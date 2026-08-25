// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Caden's icon set: inline SVG on one 24x24 grid, 1.75 stroke, round caps and
// joins. Drawn to the rules in docs/DESIGN.md -- regular weight, not light,
// because thin strokes next to 13px text read as cheapness rather than
// elegance. One size (14px) and one gutter (16px) everywhere a row has a
// leading icon; `size` only exists for the handful of places that are not
// rows (composer chips at 11-12, the sidebar toggle at 15).
//
// Names carry aliases: the app grew two vocabularies (short names like
// `cpu`/`warn` and long ones like `chip`/`exclamation-triangle`) and both are
// live at call sites, so both resolve here.

/// Path data only -- the wrapper supplies viewBox, stroke and sizing.
/// `f:` marks a filled glyph (the few that read wrong as outlines).
const ICONS = {
  // -- panels and navigation ------------------------------------------------
  'layout-sidebar-left': 'M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 3v18',
  'layout-sidebar-right': 'M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM14 3v18',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevrons-right': 'M5 5l7 7-7 7M13 5l7 7-7 7',
  'arrow-up': 'M12 20V4M5 11l7-7 7 7',
  'arrow-left': 'M20 12H4M11 5l-7 7 7 7',
  'arrow-right': 'M4 12h16M13 5l7 7-7 7',
  'arrow-right-up': 'M7 17L17 7M8 7h9v9',
  'ellipsis': 'M6 12h.01M12 12h.01M18 12h.01',

  // -- files and places -----------------------------------------------------
  'folder': 'M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-open': 'M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V11M3 8v10a2 2 0 0 0 2 2h13l3-8H6.5a2 2 0 0 0-1.9 1.4z',
  'folder-plus': 'M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11.5v6M9 14.5h6',
  'file': 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  'file-list': 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M8.5 13h7M8.5 16.5h4.5',
  'archive': 'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v1A1.5 1.5 0 0 1 19.5 9h-15A1.5 1.5 0 0 1 3 7.5zM5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4',
  'pin': 'M12 15v6M8.5 3.5h7l-.8 6.2 2.3 2.3v1.5H7v-1.5l2.3-2.3z',

  // -- machines and tools ---------------------------------------------------
  'server': 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 15a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM6.5 7.5h.01M6.5 16.5h.01',
  'chip': 'M7 7h10v10H7zM9.5 2.5v4.5M14.5 2.5v4.5M9.5 17v4.5M14.5 17v4.5M2.5 9.5h4.5M2.5 14.5h4.5M17 9.5h4.5M17 14.5h4.5',
  'terminal': 'M5 6.5L10 12l-5 5.5M12.5 17.5h6.5',
  'globe': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 12h17M12 3c2.3 2.4 3.5 5.6 3.5 9s-1.2 6.6-3.5 9c-2.3-2.4-3.5-5.6-3.5-9s1.2-6.6 3.5-9z',
  'git-branch': 'M6.5 3.5v10M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 8.5v2a4 4 0 0 1-4 4h-3.5',
  'lock-locked': 'M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  'sliders': 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
  'gear': 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.1 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 0 1-3.8 0V20a1.6 1.6 0 0 0-2.7-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.9a1.9 1.9 0 0 1 0-3.8H4a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1A1.6 1.6 0 0 0 10.7 4v-.3a1.9 1.9 0 0 1 3.8 0V4a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 0 1 0 3.8H20a1.6 1.6 0 0 0-.9.1z',
  'extensions': 'M9 3.5H5.5A1.5 1.5 0 0 0 4 5v3.5M15 3.5h3.5A1.5 1.5 0 0 1 20 5v3.5M9 20.5H5.5A1.5 1.5 0 0 1 4 19v-3.5M15 20.5h3.5a1.5 1.5 0 0 0 1.5-1.5v-3.5M9.5 9.5h5v5h-5z',

  // -- agents ---------------------------------------------------------------
  'agent': 'M12 3.5l2.4 5.1 5.6.7-4.1 3.9 1.1 5.5-5-2.8-5 2.8 1.1-5.5L4 9.3l5.6-.7z',
  'robot': 'M6 9h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 6V9M12 4.5a1.5 1.5 0 1 0 0 .01M9 13.5h.01M15 13.5h.01M9.5 16.5h5',
  'brain': 'M9.5 4A2.5 2.5 0 0 0 7 6.5 2.5 2.5 0 0 0 5 9a2.5 2.5 0 0 0 1 2 2.5 2.5 0 0 0-.5 1.5A2.5 2.5 0 0 0 8 15a2.5 2.5 0 0 0 2.5 2.5H12V4zM14.5 4A2.5 2.5 0 0 1 17 6.5 2.5 2.5 0 0 1 19 9a2.5 2.5 0 0 1-1 2 2.5 2.5 0 0 1 .5 1.5A2.5 2.5 0 0 1 16 15a2.5 2.5 0 0 1-2.5 2.5H12V4z',
  'mic': 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6 11.5V12a6 6 0 0 0 12 0v-.5M12 18v3',
  'waveform': 'M4 12h2.5L9 6l3 12 3-9 2 3h3',
  'bolt': 'M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z',

  // -- editing and actions --------------------------------------------------
  'pencil-square': 'M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4zM20 13.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5.5',
  'magnifying-glass': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4.5 4.5',
  'plus': 'M12 5v14M5 12h14',
  'minus': 'M5 12h14',
  'plus-minus': 'M5 8h8M9 4v8M5 17h8M15.5 6.5L21 19',
  'trash': 'M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5V19a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V6.5M10 10.5v6M14 10.5v6',
  'copy': 'M9 9.5A2.5 2.5 0 0 1 11.5 7h7A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 9 16.5zM15 7V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15H7',
  'split': 'M12 3.5v17M7 8.5L3.5 12 7 15.5M17 8.5l3.5 3.5-3.5 3.5',
  'list-filter': 'M4 6.5h16M6.5 12h11M10 17.5h4',
  'exclamation-triangle': 'M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0zM12 9.5v4M12 17h.01',
  'stop-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5h5v5h-5z',
  'stop-filled': { f: 'M7.5 6.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z' },
};

