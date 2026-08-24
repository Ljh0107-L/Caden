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
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { servers: [], providers: [], models: [] };
  }
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
    child.on('close', finish);
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

function removeServer(id) {
  const cfg = readConfig();
  const gone = (cfg.servers || []).find(s => s.id === id);
  cfg.servers = (cfg.servers || []).filter(s => s.id !== id);
  writeConfig(cfg);
  if (gone) stopTunnel(gone).catch(() => {});
  execFile('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE,
                        '-a', `server.${id}`], () => {});
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

function buildProvisionScript(home, files, port, restart, web = []) {
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
    ...webScript(remoteHome, web, marker),
    `sh ${remoteHome}/bootstrap.sh --home ${remoteHome} --port ${Number(port) || DEFAULT_PORT} --supervise`
      + (restart ? ' --restart' : ''),
    '',
  ].join('\n');
  return script;
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

  const script = buildProvisionScript(home, files, server.remotePort, restart,
                                      webPayload());

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

/// Whether the forward actually carries traffic to the daemon.
///
/// An open port is not proof: a forward left over from a previous remote port
/// still accepts locally and then resets, because ssh only discovers there is
/// nothing to talk to once it tries to open the channel. When the daemon is
/// supposed to be there, make the forward prove it before reusing it.
async function forwardUsable(server) {
  if (!(await canConnect(localPortOf(server)))) return false;
  if (!server.provisioned) return true;
  const ping = await daemonGet(server, '/v1/ping', { auth: false, timeout: 5000 });
  return !!(ping && ping.ok);
}

function canConnect(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

async function startTunnel(server) {
  const port = localPortOf(server);
  if (await forwardUsable(server)) return { port, reused: true };
  // Whatever is holding the port cannot reach the daemon; clear it out first.
  await stopTunnel(server);

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
      removeServer(server.id);
      return json(res, 200, { ok: true }), true;
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
  buildProvisionScript, webPayload, provision, shutdown, ensureLocalServer,
};
