// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// One section per directory per machine.
//
// The sidebar used to bucket by the working directory alone, on the theory
// that the project is the axis and the machine is an attribute of it. Two
// servers laid out the same way -- which is what happens when the same person
// sets both of them up -- then shared a section, and the `+` on its heading
// ("new session here") started the session on whichever of them owned the
// newest row. Two *different* paths ending in the same directory name were
// the case actually reported: two sections, the same title, nothing to tell
// them apart, and a fold state keyed by that title so folding one folded both.
//
// Two real daemons, because that is the only way to see any of it.
//
//   node tests/e2e/sidebar.mjs
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

const harness = await start({ machines: 2 });
const [one, two] = harness.machines;

// Outside either daemon's home: a session inside one is scratch, and scratch
// collects in "No Repo" rather than a section of its own.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caden-sb-'));
const SAME = path.join(root, 'LP');            // the same path on both boxes
const OTHER = path.join(root, 'work', 'LP');   // a second LP on the first box

const mkSession = async (m, title, cwd) => {
  const res = await fetch(`${m.url}/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${m.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, cwd, create_cwd: true, model: 'mock-1',
                           model_label: 'Mock', provider: { protocol: 'mock' } }),
  });
  if (!res.ok) throw new Error(`${title}: ${res.status} ${await res.text()}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on('pageerror', e => {
  console.log(`  FAIL   page error: ${e.message}`);
  failed++;
});

/// Every section heading, as {title, machine, tooltip}.
const sections = () => page.$$eval('.section-head', heads => heads.map(h => ({
  title: h.querySelector('.section-head-title')?.textContent || '',
  machine: h.querySelector('.section-head-machine')?.textContent || '',
  tooltip: h.getAttribute('title') || '',
  rows: h.parentElement.querySelectorAll('.sidebar-menu-item').length,
})));

try {
  await mkSession(one, 'alpha', SAME);
  await mkSession(two, 'beta', SAME);
  await mkSession(one, 'gamma', OTHER);

  await page.goto(harness.appUrl);
  await page.waitForSelector('text=alpha', { timeout: 20000 });
  await page.waitForSelector('text=beta', { timeout: 20000 });

  // -- one section per (machine, directory) --------------------------------
  const secs = await sections();
  check('one section per directory per machine', secs.length === 3,
        JSON.stringify(secs));
  check('and one session in each',
        secs.every(s => s.rows === 1), JSON.stringify(secs.map(s => s.rows)));

  // The same path on two boxes is two sections, and the heading says which.
  check('the second machine is named on its own section',
        secs.filter(s => s.machine === 'E2E-2').length === 1,
        JSON.stringify(secs.map(s => s.machine)));
  check('and the first on its two',
        secs.filter(s => s.machine === 'E2E').length === 2,
        JSON.stringify(secs.map(s => s.machine)));

  // Two LPs on one box: the machine cannot separate them, so the path does.
  const onOne = secs.filter(s => s.machine === 'E2E').map(s => s.title);
  check('two directories of the same name on one machine get enough path',
        new Set(onOne).size === 2 && onOne.every(t => t.includes('/')),
        JSON.stringify(onOne));
  // The other box has only one, so its heading stays the bare name.
  check('and a name that is unique on its machine is left alone',
        secs.find(s => s.machine === 'E2E-2')?.title === 'LP',
        JSON.stringify(secs.map(s => s.title)));

  check('the tooltip carries the machine and the whole path',
        secs.some(s => s.tooltip === `E2E-2: ${SAME}`),
        JSON.stringify(secs.map(s => s.tooltip)));

  // -- folding is per section, not per title -------------------------------
  // Keyed by the title, folding either LP folded every LP on screen.
  const headOf = machine => page.locator('.section-head')
    .filter({ has: page.locator(`.section-head-machine:text-is("${machine}")`) }).first();
  await headOf('E2E-2').click();
  const expanded = await page.$$eval('.section-head',
    hs => hs.map(h => h.parentElement.getAttribute('data-expanded') === 'true'));
  check('folding one section leaves the rest open',
        expanded.filter(Boolean).length === 2, JSON.stringify(expanded));
  await headOf('E2E-2').click();

  // -- "new session here" starts it on that section's machine --------------
  // With the two boxes sharing a section this picked whichever of them owned
  // the newest row, so the session landed on the other machine about half the
  // time.
  await headOf('E2E-2').hover();
  await headOf('E2E-2').locator('.nav-row-actions button').click();
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 10000 });
  const selects = await page.$$eval('.empty-state-selects .select-trigger',
                                    els => els.map(e => e.querySelector('span').textContent));
  check('new-session-here lands on the machine whose section it was',
        selects[1] === 'E2E-2', JSON.stringify(selects));
  check('and in the directory it was',
        selects[0] === 'LP', JSON.stringify(selects));
} finally {
  await browser.close();
  await harness.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? '\ne2e sidebar: FAILED' : '\ne2e sidebar: OK');
process.exit(failed ? 1 : 0);
