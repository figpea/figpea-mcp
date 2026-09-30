import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * REQ-1282 T3 — the timeout envelope (AC-3, AC-7).
 *
 * AC-3 is the half of the fix that a longer deadline cannot deliver. Even
 * with a floor that survives a burst, a timeout still happens — and the old
 * message said only "check state before retrying", which is advice, not a
 * route. The two reactions to that are both expensive: believe the failure and
 * abandon a layer that was created, or retry a non-idempotent `create` and
 * silently duplicate it. So the envelope has to name the call to run.
 *
 * AC-7 is the other half: the headroom must not have been bought by removing
 * the deadline. A genuinely stuck tab still yields a timeout, at the NEW
 * SHIPPED default — asserted against the floor the product actually uses, so
 * a future "fix" that makes the default unbounded fails here.
 *
 * The three substrings pre-existing tests pin (`timed out after Nms`,
 * `may still be executing this call`, `check state before retrying`) are
 * load-bearing and must survive verbatim; the state-check clause is APPENDED,
 * never substituted for them.
 *
 * TWO EXPECTATIONS WERE CORRECTED IN AN AMENDMENT COMMIT BEFORE T4, both
 * because the original wording would have had the shipped message assert
 * something false, and neither weakens the AC:
 *   1. the safe-to-re-issue branch asserts the REASON ("nothing can be
 *      half-applied") rather than the draft's "this is a read, not a
 *      mutation" — that branch also covers `export_*` and `session.openFile`,
 *      which are not reads, and a message that misclassifies them is the same
 *      class of lie this REQ exists to remove;
 *   2. a `layer.create` with no name must NOT be answered with
 *      `session.layerById("text")` — `layer.create`'s first argument is the
 *      layer KIND, so the generic "first argument is an id" rule would
 *      invent a lookup for an id that does not exist. Asserted negatively so
 *      the fallback cannot regress into naming a call that cannot work.
 *
 * Every message asserted here is produced by the REAL relay over a REAL `ws`
 * connection, and the both-lanes test drives the REAL MCP server with that
 * same real relay behind it — so what is pinned is what an agent receives,
 * not the shape of a helper's return value.
 */

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';

/** The floor the product ships (REQ-1282 T2). */
const SHIPPED_FLOOR_MS = 60_000;

/** This test's model of how much of a caller-supplied name may be echoed back
 * in the suggested state check. Owned here for the same reason the burst
 * test owns its settle constant: the assertion is about the PROPERTY (a fixed
 * cap, so the envelope cannot be bloated by a pathological name), not about
 * the production literal. */
const MAX_INTERPOLATED_NAME_CHARS = 64;

interface BridgeHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const DRILL_INDEX = {
  version: '1.8.0',
  session: { find: 'Finds layers.' },
  layer: { create: 'Creates a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: { find: { doc: 'Finds layers by selector.', params: { selector: { type: 'object', required: true } }, result: 'void' } },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: 'void',
    },
  },
};

let activeHandle: BridgeHandle | undefined;
const openSockets: WebSocket[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
  for (const fn of cleanups.splice(0)) await fn();
});

/**
 * A tab that describes itself on demand (so the drill completes and no drill
 * timer is left outstanding) and then never answers a relayed call — a stuck
 * editor, which is the only thing a relay deadline is for.
 */
