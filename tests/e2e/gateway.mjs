// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The console with the Mac switched off.
//
// The deployment this is standing in for is a reverse proxy on a machine that
// is always on: it serves app/web off disk, answers /host/config from a file,
// and forwards /proxy/<id>/* to a daemon with that daemon's token added to the
// request. Nothing of app/host.js is in the path -- that is the whole point,
// and it is what makes this worth a test of its own rather than a flag on the
// existing one.
//
// So the question here is not "does the renderer work" (session.mjs covers
// that) but "does it work when the thing serving it can only proxy": no ssh,
// no keychain, no native dialogs. The renderer learns that from the
// capabilities block, and what it must do about it is hide the controls it
// would otherwise offer, while the part that matters from a phone -- read a
// session, send a message, watch the reply arrive -- keeps working.
//
//   node tests/e2e/gateway.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { start } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

/// What the deployment's `/host/config` says. One server, and no capabilities
/// at all -- a proxy cannot add a server, open a forward or run ssh, and says
/// so by declaring nothing.
const HOST_CONFIG = {
  servers: [{ id: 'e2e-server', name: 'E2E', mode: 'direct', provisioned: true }],
  models: [],
  providers: [{ id: 'mock-prov', name: 'Mock', proto: 'mock', baseURL: '', hasKey: false,
                models: [{ id: 'mock-model', modelID: 'mock-1', alias: 'Mock',
                           contextWindow: 200000 }] }],
  defaults: { workdir: '~', permissionMode: 'bypassPermissions' },
};

function gateway({ webRoot, daemonUrl, daemonToken }) {
  const upstream = new URL(daemonUrl);
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://gateway');

    if (url.pathname === '/host/config') {
      const body = JSON.stringify(HOST_CONFIG);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(body);
    }

    // `location /proxy/<id>/` with the prefix stripped and Authorization
    // added -- the two lines of the nginx block that carry all the weight.
    const m = url.pathname.match(/^\/proxy\/[^/]+(\/.*)$/);
    if (m) {
      const out = http.request({
        hostname: upstream.hostname, port: upstream.port,
        path: m[1] + url.search, method: req.method,
        headers: {
          Authorization: `Bearer ${daemonToken}`,
          'Content-Type': req.headers['content-type'] || 'application/json',
          Accept: req.headers.accept || '*/*',
          ...(req.headers['content-length']
            ? { 'Content-Length': req.headers['content-length'] } : {}),
        },
      }, up => {
        res.writeHead(up.statusCode || 502, {
          'Content-Type': up.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        up.pipe(res);            // unbuffered, or the event stream never arrives
      });
      out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(out);
      res.on('close', () => out.destroy());
      return;
    }

    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(webRoot, rel));
    if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1',
    () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

const harness = await start();
const front = await gateway(harness);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 },
                                     hasTouch: true, isMobile: true });
page.on('pageerror', e => { console.log(`  FAIL   page error: ${e.message}`); failed++; });

try {
  await page.goto(front.url);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 15000 });
  check('the console loads with no host behind it', true);

  // The reason this deployment exists: a session, from a phone, with nothing
  // of the Mac in the path.
  await page.locator('.empty-state .composer-editor').click();
  await page.keyboard.type('hello through the gateway');
  await page.locator('.empty-state .send-btn').click();
  await page.waitForSelector('text=Done: hello through the gateway', { timeout: 20000 });
  check('a session runs end to end through the proxy', true);

  // Which means the stream survived a hop it did not have before. A proxy
  // that buffers would hang here rather than fail, so the timeout above is
  // the assertion.
  check('the event stream survives the extra hop', true);

  // Attachments: no native panel to raise, so the + button opens the
  // browser's own and the bytes go straight at the daemon's upload endpoint.
  // What lands in the message is a path on the server, the same as the Mac
  // route produces -- the file has to physically get there either way.
  const scratch = path.join(os.tmpdir(), `caden-gw-attach-${Date.now()}.txt`);
  fs.writeFileSync(scratch, 'attached through the gateway\n');
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
  await page.locator('.composer-plus').first().click();
  await (await chooser).setFiles(scratch);
  await page.waitForFunction(
    () => /uploads|\/[^\s]*caden-gw-attach/.test(
      document.querySelector('.composer-editor')?.innerText || ''),
    null, { timeout: 15000 });
  const composed = await page.locator('.composer-editor').first().innerText();
  check('the + button uploads through the daemon and inserts the path',
        !composed.includes('could not attach') && composed.trim().length > 0,
        composed.trim().slice(0, 90));
  fs.rmSync(scratch, { force: true });

  // -- what must not be offered ------------------------------------------
  await page.locator('.collapsed-strip button').click();
  await page.locator('#sidebar .sidebar-header .nav-row', { hasText: 'Servers' }).click();
  await page.locator('.pane-intro-title', { hasText: 'Servers' }).waitFor({ timeout: 8000 });

  // The status check is a round trip that starts when the pane opens, so give
  // it one before reading the row.
  await page.locator('.models-pane', { hasText: 'heartbeat' })
    .waitFor({ timeout: 10000 }).catch(() => {});
  const body = await page.locator('.models-pane').innerText();
  check('the row is filled in from the daemon, with no host to ask',
        /heartbeat \d+\.\d+/.test(body) && !/not valid JSON/.test(body),
        body.replace(/\n/g, ' / ').slice(0, 160));
  check('no ssh-config section', !body.includes('From your SSH config'));

  // The Web pane configures the very proxy this page arrived through, over
  // ssh, as root. Offering it here would be offering to do all of that from
  // inside the thing it sets up.
  const nav = await page.locator('#sidebar .nav-row-label').allInnerTexts();
  check('and no Web pane, which is the Mac\'s job', !nav.includes('Web'),
        nav.join(', '));
  // Copy is part of it: describing ssh setup on a page that cannot offer it
  // sends someone hunting for a button that was deliberately not drawn.
  check('and the pane does not describe setting one up over ssh',
        !body.includes('install the daemon over ssh'),
        body.split('\n').slice(0, 2).join(' / '));
  check('no Set up button', !(await page.locator('.prov-acts', { hasText: 'Set up' }).count()));
  check('no Close forward button',
        !(await page.locator('.prov-acts', { hasText: 'Close forward' }).count()));

  const more = page.locator('.prov-act').first();
  if (await more.count()) {
    await more.click();
    const menu = await page.locator('.menu').innerText();
    check('the options menu offers nothing that needs ssh',
          !menu.includes('Upgrade the daemon') && !menu.includes('Remove server'), menu);
    check('and still offers what does not', menu.includes('Check again'), menu);
    await page.keyboard.press('Escape');
  }

  // The server still reports what it found -- hiding the actions must not
  // hide the diagnosis. /host/servers/<id>/status is the Mac answering a
  // question only it can answer, so the row has to be assembled from the
  // daemon instead: it knows its own version and its engines, and having
  // answered at all is the liveness the host was relaying second-hand.
  //
  // Found by deploying it. Behind a real nginx the missing /host route fell
  // through to the SPA fallback, the renderer was handed index.html where it
  // expected JSON, and the row read "Daemon: not installed" over a JSON parse
  // error -- on a daemon that was running perfectly.
  check('the server row still reports its state',
        body.includes('E2E'), body.slice(0, 120));

} catch (err) {
  console.log(`  FAIL   ${err.message}`);
  failed++;
} finally {
  await browser.close();
  front.close();
  await harness.stop();
}

console.log(failed ? '\ngateway: FAILED' : '\ngateway: OK');
process.exit(failed ? 1 : 0);
