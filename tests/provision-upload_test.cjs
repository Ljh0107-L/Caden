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
// The keys the Mac holds, on their way to a daemon that has to resolve
// `key_ref` without anything in front of it that can.
const secrets = { 'prov-a': 'sk-alpha-0123456789', 'prov-b': 'sk-beta-9876543210' };

const script = buildProvisionScript(home, files, 17983, false, secrets);
const result = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8' });
try {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(home, file.name), 'utf8'), file.body,
                 `${file.name} changed during upload`);
  }
  // Credentials, and the mode they arrive with. `cat >` creates under the
  // login's umask -- 022 on most hosts -- so a file narrowed after the write
  // is briefly world-readable at its final name with the keys already in it.
  const credPath = path.join(home, 'providers.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), secrets,
                   'providers.json did not arrive intact');
  assert.equal(fs.statSync(credPath).mode & 0o777, 0o600,
               `providers.json is ${(fs.statSync(credPath).mode & 0o777).toString(8)}`);

  // Null means "the keychain did not answer", which must leave the server's
  // working keys alone rather than replacing them with {}.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-provision-nocreds-'));
  fs.writeFileSync(path.join(home2, 'providers.json'), '{"kept":"sk-existing"}');
  const r2 = spawnSync('sh', ['-s'], {
    input: buildProvisionScript(home2, files, 17984, false, null),
    encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr || r2.stdout);
  assert.equal(fs.readFileSync(path.join(home2, 'providers.json'), 'utf8'),
               '{"kept":"sk-existing"}',
               'a run with no readable keys overwrote the ones on the server');
  fs.rmSync(home2, { recursive: true, force: true });

  console.log('provision-upload_test: OK');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
