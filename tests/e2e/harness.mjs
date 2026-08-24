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

export async function start() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-e2e-'));
  const daemonHome = path.join(tmp, 'home');
  fs.mkdirSync(daemonHome, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server', 'heartbeat.py'),
                  path.join(daemonHome, 'heartbeat.py'));

  // Foreground so kill() actually reaps it; a daemonized grandchild would
  // survive the cleanup.
  const daemonPort = await freePort();
  const daemon = spawn('python3',
    [path.join(daemonHome, 'heartbeat.py'), '--foreground', '--port', String(daemonPort)],
    { cwd: daemonHome, env: { ...process.env, CADEN_HOME: daemonHome }, stdio: 'ignore' });

  const config = {
    servers: [{
      id: 'e2e-server', name: 'E2E', mode: 'direct',
      directURL: `http://127.0.0.1:${daemonPort}`,
      tokenFile: path.join(daemonHome, 'token'),
      provisioned: true,
    }, {
      // Never answers, and has no token: the state every server is in before
      // it is set up. The Servers pane used to throw rendering it -- there is
      // no engines block to read -- and a throw out of the render left every
      // row on "Checking…" for good.
      id: 'e2e-unset', name: 'Not set up', mode: 'direct',
      directURL: 'http://127.0.0.1:9', tokenFile: '', provisioned: false,
    }],
    providers: [{
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

  await waitFor(() => up(`http://127.0.0.1:${daemonPort}/v1/ping`), 15000, 'daemon');
  await waitFor(() => up(`http://127.0.0.1:${appPort}/host/config`), 15000, 'host server');

  return {
    appUrl: `http://127.0.0.1:${appPort}`,
    // For the gateway walk, which stands up its own front end in place of
    // app/server.js and needs to reach the daemon the way a reverse proxy
    // would: straight at it, with the token it reads off disk.
    daemonUrl: `http://127.0.0.1:${daemonPort}`,
    daemonToken: fs.readFileSync(path.join(daemonHome, 'token'), 'utf8').trim(),
    webRoot: path.join(ROOT, 'app', 'web'),
    async stop() {
      daemon.kill(); app.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
