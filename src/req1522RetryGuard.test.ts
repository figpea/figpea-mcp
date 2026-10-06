import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { stateCheckHint } from './callTimeout';

/**
 * REQ-1522 T3 — the identical-retry guard (AC-4), and AC-5's "never both" at
 * the same seam.
 *
 * The third recorded consequence of the dropped late frame was that nothing
 * stopped a duplicate. Three separate `/design` runs hit it and each recorded
 * it in its own words: a `stylePatch`/`setText` reported as `bridge_error` and
 * applied, an agent that retried it wrote the same value twice, and a retried
 * `layer.create` added a second identical layer. The prose advice ("check state
 * before retrying") was the only mitigation, and it is advice — a careful agent
 * reads it, an automation wiring `code` into a retry policy never sees it.
 *
 * AC-4 offers two acceptable outcomes and this suite pins BOTH, because either
 * one satisfies it and only pinning one would let the other ship:
 *
 *  - refused while the earlier call's outcome is UNKNOWN (the ordinary case —
 *    nobody has heard back yet);
 *  - refused as ALREADY-APPLIED once the late frame has been consumed and the
 *    bridge knows it landed, which is also AC-5's "the mutation is
 *    acknowledged" requirement observed from the caller's side.
 *
 * "Exactly one layer / one text value" is established by COUNTING THE `call`
 * FRAMES THE TAB RECEIVED, not by reading an envelope: a refusal that did not
 * actually stop the second frame would still produce an honest-looking refusal
 * while silently duplicating the layer, which is the entire failure.
 *
 * Everything is pinned NEGATIVELY too, because a guard is a new refusal and a
 * new refusal is a new way to be wrong:
 *
 *  - a retry whose recorded outcome was a tab FAILURE is relayed normally —
 *    refusing a call we know failed would be a defect of its own;
 *  - an audited read or an audited export is NEVER guarded, whatever its
 *    recorded outcome — re-issuing either is safe by construction, and those
 *    two audited sets already answer that question and fail closed;
 *  - a re-issue with DIFFERENT arguments is relayed: it is a different call,
 *    and an identical-only guard that could not tell them apart would refuse
 *    work that has nothing to do with the call in doubt.
 *
 * RED on the T2 build, where the bridge records an unresolved call but nothing
 * consults the record yet — every re-issue below is relayed, so every "exactly
 * one" assertion sees two.
 */

/** AC-4: the code a refused identical re-issue carries. */
const PREVIOUS_UNRESOLVED = 'bridge_previous_call_unresolved';

const DEADLINE_MS = 60;
/** Past the deadline and inside any grace window an implementation would
 *  document, so the late frame really does land after the caller was rejected. */
const LATE_REPLY_MS = 160;

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
  session: { layerTree: 'The tree.' },
  layer: { create: 'Creates a layer.', setText: 'Sets text.' },
  export: { layer: 'Exports a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: { layerTree: { doc: 'The tree.', params: {}, result: 'void' } },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: 'void',
    },
    setText: {
      doc: 'Sets text.',
      params: { id: { type: 'string', required: true }, text: { type: 'string', required: true } },
      result: 'void',
    },
  },
  export: {
    layer: {
      doc: 'Exports a layer.',
      params: { id: { type: 'string', required: true }, format: { type: 'string', required: false } },
      result: 'void',
    },
  },
};

let activeHandle: BridgeHandle | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
});

/** What the tab does with the Nth `call` frame it receives. `delayMs: null`
 *  means it never answers at all — the wedge, and the control every other
 *  script is read against. */
interface AnswerPlan {
  delayMs: number | null;
  body: { ok: boolean; value?: unknown; code?: string; message?: string };
}

interface AppliedCall {
  id: string;
  group: string;
  method: string;
  args: unknown[];
}

/**
 * A stand-in editor tab that applies every call it is handed and answers
 * according to a SCRIPT — one entry per incoming `call` frame, in order. That
 * is what lets one test say "the first create is answered late as a success and
 * the second is answered at once", which is the whole shape of AC-4's second
 * case.
 */
