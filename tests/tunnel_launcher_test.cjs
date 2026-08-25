// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Whatever the machine has, the tunnel gets held open by it.
//
// Caden used to write a systemd user unit, call `systemctl --user restart`,
// and stop there. A container-shaped devbox has no user bus -- `systemctl
// --user` answers "Failed to connect to bus: No medium found" -- and some of
// those have no `crontab` either, so on those hosts the tunnel silently did
// not exist while provisioning reported success and the console showed a 502
// with nothing anywhere saying why.
//
// `supervise.sh` has always walked systemd, then cron, then given up
// gracefully. This is the tunnel learning the same thing, plus the part
// `supervise.sh` does not need: a last rung that starts the process bare,
// because a tunnel that works until the next reboot beats no tunnel -- as
// long as the pane says which one you have.
//
// It also holds the ssh helper's own robustness, which is the same subject
// from the other end: a launcher that cannot report why it failed is no better
// than one that never ran.
//
//   node tests/tunnel_launcher_test.cjs
'use strict';
const assert = require('node:assert');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// A machine, as far as the launcher can tell: which detections succeed, and
// which installs blow up once tried.
function machine({ systemd = false, cron = false, breaks = [] } = {}) {
  const ran = [];
  const sh = async script => {
    ran.push(script);
    if (/systemctl --user show-environment/.test(script)) {
      return { stdout: systemd ? 'yes' : 'no' };
    }
    if (/command -v crontab/.test(script)) return { stdout: cron ? 'yes' : 'no' };
    if (/^true &&/.test(script)) return { stdout: 'yes' };
    for (const b of breaks) {
      if (script.includes(b)) throw new Error(`${b} exploded`);
    }
    return { stdout: '' };
  };
  return { sh, ran };
}

const load = () => {
  // The launcher is internal; the test drives it through the module's own
  // export table rather than copying the ladder, which would then be a copy
  // that cannot go stale in the only way that matters.
  const host = require('../app/host.js');
  return host.__testing__ && host.__testing__.startTunnelProcess;
};

(async () => {
  const startTunnelProcess = load();
  if (!startTunnelProcess) {
    console.log('  FAIL   host.js does not expose startTunnelProcess for testing');
    process.exit(1);
  }
  const server = { id: 'srv', name: 'Dev' };
  const cmd = 'ssh -N -T -R 7902:127.0.0.1:7838 root@gw';
  const steps = [];
  const run = m => startTunnelProcess(server, m.sh, cmd, 7902, t => steps.push(t));

  // 1. The ordinary host: systemd wins and nothing else is tried.
  let m = machine({ systemd: true, cron: true });
  let out = await run(m);
  check('a host with systemd uses it', out.how === 'systemd', out.how);
  check('and that survives a reboot', out.supervised === 'reboot');
  check('the unit is what got written',
        m.ran.some(r => /caden-tunnel\.service/.test(r)));
  check('cron is not touched as well',
        !m.ran.some(r => /crontab ~\/.caden-cron/.test(r)));

  // 2. No user bus, but cron: the rung below takes it, and the watchdog line
  //    is what makes it survive as well as systemd would.
  m = machine({ systemd: false, cron: true });
  out = await run(m);
  check('no systemd falls through to cron', out.how === 'cron', out.how);
  check('which also survives a reboot', out.supervised === 'reboot');
  const cronScript = m.ran.find(r => /crontab ~\/\.caden-cron/.test(r)) || '';
  check('@reboot brings it back', /@reboot/.test(cronScript));
  check('and a watchdog line restarts it in between',
        /\* \* \* \* \*/.test(cronScript));
  check('the keepalive is a no-op while the tunnel is up',
        /pgrep -f "R 7902:127\.0\.0\.1:"/.test(cronScript),
        'otherwise the every-minute line starts a second tunnel every minute');

  // 3. Dev's case: neither. Started bare, and honest about it.
  m = machine({ systemd: false, cron: false });
  out = await run(m);
  check('neither one still starts the tunnel', out.how === 'nohup', out.how);
  check('but does not claim it survives a reboot',
        out.supervised === 'none',
        'the pane draws this differently — a tick here would mean two things');

  // 4. A rung that applies and then fails is not the end of the ladder.
  m = machine({ systemd: true, cron: true, breaks: ['systemctl --user restart'] });
  out = await run(m);
  check('a systemd that breaks falls through rather than giving up',
        out.how === 'cron', out.how);
  check('and says so while it happens',
        steps.some(t => /did not take, trying the next way/.test(t)));

  // 5. Everything gone: a real error naming what was tried, because this is
  //    the case that used to be silent.
  m = machine({ systemd: true, cron: true,
                breaks: ['systemctl --user restart', 'crontab ~/.caden-cron',
                         'caden-tunnel.sh'] });
  let err = null;
  try { await run(m); } catch (e) { err = e; }
  check('when nothing works it throws', !!err);
  check('and the message names every rung it tried',
        err && /systemd/.test(err.message) && /cron/.test(err.message)
        && /nohup/.test(err.message),
        err ? err.message.slice(0, 140) : '');

  // 6. And the other half of 0.2.1: setting a server up is not publishing it.
  //    Provisioning reached out to the gateway as a parting errand, so adding
  //    a machine touched a third host and a gateway that was down turned into
  //    a warning on an operation that had gone perfectly.
  const host = require('../app/host.js');
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'app', 'host.js'), 'utf8');
  const provision = src.slice(src.indexOf('async function provision('),
                              src.indexOf('// ------', src.indexOf('async function provision(')));
  check('provisioning does not set up a tunnel',
        !/setupTunnel|applyWebGateway|attachToWebGateway/.test(provision),
        'the Web pane is where a server joins the web');
  check('and nothing is left calling the old parting errand',
        !/attachToWebGateway/.test(src) && !host.attachToWebGateway);
  const sh = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'provision.sh'), 'utf8');
  check('the script does not either, so both ways agree',
        !/attachToWebGateway/.test(sh),
        '"provisioned" meaning two things is how the two drift');

  // 7. A far end that goes away mid-write must not take the app with it.
  //
  //    `child.on('error')` is the process's, not the pipe's, so nothing was
  //    listening when `stdin` emitted EPIPE -- and an 'error' event nobody
  //    listens for is an uncaught exception, which in Electron is a dialog
  //    over the whole app and a main process that stops. Harmless while the
  //    payload was three small files; provisioning now pushes a third of a
  //    megabyte of console through the same pipe, so a connection that dies
  //    partway is ordinary rather than rare.
  //
  //    `head -c1` is the far end: it reads one byte and exits.
  let crashed = null;
  const onCrash = e => { crashed = e; };
  process.on('uncaughtException', onCrash);
  const r = await host.__testing__.run('sh', ['-c', 'head -c1 >/dev/null'],
                                       { input: 'x'.repeat(8 * 1024 * 1024),
                                         timeout: 10000 });
  await new Promise(done => setTimeout(done, 300));
  process.removeListener('uncaughtException', onCrash);
  check('a far end that closes mid-write does not crash the process',
        !crashed, crashed ? crashed.message : '');
  check('it is a failed run instead', r.code === -1);
  check('and the reason survives into the step stream',
        /EPIPE/.test(r.stderr), JSON.stringify(r.stderr.trim().slice(0, 60)));

  console.log(failed ? '\ntunnel launcher: FAILED' : '\ntunnel launcher: OK');
  process.exit(failed ? 1 : 0);
})();
