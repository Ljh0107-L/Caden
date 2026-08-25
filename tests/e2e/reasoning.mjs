// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Reasoning that is still arriving is on screen while it arrives.
//
// A fold starts closed -- `open` is the set the reader has opened by hand --
// so a reasoning block streamed into a collapsed one. Worse than hidden: the
// body a delta appends to is only built when the fold opens, so the deltas had
// nowhere to land and the block was rebuilt from scratch on the first click.
// What the reader saw for the length of a long think was a chevron and a
// header, which is indistinguishable from a turn that has stopped -- and on a
// model that reasons for a minute before its first visible word, that is the
// whole turn.
//
//   node tests/e2e/reasoning.mjs
process.env.CADEN_MOCK_THINK_MS = '4000';

const { chromium } = await import('playwright');
const { start } = await import('./harness.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const harness = await start();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on('pageerror', e => { console.log(`  FAIL   page error: ${e.message}`); failed++; });

try {
  await page.goto(harness.appUrl);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 15000 });
  await page.locator('.empty-state .composer-editor').click();
  await page.keyboard.type('think about it');
  await page.locator('.empty-state .send-btn').click();

  // The reasoning block, while it is still the live tail.
  const fold = page.locator('[data-fold^="think:"]');
  await fold.first().waitFor({ timeout: 15000 });
  check('a reasoning block appears', await fold.count() >= 1);

  const header = fold.first().locator('.verb').first();
  check('and says it is thinking',
        (await header.textContent()).includes('Thinking'),
        await header.textContent());

  check('it is open without being clicked',
        await fold.first().evaluate(n => n.classList.contains('open')),
        'closed, the deltas have nowhere to land and the reader sees a chevron');

  const body = fold.first().locator('.fold-body');
  await body.waitFor({ timeout: 5000 });
  const shown = (await body.textContent()).trim();
  check('and the reasoning itself is on screen', shown.includes('Considering'), shown.slice(0, 60));

  // It grows in place rather than waiting for the end.
  const grew = await page.waitForFunction(
    () => {
      const b = document.querySelector('[data-fold^="think:"] .fold-body');
      return b && b.textContent.trim().length > 'Considering: '.length;
    }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('and grows as more arrives', grew);

  // Once the turn moves on, the header becomes a duration and it folds away.
  await page.waitForSelector('text=Done: think about it', { timeout: 25000 });
  const done = await fold.first().locator('.verb').first().textContent();
  check('when it finishes the header says how long it took',
        /Thought/.test(done), done);
} catch (err) {
  console.log(`  FAIL   ${err.message}`);
  failed++;
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\nreasoning: FAILED' : '\nreasoning: OK');
process.exit(failed ? 1 : 0);
