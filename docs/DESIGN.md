# Visual system

Caden's chrome is built from one small set of tokens rather than a palette of
one-off values. The point is consistency, not novelty: a single tint source, one
small radius scale, fast motion, and hairlines instead of borders. Everything
below is what `app/web/styles.css` implements — when the two disagree, this
document is the one to change first.

## Layering

There is no palette of greys. There are two canvases and one tint colour, and
everything else is that tint at a fixed alpha:

| Canvas | Dark | Light |
| --- | --- | --- |
| content | `#181818` | `#FCFCFC` |
| sidebar / rail | `#141414` | `#F3F3F3` |
| tint source (`base`) | `#F0F0F0` | `#141414` |

| Role | Alpha of `base` |
| --- | --- |
| quaternary fill | 6% |
| hover | 7% |
| tertiary fill | 8% |
| secondary fill | 14% |
| active / selected | 16% |
| primary fill | 20% |
| hairline (soft) | 12% |
| hairline (strong) | 20% |
| text primary | 100% |
| text secondary | 74% |
| text tertiary | 60% |
| text quaternary | 36% |
| icon secondary | 66% |
| icon tertiary | 52% |

Note the sidebar is *darker* than the content area in dark mode and *lighter*
in light mode — the content column is always the brightest surface.

## Type

12px is the chrome base. Lists sit one notch above it, and the conversation one
notch above that — a dense list at 12 reads cramped, and body text at 12 reads
like a tooltip.

| Role | Size / line |
| --- | --- |
| micro — chip, timestamp, metadata | 11 |
| chrome base — section headers, counters | 12 |
| lists — sidebar rows, nav, rail rows, tool rows | 13 |
| conversation body | 15 / 24 |
| session title | 14 semibold |

Weights used: 400, 500, 600. Nothing heavier. The UI face is the system one
(`-apple-system`) at 418 — SF is a variable face and that half-step above
regular is what keeps 13px list text from looking thin against the canvas.
Code is JetBrains Mono, shipped in `app/web/fonts/` under the OFL.

## Icons

One gutter width (16px) and one size (14px, regular weight) everywhere a row has
a leading icon — sidebar nav, group headers, session rows, rail rows, tool rows.
Mixed icon sizes are the fastest way to make a list look assembled rather than
designed, and a shared gutter is what makes labels line up down the column even
when some rows have no icon at all.

An empty leading slot still has to occupy the gutter: give the slot a fixed
width and render an empty element into it rather than omitting it, or rows
without a status dot sit further left than rows with one.

## Shape

| Radius | Used for |
| --- | --- |
| 4px | menu items, small controls |
| 6px | rows, tool cards |
| 8px | cards |
| 10px | panels, popovers |
| 14px | message bubbles |
| 16px | composer |
| 999px | pills |

Six steps and no more: a radius that is *nearly* the same as its neighbour
reads as a mistake rather than a distinction.

Borders are 1px at 12% (soft) or 20% (strong) — present, but barely. Shadows
exist only on floating surfaces (composer, status pill), and there they are
layered in two: a snug contact shadow
(`0 1px 2px black/10%`) plus a soft ambient one (`0 8px 16px black/16%`), over
an **opaque** raised fill (`#1F1F1F` dark / `#FFFFFF` light) with the usual 1px
ring. A translucent fill over a drop shadow goes muddy; floating surfaces need
their own ground. Flat chrome plus floating input is most of what separates a
"designed" panel from a grey mock-up.

Icons are drawn, not licensed: `app/web/icons.js` holds the set as inline SVG
on one 24x24 grid, stroked at 1.75 in `currentColor` so an icon takes the
colour of the row it sits in. They are regular weight, not light — thin strokes
next to 13px text read as cheapness, not elegance.

Crucially, **the transcript has no cards.** Tool calls, todo lists and file
changes are rows of text with a leading icon, not bordered containers. Boxing
them is what makes a conversation read as a stack of widgets instead of prose
with machine detail folded into it. The only filled surfaces in the conversation
are the user's own message, code blocks, and command output.

## Layout

| Constant | Value |
| --- | --- |
| content column max width | 840px |
| gap between a prompt and its reply | 16px |
| air above a new prompt | 28px |
| user message padding | 10px block / 14px inline |
| composer inset | 16px |
| sidebar row hover-action width | 60px |

The user's message spans the column at the quietest fill (6%) plus a hairline
border — the border marks the prompt, so the fill can stay light enough that a
stack of prompts doesn't read as grey slabs. It stays on the left: this is a
work log, not a chat with two parties.

The inspector rail has no panel fill and no rule — it is quiet text on the
same canvas as the conversation, not a second sidebar. Composer controls
(permissions, model) are dim text that only grows a hover background; a row of
filled chips beside a text field is noise.

The composer is one surface with two rows: the text field on top, and a
controls row (workspace, permission mode, model, send) underneath. Inlining
the chips beside the text is what makes a composer read cramped, and it breaks
down entirely on multi-line drafts.

## Motion and interaction

Transitions are 70–200ms; 120ms is the default. Hover-revealed actions animate
`opacity` and toggle hit-testing — they never change layout, so rows do not
jump under the pointer. Scroll containers fade their bottom edge with a
`linear-gradient` mask rather than a hard cut.


## Structure

Three structural decisions, none of them about colour:

**Servers are groups, not a mode.** There is no server switcher; every
configured server connects and appears in the sidebar as a first-class
section — status dot, name, its workspaces nested underneath. Which server a
session lives on is something you see, not something you set globally. Server
management (setup, edit, remove) lives on the server row itself.

**Nothing is modal.** Settings-grade surfaces — the model registry, server
setup, server settings, session detail — swap into the main pane with a title
row and a way back; the sidebar stays live and selecting anything else
navigates away. Only lightweight pickers float, and they float as popovers
anchored to the control that opened them, never as app-blocking sheets.

**Starting a session is not a form.** "New session" shows the same composer
the session will live in, with where-it-runs, permissions and model as chips
on the composer — type and send. It doubles as the empty state: no session
selected means "ready to start one". The modal sheet this replaced asked
eight questions before you could say what you wanted.

## Sidebar rhythm

One rhythm down the whole column, at a 260px sidebar:

| | value |
| --- | --- |
| row pitch (nav, groups, sessions) | 30px — one uniform rhythm |
| group label height | 24px |
| list inset from the sidebar edge | 8px |
| icon box | 14px, centred in a 16px gutter |
| icon left edge | 15px from the sidebar edge |
| label left edge | 38px — group labels and session titles share it |
| extra space before a new group | +10px |
| identity row (footer) | 44px, the one taller row, with a 28px avatar |

Two rules hold this together: sections are separated by **whitespace rather
than a divider**, and the disclosure chevron on a group appears only under the
pointer. A static chevron on every row is noise in a list this dense, and a
rule between two parts of one list reads as a boundary that is not there.
