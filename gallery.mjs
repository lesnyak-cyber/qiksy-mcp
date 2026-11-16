/**
 * HOW THIS SCREEN LOOKS WHEN EVERYTHING GOES WRONG.
 *
 * The states nobody designs and nobody screenshots: the empty list, the 500 with the server's own
 * words in it, the spinner that never ends, the connection that drops mid-submit. A tester does
 * this by hand before every release — half an hour a screen — and a designer usually has never
 * seen their own error state at all.
 *
 * Three of the six people asked about this independently proposed it, and for the same reason:
 * every other capture tool can only PHOTOGRAPH a failure that happens to occur. This one can
 * CAUSE it, because the mocks and the camera are the same product. That is not a feature gap, it
 * is a category difference — and it costs almost nothing to build, because both halves already
 * exist and this file is only the recipe that walks them.
 *
 * THE ONE RULE THAT MATTERS: every path out of here clears the mocks. A forgotten rule outlives
 * the reason it was set, and the next thing anybody measures on that tab is a lie they cannot see.
 * The product already learned this once; a loop that sets rules in sequence is the easiest place
 * in the whole codebase to forget it, so the clearing is in a `finally` and is also asserted by
 * the stand.
 */

/** The failures worth having a picture of, and what each one is FOR. */
export const STATES = [
  {
    key: 'empty',
    title: 'Empty',
    why: 'the list came back with nothing in it — the state that is designed last and shipped broken most often',
    rule: { status: 200, body: '{"data":[],"items":[],"results":[],"total":0}' },
  },
  {
    key: 'server-error',
    title: 'Server error (500)',
    why: 'the back end fell over and said why — does the app show its words, or its own guess?',
    rule: { status: 500, body: '{"error":"upstream timeout","message":"The request could not be completed."}' },
  },
  {
    key: 'forbidden',
    title: 'Forbidden (403)',
    why: 'the session is alive but this user may not — the state that usually renders as an empty page with no explanation',
    rule: { status: 403, body: '{"error":"forbidden","message":"You do not have access to this resource."}' },
  },
  {
    key: 'slow',
    title: 'Slow (holding for 8s)',
    why: 'the answer is coming but has not arrived — this is the picture of the loading state, which is otherwise impossible to catch by hand',
    rule: { status: 200, body: '{"data":[]}', delayMs: 8000 },
    /* Photographed WHILE it is held, not after: the whole point is the spinner. */
    shootAfterMs: 2500,
  },
  {
    key: 'dropped',
    title: 'Connection dropped',
    why: 'the request failed at the transport level — no status, no body, the case most apps forget entirely',
    rule: { fail: true },
  },
];

export const STATE_KEYS = STATES.map((s) => s.key);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * ONE FILE THAT OPENS IN A BROWSER, and that is deliberate: the person who needs to see this —
 * a designer, a product owner, a client — does not have the extension and never will. Pictures are
 * embedded rather than linked, because a folder of files loses its pictures the moment it is
 * forwarded.
 */
export function renderGallery({ url, shots, build, receipt, at }) {
  const cards = shots
    .map((s) => {
      const img = s.dataUri
        ? `<img src="${s.dataUri}" alt="${esc(s.title)}">`
        : `<div class="missing">no picture — ${esc(s.error || 'the shot did not come back')}</div>`;
      return `<figure class="card${s.dataUri ? '' : ' bad'}">
  <figcaption>
    <h2>${esc(s.title)}</h2>
    <p class="why">${esc(s.why)}</p>
    <p class="rule">answered with: <code>${esc(s.ruleText)}</code></p>
  </figcaption>
  ${img}
</figure>`;
    })
    .join('\n');

  const hidden = (receipt?.hidden || []).map((h) => `${esc(h.what)} (${h.count})`).join(' · ') || '—';
  const notIncluded = (receipt?.notIncluded || []).map((n) => `<li>${esc(n)}</li>`).join('') || '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Failure states — ${esc(url)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 28px 32px 60px; background: #f6f7fb; color: #101828; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sub { color: #667085; margin: 0 0 6px; }
  .stamp { color: #667085; font-size: 12px; margin: 0 0 24px; }
  .stamp code { background: #eceff4; padding: 1px 5px; border-radius: 4px; }
  .card { margin: 0 0 28px; background: #fff; border: 1px solid #e4e7ec; border-radius: 12px; overflow: hidden; }
  .card.bad { border-color: #fda29b; }
  figcaption { padding: 14px 18px; border-bottom: 1px solid #f2f4f7; }
  h2 { font-size: 15px; margin: 0 0 2px; }
  .why { margin: 0 0 6px; color: #475467; }
  .rule { margin: 0; font-size: 12px; color: #667085; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  img { display: block; width: 100%; height: auto; }
  .missing { padding: 26px 18px; color: #b42318; }
  footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #e4e7ec; color: #667085; font-size: 12px; max-width: 760px; }
  footer ul { margin: 6px 0 0; padding-left: 18px; }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e6e8ec; }
    .card { background: #1b1e24; border-color: #2b2f37; }
    figcaption { border-color: #2b2f37; }
    .why { color: #aeb4bf; } .sub, .stamp, footer { color: #98a0ad; }
    .stamp code { background: #262a31; }
  }
</style>
</head>
<body>
  <h1>How this screen looks when things go wrong</h1>
  <p class="sub">${esc(url)}</p>
  <p class="stamp">Taken ${esc(at)}${build?.viewport ? ` · window ${build.viewport.w}×${build.viewport.h} at ${build.viewport.dpr}× · ${esc(build.colourScheme)} scheme` : ''}${
    build?.scripts?.length ? ` · running <code>${esc(build.scripts.slice(0, 3).join(' '))}</code>` : ''
  }</p>
  ${cards}
  <footer>
    <p><b>Each picture was caused, not waited for.</b> The app was answered from a rule instead of by its server; the rule is printed under every state. The rules were removed when the sheet was finished — a rule left behind would make the next measurement on this tab wrong.</p>
    <p><b>Covered before every frame:</b> ${hidden}.</p>
    ${notIncluded ? `<p><b>Not in this file at all:</b></p><ul>${notIncluded}</ul>` : ''}
    <p>This says what was hidden, not that the file is safe to send — whatever was on screen is in the pictures. Look before you forward it.</p>
  </footer>
</body>
</html>
`;
}
