/**
 * THE OPERATING SYSTEM'S OWN MOUSE (1.89.0, owner ask 25.11.2026: «а мы можем, чтобы и наш бридж так
 * умел делать?»).
 *
 * Every event the extension dispatches is synthetic (isTrusted: false), and some pages ignore those
 * on purpose: ChatGPT's image library takes a synthetic click on a checkbox but not a marquee drag or
 * a shift-click. A real one has to come from the OS. On 24.11.2026 a session did it with cliclick and
 * screen coordinates worked out by hand (window bounds + toolbar + CSS point × zoom), which broke on
 * every zoom change. Here the points arrive already on the screen (the worker's qa_screen_point), and
 * this module only presses.
 *
 * macOS: CoreGraphics through JXA, nothing to install; the app running the agent needs Accessibility
 * permission, the same as any tool that moves the mouse. Windows: user32 through PowerShell. Linux:
 * xdotool (X11). Only macOS is exercised by a stand; the other two follow the same plan and say so.
 *
 * The cursor goes back where it was when the plan ends: the person's mouse is borrowed, not taken.
 */
import { spawnSync } from 'node:child_process';

/* KEYS, by the names people write: «cmd+a», «enter», «shift+tab», «arrowdown». macOS virtual key
   codes; letters and digits go by their own code so a combination never depends on the keyboard
   layout (a Cyrillic layout would otherwise turn cmd+a into cmd+ф). */
const MAC_KEYS = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  arrowleft: 123, left: 123, arrowright: 124, right: 124, arrowdown: 125, down: 125, arrowup: 126, up: 126,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29, o: 31, u: 32, i: 34, p: 35, l: 37,
  j: 38, k: 40, n: 45, m: 46, '/': 44, '.': 47, ',': 43, '-': 27, '=': 24,
};
const MODS = new Set(['shift', 'cmd', 'ctrl', 'alt']);
/** «cmd+shift+g» → { key: 'g', mods: ['cmd','shift'] }, or null with the reason. */
export function parseCombo(combo) {
  const parts = String(combo).toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean)
    .map((p) => ({ command: 'cmd', meta: 'cmd', control: 'ctrl', option: 'alt', opt: 'alt' })[p] || p);
  const mods = parts.filter((p) => MODS.has(p));
  const key = parts.filter((p) => !MODS.has(p));
  if (key.length !== 1 || !(key[0] in MAC_KEYS)) return { error: `unknown key in «${combo}»: use names like enter, escape, tab, space, backspace, arrowdown, a-z, 0-9, with cmd/ctrl/alt/shift+` };
  return { key: key[0], code: MAC_KEYS[key[0]], mods };
}

