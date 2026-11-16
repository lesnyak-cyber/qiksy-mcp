/**
 * WHERE A REPORT GOES WHEN NOBODY SAID.
 *
 * Owner, 28.09.2026: «чтобы Bridge понимал, в контексте какого это проекта, и в этой папке
 * создавал» — reports that pile up in the browser's download folder belong to nobody, and a week
 * later nothing says which of them was about which product.
 *
 * The bridge already knew the answer and was not using it: this process is started BY the agent,
 * FROM the folder the person is working in, and the docs installer already tests that folder for
 * the marks of a project before writing its guide into it. The same test decides here.
 *
 * WHY NOT ~/.qiksy, WHERE THE RECIPES LIVE. A recipe is a tool — the same login flow serves every
 * project, so it is filed by project INSIDE our folder. A report is the work itself: it is
 * attached to a ticket, read by a client, and it belongs with the code it is about. Somebody who
 * has never heard of this tool should find it by opening the project.
 *
 * Kept out of server.mjs so it can be held to account without a browser, a socket or a port —
 * every decision here is a string and a file test, which is exactly the kind of thing that breaks
 * quietly and is never noticed until somebody goes looking for a report that was never written.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The marks that make a folder somebody's project rather than somebody's home directory. */
export const PROJECT_MARKS = ['.git', 'package.json', 'CLAUDE.md', 'AGENTS.md'];

/**
 * The folder the agent was started in, if it looks like a project.
 *
 * Deliberately NOT a walk up the tree: the agent is started in the folder the person is working
 * in, and climbing from a subdirectory would file a report about one package into the root of a
 * monorepo — quietly, and in the one place nobody would look for it. `home` is refused for the
 * same reason a stray `rm` refuses it: a home directory is not a project, and writing into it is
 * never what somebody meant.
 */
export function projectRoot({ cwd, home = homedir(), exists = existsSync } = {}) {
  if (!cwd) return null;
  const dir = resolve(cwd);
  if (dir === resolve(home) || dirname(dir) === dir) return null;
  return PROJECT_MARKS.some((m) => exists(join(dir, m))) ? dir : null;
}

/**
 * Where reports go when the caller names no path: the project's own folder, an explicit override,
 * or nowhere at all.
 *
 * `off` exists because writing a file is an act on somebody's disk, and a person who wants to be
 * asked every time must have a way to say so that does not involve remembering an argument.
 */
export function reportsDir({ cwd, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const set = env.QIKSY_REPORTS_DIR;
  if (set === 'off') return null;
  if (set) return resolve(set);
  const root = projectRoot({ cwd, home, exists });
  return root ? join(root, 'qiksy-reports') : null;
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * `2026-09-28-the-form-swallows-the-error.html` — sortable first, readable second.
 *
 * The subject comes from the document's own first block, because that is what the person called
 * the thing; a name built from the host or the tool would file twenty reports about twenty
 * different problems under one name and let the newest quietly replace the rest.
 */
export function reportFileName(blocks, kind, { now = new Date() } = {}) {
  const first = (Array.isArray(blocks) ? blocks : []).find((b) => b && (b.title || b.text));
  const subject = slug(first?.title || first?.text) || slug(kind) || 'report';
  const day = now.toISOString().slice(0, 10);
  return `${day}-${subject}.html`;
}
