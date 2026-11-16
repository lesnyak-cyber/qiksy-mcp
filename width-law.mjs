/**
 * THE LAW OF WIDTH — comparing DECLARATIONS, not measurements.
 *
 * The question that started this (owner, 30.09.2026): «Figma там контейнер допустим 1400, а у нас
 * там больше контейнер, нужно как-то вот на это указать». Every ordinary approach answers it
 * badly, and for one reason: a MEASUREMENT of a container depends entirely on the window it was
 * measured in. «1360 px» is not a defect and not a pass — it is a fact about the browser window,
 * and a report full of those teaches its reader to ignore it.
 *
 * A DECLARATION does not depend on the window. «This page caps its content at 1400» and «this page
 * declares no cap at all» are true at every width, so they can be compared with a mockup, argued
 * about, and fixed. That is what this module reads.
 *
 * So the verdict is never «the container is wrong». It is: here is what the code declared, here is
 * what follows from it at any width, and here is what was NOT looked at. Whether the code or the
 * mockup is right is a human's call, and this refuses to make it.
 *
 * WHAT IT DELIBERATELY REFUSES TO ANSWER. A value that moves with the window — clamp(), vw, a
 * percentage — has no single declaration to compare, so it goes to a NOT MEASURED list rather than
 * being resolved at the current window and printed as if it were a law. Resolving it would produce
 * exactly the plausible-looking number this whole design exists to avoid: right in this window,
 * wrong in the next, and indistinguishable from a real finding in the report.
 */

/** A tolerance, because a browser rounds and a designer does not. One pixel is never a finding. */
export const SLACK = 1;

/**
 * What KIND of thing a CSS length is, which matters more here than its number.
 *
 * `none` is the answer that carries the whole feature: it is what a page says when it has no
 * ceiling at all, and it is invisible in any screenshot taken on a laptop.
 */
