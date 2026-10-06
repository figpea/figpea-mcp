import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from './mcpServer';
import {
  OUTCOME_PREVIOUS_UNRESOLVED,
  OUTCOME_TIMEOUT_MAYBE_APPLIED,
  UNRESOLVED_CALL_TTL_MS,
} from './callOutcome';

/**
 * REQ-1522 T5 — the published contract carries the outcome vocabulary (AC-6).
 *
 * The envelope's `code` is the machine-readable route to an honest reading, and
 * a route nobody is told about is not one. Three surfaces, because there are
 * three kinds of reader, and this requirement's own evidence is that the wrong
 * reading is expensive rather than merely confusing: three recorded `/design`
 * runs each reported an APPLIED mutation as a failure, and the only thing
 * stopping a duplicate was an agent reading prose by hand.
 *
 *   1. the package README, beside the existing `bridge_error` cases it is
 *      replacing as the deadline's home;
 *   2. `tools/list` — `TIMEOUT_KNOB_ADVICE` (one string, every advertisement
 *      site at once) and the `status` description that already warns about a
 *      timed-out call without naming a code;
 *   3. (in `v3`, its own suite) the `figpea.SKILL("mcp-call-timeouts")` section.
 *
 * TWO THINGS ARE PINNED MECHANICALLY, NOT BY CONVENTION:
 *
 *  - every code literal asserted here is read from `callOutcome.ts`'s EXPORTS
 *    and compared against the prose, never re-spelled. A hand-copied code in a
 *    markdown file drifts the moment somebody renames the constant, and the
 *    drift is invisible because nothing links the two. The comparison is the
 *    pin: if the engineer renames the code, this test follows it to the README
 *    instead of failing on a literal nobody retyped.
 *  - the tool descriptions are read from a REAL `tools/list` over the SDK's
 *    `InMemoryTransport`, never from the zod shape — the SDK's zod→JSON-Schema
 *    conversion prefers `meta` over `.describe()` (REQ-1268), so a test against
 *    the shape would pass while the advertised schema stayed empty.
 *
 * RED before T6: the module exists (T2 shipped it), so the exports read fine,
 * but the README names none of the codes and no tool description mentions one.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');

/** The generic code the new ones sit beside. Named here as a literal because it
 *  is NOT an export — it is the existing envelope's code and this requirement
 *  adds to its neighbourhood without redefining it. */
const GENERIC_BRIDGE_ERROR = 'bridge_error';

/** One README section, from its heading up to the next heading of the SAME OR
 *  HIGHER level — so `## Call timeouts` includes its own `###` subsections,
 *  which is where this requirement's material belongs, and `### Host request
 *  timeout` still ends at the next `###`. Cutting at any heading instead would
 *  have made this helper report the timeout section as missing its own
 *  subsection, and a documentation test that cannot see the paragraph it is
 *  about is worse than none.
 *
 *  An empty string when the heading is absent, so a missing section fails as a
 *  missing section rather than as a missing substring somewhere else. */
