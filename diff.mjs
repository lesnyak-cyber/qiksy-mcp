// src/content/engine/color.ts
function canvasNormaliser() {
  let ctx;
  return (css) => {
    if (ctx === void 0) {
      try {
        ctx = document.createElement("canvas").getContext("2d");
      } catch {
        ctx = null;
      }
    }
    if (!ctx) return null;
    const read = (seed) => {
      ctx.fillStyle = seed;
      ctx.fillStyle = css;
      return String(ctx.fillStyle);
    };
    const fromBlack = read("#000000");
    const fromWhite = read("#ffffff");
    return fromBlack === fromWhite ? fromBlack : null;
  };
}

// src/content/engine/a11y.ts
var normalise = canvasNormaliser();

// src/content/page-state.ts
var MOVE_THRESHOLD = 2;
function diffStates(before, after) {
  const bySelector = new Map(before.nodes.map((n) => [n.selector, n]));
  const byName = new Map(before.nodes.filter((n) => n.name).map((n) => [`${n.role}|${n.name}`, n]));
  const usedBefore = /* @__PURE__ */ new Set();
  const changed = [];
  const appeared = [];
  let unchanged = 0;
  for (const now of after.nodes) {
    const was = bySelector.get(now.selector) ?? (now.name ? byName.get(`${now.role}|${now.name}`) : void 0);
    if (!was) {
      appeared.push({ what: now.name || now.role, selector: now.selector });
      continue;
    }
    usedBefore.add(was);
    const diffs = [];
    const dx = now.box.x - was.box.x;
    const dy = now.box.y - was.box.y;
    if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
      diffs.push(`moved ${dx ? `${dx > 0 ? dx + "px right" : -dx + "px left"}` : ""}${dx && dy ? " and " : ""}${dy ? `${dy > 0 ? dy + "px down" : -dy + "px up"}` : ""}`);
    }
    if (Math.abs(now.box.w - was.box.w) > MOVE_THRESHOLD) diffs.push(`width ${was.box.w} \u2192 ${now.box.w}`);
    if (Math.abs(now.box.h - was.box.h) > MOVE_THRESHOLD) diffs.push(`height ${was.box.h} \u2192 ${now.box.h}`);
    if (now.state !== was.state) diffs.push(`state "${was.state || "none"}" \u2192 "${now.state || "none"}"`);
    for (const [k, v] of Object.entries(now.styles)) {
      if (was.styles[k] !== void 0 && was.styles[k] !== v) diffs.push(`${k} ${was.styles[k]} \u2192 ${v}`);
    }
    if (diffs.length) changed.push({ what: now.name || now.role, selector: now.selector, changes: diffs });
    else unchanged++;
  }
  const disappeared = before.nodes.filter((n) => !usedBefore.has(n)).map((n) => ({ what: n.name || n.role, selector: n.selector }));
  const matched = after.nodes.length - appeared.length;
  const unmatched = after.nodes.length > 10 && matched < after.nodes.length * 0.4 ? `only ${matched} of ${after.nodes.length} controls could be matched between the two states \u2014 the page is probably re-rendered from scratch (a virtualised list, new React keys). Read the list below as \xABwhat is there now\xBB, not as \xABwhat changed\xBB.` : void 0;
  return {
    ok: true,
    appeared,
    disappeared,
    changed,
    unchanged,
    ...unmatched ? { unmatched } : {},
    note: "Text content is deliberately NOT compared: a name, a total or a timestamp differs between two healthy runs, and reporting those is the noise that gets visual diffing switched off. Movements under 2px are the browser rounding a layout, not a change."
  };
}
export {
  diffStates
};