export function parseLength(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return { kind: 'auto', raw: s };
  if (s === 'none') return { kind: 'none', raw: s };
  /* Order matters: clamp(60ch, 90vw, 1400px) contains "px" and is NOT a fixed length. */
  if (/\b(clamp|min|max|calc)\s*\(/.test(s) || /\d(vw|vh|vmin|vmax|dvw|svw|lvw)\b/.test(s)) {
    return { kind: 'fluid', raw: s };
  }
  if (/%$/.test(s)) return { kind: 'percent', pct: Number.parseFloat(s), raw: s };
  const px = /^(-?[\d.]+)px$/.exec(s);
  if (px) return { kind: 'px', px: Number.parseFloat(px[1]), raw: s };
  /* A length in a unit the page resolved for us anyway (rem/em arrive as px from a computed
     style); anything left is honestly unknown rather than quietly treated as zero. */
  return { kind: 'unknown', raw: s };
}

/** Computed padding and margin arrive as px strings; a side we cannot read is 0 and SAYS so. */
function side(raw) {
  const v = parseLength(raw);
  return v.kind === 'px' ? { px: v.px, sure: true } : { px: 0, sure: false, raw: v.raw };
}

/**
 * ANCESTRY WITHOUT THE DOM. `qa_collect` hands back a cssPath per node, and a path is a prefix of
 * its descendants' paths — so the layout spine can be rebuilt in this process from the table
 * alone, with no second call and no walking the page. The separator check matters: `div#main`
 * must not count as an ancestor of `div#main-nav`.
 */
export function isAncestor(a, b) {
  if (!a || !b || a === b) return false;
  if (!b.startsWith(a)) return false;
  const next = b[a.length];
  return next === ' ' || next === '>';
}

/**
 * THE SPINE: the nested chain of containers the content actually sits in.
 *
 * Only wide boxes count. A sidebar or a card is narrow BY DESIGN, and judging it against the
 * window would produce a finding on every healthy page — the defect this instrument is built to
 * not have. `minShare` is what «wide» means: at 0.5 a half-width column still counts as layout,
 * and anything narrower is content.
 */
export function spine(rows, { viewport, minShare = 0.3 } = {}) {
  const all = (rows || []).filter((r) => r && typeof r.selector === 'string' && r.selector);
  const widthOf = (r) => Number(r?.geometry?.width ?? r?.geometry?.w) || 0;

  /* WHAT COUNTS AS LAYOUT. Wide is the usual answer, but not the only one: a phone-shaped app
     centres a 560px column inside a 1501px window, and a width threshold alone throws away the
     very element that holds the cap. Measured on Qiksy Shelf, 01.10.2026: at a half-window
     threshold the spine stopped three levels above `#content`, and its `max-width: 560px` — the
     only real ceiling on the page — was never seen. So anything that DECLARES a ceiling is layout
     whatever its size. */
  const isLayout = (r) =>
    (viewport ? widthOf(r) >= viewport * minShare : true) ||
    parseLength(r?.style?.['max-width'] ?? r?.style?.maxWidth).kind === 'px';

  const chain = [];
  let tail = null;
  for (;;) {
    const next = all
      .filter((r) => (tail === null ? !all.some((o) => isAncestor(o.selector, r.selector)) : isAncestor(tail, r.selector)))
      .filter(isLayout)
      /* THE WIDEST DESCENDANT, NOT THE FIRST ONE. A sidebar and the content column are siblings,
         and sorting by path length picks between them by accident — which is how a narrow aside
         ends up being judged as the page's layout. */
      .sort((a, b) => widthOf(b) - widthOf(a) || a.selector.length - b.selector.length);
    if (!next.length) break;
    const pick = next[0];
    if (chain.some((c) => c.selector === pick.selector)) break;
    chain.push(pick);
    tail = pick.selector;
  }
  return chain;
}

/** One node's declaration, in the shape the verdict is built from. */
export function readNode(row) {
  const st = row?.style || row || {};
  const pick = (...names) => {
    for (const n of names) if (st[n] !== undefined) return st[n];
    return undefined;
  };
  return {
    selector: row?.selector || '',
    maxWidth: parseLength(pick('max-width', 'maxWidth', 'style:max-width')),
    width: parseLength(pick('width', 'style:width')),
    boxSizing: String(pick('box-sizing', 'boxSizing', 'style:box-sizing') || 'content-box').trim(),
    padLeft: side(pick('padding-left', 'paddingLeft', 'style:padding-left')),
    padRight: side(pick('padding-right', 'paddingRight', 'style:padding-right')),
    marLeft: side(pick('margin-left', 'marginLeft', 'style:margin-left')),
    marRight: side(pick('margin-right', 'marginRight', 'style:margin-right')),
    measured: Number(row?.geometry?.width ?? row?.geometry?.w),
  };
}

/**
 * What the content band WOULD be at a given window width, derived from the declarations rather
 * than measured. This is the part that answers «и что с этого» — a ceiling of 1400 means nothing
 * until someone says what the reader actually gets at 1920.
 *
 * Returns `{ band, sure, steps }`. `sure:false` means a fluid or unknown value sat in the chain,
 * and the number must NOT be printed as a law — it is reported as not measured instead.
 */
export function bandAt(chain, windowWidth) {
  let avail = windowWidth;
  let sure = true;
  const steps = [];
  for (const n of chain) {
    const before = avail;
    const padding = n.padLeft.px + n.padRight.px;
    if (!n.padLeft.sure || !n.padRight.sure) sure = false;

    /* MARGINS ARE DELIBERATELY NOT COUNTED. A computed style resolves `margin: 0 auto` into the
       centring number — on Qiksy Shelf it came back as 470.5px a side — and nothing in a computed
       style distinguishes that from an author's own 470.5px. Using it anchors the projection to
       the window this ran in: the band at 1440 came out 467 and at 1920 came out 528, from one
       and the same declaration. An unknowable value is left out rather than guessed. */
    let box = avail;
    if (n.maxWidth.kind === 'px') box = Math.min(box, n.maxWidth.px);
    else if (n.maxWidth.kind !== 'none' && n.maxWidth.kind !== 'auto') sure = false;
    /* `width` is deliberately NOT applied: a computed width is the resolved measurement, so using
       it would anchor the projection to the window this ran in and quietly make every other
       window's number a copy of it. */

    /* border-box counts padding INSIDE the declared width; content-box adds it outside, so in
       both cases the children get the box minus the padding, and only the ORDER differs. */
    avail = box - padding;
    steps.push({ selector: n.selector, from: before, to: avail, capped: n.maxWidth.kind === 'px' ? n.maxWidth.px : null });
  }
  return { band: Math.round(avail), sure, steps };
}

/** Windows worth projecting to: a laptop, a desktop, and one wide enough to expose a missing cap. */
export const WINDOWS = [1440, 1920, 2560];

/**
 * THE VERDICT. Never «right» or «wrong» — two declarations and what follows from them.
 */
export function widthLaw({ rows, viewport, windows = WINDOWS, figmaWidth = null }) {
  const chain = spine(rows, { viewport }).map(readNode);

  if (!chain.length) {
    return {
      ok: false,
      error: 'no-spine',
      note:
        'Nothing on this page is wide enough to be a layout container, so there is no width law to read. ' +
        'Either the page has not finished rendering, or `within` pointed at a narrow region — name the page or its main landmark instead.',
    };
  }

  /* ONLY `max-width` DECLARES A CEILING. `width` from a computed style is ALWAYS a resolved pixel
     number — `width: auto` on <body> reads back as «1501px» — so counting it turns the measurement
     this instrument exists to avoid into a confident law. It did exactly that on Qiksy Shelf
     (01.10.2026): «one ceiling, 1501px, set by body, 101px wider than the mockup», which would
     have read «1920px» one drag of the mouse later. `max-width` computes to `none` when nothing
     declared it, which is why it is the only honest signal here. */
  const ceilings = chain
    .filter((n) => n.maxWidth.kind === 'px')
    .map((n) => ({
      selector: n.selector,
      declares: `max-width: ${n.maxWidth.raw}`,
      px: n.maxWidth.px,
    }));

  /* The honest list, and it OPENS the report rather than closing it: a reader who does not know
     what was skipped cannot tell a clean page from an unexamined one. */
  const notMeasured = chain
    .filter((n) => ['fluid', 'percent', 'unknown'].includes(n.maxWidth.kind) || n.width.kind === 'fluid')
    .map((n) => ({
      selector: n.selector,
      value: n.maxWidth.kind === 'px' || n.maxWidth.kind === 'none' ? n.width.raw : n.maxWidth.raw,
      why: 'this value moves with the window, so it declares no single law to compare',
    }));

  const projection = windows.map((w) => {
    const r = bandAt(chain, w);
    return { window: w, band: r.sure ? r.band : null, sure: r.sure };
  });
  const here = bandAt(chain, viewport);

  const tightest = ceilings.length ? ceilings.reduce((a, b) => (a.px <= b.px ? a : b)) : null;

  const verdict = !ceilings.length
    ? 'no-ceiling'
    : ceilings.length === 1
      ? 'one-ceiling'
      : 'several-ceilings';

  const out = {
    ok: true,
    verdict,
    notMeasured,
    code: {
      ceilings,
      tightest,
      chain: chain.map((n) => n.selector),
      bandHere: here.sure ? here.band : null,
      measuredAt: viewport,
    },
    projection,
  };

  /* WITH a mockup number this becomes the comparison the owner asked for. Without one it is still
     useful on its own, which is why the number is optional rather than required. */
  if (Number.isFinite(figmaWidth)) {
    out.mockup = { declares: figmaWidth };
    if (!tightest) {
      out.disagreement = {
        mockup: `one ceiling, ${figmaWidth}px`,
        code: 'no ceiling at all',
        follows: projection
          .filter((p) => p.sure)
          .map((p) => `window ${p.window} → band ${p.band}, ${p.band - figmaWidth}px wider than the mockup`),
      };
    } else if (Math.abs(tightest.px - figmaWidth) > SLACK) {
      out.disagreement = {
        mockup: `one ceiling, ${figmaWidth}px`,
        code: `one ceiling, ${tightest.px}px, set by ${tightest.selector}`,
        follows: [`${tightest.px - figmaWidth > 0 ? 'wider' : 'narrower'} than the mockup by ${Math.abs(tightest.px - figmaWidth)}px at every window`],
      };
    }
    /* The fork is printed by the caller, never a recommendation: this instrument does not know
       whether the mockup or the code is the one that should move. */
  }
  return out;
}