async function connectStuckTab(bridge: BridgeHandle): Promise<WebSocket> {
  const described = new Promise<void>((resolve) => {
    bridge.onDescribe(() => resolve());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // Describe frames are answered; `call` frames are deliberately dropped.
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type !== 'describe') return;
    ws.send(
      JSON.stringify(
        frame.selector === undefined
          ? { type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }
          : { type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' },
      ),
    );
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect
    .poll(() => bridge.isTabConnected(), { timeout: 3000 })
    .toBe(true);
  await described;
  return ws;
}

/** The message the real relay produces for a call the stuck tab never answers. */
async function timeoutMessageFor(
  bridge: BridgeHandle,
  group: string,
  method: string,
  args: unknown[],
  timeoutMs = 60,
): Promise<string> {
  let message = '';
  try {
    await bridge.callTab(group, method, args, timeoutMs);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message, `${group}.${method} rejects when the tab never answers`).toContain('timed out');
  return message;
}

const PINNED_SUBSTRINGS = [
  'may still be executing this call',
  'check state before retrying',
] as const;

describe('REQ-1282 — a stuck tab still times out, at the shipped floor (AC-7)', () => {
  it('a no-override call survives 1ms short of the floor and rejects past it — no hang either way', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: 'pending' | 'rejected' = 'pending';
    let message = '';
    // No 4th argument: this is the shipped default path, which is what AC-7
    // is about — the deadline must still exist at the value the product uses.
    const call = bridge.callTab('session', 'find', [{ selector: { name: 'cat-label' } }]);
    call.catch((e: unknown) => {
      outcome = 'rejected';
      message = e instanceof Error ? e.message : String(e);
    });

    try {
      await vi.advanceTimersByTimeAsync(SHIPPED_FLOOR_MS - 1);
      expect(outcome, 'the deadline has not fired 1ms early').toBe('pending');

      await vi.advanceTimersByTimeAsync(2);
      expect(outcome, 'a stuck tab is reported, never hung').toBe('rejected');
    } finally {
      vi.useRealTimers();
    }

    expect(message, 'the envelope reports the shipped floor, so the number in the error is the real one').toContain(
      `timed out after ${SHIPPED_FLOOR_MS}ms`,
    );
    for (const pinned of PINNED_SUBSTRINGS) {
      expect(message, `the pinned clause "${pinned}" survives verbatim`).toContain(pinned);
    }
    await call.catch(() => {});
  });
});

describe('REQ-1282 — the envelope names the state check to run (AC-3)', () => {
  it('a create names session.find({name}) with the name the caller just used', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name: 'cat-label' }]);

    expect(
      message,
      'AC-3: the cheap check that prevents the duplicate layer is named, with the name already interpolated',
    ).toContain('session.find({name:"cat-label"})');
    for (const pinned of PINNED_SUBSTRINGS) expect(message).toContain(pinned);
  });

  it('a call whose first argument is the layer id names session.layerById(<id>)', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'layer', 'stylePatch', ['layer-1', { opacity: 0.5 }]);

    expect(
      message,
      'AC-3: the id is already known, so no selector search is needed — the check is one round trip',
    ).toContain('session.layerById("layer-1")');
  });

  it('a read is told it may simply re-issue, so no pointless verification round trip is invented', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'canvas', 'screenshot', [{ artboardId: 'a1' }]);

    expect(message, 'AC-3: a read has nothing to half-apply, so the safe action is named').toContain('re-issue is safe');
    expect(message, 'and the reason is stated, not just the instruction').toMatch(/nothing can be half-applied/i);
  });

  it('falls back to session.layerTree() when no name and no id are available', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const createWithoutName = await timeoutMessageFor(bridge, 'layer', 'create', ['text']);
    expect(
      createWithoutName,
      'a create with no usable name cannot be checked by name, so the whole tree is the route',
    ).toContain('session.layerTree()');
    expect(
      createWithoutName,
      "layer.create's first argument is the layer KIND, not an id — the message must not invent an id lookup from it",
    ).not.toContain('session.layerById("text")');

    const unknownSurface = await timeoutMessageFor(bridge, 'component', 'detach', [{ id: 'c1' }]);
    expect(
      unknownSurface,
      'an unrecognised mutation falls back to the conservative whole-tree check, never to a call that could be the un-applied one',
    ).toContain('session.layerTree()');
  });

  /**
   * ── REJECT round 1 (F1) ──────────────────────────────────────────────────
   * The id branch used to fire for ANY non-empty `args[0]`. On the real
   * contract that is wrong for every method whose first parameter is a string
   * that is not a layer id, and the envelope then named a lookup that can
   * only ever answer `layer "…" not found` (`session.impl.ts:380-382`) — a
   * check that cannot resolve the very ambiguity it was written to remove.
   *
   * Every row below is a REAL method with its REAL first parameter (audited
   * against the published contract, `v3/static/agent/contract.json`,
   * surfaceVersion 2.51.0), so the assertion is about the contract rather
   * than about this implementation's idea of it.
   */
  const NOT_A_LAYER_ID: ReadonlyArray<readonly [string, string, unknown[], 'tree' | 'reissue']> = [
    ['session', 'renameProject', ['My Project'], 'tree'],
    ['session', 'selectRelative', ['up'], 'tree'],
    ['canvas', 'addGuide', ['horizontal'], 'tree'],
    ['export', 'assetHarvest', ['web'], 'reissue'],
    ['font', 'getAlias', ['Helvetica'], 'reissue'],
    ['font', 'setAlias', ['Helvetica'], 'tree'],
    ['font', 'clearAlias', ['Helvetica'], 'tree'],
    ['layer', 'placeProjectImage', ['9f2c1ab4e7d35f60a1c8b2d4e6f70819'], 'tree'],
    ['interaction', 'remove', ['ix-1'], 'tree'],
    ['component', 'getOverrides', ['instance-7'], 'reissue'],
    ['component', 'getStates', ['component-2'], 'reissue'],
    ['layer', 'select', ['next'], 'tree'],
    // The audited exception inside an id-named group: a canvas guide is not
    // in the layer repository, so `layerById(guideId)` cannot find it either.
    ['canvas', 'removeGuide', ['guide-9'], 'tree'],
  ];

  for (const [group, method, args, route] of NOT_A_LAYER_ID) {
    it(`names no layer-id lookup for ${group}.${method} — its first argument is not a layer id`, async () => {
      const bridge = await startBridgeServer();
      activeHandle = bridge;
      await connectStuckTab(bridge);

      const message = await timeoutMessageFor(bridge, group, method, args);

      expect(
        message,
        `${group}.${method}: a string first argument is not proof of a layer id, so the envelope must not name layerById for it`,
      ).not.toContain('session.layerById(');

      // What the hint must be INSTEAD depends on what the method is, and
      // getting this right is the point: four of these rows are audited reads
      // or exports, for which "re-issue is safe" is a better answer than any
      // state check, because there is no state to check. The rest are
      // mutations, which get the conservative whole-tree route.
      if (route === 'reissue') {
        expect(
          message,
          `${group}.${method} only reads the design, so the correct hint is that re-issuing is safe`,
        ).toContain('re-issue is safe');
        expect(
          message,
          `${group}.${method}: and no verification round trip is invented for a call that changed nothing`,
        ).not.toContain('session.layerTree()');
      } else {
        expect(
          message,
          `${group}.${method}: the conservative whole-tree check is the route instead`,
        ).toContain('session.layerTree()');
      }
    });
  }

  it('a known conservative exclusion stays excluded: layer.setPageFill takes a pageId, which the audited name rule does not admit', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    // A page IS a layer, so `layerById(pageId)` would work here — the audited
    // rule admits only a first parameter named `id` or `layerId`, and
    // `pageId` is neither. Pinned deliberately, as a FALSE NEGATIVE: this one
    // call gets the less targeted whole-tree check. Stated rather than left
    // to be discovered, because the alternative is a per-exception carve-out
    // that grows into exactly the guesswork F1 rejected.
    const message = await timeoutMessageFor(bridge, 'layer', 'setPageFill', ['page-3']);
    expect(message, 'the name rule does not admit `pageId`').not.toContain('session.layerById(');
    expect(message, 'so the conservative route is used').toContain('session.layerTree()');
  });

  it('still names layerById for the methods whose effect the curated node reports, in every group that has them', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    // One row per family of node field, so this control cannot pass on one
    // convenient method: transform, style, text, visibility, name, existence
    // (delete — the node answers not_found once it is gone), and the one
    // outside the layer group (`interaction.create`, because a curated node
    // carries an `interactions` array, v3 `src/agent/serialize.ts:414`).
    for (const [group, method, args] of [
      ['layer', 'setPosition', ['layer-1', { x: 10, y: 20 }]],
      ['layer', 'stylePatch', ['layer-2', { opacity: 0.5 }]],
      ['layer', 'setText', ['layer-3', 'Hello']],
      ['layer', 'setVisible', ['layer-4', false]],
      ['layer', 'setName', ['layer-5', 'cat-label']],
      ['layer', 'delete', ['layer-6']],
      ['interaction', 'create', ['layer-7', { trigger: 'click' }]],
    ] as ReadonlyArray<readonly [string, string, unknown[]]>) {
      const message = await timeoutMessageFor(bridge, group, method, args);
      expect(
        message,
        `${group}.${method} changes state the curated node reports, so the one-round-trip route must be named`,
      ).toContain(`session.layerById(${JSON.stringify(args[0])})`);
    }
  });

  /**
   * ── REJECT round 2 ───────────────────────────────────────────────────────
   * The answerable-check rule was applied to ONE entry (`component.create`)
   * and left as a comment on the rest, so five more rows slipped through with
   * checks that run and resolve nothing. The rule is now mechanical — every
   * admitted entry carries the node field that reveals it — but the rows
   * themselves still have to be right, and these are the ones that are not.
   *
   * `canvas.fit` only sets `render.zoom` / `render.centerTo`
   * (v3 `src/agent/groups/canvas.impl.ts:258-260`) and a curated node carries
   * no viewport, camera or zoom field, so the node comes back identical.
   * `markSheet` / `unmarkSheet` write `project.sheets` and the facade's own
   * docblock says markSheet changes "NOTHING on the layer itself"
   * (v3 `src/facade/layer/index.ts:421-431`). Region fills are readable only
   * through the separate `layer.getRegionFills` read
   * (v3 `src/agent/groups/layer.impl.ts:1656`) precisely because the node
   * omits them.
   *
   * The six below that the review did not name are the same class, found by
   * auditing the remaining entries against the node's field list rather than
   * against their parameter names: `duplicate`, `repeat` and `cut` leave the
   * named layer untouched (the first two create a sibling whose id the caller
   * never received, the third only touches the clipboard); `reorder` and
   * `reparent` change a relationship the node does not report (no index and
   * no parentId); and `clip` moves the named layer into the mask slot of the
   * sibling ABOVE it, so the change lands on that sibling's `maskedBy` rather
   * than on anything the named layer reports.
   */
  const NOT_REPORTED_BY_THE_NODE: ReadonlyArray<readonly [string, string, unknown[]]> = [
    ['canvas', 'fit', ['layer-1']],
    ['layer', 'duplicate', ['layer-1']],
    ['layer', 'markSheet', ['layer-1']],
    ['layer', 'unmarkSheet', ['layer-1']],
    ['layer', 'reorder', ['layer-1', 0]],
    ['layer', 'reparent', ['layer-1', 'folder-2']],
    ['layer', 'clip', ['layer-1']],
    ['layer', 'setRegionFill', ['layer-1', 'r1', { fill: '#ffffff' }]],
    ['layer', 'clearRegionFill', ['layer-1', 'r1']],
    ['layer', 'repeat', ['layer-1', {}]],
    ['layer', 'cut', ['layer-1']],
  ];

  for (const [group, method, args] of NOT_REPORTED_BY_THE_NODE) {
    it(`names no layer-id lookup for ${group}.${method} — the node cannot report what it changed`, async () => {
      const bridge = await startBridgeServer();
      activeHandle = bridge;
      await connectStuckTab(bridge);

      const message = await timeoutMessageFor(bridge, group, method, args);

      expect(
        message,
        `${group}.${method}: a layer id is not a reason to name layerById unless the node reports the effect — this one does not`,
      ).not.toContain('session.layerById(');
      expect(message, `${group}.${method}: the conservative route is used instead`).toContain('session.layerTree()');
    });
  }

  it('every admitted id lookup names the curated-node field that reveals it, and that field really exists', async () => {
    // The gate that makes the rule mechanical rather than a comment. An entry
    // is admitted only by a field, so an entry justified by something the node
    // does not carry cannot be added without failing here — which is exactly
    // how both rounds' findings got in.
    //
    // The import is DEFERRED and cast, deliberately: `callTimeout` does not
    // export the map yet, and a static import of a missing export would fail
    // the whole file at module load, hiding the assertion-level red that every
    // other row in this round is reporting. Deferred, this test fails on its
    // own assertion and the rest of the file still runs.
    const module_ = (await import('./callTimeout')) as unknown as {
      LAYER_ID_ADDRESSED?: ReadonlyMap<string, string>;
    };
    const admitted = module_.LAYER_ID_ADDRESSED;
    expect(
      admitted,
      'callTimeout exports the admitted id route together with its per-entry justification, so the rule is checkable',
    ).toBeInstanceOf(Map);
    if (!(admitted instanceof Map)) return;

    // FIGPEA_LAYER_NODE_FIELDS is transcribed from
    // `v3/src/agent/serialize.ts`'s `FigpeaLayerNode` (the whole interface),
    // with the one non-field this route needs stated explicitly:
    // `existence` is not a node field but the not_found answer itself, which
    // is how `layer.delete` is checked.
    const FIGPEA_LAYER_NODE_FIELDS = new Set([
      'id',
      'name',
      'layerType',
      'shape',
      'path',
      'visible',
      'transform',
      'pageBackgroundFill',
      'iconName',
      'arc',
      'bounds',
      'boundsError',
      'style',
      'rawText',
      'interactions',
      'constraints',
      'resizeMode',
      'effectiveResizeMode',
      'mask',
      'maskedBy',
      'autoLayout',
      'textMetrics',
      'children',
      'existence',
    ]);
    const unjustified = [...admitted.entries()].filter(([, field]) => !FIGPEA_LAYER_NODE_FIELDS.has(field));
    expect(
      unjustified.map(([tool, field]) => `${tool} -> ${field}`),
      'every admitted method is justified by a field the curated node actually carries',
    ).toEqual([]);
    expect(
      [...admitted.keys()],
      'and the admitted set is a positive list, so a method nobody audited is simply absent',
    ).not.toContain('canvas_fit');
  });

  it('names no layer-id lookup for component.create, although its first argument IS a layer id', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    // The subtler half of the same defect, and the reason a layer id is not
    // sufficient on its own: a curated node carries `interactions` but says
    // NOTHING about components (v3 `src/agent/serialize.ts` has no component
    // field at all), so `session.layerById` cannot reveal whether a component
    // was created. Naming it would be a check that runs and resolves nothing.
    const message = await timeoutMessageFor(bridge, 'component', 'create', ['layer-1', { name: 'hero' }]);
    expect(message, 'a layer id the read cannot speak to is not a reason to name the read').not.toContain(
      'session.layerById(',
    );
    expect(message, 'so the conservative route is used').toContain('session.layerTree()');
  });

  /**
   * ── REJECT round 1 (F2) ──────────────────────────────────────────────────
   * The re-issue-safe branch was reached by group + a method-name heuristic,
   * which let `session.newProject` through — a call that "Creates a new, empty
   * design project and makes it the active session" (session.descriptor.ts:15).
   * Telling an agent to re-issue THAT discards the document being built, which
   * is worse than the ambiguity the envelope exists to resolve.
   */
  const NOT_REISSUE_SAFE: ReadonlyArray<readonly [string, string, unknown[], 'tree' | 'id']> = [
    ['session', 'newProject', [], 'tree'],
    ['session', 'openFile', [{ url: 'https://example.com/a.fig' }], 'tree'],
    ['session', 'renameProject', ['My Project'], 'tree'],
    ['session', 'setSelection', [['layer-1']], 'tree'],
    ['history', 'undo', [], 'tree'],
    ['history', 'redo', [], 'tree'],
    ['layer', 'placeProjectImage', ['9f2c1ab4e7d35f60a1c8b2d4e6f70819'], 'tree'],
    // Its layer id is one `session.layerById` can speak to (a curated node
    // carries `interactions`), so the route is the one-round-trip lookup —
    // which is a BETTER answer than the whole tree, and is why this row
    // declares its own expectation instead of inheriting the fallback.
    ['interaction', 'create', ['layer-1', { trigger: 'click' }], 'id'],
  ];

  for (const [group, method, args, route] of NOT_REISSUE_SAFE) {
    it(`never tells the agent a ${group}.${method} is safe to re-issue`, async () => {
      const bridge = await startBridgeServer();
      activeHandle = bridge;
      await connectStuckTab(bridge);

      const message = await timeoutMessageFor(bridge, group, method, args);

      expect(
        message,
        `${group}.${method} creates or changes the design, so "re-issue is safe" would be a false claim`,
      ).not.toContain('re-issue is safe');

      if (route === 'id') {
        expect(
          message,
          `${group}.${method}: the layer id it was given is the thing to check, and the read can answer it`,
        ).toContain(`session.layerById(${JSON.stringify(args[0])})`);
      } else {
        expect(
          message,
          `${group}.${method}: the advice is to look before re-issuing`,
        ).toContain('session.layerTree()');
      }
    });
  }

  it('tells an export it is safe to re-issue, because it writes its own output and cannot change the design', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'export', 'project', [{ format: 'fp' }]);

    expect(message, 'an export reads the design and writes its own artifact, so re-issuing is safe').toContain(
      're-issue is safe',
    );
    expect(message, 'and the reason is stated, not just the instruction').toMatch(/nothing can be half-applied/i);
    expect(message, 'an export is not a layer mutation, so no id lookup is invented for it').not.toContain(
      'session.layerById(',
    );
  });

  it('a name containing a quote cannot corrupt the interpolated call, and a long one is truncated', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const quoted = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name: 'cat"label' }]);
    expect(
      quoted,
      'the name is rendered as a JSON string, so a quote inside it stays inside the quotes',
    ).toContain('session.find({name:"cat\\"label"})');

    // The elision cap is a MODEL constant owned by this test, the same way
    // the settle window is in the burst test: the assertion is about the
    // property (a fixed cap, not a proportional paste), not about the
    // production literal.
    const clauseFor = async (name: string): Promise<string> => {
      const message = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name }]);
      return message.slice(message.indexOf('check state before retrying'));
    };
    const atCap = await clauseFor('L'.repeat(MAX_INTERPOLATED_NAME_CHARS + 36));
    const farPast = await clauseFor('L'.repeat(200));
    expect(farPast, 'an over-long name is elided rather than pasted whole').not.toContain('L'.repeat(200));
    expect(farPast, 'the elision is visible so the agent knows the name was cut').toContain('…');
    expect(
      atCap.length,
      'the elision is by a fixed cap, so the clause does not grow with the caller string',
    ).toBe(farPast.length);
    const rendered = farPast.match(/session\.find\(\{name:"([^"]*)"\}\)/)![1];
    expect(rendered.length, 'the interpolated name is capped').toBeLessThanOrEqual(MAX_INTERPOLATED_NAME_CHARS + 1);
  });
});

