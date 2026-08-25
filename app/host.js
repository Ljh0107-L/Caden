// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Host control plane: everything the renderer cannot do for itself because it
// needs the filesystem, ssh, or the keychain.
//
// server.js serves the UI and proxies the daemon; this file owns the app's
// config file, the server list, provisioning, the SSH forwards and the
// readiness checks behind /host/*.
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

// Everything this install keeps on the Mac, and the daemon home it provisions
// on a server, comes from the flavor -- so a development build beside the real
// app shares no config, no keychain item, no local port and no session with it.
// Production's values are still the original literals (`Application
// Support/Caden`, `app.caden.secrets`, `~/.caden`): the app's name changed once
// and where it keeps its things did not, because moving it would strand every
// machine and key already set up. See flavor.js.
const flavor = require('./flavor');
const SUPPORT = flavor.support;
const CONFIG_PATH = process.env.CADEN_CONFIG || path.join(SUPPORT, 'config.json');
const CONTROL_DIR = flavor.controlDir;
const DAEMON_DIR = path.join(__dirname, '..', 'server');
const WEB_DIR = path.join(__dirname, 'web');
/// Everything else under web/ is source text and rides the same heredoc the
/// daemon does. These cannot: a woff2 through a heredoc is not a woff2.
const WEB_BINARY = /\.(woff2?|png|jpe?g|gif|ico)$/i;
const KEYCHAIN_SERVICE = flavor.keychainService;
const REMOTE_HOME = flavor.remoteHome;

/// Fingerprint of the daemon this build ships, to compare against what a
/// server is actually running. See _source_revision() in heartbeat.py: an old
/// daemon answers new requests with 200 and drops the fields it does not
/// know, so without this a server-side feature just appears not to work.
const bundledRevision = (() => {
  try {
    return require('crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(DAEMON_DIR, 'heartbeat.py')))
      .digest('hex').slice(0, 12);
  } catch { return null; }
})();
const DEFAULT_PORT = flavor.defaultPort;

// A shared master connection means provisioning, the forward and every status
// check reuse one authentication instead of asking ssh to redo it each time.
// %C hashes the connection tuple, which keeps the socket path short enough for
// the ~104-byte limit on unix sockets.
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ControlMaster=auto',
  // Quoted: ssh parses an -o value as a config line, so a path containing a
  // space would otherwise end at the first blank.
  '-o', `ControlPath="${path.join(CONTROL_DIR, '%C')}"`,
  '-o', 'ControlPersist=10m',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const expandTilde = p => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// A shell word for a configured remote path. Keep the usual `~` form tied to
// the remote account's HOME, and quote every other path so a space or a shell
// metacharacter in the setting cannot change the provisioning command.
function shellPath(p) {
  const value = String(p || '');
  const quote = s => `'${s.replace(/'/g, "'\\''")}'`;
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return `"$HOME"${quote(value.slice(1))}`;
  return quote(value);
}

// ---------------------------------------------------------------- config

function readConfig() {
  migrateSecrets();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { servers: [], providers: [], models: [] };
  }
  return migrateTunnelPorts(cfg);
}

/// Tunnel ports were allocated from one hardcoded base by both installs.
///
/// On a gateway they share -- the ordinary arrangement, since the gateway is
/// somebody's server and both installs can be pointed at it -- dev's second
/// server and production's third both came out as 7903. Whichever tunnel bound
/// it first owned it, and the other console reached a daemon holding a
/// different token, which reads as "bad or missing token" on a server that is
/// running perfectly.
///
/// The ranges are per-flavor now. A port from before that is dropped rather
/// than kept, so the next connect allocates inside this install's range: a
/// recorded port that may belong to the other install is worse than no
/// recorded port, because the route it produces reaches the wrong machine
/// while looking correct. Written back rather than filtered on the way past,
/// so that removing a server can still find the entry it is removing.
function migrateTunnelPorts(cfg) {
  const tunnels = cfg.web?.tunnels;
  if (!tunnels) return cfg;
  const stale = Object.keys(tunnels).filter(id => tunnels[id] < flavor.tunnelBase);
  if (!stale.length) return cfg;
  for (const id of stale) {
    delete cfg.web.tunnels[id];
    if (cfg.web.tunnelHow) delete cfg.web.tunnelHow[id];
  }
  try { writeConfig(cfg); } catch { /* read-only config; the drop still holds */ }
  return cfg;
}

