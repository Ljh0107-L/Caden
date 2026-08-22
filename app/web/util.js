// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// DOM and formatting helpers. `el` builds elements with props/children; all
// text goes through textContent, so nothing here can inject markup.

import { svgIcon } from './icons.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') throw new Error('no raw html');
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

/// Icons are inline SVG from icons.js -- one 24x24 grid, stroke following
/// currentColor. The short names this module has always used (`cpu`, `warn`,
/// `chevD`) resolve there through the alias table.
export function icon(name, size = 13) {
  return svgIcon(name, size);
}

export function compactTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/// Cache writes are prompt tokens too. On a session's first turn the whole
/// prompt lands in cache_creation and nothing is read back, so leaving it out
/// reports an empty context window for a request that filled a real one.
export const contextUsed = usage => !usage ? 0
  : (usage.input_tokens || 0) + (usage.cache_read_tokens || 0)
    + (usage.cache_write_tokens || 0) + (usage.output_tokens || 0);

/// Which of a turn's two readings to measure the window with. The last
/// request is the right one, but only when it says something: some gateways
/// attach a zeroed usage to every message, and an empty reading would report
/// an empty window while the prompt sits in it.
export const windowUsage = summary => {
  if (!summary) return null;
  const ctx = summary.contextUsage;
  return contextUsed(ctx) > 0 ? ctx : (summary.usage || null);
};

/// A request that rounds to zero still happened; say so rather than "0%".
export function pctText(used, limit) {
  const pct = used / limit * 100;
  return used > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/// Elapsed time, for the places a wait has to be readable at a glance: a
/// command still running, a turn that has gone quiet, a compaction.
export const fmtDuration = ms => ms < 1000 ? `${ms}ms`
  : ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
  : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

export function usd(v) {
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

export function shortPath(p) {
  const parts = (p || '').split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

export function basename(p) {
  const parts = (p || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/// Anchored popup menu — the only floating surface in the app. items:
/// [{label, checked, disabled, section, action}] with `section` starting a
/// labelled group and '-' as a divider.
/// Clicking the anchor while its menu is open closes it (toggle): the
/// away-mousedown records the anchor, and the click that follows is ignored.
let menuAnchor = null;
let suppressed = null;

export function openMenu(anchor, items) {
  if (suppressed && suppressed.anchor === anchor
      && Date.now() - suppressed.t < 500) {
    suppressed = null;
    return;
  }
  suppressed = null;
  closeMenu();
  menuAnchor = anchor;
  const menu = el('div', { class: 'menu' });
  for (const item of items) {
    if (item === '-') { menu.append(el('hr')); continue; }
    if (item.section !== undefined) {
      menu.append(el('div', { class: 'm-section', text: item.section }));
      continue;
    }
    const btn = el('button', {
      class: 'm-item' + (item.checked ? ' checked' : ''),
      disabled: item.disabled,
      onclick: () => { closeMenu(); item.action?.(); },
    }, item.label);
    menu.append(btn);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  let x = Math.min(r.left, window.innerWidth - mr.width - 8);
  let y = r.bottom + 4;
  if (y + mr.height > window.innerHeight - 8) y = r.top - mr.height - 4;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', handleAway, { capture: true });
    document.addEventListener('keydown', handleKey, { capture: true });
  }, 0);
}

function handleAway(e) {
  if (!document.querySelector('.menu')?.contains(e.target)) {
    if (menuAnchor && menuAnchor.contains(e.target)) {
      suppressed = { anchor: menuAnchor, t: Date.now() };
    }
    closeMenu();
  }
}
function handleKey(e) { if (e.key === 'Escape') closeMenu(); }

export function closeMenu() {
  menuAnchor = null;
  document.querySelector('.menu')?.remove();
  document.removeEventListener('mousedown', handleAway, { capture: true });
  document.removeEventListener('keydown', handleKey, { capture: true });
}