async function connectedClient(bridge: BridgeHandle, toolMode: 'compact' | 'full') {
  const server = createMcpServer(bridge, { toolMode });
  const client = new Client({ name: 'req-1282-envelope-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!);
}

describe('REQ-1282 — the clause survives both calling lanes as bridge_error (AC-3)', () => {
  it('compact figpea_call and a full-mode contract tool both surface the state check intact', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;

    // The MCP server subscribes to the tab's `describe` manifest, which the
    // relay publishes ONCE, when the drill completes. So both servers are
    // created BEFORE the tab pairs — a server built afterwards would see an
    // already-drilled tab and register no contract tools at all, which is a
    // real ordering constraint of the relay, not a test artefact.
    const fullClient = await connectedClient(bridge, 'full');
    const compactClient = await connectedClient(bridge, 'compact');
    await connectStuckTab(bridge);

    // Full mode: a contract tool registered from the same manifest shape the
    // real editor publishes, behind the same real relay.
    const fullResult = await callToolJson(fullClient, 'layer_create', {
      kind: 'text',
      props: { name: 'cat-label' },
      _timeoutMs: 60,
    });
    expect(fullResult.ok, 'a timed-out call is a failed envelope').toBe(false);
    expect(fullResult.code).toBe('bridge_error');
    expect(
      fullResult.message,
      'AC-3, full mode: the named state check reaches the agent, not just the ambiguity clause',
    ).toContain('session.find({name:"cat-label"})');
    for (const pinned of PINNED_SUBSTRINGS) expect(fullResult.message).toContain(pinned);

    // Compact mode: the only way an agent reaches a contract method at all.
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['text', { name: 'cat-label' }],
      _timeoutMs: 60,
    });
    expect(compactResult.ok).toBe(false);
    expect(compactResult.code).toBe('bridge_error');
    expect(
      compactResult.message,
      'AC-3, compact mode: the named state check reaches the agent there too',
    ).toContain('session.find({name:"cat-label"})');
    for (const pinned of PINNED_SUBSTRINGS) expect(compactResult.message).toContain(pinned);
  });
});
