/**
 * ORDERING THE FIELDS OF A REPLY — the cheapest kind of flexibility there is.
 *
 * Owner, 16.09.2026: «стоит ли делать мост гибким, чтобы Клод мог структурно его переделывать?»
 * The answer this file implements is the half of that question which costs nothing and risks
 * nothing. Almost every «the bridge cannot do this» turns out to be «the verb did not hand back
 * something it had already measured», or the opposite — it handed back a whole page when three
 * fields were wanted and the caller paid for the rest in context.
 *
 * So a reply can be ASKED FOR: `select` keeps only these paths, `omit` drops these. No new verb,
 * no new capability, nothing executed — the caller names fields, exactly as every other verb here
 * names an element rather than a program.
 *
 * WHY THIS IS NOT «FLEXIBILITY» IN THE DANGEROUS SENSE. A path is a closed, enumerable thing:
 * letters, digits, dots, `[]`. It cannot compute, branch or loop, so shipping it is not shipping
 * an interpreter for somebody else's code — the line the Web Store draws, and the line this
 * product's whole design follows.
 */

/** A path is `a.b.c`; `[]` maps over an array: `fields[].name` takes `name` from every entry. */
const STEP = /^[A-Za-z0-9_$-]+(\[\])?$/;

export function validPath(path) {
  if (typeof path !== 'string' || !path.length || path.length > 200) return false;
  return path.split('.').every((s) => STEP.test(s));
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * THE PROJECTION KEEPS THE SHAPE IT PROJECTS.
 *
 * The first cut read each path separately and wrote it into a fresh object, which turned
 * `fields[].name` into `{ fields: { name: [...] } }` — an answer in a shape the original never
 * had, so anything the caller knew about the reply stopped being true. Paths are folded into one
 * tree instead and the tree is walked over the value: a list stays a list of the same length, an
 * object keeps its keys, and only the unasked-for fields go.
 */
const LEAF = Symbol('leaf');

function buildTree(paths) {
  const root = {};
  for (const path of paths) {
    let node = root;
    const steps = path.split('.');
    steps.forEach((step, i) => {
      const key = step.endsWith('[]') ? step.slice(0, -2) : step;
      const last = i === steps.length - 1;
      if (last) node[key] = LEAF;
      else {
        if (node[key] === LEAF || node[key] === undefined) node[key] = {};
        node = node[key];
      }
    });
  }
  return root;
}

/** Walk a value through the tree. Returns `undefined` when nothing on this branch was there. */
function applyTree(value, node, hit) {
  if (node === LEAF) {
    if (value !== undefined) hit.any = true;
    return value;
  }
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    /* A list stays a list — and an entry that held none of the asked-for fields is dropped rather
       than left as an empty object, so `fields[].name` over a mixed list answers with the ones
       that have a name and not with a row of blanks. */
    const out = value.map((v) => applyTree(v, node, hit)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (!isPlain(value)) return undefined;
  const out = {};
  let got = false;
  for (const [key, child] of Object.entries(node)) {
    const sub = applyTree(value[key], child, hit);
    if (sub !== undefined) {
      out[key] = sub;
      got = true;
    }
  }
  return got ? out : undefined;
}

/**
 * Keep only the named paths. A path that matches nothing is REPORTED rather than dropped in
 * silence: an agent that mistyped a field name and got `{}` back learns nothing, and the next
 * thing it does is call again with a bigger request.
 */
export function pickPaths(value, paths) {
  const bad = paths.filter((p) => !validPath(p));
  if (bad.length) return { ok: false, error: `not a field path: ${bad.slice(0, 4).join(', ')}` };
  if (value == null || typeof value !== 'object') return { ok: true, value, missed: [] };
  /* Each path is tried on its own FIRST, only to find out which ones matched nothing; the answer
     itself is then built in one walk so its shape survives. */
  const missed = [];
  for (const path of paths) {
    const hit = { any: false };
    applyTree(value, buildTree([path]), hit);
    if (!hit.any) missed.push(path);
  }
  const out = applyTree(value, buildTree(paths), { any: false });
  return { ok: true, value: out === undefined ? {} : out, missed };
}

/** Drop the named paths, keeping everything else. */
export function omitPaths(value, paths) {
  const bad = paths.filter((p) => !validPath(p));
  if (bad.length) return { ok: false, error: `not a field path: ${bad.slice(0, 4).join(', ')}` };
  const strip = (v, steps) => {
    if (Array.isArray(v)) return v.map((x) => strip(x, steps));
    if (!isPlain(v)) return v;
    const [head, ...rest] = steps;
    const key = head.endsWith('[]') ? head.slice(0, -2) : head;
    if (!(key in v)) return v;
    const copy = { ...v };
    if (!rest.length) delete copy[key];
    else copy[key] = strip(copy[key], rest);
    return copy;
  };
  let out = value;
  for (const path of paths) out = strip(out, path.split('.'));
  return { ok: true, value: out };
}

/**
 * The one entry point the verbs use. Returns the reply as asked for, plus a `projected` line
 * saying what was done — a reply that has been trimmed and does not say so is a reply nobody can
 * reason about later, and this project has paid for that mistake in other places already.
 */
export function project(value, { select, omit } = {}) {
  const sel = Array.isArray(select) ? select.filter(Boolean).map(String) : null;
  const omt = Array.isArray(omit) ? omit.filter(Boolean).map(String) : null;
  if (!sel?.length && !omt?.length) return value;
  if (value == null || typeof value !== 'object') return value;

  let out = value;
  const note = {};
  if (omt?.length) {
    const r = omitPaths(out, omt);
    if (!r.ok) return { ...value, projectionError: r.error };
    out = r.value;
    note.omitted = omt;
  }
  if (sel?.length) {
    const r = pickPaths(out, sel);
    if (!r.ok) return { ...value, projectionError: r.error };
    out = r.value;
    note.selected = sel;
    if (r.missed.length) {
      note.notThere = r.missed;
      /* The fields that ARE there, so a mistyped name is one call from being right. */
      note.available = Object.keys(isPlain(value) ? value : {}).slice(0, 30);
    }
  }
  return { ...out, projected: note };
}
