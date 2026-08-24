// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The console at every width a phone actually reports.
//
// The narrow walk proves one viewport works. This proves the layout is fluid
// rather than tuned to it: sixteen real CSS viewports -- the smallest iPhone
// still in use, a folding phone's outer screen, two landscapes where the
// height is what runs out, an iPad -- plus a desktop window for contrast,
// across the screens that have actually gone wrong.
//
// The list is something to be wrong at, not a set of breakpoints to write
// rules against. Rules keyed on a number do not survive the next handset, a
// split screen or a pinch zoom -- and keying on the number is how the
// landscape phone ended up with the desktop's ellipses, since it is 844px
// across and has no hover either way.
//
// Three failures worth separating, because each has slipped past a check
// aimed at the others: the page scrolling sideways, a child hanging out of a
// parent that is not clipping, and text an ellipsis ate.
//
//   node tests/e2e/viewports.mjs
import { chromium } from 'playwright';
import { start } from './harness.mjs';

// Touch is declared rather than inferred from the width, for the same reason
// the stylesheet no longer infers it.
const DEVICES = [
  ['iPhone SE (1st)',   320,  568, true],
  ['small Android',     360,  640, true],
  ['Galaxy S',          360,  780, true],
  ['iPhone SE 2/3',     375,  667, true],
  ['iPhone X-13 mini',  375,  812, true],
  ['iPhone 12-14',      390,  844, true],
  ['iPhone 15',         393,  852, true],
  ['Pixel 7/8',         393,  873, true],
  ['Pixel 6/7 Pro',     412,  915, true],
  ['iPhone XR/11',      414,  896, true],
  ['iPhone Pro Max',    428,  926, true],
  ['iPhone 15 Pro Max', 430,  932, true],
  ['folding, closed',   344,  882, true],
  ['iPhone landscape',  844,  390, true],
  ['Pixel landscape',   915,  412, true],
  ['iPad portrait',     768, 1024, true],
  ['desktop window',   1280,  800, false],
];

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/// Everything that can be wrong about a layout, in one pass over the DOM.
const survey = page => page.evaluate(() => {
  const limit = document.documentElement.clientWidth;
  const wide = [], spill = [], clip = [];
  for (const n of document.querySelectorAll('*')) {
    if (!n.getClientRects().length) continue;
    const a = n.getBoundingClientRect();
    const tag = `${n.tagName.toLowerCase()}.${(n.className || '').toString().slice(0, 24)}`;
    if (a.right > limit + 1) wide.push(tag);
    const p = n.parentElement;
    // A parent that clips is doing it on purpose -- a scroller, a gauge.
    if (p && getComputedStyle(p).overflow === 'visible') {
      const b = p.getBoundingClientRect();
      if (b.width && (a.right > b.right + 0.5 || a.left < b.left - 0.5)) spill.push(tag);
    }
    // Clipped means the element actually clips. Content wider than the box
    // on something with overflow:visible is not hidden -- it hangs out, which
    // is what `spill` above is for, and counting it twice reported a wrapped
    // line as an ellipsis.
    const st = getComputedStyle(n);
    if (n.innerText && n.children.length <= 3 && n.clientWidth > 0
        && st.overflow !== 'visible'
        && n.scrollWidth > n.clientWidth + 1) clip.push(tag);
  }
  return {
    scrollsSideways: document.documentElement.scrollWidth > limit + 1,
    wide: [...new Set(wide)], spill: [...new Set(spill)], clip: [...new Set(clip)],
  };
});

/// A page already holding a session, one per pointer kind. hasTouch cannot be
/// changed on a live page, and it is what the stylesheet keys on -- so the
/// two kinds need two contexts, and each pays for its own session once.
async function ready(browser, harness, errors, touch) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch });
  page.on('pageerror', e => errors.push(`${touch ? 'touch' : 'mouse'}: ${e.message}`));
  await page.goto(harness.appUrl);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 20000 });
  await page.locator('.empty-state .composer-editor').click();
  await page.keyboard.type('a message long enough to wrap on the narrow ones');
  await page.locator('.empty-state .send-btn').click();
  await page.waitForSelector('text=Done: a message long enough', { timeout: 25000 });
  return page;
}

const harness = await start();
const browser = await chromium.launch();
const errors = [];
const pages = new Map();

try {
  for (const [name, width, height, touch] of DEVICES) {
    if (!pages.has(touch)) pages.set(touch, await ready(browser, harness, errors, touch));
    const page = pages.get(touch);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);

    const notes = [];
    const look = (screen, r) => {
      if (r.scrollsSideways) notes.push(`${screen}: scrolls sideways`);
      if (r.wide.length) notes.push(`${screen}: past the viewport — ${r.wide.join(', ')}`);
      if (r.spill.length) notes.push(`${screen}: out of its parent — ${r.spill.join(', ')}`);
      // Above the fold and with a pointer that hovers, an ellipsis is a fair
      // trade and the desktop keeps it.
      if (r.clip.length && touch) notes.push(`${screen}: clipped — ${r.clip.join(', ')}`);
    };

    look('transcript', await survey(page));

    if (await page.locator('.collapsed-strip button').count())
      await page.locator('.collapsed-strip button').click();
    await page.locator('#sidebar .nav-row', { hasText: 'Servers' }).click();
    await page.locator('.pane-intro-title').waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    look('servers', await survey(page));

    // Back to the session, ready for the next size.
    await page.keyboard.press('Escape');
    if (await page.locator('.collapsed-strip button').count())
      await page.locator('.collapsed-strip button').click();
    await page.locator('#sidebar .sidebar-menu-item .nav-row').first().click();

    check(`${name.padEnd(18)} ${String(width).padStart(4)}x${height}`,
          notes.length === 0, notes.join(' | '));
  }
  check('no page errors at any size', errors.length === 0, errors[0] || '');
} catch (err) {
  check('the walk completed', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\nviewports: FAILED' : '\nviewports: OK');
process.exit(failed ? 1 : 0);
