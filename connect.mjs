/**
 * `npx qiksy-mcp connect` — THE SIX STEPS BECOME ONE.
 *
 * Owner, 20.09.2026: «QA ленивые, технически многие вообще не шарят — как к блютузу бы».
 * Measured against the old path, a person had to: switch the bridge on, accept, press Generate,
 * press Copy, FIND their agent's config file, paste JSON into it without breaking the JSON, and
 * restart the agent. Two of those steps are ours and five are theirs — and the file one is where
 * they stop, because «~/.cursor/mcp.json» means nothing to somebody who tests web shops for a
 * living.
 *
 * This process is the one thing that already lives on their machine AND is allowed to write
 * files, so it does the whole middle: picks a free port, mints the token, finds every agent that
 * is actually installed, writes the entry into each config it found, and leaves the token on the
 * clipboard so the popup is one ⌘V away. The extension cannot do any of that — no filesystem, no
 * processes — which is why this belongs here and not in the popup.
 *
 * Three rules it does not break:
 *   · nothing is invented. A config is written ONLY where that client's own folder already
 *     exists, so nobody ends up with a Windsurf config for an editor they never installed.
 *   · nothing of theirs is lost. The file is read, our one entry is set, everything else is
 *     written back untouched — and a run on a file we cannot parse stops rather than overwrites.
 *   · the pairing survives. A second run keeps the token that is already in their config, or the
 *     browser they already paired would be locked out by a fresh secret.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * WHERE EACH AGENT KEEPS ITS SERVER LIST.
 *
 * `home` and `platform` are arguments rather than reads so a test can ask for the Windows answer
 * on a Mac — the paths are the part that goes wrong silently, and they are unreachable otherwise.
 *
 * `key` differs by client and is NOT cosmetic: VS Code reads `servers`, everyone else reads
 * `mcpServers`, and a file written with the wrong key is valid JSON that the agent ignores — the
 * worst possible failure, because it looks installed.
 *
 * `needs` is the folder whose existence means the client is installed. Missing → skipped, which
 * is how «wrote 4 configs» stops being a lie on a machine with one editor.
 */
export function agentTargets({ home = homedir(), platform = osPlatform(), dir = process.cwd() } = {}) {
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const claudeDesktop =
    platform === 'win32'
      ? join(appData, 'Claude', 'claude_desktop_config.json')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return [
    /* Claude Code reads a project-scoped .mcp.json — the file belongs to the repo the person is
       standing in, which is also the repo their agent is working on. */
    { id: 'claude-code', label: 'Claude Code', file: join(dir, '.mcp.json'), key: 'mcpServers', needs: dir, scope: 'project' },
    { id: 'cursor', label: 'Cursor', file: join(home, '.cursor', 'mcp.json'), key: 'mcpServers', needs: join(home, '.cursor'), scope: 'user' },
    { id: 'vscode', label: 'VS Code', file: join(dir, '.vscode', 'mcp.json'), key: 'servers', needs: join(dir, '.vscode'), scope: 'project' },
    { id: 'windsurf', label: 'Windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers', needs: join(home, '.codeium', 'windsurf'), scope: 'user' },
    { id: 'claude-desktop', label: 'Claude Desktop', file: claudeDesktop, key: 'mcpServers', needs: join(claudeDesktop, '..'), scope: 'user' },
  ];
}

/**
 * THE ENTRY ITSELF — and on Windows it is not the obvious one.
 *
 * `command: "npx"` is what every example shows and what fails on Windows for a good half of the
 * clients: `npx` there is `npx.cmd`, and a spawn without a shell does not find it. The result is
 * an agent that reports the server as failed to start with no explanation a tester can act on.
 * So Windows gets the `cmd /c` form, which works in both the clients that need it and those that
 * would have coped anyway.
 */
export function serverEntry({ port, token, platform = osPlatform() }) {
  /* `-y` IS NOT A CONVENIENCE — IT IS WHAT STOPS THE START HANGING.
   *
   * Without it, an npx that does not already hold the package ASKS: «Need to install the following
   * packages… Ok to proceed?» — and it asks on stdin, which in an MCP server IS the protocol. The
   * client's `initialize` frame becomes the answer to a yes/no question, nothing replies, and the
   * agent reports `MCP server qiksy connection timed out after 30000ms` with no server-side trace
   * at all, because the server never ran. It bites hardest right after a release, when the cached
   * version is no longer the latest one — which is exactly when it was reported (21.09.2026). */
  const base = platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', '-y', 'qiksy-mcp', '--port', String(port)] }
    : { command: 'npx', args: ['-y', 'qiksy-mcp', '--port', String(port)] };
  return { ...base, env: { QIKSY_MCP_TOKEN: token } };
}