/// The two vocabularies that grew up in the app, pointed at one drawing each.
const ALIAS = {
  sidebar: 'layout-sidebar-left',
  'layout-sidebar-left-off': 'layout-sidebar-left',
  compose: 'pencil-square',
  search: 'magnifying-glass',
  cpu: 'chip',
  folderPlus: 'folder-plus',
  lock: 'lock-locked',
  info: 'file-list',
  plusminus: 'plus-minus',
  up: 'arrow-up',
  stop: 'stop-filled',
  chevD: 'chevron-down',
  chevR: 'chevron-right',
  chevL: 'chevron-left',
  warn: 'exclamation-triangle',
  waves: 'waveform',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export const resolve = name => ALIAS[name] || name;

/// One `<svg>`, sized in px. Stroke follows `currentColor`, so an icon takes
/// the colour of the row it sits in and needs no per-context rule.
export function svgIcon(name, size = 13) {
  const key = resolve(name);
  const spec = ICONS[key] || ICONS['file-list'];
  const filled = typeof spec === 'object';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.dataset.iconName = name;
  if (!filled) {
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', filled ? spec.f : spec);
  svg.append(path);
  return svg;
}

/// Repoint an existing icon at a different glyph, keeping its size, its slot
/// and its classes. Carrying the classes over is the whole point: callers
/// find these icons again by class (`.group-label-chevron`,
/// `.section-head-fold`) and style them by class, so dropping them on the
/// first swap would orphan both the lookup and the rule.
export function setSvgIcon(node, name) {
  if (!node) return;
  const size = node.getAttribute('width') || 13;
  const next = svgIcon(name, size);
  for (const c of node.classList) next.classList.add(c);
  node.replaceWith(next);
  return next;
}

export const iconNames = () => Object.keys(ICONS);
