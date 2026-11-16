/**
 * EVERY BRIDGE TOKEN THIS COMPUTER TRUSTS, IN ONE FILE THAT IS READ AT EVERY KNOCK.
 *
 * A bridge server used to know exactly one token: the one in the environment it was started with.
 * Install Qiksy in a second Chrome profile and that profile makes a token of its own; every agent
 * window still holds the old one, the hub on the port refuses the new browser, and the only cure
 * was restarting every Claude window on the machine, because a window reads its environment once
 * and «Reconnect» does not read it again (owner, 02.11.2026, twenty server processes deep).
 *
 * So the check is against a SET: the process's own token plus everything in
 * ~/.qiksy/bridge-tokens.json, re-read on every authentication. Every server adds its own token
 * when it starts, and `npx qiksy-mcp trust <token>` adds a browser's. Nothing has to restart: the
 * hub that is already on the port reads the file the next time the browser knocks.
 *
 * What this does not loosen: the origin check still turns away every web page, the file is the
 * owner's alone (0600), and a token is still a secret — a process that can read this file could
 * already read the agent configs the same tokens sit in.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

export const TOKENS_FILE = process.env.QIKSY_TOKENS_FILE || join(homedir(), '.qiksy', 'bridge-tokens.json');

/** A token worth storing: what the popup generates and what people paste, nothing shorter. */
export const tokenShapeOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(t);

/** `[{ token, from, at }]`; an unreadable or absent file is simply «none yet». */
export function knownTokens(file = TOKENS_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j?.tokens) ? j.tokens.filter((x) => tokenShapeOk(x?.token)) : [];
  } catch {
    return [];
  }
}

/** Add a token if it is not there. Returns 'added', 'already there' or 'refused' (bad shape). */
export function rememberToken(token, from, file = TOKENS_FILE) {
  if (!tokenShapeOk(token)) return 'refused';
  const list = knownTokens(file);
  if (list.some((x) => x.token === token)) return 'already there';
  list.push({ token, from: String(from || '').slice(0, 60), at: new Date().toISOString() });
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ tokens: list }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
    return 'added';
  } catch {
    return 'refused';
  }
}

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
};

/** Is `got` one of the tokens this machine trusts — `own` first, then the shared file. */
export function tokenTrusted(got, own, file = TOKENS_FILE) {
  if (typeof got !== 'string' || !got) return false;
  if (own && same(got, own)) return true;
  return knownTokens(file).some((x) => same(got, x.token));
}
