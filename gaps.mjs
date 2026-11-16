/**
 * WHAT THE BRIDGE COULD NOT DO — written down instead of lost in a transcript.
 *
 * Owner, 16.09.2026, asking whether the bridge should become flexible enough to do anything: the
 * honest answer is that no tool does anything, and the ones that try end up executing whatever
 * they are handed. What a tool CAN do is say precisely what it could not do, and remember it.
 *
 * So this is the other half of flexibility, and the half that survives a Web Store review: the
 * agent hits a wall, names it in one call, and the wall goes into a file the human reads. The
 * flexibility then happens where it is safe — in the next version, with a verb that has a name
 * and a stand — rather than at runtime inside somebody's browser.
 *
 * Why a file and not a counter: the interesting part of a gap is the SENTENCE. «qa_read cannot see
 * inside the iframe on the payment step» is a feature request; «iframe: 7» is a statistic nobody
 * can act on. One line of JSON per gap, appended, never rewritten — the log is the record, and a
 * record a process can rewrite is a record it can lose.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const GAPS_FILE = process.env.QIKSY_GAPS_FILE || join(homedir(), '.qiksy', 'gaps.jsonl');

const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);

/**
 * Record one gap. `at` is passed in rather than read from the clock so the caller owns the
 * timestamp — and so this file can be tested without one.
 */
export function recordGap(entry, at) {
  const wanted = clip(entry?.wanted, 400);
  if (!wanted) return { ok: false, error: 'say what you wanted the bridge to do, in one sentence (`wanted`)' };
  const row = {
    at: at ?? new Date().toISOString(),
    wanted,
    verb: clip(entry?.verb, 60) || null,
    tried: Array.isArray(entry?.tried) ? entry.tried.slice(0, 8).map((t) => clip(t, 120)).filter(Boolean) : [],
    /* The address is the difference between a report somebody can reproduce and a wish. Stripped
       of its query the same way every other artefact here is: a gap report is a document that
       leaves this machine, and a one-time token in a URL must not ride along. */
    url: clip(String(entry?.url ?? '').split('?')[0], 200) || null,
    blocked: entry?.blocked === true,
  };
  try {
    mkdirSync(dirname(GAPS_FILE), { recursive: true });
    appendFileSync(GAPS_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write ${GAPS_FILE}: ${String(e?.message || e).slice(0, 120)}` };
  }
  return { ok: true, recorded: row, file: GAPS_FILE };
}

/** Read the log back, newest first. A malformed line is skipped rather than taking the list down. */
export function listGaps(limit = 50) {
  if (!existsSync(GAPS_FILE)) return [];
  let text = '';
  try {
    text = readFileSync(GAPS_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written line from a killed process is not a reason to lose the rest */
    }
  }
  return out.reverse().slice(0, Math.max(1, Math.min(500, limit)));
}

/**
 * THE INVITATION THAT RIDES A REFUSAL.
 *
 * A verb that says no and nothing else teaches the agent to go round it — usually by switching to
 * another driver, which is the failure this project spends the most words preventing. The same
 * refusal carrying «and if the bridge genuinely cannot, say so with qa_gap» turns a dead end into
 * one call. Rate-limited by the caller: an invitation on every refusal is noise, and noise is how
 * a good instruction stops being read.
 */
export function gapInvite(verb) {
  return {
    ifTheBridgeCannot: `If this is not a mistake in the call but something the bridge genuinely cannot do, record it: qa_gap { verb: "${verb}", wanted: "<one sentence>" }. It goes into a file the human reads, and that is how the missing verb gets built.`,
  };
}
