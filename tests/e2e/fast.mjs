// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The fast-mode switch, and the models it is not offered for.
//
// Fast mode is the one composer setting the engine can refuse after agreeing
// to draw a switch for it: it needs an Opus model and a plan that carries it.
// A chip that lights up and changes nothing is worse than no chip, so the
// rule is that it appears only where it can work, and that what the engine
// said about it is what the chip reports.
//
// The daemon half is `tests/fast_mode_test.py`; this is the half a person
// touches. It runs against the mock daemon -- no turn is ever sent, because
// what is being checked is which controls exist and what they carry.
//
//   node tests/e2e/fast.mjs
import { chromium } from 'playwright';
import { start } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Two Claude models and a Codex one. Opus 5 first, so it is the default pick
// and the composer opens on the case that has the switch.
const harness = await start({
  providers: [{
    id: 'anth', name: 'Anthropic', proto: 'anthropic-messages', baseURL: '',
    models: [
      { id: 'op5', modelID: 'claude-opus-5', alias: 'Opus 5', contextWindow: 200000 },
      { id: 'son', modelID: 'claude-sonnet-4-6', alias: 'Sonnet 4.6',
        contextWindow: 200000 },
    ],
  }, {
    id: 'oai', name: 'OpenAI', proto: 'openai-responses', baseURL: '',
    models: [{ id: 'g5', modelID: 'gpt-5-codex', alias: 'GPT-5 Codex',
               contextWindow: 200000 }],
  }],
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on('pageerror', e => {
  console.log(`  FAIL   page error: ${e.message}`);
  failed++;
});

const fastChip = () => page.locator('.empty-state .effort-btn', { hasText: 'Fast' });

/// Pick a model by its label from the composer's model menu.
const pickModel = async label => {
  await page.locator('.empty-state .model-trigger').click();
  await page.locator('.menu .m-item', { hasText: label }).first().click();
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 5000 });
};

try {
  await page.goto(harness.appUrl);
  await page.locator('.empty-state .composer-editor').waitFor({ timeout: 15000 });

  // 1. Opus has it, and it starts off -- fast mode is a choice, not a default.
  await check('the switch is drawn for Opus', await fastChip().count() === 1);
  check('and starts off',
        await fastChip().getAttribute('data-on') === null);

  // 2. It is a switch, not a menu: one click is the whole interaction.
  await fastChip().click();
  check('clicking it turns it on',
        await fastChip().getAttribute('data-on') !== null);
  await fastChip().click();
  check('and clicking again turns it off',
        await fastChip().getAttribute('data-on') === null);

  // 3. Sonnet reports fast mode off and offers no reason for it, so a switch
  //    there would be a control with no effect and no explanation.
  await fastChip().click();
  await pickModel('Sonnet');
  check('a model without fast mode has no switch',
        await fastChip().count() === 0);

  // 4. And the wish does not survive the model that could not grant it: going
  //    back must not silently start the next session in a mode the user last
  //    saw refused.
  await pickModel('Opus 5');
  check('coming back, the switch is off again',
        await fastChip().count() === 1
        && await fastChip().getAttribute('data-on') === null);

  // 5. Codex has no such thing at all.
  await pickModel('GPT-5 Codex');
  check('the codex side has no switch', await fastChip().count() === 0);

  // 6. Nothing else in the toolbar was displaced by it.
  await pickModel('Opus 5');
  const labels = await page.locator('.empty-state .effort-btn .effort-label')
    .allTextContents();
  check('it sits alongside permission and effort, not instead of them',
        labels.length === 3 && labels.includes('Fast'), labels.join(', '));
} catch (err) {
  console.log(`  FAIL   ${err.message}`);
  failed++;
} finally {
  await browser.close();
  await harness.stop();
}

console.log(failed ? '\nfast: FAILED' : '\nfast: OK');
process.exit(failed ? 1 : 0);