/* One plan, every platform: a list of steps on screen points, plus held modifier keys. */
export function planFor(action, a, b, { modifiers = [], deltaY = 0, deltaX = 0, steps = 12, holdMs = 80 } = {}) {
  const plan = { flags: modifiers, steps: [] };
  const s = plan.steps;
  if (action === 'move' || action === 'hover') s.push({ t: 'move', ...a }, { t: 'wait', ms: 120 }, { t: 'move', ...a }), (plan.restore = false);
  else if (action === 'click' || action === 'right' || action === 'double') {
    const button = action === 'right' ? 'right' : 'left';
    /* Arrive, settle, arrive again. A cursor that jumps across the screen produces a move the page
       can receive AFTER the press when it is slow (seen at 125% zoom: the late move from the old
       position read as a marquee start). The second move at the same point and the pause before
       the press make the press the last thing that happened at that spot, as with a hand. */
    s.push({ t: 'move', ...a }, { t: 'wait', ms: 120 }, { t: 'move', ...a }, { t: 'wait', ms: 80 });
    s.push({ t: 'down', ...a, button, clicks: 1 }, { t: 'wait', ms: 40 }, { t: 'up', ...a, button, clicks: 1 });
    if (action === 'double') s.push({ t: 'wait', ms: 60 }, { t: 'down', ...a, button, clicks: 2 }, { t: 'up', ...a, button, clicks: 2 });
  } else if (action === 'drag') {
    s.push({ t: 'move', ...a }, { t: 'wait', ms: 120 }, { t: 'move', ...a }, { t: 'wait', ms: 80 }, { t: 'down', ...a, button: 'left', clicks: 1 }, { t: 'wait', ms: 80 });
    const n = Math.max(4, Math.min(120, steps));
    for (let i = 1; i <= n; i++) s.push({ t: 'drag', x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, { t: 'wait', ms: 16 });
    /* A drop target often needs the pointer to REST over it before it accepts (sortable lists,
       boards): holdMs is that rest, then a last move on the spot, then the release. */
    s.push({ t: 'wait', ms: Math.max(80, Math.min(3000, holdMs)) }, { t: 'drag', ...b }, { t: 'wait', ms: 60 }, { t: 'up', ...b, button: 'left', clicks: 1 });
  } else if (action === 'scroll') {
    s.push({ t: 'move', ...a }, { t: 'wait', ms: 60 }, { t: 'scroll', dy: deltaY, dx: deltaX });
  }
  return plan;
}

const MAC = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function run(argv) {
  const plan = JSON.parse(argv[0]);
  const FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 };
  const KEY = { shift: 56, ctrl: 59, alt: 58, cmd: 55 };
  let flags = 0;
  (plan.flags || []).forEach((f) => { flags |= FLAG[f] || 0; });
  const home = $.CGEventGetLocation($.CGEventCreate(null));
  /* FLAGS ARE SET ON EVERY EVENT, ZERO INCLUDED. An event created without flags inherits the
     system's modifier state, and a key-up that does not say «no modifiers» leaves the system
     believing the key is still held: on the stand (25.11.2026) a shift-click left Shift stuck, and
     the next plain click selected a range. For the person that is a stuck Shift on their keyboard. */
  const key = (name, down) => {
    const e = $.CGEventCreateKeyboardEvent(null, KEY[name], down);
    $.CGEventSetFlags(e, down ? flags : 0);
    $.CGEventPost($.kCGHIDEventTap, e);
  };
  const mouse = (type, p, button, clicks, f) => {
    const e = $.CGEventCreateMouseEvent(null, type, { x: p.x, y: p.y }, button === 'right' ? 1 : 0);
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
    $.CGEventSetFlags(e, f === undefined ? flags : f);
    $.CGEventPost($.kCGHIDEventTap, e);
  };
  (plan.flags || []).forEach((f) => key(f, true));
  let at = home;
  for (const s of plan.steps) {
    if (s.t === 'wait') delay(s.ms / 1000);
    else if (s.t === 'move') { mouse(5, s); at = s; }
    else if (s.t === 'down') mouse(s.button === 'right' ? 3 : 1, s, s.button, s.clicks);
    else if (s.t === 'up') mouse(s.button === 'right' ? 4 : 2, s, s.button, s.clicks);
    else if (s.t === 'drag') { mouse(6, s, 'left'); at = s; }
    else if (s.t === 'type') {
      /* Text goes as UNICODE characters, not key codes, so any language types as itself
         whatever the keyboard layout is. One character per event pair. */
      /* TEXT ARRIVES AS A REAL PASTE. Two routes failed on the stand (26.11.2026):
         CGEventKeyboardSetUnicodeString cannot be reached from JXA (a string is not bridged to
         UniChar*, the bare key code then types through the active layout, «ф» for «a» on a Russian
         one), and System Events' keystroke typed nothing at all. A real cmd+v of the text works in
         any language and layout (command shortcuts are layout-independent), and the person's
         clipboard text is put back right after. */
      const pb = $.NSPasteboard.generalPasteboard;
      const old = pb.stringForType($.NSPasteboardTypeString);
      pb.clearContents;
      pb.setStringForType($(s.text), $.NSPasteboardTypeString);
      delay(0.05);
      const vd = $.CGEventCreateKeyboardEvent(null, 9, true);
      $.CGEventSetFlags(vd, FLAG.cmd);
      $.CGEventPost($.kCGHIDEventTap, vd);
      const vu = $.CGEventCreateKeyboardEvent(null, 9, false);
      $.CGEventSetFlags(vu, FLAG.cmd);
      $.CGEventPost($.kCGHIDEventTap, vu);
      delay(0.25);
      pb.clearContents;
      if (old && !old.isNil()) pb.setStringForType(old, $.NSPasteboardTypeString);
    }
    else if (s.t === 'key') {
      let f = 0;
      (s.mods || []).forEach((m) => { f |= FLAG[m] || 0; });
      (s.mods || []).forEach((m) => { const e = $.CGEventCreateKeyboardEvent(null, KEY[m], true); $.CGEventSetFlags(e, f); $.CGEventPost($.kCGHIDEventTap, e); });
      const d = $.CGEventCreateKeyboardEvent(null, s.code, true);
      $.CGEventSetFlags(d, f);
      $.CGEventPost($.kCGHIDEventTap, d);
      const u = $.CGEventCreateKeyboardEvent(null, s.code, false);
      $.CGEventSetFlags(u, f);
      $.CGEventPost($.kCGHIDEventTap, u);
      (s.mods || []).slice().reverse().forEach((m) => { const e = $.CGEventCreateKeyboardEvent(null, KEY[m], false); $.CGEventSetFlags(e, 0); $.CGEventPost($.kCGHIDEventTap, e); });
      delay(0.03);
    }
    else if (s.t === 'scroll') {
      // The plain CGEventCreateScrollWheelEvent is variadic and JXA cannot call it (the event comes
      // back null and nothing scrolls); the «2» variant (macOS 13+) takes its wheels as fixed args.
      const e = $.CGEventCreateScrollWheelEvent2(null, 0, 2, -Math.round(s.dy || 0), -Math.round(s.dx || 0), 0);
      $.CGEventSetFlags(e, flags);
      $.CGEventPost($.kCGHIDEventTap, e);
    }
  }
  (plan.flags || []).slice().reverse().forEach((f) => key(f, false));
  delay(0.05);
  // The way home carries no modifiers whatever happened above.
  if (plan.restore !== false) mouse(5, home, 'left', 0, 0);
  return JSON.stringify({ ok: true, from: [home.x, home.y] });
}`;

function runMac(plan) {
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', MAC, JSON.stringify(plan)], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    return {
      ok: false,
      error: /not allowed|assistive|accessibility/i.test(err)
        ? 'macOS refused: the app running your agent needs Accessibility permission (System Settings → Privacy & Security → Accessibility).'
        : `the OS mouse failed: ${err || r.error?.message || 'unknown error'}`,
    };
  }
  return { ok: true };
}

function runWindows(plan) {
  /* user32: SetCursorPos + mouse_event + keybd_event. Untested on a stand: said in the reply. */
  const VK = { shift: 0x10, ctrl: 0x11, alt: 0x12, cmd: 0x11 };
  const lines = [
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int x,int y,int d,int e); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,int f,int e);' -Name M -Namespace W",
    '[void][W.M]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$home0 = [System.Windows.Forms.Cursor]::Position',
  ];
  for (const f of plan.flags || []) lines.push(`[W.M]::keybd_event(${VK[f] || 0x10},0,0,0)`);
  const SK = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BS}', delete: '{BS}', forwarddelete: '{DEL}', space: ' ', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', arrowup: '{UP}', up: '{UP}', arrowdown: '{DOWN}', down: '{DOWN}', arrowleft: '{LEFT}', left: '{LEFT}', arrowright: '{RIGHT}', right: '{RIGHT}' };
  const skEscape = (t) => t.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/'/g, "''");
  for (const s of plan.steps) {
    if (s.t === 'wait') lines.push(`Start-Sleep -Milliseconds ${s.ms}`);
    else if (s.t === 'type') lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${skEscape(s.text)}')`);
    else if (s.t === 'key') {
      const pre = (s.mods || []).map((m) => ({ shift: '+', ctrl: '^', cmd: '^', alt: '%' })[m] || '').join('');
      lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${pre}${SK[s.key] || skEscape(s.key)}')`);
    }
    else if (s.t === 'move' || s.t === 'drag') lines.push(`[void][W.M]::SetCursorPos(${Math.round(s.x)},${Math.round(s.y)})`);
    else if (s.t === 'down') lines.push(`[W.M]::mouse_event(${s.button === 'right' ? 8 : 2},0,0,0,0)`);
    else if (s.t === 'up') lines.push(`[W.M]::mouse_event(${s.button === 'right' ? 16 : 4},0,0,0,0)`);
    else if (s.t === 'scroll') lines.push(`[W.M]::mouse_event(0x0800,0,0,${-Math.round((s.dy || 0) * 1.2)},0)`);
  }
  for (const f of (plan.flags || []).slice().reverse()) lines.push(`[W.M]::keybd_event(${VK[f] || 0x10},0,2,0)`);
  lines.push('[void][W.M]::SetCursorPos($home0.X,$home0.Y)');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', lines.join('; ')], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? { ok: true, untested: 'Windows path: not exercised on a stand yet' } : { ok: false, error: `PowerShell failed: ${(r.stderr || '').trim().slice(0, 300)}` };
}

