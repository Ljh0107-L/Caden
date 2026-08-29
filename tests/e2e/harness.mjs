// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The real stack, minus a model: a heartbeat daemon with its built-in mock engine
// and the host server with a temp config pointing at it. No credentials, no
// keychain -- the server entry uses tokenFile, which is cross-platform, so
// the same harness runs on a Mac and on Linux CI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const freePort = () => new Promise(res => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
});

const waitFor = async (pred, timeout = 15000, label = '') => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const up = async url => {
  try { return (await fetch(url)).ok; } catch { return false; }
};

/// `providers` replaces the model list for scenarios that need a model the
/// mock provider cannot stand in for -- a chip drawn only for Claude's Opus,
/// say. The default is one mock model, which is what every other file here
/// assumes.
///
/// `machines` is how many daemons to stand up, each on its own home and its
/// own server entry. One is the default and what every other file here
/// assumes; the sidebar groups sessions per server, and two real daemons are
/// the only way to see it do that.
export async function start({ providers = null, machines = 1 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-e2e-'));

  const daemons = [];
  for (let i = 0; i < machines; i++) {
    const home = path.join(tmp, i ? `home-${i + 1}` : 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server', 'heartbeat.py'),
                    path.join(home, 'heartbeat.py'));
    // Foreground so kill() actually reaps it; a daemonized grandchild would
    // survive the cleanup.
    const port = await freePort();
    const proc = spawn('python3',
      [path.join(home, 'heartbeat.py'), '--foreground', '--port', String(port)],
      { cwd: home, env: { ...process.env, CADEN_HOME: home }, stdio: 'ignore' });
    // The first keeps the name every other file matches on.
    daemons.push({ home, port, proc,
                   id: i ? `e2e-server-${i + 1}` : 'e2e-server',
                   name: i ? `E2E-${i + 1}` : 'E2E' });
  }

  const config = {
    servers: [...daemons.map(d => ({
      id: d.id, name: d.name, mode: 'direct',
      directURL: `http://127.0.0.1:${d.port}`,
      tokenFile: path.join(d.home, 'token'),
      provisioned: true,
    })), {
      // Never answers, and has no token: the state every server is in before
      // it is set up. The Servers pane used to throw rendering it -- there is
      // no engines block to read -- and a throw out of the render left every
      // row on "Checking…" for good.
      id: 'e2e-unset', name: 'Not set up', mode: 'direct',
      directURL: 'http://127.0.0.1:9', tokenFile: '', provisioned: false,
    }],
    providers: providers || [{
      id: 'mock-prov', name: 'Mock', proto: 'mock', baseURL: '',
      models: [{ id: 'mock-model', modelID: 'mock-1', alias: 'Mock',
                 contextWindow: 200000 }],
    }],
    models: [],
  };
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const appPort = await freePort();
  const app = spawn(process.execPath,
    [path.join(ROOT, 'app', 'server.js'), String(appPort)],
    { cwd: ROOT,
      // The harness brings its own server; this machine is not part of the
      // scenario, and installing a daemon into ~/.caden would outlive the run.
      env: { ...process.env, CADEN_CONFIG: configPath, CADEN_NO_LOCAL_INSTALL: '1' },
      stdio: 'ignore' });

  for (const d of daemons) {
    await waitFor(() => up(`http://127.0.0.1:${d.port}/v1/ping`), 15000, `daemon ${d.name}`);
  }
  await waitFor(() => up(`http://127.0.0.1:${appPort}/host/config`), 15000, 'host server');

  const reach = d => ({
    id: d.id, name: d.name, home: d.home,
    url: `http://127.0.0.1:${d.port}`,
    token: fs.readFileSync(path.join(d.home, 'token'), 'utf8').trim(),
  });

  return {
    appUrl: `http://127.0.0.1:${appPort}`,
    // For the gateway walk, which stands up its own front end in place of
    // app/server.js and needs to reach the daemon the way a reverse proxy
    // would: straight at it, with the token it reads off disk.
    daemonUrl: `http://127.0.0.1:${daemons[0].port}`,
    daemonToken: reach(daemons[0]).token,
    /// Every daemon, in config order, for the tests that need more than one.
    machines: daemons.map(reach),
    webRoot: path.join(ROOT, 'app', 'web'),
    async stop() {
      for (const d of daemons) d.proc.kill();
      app.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
