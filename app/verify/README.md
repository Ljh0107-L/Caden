# verify/ — style parity checks

These tools answer one question: *did a change to `styles.css` or
`templates.js` alter how anything renders?* They compare two probes of the
live page, so the check is on computed values rather than on the source.

They were written for the de-vendoring rewrite — the pass that replaced a
copied third-party stylesheet with Caden's own — and they stay useful for any
change big enough to be worth proving.

`baseline/` is where captures land. It is gitignored and starts out empty: a
probe is a snapshot of whatever the window was showing at the time, down to
every server name and path, so baselines are taken locally rather than
shipped. Capture the "before" on the current build, make the change, capture
the "after", diff the two.

## Capturing a probe

Run the app with the staging endpoint enabled:

```bash
CADEN_VERIFY=1 npm run dev
```

Then, in the page, walk a component and post the result. The walk records one
record per visible node: tag, classes, geometry relative to the component
root, and the ~30 computed properties that decide rendering.

```js
// in the page console
const probe = (sel) => { /* see the walk in the git history of this file */ };
await fetch('/host/stage', { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'after.json',
                         data: JSON.stringify({ sidebar: probe('#sidebar') }) }) });
```

Both files may be a flat node list or a `{component: [nodes]}` map.

## Reading a diff

`text-diff.py` is the one to reach for first:

```bash
python3 app/verify/text-diff.py app/verify/baseline/before.json app/verify/baseline/after.json
```

It aligns text-bearing leaves **by their text** and reports size, weight,
family, leading and colour. Aligning by text survives restructuring, which
matters because a rewrite that flattens the DOM changes every structural path
while changing nothing a reader can see. Colours are normalised before
comparison — `color(srgb 0.941176 …)` and `rgb(240, 240, 240)` are the same
grey, and comparing them as strings makes every colour look like a delta.

`style-diff.py` is the node-by-node version, for when structure is *supposed*
to have stayed put. It ignores class names by default (`--show-class` to keep
them) and tags window-size-dependent differences `[geom]`.

## Legitimate differences to discount

- **Widths, and the text heights that follow from them.** A narrower window
  wraps more, so a taller block is not a regression. Compare at one size, or
  compare only the fixed chrome (the sidebar is a constant 260px).
- **`0px` borders.** A border-width of zero still reports a colour.
- **State-dependent values.** Focus rings, hover fills and the `opacity` of
  hover-revealed actions only match if both probes were taken in the same
  state.
