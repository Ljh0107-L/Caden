// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The same app on a phone. Caden was drawn against a desktop window and the
// stylesheet had one media query in it, for dark mode -- at 375px the main
// column's 424px floor pushed the composer off the side of the screen and the
// sidebar took two thirds of what was left.
//
// What this pins down is the part that is easy to regress by adding a fixed
// width somewhere: the page must not scroll sideways, the sidebar must behave
// as an overlay rather than a column, and the whole create-and-send flow has
// to work through it.
//
//   node tests/e2e/narrow.mjs
import { chromium } from 'playwright';
import { start } from './harness.mjs';

const IPHONE = { width: 375, height: 812 };
const SHOTS = process.env.CADEN_E2E_SHOTS || '';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/// Anything wider than the viewport, named. A bare scrollWidth comparison says
/// the page overflows but not what did it, and the offender is always a fixed
/// width on one element.
const overflowing = page => page.evaluate(() => {
  const limit = document.documentElement.clientWidth;
  return [...document.querySelectorAll('*')]
    .filter(n => n.getBoundingClientRect().right > limit + 1)
    .slice(0, 6)
    .map(n => `${n.tagName.toLowerCase()}.${n.className || '-'}`
              + ` @${Math.round(n.getBoundingClientRect().right)}px`);
});

const harness = await start();
const browser = await chromium.launch();
// isMobile/hasTouch are what make `hover: none` and `pointer: coarse` match;
// with a plain desktop context at 375px the touch rules are never evaluated
// and the hover-only controls look fine because the mouse is still there.
const page = await browser.newPage({
  viewport: IPHONE, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
});
page.on('pageerror', e => {
  console.log(`  FAIL   page error: ${e.message}`);
  failed++;
});
const shot = name => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;

try {
  await page.goto(harness.appUrl);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 15000 });

  // 1. The list is a drawer, so the phone opens on the thing you came for.
  check('the sidebar starts closed',
        await page.evaluate(() => document.body.classList.contains('sidebar-hidden')));
  await shot('01-closed');

  const wide = await overflowing(page);
  check('nothing overflows the viewport', wide.length === 0, wide.join(', '));

  // 2. The composer is the reason the 424px floor had to go: it is the last
  //    thing in the column, so it is the first thing pushed off the screen.
  const box = await page.locator('.empty-state .composer').boundingBox();
  check('the composer fits on screen',
        box.x >= 0 && box.x + box.width <= IPHONE.width,
        `x=${Math.round(box.x)} w=${Math.round(box.width)}`);

  const fontPx = await page.locator('.empty-state .composer-editor')
    .evaluate(n => parseFloat(getComputedStyle(n).fontSize));
  check('the editor is at least 16px, so focusing it does not zoom iOS',
        fontPx >= 16, `${fontPx}px`);

  // 3. Open it: an overlay with something to tap outside of.
  await page.locator('.collapsed-strip button').click();
  await page.locator('.sidebar-scrim').waitFor({ timeout: 5000 });
  const pos = await page.locator('#sidebar')
    .evaluate(n => getComputedStyle(n).position);
  check('the open sidebar is an overlay, not a column', pos === 'fixed', pos);
  await shot('02-drawer');

  const stillFits = await overflowing(page);
  check('and it does not make the page scroll sideways',
        stillFits.length === 0, stillFits.join(', '));

  // 4. Tapping the canvas beside it puts it away.
  await page.locator('.sidebar-scrim').click({ position: { x: 340, y: 400 } });
  await page.locator('.sidebar-scrim').waitFor({ state: 'detached', timeout: 5000 });
  check('tapping outside closes it',
        await page.evaluate(() => document.body.classList.contains('sidebar-hidden')));

  // 5. The whole point: a session started and answered from a phone.
  const editor = page.locator('.empty-state .composer-editor');
  await editor.click();
  await page.keyboard.type('hello from a phone');
  await page.locator('.empty-state .send-btn').click();
  await page.waitForSelector('text=Done: hello from a phone', { timeout: 20000 });
  check('a session can be created and answered', true);
  await shot('03-transcript');

  const afterReply = await overflowing(page);
  check('the transcript does not overflow either',
        afterReply.length === 0, afterReply.join(', '));

  // 6. Picking from the drawer replaces what the drawer was covering, so it
  //    has to get out of the way by itself -- there is no room for both.
  await page.locator('.collapsed-strip button').click();
  await page.locator('.sidebar-scrim').waitFor({ timeout: 5000 });
  await page.locator('#sidebar .sidebar-menu-item .nav-row').first().click();
  await page.locator('.sidebar-scrim').waitFor({ state: 'detached', timeout: 5000 });
  check('picking a session closes the drawer', true);

  // 7. A finger cannot hover, and the row actions were `pointer-events: none`
  //    until it did -- so on a phone there was no way to archive a session
  //    short of a long press nothing advertises.
  await page.locator('.collapsed-strip button').click();
  const actions = page.locator('#sidebar .sidebar-menu-item .nav-row-actions').first();
  const reachable = await actions.evaluate(n => {
    const st = getComputedStyle(n);
    return { opacity: st.opacity, events: st.pointerEvents };
  });
  check('the row actions are reachable without hover',
        reachable.opacity === '1' && reachable.events !== 'none',
        JSON.stringify(reachable));
  await shot('04-touch-actions');

  const tap = await page.locator('#sidebar .icon-btn.sm').first().boundingBox();
  check('an icon button is bigger than its mouse size',
        tap.width >= 28 && tap.height >= 28,
        `${Math.round(tap.width)}x${Math.round(tap.height)}`);
  await page.locator('.sidebar-scrim').click({ position: { x: 340, y: 400 } });

  // 8. Widened back out, it is a column again -- the same window dragged wide.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.locator('#sidebar .sidebar-nav').waitFor({ timeout: 5000 });
  const widePos = await page.locator('#sidebar')
    .evaluate(n => getComputedStyle(n).position);
  check('widening brings the column back', widePos === 'static', widePos);
} catch (err) {
  console.log(`  FAIL   ${err.message}`);
  failed++;
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\nnarrow: FAILED' : '\nnarrow: OK');
process.exit(failed ? 1 : 0);
