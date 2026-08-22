// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The main user flow, end to end in a real browser: the app loads against a
// live daemon, a session is created from the empty state, a message is sent,
// and the mock engine's reply renders. Everything the HTTP suite cannot see
// -- the DOM, the clicks, the wiring between them -- is what this covers.
//
//   node tests/e2e/session.mjs
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

try {
  await page.goto(harness.appUrl);

  // The sidebar lists the configured server once its daemon answers.
  await page.waitForSelector('text=E2E', { timeout: 10000 });
  check('app loads with the server listed', true);

  // No session yet: the empty state with its composer.
  const editor = page.locator('.empty-state .composer-editor');
  await editor.waitFor({ timeout: 10000 });
  check('empty state shows a composer', true);

  // The mock model is the only one, so it is the default pick.
  const modelLabel = page.locator('.empty-state .model-label');
  check('model preselected', (await modelLabel.textContent()).includes('Mock'),
        await modelLabel.textContent());

  // Send a message. The empty state creates the session on send.
  await editor.click();
  await page.keyboard.type('hello e2e');
  await page.locator('.empty-state .send-btn').click();

  // The mock engine's scripted reply ends in "Done: <text>".
  await page.waitForSelector('text=Done: hello e2e', { timeout: 15000 });
  check('reply renders in the transcript', true);

  // A shell row names its command once. The label for a shell call *is* the
  // command, and the raw command used to be appended to it as well -- which a
  // long command hid behind an ellipsis and a short one showed twice over.
  const ran = await page.locator('.tool-call .fold', { hasText: 'echo caden' })
      .first().innerText();
  check('a shell row does not repeat its command',
        (ran.match(/echo caden/g) || []).length === 1, JSON.stringify(ran));

  // The Servers pane, with one server set up and one not. Rendering a server
  // that has never been provisioned used to throw -- `page.on('pageerror')`
  // above turns that into a failure -- and the throw came out of the render,
  // so every row stayed on "Checking…" whether it had an answer or not.
  await page.locator('.nav-row', { hasText: 'Servers' }).first().click();
  await page.waitForSelector('.prov-card', { timeout: 10000 });
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.prov-section')]
            .some(s => /Checking…/.test(s.textContent || '')),
    null, { timeout: 15000 }).then(
      () => check('servers pane resolves every row', true),
      () => check('servers pane resolves every row', false,
                  'a row was still "Checking…"'));
  // Back to the conversation for the rest of the run.
  await page.locator('.nav-row', { hasText: 'hello e2e' }).first().click();
  await page.waitForSelector('.composer-editor', { timeout: 10000 });

  // The session now exists in the sidebar, titled from the first message.
  // The title is set when the turn starts server-side and reaches the sidebar
  // on its next refresh, so wait across a full poll cycle.
  try {
    await page.locator('.nav-row', { hasText: 'hello e2e' })
        .waitFor({ timeout: 10000 });
    check('session listed in the sidebar', true);
  } catch {
    check('session listed in the sidebar', false);
  }

  // A second turn through the same composer, proving the session path too.
  const followup = page.locator('.composer-editor').last();
  await followup.waitFor({ timeout: 5000 });
  await followup.click();
  await page.keyboard.type('second turn');
  await page.locator('.send-btn').last().click();
  await page.waitForSelector('text=Done: second turn', { timeout: 15000 });
  check('a follow-up turn renders', true);

  // -- a repaint must not eat what is being typed ---------------------------
  // `renderSession` builds a new composer every time, and plenty of things
  // call it without being asked to: a machine reconnecting on the supervisor's
  // six-second timer, a model swapped mid-sentence, a rename. The draft lives
  // on the controller now so it outlives them. Swapping the model is the
  // reproducible one; the timer is the same code path.
  await followup.click();
  await page.keyboard.type('half a sentence');
  // Tag the live editor so the assertion waits for the repaint instead of
  // racing it.
  await page.evaluate(() => {
    const eds = document.querySelectorAll('.composer-editor');
    eds[eds.length - 1].dataset.gen = 'before';
  });
  await page.locator('.composer .model-trigger').last().click();
  await page.locator('.menu .m-item').first().click();
  await page.waitForFunction(
    () => !document.querySelector('.composer-editor[data-gen="before"]'),
    null, { timeout: 10000 });
  const kept = (await page.locator('.composer-editor').last().innerText()).trim();
  check('a repaint keeps the half-typed message', kept === 'half a sentence',
        JSON.stringify(kept));

  // And sending still empties it, rather than leaving the draft behind to
  // reappear under the next message.
  await page.locator('.composer-editor').last().click();
  await page.locator('.send-btn').last().click();
  await page.waitForSelector('text=Done: half a sentence', { timeout: 15000 });
  const after = (await page.locator('.composer-editor').last().innerText()).trim();
  check('sending clears the draft', after === '', JSON.stringify(after));

  // -- truncated open: a long session opens on its tail ----------------------
  // A cold open folds only the last ~300 events; the older turns sit behind a
  // "Load earlier" affordance instead of making every open a multi-second
  // full replay. Seed the history straight through the proxy -- 25 queued
  // mock turns -- then reopen the app fresh, which is the path the
  // truncation is meant for.
  const proxy = `${harness.appUrl}/proxy/e2e-server`;
  const seeded = await (await fetch(`${proxy}/v1/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'mock', model: 'mock-1', title: 'long history 00',
                           provider: { protocol: 'mock' } }),
  })).json();
  const longId = seeded.session.id;
  for (let i = 0; i < 25; i++) {
    const n = String(i).padStart(2, '0');
    await fetch(`${proxy}/v1/sessions/${longId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `long history ${n}` }),
    });
  }
  const idleDeadline = Date.now() + 60000;
  for (;;) {
    const d = await (await fetch(`${proxy}/v1/sessions/${longId}?events=0`)).json();
    if (d.session.state === 'idle' && d.session.turns >= 25) break;
    if (Date.now() > idleDeadline) throw new Error('long session never went idle');
    await new Promise(r => setTimeout(r, 250));
  }

  // Reopen with no selection and no cached controller: the exact cold open.
  await page.reload();
  await page.locator('.nav-row', { hasText: 'long history 00' })
      .waitFor({ timeout: 15000 });
  await page.locator('.nav-row', { hasText: 'long history 00' }).click();

  const transcript = page.locator('#transcript');
  await transcript.getByText('long history 24').waitFor({ timeout: 10000 });
  check('truncated open: the latest turn is shown', true);
  check('truncated open: the oldest turn is not loaded',
        await transcript.getByText('long history 00').count() === 0);
  const loadEarlier = page.locator('.notice-action', { hasText: 'Load earlier' });
  await loadEarlier.waitFor({ timeout: 5000 });
  check('truncated open: Load earlier is offered', true);

  await loadEarlier.click();
  await transcript.getByText('long history 00').waitFor({ timeout: 15000 });
  check('Load earlier folds the whole log', true);
  check('Load earlier clears its notice',
        await page.locator('.notice-action', { hasText: 'Load earlier' }).count() === 0);
  // The fold prepended rows above the viewport; the reader's place is kept
  // instead of snapping to the new top.
  const scrollTop = await page.$eval('.conversation', el => el.scrollTop);
  check('Load earlier keeps the scroll position', scrollTop > 100,
        `${Math.round(scrollTop)}px`);
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\ne2e: FAILED' : '\ne2e: OK');
process.exit(failed ? 1 : 0);
