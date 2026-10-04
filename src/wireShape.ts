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
  /** REQ-1498 — array/matrix params only: a payload to COPY, rendered from
   *  this slot's OWN declared element shape. A rule with no example is what the
   *  card's AC-5 is about: the array's type was declared and its encoding was
   *  nowhere, so the mistake only appeared on the call. */
  payload?: string;
  /** Array/matrix params only: the one wrapper the caller must NOT send,
   *  rendered from this slot's own key — the array half of `notThis`. */
  notThisArray?: string;
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
 * The per-method statement. One fact, in the sentences that make it usable:
 * what the encoding is, where to read it, what an object slot takes — and, from
 * REQ-1498, what an ARRAY slot takes, which is the other half of the same trap.
 *
 * The array half is conditional on the method actually having one, because a
 * method with no array parameter would be told about a slot it does not have.
 * The predicate is the same one `wireEncoding` walks, so the sentence and the
 * slot list cannot disagree about which methods it applies to.
 */
function perMethodNote(hasArraySlot: boolean): string {
  const objectHalf =
    'Arguments are POSITIONAL and unwrapped — figpea_call({group, method, args}) takes args in the order of ' +
    'wire.args. An object-valued parameter IS its positional slot: pass its CONTENTS flat, never an envelope ' +
    "keyed by the parameter's name.";
  if (!hasArraySlot) return objectHalf;
  // ⛔ The position is named from the slot's OWN index, never from the parameter
  // name: `ops` is a declaration, and an agent that has just read `callAs`
  // naming it is exactly the reader this sentence exists for.
  return (
    `${objectHalf} ` +
    'An array- or matrix-valued parameter IS its positional slot too: pass the array itself as ONE element of ' +
    'args at that slot\'s own index (args[0] for the first parameter, args[1] for the second, and so on) — the ' +
    'bare array, never an object wrapping it and never a {key: …} envelope named after the parameter. A slot listed ' +
    'in wire.args with type "array" or "matrix" is filled with the array itself; wire.args[i].index tells you which ' +
    'args[i] it is. If your host cannot send a nested value at all, a long payload can travel as a JSON file instead ' +
    '(see opsFile on the generated tool, or _opsFile on figpea_call).'
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

const ARRAY_LIKE_TYPES = new Set(['array', 'matrix']);

/** Is this slot's declared type one whose positional slot holds the value
 *  itself? Shared by the note's predicate, the per-slot fields and full mode's
 *  line, so the three cannot disagree about which slots the rule covers. */
function isArrayLike(type: string): boolean {
  return ARRAY_LIKE_TYPES.has(type);
}

/**
 * The worked payload for one array slot: an array literal rendered from THAT
 * slot's own declared `of` shape, so the example cannot describe an element
 * shape the manifest does not declare (and is right for free when the element
 * gains a field).
 *
 * `…` marks a placeholder for the agent to fill; a schema this module cannot
 * read degrades to a bare `[…]`, which still says "the array itself".
 */
function renderArrayPayload(schema: { of?: { shape?: Record<string, unknown> } } | undefined): string {
  const shape = schema?.of?.shape;
  if (!shape || typeof shape !== 'object') return '[…]';
  const inner = Object.entries(shape)
    .slice(0, 4)
    .map(([key, sub]) => {
      const type = (sub as { type?: unknown })?.type;
      // A nested object/array renders as `…`: the claim being made is about the
      // slot being the array, not about the depth of its elements.
      if (type === 'object' || type === 'array' || type === 'matrix') return `"${key}": …`;
      if (type === 'string') return `"${key}": "…"`;
      if (type === 'number') return `"${key}": 0`;
      if (type === 'boolean') return `"${key}": false`;
      return `"${key}": …`;
    })
    .join(', ');
  return `[{ ${inner} }]`;
}

/** The array half of `callNames`: the parameter name suffixed, because the bare
 *  declared name is the thing that reads like a keyword argument. */
function arrayCallName(name: string): string {
  return `${name}Array`;
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
  let hasArraySlot = false;
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
    } else if (isArrayLike(raw.type)) {
      hasArraySlot = true;
      arg.payload = renderArrayPayload(raw as { of?: { shape?: Record<string, unknown> } });
      arg.notThisArray = `{ ${JSON.stringify(name)}: ${arg.payload} }`;
      callNames.push(arrayCallName(name));
      args.push(arg);
      continue;
    }
    callNames.push(name);
    args.push(arg);
  }

  return {
    encoding: 'positional',
    callAs: label ? `${label}(${callNames.join(', ')})` : `(${callNames.join(', ')})`,
    note: perMethodNote(hasArraySlot),
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

/**
 * REQ-1498 — the ARRAY half of the same lesson, for the lane that has no
 * `figpea_describe` to ask, derived from the SAME `wireEncoding` walk the
 * compact lane's `wire` key is rendered from.
 *
 * ⚠️ LOAD-BEARING, and structurally so: `namedKeyEncodingLine` above returns
 * `undefined` whenever no slot declares an object `shape`, which is EVERY
 * array/matrix slot — so `layer.batch` got nothing from it and would still get
 * nothing after a `wireShape`-only change, leaving the defect alive in the very
 * lane that is the AC-2 calling convention. This function is the other half, and
 * `tools.ts` pushes it BESIDE `namedKeyEncodingLine`, so one derivation feeds
 * both lanes and a method with both an object and an array slot gets both lines.
 *
 * Emitted only for a method declaring at least one array/matrix parameter: for
 * a method of scalars and objects the existing line already says everything, and
 * a blank line in every generated description is noise.
 *
 * The sentence is the compact lane's `note` VERBATIM — asserted by
 * `req1498DescribeEncoding.test.ts` — so an agent that learned the rule from
 * `figpea_describe` and an agent that learned it from `tools/list` read one
 * wording, not two that can drift.
 */
export function arraySlotEncodingLine(descriptor: { params?: unknown } | undefined): string | undefined {
  const wire = wireEncoding(descriptor);
  if (!wire) return undefined;
  const arrayArg = wire.args.find((arg) => arg.payload !== undefined);
  if (!arrayArg) return undefined;
  return (
    `${wire.note} ` +
    `In this tool's own keys, ${arrayArg.name} takes the array itself: { ${JSON.stringify(arrayArg.name)}: ${arrayArg.payload} } — ` +
    `never a second copy of the key: { ${JSON.stringify(arrayArg.name)}: { ${JSON.stringify(arrayArg.name)}: … } }. ` +
    'To keep a long payload out of the call entirely, pass opsFile instead: the absolute path of a JSON file whose content is that array.'
  );
}