function writeConfig(cfg) {
  fs.mkdirSync(SUPPORT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/// Base URL of a server's daemon as reachable from this machine. Tunnel mode
/// assumes the forward below is up.
function daemonBase(server) {
  if (server.mode === 'direct' && server.directURL) return server.directURL;
  return `http://127.0.0.1:${server.localPort || server.remotePort || DEFAULT_PORT}`;
}

function daemonToken(server) {
  const file = expandTilde(server.tokenFile || '');
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
  }
  try {
    return require('child_process').execFileSync('security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `server.${server.id}`, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/// Stored through the `security` CLI, which takes the secret as an argument —
/// briefly visible to `ps` on this machine. Acceptable for a local tool; a
/// packaged build should call the Security framework instead.
function storeToken(id, token) {
  return new Promise((resolve, reject) => {
    execFile('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE,
                          '-a', `server.${id}`, '-w', token, '-U'],
             err => (err ? reject(err) : resolve()));
  });
}

// ------------------------------------------------------------- provider keys
// Model API keys live in the login keychain, next to the daemon tokens --
// never in config.json. The renderer only ever sees `hasKey`; the real value
// is injected by the proxy (server.js) when a session create or provider
// switch is forwarded, the same way daemon tokens are.

function providerKey(id) {
  try {
    return require('child_process').execFileSync('security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `provider.${id}`, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/// Sync like the reads above: this runs on the request path of /host/config
/// and the proxy, where a promise would push async into every caller.
function storeProviderKey(id, key) {
  require('child_process').execFileSync('security',
    ['add-generic-password', '-s', KEYCHAIN_SERVICE,
     '-a', `provider.${id}`, '-w', key, '-U'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
}

/// Sync like the other two: a POST that returns 200 must have settled the
/// keychain state it reports, not merely queued it.
function deleteProviderKey(id) {
  try {
    require('child_process').execFileSync('security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `provider.${id}`],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* already gone */ }
}

/// One-time lift of plaintext keys written by older builds into the keychain.
/// A key is only stripped from the config once its keychain write succeeded,
/// so a locked keychain defers the migration instead of losing a secret.
let secretsMigrated = false;
function migrateSecrets() {
  if (secretsMigrated) return;
  secretsMigrated = true;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  let dirty = false;
  for (const p of (cfg.providers || [])) {
    if (!p.apiKey) continue;
    try {
      storeProviderKey(p.id, p.apiKey);
      delete p.apiKey;
      dirty = true;
    } catch { /* keychain unavailable; try again next launch */ }
  }
  if (dirty) { try { writeConfig(cfg); } catch {} }
}

// ---------------------------------------------------------------- ssh

function run(cmd, args, { input, timeout = 60000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(-1); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { stderr += String(e.message); finish(-1); });
    // The ordinary way a run ends. Dropped once while the handler below was
    // being added, which left every `run` resolving on its timeout instead:
    // a status check that had its answer in half a second sat there for the
    // full 25s, and a provision that had finished held the step on screen for
    // the whole 240s it was allowed. Both read as a hang, and both were.
    child.on('close', finish);
    // `child.on('error')` is the process's, not the pipe's. When the far end
    // goes away mid-write -- an ssh that timed out, a proxy that dropped the
    // connection, a remote shell that exited early -- `stdin` emits EPIPE, and
    // an 'error' event nobody listens for is an uncaught exception. In Electron
    // that is a dialog over the whole app and a main process that stops.
    //
    // Harmless while the payload was three small files: the write completed in
    // one go before anything could close. Provisioning now pushes the console
    // through the same pipe, a third of a megabyte of it, and a connection that
    // dies partway is an ordinary thing rather than a rare one. A failed write
    // is a failed run, which the step stream already knows how to report.
    child.stdin.on('error', e => {
      stderr += `\ncould not send to ${cmd}: ${e.code || e.message}`;
      finish(-1);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const sshTarget = s => (s.sshUser ? `${s.sshUser}@${s.sshHost}` : s.sshHost);

function sshArgs(server) {
  fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
  const args = [...SSH_OPTS];
  if (server.sshPort && server.sshPort !== 22) args.push('-p', String(server.sshPort));
  if (server.identityFile) args.push('-i', expandTilde(server.identityFile), '-o', 'IdentitiesOnly=yes');
  if (server.jumpHost) args.push('-J', server.jumpHost);
  return args;
}

function ssh(server, command, opts = {}) {
  return run('ssh', [...sshArgs(server), sshTarget(server), command], opts);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/// A daemon on this Mac's own loopback. The one server a gateway cannot use,
/// because a gateway is what you set up so the Mac can be closed.
function isLocalServer(s) {
  if (s.sshHost) return false;
  try { return LOOPBACK.has(new URL(s.directURL || '').hostname); }
  catch { return false; }
}

/// A shell on the machine the daemon runs on, which is what provisioning
/// needs: it copies files there and runs bootstrap. An ssh server gets ssh; a
/// `direct` server pointed at loopback is this machine, so it gets a local
/// shell rather than an ssh connection to nowhere. Anything else -- a direct
/// URL to a box we have no account on -- has no shell to offer, and says so
/// instead of failing as `connect to host port 22: Connection refused`.
function provisionShell(server) {
  if (server.mode === 'tunnel' && server.sshHost) {
    return (command, opts) => ssh(server, command, opts);
  }
  let host = '';
  try { host = new URL(server.directURL || '').hostname; } catch {}
  if (LOOPBACK.has(host)) {
    const local = (command, opts) => run('sh', ['-c', command], opts);
    local.local = true;
    return local;
  }
  throw new Error('this server is reached over plain HTTP on another machine, so '
                  + 'Caden has no shell on it to install through — update its daemon '
                  + 'where it runs, or re-add the machine as an ssh host');
}

/// Host aliases from the user's ssh config, following `Include`. Patterns
/// (`Host *`) are skipped: they configure other entries rather than name a
/// machine you can connect to.
function sshHosts(file = path.join(os.homedir(), '.ssh', 'config'), seen = new Set()) {
  const real = expandTilde(file);
  if (seen.has(real)) return [];
  seen.add(real);
  let text;
  try { text = fs.readFileSync(real, 'utf8'); } catch { return []; }

  const out = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    const key = keyword.toLowerCase();
    const value = rest.join(' ');
    if (key === 'include') {
      for (const pattern of rest) {
        const target = pattern.includes('/') ? pattern
                                             : path.join(os.homedir(), '.ssh', pattern);
        out.push(...sshHosts(target, seen));
      }
    } else if (key === 'host') {
      current = null;
      for (const alias of rest) {
        if (alias.includes('*') || alias.includes('?')) continue;
        current = { host: alias, hostName: '', user: '', port: 22 };
        out.push(current);
        break;
      }
    } else if (current) {
      if (key === 'hostname') current.hostName = value;
      else if (key === 'user') current.user = value;
      else if (key === 'port') current.port = Number(value) || 22;
    }
  }
  return out;
}

// ---------------------------------------------------------------- servers

const newId = () => require('crypto').randomUUID().toUpperCase();

/// A server on this machine: no ssh, no forward, just the daemon on loopback.
///
/// `provisionShell` already runs a local shell for a direct server on
/// loopback, so installing into it works the same way as installing over ssh.
/// What was missing was any way to create the entry: the Servers pane could
/// only offer hosts out of `~/.ssh/config`, so using your own Mac meant
/// editing config.json by hand.
function addLocalServer() {
  const cfg = readConfig();
  const servers = cfg.servers || (cfg.servers = []);
  if (servers.some(s => s.mode === 'direct' && !s.sshHost)) {
    throw new Error('this machine is already added');
  }
  // Clear of the forwards: those bind a local port each, and the daemon here
  // binds one of its own.
  const used = new Set(servers.map(s => s.localPort || s.remotePort));
  let port = DEFAULT_PORT;
  while (used.has(port)) port++;
  const entry = {
    id: newId(), name: 'This Mac', mode: 'direct',
    sshUser: '', sshHost: '', sshPort: 22,
    identityFile: '', jumpHost: '', sshExtraArgs: '',
    remoteHome: REMOTE_HOME, remotePort: port, localPort: port,
    directURL: `http://127.0.0.1:${port}`, tokenFile: '', provisioned: false,
  };
  servers.push(entry);
  writeConfig(cfg);
  return entry;
}

function addServer(alias) {
  const cfg = readConfig();
  const servers = cfg.servers || (cfg.servers = []);
  if (servers.some(s => s.sshHost === alias)) throw new Error(`${alias} is already added`);
  // One local port per server: two forwards cannot share one.
  const used = new Set(servers.map(s => s.localPort || s.remotePort));
  let localPort = DEFAULT_PORT;
  while (used.has(localPort)) localPort++;
  // Past this install's block is the other install's daemon, and taking it
  // would break that one for as long as this server exists.
  if (localPort > flavor.localPortEnd) {
    throw new Error(`no local port left below ${flavor.localPortEnd} for another server`);
  }
  const entry = {
    id: newId(), name: alias, mode: 'tunnel',
    sshUser: '', sshHost: alias, sshPort: 22,
    identityFile: '', jumpHost: '', sshExtraArgs: '',
    remoteHome: REMOTE_HOME, remotePort: DEFAULT_PORT, localPort,
    directURL: '', tokenFile: '', provisioned: false,
  };
  servers.push(entry);
  writeConfig(cfg);
  return entry;
}

/// Take away a server's way in to the gateway.
///
/// The gateway end first, and deliberately: it is the end that grants access,
/// and it works whether or not the machine being removed still answers. The
/// service on the machine is stopped afterwards as a courtesy -- with the
/// key gone it can no longer connect anyway, and a machine being removed is
/// often a machine that has gone.
async function revokeTunnel(server, onStep = () => {}) {
  const web = webConfig();
  if (!web.tunnels[server.id]) return;

  if (web.gatewayHost) {
    onStep('withdrawing its key from the gateway…');
    const tag = `caden-tunnel:${server.id}`;
    await gatewayShell(web.gatewayHost)([
      'set -eu',
      'test -f ~/.ssh/authorized_keys || exit 0',
      `grep -v ' ${tag}$' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true`,
      'chmod 600 ~/.ssh/authorized_keys.tmp',
      'mv -f ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys',
    ].join('\n')).catch(() => {});
  }

  // Every mechanism, not the one we think is in use: which rung took is
  // recorded, but a server that has been re-connected a few times can carry
  // leftovers from the others, and each of these is a no-op when it is not
  // there.
  onStep('stopping the tunnel on the server…');
  const port = web.tunnels[server.id];
  await provisionShell(server)([
    'systemctl --user disable --now caden-tunnel.service >/dev/null 2>&1 || true',
    'rm -f ~/.config/systemd/user/caden-tunnel.service',
    'systemctl --user daemon-reload >/dev/null 2>&1 || true',
    '(crontab -l 2>/dev/null | grep -v caden-tunnel.sh || true) > ~/.caden-cron.tmp 2>/dev/null || true',
    // An empty crontab is worth removing rather than installing; the same
    // trap `supervise.sh` fell into, and for the same reason.
    'if [ -s ~/.caden-cron.tmp ]; then crontab ~/.caden-cron.tmp; '
    + 'else crontab -r >/dev/null 2>&1 || true; fi',
    'rm -f ~/.caden-cron.tmp ~/.caden-tunnel.sh ~/.caden-tunnel.log',
    port ? `pkill -f "R ${port}:127.0.0.1:" >/dev/null 2>&1 || true` : 'true',
    'rm -f ~/.ssh/caden-tunnel ~/.ssh/caden-tunnel.pub',
  ].join('\n'), { timeout: 25000 }).catch(() => {});

  const tunnels = { ...webConfig().tunnels };
  const tunnelHow = { ...(webConfig().tunnelHow || {}) };
  delete tunnels[server.id];
  delete tunnelHow[server.id];
  saveWebConfig({ tunnels, tunnelHow });
}

/// Removing a server has to reach further than this Mac.
///
/// Dropping the entry left the gateway still routing to it, the console still
/// listing it, and -- the part that matters -- a key of its own still
/// authorised to open a tunnel in. "I removed that server" has to mean the
/// server can no longer get in.
async function removeServer(id, onStep = () => {}) {
  const gone = findServer(id);
  const web = webConfig();
  if (gone) {
    await revokeTunnel(gone, onStep).catch(() => {});
    stopTunnel(gone).catch(() => {});
  }

  const cfg = readConfig();
  cfg.servers = (cfg.servers || []).filter(s => s.id !== id);
  writeConfig(cfg);
  execFile('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE,
                        '-a', `server.${id}`], () => {});

  if (!web.hostname || !web.gatewayHost) return;
  if (web.serverId === id) {
    // The console came from the one being removed, so there is nothing to
    // rewrite the configuration around. Left as it is rather than half torn
    // down: the address keeps working until another server is chosen.
    saveWebConfig({ serverId: '' });
    onStep('this was the server the console came from — pick another in the Web pane');
    return;
  }
  onStep('bringing the web gateway in line…');
  await applyWebGateway(onStep).catch(e =>
    onStep(`the server is gone; the web gateway was not updated: ${String(e.message || e)}`));
}

const findServer = id => (readConfig().servers || []).find(s => s.id === id);

// ---------------------------------------------------------------- provisioning

/// Push the daemon and start it. One ssh round-trip carries the three files and
/// runs bootstrap; nothing is left on the box outside the server's home.
///
/// `restart` matters: bootstrap.sh is idempotent and reuses a daemon that is
/// already running, which is what you want when setting a server up but means
/// a freshly uploaded heartbeat.py would not take effect. Upgrading has to ask for
/// the restart explicitly.
/// The console's own files, for a daemon that will serve them itself.
///
/// Dotfiles are skipped rather than filtered by name: the one that keeps
/// turning up is .DS_Store, and a bundle is not the place to discover the
/// next one.
function webPayload(dir = WEB_DIR, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { webPayload(full, out); continue; }
    out.push({
      // Posix separators: this string becomes a path on the server.
      name: path.relative(WEB_DIR, full).split(path.sep).join('/'),
      binary: WEB_BINARY.test(entry.name),
      body: fs.readFileSync(full),
    });
  }
  return out;
}

function buildProvisionScript(home, files, port, restart, web = [], secrets = null) {
  const remoteHome = shellPath(home);
  // A random heredoc marker prevents a source line from terminating the file
  // early while keeping the payload independent of base64/tar availability on
  // minimal hosts. All writes remain temp-then-rename, as before.
  const marker = `__CADEN_${require('crypto').randomBytes(12).toString('hex')}__`;
  const script = [
    'set -eu',
    'printf "%s\\n" caden-ok',
    `mkdir -p ${remoteHome} && chmod 700 ${remoteHome}`,
    ...files.flatMap(({ name, body }) => [
      `cat > ${remoteHome}/${name}.tmp <<'${marker}'`,
      // The join below supplies the newline before the heredoc marker. Strip
      // exactly one existing final newline so the uploaded bytes match the
      // bundled source; otherwise every upgrade changes the revision hash.
      body.endsWith('\n') ? body.slice(0, -1) : body,
      marker,
      `chmod 700 ${remoteHome}/${name}.tmp && mv -f ${remoteHome}/${name}.tmp ${remoteHome}/${name}`,
    ]),
    ...secretsScript(remoteHome, secrets, marker),
    ...webScript(remoteHome, web, marker),
    `sh ${remoteHome}/bootstrap.sh --home ${remoteHome} --port ${Number(port) || DEFAULT_PORT} --supervise`
      + (restart ? ' --restart' : ''),
    '',
  ].join('\n');
  return script;
}

/// The model credentials this Mac holds, keyed by provider id.
///
/// A console served straight from a daemon has nothing in front of it that
/// can turn a `key_ref` into a key -- a reverse proxy adds headers, it does
/// not rewrite JSON bodies -- so the daemon resolves the ref itself, out of
/// the copy this puts there.
///
/// Returns null rather than an empty object when the config lists providers
/// and not one key came back. That is what a locked or unavailable keychain
/// looks like, and writing `{}` for it would wipe working credentials off the
/// server on the next routine upgrade.
function providerSecrets() {
  const providers = readConfig().providers || [];
  const out = {};
  for (const p of providers) {
    const key = providerKey(p.id);
    if (key) out[p.id] = key;
  }
  if (providers.length && !Object.keys(out).length) return null;
  return out;
}

/// Writing it: 0600, and created that way rather than narrowed afterwards.
/// `cat >` makes the file under the login's umask, which is 022 on most
/// hosts, so without the subshell the keys are briefly world-readable at
/// their final name.
function secretsScript(remoteHome, secrets, marker) {
  if (!secrets) return [];
  const dest = `${remoteHome}/providers.json`;
  return [
    `(umask 077; cat > ${dest}.tmp <<'${marker}'`,
    JSON.stringify(secrets, null, 2),
    marker,
    ')',
    `chmod 600 ${dest}.tmp && mv -f ${dest}.tmp ${dest}`,
  ];
}

/// The console half of the payload.
///
/// Text goes the way the daemon sources go. The two fonts have to be base64,
/// and the comment on buildProvisionScript's heredoc explains why that is not
/// the default: the target may be a container with no base64 to decode them
/// with. So they are guarded rather than assumed -- a console in the fallback
/// mono beats no console, and both beat a provisioning run that fails on a
/// minimal host over a typeface.
function webScript(remoteHome, web, marker) {
  if (!web.length) return [];
  const dirs = [...new Set(web.map(f => path.posix.dirname(f.name)))]
    .map(d => (d === '.' ? `${remoteHome}/web` : `${remoteHome}/web/${d}`));
  const lines = [
    `rm -rf ${remoteHome}/web.new`,
    ...dirs.map(d => `mkdir -p ${d.replace(`${remoteHome}/web`, `${remoteHome}/web.new`)}`),
  ];
  let guarded = false;
  for (const f of web) {
    const dest = `${remoteHome}/web.new/${f.name}`;
    if (f.binary) {
      if (!guarded) {
        lines.push('if command -v base64 >/dev/null 2>&1; then');
        guarded = true;
      }
      lines.push(`base64 -d > ${dest} <<'${marker}'`,
                 f.body.toString('base64').replace(/(.{76})/g, '$1\n'),
                 marker);
      continue;
    }
    if (guarded) { lines.push('fi'); guarded = false; }
    const text = f.body.toString('utf8');
    lines.push(`cat > ${dest} <<'${marker}'`,
               text.endsWith('\n') ? text.slice(0, -1) : text,
               marker);
  }
  if (guarded) lines.push('fi');
  // Swapped in whole, so a run that dies partway leaves the console that was
  // working there rather than half of two of them.
  lines.push(`rm -rf ${remoteHome}/web && mv ${remoteHome}/web.new ${remoteHome}/web`,
             `chmod 700 ${remoteHome}/web`);
  return lines;
}

async function provision(server, { restart = false } = {}, onStep = () => {}) {
  const home = server.remoteHome || REMOTE_HOME;
  // The one crossing that cannot be allowed to happen quietly. A development
  // build writing heartbeat.py into `~/.caden` takes effect even without
  // `--restart`: the supervisor's ExecStart names the file, not the build that
  // put it there, so the next crash or reboot brings the daemon back on
  // untrusted code -- with the real sessions still in that home. A config
  // pointed at the wrong home is a plausible slip; this turns it into a
  // message instead of a silent takeover.
  if (flavor.id !== 'prod' && home === flavor.all.prod.remoteHome) {
    throw new Error(`${flavor.label} will not provision ${home} — that is the `
                    + 'production daemon home. Point this server at '
                    + `${flavor.remoteHome}, or use the release build.`);
  }
  const sh = provisionShell(server);
  const files = [];
  for (const name of ['heartbeat.py', 'bootstrap.sh', 'supervise.sh']) {
    const src = path.join(DAEMON_DIR, name);
    if (!fs.existsSync(src)) {
      throw new Error(`${name} is missing from this build (looked in ${DAEMON_DIR}) `
                      + '— rebuild with scripts/build-app.sh');
    }
    files.push({ name, body: fs.readFileSync(src, 'utf8') });
  }

  const secrets = providerSecrets();
  if (secrets === null) {
    onStep('no provider keys could be read — leaving the ones on the server alone');
  }
  const script = buildProvisionScript(home, files, server.remotePort, restart,
                                      webPayload(), secrets);

  onStep('connecting over ssh…');
  onStep('uploading daemon files…');
  const r = await sh('sh -s', { input: script, timeout: 240000 });
  if (!r.stdout.includes('caden-ok')) {
    throw new Error(r.stderr.trim() || (sh.local
      ? 'could not run a local shell'
      : `ssh ${sshTarget(server)} failed — authenticate once in Terminal, then retry`));
  }
  onStep('starting and checking the daemon…');
  const line = r.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop();
  if (!line) throw new Error(r.stderr.trim() || 'bootstrap produced no result');
  const result = JSON.parse(line);
  if (!result.ok) throw new Error(result.error || 'bootstrap failed');

  await storeToken(server.id, result.token);
  const cfg = readConfig();
  const entry = (cfg.servers || []).find(s => s.id === server.id);
  if (entry) {
    entry.provisioned = true;
    // Which supervisor the daemon is under, so the server card can say so.
    // Absent on daemons provisioned before supervision existed.
    if (result.supervisor) entry.supervisor = result.supervisor;
    // bootstrap.sh walks up from a busy port, so the daemon does not always
    // land on the one we asked for. Recording what it reports is what keeps
    // the forward pointed at the right end.
    if (result.port && result.port !== entry.remotePort) {
      entry.remotePort = result.port;
      await stopTunnel(entry);          // the old forward addresses the old port
    }
    // A direct server is addressed by its URL, not by the forward, so the port
    // has to be carried there too or provisioning appears to succeed and the
    // daemon then reads as "installed but not answering". Unconditional on
    // purpose: the two can already disagree, and gating this on the port
    // having *changed* leaves that disagreement in place forever.
    if (result.port && entry.mode === 'direct' && entry.directURL) {
      try {
        const u = new URL(entry.directURL);
        u.port = String(result.port);
        entry.directURL = u.toString().replace(/\/$/, '');
      } catch {}
    }
    writeConfig(cfg);
  }

  // Provisioning stops at the machine. Putting a server on the web is a
  // separate decision made in the Web pane, because it is a separate thing to
  // want: a server can be one this Mac talks to over ssh and nothing more.
  // Wiring it up here meant every provision reached out to a third host, and
  // a gateway that could not be reached turned into a warning on an operation
  // that had otherwise gone perfectly.
  return { ...result, remotePort: entry ? entry.remotePort : server.remotePort };
}

// ---------------------------------------------------------------- tunnel

const tunnels = new Map();   // serverId -> the child we spawned, when we did

const localPortOf = s => s.localPort || s.remotePort || DEFAULT_PORT;

/// Whether the local end of the forward is open — decided by the port, never
/// by our child process.
///
/// ssh multiplexes over the shared master connection, so `ssh -N -L` usually
/// hands the forward to the master and the client exits 0 immediately. That is
/// success: the port stays open, held by the master. Watching the child instead
/// reports a working forward as "ssh exited immediately".
const forwardOpen = server => canConnect(localPortOf(server));

/// Whether the forward actually carries traffic to *this server's* daemon.
///
/// An open port is not proof: a forward left over from a previous remote port
/// still accepts locally and then resets, because ssh only discovers there is
/// nothing to talk to once it tries to open the channel.
///
/// Neither is a ping. Every daemon answers it, and answers it identically --
/// so on a machine that also runs a daemon of its own, a local one holding
/// the port looks exactly like a working forward, `startTunnel` reports the
/// forward reused, and the app spends the rest of the session talking to the
/// wrong machine while believing it is talking to this one. Which is what
/// happened: This Mac's daemon on 7938 answering for a server whose forward
/// had never been opened.
///
/// The token is the thing that tells them apart -- 264 bits, one per daemon
/// -- so where there is one, identity is what gets checked rather than
/// liveness.
async function forwardUsable(server) {
  if (!(await canConnect(localPortOf(server)))) return false;
  if (!server.provisioned) return true;
  const token = daemonToken(server);
  if (!token) {
    const ping = await daemonGet(server, '/v1/ping', { auth: false, timeout: 5000 });
    return !!(ping && ping.ok);
  }
  const health = await daemonGet(server, '/v1/health', { timeout: 5000 });
  return !!(health && health.revision);
}

/// A local port this forward can have to itself.
///
/// The configured one is preferred and is usually free, because it matches
/// the remote port and most people run one daemon per machine. When something
/// else is already on it -- a daemon of this Mac's own, another server's
/// forward -- walking forward beats failing with "address already in use",
/// and beats far more the previous behaviour of quietly using whatever was
/// answering.
async function freeLocalPort(server) {
  const want = localPortOf(server);
  if (!(await canConnect(want))) return want;
  // Inside this install's block only. Walking past it lands on the other
  // install's daemon port, and a forward that takes it is a development build
  // that stops the real one from starting -- the sort of interference the
  // whole flavor split exists to prevent.
  for (let port = want + 1; port <= flavor.localPortEnd; port++) {
    if (!(await canConnect(port))) return port;
  }
  throw new Error(`no free local port between ${want} and ${flavor.localPortEnd} `
                  + `for the forward to ${server.name || server.sshHost}`);
}

function canConnect(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

async function startTunnel(server) {
  if (await forwardUsable(server)) return { port: localPortOf(server), reused: true };
  // Whatever is holding the port cannot reach this daemon; clear out anything
  // of ours, then find a port that is actually free -- what is left may not be
  // ours to move.
  await stopTunnel(server);
  const port = await freeLocalPort(server);
  if (port !== localPortOf(server)) {
    const cfg = readConfig();
    const entry = (cfg.servers || []).find(x => x.id === server.id);
    if (entry) { entry.localPort = port; writeConfig(cfg); }
    server.localPort = port;
  }

  const args = [...sshArgs(server), '-N', '-T',
                '-L', `127.0.0.1:${port}:127.0.0.1:${server.remotePort}`,
                sshTarget(server)];
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  tunnels.set(server.id, child);

  for (let i = 0; i < 60; i++) {
    // Usable, not merely open: a listener we did not create proves nothing.
    if (await forwardUsable(server)) return { port };
    // Only an exit that left nothing usable behind is a real failure.
    if (child.exitCode !== null) {
      await sleep(200);
      if (await forwardUsable(server)) return { port };
      throw new Error(err.trim()
        || `ssh exited (${child.exitCode}) without opening 127.0.0.1:${port}`);
    }
    await sleep(150);
  }
  const openButDeaf = await canConnect(port);
  await stopTunnel(server);
  throw new Error(err.trim() || (openButDeaf
    ? `the forward opened but nothing answered on port ${server.remotePort} at the other end`
    : 'the forward did not come up'));
}

async function stopTunnel(server) {
  const child = tunnels.get(server.id);
  if (child && child.exitCode === null) child.kill();
  tunnels.delete(server.id);
  const port = localPortOf(server);
  if (!(await canConnect(port))) return;

  // Still open, so the shared master owns it. `-O cancel` has to name the spec
  // the forward was created with, and we may no longer know it -- the daemon's
  // port moves when bootstrap walks off a busy one, and a forward built before
  // that move cannot be matched by the current spec.
  await run('ssh', [...sshArgs(server), '-O', 'cancel',
                    '-L', `127.0.0.1:${port}:127.0.0.1:${server.remotePort}`,
                    sshTarget(server)], { timeout: 15000 });
  if (!(await canConnect(port))) return;

  // Whatever it is holding, we cannot address it by name. Drop the master:
  // it releases every forward it owns, and the next command re-establishes it.
  await run('ssh', [...sshArgs(server), '-O', 'exit', sshTarget(server)],
            { timeout: 15000 });
}

// ---------------------------------------------------------------- status

/// One request against a server's daemon, with the token attached.
function daemonRequest(server, method, path_, { body, type, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(daemonBase(server) + path_); }
    catch (e) { return reject(e); }
    const token = daemonToken(server);
    if (!token) return reject(new Error('no daemon token for this server'));
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers['Content-Type'] = type || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(url, { method, timeout, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 300) {
          let msg = data.slice(0, 300);
          try { msg = JSON.parse(data).error || msg; } catch {}
          return reject(new Error(msg || `HTTP ${res.statusCode}`));
        }
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// What a model will actually accept as an image. Anything else -- heic, tiff,
// a 40 MB png -- is a file: sending it as an image block would either be
// rejected upstream or bloat the turn, and a path the agent can open is the
// honest answer.
const MODEL_IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg',
                      '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                      '.webp': 'image/webp' };
const IMAGE_MAX = 4 << 20;
// A ceiling on what an attachment may be. Deliberately not enforced on
// /v1/uploads itself: that endpoint also carries engine builds, and codex
// alone is a quarter of a gigabyte.
const ATTACH_MAX = 50 << 20;
const CHUNK = 4 << 20;

const humanSize = n => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
                                     : `${Math.max(1, Math.round(n / 1024))} KB`);

function checkSize(name, size) {
  if (size > ATTACH_MAX) {
    throw new Error(`${name} is ${humanSize(size)}; attachments are capped at `
                    + `${humanSize(ATTACH_MAX)}`);
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha256');
    // Streamed, not read whole: a video would otherwise have to fit in memory
    // just to be checksummed.
    const rs = fs.createReadStream(file, { highWaterMark: CHUNK });
    rs.on('data', c => hash.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function uploadBuffer(server, name, read, size) {
  const begun = await daemonRequest(server, 'POST', '/v1/uploads',
    { body: JSON.stringify({ name, size, sha256: await read.digest() }) });
  const id = begun.upload.id;
  for (let offset = 0; offset < size;) {
    const chunk = await read.at(offset);
    if (!chunk || !chunk.length) break;
    await daemonRequest(server, 'PUT', `/v1/uploads/${id}?offset=${offset}`,
      { body: chunk, type: 'application/octet-stream', timeout: 300000 });
    offset += chunk.length;
  }
  const done = await daemonRequest(server, 'POST', `/v1/uploads/${id}/complete`);
  return { kind: 'file', path: done.upload.path, name, size };
}

/// Attach one local file, deciding by type what "attach" means.
///
/// An image the model can read goes back as bytes, to ride along in the turn
/// itself; everything else is pushed to the server and comes back as a path.
/// The rule is the file's, not the entry point's -- pasting a screenshot and
/// picking it with + have to land in the same place.
async function attachFile(server, localPath) {
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error(`${localPath} is not a file`);
  const name = path.basename(localPath);
  const mime = MODEL_IMAGE[path.extname(name).toLowerCase()];

  checkSize(name, stat.size);

  if (mime && stat.size <= IMAGE_MAX) {
    return { kind: 'image', name, media_type: mime,
             data: fs.readFileSync(localPath).toString('base64') };
  }

  const fd = fs.openSync(localPath, 'r');
  const buf = Buffer.alloc(CHUNK);
  try {
    return await uploadBuffer(server, name, {
      digest: () => sha256File(localPath),
      at: offset => {
        const read = fs.readSync(fd, buf, 0, CHUNK, offset);
        return buf.subarray(0, read);
      },
    }, stat.size);
  } finally {
    fs.closeSync(fd);
  }
}

/// The same, for bytes that never had a path -- a file pasted out of Finder,
/// which the renderer can read but cannot locate.
async function attachBytes(server, name, body) {
  checkSize(name, body.length);
  return uploadBuffer(server, name, {
    digest: async () => require('crypto').createHash('sha256').update(body).digest('hex'),
    at: offset => body.subarray(offset, offset + CHUNK),
  }, body.length);
}

/// The native open panel. Only the main process can raise one, which is the
/// whole reason this lives here and not in the renderer.
async function pickFiles() {
  let dialog = null;
  try { dialog = require('electron').dialog; } catch {}
  if (!dialog) throw new Error('the file picker needs the desktop app (npm start)');
  const res = await dialog.showOpenDialog({
    title: 'Attach files',
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  return res.filePaths.map(p => ({ path: p, name: path.basename(p) }));
}

function daemonGet(server, path_, { auth = true, timeout = 6000 } = {}) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(daemonBase(server) + path_); } catch { return resolve(null); }
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {};
    if (auth) {
      const token = daemonToken(server);
      if (!token) return resolve(null);
      headers.Authorization = `Bearer ${token}`;
    }
    const req = mod.request(url, { method: 'GET', timeout, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(res.statusCode < 300 ? JSON.parse(data) : null); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/// Everything that has to be true before a session can run, in the order the
/// user has to fix them.
// -- checking versions on a server's behalf -----------------------------------
//
// A box that cannot reach the registry can never answer "is there a newer
// build?", and used to sit on `cannot reach the release source` forever. This
// Mac can reach it, and already acts as the transport for the install itself,
// so it may as well do the looking too.
//
// Cached and refreshed in the background for the same reason the daemon does
// it that way: the Servers pane must never wait on a network call.

const LATEST_TTL = 3600_000;
const LATEST_RETRY = 120_000;
const latestCache = new Map();          // key -> {at, version}
const latestInflight = new Set();
const artifactSpecs = new Map();        // serverId:engine -> descriptor

const versionTuple = text => {
  const m = /(\d+(?:\.\d+)*)/.exec(text || '');
  return m ? m[1].split('.').map(Number) : null;
};
const newer = (there, here) => {
  if (!there || !here) return null;     // unknown is not "you are behind"
  for (let i = 0; i < Math.max(there.length, here.length); i++) {
    const a = there[i] || 0, b = here[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
};

async function resolveLatestHere(spec) {
  if (spec.npm) {
    const tags = await fetchJSON(
      `https://registry.npmjs.org/-/package/${encodeURIComponent(spec.npm)}/dist-tags`);
    return tags?.[spec.npm_tag] || tags?.latest || null;
  }
  if (spec.version_url) {
    // `releases/latest` redirects to `releases/tag/<tag>`; the tag is the
    // version, and reading it costs no API budget.
    const final = await finalUrl(spec.version_url);
    return final.includes('/tag/') ? final.replace(/\/$/, '').split('/tag/').pop() : null;
  }
  return null;
}

function finalUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    mod.get(url, { headers: { 'User-Agent': 'caden' } }, res => {
      res.resume();
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (!redirects) return reject(new Error('too many redirects'));
        return resolve(finalUrl(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      resolve(url);
    }).on('error', reject);
  });
}

/// Fill in what the server could not look up itself. Returns immediately with
/// whatever is cached and refreshes behind the back of the caller.
function checkLatestHere(server, engine, info) {
  const key = `${server.id}:${engine}`;
  const hit = latestCache.get(key);
  const ttl = hit?.version ? LATEST_TTL : LATEST_RETRY;
  if ((!hit || Date.now() - hit.at > ttl) && !latestInflight.has(key)) {
    latestInflight.add(key);
    (async () => {
      try {
        let spec = artifactSpecs.get(key);
        if (!spec) {
          const got = await daemonGet(server, `/v1/engines/${engine}/artifacts`,
                                      { timeout: 10000 });
          spec = (got?.artifacts || []).find(a => (a.role || 'main') === 'main');
          if (spec) artifactSpecs.set(key, spec);
        }
        const version = spec ? await resolveLatestHere(spec) : null;
        latestCache.set(key, { at: Date.now(), version });
      } catch {
        latestCache.set(key, { at: Date.now(), version: null });
      } finally {
        latestInflight.delete(key);
      }
    })();
  }
  if (!hit?.version) return;
  info.latest = versionTuple(hit.version)?.join('.') || hit.version;
  info.update_available = newer(versionTuple(hit.version), versionTuple(info.version));
  info.latest_state = 'host';           // answered from here, not from there
}

async function status(server) {
  const out = {
    id: server.id, mode: server.mode, provisioned: !!server.provisioned,
    ssh: null, tunnel: null, daemon: null, engines: null, token: !!daemonToken(server),
  };
  const port = server.localPort || server.remotePort;

  if (server.mode === 'tunnel') {
    const probe = await ssh(server, 'echo caden-ok', { timeout: 25000 });
    out.ssh = probe.stdout.includes('caden-ok');
    out.sshError = out.ssh ? null : (probe.stderr.trim().split('\n').pop() || 'unreachable');
    out.tunnel = await forwardOpen(server);
  }

  const ping = await daemonGet(server, '/v1/ping', { auth: false, timeout: 4000 });
  out.daemon = !!(ping && ping.ok);
  out.daemonVersion = null;
  out.daemonRevision = null;
  out.bundledRevision = bundledRevision;

  if (out.daemon && out.token) {
    // Which build is over there comes from the authenticated side. An
    // unauthenticated ping answers `ok` and nothing else, so a daemon one
    // proxy misconfiguration away from the internet does not hand a scanner
    // its version and source revision; /v1/health carries both for a caller
    // that can prove it belongs here.
    const [health, engines] = await Promise.all([
      daemonGet(server, '/v1/health'),
      daemonGet(server, '/v1/engines?latest=1'),
    ]);
    out.daemonVersion = health?.version || null;
    out.daemonRevision = health?.revision || null;
    // A daemon running as root cannot run Full access; the composer reads
    // this so it does not default to a mode that will be refused.
    out.root = !!health?.root;
    if (engines?.engines) {
      out.engines = {
        claude: engines.engines.claude || { installed: false },
        codex: engines.engines.codex || { installed: false },
      };
      out.arch = engines.arch;
      out.libc = engines.libc;
      for (const name of ['claude', 'codex']) {
        const info = out.engines[name];
        if (info?.installed && info.latest_state === 'unreachable') {
          checkLatestHere(server, name, info);
        }
      }
    }
  }
  // A daemon that answered but reports no revision predates the field, so it
  // is stale by definition -- that is exactly the build this check exists to
  // catch. Without a token there is nothing to compare and nothing is
  // claimed: "I could not ask" is not the same as "it is out of date".
  out.daemonStale = !!(out.daemon && out.token && bundledRevision
                       && out.daemonRevision !== bundledRevision);
  out.ready = !!(out.daemon && out.token
                 && (out.engines?.claude?.installed || out.engines?.codex?.installed));
  return out;
}

/// Install an engine with this Mac as the transport.
///
/// The fallback for a server that cannot reach the source itself -- no
/// outbound network, a blocked host, or GitHub's anonymous API budget spent.
/// The daemon says what it needs (naming is per-platform, so it is the one
/// that knows), we fetch it here and push it up the chunked upload path.
async function installViaHost(server, engine, onStep = () => {}) {
  const spec = await daemonGet(server, `/v1/engines/${engine}/artifacts`);
  if (!spec?.artifacts) throw new Error('this daemon cannot describe its artifacts — upgrade it first');

  const staged = {};
  for (const a of spec.artifacts) {
    const role = a.role || 'main';
    try {
      const { name, body } = await downloadArtifact(a, onStep);
      onStep(`uploading ${name} (${(body.length / 1048576).toFixed(1)} MiB)`);
      // uploadBuffer, not attachBytes: the 50 MB cap belongs to user
      // attachments, and an engine build is several times that.
      const up = await uploadBuffer(server, name, {
        digest: async () => require('crypto').createHash('sha256').update(body).digest('hex'),
        at: offset => body.subarray(offset, offset + CHUNK),
      }, body.length);
      staged[role] = up.path || up.id;
    } catch (e) {
      // A missing companion is not a failed install: older releases do not
      // publish one. A missing main artifact is.
      if (a.optional) { onStep(`skipping ${a.name}: ${e.message || e}`); continue; }
      throw e;
    }
  }
  if (!staged.main) throw new Error(`nothing to install for ${engine}`);
  const started = await daemonRequest(server, 'POST', '/v1/engines/install', {
    body: JSON.stringify({ engine, method: 'offline', artifact: staged.main,
                           companion: staged.companion }),
  });
  // The install endpoint answers 202 with a job. Returning here would report
  // success for work that has not run yet, so follow the job to its end.
  return waitForJob(server, started.job.id, onStep);
}

async function waitForJob(server, jobId, onStep) {
  onStep('installing on the server');
  for (let i = 0; i < 600; i++) {
    const job = await daemonGet(server, `/v1/jobs/${jobId}`, { timeout: 15000 });
    if (job?.state === 'ok') return job;
    if (job?.state === 'failed' || job?.error) {
      throw new Error(job.error || 'install failed on the server');
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('the install did not finish in time');
}

async function downloadArtifact(a, onStep) {
  if (a.npm) {
    // dist-tags then the single-version document: the full package doc lists
    // every release ever published and is megabytes for a daily build.
    const pkg = encodeURIComponent(a.npm);
    const tags = await fetchJSON(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`);
    const version = tags?.[a.npm_tag] || tags?.latest;
    if (!version) throw new Error(`cannot resolve ${a.npm}`);
    const meta = await fetchJSON(`https://registry.npmjs.org/${pkg}/${version}`);
    const url = meta?.dist?.tarball;
    if (!url) throw new Error(`no tarball for ${a.npm}@${version}`);
    const name = `${a.npm.split('/').pop()}-${version}.tgz`;
    onStep(`downloading ${a.npm}@${version}`);
    return { name, body: await fetchBuffer(url, {
      totalTimeout: 30 * 60_000,
      onProgress: (bytes, total) => onStep(downloadProgress(name, bytes, total)),
    }) };
  }
  onStep(`downloading ${a.name}`);
  return { name: a.name, body: await fetchBuffer(a.url, {
    totalTimeout: 30 * 60_000,
    onProgress: (bytes, total) => onStep(downloadProgress(a.name, bytes, total)),
  }) };
}

const fetchJSON = url => fetchBuffer(url).then(b => JSON.parse(b.toString('utf8')));

function downloadProgress(name, bytes, total) {
  const got = (bytes / 1048576).toFixed(1);
  if (!total) return `downloading ${name} · ${got} MiB`;
  const size = (total / 1048576).toFixed(1);
  const pct = Math.min(100, Math.round(bytes * 100 / total));
  return `downloading ${name} · ${got}/${size} MiB (${pct}%)`;
}

function fetchBuffer(url, {
  redirects = 5,
  onProgress = null,
  idleTimeout = 30_000,
  totalTimeout = 120_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    let req = null, settled = false;
    const timer = setTimeout(() => {
      req?.destroy(new Error(`download timed out for ${url.split('?')[0]}`));
    }, totalTimeout);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.setTimeout(0);
      fn(value);
    };

    req = mod.get(url, { headers: { 'User-Agent': 'caden' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!redirects) return finish(reject, new Error('too many redirects'));
        return finish(resolve, fetchBuffer(new URL(res.headers.location, url).toString(), {
          redirects: redirects - 1, onProgress, idleTimeout, totalTimeout,
        }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error(`HTTP ${res.statusCode} for ${url.split('?')[0]}`));
      }
      const chunks = [];
      const total = Number(res.headers['content-length']) || 0;
      let bytes = 0, reportedAt = 0;
      const report = force => {
        if (!onProgress || (!force && Date.now() - reportedAt < 750)) return;
        reportedAt = Date.now();
        try { onProgress(bytes, total); } catch {}
      };
      res.on('data', c => {
        chunks.push(c);
        bytes += c.length;
        report(false);
      });
      res.on('end', () => {
        report(true);
        finish(resolve, Buffer.concat(chunks));
      });
      res.on('error', e => finish(reject, e));
    });
    req.setTimeout(idleTimeout, () => {
      req.destroy(new Error(`download stalled for ${url.split('?')[0]}`));
    });
    req.on('error', e => finish(reject, e));
  });
}

// ---------------------------------------------------------------- routes

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

const readBody = req => new Promise(resolve => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
});

/// Handles every /host/* route. Returns false when the path is not ours.
async function route(req, res, url) {
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);          // ['host', ...]

  if (p === '/host/config') {
    const cfg = readConfig();
    const open = await Promise.all((cfg.servers || []).map(forwardOpen));
    json(res, 200, {
      servers: (cfg.servers || []).map((s, i) => ({
        id: s.id, name: s.name || s.sshHost || 'server',
        mode: s.mode, provisioned: !!s.provisioned,
        host: s.sshHost, remotePort: s.remotePort, localPort: s.localPort,
        tunnel: open[i],
      })),
      models: cfg.models || [],
      // Keys never leave this process: the renderer gets a boolean, and the
      // proxy injects the real value when a session request is forwarded.
      providers: (cfg.providers || []).map(p => {
        const { apiKey, ...rest } = p;
        return { ...rest, hasKey: !!providerKey(p.id) };
      }),
      defaults: {
        // A tilde, not this machine's home: it is expanded per server, by the
        // daemon that will actually use it.
        workdir: cfg.defaultWorkdir || '~',
        permissionMode: cfg.defaultPermissionMode || 'bypassPermissions',
      },
      // What this host can do on the renderer's behalf. Everything here needs
      // something only a Mac running the app has -- the filesystem, ssh, the
      // keychain, a native dialog -- so a console served from a daemon and
      // reached through a reverse proxy declares none of it, and the renderer
      // hides the controls rather than offering buttons that 404.
      //
      // Absent means none: a hand-written config for that arrangement should
      // not have to know the list in order to be safe.
      capabilities: {
        servers: true,        // add and remove servers, read ~/.ssh/config
        provisioning: true,   // install the daemon over ssh
        tunnels: true,        // open and close the port-forwards
        hostInstall: true,    // push an engine up using this Mac as transport
        filePicker: true,     // the native open panel, and attach-by-path
      },
    });
    return true;
  }

  if (p === '/host/providers' && req.method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.providers)) return json(res, 400, { error: 'providers must be an array' }), true;
    const cfg = readConfig();
    // Three states for the key field: a non-empty string sets/replaces it,
    // null deletes it, and '' or absent keeps what the keychain has -- the
    // renderer cannot see what it holds, so it cannot send it back.
    const prev = new Set((cfg.providers || []).map(p => p.id));
    for (const p of body.providers) {
      try {
        if (p.apiKey === null) {
          deleteProviderKey(p.id);
        } else if (p.apiKey) {
          storeProviderKey(p.id, p.apiKey);
        }
      } catch (e) {
        return json(res, 500, { error: `could not store the API key: ${String(e.message || e)}` }), true;
      }
      delete p.apiKey;
      prev.delete(p.id);
    }
    // Providers removed from the list take their keys with them.
    for (const gone of prev) deleteProviderKey(gone);
    cfg.providers = body.providers;
    // The legacy flat model list is fallback-only once the provider tree
    // exists; its keys were lifted into the tree on migration, so plaintext
    // copies have no reason to stay.
    for (const m of (cfg.models || [])) delete m.apiKey;
    writeConfig(cfg);
    return json(res, 200, { ok: true }), true;
  }

  if (seg[1] === 'servers' && seg[3] === 'install-via-host' && req.method === 'POST') {
    const server = findServer(seg[2]);
    if (!server) return json(res, 404, { error: 'no such server' }), true;
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
                         'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      const out = await installViaHost(server, body.engine, t => send({ type: 'step', text: t }));
      send({ type: 'done', ok: true, job: out.job });
    } catch (e) {
      send({ type: 'done', ok: false, error: String(e.message || e) });
    }
    res.end();
    return true;
  }

  if (p === '/host/web/status') {
    // `?quick=1` is the config-only answer, so the pane can draw itself before
    // any of the checks have come back.
    const quick = url.searchParams.get('quick') === '1';
    try { json(res, 200, await webStatus({ probe: !quick })); }
    catch (e) { json(res, 500, { error: String(e.message || e) }); }
    return true;
  }

  if (p === '/host/web/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const clean = {};
    for (const k of ['hostname', 'gatewayHost', 'serverId']) {
      if (typeof body[k] === 'string') clean[k] = body[k].trim();
    }
    return json(res, 200, saveWebConfig(clean)), true;
  }

  if (p === '/host/web/apply' && req.method === 'POST') {
    // Same streaming shape as provisioning: most of the time is spent inside
    // one ssh command, and a blank response for a minute reads as a hang.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    const send = e => res.write(`${JSON.stringify(e)}\n`);
    try {
      const result = await applyWebGateway(text => send({ type: 'step', text }));
      send({ type: 'done', ok: true, result });
    } catch (e) {
      send({ type: 'done', ok: false, error: String(e.message || e) });
    }
    res.end();
    return true;
  }

  if (p === '/host/web/tunnel' && req.method === 'POST') {
    const body = await readBody(req);
    const server = (readConfig().servers || []).find(x => x.id === body.serverId);
    if (!server) return json(res, 404, { error: 'no such server' }), true;
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    const send = e => res.write(`${JSON.stringify(e)}\n`);
    try {
      const out = await setupTunnel(server, text => send({ type: 'step', text }));
      send({ type: 'step', text: 'bringing the web gateway in line…' });
      await applyWebGateway(text => send({ type: 'step', text }));
      send({ type: 'done', ok: true, result: out });
    } catch (e) {
      send({ type: 'done', ok: false, error: String(e.message || e) });
    }
    res.end();
    return true;
  }

  if (p === '/host/web/password' && req.method === 'POST') {
    const body = await readBody(req);
    const pw = String(body.password || '');
    if (pw.length < 8) return json(res, 400, { error: 'that password is too short to be worth storing' }), true;
    const web = webConfig();
    const server = (readConfig().servers || []).find(x => x.id === web.serverId);
    if (!server) return json(res, 400, { error: 'choose which server serves the console first' }), true;
    try {
      const home = server.remoteHome || REMOTE_HOME;
      // Through stdin, so it is not in the process list on the way past or in
      // a shell history afterwards.
      await provisionShell(server)(
        `CADEN_HOME=${home} python3 ${home}/heartbeat.py --set-web-password`,
        { input: `${pw}\n` });
      json(res, 200, { ok: true });
    } catch (e) { json(res, 502, { error: String(e.message || e) }); }
    return true;
  }

  if (p === '/host/web/logout-all' && req.method === 'POST') {
    const web = webConfig();
    const server = (readConfig().servers || []).find(x => x.id === web.serverId);
    if (!server) return json(res, 400, { error: 'no console server chosen' }), true;
    try {
      const home = server.remoteHome || REMOTE_HOME;
      await provisionShell(server)(
        `curl -sS -X POST -H "Authorization: Bearer $(cat ${home}/token)" `
        + `http://127.0.0.1:${server.remotePort || DEFAULT_PORT}/v1/web/logout-all`);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 502, { error: String(e.message || e) }); }
    return true;
  }

  if (p === '/host/files/pick' && req.method === 'POST') {
    try { json(res, 200, { files: await pickFiles() }); }
    catch (e) { json(res, 501, { error: String(e.message || e) }); }
    return true;
  }

  if (p === '/host/ssh-hosts') {
    const added = new Set((readConfig().servers || []).map(s => s.sshHost).filter(Boolean));
    json(res, 200, { hosts: sshHosts().map(h => ({ ...h, added: added.has(h.host) })) });
    return true;
  }

  if (p === '/host/servers' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.host) return json(res, 400, { error: 'host is required' }), true;
    try { json(res, 201, { server: addServer(String(body.host)) }); }
    catch (e) { json(res, 409, { error: String(e.message || e) }); }
    return true;
  }

  // /host/servers/<id>[/action]
  if (seg[0] === 'host' && seg[1] === 'servers' && seg[2]) {
    const server = findServer(seg[2]);
    if (!server) return json(res, 404, { error: 'unknown server' }), true;
    const action = seg[3];

    if (!action && req.method === 'DELETE') {
      // Reaching two other machines, so it can take a moment. The renderer
      // already awaits it.
      try { await removeServer(server.id); json(res, 200, { ok: true }); }
      catch (e) { json(res, 500, { error: String(e.message || e) }); }
      return true;
    }
    if (action === 'status') {
      return json(res, 200, await status(server)), true;
    }
    if (action === 'provision' && req.method === 'POST') {
      const body = await readBody(req);
      // Provisioning can spend most of its time in a single SSH command. Keep
      // the renderer informed without buffering the whole operation behind a
      // blank HTTP response.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const send = event => res.write(`${JSON.stringify(event)}\n`);
      try {
        const result = await provision(server, body, text => send({ type: 'step', text }));
        send({ type: 'done', ok: true, result });
      } catch (e) {
        send({ type: 'done', ok: false, error: String(e.message || e) });
      }
      res.end();
      return true;
    }
    if (action === 'tunnel' && req.method === 'POST') {
      try { json(res, 200, { ok: true, ...(await startTunnel(server)) }); }
      catch (e) { json(res, 502, { error: String(e.message || e) }); }
      return true;
    }
    if (action === 'attach' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: 'path is required' }), true;
      try { json(res, 200, await attachFile(server, String(body.path))); }
      catch (e) { json(res, 502, { error: String(e.message || e) }); }
      return true;
    }
    if (action === 'attach-bytes' && req.method === 'POST') {
      const name = decodeURIComponent(url.searchParams.get('name') || 'pasted');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      await new Promise(done => req.on('end', done));
      try { json(res, 200, await attachBytes(server, name, Buffer.concat(chunks))); }
      catch (e) { json(res, 502, { error: String(e.message || e) }); }
      return true;
    }
    if (action === 'tunnel' && req.method === 'DELETE') {
      await stopTunnel(server);
      return json(res, 200, { ok: true }), true;
    }
  }

  return false;
}

// --------------------------------------------------------------------------
// the web gateway
//
// A reverse proxy in front of one or more daemons, so a browser can reach a
// session with this Mac switched off. Two ssh identities, because they are
// two jobs: the gateway's nginx lives in /etc, which wants root, and the
// daemon deliberately does not run as root -- an agent that runs arbitrary
// commands should not be running them as one.
//
// nginx proxies `/` to a daemon rather than serving app/web off the gateway's
// disk. That daemon already has the console (provisioning put it there), so
// there is nothing to copy, nothing to keep in step, and no way for the
// gateway's copy to drift from the protocol the daemon speaks.
// --------------------------------------------------------------------------

// One directory per hostname, not one shared one. The two installs are meant
// to share nothing, and they can perfectly well share a gateway -- but they
// each write a server list here, and a single path means whichever applied
// last decides what the other's console sees.
const WEB_ROOT_BASE = '/srv/caden-web';
const webRoot = hostname => `${WEB_ROOT_BASE}/${hostname}`;

/// Where the gateway is, as a machine somewhere else would have to say it.
///
/// `gatewayHost` is an alias in this Mac's ssh config, which means nothing on
/// any other machine -- and the unit that dials the tunnel runs on the other
/// machine. `ssh -G` resolves the alias the way ssh itself would.
async function gatewayTarget(gatewayHost) {
  const out = await run('ssh', ['-G', gatewayHost], { timeout: 15000 });
  const read = key => (new RegExp(`^${key} (.+)$`, 'm').exec(out.stdout) || [])[1];
  const host = read('hostname');
  if (!host) throw new Error(`could not resolve the ssh alias ${gatewayHost}`);
  return { host, user: read('user') || 'root', port: Number(read('port')) || 22 };
}

function webConfig() {
  const cfg = readConfig();
  // `appliedHostname` is what is actually configured on the gateway right
  // now, which is not the same as what the settings say the moment somebody
  // types a new one -- and the difference is what tells apply there is an old
  // site to take down.
  const out = { hostname: '', gatewayHost: '', serverId: '', appliedHostname: '',
                // serverId -> the loopback port its tunnel binds on the
                // gateway, and serverId -> what holds that tunnel open there.
                tunnels: {}, tunnelHow: {}, ...(cfg.web || {}) };
  return out;
}

/// A gateway port for this server's tunnel, stable once chosen: the unit on
/// the server and the nginx block on the gateway have to agree on it, and
/// they are written at different times.
function tunnelPortFor(serverId) {
  const web = webConfig();
  if (web.tunnels[serverId]) return web.tunnels[serverId];
  const taken = new Set(Object.values(web.tunnels));
  let port = flavor.tunnelBase;
  while (taken.has(port)) port++;
  saveWebConfig({ tunnels: { ...web.tunnels, [serverId]: port } });
  return port;
}

/// How a server's tunnel is held open, once we know. Kept beside the port
/// rather than in it: `tunnels` is read as `serverId -> port` in four places,
/// and the pane needs the mechanism to say whether it survives a reboot.
function rememberTunnel(serverId, port, how) {
  const web = webConfig();
  saveWebConfig({
    tunnels: { ...web.tunnels, [serverId]: port },
    tunnelHow: { ...(web.tunnelHow || {}), [serverId]: how },
  });
}

function saveWebConfig(patch) {
  const cfg = readConfig();
  cfg.web = { ...webConfig(), ...patch };
  writeConfig(cfg);
  return cfg.web;
}

/// A shell on the gateway. Not provisionShell: that one is about the machine
/// a daemon runs on, and this is about the machine nginx runs on, which is
/// reached as somebody who can write /etc.
function gatewayShell(gatewayHost) {
  if (!gatewayHost) throw new Error('no gateway host chosen');
  return (command, opts) => ssh({ sshHost: gatewayHost }, command, opts);
}

/// One `location` per daemon, with that daemon's token added on the way past.
/// The renderer already addresses servers as `/proxy/<id>/...`; this is the
/// same swap app/server.js does for it locally, written as configuration.
function webProxyBlocks(servers, ports) {
  return servers.map(s => {
    const port = ports.get(s.id);
    return [
      `    # ${(s.name || s.sshHost || s.id).replace(/[\r\n]/g, ' ')}`,
      `    location /proxy/${s.id}/ {`,
      `        proxy_pass http://127.0.0.1:${port}/;`,
      `        proxy_set_header Authorization "Bearer ${daemonToken(s)}";`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Connection "";',
      '        # An event stream that nginx buffers does not fail, it hangs --',
      '        # and looks exactly like a daemon that died.',
      '        proxy_buffering off;',
      '        proxy_read_timeout 3600s;',
      '        client_max_body_size 64m;',
      '    }',
    ].join('\n');
  }).join('\n\n');
}

function webSiteConfig({ hostname, consolePort, servers, ports, consoleToken }) {
  return `# Written by Caden. Edits here are replaced the next time the Web
# pane applies its settings.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${hostname};

    # Named rather than left to certbot. This file is rewritten on every
    # apply, so anything certbot inserted into the previous one is gone --
    # which is exactly how the first version of this took the site down: a
    # server block with no listener, accepted by nginx -t, answering nothing.
    ssl_certificate     /etc/letsencrypt/live/${hostname}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${hostname}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    limit_req zone=caden burst=50 nodelay;
    limit_req_status 429;

    # Checked before anything is served, including the routes that proxy to
    # other machines -- those never reach the daemon that owns the session, so
    # a check living only in a daemon would not cover them.
    auth_request /_caden_verify;
    error_page 401 = @caden_login;

    location = /_caden_verify {
        internal;
        proxy_pass http://127.0.0.1:${consolePort}/v1/web/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }
    location @caden_login { return 302 /login?next=$request_uri; }

    # Signing in cannot require being signed in.
    location = /login {
        auth_request off;
        proxy_pass http://127.0.0.1:${consolePort}/login;
        proxy_set_header Host $host;
    }
    location = /v1/web/login {
        auth_request off;
        proxy_pass http://127.0.0.1:${consolePort}/v1/web/login;
        proxy_set_header Host $host;
    }
    location = /v1/web/logout {
        auth_request off;
        proxy_pass http://127.0.0.1:${consolePort}/v1/web/logout;
        proxy_set_header Host $host;
    }

    # The server list. A file, because nothing on this side generates one.
    location = /host/config {
        root ${webRoot(hostname)};
        default_type application/json;
        add_header Cache-Control "no-cache" always;
    }
    # Everything else under /host/ is the desktop app's control plane and does
    # not exist here. Saying 404 beats letting the console below answer with
    # index.html, which the renderer then fails to parse as JSON.
    location /host/ { return 404; }

${webProxyBlocks(servers, ports)}

    # The console itself, from the daemon that already has it -- so there is
    # no second copy on this machine to fall out of step.
    location / {
        proxy_pass http://127.0.0.1:${consolePort}/;
        proxy_set_header Authorization "Bearer ${consoleToken}";
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
    }
}

# Plain HTTP exists only to send people to the other one, and to carry the
# ACME challenge when the certificate is renewed.
server {
    listen 80;
    listen [::]:80;
    server_name ${hostname};
    location /.well-known/acme-challenge/ { root ${webRoot(hostname)}; }
    location / { return 301 https://$host$request_uri; }
}
`;
}

/// What the console reads instead of asking a host process, because behind a
/// proxy there is no host process. No capabilities: nothing here can add a
/// server, run ssh or raise a file dialog.
function webHostConfig(servers) {
  const cfg = readConfig();
  return JSON.stringify({
    servers: servers.map(s => ({ id: s.id, name: s.name || s.sshHost || s.id,
                                 mode: 'direct', provisioned: true })),
    models: cfg.models || [],
    providers: (cfg.providers || []).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: true })),
    defaults: {
      workdir: cfg.defaultWorkdir || '~',
      permissionMode: cfg.defaultPermissionMode || 'bypassPermissions',
    },
    capabilities: {},
  }, null, 2);
}

/// Give a server a tunnel to the gateway, so the proxy can reach its daemon.
///
/// The direction is the whole point: the server dials out. The gateway never
/// connects to it, needs no key for it, and the server needs no public
/// address and no hole in a firewall. `ssh -R` binds the far end on 127.0.0.1,
/// so nothing but nginx can reach what comes out of it.
///
/// Idempotent -- it is also how a tunnel gets repaired after the gateway
/// moves or the port changes.
async function setupTunnel(server, onStep = () => {}) {
  const { gatewayHost } = webConfig();
  if (!gatewayHost) throw new Error('set the gateway up first');
  const port = tunnelPortFor(server.id);
  const gw = await gatewayTarget(gatewayHost);
  const sh = provisionShell(server);
  const gwSh = gatewayShell(gatewayHost);

  // A key of its own, not the one the person uses. Revoking a tunnel should
  // not be a decision about anything else, and the entry it goes into on the
  // gateway is deliberately allowed to do nothing but forward.
  onStep('making a key for the tunnel…');
  const key = await sh(
    'set -eu; mkdir -p ~/.ssh; chmod 700 ~/.ssh; '
    + '[ -f ~/.ssh/caden-tunnel ] || ssh-keygen -q -t ed25519 -N "" '
    + '-C "caden-tunnel" -f ~/.ssh/caden-tunnel; cat ~/.ssh/caden-tunnel.pub');
  const pub = String(key.stdout).trim().split('\n').pop();
  if (!/^ssh-/.test(pub)) throw new Error(`could not read a public key from ${server.name}`);

  onStep('authorising it on the gateway, for forwarding only…');
  const tag = `caden-tunnel:${server.id}`;
  // restrict turns everything off; port-forwarding turns back on the one
  // thing this key is for. No shell, no agent, no pty.
  const line = `restrict,port-forwarding ${pub.split(/\s+/).slice(0, 2).join(' ')} ${tag}`;
  await gwSh([
    'set -eu',
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys',
    // Replace this server's entry rather than accumulating one per run.
    `grep -v ' ${tag}$' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true`,
    `printf '%s\\n' ${JSON.stringify(line)} >> ~/.ssh/authorized_keys.tmp`,
    'chmod 600 ~/.ssh/authorized_keys.tmp && mv -f ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys',
  ].join('\n'));

  const remotePort = server.remotePort || DEFAULT_PORT;
  // The command itself, identical whichever thing ends up holding it open.
  // `ExitOnForwardFailure` is what makes a launcher's success mean something:
  // without it ssh stays connected after the remote bind is refused, and every
  // rung below would report a tunnel that forwards nothing.
  const cmd = `ssh -N -T -i "$HOME/.ssh/caden-tunnel" `
    // A path that drops the SYN costs the default connect timeout otherwise,
    // and on a machine where half the attempts do that, the retry below is
    // only as good as how quickly a bad attempt gives up.
    + '-o ConnectTimeout=10 '
    + '-o ExitOnForwardFailure=yes -o ServerAliveInterval=30 '
    + '-o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new '
    + `-o IdentitiesOnly=yes -p ${gw.port} `
    + `-R ${port}:127.0.0.1:${remotePort} ${gw.user}@${gw.host}`;
  const started = await startTunnelProcess(server, sh, cmd, port, onStep);

  onStep('checking the gateway can reach it…');
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const probe = await gwSh(`curl -fsS --max-time 3 http://127.0.0.1:${port}/v1/ping || true`);
    if (/"ok"\s*:\s*true/.test(probe.stdout)) {
      rememberTunnel(server.id, port, started.how);
      return { port, how: started.how, supervised: started.supervised };
    }
  }
  // Started, but the gateway cannot see it: the launcher took the command and
  // ssh went away again. Its own diagnosis is the useful half.
  const why = await sh(started.diagnose || 'true').catch(() => ({ stdout: '' }));
  throw new Error(
    `${server.name || 'the server'} started the tunnel with ${started.how} but `
    + `nothing answered on ${port} at the gateway`
    + (String(why.stdout).trim() ? `: ${String(why.stdout).trim().slice(0, 300)}` : ''));
}

/// Every way we know to hold a long-running command open on a server, best
/// first. "Best" is how much it survives: a reboot, a logout, or only until
/// something kills it.
///
/// This is a ladder rather than one mechanism because the mechanism is not
/// ours to choose. A systemd user unit is the right answer and the one most
/// hosts take; a container-shaped devbox has no user bus at all
/// (`systemctl --user` answers "Failed to connect to bus"), and some of those
/// have no `crontab` either. Caden used to write the unit, call
/// `systemctl --user restart`, and take the failure as the end of the story --
/// so on those hosts the tunnel silently did not exist while provisioning
/// reported success, and the console showed a 502 with nothing anywhere
/// saying why.
///
/// `supervise.sh` has always done this for the daemon, down to giving up
/// gracefully when neither systemd nor cron is there. The tunnel simply never
/// learned the same lesson.
const TUNNEL_LAUNCHERS = [
  {
    how: 'systemd',
    supervised: 'reboot',
    // A user bus, or there is nothing to talk to. `is-system-running` answers
    // `offline` and exits non-zero where there is none, which is exactly the
    // case this rung has to decline rather than fail on.
    detect: 'systemctl --user show-environment >/dev/null 2>&1',
    install: (cmd, unitCmd) => [
      'mkdir -p ~/.config/systemd/user',
      `cat > ~/.config/systemd/user/caden-tunnel.service <<'CADEN_UNIT'`,
      '[Unit]',
      'Description=Caden tunnel to the web gateway',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=/bin/sh -c ${shq(unitCmd)}`,
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      'CADEN_UNIT',
      'systemctl --user daemon-reload',
      'systemctl --user enable caden-tunnel.service >/dev/null 2>&1 || true',
      'systemctl --user restart caden-tunnel.service',
      // Refused where the user has no polkit rights; there the tunnel comes
      // back on first login, like the daemon it serves already does.
      'loginctl enable-linger "$(whoami)" >/dev/null 2>&1 || true',
    ].join('\n'),
    diagnose: 'systemctl --user status caden-tunnel.service --no-pager -n 6 2>&1 | tail -6',
  },
  {
    how: 'cron',
    supervised: 'reboot',
    detect: 'command -v crontab >/dev/null 2>&1',
    // `@reboot` brings it back, and the minute line is the watchdog: the
    // keepalive script is a no-op while the tunnel is alive, so running it
    // every minute costs nothing and covers a tunnel that died in between.
    install: (cmd, unitCmd, keep) => [
      `cat > ~/.caden-tunnel.sh <<'CADEN_KEEP'`,
      keep,
      'CADEN_KEEP',
      'chmod 700 ~/.caden-tunnel.sh',
      // Our two lines, replaced rather than accumulated.
      '(crontab -l 2>/dev/null | grep -v caden-tunnel.sh || true) > ~/.caden-cron.tmp',
      `printf '@reboot %s\\n' "$HOME/.caden-tunnel.sh" >> ~/.caden-cron.tmp`,
      `printf '* * * * * %s\\n' "$HOME/.caden-tunnel.sh" >> ~/.caden-cron.tmp`,
      'crontab ~/.caden-cron.tmp && rm -f ~/.caden-cron.tmp',
      '~/.caden-tunnel.sh',
    ].join('\n'),
    diagnose: 'tail -6 ~/.caden-tunnel.log 2>/dev/null',
  },
  {
    how: 'nohup',
    // Honest about what it is: the process outlives the ssh session that
    // started it and nothing more. Worth having as the last rung, because a
    // tunnel that works until the next reboot is worth a great deal more than
    // no tunnel -- but the pane has to say so rather than draw a tick.
    supervised: 'none',
    detect: 'true',
    install: (cmd, unitCmd, keep, loop) => [
      `cat > ~/.caden-tunnel.sh <<'CADEN_LOOP'`,
      loop,
      'CADEN_LOOP',
      'chmod 700 ~/.caden-tunnel.sh',
      // setsid so it outlives the ssh session that installed it, and </dev/null
      // so it does not hold that session open waiting for input.
      '(setsid ~/.caden-tunnel.sh </dev/null >/dev/null 2>&1 &)',
    ].join('\n'),
    diagnose: 'tail -6 ~/.caden-tunnel.log 2>/dev/null',
  },
];

/// Try each launcher in turn until one of them starts the tunnel.
///
/// Detection and starting are separate questions: a rung that cannot apply
/// here is skipped quietly, while one that applies and then fails is worth
/// saying out loud, because that is a host where the expected thing broke.
async function startTunnelProcess(server, sh, cmd, port, onStep) {
  // Restarts the tunnel unless it is already running, so it is safe as both
  // the starter and the every-minute watchdog. `pgrep -f` on the exact remote
  // port is what tells this tunnel from any other ssh on the box.
  // Two scripts, because the two lower rungs need different things of them.
  //
  // Under cron this runs every minute and must be a no-op while the tunnel is
  // up, so it checks and exits. Started bare there is nothing to run it again,
  // so it has to be its own supervisor -- and on a machine whose egress drops
  // half its outbound SYNs, that is the difference between a tunnel and no
  // tunnel: the first attempt is a coin flip, and one that lost used to be
  // the end of it.
  const once = `pgrep -f "R ${port}:127.0.0.1:" >/dev/null 2>&1`;
  const keep = [
    '#!/bin/sh',
    '# Written by Caden. Starts the web-gateway tunnel unless it is up.',
    `${once} && exit 0`,
    `exec setsid nohup ${cmd} >> "$HOME/.caden-tunnel.log" 2>&1 &`,
  ].join('\n');
  const loop = [
    '#!/bin/sh',
    '# Written by Caden. Holds the web-gateway tunnel open.',
    '#',
    '# This machine has neither a systemd user session nor cron, so nothing',
    '# else would start the tunnel again -- not after a crash, and not after',
    '# a first attempt that simply failed to connect.',
    // Its own pid, so the next install can stop it by number. Matching on the
    // script name would not do: the command that installs it has that name in
    // it too, and would kill itself partway through.
    'echo $$ > "$HOME/.caden-tunnel.pid"',
    'while true; do',
    `  ${cmd} >> "$HOME/.caden-tunnel.log" 2>&1`,
    '  sleep 5',
    'done',
  ].join('\n');

  // Whatever is already holding a tunnel here, whichever rung put it there.
  // Reconnecting can move the port -- the ranges are per-flavor now, and a
  // server set up before that gets a new one -- and a loop left running would
  // go on restoring the old forward, holding a port on the gateway that
  // belongs to somebody else.
  const stop = [
    '[ -f "$HOME/.caden-tunnel.pid" ] && kill "$(cat "$HOME/.caden-tunnel.pid")" 2>/dev/null || true',
    'rm -f "$HOME/.caden-tunnel.pid"',
    'systemctl --user stop caden-tunnel.service >/dev/null 2>&1 || true',
    `pkill -f "R [0-9]*:127.0.0.1:${server.remotePort || DEFAULT_PORT}" >/dev/null 2>&1 || true`,
  ].join('\n');
  await sh(stop).catch(() => {});

  const tried = [];
  for (const l of TUNNEL_LAUNCHERS) {
    const ok = await sh(`${l.detect} && echo yes || echo no`).catch(() => ({ stdout: 'no' }));
    if (!/yes/.test(String(ok.stdout))) { tried.push(`${l.how}: not available here`); continue; }
    onStep(`starting the tunnel with ${l.how}…`);
    try {
      await sh(['set -eu', l.install(cmd, cmd, keep, loop)].join('\n'));
      return { how: l.how, supervised: l.supervised, diagnose: l.diagnose };
    } catch (e) {
      tried.push(`${l.how}: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
      onStep(`${l.how} did not take, trying the next way…`);
    }
  }
  throw new Error(
    `no way to keep a tunnel open on ${server.name || 'this server'} — `
    + `tried ${TUNNEL_LAUNCHERS.map(l => l.how).join(', ')}. ${tried.join('; ')}`);
}

/// Shell-quote a string for use inside single quotes.
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

/// Set the gateway up, or bring it in line with the settings. Idempotent:
/// this is also how you apply a changed hostname or a new server.
///
/// Everything runs as one script over one ssh connection, the way
/// provisioning does, so a half-applied state is a script that stopped rather
/// than five commands that partly went through.
async function applyWebGateway(onStep = () => {}) {
  const { hostname, gatewayHost, serverId } = webConfig();
  if (!hostname) throw new Error('choose a hostname first');
  if (!gatewayHost) throw new Error('choose which machine runs the proxy');
  const server = (readConfig().servers || []).find(x => x.id === serverId);
  if (!server) throw new Error('choose which server serves the console');
  if (!daemonToken(server)) {
    throw new Error(`no daemon token for ${server.name || serverId} — provision it first`);
  }

  // Every server the proxy can actually reach: the one on the gateway, which
  // is on its own loopback, plus any that have dialled a tunnel to it. A
  // server with neither is left out rather than given a route to nothing --
  // a row that reads as broken is a worse answer than a row that is absent.
  const web = webConfig();
  const wired = [];
  const ports = new Map();
  for (const s of (readConfig().servers || [])) {
    if (!s.provisioned || !daemonToken(s)) continue;
    if (web.tunnels[s.id]) { ports.set(s.id, web.tunnels[s.id]); wired.push(s); }
    else if (s.id === serverId) {
      ports.set(s.id, s.remotePort || DEFAULT_PORT); wired.push(s);
    }
  }
  const consolePort = ports.get(server.id);
  if (!consolePort) throw new Error(`${server.name || serverId} has no route from the gateway`);
  const sh = gatewayShell(gatewayHost);
  const marker = `__CADEN_${require('crypto').randomBytes(9).toString('hex')}__`;
  const file = (path_, body, mode) => [
    `cat > ${path_} <<'${marker}'`, body.replace(/\n$/, ''), marker,
    mode ? `chmod ${mode} ${path_}` : '',
  ].filter(Boolean).join('\n');

  onStep('checking the gateway…');
  const pre = await sh('command -v nginx >/dev/null && echo nginx; '
                     + 'command -v certbot >/dev/null && echo certbot; '
                     + 'id -u');
  if (!/nginx/.test(pre.stdout)) throw new Error(`${gatewayHost} has no nginx`);
  if ((pre.stdout.match(/^0$/m) || []).length === 0) {
    throw new Error(`${gatewayHost} does not connect as root, and /etc/nginx needs it`);
  }
  const haveCertbot = /certbot/.test(pre.stdout);

  // Resolved from the gateway, and compared with the address the gateway
  // answers on. Getting the A record wrong is the likeliest thing to go wrong
  // here, and the way it surfaces otherwise is a certbot failure -- which
  // costs one of Let's Encrypt's five certificates a week for this name, so
  // it is worth a question first rather than an attempt.
  const certPath = `/etc/letsencrypt/live/${hostname}/fullchain.pem`;
  const haveCert = /yes/.test((await sh(`test -f ${certPath} && echo yes || echo no`)).stdout);
  if (!haveCert) {
    onStep(`checking that ${hostname} points here…`);
    const dns = await sh(`getent hosts ${hostname} | awk '{print $1}' | sort -u | tr '\\n' ' '; `
                       + "echo '|'; curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true");
    const [resolvedRaw, mineRaw] = String(dns.stdout).split('|');
    const resolved = (resolvedRaw || '').trim().split(/\s+/).filter(Boolean);
    const mine = (mineRaw || '').trim();
    if (!resolved.length) {
      throw new Error(`${hostname} does not resolve. Add an A record for it `
                    + `pointing at ${mine || 'this machine'}, wait for it to `
                    + 'take, and try again.');
    }
    if (mine && !resolved.includes(mine)) {
      throw new Error(`${hostname} resolves to ${resolved.join(', ')}, but this `
                    + `machine answers on ${mine}. Point the A record at `
                    + `${mine}, or choose the machine it already points at.`);
    }
  }

  // A plain HTTP site first, so certbot has something to attach to and its
  // challenge is not behind the sign-in that does not exist yet.
  onStep('writing a temporary site so a certificate can be issued…');
  await sh([
    'set -eu',
    `mkdir -p ${webRoot(hostname)}/host`,
    file(`/etc/nginx/sites-available/${hostname}`,
         `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${hostname};\n`
         + `    root ${webRoot(hostname)};\n}\n`),
    `ln -sf /etc/nginx/sites-available/${hostname} /etc/nginx/sites-enabled/${hostname}`,
    'nginx -t >/dev/null',
    'systemctl reload nginx',
  ].join('\n'));

  if (!haveCert) {
    if (!haveCertbot) throw new Error(`${gatewayHost} has no certbot, and there is no certificate for ${hostname}`);
    onStep(`asking Let's Encrypt for a certificate for ${hostname}…`);
    const out = await sh(`certbot --nginx -d ${hostname} --non-interactive --agree-tos `
                       + '--register-unsafely-without-email --redirect 2>&1 | tail -4');
    const now = await sh(`test -f ${certPath} && echo yes || echo no`);
    if (!/yes/.test(now.stdout)) {
      throw new Error(`certbot did not produce a certificate: ${out.stdout.trim().slice(0, 300)}`);
    }
  } else {
    onStep('certificate already there');
  }

  onStep('writing the proxy configuration…');
  onStep(wired.length === 1 ? 'one server' : `${wired.length} servers`);
  const site = webSiteConfig({ hostname, consolePort, servers: wired, ports,
                              consoleToken: daemonToken(server) });
  await sh([
    'set -eu',
    file('/etc/nginx/conf.d/caden-ratelimit.conf',
         '# Two a second sustained is far above anything real use produces --\n'
       + '# an event stream is one connection, not a poll -- and the burst in\n'
       + '# the site below covers a cold page load. What it caps is guessing.\n'
       + 'limit_req_zone $binary_remote_addr zone=caden:1m rate=120r/m;\n'),
    `mkdir -p ${webRoot(hostname)}/host`,
    file(`${webRoot(hostname)}/host/config.tmp`, webHostConfig(wired)),
    `mv -f ${webRoot(hostname)}/host/config.tmp ${webRoot(hostname)}/host/config`,
    // Written beside the live one and moved into place only once nginx has
    // agreed to it, so a rejected config cannot take the site down.
    file(`/etc/nginx/sites-available/${hostname}.new`, site),
    `cp /etc/nginx/sites-available/${hostname} /etc/nginx/sites-available/${hostname}.prev || true`,
    `mv -f /etc/nginx/sites-available/${hostname}.new /etc/nginx/sites-available/${hostname}`,
    `if ! nginx -t 2>/tmp/caden-nginx.err; then `
      + `mv -f /etc/nginx/sites-available/${hostname}.prev /etc/nginx/sites-available/${hostname}; `
      + 'cat /tmp/caden-nginx.err >&2; exit 1; fi',
    `rm -f /etc/nginx/sites-available/${hostname}.prev`,
    'systemctl reload nginx',
  ].join('\n')).catch(e => {
    throw new Error(`nginx refused the configuration and it was rolled back: ${String(e.message || e).slice(0, 300)}`);
  });

  // A renamed gateway leaves its old site enabled, still answering, still
  // renewing a certificate for a name nobody uses. Taken down only after the
  // new one is up and nginx has accepted it.
  const { appliedHostname } = webConfig();
  if (appliedHostname && appliedHostname !== hostname) {
    onStep(`taking down the old address, ${appliedHostname}…`);
    await sh([
      `rm -f /etc/nginx/sites-enabled/${appliedHostname}`,
      `rm -f /etc/nginx/sites-available/${appliedHostname}`,
      `rm -rf ${webRoot(appliedHostname)}`,
      'nginx -t >/dev/null && systemctl reload nginx',
    ].join('\n')).catch(() => {});
    // The certificate is left alone. Deleting one is not something to do
    // without being asked, and an unused one costs nothing but a renewal.
    onStep(`the certificate for ${appliedHostname} is still there; `
         + `certbot delete --cert-name ${appliedHostname} removes it`);
  }
  saveWebConfig({ appliedHostname: hostname });

  onStep('installing the brute-force ban…');
  await sh([
    'set -eu',
    'if command -v fail2ban-client >/dev/null 2>&1; then',
    file('/etc/fail2ban/filter.d/caden-login.conf',
         '[Definition]\nfailregex = ^<HOST> .* "POST /v1/web/login HTTP/[0-9.]+" 401\nignoreregex =\n'),
    // backend=polling is not optional on Debian: the default reads the
    // journal, and nginx logs to files, so the jail would watch nothing while
    // reporting itself enabled.
    file('/etc/fail2ban/jail.d/caden.conf',
         '[caden-auth]\nenabled  = true\nfilter   = caden-login\n'
       + 'port     = http,https\nbackend  = polling\n'
       + 'logpath  = /var/log/nginx/access.log\n'
       + 'maxretry = 5\nfindtime = 600\nbantime  = 3600\n'),
    'systemctl restart fail2ban || true',
    'else echo "no fail2ban on this host; skipped" >&2; fi',
  ].join('\n'));

  onStep('done');
  return { hostname, url: `https://${hostname}/` };
}

/// Put a freshly provisioned server on the phone.
///
/// Whether the console has a password yet, and whether the address answers.
/// `probe: false` answers from the config alone -- no ssh, no network.
///
/// Almost everything the pane draws is already known here: the address, which
/// machine runs the proxy, which daemon serves the console, the list of
/// servers. Only the ticks beside them need asking. Making the whole pane wait
/// on the asking meant it sat blank for as long as the slowest check, which
/// reads as a pane that is broken rather than one that is still counting.
async function webStatus({ probe = true } = {}) {
  const web = webConfig();
  const servers = (readConfig().servers || []).filter(s => s.provisioned);
  const out = { ...web, servers: servers.map(s => ({ id: s.id, name: s.name || s.sshHost || s.id })),
                sshHosts: sshHosts().map(h => h.host), passwordSet: null,
                cert: null, reachable: null, probed: probe };
  if (!probe) {
    // What is knowable without asking anyone. `null` where a check would go,
    // which the pane draws as "still counting" rather than as an answer.
    out.reach = {};
    for (const sv of servers) {
      out.reach[sv.id] = isLocalServer(sv) ? 'local'
        : (sv.id === web.serverId && !web.tunnels[sv.id]) ? 'gateway'
        : web.tunnels[sv.id] ? null : 'none';
    }
    return out;
  }
  // Which servers the gateway can actually reach, and how.
  const gwSh = web.gatewayHost ? gatewayShell(web.gatewayHost) : null;
  out.reach = {};
  // In parallel, and so is everything below it. Each of these is an ssh round
  // trip, and a server whose tunnel is down costs the curl's own three seconds
  // on top -- run one after another that is a pane sitting on "Checking…" for
  // as long as it takes to ask every question in turn. They do not depend on
  // each other, so there was never a reason to.
  const reachOne = async s => {
    if (isLocalServer(s)) return 'local';
    if (s.id === web.serverId && !web.tunnels[s.id]) return 'gateway';
    const port = web.tunnels[s.id];
    if (!port) return 'none';
    if (!gwSh) return 'unknown';
    const probe = await gwSh(`curl -fsS --max-time 3 http://127.0.0.1:${port}/v1/ping || true`)
      .catch(() => null);
    return probe && /"ok"\s*:\s*true/.test(probe.stdout) ? 'tunnel' : 'down';
  };
  const reached = await Promise.all(servers.map(reachOne));
  servers.forEach((s, i) => { out.reach[s.id] = reached[i]; });
  const server = servers.find(s => s.id === web.serverId);
  const [passwordSet, cert, reachable] = await Promise.all([
    (async () => {
      if (!server) return null;
      const sh = provisionShell(server);
      const home = server.remoteHome || REMOTE_HOME;
      const r = await sh(`test -s ${home}/web-password && echo yes || echo no`).catch(() => null);
      return r ? /yes/.test(r.stdout) : null;
    })(),
    (async () => {
      if (!(web.gatewayHost && web.hostname)) return null;
      const sh = gatewayShell(web.gatewayHost);
      const r = await sh(`openssl x509 -enddate -noout -in `
        + `/etc/letsencrypt/live/${web.hostname}/fullchain.pem 2>/dev/null || true`).catch(() => null);
      const m = r && /notAfter=(.+)/.exec(r.stdout);
      return m ? m[1].trim() : null;
    })(),
    (async () => {
      if (!web.hostname) return null;
      // The sign-in redirect is the healthy answer: it means nginx is there
      // and the check in front of it is working.
      return new Promise(resolve => {
        const req = https.request(`https://${web.hostname}/`, { method: 'GET', timeout: 6000 },
          r => { resolve(r.statusCode || 0); r.destroy(); });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
      });
    })(),
  ]);
  out.passwordSet = passwordSet;
  out.cert = cert;
  out.reachable = reachable;
  return out;
}

/// Called on quit: the forwards are this app's doing, so they go with it.
/// Best effort and synchronous-ish — the process is on its way out.
function shutdown() {
  const servers = readConfig().servers || [];
  for (const id of [...tunnels.keys()]) {
    const child = tunnels.get(id);
    if (child && child.exitCode === null) child.kill();
    tunnels.delete(id);
    const server = servers.find(s => s.id === id);
    if (!server) continue;
    const port = localPortOf(server);
    spawn('ssh', [...sshArgs(server), '-O', 'cancel',
                  '-L', `127.0.0.1:${port}:127.0.0.1:${server.remotePort}`,
                  sshTarget(server)], { stdio: 'ignore', detached: true }).unref();
  }
}

/// Have this machine ready to run agents, without being asked.
///
/// The Mac the app is on is a server like any other, and it is the only one
/// that needs no ssh, no forward and no credentials -- so there is nothing to
/// decide, and a button to decide it was ceremony. The entry is created before
/// the host server starts serving, so the renderer's first read of the config
/// already has it; installing the daemon into it happens in the background,
/// and the server list's own retry brings it online when that finishes.
///
/// Idempotent: an entry that is already provisioned and has a token is left
/// exactly as it is.
async function ensureLocalServer() {
  let entry;
  try {
    const servers = readConfig().servers || [];
    entry = servers.find(s => s.mode === 'direct' && !s.sshHost);
    // Only into an empty config. Someone who already has servers has already
    // been through this, and adding to their list on an upgrade -- or putting
    // back one they deleted on purpose -- is not readiness, it is meddling.
    if (!entry) {
      if (servers.length) return;
      entry = addLocalServer();
    }
  } catch (e) {
    console.warn(`caden: could not add this machine as a server: ${e.message || e}`);
    return;
  }
  if (entry.provisioned && daemonToken(entry)) return;
  // Installing a daemon is the one part with a footprint outside the config,
  // so the suites turn it off: they assert the entry, not the install.
  if (process.env.CADEN_NO_LOCAL_INSTALL) return;
  try {
    await provision(entry, {}, () => {});
  } catch (e) {
    // Not fatal, and not worth a dialog: the server is in the list, and the
    // supervisor retries it like any other machine that is not answering yet.
    console.warn(`caden: this machine is not ready yet: ${e.message || e}`);
  }
}

module.exports = {
  route, readConfig, daemonBase, daemonToken, providerKey, expandTilde,
  buildProvisionScript, webPayload, providerSecrets, provision, shutdown,
  forwardUsable, removeServer,
  ensureLocalServer,
  // Reached only by the suites: the launcher ladder is worth testing against
  // fake machines, and copying it into the test would make the copy the thing
  // that goes stale.
  __testing__: { startTunnelProcess, TUNNEL_LAUNCHERS, run },
};