async function connectScriptedTab(bridge: BridgeHandle, plan: AnswerPlan[]): Promise<AppliedCall[]> {
  const described = new Promise<void>((resolve) => {
    bridge.onDescribe(() => resolve());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const received: AppliedCall[] = [];
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type === 'describe') {
      ws.send(
        JSON.stringify(
          frame.selector === undefined
            ? { type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }
            : { type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' },
        ),
      );
      return;
    }
    if (frame?.type !== 'call') return;
    // The effect lands the instant the frame arrives — recorded here, exactly as
    // the 80-layer model recorded every layer it was asked for.
    received.push({ id: frame.id, group: frame.group, method: frame.method, args: frame.args });
    const step = plan[received.length - 1];
    if (step === undefined || step.delayMs === null) return;
    setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: frame.id, ...step.body })), step.delayMs);
  });

  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  await described;
  return received;
}

/** What one relay call produced: the resolved value, or the rejection's code
 *  and message. Returned unasserted so a test can say in its OWN words which of
 *  the two it expected — "the relay rejects rather than resolving" is true of
 *  half this file's cases and would be a false accusation of the other half. */
async function outcomeFrom(call: Promise<unknown>): Promise<
  { ok: true; value: unknown } | { ok: false; code?: unknown; message: string }
> {
  try {
    return { ok: true, value: await call };
  } catch (e) {
    return { ok: false, code: (e as { code?: unknown } | null)?.code, message: e instanceof Error ? e.message : String(e) };
  }
}

/** The refusal one relay call produced, with the refusal itself asserted. */
async function rejectionFrom(call: Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  const outcome = await outcomeFrom(call);
  expect(
    outcome.ok,
    'this call was expected to be REFUSED and was relayed to the tab instead — which is the defect under test, so the two are named here rather than left to the envelope',
  ).toBe(false);
  return outcome as { code?: unknown; message: string };
}

/** Counts the frames the tab received for one method — "exactly one layer",
 *  established from the tab's own record rather than from an envelope. */
function callsFor(received: AppliedCall[], method: string): AppliedCall[] {
  return received.filter((c) => c.method === method);
}

/** The one `layer.create` this file's cases share, so a refusal can be compared
 *  against the state check the timeout envelope names for it. */
const CREATE_ARGS = ['text', { name: 'header' }];

describe('REQ-1522 AC-4 — an identical re-issue after a timeout is refused, so nothing is applied twice', () => {
  it('a second identical layer.create never reaches the tab, so exactly one layer exists', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: { id: 'layer-9' } } },
      { delayMs: 0, body: { ok: true, value: { id: 'layer-10' } } },
    ]);

    const first = await rejectionFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));
    expect(first.message, 'the first call was reported as the deadline outcome').toContain('timed out after');

    const second = await rejectionFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));

    expect(second.code, 'AC-4: the identical re-issue is refused by name').toBe(PREVIOUS_UNRESOLVED);
    expect(
      callsFor(received, 'create'),
      'AC-4: exactly one create frame reached the tab, so exactly one layer exists',
    ).toHaveLength(1);

    // The refusal is honest about WHY, and it routes rather than instructs.
    expect(second.message, 'it names the call it is refusing a repeat of').toContain('layer.create');
    expect(
      second.message,
      'it carries the same state check the timeout envelope names — one home for "what do I run instead?"',
    ).toContain(stateCheckHint('layer', 'create', CREATE_ARGS));
    expect(
      second.message,
      'and it says the earlier outcome is not known, rather than implying the earlier call failed',
    ).toContain('outcome of that earlier call is unknown');
  });

  it('a second identical layer.setText is refused the same way — one text value, not two writes', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: {} } },
      { delayMs: 0, body: { ok: true, value: {} } },
    ]);

    await rejectionFrom(bridge.callTab('layer', 'setText', ['layer-9', 'Total 42'], DEADLINE_MS));
    const second = await rejectionFrom(bridge.callTab('layer', 'setText', ['layer-9', 'Total 42'], DEADLINE_MS));

    expect(second.code).toBe(PREVIOUS_UNRESOLVED);
    expect(callsFor(received, 'setText'), 'exactly one setText frame reached the tab').toHaveLength(1);
    expect(
      second.message,
      'the refusal names the targeted state check for a layer-id-addressed call',
    ).toContain(stateCheckHint('layer', 'setText', ['layer-9', 'Total 42']));
  });

  it('once the late frame has been consumed, an identical re-issue is refused as already-applied (AC-5: acknowledged, not re-applied)', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: { id: 'layer-9' } } },
      { delayMs: 0, body: { ok: true, value: { id: 'layer-10' } } },
    ]);

    await rejectionFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));
    // Let the late frame land inside the grace window, so the bridge knows how
    // the earlier call went. This is the whole point of keeping the record.
    await new Promise((resolve) => setTimeout(resolve, LATE_REPLY_MS + 200));

    const second = await rejectionFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));

    expect(second.code, 'AC-4: still refused, now with a known outcome behind it').toBe(PREVIOUS_UNRESOLVED);
    expect(callsFor(received, 'create'), 'the tab was never asked to create it twice').toHaveLength(1);
    expect(
      second.message,
      'and it says the earlier call is recorded as applied — a different sentence from "unknown", because a different fact',
    ).toContain('recorded as applied');
    expect(
      second.message,
      'and it does not claim the outcome is unknown any more',
    ).not.toContain('outcome of that earlier call is unknown');
  });
});

