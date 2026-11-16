/**
 * OPENING A TAB IN THE BROWSER THE BRIDGE IS ACTUALLY CONNECTED TO.
 *
 * The bridge refuses to navigate a tab onto a foreign domain, and that refusal is correct: it is
 * the thing that stops an agent from walking somebody's browser wherever it likes. But the way
 * OUT of that dead end lived nowhere near the product — it was a shell trick written down in one
 * person's instructions, so every fresh agent rediscovered the dead end and stopped there
 * (owner, 30.09.2026: «постоянно возникает вопрос, он говорит, что я не нахожу таб»).
 *
 * THE PROFILE IS THE WHOLE DIFFICULTY, AND ANCHORING IS WHAT REMOVES IT. A machine has several
 * Chrome profiles; the extension lives in exactly one, and a tab opened anywhere else is invisible
 * to the bridge — every reading afterwards is then about a tab nobody can see. Naming the profile
 * does not work: a running Chrome silently ignores `--profile-directory`, the command still exits
 * 0, and the tab still lands elsewhere. There is no error to diagnose.
 *
 * So this never names a profile. It takes a tab the bridge ALREADY SEES, finds the window holding
 * it, and inserts the new tab beside it. Same window, therefore same profile, therefore visible —
 * by construction rather than by care.
 */
import { spawnSync } from 'node:child_process';

/**
 * ONLY http AND https. `file://` hands an agent the local disk through a browser and
 * `javascript:` hands it the page it lands on; neither is «open a site», and a verb that accepts
 * them is a different, much larger verb wearing this one's name.
 */
export function safeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

/**
 * The anchor: the ORIGIN of a tab the bridge can see. An origin rather than a whole address
 * because the address moves — a single-page app rewrites its path as the person clicks, and an
 * anchor that has to match what was there a second ago is an anchor that misses.
 */
export function anchorFrom(tabs) {
  for (const t of Array.isArray(tabs) ? tabs : []) {
    try {
      const u = new URL(String(t?.url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* a tab with no readable address is simply not an anchor */
    }
  }
  return null;
}

/* AppleScript string literals take the same two escapes as C. The script goes in on stdin rather
   than through `-e`, so the SHELL never sees the address: an OAuth redirect full of & and % is
   exactly the kind of URL this is for, and quoting it for a shell is where that goes wrong. */
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function appleScript({ anchor, url, app = 'Google Chrome' }) {
  return `tell application "${esc(app)}"
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    repeat with t in tabs of w
      if (URL of t) contains "${esc(anchor)}" then
        make new tab at end of tabs of w with properties {URL:"${esc(url)}"}
        set active tab index of w to (count of tabs of w)
        return "opened in window " & wi
      end if
    end repeat
  end repeat
  return "no window holds the anchor"
end tell`;
}

/**
 * WHICH CHROMES ARE RUNNING — the one thing that makes the script above answer about the wrong
 * browser, silently and with a plausible sentence.
 *
 * A second Chrome started from the SAME bundle with its own `--user-data-dir` (which is exactly
 * what `npm run browser` and any CDP rig do) is still «Google Chrome» to AppleScript, and the
 * Apple Event can land on it instead of the person's. Measured on this machine 30.09.2026: pid
 * 628 held four windows, the CDP instance held none, and `tell application "Google Chrome" to
 * count of windows` answered 0 — so the anchor loop walked an empty browser and reported «no
 * window holds the anchor» while four live windows sat next to it. There is no error to read and
 * the sentence is the same one a genuinely closed window produces.
 *
 * Nothing here is a fix: AppleScript cannot be pointed at a process id, because the tab
 * vocabulary belongs to the application and not to System Events. What it buys is the NAME of the
 * cause, which is the difference between a two-minute answer and an afternoon.
 */
export function listChromes(run = defaultPs) {
  const out = run();
  if (typeof out !== 'string') return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/.test(l))
    /* Renderers, GPU and utility processes carry --type= and are not instances. */
    .filter((l) => !/--type=|Helper/.test(l))
    .map((l) => {
      const pid = Number(l.slice(0, l.indexOf(' ')));
      const dir = /--user-data-dir=(\S+)/.exec(l);
      return {
        pid,
        dataDir: dir ? dir[1] : null,
        /* The person's own Chrome is started with neither flag; anything carrying one is a rig. */
        isolated: !!dir || /--remote-debugging-port=/.test(l),
      };
    })
    .filter((c) => Number.isFinite(c.pid));
}

function defaultPs() {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 8_000 });
  return r.error ? '' : String(r.stdout || '');
}

/** Runs the script. Separated so the gate can drive every branch without a browser on the machine. */
export function runAppleScript(script) {
  const r = spawnSync('osascript', ['-'], { input: script, encoding: 'utf8', timeout: 15_000 });
  if (r.error) return { ok: false, said: String(r.error.message || r.error) };
  const said = String(r.stdout || '').trim() || String(r.stderr || '').trim();
  return { ok: r.status === 0 && /^opened in window/.test(said), said };
}

