/**
 * REQ-1282 D1 — the one home for the per-call timeout ladder.
 *
 * The policy used to live in two files that could not see each other: the cap,
 * the known-slow table and the resolver in `mcpServer.ts`, the actual deadline
 * in `bridgeServer.ts` as a flat 10-second constant. Two constants meaning
 * "the default" is exactly how the card's incident happened — a method outside
 * the table got the flat 10 s, which is shorter than the editor's render-settle
 * window on a large project, so the relay reported a `bridge_error` for a
 * mutation the tab went on applying.
 *
 * So the whole ladder moves here, a zero-import leaf module both consume — the
 * same "one place, one number" shape `protocol.ts` and `rawJson.ts` already use
 * in this package. It stays a leaf deliberately: `mcpServer.ts`'s
 * `BridgeServerHandle` is a structural stand-in, not an import, so importing
 * `bridgeServer` into `mcpServer` (or the reverse) would be a new and wrong
 * coupling.
 */

/** REQ-772 AC-1 — the documented maximum a per-call `_timeoutMs` override may
 * raise a single bridge call's timeout to. Values above it are clamped (not
 * rejected), per the README's stated semantics. */
export const MAX_CALL_TIMEOUT_MS = 120_000;

/** REQ-772 AC-2 — raised default timeouts for known-slow contract methods,
 * keyed by tool name (`${group}_${method}`). Lives next to the tool
 * registration so docs and code stay in one place. Mirrored verbatim in
 * README.md ("Call timeouts") — keep them in sync. */
export const DEFAULT_TIMEOUT_TABLE_MS: Record<string, number> = {
  session_openFile: 120_000,
  session_waitForIdle: 30_000,
  export_project: 120_000,
  export_specBundle: 60_000,
  export_assetHarvest: 120_000,
  export_figmaKit: 60_000,
};

/** REQ-1282 AC-1/AC-2 — the flat floor for every method the table does not
 * name, and `callTab`'s own default parameter, so the relay's deadline and the
 * MCP layer's resolved deadline are the same number by construction.
 *
 * 60 s rather than the 10 s this replaced, and deliberately rather than the
 * 120 s cap: an editor settling a burst of mutations on a large project can
 * outlast 10 s, and an agent that trusts that envelope concludes the design
 * failed when it succeeded — then retries the `create` and silently duplicates
 * the layer. But a floor at the 120 s cap would be worse: the *host* MCP
 * client has its own request timeout that no `_timeoutMs` can raise, so on any
 * host whose ceiling is below ours the host always wins and the agent gets an
 * opaque `MCP error -32001` with no envelope at all. At 60 s the relay's own
 * deadline is normally the one that fires, so the informative `bridge_error`
 * — which names the state check to run — is what the agent actually sees.
 *
 * The trade-off is accepted deliberately: a genuinely stuck tab now reports
 * after up to 60 s rather than 10 s. A caller who wants it shorter passes a
 * smaller `_timeoutMs`; the resolver honours any finite `> 0` value in both
 * directions.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** REQ-772/REQ-1282 — resolves the timeout for one contract-tool call:
 * a usable `_timeoutMs` override (finite, > 0) wins, clamped to the cap;
 * anything else falls through to the method-aware table, then to the flat
 * floor. Non-number/NaN/≤0 values are ignored rather than rejected — a broken
 * knob must not fail an otherwise-valid call.
 *
 * The one REQ-1282 change: this now ALWAYS returns a number. The old
 * `number | undefined` fall-through meant every method outside the six-entry
 * table reached `callTab` with no deadline of its own and silently inherited
 * whatever the relay's default parameter happened to be — the mechanism
 * behind the card's false negative. Both lanes (compact `figpea_call` and
 * full-mode contract tools) call this, so one edit fixes both.
 */
