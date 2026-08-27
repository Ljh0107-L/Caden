// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// `/goal` is the one message that never becomes a turn, and the composer has
// to know it. Sending anything marks the session running so the button answers
// the keystroke rather than the round trip -- but the daemon answers a goal
// command itself, in milliseconds, and no turn ever starts. The optimism was
// applied unconditionally, so the composer sat on "Thinking…" against an idle
// session, waiting for a reply nobody was going to send.
//
// It could not be fixed from the daemon either, which is why this is a browser
// test and not an HTTP one: the daemon does emit the session's real state after
// a goal command, and that event arrives *before* `sendMessage` resolves, so
// the very line being fixed overwrote the fix. Only the client can decline to
// claim a turn it knows will not exist.
//
//   node tests/e2e/goal.mjs
import { chromium } from 'playwright';
import { start } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const harness = await start();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => {
  console.log(`  FAIL   page error: ${e.message}`);
  failed++;
});

/// Whether the transcript is claiming a turn is in flight.
const busy = () => page.locator('.working-row').count();

try {
  await page.goto(harness.appUrl);
  await page.waitForSelector('text=E2E', { timeout: 10000 });

  // A session to type into.
  const editor = page.locator('.empty-state .composer-editor');
  await editor.waitFor({ timeout: 10000 });
  await editor.click();
  await page.keyboard.type('a session to hold a goal');
  await page.locator('.empty-state .send-btn').click();
  await page.waitForSelector('text=Done: a session to hold a goal', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.working-row'),
                             null, { timeout: 15000 });
  check('the session settles after a real turn', await busy() === 0);

  // -- a query, which changes nothing and starts nothing --------------------
  const composer = page.locator('.composer-editor').last();
  await composer.click();
  await page.keyboard.type('/goal');
  await page.locator('.send-btn').last().click();

  // The daemon answers it directly.
  try {
    await page.waitForSelector('text=No goal is set.', { timeout: 15000 });
    check('a bare /goal is answered', true);
  } catch {
    check('a bare /goal is answered', false, 'no answer arrived');
  }

  // And the session is where it was. Given a moment, because the failure this
  // guards is a state that never clears: an immediate check would pass on a
  // race it is supposed to catch.
  await page.waitForTimeout(1500);
  check('a /goal query leaves the composer idle', await busy() === 0,
        `${await busy()} working row(s)`);

  // -- setting one, then clearing it ----------------------------------------
  // The same shape, with the goal actually changing underneath. Nothing
  // drives here: the harness has no model behind the judge, so the loop's
  // first check fails and the goal stops itself -- which is fine, because what
  // is under test is the composer, not the loop.
  await composer.click();
  await page.keyboard.type('/goal keep the chip on screen');
  await page.locator('.send-btn').last().click();
  // Guarded rather than awaited bare: a composer stuck on "Thinking…" turns
  // its send button into a stop button, so the command never goes out and the
  // wait below is the second symptom of the first failure. A test that throws
  // there reports a timeout instead of the thing that actually broke.
  try {
    await page.waitForSelector('.goal-chip', { timeout: 15000 });
    check('setting a goal puts the chip up', true);
  } catch {
    check('setting a goal puts the chip up', false, 'no chip appeared');
  }

  await composer.click();
  await page.keyboard.type('/goal clear');
  await page.locator('.send-btn').last().click();
  try {
    await page.waitForFunction(() => !document.querySelector('.goal-chip'),
                               null, { timeout: 15000 });
    check('clearing it takes the chip away', true);
  } catch {
    check('clearing it takes the chip away', false, 'the chip stayed');
  }

  await page.waitForTimeout(1500);
  check('and leaves the composer idle', await busy() === 0,
        `${await busy()} working row(s)`);

  // The transcript stays the record of what was typed and what came back --
  // the commands that worked say nothing, so the only lines here are the ones
  // the user sent and the answer to the question they asked.
  const said = await page.locator('.human-msg-body').allInnerTexts();
  check('every command is still shown as typed',
        said.filter(t => t.startsWith('/goal')).length === 3,
        JSON.stringify(said));
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\ne2e goal: FAILED' : '\ne2e goal: OK');
process.exit(failed ? 1 : 0);