function section(heading: string, source = readme): string {
  const start = source.indexOf(heading);
  if (start === -1) return '';
  const level = (heading.match(/^#+/) ?? ['#'])[0].length;
  const after = source.slice(start + heading.length);
  const next = [...after.matchAll(/^(#{1,6}) /gm)].find((m) => m[1].length <= level);
  return next === undefined
    ? source.slice(start)
    : source.slice(start, start + heading.length + (next.index as number));
}

const CALL_TIMEOUTS = section('## Call timeouts');
const HOST_TIMEOUT = section('### Host request timeout');
const ENVELOPE_SECTION = section('### What the timeout envelope already told you');
const TROUBLESHOOTING = section('## Troubleshooting');

/** Every line of a section, so a claim can be pinned to the LINE that makes it
 *  rather than to a phrase that could appear anywhere in the file. */
function lines(body: string): string[] {
  return body.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

describe('REQ-1522 AC-6 — the package README names the outcome, beside the cases it sits beside', () => {
  it('names both new codes and the generic one, in the call-timeouts section where a reader looks for them', () => {
    expect(CALL_TIMEOUTS, 'the README still has a "Call timeouts" section').not.toBe('');
    expect(
      CALL_TIMEOUTS,
      'the deadline outcome is named — the code, not a paraphrase of it',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
    expect(
      CALL_TIMEOUTS,
      'and the refusal code, so a caller can recognise the second half of the problem too',
    ).toContain(OUTCOME_PREVIOUS_UNRESOLVED);
    expect(
      CALL_TIMEOUTS,
      'beside the cases it did not replace: bridge_error still means no tab, socket gone, malformed relay',
    ).toContain(GENERIC_BRIDGE_ERROR);
  });

  it('quotes the grace window as the number the code actually ships', () => {
    // Deliberately a PHRASE, not a bare number. `120000` already appears four
    // times in this section (the cap, three table rows), and one of those lines
    // also contains the word "window" — so a check for the number alone, or for
    // the number near any window-ish word, passes today on the cap and pins
    // nothing. "grace window" is the phrase the feature has, and it appears
    // nowhere until the documentation of it does.
    const graceWindowLine = lines(CALL_TIMEOUTS).find(
      (l) => l.includes(String(UNRESOLVED_CALL_TTL_MS)) && /grace window/i.test(l),
    );
    expect(
      graceWindowLine,
      `the grace window is quoted as its actual number (${UNRESOLVED_CALL_TTL_MS}, compared against the module's own TTL), not as "a while"`,
    ).toBeTruthy();
  });

  it('states the retry rule: an identical re-issue is refused, so the state check is the route', () => {
    const refusalLines = lines(CALL_TIMEOUTS).filter((l) => l.includes(OUTCOME_PREVIOUS_UNRESOLVED));
    expect(refusalLines.length, 'the refusal code appears in the call-timeouts section').toBeGreaterThan(0);
    expect(
      refusalLines.some((l) => /refus/i.test(l)),
      'and it says an identical re-issue is REFUSED — not merely that re-issuing is risky, which is what the section said before',
    ).toBe(true);
  });

  it('cross-references the codes from the host-request-timeout section, the one case where no envelope arrives', () => {
    expect(
      HOST_TIMEOUT,
      'a reader whose HOST ceiling fires gets no envelope at all, so the host section has to point at the vocabulary by name',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
  });

  it('keeps the envelope section enumerating the outcomes, next to the recovery clause it already quoted', () => {
    // The verbatim `recoveryHint()` quote is pinned by the package's own tests
    // and must survive; this only checks the enumeration was added beside it.
    expect(ENVELOPE_SECTION, 'the recovery section still exists').toContain('status.liveness');
    expect(
      ENVELOPE_SECTION,
      'and now names the outcome codes, so a reader who arrived here from the 504 finds the vocabulary',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
  });

  it('gives a stuck run a troubleshooting entry per outcome code', () => {
    expect(TROUBLESHOOTING, 'the README still has a Troubleshooting section').not.toBe('');
    for (const code of [OUTCOME_TIMEOUT_MAYBE_APPLIED, OUTCOME_PREVIOUS_UNRESOLVED]) {
      const bullet = lines(TROUBLESHOOTING).find((l) => l.startsWith('- ') && l.includes(code));
      expect(bullet, `Troubleshooting has a bullet naming ${code} — where a stuck run actually lands`).toBeTruthy();
      expect(bullet, 'and the bullet says what to DO, not just what the code is').toMatch(/\b(run|check|read|look|state|re-?issue)\b/i);
    }
  });

  it('does not over-promise: the outcome code is the promise, not a resolution of the ambiguity', () => {
    const outcomeProse = lines(CALL_TIMEOUTS)
      .filter((l) => l.includes(OUTCOME_TIMEOUT_MAYBE_APPLIED) || l.includes(OUTCOME_PREVIOUS_UNRESOLVED))
      .join(' ');
    expect(
      outcomeProse,
      'the bridge still cannot know whether the change landed — a README that says it can would be the same false negative in prose',
    ).not.toMatch(/ambiguity is resolved|no longer ambiguous|retries are safe|retrying is safe|safe to retry/i);
  });
});

describe('REQ-1522 AC-6 — the tool description an agent actually reads names the code', () => {
  /** The manifest the generated-tool cases advertise: one mutating method with
   *  a `_timeoutMs`-bearing surface, which is where the shared timeout string
   *  has to reach. */
  const MANIFEST = {
    layer: {
      stylePatch: {
        doc: 'Patches a layer.',
        params: {
          id: { type: 'string', required: true },
          patch: { type: 'object', required: true },
        },
        result: { id: 'string' },
      },
    },
  };

  let cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  async function clientFor(toolMode: 'compact' | 'full'): Promise<Client> {
    const bridge = {
      port: 54397,
      token: 'req-1522-docs-token',
      isTabConnected: () => false,
      // The manifest is delivered synchronously, the shape a paired tab's
      // completed drill produces, so the generated tools exist before
      // `tools/list` is asked.
      onDescribe: (handler: (manifest: unknown) => void) => handler(MANIFEST),
      callTab: async () => ({ ok: true, value: null }),
      close: async () => {},
    };
    const server = createMcpServer(bridge as never, { toolMode } as never);
    const client = new Client({ name: 'req-1522-docs-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  /** A tool's advertised description, plus every description string its input
   *  schema advertises — flattened, because the SDK nests them differently per
   *  key and a reader of `tools/list` sees all of them as one surface. */
  async function advertisedText(client: Client, name: string): Promise<string> {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} is advertised in a real tools/list`).toBeTruthy();
    const json = JSON.stringify(tool!.inputSchema ?? {});
    return `${tool!.description ?? ''} ${json}`;
  }

  it('the compact dispatcher — the only route to a contract method in the default mode — names the code', async () => {
    const text = await advertisedText(await clientFor('compact'), 'figpea_call');
    expect(
      text,
      'AC-6: an agent that only ever reads tools/list must learn the code from the one tool it calls',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
    expect(text, 'and what the code means, so it can branch rather than guess').toMatch(/may have landed|may still|applied/i);
  });

  it('a generated contract tool advertises the code on its own _timeoutMs, not only on the dispatcher', async () => {
    const text = await advertisedText(await clientFor('full'), 'layer_stylePatch');
    expect(
      text,
      'the generated schema carries the shared timeout string, so the code reaches a full-mode agent too',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
  });

  it('the status description names the code it is already warning about', async () => {
    const text = await advertisedText(await clientFor('compact'), 'status');
    expect(
      text,
      'status already told readers to read liveness BEFORE retrying a timed-out call; it must now say which code that is',
    ).toContain(OUTCOME_TIMEOUT_MAYBE_APPLIED);
  });

  it('every advertised code in tools/list is one this build actually emits', async () => {
    // The docs and the envelope are compared to the same exports elsewhere; this
    // is the reverse direction, and it is what stops a code being advertised
    // that no path can ever produce — a promise the server cannot keep.
    const { tools } = await (await clientFor('full')).listTools();
    const text = JSON.stringify(tools);
    const emitted = new Set([OUTCOME_TIMEOUT_MAYBE_APPLIED, OUTCOME_PREVIOUS_UNRESOLVED, GENERIC_BRIDGE_ERROR]);
    const advertised = [...text.matchAll(/bridge_[a-z_]+/g)].map((m) => m[0]);
    for (const code of new Set(advertised)) {
      expect(
        emitted.has(code),
        `tools/list advertises ${code}, which this build's relay cannot emit — an advertised code nothing produces is worse than none`,
      ).toBe(true);
    }
  });
});