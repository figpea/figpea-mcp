import * as path from 'node:path';

/**
 * REQ-1283 — the one place a `filePath` is allowed to lose its extension.
 *
 * The incident (card REQ-1283): `session.openFile({ filePath: '/abs/…/design.fp',
 * name: 'design' })` reported a perfectly valid `.fp` as "file may be corrupt,
 * unsupported, or empty". The extension was never lost on the wire — the bridge
 * URL is `http://localhost:<port>/file?path=%2Fabs%2F…%2Fdesign.fp`, which
 * carries it as a query parameter. It was lost in the relayed **input**: both
 * relay sites defaulted `fileName` to `path.basename(filePath)`, but only when
 * the caller supplied neither `fileName` nor `name`. The descriptor explicitly
 * allows `name` as an alias for `fileName`, so a caller using it lost the
 * extension, and the editor — which selects a decoder from the *name* it is
 * given (`performOpen` consults `source.type` and the decoder registry, not the
 * URL's query string) — had nothing to select a decoder from.
 *
 * Pure, no bridge, no I/O, no zod: the `argShape.ts` / `rawJson.ts` precedent
 * (REQ-1268, REQ-1037), which exists so a 1500-line `mcpServer.ts` does not
 * grow a rule inline twice.
 *
 * Returns the name to set on the relayed input, or `undefined` for "set
 * nothing" — the caller keeps its own value, which is the whole point of rules
 * 1 and 2: an extension is only ever *preserved* here, never invented, and
 * never substituted for one the caller chose.
 */
export function resolveOpenFileName(args: {
  filePath: string;
  fileName?: unknown;
  name?: unknown;
}): string | undefined {
  const ext = path.extname(args.filePath);

  // The caller's own name signal, `fileName` first — the same precedence v3
  // applies when it reads the input (`obj.fileName ?? obj.name`).
  const callerName = firstNonEmptyString(args.fileName, args.name);

  // Rule 4 — no caller name: today's basename default, byte-for-byte. Evaluated
  // BEFORE rule 1 and deliberately independent of `ext`, because the pre-fix code
  // applied it unconditionally: a dotless `/tmp/x/design` with no `name` has
  // always been relayed as `design`, and v3 falls back to the literal string
  // `"unnamed"` when neither key is set (`session.impl.ts:273`), so gating this
  // on `ext` would rename the document out from under a case that already works.
  if (callerName === undefined) return path.basename(args.filePath);

  // Rule 1 — a genuinely extensionless path carries no extension to preserve.
  // Never invent one: this is what keeps a sniffing open (AC-5) untouched.
  if (ext === '') return undefined;

  // Rule 2 — a name that already carries an extension is an explicit signal
  // and outranks a derived one. `lastIndexOf('.') > 0`, not `includes('.')`:
  // a leading dot is a dotfile, not an extension, which is also how v3's own
  // `ensureFileNameExtension` guards the other side of this boundary.
  if (callerName.lastIndexOf('.') > 0) return undefined;

  // Rule 3 — the fix: keep the caller's chosen stem, restore the routing signal
  // the filesystem already knows.
  return `${callerName}${ext}`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}
