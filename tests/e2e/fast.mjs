// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The fast-tier switch, and the engine it is not offered for.
//
// Codex has a `priority` service tier -- it calls it Fast -- and it is a field
// on the turn, so it travels as part of the request and a gateway can pass it
// on. Claude Code's fast mode is not a parameter at all; behind a relay the
// CLI reports it on while nothing upstream is quicker, which is a switch that
// lies. So the switch is Codex's, and this pins down that it stays there.
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

// A Codex model first, so the composer opens on the case that has the switch,
// and a Claude one to show it is not offered there.
const harness = await start({
  providers: [{
    id: 'oai', name: 'OpenAI', proto: 'openai-responses', baseURL: '',
    models: [
      { id: 'sol', modelID: 'gpt-5.6-sol', alias: 'GPT-5.6 Sol',
        contextWindow: 400000 },
      { id: 'relay', modelID: 'my-gateway-model', alias: 'Gateway',
        contextWindow: 400000 },
    ],
  }, {
    id: 'anth', name: 'Anthropic', proto: 'anthropic-messages', baseURL: '',
    models: [{ id: 'op5', modelID: 'claude-opus-5', alias: 'Opus 5',
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

  // 1. Codex has it, and it starts off -- the tier is a choice, not a default.
  await check('the switch is drawn for Codex', await fastChip().count() === 1);
  check('and starts off',
        await fastChip().getAttribute('data-on') === null);

  // 2. It is a switch, not a menu: one click is the whole interaction.
  await fastChip().click();
  check('clicking it turns it on',
        await fastChip().getAttribute('data-on') !== null);
  await fastChip().click();
  check('and clicking again turns it off',
        await fastChip().getAttribute('data-on') === null);

  // 3. Claude Code is where the switch would lie, so it is not drawn there.
  await fastChip().click();
  await pickModel('Opus 5');
  check('the claude side has no switch', await fastChip().count() === 0);

  // 4. And the wish does not survive the model that could not grant it: going
  //    back must not silently start the next session in a mode the user last
  //    saw withdrawn.
  await pickModel('GPT-5.6 Sol');
  check('coming back, the switch is off again',
        await fastChip().count() === 1
        && await fastChip().getAttribute('data-on') === null);

  // 5. A model the CLI's catalog has never heard of still gets the switch:
  //    behind a gateway that is every model, and the daemon is what decides
  //    -- after the first turn it says `model_not_supported` if it has to.
  await pickModel('Gateway');
  check('a gateway model keeps the switch', await fastChip().count() === 1);

  // 6. Nothing else in the toolbar was displaced by it.
  await pickModel('GPT-5.6 Sol');
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
