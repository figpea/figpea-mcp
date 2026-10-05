/**
 * REQ-1498 — the PAYLOAD-FROM-A-FILE reader, one implementation for both lanes.
 *
 * This module owns reading a caller-named JSON file into the top-level array
 * argument of a call: the size ceiling, the read, the parse, and every refusal
 * that can be decided without spending a tab round trip.
 *
 * It is its OWN module, not a section of `mcpServer.ts`, for REQ-1280 AC-7:
 * that card's structural guarantee is that the server file owns no `JSON.parse`
 * at all, so the `_rawJson` flag's parse has exactly one home and the loop cannot
 * be forked. The parse here is a different payload — the CONTENTS OF A FILE, not a
 * call's argument — but it landed in the server file, which made that pin red on a
 * correct addition. Moving it here keeps the pin at full strength instead of
 * weakening it with an exemption, and it is the honest home anyway: this is a
 * self-contained concern with its own ceiling, and `mcpServer.ts` decides where a
 * payload lands rather than how it was fetched.
 */

import * as fs from 'node:fs';
import type { ParamSchemaLike } from './tools';

/**
 * The read ceiling for the payload file, in bytes. A READ guard, not a budget
 * claim: the editor still measures the substituted payload against its own
 * `argsChars` limit and refuses an over-budget array whole, so this number
 * only bounds what is loaded into memory before that happens.
 *
 * Sized so nothing legitimate is refused. The editor refuses above ~22 000
 * serialized characters of the whole `args`, two orders of magnitude below
 * this, so a payload that could ever succeed is far inside the ceiling — which
 * exists to stop a 2 GB path being loaded, not to move a limit.
 */
const OPS_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Human wording for a JSON value's kind, for the not-an-array refusal. */
function jsonKindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** How the option's refusal reads once a param name is known — shared by the
 *  value checks, so one bad option produces one grammar. */
function opsFileValueRefusal(optionKey: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: 'invalid_params', message: `${optionKey} ${message}` };
}

/**
 * Reads the JSON file at `raw` and returns the array it holds.
 *
 * ONE reader, called from both lanes, because a rule stated twice is two rules.
 * Every refusal here is pre-flight and zero-round-trip; the caller supplies the
 * key name it advertised (`_opsFile` in compact mode, `opsFile` on full mode's
 * generated tool) so the message names what the caller actually wrote.
 *
 * `paramSchema` is the slot's own declaration, used only to RENDER the element
 * wording in the not-an-array refusal — so the example cannot describe an
 * element shape the manifest does not declare.
 */
export async function readArrayPayloadFromFile(
  raw: unknown,
  optionKey: string,
  paramName: string,
  paramSchema: ParamSchemaLike | undefined,
): Promise<{ ok: true; value: unknown[] } | { ok: false; code: string; message: string }> {
  if (typeof raw !== 'string') return opsFileValueRefusal(optionKey, 'must be a string');
  if (raw.trim() === '') return opsFileValueRefusal(optionKey, 'cannot be empty');
  let size: number;
  try {
    const st = await fs.promises.stat(raw);
    if (!st.isFile()) {
      // A directory, or anything else that is not a regular file. Byte-identical
      // wording to the three existing file branches, so the four cannot drift.
      return { ok: false, code: 'invalid_params', message: `file not found or not readable: ${raw}` };
    }
    size = st.size;
  } catch {
    return { ok: false, code: 'invalid_params', message: `file not found or not readable: ${raw}` };
  }
  // BEFORE the read: the point of the ceiling is that the bytes are never loaded.
  if (size > OPS_FILE_MAX_BYTES) {
    return {
      ok: false,
      code: 'invalid_params',
      message: `${optionKey}: ${raw} is ${size} bytes, which exceeds the ${OPS_FILE_MAX_BYTES}-byte read limit. Split the payload across smaller files, or across several calls.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(raw, 'utf8'));
  } catch (e) {
    // AC-4: a diagnostic naming the FILE and the PARSE FAILURE — the reader's
    // own message, quoted, so the caller is not left comparing two guesses.
    const cause = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'invalid_params', message: `${optionKey}: cannot parse ${raw} — ${cause}` };
  }
  if (!Array.isArray(parsed)) {
    const element = paramSchema?.of?.shape ? ' of {method, args} operations' : '';
    return {
      ok: false,
      code: 'invalid_params',
      message: `${optionKey}: ${raw} must contain a JSON array${element} for "${paramName}", got ${jsonKindOf(parsed)}`,
    };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      code: 'invalid_params',
      message: `${optionKey}: ${raw} contains an empty array; "${paramName}" must be a non-empty array`,
    };
  }
  return { ok: true, value: parsed };
}
