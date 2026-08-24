#!/usr/bin/env node
// The heredoc sent over SSH must not add a byte to a bundled source file.
// The daemon revision check makes that otherwise invisible: it starts fine,
// but every upgrade continues to look stale.
//
// The console rides the same payload, and a font is the case the heredoc
// cannot carry -- a woff2 with a byte added is a woff2 the browser refuses.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildProvisionScript, webPayload } = require('../app/host');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-provision-upload-'));
const files = [
  { name: 'heartbeat.py', body: 'heartbeat source\n\n' },
  { name: 'bootstrap.sh', body: '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n' },
  { name: 'supervise.sh', body: 'supervise source\n' },
];
// Every byte value, so a transport that is not 8-bit clean cannot pass.
const fontBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const web = [
  { name: 'index.html', binary: false, body: Buffer.from('<!DOCTYPE html>\n<p>hi</p>\n') },
  { name: 'app.js', binary: false,
    // Quotes, backslashes and a `$` -- the heredoc marker is quoted, so none
    // of these should be touched, and this is the line that says so.
    body: Buffer.from('const s = "a\\\\b `$x` \'q\'";\n') },
  { name: 'fonts/probe.woff2', binary: true, body: fontBytes },
];

const script = buildProvisionScript(home, files, 17983, false, web);
const result = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8' });
try {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(home, file.name), 'utf8'), file.body,
                 `${file.name} changed during upload`);
  }
  for (const file of web) {
    const got = fs.readFileSync(path.join(home, 'web', file.name));
    assert.deepEqual(got, file.body, `web/${file.name} changed during upload`);
  }

  // Swapped in whole: the scratch directory must not survive a good run, or
  // the next one starts by deleting a copy it did not make.
  assert.ok(!fs.existsSync(path.join(home, 'web.new')), 'web.new was left behind');

  // What the bundle actually ships, rather than what this file made up.
  const real = webPayload();
  assert.ok(real.some(f => f.name === 'index.html'), 'index.html is not in the payload');
  assert.ok(real.some(f => f.name.startsWith('fonts/') && f.binary),
            'the fonts are not marked binary');
  assert.ok(!real.some(f => path.posix.basename(f.name).startsWith('.')),
            `a dotfile is in the payload: ${real.map(f => f.name).join(', ')}`);

  console.log('provision-upload_test: OK');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
