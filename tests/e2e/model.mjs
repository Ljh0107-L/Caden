// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Which of two identical-looking models a session is on.
//
// A model id is unique to a provider, not to the console: two gateways in
// front of the same upstream both sell `gpt-5.6-sol`, and somebody who has
// added both has the same name twice in the picker. The tick was
// `m.modelID === currentId`, so both rows carried one -- and the composer's
// footer showed the alias alone, which is the same string either way. There
// was nothing on screen that said which gateway a session was talking to.
//
// The session now records the provider entry it was created from, and the
// name is qualified when the name alone does not identify it.
//
//   node tests/e2e/model.mjs
import { chromium } from 'playwright';
import { start } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Two gateways selling one model under one name, and one that is its own.
// Both speak `mock` so a session can actually be created against them --
// what is being tested is the picker, not the wire.
const SOL = { modelID: 'gpt-5.6-sol', alias: 'GPT 5.6 Sol', contextWindow: 400000 };
const harness = await start({
  providers: [
    { id: 'gw-sub2api', name: 'Sub2API', proto: 'mock', baseURL: 'http://127.0.0.1:9/a',
      models: [{ id: 'sub2api-sol', ...SOL }] },
    { id: 'gw-seed', name: 'Seed', proto: 'mock', baseURL: 'http://127.0.0.1:9/b',
      models: [{ id: 'seed-sol', ...SOL },
               { id: 'seed-only', modelID: 'seed-1', alias: 'Seed Only',
                 contextWindow: 200000 }] },
  ],
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on('pageerror', e => {
  console.log(`  FAIL   page error: ${e.message}`);
  failed++;
});

/// The open menu as [{section, label, checked}], in the order it is drawn --
/// the section headings are siblings of the rows, not parents of them.
const menuRows = () => page.$$eval('.menu > *', els => {
  let section = '';
  const out = [];
  for (const e of els) {
    if (e.classList.contains('m-section')) { section = e.textContent; continue; }
    if (e.classList.contains('m-item')) {
      out.push({ section, label: e.textContent,
                 checked: e.classList.contains('checked') });
    }
  }
  return out;
});

const trigger = scope => page.locator(`${scope} .model-trigger .model-label`);
const openMenu = async scope => {
  await page.locator(`${scope} .model-trigger`).click();
  await page.locator('.menu').waitFor({ timeout: 5000 });
  return menuRows();
};

try {
  await page.goto(harness.appUrl);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 20000 });

  // -- the draft -----------------------------------------------------------
  check('a name two providers share is qualified by the provider',
        await trigger('.empty-state').textContent() === 'GPT 5.6 Sol · Sub2API',
        await trigger('.empty-state').textContent());

  let rows = await openMenu('.empty-state');
  check('exactly one row is ticked',
        rows.filter(r => r.checked).length === 1,
        JSON.stringify(rows));
  check('and it is the one under the provider in use',
        rows.find(r => r.checked)?.section === 'Sub2API',
        JSON.stringify(rows.find(r => r.checked)));
  // The rows stay bare: the section heading above them is the provider's
  // name, and repeating it on every line says it twice.
  check('the rows themselves are not qualified',
        rows.every(r => !r.label.includes('·')), JSON.stringify(rows.map(r => r.label)));

  // Pick the other gateway's copy -- same label, same id, different section.
  await page.locator('.menu .m-item', { hasText: 'GPT 5.6 Sol' }).nth(1).click();
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 5000 });
  check('picking the twin moves the footer to it',
        await trigger('.empty-state').textContent() === 'GPT 5.6 Sol · Seed',
        await trigger('.empty-state').textContent());

  rows = await openMenu('.empty-state');
  check('and the tick moves with it',
        rows.filter(r => r.checked).length === 1
          && rows.find(r => r.checked)?.section === 'Seed',
        JSON.stringify(rows.filter(r => r.checked)));
  // A name only one provider sells is left alone: the qualifier is for the
  // rows that need it.
  check('a name only one provider sells stays bare',
        rows.some(r => r.label === 'Seed Only'), JSON.stringify(rows.map(r => r.label)));
  await page.keyboard.press('Escape');

  // -- the session it creates ---------------------------------------------
  await page.locator('.empty-state .composer-editor').click();
  await page.keyboard.type('hello from the seed gateway');
  await page.locator('.empty-state .send-btn').click();
  await page.waitForSelector('text=Done: hello from the seed gateway', { timeout: 20000 });

  check('the session it started carries the provider through',
        await trigger('.composer-area').textContent() === 'GPT 5.6 Sol · Seed',
        await trigger('.composer-area').textContent());

  rows = await openMenu('.composer-area');
  check('and its picker ticks one row',
        rows.filter(r => r.checked).length === 1
          && rows.find(r => r.checked)?.section === 'Seed',
        JSON.stringify(rows.filter(r => r.checked)));

  // -- switching a live session -------------------------------------------
  await page.locator('.menu .m-item', { hasText: 'GPT 5.6 Sol' }).nth(0).click();
  await page.waitForFunction(
    () => document.querySelector('.composer-area .model-label')?.textContent
            === 'GPT 5.6 Sol · Sub2API', null, { timeout: 10000 });
  check('switching gateways on a live session is a visible change', true);

  rows = await openMenu('.composer-area');
  check('and the tick follows the switch',
        rows.filter(r => r.checked).length === 1
          && rows.find(r => r.checked)?.section === 'Sub2API',
        JSON.stringify(rows.filter(r => r.checked)));

  // -- the id travels with the credential set, and only with it ------------
  // Straight at the daemon, because no client of ours sends one without the
  // other. An id left behind by a provider that has been swapped out names
  // the wrong entry, which is worse than naming none.
  const api = (path, init) => fetch(`${harness.daemonUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${harness.daemonToken}`,
               'Content-Type': 'application/json' },
  }).then(r => r.json());
  const { sessions } = await api('/v1/sessions');
  const before = sessions[0];
  check('the daemon reports which provider the session is on',
        before.provider_id === 'gw-sub2api', JSON.stringify(before.provider_id));
  const { session } = await api(`/v1/sessions/${before.id}`, {
    method: 'PATCH', body: JSON.stringify({ provider: { protocol: 'mock' } }),
  });
  check('and a provider replaced without one leaves no stale id',
        session.provider_id == null, JSON.stringify(session.provider_id));
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\ne2e model: FAILED' : '\ne2e model: OK');
process.exit(failed ? 1 : 0);
