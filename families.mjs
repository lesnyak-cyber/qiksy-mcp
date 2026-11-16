/**
 * THE ODD ONE OUT — an element judged against its own twins, and nothing else.
 *
 * This is the half of the tuning fork that needs NO mockup, no Figma, no setup and no alignment.
 * The question it answers is not «does this match the design» but «is one of these thirty not like
 * the other twenty-nine», and that question has an answer the page itself supplies.
 *
 * WHY IT CANNOT BREAK THE WAY THE WIDTH LAW DID. On 01.10.2026 the width law printed a confident
 * lie because a computed style hands back RESOLVED values: `width: auto` on <body> arrives as
 * «1501px», which is a measurement wearing a declaration's clothes. That whole class of error is
 * impossible here, because nothing is compared across windows or against a mockup — thirty
 * siblings are read in ONE instant under ONE set of conditions, so they are all resolved the same
 * way and the comparison between them stays true whatever the window is doing.
 *
 * THE THREE SILENCERS, and each exists because without it the instrument produces findings on a
 * healthy page, which is how a checker teaches its reader to ignore it:
 *   1. A CROWD OF FEWER THAN THREE IS NOT JUDGED. Two things that differ are not a majority and a
 *      deviant, they are two things.
 *   2. NO DOMINANT VALUE MEANS NO FAMILY. If the values are spread, this is not thirty twins with
 *      one defect, it is thirty different elements, and saying anything about them is noise.
 *   3. TOO MANY OUTLIERS IS A VARIANT, NOT A DEFECT. Five of thirty sharing a second value is a
 *      deliberate second kind, and calling it a bug is how a report loses its reader.
 */

/** A browser rounds and a designer does not: one pixel is never a finding. */
export const SLACK = 1;

/**
 * THE FAMILY KEY. `qa_collect` returns a cssPath per node, and siblings of one kind differ only by
 * their `:nth-of-type(N)` — so stripping that index turns the path into the name of the family.
 * Measured on a real page: `#content > div > section.sh-card:nth-of-type(1|2|3)` collapses to one
 * key, which is exactly the grouping a person would make by eye.
 */
export function familyKey(selector) {
  const s = String(selector || '');
  if (!s) return null;
  return s.replace(/:nth-(of-type|child)\(\d+\)/g, '').trim() || null;
}

/** Numbers out of computed styles. `px` only: a value in any other form is not comparable here. */
export function px(raw) {
  const m = /^(-?[\d.]+)px$/.exec(String(raw ?? '').trim());
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * THE JUDGE. Given one property's value across a family, decide whether anything is ODD — and,
 * far more often, decide to say nothing. Returning «not judged» with a reason is the normal
 * outcome, and it is what keeps the report readable.
 */
export function oddOneOut(entries, { tolerance = SLACK, minCrowd = 3, maxOutliers = 2, dominance = 0.7 } = {}) {
  const vals = (entries || []).filter((e) => e && e.value !== null && e.value !== undefined);
  if (vals.length < minCrowd) {
    return { judged: false, why: `crowd of ${vals.length}: fewer than ${minCrowd} is not a majority and a deviant, it is just a few things` };
  }

  /* Cluster by nearness for numbers, by equality for everything else. The biggest cluster is the
     norm — not the average, because an average is dragged by the very outlier we are looking for. */
  const numeric = typeof vals[0].value === 'number';
  const clusters = [];
  for (const e of vals) {
    const hit = clusters.find((c) => (numeric ? Math.abs(c.value - e.value) <= tolerance : c.value === e.value));
    if (hit) hit.members.push(e);
    else clusters.push({ value: e.value, members: [e] });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);

  const norm = clusters[0];
  const share = norm.members.length / vals.length;
  if (share < dominance) {
    return { judged: false, why: `no dominant value (${norm.members.length} of ${vals.length} agree): these are different elements, not twins with a defect` };
  }

  const odd = clusters.slice(1).flatMap((c) => c.members);
  if (odd.length > maxOutliers) {
    return { judged: false, why: `${odd.length} differ: that is a second deliberate variant, not one element gone wrong` };
  }
  if (!odd.length) return { judged: true, norm: norm.value, of: vals.length, odd: [] };

  return {
    judged: true,
    norm: norm.value,
    of: vals.length,
    odd: odd.map((e) => ({ who: e.who, value: e.value })),
  };
}

/**
 * WHICH PROPERTIES ARE WORTH JUDGING, and the two that are deliberately absent.
 *
 * `margin-top` / `margin-bottom` are NOT here: the first and last member of a list legitimately
 * carry a different one (a collapsed first margin, a trimmed last), so judging them produces a
 * finding on a perfectly healthy list. The SPACE between members is the same information without
 * that trap, and it is measured from geometry below.
 *
 * `width` and `height` are not here either: content drives them, so a family of rows with
 * different text would light up every time. The dominance silencer would mostly catch it, but a
 * property that relies on a silencer to stay quiet does not belong on the list.
 */
export const NUMERIC_PROPS = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-radius', 'font-size', 'line-height', 'border-top-width',
];
export const EXACT_PROPS = ['color', 'background-color', 'font-weight', 'font-family', 'border-style'];

