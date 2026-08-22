// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Caden's chrome components. Each builder returns a fresh detached node; the
// class names are Caden's own and styles.css is the only thing that styles
// them. docs/DESIGN.md is the spec these implement -- the row shape (one 16px
// icon gutter and one 14px icon size down every list, a 30px row pitch), the
// radius scale and the alpha ladder all come from there.
//
// The shape every list row shares:
//
//   .nav-row
//     .nav-row-lead     leading slot -- icon, status dot or nothing, but
//                       always present, so labels line up down the column
//     .nav-row-body     .nav-row-label [+ .nav-row-desc]
//     .nav-row-end      trailing -- shortcut badge or hover actions, sharing
//                       one grid cell so the row keeps its measure
//
// `loadTemplates` stays async and exported so app.js keeps its existing
// startup sequence; there is nothing left to fetch.

import { el } from './util.js';
import { svgIcon, setSvgIcon } from './icons.js';

export async function loadTemplates() { /* nothing to load any more */ }

/// Class strings for the containers app.js builds itself.
const CLS = {
  sidebarClasses: 'sidebar-nav',
  sidebarHeaderCls: 'sidebar-header',
  sidebarHeaderContentCls: 'sidebar-header-body',
  scrollAreaCls: 'sidebar-scroll',
  viewportCls: 'sidebar-viewport',
  contentCls: 'sidebar-list',
  groupCls: 'sidebar-group',
  sectionCls: 'sidebar-section',
  sectionContentCls: 'sidebar-section-body',
  menuCls: 'sidebar-menu',
  menuItemCls: 'sidebar-menu-item',
  submitClsActive: 'send-btn ready',
  submitClsDim: 'send-btn',
};

export const cls = name => CLS[name] || '';

/// Standalone icon. Kept as `cIcon` because that is what the call sites say.
export function cIcon(name, size = 16) {
  return svgIcon(name, size);
}

/// Repoint an icon already in the tree at a different glyph.
export function setIcon(iconEl, name) {
  return setSvgIcon(iconEl, name);
}

/// The leading slot always exists, even when empty: a row without an icon
/// still has to occupy the gutter or its label sits left of its neighbours'.
const lead = (icon, size = 14) =>
  el('div', { class: 'nav-row-lead' }, icon ? svgIcon(icon, size) : null);

/// One list row. Everything in the sidebar is one of these.
function navRow({ label, icon, desc, badge, active, actionId } = {}) {
  const row = el('div', { class: 'nav-row', role: 'button', tabindex: '0' },
    lead(icon),
    el('div', { class: 'nav-row-body' },
      el('span', { class: 'nav-row-label', text: label || '' }),
      desc ? el('span', { class: 'nav-row-desc', text: desc }) : null),
    el('div', { class: 'nav-row-end' },
      badge ? el('span', { class: 'kbd', text: badge }) : null));
  row.dataset.navRow = '';
  if (active) row.dataset.active = 'true';
  if (actionId) row.dataset.actionId = actionId;
  return row;
}

