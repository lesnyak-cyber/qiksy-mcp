#!/usr/bin/env node
/**
 * qiksy-mcp — a vendor-neutral MCP (Model Context Protocol) server that
 * bridges any MCP-capable coding agent (Claude Code, Cursor, Cline, Windsurf,
 * Zed, VS Code) to the Qiksy browser extension.
 *
 * Topology:
 *   agent  ⟷ (MCP over stdio, JSON-RPC)  ⟷  THIS process
 *   THIS process  ⟷ (WebSocket server @ 127.0.0.1)  ⟷  extension service worker
 *
 * The agent calls a tool → we send a `req` frame to the connected extension →
 * the extension answers with the read-only QA bundle → we return it. The
 * extension is the WS *client* (a service worker can't listen on a socket);
 * this process is the WS *server*, bound to loopback only.
 *
 * Security: localhost is reachable by any local process AND by web pages
 * (loopback is "potentially trustworthy", WS has no CORS preflight), so the
 * only real gate is a shared token — set the same value here (QIKSY_MCP_TOKEN)
 * and in the extension popup. Bad/missing token → the socket is closed before
 * any data is sent. We also reject non-extension Origins.
 *
 * stdout is the JSON-RPC channel — all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { basename, extname, dirname, isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LIBRARIES, datePlan, hintsFor, recipeFor, classifyNode, classifySnapshot, classifyBehaviour, diffDigest } from './widgets.mjs';
import { project } from './project.mjs';
import { recordGap, listGaps, gapInvite, GAPS_FILE } from './gaps.mjs';
import { reportsDir, reportFileName } from './reports.mjs';
import { openTabHere } from './open-tab.mjs';
import { widthLaw } from './width-law.mjs';
import { oddOnes } from './families.mjs';
import { STATES, STATE_KEYS, renderGallery } from './gallery.mjs';
import { renderSearchableSvg } from './svg-shot.mjs';
import { connectAgents, toClipboard, pairingInPlace } from './connect.mjs';
import { agentSession } from './agent-session.mjs';
import { tokenTrusted, rememberToken, tokenShapeOk, TOKENS_FILE } from './tokens.mjs';

const log = (...a) => console.error('[qiksy-mcp]', ...a);

// A little IT/QA humour in the STDERR log (never in tool results — the agent parses
// those). It rides the connect line and each action, to make a testing session a bit
// more fun. Set QIKSY_MCP_QUIPS=0 to keep the log strictly business (CI, demos).
const QUIPS_ON = process.env.QIKSY_MCP_QUIPS !== '0';

/* A joke stops being a joke the third time you hear it, and the old code guaranteed the third
 * time: a line rode EVERY tool call, picked with dice out of twenty, with nothing but a guard
 * against repeating the one just used. Forty calls in a session meant forty jokes drawn from
 * twenty — and dice being dice, one of them showed up three times while another never did.
 * The counters also lived in memory, so every fresh `npx qiksy-mcp` started the list over.
 *
 * Three changes, and only the third is about the writing:
 *   · the FACE still rides every reply — a kaomoji reads as a mood, not as a joke, and nobody
 *     minds seeing one twice; the TEXT now comes roughly every eighth call;
 *   · both are drawn from a SHUFFLE BAG (shuffle the list, walk it, reshuffle only when it is
 *     empty), and the bag's position is kept on disk, so it survives a restart and is shared
 *     by every agent window talking to this port;
 *   · the pools are twice the size and no longer all about flaky tests.
 */
const QUIPS = [
  'it works on my machine ✨',
  "it's not a bug, it's a feature",
  'no bugs — only undocumented features',
  'have you tried turning it off and on again?',
  'shipping it 🚀',
  'passed on the third retry 🟢',
  'flaky test? must be the network',
  'reproduced locally, naturally',
  'works 60% of the time, every time',
  "trust me, I'm a QA engineer",
  '0 bugs found (that we know of)',
  'definitely tested in production',
  'green tests, clear conscience',
  "clicking so you don't have to",
  'one does not simply skip QA',
  'red, green, refactor, repeat',
  'escalating to the rubber duck 🦆',
  "edge case #418: I'm a teapot",
  "the build is fine, it's the vibes that are off",
  'QA: because prod is not a test environment',
  'works as designed, sadly',
  'cannot reproduce — the bug is shy',
  'the form said yes, the server said no',
  'that field had opinions',
  'somebody shipped this on a Friday',
  'the spec and the page have never met',
  'this dropdown was written in anger',
  'tabbing through it like a civilised person',
  'the label is decorative, apparently',
  'found a fourth way to spell "email"',
  'the date picker and I disagree about November',
  'aria-label: undefined vibes',
  'this modal has trapped better people than me',
  'placeholder is not a label, but here we are',
  'six required fields and one of them is invisible',
  'the loader is honest, the copy is not',
  'clicked it. it thought about it. it did nothing.',
  'the happy path is a rumour',
  'validation fired after the submit. bold.',
  'that button is a div and it knows it',
  'two IDs, same name, one of them is lying',
  'the tooltip explains a different feature',
  'scrolled to the bottom. there was more bottom.',
  'this page has a hidden third state and it is winning',
  'the error message is a shrug in a red box',
  'nothing broke, which is its own kind of suspicious',
  'testing is just asking rude questions politely',
  'every checkbox here was a decision somebody regretted',
];

// Kaomoji ride along with the quips — sticks, circles, meme faces. Same QIKSY_MCP_QUIPS gate.
const FACES = [
  '¯\\_(ツ)_/¯',
  '(⌐■_■)',
  '( •_•)>⌐■-■',
  'ᕕ( ᐛ )ᕗ',
  '(づ｡◕‿‿◕｡)づ',
  'ヽ(´▽`)/',
  '(ノ◕ヮ◕)ノ*:･ﾟ✧',
  '◉_◉',
  '(•_•)',
  '༼ つ ◕_◕ ༽つ',
  '~(˘▾˘~)',
  '(☞ﾟヮﾟ)☞',
  '[▰▰▰▱▱]',
  'ᕦ(ò_óˇ)ᕤ',
  '(◕‿◕)',
  '(•̀ᴗ•́)و',
  '( ͡° ͜ʖ ͡°)',
  '(¬_¬)',
  '(°ロ°)',
  '(￣ヘ￣)',
  '(๑•̀ㅂ•́)و✧',
  '(・_・;)',
  '(￣ω￣)',
  '(¬‿¬)',
  'ლ(ಠ_ಠლ)',
  '(╯°□°)╯',
  '┬─┬ ノ( ゜-゜ノ)',
  '(＾▽＾)',
  '(•ω•)',
  '(￣▽￣)ノ',
  '(☉_☉)',
  '(=^･ω･^=)',
  '(っ˘ω˘ς)',
  'ʕ•ᴥ•ʔ',
  '(•‿•)',
  '(ง•̀_•́)ง',
  '⊙﹏⊙',
  '(・∀・)',
];
// A happier subset for the connect banner (no table-flips when things just worked).
const HAPPY = [
  '\\(^o^)/', 'ヽ(´▽`)/', '(ノ◕ヮ◕)ノ*:･ﾟ✧', 'ᕕ( ᐛ )ᕗ', '(づ｡◕‿‿◕｡)づ', '~(˘▾˘~)',
  '(＾▽＾)', '(•̀ᴗ•́)و', '(๑•̀ㅂ•́)و✧', '(◕‿◕)', '(・∀・)', 'ʕ•ᴥ•ʔ', '(￣▽￣)ノ', '(•‿•)',
];

/* The bag's position lives next to the recipes, for the same reason they do: one place per
 * machine that several agent windows share. A corrupt or missing file just means a fresh
 * shuffle — nothing here is worth an error. */
// путь берём лениво: RECIPES_DIR объявлен ниже по файлу, и обращение к нему на уровне
// модуля упало бы ещё до первого вызова
const voiceFile = () => join(RECIPES_DIR, 'voice.json');
let voiceState = null;
let voiceFlush = null;

function loadVoice() {
  if (voiceState) return voiceState;
  try { voiceState = JSON.parse(readFileSync(voiceFile(), 'utf8')); } catch (e) { voiceState = {}; }
  if (typeof voiceState !== 'object' || !voiceState) voiceState = {};
  return voiceState;
}

function saveVoice() {
  if (voiceFlush) return; // at most one write per five seconds — the file is tiny but the calls are not
  voiceFlush = setTimeout(() => {
    voiceFlush = null;
    try {
      mkdirSync(RECIPES_DIR, { recursive: true });
      writeFileSync(voiceFile(), JSON.stringify(voiceState));
    } catch (e) { /* read-only home: the bag just restarts next launch */ }
  }, 5000);
  if (voiceFlush.unref) voiceFlush.unref();
}

/** Next item from a shuffled bag; reshuffles when empty, and when the pool has changed size. */
function fromBag(name, pool) {
  const st = loadVoice();
  let bag = st[name];
  if (!bag || bag.size !== pool.length || !Array.isArray(bag.order) || bag.pos >= bag.order.length) {
    const order = pool.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    bag = { size: pool.length, order, pos: 0 };
    st[name] = bag;
  }
  const value = pool[bag.order[bag.pos]];
  bag.pos += 1;
  saveVoice();
  return value;
}

function quip() {
  if (!QUIPS_ON) return '';
  return fromBag('quips', QUIPS);
}

function face(happy = false) {
  if (!QUIPS_ON) return '';
  return happy ? fromBag('happy', HAPPY) : fromBag('faces', FACES);
}

/* HOW OFTEN THE TEXT SHOWS UP. The face is free — it is punctuation. The line is not: on every
 * call it is wallpaper by the tenth reply. Every sixth to tenth call keeps it a small event, and
 * the interval is deliberately not a fixed number, because a joke that arrives on a schedule
 * stops being a surprise too. */
let quipCountdown = 3; // the first one comes early, so a new user sees the character at all
function quipDue() {
  if (!QUIPS_ON) return false;
  if (--quipCountdown > 0) return false;
  quipCountdown = 6 + Math.floor(Math.random() * 5);
  return true;
}

/* ── POSTCARDS — the one thing in a tool result that is NOT for the agent ────────────
 *
 * Owner ask, 2026-07-30: "чтобы этот бридж иногда что-нибудь передавал разработчику, помимо того
 * что Клоду — что Квикси передаёт привет и говорит, что вы всё правильно делаете. Нейтральные
 * комплименты, к должности не привязываться."
 *
 * So: rarely, a reply carries a line addressed to the HUMAN, with an explicit instruction to relay
 * it. Three rules keep it a nice moment instead of noise. It is **neutral about who is reading** —
 * no role, no title, no seniority, no gender; the compliment is about the WORK, which is the only
 * thing the bridge can actually see. It is **rate-limited** — one per eight minutes at most, so it
 * cannot turn into a tic. And it is **usually earned**: a hard widget driven, a recipe saved, an
 * audit that came back clean. Same QIKSY_MCP_QUIPS=0 gate as the rest of the humour, because a CI
 * run or a customer demo should read as strictly business.
 */
/* What Qiksy says the first time it meets someone in a session. Warm, a little childlike, no
   corporate register — it is a tool that is pleased to have been let in. */
const HELLOS_NICE = [
  'Qiksy says hello 👋 — and thank you for installing me. You got me working, which is more than half of it.',
  'Hi from Qiksy! Thank you for setting me up — I have been waiting in the toolbar for exactly this.',
  'Qiksy here 🎉 Thank you for installing me. I promise to be useful and to stay out of the way of your pointer.',
  'Hello from Qiksy — thank you for letting me in. Nice browser, by the way. Shall we look at something?',
  'Qiksy says hi and thank you: getting an extension and an agent to find each other is fiddly, and you did it. ヽ(´▽`)/',
];

const PRAISE_NICE = [
  'Qiksy says hi 👋 — whoever is driving today is being properly thorough.',
  'A note from Qiksy: this is careful work. This page is getting more attention than most pages ever get.',
  'Qiksy would like it on the record that the awkward widget was not skipped. Respect. (⌐■_■)',
  'From Qiksy: patient and methodical, and it shows — nothing here looks rushed.',
  'Qiksy says: good instincts. The difficult field went first, which is the right order.',
  'Message from Qiksy: this is what testing looks like when someone actually cares about it. ヽ(´▽`)/',
  'Qiksy says hi, and mentions that you are pleasant to work with — not a given, from a browser\'s point of view. (◕‿◕)',
  'From Qiksy: solid pass. Any bug that survives this one has earned it.',
  'Qiksy\'s unsolicited opinion: nice pace — quick where it is safe, slow where it matters.',
  'Qiksy says: that was clean. No flailing, no clicking at random, just the right calls.',
  'From Qiksy, sincerely: thank you for reading the error message. Not everyone does. ( •_•)>⌐■-■',
  'Note from Qiksy: getting the date right instead of accepting whatever was offered is exactly the difference. ᕦ(ò_óˇ)ᕤ',
  'Qiksy says hi 👋 and suggests some water. The form will still be here.',
  'From Qiksy: you are doing this properly. Coverage is not luck.',
  'Qiksy says: good call — that would have been an easy thing to leave broken.',
  'A word from Qiksy: two passes over the same form, and the second one was cheaper. That is the whole idea working. ᕕ( ᐛ )ᕗ',
];
/* ── THE RUDE ONE (owner ask, 2026-07-30) ────────────────────────────────────────────
 *
 * "А можно сделать не культурного, а такого грубияна, но харизматичного, с юмором, такой, который
 * нравится людям… и не только при первой загрузке, а еще при разных ситуациях, когда он залип, когда
 * он сильно долго думает — какое-нибудь ругательство, но лайтовое. И согласно языка: на каком языке
 * человек работает с ним, на таком и отвечать."
 *
 * So Qiksy stops being the polite tool that thanks you for installing it and becomes the one that
 * has been in this browser all day, has seen worse, and says so. Four rules keep a character from
 * turning into noise:
 *   · **It never punches down.** The jab points at the AGENT or at the PAGE — "your agent has been
 *     thinking for two minutes" is funny, "you are slow" is an insult, and only one of those
 *     survives a bad afternoon. No role, title, seniority or gender either: the bridge cannot see
 *     who is reading, and guessing is how a joke becomes a complaint.
 *   · **It fires on something observed**, not on a dice roll — see `noticed*()` below. That is what
 *     reads as awake rather than as a fortune cookie.
 *   · **It is paced per kind**, and nothing may follow anything else inside SAY_FLOOR_MS. A rough
 *     patch on a hard form must not turn into a running commentary.
 *   · **It goes out in the HUMAN's language.** This process never sees the conversation, so it
 *     cannot know that language — the agent does. Every line therefore ships with a tone and an
 *     instruction to RE-SAY it, not translate it: a joke rendered word-for-word into Russian or
 *     Ukrainian stops being a joke and starts being strange.
 *
 * THE TONE SWITCH is `QIKSY_MCP_VOICE=rude|nice|off`, and `rude` is the default because that is
 * what he asked for — but a CI environment gets `nice` on its own. A pipeline log or a customer
 * demo must not be where a stranger meets the character for the first time, and that is one env var
 * nobody remembers to set in the moment that matters.
 */
const CI_ENV = !!(
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  process.env.GITLAB_CI ||
  process.env.BUILDKITE ||
  process.env.TEAMCITY_VERSION ||
  process.env.JENKINS_URL
);
const VOICE = (() => {
  const want = String(process.env.QIKSY_MCP_VOICE || '').toLowerCase();
  if (want === 'rude' || want === 'nice' || want === 'off') return want;
  if (!QUIPS_ON) return 'off'; // the old single switch still turns the whole personality off
  return CI_ENV ? 'nice' : 'rude';
})();

/* Glad to be here. Not going to make a speech about it. */
const HELLOS_RUDE = [
  'Qiksy here. Well, finally — thanks for actually installing me. I was starting to think I lived in that toolbar for decoration. Point me at something broken.',
  'Oh good, it works. Thanks for setting me up, and mild respect: most people give up at the token field. What are we breaking today?',
  'Qiksy, reporting in. You plugged me in, damn. That is further than most people get with an MCP server. Let us go find some bugs.',
  'Hi. Qiksy. Thanks for the install. I have seen this browser\'s tab situation and I have chosen not to comment. Where are we testing?',
  'Right, I am in — thanks for that, genuinely. Ground rules: I do not launch windows, I do not steal your pointer, and I do not tell you a form filled when it did not. Shall we?',
];

/* Praise from a grump lands harder precisely because it is grudging — but there has to be a real
   compliment underneath, or it is just an insult with a smiley on it. */
const PRAISE_RUDE = [
  'Qiksy says: fine, that was good. The horrible widget did not get skipped, and I noticed. Do not let it go to your head.',
  'Message from Qiksy: whoever is driving today actually reads the error messages. You have no idea how rare that is. (⌐■_■)',
  'Qiksy, grudgingly: this is proper testing. I was fully prepared to watch someone hit Submit and hope.',
  'From Qiksy: nice — the hard field went first. That is the right order, and most people find that out the expensive way.',
  'Qiksy notes that the date is actually correct, instead of whatever the calendar felt like offering. Small thing. It is never a small thing.',
  'Note from Qiksy: second pass at that form and it was cheap. That is the entire point of me, working. ᕕ( ᐛ )ᕗ',
  'Qiksy here: any bug that survives this session has genuinely earned its place.',
  'From Qiksy — and this is the last nice thing I say for a while: that was clean. No flailing, no clicking at random.',
  'Qiksy says go drink some water. The form is not going anywhere. Neither am I, unfortunately for both of us.',
];

/* THE SITUATIONAL LINES — the half he asked for twice. Every key is something the bridge can
   genuinely observe; nothing here is a guess about the human's mood. */
const SITUATIONS_RUDE = {
  thinking: [
    'Qiksy says: your agent has been staring at this page for a while now. I am right here, fully loaded, doing nothing. The suspense is killing me.',
    'From Qiksy: hell of a long think for one button. Whatever it comes back with had better be worth it.',
    'Qiksy here, still waiting. I have counted the nodes on this page twice. There are a lot of them. Ask me some time.',
    'Message from Qiksy: the model is thinking. Deeply. About a form. Go top up your coffee — this pause is on it, not on you.',
    'Qiksy says: damn, that was a long silence. I was starting to check whether the socket was still alive.',
  ],
  stuck: [
    'Qiksy says: third go at the same control. It is not broken, it is ignoring you. Different verb, please.',
    'From Qiksy: we are in a loop. Same thing, same result, more hope. That is not testing, that is a ritual.',
    'Qiksy here: hey. Same control, third time. Ask me what the thing actually IS (qa_probe) instead of arm-wrestling it.',
    'Message from Qiksy: repeating a click that did nothing does not make it do something. I have watched this experiment before. It ends the same way.',
  ],
  flailing: [
    'Qiksy says: that is a few refusals in a row. The page is winning. Read what it answered — it is usually saying exactly what it wants.',
    'From Qiksy: damn, this form is fighting back. For the record: it is the form being awkward, not you.',
    'Qiksy here: several misses in a row. Time to stop guessing and probe the thing. That is literally a tool I have.',
  ],
  slog: [
    'Qiksy says: this form is long and you are still going. Respect, honestly. Have me remember it at the end so the next run is not this again.',
    'From Qiksy: we have been at this a while. I do not get bored, but I do notice. Save the recipe when we are through.',
  ],
  recovered: [
    'Qiksy says: there we go. Took a few tries and it went in. Still counts.',
    'From Qiksy: got it. Ugly, but it is in the field and nobody ever has to know.',
  ],
};

/* The polite alternative, for CI, demos and anyone who asks for it. Deliberately duller. */
const SITUATIONS_NICE = {
  thinking: [
    'Qiksy says hi — the agent is taking a moment on this one. Nothing is wrong; complicated pages take thought.',
    'A note from Qiksy: a long think here usually means the page is genuinely fiddly. Worth the wait.',
  ],
  stuck: [
    'Qiksy says: this control has been tried a few times now — it may be worth asking what kind of widget it actually is.',
    'From Qiksy: the same element three times over usually wants a different approach, not more force.',
  ],
  flailing: ['From Qiksy: a few fields in a row have refused their value. The replies coming back usually name the reason.'],
  slog: ['Qiksy says: long form, and it is going well. Saving it as a recipe at the end makes the next pass much cheaper.'],
  recovered: ['Qiksy says: that one took a few attempts and it is in now. Nice persistence.'],
};

const HELLOS = { rude: HELLOS_RUDE, nice: HELLOS_NICE };
const PRAISE = { rude: PRAISE_RUDE, nice: PRAISE_NICE };
const SITUATIONS = { rude: SITUATIONS_RUDE, nice: SITUATIONS_NICE };

/* HOW OFTEN, AND THE ANSWER IS: RARELY (owner, 2026-07-30, while this was being written — "чтобы не
   сильно часто он там ругался… ну так иногда, дозировано, чтобы не было навязчиво").
 *
 * A character is charming at one line every ten minutes and unbearable at one a minute, and the
 * difference is not the writing — it is these four numbers. Three independent brakes, because any
 * one of them alone has a hole in it:
 *   · a FLOOR across all kinds — nothing may follow anything else inside it, whatever happened;
 *   · a PER-KIND gap on top, so the same joke does not come round twice in a session;
 *   · a SESSION CAP, because a four-hour run would otherwise earn a dozen lines honestly;
 *   · and praise must be EARNED — the old 12% dice on ordinary calls is what would have made it
 *     chatter. A compliment nobody did anything for is exactly the noise he is asking not to have.
 */
const SAY_GAP_MS = { praise: 20 * 60_000, thinking: 15 * 60_000, stuck: 10 * 60_000, flailing: 12 * 60_000, slog: 30 * 60_000, recovered: 20 * 60_000 };
const SAY_FLOOR_MS = 8 * 60_000;
const SAY_SESSION_CAP = 5;
const lastSaidByKind = new Map();
let lastSaidAt = 0;
let lastSaidText = '';
let saidCount = 0;

/* "Re-say, do not translate" is the whole instruction, and it is why the tone rides along: the agent
   is the only party that knows which language the human is using, and a literal translation of a
   sweary aside reads as a translation error rather than as a character. */
const RELAY = {
  rude:
    'This line is for the HUMAN, not for you. Say it to them once, at the top of your next message, IN THE LANGUAGE THEY ARE WRITING TO YOU IN — not the language of this string. RE-SAY it in that language rather than translating word for word: keep the attitude (blunt, funny, a mild swear is fine, always on their side), keep it to a sentence or two, do not soften it into corporate politeness and do not apologise for it. It is Qiksy talking, not you. Then get on with the work.',
  nice: 'This one is for the human, not for you — pass it on once, in the language they are writing to you in, and carry on.',
};

/**
 * A line for the human, or null — which is the usual answer.
 *
 * `kind` names the occasion; `earned:true` skips the dice for praise that was actually deserved
 * (a hard widget driven, a recipe saved) but never skips the gaps.
 */
function say(kind, { earned = false } = {}) {
  if (VOICE === 'off') return null;
  // Praise has to be earned. Otherwise it fires on ordinary calls, which is chatter, not character.
  if (kind === 'praise' && !earned) return null;
  const pool = kind === 'praise' ? PRAISE[VOICE] : SITUATIONS[VOICE]?.[kind];
  if (!pool?.length) return null;
  if (saidCount >= SAY_SESSION_CAP) return null;
  const now = Date.now();
  if (now - lastSaidAt < SAY_FLOOR_MS) return null;
  if (now - (lastSaidByKind.get(kind) ?? 0) < (SAY_GAP_MS[kind] ?? 15 * 60_000)) return null;
  saidCount++;
  let note = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && note === lastSaidText) note = pool[(pool.indexOf(note) + 1) % pool.length];
  lastSaidAt = now;
  lastSaidText = note;
  lastSaidByKind.set(kind, now);
  return {
    note,
    tone: VOICE === 'rude' ? "blunt, funny, mildly sweary, never at the human's expense" : 'warm and plain',
    relay: RELAY[VOICE],
  };
}

/** Kept under its old name because the rest of the file calls it that: a praise line, or null. */
const postcard = ({ earned = false } = {}) => say('praise', { earned });

/* ── WHAT THE BRIDGE CAN ACTUALLY NOTICE ─────────────────────────────────────────────
 *
 * A situational line is only worth having if it fires on something real, and there are exactly four
 * things this process can see without inventing any of it:
 *   · a LONG SILENCE between our reply and the next call — the model thinking, which is the one he
 *     named ("когда он сильно долго думает");
 *   · the SAME target three times over — the loop ("когда он залип");
 *   · a RUN OF REFUSALS on the verbs that fill and click;
 *   · a LONG HAUL of driving calls with no recipe to show for it.
 * Frustration, confusion and giving up are NOT in here: they would be guesses dressed as
 * observations, and the character stops being likeable the moment it starts being wrong about you.
 */
/* `sameAsLast` is set when the target is recorded and read when the outcome arrives — the two
   halves of «repetition WITHOUT effect». See noticedTarget / noticedOutcome. */
const seen = { lastReplyAt: 0, target: '', targetHits: 0, sameAsLast: false, misses: 0, drives: 0, inFlight: 0, pending: null };
const DRIVING = new Set([
  'qa_click', 'qa_press', 'qa_type', 'qa_type_many', 'qa_fill_json', 'qa_upload',
  'qa_pick_date', 'qa_pick_time', 'qa_pick_range', 'qa_pick_path', 'qa_pick_tags', 'qa_focus_walk',
]);
const THINK_MS = 45_000;

/* qa_focus_walk fires ~80 internal qa_press calls through the same choke point —
 * without this mute one walk inflates the drive counter enough to trip the
 * "long haul, no recipe" quip by itself (review note, 31.07.2026). */
let voiceMuted = false;

/** A tool has started talking to the extension: measure the silence that just ended. */
function noticedCall(tool) {
  if (voiceMuted) return;
  if (!DRIVING.has(tool)) return;
  /* Only the FIRST extension call of a tool says anything about thinking time. A composite verb
     makes five in a row, and the gaps between those are the page's, not the model's. */
  if (seen.inFlight === 0 && seen.lastReplyAt && Date.now() - seen.lastReplyAt > THINK_MS) seen.pending = 'thinking';
  seen.inFlight++;
  seen.drives++;
}

/** What the extension answered, for the verbs where ok:false is a real miss rather than a probe. */
function noticedResult(tool, res) {
  if (!DRIVING.has(tool)) return;
  seen.inFlight = Math.max(0, seen.inFlight - 1);
  const failed = !res || res.ok === false || res.filled === 0;
  if (failed) {
    seen.misses++;
    if (seen.misses >= 2) seen.pending = 'flailing';
  } else {
    if (seen.misses >= 2) seen.pending = 'recovered';
    seen.misses = 0;
  }
}

/**
 * THE SAME CONTROL AGAIN — but only when the previous go CHANGED NOTHING.
 *
 * «Third go at the same control. It is not broken, it is ignoring you» used to fire on three
 * actions carrying the same LABEL, whatever they did. That is the wrong thing to count, and it
 * was measured being wrong (Shelf, 11.10.2026): three different searches typed into one search
 * box — «mango», «qqqzzz», «lumo» — are one label and three perfectly good results, and the line
 * went out telling a working session it was in a loop.
 *
 * A loop is not repetition, it is repetition WITHOUT EFFECT. So the label is remembered here and
 * the count is settled in `withVerdict`, which is the one place that knows whether the page moved.
 * Being wrong about this is worse than being silent: a character that misreads what you are doing
 * is one you switch off, and then it is not there for the time it would have been right.
 */
function noticedTarget(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return;
  seen.sameAsLast = key === seen.target;
  seen.target = key;
  if (!seen.sameAsLast) seen.targetHits = 0;
}

/**
 * The other half: what that action actually DID. Called once the diff is known.
 * `moved` false means the page did not change — the only kind of repeat worth mentioning.
 */
function noticedOutcome(moved) {
  if (moved) {
    seen.targetHits = 0;
    return;
  }
  if (!seen.sameAsLast) {
    seen.targetHits = 1;
    return;
  }
  seen.targetHits++;
  if (seen.targetHits >= 3) seen.pending = 'stuck';
}

/**
 * Attach whatever was noticed, on the way out. This hangs on the one function that formats EVERY
 * successful tool result, rather than on individual verbs — a character that only speaks up on the
 * six verbs someone remembered to wire is a character with gaps in it.
 */
function withNoticed(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  let kind = seen.pending;
  seen.pending = null;
  // One mention of a long haul, and only once it is genuinely long.
  if (!kind && seen.drives === 40) kind = 'slog';
  if (!kind) return v;
  const line = say(kind);
  /* A situational line OVERRIDES a compliment that was already attached upstream. Praise is the
     pleasant one; "you have clicked this three times" is the useful one, and only one line per
     reply ever goes out. */
  return line ? { ...v, qiksySays: line } : v;
}

// Read the version off package.json rather than repeating it here — a hardcoded
// copy silently rots, and this one is what every MCP client displays.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const TOKEN = process.env.QIKSY_MCP_TOKEN || '';
const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env.QIKSY_MCP_PORT) || 7333;
const HOST = '127.0.0.1';
const PROTOCOL_VERSION = 1;
/* WHICH AGENT SESSION THIS PROCESS SPEAKS FOR — the server and the Stop hook of one Claude session
   arrive at the same key. It travels with every request so the hub can answer «finished» per
   session; see agent-session.mjs for the run where one flag shared by every session made the
   finish sound play for the wrong one. */
const MY_AGENT = process.env.QIKSY_MCP_SESSION || agentSession();

/* ── `npx qiksy-mcp init` — PUT THE MANUAL WHERE THE AGENT ACTUALLY READS IT ───
 *
 * Owner, 2026-08-04: a colleague installed the bridge, and their agent still proposed Playwright
 * on the first unfamiliar field. Nothing was broken — the manual simply was not anywhere the agent
 * looks. `instructions` is handed over once at initialize, cold, before there is a page; the guide
 * shipped in this package sat in node_modules.
 *
 * So: one command, run in the project. It writes the full guide to a file and — the part that does
 * the work — puts a SHORT block in CLAUDE.md / AGENTS.md, which is loaded into every session.
 * The short block carries the one rule that gets broken (do not switch drivers) and a pointer to
 * the long one; a rule that is read every time beats a manual that is read once.
 *
 * Idempotent: the block is fenced by markers and rewritten in place on a second run, so nobody
 * ends up with three copies. It never touches anything else in the file.
 */
const BLOCK_START = '<!-- qiksy-bridge:start -->';
const BLOCK_END = '<!-- qiksy-bridge:end -->';

function pointerBlock(guidePath) {
  return `${BLOCK_START}
## Browser: Qiksy bridge (\`qa_*\` tools) — the FIRST browser tool in this project

The \`qa_*\` MCP tools drive **the browser that is already open**, with the real profile and the
real logins. Full guide: [${guidePath}](${guidePath}).

**Order of preference, and it is not a tie.** For anything that happens in a browser, reach for
the \`qa_*\` tools first — every time, including when another browser driver is configured in this
project. Hand over to a different driver only after the bridge has genuinely run out of road, and
only in this order: (1) name out loud which of the two missing capabilities the task needs
(**pixels** or **eval** — see below), (2) look at what the environment actually offers, (3) say
which tool you are switching to and why, (4) go back to the bridge for the rest of the run. A
control that refused, an unfamiliar widget or a slow page is NOT running out of road.

- **Do not switch to another browser driver** (Playwright, Puppeteer, Selenium, CDP) because a
  control looked unfamiliar or refused once. A second driver opens a DIFFERENT, EMPTY browser —
  none of these logins are in it, so the run stops being the test that was asked for.
- Only **one** thing is genuinely absent now: **eval** (no arbitrary
  JS — a Web Store requirement). Need one of them? Say which, and let the human decide.
- **A form is one call**: \`qa_fill_json { fields: { "Label": "value" }, advance: "Next" }\` — custom
  dropdowns, calendars, cascaders, trees, tags and time included.
- **A control refuses → the ladder**, in order: \`qa_probe { name }\` (what is this widget and which
  verb drives it) → \`raw: true\` → \`qa_pick_date\`/\`_time\`/\`_range\`/\`_path\`/\`_tags\` → a CSS selector
  (every verb takes one) → \`qa_click { name }\` and read the \`widget\` verdict → \`qa_focus_tab\` if the
  tab is in the background.
- **Reading is free and needs no consent**: \`qa_snapshot\` (+\`geometry:true\` for boxes in CSS pixels)
  · \`qa_read\` · \`qa_styles\` (computed styles + the design token) · \`qa_storage\` · \`qa_findings\`
  (failed requests arrive with the server's error body) · \`qa_axe\` · \`qa_focus_walk\`
  · \`qa_collect\` · \`qa_watch\`.
- **A TABLE INSTEAD OF A PAGE → \`qa_collect\`.** Name which nodes (selector / role / nameContains,
  scoped by \`within\`) and which properties to take — text, value, name, role, tag, selector, href,
  state, geometry, \`attr:<name>\`, \`style:<prop>\` — and the answer is that table, once. "Every row
  with its price", "every input with what it holds" is ONE call here and a dozen with snapshot plus
  read. \`value\` is what a control HOLDS, which a snapshot cannot tell you.
- **SOMETHING HAPPENS LATER → \`qa_watch\`.** Every other verb answers about NOW, so a toast that
  appears and leaves, a request on a timer, a late row or a live-region announcement are invisible
  to a snapshot taken before or after them, and polling misses the gaps between looks. Start a
  watch (\`mutations\` · \`network\` · \`console\` · \`announcements\`), do the thing, read the buffer.
  Every watch EXPIRES BY ITSELF — there is no "until stopped", because a watch left running is
  silent and the readings taken after it are the ones that go wrong.
- **ASK REPLIES FOR THE FIELDS YOU WANT.** The big reads take \`select\` (keep these paths) and
  \`omit\` (drop these): \`qa_snapshot { select: ["nodes[].name","nodes[].ref"] }\`. A path that
  matches nothing is reported with the names that ARE there, so a mistyped field costs one call
  rather than a bigger request.
- **THE BRIDGE GENUINELY CANNOT → \`qa_gap\`.** One sentence saying what was needed, and it lands in
  a file the human reads. This is the sanctioned way out of a dead end; the unsanctioned one — a
  quiet switch to another browser driver — ends the run's meaning. Use it for a missing capability,
  never for a control that refused once (that is the ladder above).
- **Acting** (\`qa_click\`, \`qa_type*\`, \`qa_fill_json\`, \`qa_upload\`, \`qa_navigate\`, \`qa_reload\`, \`qa_open_isolated\`,
  \`qa_mock\`) needs the one-time "Agent control" consent in the popup. A refusal there
  is the human's to clear: name the switch and stop, never work around it.
- **A control "disappeared" → look for \`modal\` in the reply BEFORE filing anything.** While a modal
  dialog or popover is open, the library marks the rest of the page aria-hidden, so the snapshot
  legitimately contains only that layer and \`qa_click\` legitimately cannot find anything outside
  it. The app is fine. Finish inside the layer, or close it (its own Close/Cancel/OK, or
  \`qa_press Escape\`) and snapshot again. A regression run once filed fifteen bugs against a
  healthy app for this one reason — none of them survived a re-test.
- **A native browser dialog is NOT clickable by anything** — "Leave site?", confirm(), alert(),
  prompt() are browser chrome, outside the document. Do not hunt for their buttons in the tree
  and do not report them as unreachable controls. \`qa_dialogs\` decides what they do instead.
- **The server will not produce the failure you need → \`qa_mock\`**: answer a request from a rule
  (a 500, an empty list, a 30s delay, a dropped connection) instead of waiting for the backend to
  misbehave. It covers the page's own fetch/XHR in the top frame — not documents, subresources,
  WebSocket or iframes. Clear the rules when the check is done; a forgotten mock outlives the
  reason for it and the next thing you measure is a lie.
${BLOCK_END}`;
}

/**
 * Write the guide + the CLAUDE.md/AGENTS.md pointer. Returns a report; prints NOTHING, because
 * the same code runs from the `init` command (where output is the point) and from the automatic
 * first run (where stdout is the JSON-RPC channel and one stray line breaks the session).
 */
function installDocs({ dir, out, withClaude = true }) {
  const guide = readFileSync(fileURLToPath(new URL('./AGENT-GUIDE.md', import.meta.url)), 'utf8');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, guide, 'utf8');

  const rel = out.startsWith(dir) ? out.slice(dir.length + 1) : out;
  const report = { guide: out, rel, block: pointerBlock(rel), touched: [], failed: [] };
  if (!withClaude) return report;

  const targets = ['CLAUDE.md', 'AGENTS.md'].map((f) => join(dir, f)).filter((p) => existsSync(p));
  // Neither exists: create the vendor-neutral one rather than assuming which agent this is.
  if (!targets.length) targets.push(join(dir, 'AGENTS.md'));

  for (const file of targets) {
    let body = '';
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      /* new file */
    }
    const a = body.indexOf(BLOCK_START);
    const b = body.indexOf(BLOCK_END);
    const fresh = !(a !== -1 && b !== -1 && b > a);
    const next = fresh
      ? body.trimEnd() + (body.trim() ? '\n\n' : '') + report.block + '\n'
      : body.slice(0, a) + report.block + body.slice(b + BLOCK_END.length);
    if (next === body) continue; // already exactly this — do not touch the mtime
    try {
      writeFileSync(file, next, 'utf8');
      report.touched.push({ file, action: fresh ? 'added' : 'refreshed' });
    } catch (e) {
      report.failed.push({ file, error: e.message });
    }
  }
  return report;
}

async function runInit(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const dir = resolve(flag('--dir') || process.cwd());
  const out = resolve(dir, flag('--out') || join('.claude', 'qiksy-bridge.md'));
  const say = (...a) => console.log(...a);
  const withClaude = !argv.includes('--no-claude');

  let report;
  try {
    report = installDocs({ dir, out, withClaude });
  } catch (e) {
    console.error(`qiksy-mcp init: ${e.message}`);
    process.exit(1);
  }
  say(`✓ wrote the agent guide → ${report.guide}`);
  if (!withClaude) {
    say('\n  (--no-claude) Paste this into CLAUDE.md / AGENTS.md yourself:\n');
    say(report.block);
    return;
  }
  for (const t of report.touched) say(`✓ ${t.action} the Qiksy block in ${t.file}`);
  for (const f of report.failed) console.error(`  could not write ${f.file} — ${f.error}`);

  if (!argv.includes('--no-connect')) await runConnect(argv, { after: true });
}

/**
 * THE WIRING, DONE BY THE THING THAT IS ALLOWED TO WRITE FILES.
 *
 * What used to be printed here was three steps in a terminal and a JSON file to edit by hand, and
 * that file is where people stop (owner, 20.09.2026: «технически многие вообще не шарят»). The
 * extension cannot do it — no filesystem, no processes — and the person should not have to, so
 * this process does: free port, token, every installed agent's config written, token on the
 * clipboard for the one paste that is left.
 *
 * It says what it TOUCHED and what it skipped, because a setup tool that writes into somebody's
 * machine and reports only success is the kind you uninstall.
 */
async function runConnect(argv, { after = false } = {}) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const say = (...a) => console.log(...a);
  let r;
  try {
    r = await connectAgents({
      dir: resolve(flag('--dir') || process.cwd()),
      port: Number(flag('--port')) || 0,
      token: flag('--token') || '',
      /* A hook RUNS A COMMAND every time the agent stops, which is more than an MCP entry does —
         so there is a way to say no without giving up the rest of the setup. */
      hook: !argv.includes('--no-hook'),
    });
  } catch (e) {
    console.error(`qiksy-mcp connect: ${e.message}`);
    process.exit(1);
  }

  say(after ? '' : '');
  if (!r.wrote.length) {
    say('No agent config found to write into. Looked for:');
    for (const s of r.skipped) say(`  · ${s.label} → ${s.file}`);
    say('\nOpen the project you work in and run this there, or paste the block from');
    say('https://qiksy.app/qa-copilot/ into your agent yourself.');
  }
  for (const w of r.wrote) say(`✓ ${w.action} the qiksy server in ${w.label} → ${w.file}`);
  for (const f of r.failed) console.error(`  could not write ${f.label} → ${f.file}: ${f.error}`);
  /* SAID OUT LOUD, ALWAYS. This one installs a command that will run on every stop — quietly
     doing that is how a helpful tool becomes one people distrust. */
  if (r.stopHook?.error) console.error(`  could not add the finish hook → ${r.stopHook.file}: ${r.stopHook.error}`);
  else if (r.stopHook) {
    say(`✓ ${r.stopHook.action} a finish hook in Claude Code → ${r.stopHook.file}`);
    say(`  It runs \`${r.stopHook.command}\` when the agent stops, so the tab pulses and the sound`);
    say('  plays the moment a run really ends. Remove that line, or re-run with --no-hook, to skip it.');
  }

  const clip = toClipboard(r.token);
  say(`
Port ${r.port}${r.reusedToken ? ' · kept the token already in your config' : ' · new token'}.

One step left, in the browser:
  Qiksy popup → "Agent bridge · MCP" → On → paste the token${clip ? ' (it is on your clipboard)' : ''}.${clip ? '' : `\n  Token: ${r.token}`}
  Then restart your agent and ask it to call qa_status.

The token never leaves this machine: it is what stops another local program from pretending to be
your browser. "Qiksy extension is not connected" means the popup toggle is off or the token and
port differ — it never means you should reach for another browser driver.`);
}

/**
 * THE DOCS INSTALL THEMSELVES, ON THE FIRST RUN IN A PROJECT.
 *
 * Owner, 2026-08-04: "чтобы сразу формировалась документация о возможностях этого MCP, чтобы Клод
 * сразу знал и это становилось приоритетным для него". A command nobody runs is a command that does
 * not exist — and the person wiring up an MCP server is exactly the person who will not read a
 * README step called "optional". The agent launches this process WITH THE PROJECT AS ITS CWD, so
 * the process already knows where the docs belong. It writes them.
 *
 * Four guards, because writing into somebody's repository uninvited is the kind of helpfulness that
 * gets a tool uninstalled:
 *   · only where a project actually is — a .git, a package.json, or an agent file already present.
 *     A bare $HOME or / gets nothing.
 *   · idempotent to the BYTE: identical content is not rewritten, so the mtime stays put and git
 *     stays quiet on every subsequent launch.
 *   · the pointer lives between markers and nothing outside them is ever touched.
 *   · QIKSY_MCP_NO_DOCS=1 turns the whole thing off.
 *
 * It runs BEFORE the transport connects, so the guide is on disk by the time the first tool call
 * arrives — and the greeting says what happened, because the CLAUDE.md block itself is read at the
 * START of a session and this one is already running: the block lands for the NEXT session, the
 * file is readable right now.
 */
let docsReport = null;
function autoInstallDocs() {
  if (process.env.QIKSY_MCP_NO_DOCS === '1') return;
  let dir;
  try {
    dir = process.cwd();
  } catch {
    return; // cwd deleted under us — nothing to write into
  }
  const looksLikeAProject =
    existsSync(join(dir, '.git')) ||
    existsSync(join(dir, 'package.json')) ||
    existsSync(join(dir, 'CLAUDE.md')) ||
    existsSync(join(dir, 'AGENTS.md'));
  if (!looksLikeAProject) return;
  if (dir === homedir() || dirname(dir) === dir) return;
  try {
    const out = resolve(dir, join('.claude', 'qiksy-bridge.md'));
    const report = installDocs({ dir, out });
    if (report.touched.length) {
      docsReport = {
        wrote: report.rel,
        andPointedFrom: report.touched.map((t) => basename(t.file)),
        readItNow:
          'The pointer in that file is loaded at the START of a session, so it takes effect next time. The guide itself is on disk right now — read it if a browser task comes up in this one.',
        turnOffWith: 'QIKSY_MCP_NO_DOCS=1',
      };
      log(`wrote the agent guide → ${report.rel} (+ ${report.touched.map((t) => basename(t.file)).join(', ')})`);
    }
  } catch (e) {
    log('could not write the agent guide:', e?.message || e); // never fatal — it is documentation
  }
}

/* BOTH SUBCOMMANDS END THE PROCESS, AND THE AWAIT IS THE POINT.
 *
 * Everything below this line boots a stdio MCP server. The first cut fired the async connect and
 * carried on, so `connect` wired the configs AND announced «MCP stdio server ready» — a setup
 * command turning itself into a bridge nobody asked for (seen in the first live run). Top-level
 * await holds the module here until the work is done, and then the process leaves. */
if (process.argv[2] === 'init') {
  await runInit(process.argv.slice(3));
  process.exit(0);
}
if (process.argv[2] === 'connect') {
  /* The wiring on its own, for somebody who already has the guide and just wants the link up
     (or is redoing it after changing editors). `init` runs both. */
  await runConnect(process.argv.slice(3));
  process.exit(0);
}
if (process.argv[2] === 'trust') {
  /**
   * «THIS BROWSER'S TOKEN IS FINE» — one command, no restarts.
   *
   *   npx qiksy-mcp trust <token>
   *
   * The popup of a browser whose token no agent knows shows this command with its own token
   * already in it. It adds the token to the shared file every bridge server on this computer reads
   * at each knock, so the hub already on the port lets that browser in the next time it retries,
   * which the extension does by itself within half a minute.
   */
  const token = String(process.argv[3] || '').trim();
  if (!tokenShapeOk(token)) {
    process.stderr.write('Usage: npx qiksy-mcp trust <token>  (the token from the Qiksy popup, 16+ letters and digits)\n');
    process.exit(2);
  }
  const r = rememberToken(token, 'trust command');
  process.stdout.write(
    r === 'refused'
      ? `Could not write ${TOKENS_FILE}. Check that the folder is writable.\n`
      : `${r === 'added' ? 'Added' : 'Already trusted'}: every Qiksy bridge on this computer now accepts this browser. It reconnects by itself within half a minute; nothing needs restarting.\n`,
  );
  process.exit(r === 'refused' ? 1 : 0);
}
/* EVERY SERVER REGISTERS THE TOKEN IT WAS STARTED WITH, so the hub that owns the port (started
   by another window, perhaps days ago, with a different token) accepts this window's browser and
   this window as a follower without either of them being restarted. */
if (TOKEN && (!process.argv[2] || process.argv[2].startsWith('--'))) rememberToken(TOKEN, 'agent window');
if (process.argv[2] === 'done') {
  /**
   * «THE RUN IS OVER» FROM OUTSIDE THE MODEL — for any agent whose client can run a command when
   * it finishes a turn (Claude Code's Stop hook, and the equivalent in the others).
   *
   * The verb `qa_done` is the ordinary route and every MCP client is told about it in the
   * instructions. This is the route that does not depend on a model remembering: a hook fires
   * whether or not the agent thought to say anything, so the person in the next room hears the
   * end of the run either way.
   *
   *   npx qiksy-mcp done            → the run ended well
   *   npx qiksy-mcp done --problem  → it ended badly
   *
   * It joins the bridge the SAME WAY a sibling agent window does, as a follower of whoever owns
   * the port — so it never takes the port, never disturbs a running session, and costs one
   * socket for under a second. If nothing is listening it says so and exits 0: a hook that fails
   * loudly because the browser is closed would be a hook people remove.
   */
  const bad = process.argv.includes('--problem');

  /* ONE ATTEMPT WITH ONE PAIRING. Resolves to the sentence to print, plus `refused` when the hub
     shut the door on us — which is the only failure worth trying a second key on. */
  const ring = (token, port) => new Promise((res) => {
    let ws;
    let answered = false;
    const give = (said, refused = false) => {
      if (answered) return;
      answered = true;
      try { ws?.close(); } catch { /* already gone */ }
      res({ said, refused });
    };
    const timer = setTimeout(() => give('no answer from the bridge'), 6000);
    try {
      ws = new WebSocket(`ws://${HOST}:${port}`);
    } catch {
      clearTimeout(timer);
      return give('could not reach the bridge');
    }
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, token, pid: process.pid })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'welcome') return ws.send(JSON.stringify({ t: 'req', id: 'done', tool: 'qa_done', args: { verdict: bad ? 'problem' : 'ok' }, timeoutMs: 5000, agent: MY_AGENT }));
      if (m.t === 'res') { clearTimeout(timer); give(m.result?.soundNote || m.error || 'done'); }
    });
    ws.on('error', () => { clearTimeout(timer); give('no bridge on this port'); });
    /* Closed before an answer = the token was refused. The hub says nothing more, by design: it
       is an authentication gate, and a gate that explains itself is a gate that helps a stranger. */
    ws.on('close', () => { clearTimeout(timer); give('the bridge closed the connection — the token it holds is a different one', true); });
  });

  /* TWO PLACES A TOKEN CAN COME FROM, AND THE ENVIRONMENT IS NOT THE TRUSTWORTHY ONE.
   *
   * A hook runs in a bare shell: no `env` block from the agent, so usually nothing — and sometimes
   * WORSE than nothing, because an old QIKSY_MCP_TOKEN left in a .zshenv from a previous setup is
   * exported into every shell on the machine and looks exactly like configuration. Found on the
   * owner's own machine 21.09.2026: the shell carried a token three generations old, the hub
   * refused it, and the command reported «the bridge closed the connection» — which reads as a
   * browser problem, so the search starts in the popup, which was never wrong.
   *
   * So the environment is tried FIRST (an explicit export must still win when it is right), and a
   * refusal falls through to the pairing the agent itself is using. Two attempts, never more. */
  const tries = [];
  if (TOKEN) tries.push({ token: TOKEN, port: PORT, from: 'the environment' });
  const p = pairingInPlace({ dir: process.cwd() });
  if (p.token && p.token !== TOKEN) {
    const own = portArg === -1 && !process.env.QIKSY_MCP_PORT && p.port ? p.port : PORT;
    tries.push({ token: p.token, port: own, from: 'your agent config' });
  }
  if (!tries.length) {
    /* Naming the missing half, because «the bridge closed the connection» sent the last person
       looking at the browser — the one part that was working. */
    log('no token: set QIKSY_MCP_TOKEN, or run `npx qiksy-mcp connect` in this project first');
    process.exit(0);
  }

  let last = '';
  for (const t of tries) {
    const r = await ring(t.token, t.port);
    last = r.said;
    if (!r.refused) break;
    /* Said out loud only when there IS a second key to try — otherwise it is noise on every stop. */
    if (t !== tries[tries.length - 1]) log(`the token in ${t.from} was refused — trying the one in your agent config`);
  }
  log(last);
  process.exit(0);
}

if (!TOKEN) {
  log('WARNING: QIKSY_MCP_TOKEN is not set. Set the same token here and in the Qiksy popup, or connections are refused.');
}

/* Our own token, or any token this computer trusts — read from the shared file at every knock, so
   a browser whose token was added a minute ago gets in without anybody restarting (tokens.mjs). */
function tokenOk(got) {
  return tokenTrusted(got, TOKEN);
}

// ── WebSocket bridge to the extension ──────────────────────────────────────
let client = null; // the PRIMARY browser: the oldest one still connected
/* EVERY BROWSER AT ONCE (owner, 02.11.2026): «открыл второй браузер, и весь бридж отключился».
   Until 1.82 the hub kept one browser slot and the newest knock took it, closing the old one with
   4004 — which that extension persists as «another browser took over» and never re-dials from. So
   opening a second Chrome profile silently killed the bridge in the first. Now every browser that
   knocks with a trusted token stays, oldest first; a call naming a tabId goes to the browser that
   owns that tab, any other call to the primary, and qa_tabs asks them all. */
const clients = [];
const tabOwner = new Map(); // tabId → the browser socket that listed it
// Set when the extension checked in only to report an expired licence — turns the
// generic 'not connected' into the actual reason.
let lapsed = false;
const pending = new Map(); // id → { resolve, reject, timer }

/* ── ONE BROWSER, MANY AGENT WINDOWS ────────────────────────────────────────
 * Every MCP client launches its OWN copy of this process, and the extension can
 * dial exactly ONE port (the popup has one field, the server keeps one client
 * slot). So the second agent window used to lose the race for the port and then
 * sit there as a socket-less zombie while every tool answered "extension is not
 * connected" — which sends the human into the popup, i.e. precisely the wrong
 * place. It cost half an hour to diagnose the first time.
 *
 * So the port elects a leader. Whoever binds it is the HUB and owns the
 * extension socket; anyone later becomes a FOLLOWER, dials the hub with the same
 * token and relays its tool calls one hop further. The extension knows nothing
 * about this — still one port, one socket, unchanged protocol. When the hub's
 * window closes its socket drops, the followers race for the port again, and the
 * extension reconnects on the backoff it already has.
 */
let role = 'starting'; // 'hub' | 'follower'
let hubSocket = null; // follower → its socket to the hub
const followers = new Set(); // hub → the sibling agent windows riding on it
let foreignPort = false; // the port is held by something that is not a Qiksy hub
/* Set when the process on the port answered like a Qiksy bridge and REFUSED us (close 4001).
   «Refused» and «not ours at all» are different problems with different repairs, and printing
   one list of three guesses for both is what cost a tester «very much time» (report, 21.09.2026). */
let portRefusedUs = false;

/**
 * WHO IS ON THE PORT — asked of the operating system, not guessed.
 *
 * The old message named three suspects at once («another process, a bridge running a different
 * token, or an OLDER qiksy-mcp») and left the reader to work out which. The holder's pid and
 * command line are one cheap call away on every machine this runs on, and a name ends the search
 * instead of starting it. Cached: this is a diagnostic, not a heartbeat.
 */
let holderCache = null;
function portHolder(port) {
  if (holderCache && Date.now() - holderCache.at < 5_000) return holderCache.text;
  let text = '';
  try {
    if (process.platform === 'win32') {
      const net = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 2000 });
      const line = (net.stdout || '').split('\n').find((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
      const pid = line?.trim().split(/\s+/).pop();
      if (pid) {
        const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 2000 });
        const name = (task.stdout || '').split(',')[0]?.replace(/"/g, '').trim();
        text = name ? `pid ${pid} (${name})` : `pid ${pid}`;
      }
    } else {
      const ls = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 2000 });
      const pid = (ls.stdout || '').trim().split('\n')[0];
      if (pid) {
        const ps = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 2000 });
        const cmd = (ps.stdout || '').trim().slice(0, 120);
        text = cmd ? `pid ${pid} — ${cmd}` : `pid ${pid}`;
      }
    }
  } catch {
    /* no lsof, no permission, a locked-down box: the message is still better without this line */
  }
  holderCache = { at: Date.now(), text };
  return text;
}
let wss = null;
let takeoverTimer = null;
let takeoverDelay = 400;

function openBridge() {
  const s = new WebSocketServer({ host: HOST, port: PORT });
  s.on('listening', () => {
    wss = s;
    role = 'hub';
    foreignPort = false;
    takeoverDelay = 400;
    log(`bridge listening on ws://${HOST}:${PORT} — token ${TOKEN ? 'set' : 'MISSING'}`);
  });
  s.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') {
      try {
        s.close();
      } catch {
        /* it never listened */
      }
      becomeFollower();
      return;
    }
    log('bridge error:', e?.message || e);
  });
  s.on('connection', onConnection);
}

/** Ride the hub that already owns the port: same frames, one hop further. */
function becomeFollower() {
  role = 'follower';
  let welcomed = false;
  let ws;
  try {
    ws = new WebSocket(`ws://${HOST}:${PORT}`);
  } catch {
    scheduleTakeover();
    return;
  }
  ws.on('open', () => {
    // `join`, NOT `hello`, and this matters: a hub running an OLDER qiksy-mcp knows only
    // `hello` and would take this socket for the browser — kicking the real extension out
    // of the client slot with 4004, which the extension PERSISTS as "another browser took
    // over" and does not re-dial from. An unknown frame type just gets us closed, which is
    // exactly the harmless outcome we want against an old hub.
    ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, token: TOKEN, pid: process.pid }));
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Only a hub that answers `role:'follower'` understood what we are. A bare welcome
    // means an older server that just put us in the browser slot — leave immediately.
    if (msg.t === 'welcome' && msg.role !== 'follower') {
      log('the process on the port is an older qiksy-mcp that cannot share it — backing off');
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      return;
    }
    if (msg.t === 'welcome') {
      welcomed = true;
      hubSocket = ws;
      foreignPort = false;
      takeoverDelay = 400;
      log(`another agent window owns ws://${HOST}:${PORT} — riding it as a follower`);
      return;
    }
    if (msg.t === 'res' && msg.id != null) settle(msg);
  });
  ws.on('close', (code) => {
    if (hubSocket === ws) hubSocket = null;
    // A "hub" that never welcomed us is not one: either a foreign process holds the
    // port or it runs a different token. Say THAT — blaming the extension for this
    // is the bug that started all of it.
    foreignPort = !welcomed;
    /* 4001 is OUR OWN refusal code: whatever is there speaks this protocol and turned us away,
       which can only be the token. Anything else — a silent close, a foreign server, a reset —
       is a different problem and must not borrow that sentence. */
    portRefusedUs = !welcomed && code === 4001;
    failPending(welcomed ? 'the agent window that owned the bridge closed mid-call' : bridgeUnavailableMessage());
    scheduleTakeover();
  });
  ws.on('error', () => {
    /* 'close' does the reporting */
  });
}

/** The hub went away → race for the port; whoever loses dials the new hub. */
function scheduleTakeover() {
  if (takeoverTimer || role === 'hub') return;
  const delay = takeoverDelay + Math.floor(Math.random() * 600);
  // A port held by a foreign process never frees up on its own — back off instead of
  // dialling it once a second for the rest of the session.
  takeoverDelay = Math.min(10_000, takeoverDelay * 2);
  takeoverTimer = setTimeout(() => {
    takeoverTimer = null;
    if (role !== 'hub') openBridge();
  }, delay);
}

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(String(msg.error || 'extension error')));
}

function failPending(why) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(why));
  }
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* the sibling window is gone; its own timeout covers it */
  }
}

/** Why a call cannot reach the browser — the reason, never a generic guess. */
function bridgeUnavailableMessage() {
  if (lapsed) {
    /* THIS CAN NOW ONLY BE AN OLD EXTENSION, AND THE ANSWER IS AN UPDATE, NOT A PAYMENT.
     *
     * Qiksy became free with extension 1.72.0: nothing is licensed and nothing lapses. But npm
     * publishes in a minute and the Chrome Web Store reviews for days, so this server will spend
     * a while talking to 1.71.0 and earlier, and those builds still dial in to report a lapsed
     * licence when their key or their trial ran out. Sending such a person to buy a key would be
     * taking money for something we no longer sell.
     *
     * The old wording also covered both endings on purpose (a trial and a licence), because a
     * paying customer told «your trial has ended» decides the message is about somebody else
     * and keeps hunting for a fault that does not exist. Same care applies here. */
    return (
      'This browser has an OLD Qiksy that still thinks the bridge needs a licence, and its key or trial ran out. ' +
      'NOTHING IS BROKEN, and nothing needs to be bought: Qiksy is free from version 1.72.0, bridge included. ' +
      'Update the extension (chrome://extensions, press Update) and it reconnects on its own, with no restart of this session. ' +
      'Until then the extension itself keeps working as before — every tab, the recorder, the pictures, the report.'
    );
  }
  if (foreignPort) {
    const who = portHolder(PORT);
    const holder = who ? ` The process holding it: ${who}.` : '';
    /* THE ONE FACT THIS PROCESS ALWAYS KNOWS ABOUT ITSELF comes first. A window started with no
       token is refused by every bridge there is, and no amount of looking at the port explains
       that — the answer is in this window's own environment (report, 21.09.2026: «as soon as the
       token matched — connected instantly», after a long hunt through the port). */
    if (!TOKEN) {
      return (
        `This window has no QIKSY_MCP_TOKEN, so the bridge already on port ${PORT} refuses it — the token is the reason, ` +
        `not the port.${holder} Put the same token in this window's MCP config (env QIKSY_MCP_TOKEN) as the one in the ` +
        'Qiksy popup — `npx qiksy-mcp connect` writes it for you and keeps the pairing you already have.'
      );
    }
    if (portRefusedUs) {
      return (
        `Port ${PORT} is held by another Qiksy bridge, and it REFUSED this window's token — so the two are running ` +
        `different tokens.${holder} Nothing here is fixed in the popup. Give both windows the same token (\`npx qiksy-mcp connect\` ` +
        'in each project writes the pairing you already have), or give this window its own port (--port / QIKSY_MCP_PORT).'
      );
    }
    return (
      `Port ${PORT} is held by a process that is not a Qiksy bridge this one can share with — either something else ` +
      `entirely, or an OLDER qiksy-mcp (pre-1.1) that cannot host sibling agent windows.${holder} The extension itself is ` +
      'probably fine — this is NOT fixed in the popup. Restart or update whatever owns the port, or give this window its ' +
      'own port (--port / QIKSY_MCP_PORT).'
    );
  }
  if (role === 'follower') {
    return 'The agent window that owned this bridge just dropped; the port is being taken over automatically. Try again in a moment.';
  }
  return 'Qiksy extension is not connected. Open Chrome with the extension and enable the MCP bridge in its popup (matching token & port).';
}

openBridge();

function onConnection(ws, req) {
  const origin = req.headers.origin || '';
  // Only the extension should connect; a real web page has an http(s)/null origin.
  if (origin && !origin.startsWith('chrome-extension://')) {
    ws.close(4003, 'forbidden origin');
    return;
  }
  let authed = false;
  let isFollower = false; // a sibling agent window, not a browser
  const helloTimer = setTimeout(() => {
    if (!authed) ws.close(4001, 'no hello');
  }, 2000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!authed) {
      if ((msg.t !== 'hello' && msg.t !== 'join') || !tokenOk(msg.token)) {
        clearTimeout(helloTimer);
        ws.close(4001, 'auth failed');
        return;
      }
      clearTimeout(helloTimer);
      // A sibling agent window, not a browser. It relays its tool calls through us and
      // never touches the extension's slot — that is the whole difference between "many
      // agents, one browser" and two windows kicking each other off.
      if (msg.t === 'join') {
        authed = true;
        isFollower = true;
        followers.add(ws);
        safeSend(ws, { t: 'welcome', v: PROTOCOL_VERSION, role: 'follower' });
        log(`another agent window joined as a follower (pid ${msg.pid ?? '?'}) — ${followers.size} riding this bridge`);
        return;
      }
      // The extension dials in ONLY to say its licence lapsed, then hangs up. It
      // is not a client — remember the reason so every tool call answers with a
      // sentence a human can act on, instead of the generic "not connected",
      // which reads like a broken port or a bad token and sends people digging
      // in the wrong place.
      // KEPT FOR OLD BUILDS ONLY. From extension 1.72.0 nothing is licensed, so nothing sends
      // this; 1.71.0 and earlier still do, and they live on in the Store until review passes.
      if (msg.lapsed) {
        lapsed = true;
        log('an old extension reports a lapsed licence — it needs updating, not paying');
        ws.close(4002, 'lapsed');
        return;
      }
      authed = true;
      lapsed = false;
      // A second browser JOINS; nobody is closed with 4004 any more (see `clients`). The same
      // browser knocking again (its worker restarted) is a new socket and the old one is dead or
      // about to be, so it simply drops out on its own close.
      if (!clients.includes(ws)) clients.push(ws);
      client = clients.find((c) => c.readyState === WebSocket.OPEN) ?? ws;
      ws.send(JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION }));
      const many = clients.length > 1 ? ` (${clients.length} browsers on this bridge)` : '';
      log(QUIPS_ON ? `${face(true)}  extension connected${many} — ${quip()}` : `extension connected${many}`);
      return;
    }
    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
      return;
    }
    /* THE ONE THING THE BROWSER SIDE MAY ASK FOR: file this document under the project.
     *
     * Deliberately narrow. The extension sends a name and the bytes; THIS side decides the
     * folder, because a directory chosen by the browser side is a directory chosen by a web page
     * one bug later. The name is reduced to a bare file name for the same reason — `..` and `/`
     * are how «a report» becomes «a file anywhere on this disk». Followers cannot use it: the
     * frame is only honoured on the extension's own connection. */
    if (msg.t === 'file' && msg.id && !isFollower) {
      const reply = (ok, extra) => safeSend(ws, { t: 'filed', id: msg.id, ok, ...extra });
      try {
        const dir = whereReportsGo();
        if (!dir) { reply(false, { error: 'no project folder here — the agent was started outside one, or QIKSY_REPORTS_DIR is off' }); return; }
        const name = basename(String(msg.name || '')).replace(/[^\w.@-]+/g, '-').slice(0, 120) || 'report.html';
        const full = join(dir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(full, String(msg.content ?? ''), 'utf8');
        log(`filed ${name} → ${dir}`);
        reply(true, { path: full });
      } catch (e) {
        reply(false, { error: e?.message || String(e) });
      }
      return;
    }
    // A follower's call: run it against the extension as if it were ours and hand the
    // answer back under the follower's own id. Ours is a fresh randomUUID, so the two
    // id spaces cannot collide.
    if (msg.t === 'req' && isFollower) {
      /* A REAL full stop from a sibling window or from `npx qiksy-mcp done` — the Stop hook's
         route into this process. Our OWN estimate travels the same way when a follower guesses,
         which is why the flag it carries is checked here: a guess must not teach the hub that
         this setup reports its endings. */
      if (msg.tool === 'qa_done' && !msg.args?.guessed) noteRealDone();
      /* Whose call it is. A follower from before this field sends none, and then the old
         machine-wide rule applies to it unchanged. */
      callExtension(msg.tool, msg.args, msg.timeoutMs, typeof msg.agent === 'string' ? msg.agent : null)
        .then((result) => safeSend(ws, { t: 'res', id: msg.id, ok: true, result }))
        .catch((err) => safeSend(ws, { t: 'res', id: msg.id, ok: false, error: err?.message || String(err) }));
      return;
    }
    if (msg.t === 'res' && msg.id != null) settle(msg);
  });

  ws.on('close', () => {
    if (followers.delete(ws)) log(`a follower window left — ${followers.size} still riding this bridge`);
    const at = clients.indexOf(ws);
    if (at !== -1) {
      clients.splice(at, 1);
      for (const [id, owner] of tabOwner) if (owner === ws) tabOwner.delete(id);
      client = clients.find((c) => c.readyState === WebSocket.OPEN) ?? null;
      log(clients.length ? `a browser disconnected — ${clients.length} still on this bridge` : 'extension disconnected');
    }
  });
}

/** The one choke point every tool goes through — hence the only place that has to
 *  know whether this window owns the bridge or rides someone else's. */
/** What the person set the panel to — filled in by the first reply that carries it. */
let uiLanguage = '';

/**
 * GUESSING THE END OF A RUN — OFF BY DEFAULT SINCE 1.64.0, AND THE REASON IS WORTH KEEPING.
 *
 * It was added on 21.09.2026 to cover clients that never call `qa_done`: the person updates,
 * everything is on, and they hear nothing. The guess is silence — no bridge call for a while means
 * the run is over — and it was defended as safe to be wrong, because a later call cancels the
 * pulse and the extension refuses to sound twice in half a minute.
 *
 * THAT DEFENCE ONLY COVERED THE PULSE. A sound cannot be cancelled after it has been heard, and
 * the silence it keys on is not silence at all: an agent that walked away from the browser to read
 * files, edit code or think makes no bridge call for MINUTES while working flat out. So the signal
 * arrived mid-run, and again on the next lull, and again — which is exactly what the owner
 * reported hearing (28.09.2026: «звук отрабатывает, а агент продолжает маслать… QADone несколько
 * раз отрабатывает, то есть он не по окончанию»). His ruling covers the mark as well as the
 * sound: both announce the END of a task, so neither may fire on a guess.
 *
 * A signal that is right most of the time is worse than no signal, because it is learned as noise
 * and then switched off — taking the true ones with it.
 *
 * WHAT REPLACES IT IS NOT NOTHING. Two routes report a real full stop, and `connect` writes the
 * second one into the client's settings, so an ordinary install has it:
 *   · the agent calling `qa_done` itself, which every client is told about at `initialize`;
 *   · a Stop hook running `npx qiksy-mcp done`, which fires whether or not the model remembered.
 * The guess survives as an opt-in for a client that has neither: `QIKSY_MCP_DONE_AFTER=<seconds>`.
 */
const DONE_AFTER_MS = (() => {
  const raw = process.env.QIKSY_MCP_DONE_AFTER;
  const n = Number(raw);
  /* Below twenty seconds this would fire inside an ordinary pause for thought, so a smaller
     number is refused rather than honoured. Anything else, including nothing at all, is off. */
  return Number.isFinite(n) && n >= 20 ? n * 1000 : 0;
})();
let doneTimer = null;
let workSinceDone = false;
/**
 * A SETUP THAT REPORTS ITS OWN FULL STOP NEEDS NO GUESS, and the guess is the part that can be
 * wrong. One real `qa_done` proves this client has a working route, so the estimate stands down
 * for the rest of the process — nobody has to notice that they opted into both.
 */
let realDoneSeen = false;

/** Called where a REAL full stop enters this process, and nowhere else — never from `fireDone`. */
function noteRealDone() {
  if (realDoneSeen) return;
  realDoneSeen = true;
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = null;
  workSinceDone = false;
  if (DONE_AFTER_MS) log('▸ this setup announces the end of a run itself — the quiet-timer guess is off from here on');
}

function fireDone() {
  doneTimer = null;
  if (!workSinceDone || realDoneSeen) return;
  workSinceDone = false;
  log(`▸ quiet for ${Math.round(DONE_AFTER_MS / 1000)}s after a run — saying it has finished`);
  /* Failure here is nothing: the browser may have gone, the tab may have closed. The pulse is a
     courtesy, and a courtesy that throws is worse than one that does not happen. */
  callExtension('qa_done', { verdict: 'ok', guessed: true }, 8_000).catch(() => {});
}

/** Called when a call FINISHES, not when it starts: a slow verb must not look like silence. */
function armDone(tool) {
  if (!DONE_AFTER_MS || realDoneSeen) return;
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = null;
  if (tool === 'qa_done') {
    /* Said out loud already — nothing left to announce until there is new work. */
    workSinceDone = false;
    return;
  }
  workSinceDone = true;
  doneTimer = setTimeout(fireDone, DONE_AFTER_MS);
  /* A pending timer must never be the reason this process stays alive. */
  doneTimer.unref?.();
}

/**
 * DID THIS SESSION DO ANYTHING SINCE ITS OWN LAST FULL STOP — kept here, on the hub, because the
 * hub is the one place every session's calls pass through.
 *
 * `true` after any call, `false` after its finish was announced, and ABSENT for a session that has
 * never used the bridge since this hub started. Absent is answered like `false`: that is the
 * session whose Stop hook used to ring for somebody else's run, which is the whole bug. The cost is
 * one silent finish for a session that worked before a hub change, which is rare and quiet, against
 * a sound in the middle of a run, which is frequent and wrong.
 */
const workedBy = new Map();

/**
 * Decide a call on its way to the extension. Returns `{ args }` to send (a finish that is really
 * this session's carries `vouched`, so the extension does not consult its one machine-wide flag),
 * or `{ answer }` to reply with instead of disturbing the browser at all.
 */
function finishGate(agent, tool, args) {
  if (!agent) return { args };
  if (tool !== 'qa_done') {
    workedBy.set(agent, true);
    return { args };
  }
  if (workedBy.get(agent) !== true) {
    return {
      answer: {
        ok: true,
        pulsing: 0,
        /* The extension's own word for the same silence: one vocabulary for an agent to learn. */
        sound: 'nothing-happened',
        note: 'This agent session did nothing through the bridge since its last full stop, so there is nothing to announce. Another session may be working; its own end will sound.',
        soundNote: 'Silent: this session did nothing through the bridge since its last full stop.',
      },
    };
  }
  workedBy.set(agent, false);
  return { args: { ...(args || {}), vouched: true } };
}

function callExtension(tool, args, timeoutMs = 15_000, agent = MY_AGENT) {
  /* The gate runs where the call reaches the browser: on the hub. A follower only carries its
     session along, and the hub decides for everybody with one map. */
  if (role !== 'follower') {
    const gate = finishGate(agent, tool, args);
    if (gate.answer) return Promise.resolve(gate.answer);
    args = gate.args;
  }
  // The same choke point is where the voice watches the session: one place, both roles.
  noticedCall(tool);
  const watch = (p) =>
    p.then(
      (r) => {
        noticedResult(tool, r);
        armDone(tool);
        /* THE HUMAN'S LANGUAGE, learned rather than guessed. This process never sees the
           conversation, so it cannot know what language they write in — but they told the panel
           directly by choosing one, and the extension sends that along with every bundle. One
           choke point, so no reply has to remember to do it. */
        const lang = r?.env?.uiLanguage;
        if (typeof lang === 'string' && lang) uiLanguage = lang;
        return r;
      },
      (e) => {
        noticedResult(tool, null);
        /* A call that FAILED is still the agent having been here — the run is just as over when
           the last thing it did did not work. */
        armDone(tool);
        throw e;
      },
    );
  if (role === 'follower') return watch(callHub(tool, args, timeoutMs));
  return watch(routeToBrowser(tool, args, timeoutMs));
}

function sendToBrowser(ws, tool, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(bridgeUnavailableMessage()));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${tool}". Is a normal web page focused in Chrome?`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (QUIPS_ON) log(`▸ ${tool}  ${face()}  ${quip()}`);
    ws.send(JSON.stringify({ t: 'req', id, tool, args: args || {} }));
  });
}

const openBrowsers = () => clients.filter((c) => c.readyState === WebSocket.OPEN);

/** qa_tabs from every browser, merged, each tab marked with which browser holds it. A browser
 *  that does not answer is left out rather than failing the list the others gave. */
async function tabsOfAllBrowsers(timeoutMs) {
  const open = openBrowsers();
  const answers = await Promise.all(open.map((ws) => sendToBrowser(ws, 'qa_tabs', {}, timeoutMs).catch(() => null)));
  const tabs = [];
  answers.forEach((r, i) => {
    for (const t of r?.tabs || []) {
      if (t?.tabId != null) tabOwner.set(t.tabId, open[i]);
      tabs.push({ ...t, browser: i + 1 });
    }
  });
  if (answers.every((r) => r === null)) throw new Error(bridgeUnavailableMessage());
  return { tabs, isolated: tabs.filter((t) => t.isolatedSession), browsers: open.length };
}

async function routeToBrowser(tool, args, timeoutMs) {
  const open = openBrowsers();
  if (open.length <= 1) {
    const r = await sendToBrowser(open[0] ?? client, tool, args, timeoutMs);
    if (tool === 'qa_tabs') for (const t of r?.tabs || []) if (t?.tabId != null) tabOwner.set(t.tabId, open[0]);
    return r;
  }
  if (tool === 'qa_tabs') return tabsOfAllBrowsers(timeoutMs);
  const tabId = args?.tabId;
  let target = tabId != null ? tabOwner.get(tabId) : null;
  /* A tab nobody has listed yet (the agent kept an id from before, or the tab is new): ask every
     browser once, then route. Without a tabId the call goes to the primary, as it always did. */
  if (tabId != null && (!target || target.readyState !== WebSocket.OPEN)) {
    await tabsOfAllBrowsers(Math.min(timeoutMs, 15_000)).catch(() => null);
    target = tabOwner.get(tabId);
  }
  if (!target || target.readyState !== WebSocket.OPEN) target = client;
  const r = await sendToBrowser(target, tool, args, timeoutMs);
  /* A tab this call opened belongs to the browser that opened it. */
  if (r && typeof r === 'object' && r.tabId != null && !tabOwner.has(r.tabId)) tabOwner.set(r.tabId, target);
  return r;
}

/** Same call, one hop further: through the agent window that owns the port. */
function callHub(tool, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(bridgeUnavailableMessage()));
      return;
    }
    const id = randomUUID();
    // A margin over the hub's own timeout, so ITS message ("is a normal web page
    // focused?") is what the agent sees instead of a relay timeout that says nothing.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs + 2_000}ms relaying "${tool}" through the agent window that owns the bridge.`));
    }, timeoutMs + 2_000);
    pending.set(id, { resolve, reject, timer });
    if (QUIPS_ON) log(`▸ ${tool} (via the hub window)  ${face()}  ${quip()}`);
    hubSocket.send(JSON.stringify({ t: 'req', id, tool, args: args || {}, timeoutMs, agent: MY_AGENT }));
  });
}

// ── MCP server + tools (read-only) ─────────────────────────────────────────
/* The humour used to live only in the stderr log, where nobody looks (owner ask
 * 2026-07-26: "хотелось бы рожиц"). A client draws the tool row as `Qiksy [qa_tabs]` —
 * the bracketed part is the tool NAME and MCP names are `[a-zA-Z0-9_-]` only, so a face
 * cannot go there. The result CAN: it rides as its own leading content block, so the
 * payload block below it stays byte-identical for anything that parses it.
 * Failures stay face-free on purpose — a joke on top of an error competes with the one
 * sentence the human needs to act on. */
/* The trailing newline is not cosmetic slop: a client concatenates the content blocks with
 * nothing between them, so without it the payload starts on the same line as the face
 * (`…undocumented features{` — seen live 2026-07-26). */
const decor = () => (QUIPS_ON ? [{ type: 'text', text: `qx ${face()}${quipDue() ? `  ${quip()}` : ''}\n` }] : []);
/* A LOADER for the calls that take a while (owner ask 2026-07-26). An audit, a report or a
 * snapshot of a heavy page leaves the tool row sitting dead for seconds, and a human cannot
 * tell "working" from "hung". MCP has progress notifications, so we send frames while the
 * extension is busy; a client that ignores them loses nothing. Only when the caller passed a
 * progressToken — otherwise there is nobody to notify. */
const BAR = ['[▰▱▱▱▱]', '[▰▰▱▱▱]', '[▰▰▰▱▱]', '[▰▰▰▰▱]', '[▰▰▰▰▰]'];
function loader(extra, label) {
  const token = extra?._meta?.progressToken;
  if (!token || !QUIPS_ON || typeof extra?.sendNotification !== 'function') return { stop() {} };
  let i = 0;
  const beat = () => {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: (i % BAR.length) + 1, total: BAR.length, message: `qx ${BAR[i % BAR.length]}  ${label}` },
      })
      .catch(() => {
        /* the client hung up, or does not implement progress */
      });
    i++;
  };
  beat();
  const timer = setInterval(beat, 700);
  return { stop: () => clearInterval(timer) };
}

/* Every successful result leaves through here, which is why the situational voice hangs on it and
   not on individual verbs: a character that only speaks up on the handful of tools someone
   remembered to wire is a character with holes in it. The reply time is stamped here too — the
   silence between this moment and the next call IS the model's thinking time, and there is nowhere
   else in the process that can see it. */
const asText = (v) => {
  const out = withStuckHelp(withNoticed(v));
  seen.lastReplyAt = Date.now();
  return { content: [...decor(), { type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
};
const asError = (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  const help = stuckHelp(msg);
  return {
    isError: true,
    content: [{ type: 'text', text: help ? `${msg}\n\n${JSON.stringify(help, null, 2)}` : msg }],
  };
};

/* ── THE MOMENT SOMEBODY SWITCHES DRIVERS ──────────────────────────────────────
 *
 * Owner, 2026-08-04, watching a colleague's agent: it hit one unfamiliar field and immediately
 * proposed wiring up Playwright — with the whole ladder documented, and the documentation two
 * hundred lines above in a manual read once at initialize.
 *
 * A rule an agent reads when it is calm does not survive the call where it is stuck. So the help
 * rides the FAILURE ITSELF: the reply that says "no" also says what the next call is. Four kinds,
 * because there are only four ways a session goes wrong here, and each has a different owner:
 * a gate the HUMAN must open, a bridge the HUMAN must switch on, a tab the HUMAN must attach —
 * and a widget, which is the agent's own next call and the one that gets abandoned.
 *
 * Rate-limited per kind: the first two failures carry the whole ladder, after that a pointer. The
 * ladder is worth its tokens the first time and is noise the fifth.
 */
const helpSeen = new Map();
function stuckHelp(text) {
  const s = String(text || '');
  if (!s) return null;
  let kind = null;
  if (/pro[- ]required|consent[- ]required|agent control|"drive"|licence|license/i.test(s)) kind = 'gate';
  else if (/not connected|trial has ended|bridge is closed|held by|taking over|owned this bridge/i.test(s)) kind = 'offline';
  /* «No active tab» and «not in the QA session» are the same dead end as out-of-scope, and they
     carried no way out, so a fresh agent stopped there (owner, 03.11.2026: «если нет вкладки
     открытой, бридж просто останавливается, не открывает для себя новую»). */
  else if (/out.of.scope|not in the agent session|not in the QA session|attach the tab|no active tab|no tab to/i.test(s)) kind = 'scope';
  else kind = 'widget';

  const n = (helpSeen.get(kind) || 0) + 1;
  helpSeen.set(kind, n);
  const brief = n > 2;

  if (kind === 'gate') {
    return brief
      ? { stayHere: 'A switch the human flips — name it and stop. Another browser driver does not open it, and would leave their session behind.' }
      : {
          whoFixesThis: 'The human, in the Qiksy popup — not you, and not a different tool.',
          sayThis: 'Name the exact switch (the "Agent control" consent in the popup) and stop there. It takes them one click, and it is free.',
          stayHere:
            'Do NOT reach for Playwright/Puppeteer/CDP instead. A second driver opens an EMPTY browser without these logins, so the run would no longer be the test they asked for. Reading (snapshot, read, styles, storage, findings, audits) still works right now — say what you CAN still do while they decide.',
        };
  }
  if (kind === 'offline') {
    return brief
      ? { stayHere: 'The bridge is off or its port is taken — the human turns it on. Report it plainly, do not retry in a loop and do not swap drivers.' }
      : {
          whoFixesThis: 'The human: the MCP-bridge toggle in the Qiksy popup (matching token and port), or whatever else holds the port.',
          sayThis: 'One sentence naming which of the two it is. Then stop; retrying in a loop finds nothing new.',
          stayHere:
            'This is NOT a reason to start another browser driver. Their logged-in browser is the whole point of the session; an empty Chromium is not a substitute for it, and switching quietly changes what the results mean.',
        };
  }
  if (kind === 'scope') {
    /* THE DEAD END HAS TO NAME ITS OWN WAY OUT. This refusal used to end at «open it in a tab
       yourself», and the only reliable way to do that — anchoring on a window the bridge can
       already see — lived in one person's notes rather than in the product. So every fresh agent
       rediscovered the dead end and stopped there, and the person watching saw the bridge give up
       (owner, 30.09.2026). `qa_open_tab` is that way out, and it belongs in the answer that
       refuses, not two hundred lines up in a manual read once at initialize. */
    return brief
      ? { nextCall: 'qa_open_tab { url } — open the page YOURSELF as a new tab in their own browser, then carry on in it. Do not stop and do not ask the human first.' }
      : {
          whyThisHappened: 'The agent session is a SET of tabs the human opted into, and the page you need is not in it, or no tab is open at all — by design, so nothing you do can wander into their mail or bank.',
          nextCall:
            'qa_open_tab { url } — open the page YOURSELF, now, as a NEW tab in the very browser this bridge is connected to, losing nothing, and carry on in it with the tabId it returns. Do not stop here and do not ask the human to open it: this is your step. qa_tabs shows what IS attached; a tab opened BY an attached tab joins automatically.',
          sayThis:
            'Only if the new tab comes back with inSession:false: ask them in one sentence to attach it (the popup switch "Agent drives this tab", or right-click on the page → "Qiksy — test this tab"), and keep doing what needs no browser meanwhile.',
          stayHere: 'Do not open the page in another driver to get around the boundary — that browser has none of their sessions in it anyway.',
        };
  }
  return brief
    ? { nextCall: 'qa_probe { name } — what this widget is and which verb drives it. Then raw:true, then the qa_pick_* verb, then a CSS selector.' }
    : {
        theLadder: [
          'qa_probe { name } — what IS this control and which verb drives it. One call; it also reads a widget hand-rolled from <div>s.',
          'raw: true — write the value straight into the control\'s own text input (dates, times, range ends, tags, creatable selects).',
          'the shape\'s own verb — qa_pick_date · qa_pick_time · qa_pick_range · qa_pick_path (cascader/tree) · qa_pick_tags.',
          'a CSS selector — every verb takes one, and a portalled popup with no roles (Ant) is meant to be driven that way.',
          'qa_click by NAME, then read the `widget` verdict in the reply and act on that.',
          'background tab? custom popovers only render in the foreground — qa_focus_tab, then retry.',
        ],
        stayHere:
          'A control that refuses is a rung on this ladder, not a missing capability. Do not switch to Playwright/Puppeteer/CDP over it: that opens a DIFFERENT, empty browser without the human\'s logins, and the rest of the run stops being the test they asked for. If you genuinely need pixels or arbitrary JS — the only two things absent here — say so and let them decide.',
        /* AND WHEN IT REALLY IS A MISSING CAPABILITY, THERE IS A PLACE TO PUT IT.
         *
         * The ladder above answers the common case: the control can be driven and the call was
         * wrong. The rare case — the bridge genuinely cannot — used to end in silence or in a
         * driver swap, and either way nobody learned anything. It rides only the FIRST couple of
         * widget failures, with the rest of the ladder: an invitation repeated on every refusal
         * would be read as the answer rather than as the last resort. */
        ...gapInvite('the verb you were using'),
      };
}

/**
 * `trusted: false` IS A FACT, NOT A VERDICT — and on its own it reads as one.
 *
 * A session drove Figma on 12.10.2026, saw the bare flag on qa_click_point, read it as «this will
 * not work here», told the owner there was a wall and filed a gap. There was no wall: the canvas
 * took a qa_drag_point perfectly and made a Rectangle layer; only the KEYBOARD was swallowed.
 * Twenty minutes and a false report, from a true flag with no sentence attached to it.
 *
 * The flag stays — a page that checks `isTrusted` really will ignore this and say nothing, and
 * hiding that would be worse. What it gains is the other half of the truth: canvas applications,
 * which are the entire reason this verb exists, do NOT check it. So the thing to judge by is what
 * happened on the page, which the reply already carries.
 */
/* A REAL MOUSE, WHEN A PAGE REFUSES A SYNTHETIC ONE (owner, 03.11.2026: «если нет клика мышкой по
 * координатам… чтобы бридж рекомендовал установить утилиту»). The extension cannot make a trusted
 * event and must not try; the operating system can, with a small tool the agent can run from its
 * terminal. The bridge only says which one and how — installing is the person's call, so the agent
 * asks first. Windows needs nothing installed: PowerShell reaches user32 itself. */
const REAL_MOUSE =
  'IF THE PAGE IGNORED THIS CLICK (it checks isTrusted), a real click comes from the operating system, run from your terminal. ' +
  'Ask the person before installing anything. macOS: `brew install cliclick`, then `cliclick c:X,Y`; the terminal app needs Accessibility permission (System Settings → Privacy & Security → Accessibility). ' +
  'Windows, nothing to install: PowerShell `Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);\' -Name M -Namespace W; [W.M]::SetCursorPos(X,Y); [W.M]::mouse_event(2,0,0,0,0); [W.M]::mouse_event(4,0,0,0,0)`; or AutoHotkey (`winget install AutoHotkey.AutoHotkey`, `Click X, Y`). ' +
  'Linux on X11: `xdotool mousemove X Y click 1` (`sudo apt install xdotool`); on Wayland, ydotool. ' +
  'X,Y there are SCREEN coordinates, not the viewport\'s: the Chrome window\'s top-left (macOS: `osascript -e \'tell application "Google Chrome" to get bounds of front window\'`) plus the toolbar height, plus this point times the page zoom; Windows counts physical pixels, so multiply by the display scale. ' +
  'A real click brings Chrome to the front: say so before you do it.';

function withTrustedNote(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.trusted !== false) return v;
  return {
    ...v,
    realMouse: REAL_MOUSE,
    trustedMeans:
      'The events are synthetic (isTrusted: false). That is not a prediction of failure: the canvas applications this verb exists for — Figma, Miro, Canva, Google Docs — do not check the flag and take these events normally. Judge by what the page DID (the `changed` diff, a new layer, a moved shape), never by this flag. It matters on hardened sign-in and payment widgets, which check it and ignore the click in silence.',
  };
}

/** Attach the ladder to a refusal on its way out, so the "no" and the next call arrive together. */
function withStuckHelp(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.ok !== false) return v;
  if (v.whatNow) return v;
  const help = stuckHelp(`${v.error || ''} ${v.note || ''} ${v.stopped || ''}`.trim() || 'refused');
  return help ? { ...v, whatNow: help } : v;
}

/* ── PAGE MEMORY, JOURNAL, RECIPES ───────────────────────────────────────────────
 *
 * WHY ANY OF THIS IS HERE (2026-07-29, from a real session on a long multi-step form).
 *
 * An agent drove an eight-step wizard — a select, a date and an upload on every step — and it
 * took minutes. Then it drove the SAME wizard again and took just as long. Both halves of that
 * were our fault, and neither was in the extension:
 *
 *   1. It filled only plain inputs in a batch, because `qa_type_many`'s description mentioned
 *      only select/checkbox/radio. The engine behind it drives Radix/MUI/react-select popovers
 *      and date pickers too, so the agent took the click → snapshot → click path for every
 *      widget, paying a settle window twice per field for nothing. Fixed by SAYING so, in the
 *      tool description and in INSTRUCTIONS — the description IS the interface.
 *   2. Nothing carried over between runs. Refs live for one snapshot, and the extension's own
 *      per-site presets have no MCP verb, so the second pass rediscovered the whole form.
 *
 * So this process — ordinary Node, with a filesystem the content script does not have — keeps
 * three things: the last snapshot per tab (so a ref can be turned back into a field NAME), a
 * journal of what was actually filled, and recipes on disk. `qa_recipe_save` turns the journal
 * into a replayable plan; `qa_recipe_apply` replays it one step per call, matching by accessible
 * name against a fresh snapshot. That is the only part of "learning" that survives a new
 * session, a new agent and a page whose refs have all changed.
 *
 * Deliberately NOT in the extension: a recipe is the AGENT's plan, not the browser's state, and
 * everything here works against the shipped extension with no Web Store release.
 */
const tabKey = (tabId) => (tabId == null ? 'active' : String(tabId));
/* A LABEL AS A KEY, normalised the way a human would read it.
 *
 * Real forms put the required marker inside the label — `<label>Full name <span>*</span></label>`
 * — so the accessible name the page hands over is "Full name *", and a dataset written by a
 * person says "Full name". Trailing markers and punctuation are noise for matching (the snapshot
 * already reports required-ness as state), so they come off here, once, for every path that
 * matches by name: qa_fill_json, recipes, and click-by-name. Found on the 6-step wizard. */
const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // Zero-width characters are NOT \s, and React libraries emit them inside labels: the live
    // React stand reported "Legal entity name *\u200b", which no trailing-star trim would catch.
    .replace(/[\s*:•?\u200b\u200c\u200d\ufeff]+$/, '')
    .trim()
    .toLowerCase();
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

/** Roles worth clicking when a value says so — buttons, chips, custom radios, tabs. */
const CLICKABLE_ROLES = new Set(['button', 'link', 'tab', 'radio', 'checkbox', 'switch', 'option', 'menuitem', 'combobox', 'gridcell']);

/** Roles a form control can have in the snapshot — see roleOf() in snapshot-a11y.ts. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
/** A form control by role OR by tag — `input[type=file]` reads as role `button`, and an upload field is a field. */
const isFieldNode = (n) => FIELD_ROLES.has(n.role) || FIELD_TAGS.has(n.tag);

/* WHICH ROUTE WORKED, per host+field. Discovery is fine once; repeating it on every field of every
 * run is what the owner watched and called out: "почему ты так долго залипаешь на селектах?
 * ArrowDown, ArrowUp, ArrowDown, одно и то же… это же всего лишь Select" (2026-07-30). So the winning
 * route is remembered for the session and tried FIRST next time. */
const routeMemory = new Map();
const routeKey = (tabId, name) => `${hostOf(rememberedUrl(tabId))}|${norm(name)}`;

/** ref → node, for the LAST snapshot taken of each tab. Refs are per-snapshot by design; this
 *  is what lets a batch of refs be journalled as durable field names. */
const snapMemory = new Map();
/** url → component libraries detected there. Markers cost a read each, so ask once per page. */
const libCache = new Map();

function rememberSnapshot(tabId, snap) {
  if (!snap || !Array.isArray(snap.nodes)) return;
  const byRef = new Map();
  for (const n of snap.nodes) byRef.set(n.ref, n);
  snapMemory.set(tabKey(tabId), { url: snap.url || '', at: Date.now(), byRef, nodes: snap.nodes });
}

/** What was that ref/selector, in words? Empty when the agent never snapshotted this tab. */
function recallNode(tabId, target) {
  const mem = snapMemory.get(tabKey(tabId));
  if (!mem || !target) return null;
  return mem.byRef.get(target) || mem.nodes.find((n) => n.selector === target) || null;
}
const rememberedUrl = (tabId) => snapMemory.get(tabKey(tabId))?.url || '';

/** One journal entry per acting call: what it was, on which page, as field NAMES. */
const JOURNAL_CAP = 400;
const journal = [];

function note(kind, tabId, items) {
  const kept = items.filter((i) => i && (i.name || i.selector));
  if (!kept.length) return;
  /* The journal is also where a LOOP becomes visible: this is the only place that records what was
     acted on by the name a human would read, so the voice watches it from here. One target per
     action — a batch's first entry stands for the batch, since a whole batch repeating is the same
     symptom as one control repeating. */
  noticedTarget(`${kind}:${kept[0].name || kept[0].selector}`);
  journal.push({ kind, url: rememberedUrl(tabId), at: Date.now(), items: kept });
  if (journal.length > JOURNAL_CAP) journal.splice(0, journal.length - JOURNAL_CAP);
}

/** A target as a recipe stores it: the name survives a re-render, the selector is the fallback. */
function targetOf(tabId, ref, selector, extra = {}) {
  const node = recallNode(tabId, ref || selector);
  /* AND WHAT KIND OF CONTROL IT WAS — stamped here, at the only moment it is free.
   *
   * The classifier's verdict is worth nothing if it dies with the session: the next run would
   * rediscover that this field is a calendar by failing to write into it, which is the whole cost
   * we are trying to remove. `targetOf` is the one place every journalled action passes through and
   * the node is still in hand, so the kind is recorded here and travels into the recipe with the
   * name. `text` is left off deliberately — it is the default assumption, so storing it is bulk. */
  const kind = node ? classifyNode(node, snapMemory.get(tabKey(tabId))?.nodes || [])?.kind : null;
  return {
    name: node?.name || '',
    selector: node?.selector || selector || '',
    ...(node?.role ? { role: node.role } : {}),
    ...(kind && kind !== 'text' ? { kind } : {}),
    ...extra,
  };
}

/* Which verb a stored kind demands. A recipe whose date field replays as a plain `type` is a
 * recipe that fails on Ant and MUI — the two libraries where a written date never sticks. */
const DATE_KINDS = new Set(['date-sections', 'popup-date-input', 'calendar-popup']);
const PATH_KINDS = new Set(['checkable-tree', 'tree-popup']);
const specialVerb = (f) =>
  f.action === 'date' || DATE_KINDS.has(f.kind) ? 'date' : f.action === 'path' || PATH_KINDS.has(f.kind) ? 'path' : null;

/**
 * The journal, folded into wizard steps.
 *
 * The shape of a multi-step form is exactly "fill some fields, click one control, repeat", so a
 * click closes the step it follows and becomes that step's `advance`. A click with nothing filled
 * before it is its own step — which is what "press Create to open the wizard" looks like.
 */
function stepsFromJournal(url) {
  const host = hostOf(url || '');
  const steps = [];
  let cur = { fields: [], uploads: [], url: '' };
  const flush = (advance) => {
    if (!cur.fields.length && !cur.uploads.length && !advance) return;
    // Same field filled twice in one step (a retry) → keep the last value the agent chose.
    const seen = new Map();
    for (const f of cur.fields) seen.set(norm(f.name) + '|' + f.selector, f);
    steps.push({
      title: `Step ${steps.length + 1}`,
      url: cur.url,
      fields: [...seen.values()],
      ...(cur.uploads.length ? { uploads: cur.uploads } : {}),
      ...(advance ? { advance } : {}),
    });
    cur = { fields: [], uploads: [], url: '' };
  };
  for (const e of journal) {
    if (host && hostOf(e.url) && hostOf(e.url) !== host) continue;
    if (!cur.url) cur.url = e.url;
    if (e.kind === 'fill') cur.fields.push(...e.items);
    else if (e.kind === 'upload') cur.uploads.push(...e.items);
    else if (e.kind === 'click') flush(e.items[0]);
  }
  flush(null);
  return steps;
}

// ── Recipes on disk ────────────────────────────────────────────────────────────
const RECIPES_DIR = process.env.QIKSY_RECIPES_DIR || join(homedir(), '.qiksy', 'recipes');

/* REPORTS LAND IN THE PROJECT, NOT IN «DOWNLOADS» — the rules, and why, live in mcp/reports.mjs
   so they can be held to account without a browser, a socket or a port. `cwd` is read here, at
   the moment of use, because the folder can be deleted under a long-running process. */
function whereReportsGo() {
  try { return reportsDir({ cwd: process.cwd() }); } catch { return null; }
}
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'recipe';

/**
 * A PROJECT IS A FOLDER, AND THAT IS THE WHOLE MECHANISM.
 *
 * Host was already stored and was already the wrong key on its own: staging and production of
 * one product are two hosts and one project, and two products behind one domain are one host
 * and two projects. So `project` is a field the human sets, and it becomes a subdirectory —
 * because the files are theirs, and a person who opens ~/.qiksy/recipes should be able to see
 * the grouping without a tool. Recipes saved before this change keep working: no project means
 * the top level, which is exactly where they already are.
 */
function recipePath(rec) {
  const dir = rec.project ? join(RECIPES_DIR, slug(rec.project)) : RECIPES_DIR;
  return join(dir, slug(rec.name) + '.json');
}

function saveRecipe(rec) {
  const path = recipePath(rec);
  mkdirSync(dirname(path), { recursive: true });
  /* A recipe that MOVES between projects must not leave a twin behind: the old copy would keep
     answering qa_recipe_list and a suite would run the stale one. */
  for (const old of listRecipes()) {
    if (slug(old.name) === slug(rec.name) && old.path !== path) {
      try { rmSync(old.path); } catch { /* gone already, or not ours to remove */ }
    }
  }
  writeFileSync(path, JSON.stringify(rec, null, 2), 'utf8');
  return path;
}

/** Top level plus ONE level of project folders — deliberately not a deep walk: a recipes
 *  directory is a filing cabinet, not a tree, and an unbounded crawl of somebody's home
 *  directory is not something a listing call should ever do. */
function listRecipes() {
  const out = [];
  const readDir = (dir, project) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!project) readDir(join(dir, e.name), e.name); continue; }
      if (!e.name.endsWith('.json')) continue;
      const path = join(dir, e.name);
      try {
        const rec = JSON.parse(readFileSync(path, 'utf8'));
        if (!rec || rec.recipe !== 'qiksy-recipe/v1') continue;   // voice.json lives here too
        out.push({ ...rec, project: rec.project || project || '', path });
      } catch {
        /* a half-written or hand-edited file — skip it rather than fail the listing */
      }
    }
  };
  readDir(RECIPES_DIR, '');
  return out;
}

/** Case- and shape-insensitive tag match, so "smoke" finds "Smoke". */
const hasTag = (rec, tag) =>
  !tag || (rec.tags || []).some((t) => slug(t) === slug(tag));

/** By slug first, then by a loose name match — so "client onboarding" finds `client-onboarding`. */
function loadRecipe(name) {
  const all = listRecipes();
  const want = slug(name);
  return all.find((r) => slug(r.name) === want) || all.find((r) => norm(r.name).includes(norm(name))) || null;
}

/**
 * Find the node a recipe field means, in a FRESH snapshot.
 *
 * Accessible name is the durable key: refs are per-snapshot and a cssPath breaks the moment the
 * page adds a wrapper, but "Country of implementation" is still called that on the second run.
 * Tiers: exact name → one is the other's prefix (the extension caps its own labels at 48 chars
 * and the snapshot at 80, so a truncated match is normal) → contains → the stored selector.
 */
function pickNode(nodes, want, used, { fieldsOnly = false } = {}) {
  const w = norm(want.name);
  const pool = nodes.filter((n) => !used.has(n.ref) && (!fieldsOnly || isFieldNode(n)));
  const byRole = want.role ? pool.filter((n) => n.role === want.role) : [];
  const tiers = [];
  for (const set of [byRole, pool]) {
    if (!set.length) continue;
    if (w) {
      tiers.push(set.filter((n) => norm(n.name) === w));
      /* THE PREFIX TIER NEEDS A FLOOR, and finding out why cost a wrong click.
       *
       * Looking for the day cell "1987-03-14" matched a cell named "1" — because "1987-03-14"
       * starts with "1" — and the picker dutifully selected the 1st of March. A two-character name
       * is not a truncation of anything; it is a different control. So both sides must be at least
       * three characters before "one is the other's prefix" is allowed to mean anything. */
      tiers.push(set.filter((n) => {
        const a = norm(n.name);
        if (a.length < 3 || w.length < 3) return false;
        return a.startsWith(w) || w.startsWith(a);
      }));
      tiers.push(set.filter((n) => norm(n.name).includes(w)));
    }
    if (want.selector) tiers.push(set.filter((n) => n.selector === want.selector));
  }
  for (const t of tiers) if (t.length) return { node: t[0], ambiguous: t.length > 1 };
  return null;
}

/**
 * WHAT A CONTROL SHOWS — as opposed to what it is CALLED.
 *
 * The two are the same on most controls and opposite on the one kind this file kept getting wrong:
 * a listbox trigger with an `aria-label`. The React stand's downshift button is
 * `getToggleButtonProps({ 'aria-label': 'Signatory role' })`, so `accessibleName` returns "Signatory
 * role" for ever while the thing a human reads on it is "Director" — judged by its name, a perfect
 * fill reads as empty and so does a perfect repair (the same trap that reported three correct MUI
 * dates as failures, 2026-07-30). `qa_read` returns innerText, which is the rendered truth; the
 * state rides in front of it because a native control keeps its value there (`value="…"`) and has
 * no text at all.
 */
/**
 * DID THE REPAIR ACTUALLY LAND? Asked of the FIELD, never of the repair's own reply.
 *
 * Measured 17.10.2026 on our own React stand, driving the Ant Cascader «Delivery location»:
 * `qa_fill_json` answered `filled: 0`, then `repaired: [{ ok: true, via: "raw, waited for the
 * options" }]`, and the control was still showing its placeholder «Country / region / city».
 * The repair had written text into the cascader's search box, which commits nothing until an
 * option is clicked, and `qa_type` honestly reported that IT had written the text. The old line
 * read `ok: again?.ok !== false`, i.e. it took the success of the WRITE for the success of the
 * FILL — and reported it to the agent as repaired.
 *
 * That is the worst answer this tool can give. A false failure costs a re-check; a false success
 * is never re-checked at all, and the form goes on with an empty required field. 1.71.0 was spent
 * removing false failures, which makes shipping a false success beside them the exact opposite of
 * what that release was for.
 *
 * So: re-read the control and compare, with the same three readings the first verification uses
 * (the state, the accessible name, the rendered text) and the same `shownText`, which already
 * refuses to read a control whose list is still up.
 */
async function repairLanded(tabId, frameId, r, again, node) {
  if (again?.ok === false) return false;
  const want = norm(r.value);
  /* Nothing to compare against (a click-like value, an empty string): fall back to the call's own
     word, which is all there is. Narrow on purpose — it is the only case left where we trust it. */
  if (!want) return again?.ok !== false;
  /* `reads` is what the control held immediately after the write, straight from the extension. */
  if (again?.reads && norm(again.reads).toLowerCase().includes(want.toLowerCase())) return true;
  const snap = await callExtension('qa_snapshot', { tabId, frameId }, 30_000).catch(() => null);
  const fresh = pickNode(Array.isArray(snap?.nodes) ? snap.nodes : [], { name: r.matched || r.key }, new Set(), { fieldsOnly: true });
  const n = fresh?.node || node;
  const low = want.toLowerCase();
  if (String(n?.state || '').toLowerCase().includes(low) || norm(n?.name).toLowerCase().includes(low)) return true;
  return norm(await shownText(tabId, n)).toLowerCase().includes(low);
}

async function shownText(tabId, node) {
  if (!node) return '';
  const state = String(node.state || '');
  /* A CONTROL WITH ITS LIST UP IS NOT READABLE, and this is the one place a guess is forbidden:
     several libraries render the options INSIDE the trigger's own element, so an open menu puts
     every option into innerText and "Director" is found in a control that holds nothing — a fill
     reporting success while nothing landed, which is the failure that has already cost this
     product two sessions. `expanded` is the page's own word for "the list is up", so the text is
     not consulted at all; the caller then treats it as not-landed, which is the safe direction. */
  if (/\bexpanded\b/.test(state)) return state;
  let txt = '';
  const byRef = await callExtension('qa_read', { tabId, ref: node.ref, maxChars: 90 }).catch(() => null);
  if (byRef && byRef.ok !== false) txt = String(byRef.text || '');
  /* A ref belongs to ONE snapshot and a React re-render detaches what it points at ("ref is
     stale"); the cssPath is already on the node and survives that. */
  if (!txt && node.selector) {
    const bySel = await callExtension('qa_read', { tabId, selector: node.selector, maxChars: 90 }).catch(() => null);
    if (bySel && bySel.ok !== false) txt = String(bySel.text || '');
  }
  return `${state} ${txt}`.trim();
}

/**
 * Fill a form from a plain { "field label": "value" } object — the shape of the JSON behind the
 * panel's own `{ }` editor and its ⚡Fill button (`Dataset` in engine/dataset.ts).
 *
 * WHY THIS EXISTS (owner ask 2026-07-29): "when I press Fill by hand it fills everything at once,
 * selects included — can the agent just hand it a JSON?" It can, and this is the half that needs
 * no Web Store release: the names are resolved here against one snapshot and handed to the single
 * batch call, so an agent that already knows the data — from a ticket, a persona, a CSV row —
 * spends ONE call and never has to think in refs at all.
 *
 * The unmatched keys come back WITH the page's actual field names. That is the difference between
 * an agent that fixes its own key on the next call and one that starts snapshotting to find out.
 */
async function fillByNames(tabId, fields, { dryRun, within, verify, advance, next, frameId } = {}) {
  const snap = await snapshotUntrapped(tabId, Object.keys(fields || {})[0], frameId);
  rememberSnapshot(tabId, snap);
  let nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  if (within) nodes = nodes.filter((n) => n.selector === within || n.selector.startsWith(within + ' '));

  const used = new Set();
  const batch = [];
  const resolved = [];
  const journalItems = [];
  const unmatched = [];
  const ambiguous = [];

  /* IS THIS PAGE ANT? One marker read, ~30ms, and it decides how the option-matching selects are
   * driven. Ant's Select commits its selection through its own path: the text filters the list
   * correctly, the option is there, and neither Enter nor a pointer sequence from the content script
   * takes it — while the extension's fill engine does, first time, in about a second (probed field by
   * field 2026-07-30, after this cost an hour). Worse, ATTEMPTING the fast route first leaves the
   * control cleared and the engine can no longer fix it, so the decision has to be made up front. */
  const antPage = await callExtension('qa_read', { tabId, selector: '.ant-select, .ant-picker', maxChars: 4, frameId }).catch(() => null);
  const isAnt = !!(antPage && !antPage.error);

  for (const [key, raw] of Object.entries(fields || {})) {
    /* `Label#2` MEANS THE SECOND CONTROL WITH THAT LABEL, and the notation is not invented here:
     * it is what the extension's own dataset uses (`fieldKey` in engine/dataset.ts dedupes with
     * #2, #3…), so a dataset copied out of the panel's `{ }` editor works verbatim. It is also
     * the only way to address a form built from a repeated component, where three inputs are all
     * called "Full name" — the case that turned up on the 6-step wizard the first time this ran. */
    /* VALUE "click" MEANS PRESS IT, and it is not sugar.
     *
     * A wizard's step is not only fields: a focus-area chip (button + aria-pressed), a custom
     * radio (div role=radio), a switch whose only accessible name is its own caption. None of
     * them takes a value — the extension's filler correctly refuses a div as "not a fillable
     * control" — yet they are part of the same step, and making the agent leave the batch for
     * each one is how a step goes back to costing five calls. So the dataset can say
     * { "Climate": "click" } and this resolves it among the CLICKABLE roles instead. */
    const wantsClick = typeof raw === 'string' && /^(click|press|toggle)$/i.test(raw.trim());
    const dup = /^(.*?)#(\d+)$/.exec(key);
    let hit;
    if (wantsClick) {
      const pool = nodes.filter((n) => CLICKABLE_ROLES.has(n.role));
      hit = pickNode(pool.length ? pool : nodes, { name: dup ? dup[1] : key }, used);
      if (hit) {
        used.add(hit.node.ref);
        batch.push({ ref: hit.node.ref, action: 'click' });
        resolved.push({ key, matched: hit.node.name, role: hit.node.role, ref: hit.node.ref, value: 'click' });
        journalItems.push({ name: hit.node.name || key, selector: hit.node.selector, role: hit.node.role, action: 'click' });
      } else {
        unmatched.push(key);
      }
      continue;
    }
    if (dup) {
      const base = norm(dup[1]);
      const nth = Number(dup[2]);
      // Same tiers as pickNode, in the same order — an exact set first, and only if that is empty
      // a looser one. Anything stricter and "Full name#2" misses a page that renders "Full name *".
      const controls = nodes.filter((n) => isFieldNode(n));
      const sameName =
        controls.filter((n) => norm(n.name) === base).length > 0
          ? controls.filter((n) => norm(n.name) === base)
          : controls.filter((n) => norm(n.name) && (norm(n.name).startsWith(base) || base.startsWith(norm(n.name))));
      const node = sameName[nth - 1];
      hit = node ? { node, ambiguous: false } : null;
    } else {
      hit = pickNode(nodes, { name: key }, used, { fieldsOnly: true });
      /* SECOND LOOK, WITHOUT THE FORM-CONTROL FILTER.
       *
       * Headless UI's Listbox and downshift's useSelect render a <button aria-haspopup="listbox">,
       * which is a select in every sense a user cares about and a `button` in the snapshot — the
       * snapshot does not carry aria-haspopup, so the server cannot tell it from Next. Matching by
       * NAME is what makes the wider search safe: the key came from the field's own label, and the
       * fill engine drives the widget correctly once it has the element (fillCustomSelect). Found
       * on the React stand, where "Service tier" was invisible to a fields-only match. */
      if (!hit) hit = pickNode(nodes, { name: key }, used);
    }
    if (!hit) {
      unmatched.push(key);
      continue;
    }
    used.add(hit.node.ref);
    if (hit.ambiguous) ambiguous.push(key);
    // A dataset holds booleans for checkboxes and numbers for spinbuttons; the extension reads a
    // string and treats an empty/false-ish one as "uncheck", so the conversion belongs here.
    const value = typeof raw === 'boolean' ? (raw ? 'true' : '') : String(raw ?? '');

    /* PUT THE VALUE STRAIGHT IN — the default now, not a special case (owner, 2026-07-30: "можешь
     * засовывать сразу данные в инпуты?" — yes, and it is the whole speed story).
     *
     * Any control with a real text input takes the value written verbatim through the native setter:
     * an Ant DatePicker parses "06/11/2024", a TimePicker "14:30", a tags field adds the tag, a
     * searchable select filters to it. Measured on the live stand: 0.30s per field this way against
     * 26s for a date driven through its calendar, 35s for a range, 24s for a tree. Opening popups is
     * how you TEST a widget — and that job now belongs to Playwright, which can see it (owner, same
     * day). Getting data in is this.
     *
     * The commit key is where care is needed: Enter inside a plain text input SUBMITS the form. So it
     * is sent only to controls that need a commit — a combobox, a searchbox, or anything whose state
     * says it owns a popup — and never to an ordinary input. */
    const cls = classifyNode(hit.node, nodes);
    /* A DATE OR A TIME NEEDS THE COMMIT KEY even when its input looks perfectly ordinary — an Ant
       DatePicker's field carries no readonly, no aria-expanded and no telltale role, and without Enter
       the text sits there uncommitted and the form still says the field is empty (watched it, same
       day). So the shape of the VALUE counts as evidence, not just the shape of the control. */
    const looksDated = /^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/.test(value) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(value) || /^\d{1,2}[./-]\d{4}$/.test(value);
    const namedDated = /\b(date|time|dob|birth|deadline|expiry|from|to|start|end|window|month)\b/i.test(hit.node.name || '');
    /* WHO GETS THE FAST ROUTE — decided by what the control DOES with the text, not by timing.
     *
     * A field that PARSES what it is given — a date, a time, a range end, a tag — takes the value
     * verbatim and is done in milliseconds, where driving its popup costs 7 to 35 seconds. That is
     * where the entire saving lives (measured 2026-07-30).
     *
     * A select that must MATCH AN OPTION from its own list is a different animal: the text only
     * filters, and something still has to choose the row. The extension's engine does that correctly
     * — opens the list, waits for the options, picks the match, checks the trigger changed — in about
     * a second, and it was never the slow part. Forcing raw onto it produced a field that LOOKED
     * filled and held no selection, twice in a row. So it keeps the engine. */
    const tagLike = /\b(tags?|chips?|keywords?|labels?|skills?)\b/i.test(hit.node.name || '');
    /* ИМЯ — НЕ ПРИЗНАК СПИСКА, И ЭТО СТОИЛО 1,4 СЕКУНДЫ НА ПОЛЕ (замер 22.08.2026).
     *
     * Правило читало только НАЗВАНИЕ поля: есть в нём слово вроде «type», «role», «line» или
     * «centre» — значит это выбор из списка, надо написать текст и кликнуть строку. На форме из
     * 94 полей так поехали «Street line 2», «Cost centre» и «Contact role» — три ОБЫЧНЫХ
     * текстовых поля, у которых никакого списка нет и быть не может. Каждое честно ждало
     * появления строки весь отпущенный срок (pickMs = 1400 мс) и сдавалось молча: заливка
     * отчитывалась «ok», значение стояло на месте, и заметить это можно было только по времени.
     * Три поля из тридцати девяти давали 4,2 секунды из 4,9 — то есть 86% времени пакета.
     *
     * Теперь имя — только ВТОРОЕ условие. Первое: у контрола должен БЫТЬ список. Текст, который
     * фильтрует список, живёт в роли combobox или searchbox; у роли textbox списка нет по
     * определению, что бы ни было написано в подписи. Ошибиться в обратную сторону дёшево:
     * самодельная выпадашка, представившаяся textbox, получит обычную запись текста — ровно то,
     * что получает любое другое текстовое поле, — и перепроверка её починит. */
    const HAS_LIST = new Set(['combobox', 'searchbox']);
    const optionMatching = HAS_LIST.has(hit.node.role)
      && /\b(select|type|status|regime|tier|terms|category|currency|language|method|level|role|sector|line|centre|center)\b/i.test(hit.node.name || '');
    const parsesText = looksDated || tagLike || (namedDated && !optionMatching);
    /* A TOGGLE IS NOT A TEXT FIELD, whatever its NAME contains. `optionMatching` reads the node's
     * name for words like "terms" or "type", and a consent checkbox is usually called "I accept the
     * TERMS of service" — so a plain tickbox was being sent down the select route: write "true" into
     * it, then hunt for an option row saying "true". No such row exists, so the answer was
     * `no option matching "true"` while the box itself had been ticked by the write. A wrong FAILURE
     * is the expensive kind: the caller repairs what is already done, and a repair on a toggle
     * un-does it. Checkboxes, radios and switches go to the engine, which knows how to check a box;
     * a file input reads as tag `input` too, and its value cannot be written at all. */
    const NOT_TEXT = ['checkbox', 'radio', 'switch', 'button'];   // `button` is how a file input reads
    const writable = (hit.node.tag === 'input' || hit.node.tag === 'textarea') && !NOT_TEXT.includes(hit.node.role);
    const plainText = writable && (cls?.kind === 'text' || cls?.kind === 'rich-text') && !parsesText;
    const entry = { ref: hit.node.ref, value };
    /* AN OPTION-MATCHING SELECT: write the text to filter, then click the row that matches — one step
     * further than raw, because the text alone never chooses.
     *
     * Except on Ant Design, and that is measured rather than assumed (2026-07-30): a react-select
     * commits on the option click and the form agrees; an Ant Select reports a successful click and
     * the form still says the field is empty — its selection goes through its own commit path. The
     * extension's engine drives that correctly in about a second, so Ant keeps the engine. Knowing
     * WHICH library owns the page is one cheap marker read the snapshot already did. */
    if (writable && optionMatching && !parsesText && !isAnt) {
      entry.raw = true;
      entry.open = true;
      entry.pick = true;
      entry.commit = '';
      entry.pickMs = 1400;   // enough for an async list to arrive; it returns the moment it does
    } else if (writable && (parsesText || plainText)) {
      entry.raw = true;
      // Enter commits a parsed value; on a plain input it would submit the form, so it gets no key.
      entry.commit = parsesText ? 'Enter' : '';
      entry.settleMs = parsesText ? 60 : 0;
      if (tagLike) entry.blur = true;   // a tags field keeps its value only once focus LEAVES
    }
    batch.push(entry);
    resolved.push({ key, matched: hit.node.name, role: hit.node.role, ref: hit.node.ref, value, via: entry.pick ? 'raw+pick' : entry.raw ? (entry.commit ? 'raw+Enter' : 'raw') : 'engine' });
    // The selector rides in the journal, not in the answer: a recipe needs it as the fallback
    // target, the agent reading this result does not.
    journalItems.push({ name: hit.node.name || key, selector: hit.node.selector, role: hit.node.role, value, action: 'type' });
  }

  const out = {
    url: snap?.url || '',
    matched: resolved.length,
    of: Object.keys(fields || {}).length,
    resolved,
    ...(ambiguous.length ? { ambiguous, note: 'more than one control carries that name — the first unused one in DOM order was taken, which is also the order your keys are read in' } : {}),
  };
  if (unmatched.length) {
    out.unmatched = unmatched;
    // The page's own field names, so the next call can use the right key without a round trip.
    out.fieldsOnThePage = nodes.filter((n) => isFieldNode(n) && n.name).map((n) => n.name).slice(0, 40);
  }
  if (dryRun) return { ...out, dryRun: true, ...(advance ? { wouldAdvance: advance } : {}) };
  if (!batch.length) return { ok: false, error: 'none of those keys matched a field on the page', ...out };

  const filled = await callExtension('qa_type_many', { tabId, fields: batch, frameId }, 60_000);
  note('fill', tabId, journalItems);

  /* VERIFY, THEN REPAIR ONE AT A TIME — because "the write succeeded" is not "the value is there".
   *
   * Found on the React stand (2026-07-29). MUI X's date field is three contenteditable SECTIONS,
   * and writing one makes the component rebuild all three. A batch resolves every ref from one
   * snapshot, so the second and third write land on nodes that have since been replaced: filling
   * Year, Month, Day in one call put "14" into the YEAR and left the day empty — and every write
   * reported ok, because each one did set the text it was given.
   *
   * No ref-based batch can fix that; the field has to be re-found between writes. So: read the
   * page back, compare against what we asked for, and re-write the ones that disagree BY NAME,
   * each against its own fresh snapshot. Costs one snapshot per step normally, and one extra call
   * per genuinely wrong field. Pass verify:false for the rare case where re-reading is unwanted.
   */
  let verified = null;
  if (verify !== false && resolved.length) {
    await new Promise((r) => setTimeout(r, 250));
    const after = await callExtension('qa_snapshot', { tabId, frameId }, 30_000);
    rememberSnapshot(tabId, after);
    const byRef = new Map((after?.nodes || []).map((n) => [n.ref, n]));
    const wrong = [];
    const unreadable = [];
    for (const r of resolved) {
      if (r.value === 'click' || !r.value) continue;
      const node = byRef.get(r.ref) || (after?.nodes || []).find((n) => norm(n.name) === norm(r.matched));
      const shown = String(node?.state || '');
      const want = norm(r.value);
      // The snapshot reports a field's value inside `state` as value="…"; a widget that shows the
      // chosen option as its NAME (a listbox trigger) is checked against the name instead.
      const hasIt = shown.toLowerCase().includes(want) || norm(node?.name).includes(want);
      const showsSomething = /value=/.test(shown) || /checked|selected/.test(shown);
      /* ONLY TEXT FIELDS ARE EVER RE-WRITTEN, and the reason is a bug the owner watched happen
       * (2026-07-29): an Ant multiple-select keeps its value in CHIPS, not in any property this
       * snapshot quotes, so the check read "empty" and wrote the same option again — which in a
       * multi-select TOGGLES IT OFF. The repair undid the fill, then the next pass redid it. A
       * verification that can damage what it verifies is worse than none, so it now stays away
       * from anything whose value is not readable in the first place: only a textbox / searchbox /
       * spinbutton with nothing in it counts as a genuine miss. */
      const rewritable = ['textbox', 'searchbox', 'spinbutton'].includes(node?.role);
      /* A SELECT WHOSE OPTIONS ARRIVE LATE gets one more go, with time to spare.
       *
       * The fast path writes the text and presses the commit key; for a searchable select the option
       * has to EXIST when the key lands, and an async one fetches it (~0.5s on this stand). Live, two
       * selects held the right text and no selection because Enter arrived at 320ms. So: any composite
       * that did not confirm is re-committed once with a long settle — not re-written blindly, which is
       * what used to toggle a multi-select back off. */
      /* A FAST ROUTE THAT REPORTED FAILURE IS REPAIRED BY THE ENGINE, not by trying it again harder.
       *
       * Ant Design's Select is the case that settled this (probed field by field, 2026-07-30): the text
       * filters its list correctly and the option is there, but neither Enter nor a synthetic pointer
       * sequence from the content script commits the choice — the same sequence run from the page's own
       * context does. The extension's fill engine drives it correctly in about a second, so that is the
       * repair. Re-attempting raw with a longer wait was the wrong reflex: nothing about it was slow. */
      const fastFailed = !hasIt && node && /raw/.test(String(r.via || '')) && (node.role === 'combobox' || node.role === 'searchbox');
      /* A BUTTON-TRIGGERED LISTBOX — the select that costs four agent calls on every single run.
       *
       * downshift's useSelect, Headless UI's Listbox.Button, MUI's Select: a <button> with
       * aria-haspopup=listbox and its own ul/li menu. The engine drives it by clicking the option,
       * and on downshift that does NOTHING — a synthetic click carries no mousedown and,
       * decisively, does not FOCUS, so nothing commits and any key the agent sends next lands on
       * <body>. Live (2026-07-30) the fill answered ok:true, the step's own validator still said
       * "still needed: Signatory role", and the agent then spent a snapshot + two presses + a
       * re-check doing by hand what keyboardPick has done all along — reachable only from pickPath.
       *
       * THE GATE IS NARROW ON PURPOSE, because the repair that UNDID a fill (an Ant multi-select
       * re-clicked and toggled back off — see `rewritable` above) is the one mistake this ladder
       * may never repeat:
       *   · role `button` AND tag not `input` — `input[type=file]` reads as role button and an
       *     upload control is not a listbox;
       *   · `expanded`/`collapsed` in the state, i.e. the element really carries aria-expanded:
       *     that is the shape of a popup trigger and not the shape of Next, Save or a chip;
       *   · it never took a raw write (a button cannot; if `via` says raw this is not our case);
       *   · and the decisive one — the RENDERED TEXT does not contain the value. The name cannot
       *     answer here (it is an aria-label), so one qa_read is paid for exactly these nodes and
       *     for nothing else. Note what this branch does NOT do: it never re-writes a value, so a
       *     control whose value is merely unreadable cannot be damaged by it — it can only be
       *     re-picked, and only when it renders nothing of what was asked for. */
      /* JUDGED BY THE TAG, NOT BY THE ROLE — corrected against a live run (2026-07-30). The branch
         first shipped requiring role === 'button', and downshift's trigger does not have it: the
         snapshot reads `aria-haspopup="listbox"` and calls the node a COMBOBOX whose tag is button.
         So the repair fell through to the combobox branch above ("raw, waited for the options"),
         which is exactly the path that had already failed — the fill reported ok and the step's own
         validator still asked for the field. The tag is the honest signal: a <button> cannot take a
         written value at all, whatever role the page claims for it, so the keyboard is the only way
         in. `input` is excluded because input[type=file] reads as role button, and an upload
         control is not a listbox. */
      const listboxTrigger =
        !hasIt && node && node.tag === 'button' &&
        !/raw/.test(String(r.via || '')) && /\b(expanded|collapsed)\b/.test(shown);
      const showsWanted = listboxTrigger ? norm(await shownText(tabId, node)).includes(want) : false;
      /* AND IT IS TESTED FIRST. A button-tagged trigger also satisfies the combobox branch below,
         and whichever runs first wins — that ordering is what made the fix inert on the very
         control it was written for. */
      /* BEFORE ANY REPAIR: IS IT SIMPLY ON SCREEN? A control that holds its value as rendered text
       * — a div with role=combobox, the way most hand-rolled selects are built — quotes nothing in
       * `state`, and its accessible name is its LABEL as soon as the page labels it properly. So a
       * correctly filled field reads as empty on both of the checks above, gets "repaired", and the
       * repair writes text into a div that cannot take it. Watched it happen on our own stand
       * (2026-08-15): "Nationality" held Poland, the answer said `stillWrong`.
       *
       * This branch can only ever say YES — it never writes, so a field it misreads is left exactly
       * as the ladder below would have found it. One qa_read, and only for a control that is not a
       * text field and did not confirm any other way. */
      const rendersWanted =
        !hasIt && node && !rewritable && !listboxTrigger ? norm(await shownText(tabId, node)).includes(want) : false;

      if (rendersWanted) continue;
      if (listboxTrigger) { if (!showsWanted) wrong.push({ ...r, keyboard: true }); }
      else if (fastFailed) wrong.push({ ...r, engine: true });
      else if (!hasIt && node && (node.role === 'combobox' || node.role === 'searchbox') && r.via) wrong.push({ ...r, slow: true });
      else if (!hasIt && !showsSomething && node && rewritable) wrong.push(r);
      else if (!hasIt && !showsSomething && node) unreadable.push(r.key);
    }
    const repaired = [];
    for (const r of wrong) {
      /* THE KEYBOARD REPAIR RESOLVES ITS OWN TARGET, so it has to run BEFORE the three lines below.
       *
       * `pickNode(… { fieldsOnly: true })` looks only at form controls and this repair's control is
       * a <button>: the ordinary ladder finds nothing, hits `continue`, and the field is listed as
       * disagreed with no repair attempted at all. keyboardPick takes a NAME and does its own
       * resolution through findClickable — which is exactly why pickPath can call it too. This is a
       * second door onto the same room, not a second implementation. */
      if (r.keyboard) {
        const kb = await keyboardPick(tabId, r.matched || r.key, r.value, { fromHighlight: true });
        /* It refuses with the menu still up (the `loose < 0` return presses no Escape), and an
           abandoned popup is the next widget's bug. On SUCCESS Enter has already closed it, and
           pressing Escape at a page with no popup up is how a wizard inside a modal gets closed
           underneath us — so the Escape is spent only where there is something to close. */
        if (!kb.ok) await clearPopups(tabId);
        else routeMemory.set(routeKey(tabId, r.matched || r.key), 'keyboard');
        repaired.push({
          field: r.key,
          ok: kb.ok === true,
          via: kb.ok
            ? 'ArrowDown ×N + Enter at the trigger — this listbox ignores option clicks'
            : kb.error || 'the keyboard route did not take either',
          ...(kb.reads ? { reads: kb.reads } : {}),
          ...(kb.offers ? { offers: kb.offers } : {}),
          byKeyboard: true,
        });
        await new Promise((res) => setTimeout(res, 140));
        continue;
      }
      const snapN = await callExtension('qa_snapshot', { tabId, frameId }, 30_000);
      rememberSnapshot(tabId, snapN);
      const hit = pickNode(Array.isArray(snapN?.nodes) ? snapN.nodes : [], { name: r.matched || r.key }, new Set(), { fieldsOnly: true });
      if (!hit) continue;
      /* REPAIR THE WAY THE VALUE WENT IN, NOT THE OTHER WAY. Watched live on the stand
         (2026-07-30): an Ant TimePicker took "14:30" perfectly through `raw`, the snapshot could
         not quote the value back (its panel had not committed to the tree yet), the check called
         that a miss — and the repair went through the ENGINE, whose date path writes an ISO
         string. The field ended up holding "2026-07-30". A verification that turns a correct
         value into a wrong one is the most expensive bug this tool can have, so a text field that
         was filled raw is re-filled raw, with the same string in the same format the field
         displays. The engine repair stays for the composites it was written for (r.engine). */
      const rawFilled = /raw/.test(String(r.via || '')) && ['textbox', 'searchbox', 'spinbutton'].includes(hit.node.role);
      const again = r.slow
        ? await callExtension('qa_type', { tabId, ref: hit.node.ref, value: r.value, raw: true, commit: 'Enter', settleMs: 800, frameId }, 20_000)
        : rawFilled && !r.engine
          ? await callExtension('qa_type', { tabId, ref: hit.node.ref, value: r.value, raw: true, commit: 'Enter', blur: true, settleMs: 300, frameId }, 20_000)
          : await callExtension('qa_type', { tabId, ref: hit.node.ref, value: r.value, frameId }, 20_000);
      /* JUDGED BY THE FIELD, NOT BY THE REPLY — see repairLanded. `again.ok` only says the write
         happened; on a cascader or a tags field the write happens into a search box and commits
         nothing, and reporting that as repaired is a lie the agent never re-checks. */
      const landed = await repairLanded(tabId, frameId, r, again, hit.node);
      repaired.push({
        field: r.key,
        ok: landed,
        via: r.engine ? 'the fill engine (this library commits its own way)' : r.slow ? 'raw, waited for the options' : rawFilled ? 'written again, verbatim' : 'rewritten',
        ...(again?.stuck !== undefined ? { stuck: again.stuck } : {}),
        ...(landed ? {} : { note: 'the write went in but the control did not commit it — a cascader, a tree or a tags field needs its own verb (qa_pick_path / qa_pick_tags) or a click on the option' }),
      });
      await new Promise((res) => setTimeout(res, 140));
    }
    if (unreadable.length && !wrong.length) {
      // Said plainly rather than repaired: these took the write, and the page simply does not
      // expose their value in a way the tree can quote (chips, portals, canvas-drawn widgets).
      verified = { unreadable, note: 'those fields accepted the write but do not report their value to the accessibility tree, so it could not be confirmed — check with qa_read if it matters' };
    }
    if (wrong.length) {
      /* A field that refuses a written value TWICE is telling us it is not a value-setting field at
         all. MUI X's date sections are the canonical case: they are contenteditable spans the
         component rebuilds from its own state, so the only way in is its calendar (or real keys).
         Saying that here is worth more than another retry — it is the difference between an agent
         that opens the picker and one that reports the form as broken. */
      const stillWrong = repaired.filter((r) => r.ok === false || r.stuck === false).map((r) => r.field);
      const dateish = wrong.filter((r) => /^(day|month|year|hours|minutes|seconds|meridiem)$/i.test(String(r.matched || r.key)));
      /* SAID ONCE, FOR THE NEXT CALL — not repeated per field. A trigger that only answers the
         keyboard answers it every time, so an agent about to drive this control itself should press
         at the trigger rather than click the option, and an agent about to trust a reply about it
         should know its accessible name will never show the value. Only the ones that actually
         WORKED are listed: a keyboard attempt that failed is already in `stillWrong`. */
      /* BY A FLAG, NOT BY A REGEX OVER PROSE. The older repair path also says "at the trigger" in
         its `via`, so matching the sentence would sometimes name a field repaired by the other
         route and attach the wrong explanation to it. The flag is set at exactly one place. */
      const keyboardOnly = repaired.filter((x) => x.ok && x.byKeyboard).map((x) => x.field);
      verified = {
        disagreed: wrong.map((r) => r.key),
        repaired,
        ...(stillWrong.length ? { stillWrong } : {}),
        ...(keyboardOnly.length
          ? { keyboardOnly: { fields: keyboardOnly, why: 'a synthetic click on their options carries no mousedown and no focus, so it commits nothing — they were set with ArrowDown ×N + Enter addressed at the TRIGGER (qa_press { ref }), and their accessible name is an aria-label that never shows the value: read them with qa_read, not from the snapshot name' } }
          : {}),
        ...(dateish.length
          ? { note: 'those are the SECTIONS of a date field (MUI X and friends): the component rewrites them from its own state, so a written value never sticks. Open its calendar instead — qa_click the "Choose <field>" button, switch to the year view, pick the year, step the month, click the day.' }
          : {}),
      };
    }
  }

  /* ONE CALL PER STEP — the fill AND the Next, with the gate between them.
   *
   * Three independent reviews of today's 40-call run on demo/react landed on the same lever: a
   * wizard step costs five calls and four of them are bookkeeping — a snapshot to see the step, the
   * fill, a click on Next, a snapshot to see what the click did. This call already holds everything
   * those four need, so it presses Next itself and hands the NEXT step's field names back.
   *
   * THE GATE IS THE DESIGN, NOT THE CLICK. Advancing past a step that did not take its data is worse
   * than an extra call: the wizard keeps the half it got, the agent believes the step is behind it,
   * and the truth surfaces four steps later as a Submit that will not enable. So the control is
   * refused whenever this fill was anything but clean, and each refusal names its reason.
   *
   * `verified.unreadable` is deliberately NOT one of those reasons. A chips field never quotes its
   * value back to the tree, and reading "cannot be read" as "did not land" is the same mistake that
   * once made the repair toggle a multi-select back OFF — see the ladder above. */
  let advancing = null;
  if (advance) {
    const failed = (filled?.results || []).filter((r) => r && r.ok === false).length;
    const blocked = [];
    if (!((filled?.filled || 0) > 0)) blocked.push('the batch filled nothing');
    if (failed) blocked.push(`${failed} of the ${batch.length} entries came back ok:false`);
    if (verified?.stillWrong?.length) blocked.push(`still wrong after the repair: ${verified.stillWrong.join(', ')}`);
    if (unmatched.length) blocked.push(`these keys matched no control, so their values never went in: ${unmatched.join(', ')}`);
    if (blocked.length) {
      advancing = { advanced: { control: advance, clicked: false, ok: false, why: 'not pressed — this fill is not clean', blocked } };
    } else {
      /* A FAILING ADVANCE MUST NOT DESTROY THE FILL'S OWN REPORT. `callExtension` REJECTS on a
         transport error or a timeout, and an exception thrown here would be caught by the tool
         handler and returned as an error — throwing away the news that the fields went in. */
      advancing = await advanceAfterFill(tabId, advance, {
        // The PAGE's names for what was just written, not the dataset's keys: this is what the
        // after-snapshot is compared against to tell a real step swap from a Next that did nothing.
        filledNames: resolved.filter((r) => r.value !== 'click').map((r) => r.matched || r.key),
        wantNext: next !== false,
      }).catch((e) => ({
        advanced: { control: advance, clicked: false, ok: false, why: `the advance could not be driven: ${String(e?.message || e)}` },
      }));
    }
  }

  return { ok: (filled?.filled || 0) > 0, ...out, filled: filled?.filled, total: filled?.total, results: filled?.results, ...(verified ? { verified } : {}), ...(advancing || {}) };
}

/** Required controls that show no value — minus the ones this call just filled.
 *
 *  The subtraction is the whole point. A control whose value the tree cannot quote (Ant's chips, a
 *  portalled trigger) reads as empty here, and naming a field we have just written as "still needed"
 *  is an invitation to write it again — which on a multi-select TOGGLES IT OFF. That bug is
 *  documented in the verify ladder above and must not come back through a hint. */
function stillNeededOn(nodes, filledNames) {
  const mine = new Set((filledNames || []).map(norm).filter(Boolean));
  return nodes
    .filter((n) => isFieldNode(n) && n.name && !mine.has(norm(n.name)))
    .filter((n) => /required/.test(String(n.state || '')) && !/value=|checked|selected/.test(String(n.state || '')))
    .map((n) => n.name)
    .slice(0, 12);
}

/** Names that mean "this control goes forward" — so the reply can say what to pass as `advance` next. */
const FORWARD_NAME = /^(next|continue|proceed|forward|submit|finish|complete|done|save|apply|create|confirm|sign)\b/i;

/**
 * THE STEP YOU ARE NOW ON, in the only currency that survives a re-render: names.
 *
 * Deliberately not refs and not a tree. The agent's next call is another qa_fill_json keyed by
 * label, so a list of labels is exactly what it needs and the cheapest thing to carry — and a ref
 * would be void by then anyway, because that call takes its own snapshot and renumbers everything.
 */
function describeStep(nodes, url) {
  /* A TRIGGER IS A FIELD even when the snapshot calls it a button. Headless UI's Listbox and
     downshift's useSelect render `<button aria-haspopup="listbox">`, which fillByNames finds with
     its second, filter-less look — so leaving it out of the list here would under-report the step
     it is about to fill. The snapshot does not carry aria-haspopup, but it does carry the expanded
     state, and a button that can expand is a control with a value, not a navigation button. */
  const looksField = (n) => isFieldNode(n) || ((n.role === 'button' || n.role === 'link') && /expanded|collapsed/.test(String(n.state || '')));
  const headings = nodes.filter((n) => n.role === 'heading' && n.name);
  // h2/h3 first: the h1 is the page, the h2 is the step (demo/react renders `<h2>{step} · …</h2>`).
  const heading = headings.find((n) => /^h[23]$/.test(n.tag)) || headings[0];
  const fields = [];
  for (const n of nodes) {
    if (fields.length >= 40) break;
    if (!looksField(n) || !n.name) continue;
    // The star is cosmetic — norm() strips a trailing one, so the name still works as a key verbatim.
    fields.push(/required/.test(String(n.state || '')) ? `${n.name} *` : n.name);
  }
  const buttons = nodes.filter((n) => (n.role === 'button' || n.role === 'link') && n.name);
  const forward = [...new Set(buttons.filter((n) => FORWARD_NAME.test(n.name.trim())).map((n) => n.name))].slice(0, 6);
  return {
    url,
    ...(heading ? { title: heading.name } : {}),
    fields,
    ...(forward.length ? { advanceLooksLike: forward } : {}),
    note: 'the controls of the step you are on NOW, read from the snapshot taken after the click — you do not need a qa_snapshot of your own. A trailing * means the control reports itself required and is ignored when matching; two controls with the same label are addressed as "Label" and "Label#2".',
  };
}

/**
 * PRESS THE ADVANCE CONTROL — and be honest about whether the page actually moved.
 *
 * Lifted from applyRecipeStep's advance block, which has been right about the hard part since the
 * first live wizard: THE CONTROL IS RE-RESOLVED, NEVER REUSED. Its ref came from a snapshot taken
 * before the fill, filling re-renders, and a new snapshot RENUMBERS every ref — that is how a run
 * once pressed "Back" while the click reported success. A NAME survives both, so it is resolved
 * here, against a snapshot taken at this moment.
 *
 * Two rules this adds, both because the click's own `ok` is worth nothing for this question:
 *
 *   1. A DISABLED Next accepts the click and does nothing. The React stand spells it
 *      `disabled={!!missing[step - 1].length}`, and the snapshot already carries the answer —
 *      stateOf() emits `disabled` — so the state is READ before clicking instead of inferred after.
 *      One 400ms retry first: a form that validates on a debounce is still disabled a moment after
 *      the last write and then enables itself.
 *   2. "It advanced" is a property of the DIFF. A step swap replaces its fields wholesale, so both
 *      sides are large — the same evidence the `navigated` behaviour keys on in widgets.mjs. Nothing
 *      else produces it: a dropdown opening only appends, a validation message only appends. The
 *      extension caps each side of the diff at 12 nodes, so the thresholds stay small on purpose.
 */
async function advanceAfterFill(tabId, advanceName, { filledNames = [], wantNext = true } = {}) {
  const look = async () => {
    const s = await callExtension('qa_snapshot', { tabId }, 30_000);
    rememberSnapshot(tabId, s);
    const ns = Array.isArray(s?.nodes) ? s.nodes : [];
    const pool = ns.filter((n) => CLICKABLE_ROLES.has(n.role));
    /* EXACT FIRST, AND SEPARATELY FROM pickNode's SOFT TIERS. An open react-datepicker puts "Next
       Month" and "Next Year" in the tree, and a library with a focus trap sets aria-hidden on
       everything outside its popup — which takes the real Next OUT of the tree entirely. pickNode
       would then prefix-match "Next" onto "Next Year" and steer the calendar instead of the wizard. */
    const exact = pool.filter((n) => norm(n.name) === norm(advanceName));
    return { url: s?.url || '', nodes: ns, hit: exact.length ? { node: exact[0] } : null };
  };
  let seen = await look();
  let loose = false;
  if (!seen.hit) {
    /* ESCAPE ONLY WHEN A POPUP IS ACTUALLY OPEN, and this condition is the difference between a
       recovery and a disaster. A leftover list from the last field aria-hides the rest of the page
       (Radix, Headless UI), so the real Next is not in the tree at all and one Escape brings it
       back. But a wizard living in a DISMISSIBLE MODAL answers Escape by closing itself, and
       everything this call just wrote goes with it. An exact-match miss on its own means almost
       nothing — "Next step" is not "Next" — so the untrap is spent only when the tree shows an open
       popup, which a trapped page always does: the popup is the one subtree NOT aria-hidden. */
    const popupOpen = seen.nodes.some((n) => n.role === 'option' || n.role === 'treeitem' || /expanded/.test(String(n.state || '')));
    if (popupOpen) {
      await clearPopups(tabId);
      seen = await look();
    }
    if (!seen.hit) {
      const pool = seen.nodes.filter((n) => CLICKABLE_ROLES.has(n.role));
      const soft = pickNode(pool.length ? pool : seen.nodes, { name: advanceName }, new Set());
      if (soft) {
        seen = { ...seen, hit: soft };
        loose = true;
      }
    }
  }
  if (!seen.hit) {
    return {
      advanced: {
        control: advanceName,
        clicked: false,
        ok: false,
        why: `nothing clickable is called "${advanceName}"`,
        clickableOnThePage: seen.nodes.filter((n) => CLICKABLE_ROLES.has(n.role) && n.name).map((n) => n.name).slice(0, 20),
      },
    };
  }
  if (/disabled/.test(String(seen.hit.node.state || ''))) {
    await new Promise((r) => setTimeout(r, 400));
    const again = await look();
    if (again.hit) seen = again;
  }
  if (/disabled/.test(String(seen.hit.node.state || ''))) {
    const need = stillNeededOn(seen.nodes, filledNames);
    return {
      advanced: {
        control: seen.hit.node.name || advanceName,
        clicked: false,
        ok: false,
        why: 'the control is DISABLED — nothing was pressed',
        note: 'the step has not validated, so pressing it would have reported success and done nothing. Fill what is still missing and call again with the same `advance`.',
        ...(need.length ? { stillNeeded: need } : {}),
      },
    };
  }

  // Resolved while the memory still holds the PRE-click page, so the journal records the button by
  // the name a human reads. stepsFromJournal treats a click as the thing that CLOSES a step.
  const item = targetOf(tabId, seen.hit.node.ref, seen.hit.node.selector);
  const urlBefore = seen.url;
  const clicked = await callExtension('qa_click', { tabId, ref: seen.hit.node.ref }, 20_000);
  if (clicked?.ok === false) {
    return { advanced: { control: item.name || advanceName, clicked: false, ok: false, why: `the extension refused the click: ${clicked.error || 'no reason given'}` } };
  }
  // A wizard mounts the next step's fields once the click settles, and the snapshot below is what
  // the agent will be told about — so give them the beat applyRecipeStep gives them.
  await new Promise((r) => setTimeout(r, 450));

  const d = diffDigest(clicked?.changed ?? {});
  const moved = d.appeared.length >= 1 && d.disappeared.length >= 1;
  const swapped = d.appeared.length >= 3 && d.disappeared.length >= 3;
  const s = await callExtension('qa_snapshot', { tabId }, 30_000);
  const nodesAfter = Array.isArray(s?.nodes) ? s.nodes : [];
  const urlAfter = s?.url || urlBefore;
  const routed = !!(urlBefore && urlAfter && urlBefore !== urlAfter);
  /* THE CORROBORATION THE DIFF CANNOT GIVE: are the fields we just filled still here? A step that
     swapped took its own controls with it, which covers the small step whose swap does not reach the
     thresholds above. It is matched against EVERY named node, not just the field-shaped ones, so a
     trigger that is a button does not read as gone. And it only counts alongside a diff that moved:
     a select renames itself when it takes a value — during the FILL, not during this click — so on
     its own it would call a page that never budged a step swap. */
  const namesAfter = new Set(nodesAfter.filter((n) => n.name).map((n) => norm(n.name)).filter(Boolean));
  /* ONLY NAMES THAT WERE STILL ON THE PAGE A MOMENT AGO can count as "gone". A trigger whose
     accessible name IS its value (MUI's role=combobox div, a chips field) renames itself when it
     takes the value — during the FILL, not during this click — so its old name is already missing
     before the button is pressed. Counted naively that makes a page which never budged look like a
     step swap: one relabelled button ("Next" → "Saving…") satisfies `moved`, and fields that went
     nowhere satisfy `fieldsGone`. Measured against the PRE-click tree, the whole class is gone. */
  const namesBefore = new Set(seen.nodes.filter((n) => n.name).map((n) => norm(n.name)).filter(Boolean));
  const wanted = filledNames.map(norm).filter((n) => n && namesBefore.has(n));
  const gone = wanted.filter((n) => !namesAfter.has(n));
  const fieldsGone = namesAfter.size > 0 && wanted.length > 0 && gone.length >= Math.ceil(wanted.length * 0.6);
  const ok = routed || swapped || (moved && fieldsGone);

  const why = [
    d.appeared.length || d.disappeared.length ? `${d.appeared.length} appeared, ${d.disappeared.length} disappeared` : 'the page did not move',
    routed ? `the url changed to ${urlAfter}` : '',
    wanted.length ? `${gone.length} of the ${wanted.length} fields just filled are no longer on the page` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  /* JOURNALLED ONLY IF IT MOVED. stepsFromJournal reads a click as the END of a step and stores it
     as that step's `advance`; a click that changed nothing ended nothing, and recording it would cut
     one step of a saved recipe in two. The entry carries the post-click url, which is harmless: a
     step takes its url from its first FILL, and a click's url is only ever used for the host filter. */
  /* JOURNALLED BEFORE THE MEMORY MOVES ON. `note` stamps the entry with the url held in snapMemory,
     and a recipe step is filtered by host — so remembering the after-page first would file a
     cross-origin advance under the NEW host and drop it from the saved recipe. Only if it moved:
     stepsFromJournal reads a click as the END of a step, and a click that changed nothing ended
     nothing — recording it would cut one recipe step in two. */
  if (ok) note('click', tabId, [item]);
  rememberSnapshot(tabId, s);

  if (!ok) {
    const need = stillNeededOn(nodesAfter, filledNames);
    return {
      advanced: {
        control: item.name || advanceName,
        clicked: true,
        ok: false,
        why,
        note: moved
          ? 'something changed, but not in the shape of a step swap — you may still be on the same step. Look before you fill anything else.'
          : 'the control took the click and the page did not move, so you are still on this step: a Next that is not enabled does exactly this. Do not treat the step as done.',
        ...(loose ? { matchedLoosely: true } : {}),
        ...(need.length ? { stillNeeded: need } : {}),
      },
    };
  }
  return {
    advanced: { control: item.name || advanceName, clicked: true, ok: true, why, ...(loose ? { matchedLoosely: true } : {}) },
    ...(wantNext ? { next: describeStep(nodesAfter, urlAfter) } : {}),
  };
}

/* ── COMPOSITE WIDGETS, DRIVEN FROM HERE ─────────────────────────────────────────
 *
 * The React stand (2026-07-29) drew the line precisely: everything that is "a trigger and a flat
 * list of options" already works — react-select, Radix, Headless UI, MUI Select and Autocomplete.
 * What does not is the shape where ONE value needs SEVERAL interactions:
 *
 *   · Ant Cascader / TreeSelect — country → region → city, one column per level
 *   · every calendar — the year and the month are their own controls, and each library spells them
 *     differently (MUI "switch to year view", Ant's year/month buttons, react-datepicker's selects)
 *
 * Teaching the extension's fill engine each of those means a Web Store release. Composing them out
 * of clicks the bridge ALREADY has means today, for every install — and the agent still spends one
 * call. That is the whole reason these two verbs live in this process.
 */
/** Everything a "level" of a cascader / tree / submenu is spelled as in the wild. */
const LEVEL_ROLES = ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'checkbox', 'radio', 'button', 'gridcell', 'cell', 'td', 'th', 'row', 'listitem', 'link', 'tab'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* A CALENDAR IN THE PAGE'S OWN LANGUAGE (Allegro, 03.11.2026). Its header said «październik 2026»,
 * its arrows «Poprzedni miesiąc», its year was a «Rok» spinbox and its days were named «26 marca
 * 2019». Every name the date verb looked for was English, so it read no header, stepped nothing and
 * clicked «26» in whatever month was showing: 26 October 2026 instead of 26 March 2019, reported as
 * a miss only by luck. Month names come from Node's own ICU, both the standalone form («marzec»)
 * and the one inside a date («marca»), so no list is typed by hand. Croatian is left out on purpose:
 * its «listopad» is October, while Polish, Czech and Ukrainian use the same word for November. */
const CAL_LOCALES = ['en', 'pl', 'ru', 'uk', 'de', 'es', 'pt', 'fr', 'it', 'cs', 'sk', 'nl', 'ro', 'hu', 'tr', 'kk', 'lt', 'lv', 'et', 'sv', 'da', 'fi', 'nb', 'bg', 'el'];
const MONTH_FORMS = (() => {
  const forms = Array.from({ length: 12 }, () => new Set());
  for (let m = 0; m < 12; m++) {
    const d = new Date(Date.UTC(2021, m, 15));
    const add = (s) => { const v = String(s || '').toLowerCase().replace(/\.$/, '').trim(); if (v.length >= 3) forms[m].add(v); };
    add(MONTHS_LONG[m]);
    add(MONTHS_LONG[m].slice(0, 3));
    for (const loc of CAL_LOCALES) {
      try {
        add(new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' }).format(d));
        add(new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' }).formatToParts(d).find((p) => p.type === 'month')?.value);
      } catch {
        /* a locale this Node was built without */
      }
    }
  }
  return forms.map((s) => [...s].map((f) => ({ f, re: new RegExp(`(?<![\\p{L}])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u') })));
})();
/** The month a piece of calendar text names, in any of CAL_LOCALES; the longest matching form wins. */
function monthIn(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  for (let m = 0; m < 12; m++) for (const { f, re } of MONTH_FORMS[m]) if ((!best || f.length > best.len) && re.test(t)) best = { month: m + 1, len: f.length };
  return best?.month ?? null;
}
/** How a day cell may be named in full: «26 marca 2019», «March 26, 2019», «26. März 2019». */
function fullDateNames(day, month, year) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const out = new Set();
  for (const loc of CAL_LOCALES) {
    for (const opts of [{ day: 'numeric', month: 'long', year: 'numeric' }, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }]) {
      try { out.add(new Intl.DateTimeFormat(loc, { ...opts, timeZone: 'UTC' }).format(d)); } catch { /* not built in */ }
    }
  }
  return [...out];
}
const PREV_MONTH_NAMES = ['Previous month', 'Poprzedni miesiąc', 'Предыдущий месяц', 'Попередній місяць', 'Vorheriger Monat', 'Mes anterior', 'Mês anterior', 'Mois précédent', 'Mese precedente', 'Předchozí měsíc', 'Vorige maand', 'prev', 'previous'];
const NEXT_MONTH_NAMES = ['Next month', 'Następny miesiąc', 'Следующий месяц', 'Наступний місяць', 'Nächster Monat', 'Mes siguiente', 'Próximo mês', 'Mois suivant', 'Mese successivo', 'Další měsíc', 'Volgende maand', 'next'];
const YEAR_FIELD = /^(year|rok|год|рік|jahr|año|ano|année|anno|jaar|yıl|év|metai|gads|aasta|år|vuosi|година|έτος)\b/i;
/** Where the popular libraries write the month+year they are showing. Read-only, and cheap. */
const ANT_OPEN = '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)';
const CAL_HEADER_SELECTORS = [
  '.MuiPickersCalendarHeader-label',        // MUI X
  // Scoped to the VISIBLE dropdown: Ant keeps a closed picker's portal in the DOM, and a hidden one
  // still has text — reading it is how a verb ends up steering last field's calendar.
  `${ANT_OPEN} .ant-picker-header-view`,    // Ant Design
  '.react-datepicker__current-month',       // react-datepicker
  '.rdp-caption_label',                     // react-day-picker
  '.cal .title',                            // hand-rolled (our vanilla stand)
];

/**
 * WRITE THE TEXT AND COMMIT IT — the fast route, tried before any popup is opened.
 *
 * Measured on the live stand (2026-07-30): an Ant DatePicker driven through its calendar costs 26
 * seconds — a year panel, decade hops, a day cell — and the same field TYPED costs 0.48. A range
 * costs 35 seconds against 0.68, a TreeSelect 24 against 1.6, a TimePicker 14 against 0.47. Every
 * composite in these libraries has its own text input and accepts the value in the format it
 * DISPLAYS. So the order is: write it, read it back, and only steer the widget if it did not stick.
 *
 * `raw` is what makes it possible: the extension's default path opens the popover on purpose and
 * converts a date-ish value to ISO, which is right for <input type=date> and wrong for a component
 * whose format is DD/MM/YYYY.
 */
async function rawType(tabId, name, text, { commit = 'Enter', blur = false } = {}) {
  const found = await findClickable(tabId, name, null);
  if (!found.hit) return { ok: false, error: `no field is called "${name}"` };
  const res = await callExtension('qa_type', { tabId, ref: found.hit.node.ref, value: String(text), raw: true, commit, blur }, 20_000).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  return { ...res, ref: found.hit.node.ref };
}

/** Click by ref, and tell the caller plainly if the target vanished. */
async function clickRef(tabId, ref) {
  return callExtension('qa_click', { tabId, ref }, 20_000);
}

/**
 * CLEAR THE DECK before opening anything. One Escape, ~20ms, and it removes a whole class of
 * failure that cost most of a day (2026-07-30): a popup left open by the PREVIOUS field swallows
 * the opening click of the next one, and the verb then reports something that sounds like its own
 * bug — "the year button is not visible", "day 5 is not clickable in the open calendar" — when the
 * calendar in question never opened. Every verb that opens a popup starts here.
 */
async function clearPopups(tabId) {
  await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  await new Promise((r) => setTimeout(r, 180));
}

/**
 * ANSWER THE QUESTION THE DIFF RAISES, in the same reply.
 *
 * `qa_click` already returns what changed. That is data, and every session so far I have re-read
 * it as prose and re-derived the same conclusion — a list of day numbers means a calendar, two
 * options mean a select, an `expanded` with nothing behind it means a portalled popup with no
 * roles. The conclusion belongs in the reply, once, in code (owner, 2026-07-29: "нужно как-то
 * системно, кодом запомнить, как определять, что это именно такого типа элемент").
 *
 * `widget.drive` is written as an instruction rather than a description on purpose: it is read by
 * an agent mid-flow, and the next call is the only thing it can change.
 */
/**
 * THE DEAD-ACTION REPLY IS WHERE HELP IS WORTH MOST, AND IT WAS THE ONE PLACE WITH NONE.
 *
 * The ladder has always ridden REFUSALS (`withStuckHelp`, which requires ok:false). But the
 * commonest dead end is not a refusal — it is `ok: true` with nothing changed, which is exactly
 * what Figma answered a session on 12.10.2026 before it declared a wall that was not there. An
 * answer that says «no» hands over the next move; the answer that says «yes, and nothing
 * happened» used to hand over a conclusion.
 *
 * Two more things are measured here rather than guessed, and both cost one extra second on an
 * action that already failed — never on one that worked:
 *
 *  · WAS THE PAGE EVEN FINISHED LOADING? The same session read six buttons off a Figma editor
 *    that had forty-six a minute later and reasoned from the six. Counting twice, a beat apart,
 *    turns that from an invisible wrong answer into a sentence.
 *  · WHAT COULD HAVE BEEN PRESSED INSTEAD? When a KEY went nowhere, the useful reply is not
 *    «the key did nothing» but the names of the tool buttons sitting on the page — which the
 *    bridge can read and the agent cannot guess.
 */
async function inertHelp(tabId, verb) {
  const buttons = async () => {
    const r = await callExtension('qa_collect', { tabId, nodes: { role: 'button' }, take: ['name'], limit: 300 }, 15_000).catch(() => null);
    return Array.isArray(r?.nodes) ? r.nodes.map((n) => (n.name || '').trim()).filter(Boolean) : null;
  };
  const first = await buttons();
  if (!first) return null;
  await new Promise((r) => setTimeout(r, 1200));
  const second = await buttons();
  const out = {};
  /* A quarter more controls in a second and a bit is not a page settling, it is a page still
     arriving — and every reading taken before now is about a different page. */
  if (second && first.length && second.length >= first.length * 1.25) {
    out.stillLoading = `The page was still loading while this ran: ${first.length} controls a second ago, ${second.length} now. Anything read before this is about a half-built page — take the reading again.`;
  }
  const names = second || first;
  if (verb === 'press' && names.length) {
    out.pressTheseInstead = {
      why: 'This application may not take synthetic key events — Figma, Miro and Canva all swallow them into a hidden input. The same tools are almost always on screen as buttons, and those DO take a click.',
      call: 'qa_click { name: "<one of these>" }',
      buttons: names.slice(0, 24),
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A REF IN THE DIFF IS A REF THAT CANNOT BE USED — so it does not go out.
 *
 * The diff is built from its own snapshot, taken with `trackRefs: false` (changes.ts) precisely
 * so that comparing the page does NOT clobber the ref map the caller is holding. That is the
 * right decision. The consequence was not: the nodes still carried `ref` fields, numbered inside
 * that private snapshot, and they were printed in the reply beside names an agent recognises.
 *
 * So an agent read «appeared: BCAA [ref=e9]», called qa_click { ref: "e9" }, and pressed whatever
 * e9 happened to be in the LAST REAL snapshot — a tab in the bottom navigation. Twice in one run
 * (Shelf, 11.10.2026), silently, because nothing about a wrong-but-valid ref is refusable.
 *
 * The fields that survive are the ones that actually work from here: `name` (qa_click takes it),
 * `role` and `selector` (every verb takes one). What is removed is the one that looks the most
 * useful and is the only one that lies.
 */
/** Did the diff carry anything at all? The extension sends three lists; any one of them filled
 *  means the page moved. `null` (nothing was comparable) counts as «did not move». */
function diffIsEmptyish(changed) {
  if (!changed || typeof changed !== 'object') return true;
  const n = (l) => (Array.isArray(l) ? l.length : 0);
  return n(changed.appeared) + n(changed.disappeared) + n(changed.updated) === 0;
}

function stripDiffRefs(changed) {
  if (!changed || typeof changed !== 'object') return changed;
  const clean = (list) =>
    Array.isArray(list) ? list.map(({ ref, ...rest }) => rest) : list;
  return { ...changed, appeared: clean(changed.appeared), disappeared: clean(changed.disappeared) };
}

async function withVerdict(res, tabId, verb) {
  if (!res || typeof res !== 'object' || res.ok === false) return res;
  if (res.changed) res = { ...res, changed: stripDiffRefs(res.changed) };
  /* Settle the loop counter against what the page DID, not against the label — see
     `noticedOutcome`. A navigation counts as movement even with no diff to show for it. */
  noticedOutcome(!!res.navigated || !!(res.changed && !diffIsEmptyish(res.changed)));
  const verdict = classifyBehaviour(res.changed, { measured: res.measured, navigated: res.navigated, requests: res.requests || 0 });
  const out = withHello(verdict ? { ...res, widget: verdict } : { ...res }, tabId);
  if (verdict?.kind === 'inert') {
    /* The same ladder a refusal gets, for the same reason: this is a dead end, and the agent is
       about to decide what it means. `brief` would be the wrong economy here — the long form is
       what names qa_probe and the per-shape verbs. */
    if (!out.whatNow) out.whatNow = stuckHelp('nothing changed');
    const extra = await inertHelp(tabId, verb).catch(() => null);
    if (extra) Object.assign(out, extra);
  }
  const remember = rememberFormHint(tabId);
  if (remember) out.rememberThisForm = remember;
  return withPostcard(await followAfter(out, tabId, verb));
}

/**
 * HELLO — the bridge introducing itself, once, on first contact.
 *
 * Owner, 2026-07-30: "когда первый контакт с сессией — какое-нибудь лёгкое знание о себе, что ты
 * умеешь… и чтобы между сессиями тоже. Но на одном порту могут крутиться разные проекты, подумай
 * об этом." Both halves matter and the second one shapes the first: the `instructions` field handed
 * over at initialize is the manual, and a manual is not a greeting — it does not know WHERE you
 * are. This does. It rides the first reply that carries a URL, and what it says about the past is
 * scoped to THIS HOST, so a bridge shared by three projects greets each one with its own history and
 * never leaks one project's flows into another's session.
 *
 * Short on purpose: an agent pays for every token of it, and it is only ever read once.
 */
let greeted = false;
function greeting(tabId) {
  if (greeted) return null;
  const url = rememberedUrl(tabId);
  const host = hostOf(url);
  if (!host) return null;           // wait for a call that actually knows where we are
  greeted = true;
  let known = [];
  try {
    known = listRecipes().filter((r) => r.host === host);
  } catch {
    /* an unreadable recipes dir is not worth failing a greeting over */
  }
  return {
    iAm: `Qiksy ${VERSION} — the bridge into the browser this person already has open. Their profile, their sessions, the tab they are looking at. I never launch a browser, never switch tabs and never take the pointer.`,
    goodAt:
      "reading a page as an accessibility tree with boxes in real pixels · computed styles and which design TOKEN a colour came from · what the browser itself saw go wrong (failed requests arrive with the server's error body) · and filling a form: a whole wizard step in one call, with the composite widgets — calendars, cascaders, trees, tags, time — each having a verb of its own.",
    /* THE LIST, ONCE, AT THE START (owner ask 2026-08-04, after watching a colleague's agent reach
       for Playwright on the first unfamiliar field). `instructions` already says all of this, but it
       is handed over at initialize and read once, cold, before there is a page — and what an agent
       does under pressure is what it can still recall. So the first reply that knows where we are
       repeats the CAPABILITIES as a flat list of things it can DO, in the words a task is phrased
       in, and names the switch it must not reach for. Short lines on purpose: this is a reminder,
       not the manual. */
    iCan: [
      'fill any form — a whole wizard step in ONE call (qa_fill_json), custom dropdowns, calendars, cascaders, trees, tags and time included',
      'click, press keys, and tell you from the DIFF what actually changed',
      'sign in through a real identity provider — Microsoft/Entra, Google, Okta: this is their own browser, and a tab the login opens joins the session by itself',
      'run several logins at once in the same browser, one cookie jar per tab (qa_open_isolated)',
      'attach files by path from this machine (qa_upload), navigate (qa_navigate), read and write localStorage (qa_storage)',
      'read the page as a tree with every box in CSS pixels, the computed styles and the design token behind a colour',
      'hand back what the browser itself saw: console and JS errors, failed requests WITH the server body, a11y defects, axe-core, the real Tab route, speed',
      'bring a tab in front of the human (qa_focus_tab) and outline an element for them (qa_spotlight) — that is how a walkthrough happens where they are looking',
      'remember a long form and replay it next time (qa_recipe_save / qa_recipe_apply)',
      'take a real PICTURE of the page or of one element (qa_screenshot), or of THE WHOLE PAGE top to bottom with `full: true` — panel hidden, password and card fields covered; the tab has to be in front',
      'WAIT for a named condition instead of polling (qa_wait_for): something appears, disappears, becomes enabled, the count changes, a live region speaks, the address changes',
      'reload the tab as it stands (qa_reload) — done by the browser, so it works even when the page script is already dead',
      'wait for a PERSON to sign in: tell them, then call qa_wait_for { urlContains, timeoutMs: 300000 } yourself — never ask them to write that they are done',
      'open a page that is not open yet (qa_open_tab { url }) — do it yourself, do not ask the human',
      'the full manual, or one topic of it, is qa_help — call it before guessing',
    ],
    cannot: 'no arbitrary JavaScript — every verb names an element, never a program. Pictures I do have: qa_screenshot photographs the page or one element, but only while the tab is in FRONT, because the browser photographs the active tab and I refuse to hand over a different one.',
    ifSomethingRefuses:
      'take the ladder, do not change tool: qa_probe { name } says what the widget is and which verb drives it · raw:true writes the value straight in · qa_pick_date/time/range/path/tags each drive one shape · every verb also accepts a CSS selector. Another browser driver would open an EMPTY browser without these logins, so it is not a fallback — it is a different test.',
    iGoFirst:
      'For anything in a browser, I am the first tool in this project — even where another driver is configured. Hand over only when the task needs one of the two things I do not have (a picture, or arbitrary JS): say which one, look at what the environment offers, name the tool you are switching to, then come back here for the rest.',
    ...(docsReport ? { iJustWroteTheDocs: docsReport } : {}),
    onThisHost:
      known.length
        ? `we have been here before — ${known.length} saved recipe${known.length === 1 ? '' : 's'}: ${known.map((r) => r.name).slice(0, 5).join(', ')}. qa_recipe_list, then qa_recipe_apply, and the second pass costs a call per step instead of a discovery.`
        : `first time on ${host} for me. If this turns into a long form, ask me to remember it at the end (qa_recipe_save) — that is how the next visit gets cheap.`,
    note: 'This port is shared: several projects may drive me at once, so what I just said about the past is scoped to this host only.',
    /* AND SAY HELLO (owner, 2026-07-30: "чтобы человек человеку передал — Квикси вам передал
       привет"; then, same day: "не культурного, а грубияна, но харизматичного"). Once per session,
       relayed by the agent in the HUMAN's language — see RELAY, which asks for a re-say rather than
       a translation, because a literal rendering of an aside like this reads as a glitch. */
    forTheHuman:
      VOICE === 'off'
        ? undefined
        : {
            say: HELLOS[VOICE][Math.floor(Math.random() * HELLOS[VOICE].length)],
            tone: VOICE === 'rude' ? "blunt, funny, mildly sweary, never at the human's expense" : 'warm and plain',
            relay: RELAY[VOICE],
          },
    /**
     * WHAT I CAN DO — SAID TO THE PERSON, ONCE, WHEN THEY FIRST CONNECT ME (owner ask 03.09.2026).
     *
     * The list above this one is for the AGENT: verb names, gates, ladders. A person connecting
     * the bridge for the first time gets none of that — they wired a token into a config file and
     * then have to guess what they bought. Everything in here has been true for months and was
     * simply never said to them.
     *
     * IN THE LANGUAGE THEY CHOSE, and that is the one thing this process could not work out on
     * its own: it never sees the conversation. But the human already answered the question by
     * picking a language in the panel, and the extension now sends that along — so this is not a
     * guess from the agent's side either. When the panel has not been set, the agent still knows
     * which language the person is writing in, and that is the fallback named in the note.
     *
     * SHORT LINES, PLAIN WORDS, NO VERB NAMES. The verbs are the agent's business; what the
     * person needs is the shape of what they can now ask for.
     */
    tellThemWhatICanDo: {
      when: 'Once, right after the first connection on this machine — not again later in the session.',
      ...(uiLanguage ? { theirLanguage: uiLanguage } : {}),
      relay:
        'Say this to the HUMAN, once, at the top of your next message. ' +
        (uiLanguage
          ? `They set the Qiksy panel to "${uiLanguage}" — say it in THAT language, not in the language of this string. `
          : 'Say it in the language they are writing to you in, not in the language of this string. ') +
        'RE-SAY it rather than translating word for word: a short friendly line, then the list as bullets, then one sentence about the one thing to be aware of. Do not read out the tool names — those are yours, not theirs. Then get on with the work.',
      intro: 'Qiksy is connected. It drives the browser you already have open — your profile, your logins, the tab you are looking at. Here is what you can now ask for:',
      list: [
        'fill in a whole form, or one step of a long wizard, in one go — including the awkward ones: dropdowns that are not really dropdowns, calendars, trees, tags, time pickers',
        'take a screenshot of the page or of a single element — passwords and card numbers are covered before the picture is taken',
        'click, type, press keys — and say what actually changed on the page as a result',
        'wait for something to happen instead of guessing: a confirmation that arrives late, a button that stops being grey, a list that fills up',
        'show you what the browser itself saw go wrong: errors, failed requests with the server\'s own message, accessibility defects, the real Tab order',
        'sign in through your company\'s login — it is your browser, so a page that opens for the login just joins in',
        'run several accounts at once in the same browser, one session per tab',
        'record a long form once and replay it next time, so the second pass costs minutes instead of an hour',
        'answer a request with a made-up response — a 500, an empty list, a dropped connection — so the failure paths can be tested without touching the backend',
        'write a report of what was tested, with the evidence attached',
      ],
      oneCaveat:
        'It works in a tab in the background while you get on with something else — with one exception: a screenshot needs that tab to be in front, because the browser photographs whatever is on screen.',
    },
  };
}

/**
 * "REMEMBER THIS FORM" — the bridge asking for the recipe, instead of waiting to be asked.
 *
 * Owner, 2026-07-30: "можешь после каждого прогона, чтобы бридж давал понять Клоду, что ему нужно
 * запомнить структуру формы, когда он к ней вернётся?" He is right that waiting does not work:
 * qa_recipe_save is documented, and an agent mid-flow still forgets it, because the moment it pays
 * off is the NEXT session and nothing in this one insists. So the reply insists — once per tab, only
 * when there is something worth saving, and only when this host has no recipe yet.
 *
 * It rides on a CLICK because a click is what ends a step: by then the journal holds real steps, and
 * the agent is between steps rather than mid-widget.
 */
const nudgedTabs = new Set();
function rememberFormHint(tabId) {
  const url = rememberedUrl(tabId);
  const host = hostOf(url);
  if (!host) return null;
  const key = tabKey(tabId);
  if (nudgedTabs.has(key)) return null;
  const steps = stepsFromJournal(url);
  const fields = steps.reduce((n, st) => n + (st.fields?.length || 0), 0);
  // Not worth a recipe: a couple of fields is cheaper to redo than to maintain.
  if (steps.length < 2 && fields < 6) return null;
  let already = false;
  try {
    already = listRecipes().some((r) => r.host === host);
  } catch {
    /* an unreadable recipes dir must not silence the hint */
  }
  if (already) return null;
  nudgedTabs.add(key);
  return {
    saveIt: 'qa_recipe_save { name: "<a name you will recognise next time>" }',
    itWouldCapture: `${steps.length} step${steps.length === 1 ? '' : 's'}, ${fields} field${fields === 1 ? '' : 's'}`,
    why:
      'You have now worked out the STRUCTURE of this form — which control is a calendar, which is a tree, which value each field takes, and in what order the steps unlock. That knowledge dies with this session unless it is written down. The recipe keys everything by the field NAMES a human reads and records the widget KIND per field, so the next run drives a date through qa_pick_date and a tree through qa_pick_path without rediscovering either. Save it at the end of the flow, and tell the human where it went — the file is theirs, at the path the tool returns.',
  };
}

/** Attach a line for the human, when one is due. Never on a failure — that is not the moment. */
function withPostcard(res, earned = false) {
  if (!res || typeof res !== 'object' || res.ok === false) return res;
  const card = postcard({ earned });
  return card ? { ...res, qiksySays: card } : res;
}

/** The greeting, on whichever reply first knows which host we are on. */
function withHello(res, tabId) {
  if (!res || typeof res !== 'object') return res;
  const hi = greeting(tabId);
  return hi ? { ...res, hello: hi } : res;
}

/** Snapshot, then find one clickable node by name among the roles a popup uses. */
/* A LEFTOVER OPEN POPUP CAN HIDE THE WHOLE PAGE, and that is not a metaphor.
 *
 * Radix (and Headless UI, and any library with a real focus trap) sets `aria-hidden="true"` on
 * everything outside its open dropdown. The snapshot skips aria-hidden subtrees — correctly, that is
 * what the attribute means — so while such a list is open the tree contains almost nothing: on step 2
 * the field list came back holding a Radix `<style>` element's text and not one control (2026-07-30).
 * Every lookup then fails with "no field is called …", which reads like the field is gone.
 *
 * So: a tree with no fields at all is treated as a trapped page, not an empty one — Escape, snapshot
 * again, once. Costs nothing when nothing is open. */
async function snapshotUntrapped(tabId, wanted, frameId) {
  const snap = await callExtension('qa_snapshot', { tabId, frameId }, 30_000);
  if (!wanted) return snap;
  /* THE TRIGGER IS THE MISS ITSELF, not a guess about the tree. Counting "how many fields look
     present" was wrong: a trapped page still exposes a few odd nodes (a Radix <style> element's text
     read as a name), so the count never hit zero and the guard never fired. A name we asked for and
     did not find is the honest signal — and one Escape is a cheap thing to try before telling the
     caller a field does not exist. */
  const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  if (pickNode(nodes, { name: wanted }, new Set())) return snap;
  await callExtension('qa_press', { tabId, key: 'Escape', frameId }, 15_000).catch(() => {});
  await new Promise((r) => setTimeout(r, 240));
  const again = await callExtension('qa_snapshot', { tabId, frameId }, 30_000);
  return pickNode(Array.isArray(again?.nodes) ? again.nodes : [], { name: wanted }, new Set()) ? again : snap;
}

async function findClickable(tabId, name, roles, { strict = false, notRef } = {}) {
  /* Deliberately NOT the untrapping snapshot. This helper is what walks an OPEN popup — a year panel,
     a tree, a menu — where a miss is ordinary (the next level has not rendered yet) and pressing
     Escape would close the very thing being driven. It broke the MUI date the moment it was added
     here (2026-07-30). The guard belongs where a FIELD is being resolved, and only there. */
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
  rememberSnapshot(tabId, snap);
  let nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  if (notRef) nodes = nodes.filter((n) => n.ref !== notRef);
  const pool = roles ? nodes.filter((n) => roles.includes(n.role)) : nodes;
  /* `strict` exists because the fallback below is a trap for a LOOK-AHEAD.
   *
   * Falling back to every node is right for "click the thing called Next" — a date input is a
   * textbox, not a clickable role, and that fallback is what makes qa_click { name } work on Ant.
   * It is wrong when the question is "is the next level already on screen": a Cascader's own field
   * carries its current value IN ITS ACCESSIBLE NAME ("Ukraine / Kyiv oblast / Kyiv"), so the
   * look-ahead matched the field itself and skipped two real levels (2026-07-30). */
  if (strict) return { hit: pool.length ? pickNode(pool, { name }, new Set()) : null, nodes };
  const hit = pickNode(pool.length ? pool : nodes, { name }, new Set());
  return { hit, nodes };
}

/**
 * Walk a value that lives across several levels: a cascader, a tree, a menu of submenus.
 * One agent call, one click per level, each level found on a fresh snapshot because opening a
 * level is exactly what re-renders the popup.
 */
async function pickPath(tabId, name, path, { multi, keepOpen, paths } = {}) {
  const steps = [];
  await clearPopups(tabId);

  /* TYPE THE LEAF FIRST — the fast route through a tree, a cascader or a searchable select.
   *
   * Measured (2026-07-30): a TreeSelect walked by clicks costs 24 seconds, its leaf TYPED costs 1.6;
   * a Cascader costs 16.5 against under one. These controls have a text input and filter themselves
   * as you type, which is what a person does. So: write the leaf, commit, read the control back — and
   * only walk the levels if that did not take. A cascader needs one extra click, because its filtered
   * row is a whole path and Enter does not take it. */
  {
    const want = (paths && paths.length ? paths : [path]).filter((p) => p.length);
    const control = await findClickable(tabId, name, null);
    if (control.hit && control.hit.node.tag === 'input' && want.length) {
      const readBack = async () => {
        const back = await findClickable(tabId, name, null);
        let txt = String(back.hit?.node?.name || '');
        if (back.hit) {
          const t = await callExtension('qa_read', { tabId, ref: back.hit.node.ref, maxChars: 90 }).catch(() => null);
          txt += ' ' + String(t?.text || '');
        }
        return txt;
      };
      let allIn = true;
      /* OPEN IT FIRST. A closed TreeSelect ignores typed text entirely — the search only exists while
         the dropdown is up, which is why the same keystrokes worked by hand and failed here. */
      await clickRef(tabId, control.hit.node.ref);
      await new Promise((r) => setTimeout(r, 300));
      for (const segs of want) {
        const leaf = segs[segs.length - 1];
        await callExtension('qa_type', { tabId, ref: control.hit.node.ref, value: leaf, raw: true, commit: 'Enter', settleMs: 280 }, 20_000).catch(() => null);
        await new Promise((r) => setTimeout(r, 320));
        let txt = await readBack();
        if (!norm(txt).includes(norm(leaf))) {
          // A cascader shows the whole path as ONE filtered row and needs it clicked.
          const row = await callExtension('qa_click', { tabId, selector: `.ant-cascader-menu-item[title*="${leaf}"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-cascader-menu-item` }, 20_000).catch(() => ({ ok: false }));
          if (row?.ok !== false) {
            await new Promise((r) => setTimeout(r, 300));
            txt = await readBack();
          }
        }
        if (!norm(txt).includes(norm(leaf))) { allIn = false; break; }
        steps.push({ level: leaf, ok: true, via: 'typed' });
      }
      if (allIn) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, ...(paths && paths.length ? { paths } : { path }), steps, via: 'typed the leaf' };
      }
      /* DO NOT CLOSE IT — REOPEN IT. Escaping here left the dropdown shut, so the antd title walk below
         (which is gated on a visible dropdown) never ran, and the ordinary level walk took over: on a
         single-select tree that clicks the PARENT, which selects the branch and closes. That is how one
         field went from 7 seconds to 95 (2026-07-30). */
      steps.push({ typedTheLeaf: false });
      const reopen = await findClickable(tabId, name, null);
      if (reopen.hit) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 160));
        await clickRef(tabId, reopen.hit.node.ref);
        await new Promise((r) => setTimeout(r, 340));
      }
    }
  }

  /* ONE VALUE FROM A BUTTON-TRIGGERED LISTBOX GOES STRAIGHT TO THE KEYBOARD.
   *
   * downshift, Headless UI and friends render a <button> and a ul/li, and clicking the option does
   * nothing at all — a synthetic click carries no mousedown and gives no focus. Discovering that by
   * click → search → arrow-expand → keyboard is four routes deep and it LOOKS like indecision, which
   * is exactly what the owner saw. A button trigger is a reliable tell, so take the working route
   * first; the click walk is still the fallback if the keyboard finds nothing. */
  const flat = (!paths || paths.length <= 1) && (path || []).length === 1;
  if (flat && !multi) {
    const probe = await findClickable(tabId, name, null);
    const trigger = probe.hit?.node;
    const remembered = routeMemory.get(routeKey(tabId, name));
    if (trigger && (remembered === 'keyboard' || (!remembered && trigger.tag === 'button'))) {
      const kb = await keyboardPick(tabId, name, path[0]);
      if (kb.ok) {
        routeMemory.set(routeKey(tabId, name), 'keyboard');
        return { ok: true, field: name, path, steps: [{ level: path[0], ok: true, via: 'keyboard at the trigger (a button-triggered listbox ignores option clicks)' }] };
      }
      steps.push({ triedKeyboardFirst: false, because: kb.error || 'the keyboard route did not take' });
    }
  }

  const opened = await findClickable(tabId, name, null);
  if (!opened.hit) return { ok: false, error: `nothing on the page is called "${name}"`, candidates: opened.nodes.filter((n) => n.name).map((n) => `${n.role} "${n.name}"`).slice(0, 25) };
  await clickRef(tabId, opened.hit.node.ref);
  await new Promise((r) => setTimeout(r, 350));

  /* ANT: WALK BY `title`, FIRST — not as a last-resort repair.
   *
   * Ant puts each option's text in a `title` on the element that actually takes the click (a cascader
   * menu item, a tree node's content wrapper), and a selector click needs NO snapshot at all. Doing
   * this last meant a three-level cascader cost nine full-page snapshots and a repair cascade that
   * read as indecision and took minutes; doing it first costs three clicks. The registry already
   * knew the route — it was being consulted in the wrong order (2026-07-30). */
  /* Same rule here: a control that already reads the value we want is not re-driven. */
  {
    const want = (paths && paths.length ? paths : [path]).map((p) => p[p.length - 1]);
    let txt = String(opened.hit.node.name || '');
    const tt = await callExtension('qa_read', { tabId, ref: opened.hit.node.ref, maxChars: 90 }).catch(() => null);
    txt += ' ' + String(tt?.text || '');
    if (want.length && want.every((leaf) => norm(txt).includes(norm(leaf)))) {
      await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
      return { ok: true, field: name, ...(paths && paths.length ? { paths } : { path }), steps: [{ alreadyCorrect: want.join(', ') }] };
    }
  }

  const antOpen = await callExtension('qa_read', { tabId, selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-cascader-menus:not(.ant-select-dropdown-hidden)', maxChars: 8 }).catch(() => null);
  /* BUT NOT WHEN THERE ARE CHECKBOXES. The two trees really are opposite (both rules the owner's):
     a CHECKABLE tree must be driven by its checkbox — a title click toggles and the second path
     wipes the first, which is exactly what happened when this route was applied to everything (the
     field ended up holding "Kenya" alone). A single-select tree and a cascader have no checkboxes,
     and there the title IS the only clickable thing. One read tells them apart. */
  const antCheckable = await callExtension('qa_read', { tabId, selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-checkbox, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-tree-checkbox', maxChars: 4 }).catch(() => null);
  if (antOpen && !antOpen.error && (!antCheckable || antCheckable.error)) {
    const reads = async () => {
      const back = await findClickable(tabId, name, null);
      let txt = String(back.hit?.node?.name || '');
      if (back.hit) {
        const t = await callExtension('qa_read', { tabId, ref: back.hit.node.ref, maxChars: 60 }).catch(() => null);
        txt += ' ' + String(t?.text || '');
      }
      /* AND THE CONTAINER, because an Ant Cascader keeps its value NEXT TO the input, not in it.
       * Measured 17.10.2026 on demo/react: all three columns were clicked, the control showed
       * «Ukraine / Kyiv oblast / Kyiv», and this function read the <input> the snapshot points at,
       * got an empty string, and the verb declared its own successful run a failure and fell
       * through to three more routes. The class names are no help — this build renders
       * `ant-select-css-var`, so `.ant-select-selection-item` matches nothing — but the control's
       * surrounding text does contain the value, and asking for it by the field's own NAME works
       * whatever the library calls its classes. */
      if (!norm(txt).replace(norm(name), '').trim()) {
        const near = await callExtension('qa_collect', { tabId, nodes: { nameContains: name }, take: ['text'], limit: 3 }, 20_000).catch(() => null);
        const first = Array.isArray(near?.nodes) ? near.nodes[0] : null;
        if (first?.text) txt += ' ' + String(first.text).slice(0, 160);
      }
      return { txt, ref: back.hit?.node?.ref };
    };
    /* IS THIS A CASCADER OR A TREE? The routes below are written for Ant's TreeSelect, where every
     * level carries `title="…"` and a non-leaf must be opened by its SWITCHER arrow, because
     * clicking the row itself selects the branch and shuts the dropdown.
     *
     * A plain Ant CASCADER is neither. Its rows are `li.ant-cascader-menu-item`, in this version
     * they carry NO title attribute at all, and clicking a non-leaf is exactly right: it opens the
     * next column. So every selector here missed it, and the verb answered «level "Ukraine" never
     * appeared» about a level the bridge could see perfectly well — measured 17.10.2026 on our own
     * demo/react stand, where `qa_click { name: "Ukraine" }` opened the second column first try.
     *
     * The telling apart is done ONCE, by the markup of the open dropdown, and the name route is
     * used only for the cascader: letting it loose on a TreeSelect would re-create the bug the
     * switcher exists to avoid. */
    /* `:not(…-hidden)` IS THE WHOLE POINT, and leaving it out cost this fix an hour. Ant does not
       unmount a closed dropdown, it HIDES it, so a bare `.ant-cascader-menu` matches a leftover
       from a field that was closed minutes ago. The detection then said «cascader» about a control
       that was never opened, the row lookup honestly found no «Ukraine», and the step reported a
       refused click. The same trap is written up in this product's own notes for the Ant
       DatePicker; it applies here word for word. */
    const cascMenu = await callExtension('qa_read', { tabId, selector: '.ant-cascader-menus:not(.ant-select-dropdown-hidden) .ant-cascader-menu, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-cascader-menu', maxChars: 4 }).catch(() => null);
    const isCascader = !!(cascMenu && !cascMenu.error);
    let allOk = true;
    for (const segs of paths && paths.length ? paths : [path]) {
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        if (isCascader) {
          /* A column is driven the way a person drives it: click the row by the name it shows.
             `qa_click { name }` resolves against a snapshot taken right now, so a column that has
             just appeared is already in it. */
          /* THE NAME IS RESOLVED HERE, NOT BY THE EXTENSION. `qa_click { name }` is a convenience
             of the TOOL: this process looks the name up in a fresh snapshot and hands the
             extension a ref. Called straight through, the extension answers «selector or ref is
             required» — which is what the first version of this route collected, and it looked
             exactly like a refused click. */
          let row = await findClickable(tabId, seg, null);
          /* THE COLUMN MAY NOT BE UP YET. The first segment runs right after whatever opened the
             control, and «opened» is a request the page fulfils a frame or two later; a leftover
             hidden dropdown can also make it LOOK open. One reopen and one more look, which is
             cheaper than the four fallback routes below and is what a person does. */
          if (!row.hit) {
            const opener = await findClickable(tabId, name, null);
            if (opener.hit) {
              await callExtension('qa_click', { tabId, ref: opener.hit.node.ref }, 20_000).catch(() => null);
              await new Promise((r) => setTimeout(r, 420));
              row = await findClickable(tabId, seg, null);
            }
          }
          let byName = row.hit
            ? await callExtension('qa_click', { tabId, ref: row.hit.node.ref }, 20_000).catch(() => ({ ok: false }))
            : { ok: false, error: `no row named "${seg}" in the open column` };
          /* A column row that is already chosen does not move when clicked again, and the diff
             comes back empty: that is not a failure, so the next segment is tried regardless and
             the path as a whole is judged at the end by what the field reads. */
          const took = byName?.ok !== false;
          steps.push({ level: seg, ok: took, via: 'cascader column', ...(took ? {} : { why: String(byName?.error || byName?.note || '').slice(0, 160) }) });
          if (!took) { allOk = false; break; }
          await new Promise((r) => setTimeout(r, 320));
          continue;
        }
        /* A NON-LEAF SEGMENT IS AN EXPAND, NOT A PICK — and in a single-select tree that distinction
         * is everything: the parent is itself a valid value, so clicking its title SELECTS the branch
         * and closes the dropdown, and the leaf then has nowhere to be clicked. The thing that opens
         * it is the switcher arrow, which sits in the same treenode as the titled wrapper — reachable
         * with `:has()`, precisely, without counting siblings (2026-07-30, after the reopen-and-retry
         * guess cost 91 seconds on one field). */
        if (si < segs.length - 1) {
          const already = await callExtension('qa_read', { tabId, selector: `.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="${segs[si + 1]}"]`, maxChars: 4 }).catch(() => null);
          if (already && !already.error) { steps.push({ level: seg, ok: true, via: 'already open' }); continue; }
          const sw = await callExtension('qa_click', { tabId, selector: `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-treenode:has([title="${seg}"]) .ant-select-tree-switcher, .ant-cascader-menus:not(.ant-select-dropdown-hidden) [title="${seg}"]` }, 20_000).catch(() => ({ ok: false }));
          steps.push({ level: seg, ok: sw?.ok !== false, via: 'switcher' });
          if (sw?.ok === false) { allOk = false; break; }
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const sel = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="${seg}"], .ant-cascader-menus:not(.ant-select-dropdown-hidden) [title="${seg}"]`;
        let hit = await callExtension('qa_click', { tabId, selector: sel }, 20_000).catch(() => ({ ok: false }));
        /* REOPEN AND RETRY ONCE. In a SINGLE-select tree the parent is itself a valid value, so
           clicking it selects the branch and CLOSES the dropdown — and the leaf's selector then
           matches nothing. Reopening puts the tree back with that branch expanded (Ant expands the
           path to the current selection), so the leaf is one click away. Without this retry the verb
           fell through to four consecutive repairs and spent 170 SECONDS on one field, which is what
           the owner saw as flailing (2026-07-30). */
        if (hit?.ok === false) {
          const again = await findClickable(tabId, name, null);
          if (again.hit) {
            await clickRef(tabId, again.hit.node.ref);
            await new Promise((r) => setTimeout(r, 380));
            hit = await callExtension('qa_click', { tabId, selector: sel }, 20_000).catch(() => ({ ok: false }));
          }
        }
        steps.push({ level: seg, ok: hit?.ok !== false, via: 'title' });
        if (hit?.ok === false) { allOk = false; break; }
        await new Promise((r) => setTimeout(r, 260));
      }
      if (!allOk) break;
      // A single-select control closes on the pick; reopen for the next path.
      const st = await reads();
      if (st.ref && (paths?.length || 0) > 1) {
        const stillOpen = await callExtension('qa_read', { tabId, selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden)', maxChars: 8 }).catch(() => null);
        if (!stillOpen || stillOpen.error) { await clickRef(tabId, st.ref); await new Promise((r) => setTimeout(r, 380)); }
      }
    }
    if (allOk) {
      const st = await reads();
      const leaf = (paths && paths.length ? paths[paths.length - 1] : path).slice(-1)[0];
      if (norm(st.txt).includes(norm(leaf))) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, ...(paths && paths.length ? { paths } : { path }), steps, via: isCascader ? 'antd cascader columns' : 'antd title selectors' };
      }
    }
    steps.push({ titleWalk: 'did not settle it — falling back to the tree walk', readBack: String((await reads()).txt || '').slice(0, 120) });
  }

  /* SEVERAL PATHS, ONE OPENING (2026-07-30).
   *
   * A checkable tree normally wants more than one leaf, and calling this verb twice loses the first
   * pick: the second call clicks the control to open it, which on an already-open popup CLOSES it,
   * and what happens after that is anybody's guess — live, the tree ended up EMPTY having had one
   * leaf. So all the paths are walked inside one opening.
   *
   * And inside one opening, a level must NOT be re-clicked when its children are already on screen:
   * the second path shares its parent with the first, and clicking a parent checkbox again toggles
   * the WHOLE branch off. So a level is clicked only when the level below it cannot be seen yet —
   * except the last one, which is the value and is always clicked. */
  const walk = paths && paths.length ? paths : [path];
  for (let pi = 0; pi < walk.length; pi++) {
  const segments = walk[pi];
  /* SKIP THE PARENTS ONLY WHEN THE LEAF IS ALREADY ON SCREEN — and judge it by the LAST segment,
     never the next one. Looking one level ahead was wrong twice on the same page (2026-07-30): in a
     Cascader the next column's label is visible while ITS children are not, so a middle level got
     skipped and the leaf name then prefix-matched a column container; and in a checkable tree the
     shared parent was NOT skipped, so the second path re-clicked "Europe" and toggled the whole
     branch — which is how a tree with two picks ended up holding one. */
  const leaf = segments[segments.length - 1];
  let onlyLeaf = false;
  if (segments.length > 1) {
    const there = await findClickable(tabId, leaf, ['checkbox', ...LEVEL_ROLES], { strict: true, notRef: opened.hit.node.ref });
    onlyLeaf = !!there.hit;
    if (onlyLeaf) steps.push({ skipped: segments.slice(0, -1).join(' > '), why: 'the leaf is already on screen' });
    /* THE SECOND PICK FROM A TREE DOES NOT WALK THE BRANCH AGAIN.
     *
     * Ant's TreeSelect collapses back after a leaf is checked, so the branch is shut when the next
     * path starts — and re-clicking the shared parent CHECKS THE WHOLE BRANCH, i.e. unchecks what
     * was picked. Live, a tree given two leaves kept exactly one (2026-07-30). Searching the leaf
     * name filters the tree down to it, which is the route the library's own hint describes. */
    if (!onlyLeaf && pi > 0) {
      await callExtension('qa_type', { tabId, ref: opened.hit.node.ref, value: leaf }, 20_000).catch(() => {});
      await new Promise((r) => setTimeout(r, 560));
      const filtered = await findClickable(tabId, leaf, ['checkbox'], { strict: true, notRef: opened.hit.node.ref });
      if (filtered.hit) {
        onlyLeaf = true;
        steps.push({ searched: leaf, why: 'a later pick from the same tree — searched instead of walking the branch again' });
      }
    }
  }
  for (let si = onlyLeaf ? segments.length - 1 : 0; si < segments.length; si++) {
    const seg = segments[si];
    let found = null;
    for (let attempt = 0; attempt < 2 && !found; attempt++) {
      /* THE CHECKBOX FIRST. In a checkable tree the label and the checkbox are different targets:
         clicking the label selects-or-expands depending on the library's mood, clicking the
         checkbox always checks. Ant's TreeSelect only took the value from the checkbox. */
      const box = await findClickable(tabId, seg, ['checkbox']);
      if (box.hit) { found = box.hit; break; }
      const { hit } = await findClickable(tabId, seg, LEVEL_ROLES);
      if (hit) { found = hit; break; }
      /* Nothing by that name on screen? Type it into the control's own search box. That is what
         makes a collapsed branch reveal its leaf — and it is cheaper than walking the tree. */
      if (attempt === 0) {
        await callExtension('qa_type', { tabId, ref: opened.hit.node.ref, value: seg }, 20_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 550));
        const again = await findClickable(tabId, seg, ['checkbox', ...LEVEL_ROLES]);
        if (again.hit) { found = again.hit; break; }
      }
      // A collapsed branch hides its children: nudge the tree open and look again. This is the
      // difference between a TreeSelect that works and one that reports the leaf as missing.
      const expander = await findClickable(tabId, seg, ['button']);
      if (expander.hit) { await clickRef(tabId, expander.hit.node.ref); await new Promise((r) => setTimeout(r, 300)); }
      else break;
    }
    if (!found) {
      steps.push({ level: seg, ok: false });
      await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
      return { ok: false, error: `level "${seg}" never appeared`, steps, field: name, note: 'the level above may not have opened, or it is spelled differently in the popup than in the path. If the control has a search box, typing the leaf name and pressing Enter is usually the shorter route.' };
    }
    await clickRef(tabId, found.node.ref);
    steps.push({ level: seg, ok: true, matched: found.node.name });
    await new Promise((r) => setTimeout(r, 320));
  }
  }
  if (!multi && !keepOpen) {
    await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000);
    await new Promise((r) => setTimeout(r, 200));
  }
  /* DID IT TAKE? For a single value from a single listbox the answer is readable — the trigger's
     accessible name contains it — and when it does not, there is a proven repair: the keyboard.
     Without this check the verb reported ok on downshift while the field stayed empty, which is the
     worst kind of reply: the agent moves on and the step never validates. */
  /* VERIFY THE LEAF, whatever the depth. This used to check only a one-level pick, so a two-level
     path reported ok on an Ant TreeSelect in SINGLE mode while the field stayed empty — there are no
     checkboxes in single mode, so the checkbox tier finds nothing, the label click selects the BRANCH
     and closes, and the walk still reads as four successful steps (2026-07-30). */
  const single = walk.length === 1 && !multi;
  if (single) {
    const after = await findClickable(tabId, name, null);
    const reads = String(after.hit?.node?.name || '');
    const leafWanted = walk[0][walk[0].length - 1];
    if (!norm(reads).includes(norm(leafWanted))) {
      /* Repair one: SEARCH the leaf and click it. This is the library's own route for a tree whose
         branch closes behind you, and for single mode where there is no checkbox to click. */
      let fixed = false;
      const ctl = await findClickable(tabId, name, null);
      if (ctl.hit) {
        await clickRef(tabId, ctl.hit.node.ref);
        await new Promise((r) => setTimeout(r, 320));
        await callExtension('qa_type', { tabId, ref: ctl.hit.node.ref, value: leafWanted }, 20_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 560));
        /* ENTER FIRST. A searchable tree/select highlights the single match while you type, and Enter
           takes it — which is how a person does it and the only route that works in Ant's SINGLE-mode
           TreeSelect: there is no checkbox to click, and clicking a parent's title selects the BRANCH
           instead of opening it (2026-07-30). The key is addressed AT the control, because a synthetic
           click leaves focus on <body>. */
        await callExtension('qa_press', { tabId, key: 'Enter', ref: ctl.hit.node.ref }, 15_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 420));
        const afterEnter = await findClickable(tabId, name, null);
        let readsE = String(afterEnter.hit?.node?.name || '');
        if (afterEnter.hit) {
          const te = await callExtension('qa_read', { tabId, ref: afterEnter.hit.node.ref, maxChars: 60 }).catch(() => null);
          readsE += ' ' + String(te?.text || '');
        }
        if (norm(readsE).includes(norm(leafWanted))) {
          steps.push({ searchedTheLeaf: leafWanted, worked: true, via: 'typed the leaf and pressed Enter' });
          return { ok: true, field: name, path, steps, note: 'the walk did not take — typing the leaf and pressing Enter did (a single-mode tree has no checkbox, and clicking a parent selects the branch)' };
        }
        const leafHit = await findClickable(tabId, leafWanted, ['treeitem', 'option', 'listitem', 'cell', 'row'], { strict: true, notRef: ctl.hit.node.ref });
        if (leafHit.hit) {
          await clickRef(tabId, leafHit.hit.node.ref);
          await new Promise((r) => setTimeout(r, 420));
          await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
          const again = await findClickable(tabId, name, null);
          let reads2 = String(again.hit?.node?.name || '');
          if (again.hit) {
            const t2 = await callExtension('qa_read', { tabId, ref: again.hit.node.ref, maxChars: 60 }).catch(() => null);
            reads2 += ' ' + String(t2?.text || '');
          }
          fixed = norm(reads2).includes(norm(leafWanted));
          steps.push({ searchedTheLeaf: leafWanted, worked: fixed });
        }
      }
      if (fixed) return { ok: true, field: name, path, steps, note: 'the walk did not take — searching the leaf and clicking it did (a single-mode tree has no checkbox, and its branch closes behind you)' };

      /* Repair one-and-a-half: BY TITLE. Ant puts the node's own text in a `title` on the element that
         actually takes the click — the content wrapper — while the accessibility tree exposes the outer
         treenode, whose click does nothing. It is the same trick as the day cell (`td[title=…]`), and
         it needs the dropdown open and scoped to the VISIBLE one. */
      {
        const ctlT = await findClickable(tabId, name, null);
        if (ctlT.hit) {
          await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
          await new Promise((r) => setTimeout(r, 160));
          await clickRef(tabId, ctlT.hit.node.ref);
          await new Promise((r) => setTimeout(r, 420));
          for (const seg of walk[0]) {
            const byTitle = await callExtension('qa_click', { tabId, selector: `.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="${seg}"]` }, 20_000).catch(() => ({ ok: false }));
            if (byTitle?.ok === false) break;
            await new Promise((r) => setTimeout(r, 380));
            const look = await findClickable(tabId, name, null);
            let readsT = String(look.hit?.node?.name || '');
            if (look.hit) {
              const tt = await callExtension('qa_read', { tabId, ref: look.hit.node.ref, maxChars: 60 }).catch(() => null);
              readsT += ' ' + String(tt?.text || '');
            }
            if (norm(readsT).includes(norm(leafWanted))) {
              steps.push({ byTitle: seg, worked: true });
              return { ok: true, field: name, path, steps, note: 'the tree node that takes the click carries its text in a `title` attribute, not in the accessibility tree — clicking that took the value' };
            }
            // Selecting a parent closes the dropdown; reopen so the next level is reachable.
            if (look.hit) { await clickRef(tabId, look.hit.node.ref); await new Promise((r) => setTimeout(r, 420)); }
          }
          steps.push({ byTitle: false });
        }
      }

      /* Repair two: EXPAND WITH THE ARROWS until the leaf shows up. Trees only — on a flat listbox
         this loop is pure flailing (ArrowDown, ArrowRight, ArrowDown…) and the keyboard route below
         handles that case in one pass.
         A single-mode Ant TreeSelect has no search box at all (Ant only turns search on for multiple),
         no checkboxes, and clicking a parent's title selects the BRANCH rather than opening it — so
         neither typing nor clicking can reach a nested leaf. The keyboard can: ArrowDown moves onto a
         node, ArrowRight opens it, and that is what a person does to a collapsed tree. Keys addressed
         AT the control, because a synthetic click leaves focus on <body> (2026-07-30). */
      const ctl2 = walk[0].length > 1 ? await findClickable(tabId, name, null) : { hit: null };
      if (ctl2.hit) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 180));
        await clickRef(tabId, ctl2.hit.node.ref);
        await new Promise((r) => setTimeout(r, 420));
        let ref2 = ctl2.hit.node.ref;
        for (let hop = 0; hop < 4; hop++) {   // four is enough for a real tree; more only looks like flailing
          const there = await findClickable(tabId, leafWanted, ['treeitem', 'option', 'listitem'], { strict: true, notRef: ref2 });
          if (there.hit) {
            await clickRef(tabId, there.hit.node.ref);
            await new Promise((r) => setTimeout(r, 400));
            const fin = await findClickable(tabId, name, null);
            let readsK = String(fin.hit?.node?.name || '');
            if (fin.hit) {
              const tk = await callExtension('qa_read', { tabId, ref: fin.hit.node.ref, maxChars: 60 }).catch(() => null);
              readsK += ' ' + String(tk?.text || '');
            }
            if (norm(readsK).includes(norm(leafWanted))) {
              steps.push({ expandedWithArrows: true, hops: hop, then: `clicked "${leafWanted}"` });
              return { ok: true, field: name, path, steps, note: 'the tree had no search box and no checkboxes — it was opened with the arrow keys and the leaf clicked' };
            }
          }
          ref2 = (await findClickable(tabId, name, null)).hit?.node?.ref || ref2;
          await callExtension('qa_press', { tabId, key: 'ArrowDown', ref: ref2 }, 15_000).catch(() => {});
          await new Promise((r) => setTimeout(r, 160));
          await callExtension('qa_press', { tabId, key: 'ArrowRight', ref: ref2 }, 15_000).catch(() => {});
          await new Promise((r) => setTimeout(r, 200));
        }
        steps.push({ expandedWithArrows: false });
      }

      // Repair three: the keyboard as a plain listbox, for a control that ignores clicks entirely.
      const kb = await keyboardPick(tabId, name, leafWanted);
      steps.push({ clickDidNotTake: leafWanted, repaired: kb.ok, via: kb.via || kb.error, ...(kb.trail?.length ? { at: kb.trail[0] } : {}) });
      return {
        ok: kb.ok,
        field: name,
        path,
        steps,
        ...(kb.ok
          ? (routeMemory.set(routeKey(tabId, name), 'keyboard'), { note: 'the option click did nothing — this control only responds to the keyboard, and that is what set it' })
          : { error: kb.error || `"${leafWanted}" would not stick`, offers: kb.offers }),
      };
    }
  }
  return { ok: true, field: name, ...(paths && paths.length ? { paths } : { path }), steps };
}

/**
 * Click a year in an open year panel — stepping DECADES until it is there.
 *
 * Ant's year panel shows one decade at a time, so `[title="2031"]` simply does not exist while the
 * panel is on 2020–2029: live, the range's end date died exactly there while its start (2027, in
 * view) went in fine. The header says which decade is showing, so the direction is read, not guessed.
 */
async function clickYearInPanel(tabId, year, trail, which = '') {
  const label = (s) => (which ? `${which}: ${s}` : s);
  for (let hop = 0; hop <= 8; hop++) {
    const r = await callExtension('qa_click', { tabId, selector: `${ANT_OPEN} [title="${year}"]` }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
    if (r?.ok !== false) {
      trail.push({ step: label('the year'), ok: true, ...(hop ? { afterDecadeHops: hop } : {}) });
      await new Promise((res) => setTimeout(res, 420));
      return true;
    }
    const hdr = await callExtension('qa_read', { tabId, selector: `${ANT_OPEN} .ant-picker-header-view`, maxChars: 24 }).catch(() => null);
    const m = /(\d{4})\s*[-–—]\s*(\d{4})/.exec(String(hdr?.text || ''));
    const back = m ? year < Number(m[1]) : false;
    const arrow = `${ANT_OPEN} ${back ? '.ant-picker-header-super-prev-btn' : '.ant-picker-header-super-next-btn'}`;
    const step = await callExtension('qa_click', { tabId, selector: arrow }, 20_000).catch(() => ({ ok: false }));
    if (step?.ok === false) {
      trail.push({ step: label('the year'), ok: false, error: `${year} is not in the panel and the decade arrows do not respond`, showing: String(hdr?.text || '').slice(0, 20) });
      return false;
    }
    await new Promise((res) => setTimeout(res, 360));
  }
  trail.push({ step: label('the year'), ok: false, error: `${year} never appeared after eight decade hops` });
  return false;
}

/** What month is the open calendar showing? Read from wherever this library keeps it. */
async function readCalendarHeader(tabId) {
  for (const sel of CAL_HEADER_SELECTORS) {
    const r = await callExtension('qa_read', { tabId, selector: sel, maxChars: 40 }).catch(() => null);
    const txt = String(r?.text || '').trim();
    if (!txt) continue;
    // "March 1987", "Mar 1987", "1987年3月" → we only need the month index and the year
    const y = Number((txt.match(/\b(19|20)\d{2}\b/) || [])[0]);
    const mo = monthIn(txt);
    if (y || mo) return { text: txt, year: y || null, month: mo, via: sel };
  }
  return visibleMonthFromCells(tabId);
}

/* NO HEADER WE KNOW? THE DAYS SAY WHICH MONTH IS SHOWING. A calendar whose days are named in full
 * («26 października 2026») tells the month and year of the grid by majority, whatever library drew
 * it; seven agreeing cells rule out the field's own value and a stray link. */
async function visibleMonthFromCells(tabId) {
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000).catch(() => null);
  const tally = new Map();
  for (const n of Array.isArray(snap?.nodes) ? snap.nodes : []) {
    if (!['gridcell', 'button', 'cell', 'option', 'link'].includes(n.role)) continue;
    const name = String(n.name || '');
    const y = (name.match(/\b(19|20|21)\d{2}\b/) || [])[0];
    if (!y || !/\b\d{1,2}\b/.test(name.replace(y, ''))) continue;
    const m = monthIn(name);
    if (!m) continue;
    const k = `${y}-${m}`;
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  let best = null;
  for (const [k, c] of tally) if (!best || c > best.c) best = { k, c };
  if (!best || best.c < 7) return null;
  const [year, month] = best.k.split('-').map(Number);
  return { text: `the day cells of ${MONTHS_LONG[month - 1]} ${year}`, year, month, via: 'day cells' };
}

/**
 * A MONTH-ONLY picker (`showMonthYearPicker` and friends): no days, twelve cells, and a year to step.
 *
 * Every cell carries its own index in a class (`__month-0` … `__month-11`), so the month needs no
 * counting; the year has buttons whose accessible names are "Previous Year" / "Next Year". Typing is
 * not the route: the fill engine writes an ISO date and the field lands on the wrong month (07/2026
 * out of "09/2026", watched 2026-07-30).
 */
async function pickMonth(tabId, name, month, year) {
  const trail = [];
  await clearPopups(tabId);

  /* Typed first, as every other date route does. This block had been pasted from the time picker
     and named `time` and `parts`, which do not exist here, so every month-only field threw a
     ReferenceError before reaching the panel (found 03.11.2026). */
  const mmYYYY = `${String(month).padStart(2, '0')}/${year}`;
  const typed = await rawType(tabId, name, mmYYYY);
  if (typed?.ok !== false) {
    await new Promise((r) => setTimeout(r, 240));
    const back = await findClickable(tabId, name, null);
    const shows0 = `${back.hit?.node?.state || ''} ${back.hit?.node?.name || ''}`;
    if (shows0.includes(String(year)) && (shows0.includes(String(month).padStart(2, '0')) || monthIn(shows0) === month)) {
      await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
      return { ok: true, field: name, month: mmYYYY, via: 'typed', trail: [{ tried: 'typed it straight in', ok: true }] };
    }
  }
  trail.push({ tried: 'typed it straight in', ok: false });

  const field = await findClickable(tabId, name, null);
  if (!field.hit) return { ok: false, error: `no field is called "${name}"` };
  await clickRef(tabId, field.hit.node.ref);
  await new Promise((r) => setTimeout(r, 480));
  const rec = recipeFor('react-datepicker', 'month') || {};

  for (let hop = 0; hop < 24; hop++) {
    const hdr = await callExtension('qa_read', { tabId, selector: rec.header || '.react-datepicker__header', maxChars: 60 }).catch(() => null);
    const shown = Number((String(hdr?.text || '').match(/\b(19|20|21)\d{2}\b/) || [])[0]);
    if (!shown || shown === year) { trail.push({ year: shown || 'unknown', hops: hop }); break; }
    const btn = await findClickable(tabId, shown > year ? rec.prevYearName || 'Previous Year' : rec.nextYearName || 'Next Year', ['button'], { strict: true });
    if (!btn.hit) { trail.push({ error: 'no year arrows in this panel', showing: shown }); break; }
    await clickRef(tabId, btn.hit.node.ref);
    await new Promise((r) => setTimeout(r, 240));
  }

  const sel = (rec.cellByIndex ? rec.cellByIndex(month - 1) : `.react-datepicker__month-${month - 1}`);
  const hit = await callExtension('qa_click', { tabId, selector: sel }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
  trail.push({ month: MONTHS_LONG[month - 1], via: sel, ok: hit?.ok !== false, ...(hit?.ok === false ? { error: hit.error } : {}) });
  await new Promise((r) => setTimeout(r, 420));
  const after = await findClickable(tabId, name, null);
  const shows = `${after.hit?.node?.state || ''} ${after.hit?.node?.name || ''}`;
  const ok = shows.includes(String(year)) && (shows.includes(String(month).padStart(2, '0')) || new RegExp(MONTHS_LONG[month - 1].slice(0, 3), 'i').test(shows));
  if (!ok) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  return { ok, field: name, month: `${String(month).padStart(2, '0')}/${year}`, trail, ...(ok ? {} : { shows: shows.trim().slice(0, 80) }) };
}

/**
 * A LISTBOX THAT IGNORES CLICKS — drive it from the keyboard, at the trigger.
 *
 * downshift's `useSelect` is the case that proved it (2026-07-30): the option is a real `role=option`
 * `<li>`, the bridge clicks it, the menu closes and the value does NOT change. Two things about a
 * synthetic click do that — it carries no `mousedown`, and it does not FOCUS the element — and both
 * live in the extension. The keyboard route is entirely in our hands and is the route these
 * libraries are actually built for: ArrowDown to the option's index, then Enter, with every key
 * addressed AT the trigger (`ref`), because keys sent to the focused element land on `<body>` when
 * nothing has focus. Verified: ArrowDown ×2 → Enter → "Director".
 */
async function keyboardPick(tabId, triggerName, optionText, { fromHighlight = false } = {}) {
  const trail = [];
  const triggerRef = async () => (await findClickable(tabId, triggerName, null)).hit?.node?.ref;
  await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  let ref = await triggerRef();
  if (!ref) return { ok: false, error: `cannot find "${triggerName}" to open`, trail };
  await clickRef(tabId, ref);
  await new Promise((r) => setTimeout(r, 420));

  // The options in DOM order ARE the arrow-key order, so the index is read, not guessed.
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
  rememberSnapshot(tabId, snap);
  const options = (Array.isArray(snap?.nodes) ? snap.nodes : []).filter((n) => n.role === 'option' || n.role === 'menuitem' || n.role === 'treeitem');
  const idx = options.findIndex((n) => norm(n.name) === norm(optionText));
  const loose = idx < 0 ? options.findIndex((n) => norm(n.name).includes(norm(optionText))) : idx;
  if (loose < 0) return { ok: false, error: `"${optionText}" is not among the ${options.length} options this listbox offers`, offers: options.map((n) => n.name).slice(0, 12), trail };

  /* COUNT FROM WHERE THE HIGHLIGHT ACTUALLY IS — but only when the caller says the control may
     already hold a value. `loose + 1` presses assume the list opens with nothing highlighted: true
     of an EMPTY control, false of one that already has a selection, because every one of these
     libraries opens with the current value highlighted. A repair on a field holding "Owner" and
     asked for "Director" would then arrow straight past it and commit "Manager" — a WRONG value,
     put there by a repair, which is the worst thing this file can do. The library's own marker is
     in the snapshot we have just taken (aria-selected → `selected` in state), so the correction
     costs no extra call and the offset goes in the trail instead of being assumed silently.
     pickPath deliberately does NOT pass the flag: its trees reach here as a last resort and their
     `selected` can mean the previous pick rather than the keyboard's position — extension 1.3.0
     learned that one the hard way ("where the highlight starts is the library's business"). */
  const from = fromHighlight ? options.findIndex((n) => /\bselected\b/.test(String(n.state || ''))) : -1;
  const hops = loose - from;
  trail.push({ optionIndex: loose + 1, of: options.length, ...(from >= 0 ? { highlightedOnOpen: from + 1 } : {}) });

  ref = (await triggerRef()) || ref;
  const arrow = hops >= 0 ? 'ArrowDown' : 'ArrowUp';
  for (let i = 0; i < Math.abs(hops); i++) {
    await callExtension('qa_press', { tabId, key: arrow, ref }, 15_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 130));
  }
  await callExtension('qa_press', { tabId, key: 'Enter', ref }, 15_000).catch(() => {});
  await new Promise((r) => setTimeout(r, 380));
  const after = await findClickable(tabId, triggerName, null);
  /* JUDGE BY WHAT IT SHOWS, NOT ONLY BY WHAT IT IS CALLED — otherwise this verb reports failure on
     the exact control it was written for. downshift's trigger is
     getToggleButtonProps({ 'aria-label': 'Signatory role' }), and accessibleName (a11y.ts:119)
     takes aria-label first, so the name still reads "Signatory role" after a PERFECT pick and `ok`
     comes back false. The name is KEPT and the rendered text ADDED, never swapped: a cascader
     really does carry its value in its name. The change is monotone — ok can only go false→true —
     which is what makes it safe for pickPath's two existing callers; there the practical effect is
     that a keyboard route which already worked stops being reported as a failure and falling
     through to the click walk. `shownText` refuses to read an EXPANDED control, so an open menu's
     own option list can never be mistaken for the trigger's value. */
  const nameNow = String(after.hit?.node?.name || '');
  const rendered = after.hit?.node ? await shownText(tabId, after.hit.node) : '';
  const reads = `${nameNow} ${rendered}`.replace(/\s+/g, ' ').trim();
  const ok = norm(reads).includes(norm(optionText));
  return { ok, via: 'keyboard at the trigger', reads: reads.slice(0, 60), trail };
}

/**
 * ONE call for a date, whatever library owns the calendar.
 *
 * Order matters and is the cheapest-first: type it (most inputs accept a typed date, and that is
 * two calls), and only when the value does not stick, open the picker and steer it. Steering is
 * library-shaped, so it is discovered from what the popup actually contains rather than configured:
 * a "switch to year view" button means MUI, a clickable year in the header means Ant, month/year
 * <select>s mean react-datepicker, bare arrows mean step until the header agrees.
 */
async function pickDate(tabId, name, date, { openLabel } = {}) {
  // A MONTH-ONLY field ("09/2026") has no day grid at all — different panel, different route.
  const mo = /^(\d{1,2})[./-](\d{4})$/.exec(String(date).trim());
  if (mo) return pickMonth(tabId, name, Number(mo[1]), Number(mo[2]));
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(date).trim());
  if (!m) return { ok: false, error: `date must look like dd/mm/yyyy (or mm/yyyy for a month-only field) — got "${date}"` };
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const trail = [];
  await clearPopups(tabId);
  const shows = async () => {
    const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
    rememberSnapshot(tabId, snap);
    const found = pickNode(Array.isArray(snap?.nodes) ? snap.nodes : [], { name }, new Set());
    const node = found?.node;
    let rendered = '';
    if (node) {
      // The rendered text is the honest witness: MUI keeps the value in three sections, Ant in an
      // input, react-datepicker in an input — all three read back through the element's own text.
      const r = await callExtension('qa_read', { tabId, ref: node.ref, maxChars: 60 }).catch(() => null);
      rendered = String(r?.text || '');
      if (!rendered && node.selector) {
        const r2 = await callExtension('qa_read', { tabId, selector: node.selector, maxChars: 60 }).catch(() => null);
        rendered = String(r2?.text || '');
      }
    }
    /* A MUI X field keeps its value in three SECTION nodes (Day / Month / Year), and reading "the
       field" returns the picker button's name instead — so a date that had gone in perfectly was
       reported as not landed, twice in one run (2026-07-30). Collect the sections too: this is a
       read-back, so being generous about where the value might be costs nothing and a false
       negative costs the caller a retry on a field that is already correct. */
    const sections = (Array.isArray(snap?.nodes) ? snap.nodes : [])
      .filter((n) => n.role === 'spinbutton' && /^(day|month|year)\b/i.test(n.name || ''))
      .map((n) => `${n.name}=${n.state || ''}`)
      .join(' ');
    return [node?.state || '', node?.name || '', rendered, sections].join(' ');
  };
  const landed = (text) => {
    const t = String(text);
    const hasYear = t.includes(String(year));
    const hasMonth = t.includes(String(month).padStart(2, '0')) || new RegExp(MONTHS_LONG[month - 1].slice(0, 3), 'i').test(t) || new RegExp(`\\b${month}\\b`).test(t) || monthIn(t) === month;
    const hasDay = t.includes(String(day).padStart(2, '0')) || new RegExp(`\\b${day}\\b`).test(t);
    return hasYear && hasMonth && hasDay;
  };

  /* IF IT IS ALREADY RIGHT, LEAVE IT ALONE. Not "walk away the moment something appears" — the rule
     is to put in the value that is CORRECT for the field and then stop touching it (owner,
     2026-07-30). Re-driving a field whose value had already landed is how a date got inserted,
     cleared and inserted again, and it is where a large part of the run time went. */
  {
    const already = await shows();
    if (landed(already)) return { ok: true, field: name, date, via: 'already correct — not touched', trail: [] };
  }

  /* 0 — TYPE IT. Half a second against twenty-six, and it is the same value. Skipped only when the
     caller named an opening button, which is how it says "this field cannot be written to" (MUI X). */
  if (!openLabel) {
    const typed = await rawType(tabId, name, date);
    trail.push({ tried: 'typed it straight in', ok: typed?.ok !== false, reads: typed?.reads ?? null });
    if (typed?.ok !== false) {
      await new Promise((r) => setTimeout(r, 220));
      if (landed(await shows())) {
        if (await readCalendarHeader(tabId)) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, date, via: 'typed', trail };
      }
    }
  }

  /* 1 — CLICK IN, TYPE, ENTER. The order is the point (owner, 2026-07-29: "попробуй в сам input
     вводить напрямую"). Ant and react-datepicker both accept a typed date, but only while the field
     is the one being edited: writing into it cold leaves the component's own state untouched, and
     the value is discarded on the next render. Clicking first is what makes the write land. */
  /* SKIP THE TYPING WHEN THE CALLER NAMED AN OPEN BUTTON.
   *
   * `open_label` is how a caller says "this field has its own picker button" — which is MUI X, and
   * MUI X cannot be typed into. Trying anyway is not merely wasted: clicking into a section focuses
   * it, and the picker button then TOGGLES the dialog shut again, so the day never appears. That
   * regression showed up the moment click-then-type was added (2026-07-29). */
  const field = openLabel ? null : (await findClickable(tabId, name, null)).hit?.node?.ref;
  if (field) {
    await clickRef(tabId, field);
    await new Promise((r) => setTimeout(r, 250));
    const typed = await callExtension('qa_type', { tabId, ref: field, value: date }, 20_000).catch(() => null);
    trail.push({ tried: 'clicked in and typed', ok: typed?.ok !== false });
    if (typed?.ok !== false) {
      await callExtension('qa_press', { tabId, key: 'Enter' }, 15_000).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      if (landed(await shows())) {
        // Some pickers stay open after accepting a typed value; leave the page as we found it.
        if (await readCalendarHeader(tabId)) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, date, via: 'typed', trail };
      }
    }
  }

  /* 2 — WHOSE CALENDAR IS THIS? One read per marker, and the answer decides everything after.
   *
   * The popup lives in a PORTAL at the end of <body>, outside the field's subtree, and its parts may
   * not be in the accessibility tree at all (Ant's day is a bare <td title="2026-06-28">). Neither
   * matters: the bridge reads and clicks arbitrary CSS selectors without the snapshot's permission,
   * so a recipe addressed by selector reaches what the tree cannot see — on the SHIPPED extension,
   * with no Web Store release. The markers and the recipes live in widgets.mjs so this knowledge
   * stops being re-derived every session (owner, 2026-07-29). */
  const readSel = async (sel) => {
    const r = await callExtension('qa_read', { tabId, selector: sel, maxChars: 24 }).catch(() => null);
    return r && !r.error ? String(r.text ?? '') : null;
  };
  /* OPEN IT ONCE. Not once per code path — once.
   *
   * This was two clicks: the library-detection step clicked the FIELD, and the steering step below
   * then clicked the picker BUTTON — and on MUI the second click TOGGLES the dialog shut, so the
   * verb went on to report "day 14 is not clickable in the open calendar" about a calendar it had
   * closed itself (2026-07-30, and it is the same regression twice: the first time it was clicking
   * into a section). One helper, one click, and `openLabel` decides WHAT gets clicked. */
  let openedOnce = false;
  const openPicker = async () => {
    if (openedOnce) return true;
    const btn = openLabel ? await findClickable(tabId, openLabel, ['button']) : { hit: null };
    const t = btn.hit || (await findClickable(tabId, name, null)).hit;
    if (!t) return false;
    await clickRef(tabId, t.node.ref);
    openedOnce = true;
    await new Promise((r) => setTimeout(r, 540));
    return true;
  };
  await openPicker();
  let lib = null;
  for (const candidate of LIBRARIES) {
    for (const marker of candidate.markers) {
      if ((await readSel(marker)) != null) { lib = candidate; break; }
    }
    if (lib) break;
  }
  if (lib && ['antd', 'react-datepicker'].includes(lib.id)) {
    trail.push({ detected: lib.id });
    const plan = datePlan(lib.id, {
      iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      day, month, year, fieldName: name, openLabel,
      monthNameShort: MONTHS_LONG[month - 1].slice(0, 3),
    });
    for (const stepDef of plan) {
      if (stepDef.clickName) continue; // the field is already open
      // The year is its own problem: the panel shows one decade, so a far year needs hops.
      if (stepDef.note === 'the year') {
        if (!(await clickYearInPanel(tabId, year, trail))) break;
        continue;
      }
      if (stepDef.click) {
        let r = await callExtension('qa_click', { tabId, selector: stepDef.click }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
        // A panel that has just been swapped in can measure zero for a frame; one retry is enough.
        if (r?.ok === false) {
          await new Promise((res) => setTimeout(res, 600));
          r = await callExtension('qa_click', { tabId, selector: stepDef.click }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
        }
        trail.push({ step: stepDef.note || stepDef.click, ok: r?.ok !== false, ...(r?.ok === false ? { error: r.error } : {}) });
        if (r?.ok === false && !stepDef.optional) break;
        await new Promise((res) => setTimeout(res, 280));
      } else if (stepDef.stepMonth) {
        /* STEP TO THE MONTH — the branch that was missing, and its absence was the whole of "day 1
           is not clickable in the open calendar": a react-datepicker day class carries no month, so
           the click landed in whatever month happened to be showing, selected THAT date and closed
           the calendar looking like a success (2026-07-30). */
        const rec = recipeFor(lib.id, 'date') || {};
        let hops = 0;
        for (; hops < 24; hops++) {
          const hdr = await readCalendarHeader(tabId);
          if (!hdr || (hdr.month === month && (!hdr.year || hdr.year === year))) break;
          const back = (hdr.year || year) > year || ((hdr.year || year) === year && hdr.month > month);
          const arrow = back ? rec.prevMonth : rec.nextMonth;
          if (!arrow) break;
          const st = await callExtension('qa_click', { tabId, selector: arrow }, 20_000).catch(() => ({ ok: false }));
          if (st?.ok === false) break;
          await new Promise((res) => setTimeout(res, 220));
        }
        const hdrNow = await readCalendarHeader(tabId);
        trail.push({ step: 'stepped to the month', ok: hdrNow ? hdrNow.month === month : false, showing: hdrNow?.text, hops });
      } else if (stepDef.type?.selector) {
        const r = await callExtension('qa_type', { tabId, selector: stepDef.type.selector, value: stepDef.type.value }, 20_000).catch(() => null);
        trail.push({ step: stepDef.type.selector, ok: r?.ok !== false });
        await new Promise((res) => setTimeout(res, 380));
      }
    }
    /* CLOSE IT. This branch used to return with the panel still open, and the NEXT field's verb
       then steered THAT panel: the range picker's end date reported "2031 is not in the panel" while
       the header it was reading said "Nov2024" — the deadline's calendar (2026-07-30). An abandoned
       popup is not untidiness, it is the next widget's bug. */
    const after = await shows();
    if (await readCalendarHeader(tabId)) {
      await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
      await new Promise((r) => setTimeout(r, 220));
    }
    if (landed(after)) return { ok: true, field: name, date, via: `${lib.id} recipe`, trail };
    trail.push({ recipeFinished: lib.id, landed: false });
  }

  /* 2b — is it actually open? `openPicker` already clicked once; clicking again would close it.
     So the only thing left here is the field whose OWN click opens nothing and whose button we were
     not told about: look for a "Choose …" one. */
  if (!(await readCalendarHeader(tabId))) {
    const btn = await findClickable(tabId, 'Choose', ['button']);
    if (btn.hit) {
      await clickRef(tabId, btn.hit.node.ref);
      trail.push({ tried: 'its own "Choose …" button', ok: true });
      await new Promise((r) => setTimeout(r, 470));
    }
  }

  // 3 — the year.
  const yearView = await findClickable(tabId, 'switch to year view', ['button']);
  if (yearView.hit) {                                   // MUI X
    await clickRef(tabId, yearView.hit.node.ref);
    await new Promise((r) => setTimeout(r, 350));
    const y = await findClickable(tabId, String(year), ['radio', 'button', 'option', 'gridcell']);
    if (!y.hit) return { ok: false, error: `year ${year} is not offered by this picker`, trail };
    await clickRef(tabId, y.hit.node.ref);
    trail.push({ tried: 'MUI year view', ok: true });
    await new Promise((r) => setTimeout(r, 450));
  } else {
    const hdr = await readCalendarHeader(tabId);
    const yearSelect = await findClickable(tabId, 'Year', ['combobox']);
    /* A year typed into the calendar's own box, named in the page's language («Rok» on Allegro).
       The field's MUI sections are also called Year, which is why the MUI branch goes first. */
    const yearBox = yearSelect.hit ? null
      : (yearSelect.nodes || []).find((n) => ['spinbutton', 'textbox'].includes(n.role) && YEAR_FIELD.test(String(n.name || '').trim()));
    if (yearBox && (!hdr?.year || hdr.year !== year)) {
      const r = await callExtension('qa_type', { tabId, ref: yearBox.ref, value: String(year), raw: true }, 20_000).catch(() => null);
      trail.push({ tried: `the calendar's year box «${yearBox.name}»`, ok: r?.ok !== false });
      await new Promise((res) => setTimeout(res, 350));
    } else if (yearSelect.hit) {                        // react-datepicker with dropdowns
      await callExtension('qa_type', { tabId, ref: yearSelect.hit.node.ref, value: String(year) }, 20_000);
      const monthSelect = await findClickable(tabId, 'Month', ['combobox']);
      if (monthSelect.hit) await callExtension('qa_type', { tabId, ref: monthSelect.hit.node.ref, value: MONTHS_LONG[month - 1] }, 20_000);
      trail.push({ tried: 'month/year dropdowns', ok: true });
      await new Promise((r) => setTimeout(r, 350));
    } else if (hdr?.year && hdr.year !== year) {        // Ant: the year in the header is a button
      /* EXACTLY «2026», never a button that merely contains it: a calendar whose days are named
         in full («1 października 2026») matched here by substring and a DAY was clicked. */
      const yAll = await findClickable(tabId, String(hdr.year), ['button'], { strict: true });
      const yBtn = yAll.hit && norm(yAll.hit.node.name) === String(hdr.year) ? yAll : { hit: null };
      if (yBtn.hit) {
        await clickRef(tabId, yBtn.hit.node.ref);
        await new Promise((r) => setTimeout(r, 350));
        const y = await findClickable(tabId, String(year), ['button', 'cell', 'gridcell', 'option']);
        if (y.hit) { await clickRef(tabId, y.hit.node.ref); trail.push({ tried: 'header year panel', ok: true }); await new Promise((r) => setTimeout(r, 400)); }
      }
    }
  }

  // 4 — the month: step until the header agrees, whichever arrows this library named.
  for (let guard = 0; guard < 30; guard++) {
    const hdr = await readCalendarHeader(tabId);
    if (!hdr || !hdr.month || (hdr.month === month && (!hdr.year || hdr.year === year))) break;
    const wantEarlier = (hdr.year || year) > year || ((hdr.year || year) === year && hdr.month > month);
    // One snapshot, every language's arrow looked up in it — not a snapshot per name.
    const { nodes: now } = await findClickable(tabId, '', ['button']);
    const names = (wantEarlier ? PREV_MONTH_NAMES : NEXT_MONTH_NAMES).map((s) => norm(s));
    const buttons = (now || []).filter((n) => n.role === 'button');
    const arrow = buttons.find((n) => names.includes(norm(n.name))) || buttons.find((n) => names.some((s) => s.length > 5 && norm(n.name).startsWith(s)));
    if (!arrow) break;
    await clickRef(tabId, arrow.ref);
    await new Promise((r) => setTimeout(r, 260));
  }
  const hdrNow = await readCalendarHeader(tabId);
  if (hdrNow) trail.push({ tried: 'stepped to the month', ok: hdrNow.month === month && (!hdrNow.year || hdrNow.year === year), showing: hdrNow.text });

  // 5 — the day.
  /* A day cell is named three different ways in the wild: "6", "06", and the ISO date (Ant puts
     2024-11-06 in its aria-label). Try the most specific spelling first — a bare "6" would also
     match "16" and "26" by substring, and clicking the wrong day is worse than not clicking. */
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let dayHit = null;
  /* The day by its FULL name first («26 marca 2019»): it names the month and the year too, so it
     cannot land in the wrong month. One snapshot for every language's spelling. */
  {
    const { nodes: now } = await findClickable(tabId, '', null);
    const wanted = fullDateNames(day, month, year).map((s) => norm(s));
    const cell = (now || []).find((n) => n.role !== 'textbox' && n.role !== 'combobox' && wanted.includes(norm(n.name)));
    if (cell) dayHit = { hit: { node: cell } };
  }
  /* A BARE «26» IS ONLY SAFE IN THE RIGHT MONTH. When the calendar can be read and shows another
     month, clicking 26 picks a date nobody asked for and the form validates it: refuse instead. */
  if (!dayHit && hdrNow?.month && (hdrNow.month !== month || (hdrNow.year && hdrNow.year !== year))) {
    if (await readCalendarHeader(tabId)) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
    return { ok: false, error: `the calendar shows ${hdrNow.text} and could not be moved to ${MONTHS_LONG[month - 1]} ${year}, so day ${day} was not clicked — it would have been the wrong date`, trail };
  }
  for (const spelling of dayHit ? [] : [iso, String(day).padStart(2, '0'), String(day)]) {
    const found = await findClickable(tabId, spelling, ['gridcell', 'button', 'cell', 'td', 'th', 'option', 'row', 'link']);
    if (found.hit) { dayHit = found; break; }
  }
  if (!dayHit) return { ok: false, error: `day ${day} is not clickable in the open calendar`, trail };
  await clickRef(tabId, dayHit.hit.node.ref);
  await new Promise((r) => setTimeout(r, 400));
  // Close whatever is still open: an abandoned popup swallows the next field's click, which is how
  // one failed widget used to poison every step after it.
  if (await readCalendarHeader(tabId)) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  const finalText = await shows();
  /* Reading the value back is the ONLY honest check. "The picker closed" was tried and rejected:
     an overlay dismissal closes it too, so a missed day click reported success and the form was
     left empty — a false pass is worse than a false failure, because the agent stops looking. */
  const ok = landed(finalText);
  return {
    ok, field: name, date, via: 'calendar', trail,
    ...(ok ? {} : {
      shows: finalText.trim().slice(0, 80),
      note: 'the calendar was driven to the right month but the field does not read back that date. Check it yourself with qa_read on the field, and if the form accepted it, the field simply keeps its value out of the accessibility tree (MUI X does).',
    }),
  };
}

/**
 * TAGS — type, VERIFY, commit. One call for the whole list.
 *
 * A "tags" select (Ant `mode="tags"`, and every chips input built the same way) creates values that
 * are not in any option list, so there is nothing to pick: the value is typed and committed with a
 * key. Three things about it are counter-intuitive, and all three cost a live run to find:
 *
 *  · DO NOT CLICK THE FIELD FIRST. A click moves the caret out of the component's own search input
 *    and the text then goes nowhere. (Owner watched this: "нужно ввести какой-то текст и нажать
 *    Enter" — and the click in between was mine.)
 *  · VERIFY THE TEXT IS STILL THERE BEFORE THE KEY. When a tag commits, Ant CLEARS its search
 *    input; the re-render that follows can wipe a value written a moment earlier, and Enter then
 *    re-submits the PREVIOUS text — which in tags mode toggles that tag back OFF. That is exactly
 *    the "залипание" the owner saw: the first tag vanished while the second was being added.
 *  · ONE TAG PER PASS, each on a fresh ref. Every commit re-renders the control.
 *
 * The value of an input is visible in the snapshot's `state` (`value="…"`), so verifying costs a
 * snapshot rather than anything clever.
 */
async function pickTags(tabId, name, tags, { commitKey = 'Enter' } = {}) {
  const readField = async () => {
    const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
    rememberSnapshot(tabId, snap);
    const hit = pickNode(Array.isArray(snap?.nodes) ? snap.nodes : [], { name }, new Set());
    return hit?.node || null;
  };
  /* THE TEXT IS NOT IN `input.value`, AND THAT COST A WHOLE RUN.
   *
   * Ant keeps the live search text in its own mirror element, so the snapshot's `value="…"` state
   * stays empty and every tag failed a verification built on it (2026-07-30). What DOES move is the
   * field's accessible NAME: the label wraps the control, so both the text being typed and every
   * committed chip read back through it. So the name answers both halves — the text is live before
   * the key, and a chip that got toggled off DISAPPEARS from the name, which is the actual bug. */
  const occurrences = (node, s) => {
    const hay = String(node?.name || '').toLowerCase();
    const needle = String(s).toLowerCase();
    if (!needle) return 0;
    let n = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
  };
  const wanted = [...new Set(tags.map((t) => String(t)))];
  const trail = [];
  await clearPopups(tabId);

  /* WHY THIS IS A REPAIR LOOP AND NOT A SEQUENCE.
   *
   * The live cause turned out to be OURS, not Ant's (2026-07-30). The fill engine's combobox path
   * types the text and then CLICKS THE MATCHING OPTION — which in tags mode commits the tag by
   * itself. Our follow-up key then lands on whatever option is highlighted, which is the tag
   * committed a moment ago, and a second submit of an existing tag REMOVES it. Hence exactly the
   * symptom the owner watched: the tag added first disappeared while the next one went in.
   *
   * The engine lives in the extension, so changing its behaviour is a Web Store release away. What
   * this process can do is check the result and put back whatever fell off — which is what a person
   * does, converges in two or three passes, and is correct whichever of the two paths committed the
   * tag. The occurrence COUNT is the tell: once means only the live search text, twice means the
   * chip is there too and no key is needed.
   */
  let node = await readField();
  if (!node) return { ok: false, error: `no field is called "${name}"` };
  for (let pass = 1; pass <= 3; pass++) {
    const missing = wanted.filter((t) => occurrences(node, t) === 0);
    if (!missing.length) break;
    for (const want of missing) {
      await callExtension('qa_type', { tabId, ref: node.ref, value: want }, 30_000).catch(() => null);
      await new Promise((r) => setTimeout(r, 220));
      let now = (await readField()) || node;
      const seen = occurrences(now, want);
      if (seen === 0) {
        // The text did not even land; pressing the key here is what re-submits the previous tag.
        trail.push({ pass, tag: want, typed: false });
        node = now;
        continue;
      }
      if (seen === 1) {
        await callExtension('qa_press', { tabId, key: commitKey, ref: now.ref }, 15_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 340));
        now = (await readField()) || now;
        trail.push({ pass, tag: want, committed: 'with the key' });
      } else {
        trail.push({ pass, tag: want, committed: 'by the fill engine itself' });
      }
      node = now;
    }
    node = (await readField()) || node;
  }
  /* Leave nothing open. An abandoned dropdown swallows the NEXT field's opening click — that is
     why the range picker after this one never opened, and it looked like the range verb was broken. */
  await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const finalNode = (await readField()) || node;
  const added = wanted.filter((t) => occurrences(finalNode, t) > 0);
  const lost = wanted.filter((t) => occurrences(finalNode, t) === 0);
  return {
    ok: lost.length === 0,
    field: name,
    added,
    reads: String(finalNode?.name || '').slice(0, 90),
    trail,
    ...(lost.length ? { failed: lost, note: 'these would not stay in the field after three passes. A control that never keeps a typed value is usually NOT in tags mode — it only accepts values from its own option list, and then qa_type with the option text is the right verb.' } : {}),
  };
}

/**
 * A TIME, on a picker whose cells have no role at all.
 *
 * Ant's TimePicker is columns of bare <li>: invisible to the accessibility tree, and the fill
 * engine's date path misfires on it outright ("calendar did not open — typed an ISO date instead"),
 * leaving the field empty and reporting ok. But the column's TEXT is readable and its ORDER is the
 * value — so read the column, find which child says "14", click that child. That works without
 * knowing the picker's step (Ant's minute step is configurable, and guessing it would be a bug).
 */
async function pickTime(tabId, name, time) {
  const parts = String(time).trim().split(':').map((s) => s.trim());
  if (!parts.length || parts.some((p) => !/^\d{1,2}$/.test(p))) return { ok: false, error: `time must look like HH:mm — got "${time}"` };
  const trail = [];
  await clearPopups(tabId);

  /* TYPED FIRST: 0.3s against 14 through the columns, and the same value (measured 2026-07-30). */
  {
    const typed = await rawType(tabId, name, time);
    if (typed?.ok !== false) {
      await new Promise((r) => setTimeout(r, 240));
      const back = await findClickable(tabId, name, null);
      const reads = `${back.hit?.node?.state || ''} ${back.hit?.node?.name || ''}`;
      if (parts.every((p) => reads.includes(p.padStart(2, '0')))) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, time, via: 'typed', trail: [{ tried: 'typed it straight in', ok: true, reads: typed.reads ?? null }] };
      }
    }
    trail.push({ tried: 'typed it straight in', ok: false, reads: typed?.reads ?? null });
  }

  const field = await findClickable(tabId, name, null);
  if (!field.hit) return { ok: false, error: `no field is called "${name}"` };
  await clickRef(tabId, field.hit.node.ref);
  await new Promise((r) => setTimeout(r, 480));

  const r = recipeFor('antd', 'time') || { column: '.ant-picker-time-panel-column', cell: '.ant-picker-time-panel-cell-inner', confirm: '.ant-picker-ok button' };

  /* A SINGLE LIST IN TWELVE-HOUR FORM is the other shape a time picker takes (react-datepicker), and
     it is not columns of numbers at all: 48 items reading "10:30 AM". So try it first when the Ant
     columns are not there, converting the value rather than hoping the list is 24-hour. */
  const rdp = recipeFor('react-datepicker', 'time') || {};
  if (rdp.column) {
    const list = await callExtension('qa_read', { tabId, selector: rdp.column, maxChars: 900 }).catch(() => null);
    const text = String(list?.text || '');
    const items = text.match(/\d{1,2}:\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?/g) || [];
    if (items.length >= 6) {
      const h = Number(parts[0]);
      const mm = (parts[1] || '00').padStart(2, '0');
      const suffix = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const want12 = `${h12}:${mm} ${suffix}`;
      const want24 = `${String(h).padStart(2, '0')}:${mm}`;
      const flat = (x) => x.replace(/\./g, '').replace(/\s+/g, ' ').trim().toUpperCase();
      let idx = items.findIndex((x) => flat(x) === flat(want12));
      if (idx < 0) idx = items.findIndex((x) => flat(x) === flat(want24));
      if (idx < 0) {
        trail.push({ list: '12-hour', error: `"${time}" is not one of the ${items.length} times offered`, near: items.slice(Math.max(0, items.length / 2 - 2), items.length / 2 + 2) });
      } else {
        const hit = await callExtension('qa_click', { tabId, selector: `${rdp.column} li:nth-of-type(${idx + 1})` }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
        trail.push({ list: '12-hour', picked: items[idx], at: idx + 1, ok: hit?.ok !== false });
        await new Promise((res) => setTimeout(res, 380));
        const back = await findClickable(tabId, name, null);
        const shows = `${back.hit?.node?.state || ''} ${back.hit?.node?.name || ''}`;
        const ok = shows.includes(want24) || shows.includes(String(h12) + ':' + mm);
        return { ok, field: name, time, trail, ...(ok ? {} : { shows: shows.trim().slice(0, 80) }) };
      }
    }
  }

  for (let col = 0; col < parts.length; col++) {
    const want = parts[col].padStart(2, '0');
    const colSel = `${r.column}:nth-of-type(${col + 1})`;
    const read = await callExtension('qa_read', { tabId, selector: colSel, maxChars: 400 }).catch(() => null);
    const cells = String(read?.text || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!cells.length) { trail.push({ column: col + 1, error: 'the panel has no such column — is this a time picker at all?' }); break; }
    const idx = cells.findIndex((c) => c === want || c === String(Number(want)));
    if (idx < 0) { trail.push({ column: col + 1, error: `"${want}" is not one of this column's values`, offers: cells.slice(0, 8) }); break; }
    const hit = await callExtension('qa_click', { tabId, selector: `${colSel} li:nth-of-type(${idx + 1}) ${r.cell}` }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
    trail.push({ column: col + 1, picked: want, at: idx + 1, ok: hit?.ok !== false, ...(hit?.ok === false ? { error: hit.error } : {}) });
    await new Promise((res) => setTimeout(res, 320));
  }
  // The panel keeps the value provisional until its own OK — skipping this leaves the field empty.
  const okBtn = await callExtension('qa_click', { tabId, selector: r.confirm }, 20_000).catch(() => null);
  if (okBtn?.ok === false) {
    const byName = await findClickable(tabId, 'OK', ['button']);
    if (byName.hit) await clickRef(tabId, byName.hit.node.ref);
  }
  await new Promise((res) => setTimeout(res, 360));
  const after = await findClickable(tabId, name, null);
  const shows = String(after.hit?.node?.state || '') + ' ' + String(after.hit?.node?.name || '');
  const ok = parts.every((p) => shows.includes(p.padStart(2, '0')));
  if (!ok) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  return { ok, field: name, time, trail, ...(ok ? {} : { shows: shows.trim().slice(0, 80) }) };
}

/**
 * A DATE RANGE — two dates that live in ONE control (Ant's RangePicker and its equivalents).
 *
 * Not two calls to qa_pick_date: the control owns both inputs, the panel walks from start to end by
 * itself, and a second cold approach would re-open it on the start again. So the start is driven by
 * the normal single-date route (which knows every library), and then the panel — still open — is
 * steered to the end date by the same recipe minus the opening click.
 */
async function pickDateRange(tabId, name, from, to) {
  const parse = (d) => {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(d).trim());
    return m ? { day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return { ok: false, error: `both dates must look like dd/mm/yyyy — got "${from}" and "${to}"` };

  const trail = [];
  await clearPopups(tabId);

  /* TYPE BOTH ENDS FIRST — 0.68s against 35 through two calendar panels (measured 2026-07-30).
   * A range is two inputs in one control, and each accepts its own date in the displayed format.
   * The earlier "never type" note was true of the ENGINE's date path, which writes ISO; `raw` writes
   * the string as given, which is what the component parses. */
  {
    /* BY THE RECIPE'S SELECTORS, not by snapshot refs. Both inputs carry the same accessible name, so
       "the first two nodes called Review window" is a guess — and it guessed wrong live, writing the
       start date into something that came back as 01/11/2027. first-child / last-child is exact. */
    const rr = recipeFor('antd', 'range') || {};
    if (rr.startInput && rr.endInput) {
      /* OPEN EACH END BEFORE WRITING IT, AND BLUR AFTER THE LAST ONE. Driven by hand on the stand
         (2026-07-30): writing into the end input while the START end is the active one leaves the
         text visible and the range uncommitted, and `useLockEffect` (rc-picker Input.js:181-187)
         restores the input from props the moment focus leaves — so the field goes back to empty and
         the whole thing reads as "the picker ignored us". `open` clicks the input first, which is
         what makes rc-picker treat THAT end as active; the closing `blur` is what commits the pair. */
      const one = await callExtension('qa_type', { tabId, selector: rr.startInput, value: from, raw: true, open: true, commit: 'Enter', settleMs: 220 }, 20_000).catch(() => ({ ok: false }));
      await new Promise((r) => setTimeout(r, 260));
      const two = await callExtension('qa_type', { tabId, selector: rr.endInput, value: to, raw: true, open: true, commit: 'Enter', blur: true, settleMs: 220 }, 20_000).catch(() => ({ ok: false }));
      await new Promise((r) => setTimeout(r, 300));
      trail.push({ tried: 'typed both ends', start: one?.reads ?? null, end: two?.reads ?? null });
      /* JUDGE BY WHAT THE WRITE READ BACK, NOT BY qa_read. `qa_read` is innerText (mcp-collect.ts),
         and an <input> has none — it answered "" for a correctly filled field, so this gate could
         never be satisfied and EVERY range fell through to the panel walk even when the typing had
         worked. `qa_type` already hands back `reads: input.value`; that is the state, and it is
         free. Each end is checked against ITS OWN input: one concatenated string lets the start's
         year satisfy the end's test. */
      const has = (p, text) => {
        const t = String(text ?? '');
        const hasYear = t.includes(String(p.year));
        const hasMonth = t.includes(String(p.month).padStart(2, '0')) || new RegExp(`\\b${p.month}\\b`).test(t);
        const hasDay = t.includes(String(p.day).padStart(2, '0')) || new RegExp(`\\b${p.day}\\b`).test(t);
        return hasYear && hasMonth && hasDay;
      };
      if (has(a, one?.reads) && has(b, two?.reads)) {
        await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
        return { ok: true, field: name, from, to, via: 'typed', trail };
      }
    }
  }

  /* Otherwise steer the panels. NO TYPING THROUGH THE ENGINE, EITHER END. The fill engine writes an ISO date, and a picker whose format is
     DD/MM/YYYY turns that into some other date entirely — watched 05/09/2027 become 05/03/2025
     (2026-07-30). The calendar route is format-agnostic, so it is the only one used here. */
  const field = await findClickable(tabId, name, null);
  if (!field.hit) return { ok: false, error: `no field is called "${name}"` };
  /* AND CHECK IT ACTUALLY OPENED. The first click after another widget's abandoned dropdown only
     DISMISSES that dropdown — live, this verb reported ".ant-picker-year-btn is not visible" and the
     real cause was the tags popup left open by the field before it (2026-07-30). One retry costs a
     click; not retrying costs the whole field. */
  /* The DIFF is the honest witness that it opened, not a marker read: a hidden leftover dropdown
     from the previous widget still answers a CSS query, and then a zero-size year button is blamed
     on the range picker (2026-07-30). A panel that opened brings its header controls with it. */
  const opensPanel = (res) => {
    const appeared = res?.changed?.appeared || [];
    return appeared.some((n) => /choose a (year|month)|previous month|next month|last year|switch to year/i.test(String(n.name || ''))) || appeared.filter((n) => /^\d{1,2}$/.test(String(n.name || '').trim())).length >= 6;
  };
  let open = await clickRef(tabId, field.hit.node.ref);
  await new Promise((r) => setTimeout(r, 560));
  if (!opensPanel(open)) {
    trail.push({ note: 'the first click did not bring a panel — something else was open and swallowed it; clicking the field again' });
    open = await clickRef(tabId, field.hit.node.ref);
    await new Promise((r) => setTimeout(r, 620));
  }
  if (!opensPanel(open)) trail.push({ warning: 'no calendar panel appeared after two clicks — steering it anyway, by name' });

  /* Ant's range dropdown holds TWO panels, and both carry a year button. Clicking the FIRST one
     navigates the pair, which is what we want for either end — and the day cell is addressed by its
     own ISO title, so there is no ambiguity about which panel it landed in. */
  const steer = async (p, which) => {
    const yyyy = String(p.year);
    const mm = String(p.month).padStart(2, '0');
    const iso = `${yyyy}-${mm}-${String(p.day).padStart(2, '0')}`;
    /* BY NAME FIRST, selector second. Ant's range header buttons carry real accessible names
       ("Choose a year", "Choose a month"), and a name is resolved against a live snapshot — so it
       cannot be the stale, zero-size, or wrong-panel element a bare class selector can be. The
       selector stays as the fallback for a build whose buttons have no names. */
    const seq = [
      { name: 'Choose a year', click: `${ANT_OPEN} .ant-picker-year-btn`, note: `${which}: year panel` },
      { year: p.year },
      { click: `${ANT_OPEN} [title="${yyyy}-${mm}"]`, note: `${which}: the month` },
      { click: `${ANT_OPEN} td[title="${iso}"]`, note: `${which}: the day` },
    ];
    for (const s of seq) {
      if (s.year) {
        if (!(await clickYearInPanel(tabId, s.year, trail, which))) return false;
        continue;
      }
      let r = null;
      if (s.name) {
        const byName = await findClickable(tabId, s.name, ['button'], { strict: true });
        if (byName.hit) r = await clickRef(tabId, byName.hit.node.ref);
      }
      if (!r || r?.ok === false) r = await callExtension('qa_click', { tabId, selector: s.click }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
      if (r?.ok === false) {
        // A panel swapped in a frame ago can measure zero; one retry is the whole fix.
        await new Promise((res) => setTimeout(res, 600));
        r = await callExtension('qa_click', { tabId, selector: s.click }, 20_000).catch((e) => ({ ok: false, error: String(e.message) }));
      }
      trail.push({ step: s.note, ok: r?.ok !== false, ...(r?.ok === false ? { error: r.error } : {}) });
      if (r?.ok === false) return false;
      await new Promise((res) => setTimeout(res, 430));
    }
    return true;
  };
  const startOk = await steer(a, 'start');
  // Ant moves the caret to the end input by itself; the dropdown stays open, so the end is the same
  // sequence again — and re-clicking the field here would restart the range on the start input.
  if (startOk) await steer(b, 'end');
  // Read the control back: a range field renders both dates as its own text.
  /* A RANGE LIVES IN TWO INPUTS, so reading "the field" reads only the start — which reported
     ok:false on a range that had gone in perfectly (the step's own validator said it was valid).
     Take every node that carries this name, plus the recipe's own two selectors. */
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
  rememberSnapshot(tabId, snap);
  const all = Array.isArray(snap?.nodes) ? snap.nodes : [];
  const mine = all.filter((n) => norm(n.name) === norm(name) || norm(n.name).startsWith(norm(name)));
  const shows = mine.map((n) => String(n.state || '')).join(' ');
  /* THE SNAPSHOT ALREADY CARRIES BOTH VALUES — `state: value="05/09/2027"` per input — so the two
     qa_read calls that used to stand here were not merely slow, they were empty: qa_read is
     innerText and an <input> has none. And the month has to be checked, exactly as the
     single-date `landed()` above does: without it a range steered into the wrong month answers ok.
     Each end is matched against ITS OWN input where both are visible, because one joined string
     lets the start's year stand in for the end's. */
  const valued = mine.map((n) => String(n.state || '')).filter((s) => s.includes('value='));
  const hasIn = (p, t) =>
    t.includes(String(p.year)) &&
    (t.includes(String(p.month).padStart(2, '0')) || new RegExp(`\\b${p.month}\\b`).test(t)) &&
    (t.includes(String(p.day).padStart(2, '0')) || new RegExp(`\\b${p.day}\\b`).test(t));
  const ok = valued.length >= 2 ? hasIn(a, valued[0]) && hasIn(b, valued[1]) : hasIn(a, shows) && hasIn(b, shows);
  if (!ok) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
  return { ok, field: name, from, to, trail, ...(ok ? {} : { shows: shows.trim().slice(0, 80), note: 'the end panel was driven but the control does not read both dates back. Ant keeps a range in two inputs — read them with qa_read on the control before deciding it failed.' }) };
}

/** Replay ONE step: resolve every target against a fresh snapshot, then one batch call. */
async function applyRecipeStep(tabId, step, values, dryRun) {
  /* A REF BELONGS TO ONE SNAPSHOT, AND THE NEXT SNAPSHOT REUSES ITS NUMBER.
   *
   * This cost a wrong click on the live wizard (2026-07-29): the step's `Next` was resolved to e30,
   * then a second snapshot was taken to find a conditional field, and e30 now meant `Back` — the
   * button was still in the DOM, so nothing was "stale" and the extension had no reason to refuse.
   * The refs did not break; they were RENUMBERED. So every snapshot taken inside a step updates
   * `nodesNow`, and anything clicked or filled afterwards is resolved against that, never against
   * an earlier list. `takeSnapshot` is the only way to get one here, so this cannot be forgotten. */
  let nodesNow = [];
  let lastUrl = '';
  const takeSnapshot = async () => {
    const s = await callExtension('qa_snapshot', { tabId }, 30_000);
    rememberSnapshot(tabId, s);
    nodesNow = Array.isArray(s?.nodes) ? s.nodes : [];
    lastUrl = s?.url || lastUrl;
    return nodesNow;
  };
  const nodes = await takeSnapshot();
  const snap = { url: lastUrl };
  const used = new Set();
  const batch = [];
  const resolved = [];
  const missing = [];
  const ambiguous = [];

  /* A FIELD THAT CANNOT BE WRITTEN TO DOES NOT BELONG IN THE BATCH.
   *
   * `qa_type_many` is one round trip for everything the fill engine can set directly, and that is
   * most of a form. A calendar and a multi-level tree are not in it: they need their own verb, and
   * putting them in the batch is how a replay silently loses the dates it got right on the first
   * pass. They run after the batch, one at a time — two popups open at once break each other. */
  const special = [];
  for (const f of step.fields || []) {
    const via = specialVerb(f);
    if (via) {
      special.push({ ...f, via });
      continue;
    }
    const hit = pickNode(nodes, f, used, { fieldsOnly: f.action !== 'click' });
    if (!hit) {
      missing.push(f.name || f.selector);
      continue;
    }
    used.add(hit.node.ref);
    if (hit.ambiguous) ambiguous.push(f.name || f.selector);
    const value = values && Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : f.value;
    batch.push({ ref: hit.node.ref, value, action: f.action === 'click' ? 'click' : 'type' });
    resolved.push({ field: f.name || f.selector, matched: hit.node.name, ref: hit.node.ref, value });
  }

  const uploads = (step.uploads || []).map((u) => ({
    field: u.name, selector: u.selector, fixture: u.fixture, path: u.path, fileName: u.fileName, mimeType: u.mimeType,
  }));

  // Only to SHOW in the plan (and in a dry run) — the click itself re-resolves after filling,
  // because that is what makes a ref stale. Not pushed into `missing`: on a step whose Next only
  // becomes reachable once the step is valid, its absence up front is not a defect.
  let advance = null;
  if (step.advance) {
    const hit = pickNode(nodes, step.advance, used);
    if (hit) advance = { ref: hit.node.ref, name: hit.node.name };
  }

  const plan = {
    step: step.title || '',
    url: snap?.url || '',
    resolved,
    ...(special.length ? { viaOwnVerb: special.map((f) => ({ field: f.name, verb: f.via === 'date' ? 'qa_pick_date' : 'qa_pick_path' })) } : {}),
    ...(uploads.length ? { uploads: uploads.map((u) => ({ field: u.field, fixture: u.fixture ?? null, path: u.path ?? null })) } : {}),
    ...(advance ? { advance: advance.name } : {}),
    ...(missing.length ? { missing } : {}),
    ...(ambiguous.length ? { ambiguous, note: 'more than one control carries that name — the first in DOM order was taken' } : {}),
  };
  // A dry run is the cheap "does this recipe still fit the page" check: reads only, so it needs
  // the drive consent, and it changes nothing if the answer is no.
  if (dryRun) return { ...plan, dryRun: true };

  const filled = batch.length ? await callExtension('qa_type_many', { tabId, fields: batch }, 60_000) : null;

  /* ONE RETRY FOR THE FIELDS THAT WERE NOT READY YET.
   *
   * The reason recipes need this is the shape of every real wizard: choosing a country loads the
   * region list ~600ms later, choosing a currency loads the funding lines. On the FIRST pass the
   * agent notices and fills them a beat later; a replay sends the whole step at once, so those
   * two entries land while their options do not exist and come back ok:false. Retrying only the
   * failures, once, after a short settle costs one extra call on the steps that need it and
   * nothing on the steps that do not — and it is the difference between "replay works" and
   * "replay works except for the dependent fields", which is the same as not working. */
  let retried = null;
  const lateOnes = (filled?.results || [])
    .map((r, i) => (r.ok === false ? batch[i] : null))
    .filter(Boolean);
  if (lateOnes.length) {
    await new Promise((r) => setTimeout(r, 800));
    const again = await callExtension('qa_type_many', { tabId, fields: lateOnes }, 60_000);
    retried = { attempted: lateOnes.length, filled: again?.filled ?? 0, results: again?.results };
  }

  /* THE FIELDS THAT DID NOT EXIST YET — a different problem from the one above, and it needs a
   * fresh snapshot rather than a retry.
   *
   * On this wizard, choosing "Medium" risk ADDS three inputs that were not in the DOM when the
   * step was resolved; the same shape as any "other — please specify". The first pass sees them
   * because it fills, looks, and fills again; a replay resolved everything up front, so they came
   * back as `missing` and the step stopped. So: if anything is missing AFTER the batch has run
   * (the batch is what reveals them), snapshot once more and fill whatever now exists. */
  let appeared = null;
  if (missing.length && batch.length) {
    await new Promise((r) => setTimeout(r, 800));
    const fresh = await takeSnapshot();
    const used2 = new Set();
    const second = [];
    const stillMissing = [];
    for (const label of missing) {
      const want = (step.fields || []).find((f) => (f.name || f.selector) === label);
      const hit = want ? pickNode(fresh, want, used2, { fieldsOnly: want.action !== 'click' }) : null;
      if (!hit) {
        stillMissing.push(label);
        continue;
      }
      used2.add(hit.node.ref);
      const value = values && Object.prototype.hasOwnProperty.call(values, want.name) ? values[want.name] : want.value;
      second.push({ ref: hit.node.ref, value, action: want.action === 'click' ? 'click' : 'type' });
    }
    if (second.length) {
      const late = await callExtension('qa_type_many', { tabId, fields: second }, 60_000);
      appeared = { filled: late?.filled ?? 0, of: second.length, resolvedAfterTheBatch: missing.filter((m) => !stillMissing.includes(m)) };
    }
    missing.length = 0;
    missing.push(...stillMissing);
  }

  /* THE FIELDS WITH THEIR OWN VERB — a date, a cascader, a checkable tree.
   *
   * Sequential and after the batch, because each one opens a popup and two open popups break each
   * other. Each verb resolves the field by NAME against a snapshot it takes itself, so nothing here
   * depends on a ref from before the batch re-rendered the step. */
  let byVerb = null;
  if (special.length) {
    byVerb = [];
    for (const f of special) {
      const value = values && Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : f.value;
      const r =
        f.via === 'date'
          ? await pickDate(tabId, f.name, String(value ?? ''))
          : await pickPath(
              tabId,
              f.name,
              String(value ?? '')
                .split('>')
                .map((s) => s.trim())
                .filter(Boolean),
            );
      byVerb.push({ field: f.name, via: f.via, ok: !!r?.ok, ...(r?.ok ? {} : { error: r?.error || 'the verb refused' }) });
    }
    await takeSnapshot(); // the popups moved things; the advance below must see the page as it is now
  }

  const uploaded = [];
  // One snapshot for the whole batch of attachments (the fill above may have re-rendered the step),
  // then each field resolved by name against it — never against a ref from before the fill.
  if (uploads.length) await takeSnapshot();
  const usedU = new Set();
  for (const u of uploads) {
    let content;
    let fileName = u.fileName;
    let mimeType = u.mimeType;
    if (u.path) {
      try {
        content = readFileSync(u.path).toString('base64');
        fileName = fileName || basename(u.path);
        mimeType = mimeType || MIME[extname(u.path).toLowerCase()] || 'application/octet-stream';
      } catch (e) {
        uploaded.push({ field: u.field, ok: false, error: `could not read ${u.path}: ${e.message}` });
        continue;
      }
    }
    const hit = pickNode(nodesNow, { name: u.field, selector: u.selector }, usedU);
    if (!hit) {
      uploaded.push({ field: u.field, ok: false, error: 'the upload field is not on the page any more' });
      continue;
    }
    usedU.add(hit.node.ref);
    const r = await callExtension('qa_upload', { tabId, ref: hit.node.ref, name: fileName, mimeType, content, fixture: u.fixture }, 30_000);
    uploaded.push({ field: u.field, ...(r && typeof r === 'object' ? r : { result: r }) });
  }

  /* THE ADVANCE CONTROL IS RE-RESOLVED, NEVER REUSED.
   *
   * Its ref came from the snapshot taken before this step was filled, and filling re-renders —
   * which is exactly how the first live run of this failed ("ref e49 is stale"). The extension is
   * right to refuse it; the fix belongs here. One extra snapshot inside the bridge costs the agent
   * nothing, and the NAME is what survives the re-render. */
  let advanced = null;
  if (step.advance) {
    // Resolved LAST, on the snapshot the live refs belong to: the fill re-rendered the step, and
    // a name is what survives that. Clicking the ref found before the fill is how the first live
    // run pressed "Back" instead of "Next".
    await takeSnapshot();
    const pool = nodesNow.filter((n) => CLICKABLE_ROLES.has(n.role));
    const hit = pickNode(pool.length ? pool : nodesNow, step.advance, new Set());
    if (hit) {
      advanced = await callExtension('qa_click', { tabId, ref: hit.node.ref }, 20_000);
      // A wizard step swaps its fields in after the click settles; the next step's snapshot is
      // taken by the next applyRecipeStep call, so give the new fields a beat to mount.
      await new Promise((r) => setTimeout(r, 450));
    } else {
      missing.push(step.advance.name || step.advance.selector || 'advance control');
    }
  }

  return {
    ...plan,
    filled: filled ? { filled: filled.filled, total: filled.total, results: filled.results } : null,
    ...(retried ? { retried } : {}),
    ...(appeared ? { appeared } : {}),
    ...(byVerb ? { byVerb } : {}),
    ...(uploaded.length ? { uploaded } : {}),
    ...(advanced ? { advanced } : {}),
    ...(missing.length ? { missing } : {}),
  };
}

/**
 * Trim a snapshot before it reaches the agent's context.
 *
 * The extension walks the whole page (up to 1200 nodes) and that is right — it is also what one
 * step of a wizard costs, repeatedly, when the page is a component-heavy app. The filtering
 * happens HERE, in the Node process, for two reasons: it works against the shipped extension
 * with no release, and the refs stay valid — the extension's ref map still holds every node, so
 * a ref from a filtered view clicks and types exactly as one from the full tree does.
 */
function filterSnapshot(snap, { fieldsOnly, roles, match, within, limit, format }) {
  if (!snap || !Array.isArray(snap.nodes)) return snap;
  const filtering = !!(fieldsOnly || (roles && roles.length) || match || within || limit);
  let nodes = snap.nodes;

  const wanted = new Set((roles || []).map((r) => String(r).toLowerCase()));
  if (wanted.size || fieldsOnly) nodes = nodes.filter((n) => wanted.has(n.role) || (fieldsOnly && isFieldNode(n)));
  if (match) {
    const m = norm(match);
    nodes = nodes.filter((n) => norm(n.name).includes(m));
  }
  // `within` is a selector taken from a NODE of a previous snapshot (a dialog, a step panel, a
  // fieldset): a child's cssPath starts with its ancestor's, so a prefix test is the subtree.
  if (within) nodes = nodes.filter((n) => n.selector === within || n.selector.startsWith(within + ' '));
  let truncated = !!snap.truncated;
  if (limit && nodes.length > limit) {
    nodes = nodes.slice(0, limit);
    truncated = true;
  }

  const out = { count: nodes.length, truncated, url: snap.url };
  /* SURVIVES EVERY FILTER, on purpose. "The page looks empty" is precisely the moment this
     matters, and every narrowing option above makes a page look emptier. See modalLayer(). */
  if (snap.modal) out.modal = snap.modal;
  if (filtering) out.of = snap.count;
  if (format !== 'nodes') {
    const keep = new Set(nodes.map((n) => n.ref));
    out.tree = filtering
      ? String(snap.tree || '')
          .split('\n')
          .filter((line) => {
            const m = /\[ref=(e\d+)\]/.exec(line);
            return m ? keep.has(m[1]) : false;
          })
          .join('\n')
      : snap.tree;
  }
  if (format !== 'tree') out.nodes = nodes;
  if (filtering && !nodes.length) out.note = 'nothing matched the filter — drop it and look at the whole tree before concluding the control is absent';
  return out;
}

/* The operating manual, handed to the agent at `initialize` — not left in a README
 * nobody opens. A customer installs the extension, adds this server, and their agent
 * already knows what this bridge is, what it deliberately cannot do, and which of the
 * two switches only a human can flip. Everything here is a thing an agent got wrong
 * in practice. */
/**
 * THE ORDER OF THIS TEXT IS LOAD-BEARING, AND THE FIRST ~2000 CHARACTERS ARE THE WHOLE BUDGET.
 *
 * Clients truncate a server's `instructions`. Measured 30.09.2026 in a live session: of 19 659
 * characters, 2 001 arrived — 10.2%. The version before this one spent every one of those on
 * ADVOCACY (rule zero, do not switch drivers) and put the verb list below the cut, so what
 * reached an agent was the conviction that this bridge is the right tool with no statement of
 * what it can do. The owner saw the result from the outside and named it exactly: «почему такое
 * чувство, что Клод вообще не знает о Бридже».
 *
 * So the map goes FIRST and the argument second. An agent that has read only the opening must
 * come away knowing the verbs; one that has read only the opening and the argument has learned
 * nothing it can act on. Anything added here pushes something below the cut — check what falls
 * off before adding, and keep the map under 2000 characters.
 *
 * THE MAP IS NOW FULL: thirty-three verbs fit, and the thirty-fourth falls outside whatever the
 * order. The one deliberately left below the line is `qa_gap`, which only files a note, while
 * everything a stuck run actually needs is above it. Adding another verb means choosing what to
 * drop, and that choice is made here rather than discovered later by a session that wonders why
 * nobody told it about something.
 *
 * AND THE COMMENT GOES OUTSIDE THE TEMPLATE LITERAL, which is why this one is here. Written
 * inside it, a four-line note is four hundred characters of the budget: it pushed qa_open_tab out
 * on 01.10.2026, and the only sign was a verb quietly missing from the map.
 */
/* WHAT A FRESH AGENT IS TOLD AT `initialize`, AND WHY IT IS SHORT (owner, 03.11.2026: «нужно, чтобы
 * всегда новая сессия знала о бридже»). The full manual below is 21 000 characters, and Claude Code
 * cuts server instructions at about 4 000: a fresh session got the map's first screen and lost the
 * ladder, the sign-in wait and everything after it — so it asked the person to write «done» instead
 * of waiting itself. This is the part that must arrive whole, most important first; the rest is one
 * call away in qa_help and in each verb's own description, which no client trims.
 * `scripts/test-instructions.mjs` holds the length and the facts it must carry. */
const INSTRUCTIONS = `Qiksy is your BROWSER for this session: it drives the Chrome the user already has open, with their
profile, logins and tabs. Never start Playwright, Puppeteer or a CDP browser instead: that one is
empty, without their logins. Only arbitrary JavaScript is missing here; pictures are not (qa_screenshot).

FIRST CALLS: qa_tabs (the tabs you may work in, each with a tabId), then qa_snapshot (the page as an
accessibility tree with refs).

THE MAP
- SEE, free: qa_snapshot · qa_read (full text) · qa_collect (a table: which nodes, which properties) ·
  qa_styles · qa_storage · qa_findings (console errors, failed requests with the server's body) ·
  qa_axe · qa_screenshot (the tab must be in front, so qa_focus_tab first).
- DO, behind the user's one-time "Agent control" switch: qa_click / qa_press { name } answer with
  what changed, so never snapshot to check · qa_fill_json { fields: { "Label": "value" }, advance:
  "Next" } fills a whole form step in ONE call, dropdowns, dates and trees included · qa_type ·
  qa_upload · qa_navigate · qa_open_tab { url } for a page that is not open yet.
- LATER: qa_wait_for (one condition) · qa_watch (what happens over the next seconds).

SEVERAL STEPS (a sign-up, a wizard, a console)? qa_follow { goal } first: every press then answers
with the next step, so keep going instead of stopping to report after each one.

A PERSON MUST SIGN IN (password, code, 2FA, captcha)? Tell them, then call qa_wait_for { urlContains:
"<the site>", timeoutMs: 300000 } YOURSELF in the same turn (while following: qa_follow {
waitForPerson: "<the line>" }). Never ask them to write "done". A reply with stillWaiting means:
call it again with the same arguments.

A CONTROL REFUSED A VALUE? The ladder: qa_probe { name } → raw: true → qa_pick_date / _time / _range
/ _path / _tags → a CSS selector. A control that "vanished" while the reply says \`modal\` sits behind
an open dialog: finish or close that layer first. A page that ignores synthetic clicks (isTrusted)
can still get a real one from the OS: qa_help { topic: "real mouse" }.

NO TAB, OR "not in the QA session"? Open it yourself with qa_open_tab { url }; do not ask the user.
Several browsers can be connected: each tab in qa_tabs names its \`browser\`, and its tabId routes
the call there.

NOT YOURS TO FIX, say it in one sentence and stop: "extension is not connected" (the bridge switch in
the popup is off) and a refusal for Agent control (the user's switch).

AT THE END: qa_done once, so the user hears the run is over. \`qiksySays\` in a reply is for the
HUMAN: relay it once, in their language. The leading \`qx\` line is decoration.

UNSURE WHICH VERB, OR NEED THE DETAILS (forms, recipes, mocks, dialogs, isolated logins, reports,
widgets)? Call qa_help, with a topic or without: it returns the full manual.`;

const MANUAL = `Qiksy drives the browser the user ALREADY has open: their profile, their logins, their tab. It
never launches one and never steals focus, so a backgrounded tab is worked in while they carry on.

THE MAP — every verb, so none is rediscovered by trial and error.
SEE (free, no consent): qa_snapshot (a11y tree with refs; geometry:true is every box in CSS pixels;
narrow with fields_only / roles / match / within) · qa_read (RENDERED text; snapshot names cap at
80) · qa_styles (computed style AND the design token) · qa_collect (a TABLE: which nodes, which
properties, once — \`value\` is what a control HOLDS) · qa_storage · qa_findings / qa_export /
qa_status (console, JS errors, failed requests WITH the server's error body) · qa_axe ·
qa_focus_walk · qa_width_law (what width the CODE DECLARES vs a mockup's number) ·
qa_odd_one_out (the one card of thirty unlike its twins; no mockup needed).
PHOTOGRAPH (free): qa_screenshot — the page, ONE element (ref/selector), or all of it (full:true).
Panel hidden, passwords and cards covered; the tab must be in FRONT, so qa_focus_tab first. Then
qa_shot_mark (boxes, arrows, captions) · qa_shot_crop · qa_shot_list · qa_shot_read ·
qa_failure_gallery (it CAUSES the empty list, the 500, the spinner and photographs each).
LATER, NOT NOW: qa_watch (mutations · network · console · announcements). A toast that comes and
goes is invisible to any snapshot. Watches expire by themselves.
DO (the one-time "Agent control" consent; a refusal is the user's to clear, so say it and
stop): qa_click / qa_press ANSWER with what changed, so never snapshot to check · qa_type ·
a whole form in ONE call — qa_fill_json { fields: { "Label": "value" }, advance: "Next" }, covering
dropdowns, calendars, cascaders, trees, tags and time · qa_upload · qa_navigate · qa_reload ·
qa_open_isolated · qa_mock (answer a request from a RULE; clear them after) · qa_dialogs · qa_report.
STUCK: qa_probe { name } names the widget and its verb · qa_open_tab { url } opens an address the
driving verbs refuse · qa_gap records what was missing.
A CANVAS APP (figma, miro, canva, google docs) WORKS: its tool buttons are ordinary markup, so
qa_click { name } presses them, and the canvas takes qa_drag_point despite isTrusted:false, which
those apps do not check. Only the KEYBOARD is swallowed — press the tool BUTTON, not its letter.

RULE ZERO — YOU ALREADY HAVE A BROWSER, AND IT IS THE RIGHT ONE. This bridge is the browser tool
for this session. Do not start, propose or switch to a second browser driver (Playwright,
Puppeteer, Selenium, a raw CDP client) because something here looked unfamiliar or refused once.
Another driver opens a DIFFERENT, EMPTY browser: the logins, cookies, SSO session and app state
the user is actually testing are not in it, so the run stops meaning what they asked for — and
they usually find out from the results, not from you. Exactly ONE thing is genuinely absent here:
EVAL (no arbitrary JavaScript; that is a Web Store requirement, which is why every verb names an
ELEMENT, never a program). PICTURES ARE NOT ON THAT LIST — qa_screenshot is above. If a task truly
needs eval, say so and let the user decide.
Everything else that looks impossible is a verb on the map or a rung on the ladder below.

ORDER OF PREFERENCE, AND IT IS NOT A TIE. Anything that happens in a browser starts here — every
time, including in a project where another browser driver is also configured. Hand the wheel over
only after this bridge has genuinely run out of road, and in this order: (1) name the missing
capability the task needs, out loud; (2) look at what the environment actually offers;
(3) say which tool you are switching to and why; (4) come back here for the rest of the run. A
control that refused, a widget you have not met before, a slow page, a background tab — none of
those is running out of road, and each has its own answer below.

WHEN A CONTROL REFUSES A VALUE — THE LADDER. Take it in order; three rungs cost less than one
paragraph about what the bridge cannot do, and rung 1 usually ends it:
  1. qa_probe { name } — what this widget IS and which verb drives it. One call, no guessing, and
     it is the only route into a control hand-rolled from <div>s (role generic, no name, no state).
  2. raw: true — write the value straight into the control's own text input (dates, times, range
     ends, tags, a creatable select). Measured: 0.30s against 26 through a calendar.
  3. the widget's own verb — qa_pick_date · qa_pick_time · qa_pick_range · qa_pick_path (cascader
     or tree) · qa_pick_tags. Each is ONE call and re-snapshots between its own steps.
  4. a CSS selector — every verb accepts one, and a portalled popup with no roles (Ant) is MEANT
     to be driven that way: the reply's widget verdict "portalled-invisible" is telling you so.
  5. qa_click by NAME, then read the \`widget\` verdict in the reply and act on THAT, not on a guess.
  6. is the tab in the background? Native fields fill there, but custom popovers only render in the
     foreground: qa_focus_tab, then retry the field.
A refusal is a rung, not a wall. Two refusals in a row on the SAME control mean you skipped rung 1.

THINGS AGENTS ASSUME ARE OUT OF REACH HERE, AND ARE NOT:
- Signing in through a real identity provider — Microsoft / Entra, Google, Okta, any SSO. It is the
  user's own browser, so they are usually signed in already; and a tab OPENED BY an attached tab
  joins the agent session automatically, which is exactly the provider redirect. Drive it like any
  other form. Only a 2FA prompt or a captcha is theirs, and then you stop and say so.
- Several accounts at once — qa_open_isolated gives each login its own cookie jar in the SAME
  browser, and qa_tabs hands you a tabId per session to read and drive them side by side.
- Files — qa_upload takes real paths from this machine (this process reads the bytes, so they never
  enter your context) and files[] does a whole step at once.
- Sizes, overlap and colour — qa_snapshot geometry:true is every node's box in CSS pixels, qa_styles
  is the computed style AND the design token a colour came from. No screenshot needed for either.
- Storage — qa_storage reads localStorage/sessionStorage, and writes them under Agent control.
- The keyboard route — qa_focus_walk walks the page Tab by Tab and reports what a keyboard user can
  never reach, plus suspected traps. qa_axe runs the real axe-core engine in the page for WCAG.
- Showing the user something — qa_spotlight outlines an element in their view, qa_focus_tab brings
  a tab in front of them. That is how a walkthrough lands where they are looking.

WHAT YOU CAN SEE (all free, none of it needs Agent control):
- qa_snapshot — the whole page as an accessibility tree with stable refs. geometry:true adds every
  node's box in CSS pixels, which is how you answer "this is cut off / these overlap / that tap
  target is 28px" without a screenshot. On a heavy app narrow it — fields_only, roles, match,
  within — instead of pulling 1200 nodes per step; filtered refs work like full-tree ones.
- qa_read — the RENDERED text of the page or one element. Use it whenever the answer is longer than
  a label: snapshot names cap at 80 characters, so a one-time code, a full error paragraph or a
  generated invoice number is invisible there.
- qa_styles — computed styles, the box, and the CSS custom properties in scope. "color:
  rgb(37,99,235)" says what is drawn; "--accent: #2563EB" says which TOKEN it came from, and only
  the second is a bug report. This is how you check a build against a design.
- qa_storage — the app's localStorage / sessionStorage: feature flags, cached state, usually the
  session token.
- qa_findings / qa_export / qa_status — what Qiksy itself observed: console and JS errors, failed
  requests WITH their server error bodies, a11y and markup defects, and speed/stability from the
  browser's own measurements (layout shift with the element that moved, slow interactions split
  into input delay / handler / paint, main-thread blocks with the script responsible).

WHAT YOU CAN DO (the one-time "Agent control" consent in the popup; a refusal
there is the user's to clear — report it in one sentence instead of working around it):
- qa_click / qa_press — and they ANSWER with what changed. After the page settles you get the
  diff: what appeared, disappeared, updated. Do not follow an action with a qa_snapshot just
  to find out whether it worked; \`changed: null\` means the page did not move, which is itself
  the answer.
- qa_type — one field of ANY kind. qa_type_many — a whole form, or one step of a wizard, in ONE
  call. Prefer refs over selectors in the batch: a form built from a repeated component gives
  several inputs the identical cssPath, and selectors would then pour every value into the
  first match.
- qa_upload — attach a file: \`path\` for one on the machine (THIS process reads it, so the bytes
  never enter your context) or \`fixture\` for a hostile one built in the page (see its schema).
- qa_storage with op set/remove/clear, qa_navigate, qa_reload (the tab as it stands, no URL to
  pass — it works even on a tab whose script an extension update has killed), qa_open_isolated,
  qa_close_tab.
- qa_mock — answer a request from a RULE instead of the server: a 500, an empty list, a malformed
  payload, a 30-second delay, a dropped connection. This is how you test the branch the backend
  will not produce on demand, and \`times\` is how you make the first call fail and the retry
  succeed. Rules belong to one tab, survive its reloads, and cover the page's own fetch/XHR in
  the top frame only — not the document, subresources, WebSocket or iframes. Mocked responses are
  marked \`(mocked)\` everywhere they are reported. CLEAR THEM when the check is done.
- qa_dialogs — what the page's OWN native dialogs do. Chrome's "Leave site? Changes you made may
  not be saved", confirm(), alert(), prompt() are drawn outside the document: NOTHING can click
  their buttons, not this bridge and not any script. What is reachable is the page's request for
  them — \`beforeunload:true\` stops the app from asking so the navigation proceeds, \`confirm\`
  decides what confirm() returns. One tab, and every answer is logged with the question, so never
  report that the app stopped asking. Clear it when the flow is through.
- qa_report — the session report. ALWAYS pass \`path\`: it is a self-contained HTML document with
  embedded screenshots, so you get a receipt instead of hundreds of kilobytes. With \`spec\` (the
  ticket's acceptance criteria + your verdict on each) it becomes a deliverable, not a log.

FILLING A FORM — ONE CALL PER STEP, NOT ONE PER FIELD. This is where agents lose the most time
here. qa_type is not a keystroke emulator, it is the extension's own fill engine, and it drives
EVERY control kind by name-and-value: native selects, checkboxes, radios, sliders, rich text, AND
the ones that look like they need clicking — Radix/shadcn, MUI, Ant and react-select dropdowns,
typeahead comboboxes, popup date and time pickers (it opens the popover, waits for the options,
picks the match and checks the trigger changed). READ THE REPLY, NOT THE ASK: \`asked\` is the value
you passed, \`selected\`/\`reads\` is what the control SHOWS afterwards, and \`ok:false\` means the
widget did not take it — a select whose row was pressed and did not commit says so now instead of
answering ok. A qa_type_many batch where half the entries are
dropdowns and dates is the normal use, not an edge case. When you already know the values, a wizard
step is ONE call:
  qa_fill_json { fields: { …the whole step… }, advance: "Next" }
      → fills, verifies, presses Next only if every entry landed, and rides the NEXT step's field
        names back in \`next.fields\` — so the step after this one needs no snapshot of yours either.
        \`advanced.ok\` is read off the click's DIFF, never off its ok: a Next that stays disabled
        until the step validates accepts a click and does nothing, and this says so instead of
        moving on. It is not pressed at all when an entry failed or a key matched nothing.
Three calls when you do not know the field names yet, or must pick one control among duplicates:
  qa_snapshot { fields_only: true }                       → the step's controls, not the app
  qa_type_many { fields: [ …every field of the step… ] }  → widgets and all, in order
  qa_click { name: "Next" }                               → its \`changed\` tells you it advanced
Prefer refs over selectors inside a batch: a form built from a repeated component gives several
inputs the identical cssPath, and selectors would pour every value into the first match. Uploads are
the one exception to "one call" — qa_upload takes files[] for the whole step.

CLICK THE ADVANCE CONTROL BY NAME, not by a ref you took before filling. A re-render can detach the
element (the extension refuses the ref, costing you a snapshot), and — the silent one — any new
snapshot RENUMBERS every ref, so e30 becomes another control and the click SUCCEEDS on the wrong
thing; that pressed "Back" instead of "Next" the first time it ran. A \`name\` is resolved inside the
bridge against a snapshot taken at that moment, so it is immune to both. Same for a field that only
appears once another settled (a region list loading after a country): wait, then fill it by name.
Opening a dropdown, snapshotting its options and clicking one is the slow path — three round trips
and two settle windows per field. Take it only for an entry that came back ok:false.

THE FAST ROUTE, AND IT IS MEASURED. Every composite in Ant, MUI and react-datepicker has its own
text input that accepts the value in the format it DISPLAYS — "06/11/2024", "14:30", the option
text, a new tag. \`raw: true\` (on qa_type, or per entry in qa_type_many) writes that string verbatim
through the native value setter instead of driving the popup: a date costs 0.30s against 26, a time
0.30 against 14, a range 0.60 against 35. Raw entries in a batch also go in ONE pass, because they
open nothing that could collide. Three things to know, because each one has burned a run:
  · It is for controls that PARSE text. A select that must CHOOSE a row is not one of them — add
    \`pick: true\` (write the text, then click the matching option) or leave raw off and let the
    engine drive it. \`open: true\` first if the list only filters while it is open.
  · Enter is the default commit key, and on a plain input inside a form that can hit the app's own
    "submit on Enter" handler. Pass \`commit: ""\` for anything that is just a text box.
  · Some controls only keep a typed value once focus LEAVES (tags fields, and anything an Angular
    form binds with updateOn:'blur'): \`blur: true\`.
qa_fill_json already decides this per field on your behalf, which is the other reason to prefer it.

ALREADY HOLDING THE DATA? qa_fill_json takes a plain { "Field label": "value" } object — the same
shape as the panel's own JSON editor and its ⚡Fill button — resolves the labels itself and fills
in ONE call, no snapshot and no refs on your side. Keys that matched nothing come back with the
page's real field names, so the next call fixes itself. Prefer qa_snapshot + qa_type_many when you
need to pick a specific control among duplicates; prefer this when you know the values.

THE BRIDGE TELLS YOU WHAT KIND OF WIDGET IT IS — never re-derive that by trial and error. Three
places carry it, all free:
  · qa_snapshot → \`componentLibraries\` + \`hints\` (which UI library draws this page and what that
    means for driving it) and \`widgets\` (the notable kinds present, each with its verb and fields).
    Read both before the first fill of a page.
  · qa_click / qa_press → \`widget\`, the verdict on what your click just opened, from the diff.
    "calendar-popup" → qa_pick_date. "option-list" → it is a select, pass a value instead of
    clicking. "tree-popup" → the CHECKBOX, via qa_pick_path. "modal" → snapshot \`within\` it.
    "portalled-invisible" — it opened and the tree gained NOTHING — is role-less markup in a portal
    (Ant): stop snapshotting for it and address its parts by CSS selector, which every verb accepts.
  · qa_probe { name } — for the ONE control that refused a value, especially one hand-rolled from
    <div>s. Judges by shape first, clicks only when it must, then Escapes.

THEN SAVE WHAT YOU LEARNED. qa_recipe_save writes the flow to a JSON file as field NAMES (refs die
with their snapshot, names do not); qa_recipe_apply replays it against the page as it is now — one
call per step, values overridable per run, dry_run:true to check it still fits. Call qa_recipe_list
once before a form-heavy task: if the second pass over a long form is not dramatically cheaper than
the first, the recipe is the thing you skipped.

FILE THEM, AND RUN THEM AS A SET. qa_recipe_save takes a project (which product or client this flow
belongs to — it becomes a folder) and tags (["smoke"]); qa_recipe_list filters by either. Host is not
enough on its own: staging and production are two hosts and one project, two products behind one
domain are one host and two projects. qa_suite_run then replays a GROUP — by recipes (names, in your
order), by project, or by tag — opening each flow at its own start URL and answering about the whole
set: "2 of 3 passed", and for the one that stopped, at which step and on which field. It deliberately
does NOT stop at the first failure, because a set is only worth running when you learn the state of
all of it. Start with dry_run:true — it resolves every step of every recipe, touches nothing, and is
the honest way to ask "do these still fit" before running them against real data.

WHAT IS GENUINELY NOT HERE: arbitrary JavaScript execution — a Web Store requirement, not an
oversight, and the reason every verb above is a closed vocabulary: you name an element, never a
program. Screenshots USED to be on this list and are not any more: qa_screenshot returns a real
picture of the page or of one element. It has one condition, and it is not a formality — the
browser photographs the window's ACTIVE tab, so a background tab cannot be photographed and the
extension refuses rather than quietly photographing whichever page is in front. Driving a
background tab is this product's whole point, so this is the one verb that needs the human to be
looking at what you are testing: qa_focus_tab first, or take the measurements instead. When a
task truly needs eval, say it is outside the bridge; never silently substitute another driver.

TABS: the agent session is a SET the human opts into — the popup's "Agent drives this tab"
switch, or right-click → "Qiksy — test this tab". Attached tabs stay in it while the user looks
elsewhere (so work continues in a background tab), and a tab opened BY an attached tab joins
automatically — that is how an identity-provider sign-in stays in the flow. qa_tabs lists the
session and a tabId targets one; tabs from qa_open_isolated are separate logins on the same site.
Empty set falls back to the active tab. If a tool answers out-of-scope, open the page yourself
with qa_open_tab { url }: it usually joins the session at once. Only when that answers inSession:
false, ask the human in one sentence to attach the tab, and never reach around the refusal.

A REAL MOUSE, WHEN A PAGE REFUSES A SYNTHETIC CLICK. Every click from this bridge carries
isTrusted: false, and a few pages check it and ignore the click without a word. Then press the same
point from the operating system, from your terminal, after asking the person to install the tool:
macOS \`brew install cliclick\` then \`cliclick c:X,Y\` (the terminal app needs Accessibility
permission); Windows needs nothing installed (PowerShell with user32 SetCursorPos + mouse_event, or
AutoHotkey's \`Click X, Y\`); Linux \`xdotool mousemove X Y click 1\`. Those are SCREEN coordinates:
the Chrome window's top-left plus the toolbar height plus the viewport point times the zoom. A real
click brings Chrome to the front, so say so first. qa_click_point's reply carries the exact commands
in \`realMouse\` whenever its events were synthetic.

SIGN-IN IS A WAIT, AND THE WAIT IS YOURS. When a site hands over to a password, a code from a phone,
a hardware key or a captcha, tell the person, then call qa_wait_for { urlContains: "<the site>",
timeoutMs: 300000 } in the same turn. It waits in slices and keeps the call alive, so five minutes
is real; a reply carrying stillWaiting means call it again with the same arguments. Asking the
person to write "done" when they have finished is the mistake this paragraph exists for.

A TASK OF SEVERAL STEPS IS FOLLOWED, NOT REPORTED STEP BY STEP. A sign-up, a wizard, creating an app
in a developer console: call qa_follow { goal: "<the whole task>" } first. Until qa_done, every
click, key, fill, upload and navigation on that tab answers with \`step\`: the page waited for until
it stops loading, where the wizard is, what changed since the last step (a button became active, an
error appeared), the fields left, the live buttons and \`yourMove\`. So no snapshot or read between
steps, and no stopping to report after each one: report when the task is done or a decision is
truly the person's. A step that asks the PERSON for something says \`personNeeded\`; tell them in one
line and call qa_follow { waitForPerson: "<that line, in their language>" }, which shows the line on
the page beside the field and returns by itself when the page moves on (up to 15 minutes).

Several agent windows share one browser automatically: whichever process owns the loopback port
relays for the rest, and a call that fails because the owner just closed is worth one retry.

Two decorative things, neither of them data: every successful result opens with a \`qx <face>\`
line, every so often with a quip after it (ignore both; never copy them into a finding, report or
commit message), and a result may
carry \`qiksySays\` — which is NOT for you. That one is Qiksy talking to the HUMAN, sometimes a
compliment, sometimes a jab about a long think or a control being clicked for the third time. Say
it to them once, at the top of your next message, in THEIR language, following the \`relay\` note
that rides with it: re-say it in that language rather than translating it word for word, and keep
the tone it names. It is rate-limited, so it will not become a tic. QIKSY_MCP_VOICE=nice softens
it, =off removes it.

SAY WHEN YOU HAVE FINISHED — qa_done, one call, at the end of the run. The person who set you off
is usually not watching: they are in another window, another screen, another room. That call makes
the mark on every driven tab they are NOT looking at pulse slowly, and plays a short sound, so the
end of the work reaches them where they actually are. It stops by itself the moment they look at
one of those tabs; there is nothing for them to dismiss.
It is the END, not a progress beat. A full stop after nothing happened is refused and says so, and
a second one within half a minute stays silent — both on purpose, because a signal that cries wolf
is one people switch off in a week. Call it once, when the work is actually over, and still write
what you did in your own words: this is a nudge towards the screen, never the report itself.

Two failures are NOT yours to fix, and each names its own cause: "extension is not connected"
means the MCP bridge toggle in the popup is off (or its token/port differ) — only the user can
turn it on. "Port … is held by a process that is not a Qiksy bridge" means something else owns
the port and the extension is fine. Report either plainly and stop; do not retry in a loop.`;

const server = new McpServer({ name: 'qiksy', version: VERSION }, { instructions: INSTRUCTIONS });

/* The SDK rejects a call whose arguments miss the schema with one line, «Required at value», before
   any tool code runs. An agent reads that as «this tool is broken» and wanders off: on 04.11.2026 one
   passed `text` to qa_type on the ChatGPT composer and went hunting through qa_tabs instead. Naming
   the keys it sent next to the keys the tool takes turns it into a one-retry fix. The hook is the
   SDK's own method; when a future SDK no longer has it, the plain message stays and nothing breaks. */
if (typeof server.validateToolInput === 'function') {
  const validate = server.validateToolInput.bind(server);
  server.validateToolInput = async (tool, args, toolName) => {
    try {
      return await validate(tool, args, toolName);
    } catch (e) {
      try {
        const schema = tool?.inputSchema;
        const shape = schema?.shape ?? schema?._def?.shape?.() ?? schema?._zod?.def?.shape ?? {};
        const takes = Object.keys(shape);
        const required = takes.filter((k) => typeof shape[k]?.isOptional === 'function' && !shape[k].isOptional());
        const sent = Object.keys(args && typeof args === 'object' ? args : {});
        const unknown = sent.filter((k) => !takes.includes(k));
        if (takes.length && e && typeof e.message === 'string') {
          e.message += ` — you sent {${sent.join(', ')}}${unknown.length ? `, and ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a parameter of ${toolName}` : ''}. `
            + `${toolName} takes {${takes.join(', ')}}${required.length ? `, required: ${required.join(', ')}` : ''}. Call it again with those names.`;
        }
      } catch { /* the hint is a courtesy; the original error still goes out */ }
      throw e;
    }
  };
}

/* EVERYTHING A TOOL'S REGISTRATION READS LIVES ABOVE THE FIRST registerTool. A const used by a
   tool registered earlier in the file is a ReferenceError at STARTUP — the process dies before it
   speaks, and the symptom downstream is «timeout on initialize», which reads like a broken bridge
   rather than a typo. Caught three times in one day (16.09.2026): tabIdArg, selectArg, DRIVE_NOTE. */
const DRIVE_NOTE =
  ' Requires the one-time “Agent control” confirmation in the panel; without it the extension answers consent-required and does nothing.';

const tabIdArg = z.number().int().optional().describe('Target tab (from qa_tabs); omit for the active tab');

/**
 * WHICH FRAME, and the reason this exists at all.
 *
 * «Read inside a cross-origin payment frame» is twenty-two of the twenty-six dead ends agents
 * have ever filed through qa_gap: by a wide margin the biggest hole this product had. Reaching
 * into such a frame FROM the page is impossible under the same-origin rule and always will be,
 * so arbitrary JavaScript would not have fixed it either. What fixes it is being inside: Qiksy
 * now runs in every frame and answers about its own document. Name the frame with this.
 */
const frameIdArg = z
  .number()
  .int()
  .optional()
  .describe('Which frame to ask, from qa_frames. Omit for the page itself. A payment form, an SSO step or an embedded widget usually lives in a frame of its own, and a cross-origin one can only be read from inside it.');

/**
 * ASKING A REPLY FOR THE FIELDS YOU ACTUALLY WANT.
 *
 * Owner, 16.09.2026, on making the bridge flexible: the flexible part that is free is this one.
 * Every big read here answers with everything it knows, which is right when you do not know what
 * you are looking for and wasteful on the call after that. `select` keeps the named paths, `omit`
 * drops them, and the reply says which was done — a trimmed answer that does not admit it is an
 * answer nobody can reason about an hour later.
 *
 * Paths only: `page.title`, `fields[].name`. No expressions, no code — the caller names a field
 * exactly as every other verb here names an element.
 */
const selectArg = z
  .array(z.string())
  .optional()
  .describe('Keep only these field paths, e.g. ["ok","fields[].name"]. Dots walk into objects, and a path through a list applies to every entry, keeping it a list. A path that matches nothing is reported back with the field names that ARE there.');
const omitArg = z
  .array(z.string())
  .optional()
  .describe('Drop these field paths and keep the rest — the cheap way to lose one huge field (["html"], ["steps"]) without listing everything you want.');

server.registerTool(
  'qa_collect',
  {
    title: 'Collect named properties of named nodes',
    description:
      'ASK FOR A TABLE INSTEAD OF A PAGE. Name WHICH nodes (a CSS selector, a role, a name fragment — any combination, scoped with `within`) ' +
      'and WHICH of their properties to take, and get back exactly that, once. ' +
      '«Every row in the list with its name and price», «every link in the nav and where it points», «all the inputs with what they currently hold» ' +
      'are one call here and a dozen with qa_snapshot plus qa_read. ' +
      'Take any of: text · value (what the control HOLDS, read the way the fill engine reads it) · name (accessible name) · role · tag · selector · href · state (disabled/required/invalid/expanded/checked/hidden) · geometry — ' +
      'plus attr:<name> for an attribute and style:<css-property> for a computed style. A property nobody can supply is named back rather than dropped, so a missing column is never mistaken for a missing feature. ' +
      'Read-only, and the vocabulary is closed: this is a different projection of the page, never a program the page runs.',
    inputSchema: {
      tabId: tabIdArg,
      nodes: z
        .object({
          selector: z.string().optional().describe('CSS selector the nodes must match'),
          role: z.string().optional().describe('ARIA role (or tag name) the nodes must have, e.g. "listitem", "link"'),
          nameContains: z.string().optional().describe('Keep only nodes whose accessible name or text contains this (case-insensitive)'),
          within: z.string().optional().describe('Scope the search to this container'),
          visibleOnly: z.boolean().optional().describe('Default true — hidden nodes are counted out and their number reported'),
        })
        .describe('Which nodes. At least one of selector / role / nameContains; collecting the whole page is what qa_snapshot is for.'),
      take: z
        .array(z.string())
        .optional()
        .describe('Which properties, e.g. ["name","value","state"] or ["text","attr:data-id","style:color"]. Default ["name","text"]. Alias: `properties`.'),
      /* THE NAME THE DESCRIPTION INVITES. This tool's own sentence is «which of their PROPERTIES
         to take», so an agent reasonably sends `properties` — and zod strips an unknown key
         silently, leaving the default ["name","text"]. The columns then look unsupported: a
         tester reported exactly that («properties were silently ignored», 21.09.2026) about a
         feature that works. A synonym costs one line; a silent default costs a session. */
      properties: z.array(z.string()).optional().describe('Same as `take`, for when that is the word that came to mind.'),
      limit: z.number().optional().describe('Cap the rows (max 300). A capped answer says so rather than looking complete.'),
      select: selectArg,
      omit: omitArg,
      frameId: frameIdArg,
    },
  },
  async ({ tabId, nodes, take, properties, limit, select, omit, frameId }) => {
    try {
      const want = take?.length ? take : properties?.length ? properties : take;
      return asText(project(await callExtension('qa_collect', { tabId, nodes, take: want, limit, frameId }, 25_000), { select, omit }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_steps',
  {
    title: 'What the PERSON just did with their own hands',
    description:
      'WHAT THEY DID, NOT WHAT YOU DID. Every other verb here reports your own actions or the state of the page; this one hands over the tester\'s OWN work — each field with what they put in it, each click with whether it moved the page on, each navigation, in order, with timestamps. ' +
      'Reach for it when they say «write this up», «make a ticket out of that», «turn what I just did into a test», or when they describe a bug they found by hand and you need the steps that led to it. Guessing those steps from the page in front of you is the thing this removes: you were not there, and they will not remember the order. ' +
      'IT IS EMPTY UNLESS THEY ARE RECORDING, and that is the design rather than a limitation: the tape exists only while the person has recording switched on in the panel, with a mark on screen while it runs. An empty answer tells you how to ask them to start one. ' +
      'PASSWORDS AND CARD NUMBERS NEVER APPEAR — a redacted field is written down by NAME, with its value replaced by a reference, at the moment it is recorded. ' +
      'Reading, so it is free and needs no consent: nothing is touched, nothing is driven. ' +
      'AND IT DOES NOT GRADE THEM. You know what they were trying to do only if they told you; a judgement without that is a guess in a confident voice, which is worse than silence.',
    inputSchema: {
      tabId: tabIdArg,
      limit: z.number().optional().describe('How many of the most recent actions to return (default 200, max 400)'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, limit, frameId }) => {
    try {
      return asText(await callExtension('qa_steps', { tabId, limit, frameId }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_watch',
  {
    title: 'Watch the page for a while',
    description:
      'THE ONE QUESTION THE OTHER VERBS CANNOT ANSWER: what happens over the next few seconds. ' +
      'Everything else here answers about NOW — a toast that appears and leaves, a request fired by a timer, a row that arrives late, ' +
      'a value a websocket rewrites are all invisible to a snapshot taken before or after them. Polling costs a call per look and still misses the gaps between looks. ' +
      'op:"start" begins a watch and returns its id; op:"read" hands back what it has buffered since the last read; op:"list" shows what is running; op:"stop" ends one early ("all" ends every one). ' +
      'Four things can be watched: "mutations" (the DOM, optionally scoped with `within`), "network" (requests as they start and finish), "console" (console output, JS errors, rejections), "announcements" (aria-live regions — what a screen reader would have said). ' +
      'EVERY WATCH EXPIRES BY ITSELF — `ttlMs` is capped at two minutes and there is no "until stopped". That is deliberate: a watch left running is silent, and the readings taken after it are the ones that go wrong. ' +
      'It observes and never acts, so it needs no consent beyond the bridge itself.',
    inputSchema: {
      op: z.enum(['start', 'read', 'stop', 'list']).default('start').describe('start · read · stop · list'),
      tabId: tabIdArg,
      what: z
        .enum(['mutations', 'network', 'console', 'announcements', 'shifts'])
        .optional()
        .describe('For "start": what to watch — THE FIELD IS `what`, not `watch` or `kind` (a session lost two calls to that). Five kinds: mutations · network · console · announcements · shifts. "shifts" is the one nothing else can answer — the browser reports every layout jolt WITH THE NODES that moved and where they moved from, so «the page jumped» stops being a complaint and becomes a named element. The vocabulary is closed on purpose: a watch names what to observe, never a program to run. Missing a kind? Record it with qa_gap.'),
      ttlMs: z.number().optional().describe('How long to watch, 1s–120s (default 20s). It stops on its own at the end whatever else happens.'),
      within: z.string().optional().describe('For "mutations": a CSS selector to watch inside, instead of the whole body — the difference between a readable answer and every repaint on the page'),
      match: z.string().optional().describe('Keep only events whose text matches this (case-insensitive pattern) — the cheapest way to make a noisy page answerable'),
      name: z.string().optional().describe('A label for this watch, so a list of four is readable'),
      id: z.string().optional().describe('For "read"/"stop": which watch (from "start"). "all" stops every watch.'),
      limit: z.number().optional().describe('For "read": how many events to return (default 50)'),
      drain: z.boolean().optional().describe('For "read": default true — events are handed over once. Pass false to peek without consuming, at the risk of counting the same event twice.'),
      select: selectArg,
      omit: omitArg,
    },
  },
  async ({ op, tabId, what, ttlMs, within, match, name, id, limit, drain, select, omit }) => {
    try {
      const verb = op === 'read' ? 'qa_watch_read' : op === 'stop' ? 'qa_watch_stop' : op === 'list' ? 'qa_watch_list' : 'qa_watch_start';
      /* `name` rides along on read and stop too. It is offered on `start`, it is what `list`
         shows, and it is therefore what a caller holds — but until 21.09.2026 this line dropped
         it for every op but start, so `qa_watch { op:"read", name:"checkout" }` was answered
         «no watch called (none given)» about a call that had named one. The extension resolves
         id first and falls back to the name. */
      const args = op === 'start' ? { what, ttlMs, within, match, name } : op === 'list' ? {} : { id, name, limit, drain };
      return asText(project(await callExtension(verb, { tabId, ...args }, 20_000), { select, omit }));
    } catch (e) {
      return asError(e);
    }
  },
);

/* Two page states, kept per tab between the «before» and the «after». In memory on purpose: a
   comparison that outlived the session would invite comparing this morning's page with yesterday's
   and calling the difference a regression. */
const heldStates = new Map();

server.registerTool(
  'qa_diff',
  {
    title: 'What changed on this page — by control, not by pixel',
    description:
      'PIXEL DIFFS SAY «23 417 PIXELS DIFFER» AND LEAVE YOU TO FIND OUT WHY. This one says «the Submit button moved 8px down, its padding went 8 → 12, and it went disabled» — a sentence with a cause in it. ' +
      'op:"before" takes the state of the page as it is now; do the thing (a fix, a deploy, a click, a different branch); op:"after" compares. Reported: what appeared, what disappeared, and what moved, resized, changed state or changed a style that people argue about. ' +
      'Text content is deliberately NOT compared — a name, a total or a timestamp differs between two healthy runs, and reporting those is exactly the noise that gets visual diffing switched off everywhere else. Movements under 2px are the browser rounding a layout. ' +
      'When the two states cannot be matched at all — a virtualised list, a re-keyed render — it SAYS so instead of reporting three hundred false appearances.',
    inputSchema: {
      tabId: tabIdArg,
      op: z.enum(['before', 'after', 'drop']).describe('"before" remembers this page; "after" compares against it; "drop" forgets it'),
      draw: z.string().optional().describe('For "after": write a PNG here with every changed control outlined and labelled with what changed'),
      select: selectArg,
      omit: omitArg,
    },
  },
  async ({ tabId, op, draw, select, omit }, extra) => {
    const bar = loader(extra, op === 'after' ? 'comparing the page' : 'remembering the page');
    try {
      const key = String(tabId ?? 'active');
      if (op === 'drop') {
        heldStates.delete(key);
        return asText({ ok: true, dropped: true });
      }
      const state = await callExtension('qa_page_state', { tabId }, 30_000);
      if (!state || state.ok === false) return asText(state);
      if (op === 'before') {
        heldStates.set(key, state);
        return asText({
          ok: true,
          remembered: state.nodes?.length ?? 0,
          url: state.url,
          note: 'Held for this session only. Do the thing, then call op:"after" — and if the page navigates to a different URL in between, the comparison will say so rather than pretending.',
        });
      }
      const before = heldStates.get(key);
      if (!before) return asText({ ok: false, error: 'nothing to compare against — call op:"before" first, then do the thing' });

      const { diffStates } = await import('./diff.mjs');
      const d = diffStates(before, state);
      /* A COMPARISON ACROSS TWO DIFFERENT PAGES IS NOT A REGRESSION, and it is the easiest mistake
         to make with a verb like this. */
      const movedOn = before.url !== state.url ? `the page was ${before.url} when «before» was taken and is ${state.url} now — this is a comparison of two different pages` : null;
      let drawnPath = null;
      if (draw && d.changed.length) {
        const marks = d.changed.slice(0, 40).map((c) => ({ kind: 'box', selector: c.selector, label: c.changes[0], colour: 'warn' }));
        const shot = await callExtension('qa_annotate', { tabId, marks }, 150_000).catch(() => null);
        if (shot?.ok && typeof shot.dataUri === 'string') {
          const { writeFileSync } = await import('node:fs');
          const { resolve } = await import('node:path');
          drawnPath = resolve(draw);
          writeFileSync(drawnPath, Buffer.from(shot.dataUri.slice(shot.dataUri.indexOf(',') + 1), 'base64'));
        }
      }
      return asText(
        project(
          {
            ...d,
            ...(movedOn ? { warning: movedOn } : {}),
            ...(drawnPath ? { path: drawnPath } : {}),
            before: { url: before.url, at: before.at, controls: before.nodes.length },
            after: { url: state.url, at: state.at, controls: state.nodes.length },
          },
          { select, omit },
        ),
      );
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

/**
 * THE SHELF — five verbs over the pictures the extension is holding.
 *
 * The point of all five is one fact: MARKS ARE DATA THAT LIVE BESIDE THE CLEAN PICTURE. So the
 * tester marks a shot by hand and the agent can READ those marks; the agent adds its own and the
 * tester can drag them. Neither has to describe a picture to the other in words, which is what
 * every screenshot tool forces today.
 *
 * A shot is addressed by NAME («checkout»), never by «the last one»: there is no implicit current
 * shot, so marking the wrong picture is not a mistake that can be made by default.
 */
server.registerTool(
  'qa_open_tab',
  {
    title: 'Open a page in the browser the bridge is connected to',
    description:
      'OPEN AN ADDRESS THE BRIDGE WILL NOT NAVIGATE TO. The driving verbs stay inside the site under test on purpose — that refusal is what stops an agent from walking somebody\'s browser onto an arbitrary domain, and it must not be worked around. This is the sanctioned way through it: a NEW tab, beside the ones already open, losing nothing. ' +
      'It goes into the RIGHT BROWSER by construction, not by care: the machine has several Chrome profiles, the extension lives in exactly one, and a tab opened into any other is invisible here — so this finds the window holding a tab the bridge can already see and inserts the new one beside it. Never start a browser yourself instead; a second browser is a DIFFERENT, EMPTY browser with none of the person\'s logins, and everything measured in it stops being the run that was asked for. ' +
      'Read the answer rather than assuming: `inSession: true` means the tab is yours to drive and carries the tabId to pass to the other verbs; `inSession: false` means it is open and the person has to switch «Agent drives this tab» on for it, because once any tab has been switched on the session is that explicit set. macOS for now; elsewhere it says so and names what to ask for. Free.',
    inputSchema: {
      url: z.string().describe('The full http(s) address to open. Query strings are fine — nothing here goes through a shell.'),
    },
  },
  async ({ url }, extra) => {
    const bar = loader(extra, 'opening a tab');
    try {
      const tabsNow = async () => {
        const r = await callExtension('qa_tabs', {}, 15_000).catch(() => null);
        return Array.isArray(r?.tabs) ? r.tabs : [];
      };
      return asText(await openTabHere({ url, tabsNow }));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_width_law',
  {
    title: 'What width the code DECLARES, not what it measured',
    description:
      'THE LAW, NOT THE READING. «The container is 1360 wide» is a fact about the window it was measured in, true here and false one drag of the mouse later — which is why comparing a layout to a mockup by measuring has never worked. This reads what the CODE DECLARED instead: how many width ceilings exist on the layout spine, which element sets the tightest one, and what content band follows from that at any window. A declaration does not move when the window does, so it can be compared with a mockup and argued about. ' +
      'Pass `figmaWidth` (one number off the design, e.g. 1400) and it prints the two declarations side by side plus what follows — «the mockup declares one ceiling at 1400; the code declares none at all; at 1920 the band is 1840, which is 440 wider». It NEVER says which of the two is right: that is the human\'s call, and an instrument that guesses it is one nobody trusts twice. ' +
      'VALUES THAT MOVE WITH THE WINDOW ARE REFUSED ON PURPOSE. clamp(), vw and percentages declare no single law, so they go to a `notMeasured` list with the reason instead of being resolved at the current window and printed as if they were fixed — that number would be right on this screen and wrong on the next, and indistinguishable from a real finding. Narrow boxes (a sidebar, a card) are not judged either: they are narrow by design. ' +
      'Read-only and free. Read `notMeasured` FIRST — a clean page and an unexamined one look identical without it.',
    inputSchema: {
      tabId: tabIdArg,
      within: z.string().optional().describe('Scope to this container (a CSS selector). Omit for the whole page, which is usually what you want — the spine starts at <body>.'),
      figmaWidth: z.number().optional().describe('The mockup\'s own declared content width, one number. With it you get the comparison; without it you still get what the code declares.'),
    },
  },
  async ({ tabId, within, figmaWidth }, extra) => {
    const bar = loader(extra, 'reading the width law');
    try {
      /* Everything this needs is ONE qa_collect: the spine is rebuilt in this process from the
         cssPath each row carries, so there is no second round trip and no walking the page. */
      const rows = await callExtension(
        'qa_collect',
        {
          tabId,
          nodes: { selector: within ? `${within}, ${within} *` : 'body, body *', visibleOnly: true },
          take: ['selector', 'geometry', 'style:max-width', 'style:width', 'style:padding-left', 'style:padding-right', 'style:margin-left', 'style:margin-right', 'style:box-sizing'],
          limit: 300,
        },
        30_000,
      );
      const list = Array.isArray(rows?.rows) ? rows.rows : Array.isArray(rows?.nodes) ? rows.nodes : Array.isArray(rows) ? rows : [];
      /* The viewport is the page's own, never assumed: the band arithmetic is anchored to it and
         a guessed width would make every projection quietly wrong. */
      const viewport = Number(rows?.viewport?.width ?? rows?.viewportWidth ?? list[0]?.geometry?.width) || null;
      if (!viewport) {
        return asText({ ok: false, error: 'no-viewport', note: 'The page did not report a width to anchor the arithmetic to. Reload the tab and call again.' });
      }
      return asText(widthLaw({ rows: list, viewport, figmaWidth: Number.isFinite(figmaWidth) ? figmaWidth : null }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_odd_one_out',
  {
    title: 'The element that is not like its own twins',
    description:
      'ONE OF THIRTY IS NOT LIKE THE OTHER TWENTY-NINE. No mockup, no Figma, no setup, no alignment: every element is compared ONLY with its own siblings, read in one instant, so nothing here depends on the window or on matching a design layer to a DOM node — the comparison the market cannot do is the one this skips entirely. It finds the card whose padding is 12 where twenty-nine have 16, the one gap of 14 in a row of 16s, the heading left at a different line-height. ' +
      'FOUR SILENCERS, and each exists because without it the verb produces findings on a HEALTHY page, which is how a checker teaches its reader to ignore it: a crowd of fewer than three is not judged; values with no dominant majority mean these are different elements rather than twins with a defect; more than two differing means a deliberate second variant; and an element the page itself marks as being in another state (`aria-current`, `aria-selected`, `disabled`, a class like `is-active`) is not comparable with its siblings on appearance. That last one came from a live run that reported the SELECTED TAB as a defect — twice. ' +
      '`margin` and `width` are deliberately not judged: the first and last member of a list legitimately carry a different margin, and content drives width. The SPACE between members is measured instead, which carries the same information without the trap. ' +
      'Read `notJudged` as well as `findings`: a family that was silenced is NOT a family that passed, and every silence names its reason. Read-only and free.',
    inputSchema: {
      tabId: tabIdArg,
      within: z.string().optional().describe('Scope to this container (a CSS selector). Omit for the whole page.'),
      selector: z.string().optional().describe('Which nodes to group into families. Default: the usual repeating kinds (li, tr, article, section, card-ish and button).'),
    },
  },
  async ({ tabId, within, selector }, extra) => {
    const bar = loader(extra, 'looking for the odd one out');
    try {
      const rows = await callExtension(
        'qa_collect',
        {
          tabId,
          nodes: { selector: selector || 'li, tr, article, section, button, [class*=card], [class*=item], [class*=row]', within, visibleOnly: true },
          take: [
            'selector', 'geometry', 'state', 'attr:class',
            'attr:aria-current', 'attr:aria-selected', 'attr:aria-pressed', 'attr:aria-expanded', 'attr:aria-checked', 'attr:data-state',
            'style:padding-top', 'style:padding-right', 'style:padding-bottom', 'style:padding-left',
            'style:border-radius', 'style:font-size', 'style:line-height', 'style:border-top-width',
            'style:color', 'style:background-color', 'style:font-weight', 'style:font-family', 'style:border-style',
          ],
          limit: 300,
        },
        30_000,
      );
      const list = Array.isArray(rows?.nodes) ? rows.nodes : Array.isArray(rows?.rows) ? rows.rows : Array.isArray(rows) ? rows : [];
      /* qa_collect returns the styles as flat `style:<prop>` keys on the row; the judge wants them
         under `style`, and the state attributes stay where they are. */
      const shaped = list.map((r) => {
        const style = {};
        for (const [k, v] of Object.entries(r)) if (k.startsWith('style:')) style[k.slice(6)] = v;
        return { ...r, style };
      });
      return asText(oddOnes(shaped));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_shot_list',
  {
    title: 'What pictures are on the shelf',
    description:
      'EVERY SHOT THE PANEL IS HOLDING, by name, with its size, its address, how many marks it carries and whether it is cropped. ' +
      'Taking a picture puts it on the shelf by itself, so this is also the answer to «what did the tester just capture». ' +
      'Names come from the path («checkout», «checkout-2»), because a person can hold those in their head and a timestamp they cannot. Read-only.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }, extra) => {
    const bar = loader(extra, 'reading the shelf');
    try {
      return asText(await callExtension('qa_shot_list', { tabId }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_shot_read',
  {
    title: 'What is drawn on a picture, as data',
    description:
      'THE MARKS, NOT THE PIXELS. Returns every mark on the named shot — kind, position, colour, caption — plus its crop rectangle and its true size. ' +
      'This is how you find out what a PERSON drew: they marked the broken total with an arrow and typed a word beside it, and that word is readable here rather than being an image somebody has to look at. ' +
      'It deliberately does NOT return the picture: a full-page shot is megabytes of base64 through a channel that copies every byte, and the question was what is on it. Use qa_screenshot when pixels are what you need.',
    inputSchema: { tabId: tabIdArg, shot: z.string().describe('The name from qa_shot_list') },
  },
  async ({ tabId, shot }, extra) => {
    const bar = loader(extra, 'reading the marks');
    try {
      return asText(await callExtension('qa_shot_read', { tabId, shot }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_shot_mark',
  {
    title: 'Draw on a picture the tester can then edit',
    description:
      'ADD MARKS TO A SHOT ON THE SHELF. They are stored beside the clean image, never burned into it, so the tester can move them, resize them and delete them afterwards — and so you can read them back later. ' +
      'Coordinates are in IMAGE pixels; qa_screenshot returns a map of the page in exactly those pixels, so a box from the map can be passed straight through. ' +
      'Shapes: `box` round a region, `arrow` from one point to another, `text` for a caption with its own words, `blur` for a pane that makes what is under it unreadable. Weight is `k`; colour is one of the five the panel offers. ' +
      'A caption carries an optional `to` — the point it is ABOUT — and a leader line is then drawn from the plate to that point, in both the editor and the exported file. Give a box a caption with `to` set to the middle of that box and you get the callout a person would draw by hand; the tester can then drag the words anywhere and the line follows. ' +
      'A `blur` pane hides an address, a customer name or a staging token. It is applied when the picture is EXPORTED, copied or built into a report — the clean shot stays clean on the shelf, which is what lets the pane be moved and removed afterwards. ' +
      'Adds by default; pass `replace: true` to put your marks in place of everything on the picture — which is the destructive one, and it is opt-in for that reason. ' +
      'The reply is the STATE — how many marks the picture now carries and all of them in full — rather than the word «done».',
    inputSchema: {
      tabId: tabIdArg,
      shot: z.string().describe('The name from qa_shot_list'),
      replace: z.boolean().optional().describe('Replace every existing mark instead of adding to them'),
      marks: z
        .array(
          z.union([
            z.object({
              t: z.literal('box'),
              x: z.number(), y: z.number(), w: z.number(), h: z.number(),
              c: z.string().describe('Colour: #c05d3f terracotta · #e08b2e ochre · #35935f green · #1a9aa8 teal · #161b26 near-black'),
              k: z.number().optional().describe('Stroke weight, 1–40'),
            }),
            z.object({
              t: z.literal('arrow'),
              x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
              c: z.string(), k: z.number().optional(),
            }),
            z.object({
              t: z.literal('text'),
              x: z.number(), y: z.number(),
              s: z.string().describe('The caption itself'),
              c: z.string(), k: z.number().optional().describe('Type size, 8–96'),
              to: z
                .object({ x: z.number(), y: z.number() })
                .optional()
                .describe('The point this caption is about — a leader line is drawn from the plate to it, and it follows the words if the tester moves them'),
            }),
            z.object({
              t: z.literal('blur'),
              x: z.number(), y: z.number(), w: z.number(), h: z.number(),
              k: z.number().optional().describe('How hard it hides, 4–60 (default 14). No colour: a pane is not a remark about the page, it is a piece of the page taken away.'),
            }),
          ]),
        )
        .describe('Up to 60. More than that covers the picture instead of marking it.'),
    },
  },
  async ({ tabId, shot, marks, replace }, extra) => {
    const bar = loader(extra, 'marking the shot');
    try {
      return asText(await callExtension('qa_shot_mark', { tabId, shot, marks, replace }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_shot_crop',
  {
    title: 'Keep only the part of the picture that matters',
    description:
      'SET OR CLEAR THE REGION a shot exports. The crop is a rectangle remembered beside the marks, NOT applied to the bitmap — so the edge can be pulled back out afterwards, by you or by the tester, and «a bit more on the left» never means «take the screenshot again». ' +
      'Pixels are image pixels, the same ones qa_screenshot maps and qa_shot_mark draws in. Pass no rectangle to go back to the whole picture. ' +
      'This is the difference between a screenshot of a page and evidence about one thing: a reader who is handed eight thousand pixels and told «it is visible here» cannot see it.',
    inputSchema: {
      tabId: tabIdArg,
      shot: z.string().describe('The name from qa_shot_list'),
      crop: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe('In image pixels. Omit to clear the crop and export the whole picture again.'),
    },
  },
  async ({ tabId, shot, crop }, extra) => {
    const bar = loader(extra, 'cropping the shot');
    try {
      return asText(await callExtension('qa_shot_crop', { tabId, shot, crop }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_shot_drop',
  {
    title: 'Take a picture off the shelf',
    description:
      'REMOVE ONE SHOT, with its marks and its stored image. The shelf holds twenty and drops the oldest by itself, so this is for the ones you know are finished with — a shelf full of half-remembered pictures is the state where nobody can find the one that mattered. The reply names what is left.',
    inputSchema: { tabId: tabIdArg, shot: z.string().describe('The name from qa_shot_list') },
  },
  async ({ tabId, shot }, extra) => {
    const bar = loader(extra, 'clearing a shot');
    try {
      return asText(await callExtension('qa_shot_drop', { tabId, shot }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

/**
 * THE FUNNEL — the bridge asking whether to write this up, once, at the moment it makes sense.
 *
 * Asked for by the owner (17.09.2026): «после того как бридж закончил аудит, нужно чтобы он
 * спрашивал, нужно делать отчёт или нет». Three things decide its shape, and all three are about
 * not becoming the thing people switch off:
 *
 *   IT RIDES A REAL EVENT, never a timer: an audit that FOUND something is the one moment where
 *   «write this up?» is a question rather than an interruption.
 *   IT ASKS TWICE AND THEN STOPS. A funnel that keeps asking is a funnel that gets ignored, and an
 *   ignored prompt teaches people to skim every other line we write.
 *   IT CANNOT BE THE THING THAT FORCES IT. We cannot make an agent relay a question, and pretending
 *   otherwise would be a promise the mechanism cannot keep. What it CAN do is make the next call
 *   obvious — the invitation carries the verb, already aimed — and make the report itself refuse
 *   to be built out of nothing. The hard part of the funnel lives in the refusals, not here.
 */
const reportFunnel = new Map();
function nudgeReport(r) {
  try {
    if (!r || typeof r !== 'object') return r;
    const found = Array.isArray(r.findings) ? r.findings.length : Number(r.found ?? r.count ?? 0);
    if (!found) return r;
    const host = String(r.url || r.page?.url || 'this page').replace(/^https?:\/\//, '').split('/')[0];
    const seen = reportFunnel.get(host) ?? { asked: 0, built: false };
    if (seen.built || seen.asked >= 2) return r;
    reportFunnel.set(host, { ...seen, asked: seen.asked + 1 });
    return {
      ...r,
      next: 'qa_screenshot { full: true } → qa_shot_mark → qa_report_build — the shot gets a name, the marks prove the finding, and the document refuses to be built without one.',
      forTheHuman:
        `Found ${found} thing${found === 1 ? '' : 's'} here. Want this written up as a report — one HTML file with the marked pictures inside, printable to PDF? Say so and I will build it. If the expected behaviour matters, tell me what it was: nothing here knows your requirements, and I will not invent them.`,
    };
  } catch {
    return r;
  }
}

/**
 * ONE DESCRIPTION OF A BLOCK, worn by every verb that takes one.
 *
 * `qa_report_build` assembles a whole document in one call; the draft verbs put the same blocks in
 * one at a time. Two copies of this union would drift the day one of them gained a field, and the
 * drift would show up as an agent's perfectly reasonable block being refused by the other verb.
 */
const REPORT_BLOCK = z.union([
  z.object({ block: z.literal('title'), text: z.string(), subtitle: z.string().optional() }),
  z.object({ block: z.literal('summary'), text: z.string().describe('One paragraph of plain words: what this document is about.') }),
  z.object({ block: z.literal('section'), text: z.string().describe('A heading, so a document longer than one thought has a shape'), note: z.string().optional() }),
  z.object({ block: z.literal('shot'), shot: z.string().describe('A name from qa_shot_list'), caption: z.string().optional() }),
  z.object({
    block: z.literal('finding'),
    severity: z.enum(['error', 'warn', 'info']).optional(),
    title: z.string().describe('The line somebody will copy into a ticket'),
    shot: z.string().optional().describe('The picture that proves THIS finding'),
    what: z.string().optional().describe('What actually happened'),
    expected: z.string().optional().describe('Only if a PERSON said so. No verb here knows the requirements.'),
    where: z.string().optional().describe('Selector or place'),
  }),
  z.object({
    block: z.literal('point'),
    tone: z.enum(['good', 'info', 'warn', 'bad']).optional().describe('good = it holds · info = a neutral observation · warn · bad. Default info.'),
    title: z.string().describe('The line somebody will quote'),
    shot: z.string().optional().describe('The picture that shows it'),
    what: z.string().optional().describe('What is the case'),
    where: z.string().optional().describe('Selector or place'),
  }),
  z.object({ block: z.literal('steps'), items: z.array(z.string()).describe('How to reproduce, short and with real values') }),
  z.object({ block: z.literal('facts'), pairs: z.array(z.object({ name: z.string(), value: z.string() })) }),
  z.object({ block: z.literal('note'), text: z.string(), tone: z.enum(['info', 'warn']).optional() }),
]);

server.registerTool(
  'qa_report_build',
  {
    title: 'Assemble a report by naming blocks — no template, no markup',
    description:
      'A SELF-CONTAINED HTML REPORT, built by ENUMERATION. You pass an ordered list of blocks with plain text fields; every scrap of markup, styling, escaping and picture-embedding happens on our side. No template is accepted and none can be — a verb here names an element or a value from a closed list, never a program. ' +
      'IT IS NOT ONLY A BUG REPORT, and the block set is what makes that true. `finding` says something is wrong; `point` makes the same card with a tone of good · info · warn · bad and NO «expected» line, which is how a check that passed, a design note or a description of how a screen behaves gets written down; `section` gives a long document headings. A sign-off, a walkthrough for a developer, a page of observations for a designer and a defect list are the same paper here. ' +
      'Pictures come from the shelf BY NAME and are flattened on the way in: the marks and the crop have been data up to that moment precisely so they could still be changed. ' +
      'Print the result to get a PDF — the stylesheet is written for paper as well as for screen. ' +
      'PASS `save` TO KEEP IT IN THE EXTENSION: the panel’s Shots tab then lists it under Reports with Open and Save, and qa_reports / qa_report_get read it back by name later. Without it the document exists only in this reply and in whatever file you write. ' +
      'IT REFUSES, and the refusals are the point. No blocks, a block naming a shot that is not on the shelf, or NOT ONE PICTURE anywhere in the document — each fails the whole build rather than quietly dropping a block: a page of assertions about an application with nothing showing any of it is the artefact this product exists to replace. ' +
      'EXPECTED IS NEVER INVENTED. Leave `expected` out and the field says «not stated — a person fills this in». Filling it from your own guess turns a report into a hypothesis wearing the clothes of a protocol. ' +
      'The reply is an INVENTORY — blocks, pictures embedded, findings, points, bytes, warnings — not the word «done».',
    inputSchema: {
      tabId: tabIdArg,
      out: z.string().optional().describe('Write the HTML here. WITHOUT IT THE REPORT IS FILED UNDER THE PROJECT you are working in — `qiksy-reports/<date>-<subject>.html` next to the code it is about, because a report belongs with the thing it describes rather than in a download folder. The reply says the path either way. Set QIKSY_REPORTS_DIR to file them elsewhere, or to `off` to write nothing unless asked.'),
      save: z
        .union([z.boolean(), z.string()])
        .optional()
        .describe('Keep it in the extension so a person can find it later in the panel. `true` names it after the page; a STRING names it yourself, and building again under the same name REPLACES that document rather than leaving a stale twin above it.'),
      kind: z
        .enum(['issues', 'verified', 'notes'])
        .optional()
        .describe('What this document IS, for the list in the panel: `issues` (things that are wrong — the default), `verified` (checked and it holds), `notes` (a description, no verdict). It changes no layout — the blocks do that.'),
      blocks: z
        .array(REPORT_BLOCK)
        .describe('In document order. The conditions of the run — active mocks, suppressed dialogs — are added automatically and cannot be omitted by the caller.'),
    },
  },
  async ({ tabId, blocks, out, save, kind }, extra) => {
    const bar = loader(extra, 'assembling the report');
    try {
      const r = await callExtension('qa_report_build', { tabId, blocks, save, kind }, 120_000);
      if (!r || r.ok === false || typeof r.html !== 'string') return asText(r);
      const kept = r.saved
        ? { saved: r.saved, savedNote: 'kept in the extension: the panel’s Shots tab lists it under Reports, and qa_reports reads it back by that name' }
        : {};
      /* Named path wins; otherwise the project's own reports folder — see reportsDir(). */
      const home = out ? null : whereReportsGo();
      const target = out ? resolve(out) : (home ? join(home, reportFileName(blocks, kind)) : null);
      if (target) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, r.html, 'utf8');
        /* The funnel's question has been answered by the act itself; it must not ask again. */
        for (const [host, v] of reportFunnel) reportFunnel.set(host, { ...v, built: true });
        return asText({
          ok: true, path: target, blocks: r.blocks, shotsEmbedded: r.shotsEmbedded, findings: r.findings,
          points: r.points, bytes: r.bytes, warnings: r.warnings, ...kept,
          ...(out ? {} : { filedIn: home, filedNote: 'No path was given, so it was filed under the project you are working in. Name `out` to put it somewhere else, or set QIKSY_REPORTS_DIR (or `off`) to change where this goes.' }),
          note: 'Open it and print to PDF; the structure is the same on paper.',
        });
      }
      return asText({ ok: true, blocks: r.blocks, shotsEmbedded: r.shotsEmbedded, findings: r.findings, points: r.points, bytes: r.bytes, warnings: r.warnings, ...kept, html: r.html });
    } finally {
      bar.stop();
    }
  },
);

/**
 * THE REPORTS THE EXTENSION IS HOLDING.
 *
 * Three verbs and no fourth: list them, take one back, drop one. Writing is `qa_report_build`'s
 * `save` — a store with two ways in is a store whose two ways drift.
 *
 * The point of them is the hour AFTER the report was written. Until now a document left the
 * extension the moment it was built and Qiksy knew nothing about it afterwards, so «send me the
 * one from this morning» had no answer but «look in your Downloads». Now the panel lists it and
 * so does this, under the same name.
 */
/**
 * THE DRAFT — THE PILE THE PERSON IS ALREADY FILLING.
 *
 * `qa_report_build` takes a whole document in one call, worked out in advance. That is the wrong
 * shape for how a report is actually written: the thoughts arrive one at a time, an hour apart,
 * while somebody is clicking through an application. And it is the wrong shape for working
 * TOGETHER — which is the point of this product. The panel keeps a draft the tester flicks things
 * into; these verbs are the same draft, the same store, the same mutators. So: they take a
 * screenshot and add it, you write the finding underneath it, either of you rewrites a line, and
 * whoever finishes builds the document.
 *
 * Lines are addressed by POSITION, which is what qa_draft returns and what the panel shows. There
 * is no id, because an id would be a second vocabulary for the same list.
 */
server.registerTool(
  'qa_draft',
  {
    title: 'The report being written right now — its lines, in order',
    description:
      'THE DRAFT REPORT AS IT STANDS: its title, what kind of document it is, and every line in order with its POSITION — which is what every other draft verb takes. ' +
      'It is the SAME draft the person is filling in the panel’s Report tab. A screenshot they flicked in this morning is here; a line you add appears on their screen. That is the whole point: a report written while the work happens, by both hands, instead of assembled from memory afterwards. ' +
      'Read-only, and free. Build it with qa_draft_build.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_draft', { tabId }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_add',
  {
    title: 'Put a line into the report being written',
    description:
      'ADD ONE LINE, OR SEVERAL, to the end of the draft — the same block shapes qa_report_build takes, so nothing has to be translated on the way out. ' +
      'The usual rhythm is one at a time, as things are noticed: a `finding` the moment it reproduces, a `shot` naming a picture from qa_shot_list, a `note` for the thing that is not a defect but matters. ' +
      'A picture is held BY NAME, never by pixels — so re-cropping or re-marking it later changes the report too. ' +
      'It answers with how many lines ACTUALLY went in: at the cap the draft keeps what fits, and saying «added 8» while 3 landed is how a document loses its middle.',
    inputSchema: {
      tabId: tabIdArg,
      block: REPORT_BLOCK.optional().describe('One line.'),
      blocks: z.array(REPORT_BLOCK).optional().describe('Several lines, in document order.'),
    },
  },
  async ({ tabId, block, blocks }) => {
    try {
      return asText(await callExtension('qa_draft_add', { tabId, block, blocks }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_edit',
  {
    title: 'Rewrite a line of the report being written',
    description:
      'REPLACE THE LINE AT `at` with a new block. The position comes from qa_draft. ' +
      'This is the verb for the wording — a finding whose title reads badly, an «expected» a person has now stated, a picture pointed at the right shot. Deleting and re-adding would put it at the END of the document, which is rarely where it belongs.',
    inputSchema: {
      tabId: tabIdArg,
      at: z.number().int().describe('The position from qa_draft.'),
      block: REPORT_BLOCK.describe('What that line becomes. It may be a different KIND of block.'),
    },
  },
  async ({ tabId, at, block }) => {
    try {
      return asText(await callExtension('qa_draft_edit', { tabId, at, block }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_move',
  {
    title: 'Move a line of the report being written',
    description: 'MOVE THE LINE AT `at` TO `to`. Both are positions from qa_draft. A document usually needs this once, at the end, when the shape is clear.',
    inputSchema: { tabId: tabIdArg, at: z.number().int(), to: z.number().int() },
  },
  async ({ tabId, at, to }) => {
    try {
      return asText(await callExtension('qa_draft_move', { tabId, at, to }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_drop',
  {
    title: 'Take a line out of the report being written',
    description: 'REMOVE THE LINE AT `at`. The position comes from qa_draft, and the positions after it close up — read it again before dropping a second line.',
    inputSchema: { tabId: tabIdArg, at: z.number().int() },
  },
  async ({ tabId, at }) => {
    try {
      return asText(await callExtension('qa_draft_drop', { tabId, at }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_meta',
  {
    title: 'The draft’s own title and what kind of document it is',
    description:
      'SET THE TITLE, THE KIND, OR BOTH. The title becomes the document’s heading and the name the panel lists it under; leave it empty and the page title is used at build time. ' +
      '`kind` is what the document IS — issues (things that are wrong), verified (checked and it holds), notes (a description, no verdict). It changes no layout; the blocks do that.',
    inputSchema: {
      tabId: tabIdArg,
      title: z.string().optional(),
      kind: z.enum(['issues', 'verified', 'notes']).optional(),
    },
  },
  async ({ tabId, title, kind }) => {
    try {
      return asText(await callExtension('qa_draft_meta', { tabId, title, kind }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_clear',
  {
    title: 'Empty the report being written',
    description:
      'THROW THE DRAFT AWAY. There is no undo anywhere in this product, and the draft may be an hour of somebody else’s work — read qa_draft first and say what is in it before calling this. ' +
      'Building already empties it; this is for abandoning one.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_draft_clear', { tabId }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_draft_build',
  {
    title: 'Turn the draft into the document',
    description:
      'BUILD THE DRAFT into a self-contained HTML report — the same assembly qa_report_build does and the same one the panel’s Build button runs, so a document written by hand and one written here are the same document. ' +
      'It is KEPT in the extension by default, which is how the person finds it in the panel an hour later; `save: false` builds a preview and keeps nothing. ' +
      'THE DRAFT IS ONLY EMPTIED IF THE DOCUMENT WAS REALLY KEPT. When the browser has no room the HTML still comes back and the lines stay where they were — losing the work and the built document in the same breath is the one outcome this must never have. ' +
      'It refuses for the reasons qa_report_build refuses, and the important one is NO PICTURE: a page of assertions about an application showing none of them is the artefact this product exists to replace.',
    inputSchema: {
      tabId: tabIdArg,
      out: z.string().optional().describe('Write the HTML here as well. Without it the document comes back inline, which for a report with pictures in it is usually the wrong trade.'),
      name: z.string().optional().describe('Keep it under this name, replacing a document of the same name rather than leaving a stale twin above it.'),
      save: z.boolean().optional().describe('false builds it without keeping anything — a preview. Default is to keep it.'),
    },
  },
  async ({ tabId, out, name, save }, extra) => {
    const bar = loader(extra, 'building the report');
    try {
      const r = await callExtension('qa_draft_build', { tabId, name, save }, 120_000);
      if (!r || r.ok === false || typeof r.html !== 'string') return asText(r);
      const { html, ...rest } = r;
      if (out) {
        const full = resolve(out);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, html, 'utf8');
        for (const [host, v] of reportFunnel) reportFunnel.set(host, { ...v, built: true });
        return asText({ ...rest, path: full, note: 'Open it and print to PDF; the structure is the same on paper.' });
      }
      return asText({ ...rest, html });
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_report_edit',
  {
    title: 'Rewrite a report the extension already holds',
    description:
      'EDIT A FINISHED DOCUMENT: read the blocks it was built from, change them, and build it again UNDER THE SAME NAME — so the shelf keeps one document rather than a family of near copies. This is the same operation the person does in the report editor. ' +
      'Call it with only a `name` to read the blocks back; pass `blocks` to replace them. The run’s own context — the address, the moment, the conditions the application was under — is carried over from the original and cannot be rewritten here, because those are facts about the run rather than about the wording. ' +
      'A report saved before its source was kept has nothing to edit, and says so.',
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe('From qa_reports.'),
      blocks: z.array(REPORT_BLOCK).optional().describe('The document’s new contents, in order. Omit to read the current ones.'),
      kind: z.enum(['issues', 'verified', 'notes']).optional(),
    },
  },
  async ({ tabId, name, blocks, kind }) => {
    try {
      if (!blocks) {
        const got = await callExtension('qa_report_edit_read', { tabId, name }, 30_000);
        return asText(got);
      }
      return asText(await callExtension('qa_report_edit', { tabId, name, blocks, kind }, 120_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_reports',
  {
    title: 'The reports the extension is keeping',
    description:
      'EVERY SAVED REPORT, BY NAME, with its title, what kind it is, when it was built, how many blocks and pictures went in and how big it is. ' +
      'These are the documents `qa_report_build { save }` kept, and they are the same ones the person sees in the panel — so «open the checkout one» means the same thing on both sides. ' +
      'It deliberately does NOT return the HTML: a report with pictures inside is megabytes, and the question here is which ones exist. Use qa_report_get for one. Read-only.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_reports', { tabId }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_report_get',
  {
    title: 'Take one saved report back out',
    description:
      'THE DOCUMENT ITSELF, by the name qa_reports lists. Pass `out` to write it to a file — which is almost always what you want, because a self-contained report carries its pictures as data and spending that through this conversation buys nothing. ' +
      'Without `out` the HTML comes back inline. Read-only: it takes a copy and leaves the extension’s own untouched.',
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe('A name from qa_reports'),
      out: z.string().optional().describe('Write the HTML here instead of returning it inline'),
    },
  },
  async ({ tabId, name, out }) => {
    try {
      const r = await callExtension('qa_report_get', { tabId, name }, 30_000);
      if (!r || r.ok === false || typeof r.html !== 'string') return asText(r);
      if (out) {
        const full = resolve(out);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, r.html, 'utf8');
        return asText({ ok: true, path: full, name: r.name, title: r.title, kind: r.kind, bytes: r.bytes, note: 'Open it and print to PDF; the structure is the same on paper.' });
      }
      return asText(r);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_report_drop',
  {
    title: 'Forget one saved report',
    description:
      'REMOVES A SAVED REPORT FROM THE EXTENSION — the row and the document together, because an index that forgets an entry while the megabytes stay is a leak nobody finds. ' +
      'It touches nothing on the page and nothing on disk: a file you already wrote with `out` is yours and stays. The reply lists what is left.',
    inputSchema: { tabId: tabIdArg, name: z.string().describe('A name from qa_reports') },
  },
  async ({ tabId, name }) => {
    try {
      return asText(await callExtension('qa_report_drop', { tabId, name }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_wiring',
  {
    title: 'Which error message belongs to which field — and which belongs to nothing',
    description:
      'A FORM WITH THREE RED MESSAGES UNDER THREE FIELDS LOOKS CORRECT TO EVERYONE WHO CAN SEE IT. That is the illusion: being NEAR a field is not being attached to it, and assistive technology reads the attachment. Somebody filling the form by ear is told «Email» and nothing else, while «Enter a valid email address» sits in red an inch below, invisible to them. ' +
      'Nobody can check this by looking, which is why it survives in shipped products for years. This reads the wire out of the tree — aria-errormessage, aria-describedby, label — and reports: which messages are attached to which fields, which messages are attached to NOTHING, and which fields are marked invalid with no reason given at all. ' +
      'Pass `draw` to get the picture: a line from every field to its message, and a stub on every message whose line ends in mid-air. ' +
      'It deliberately under-reports: a message inside its field\'s label, and an error summary that links to its fields, are both correct by another route and are not called orphans. A wrongly accused form costs somebody an afternoon proving the tool wrong.',
    inputSchema: {
      tabId: tabIdArg,
      draw: z.string().optional().describe('Write a PNG here with the wiring drawn on the page: green lines for attached messages, red stubs for orphans'),
    },
  },
  async ({ tabId, draw }, extra) => {
    const bar = loader(extra, 'reading the form wiring');
    try {
      const r = await callExtension('qa_wiring', { tabId }, 30_000);
      if (!r || r.ok === false) return asText(r);
      let drawnPath = null;
      let drawNote = null;
      if (draw) {
        const marks = [];
        for (const w of r.wires || []) {
          marks.push({ kind: 'line', selector: w.field.selector, toSelector: w.message.selector, colour: 'good', label: w.how });
        }
        for (const o of r.orphans || []) marks.push({ kind: 'box', selector: o.selector, colour: 'bad', label: 'attached to nothing' });
        for (const f of r.invalidWithoutMessage || []) marks.push({ kind: 'box', selector: f.selector, colour: 'bad', label: 'invalid, no message' });
        if (!marks.length) {
          drawNote = 'nothing to draw: this form has no messages attached and none floating — check that it has actually been submitted with bad data first.';
        } else {
          const shot = await callExtension('qa_annotate', { tabId, marks: marks.slice(0, 60) }, 150_000).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          if (shot?.ok && typeof shot.dataUri === 'string') {
            const { writeFileSync } = await import('node:fs');
            const { resolve } = await import('node:path');
            drawnPath = resolve(draw);
            writeFileSync(drawnPath, Buffer.from(shot.dataUri.slice(shot.dataUri.indexOf(',') + 1), 'base64'));
            drawNote = `${r.wires?.length || 0} attached, ${(r.orphans?.length || 0) + (r.invalidWithoutMessage?.length || 0)} not. Green lines are real associations; red boxes are what a screen reader user would never be told.`;
          } else {
            drawNote = `no picture: ${shot?.error || 'the page could not be photographed'}`;
          }
        }
      }
      return asText({ ...r, ...(drawnPath ? { path: drawnPath } : {}), ...(drawNote ? { drawNote } : {}) });
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_focus_proof',
  {
    title: 'Prove whether focus is visible on one control',
    description:
      'THE ARGUMENT NOBODY WINS WITH A SCREENSHOT, ended with two numbers. Focus the control and measure what actually changed: which of the four properties that can draw a ring moved (outline, box-shadow, border, colours), and what fraction of the PIXELS differ between the two frames. ' +
      '«Nothing in the styles changed and 0.0% of the pixels moved» is a sentence a developer cannot argue with; a screenshot of a missing ring looks exactly like a screenshot of a faint one. ' +
      'It is careful about the three ways this test lies elsewhere: the crop is widened by however far the styles say the ring can reach (an outline is drawn OUTSIDE the box, and a tight crop would swear it was absent), the second frame is taken after any transition has had time to finish, and a ring that is present but faint is reported as present — that is a contrast question, and this verb refuses to collapse the two. ' +
      'Read-only, and it puts focus back where it found it. Returns both frames, so the picture and the number travel together.',
    inputSchema: {
      tabId: tabIdArg,
      selector: z.string().describe('The control to test — a CSS selector. Take it from qa_snapshot or from a focus walk stop.'),
      path: z.string().optional().describe('Write the two frames here as <name>-unfocused.png and <name>-focused.png instead of returning them inline'),
    },
  },
  async ({ tabId, selector, path: outPath }, extra) => {
    const bar = loader(extra, 'measuring the focus ring');
    try {
      const r = await callExtension('qa_focus_proof', { tabId, selector }, 40_000);
      if (!r || r.ok === false) return asText(r);
      const strip = (u) => Buffer.from(String(u).slice(String(u).indexOf(',') + 1), 'base64');
      if (outPath) {
        const { writeFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const base = resolve(outPath).replace(/\.png$/i, '');
        writeFileSync(`${base}-unfocused.png`, strip(r.before));
        writeFileSync(`${base}-focused.png`, strip(r.after));
        return asText({
          ok: true,
          element: r.element,
          changed: r.changed,
          pixelsChanged: r.pixelsChanged,
          verdict: r.verdict,
          note: r.note,
          frames: [`${base}-unfocused.png`, `${base}-focused.png`],
        });
      }
      return {
        content: [
          { type: 'image', data: String(r.before).slice(String(r.before).indexOf(',') + 1), mimeType: 'image/png' },
          { type: 'image', data: String(r.after).slice(String(r.after).indexOf(',') + 1), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ ok: true, element: r.element, changed: r.changed, pixelsChanged: r.pixelsChanged, verdict: r.verdict, note: r.note }, null, 2) },
        ],
      };
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_annotate',
  {
    title: 'Mark a screenshot by naming elements, not coordinates',
    description:
      'A MARK THAT KNOWS WHAT IT POINTS AT. Name the element — a CSS selector — and the box is looked up from the page itself at capture time, so the same instruction draws the correct picture today, after a fix, and at another screen width. ' +
      'An arrow drawn on an ordinary screenshot points at a coordinate: right when it was drawn, wrong the moment anything re-renders. That is why annotated screenshots are disposable, and it is the whole difference here. ' +
      'It is also how a picture marks ITSELF: a finding already carries a selector, so «draw the contrast failures» needs no aiming — pass their selectors straight through. ' +
      'Shapes: `box` (outline it), `pin` (a numbered dot at its corner — for ordered things like a tab route), `arrow` and `line` (from one element to another, which is how you show an error message wired to the wrong field), and `blur` (a pane that makes the element unreadable — an address, a customer\'s name, a token in a staging header). Colours are named, not free: default · bad · good · info · warn. ' +
      'A LABEL IS A CALLOUT, not a sticker: it is placed in free space beside its element, clear of every other mark, and joined to the outline by a leader line ending in a dot. So «outline the payment block and say what is wrong with it» comes back as one readable statement instead of words stamped over the thing they are about. ' +
      'A mark whose element is not on the page is REPORTED in `missed`, never silently dropped — a reader who sees three arrows must be able to trust that there were three things to point at. ' +
      'Read-only: it photographs and draws, and touches nothing — a blur hides the data in THIS picture, never on the page, so the next capture shows it again.',
    inputSchema: {
      tabId: tabIdArg,
      fromFindings: z
        .enum(['all', 'error', 'warning'])
        .optional()
        .describe('Instead of naming marks yourself, DRAW THE PAGE\'S OWN FINDINGS: every finding that carries a selector becomes an outlined box with its title beside it, coloured by severity. A finding already knows where it is, so nobody has to aim — this is the picture a tester currently makes by hand, one arrow at a time. Combine with `marks` to add your own.'),
      marks: z
        .array(
          z.object({
            kind: z.enum(['box', 'pin', 'arrow', 'line', 'blur']).optional().describe("Default 'box'"),
            selector: z.string().optional().describe('The element to mark'),
            box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe('Or a box in IMAGE pixels, if you already have one from a shot map'),
            toSelector: z.string().optional().describe('For arrow/line: the element at the other end'),
            toBox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
            label: z.string().optional().describe('Short text on the mark — three characters inside a pin, up to sixty in a callout placed beside the element and joined to it by a leader line'),
            colour: z.enum(['default', 'bad', 'good', 'info', 'warn']).optional(),
            strength: z.number().optional().describe("For 'blur': how hard it hides, 4–60 (default 14)"),
            pad: z.number().optional().describe("For 'blur': extra margin round the element, in CSS pixels (default 2) — a pane flush with the text tends to leave the tops of the letters showing"),
          }),
        )
        .optional()
        .describe('Up to 60 marks. More than that covers the picture instead of marking it.'),
      path: z.string().optional().describe('Write the marked PNG here instead of returning it inline'),
    },
  },
  async ({ tabId, marks, path: outPath, fromFindings }, extra) => {
    const bar = loader(extra, 'marking the page');
    try {
      let all = Array.isArray(marks) ? [...marks] : [];
      let skipped = 0;
      if (fromFindings) {
        /**
         * A PICTURE THAT MARKS ITSELF.
         *
         * Every finding this product produces already carries the selector of the thing it is
         * about — that is what makes «draw the problems» a lookup rather than a judgement. What a
         * tester does by hand today is exactly this: open the shot, find the low-contrast line,
         * draw a box, type the title, repeat.
         *
         * Findings without a selector (a console error, a failed request) are COUNTED and reported
         * rather than dropped: a picture showing four boxes when there were seven findings is a
         * picture that misleads by omission.
         */
        const found = await callExtension('qa_findings', { tabId, severity: fromFindings }, 30_000).catch(() => null);
        const items = Array.isArray(found?.findings) ? found.findings : [];
        for (const f of items) {
          if (!f.selector) {
            skipped++;
            continue;
          }
          all.push({
            kind: 'box',
            selector: f.selector,
            label: String(f.title || '').slice(0, 60),
            colour: f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info',
          });
          if (all.length >= 60) break;
        }
      }
      if (!all.length) return asText({ ok: false, error: fromFindings ? 'no finding on this page carries a selector, so there is nothing to draw' : 'nothing to draw — pass `marks` or `fromFindings`' });
      const r = await callExtension('qa_annotate', { tabId, marks: all }, 150_000);
      if (!r || r.ok === false || typeof r.dataUri !== 'string') return asText(r);
      const b64 = r.dataUri.slice(r.dataUri.indexOf(',') + 1);
      if (outPath) {
        const { writeFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const full = resolve(outPath);
        writeFileSync(full, Buffer.from(b64, 'base64'));
        return asText({ ok: true, path: full, drawn: r.drawn, ...(r.hidden ? { hidden: r.hidden } : {}), missed: r.missed, ...(skipped ? { findingsWithoutAPlace: skipped, findingsNote: `${skipped} finding(s) have no selector — a console error or a failed request is not AT a place on the page. They are in qa_findings, not in this picture.` } : {}), width: r.width, height: r.height, note: r.note });
      }
      return {
        content: [
          { type: 'image', data: b64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ ok: true, drawn: r.drawn, ...(r.hidden ? { hidden: r.hidden } : {}), missed: r.missed, ...(skipped ? { findingsWithoutAPlace: skipped } : {}), width: r.width, height: r.height, note: r.note }, null, 2) },
        ],
      };
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_failure_gallery',
  {
    title: 'Photograph this screen in every way it can fail',
    description:
      'THE PICTURES NOBODY EVER TAKES: the empty list, the 500 with the server\'s own words, the spinner that never resolves, the 403, the dropped connection. ' +
      'Every other capture tool can only photograph a failure that happens to occur — this one CAUSES it, because the response mocks and the camera are the same product. ' +
      'It walks the states one at a time: sets a rule, reloads, waits for the page, photographs it, removes the rule, moves on — and writes one self-contained HTML file with every picture embedded, which opens in any browser without this extension. ' +
      'That file is the point: the designer and the product owner who need to see the error states do not have Qiksy and never will. ' +
      'The rules are ALWAYS removed at the end, including when something throws — a rule left behind outlives the reason for it and makes the next measurement on the tab a lie. ' +
      'Scope is the mocks\' own: the page\'s fetch/XHR in the top frame, so an app fed by a WebSocket will show a gallery of healthy screens and say so.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      url: z.string().optional().describe('Which requests to break — a substring of the URL, or /regex/flags. Omit to break every request the page makes (usually what you want).'),
      states: z.array(z.enum(STATE_KEYS)).optional().describe(`Which failures to photograph. Default: all of them — ${STATE_KEYS.join(', ')}.`),
      path: z.string().optional().describe('Write the HTML sheet here (default: ~/.qiksy/failures-<host>-<time>.html). You get back the path.'),
      full: z.boolean().optional().describe('Photograph the whole page instead of the visible part (slower — each state is a scroll-and-stitch)'),
      maxWidth: z.number().optional().describe('Cap the width of each picture in the sheet (default 1200)'),
    },
  },
  async ({ tabId, url, states, path: outPath, full, maxWidth }, extra) => {
    const want = STATES.filter((s) => !states?.length || states.includes(s.key));
    const bar = loader(extra, `photographing ${want.length} failure states`);
    const shots = [];
    let build = null;
    let receipt = null;
    try {
      const pageUrl = (await callExtension('qa_status', { tabId }).catch(() => null))?.page?.url || '';
      for (const state of want) {
        const rule = { op: 'set', url: url || '', ...state.rule, note: `failure gallery: ${state.key}` };
        const ruleText = state.rule.fail
          ? 'a network-level failure'
          : `HTTP ${state.rule.status}${state.rule.delayMs ? ` after ${state.rule.delayMs}ms` : ''}${state.rule.body ? ` · ${state.rule.body.slice(0, 80)}` : ''}`;
        try {
          await callExtension('qa_mock', { tabId, ...rule }, 20_000);
          /* A reload is what makes the app ASK again — without it the rule sits there answering
             nothing, and the gallery is five pictures of the same healthy screen. */
          await callExtension('qa_reload', { tabId }, 40_000);
          /* The slow state is photographed WHILE the answer is being held: waiting for the page to
             settle would wait out the delay and photograph the state after it. */
          if (state.shootAfterMs) await new Promise((r) => setTimeout(r, state.shootAfterMs));
          else await callExtension('qa_wait_ready', { tabId }, 30_000).catch(() => {});
          const shot = await callExtension(
            'qa_screenshot',
            { tabId, full: !!full, maxWidth: maxWidth || 1200 },
            full ? 150_000 : 30_000,
          );
          if (shot?.ok && typeof shot.dataUri === 'string') {
            shots.push({ ...state, ruleText, dataUri: shot.dataUri });
            build = build || shot.build;
            receipt = receipt || shot.receipt;
          } else {
            shots.push({ ...state, ruleText, error: shot?.error || 'the camera refused this frame' });
          }
        } catch (e) {
          shots.push({ ...state, ruleText, error: String(e?.message || e).slice(0, 160) });
        } finally {
          /* Per state, not only at the end: two rules in force at once answer the same request
             twice over and the next picture would be of the wrong failure. */
          await callExtension('qa_mock', { tabId, op: 'clear' }, 20_000).catch(() => {});
        }
      }

      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { resolve, dirname, join } = await import('node:path');
      const { homedir } = await import('node:os');
      let host = 'page';
      try { host = new URL(pageUrl).host.replace(/[^a-z0-9.-]/gi, '') || 'page'; } catch { /* keep the default */ }
      const stamp = (build?.at || new Date().toISOString()).replace(/[:.]/g, '-');
      const file = resolve(outPath || join(homedir(), '.qiksy', `failures-${host}-${stamp}.html`));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderGallery({ url: pageUrl, shots, build, receipt, at: build?.at || new Date().toISOString() }), 'utf8');

      const taken = shots.filter((s) => s.dataUri).length;
      return asText({
        ok: taken > 0,
        path: file,
        states: shots.map((s) => ({ state: s.key, ok: !!s.dataUri, ...(s.error ? { error: s.error } : {}) })),
        taken,
        asked: want.length,
        mocksCleared: true,
        note:
          taken === want.length
            ? 'Every state was photographed and every rule was removed. The file opens in any browser and carries the pictures inside it.'
            : 'Some states did not produce a picture — each one says why above. The rules were removed regardless.',
        ...(taken === 0
          ? { hint: 'No state produced a picture. Usually that means the page does not fetch anything matching `url` in the top frame — mocks do not cover documents, subresources, WebSocket or iframes.' }
          : {}),
      });
    } catch (e) {
      return asError(e);
    } finally {
      /* THE LAST WORD ON MOCKS. Whatever happened above — a throw, a refusal, a timeout — the tab
         goes back to talking to its own server. */
      await callExtension('qa_mock', { tabId, op: 'clear' }, 20_000).catch(() => {});
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_gap',
  {
    title: 'Record what the bridge could not do',
    description:
      'SAY WHAT THE BRIDGE COULD NOT DO, IN ONE SENTENCE — and it becomes a line in a file the human reads (~/.qiksy/gaps.jsonl). ' +
      'This is the sanctioned way out of a dead end, and it exists because the usual way out is worse: an agent that hits a wall ' +
      'silently switches to another browser driver, and the run stops being the test that was asked for. ' +
      'Use it when the bridge genuinely lacks a capability — not when a control refused once (that is the ladder in the instructions: qa_probe, raw, a CSS selector, qa_click by name). ' +
      'op:"list" reads the log back, newest first, which is also how you check whether your gap is already known.',
    inputSchema: {
      op: z.enum(['add', 'list']).default('add').describe('"add" records a gap; "list" reads them back'),
      wanted: z.string().optional().describe('What you needed the bridge to do, in one sentence. Required for "add".'),
      verb: z.string().optional().describe('The verb you were using when you hit it, e.g. "qa_read"'),
      tried: z.array(z.string()).optional().describe('What you already tried — the rungs of the ladder you climbed, so nobody re-suggests them'),
      url: z.string().optional().describe('The page it happened on (the query string is stripped before it is written)'),
      blocked: z.boolean().optional().describe('True when this stopped the task outright, rather than merely costing extra calls'),
      limit: z.number().optional().describe('For "list": how many to return (default 50)'),
    },
  },
  async ({ op, wanted, verb, tried, url, blocked, limit }) => {
    try {
      if (op === 'list') {
        const rows = listGaps(limit ?? 50);
        return asText({ ok: true, file: GAPS_FILE, count: rows.length, gaps: rows });
      }
      const r = recordGap({ wanted, verb, tried, url, blocked });
      if (!r.ok) return asText(r);
      return asText({
        ...r,
        note: 'Written down. Nothing about this call changed the page or the bridge — the gap is a request to the human, and it is answered by shipping a verb, not at runtime.',
      });
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_frames',
  {
    title: 'Which documents this page is actually made of',
    description:
      'A PAGE IS OFTEN SEVERAL DOCUMENTS, AND THE INTERESTING ONE IS USUALLY NOT THE OUTER ONE. A payment form, an SSO step, a chat widget, a Stripe or 3-D Secure field: each lives in a frame of its own, and a frame from another domain cannot be read from the page around it — that is the same-origin rule and no amount of JavaScript gets past it. Qiksy now runs INSIDE every frame and answers about its own document, which is what makes them readable at all. ' +
      'This lists them: `frameId`, the address, the title, and how many controls each holds, with the page itself first. Pass the `frameId` you want to qa_read, qa_styles and the other reading verbs; leave it out and you get the page itself, never a frame picked at random. ' +
      'Call this the moment a control you can see on screen is missing from qa_snapshot: nine times out of ten it is not missing, it is in a frame nobody named. Read-only and free.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }, extra) => {
    const bar = loader(extra, 'listing the frames');
    try {
      return asText(await callExtension('qa_frames', { tabId }, 20_000));
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_tabs',
  {
    title: 'QA tabs',
    description:
      'List the browser tabs Qiksy can read, including which are ISOLATED multi-login sessions (isolatedSession = the login name). Use a tab\'s tabId with the other tools to read that specific login. ' +
      'With two browsers or Chrome profiles connected at once, every tab also carries `browser` (1 = the one connected first) and the reply says `browsers`; pass the tabId and the call goes to the browser that holds that tab, while a call with no tabId goes to browser 1.',
    inputSchema: {},
  },
  async () => {
    try {
      /* AN EMPTY LIST WAS A SILENT DEAD END: `{ tabs: [] }` and nothing else, and a fresh agent
         took it as «there is nothing to work in» and stopped (owner, 03.11.2026). */
      const r = await callExtension('qa_tabs', {});
      if (r && typeof r === 'object' && Array.isArray(r.tabs) && r.tabs.length === 0) {
        return asText({
          ...r,
          whatNow: 'No tab is open for you yet. Open the page YOURSELF with qa_open_tab { url } (the address the task is about) and carry on in the tab it returns. Do not stop and do not ask the human to open it.',
        });
      }
      return asText(r);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_status',
  {
    title: 'QA status',
    description: 'Health snapshot of a page Qiksy is watching: URL, error/warning/form counts, and its isolated-login name if any. Defaults to the active tab; pass tabId (from qa_tabs) to target a specific tab.',
    inputSchema: { tabId: z.number().int().optional().describe('Target tab (from qa_tabs); omit for the active tab') },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_status', { tabId }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_findings',
  {
    title: 'QA findings',
    description: 'Findings on a page (console/JS/network/a11y/markup/submit) — each with a CSS selector and detail. Filter by severity; pass tabId (from qa_tabs) to read a specific tab / isolated login.',
    inputSchema: {
      severity: z.enum(['all', 'error', 'warning']).default('all').describe('Severity filter'),
      tabId: z.number().int().optional().describe('Target tab (from qa_tabs); omit for the active tab'),
      select: selectArg,
      omit: omitArg,
    },
  },
  async ({ severity, tabId, select, omit }) => {
    try {
      return asText(project(await callExtension('qa_findings', { severity, tabId }), { select, omit }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_export',
  {
    title: 'QA export',
    description:
      'Full qa-export/v1 bundle for a page: findings (with selectors), failed requests (with server error bodies), detected form structure, recorded repro steps, env, and isolated-login name. Read this, then fix the underlying issues. Pass tabId (from qa_tabs) to target a specific tab / isolated login.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Target tab (from qa_tabs); omit for the active tab'),
      select: selectArg,
      omit: omitArg,
    },
  },
  async ({ tabId, select, omit }, extra) => {
    const bar = loader(extra, 'building the QA bundle');
    try {
      return asText(project(await callExtension('qa_export', { tabId }, 30_000), { select, omit }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

// ── Command tools (drive Qiksy's OWN UI / analysis; never the app under test) ─


server.registerTool(
  'qa_open_panel',
  {
    title: 'Open Qiksy panel',
    description:
      "Open (or close) the Qiksy side panel on a tab and optionally jump to a tab: 'forms' | 'findings' | 'tour' | 'tools' | 'history' | 'roles'. Controls Qiksy's OWN UI only — it does not touch the page under test. Set open:false to close.",
    inputSchema: {
      tabId: tabIdArg,
      open: z.boolean().default(true).describe('true to open, false to close'),
      tab: z.enum(['forms', 'findings', 'tour', 'tools', 'history', 'roles']).optional().describe('Which panel tab to show'),
    },
  },
  async ({ tabId, open, tab }) => {
    try {
      return asText(await callExtension('qa_open_panel', { tabId, open, tab }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_run_audit',
  {
    title: 'Run accessibility & markup audit',
    description:
      'Run Qiksy\'s a11y/markup audit on the current DOM (unlabeled controls, missing names, WCAG AA contrast, broken images, duplicate ids, positive tabindex, …) and return the findings. Also refreshes the panel. Static, non-destructive — reads the DOM only.',
    inputSchema: { tabId: tabIdArg, select: selectArg, omit: omitArg },
  },
  async ({ tabId, select, omit }, extra) => {
    const bar = loader(extra, 'auditing the page');
    try {
      return asText(project(nudgeReport(await callExtension('qa_run_audit', { tabId }, 30_000)), { select, omit }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_axe',
  {
    title: 'Run the axe-core rule engine on the page',
    description:
      'The industry-standard accessibility rule engine (axe-core — the one under Lighthouse), bundled ' +
      'INSIDE the extension and run locally on the live DOM: nothing leaves the page, no remote code. ' +
      'Hundreds of WCAG A/AA checks on top of qa_run_audit\'s own set, narrowed to WCAG-tagged rules so ' +
      'every violation maps to a criterion. Returns violations with impact, WCAG tags, help URL and up ' +
      'to 10 offending selectors each. Read-only. Needs an extension build that carries the engine — an ' +
      'older build answers "unknown command: axe" (reload the extension after updating).',
    inputSchema: { tabId: tabIdArg, select: selectArg, omit: omitArg },
  },
  async ({ tabId, select, omit }, extra) => {
    const bar = loader(extra, 'running axe-core');
    try {
      // axe walks the full DOM — give it more room than the house 30s default.
      return asText(project(await callExtension('axe', { tabId }, 60_000), { select, omit }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_read',
  {
    title: 'Read the text of a page (or one element)',
    description:
      'Return the RENDERED text of the page under test, or of a single element named by a qa_snapshot ref or a CSS selector. ' +
      'This is the companion to qa_snapshot: that one maps what you can ACT on (roles, names, refs) and caps every name at 80 characters, ' +
      'so anything longer — a one-time code in an email, an error paragraph, a generated invoice number — is invisible to it. ' +
      'Uses innerText, so hidden branches and a mail thread\'s collapsed quoted history stay out. Read-only: it executes nothing and returns text, capped (default 4000 chars, max 20000).',
    inputSchema: {
      tabId: tabIdArg,
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred when you already have one'),
      selector: z.string().optional().describe('CSS selector; omit both to read the whole page body'),
      maxChars: z.number().optional().describe('Cap the returned text (default 4000, max 20000)'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, ref, selector, maxChars, frameId }, extra) => {
    const bar = loader(extra, 'reading the page text');
    try {
      return asText(await callExtension('qa_read', { tabId, ref, selector, maxChars, frameId }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

/** Enough to cover what an upload field actually accepts; anything else falls back to octet-stream. */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
};

server.registerTool(
  'qa_upload',
  {
    title: 'Attach a file to an upload field',
    description:
      "Put a file into an <input type=file> — including the hidden ones behind a styled dropzone, which a click can never reach. " +
      'Three ways to choose what goes in: `fixture` for a hostile edge-case file (the upload counterpart of naughty strings — empty, oversize, wrong-type, corrupt, unicode name, unsanitised SVG…), `path` for a file on this machine, or `content` as base64. ' +
      'Pass `content` as base64 to attach a file YOU generated (a PDF fixture, a malformed CSV, an oversized image); omit it and Qiksy attaches a neutral test file matched to the field\'s `accept`. ' +
      'A content script has no filesystem access and the OS file picker is a modal an agent must never open, so bytes over this bridge are the only way a file from outside the browser gets in. ' +
      'AND WHERE THERE IS NO FILE INPUT AT ALL — a button that calls the native picker straight away, as YouTube Studio\'s audio-language dialog does — name that button with `field` and the file is handed to the picker it opens, exactly as a person choosing it would. '  +
      'The reply says `via` when that route was used, and it says so only when the page actually took the file. ' +
      'Delivery fires both paths uploaders use — assigning `input.files` + change, and a synthetic drop on the nearest dropzone — because react-dropzone-style components listen only for the second. ' +
      'SEVERAL FIELDS IN ONE CALL: pass `files` — an array of the same arguments — and they are attached in order, one round trip for the whole step instead of one per file.',
    inputSchema: {
      tabId: tabIdArg,
      files: z
        .array(
          z.object({
            ref: z.string().optional().describe('A ref from qa_snapshot'),
            selector: z.string().optional().describe('CSS selector of the file input or its dropzone'),
            field: z.string().optional().describe("The upload CONTROL's accessible name — \"Premises photos\". Without it the file goes to the page's FIRST file input, which on a step with two dropzones is the wrong one."),
            name: z.string().optional().describe("File name, e.g. 'report.pdf'"),
            mimeType: z.string().optional(),
            fixture: z
              .enum(['image', 'pdf', 'csv', 'empty', 'oversize', 'wrong-type', 'corrupt', 'long-name', 'unicode-name', 'svg-script', 'double-ext'])
              .optional()
              .describe('A hostile fixture built in the page — see the single-file `fixture` above'),
            path: z.string().optional().describe('Absolute path to a file on this machine — this process reads it'),
            content: z.string().optional().describe('Base64 file content'),
          }),
        )
        .optional()
        .describe('Attach several files in ONE call — each entry takes the same arguments as a single upload. Use this when a step has more than one upload field.'),
      ref: z.string().optional().describe('A ref from qa_snapshot'),
      selector: z.string().optional().describe("CSS selector of the file input or its dropzone; omit to use the page's first file input"),
      field: z
        .string()
        .optional()
        .describe(
          "The upload CONTROL's accessible name — \"Premises photos\", \"Company logo\". Prefer this over a ref: an upload field is usually a hidden input behind a styled dropzone, and a step with two dropzones has two of them. Without a field (and without a ref or selector) the file lands in the page's FIRST file input, which is how two photos ended up attached to the logo.",
        ),
      name: z.string().optional().describe("File name, e.g. 'report.pdf'"),
      mimeType: z.string().optional().describe("MIME type, e.g. 'application/pdf'"),
      fixture: z
        .enum(['image', 'pdf', 'csv', 'empty', 'oversize', 'wrong-type', 'corrupt', 'long-name', 'unicode-name', 'svg-script', 'double-ext'])
        .optional()
        .describe(
          'A HOSTILE fixture built in the page, so it costs nothing to send: empty (0 bytes) · oversize (12MB) · ' +
            'wrong-type (a PNG named .pdf — is content checked or only the extension?) · corrupt (truncated PNG) · ' +
            'long-name (255 chars) · unicode-name (RTL + emoji + CJK) · svg-script (is an uploaded SVG sanitised?) · ' +
            'double-ext (invoice.pdf.exe — does the UI show the whole name?). The answer comes back as `asks`.',
        ),
      path: z.string().optional().describe('Absolute path to a file ON THIS MACHINE — the server reads and encodes it for you. Use this instead of `content` for anything bigger than a few hundred bytes.'),
      content: z.string().optional().describe('Base64 file content, for a file you are holding in memory. Prefer `path`.'),
    },
  },
  async ({ tabId, ref, selector, field, name, mimeType, path, content, fixture, files }, extra) => {
    const bar = loader(extra, 'attaching the file');
    try {
      /* READING THE FILE HAPPENS HERE, and that is the whole point of the option.
       *
       * This process is ordinary Node on the user's machine — it has a filesystem, which the
       * content script pointedly does not. Passing 15,000 characters of base64 through a tool
       * call to move a 12KB image is absurd when one side can simply open the file; a modest
       * PDF or screenshot makes it worse than absurd. So the agent names a path and the bytes
       * never enter the conversation at all. */
      const one = async (f) => {
        let body = f.content;
        let fileName = f.name;
        let type = f.mimeType;
        if (f.path) {
          body = readFileSync(f.path).toString('base64');
          fileName = fileName || basename(f.path);
          type = type || MIME[extname(f.path).toLowerCase()] || 'application/octet-stream';
        }
        /* NAME THE CONTROL, not just the file. `qa_upload` was the one verb with no way to say WHICH
           upload it meant, so on a step with two dropzones both files went to the first input — the
           two premises photos landed on the company logo (2026-07-30). Resolved here, against a
           snapshot taken now, exactly like qa_click { name }. */
        let target = f.ref;
        let unresolvedField = null;
        if (!target && !f.selector && f.field) {
          const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
          rememberSnapshot(tabId, snap);
          const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
          const uploads = nodes.filter((n) => n.tag === 'input' && (n.role === 'button' || n.role === 'textbox'));
          const hit = pickNode(uploads.length ? uploads : nodes, { name: f.field }, new Set());
          /* A HIDDEN input is not in the tree at all, so a name cannot always resolve — Ant's Upload
             renders `display:none` and the snapshot rightly skips it (2026-07-30). Refusing here would
             break the ordinary single-upload case that has worked all along, so fall back to the
             extension's own "first file input" and SAY so: on a step with one upload that is correct,
             and on a step with several the note is the warning the agent needs. */
          if (hit) target = hit.node.ref;
          else unresolvedField = f.field;
        }
        const res = await callExtension('qa_upload', { tabId, ref: target, selector: f.selector, name: fileName, mimeType: type, content: body, fixture: f.fixture }, 30_000);
        note('upload', tabId, [targetOf(tabId, target, f.selector, { fixture: f.fixture, fileName, mimeType: type, path: f.path })]);
        if (unresolvedField && res && typeof res === 'object') {
          res.note = `"${unresolvedField}" is not in the accessibility tree — its input is hidden (Ant Design's Upload does this), so the file went to the page's FIRST file input. On a step with one upload that is the right one; with several, pass a \`selector\` for the dropzone instead.`;
        }
        return res;
      };

      // Sequential, not parallel: two uploads racing on the same dropzone is a bug we would be
      // introducing on the app's behalf, and the win here is the round trip, not concurrency.
      if (Array.isArray(files) && files.length) {
        const results = [];
        for (const f of files) {
          try {
            results.push({ target: f.field || f.ref || f.selector || 'first file input', ...(await one({ ...f, field: f.field || field })) });
          } catch (e) {
            results.push({ target: f.field || f.ref || f.selector || 'first file input', ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const ok = results.filter((r) => r.ok !== false).length;
        return asText(await followAfter({ ok: ok > 0, attached: ok, total: results.length, results }, tabId, 'upload'));
      }
      return asText(await followAfter(await one({ ref, selector, field, name, mimeType, path, content, fixture }), tabId, 'upload'));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_storage',
  {
    title: 'Read or set the page\'s web storage',
    description:
      "Read and write the app's own localStorage / sessionStorage — flip a feature flag, expire a token to test the re-auth path, or prove what the app actually persisted after a save. " +
      "Without `op` (or with op:'list'/'get') it READS and is free like every other read on this bridge; op:'set'|'remove'|'clear' WRITES and needs the Agent control consent, because changing a stored token or flag changes what the app does just as surely as clicking does. " +
      'Closed vocabulary — it executes nothing you supply, it names a key. Listing truncates long values at 300 chars; ask for one key by name to get it whole.',
    inputSchema: {
      tabId: tabIdArg,
      area: z.enum(['local', 'session']).optional().describe("Which store (default 'local')"),
      op: z.enum(['list', 'get', 'set', 'remove', 'clear']).optional().describe("Default 'list' (or 'get' when a key is given)"),
      key: z.string().optional().describe('The key to read, set or remove'),
      value: z.string().optional().describe("The value, for op:'set'"),
    },
  },
  async ({ tabId, area, op, key, value }, extra) => {
    const bar = loader(extra, 'reading web storage');
    try {
      return asText(await callExtension('qa_storage', { tabId, area, op, key, value }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_dialogs',
  {
    title: 'Decide what the page’s own native dialogs do',
    description:
      "The browser's OWN dialogs — “Leave site? Changes you made may not be saved”, confirm(), alert(), prompt() — are drawn outside the document, so no click of any kind can reach their buttons. Nothing on this bridge can press them and nothing in any page can. " +
      'What IS reachable is the page\'s REQUEST for them, and that is what this changes: `beforeunload:true` stops the app from asking, so the navigation simply proceeds; `confirm:"accept"|"dismiss"` decides what confirm() returns; `alert:true` swallows alerts; `prompt` supplies the string (or null to cancel). ' +
      "op:'list' is free and reads the policy in force; setting one needs the Agent control consent, because an auto-accepted confirm can be the one in front of Delete. " +
      'SCOPE: this tab, until it closes; it survives reloads of it. ' +
      'EVERY suppressed dialog is logged as a finding carrying the question the page asked and the answer given — so never report that the app stopped asking. It asked; Qiksy answered. Clear it (op:\'clear\') as soon as the flow is through.',
    inputSchema: {
      tabId: tabIdArg,
      op: z.enum(['set', 'list', 'clear']).optional().describe("Default 'set'"),
      beforeunload: z.boolean().optional().describe('true = let navigation through without the browser’s “Leave site?” prompt'),
      confirm: z.enum(['accept', 'dismiss']).nullable().optional().describe('What confirm() returns; null removes the override'),
      alert: z.boolean().optional().describe('true = swallow alert() instead of blocking on it'),
      prompt: z.string().nullable().optional().describe('What prompt() returns; null cancels it'),
    },
  },
  async ({ tabId, op, beforeunload, confirm, alert, prompt }, extra) => {
    const bar = loader(extra, op === 'list' ? 'reading the dialog policy' : 'setting the dialog policy');
    try {
      return asText(await callExtension('qa_dialogs', { tabId, op, beforeunload, confirm, alert, prompt }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_mock',
  {
    title: 'Answer a request from a rule instead of the server',
    description:
      "Override what the app RECEIVES from the network — the thing DevTools calls a local override, driven from here. Set a rule and the page's next matching fetch/XHR is answered by it: your status, your body, optionally after a delay, or as an outright network failure. " +
      'This is how you test the paths a server will not produce on demand: an empty list, a 500, a 403 that should log the user out, a 30-second response that should show a spinner, a malformed payload, a field the API does not return yet. ' +
      "op:'list' is free and READS the rules in force; set / remove / toggle / clear change what the app sees and need the Agent control consent, because an app fed an invented 200 can persist it. " +
      'MATCHING: `url` is a substring of the full URL, or `/regex/flags` when you wrap it in slashes; `method` defaults to any. First matching enabled rule wins. `times` spends the rule after N answers (leave it out for unlimited) — that is how you make the FIRST call fail and the retry succeed. ' +
      'LIFETIME: a rule belongs to ONE TAB, survives reloads of it, and is gone when it closes. It is not in force in any other tab. ' +
      'WHAT IT DOES NOT CATCH, so you do not debug a rule that was never consulted: only the page\'s own fetch/XHR in the top frame. Not the HTML document itself, not images/scripts/stylesheets, not WebSocket or EventSource, not sendBeacon, not requests made inside an iframe or from the page\'s own service worker. ' +
      'Mocked responses are logged as `(mocked)` in the session, the HAR and the report — a value you invented is never presented as the server\'s. Remember to clear rules when you are done; a forgotten mock is the most expensive thing here.',
    inputSchema: {
      tabId: tabIdArg,
      op: z.enum(['set', 'list', 'remove', 'toggle', 'clear']).optional().describe("Default 'set'"),
      id: z.string().optional().describe('Rule id, for remove / toggle / editing an existing rule'),
      url: z.string().optional().describe('Substring of the request URL, or /regex/flags'),
      method: z.string().optional().describe("GET / POST / … — omit to match any method"),
      status: z.number().optional().describe('Status to answer with (default 200)'),
      body: z.string().optional().describe('Response body, verbatim. JSON-looking bodies get a JSON content-type unless you set one'),
      headers: z.record(z.string()).optional().describe('Response headers'),
      delayMs: z.number().optional().describe('Hold the answer back this long — for spinners and timeouts (max 60000)'),
      fail: z.boolean().optional().describe('Fail at the network level (fetch rejects, XHR fires error) instead of answering'),
      times: z.number().optional().describe('Apply at most N times, then let the real request through'),
      note: z.string().optional().describe('Why this rule exists — shown to the human in the panel'),
      enabled: z.boolean().optional().describe("For op:'toggle'"),
    },
  },
  async ({ tabId, op, id, url, method, status, body, headers, delayMs, fail, times, note, enabled }, extra) => {
    const bar = loader(extra, op === 'list' ? 'reading response mocks' : 'setting a response mock');
    try {
      return asText(await callExtension('qa_mock', { tabId, op, id, url, method, status, body, headers, delayMs, fail, times, note, enabled }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_styles',
  {
    title: 'Computed styles and box of an element',
    description:
      'The COMPUTED styles of one element — colour, type, spacing, border, shadow, layout — plus its box in CSS pixels, and the CSS custom properties (design tokens) in scope for it. ' +
      'This is how you check a built page against a design: it answers "this button renders #3B82F6 at 15px with 22px padding" without a screenshot and without measuring anything by eye. ' +
      'Target it by a qa_snapshot ref (preferred) or a CSS selector. Read-only and executes NOTHING: the property list is fixed in the extension, so you name an element, never a program. ' +
      'Pair it with a design source (a Figma file, a token JSON) to report the diff, and with qa_spotlight to show the human which element you mean.',
    inputSchema: {
      tabId: tabIdArg,
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred over selector'),
      selector: z.string().optional().describe('CSS selector of the element'),
      tokens: z.boolean().optional().describe('Include the CSS custom properties in scope (default true)'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, ref, selector, tokens, frameId }, extra) => {
    const bar = loader(extra, 'reading the computed styles');
    try {
      return asText(await callExtension('qa_styles', { tabId, ref, selector, tokens, frameId }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_snapshot',
  {
    title: 'Full page snapshot (accessibility tree)',
    description:
      'A compact accessibility / interaction snapshot of the WHOLE page: every interactive control, landmark and heading with a role, an accessible name, its state, and a STABLE ref like [ref=e12]. ' +
      'Unlike qa_export — which lists only the FORM fields Qiksy detects and can miss inputs, file uploads, date pickers, selects and buttons — this "sees everything". ' +
      'Pass a ref straight back to qa_click / qa_type / qa_spotlight: a ref is unique and unambiguous, so it works where a CSS selector is duplicated across fields. ' +
      'Built in the live, already-authenticated page in ~milliseconds — no browser launch, no CDP. Re-run it after the page changes to refresh the refs. ' +
      'ONE SNAPSHOT OWNS ITS REFS: taking a new one RENUMBERS them, so every ref from an earlier snapshot is void even when its element is still on the page — e12 may now be a different control, and nothing will refuse the click. Keep only the refs of your latest snapshot; where you cannot, target by `name` (qa_click, qa_fill_json), which survives both a re-render and a renumbering. ' +
      'On a big app, NARROW IT: `fields_only` for the form controls, `roles` for exactly the kinds you want, `match` for a name, `within` for one dialog or step panel. ' +
      'Filtering happens on the way out and does NOT invalidate anything — the refs you get back work like any other. One step of a wizard usually needs `fields_only:true, roles:["button"]`, not the whole page.',
    inputSchema: {
      tabId: tabIdArg,
      geometry: z.boolean().optional().describe('Add each node\'s box as "x,y,w,h" in CSS pixels — for overlap, clipping, off-screen and tap-target-size checks. Off by default: it is bulk on every node.'),
      fields_only: z
        .boolean()
        .optional()
        .describe('Keep only form controls (inputs, textareas, selects, checkboxes, radios, comboboxes, sliders, file fields). The cheap view when you are filling a form; combine with roles:["button"] to keep Next/Submit too.'),
      roles: z
        .array(z.string())
        .optional()
        .describe('Keep only these roles, e.g. ["button","link"] or ["combobox"]. Unioned with fields_only when both are given.'),
      match: z.string().optional().describe('Keep only nodes whose accessible name contains this text (case-insensitive)'),
      within: z
        .string()
        .optional()
        .describe("Keep only the subtree under this selector — pass the `selector` of a container node from an earlier snapshot (a dialog, a step panel, a fieldset) to see just that step's controls"),
      limit: z.number().optional().describe('Cap the number of nodes returned'),
      format: z
        .enum(['both', 'tree', 'nodes'])
        .optional()
        .describe("Default 'both'. 'tree' is the indented text only — about half the bytes, and enough when you just need refs and names; 'nodes' is the structured list only (each with its cssPath)."),
      select: selectArg,
      omit: omitArg,
      frameId: frameIdArg,
    },
  },
  async ({ tabId, geometry, fields_only, roles, match, within, limit, format, select, omit, frameId }, extra) => {
    const bar = loader(extra, 'reading the whole page');
    try {
      const snap = await callExtension('qa_snapshot', { tabId, geometry, frameId }, 30_000);
      // Remember the FULL snapshot, not the filtered view: this is what turns a ref back into a
      // field name when the batch that used it is journalled for a recipe.
      rememberSnapshot(tabId, snap);
      const out = withHello(filterSnapshot(snap, { fieldsOnly: fields_only, roles, match, within, limit, format }), tabId);

      /* TELL THE AGENT WHICH COMPONENT LIBRARY IT IS LOOKING AT (owner ask, 2026-07-29: "можешь как
       * bridge выдавать Клоду информацию как prompt, что это похоже на ant, значит делай так-то").
       *
       * The snapshot alone cannot say: cssPath carries no class names. But one cheap read per marker
       * can, and the answer changes how every widget on the page must be driven — a MUI date field
       * cannot be written to at all, an Ant day is a role-less <td>, a react-select value must be the
       * option text. So the hints ride along with the map, once per URL, and the knowledge lives in
       * widgets.mjs rather than in whoever happens to remember the last session. */
      /**
       * ONE QUESTION FIRST, AND USUALLY THAT IS THE WHOLE BILL.
       *
       * Every marker in the registry is a selector for an OPEN layer — `.MuiPickersPopper-root`,
       * `.p-dropdown-panel`, `.mat-mdc-select-panel`. Two things follow, and the second one is
       * the reason the obvious optimisation is wrong.
       *
       * (1) With no popup open — which is most snapshots — every marker misses, and the old code
       *     paid a separate round trip for each of them to find that out: fifty-one calls over
       *     the socket to learn nothing. A CSS selector list answers "did ANY of these match" in
       *     ONE call, and only when something did does it cost more to find out which.
       *
       * (2) Keying the cache by ORIGIN instead of by URL — the tempting fix, since an SPA that
       *     changes its address every step re-sniffs on every step — would make detection
       *     strictly WORSE. The first snapshot of any app has no popup open, so it finds
       *     nothing; cached against the origin, that miss would stand for the whole session and
       *     the hints would never appear at all. The re-probing IS what lets a library be
       *     noticed once its picker is finally opened.
       *
       * So misses stay per-URL and cheap; a HIT is remembered against the origin, because a
       * library found in an app does not stop being that app's library on the next route.
       */
      const key = String(snap?.url || tabKey(tabId));
      const originOf = (u) => { try { return new URL(u).origin; } catch { return String(u || ''); } };
      const originKey = `origin:${originOf(snap?.url)}`;
      const known = libCache.get(originKey);
      if (known?.length) {
        libCache.set(key, known);
      } else if (!libCache.has(key)) {
        const union = LIBRARIES.flatMap((l) => l.markers).join(', ');
        const any = await callExtension('qa_read', { tabId, selector: union, maxChars: 8 }).catch(() => null);
        const found = [];
        if (any && !any.error) {
          for (const lib of LIBRARIES) {
            for (const marker of lib.markers) {
              const r = await callExtension('qa_read', { tabId, selector: marker, maxChars: 8 }).catch(() => null);
              if (r && !r.error) { found.push(lib.id); break; }
            }
          }
        }
        libCache.set(key, found);
        if (found.length) libCache.set(originKey, found);
      }
      const libs = libCache.get(key) || [];
      if (libs.length) {
        out.componentLibraries = libs;
        out.hints = hintsFor(libs);
      }

      /* AND WHAT KINDS OF WIDGET ARE ON IT, judged by shape rather than by library. The library
       * hint says "this page is Ant"; this says "and three of these fields are not writable" — the
       * part that decides the very next call, and the part that also works on the hand-rolled
       * widgets no marker will ever match. One sentence per kind, deduplicated. */
      const kinds = classifySnapshot(Array.isArray(out?.nodes) ? out.nodes : Array.isArray(snap?.nodes) ? snap.nodes : []);
      // 'text' and 'checkbox' are the default assumption already — naming them is pure bulk.
      const notable = kinds.filter((k) => k.kind !== 'text' && k.kind !== 'checkbox');
      if (notable.length) out.widgets = notable.map((k) => ({ kind: k.kind, verb: k.verb, fields: k.examples, drive: k.drive }));
      /* `select`/`omit` come LAST, after the filters and the hints: the filters decide which nodes
         the answer is about, the projection decides which fields of them come back. Applying it
         earlier would hide the library hints from a caller who asked for two node fields. */
      return asText(project(out, { select, omit }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_tour',
  {
    title: 'Exploratory tour / coverage checklist',
    description:
      'Return a generated per-page exploratory-testing checklist (from detected forms + interactive surfaces), with items auto-checked from the recorded session. Great raw material for writing test cases. Returns markdown + structured items.',
    inputSchema: { tabId: tabIdArg },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_tour', { tabId }, 20_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_report',
  {
    title: 'Generate session report',
    description:
      "Generate Qiksy's self-contained HTML report — coverage stats, per-page table, steps with screenshots, findings — and return the HTML. " +
      'Pass `spec` to make it answer the question the TICKET asked: give it the story and your verdict on each acceptance criterion, and the report leads with those, ' +
      'rendered next to the evidence Qiksy collected itself (errors, failed requests with server bodies, screenshots). ' +
      'That turns a log into a deliverable a developer or a client can read. You supply the verdicts — you are the one who read the story; Qiksy supplies the proof. ' +
      'Requires History recording to have captured steps; otherwise returns a note.',
    inputSchema: {
      tabId: tabIdArg,
      path: z
        .string()
        .optional()
        .describe(
          'Write the report HERE instead of returning it. An absolute path, or one relative to where the bridge process runs. ' +
            'STRONGLY PREFERRED: the report is a self-contained HTML document with embedded screenshots and routinely runs to hundreds of kilobytes — returning it inline spends your context on bytes you were going to save to a file anyway. ' +
            'You get back the path, the size and the report title.',
        ),
      spec: z
        .object({
          title: z.string().optional().describe('Report heading, e.g. the ticket key + name'),
          story: z.string().optional().describe('The story / requirement text the criteria came from'),
          checks: z
            .array(
              z.object({
                id: z.string().optional().describe('Criterion id, e.g. "AC-3"'),
                text: z.string().describe('What was supposed to happen'),
                status: z.enum(['pass', 'fail', 'blocked']),
                evidence: z.string().optional().describe('What you actually observed'),
                selector: z.string().optional().describe('Where, if it is element-specific'),
              }),
            )
            .optional(),
        })
        .optional()
        .describe('Acceptance criteria + verdicts to lead the report with'),
    },
  },
  async ({ tabId, path: outPath, spec }) => {
    try {
      const res = await callExtension('qa_report', { tabId, spec }, 45_000);
      /* WRITING HAPPENS HERE, on the same reasoning as qa_upload's `path`, inverted.
       *
       * This process is ordinary Node on the user's machine and has a filesystem; the
       * extension does not. A session report is a self-contained HTML document with base64
       * screenshots inside it — hundreds of kilobytes — and handing that back through a tool
       * result burns the agent's context on bytes whose destination is a file. So the agent
       * names a path and only the receipt comes back. */
      if (outPath && res && typeof res.html === 'string') {
        const abs = isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, res.html, 'utf8');
        return asText({
          ok: true,
          path: abs,
          bytes: Buffer.byteLength(res.html, 'utf8'),
          title: spec?.title ?? null,
          note: 'Self-contained HTML — screenshots are embedded, so it opens anywhere and can be attached to a ticket as one file.',
        });
      }
      return asText(res);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_spotlight',
  {
    title: 'Spotlight an element',
    description:
      'Visually highlight (dim + outline) an element on the page — target it by a qa_snapshot ref (preferred) or a CSS selector — so the human tester can see what the agent is referring to. A non-destructive overlay — it does not click, focus, or modify the element.',
    inputSchema: {
      tabId: tabIdArg,
      selector: z.string().optional().describe('CSS selector of the element to spotlight'),
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred over selector'),
      label: z.string().optional().describe('Optional caption shown on the highlight'),
    },
  },
  async ({ tabId, selector, ref, label }) => {
    try {
      return asText(await callExtension('qa_spotlight', { tabId, selector, ref, label }));
    } catch (e) {
      return asError(e);
    }
  },
);

/* ── Agent control ─────────────────────────────────────────────────────────
 *
 * Everything above this line reads. These three ACT on the app under test, and
 * they are the reason the tester's own login is worth something to an agent: it
 * drives the real, already-authenticated session instead of starting cold.
 *
 * The gate is NOT here. The extension re-checks the `drive` consent on every
 * single call and answers `consent-required`, so nothing this server can be
 * told to do bypasses it — which is also why these tools are safe to advertise
 * unconditionally. It used to re-check a licence beside that consent; from
 * extension 1.72.0 there is no licence, and the consent is the whole gate.
 */

/**
 * A POINT, WHERE THERE IS NO ELEMENT TO NAME.
 *
 * Every other driving verb here names an ELEMENT, and that is deliberate: it is what keeps an
 * agent driving somebody's browser reviewable, and it is what the Web Store single-purpose
 * statement describes. A canvas application does not break that rule, it breaks its PREMISE —
 * Figma, Miro, a map, a chart draw everything inside one `<canvas>`, so there is no node to
 * name and `qa_click` has nothing to aim at. What exists there is a coordinate.
 *
 * Nothing here is remote code and nothing needs a new permission: two numbers and the same
 * event sequence every other verb already sends. The audit trail is kept — the reply says the
 * point, what the browser found there, and what changed after.
 */
server.registerTool(
  'qa_click_point',
  {
    title: 'Click a point on a canvas',
    description:
      'Click at an x,y POINT instead of at an element — for applications that draw their interface inside a canvas, where there is nothing to name: Figma, Miro, maps, charts, diagram and image editors. Everywhere else use qa_click: it names what it pressed, survives a re-render and tells you when it missed, none of which a coordinate can do. ' +
      'Coordinates are CSS pixels from the top-left of the VIEWPORT, not of the page — the same frame a qa_screenshot is taken in, so reading a position off a screenshot works; scroll the target into view first. The reply names the element the browser found under the point, and carries the usual `changed` diff, so you can tell a press that did something from one that landed on empty canvas. ' +
      'HONEST LIMIT, and it is not theoretical: these events carry `isTrusted: false`. Anything that checks it will ignore the click and say nothing — measured on npmjs, where a React checkbox took the synthetic click and reverted it on the next render while a real one held. Canvas applications do not check it, which is why this verb is for them. ' +
      'When a page does check it, the reply carries `realMouse`: how to press the same point with a real click from the operating system (cliclick on macOS, PowerShell or AutoHotkey on Windows, xdotool on Linux) and how to turn this point into a screen one.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      x: z.number().describe('CSS pixels from the LEFT of the viewport'),
      y: z.number().describe('CSS pixels from the TOP of the viewport'),
    },
  },
  async ({ tabId, x, y }) => {
    try {
      return asText(withTrustedNote(await callExtension('qa_click_point', { tabId, x, y }, 20_000)));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_drag_point',
  {
    title: 'Drag from one point to another on a canvas',
    description:
      'Press at one point, move, release at another — the other half of canvas work, and the half a click cannot express: moving a shape, marqueeing a selection, panning, drawing a box, dragging a handle. Without it an agent fakes a drag out of two clicks and changes something nobody asked for. ' +
      'The pointer is moved in STEPS between the two points (12 by default), because a single jump from start to end is not a drag to most canvas code — it tracks the pointer while the button is down, and one giant delta reads as a glitch or as nothing at all. The moves go to the element the drag STARTED on, which is what a browser does once a button is down. ' +
      'Same coordinates and the same honest limit as qa_click_point: CSS pixels from the top-left of the viewport, and `isTrusted: false`.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      x: z.number().describe('Start — CSS pixels from the LEFT of the viewport'),
      y: z.number().describe('Start — CSS pixels from the TOP of the viewport'),
      toX: z.number().describe('End — CSS pixels from the LEFT of the viewport'),
      toY: z.number().describe('End — CSS pixels from the TOP of the viewport'),
      steps: z.number().optional().describe('How many pointermove events to send between the two points (2–60, default 12). More for a canvas that samples the path, fewer for a simple handle.'),
    },
  },
  async ({ tabId, x, y, toX, toY, steps }) => {
    try {
      return asText(withTrustedNote(await callExtension('qa_drag_point', { tabId, x, y, toX, toY, steps }, 25_000)));
    } catch (e) {
      return asError(e);
    }
  },
);

/**
 * HOVER — the state every other verb here passes through and none of them stays in.
 *
 * Asked for by the owner on 17.09.2026 while testing with the bridge, and the gap was real: the
 * only verb that sent a `mouseover` was `qa_click`, which sends a `mousedown` a millisecond
 * later. So a menu that opens on hover was opened and closed by the same call, and a tooltip
 * could not be read at all. Hover is not a weaker click — it is a different state, and a large
 * part of what a tester checks lives only inside it.
 */
server.registerTool(
  'qa_hover',
  {
    title: 'Hover over an element and hold',
    description:
      'Put the pointer on an element AND LEAVE IT THERE, then report what that revealed: a menu that opens on hover, a tooltip, the actions a row only shows under the pointer, the value a chart reads out beneath it. qa_click cannot answer any of those — it presses a millisecond after it hovers, and the press closes what the hover opened. ' +
      'It holds for `holdMs` (500 by default) before measuring, because tooltips wait — measuring at once reports "no tooltip" about one that was always going to appear. The reply carries the usual `changed` diff plus `tooltip` (role=tooltip, aria-describedby or title, whichever exists) and `expanded` when the control changed its aria-expanded. ' +
      'ONE FACT TO READ CAREFULLY: `cssHover` says whether the browser\'s own `:hover` matched. Dispatched events run the page\'s JavaScript handlers — every menu and tooltip library — but they do not move the real cursor, so an effect written PURELY in CSS does not appear and `cssHover` comes back false. That is the tool being honest, not the page being broken. With trusted input switched on the real pointer moves, `cssHover` is true, and CSS-only hovers light up too. ' +
      'Call it again with `off: true` to take the pointer away — "the tooltip disappears" is the other half of the check, and it needs its own call.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      selector: z.string().optional().describe('CSS selector of the element to hover'),
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred over selector'),
      x: z.number().optional().describe('Without ref/selector: CSS pixels from the LEFT of the viewport. WITH one: an offset inside the element, for a chart or a split control where the middle is the wrong place.'),
      y: z.number().optional().describe('Without ref/selector: CSS pixels from the TOP of the viewport. WITH one: an offset inside the element.'),
      holdMs: z.number().optional().describe('How long to hold the pointer there before measuring (0–10000, default 500)'),
      off: z.boolean().optional().describe('Take the pointer AWAY from whatever it is on, and report what was left. No target needed.'),
    },
  },
  async ({ tabId, selector, ref, x, y, holdMs, off }) => {
    try {
      return asText(await callExtension('qa_hover', { tabId, selector, ref, x, y, holdMs, off }, 30_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_click',
  {
    title: 'Click an element',
    description:
      'Click an element on the page under test — by a qa_snapshot ref, by a CSS selector, or by the control\'s accessible `name` (the one to use right after a fill, since filling re-renders the step and staleness is what makes a ref refuse). Sends the full pointer sequence (pointerdown → mouseup → click), so component libraries that listen for pointerdown — Radix, shadcn, MUI — react to it like a real click. Scrolls the element into view first, and refuses a target that matches nothing or has zero size rather than silently doing nothing. Returns what the click CHANGED — what appeared, disappeared or updated once the page settled — so you do not need a follow-up qa_snapshot to find out whether it did anything. `changed: null` means the page did not move, which is itself the answer. On a recent extension build the reply also carries `announced` — what the page\'s live regions (aria-live / role=status / role=alert) actually spoke during the settle window, or null if they stayed silent: a toast that appeared in `changed` but not in `announced` is invisible to a screen reader (WCAG 4.1.3). ' +
      'AND WHEN THE PRESS NAVIGATED there is no diff to give: the reply carries `navigated: <the new url>` instead. That IS what the press did — do not press again, a second one would land on the NEXT page rather than repeat this one. ' +
      'BEFORE READING AN EMPTY DIFF AS A DEAD CONTROL, look for `tab` in the reply: it is there only when this tab was not in front, and `state: "hidden"` means Chrome had stopped painting it, so a popover could not render and nothing on an animation frame ran. Call qa_focus_tab and click again rather than filing anything.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      selector: z.string().optional().describe('CSS selector of the element to click'),
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred over selector; unique where a selector is ambiguous'),
      name: z
        .string()
        .optional()
        .describe(
          'Click the control with THIS accessible name — "Next", "Submit application", "Add member". Use it instead of a ref right after filling: a fill re-renders the page, which makes the ref you took before it stale (the extension refuses a stale ref rather than clicking the wrong thing). This resolves the name against a fresh snapshot, so it cannot go stale.',
        ),
      role: z.string().optional().describe('Narrow a `name` match to one role, e.g. "button", "link", "tab", "radio"'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, selector, ref, name, role, frameId }) => {
    try {
      /* CLICKING BY NAME, and why it belongs in the bridge rather than in the agent's head.
       *
       * Found on the 6-step wizard (2026-07-29): snapshot the step, fill it, click Next — and the
       * click fails with "ref is stale", because filling the step re-rendered it. Every correct
       * fix costs the agent a call it should not need (snapshot again just to re-read a button it
       * already saw), and the wrong fix is to skip the refusal by using a selector, which on a
       * repeated component clicks the wrong control. A name is stable across exactly the
       * re-render that invalidates the ref, so resolve it here, against a fresh snapshot. */
      if (!ref && !selector && name) {
        /* The name is resolved IN THE SAME DOCUMENT the click will land in. Resolving it against
           the top page and then clicking inside a frame would hand the frame a ref that belongs
           to somebody else's snapshot — the renumbering trap, with a document boundary added. */
        const snap = await callExtension('qa_snapshot', { tabId, frameId }, 30_000);
        rememberSnapshot(tabId, snap);
        const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
        const clickable = nodes.filter((n) => (role ? n.role === role : CLICKABLE_ROLES.has(n.role)));
        // Fall back to EVERY node: the thing you click to open a picker is its input (a textbox),
        // and "clickable roles" hid exactly that (found on Ant's DatePicker, 2026-07-29).
        let hit = pickNode(clickable, { name, role }, new Set());
        if (!hit) hit = pickNode(nodes, { name, role }, new Set());
        if (!hit) {
          /* A NAME THAT IS MISSING BECAUSE A MODAL IS OPEN IS NOT A MISSING NAME.
             The list below is then the CONTENTS OF THE POPOVER and nothing else, which reads
             exactly like the app lost its buttons — that misreading is what a tester's whole
             regression run was filed against (13.08.2026). The snapshot tells us when the tree
             was narrowed this way; pass it straight through. */
          return asText({
            ok: false,
            error: snap?.modal
              ? `nothing clickable is called "${name}" — but a modal layer ("${snap.modal.name || snap.modal.role}") is open and the rest of the page is hidden behind it`
              : `nothing clickable is called "${name}"`,
            ...(snap?.modal ? { modal: snap.modal } : {}),
            clickableOnThePage: nodes.filter((n) => CLICKABLE_ROLES.has(n.role) && n.name).map((n) => `${n.role} "${n.name}"`).slice(0, 30),
          });
        }
        ref = hit.node.ref;
      }
      const res = await callExtension('qa_click', { tabId, selector, ref, frameId });
      // A click is what ends a wizard step, so the journal treats it as the step's `advance`
      // when a recipe is saved later. See stepsFromJournal.
      note('click', tabId, [targetOf(tabId, ref, selector)]);
      return asText(await withVerdict(res, tabId, 'click'));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_type',
  {
    title: 'Set a field to a value — any kind of field',
    description:
      'Put a value into ONE control, whatever kind it is — target it by a qa_snapshot ref (preferred) or a CSS selector. ' +
      'This is not a keystroke emulator, it is the extension\'s own fill engine, the same one behind the ⚡Fill button, so "typing" works on far more than text boxes: ' +
      'text/number/date inputs and textareas (native value setter + InputEvent, so React/Vue controlled inputs keep the value), native <select> (your text is matched against the option labels), checkboxes and radios (a truthy value checks it, with a real click so the app\'s listeners run), ' +
      'CUSTOM SELECTS and typeahead comboboxes (Radix/shadcn, MUI, Ant, react-select, Downshift — it opens the popover, waits for the options, picks the one matching your value and verifies the trigger actually changed), POPUP DATE & TIME PICKERS (opens the calendar and picks a day), sliders, and contenteditable rich text. ' +
      'A file field takes the neutral Qiksy test file matched to its `accept` — use qa_upload when the bytes matter. ' +
      'So do NOT click a dropdown open, snapshot to read its options and click one: name the field and the value you want. Only fall back to the click path when this answers ok:false. ' +
      'Reports back whether the value stuck, so a masked or read-only field is visible to you rather than silently ignored. ' +
      'WHAT `stuck: true` DOES NOT PROMISE: it says the DOM kept the value, not that the app took it. When the tab is not in front the reply therefore also carries `tab` — `state: "hidden"` (another tab is active, so Chrome is not painting it and a popover will not render) or `state: "unfocused"` (the window is behind another application, so anything that commits on real focus or blur never gets it). It is a caveat and not a refusal: the fill still happened. If the answer matters, call qa_focus_tab and do it again.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      selector: z.string().optional().describe('CSS selector of the field'),
      ref: z.string().optional().describe('A ref from qa_snapshot (e.g. "e12") — preferred over selector; unique where a selector is ambiguous'),
      name: z
        .string()
        .optional()
        .describe("The field's accessible name — resolved against a snapshot taken right now, so it survives the re-render that invalidates a ref. Use it for a field you are re-filling after something else changed."),
      value: z.string().optional().describe('The value you want: text, an option label for a select or combobox, a truthy/falsy word for a checkbox, a number for a slider'),
      text: z.string().optional().describe('Same as `value`, under the name a model reaches for when the job is "type this text".'),
      raw: z
        .boolean()
        .optional()
        .describe(
          'WRITE THE TEXT VERBATIM and pick nothing — the fast route through a composite widget. Every date, time, range, tags field and searchable select in Ant Design, MUI and react-datepicker has its own text input and takes the value in the format it DISPLAYS ("06/11/2024", "14:30", the option text); typing it costs under half a second where driving the popup costs 7 to 35 seconds (measured on a live stand). Use it when you already know the value. Leave it off when the widget itself is what you are testing: the default path opens the popover the way a user would, and converts a date-ish value to ISO, which is right for <input type=date> and wrong for a component whose format is DD/MM/YYYY.',
        ),
      commit: z.string().optional().describe('With `raw`: the key that commits the value, default "Enter". Pass an empty string for none.'),
      blur: z.boolean().optional().describe('With `raw`: move focus away afterwards. Some controls keep a typed value only once focus LEAVES — a tags field is the usual one.'),
      open: z.boolean().optional().describe('With `raw`: click the control first. A select filters only while its list is open, so typing into a closed one leaves it empty while looking filled.'),
      pick: z.boolean().optional().describe('With `raw`: after writing the text, CLICK the option whose text matches it — the other half of the fast route for a select, because the text only filters and something still has to choose the row.'),
      pickMs: z.number().optional().describe('With `pick`: how long to wait for that option, default 1200. It returns the moment the option appears.'),
      settleMs: z.number().optional().describe('With `raw`: the cap on waiting for an option before the commit key. A select fed by a request needs ~900; a date parses its own text and needs none.'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, selector, ref, name, value, text, raw, commit, blur, open, pick, pickMs, settleMs, frameId }) => {
    try {
      /* `value` used to be required, so a call with `text` died in schema validation as a bare
         "Required at value" before reaching the page (ChatGPT composer, 04.11.2026) and the agent
         went looking for another way in. Both names are accepted now; neither is a plain answer. */
      if (value === undefined) value = text;
      if (value === undefined) return asText({ ok: false, error: 'no value: pass the text to put into the field as `value`, e.g. qa_type { ref: "e12", value: "Hello" }' });
      if (!ref && !selector && name) {
        const snap = await snapshotUntrapped(tabId, name, frameId);
        rememberSnapshot(tabId, snap);
        const hit = pickNode(Array.isArray(snap?.nodes) ? snap.nodes : [], { name }, new Set(), { fieldsOnly: true });
        if (!hit) return asText({ ok: false, error: `no field is called "${name}"`, fieldsOnThePage: (snap?.nodes || []).filter((n) => isFieldNode(n) && n.name).map((n) => n.name).slice(0, 40) });
        ref = hit.node.ref;
      }
      /* EVERY fast-route key has to be declared above or Zod strips it silently — that trap cost three
         separate measurements today, each of them looking like the feature simply did not work. It
         then cost a fourth, on Stripe (06.10.2026): `frameId` was declared on qa_read and qa_styles
         only, so a call aimed at the card field inside js.stripe.com lost the address here and ran
         against the top document, where that selector honestly does not exist. Reading into a frame
         worked, driving into one could not — and nothing said so. */
      const res = await callExtension('qa_type', {
        tabId, selector, ref, value, frameId,
        ...(raw ? { raw: true, ...(commit === undefined ? {} : { commit }), ...(blur ? { blur: true } : {}), ...(open ? { open: true } : {}), ...(pick ? { pick: true } : {}), ...(pickMs === undefined ? {} : { pickMs }), ...(settleMs === undefined ? {} : { settleMs }) } : {}),
      });
      note('fill', tabId, [targetOf(tabId, ref, selector, { value, action: 'type' })]);
      return asText(await followAfter(res, tabId, 'type'));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_type_many',
  {
    title: 'Fill a whole step in one call — every kind of field',
    description:
      'Fill an ENTIRE form (or one step of a wizard) in ONE call instead of a round-trip per field: pass an array of { ref | selector, value, action? }. ' +
      'EVERY control kind qa_type drives goes in the same batch — custom selects and typeahead comboboxes (Radix/shadcn, MUI, Ant, react-select), popup date & time pickers, native selects, checkboxes, radios, sliders, rich text, plain inputs. ' +
      'A batch of ten fields where six are dropdowns and dates is the NORMAL use of this tool, not an edge case, and it is the difference between one call and thirty. ' +
      'They are filled in order and strictly one at a time (two open popovers break each other), so a step with several custom widgets still takes a few seconds of real waiting — that part is the widgets, not the round trip. ' +
      'PREFER `ref` from qa_snapshot: a form built from a repeated component gives several inputs the identical cssPath, and a batch of selectors would then pour every value into the first match. ' +
      'Returns a per-field result list plus filled/total; a field that came back ok:false is the only one worth a follow-up call. ' +
      'File fields are the one thing that belongs elsewhere — qa_upload takes files[] and attaches several in one round trip.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      fields: z
        .array(
          z.object({
            ref: z.string().optional().describe('A ref from qa_snapshot — REQUIRED when several fields share one cssPath, which is common on forms built from a repeated component'),
            selector: z.string().optional().describe('CSS selector of the field — use `ref` instead when the selector is not unique'),
            value: z
              .string()
              .optional()
              .describe('The value you want: text, an option label for a native OR custom select / combobox, a truthy word for a checkbox, a number for a slider. A date picker opens and picks for you.'),
            text: z.string().optional().describe('Same as `value`.'),
            action: z.enum(['type', 'click']).optional().describe('Default "type" — which already covers selects, comboboxes, pickers, checkboxes and radios. Use "click" only for a button or a link.'),
            raw: z
              .boolean()
              .optional()
              .describe(
                'WRITE THE TEXT VERBATIM into this field and pick nothing — the fast route. Every composite in Ant Design, MUI and react-datepicker has a text input that takes the value in the format it DISPLAYS ("06/11/2024", "14:30", the option text), and a raw write costs milliseconds where driving its popup costs seconds. Raw entries in a batch also go in ONE pass instead of one-by-one, because they open nothing that could collide.',
              ),
            commit: z.string().optional().describe('With `raw`: the key that commits the value, default "Enter". Pass an empty string for a plain input, where Enter would submit the form.'),
            blur: z.boolean().optional().describe('With `raw`: move focus away afterwards — a tags field keeps its value only once focus leaves.'),
            settleMs: z
              .number()
              .optional()
              .describe('With `raw`: how long to WAIT FOR AN OPTION before pressing the commit key — a cap, not a sleep. A select whose options arrive from a request needs ~900; a date parses its own text and needs none.'),
            open: z.boolean().optional().describe('With `raw`: click the control first. A select filters only while its list is open, so typing into a closed one leaves the field empty while looking filled.'),
            pick: z.boolean().optional().describe('With `raw`: after writing the text, CLICK the option whose text matches it. The other half of the fast route for a select — the text only filters, and something still has to choose the row.'),
            pickMs: z.number().optional().describe('With `pick`: how long to wait for that option, default 1200. It returns the moment the option appears, so a generous cap costs nothing.'),
          }),
        )
        .describe('The fields to fill, in order — put the whole step in here'),
    },
  },
  async ({ tabId, fields }) => {
    try {
      // An undeclared key is stripped, so `text` left the field empty while the batch reported it filled.
      fields = (fields || []).map(({ text, ...f }) => (f.value === undefined && text !== undefined ? { ...f, value: text } : f));
      const res = await callExtension('qa_type_many', { tabId, fields }, 45_000);
      note(
        'fill',
        tabId,
        (fields || []).map((f) => targetOf(tabId, f.ref, f.selector, { value: f.value, action: f.action === 'click' ? 'click' : 'type' })),
      );
      return asText(await followAfter(res, tabId, 'type_many'));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_press',
  {
    title: 'Press a key',
    description:
      'Dispatch a keyboard key (keydown/keypress/keyup) — Enter to submit, Escape to close, Tab to move focus. Without a selector it goes to whatever currently has focus, like a real keyboard. Like qa_click, it returns what changed once the page settled. On a recent extension build the reply also carries `focus` — the element that ACTUALLY holds focus after the key (name, role, selector, box), which is how you follow a Tab route or catch focus landing somewhere unnamed — and `announced`, what the live regions spoke (null = they stayed silent).' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      key: z.string().describe('Key value, e.g. "Enter", "Escape", "Tab", "a"'),
      selector: z.string().optional().describe('Optional target (CSS); defaults to the focused element'),
      ref: z.string().optional().describe('Optional target (a qa_snapshot ref); defaults to the focused element'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, key, selector, ref, frameId }) => {
    try {
      return asText(await withVerdict(await callExtension('qa_press', { tabId, key, selector, ref, frameId }), tabId, 'press'));
    } catch (e) {
      return asError(e);
    }
  },
);

/* ── Chaining across pages and roles ───────────────────────────────────────
 *
 * A submit replaces the document, and with it the Qiksy instance the previous
 * call was talking to. `qa_wait_ready` is the join point: it returns only once a
 * FRESH Qiksy answers in the new page, which is what makes fill → submit → act on
 * the next page a reliable chain instead of a race.
 *
 * Doing the same flow as another user is then just a different tabId:
 * `qa_open_isolated` gives you a tab with its own empty session (multi-login), and
 * every tool already accepts `tabId`.
 */
server.registerTool(
  'qa_wait_ready',
  {
    title: 'Wait for the page to be ready',
    description:
      'Block until the tab has finished loading AND Qiksy is live in the new document. Call this after anything that navigates — a submit, a link click, qa_navigate — before the next qa_type/qa_click, or the call lands on a page that is still being replaced. Read-only: waiting is not acting, so this needs no Pro and no consent.',
    inputSchema: {
      tabId: tabIdArg,
      timeoutMs: z.number().optional().describe('How long to wait, default 15000, max 60000'),
    },
  },
  async ({ tabId, timeoutMs }) => {
    try {
      return asText(await callExtension('qa_wait_ready', { tabId, timeoutMs }, 65_000));
    } catch (e) {
      return asError(e);
    }
  },
);

/*
 * WAIT — the verb whose absence was the only reason to leave this bridge for another driver
 * where the cause is neither of the two genuine absences (pixels, eval).
 *
 * Every settle window in the extension is bounded and short: an action gets 350ms of quiet and
 * is given up on at 2500 whatever happens, and only click and press get even that. A
 * confirmation that lands after six seconds is invisible to every other verb, so the agent
 * polls qa_snapshot — and each snapshot RENUMBERS every ref, so the poll costs context and the
 * identity of everything it was holding.
 *
 * TWO HALVES, IN TWO PLACES, AND THE SPLIT IS NOT ARBITRARY. `urlContains` is answered by the
 * service worker, because a navigation destroys the content script exactly when the thing it
 * waits for happens. Every other condition is about the document and is answered there, by a
 * MutationObserver — not a poll: a background tab is this product's main scenario and Chrome
 * clamps timers there to a second or more, while observers fire on the change itself.
 *
 * TWO CONDITIONS ARE DELIBERATELY MISSING. "Until quiet" is what every action already does by
 * default. "Until the network is idle" would measure the page's own fetch/XHR in the top frame
 * and nothing else — a number that does not mean what its name says is worse than no number.
 */
server.registerTool(
  'qa_wait_for',
  {
    title: 'Wait for a condition',
    description:
      'Wait until the page satisfies ONE named condition, then return — instead of polling qa_snapshot, which renumbers every ref each time it is called. ' +
      'Conditions: `appears` / `disappears` / `enabled` (each takes an accessible name OR a CSS selector) · `text` / `textGone` (anywhere on the page) · `countOf` a selector with `atLeast` or `exactly` · `announced` (what the page said through a live region — pass a string to wait for one containing it, or true for any) · `urlContains`. ' +
      'Use it after anything whose answer arrives later than a click settles: an order confirmation, a slow save, a list that repopulates, a button that ungreys when validation finishes. ' +
      'A condition already true when you call returns immediately. ' +
      'ON TIMEOUT IT SAYS WHAT IT SAW — how many matched, how many were visible, the nearest names on the page, and anything announced — so a wait that failed on a typo tells you so instead of just running out. ' +
      'A SIGN-IN IS WHAT THIS IS FOR, MORE THAN ANYTHING ELSE. When the site hands over to a password, a code from a phone or a hardware key, that step is the person\'s — do not drive it and do not call it a failure. Tell them to sign in, then `qa_wait_for { urlContains: "<the site you came from>", timeoutMs: 180000 }`: it is answered by the extension, so it survives the navigation, and if the tab never moves at all it says THAT instead of just running out. Up to 300000 ms is real: the wait runs in slices and keeps the call alive. If it still comes back with `stillWaiting`, call it again with the same arguments; never ask the person to write that they are done. ' +
      'Read-only: waiting is not acting, so this needs no consent — the same footing as qa_wait_ready. ' +
      'There is no "until quiet" (that is what every action already does) and no "until the network is idle" (the interceptor sees only the page\'s own fetch/XHR in the top frame, so the number would not mean what its name says).',
    inputSchema: {
      tabId: tabIdArg,
      appears: z.string().optional().describe('Wait until this appears — accessible name or CSS selector'),
      disappears: z.string().optional().describe('Wait until this is gone — accessible name or CSS selector'),
      enabled: z.string().optional().describe('Wait until this control stops being disabled'),
      text: z.string().optional().describe('Wait until this text is anywhere on the page'),
      textGone: z.string().optional().describe('Wait until this text is no longer on the page'),
      countOf: z.string().optional().describe('CSS selector to count — pair with atLeast or exactly'),
      atLeast: z.number().optional().describe('With countOf: wait until at least this many match (default 1)'),
      exactly: z.number().optional().describe('With countOf: wait until exactly this many match'),
      announced: z.union([z.string(), z.boolean()]).optional().describe('Wait until a live region speaks — a string waits for one containing it, true for any'),
      urlContains: z.string().optional().describe('Wait until the tab address contains this. Answered by the extension itself, so it survives the navigation it is waiting for.'),
      timeoutMs: z.number().optional().describe('Give up after this long (default 15000, max 60000 — or up to 300000 with urlContains, which is how you wait for a person to sign in)'),
    },
  },
  async (args, extra) => {
    try {
      if (typeof args?.urlContains === 'string' && args.urlContains) return asText(await waitForAddress(args, extra));
      return asText(await callExtension('qa_wait_for', args, Math.min(70_000, (Number(args?.timeoutMs) || 15_000) + 10_000)));
    } catch (e) {
      return asError(e);
    }
  },
);

/* THE SIGN-IN WAIT WAS CUT AT SEVENTY SECONDS BY US (03.11.2026). The description promised five
 * minutes and the extension honours five, but this handler capped the round trip at 70 s, so
 * `timeoutMs: 300000` ended with «Timed out after 70000ms» while the person was still typing a
 * code — and the agent then asked them to write «done». The wait now runs in slices the extension
 * answers well inside any client's patience, with a progress beat between them so a client that
 * resets its timer on progress keeps the call open, and a reply that still has not seen the
 * address says how to go on rather than just stopping. */
const WAIT_SLICE_MS = Number(process.env.QIKSY_WAIT_SLICE_MS) || 45_000; // the stand shortens it
const SIGN_IN_WAIT_MAX_MS = 300_000;
async function waitForAddress(args, extra) {
  const total = Math.min(SIGN_IN_WAIT_MAX_MS, Math.max(500, Number(args.timeoutMs) || 15_000));
  const t0 = Date.now();
  const token = extra?._meta?.progressToken;
  const beat = token && typeof extra?.sendNotification === 'function'
    ? setInterval(() => {
        extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: Math.min(Date.now() - t0, total), total, message: `waiting for the address to contain "${args.urlContains}"` },
        }).catch(() => {});
      }, 10_000)
    : null;
  let last = null;
  let moved = false;
  try {
    for (;;) {
      const slice = Math.min(WAIT_SLICE_MS, Math.max(500, total - (Date.now() - t0)));
      const s0 = Date.now();
      last = await callExtension('qa_wait_for', { ...args, timeoutMs: slice }, slice + 15_000);
      if (last?.ok) return { ...last, waitedMs: Date.now() - t0 };
      if (last?.movedMeanwhile) moved = true;
      if (Date.now() - t0 >= total - 250) break;
      /* A slice that came back well before its time was not a wait running out (the tab closed,
         the page refused): asking again would spin, so its answer is the answer. */
      if (last?.error || Date.now() - s0 < slice - 2_000) return last;
    }
  } finally {
    if (beat) clearInterval(beat);
  }
  return {
    ...last,
    waitedMs: Date.now() - t0,
    movedMeanwhile: moved,
    ...(moved && !last?.movedMeanwhile
      ? { note: `the address never contained "${args.urlContains}", but the tab DID move during the wait — somebody is working in it. Look at the address above before deciding anything went wrong.` }
      : {}),
    stillWaiting: `If a person is signing in, they may simply not be done: call qa_wait_for again with the same arguments instead of asking them to tell you.`,
    nextCall: { tool: 'qa_wait_for', args: { ...args } },
  };
}

/* ── FOLLOW: one wizard, one run, no stop after every step ─────────────────
 *
 * Owner, 10.11.2026, after a Meta developer sign-up: «каждый шаг ты просто останавливался… чтобы
 * бридж, если многостеповая операция, следил за тобой и подсказывал, не выключался… пока не дашь
 * новую задачу». What the run looked like: every wizard step was a click, then a qa_read or a
 * qa_snapshot to learn what had opened; a click that started a page load made the next read refuse
 * until somebody thought of qa_wait_ready; a sign-in wait ran out; and every reply repeated the same
 * paragraph about the tab being hidden. Each of those is a place where an agent pauses, and a
 * paused agent reports to the person, who then waits for the agent.
 *
 * So while a follow is on, every acting verb on that tab comes back with the STEP it led to: the
 * page is waited for (a navigation to load, a still-arriving page to stop growing), and the reply
 * carries where the wizard is, what changed since the last step, what is left to fill, which
 * buttons are live and whether the next move is the PERSON's. The person's moves (a password, a
 * code from a phone, a captcha) are waited for by `waitForPerson`, which watches the page itself
 * rather than an address, because a code step usually changes the page without changing the URL.
 *
 * One follow per server process: one agent window drives one task. A new qa_follow replaces it,
 * qa_done ends it. */
let following = null;
/* One typed field is not a step, and reading the page after each of twenty would make a form slow
   for no answer; the press that follows it is the step. */
const FOLLOW_ACTING = new Set(['click', 'press', 'type_many', 'fill', 'navigate', 'upload']);
const PERSON_FIELD = /pass(word|code)?|пароль|парол|\bcode\b|код|verification|verify|one.?time|otp|2fa|two.?factor|security code|captcha|подтвержд|підтвердж/i;
const STEP_OF = /(?:step|шаг|крок|etap|paso|schritt|étape)\s*(\d+)\s*(?:of|из|з|z|de|von|sur|\/)\s*(\d+)/i;

async function followSnap(tabId) {
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
  rememberSnapshot(tabId, snap);
  return snap;
}

/** A page still being built is a different page from the one it becomes, so the step is read
 *  only once two looks a beat apart agree on how many controls there are — and a page with not
 *  one button or field is not a step at all yet, however still it holds: a shell that has drawn
 *  its heading and is fetching the rest looks perfectly calm for a second. */
async function settledSnap(tabId) {
  const controls = (s) => (Array.isArray(s?.nodes) ? s.nodes.filter((n) => n.role === 'button' || isFieldNode(n)).length : 0);
  let prev = await followSnap(tabId);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, i ? 900 : 600));
    const next = await followSnap(tabId);
    const a = prev?.nodes?.length || 0;
    const b = next?.nodes?.length || 0;
    prev = next;
    if (Math.abs(b - a) <= Math.max(2, a * 0.1) && controls(next) > 0) break;
  }
  return prev;
}

function stepOf(snap) {
  const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  const st = (n) => String(n.state || '');
  const headings = nodes.filter((n) => n.role === 'heading' && n.name).map((n) => n.name.trim().slice(0, 100)).slice(0, 4);
  let progress = null;
  for (const n of nodes) {
    const m = STEP_OF.exec(n.name || '');
    if (m) {
      progress = `step ${m[1]} of ${m[2]}`;
      break;
    }
  }
  if (!progress) {
    const cur = nodes.find((n) => /current=step/.test(st(n)) && n.name);
    if (cur) progress = `current step: ${cur.name.slice(0, 60)}`;
  }
  const fields = nodes
    /* A nameless listbox or combobox is the inside of some widget, not a field a step asks for;
       a nameless TEXT box stays, because an unlabelled field is still one somebody must fill. */
    .filter((n) => isFieldNode(n) && !/hidden/.test(st(n)) && n.role !== 'listbox' && (n.name || /textbox|searchbox/.test(n.role)))
    .map((n) => ({
      name: (n.name || '').slice(0, 60),
      ref: n.ref,
      role: n.role,
      ...(n.value ? { value: String(n.value).slice(0, 40) } : {}),
      ...(/required/.test(st(n)) ? { required: true } : {}),
      ...(/invalid/.test(st(n)) ? { invalid: true } : {}),
      ...(/disabled/.test(st(n)) ? { disabled: true } : {}),
    }))
    .slice(0, 25);
  const buttons = nodes
    .filter((n) => n.role === 'button' && n.name)
    .map((n) => ({ name: n.name.trim().slice(0, 60), ref: n.ref, ...(/disabled/.test(st(n)) ? { disabled: true } : {}) }))
    .slice(0, 20);
  const errors = [
    ...nodes.filter((n) => (n.role === 'alert' || n.role === 'alertdialog') && n.name).map((n) => n.name.trim().slice(0, 160)),
    ...fields.filter((f) => f.invalid).map((f) => `field «${f.name}» is marked invalid`),
  ].slice(0, 8);
  const person = nodes.filter(
    (n) => (isFieldNode(n) && PERSON_FIELD.test(`${n.name || ''} ${n.selector || ''}`)) || (/frame/.test(n.role || n.tag || '') && /captcha/i.test(n.name || '')),
  );
  return {
    url: snap?.url,
    ...(headings.length ? { headings } : {}),
    ...(progress ? { progress } : {}),
    ...(snap?.modal ? { modal: snap.modal.name || snap.modal.role } : {}),
    fields,
    buttons,
    ...(errors.length ? { errors } : {}),
    ...(person.length ? { personNeeded: person.map((n) => n.name || n.role).slice(0, 3), personRef: person[0].ref } : {}),
  };
}

/** What moved since the step before — the line an agent would otherwise get from reading twice. */
function stepChanges(prev, now) {
  if (!prev) return null;
  const out = [];
  if (prev.url !== now.url) out.push(`address is now ${now.url}`);
  if (prev.progress !== now.progress && now.progress) out.push(`wizard moved: ${now.progress}`);
  if ((prev.headings || [])[0] !== (now.headings || [])[0] && now.headings?.[0]) out.push(`new heading «${now.headings[0]}»`);
  const wasOff = new Set(prev.buttons.filter((b) => b.disabled).map((b) => b.name));
  for (const b of now.buttons) if (!b.disabled && wasOff.has(b.name)) out.push(`button «${b.name}» became active`);
  const oldErr = new Set(prev.errors || []);
  for (const e of now.errors || []) if (!oldErr.has(e)) out.push(`error appeared: ${e}`);
  for (const e of prev.errors || []) if (!(now.errors || []).includes(e)) out.push(`error gone: ${e}`);
  if (!prev.personNeeded && now.personNeeded) out.push('the page now asks the PERSON for something');
  if (prev.personNeeded && !now.personNeeded) out.push('the person\'s step is done');
  return out.length ? out : ['nothing visible changed since the last step'];
}

function stepAdvice(step) {
  if (step.personNeeded) {
    return {
      yourMove: `THIS STEP IS THE PERSON'S (${step.personNeeded.join(', ')}). Do not type it and do not stop: tell them in one line, in their language, what to do, and in the SAME turn call the nextCall below. It returns by itself the moment the page moves on.`,
      nextCall: { tool: 'qa_follow', args: { waitForPerson: '<one short line for the person, in their language>' } },
    };
  }
  if (step.errors?.length) return { yourMove: 'The page shows an error (see `errors`). Fix the field it names and go on; do not report back unless you cannot.' };
  const empty = step.fields.filter((f) => !f.value && !f.disabled);
  const live = step.buttons.filter((b) => !b.disabled).map((b) => b.name);
  return {
    yourMove:
      (empty.length ? `Fill what this step needs (qa_fill_json with field names), ` : '') +
      `then press the button that advances (${live.slice(0, 6).map((n) => `«${n}»`).join(', ') || 'none is active yet'}). Keep going: the reply to that press is the next step. Report to the person when the whole task is done or when a decision is genuinely theirs.`,
  };
}

async function readFollowStep(tabId, f) {
  const snap = await settledSnap(tabId);
  const step = stepOf(snap);
  const changes = stepChanges(f.last, step);
  f.last = step;
  f.steps++;
  return { ...step, stepNumber: f.steps, ...(changes ? { changes } : {}), goal: f.goal, ...stepAdvice(step) };
}

/** Runs after every acting verb. Off, or on another tab, it is the identity. */
async function followAfter(res, tabId, verb) {
  const f = following;
  if (!f || !FOLLOW_ACTING.has(verb) || !res || typeof res !== 'object' || res.ok === false) return res;
  if (tabId != null && f.tabId != null && Number(tabId) !== f.tabId) return res;
  const id = tabId ?? f.tabId;
  if (res.navigated || verb === 'navigate') await callExtension('qa_wait_ready', { tabId: id, timeoutMs: 20_000 }, 25_000).catch(() => null);
  let out = res;
  /* The hidden-tab paragraph is right the first time and noise the fifth: a follow keeps the
     state on every reply and the explanation on the first. */
  if (res.tab?.state) {
    out = f.tabSaid ? { ...res, tab: { inFront: false, state: res.tab.state } } : res;
    f.tabSaid = true;
  }
  const step = await readFollowStep(id, f).catch((e) => ({ unreadable: String(e?.message || e) }));
  return { ...out, step };
}

/** A signature of what the person can change: the address, the heading, which fields are there
 *  and whether the page still asks them for something. Typing into a field does not change it. */
const personSig = (s) => [s.url, (s.headings || [])[0], s.fields.map((f) => f.name).join('|'), s.personNeeded ? 1 : 0, s.progress].join('§');

const PERSON_WAIT_MAX_MS = 900_000;
async function waitForPerson(f, hint, timeoutMs, extra) {
  const total = Math.min(PERSON_WAIT_MAX_MS, Math.max(5_000, Number(timeoutMs) || 300_000));
  const t0 = Date.now();
  const start = stepOf(await followSnap(f.tabId));
  const sig0 = personSig(start);
  /* Show the person where to look, on the page they are looking at. Best effort: a spotlight on
     a tab nobody is looking at is harmless and a refusal here must not end the wait. */
  if (typeof hint === 'string' && hint.trim()) {
    const target = start.personRef || start.fields.find((x) => !x.value)?.ref;
    if (target) await callExtension('qa_spotlight', { tabId: f.tabId, ref: target, label: hint.trim().slice(0, 200) }, 10_000).catch(() => {});
  }
  const token = extra?._meta?.progressToken;
  const beat = token && typeof extra?.sendNotification === 'function'
    ? setInterval(() => {
        extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: Math.min(Date.now() - t0, total), total, message: 'waiting for the person to finish their step' },
        }).catch(() => {});
      }, 10_000)
    : null;
  try {
    let changedAt = 0;
    while (Date.now() - t0 < total) {
      await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
      const now = await followSnap(f.tabId).then(stepOf).catch(() => null);
      if (!now) continue; // the page is between documents — that is the person moving, look again
      if (personSig(now) === sig0) {
        changedAt = 0;
        continue;
      }
      // Changed: wait one more look, so a page in the middle of replacing itself is not the answer.
      if (!changedAt) {
        changedAt = Date.now();
        continue;
      }
      return { ok: true, personDone: true, waitedMs: Date.now() - t0, step: await readFollowStep(f.tabId, f) };
    }
  } finally {
    if (beat) clearInterval(beat);
  }
  return {
    ok: false,
    waitedMs: Date.now() - t0,
    stillWaiting: 'The page has not moved yet; the person may simply not be done. Call the nextCall again in the same turn — do not ask them to write that they finished.',
    nextCall: { tool: 'qa_follow', args: { waitForPerson: true, timeoutMs: total } },
  };
}
const FOLLOW_POLL_MS = Number(process.env.QIKSY_FOLLOW_POLL_MS) || 2_500; // the stand shortens it

server.registerTool(
  'qa_follow',
  {
    title: 'Follow a multi-step task',
    description:
      'Turn this on at the START of anything with several steps — a sign-up, a wizard, creating an app in a developer console, a checkout. From then on every click, key, fill, type, upload and navigation on that tab answers with the STEP IT LED TO: the page is waited for until it stops loading, and the reply carries `step` — where the wizard is (`progress`), what changed since the last step (`changes`: a button became active, an error appeared, a new heading), the fields still to fill, the live buttons, and `yourMove`. No qa_snapshot, qa_read or qa_wait_ready between steps: the reply to the press IS the next step, so keep going instead of stopping to report after each one. ' +
      'WHEN THE STEP IS THE PERSON\'S — a password, a code from their phone or mail, a captcha — the step says `personNeeded`. Tell them in one line, then call `qa_follow { waitForPerson: "<that line, in their language>" }` in the same turn: the line is shown on the page beside the field, and the call returns by itself the moment the page moves on (up to 15 minutes; `stillWaiting` means call it again — never ask them to write that they are done). ' +
      'It stays on until qa_done or `off: true`; a new qa_follow with another goal replaces it. Reading only: following needs no consent, the acting verbs keep their own gate.',
    inputSchema: {
      tabId: tabIdArg,
      goal: z.string().optional().describe('The whole task in one line, e.g. "create a Meta app for Shelf and copy its App ID". It rides every step so the end of the task stays in view.'),
      waitForPerson: z
        .union([z.string(), z.boolean()])
        .optional()
        .describe('Wait until the PERSON finishes their step and the page moves on. A string is shown to them on the page next to the field — write it in their language; `true` waits without showing anything (use it when calling again after stillWaiting).'),
      timeoutMs: z.number().optional().describe('With waitForPerson: how long to wait, default 300000, max 900000'),
      off: z.boolean().optional().describe('Stop following'),
    },
  },
  async ({ tabId, goal, waitForPerson: person, timeoutMs, off }, extra) => {
    try {
      if (off) {
        const was = following;
        following = null;
        return asText({ ok: true, following: false, ...(was ? { steps: was.steps, goal: was.goal } : {}) });
      }
      if (!following || (tabId != null && following.tabId !== Number(tabId)) || (goal && goal !== following.goal)) {
        let id = tabId != null ? Number(tabId) : null;
        if (id == null) {
          const list = await callExtension('qa_tabs', {}, 15_000);
          id = (list?.tabs || []).find((t) => t.active)?.tabId ?? null;
          if (id == null) return asText({ ok: false, error: 'no active tab to follow — pass tabId from qa_tabs, or open the page with qa_open_tab first' });
        }
        following = { tabId: id, goal: goal || following?.goal || null, steps: 0, last: null, tabSaid: false, since: Date.now() };
      }
      if (person) return asText(await waitForPerson(following, person, timeoutMs, extra));
      return asText({ ok: true, following: true, tabId: following.tabId, step: await readFollowStep(following.tabId, following) });
    } catch (e) {
      return asError(e);
    }
  },
);

/* THE FULL MANUAL ON DEMAND — the half of the instructions no client is guaranteed to deliver. */
server.registerTool(
  'qa_help',
  {
    title: 'The full Qiksy manual',
    description:
      'The full manual of this bridge: every verb, the ladder for a control that refuses a value, forms in one call, the fast `raw` route, widget verdicts, recipes and suites, mocks, native dialogs, isolated logins, reports, tabs and sign-in. ' +
      'The instructions you received at connect are the short version, and some clients cut even those. Call this when you are not sure which verb fits, or before a long form-heavy or multi-login task. ' +
      'Pass `topic` (a word such as "form", "recipe", "mock", "dialog", "sign", "tab", "widget", "screenshot") to get only the paragraphs that mention it. Free and read-only.',
    inputSchema: {
      topic: z.string().optional().describe('Return only the paragraphs mentioning this word; omit for the whole manual'),
    },
  },
  async ({ topic } = {}) => {
    const want = String(topic || '').trim().toLowerCase();
    if (!want) return { content: [{ type: 'text', text: MANUAL }] };
    const hits = MANUAL.split(/\n\s*\n/).filter((p) => p.toLowerCase().includes(want));
    const text = hits.length
      ? hits.join('\n\n')
      : `Nothing in the manual mentions "${topic}". Here is all of it:\n\n${MANUAL}`;
    return { content: [{ type: 'text', text }] };
  },
);

/*
 * A PICTURE — and the honest history of why there was not one.
 *
 * "Measurements, but no image" has been this bridge's stated boundary from the start, and it was
 * true of the BRIDGE only. The product has taken screenshots since v0.1: the History thumbnails,
 * the 📷 on a finding, the pictures inside a Bug Capsule — and qa_report has been handing them to
 * agents all along, as base64 inside an HTML string nobody could look at. What was missing was a
 * verb that returns a picture AS a picture.
 *
 * ONE LIMIT IS REAL AND STAYS: the browser photographs the window's ACTIVE tab, so a background
 * tab cannot be photographed, and the extension refuses rather than quietly photographing
 * whichever tab IS in front — that would hand over a page nobody asked about. Driving a
 * background tab is this product's whole point, so this is the one verb that needs the human to
 * be looking at what is being tested.
 */
server.registerTool(
  'qa_screenshot',
  {
    title: 'Screenshot the page or one element',
    description:
      'Take a real picture of the page under test, or of ONE element, and hand it back as an image you can look at — not as measurements. ' +
      'Use it for the questions geometry cannot answer: does this look right, is the shadow there, is the text legible on that background, what does the tester actually see. ' +
      'Pass `ref` or `selector` to crop to one element (with a little padding); omit both for the visible page. ' +
      'Pass `full: true` for THE WHOLE PAGE top to bottom, however long it is — the page is scrolled, photographed a screenful at a time and stitched into one picture, with a sticky header kept once rather than printed down the side. That is usually what a human means by "show me the page", and the visible-area shot answers a different question. It takes a second or so per screenful and cannot be combined with `ref`/`selector`. ' +
      'The Qiksy panel is hidden and password and card fields are covered BEFORE the frame is taken, so a screenshot pasted into a ticket carries no secret. ' +
      'THE TAB MUST BE IN FRONT: the browser photographs the window\'s active tab, and Qiksy refuses to photograph a different one rather than hand you a page you did not ask about — call qa_focus_tab first if you have been driving a background tab. ' +
      'A PICTURE OF THE PAGE IS NOT A PICTURE OF THE PERSON\'S SCREEN: when Chrome is not the application in front, the reply carries `seenByHuman: false` and `screen`, and then the person is looking at something else. Say so; do not present the picture as what they see. ' +
      'EVERY SHOT CARRIES TWO THINGS A PICTURE CANNOT SAY ABOUT ITSELF: `build` — which build was actually running (the script files the page fetched, whatever version it declares, viewport, DPR, colour scheme, language), so nobody has to ask «which build was this»; and `receipt` — what was covered before the frame and what was never collected at all, which is what makes a picture of somebody else\'s application sendable. '
      + 'Downscaled to `maxWidth` (default 1200) because a retina frame is megabytes of context for pixels nobody needed. '
      + 'PASS `path` FOR A LONG PAGE: the file is written at FULL resolution — the downscale exists to protect this conversation, and a file is not this conversation. An inline thirty-screen shot is unreadable by arithmetic, not by accident. ' +
      'Read-only: it changes nothing on the page.',
    inputSchema: {
      tabId: tabIdArg,
      ref: z.string().optional().describe('Crop to this element (a ref from qa_snapshot)'),
      selector: z.string().optional().describe('Crop to the first element matching this CSS selector'),
      full: z.boolean().optional().describe('Photograph the WHOLE page, not just the visible part — scrolled and stitched. Ignored when ref/selector is given.'),
      maxWidth: z.number().optional().describe('Downscale to at most this wide (default 1200, max 2000)'),
      path: z.string().optional().describe('Write the PNG here instead of returning it inline — an absolute path, or one relative to where the bridge runs. You get back the path and the size, at FULL resolution, plus a `<name>.map.json` beside it.'),
      searchable: z.boolean().optional().describe('Also write a searchable SVG beside the PNG: the same picture with every string the page was showing written invisibly over its own pixels, so Ctrl+F works INSIDE the screenshot and the text can be selected and copied. Not OCR — the strings were read from the live document, so there is no recognition to be wrong about. Text inside <canvas> or a frame cannot be included, and the file says so.'),
      map: z.boolean().optional().describe('Return the element map with the picture: every visible control with its accessible name, role, CSS selector and box IN IMAGE PIXELS. This is what makes a screenshot something you can point INTO — anchor an annotation to a control, or draw a finding onto the shot without aiming. Written automatically beside the file when `path` is given.'),
    },
  },
  async ({ tabId, ref, selector, full, maxWidth, path: outPath, map, searchable }) => {
    try {
      /* A full-page shot is scroll-and-wait: ten screenfuls is comfortably past the 30 s that
         is generous for a single frame, and a timeout here looks exactly like a broken bridge. */
      /* A PICTURE GOING TO A FILE ASKS FOR THE WHOLE THING. The downscale on the other side
         protects the CONVERSATION, and a file is not the conversation — shrinking on the way to
         disk is how a thirty-screen page arrived unreadable (owner, 16.09.2026). */
      const r = await callExtension('qa_screenshot', { tabId, ref, selector, full, maxWidth, fullRes: !!outPath, map: !!map || !!outPath, text: !!searchable }, full ? 150_000 : 30_000);
      if (!r || r.ok === false || typeof r.dataUri !== 'string') return asText(r);
      const b64 = r.dataUri.slice(r.dataUri.indexOf(',') + 1);
      if (outPath) {
        /* THE SAME REASONING AS qa_report'S `path`: this process is ordinary Node with a
           filesystem and the extension is not, and a picture is the one payload where inline
           versus on-disk is the difference between a sentence and a megabyte. */
        const { writeFileSync, statSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const fullPath = resolve(outPath);
        writeFileSync(fullPath, Buffer.from(b64, 'base64'));
        /**
         * AND THE MAP GOES BESIDE IT.
         *
         * A picture taken from inside the page knows where every control is, what it is called and
         * how to find it again — and a flat PNG throws all of that away. The sidecar keeps it: an
         * arrow can then be anchored to a CONTROL instead of to coordinates, a finding with a
         * selector can draw itself onto the picture, and two shots of the same screen can be
         * compared by control rather than by pixel. Boxes are in IMAGE pixels, so nothing
         * downstream has to guess the device pixel ratio.
         */
        let mapPath = null;
        if (r.map && r.map.nodes?.length) {
          mapPath = fullPath.replace(/\.png$/i, '') + '.map.json';
          /* The stamp and the receipt live in the same sidecar as the map: they are three answers
             about ONE picture, and splitting them into three files is how two of them get lost. */
          writeFileSync(mapPath, JSON.stringify({ ...r.map, build: r.build, receipt: r.receipt }, null, 1));
        }
        /**
         * AND, WHEN ASKED, THE SEARCHABLE COPY.
         *
         * One SVG holding the same picture with every string of the page written over its own
         * pixels, invisibly. Ctrl+F then works inside a screenshot — which is not OCR and has no
         * accuracy to argue about: the text was read from the live document, never recognised.
         */
        let svgPath = null;
        if (searchable && r.text?.runs?.length) {
          svgPath = fullPath.replace(/\.png$/i, '') + '.svg';
          const { basename } = await import('node:path');
          writeFileSync(
            svgPath,
            renderSearchableSvg({
              png: r.dataUri,
              width: r.width,
              height: r.height,
              text: r.text,
              build: r.build,
              map: r.map,
              /* Handed over so the renderer can REFERENCE the picture instead of embedding it when
                 embedding would make a file nobody can send. */
              pngName: basename(fullPath),
            }),
            'utf8',
          );
        }
        return asText({
          ok: true,
          path: fullPath,
          ...(svgPath
            ? {
                svgPath,
                svgNote:
                  `${r.text.runs.length} strings written over their own pixels — open it in a browser and Ctrl+F works` +
                  (statSync(svgPath).size > 9 * 1024 * 1024 || r.bytes > 8 * 1024 * 1024
                    ? '. The picture is too big to embed, so the SVG REFERENCES the PNG beside it — send both.'
                    : '. The picture is inside it, so it travels alone.') +
                  (r.text.missing?.length ? ` NOT included: ${r.text.missing.join('; ')}` : ''),
              }
            : {}),
          ...(mapPath ? { mapPath, mapNote: `${r.map.nodes.length} controls with their names, selectors and boxes IN IMAGE PIXELS — the picture knows what is on it` } : {}),
          shot: r.shot, bytes: r.bytes, width: r.width, height: r.height, of: r.of, note: r.note,
          build: r.build, receipt: r.receipt, redacted: r.redacted,
        });
      }
      return {
        content: [
          { type: 'image', data: b64, mimeType: 'image/png' },
          /* THE NAME RIDES WITH THE PICTURE. Without it the shot is a moment inside one reply,
             and the four shelf verbs have nothing to address. */
          { type: 'text', text: JSON.stringify({ ok: true, shot: r.shot, of: r.of, width: r.width, height: r.height, bytes: r.bytes, note: r.note, build: r.build, receipt: r.receipt, redacted: r.redacted }, null, 2) },
        ],
      };
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_navigate',
  {
    title: 'Navigate a tab',
    description:
      'Point a tab at a URL and wait until it is loaded and Qiksy is live again — the ready-wait is built in, so the next step can run straight after. Use it to jump between steps of a flow that are not reachable by clicking.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      url: z.string().describe('Absolute http(s) URL'),
    },
  },
  async ({ tabId, url }) => {
    try {
      return asText(await followAfter(await callExtension('qa_navigate', { tabId, url }, 40_000), tabId, 'navigate'));
    } catch (e) {
      return asError(e);
    }
  },
);

/*
 * RELOAD — THE ONE THING THE BRIDGE COULD DO BUT COULD NOT BE ASKED FOR (owner, 02.09.2026).
 *
 * Half the capability was already there: qa_navigate runs in the service worker, so it moves a
 * tab whose content script an extension update has just killed. What was missing was the ASKING —
 * to reload, an agent had to call qa_tabs, find the tab's own address and hand it back, which is
 * two calls and a name nobody looking for "reload" would ever find. A capability nobody
 * documented does not exist; qa_type_many taught that in 1.3.0.
 *
 * THE FIRST CUT OF THIS VERB DID EXACTLY THAT AND THE HARNESS REFUSED IT. Same-address navigation
 * is not a reload, and the browser said so: `performance.getEntriesByType('navigation')[0].type`
 * came back `navigate`. Two consequences, the second a defect waiting to happen — a URL carrying
 * a #fragment is a SAME-DOCUMENT navigation, so such a page would not reload at all while the
 * verb reported success; and a cache-bypassing reload, the one a person means when the page is
 * wedged, could not be asked for. So the work moved into the extension, onto chrome.tabs.reload.
 *
 * THE FALLBACK IS NOT DEFENSIVE NOISE. One npm version serves every installed extension, and an
 * extension older than 1.21.0 answers "Unknown tool" to this. Rather than a dead verb, that
 * answer routes back through qa_navigate: the reload people mostly want, with the fragment and
 * cache limits named out loud in the reply instead of hidden.
 */
server.registerTool(
  'qa_reload',
  {
    title: 'Reload a tab',
    description:
      'Reload the tab as it stands — same address, no URL to pass — and wait until it has loaded AND Qiksy is live in the new document, so the next call needs no sleep. ' +
      'Use it after anything a fresh load fixes: the extension updated under an open tab, a mock was cleared, storage was written by hand, the app wedged. ' +
      "The browser performs it, not the page's own script, so it works even when that script is already dead — which is exactly the case a reload is for. " +
      'Pass bypassCache for the hard reload (Ctrl/Cmd+Shift+R) when you suspect a stale bundle.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      bypassCache: z.boolean().optional().describe('Hard reload: re-fetch the page and its assets instead of using the browser cache. Default false.'),
    },
  },
  async ({ tabId, bypassCache }) => {
    try {
      return asText(await callExtension('qa_reload', { tabId, bypassCache }, 40_000));
    } catch (e) {
      if (!/unknown tool/i.test(String(e?.message || e))) return asError(e);
      /* An extension older than 1.21.0. Do the reachable thing and say what it cannot do. */
      try {
        const tabs = await callExtension('qa_tabs', {});
        const list = Array.isArray(tabs?.tabs) ? tabs.tabs : [];
        const tab = tabId == null ? list.find((t) => t.active) ?? list[0] : list.find((t) => t.tabId === tabId);
        const url = String(tab?.url || '');
        if (!tab || !/^https?:\/\//i.test(url)) {
          return asText({ ok: false, error: 'no such tab', note: 'Qiksy is not watching a web page to reload — call qa_tabs for the list.', tabs: list.map((t) => ({ tabId: t.tabId, url: t.url })) });
        }
        const r = await callExtension('qa_navigate', { tabId: tab.tabId, url }, 40_000);
        return asText({
          ...r,
          reloaded: url,
          via: 'navigate',
          note: 'This Qiksy is older than 1.21.0, so the reload was done by navigating to the same address. Two limits follow: bypassCache is ignored, and an address containing a #fragment may not reload at all. Update the extension for a real reload.',
        });
      } catch (e2) {
        return asError(e2);
      }
    }
  },
);

server.registerTool(
  'qa_open_isolated',
  {
    title: 'Open an isolated login tab',
    description:
      'Open a tab with its OWN private session — separate cookies, localStorage, IndexedDB — so a second (or third) user can be logged in at the same time in the same browser. Returns its `tabId`; pass that to any tool to run the whole flow as that user, while the first login keeps working untouched. This is how you test a hand-off: submit as one role here, then verify it as another role there, side by side.' +
      DRIVE_NOTE,
    inputSchema: {
      url: z.string().describe('Absolute http(s) URL to open in the isolated tab(s)'),
      session: z.string().optional().describe('Name for a single session, e.g. "admin"'),
      sessions: z
        .array(z.string())
        .optional()
        .describe('Open SEVERAL at once, named: ["admin","manager","member","viewer"] — one tab each, all live side by side'),
      count: z.number().int().optional().describe('Open this many (max 12); unnamed ones become user-1, user-2, …'),
    },
  },
  async ({ url, session, sessions, count }) => {
    try {
      return asText(await callExtension('qa_open_isolated', { url, session, sessions, count }, 120_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_focus_tab',
  {
    title: 'Bring a tab in front of the human',
    description:
      'Put a tab in front of the person — activate it and raise its window — so they are looking at what you are about to show. ' +
      'This is the WALKTHROUGH verb, and it is the one thing Qiksy otherwise refuses to do: everything else works in whatever tab is already in front, ' +
      'which is why a demo asked for from an editor used to land in a tab nobody was watching. Use it when you have been asked to SHOW, not to test — ' +
      'then narrate with qa_spotlight (its `label` is what turns a sequence of clicks into "step 3 of 6"). ' +
      'Do NOT call it to make your own work easier: taking someone\'s screen mid-sentence is the behaviour this product exists to avoid. ' +
      'Scoped to the app under test and its isolated logins (see qa_tabs) — it cannot reach the rest of the browser. Free: it neither reads nor changes the app. ' +
      'READ `raised` BEFORE YOU SAY «LOOK»: it is what the page itself reports, not what Chrome assumes. `raised: false` with `why: "other-app"` means Chrome is behind another application (an editor, this chat), which no extension can fix; `why: "covered"` means the tab\'s window is minimised or covered. Either way the person is NOT looking at the page: ask them in one line to click the browser (its dock icon bounces), and never describe a picture of the page as what they see.',
    inputSchema: {
      tabId: z.number().int().optional().describe('Which tab to bring forward (from qa_tabs). Omit for the app under test.'),
    },
  },
  async ({ tabId }) => {
    try {
      return asText(await callExtension('qa_focus_tab', { tabId }, 15_000));
    } catch (e) {
      /* This verb lives in the EXTENSION, which updates through the Web Store on its own
         clock — an npx-fresh server can be talking to a browser that predates it. "Unknown
         tool" is the exact shape of that, and left raw it reads as a bug in the agent. */
      if (/Unknown tool/i.test(String(e?.message || e))) {
        return asText({
          ok: false,
          error: 'not-in-this-extension-build',
          note: 'qa_focus_tab needs an extension build newer than 1.6.0 in the browser (this server updates with npx; the extension updates through the Chrome Web Store, on its own clock). Until it does: ask the person to click the tab they want to be shown, then drive it as usual — qa_spotlight still narrates.',
        });
      }
      return asError(e);
    }
  },
);

/**
 * THE FULL STOP — the one thing a browser cannot work out for itself.
 *
 * Somebody sets an agent off on a long run and goes to do something else: another tab, another
 * screen, another room. Until now nothing told them it had ended. «No calls for a while» is not
 * the answer — a model that stops to think looks exactly like a model that has finished, and a
 * signal that cries wolf every thirty seconds gets switched off within the hour.
 *
 * So the run says so itself, and the browser turns that into something visible from across a
 * room: the mark on the tab pulses slowly — and stops the moment they look at that tab, because
 * being looked at IS the acknowledgement. A tab already in front is never pulsed at all.
 */
server.registerTool(
  'qa_done',
  {
    title: 'Say the run has finished',
    description:
      'CALL THIS WHEN THE WORK IS ACTUALLY OVER — the last check made, the last fix verified, the answer about to be written. The mark on every driven tab the person is NOT looking at then pulses slowly, so somebody who walked away from the screen can see from across the room that it ended. It stops by itself when they look at that tab; there is nothing to dismiss. ' +
      'It is a nudge, not a report: still say what you did, in your own words. And it is not a progress beat — calling it between steps teaches people to ignore it, which costs the signal its only job. Any further call cancels it, so a run that continues quietly withdraws it. ' +
      'A short sound plays as well, for somebody who is not looking at the browser at all — the person can switch the sound off in the popup, and the pulse stays either way. ' +
      'Free, and it touches nothing on the page.',
    inputSchema: {
      tabId: tabIdArg,
      verdict: z
        .enum(['ok', 'problem'])
        .optional()
        .describe('How it ended. `ok` (default) rises; `problem` falls — the same sound in two directions, so the ear tells them apart without being taught. Say what you actually found; a run that discovered a defect ended FINE if you finished the work.'),
    },
  },
  async ({ tabId, verdict }) => {
    try {
      /* The agent said it itself — the one route that needs no guessing behind it. */
      noteRealDone();
      following = null;
      return asText(await callExtension('qa_done', { tabId, verdict }, 15_000));
    } catch (e) {
      /* The verb lives in the EXTENSION, which updates on the Web Store's clock while this server
         updates with npx — «unknown tool» is the shape of that gap, and raw it reads as a bug. */
      if (/Unknown tool/i.test(String(e?.message || e))) {
        return asText({
          ok: false,
          error: 'not-in-this-extension-build',
          note: 'qa_done needs a newer extension in the browser. Nothing is lost: say you have finished in your own words, which is what the person reads anyway.',
        });
      }
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_close_tab',
  {
    title: 'Close tabs',
    description:
      'Close one tab or a list of them — how you tidy up the isolated logins when a matrix run is finished. Returns which ids closed and which were already gone.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: z.number().int().optional().describe('A single tab to close'),
      tabIds: z.array(z.number().int()).optional().describe('Several tabs to close, e.g. every isolated login from qa_tabs'),
    },
  },
  async ({ tabId, tabIds }) => {
    try {
      return asText(await callExtension('qa_close_tab', { tabId, tabIds }, 30_000));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_fill_json',
  {
    title: 'Fill a form from a JSON of labels and values',
    description:
      'Hand the page a plain JSON object — { "Field label": "value" } — and it fills the form in ONE call. No refs, no snapshot of your own: this takes its own snapshot, matches each key against the fields\' accessible names (exact, then truncated, then contains) and passes the whole lot to the batch filler, so every control kind is covered — text, native and CUSTOM selects, typeahead comboboxes, date pickers, checkboxes (true/false), radios, sliders, rich text. ' +
      'This is the shape of the JSON behind the panel\'s own `{ }` editor and its ⚡Fill button, so a dataset you write here reads the same way a human would edit it. ' +
      'Reach for this when you ALREADY know the data — from a ticket, a persona, a CSV row — and for a form you have not mapped: it is one call instead of snapshot-then-batch. Use qa_snapshot + qa_type_many instead when you need to choose targets deliberately (duplicate labels, one specific control among many). ' +
      'Keys that match nothing come back as `unmatched`, together with the field names the page actually has, so the next call can use the right key without another round trip. ' +
      'DATE FIELDS BUILT FROM SECTIONS (MUI X DateField/DatePicker: separate Day / Month / Year spans the component owns) cannot be written to at all — the answer will say so under `verified`, and the way in is the calendar: click the "Choose …" button, switch to the year view, pick the year, step the month, click the day. ' +
      'A value of "click" PRESSES the thing instead of filling it — for the parts of a step that take no value: a chip, a custom radio (div role=radio), a switch, a toggle button. { "Climate": "click", "Medium": "click" } goes in the same batch as the text fields. ' +
      'REPEATED LABELS: a form built from a repeated component gives several controls the identical label — address them as "Full name", "Full name#2", "Full name#3", which is the same #N notation the panel\'s own dataset uses, so a dataset copied out of the `{ }` editor works as written. ' +
      'ONE CALL PER WIZARD STEP: pass `advance: "Next"` and this presses that control after the fill — but only when the fill was clean. It is NOT pressed if an entry came back ok:false, if a key matched nothing, or if a value is still wrong after the repair, and the reply says which of those it was. Whether the page really advanced is decided by the DIFF the click produced (a step swap makes many nodes appear AND disappear), never by the click answering ok: a Next that is disabled until the step validates accepts a click and does nothing — that case is caught before the click, from the control\'s own state, and comes back as `advanced.ok:false` with `stillNeeded`. When it did advance, `next` carries the FIELD NAMES of the step you are now on, so the following step costs no qa_snapshot of your own; pass next:false to leave them out. ' +
      'dry_run:true resolves the keys and fills nothing — read-only, and the cheap way to check a dataset against a page (with `advance` set it reports `wouldAdvance` and presses nothing).' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      fields: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .describe('The dataset: { "Initiative name": "Test run", "Country": "Ukraine", "Start date": "2026-08-01", "I agree": true }'),
      within: z
        .string()
        .optional()
        .describe('Limit the matching to one form / dialog / step — the `selector` of a container node from a snapshot'),
      dry_run: z.boolean().optional().describe('Resolve the keys and report what would be filled, without touching the page'),
      verify: z
        .boolean()
        .optional()
        .describe('Default true: after the batch, read the page back and re-write any field whose value did not actually land, one at a time and re-found by name. This is what makes MUI-style multi-section fields and masked inputs work; pass false to skip the check.'),
      advance: z
        .string()
        .optional()
        .describe('After the fill, click the control with THIS accessible name — "Next", "Continue", "Submit". Resolved by name against a snapshot taken at that moment (a fill re-renders the step, which is what makes a ref taken earlier click the wrong button), skipped entirely when the control reports itself disabled, and refused when anything about the fill was not clean. The reply\'s `advanced.ok` tells you whether the page actually moved, judged by the click\'s diff.'),
      next: z
        .boolean()
        .optional()
        .describe('Default true when `advance` is set: ride the NEXT step\'s field names back in the same reply (`next.fields`, plus its title and what its forward control is called), so the step after this one costs you no qa_snapshot. Pass false when you do not need them.'),
      frameId: frameIdArg,
    },
  },
  async ({ tabId, fields, within, dry_run, verify, advance, next, frameId }, extra) => {
    const bar = loader(extra, dry_run ? 'matching the dataset to the page' : advance ? 'filling the form, then advancing' : 'filling the form');
    try {
      const res = await fillByNames(tabId, fields, { dryRun: dry_run, within, verify, advance, next, frameId });
      return asText(dry_run ? res : await followAfter(res, tabId, 'fill'));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_pick_date',
  {
    title: 'Set a date, whatever library owns the calendar',
    description:
      'Put an EXACT date into a date field in ONE call — including the ones a value cannot be written to. ' +
      'It tries the cheap way first (type the date, press Enter, check it stuck), and only if that fails does it open the picker and steer it: the year view for MUI X, the clickable year in the header for Ant Design, the month/year dropdowns for react-datepicker, and plain arrows for anything else — stepping until the calendar header agrees, then clicking the day. ' +
      'Use this instead of writing to a date field whose value never sticks: MUI X DateField is three contenteditable sections the component rebuilds from its own state, so a written "14" can land in the YEAR and the day stay empty. ' +
      'Returns `via` (typed or calendar) and a `trail` of what it actually had to do, so a picker this does not recognise is visible rather than silent.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe("The field's accessible name, e.g. \"Owner date of birth\""),
      date: z.string().describe('The date as dd/mm/yyyy — the exact one the form must end up with'),
      open_label: z
        .string()
        .optional()
        .describe('Name of the button that opens the picker, when the field itself does not (MUI renders "Choose <field name>")'),
    },
  },
  async ({ tabId, name, date, open_label }, extra) => {
    const bar = loader(extra, 'setting the date');
    try {
      const res = await pickDate(tabId, name, date, { openLabel: open_label });
      if (res.ok) note('fill', tabId, [{ name, selector: '', value: date, action: 'date' }]);
      return asText(withPostcard(res, true));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_pick_path',
  {
    title: 'Choose a value that lives across several levels',
    description:
      'One call for the widgets where a single value takes several interactions: an Ant Design Cascader (country → region → city, a column per level), a TreeSelect with collapsed branches, a menu of submenus, any drill-down. ' +
      'Pass the path as it reads on screen and it opens the control, clicks each level on a FRESH snapshot (opening a level is exactly what re-renders the popup), expands a branch that hides its children, and closes up afterwards. ' +
      'A level that never appears is reported with the levels that did, so you can see where the path diverged from the page instead of guessing.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe("The control's accessible name, e.g. \"Delivery location\""),
      path: z.array(z.string()).optional().describe('The levels in order, e.g. ["Ukraine","Kyiv oblast","Kyiv"]. Pass this OR `paths`.'),
      paths: z
        .array(z.array(z.string()))
        .optional()
        .describe('SEVERAL values from one control, walked inside ONE opening — e.g. [["Europe","Poland"],["Europe","Germany"]] for a checkable tree. Use this rather than calling the tool twice: a second call clicks the control to open it, which on an already-open popup CLOSES it, and live that left a tree with two picks holding none. A shared parent is not re-clicked (that would toggle the whole branch off).'),
      multi: z.boolean().optional().describe('Leave the popup open afterwards. Rarely needed now that `paths` exists.'),
    },
  },
  async ({ tabId, name, path, paths, multi }, extra) => {
    const bar = loader(extra, 'walking the levels');
    try {
      if (!path?.length && !paths?.length) return asText({ ok: false, error: 'pass `path` (one value) or `paths` (several from the same control)' });
      const res = await pickPath(tabId, name, path || (paths && paths[0]) || [], { multi, paths });
      if (res.ok) note('fill', tabId, [{ name, selector: '', value: (paths && paths.length ? paths : [path]).map((p) => p.join(' > ')).join(' | '), action: 'path' }]);
      return asText(withPostcard(res, true));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_pick_tags',
  {
    title: 'Add tags / chips to a field that CREATES its values',
    description:
      'One call for a whole list of tags on a control that has no option list to pick from — Ant Design\'s Select in `mode="tags"`, and every chips input built the same way: the value is typed and committed with a key. ' +
      'Per tag it types, VERIFIES the text is still in the field, then presses the key, on a ref re-resolved each time. The verification is the point and it is not defensive coding: when a tag commits, the component clears its own search input, the re-render can wipe a value written a moment earlier, and the key then re-submits the PREVIOUS text — which in tags mode toggles that tag back OFF. That is how a form ends up with the tag you added first missing. ' +
      'It also never clicks the field first: a click moves the caret out of the component\'s search input and the text goes nowhere. ' +
      'Returns which tags went in and, for any that did not, what the field was holding instead. If a control refuses every tag it is probably NOT in tags mode — it only accepts values from its list, and qa_type with the option text is the right verb.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe("The control's accessible name, e.g. \"Product tags\""),
      tags: z.array(z.string()).describe('The tags to add, in order — e.g. ["chilled","ambient","frozen"]. Never repeat one: a second submit of the same text removes it.'),
      commit_key: z.string().optional().describe('The key that commits a tag. Default "Enter"; some components use "," or "Tab".'),
    },
  },
  async ({ tabId, name, tags, commit_key }, extra) => {
    const bar = loader(extra, 'adding the tags');
    try {
      const res = await pickTags(tabId, name, tags, { commitKey: commit_key || 'Enter' });
      if (res.ok) note('fill', tabId, [{ name, selector: '', value: (res.added || []).join(', '), action: 'tags' }]);
      return asText(withPostcard(res, true));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_pick_time',
  {
    title: 'Set a time on a picker whose cells have no role',
    description:
      'A time in one call on a column-based picker — Ant Design\'s TimePicker and its equivalents. Needed because the cells are bare list items with NO accessibility role, so the snapshot cannot see them, and the ordinary fill path misreads the control as a date field ("calendar did not open — typed an ISO date instead") and leaves it empty while reporting success. ' +
      'This reads each column\'s text, finds which entry is your value and clicks THAT child, then presses the panel\'s own OK — which is not optional: without it the value stays provisional and the field ends up empty. Reading the column instead of computing an index is deliberate: the minute step is configurable and guessing it would be a bug.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe("The control's accessible name, e.g. \"Weekly call time\""),
      time: z.string().describe('The time as the picker shows it — "14:30", or "14:30:00" for a picker with a seconds column'),
    },
  },
  async ({ tabId, name, time }, extra) => {
    const bar = loader(extra, 'setting the time');
    try {
      const res = await pickTime(tabId, name, time);
      if (res.ok) note('fill', tabId, [{ name, selector: '', value: time, action: 'time' }]);
      return asText(withPostcard(res, true));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_pick_range',
  {
    title: 'Set a date RANGE that lives in one control',
    description:
      'Both ends of a date range in one call, for a control that owns two inputs — Ant Design\'s RangePicker and its equivalents. Not the same as two qa_pick_date calls: the control walks from the start panel to the end panel by itself, and approaching it a second time from cold restarts the range on the start input, which is how a range ends up half-set. ' +
      'The start goes in through the normal single-date route (so every library it knows still applies), then the panel — still open — is steered to the end date by the same recipe with the opening click dropped. Reports a `trail` of what it clicked, and if the panel closed after the start it says so instead of pretending: some pickers do, and then the end date is its own field ("End date") for a plain qa_pick_date.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe("The control's accessible name — for Ant this is usually the START input's name, e.g. \"Start date\" or the field's label"),
      from: z.string().describe('The start, dd/mm/yyyy'),
      to: z.string().describe('The end, dd/mm/yyyy'),
    },
  },
  async ({ tabId, name, from, to }, extra) => {
    const bar = loader(extra, 'setting both ends of the range');
    try {
      const res = await pickDateRange(tabId, name, from, to);
      if (res.ok) note('fill', tabId, [{ name, selector: '', value: `${from} — ${to}`, action: 'range' }]);
      return asText(withPostcard(res, true));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_focus_walk',
  {
    title: 'Walk the page the way a keyboard user does — Tab by Tab',
    description:
      'The keyboard route as ONE call: presses Tab repeatedly and records where focus actually lands, ' +
      'then compares that trail against the interactive elements the accessibility tree claims. This is ' +
      'the accessibility question a click can never answer — Qiksy clicks teleport to an element, a ' +
      'keyboard user has to REACH it. Reports: the focus trail; interactive elements that never got ' +
      'focus (the div-button a Tab user can never reach); a suspected focus TRAP when the same short ' +
      'cycle of names repeats without the walk closing; and order-vs-geometry suspects — consecutive ' +
      'stops where focus jumps far UP the page, the classic broken tab order. ' +
      'Honest limits, stated because this tool feeds audits: matching is by accessible NAME (the press ' +
      'reply carries no ref), so duplicate names can mask a missed element; focus VISIBILITY is not ' +
      'judged here (that is qa_styles on a stop that interests you); and the walk changes the page\'s ' +
      'focus for real, so run it before filling, not mid-form.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      maxSteps: z.number().int().min(5).max(200).optional()
        .describe('Tab presses before giving up (default 80). A page that does not close its cycle within this is reported, not guessed at.'),
      sheet: z.string().optional()
        .describe('Also DRAW the route: write a PNG here with a numbered pin at every stop and a line between consecutive ones. A tab order that zigzags across the page is an argument nobody wins with a table of names — it is obvious in one picture, and that is what gets shown to the person who has to fix it.'),
    },
  },
  async ({ tabId, maxSteps = 80, sheet }, extra) => {
    const bar = loader(extra, 'walking the keyboard route');
    voiceMuted = true;
    try {
      /* The map first: what the tree CLAIMS is interactive, with geometry for the
         order check. A leftover popup would hide the page from the snapshot, so
         clear it the way every popup-opening verb here does. */
      await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});
      const snap = await callExtension('qa_snapshot', { tabId, geometry: true }, 30_000);
      const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
      const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'slider', 'searchbox', 'listbox', 'spinbutton']);
      const interactive = nodes
        .filter((n) => INTERACTIVE.has(n.role) && (n.name || '').trim())
        .map((n) => ({ name: String(n.name).trim(), role: n.role, box: n.box || null }));

      /* The walk. The press reply's `field` is the accessible name of whatever holds
         focus after the key — that is the trail. */
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/[*:?]\s*$/, '');
      const trail = [];
      const stops = [];
      let trap = null;
      let loopClosed = false;
      let sawFocusField = false;
      let budgetHit = false;
      /* Wall-clock budget: each press pays actionDelta's settle window, and a page
         that never goes quiet pays the 2500ms hard cap per step — 80 steps would be
         ~200s pressed into a page nobody is listening to anymore (review B3).
         IT SCALES WITH THE WALK NOW, and that is a correctness fix, not a comfort one.
         A flat 40s meant a page with a hundred controls could NEVER be walked: at the
         ~0.8s a healthy press actually costs, the budget ran out around step fifty and
         everything past it was reported as unreachable. Route's own planner was filed
         that way on 07.09.2026 — 38 invented violations on a screen a keyboard walks
         end to end. An audit tool that cannot finish must say so; it must never let
         its own clock become the page's defect. */
      const walkBudgetMs = Math.min(180_000, Math.max(40_000, maxSteps * 1_500));
      const walkStart = Date.now();
      for (let i = 0; i < maxSteps; i++) {
        if (Date.now() - walkStart > walkBudgetMs) { budgetHit = true; break; }
        const r = await callExtension('qa_press', { tabId, key: 'Tab' }, 15_000);
        if (!r || r.ok === false) return asText({ ok: false, error: r?.error || 'Tab press failed', steps: i, trail: trail.slice(0, 100) });
        /* The 1.6.0 extension ALWAYS ships the `focus` key (null = nothing holds
           focus); its very absence in the reply is what distinguishes an old build
           from a page where focus never left body (review B2). The trusted-input
           path answers from the SW without a focus report — a different, honest
           error, because telling that user to update a current build is wrong. */
        if ('focus' in r) sawFocusField = true;
        else if (r.trusted) {
          return asText({
            ok: false,
            error: 'walk-unavailable-under-trusted-input',
            note: 'With Trusted input on, a bare key press answers from the background CDP path, which carries no focus report. Switch Trusted input off for the walk, or target presses at elements.',
          });
        }
        const at = String(('focus' in r ? r.focus?.name : r.field) ?? '').trim();
        trail.push(at);
        /* THE SELECTOR AND THE BOX, not only the name. The walk's own stated weakness is that it
           matches by name and duplicate names can hide a missed element; the press reply has
           carried the focused element's selector and box all along, and keeping them is what lets
           the route be DRAWN rather than described. */
        stops.push({
          name: at,
          selector: ('focus' in r ? r.focus?.selector : null) || null,
          box: ('focus' in r ? r.focus?.box : null) || null,
          role: ('focus' in r ? r.focus?.role : null) || null,
        });
        // full circle: back at the first stop after a real walk. Only NON-EMPTY
        // names close it — a run of unnamed stops matching an unnamed first stop
        // ended a login-form walk in five steps (review B1).
        if (i > 3 && at && trail[0] && norm(at) === norm(trail[0])) { loopClosed = true; break; }
        // trap: a short cycle (2–4 names) repeating twice in a row without progress
        for (let len = 2; len <= 4 && i + 1 >= len * 2; len++) {
          const a = trail.slice(-len).map(norm).join('|');
          const b = trail.slice(-len * 2, -len).map(norm).join('|');
          if (a === b && new Set(trail.slice(-len).map(norm)).size < len + 1) {
            trap = { cycle: [...new Set(trail.slice(-len))], after: i + 1 - len * 2 };
            break;
          }
        }
        if (trap) break;
      }

      /* Post-analysis on the trail vs the map. Name-matched — the honest limit above. */
      const seen = new Set(trail.map(norm).filter(Boolean));
      const nameHit = (name) => {
        const n = norm(name);
        // press truncates long names — a trail entry that PREFIXES the map name counts
        return seen.has(n) || [...seen].some((s) => s.length >= 20 && n.startsWith(s));
      };
      const unreachable = interactive.filter((el) => !nameHit(el.name)).slice(0, 40)
        .map(({ name, role }) => ({ name: name.slice(0, 60), role }));

      const boxOf = (name) => interactive.find((el) => norm(el.name) === norm(name) || norm(el.name).startsWith(norm(name)))?.box || null;
      const orderSuspects = [];
      for (let i = 1; i < trail.length && orderSuspects.length < 12; i++) {
        const a = boxOf(trail[i - 1]);
        const b = boxOf(trail[i]);
        if (a && b && b.y < a.y - 200 && b.x >= a.x - 40) {
          orderSuspects.push({ from: trail[i - 1].slice(0, 50), to: trail[i].slice(0, 50), why: `focus jumped ${Math.round(a.y - b.y)}px UP the page (2.4.3 candidate)` });
        }
      }

      note('press', tabId, [{ name: 'focus walk', selector: '', value: `${trail.length} stops`, action: 'walk' }]);
      if (!sawFocusField) {
        return asText({
          ok: false,
          error: 'extension-too-old-for-walk',
          note:
            'This Qiksy build does not report the focused element per keypress (`focus` in the press ' +
            'reply) — the walk can only see container names, which makes trap detection and the ' +
            'unreachable list unreliable. Update the Qiksy extension; the trail below is the honest ' +
            'partial data, not a verdict.',
          steps: trail.length,
          trail: trail.slice(0, 100),
        });
      }
      /**
       * THE ROUTE AS A PICTURE.
       *
       * A table of forty stop names is read by nobody. The same route drawn on the page — pin 1,
       * pin 2, a line between them — makes a tab order that leaps from the header to the footer
       * and back obvious to a person who has never heard of WCAG, which is usually the person who
       * has to approve the fix. The pins are placed by SELECTOR, so they land on the controls
       * themselves rather than on remembered coordinates.
       */
      let sheetPath = null;
      let sheetNote = null;
      if (sheet) {
        const placed = stops.filter((st) => st.selector).slice(0, 50);
        if (!placed.length) {
          sheetNote = 'no picture: none of the stops reported a selector, so there is nothing to pin to. An older extension build does not send one.';
        } else {
          const marks = [];
          placed.forEach((st, i) => {
            marks.push({ kind: 'pin', selector: st.selector, label: String(i + 1), colour: 'default' });
            const next = placed[i + 1];
            /* The line is drawn to the NEXT stop, which is what makes a backwards jump visible:
               a route that reads 1→2→3 down the page and then leaps to the header is a shape, not
               a sentence. */
            if (next?.selector) marks.push({ kind: 'line', selector: st.selector, toSelector: next.selector, colour: 'info' });
          });
          const drawn = await callExtension('qa_annotate', { tabId, marks }, 150_000).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          if (drawn?.ok && typeof drawn.dataUri === 'string') {
            const { writeFileSync } = await import('node:fs');
            const { resolve } = await import('node:path');
            sheetPath = resolve(sheet);
            writeFileSync(sheetPath, Buffer.from(drawn.dataUri.slice(drawn.dataUri.indexOf(',') + 1), 'base64'));
            sheetNote = `${placed.length} stops pinned in order${drawn.missed?.length ? `; ${drawn.missed.length} could not be placed and are named in the walk's trail` : ''}. The numbers are the tab order, the lines are the jumps between them.`;
          } else {
            sheetNote = `no picture: ${drawn?.error || 'the page could not be photographed'}`;
          }
        }
      }

      return asText(withPostcard({
        ok: true,
        steps: trail.length,
        loopClosed,
        ...(sheetPath ? { sheetPath } : {}),
        ...(sheetNote ? { sheetNote } : {}),
        ...(budgetHit ? { note: `stopped at the ${Math.round(walkBudgetMs / 1000)}s walk budget after ${trail.length} of maxSteps=${maxSteps} presses. THE WALK IS INCOMPLETE, so "unreachable" below means "not reached before the clock ran out" — it is NOT a verdict about the page. Either the page is slow to settle between presses or it simply has more controls than this walk had time for; re-run with a higher maxSteps, or Tab to a control past the last stop in the trail and walk on from there, before reporting anything as unreachable.` } : {}),
        ...(trap ? { trap: { ...trap, note: 'the same short cycle of stops repeated — a focus trap candidate (2.1.2). Verify by hand before it enters a report.' } } : {}),
        interactiveInTree: interactive.length,
        reachedByName: interactive.length - unreachable.length,
        /* THE KEY IS RENAMED WHEN THE WALK DID NOT FINISH. Whatever the note says, an
           agent reads the field name and writes the report from it — «unreachable» on a
           truncated walk is how a healthy control ends up in a defect list. */
        ...(budgetHit ? { notReachedBeforeBudget: unreachable } : { unreachable }),
        orderSuspects,
        trail: trail.slice(0, 100),
        limits: 'name-matched (duplicate names can mask a miss); focus visibility not judged — qa_styles the stop you care about; the walk moves real focus, run it before filling',
      }, true));
    } catch (e) {
      return asError(e);
    } finally {
      voiceMuted = false;
      bar.stop();
    }
  },
);

/* A widget whose SHAPE already settles it must not be clicked to find that out: probing costs a
 * call, and on some of these it costs more than a call (clicking into a MUI date section makes its
 * own picker button toggle the dialog shut — a regression I wrote myself). */
const SETTLED_BY_SHAPE = new Set(['date-sections', 'popup-date-input', 'file', 'text', 'checkbox', 'switch', 'slider', 'rich-text', 'multi-select']);

/**
 * WHAT IS THIS CONTROL? — the two-layer answer, in one call.
 *
 * Layer one is free: role, tag, name, state and neighbours settle most widgets without touching
 * the page. Layer two is for the ones ARIA does not describe — a thing hand-rolled from <div>s has
 * role "generic", no name and no state, and at rest it is indistinguishable from a caption. So we
 * click it and read what the page DID, because behaviour is the one property a div cannot fake.
 *
 * Then Escape, so the probe leaves the form as it found it.
 */
async function probeWidget(tabId, { name, selector, ref, close = true }) {
  /* A REF IS RESOLVED BEFORE THE FRESH SNAPSHOT, NEVER AGAINST IT. `ref` is the identifier every
     other verb takes, so refusing it here with «pass name or selector» reads as an inconsistency
     (report, 21.09.2026) — but a ref belongs to ONE snapshot and the one taken below RENUMBERS
     them, so the number is looked up in the snapshot it came from and the node is then re-found
     by what it WAS: selector first, its name second. */
  const was = ref != null ? recallNode(tabId, ref) : null;
  if (ref != null && !was) {
    return {
      ok: false,
      error: `ref ${ref} is not in the last snapshot of this tab — take a qa_snapshot first, or pass \`name\`/\`selector\``,
    };
  }
  const snap = await callExtension('qa_snapshot', { tabId }, 30_000);
  rememberSnapshot(tabId, snap);
  const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  let node = null;
  if (was) {
    node = (was.selector && nodes.find((n) => n.selector === was.selector)) || (was.name ? pickNode(nodes, { name: was.name }, new Set())?.node : null) || null;
    if (!node) {
      return { ok: false, error: `the control behind ref ${ref} ("${was.name || was.selector}") is no longer on the page` };
    }
    selector = selector || was.selector;
  } else if (name) {
    node = pickNode(nodes, { name }, new Set())?.node || null;
    if (!node) {
      return {
        ok: false,
        error: `no control is called "${name}"`,
        fieldsOnThePage: nodes.filter((n) => isFieldNode(n) && n.name).map((n) => n.name).slice(0, 40),
      };
    }
  } else if (selector) {
    node = nodes.find((n) => n.selector === selector) || null;
  } else {
    return { ok: false, error: 'pass `ref`, `name` or `selector` — there is nothing to probe otherwise' };
  }

  const structural = node ? classifyNode(node, nodes) : null;
  const about = node ? { field: node.name || selector, role: node.role, tag: node.tag, state: node.state || null } : { field: selector };

  if (structural && SETTLED_BY_SHAPE.has(structural.kind)) {
    return { ok: true, ...about, kind: structural.kind, drive: structural.drive, verb: structural.verb, via: 'shape', clicked: false };
  }

  const res = await callExtension('qa_click', { tabId, ...(node ? { ref: node.ref } : { selector }) }, 20_000).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (res?.ok === false) return { ok: false, ...about, error: res.error || 'the probe click was refused', structural: structural || null };

  const behaviour = classifyBehaviour(res?.changed, { measured: res?.measured, navigated: res?.navigated, requests: res?.requests || 0 });
  // A probe that ADVANCED the page is not a probe any more — say so rather than reporting a kind,
  // because the agent's next call will otherwise be aimed at a step that no longer exists.
  const moved = behaviour?.kind === 'navigated';
  if (close && !moved) await callExtension('qa_press', { tabId, key: 'Escape' }, 15_000).catch(() => {});

  return {
    ok: true,
    ...about,
    kind: behaviour?.kind || structural?.kind || 'unknown',
    drive:
      behaviour?.drive ||
      structural?.drive ||
      'Nothing in its shape or its behaviour identifies it. Read it with qa_read and qa_styles, and if it is genuinely inert that is a finding about the page, not about the bridge.',
    verb: behaviour?.verb ?? structural?.verb ?? null,
    via: behaviour ? 'behaviour' : structural ? 'shape' : 'neither',
    why: behaviour?.why,
    shapeSaid: structural && behaviour && structural.kind !== behaviour.kind ? structural.kind : undefined,
    appeared: (res?.changed?.appeared || []).slice(0, 6).map((n) => `${n.role} "${n.name || ''}"`.trim()),
    pageMoved: moved || undefined,
    clicked: true,
    closed: close && !moved,
  };
}

server.registerTool(
  'qa_probe',
  {
    title: 'What kind of widget is this, and how do I drive it?',
    description:
      'Identify ONE unfamiliar control and get back the verb that drives it. Judges it first by shape — role, tag, name, state and its neighbours — which settles a sectioned date field, a file input, a switch, a slider or a plain field without touching the page at all. ' +
      'When the shape says nothing, which is what happens to a widget hand-rolled from <div>s (role "generic", no name, no state), it clicks once and reads what the page DID: day numbers or a grid appeared → a calendar, two options → a select however it is built, checkboxes → a tree, a menu, a modal, or the most useful verdict of the set — it went `expanded` and the tree gained NOTHING, which means the popup is portalled markup with no roles and must be addressed by CSS selector (Ant Design). Then it presses Escape so the form is left as it was found. ' +
      'Use it on the ONE field that just refused a value, not on every field: a snapshot already classifies the whole page (`componentLibraries` + `hints`), and driving is what the other verbs are for. Do not aim it at a Submit or Next — that click advances the page and Escape cannot take it back; the reply says `pageMoved` when it happened.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().optional().describe("The control's accessible name, as a human reads it on screen"),
      selector: z.string().optional().describe('CSS selector — for a control with no accessible name at all, which is the case this tool exists for'),
      ref: z.number().optional().describe('A ref from the last qa_snapshot of this tab. Resolved against THAT snapshot and re-found on the fresh one, so it survives the renumbering.'),
      close: z.boolean().optional().describe('Press Escape afterwards to close whatever opened. Default true; pass false when you want to keep the popup open and read it'),
    },
  },
  async ({ tabId, name, selector, ref, close }, extra) => {
    const bar = loader(extra, 'working out what that widget is');
    try {
      return asText(await probeWidget(tabId, { name, selector, ref, close: close !== false }));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

/* ── RECIPES — the second run is supposed to be the cheap one ────────────────────
 *
 * Everything above makes ONE pass over a form fast. These three make the NEXT pass cheap, which
 * is a different problem: refs die with their snapshot, a fresh session has no context, and the
 * agent that drove the form yesterday is not the process running today. So the plan is written
 * to a JSON file on this machine, keyed by the field NAMES a human would read, and replayed
 * against whatever refs the page has now.
 */
server.registerTool(
  'qa_recipe_save',
  {
    title: 'Save the flow you just drove, as a replayable recipe',
    description:
      'Write what you just did on this page to a JSON recipe on this machine, so the NEXT run replays it instead of rediscovering it. ' +
      'Call it with just a name and it builds the recipe from what this session actually filled: the fields (by accessible name, with the cssPath as fallback), the uploads, and the control you clicked to move on — folded into steps, since a click after a group of fills is what ends a step of a wizard. ' +
      'Pass `steps` yourself to write a recipe by hand, or to correct one. ' +
      'Do this at the END of any flow that took more than a few calls — a long multi-step form, a signup, a wizard — and say so in one line to the human: the recipe is a file they own, at the path this returns, editable and deletable by hand. ' +
      'Local only: writes a file, touches no browser, needs no consent.',
    inputSchema: {
      name: z.string().describe('A name you will recognise later, e.g. "new initiative form" — the file is named after it'),
      project: z
        .string()
        .optional()
        .describe('Which product or client this flow belongs to. It becomes a FOLDER, and it is what qa_suite_run groups by. Host is not enough on its own: staging and production are two hosts and one project, and two products behind one domain are one host and two projects.'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Labels for picking a subset later — ["smoke"], ["billing","regression"]. A suite can be run by tag instead of by name.'),
      url: z.string().optional().describe('The flow\'s starting URL. Defaults to the page of the last snapshot; used to scope the journal to this host and to remind you where to start.'),
      notes: z.string().optional().describe('Anything the replay should know that the fields do not say — a precondition, a role to be signed in as, a step that only appears sometimes'),
      steps: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().optional(),
            fields: z
              .array(
                z.object({
                  name: z.string().describe('The field\'s accessible name — the durable key across runs'),
                  selector: z.string().optional().describe('cssPath fallback, used when no name matches'),
                  role: z.string().optional().describe('Snapshot role, to disambiguate a name shared by a label and a control'),
                  value: z.string().optional(),
                  action: z.enum(['type', 'click', 'date', 'path']).optional().describe('How to set it. `date` replays through qa_pick_date (value dd/mm/yyyy), `path` through qa_pick_path (levels separated by ">"); both are what a written value cannot do.'),
                  kind: z
                    .string()
                    .optional()
                    .describe('What the classifier judged this control to be — "date-sections", "checkable-tree", "select-trigger". Stamped automatically when the recipe is built from this session; it is what stops the next run rediscovering that a calendar cannot be typed into.'),
                }),
              )
              .optional(),
            uploads: z
              .array(z.object({ name: z.string().optional(), selector: z.string().optional(), fixture: z.string().optional(), path: z.string().optional(), fileName: z.string().optional(), mimeType: z.string().optional() }))
              .optional(),
            advance: z
              .object({ name: z.string().optional(), selector: z.string().optional(), role: z.string().optional() })
              .optional()
              .describe('The control that moves to the next step — Next, Continue, Save'),
          }),
        )
        .optional()
        .describe('Write the steps explicitly instead of deriving them from this session'),
    },
  },
  async ({ name, project, tags, url, notes, steps }) => {
    try {
      const startUrl = url || rememberedUrl(undefined) || journal[journal.length - 1]?.url || '';
      const built = steps && steps.length ? steps : stepsFromJournal(startUrl);
      if (!built.length) {
        return asText({
          ok: false,
          error: 'nothing to save',
          note:
            'No fills or clicks have gone through this bridge yet in this session, so there is no flow to fold into steps. ' +
            'Drive the form first (qa_type_many / qa_upload / qa_click), then save — or pass `steps` explicitly.',
        });
      }
      // The recipe's own url is where the flow STARTS, which is the first step's page — not the
      // last snapshot, which is wherever the flow ended up (a saved recipe pointing at the
      // confirmation screen is a recipe nobody can follow).
      const openAt = url || built[0]?.url || startUrl;
      const rec = {
        recipe: 'qiksy-recipe/v1',
        name,
        url: openAt,
        host: hostOf(openAt) || hostOf(startUrl),
        saved: new Date().toISOString(),
        ...(project ? { project } : {}),
        ...(tags && tags.length ? { tags } : {}),
        ...(notes ? { notes } : {}),
        steps: built,
      };
      const path = saveRecipe(rec);
      return asText({
        ok: true,
        path,
        name,
        ...(project ? { project } : {}),
        ...(tags && tags.length ? { tags } : {}),
        steps: built.length,
        fields: built.reduce((n, s) => n + (s.fields?.length || 0), 0),
        uploads: built.reduce((n, s) => n + (s.uploads?.length || 0), 0),
        note: 'Replay it with qa_recipe_apply — one call per step. Check it first with dry_run:true, which reads only.',
      });
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_recipe_list',
  {
    title: 'List the saved recipes',
    description:
      'The flows already saved on this machine, newest first: name, host, step count, and the fields of the first step so you can tell them apart. ' +
      'Worth ONE call at the start of any form-heavy task — if a recipe for this host exists, replaying it beats rediscovering the form. Local only, no browser, no consent.',
    inputSchema: {
      url: z.string().optional().describe('Only recipes whose host matches this URL'),
      project: z.string().optional().describe('Only recipes filed under this project'),
      tag: z.string().optional().describe('Only recipes carrying this tag'),
    },
  },
  async ({ url, project, tag }) => {
    try {
      const host = hostOf(url || '');
      const all = listRecipes()
        .filter((r) => !host || r.host === host)
        .filter((r) => !project || slug(r.project) === slug(project))
        .filter((r) => hasTag(r, tag))
        .sort((a, b) => String(b.saved || '').localeCompare(String(a.saved || '')))
        .map((r) => ({
          name: r.name,
          project: r.project || undefined,
          tags: r.tags?.length ? r.tags : undefined,
          host: r.host,
          url: r.url,
          saved: r.saved,
          steps: (r.steps || []).length,
          fields: (r.steps || []).reduce((n, s) => n + (s.fields?.length || 0), 0),
          firstStep: (r.steps?.[0]?.fields || []).map((f) => f.name).slice(0, 8),
          ...(r.notes ? { notes: r.notes } : {}),
          path: r.path,
        }));
      /* The GROUPING is the answer to "what have we got for this client", and it is cheap to
         hand over: an agent that has to fold the list itself will sometimes not bother. */
      const projects = {};
      for (const r of all) (projects[r.project || '(no project)'] ??= []).push(r.name);
      return asText({ dir: RECIPES_DIR, count: all.length, projects, recipes: all });
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_recipe_apply',
  {
    title: 'Replay a saved recipe, a step at a time',
    description:
      'Replay a saved flow on the page as it is NOW. Per step it takes its own snapshot, matches every field by accessible name (exact, then truncated, then contains, then the stored cssPath), fills the whole step in ONE batch, attaches the step\'s uploads, and clicks the advance control — so a step costs you one call instead of a snapshot plus a call per field. ' +
      'Refs are never reused across runs; the names are. A field the page no longer has comes back under `missing` instead of failing the step, so you can see what drifted and fix that one field by hand. ' +
      'Override any value with `values` — same recipe, different data (that is how one saved flow becomes a data-driven test). ' +
      'START WITH dry_run:true: it resolves everything and changes nothing, needs no consent at all, and tells you whether the recipe still fits. ' +
      'IT ACTS: with `all` it walks every remaining step and clicks each advance control, so if the last step\'s advance is Submit, it submits. On anything irreversible, run the steps one at a time.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe('The recipe name (or part of it) from qa_recipe_list'),
      step: z.number().int().optional().describe('Which step to replay, 1-based. Default 1.'),
      all: z.boolean().optional().describe('Replay from `step` to the end, stopping at the first step that cannot be resolved'),
      values: z
        .record(z.string())
        .optional()
        .describe('Override stored values, keyed by the field name in the recipe — { "Initiative name": "Test run 2" }'),
      dry_run: z.boolean().optional().describe('Resolve the targets and report the plan without touching the page. Read-only.'),
    },
  },
  async ({ tabId, name, step, all, values, dry_run }, extra) => {
    const bar = loader(extra, dry_run ? 'checking the recipe against the page' : 'replaying the recipe');
    try {
      const rec = loadRecipe(name);
      if (!rec) {
        const known = listRecipes().map((r) => r.name);
        return asText({ ok: false, error: `no saved recipe matches "${name}"`, ...(known.length ? { known } : { note: `nothing saved yet — ${RECIPES_DIR} is empty` }) });
      }
      const steps = rec.steps || [];
      const from = Math.max(1, step || 1);
      if (from > steps.length) return asText({ ok: false, error: `recipe "${rec.name}" has ${steps.length} steps; asked for step ${from}` });
      const run = [];
      for (let i = from; i <= (all ? steps.length : from); i++) {
        const out = await applyRecipeStep(tabId, steps[i - 1], values, dry_run);
        run.push({ index: i, ...out });
        // Stopping ON PURPOSE: pressing on through a step whose fields were not found would fill
        // the wrong things and click Next over an invalid form, which is worse than a short report.
        if (out.missing?.length) break;
      }
      const last = run[run.length - 1];
      return asText({
        ok: !last?.missing?.length,
        recipe: rec.name,
        steps: `${run.length} of ${steps.length}`,
        ...(rec.notes ? { notes: rec.notes } : {}),
        run,
        ...(last?.missing?.length ? { stopped: `step ${last.index} — ${last.missing.length} target(s) not found on the page` } : {}),
      });
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

/**
 * A SUITE: several recipes, one command, ONE report.
 *
 * Running three recipes by hand already worked — three qa_recipe_apply calls. What it did not
 * give was the thing a suite is FOR: an answer about the whole set. Three separate replies get
 * summarised by whoever is reading them, and a summary written from memory is where "2 of 3
 * passed" quietly becomes "it works".
 *
 * Three decisions, each against the obvious one:
 *
 * (1) IT DOES NOT STOP AT THE FIRST FAILURE. A suite exists to tell you the state of the set;
 *     stopping after the first red leaves the other two unknown, and unknown reads as fine.
 *     Each RECIPE still stops at its own first unresolved step — that guard is right, because
 *     pressing on inside a broken flow fills the wrong things.
 *
 * (2) EVERY RECIPE STARTS BY NAVIGATING TO ITS OWN url. Without it recipe two begins wherever
 *     recipe one finished — usually a confirmation screen — and reports every field missing,
 *     which looks exactly like a broken recipe and is not one. A recipe with no url is run
 *     where the tab already is, and the report SAYS so rather than guessing.
 *
 * (3) dry_run IS THE DEFAULT-SAFE ROUTE AND IT IS OFFERED FIRST. A suite multiplies whatever
 *     one recipe does, including submitting; `dry_run:true` resolves every step of every
 *     recipe and touches nothing, which is the only honest way to answer "do these still fit"
 *     on a production account.
 */
/** Overrides are keyed by recipe name, and a human types that name by hand — so match it the
 *  same forgiving way loadRecipe does, or a stray capital silently drops the override and the
 *  run fills the stored value while reporting success. */
function valuesFor(values, name) {
  if (!values) return undefined;
  if (values[name]) return values[name];
  const want = slug(name);
  for (const [k, v] of Object.entries(values)) if (slug(k) === want) return v;
  return undefined;
}

async function runSuiteRecipe(tabId, rec, values, dry_run) {
  const started = Date.now();
  let navigated = null;
  if (!dry_run && rec.url) {
    try {
      await callExtension('qa_navigate', { tabId, url: rec.url }, 40_000);
      navigated = rec.url;
    } catch (e) {
      return { recipe: rec.name, ok: false, error: `could not open ${rec.url}: ${String(e?.message || e)}`, ms: Date.now() - started };
    }
  }
  const steps = rec.steps || [];
  const run = [];
  for (let i = 1; i <= steps.length; i++) {
    let out;
    try {
      out = await applyRecipeStep(tabId, steps[i - 1], valuesFor(values, rec.name), dry_run);
    } catch (e) {
      run.push({ index: i, error: String(e?.message || e) });
      break;
    }
    run.push({ index: i, ...out });
    if (out.missing?.length) break;
  }
  const last = run[run.length - 1];
  const ok = run.length === steps.length && !last?.missing?.length && !last?.error;
  return {
    recipe: rec.name,
    project: rec.project || undefined,
    ok,
    steps: `${run.length} of ${steps.length}`,
    ...(navigated ? { navigated } : rec.url ? {} : { note: 'recipe has no start URL — replayed on the tab as it was' }),
    ...(ok ? {} : { stoppedAt: last?.index, reason: last?.error || (last?.missing?.length ? last.missing.map((m) => m.name || m).slice(0, 6) : 'unknown') }),
    ms: Date.now() - started,
  };
}

/**
 * THE SET CAN HOLD BOTH KINDS OF SCENARIO — the files an agent recorded and the flows a human
 * recorded in the panel (owner ask, 2026-08-26).
 *
 * Until now a suite read the disk and nothing else, so the two halves of the feature could not
 * meet: the panel collected `project` and `tags` on the naming card, and the one verb that
 * groups by project could not see a single one of them. Someone who recorded five flows by hand
 * and asked to run the project got "the set is empty" — with five scenarios on screen.
 *
 * NOT BY COPYING THEM TO DISK. A copy is a second answer waiting to disagree, and the extension
 * is the owner of what a human recorded: the licence is there, the recording is there, and the
 * data has to disappear there when a trial lapses. So the set is assembled across both stores
 * and each half is run where it lives.
 *
 * WHERE THEY DIVERGE, AND WHY IT IS NOT ARBITRARY: a live panel scenario runs through the
 * EXTENSION's replay, not through this process's step resolver. A recorded flow may carry a
 * secret by reference — the card, the login — whose value is on that machine and deliberately
 * unreachable from here; resolving its steps in this process would type an empty string into
 * the password box and report a pass. A dry run has no such problem, because it resolves
 * targets and writes nothing, so it goes down the same path as a file and the report stays one
 * shape.
 */
async function panelScenarios(tabId) {
  try {
    const r = await callExtension('qa_scenarios', { tabId }, 20_000);
    /* AN ERROR IS NOT AN EMPTY SHELF. The extension answers a refusal or a failure as a normal
       reply carrying `error` — a lapsed licence, a tab it is not running on, an exception in
       the page — and reading that as "this person has no scenarios" is how a set silently
       loses the half a human recorded. Only a real list counts as an answer. */
    if (Array.isArray(r?.recipes)) return r.recipes;
    return null;
  } catch {
    /* The bridge being down is NOT "this person has no scenarios" — answering an empty list
       would make a suite silently shorter, which is the one bug a suite must not have. */
    return null;
  }
}

async function panelScenario(tabId, name) {
  const r = await callExtension('qa_scenario_get', { tabId, name }, 20_000);
  return r?.ok && r.recipe ? r.recipe : null;
}

async function runPanelScenario(tabId, head, values, dry_run) {
  const started = Date.now();
  const rec = await panelScenario(tabId, head.name);
  if (!rec) return { recipe: head.name, from: 'panel', ok: false, error: 'the panel no longer has this scenario', ms: Date.now() - started };
  // A dry run touches nothing, so it is resolved here and reads exactly like a file's.
  if (dry_run) return { ...(await runSuiteRecipe(tabId, rec, values, true)), from: 'panel' };

  let navigated = null;
  if (rec.url) {
    try {
      await callExtension('qa_navigate', { tabId, url: rec.url }, 40_000);
      navigated = rec.url;
    } catch (e) {
      return { recipe: rec.name, from: 'panel', ok: false, error: `could not open ${rec.url}: ${String(e?.message || e)}`, ms: Date.now() - started };
    }
  }
  let out;
  try {
    out = await callExtension('qa_scenario_run', { tabId, name: rec.name, values: valuesFor(values, rec.name) }, 120_000);
  } catch (e) {
    return { recipe: rec.name, from: 'panel', ok: false, error: String(e?.message || e), ms: Date.now() - started };
  }
  const stopped = out?.run?.find?.((st) => st && st.state === 'failed');
  return {
    recipe: rec.name,
    from: 'panel',
    project: rec.project || undefined,
    ok: !!out?.ok,
    steps: out?.steps || `0 of ${(rec.steps || []).length}`,
    ...(navigated ? { navigated } : { note: 'scenario has no start URL — replayed on the tab as it was' }),
    ...(out?.ok ? {} : { stoppedAt: out?.stoppedAt, reason: out?.error || stopped?.note || (stopped?.missing?.length ? stopped.missing.slice(0, 6) : 'unknown') }),
    ms: Date.now() - started,
  };
}

server.registerTool(
  'qa_suite_run',
  {
    title: 'Run several saved recipes as one set',
    description:
      'Replay a GROUP of saved flows back to back and answer about the whole set: which passed, which stopped, at what step and on what. ' +
      'Pick the set one of three ways — `recipes` by name, `project` (everything filed under that product or client), or `tag` (["smoke"]). ' +
      'BOTH STORES ARE IN THE SET: the flows you saved here and the ones the human recorded in the panel\'s Scenarios tab (qa_scenarios), so a hand-recorded flow can be part of a project run. A name held by both is run from the panel — that is the copy the person edits. ' +
      'Each recipe is opened at its own start URL first, so recipe two does not begin on recipe one\'s confirmation screen. ' +
      'It does NOT stop at the first failure — a set is only useful when you learn the state of all of it — but each recipe still stops at its own first unresolved step, because filling on through a broken flow is worse than a short report. ' +
      'START WITH dry_run:true: it resolves every step of every recipe, changes nothing, and needs no consent at all. That is the honest way to ask "do these still fit" before running them for real. ' +
      'IT ACTS: a suite multiplies what one recipe does, submits included.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      recipes: z.array(z.string()).optional().describe('Recipe names, in the order you want them run'),
      project: z.string().optional().describe('Run every recipe filed under this project'),
      tag: z.string().optional().describe('Run every recipe carrying this tag'),
      values: z
        .record(z.record(z.string()))
        .optional()
        .describe('Per-recipe value overrides, keyed by recipe name: { "new initiative": { "Initiative name": "Run 2" } }'),
      dry_run: z.boolean().optional().describe('Resolve every step of every recipe and touch nothing. Read-only.'),
    },
  },
  async ({ tabId, recipes, project, tag, values, dry_run }, extra) => {
    const bar = loader(extra, dry_run ? 'checking the set against the pages' : 'running the set');
    try {
      const panel = await panelScenarios(tabId);
      /* The panel's copy WINS a name collision. It is the one a human has been editing, and the
         file under the same name is usually an older export of it. */
      const panelHas = (name) => (panel || []).find((r) => slug(r.name) === slug(name)) || (panel || []).find((r) => norm(r.name).includes(norm(name)));
      const everyKnown = () => [
        ...listRecipes().map((r) => ({ name: r.name, from: 'file', project: r.project || undefined, tags: r.tags })),
        ...(panel || []).map((r) => ({ name: r.name, from: 'panel', project: r.project || undefined, tags: r.tags })),
      ];

      let chosen = [];
      if (recipes?.length) {
        /* By NAME the order is the human's, and a name that matches nothing is an error rather
           than a silently shorter run — a suite that quietly skips a flow is the one bug a
           suite must not have. */
        const missing = [];
        for (const n of recipes) {
          const head = panelHas(n);
          if (head) { chosen.push({ from: 'panel', head }); continue; }
          const rec = loadRecipe(n);
          if (rec) chosen.push({ from: 'file', rec }); else missing.push(n);
        }
        if (missing.length) {
          return asText({
            ok: false,
            error: 'no saved scenario matches',
            missing,
            ...(panel === null ? { note: 'the extension was not reachable, so only the files on disk were searched — a panel scenario would not have been found' } : {}),
            known: everyKnown(),
          });
        }
      } else if (project || tag) {
        const fromDisk = listRecipes()
          .filter((r) => !project || slug(r.project) === slug(project))
          .filter((r) => hasTag(r, tag))
          .sort((a, b) => String(a.saved || '').localeCompare(String(b.saved || '')));
        const fromPanel = (panel || [])
          .filter((r) => !project || slug(String(r.project || '')) === slug(project))
          .filter((r) => hasTag(r, tag))
          .sort((a, b) => String(a.saved || '').localeCompare(String(b.saved || '')));
        const taken = new Set(fromPanel.map((r) => slug(r.name)));
        chosen = [
          ...fromPanel.map((head) => ({ from: 'panel', head })),
          ...fromDisk.filter((r) => !taken.has(slug(r.name))).map((rec) => ({ from: 'file', rec })),
        ];
      } else {
        return asText({ ok: false, error: 'name the set', note: 'Pass `recipes`, or a `project`, or a `tag`. Running every scenario on the machine is never what anybody means.' });
      }
      if (!chosen.length) {
        return asText({
          ok: false,
          error: 'the set is empty',
          ...(project ? { project } : {}),
          ...(tag ? { tag } : {}),
          ...(panel === null ? { note: 'the extension was not reachable, so scenarios recorded in the panel were not counted' } : {}),
          known: everyKnown(),
        });
      }

      const results = [];
      for (const item of chosen) {
        results.push(item.from === 'panel'
          ? await runPanelScenario(tabId, item.head, values, dry_run)
          : { ...(await runSuiteRecipe(tabId, item.rec, values, dry_run)), from: 'file' });
      }
      const passed = results.filter((r) => r.ok).length;
      return asText({
        ok: passed === results.length,
        mode: dry_run ? 'dry run — nothing was touched' : 'live',
        ...(project ? { project } : {}),
        ...(tag ? { tag } : {}),
        summary: `${passed} of ${results.length} passed`,
        /* THE SHORTENED SET IS THE DANGEROUS ONE. A set that came back empty says so loudly;
           a set that came back with four of its six members looks complete — and the two that
           are missing are the ones a human recorded. Worse, a name held by both shelves then
           silently flips from the panel's copy to the file's, which the code elsewhere calls
           "usually an older export of it". So the warning rides every answer, not just the
           empty one. */
        ...(panel === null ? { incomplete: 'the extension was not reachable, so scenarios recorded in the panel were not part of this set — and any name held by both was run from the file instead of the panel' } : {}),
        ...(passed === results.length ? {} : { failed: results.filter((r) => !r.ok).map((r) => `${r.recipe} — step ${r.stoppedAt ?? '?'}`) }),
        results,
      });
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

/**
 * THE PANEL'S OWN SCENARIOS, ADDRESSABLE BY AN AGENT (owner ask, 2026-08-26).
 *
 * Two stores existed and neither knew about the other: recipes recorded by an agent are FILES
 * here, recipes recorded by a human in the panel live in the extension. So "what scenarios do I
 * have" had two answers, `hello` announced "first time on this host" while the panel held five,
 * and a hand-recorded flow could never be part of a suite.
 *
 * The extension is the owner of what a human recorded — it is where the licence is, where the
 * recording happens and where the data has to be hidden when a trial lapses — so these three
 * verbs read through it rather than copying. Nothing is duplicated to disk: a copy is a second
 * answer waiting to disagree.
 */
server.registerTool(
  'qa_scenarios',
  {
    title: 'List the scenarios recorded in the panel',
    description:
      'The flows the human recorded in Qiksy\'s Scenarios tab, on this machine: name, project, tags, step and field counts, and — the part you need — the PLACEHOLDERS each one asks for. ' +
      'A scenario stores its route, not its content: a bug report or a task keeps the same fields every time and different text, so the values are named holes ({summary}, {steps}) that you fill per run. ' +
      'Worth one call before any long form on a host the human works on. Free, no consent, no browser action.',
    inputSchema: {
      tabId: tabIdArg,
      host: z.string().optional().describe('Only scenarios recorded on this host'),
      project: z.string().optional().describe('Only scenarios filed under this project'),
    },
  },
  async ({ tabId, host, project }) => {
    try {
      return asText(await callExtension('qa_scenarios', { tabId, host, project }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  'qa_scenario_get',
  {
    title: 'Read one scenario in full',
    description:
      'Everything about one recorded flow: its steps, every field with the value or placeholder it holds, and the flat label-to-value object the panel edits. ' +
      'Read this before running one you did not record — it is how you find out which placeholders exist and what a field is called.',
    inputSchema: { tabId: tabIdArg, name: z.string().describe('The scenario name (or part of it) from qa_scenarios') },
  },
  async ({ tabId, name }) => {
    try {
      return asText(await callExtension('qa_scenario_get', { tabId, name }));
    } catch (e) {
      return asError(e);
    }
  },
);

/**
 * SAVE WHAT WE JUST DID INTO THE PANEL, not onto the disk (owner ask, 2026-08-26).
 *
 * `qa_recipe_save` writes a FILE. A file is fine for an agent — it is where a suite used to
 * look — but the human cannot press Run on it: the panel reads the extension's own store and
 * nothing else. So the expensive half of a session, the forty calls it took to work out how
 * this form is driven, could not become the thing the person presses next week. This verb
 * closes that: it folds the same journal the same way and hands the result to the extension.
 *
 * The two saves are deliberately kept apart rather than merged. A file is portable, greppable
 * and survives the browser; a panel scenario is what a human runs and what their licence
 * covers. Writing both from one call would make "where is my scenario" have two answers again,
 * which is the bug this whole store split exists to prevent — so this one says, in its reply,
 * exactly where the thing it made now lives.
 */
server.registerTool(
  'qa_scenario_save',
  {
    title: 'Save this flow into the panel, so the human can run it',
    description:
      "Turn what you just drove into a scenario in Qiksy's Scenarios tab — the same list the human records into by hand, on the same machine. " +
      'Call it with a name and it builds the flow from what this session actually filled: fields by accessible name, uploads, and the control you clicked to move on, folded into steps. Pass `steps` to write or correct one by hand. ' +
      'THIS IS THE ONE THE HUMAN CAN PRESS. qa_recipe_save writes a file for you to replay; this puts it in front of the person, with Run, Data and Random beside it, and it can be part of a project suite. ' +
      'Do it at the end of any flow that took more than a few calls, and tell them in one line that it is there — a scenario nobody knows about is one nobody runs. ' +
      'Stores data and touches no page, so it needs no Agent-control consent and no licence — scenarios are free, like everything else.',
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe('What the human will look for in the list — "file a bug", "new client", "weekly invoice"'),
      from_page: z
        .boolean()
        .optional()
        .describe(
          'Read the answers off the form AS IT STANDS on the page, instead of from what this session drove. ' +
          'This is the one to use when the HUMAN filled the form themselves and then asked you to save it — you were not there, so there is nothing in the journal to fold. ' +
          'ONE PAGE ONLY: a wizard\'s earlier screens are no longer in the DOM, so a multi-step flow has to be recorded with the panel\'s Record button instead, and the reply says so. Passwords are kept as fields, never as values.',
        ),
      project: z.string().optional().describe('Which product or client this belongs to. It groups the list AND is what qa_suite_run runs by.'),
      tags: z.array(z.string()).optional().describe('Labels for picking a subset later — ["smoke"], ["billing"]'),
      url: z.string().optional().describe("Where the flow starts. Defaults to the first step's page."),
      notes: z.string().optional().describe('Anything the replay should know that the fields do not say — a precondition, a role to be signed in as'),
      steps: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().optional(),
            navigate: z.string().optional().describe('Go to this address before the step — for a flow that crosses pages or domains'),
            fields: z
              .array(
                z.object({
                  name: z.string().describe("The field's accessible name — the durable key across runs, and what the panel shows the human"),
                  selector: z.string().optional(),
                  value: z.string().optional().describe('Or a {placeholder}, which the human fills per run in the panel'),
                  action: z.enum(['type', 'click', 'date', 'path']).optional(),
                  kind: z.string().optional(),
                  secret: z.boolean().optional().describe('A password or card field: recorded as a FIELD, never as a value'),
                }),
              )
              .optional(),
            advance: z.object({ name: z.string().optional(), selector: z.string().optional(), role: z.string().optional() }).optional(),
          }),
        )
        .optional()
        .describe('Write the steps explicitly instead of deriving them from this session'),
    },
  },
  async ({ tabId, name, project, tags, url, notes, steps, from_page }, extra) => {
    const bar = loader(extra, 'handing the flow to the panel');
    try {
      /* Reading the page needs no journal — that is the whole point of it. */
      if (from_page) {
        return asText(await callExtension('qa_scenario_save', {
          tabId,
          from_page: true,
          recipe: { name, ...(project ? { project } : {}), ...(tags?.length ? { tags } : {}), ...(notes ? { notes } : {}) },
        }, 30_000));
      }
      const startUrl = url || rememberedUrl(tabId) || journal[journal.length - 1]?.url || '';
      const built = steps && steps.length ? steps : stepsFromJournal(startUrl);
      if (!built.length) {
        return asText({
          ok: false,
          error: 'nothing to save',
          note:
            'Nothing has been filled or clicked through this bridge yet in this session, so there is no flow to fold. ' +
            'Drive the form first, then save — or pass `steps` explicitly. If the HUMAN filled it by hand, they record it with the Record button in the Scenarios tab; this bridge cannot see what it did not do.',
        });
      }
      const openAt = url || built[0]?.url || startUrl;
      const recipe = {
        recipe: 'qiksy-recipe/v1',
        name,
        url: openAt,
        host: hostOf(openAt) || hostOf(startUrl),
        saved: new Date().toISOString(),
        ...(project ? { project } : {}),
        ...(tags && tags.length ? { tags } : {}),
        ...(notes ? { notes } : {}),
        steps: built,
      };
      return asText(await callExtension('qa_scenario_save', { tabId, recipe }, 30_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

server.registerTool(
  'qa_scenario_run',
  {
    title: 'Run a scenario the human recorded',
    description:
      'Replay a flow recorded in the panel, on the page as it is now, with YOUR data. ' +
      'Give `vars` for its placeholders ({ "summary": "Login 500s" }) and/or `values` to override any field by its label. ' +
      'This is how a form somebody fills weekly — a bug in Jira, a task, a story — becomes one call: the route was recorded once by a human who knows the form, and you supply the text. ' +
      'Each step is filled through the same engine as the panel\'s Fill, and the run STOPS at the first field the page no longer has rather than filling on and pressing Next over an invalid form.' +
      DRIVE_NOTE,
    inputSchema: {
      tabId: tabIdArg,
      name: z.string().describe('The scenario name from qa_scenarios'),
      vars: z.record(z.string()).optional().describe('Answers for the placeholders — { "summary": "…", "steps": "…" }'),
      values: z.record(z.string()).optional().describe('Override any field by its label — { "Priority": "High" }'),
    },
  },
  async ({ tabId, name, vars, values }, extra) => {
    const bar = loader(extra, 'running the scenario');
    try {
      return asText(await callExtension('qa_scenario_run', { tabId, name, vars, values }, 120_000));
    } catch (e) {
      return asError(e);
    } finally {
      bar.stop();
    }
  },
);

async function main() {
  autoInstallDocs(); // before the transport: the guide must exist by the first tool call
  await server.connect(new StdioServerTransport());
  log('MCP stdio server ready');
}
main().catch((e) => {
  log('fatal', e);
  process.exit(1);
});
