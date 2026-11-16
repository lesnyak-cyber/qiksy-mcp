/**
 * WHICH AGENT SESSION A PROCESS BELONGS TO — so «finished» is answered per session, not per machine.
 *
 * The finish sound used to be decided by ONE flag in the browser: «did anything happen through
 * the bridge since the last full stop». The Stop hook lives in the PROJECT's settings, so every
 * Claude session in that project runs it at the end of every turn — and the owner keeps several
 * open at once. Session A drives the browser; session B, which never touched it, ends a turn; B's
 * hook consumes A's flag and the sound plays in the middle of A's run. When A really finishes the
 * flag is already spent and nothing plays. «It works, but not when the task is done» (owner,
 * 26.10.2026) was exactly that, and it looked random because it depended on which session spoke
 * first.
 *
 * The fix needs a name for «the session», and the process tree already has one. Claude Code runs
 * one `claude` process per session; it spawns the MCP server (through `npm exec` and `node`) AND
 * the Stop hook (through a shell and `npx`). Walk up past those wrappers and both arrive at the
 * same pid. Other clients have their own process in the same place, so the rule is general:
 * the first ancestor that is not a wrapper.
 *
 * Null when the tree cannot be read (Windows, a sandbox without `ps`): the caller then keeps the
 * old machine-wide behaviour rather than guessing.
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/** Processes that only carry the real one: launchers, shells, the runtime itself. */
const WRAPPERS = new Set(['node', 'npm', 'npx', 'npm exec', 'sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'login', 'tsx', 'bun', 'deno']);

/** `pid → {ppid, name}` through `ps`; null when it cannot be asked. */
function readProc(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.trim().match(/^(\d+)\s+(.+)$/);
  /* The FIRST word, then its basename: npm rewrites its own title, so `comm` reads
     «npm exec qiksy-mcp --port 7333» rather than a path, and only «npm» names what it is. */
  return m ? { ppid: Number(m[1]), name: basename(m[2].trim().split(/\s+/)[0]) } : null;
}

/**
 * The session key: the pid of the first non-wrapper ancestor, as a string.
 * `read` is injectable so the walk can be judged without a process tree.
 */
export function agentSession(startPid = process.ppid, read = readProc) {
  if (process.platform === 'win32' && read === readProc) return null;
  let pid = startPid;
  for (let hops = 0; hops < 12 && pid > 1; hops++) {
    const p = read(pid);
    if (!p) return null;
    if (!WRAPPERS.has(p.name.toLowerCase())) return String(pid);
    pid = p.ppid;
  }
  return null;
}