const styleOf = (row, name) => {
  const st = row?.style || {};
  return st[name] ?? st[`style:${name}`] ?? st[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
};

/**
 * THE FOURTH SILENCER, AND THE LIVE PAGE IS WHAT ASKED FOR IT.
 *
 * Run against the real tab bar of Qiksy Shelf (01.10.2026), this verb reported the SELECTED tab as
 * a defect — twice, for its colour and its background — on a page where nothing is wrong. Every
 * tab bar, accordion, segmented control and selected table row on the web would have produced the
 * same, which is precisely how a checker gets switched off and takes the true findings with it.
 *
 * So: an element in a DIFFERENT STATE is not comparable with its siblings on appearance, and the
 * instrument says which attribute told it so rather than silently dropping the finding. The signal
 * is read, never guessed — ARIA state attributes, the form state the bridge already reports, and
 * class names from a NAMED list of state words. An arbitrary modifier class (`card-wide`,
 * `col-3`) is deliberately NOT a state: silencing on any class difference at all would silence
 * almost everything.
 */
/**
 * Два семейства признаков, и второе добавлено живой страницей.
 *
 * ARIA говорит о состоянии вслух, и наш Shelf помечает выбранную вкладку `aria-current="page"`.
 * Но целый пласт современного веба — shadcn/ui и всё, что построено на Radix — метит состояние
 * атрибутами `data-*`, потому что по ним же и стилизует (`data-[active=true]:bg-...`). Настоящая
 * страница проекта IUCN (01.10.2026) помечает активный пункт меню `data-active="true"`, а
 * остальные шесть `data-active="false"`: признак был, просто в этом списке его не было, и прибор
 * выдал три находки на исправном меню.
 *
 * `false` не считается состоянием, и это важно: шесть пунктов с `data-active="false"` обязаны
 * остаться одной толпой, иначе семья распадётся и судить станет нечего.
 */
const STATE_ATTRS = [
  'aria-current', 'aria-selected', 'aria-pressed', 'aria-expanded', 'aria-checked', 'aria-disabled', 'disabled',
  'data-state', 'data-active', 'data-selected', 'data-current', 'data-open', 'data-checked', 'data-disabled', 'data-highlighted',
];
const STATE_WORDS = /(^|[-_])(is|has)([-_]|$)|active|selected|current|checked|open(ed)?|expanded|disabled|focus|error|invalid|danger|warning|success|highlight|pending|loading|done/i;

export function stateOf(row) {
  const bag = [];
  for (const a of STATE_ATTRS) {
    const v = row?.[`attr:${a}`] ?? row?.attrs?.[a] ?? row?.style?.[`attr:${a}`];
    if (v !== undefined && v !== null && String(v) !== 'false') bag.push(`${a}=${v}`);
  }
  if (Array.isArray(row?.state)) bag.push(...row.state.map((s) => `state:${s}`));
  else if (typeof row?.state === 'string' && row.state) bag.push(`state:${row.state}`);

  const cls = String(row?.['attr:class'] ?? row?.attrs?.class ?? '').trim();
  for (const c of cls.split(/\s+/).filter(Boolean)) if (STATE_WORDS.test(c)) bag.push(`class:${c}`);

  return bag.sort().join(' ');
}
const geom = (row) => {
  const g = row?.geometry || {};
  const x = Number(g.x), y = Number(g.y);
  const w = Number(g.width ?? g.w), h = Number(g.height ?? g.h);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
};

/**
 * THE SPACE BETWEEN MEMBERS, which is the finding people actually describe: «one gap of 14 among
 * twenty-nine 16s». Orientation is read off the boxes rather than assumed — a row and a column are
 * the same family with the axes swapped, and guessing wrong turns every gap into nonsense.
 */
export function gapsOf(members) {
  const boxes = members.map((m) => ({ who: m.selector, b: geom(m) })).filter((m) => m.b);
  if (boxes.length < 2) return { axis: null, gaps: [] };

  const sameRow = boxes.every((m) => Math.abs(m.b.y - boxes[0].b.y) <= SLACK);
  const axis = sameRow ? 'horizontal' : 'vertical';
  const sorted = boxes.slice().sort((a, b) => (axis === 'horizontal' ? a.b.x - b.b.x : a.b.y - b.b.y));

  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].b, cur = sorted[i].b;
    const g = axis === 'horizontal' ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h);
    /* A negative gap means the two overlap, which is a different defect and not this one's to
       report: an overlap is visible, a 2px gap difference is not. */
    if (g >= 0) gaps.push({ who: `${sorted[i - 1].who} → ${sorted[i].who}`, value: Math.round(g) });
  }
  return { axis, gaps };
}