export function resolveTimeoutMs(toolName: string, rawOverride: unknown): number {
  if (typeof rawOverride === 'number' && Number.isFinite(rawOverride) && rawOverride > 0) {
    return Math.min(rawOverride, MAX_CALL_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_TABLE_MS[toolName] ?? DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * The methods that only READ the design: queries, measurements, reports and
 * renders, which return data and change nothing. Re-issuing one is free, and
 * there is no state to go and look for.
 *
 * This is a positive allowlist, and it has to be: the contract carries no
 * read-only flag, so "does this change anything?" is not derivable from it —
 * and the previous build answered it with a method-name heuristic, which let
 * `session.newProject` (a call that replaces the whole document) through and
 * told the agent to re-issue it. Failing CLOSED is the only safe direction: a
 * method nobody audited is simply not in here, so it gets the conservative
 * whole-tree check rather than an unchecked promise.
 *
 * Audited 2026-09-30 against the published contract
 * (`v3/static/agent/contract.json`, surfaceVersion 2.51.0, 102 methods), and
 * re-audit this whenever the editor's agent surface moves — the cost of a
 * stale entry is only a less targeted hint, never a wrong one.
 */
const REISSUE_SAFE_READS: ReadonlySet<string> = new Set([
  'session_layerTree',
  'session_layerById',
  'session_find',
  'session_getSelection',
  'session_findMatching',
  'session_layersAtPoint',
  'session_waitForIdle',
  'layer_getRegionFills',
  'layer_measureText',
  'canvas_screenshot',
  'canvas_getViewport',
  'canvas_layerRect',
  'canvas_widgetGeometry',
  'canvas_gradientWidgetGeometry',
  'report_summary',
  'report_copyDeck',
  'report_fonts',
  'report_diagnostics',
  'report_projectImages',
  'font_listAliases',
  'font_getAlias',
  'component_getStates',
  'component_getChildOverrides',
  'component_getOverrides',
  'interaction_list',
]);

/** The methods that read the design and then write their OWN output — the
 * exports. Separate from the reads above because the claim is different: a
 * timed-out export may or may not have written its file, but it cannot have
 * touched the design, so re-issuing it is safe and simply overwrites that
 * output. A separate sentence because "this call only reads the design" would
 * be false here, and this whole clause exists to stop telling agents things
 * that are not true. */
const REISSUE_SAFE_EXPORTS: ReadonlySet<string> = new Set([
  'export_layer',
  'export_artboard',
  'export_project',
  'export_specBundle',
  'export_tokens',
  'export_originals',
  'export_assetHarvest',
  'export_figmaKit',
  'export_contactSheet',
  'export_flowPoster',
]);

/**
 * The methods whose FIRST argument really is a layer id **and whose effect a
 * curated node actually reports** — the only two things that make
 * `session.layerById(<id>)` a valid answer to "did this apply?".
 *
 * The value of each entry is the `FigpeaLayerNode` field that reveals the
 * effect, and it is not decoration: it is the admission ticket, and
 * `req1282TimeoutEnvelope.test.ts` gates every value against the node's real
 * field list (v3 `src/agent/serialize.ts`). A bare set of method names was
 * wrong twice — once for methods whose first parameter is not an id at all,
 * and once for methods whose id is fine but whose effect the node does not
 * carry — because "has an id" is not the same question as "can the read
 * answer". Making the second question a per-entry value means an entry cannot
 * be added without answering it, and a reviewer can check one line per entry
 * instead of re-deriving a matrix.
 *
 * Audited 2026-09-30 against the published contract
 * (`v3/static/agent/contract.json`, surfaceVersion 2.51.0) and the whole
 * `FigpeaLayerNode` interface. `existence` is the one value that is not a node
 * field: for `layer.delete` the answer is the `not_found` error itself.
 *
 * The node reports, and these are the only things a caller can check with one
 * read: geometry and position (`transform`, `bounds`), `path`, `shape`,
 * `visible`, `name`, `style`, `rawText`, `textMetrics`, `pageBackgroundFill`,
 * `iconName`, `arc`, `mask`, `maskedBy`, `constraints`, `resizeMode`,
 * `autoLayout`, `interactions`, `children`, and a layer's own existence.
 *
 * What the node does NOT report, and therefore what this route may not name:
 * a layer's position among its siblings or its parent (no index, no parentId);
 * sheet membership (`project.sheets`); region fills (readable only through
 * `layer.getRegionFills`, which exists because the node omits them); the
 * camera (zoom, centre, viewport — `canvas.fit` changes only these); and
 * anything a *new* sibling or group carries, which is why `layer.duplicate`,
 * `layer.repeat` and `layer.cut` are absent: the id they produced was never
 * delivered to a caller whose call timed out, and the named layer is
 * untouched. `layer.clip` is absent for the same reason one step along: it
 * moves the named layer into the mask slot of the sibling ABOVE it, so the
 * effect lands on that sibling's `maskedBy`, not on the layer the caller
 * named. `layer.unclip` IS present, because it takes the host that owns the
 * clip slot, whose own `mask` field changes.
 *
 * KNOWN FALSE NEGATIVES, stated rather than special-cased (a per-exception
 * carve-out is the guesswork that produced both rounds' findings):
 * `layer.setPageFill` (its first parameter is a `pageId`, which the audited
 * name rule does not admit) and any method added after this audit. Both fall
 * to the conservative whole-tree route, which is a real read of real state
 * even when it is not the most targeted one.
 */
export const LAYER_ID_ADDRESSED: ReadonlyMap<string, string> = new Map([
  // geometry and position
  ['layer_move', 'transform'],
  ['layer_setPosition', 'transform'],
  ['layer_setLocalPosition', 'transform'],
  ['layer_setTransform', 'transform'],
  ['layer_resize', 'bounds'],
  ['layer_rotate', 'transform'],
  ['layer_flipX', 'transform'],
  ['layer_flipY', 'transform'],
  // paint and content
  ['layer_stylePatch', 'style'],
  ['layer_setImageFill', 'style'],
  ['layer_outlineStroke', 'path'],
  ['layer_smoothPath', 'path'],
  ['layer_setText', 'rawText'],
  // identity and visibility
  ['layer_setVisible', 'visible'],
  ['layer_setName', 'name'],
  ['layer_delete', 'existence'],
  // structure the node itself reports
  ['layer_ungroup', 'children'],
  ['layer_setMask', 'mask'],
  ['layer_clearMask', 'mask'],
  ['layer_unclip', 'mask'],
  // layout
  ['layer_setConstraints', 'constraints'],
  ['layer_setResizeMode', 'resizeMode'],
  ['layer_setAutoLayout', 'autoLayout'],
  // outside the layer group, and the only one there whose effect the node
  // reports: a curated node carries an `interactions` array
  ['interaction_create', 'interactions'],
]);

/** Longest caller-supplied string interpolated into a state-check call. Past
 * this the value is elided, so a layer name (or an id) long enough to be
 * nonsense cannot turn the envelope into a wall of text. */
const MAX_HINT_VALUE_CHARS = 64;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Renders a caller-supplied value for interpolation into a suggested call.
 *
 * `JSON.stringify` rather than bare quotes, so a name containing `"` cannot
 * produce a suggested call that looks broken or, worse, that names a different
 * layer than the one that was created. Ellipsised past the length cap. */
function quoteForHint(value: string): string {
  const capped = value.length > MAX_HINT_VALUE_CHARS ? `${value.slice(0, MAX_HINT_VALUE_CHARS)}…` : value;
  return JSON.stringify(capped);
}

/** REQ-1282 AC-3 — the one clause appended to a relay timeout envelope: the
 * specific, callable state check that resolves the ambiguity.
 *
 * The old envelope said only "check state before retrying", which is advice
 * with no route attached, and the two reactions to it are both expensive —
 * believe the failure and abandon a layer that was created, or retry a
 * non-idempotent `create` and silently duplicate it. Naming the call removes
 * the guesswork for one round trip.
 *
 * Branches, in order, and the order is load-bearing:
 *
 *  1. `layer.create` with a name → `session.find({name})`, the cheap check
 *     that prevents the duplicate layer (the card's own example). Checked
 *     first because `layer.create`'s first argument is the layer KIND, not an
 *     id, so no id rule could read it as one.
 *  2. `layer.create` with no usable name → the whole tree. A create cannot be
 *     checked by a name nobody has.
 *  3. an audited read → the safe action is to re-issue, said explicitly so the
 *     agent does not spend a round trip verifying something that cannot have
 *     changed.
 *  4. an audited export → re-issue is safe too, for a different reason, so it
 *     gets its own sentence (see `REISSUE_SAFE_EXPORTS`).
 *  5. an audited layer-id-addressed call → `session.layerById(<id>)`, the
 *     one-round-trip answer. AFTER the reads, because for a read "just
 *     re-issue it" is strictly better advice than going to look.
 *  6. anything else → the whole tree, with the advice to look before
 *     re-issuing rather than to re-issue.
 *
 * The invariant every branch has to hold: never suggest a call that cannot
 * work, and never claim a call is harmless when it is not. Both halves are now
 * backed by audited sets that fail closed — see the set docblocks for the
 * derivation and the trade-off. No manifest is consulted, so the hint is
 * correct on the very first call of a session, before any `describe()` has
 * landed; the price is that the sets are curated rather than derived, and the
 * only thing a stale entry can cost is a less targeted hint.
 */
export function stateCheckHint(group: string, method: string, args: unknown[]): string {
  const tool = `${group}_${method}`;

  if (group === 'layer' && method === 'create') {
    const name = (args[1] as { name?: unknown } | undefined)?.name;
    return isNonEmptyString(name)
      ? `run session.find({name:${quoteForHint(name)}}) to see whether the layer already exists — a retry would add a second, identical one`
      : 'run session.layerTree() to see whether a new layer was already added';
  }

  if (REISSUE_SAFE_READS.has(tool)) {
    return 're-issue is safe — this call only reads the design, so nothing can be half-applied and there is nothing to undo';
  }

  if (REISSUE_SAFE_EXPORTS.has(tool)) {
    return 're-issue is safe — this call reads the design and writes its own output, so nothing can be half-applied in the design; re-issuing overwrites that output';
  }

  // Membership, not the id: the map is what says a node reports this call's
  // effect (see LAYER_ID_ADDRESSED), and the id is only interpolated once
  // that has been established.
  if (LAYER_ID_ADDRESSED.has(tool) && isNonEmptyString(args[0])) {
    return `run session.layerById(${quoteForHint(args[0])}) to see whether the change already applied on that layer`;
  }

  return 'run session.layerTree() to see the design as it is now — re-issue only if the intended result is visibly absent there';
}
