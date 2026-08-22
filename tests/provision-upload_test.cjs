#!/usr/bin/env node
// The heredoc sent over SSH must not add a byte to a bundled source file.
// The daemon revision check makes that otherwise invisible: it starts fine,
// but every upgrade continues to look stale.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildProvisionScript } = require('../app/host');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-provision-upload-'));
const files = [
  { name: 'heartbeat.py', body: 'heartbeat source\n\n' },
  { name: 'bootstrap.sh', body: '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n' },
  { name: 'supervise.sh', body: 'supervise source\n' },
];
const script = buildProvisionScript(home, files, 17983, false);
const result = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8' });
try {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(home, file.name), 'utf8'), file.body,
                 `${file.name} changed during upload`);
  }
  console.log('provision-upload_test: OK');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
