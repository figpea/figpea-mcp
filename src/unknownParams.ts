/**
 * REQ-1296 D2 — the one question this server was never able to ask:
 * **"did I understand every key I was given?"**
 *
 * The incident (2026-09-27): a design run's author called
 * `canvas.screenshot({filePath: "…/shot.png"})` to persist its own acceptance
 * evidence. `canvas.screenshot` declares no such parameter, so the call
 * answered `ok:true` with the image inline and **wrote nothing**. The agent
 * reported a captured round-trip screenshot that did not exist; only an
 * independent reviewer checking the filesystem caught it, at the end of a
 * three-round build.
 *
 * There was no predicate to blame, because there was no predicate: an unknown
 * key was destroyed by the SDK's zod parse (see `buildInputShape`'s REQ-1296
 * note) before this server ever saw it, and the handler then forwards only
 * the manifest's declared `inputKeys`. "Is this param valid?" is not the
 * question either — the question is whether every key is *known*, and an
 * unknown key is knowable exactly once it survives the boundary.
 *
 * Pure, no bridge, no I/O, so it is unit-testable in isolation —
 * `argShape.ts` (REQ-1268) is the in-repo precedent for exactly this split,
 * and it keeps a 1200-line `mcpServer.ts` from growing.
 */

/**
 * The keys every generated contract tool (full mode) accepts beyond its own
 * manifest parameters. Declared in the shape so they survive the SDK's parse,
 * and excluded from `inputKeys` by construction so they are never forwarded to
 * the tab.
 *
 *   - `_timeoutMs` (REQ-772) — per-call bridge timeout, clamped to the cap.
 *   - `_rawJson`   (REQ-1037) — passthrough for stringified nested numbers.
 *   - `returnAs`   (REQ-1020/1279) — off-band binary return, `"inline"|"path"`.
 */
export const FULL_MODE_RESERVED = ['_timeoutMs', '_rawJson', 'returnAs'] as const;

/**
 * The keys `figpea_call` (compact mode) accepts. The dispatcher's own three
 * plus the three reserved keys every contract tool gets — a reserved key means
 * the same thing through the dispatcher, because the dispatcher forwards to
 * the very same tab method.
 */
/**
 * REQ-1498 adds `_opsFile` — a per-call path to a JSON file whose content is the
 * method's top-level array/matrix payload. It is a RESERVED key rather than a
 * declared param because it is read by this server and never forwarded to the
 * tab, exactly like `_timeoutMs`/`_rawJson` beside it; the declared key a
 * caller writes on full mode's generated tool is the unprefixed `opsFile`, which
 * `mcpServer.ts` allows and strips per-tool (derived from the manifest, so no
 * method name appears in either module).
 *
 * `opsFile` is deliberately NOT in this list: on full mode the allowance is
 * per-tool and derived (only for a tool whose manifest declares a top-level
 * array/matrix param), so putting it here would advertise the key on every
 * generated tool whether or not it can mean anything.
 */
export const COMPACT_RESERVED = ['group', 'method', 'args', '_timeoutMs', '_rawJson', 'returnAs', '_opsFile'] as const;

/**
 * Returns every key of `raw` that is neither declared nor reserved, in
 * arrival order.
 *
 * Judged by NAME and nothing else. A declared key carrying a bad value is a
 * different failure with a different message (`returnAs:"path"` is caught by
 * `resolveReturnAs`, a bad enum by zod), and folding the two together here
 * would duplicate the first and contradict the second. An unknown key is
 * unknown whatever it holds — `null`, `undefined` and `0` included, since
 * "the caller sent a key I do not understand" is true regardless of the value
 * they put in it, and a value-shaped test would let `"filePath": null` through
 * silently.
 *
 * Own enumerable keys only (`Object.keys`), which is exactly the set the SDK
 * hands the handler: a payload assembled from a prototype chain is not
 * carrying evidence the caller sent, and a `hasOwnProperty`-free `for…in`
 * would report inherited names as caller mistakes.
 */
export function findUnknownTopLevelKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) unknown.push(key);
  }
  return unknown;
}

/**
 * REQ-1508 — the `figpea_call`-level keys that are never read from inside
 * `args`, and the pure scanner that finds them one level down.
 *
 * The card names exactly this pair (`returnAs`, `_rawJson`): the two whose
 * misplacement silently changes result shape/parse behaviour (megabytes
 * inline / unparsed JSON). A nested `_timeoutMs` merely falls back to the
 * default timeout — a lower-harm class, deliberately not scanned.
 *
 * No contract method declares a parameter named `returnAs`/`_rawJson` (both
 * lanes reserve and strip them server-side, never forward), so a nested
 * own-key with either name cannot be a legitimate method argument — while a
 * VALUE equal to one of those strings is not a hit (keys only).
 */
export const NESTED_RESERVED = ['returnAs', '_rawJson'] as const;

/** A nested reserved key, and the `args[…]`-rooted position it was found at. */
export interface NestedReservedHit {
  path: string;
  key: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walks the `args` tree and returns every own-key of `NESTED_RESERVED` on any
 * plain object in it, with positions rendered as `args[1].returnAs` (and
 * deeper, e.g. `args[0][0].args[1].returnAs` for a `layer.batch` op's inner
 * args). Arrays are descended into; non-plain objects (class instances, Dates
 * and the like) are skipped — a key on one is not caller-sent evidence, the
 * same way an inherited key is not. Pure, no bridge, no I/O.
 */
export function findNestedReservedKeys(args: unknown): NestedReservedHit[] {
  const reserved = new Set<string>(NESTED_RESERVED as readonly string[]);
  const hits: NestedReservedHit[] = [];
  const visit = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], `${at}[${i}]`);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      if (reserved.has(key)) hits.push({ path: `${at}.${key}`, key });
      visit(value[key], `${at}.${key}`);
    }
  };
  visit(args, 'args');
  return hits;
}