/**
 * The whole verb, with the platform check and both ways it can legitimately fail.
 *
 * `tabsNow` returns the bridge's current tab list; it is asked TWICE on purpose — once for the
 * anchor, once to find out what actually happened. A command that exits 0 proves the script ran,
 * not that a tab the bridge can see now exists, and those are the two facts that get confused.
 */
export async function openTabHere({
  url,
  tabsNow,
  platform = process.platform,
  run = runAppleScript,
  chromes = listChromes,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 8,
}) {
  const clean = safeUrl(url);
  if (!clean) return { ok: false, error: 'bad-url', note: 'Only http:// and https:// addresses can be opened this way.' };

  const before = await tabsNow();
  const anchor = anchorFrom(before);
  if (!anchor) {
    return {
      ok: false,
      error: 'no-anchor',
      note:
        'The bridge can see no tab at all, so there is no window to open this beside — and opening it anywhere else would put it in a Chrome profile the extension does not live in, where nothing you do next is visible. Ask the person to open any page in the browser that has Qiksy in it, then call this again.',
    };
  }

  if (platform !== 'darwin') {
    return {
      ok: false,
      error: 'not-on-this-platform',
      anchor,
      note: `Opening a tab this way is macOS-only for now. Ask the person to open ${clean} themselves in the browser that has Qiksy in it — any other browser or profile is invisible to the bridge.`,
    };
  }

  const said = run(appleScript({ anchor, url: clean }));
  if (!said.ok) {
    /* THE ANCHOR WAS NOT FOUND — and the likeliest reason is not that the window closed. Ask which
       Chromes are running BEFORE blaming the window, because a second instance answers in its
       place with a sentence that reads identically. */
    const running = (() => {
      try {
        return chromes();
      } catch {
        return [];
      }
    })();
    const rigs = running.filter((c) => c.isolated);
    if (running.length > 1 && rigs.length) {
      return {
        ok: false,
        error: 'another-chrome-answers',
        anchor,
        said: said.said,
        chromes: running.map(({ pid, isolated, dataDir }) => ({ pid, isolated, dataDir })),
        note:
          `There are ${running.length} Chrome processes from the same application, and AppleScript reaches only one of them — here it reached a rig instead of the person's browser, so it looked through a window list that is not theirs. This is not a closed window and retrying changes nothing. ` +
          `The extra one is pid ${rigs.map((c) => c.pid).join(', ')}${rigs[0].dataDir ? ` (started with --user-data-dir=${rigs[0].dataDir})` : ''} — a debugging or release browser, which is safe to close and comes back on demand. ` +
          `Ask the person to quit it (or run \`kill ${rigs[0].pid}\`) and call this again; the anchor works the moment one Chrome is left. Do NOT open the address with another driver instead.`,
      };
    }
    return {
      ok: false,
      error: 'could-not-open',
      anchor,
      said: said.said,
      chromes: running.map(({ pid, isolated }) => ({ pid, isolated })),
      note: 'The browser did not take the new tab. If this says the anchor was not found, the window holding it was probably closed between the two steps.',
    };
  }

  /* WAIT FOR THE TAB TO BE VISIBLE TO THE BRIDGE, not for a number of milliseconds: a page that
     is still loading has no address the extension reports yet, and answering before it does would
     hand back «opened, and I cannot see it», which reads as a failure. */
  const wantOrigin = new URL(clean).origin;
  const knownIds = new Set((before || []).map((t) => t.tabId));
  let fresh = null;
  for (let i = 0; i < tries && !fresh; i++) {
    await sleep(600);
    const now = await tabsNow();
    fresh = (now || []).find((t) => !knownIds.has(t.tabId)) || null;
    if (!fresh) fresh = (now || []).find((t) => String(t.url || '').startsWith(wantOrigin) && !knownIds.has(t.tabId)) || null;
  }

  if (fresh) {
    return { ok: true, tabId: fresh.tabId, url: fresh.url, inSession: true, said: said.said, note: 'The tab is open and the bridge can act on it. Pass this tabId to the other verbs.' };
  }

  /**
   * OPENED, BUT NOT IN THE SESSION — and this is the ordinary case rather than a fault.
   *
   * The active tab counts as the session only while NOTHING has been attached; the moment a person
   * has switched «Agent drives this tab» on anywhere, the session is that explicit set and a new
   * tab is not in it. Reporting «opened» and stopping would leave the agent measuring a tab it
   * cannot see and blaming the bridge, which is the exact failure this verb was built to end.
   */
  return {
    ok: true,
    tabId: null,
    inSession: false,
    said: said.said,
    note: `The tab is open in the right browser, but it is not in the agent's session: once any tab has been switched on for the agent, the session is that explicit set and a new tab does not join it by itself. Ask the person to switch «Agent drives this tab» on for ${wantOrigin} — reading and driving both start working the moment they do.`,
  };
}