/** Read a config we are about to edit. Unreadable JSON is an error, never something to overwrite. */
export function readConfig(file) {
  if (!existsSync(file)) return { json: {}, existed: false };
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return { json: {}, existed: true };
  try {
    return { json: JSON.parse(raw), existed: true };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}) — fix or move it, I will not overwrite it`);
  }
}

/** The token already wired into one of their configs, if any: a second run must not break the pair. */
export function tokenInPlace(targets) {
  for (const t of targets) {
    try {
      if (!existsSync(t.file)) continue;
      const { json } = readConfig(t.file);
      const tok = json?.[t.key]?.qiksy?.env?.QIKSY_MCP_TOKEN;
      if (typeof tok === 'string' && tok.length >= 16) return tok;
    } catch {
      /* a broken file is reported later by the write; it must not stop the search */
    }
  }
  return '';
}

/** The port already wired in, for the same reason: re-running must not move the browser's target. */
export function portInPlace(targets) {
  for (const t of targets) {
    try {
      if (!existsSync(t.file)) continue;
      const { json } = readConfig(t.file);
      const args = json?.[t.key]?.qiksy?.args;
      const i = Array.isArray(args) ? args.indexOf('--port') : -1;
      const p = i !== -1 ? Number(args[i + 1]) : NaN;
      if (Number.isInteger(p) && p > 0) return p;
    } catch {
      /* same */
    }
  }
  return 0;
}

/**
 * THE PAIRING, FOR A COMMAND THAT HAS NO ENVIRONMENT — i.e. the finish hook.
 *
 * The server proper is started BY the agent, which hands it the token in the entry's `env` block.
 * A Stop hook is not started that way: it is a bare command in a bare shell, so QIKSY_MCP_TOKEN is
 * empty, the hub closes the unauthenticated join — correctly — and the hook then fails in the one
 * way nobody notices: silently, once per run, into a log no one reads. Measured on a real setup
 * (21.09.2026): `npx qiksy-mcp done` answered «the bridge closed the connection» and the browser
 * never heard a thing, while the same command with the token in front of it rang through.
 *
 * So the hook reads the same pairing the agent itself uses. `~/.claude.json` is in the search
 * because that is where `claude mcp add` puts an entry — top level, or under projects/<cwd> — and
 * it is READ ONLY here: connect writes `.mcp.json` instead, and a command that fires on every stop
 * must never rewrite the file that holds every project's servers.
 */
export function pairingInPlace({ dir = process.cwd(), home = homedir(), platform = osPlatform() } = {}) {
  const targets = agentTargets({ dir, home, platform });
  const found = { token: tokenInPlace(targets), port: portInPlace(targets) };
  if (found.token && found.port) return found;

  for (const entry of claudeJsonEntries(join(home, '.claude.json'), dir)) {
    const tok = entry?.env?.QIKSY_MCP_TOKEN;
    if (!found.token && typeof tok === 'string' && tok.length >= 16) found.token = tok;
    if (!found.port) {
      const args = Array.isArray(entry?.args) ? entry.args : [];
      const i = args.indexOf('--port');
      const p = i !== -1 ? Number(args[i + 1]) : NaN;
      if (Number.isInteger(p) && p > 0) found.port = p;
    }
    if (found.token && found.port) break;
  }
  return found;
}

/**
 * Every qiksy entry in `~/.claude.json`, THE ONE FOR THIS FOLDER FIRST.
 *
 * Order is the whole point: the token is the same everywhere (the popup has one field), but the
 * PORT is per project, and a hook that picks a neighbouring project's port rings a bridge that
 * belongs to somebody else's run. Deepest matching project path wins, then the global entry, then
 * whatever else is there — the last one so a folder that was never connected still finds the
 * pairing instead of going silent.
 */
function claudeJsonEntries(file, dir) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return []; // missing or hand-broken: not our file to fix, and not a reason to fail
  }
  const projects = json?.projects && typeof json.projects === 'object' ? json.projects : {};
  const mine = Object.keys(projects)
    .filter((p) => dir === p || dir.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length);
  const rest = Object.keys(projects).filter((p) => !mine.includes(p));
  const out = [];
  for (const p of mine) if (projects[p]?.mcpServers?.qiksy) out.push(projects[p].mcpServers.qiksy);
  if (json?.mcpServers?.qiksy) out.push(json.mcpServers.qiksy);
  for (const p of rest) if (projects[p]?.mcpServers?.qiksy) out.push(projects[p].mcpServers.qiksy);
  return out;
}

/** Write our one entry, keep everything else in the file exactly as it was. */
export function writeEntry(target, entry) {
  const { json, existed } = readConfig(target.file);
  const next = { ...json, [target.key]: { ...(json[target.key] || {}), qiksy: entry } };
  mkdirSync(join(target.file, '..'), { recursive: true });
  writeFileSync(target.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return existed ? 'updated' : 'created';
}

/**
 * THE EXACT FINISH SIGNAL, for the one client that can give it.
 *
 * `qa_done` makes the tab pulse and the sound play, and the agent is asked to call it. The server
 * also says it by itself after a long enough silence — but silence is an estimate, and Claude Code
 * knows the real thing: it fires a `Stop` hook the moment the agent actually stops. One line in
 * the project's settings turns the estimate into a fact.
 *
 * THREE RULES, and they are what makes writing into somebody's settings acceptable at all:
 *   · everything already in the file survives, including other Stop hooks;
 *   · running it twice adds nothing — the same command is recognised and left alone;
 *   · it is reported out loud by the caller, because a command that will run on every stop is not
 *     something to install quietly.
 */
export const STOP_COMMAND = 'npx qiksy-mcp done';

export function stopHookFile(dir) {
  return join(dir, '.claude', 'settings.json');
}

export function writeStopHook(file, command = STOP_COMMAND) {
  const { json, existed } = readConfig(file);
  const hooks = { ...(json.hooks || {}) };
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  /* Already there — from a previous run, or written by hand. Adding a second copy would make the
     browser say «done» twice for one stop. */
  const has = stop.some((g) =>
    Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('qiksy-mcp done')),
  );
  if (has) return 'already there';
  stop.push({ hooks: [{ type: 'command', command }] });
  hooks.Stop = stop;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...json, hooks }, null, 2)}\n`, 'utf8');
  return existed ? 'updated' : 'created';
}

