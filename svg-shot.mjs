/**
 * THE SCREENSHOT AS A DOCUMENT YOU CAN SEARCH.
 *
 * One SVG: the captured raster as the base layer, and over it every string the page was showing,
 * as real text at zero opacity, sitting on its own pixels. Open it in any browser and Ctrl+F
 * works. Select a paragraph and it copies. Zoom in and the picture is a picture — the text layer
 * is for finding, not for rendering.
 *
 * Why this is not OCR: nothing is recognised. The strings, their boxes and their fonts were read
 * from the live document at the moment of the shot, so there is no accuracy to discuss — an eight
 * pixel label, a Chinese heading and an Arabic form label are all exactly as correct as the page
 * was.
 *
 * The one thing this file must never do is let the text layer become VISIBLE if a viewer ignores
 * the opacity: the page's own words in the wrong font over their own picture would look like a
 * rendering bug in the product. Hence both `fill-opacity="0"` and `fill="none"`, which no viewer
 * paints, and the layer is marked `aria-hidden` so a screen reader does not read the page twice.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Fonts are named as the page named them, with a generic fallback so a viewer never guesses. */
const family = (f) => `${esc(f)}, sans-serif`;

/**
 * EMBED OR LINK — decided by size, and said out loud either way.
 *
 * A self-contained file is the whole point: one thing to send, nothing to lose. But a
 * twenty-eight-screen capture is 22 MB of PNG, which is 30 MB once it is base64 inside an SVG, and
 * a 59 MB file is not «one thing to send», it is a thing that bounces off a mail server. Past the
 * threshold the picture is referenced by its own name beside the file instead — and the artefact
 * says which of the two it is, so nobody discovers it by forwarding the SVG on its own.
 */
const EMBED_LIMIT = 8 * 1024 * 1024;

export function renderSearchableSvg({ png, width, height, text, build, map, pngName }) {
  const runs = text?.runs ?? [];
  const missing = text?.missing ?? [];

  const layer = runs
    .map((r) => {
      /* textLength + lengthAdjust makes the invisible string occupy exactly the width the real one
         occupied, so a selection drag highlights the right pixels even though the font here is not
         the font the page used. */
      const len = Math.max(1, r.w);
      return `<text x="${r.x}" y="${r.baseline}" font-size="${r.size}" font-family="${family(r.family)}" font-weight="${esc(
        r.weight,
      )}" textLength="${len}" lengthAdjust="spacingAndGlyphs"${r.rtl ? ' direction="rtl"' : ''}>${esc(r.text)}</text>`;
    })
    .join('\n');

  /* The facts about the shot ride inside the file as a comment: an SVG is a text file, so this
     survives being opened, read and diffed, and it costs nothing. */
  const about = [
    build?.url ? `page: ${build.url}` : null,
    build?.at ? `taken: ${build.at}` : null,
    build?.viewport ? `window: ${build.viewport.w}x${build.viewport.h} at ${build.viewport.dpr}x` : null,
    build?.scripts?.length ? `running: ${build.scripts.slice(0, 6).join(' ')}` : null,
    map?.nodes?.length ? `controls mapped: ${map.nodes.length}` : null,
    `text runs: ${runs.length}${text?.capped ? ' (capped)' : ''}`,
    missing.length ? `NOT in the text layer: ${missing.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join('\n  ')
    .replace(/--/g, '—');

  const embed = png.length <= EMBED_LIMIT || !pngName;
  const href = embed ? png : pngName;
  const carriage = embed
    ? 'The picture is inside this file — it is one thing to send.'
    : `The picture is NOT inside this file: it is ${pngName}, beside it. Send both, or the SVG opens empty.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<!--
  Qiksy searchable screenshot.
  ${about}

  The picture is the truth; the text layer below it is invisible and exists so this file can be
  searched, selected and copied from. It was read from the live page, not recognised from pixels.

  ${carriage}
-->
<title>${esc(build?.title || build?.url || 'Screenshot')}</title>
<image x="0" y="0" width="${width}" height="${height}" xlink:href="${href}" href="${href}"/>
<g aria-hidden="true" fill="none" fill-opacity="0" stroke="none">
${layer}
</g>
</svg>
`;
}
