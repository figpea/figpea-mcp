/**
 * REQ-1295 (AC-2, AC-4) — the positional ENCODING, derived.
 *
 * `describe()` publishes a method's parameters two ways at once: as a NAMED
 * DECLARATION (`params` keyed by parameter name) and — because `figpea_call`
 * and every generated full-mode tool take them POSITIONALLY — as nothing at
 * all. The declaration is the editor's contract and is correct; what is missing
 * is the sentence connecting it to the shape an agent must actually send.
 *
 * For a method whose argument is an OBJECT the two forms DIVERGE, and nothing
 * on the surface says which one is the encoding: an agent that reads `params`
 * and sends the declaration gets its wrapper delivered as the object itself,
 * and the editor answers about a style key it never received. That is the trap
 * this module's output exists to remove.
 *
 * ⛔ DERIVE, NEVER ENUMERATE. Nothing below names a method or a parameter. A
 * method published this way is covered with no edit here, and a parameter that
 * later gains a field is right for free. A hard-coded list would be the drift
 * generator the very next contract change has to come back and edit — the same
 * rule, and the same mechanically-pinned technique, as `argShape.ts`'s per-kind
 * rule.
 *
 * ⛔ NO OPINION ⇒ NO KEY. A legacy free-text manifest's `params` values are
 * hint STRINGS rather than schemas, so there is no encoding to state: the
 * caller omits the key entirely rather than publishing a partial one, which
 * would read as "this method takes no arguments". This is REQ-1318's exact
 * rule for `stringJsonParams`, and the two keys must not collide.
 *
 * Dependency-free by construction (same constraint `tools.ts` documents: no
 * `ws`/SDK/zod value imports), so `tools.ts` can import from here for full
 * mode and the derivation stays ONE function the two lanes cannot disagree
 * about.
 */

/** One positional slot, as the manifest's own declaration renders it. */
export interface WireArg {
  /** The slot this parameter occupies — `0` is `args[0]`. */
  index: number;
  /** The parameter's declared name. The declaration is not the encoding. */
  name: string;
  type: string;
  required?: boolean;
  /** Object params only: the declared shape's own keys, in declaration
   *  order. The legal contents of this slot, i.e. what to send AT it. */
  contents?: string[];
  /** Object params only: the one envelope the caller must NOT send, rendered
   *  from this parameter's own key. Derived, so it cannot name a parameter
   *  that does not exist. */
  notThis?: string;
}

export interface WireEncoding {
  encoding: 'positional';
  /** The literal call form — `group.method(first, secondContents)`. */
  callAs: string;
  note: string;
  args: WireArg[];
}

/**
 * The one-line universal statement, carried by a GROUP listing so an agent
 * learns the rule once for every method it holds rather than per describe
 * round trip. Says the thing that is true of the whole surface.
 *
 * Deliberately NOT a prohibition. A single object as the whole of `args`,
 * keyed by the method's own parameter names, is legal and expands to
 * positional order — so "never wrap" on its own would be false, and the editor
 * ships that form deliberately.
 */
export function groupEncodingNote(): string {
  return (
    'Arguments are POSITIONAL and unwrapped — figpea_call({group, method, args}) takes args in the order each ' +
    "method's wire.args lists them, in that method's own parameter order. An object-valued parameter IS its " +
    "positional slot: pass its CONTENTS flat, never an envelope keyed by the parameter's name. (A single object " +
    'as the whole of `args`, keyed by the method\'s own parameter names, is the one legal wrapper — the editor ' +
    'expands it — and it expands only while it is the whole of `args`.) figpea_describe({group, method}) lists ' +
    'one method\'s wire under `wire`.'
  );
}

/**
 * The per-method statement. One fact, in the three sentences that make it
 * usable: what the encoding is, where to read it, and what an object slot
 * takes.
 */
function perMethodNote(): string {
  return (
    'Arguments are POSITIONAL and unwrapped — figpea_call({group, method, args}) takes args in the order of ' +
    'wire.args. An object-valued parameter IS its positional slot: pass its CONTENTS flat, never an envelope ' +
    "keyed by the parameter's name."
  );
}

/** The structural minimum a `params` entry must carry to be a schema this
 *  module can reason about. Identical to `tools.ts`'s own predicate — a
 *  legacy free-text hint string is not one. */
function isSchema(value: unknown): value is { type: string; required: boolean; shape?: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { required?: unknown }).required === 'boolean'
  );
}