/** A port nothing is listening on, starting where the docs say and walking up a short way. */
export async function freePort(from = 7333, tries = 12) {
  for (let p = from; p < from + tries; p++) {
    const ok = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  return from;
}

/**
 * THE TOKEN GOES TO THE CLIPBOARD, because the last step is a paste into the popup.
 * Best effort by design: a headless Linux box has no clipboard, and that is not a failure of the
 * setup — the token is printed as well, and the report says which of the two happened.
 */
export function toClipboard(text, platform = osPlatform()) {
  const runners = platform === 'darwin'
    ? [['pbcopy', []]]
    : platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of runners) {
    try {
      const r = spawnSync(cmd, args, { input: text, shell: platform === 'win32' });
      if (!r.error && r.status === 0) return cmd;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

export const mintToken = () => randomBytes(18).toString('base64url');

/**
 * Do the whole thing and report what happened. No printing here — the caller owns the voice, and
 * a function that both decides and narrates cannot be tested without reading its output.
 */
export async function connectAgents({ dir = process.cwd(), home = homedir(), platform = osPlatform(), port, token, hook = true } = {}) {
  const targets = agentTargets({ home, platform, dir });
  const installed = targets.filter((t) => existsSync(t.needs));
  /* THE SEARCH FOR AN EXISTING PAIRING IS WIDER THAN THE LIST WE WRITE INTO, and that is the whole
     point of it. `claude mcp add` puts the entry in ~/.claude.json, which is not a file connect
     writes; looking only at its own targets, a re-run found nothing, minted a FRESH token and wrote
     it everywhere — leaving the browser paired with a secret nobody holds any more. It costs the
     person a «Token rejected» on the next restart and a trip to the popup, for a command they ran
     to fix something else. Seen live on the owner's own machine, 21.09.2026. */
  const inPlace = pairingInPlace({ dir, home, platform });
  const keptToken = token || inPlace.token;
  const keptPort = port || inPlace.port;
  const usePort = keptPort || (await freePort());
  const useToken = keptToken || mintToken();
  const entry = serverEntry({ port: usePort, token: useToken, platform });

  const wrote = [];
  const failed = [];
  for (const t of installed) {
    try {
      wrote.push({ ...t, action: writeEntry(t, entry) });
    } catch (e) {
      failed.push({ ...t, error: e.message });
    }
  }
  /* Only where Claude Code actually is: the hook lives in the same project this just wrote a
     `.mcp.json` into, and writing one into a folder with no agent in it is litter. */
  let stopHook = null;
  if (hook && installed.some((t) => t.id === 'claude-code')) {
    const file = stopHookFile(dir);
    try {
      stopHook = { file, action: writeStopHook(file), command: STOP_COMMAND };
    } catch (e) {
      stopHook = { file, error: e.message };
    }
  }

  return {
    port: usePort,
    token: useToken,
    reusedToken: !!keptToken,
    entry,
    wrote,
    failed,
    stopHook,
    skipped: targets.filter((t) => !installed.includes(t)),
  };
}