const BUILD = {
  /// Window strip above the sidebar: traffic-light clearance + the collapse
  /// toggle. The spacer is a real element so its width can come from a var
  /// that is zero outside Electron.
  sidebarTop: () => el('div', { class: 'sidebar-topbar' },
    el('div', { class: 'traffic-spacer' }),
    el('div', { class: 'sidebar-topbar-icons' },
      el('button', { class: 'icon-btn', type: 'button' },
        svgIcon('layout-sidebar-left', 15)))),

  /// The three top-level destinations. app.js relabels them and wires the
  /// clicks; it no longer has to delete four rows it did not ask for.
  navHeader: () => el('div', { class: 'sidebar-header' },
    el('div', { class: 'sidebar-header-body' },
      navRow({ label: 'New session', icon: 'agent', badge: '⌘N' }),
      navRow({ label: 'Servers', icon: 'server' }),
      navRow({ label: 'Models', icon: 'robot' }))),

  navRow: () => navRow({ label: '', icon: 'agent' }),

  /// Group heading. The chevron only appears under the pointer -- a static
  /// one on every row is noise in a list this dense.
  groupLabel: () => {
    const label = el('div', { class: 'group-label' },
      el('div', { class: 'group-label-main' },
        el('span', { class: 'group-label-text' },
          el('span', { class: 'group-label-title', text: '' }),
          svgIcon('chevron-down', 12)),
        el('div', { class: 'group-label-actions' })));
    label.querySelector('svg').classList.add('group-label-chevron');
    return label;
  },

  /// A server/workspace heading: folder icon at rest, disclosure chevron on
  /// hover, actions revealed with it.
  sectionHead: () => {
    const head = el('div', { class: 'nav-row section-head' },
      el('div', { class: 'nav-row-lead' },
        svgIcon('folder-open', 14),
        svgIcon('chevron-down', 14)),
      el('div', { class: 'nav-row-body' },
        el('span', { class: 'nav-row-label' },
          el('span', { class: 'section-head-title', text: '' }))),
      el('div', { class: 'nav-row-end' },
        el('div', { class: 'nav-row-actions' },
          el('button', { class: 'icon-btn sm', type: 'button' },
            svgIcon('plus', 14)))));
    const [rest, fold] = head.querySelectorAll('.nav-row-lead > svg');
    rest.classList.add('section-head-icon');
    fold.classList.add('section-head-fold');
    head.dataset.sectionHead = '';
    return head;
  },

  /// A session row: status dot, title, and the archive action that appears
  /// under the pointer. No machine badge and no timestamp -- the list is
  /// sorted newest-first, so "3m" only restates the order, and which server a
  /// session runs on is already the section it sits in.
  cell: () => el('li', { class: 'sidebar-menu-item' },
    el('div', { class: 'nav-row', role: 'button', tabindex: '0',
                dataset: { navRow: '', hasActions: 'true' } },
      el('div', { class: 'nav-row-lead' },
        el('span', { class: 'nav-row-status' },
          el('span', { class: 'status-dot' }))),
      el('div', { class: 'nav-row-body' },
        el('span', { class: 'nav-row-label', text: '' })),
      el('div', { class: 'nav-row-end' },
        el('div', { class: 'nav-row-actions' },
          el('button', { class: 'icon-btn sm', type: 'button', title: 'Pin' },
            svgIcon('pin', 14)),
          el('button', { class: 'icon-btn sm', type: 'button', title: 'Archive' },
            svgIcon('archive', 14)))))),

  /// Identity strip at the bottom of the sidebar.
  footer: () => el('div', { class: 'sidebar-footer' },
    el('div', { class: 'nav-row', dataset: { static: 'true' } },
      el('div', { class: 'nav-row-lead' },
        el('span', { class: 'avatar', text: '' })),
      el('div', { class: 'nav-row-body' },
        el('span', { class: 'nav-row-label', text: '' }),
        el('span', { class: 'nav-row-desc', text: '' })))),

  /// The main column's title row.
  topbar: () => {
    const bar = el('div', { class: 'header' },
      el('button', { class: 'icon-btn', type: 'button', title: 'Show the sidebar' },
        svgIcon('layout-sidebar-left', 15)),
      el('span', { class: 'title', text: '' }),
      el('div', { class: 'header-end' }));
    bar.dataset.component = 'content-pane-top-bar';
    return bar;
  },

  /// Sidebar reduced to a rail when it is collapsed.
  collapsedStrip: () => el('div', { class: 'collapsed-strip' },
    el('button', { class: 'icon-btn', type: 'button', title: 'Show the sidebar' },
      svgIcon('layout-sidebar-left', 15))),

  /// A user's own message: the only filled surface in the conversation.
  rowHuman: () => el('div', { class: 'human-msg' },
    el('div', { class: 'human-msg-body' })),

  /// Assistant prose.
  rowText: () => el('div', { class: 'row-markdown' },
    el('div', { class: 'md', dataset: { size: 'md' } })),

  /// A collapsed tool call -- a row of text with a leading verb, not a card.
  rowTool: () => {
    const row = el('div', { class: 'row-activity' },
      el('div', { class: 'tool-call' },
        el('button', { class: 'fold', type: 'button' },
          el('span', { class: 'verb', text: '' }),
          el('span', { class: 'subject' }),
          svgIcon('chevron-right', 11))));
    row.querySelector('svg').classList.add('chev');
    return row;
  },

  /// An expanded group of tool calls: the same header plus a content view.
  rowToolOpen: () => {
    const group = el('div', { class: 'tool-group', dataset: { open: 'true' } },
      el('button', { class: 'fold open', type: 'button' },
        el('span', { class: 'verb', text: '' }),
        el('span', { class: 'subject' }),
        svgIcon('chevron-right', 11)),
      el('div', { class: 'fold-view', dataset: { open: 'true' } },
        el('div', { class: 'fold-content' })));
    group.querySelector('svg').classList.add('chev');
    return group;
  },

  /// One tool call inside an expanded group: verb, subject, trailing meta.
  toolLine: () => el('div', { class: 'tool-line-wrap' },
    el('div', { class: 'tool-line', dataset: { messageKind: 'tool' } },
      el('span', { class: 'tool-line-action', text: '' }),
      el('span', { class: 'tool-line-details', text: '' }))),

  /// Nine dots on a 3x3 sine, used where a row is waiting on the engine.
  dotLoader: () => {
    const grid = el('span', { class: 'dot-loader' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    for (let i = 0; i < 9; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', 2 + (i % 3) * 4);
      c.setAttribute('cy', 2 + Math.floor(i / 3) * 4);
      c.setAttribute('r', '1');
      c.setAttribute('fill', 'currentColor');
      // The sine runs along the anti-diagonal, so the wave reads as motion
      // across the grid rather than nine independent blinks.
      c.style.animationDelay = `${((i % 3) + Math.floor(i / 3)) * 0.11}s`;
      svg.append(c);
    }
    grid.append(svg);
    return el('span', { class: 'nav-row-status' }, grid);
  },

  /// Branch + workspace, under the composer.
  statusRow: () => el('div', { class: 'caden-status-row' },
    el('button', { class: 'quiet', type: 'button', dataset: { shows: 'branch' } },
      svgIcon('git-branch', 12),
      el('span', { text: '' }),
      svgIcon('chevron-down', 11)),
    el('button', { class: 'quiet', type: 'button', disabled: true },
      svgIcon('server', 12),
      el('span', { text: '' }))),

  /// Context-window dial: a ring that fills as the window does.
  contextGauge: () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', 'rotate(-90 12 12)');
    for (const role of ['track', 'value']) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', 'currentColor');
      c.setAttribute('stroke-width', '3');
      c.classList.add('gauge-' + role);
      if (role === 'value') {
        c.setAttribute('stroke-linecap', 'round');
        // pathLength normalises the circumference to 100, so the arc is set
        // in percent and the dash maths cannot drift out of step with `r`
        // again -- which is exactly what made the ring draw a stray second
        // segment when the two disagreed.
        c.setAttribute('pathLength', '100');
      }
      g.append(c);
    }
    svg.append(g);
    return el('button', { class: 'gauge', type: 'button' }, el('span', {}, svg));
  },

  /// Token/cost detail, opened from the gauge: how full the window is, a
  /// stacked bar of where the tokens went, and the same split as a list.
  contextPanel: () => el('div', { class: 'ctx-panel' },
    el('div', { class: 'ctx-panel-head' },
      el('span', { class: 'ctx-panel-pct', text: '' }),
      el('span', { class: 'ctx-panel-count', text: '' }),
      el('button', { class: 'icon-btn sm ctx-panel-close', type: 'button',
                     title: 'Close' }, svgIcon('minus', 13))),
    el('div', { class: 'ctx-bar' }),
    el('ul', { class: 'ctx-cats' })),

  /// One segment of the context bar / one row of its legend.
  ctxSegment: () => el('span', { class: 'ctx-seg' }),
  ctxCategory: () => el('li', { class: 'ctx-cat' },
    el('span', { class: 'ctx-cat-swatch' }),
    el('span', { class: 'ctx-cat-label', text: '' }),
    el('span', { class: 'ctx-cat-value', text: '' })),

  /// New-session screen. Starting a session is not a form: the same composer
  /// the session will live in, with where-it-runs as two selects above it.
  emptyState: () => el('div', { class: 'empty-state' },
    el('div', { class: 'empty-state-inner' },
      el('div', { class: 'empty-state-selects' },
        el('button', { class: 'select-trigger', type: 'button' },
          svgIcon('folder', 12), el('span', { text: '' }), svgIcon('chevron-down', 10)),
        el('button', { class: 'select-trigger', type: 'button' },
          svgIcon('server', 12), el('span', { text: '' }), svgIcon('chevron-down', 10))),
      BUILD.promptInput())),

  terminalsPill: () => el('span', { class: 'chip' },
    svgIcon('terminal', 11), el('span', { text: '' })),

  promptInput: () => el('div', { class: 'composer' },
    el('div', { class: 'composer-editor', contenteditable: 'true',
                role: 'textbox', 'aria-multiline': 'true' },
      el('p')),
    el('div', { class: 'composer-controls' },
      el('button', { class: 'icon-btn composer-plus', type: 'button', title: 'Attach' },
        svgIcon('plus', 14)),
      el('div', { class: 'composer-controls-left' },
        el('button', { class: 'quiet model-trigger', type: 'button' },
          el('span', { class: 'model-label', text: '' }),
          svgIcon('chevron-down', 10))),
      el('button', { class: 'send-btn', type: 'button', dataset: { state: 'active' } },
        svgIcon('arrow-up', 14)))),
};

/// Fresh DOM node for a component.
export function tpl(name) {
  const build = BUILD[name];
  if (!build) throw new Error(`no such component: ${name}`);
  return build();
}

/// Fill a row: label, icon, click. Unchanged signature -- only the selectors
/// underneath it moved.
export function fillMenuButton(root, { label, icon, onClick, onContext }) {
  const btn = root.matches?.('.nav-row') ? root : root.querySelector('.nav-row');
  const labelEl = btn.querySelector('.nav-row-label');
  if (labelEl) labelEl.textContent = label;
  if (icon) {
    const slot = btn.querySelector('.nav-row-lead');
    if (slot) slot.replaceChildren(svgIcon(icon, 14));
  }
  if (onClick) btn.addEventListener('click', onClick);
  if (onContext) btn.addEventListener('contextmenu', e => { e.preventDefault(); onContext(e); });
  btn.removeAttribute('data-action-id');
  return btn;
}