describe('REQ-1522 AC-4 — the guard is pinned negatively, because a new refusal is a new way to be wrong', () => {
  it('a re-issue whose recorded outcome was a TAB FAILURE is relayed normally', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      // The tab's own refusal, delivered late: this call is known to have FAILED.
      { delayMs: LATE_REPLY_MS, body: { ok: false, code: 'invalid_params', message: 'no such layer' } },
      { delayMs: 0, body: { ok: true, value: { id: 'layer-10' } } },
    ]);

    await rejectionFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));
    await new Promise((resolve) => setTimeout(resolve, LATE_REPLY_MS + 200));

    const retry = await outcomeFrom(bridge.callTab('layer', 'create', CREATE_ARGS, DEADLINE_MS));

    expect(
      retry.ok,
      'refusing a call we know FAILED would be a defect of its own — the caller has learned exactly that it did not land',
    ).toBe(true);
    expect(callsFor(received, 'create'), 'and the retry really reached the tab').toHaveLength(2);
  });

  it('an audited READ is never guarded, however its outcome turned out', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: { layers: [] } } },
      { delayMs: 0, body: { ok: true, value: { layers: ['header'] } } },
    ]);

    await rejectionFrom(bridge.callTab('session', 'layerTree', [], DEADLINE_MS));
    await new Promise((resolve) => setTimeout(resolve, LATE_REPLY_MS + 200));

    const retry = await outcomeFrom(bridge.callTab('session', 'layerTree', [], DEADLINE_MS));

    expect(retry.ok, 'a read cannot be half-applied, so re-issuing it is free').toBe(true);
    expect(callsFor(received, 'layerTree'), 'and it reached the tab').toHaveLength(2);
  });

  it('an audited EXPORT is never guarded either — it writes its own output, not the design', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: { bytes: 1 } } },
      { delayMs: 0, body: { ok: true, value: { bytes: 2 } } },
    ]);

    await rejectionFrom(bridge.callTab('export', 'layer', ['layer-9', { format: 'png' }], DEADLINE_MS));
    await new Promise((resolve) => setTimeout(resolve, LATE_REPLY_MS + 200));

    const retry = await outcomeFrom(bridge.callTab('export', 'layer', ['layer-9', { format: 'png' }], DEADLINE_MS));

    expect(retry.ok, 're-issuing an export overwrites its own output and touches no design state').toBe(true);
    expect(callsFor(received, 'layer')).toHaveLength(2);
  });

  it('a re-issue with DIFFERENT arguments is relayed — it is a different call', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const received = await connectScriptedTab(bridge, [
      { delayMs: LATE_REPLY_MS, body: { ok: true, value: { id: 'layer-9' } } },
      { delayMs: 0, body: { ok: true, value: { id: 'layer-10' } } },
    ]);

    await rejectionFrom(bridge.callTab('layer', 'create', ['text', { name: 'header' }], DEADLINE_MS));
    const different = await outcomeFrom(bridge.callTab('layer', 'create', ['text', { name: 'footer' }], DEADLINE_MS));

    expect(
      different.ok,
      'a guard that could not tell two creates apart would refuse work unrelated to the one in doubt',
    ).toBe(true);
    expect(callsFor(received, 'create'), 'both distinct calls reached the tab').toHaveLength(2);
  });
});