function runLinux(plan) {
  const has = spawnSync('xdotool', ['version'], { encoding: 'utf8' });
  if (has.status !== 0) return { ok: false, error: 'xdotool is not installed (X11). Ask the person: `sudo apt install xdotool`. On Wayland use ydotool.' };
  const KEY = { shift: 'shift', ctrl: 'ctrl', alt: 'alt', cmd: 'super' };
  const home = spawnSync('xdotool', ['getmouselocation', '--shell'], { encoding: 'utf8' }).stdout || '';
  const hx = /X=(\d+)/.exec(home)?.[1];
  const hy = /Y=(\d+)/.exec(home)?.[1];
  const cmd = [];
  for (const f of plan.flags || []) cmd.push('keydown', KEY[f]);
  const XK = { enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace', delete: 'BackSpace', forwarddelete: 'Delete', space: 'space', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right' };
  for (const s of plan.steps) {
    if (s.t === 'wait') cmd.push('sleep', String(s.ms / 1000));
    else if (s.t === 'type') cmd.push('type', '--delay', '12', s.text);
    else if (s.t === 'key') cmd.push('key', [...(s.mods || []).map((m) => KEY[m]), XK[s.key] || s.key].join('+'));
    else if (s.t === 'move' || s.t === 'drag') cmd.push('mousemove', String(Math.round(s.x)), String(Math.round(s.y)));
    else if (s.t === 'down') cmd.push('mousedown', s.button === 'right' ? '3' : '1');
    else if (s.t === 'up') cmd.push('mouseup', s.button === 'right' ? '3' : '1');
    else if (s.t === 'scroll') cmd.push('click', '--repeat', String(Math.max(1, Math.round(Math.abs(s.dy || 0) / 60))), (s.dy || 0) > 0 ? '5' : '4');
  }
  for (const f of (plan.flags || []).slice().reverse()) cmd.push('keyup', KEY[f]);
  if (hx && hy) cmd.push('mousemove', hx, hy);
  const r = spawnSync('xdotool', cmd, { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? { ok: true, untested: 'Linux path: not exercised on a stand yet' } : { ok: false, error: `xdotool failed: ${(r.stderr || '').trim().slice(0, 300)}` };
}

export function runPlan(plan) {
  if (process.env.QIKSY_OS_MOUSE === 'off') return { ok: false, error: 'the OS mouse is switched off on this machine (QIKSY_OS_MOUSE=off)' };
  if (process.platform === 'darwin') return runMac(plan);
  if (process.platform === 'win32') return runWindows(plan);
  return runLinux(plan);
}

/** Keys as a plan: text to type and/or combinations, in the order given. */
export function keysPlan(items) {
  const plan = { flags: [], steps: [], restore: false };
  for (const it of items) {
    if (it.text != null) plan.steps.push({ t: 'type', text: String(it.text) });
    else if (it.key != null) {
      const c = parseCombo(it.key);
      if (c.error) return { error: c.error };
      plan.steps.push({ t: 'key', key: c.key, code: c.code, mods: c.mods });
    }
    plan.steps.push({ t: 'wait', ms: it.waitMs ?? 60 });
  }
  return plan;
}

/**
 * A PICTURE OF THE SCREEN REGION the browser window covers — the one view that includes what is
 * NOT the page: the browser's own dialogs («Leave site?», a permission bubble), a native file
 * chooser, the tab strip. It cannot mask password fields the way qa_screenshot does, because it is
 * pixels from the OS, not a page the extension can edit first: callers say so.
 */
export function screenshotRegion({ x, y, w, h }, file) {
  const R = [x, y, w, h].map((n) => Math.round(n));
  if (process.platform === 'darwin') {
    const r = spawnSync('screencapture', ['-x', '-R', R.join(','), file], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return { ok: false, error: `screencapture failed: ${(r.stderr || '').trim() || 'macOS refused (Screen Recording permission for the app running the agent)'}` };
    return { ok: true };
  }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap(${R[2]},${R[3]}); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${R[0]},${R[1]},0,0,$b.Size); $b.Save('${file.replace(/'/g, "''")}')`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0 ? { ok: true, untested: 'Windows path: not exercised on a stand yet' } : { ok: false, error: `PowerShell failed: ${(r.stderr || '').trim().slice(0, 300)}` };
  }
  const r = spawnSync('import', ['-window', 'root', '-crop', `${R[2]}x${R[3]}+${R[0]}+${R[1]}`, file], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? { ok: true, untested: 'Linux path: not exercised on a stand yet' } : { ok: false, error: 'ImageMagick `import` is needed on Linux (sudo apt install imagemagick)' };
}

/* Bring the browser application to the front: the OS mouse presses whatever is on top. */
export function raiseBrowser() {
  if (process.platform !== 'darwin') return;
  // The stand runs Chrome for Testing; the person's own browser is Google Chrome (or set this).
  const app = String(process.env.QIKSY_BROWSER_APP || 'Google Chrome').replace(/"/g, '');
  /* VISIBLE IS NOT FRONTMOST. A tab can be painted while its application is not the active one,
     and on macOS the first click on an inactive application's window only ACTIVATES it: the page
     never sees it (the first marquee of a run failed this way, 26.11.2026). So activate, then wait
     until the system says this application is frontmost. */
  spawnSync('osascript', ['-e', `tell application "${app}" to activate`], { timeout: 5_000 });
  for (let i = 0; i < 15; i++) {
    const r = spawnSync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8', timeout: 3_000 });
    const front = (r.stdout || '').trim();
    if (!front || front === app || app.startsWith(front) || front.startsWith(app)) return true;
    spawnSync('sleep', ['0.1']);
  }
  return false;
}