/** Group the rows into families by their path, keeping the ones big enough to have a majority. */
export function families(rows, { minSize = 3 } = {}) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = familyKey(r?.selector);
    if (!key) continue;
    /* A node with no index in its path is an only child: it has no twins and no family. */
    if (!/:nth-(of-type|child)\(/.test(String(r.selector))) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return [...byKey.entries()]
    .filter(([, members]) => members.length >= minSize)
    .map(([key, members]) => ({ key, members }))
    .sort((a, b) => b.members.length - a.members.length);
}

/**
 * THE WHOLE VERB. Findings first, then — always — what was NOT looked at, because a clean page and
 * an unexamined one are indistinguishable without it.
 */
export function oddOnes(rows, opts = {}) {
  const fams = families(rows, opts);
  const findings = [];
  const quiet = [];

  for (const fam of fams) {
    /* The crowd's state, taken as the majority's: that is what «the same state» means here. */
    const stateCount = new Map();
    for (const m of fam.members) {
      const s = stateOf(m);
      stateCount.set(s, (stateCount.get(s) || 0) + 1);
    }
    const normalState = [...stateCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const stateByWho = new Map(fam.members.map((m) => [m.selector, stateOf(m)]));

    const say = (what, verdict, unit) => {
      if (!verdict.judged) { quiet.push({ family: fam.key, what, why: verdict.why }); return; }
      if (!verdict.odd.length) return;

      /* An element the page itself marks as being in another state is not comparable on looks.
         Name the attribute that explains it — a silenced finding the reader cannot check is just
         a missing finding. */
      const explained = verdict.odd.filter((o) => (stateByWho.get(o.who) ?? '') !== normalState);
      const real = verdict.odd.filter((o) => (stateByWho.get(o.who) ?? '') === normalState);
      for (const o of explained) {
        quiet.push({
          family: fam.key,
          what,
          why: `${o.who} differs (${unit ? `${o.value}${unit}` : o.value} against ${unit ? `${verdict.norm}${unit}` : verdict.norm}), but the page marks it as being in another state (${stateByWho.get(o.who) || 'no state read'}), and an element in another state is not comparable with its siblings on appearance`,
        });
      }
      if (!real.length) return;

      findings.push({
        family: fam.key,
        size: fam.members.length,
        what,
        normal: unit ? `${verdict.norm}${unit}` : verdict.norm,
        agreeing: verdict.of - verdict.odd.length,
        odd: real.map((o) => ({ who: o.who, is: unit ? `${o.value}${unit}` : o.value })),
      });
    };

    for (const prop of NUMERIC_PROPS) {
      say(prop, oddOneOut(fam.members.map((m) => ({ who: m.selector, value: px(styleOf(m, prop)) })), opts), 'px');
    }
    for (const prop of EXACT_PROPS) {
      say(prop, oddOneOut(fam.members.map((m) => ({ who: m.selector, value: styleOf(m, prop) ?? null })), { ...opts, tolerance: 0 }));
    }
    const { axis, gaps } = gapsOf(fam.members);
    if (gaps.length) say(`gap between members (${axis})`, oddOneOut(gaps.map((g) => ({ who: g.who, value: g.value })), opts), 'px');
  }

  return {
    ok: true,
    familiesSeen: fams.length,
    largest: fams[0] ? { family: fams[0].key, size: fams[0].members.length } : null,
    findings,
    notJudged: quiet,
    note:
      'Each element is compared ONLY with its own siblings, read in one instant, so nothing here depends on the window, the mockup or an alignment. ' +
      'Read `notJudged` as well as `findings`: a family that was silenced is not a family that passed.',
  };
}