/** The legal contents of one object slot: its declared shape's own keys, in
 *  declaration order. `undefined` when the parameter declares no shape — an
 *  object with no declared keys has no contents to advertise, and publishing
 *  `[]` would read as "this parameter takes nothing". */
function declaredContents(schema: { shape?: Record<string, unknown> }): string[] | undefined {
  if (schema.shape === undefined || schema.shape === null || typeof schema.shape !== 'object') return undefined;
  return Object.keys(schema.shape);
}

/**
 * The positional encoding for one method's descriptor, or `undefined` when
 * this server has no opinion (a descriptor with no parameters, or a legacy
 * free-text `params` map this module cannot read as a declaration).
 *
 * @param descriptor the manifest's method descriptor
 * @param label       `group.method`, used to render `callAs`; omitting it
 *                    renders the parameter list alone rather than inventing a
 *                    name
 */
export function wireEncoding(
  descriptor: { params?: unknown } | undefined,
  label?: string,
): WireEncoding | undefined {
  const params = descriptor?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const entries = Object.entries(params as Record<string, unknown>);
  // A method that declares no parameters takes none: there is no positional
  // encoding to state, and a `callAs()` with an empty list says nothing an
  // agent did not already know.
  if (entries.length === 0) return undefined;
  // No opinion ⇒ no key. A legacy hint string here means this server holds no
  // declaration, so it cannot publish an encoding for one.
  if (!entries.some(([, schema]) => isSchema(schema))) return undefined;

  const args: WireArg[] = [];
  const callNames: string[] = [];
  for (const [index, [name, raw]] of entries.entries()) {
    if (!isSchema(raw)) {
      // A partially-structured map: the positional ORDER is still known from
      // the key list (it is `Object.keys(params)`, which is the correspondence
      // every generated tool already relies on), but this slot's type is not.
      // Say so rather than guessing a type.
      args.push({ index, name, type: 'unknown' });
      callNames.push(name);
      continue;
    }
    const arg: WireArg = { index, name, type: raw.type, required: raw.required };
    if (raw.type === 'object') {
      const contents = declaredContents(raw);
      if (contents) {
        arg.contents = contents;
        // The one envelope not to send, rendered from this parameter's OWN key —
        // the whole lesson in one field, and derived so it cannot name a
        // parameter that does not exist.
        arg.notThis = `{ ${JSON.stringify(name)}: { … } }`;
        // An object slot is filled with its CONTENTS, so `callAs` reads a
        // contents-suffixed parameter name rather than the bare declared name,
        // which would restate the declaration and re-create the confusion.
        callNames.push(`${name}Contents`);
        args.push(arg);
        continue;
      }
    }
    callNames.push(name);
    args.push(arg);
  }

  return {
    encoding: 'positional',
    callAs: label ? `${label}(${callNames.join(', ')})` : `(${callNames.join(', ')})`,
    note: perMethodNote(),
    args,
  };
}

/**
 * Full mode's one derived line — the SAME fact for the lane that has no
 * `figpea_describe` to ask (REQ-1295 T5, AC-4).
 *
 * Emitted only for a method declaring at least one OBJECT parameter, because
 * that is where the declaration and the encoding diverge; for a method of
 * scalars the named-key form and the positional form agree, so there is no
 * trap to defuse and no line worth the tokens.
 */
export function namedKeyEncodingLine(descriptor: { params?: unknown } | undefined): string | undefined {
  const wire = wireEncoding(descriptor);
  if (!wire) return undefined;
  const objectArg = wire.args.find((arg) => arg.contents !== undefined);
  if (!objectArg) return undefined;

  // A worked payload to copy, derived from this parameter's own name and its
  // first declared key, so the example cannot drift from the declaration it
  // illustrates.
  const params = (descriptor!.params ?? {}) as Record<string, { shape?: Record<string, unknown> }>;
  const sampleKey = objectArg.contents?.[0] ?? '…';
  const sampleValue = { [sampleKey]: '…' };
  const leading: Record<string, unknown> = {};
  for (const arg of wire.args) {
    if (arg.index >= objectArg.index) break;
    leading[arg.name] = '…';
  }
  const correct = JSON.stringify({ ...leading, [objectArg.name]: sampleValue });
  const doubled = JSON.stringify({ ...leading, [objectArg.name]: { [objectArg.name]: sampleValue } });

  return (
    'Encoding: parameters are NAMED here — pass them as this tool\'s own keys, and an object-valued ' +
    `parameter takes its CONTENTS under its key: ${correct} — never a second copy of the key: ${doubled}.`
  );
}