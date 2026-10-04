import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-1503 T5 — the README is the documented way back, so it is pinned as a
 * procedure rather than as prose.
 *
 * This card's complaint is literally "no documented way back". The fix is only
 * real if a reader who has lost their MCP channel can follow the document: which
 * file to read, which command to run, what each answer means, and — the part
 * every other requirement's docs got wrong — what the package CANNOT do. So the
 * pins below are mostly about the STEPS and the LIMITS, not about sentences.
 *
 * Two obligations are load-bearing and are called out where they are asserted:
 *
 *  - **The envelope clause is QUOTED, not paraphrased**, from the module that
 *    emits it. A paraphrase is the REQ-1282 failure mode in a new costume: two
 *    texts describing the same message drift apart, and this one is read by an
 *    agent matching on it.
 *  - **Rung (c) is stated as a limit.** The bridge starts INSIDE the stdio
 *    process and closes with it, so `POST /call` covers a lost channel and not a
 *    dead process. A README that implied otherwise would make this one promise
 *    fail in precisely the case the requirement exists for — which is what
 *    actually happened on 2026-10-03.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
const lines = readme.split('\n');

const RECOVERY_SECTION = '## Recovering a lost session';
const SECURITY_SECTION = '## Security model';
const TIMEOUT_SECTION = '## Call timeouts';

/** The body of one `##` section, heading-to-next-`##` — the same slice
 *  `req1457ReadmeBuild.test.ts` uses, so the files agree on what a section is. */
function section(heading: string): string {
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  expect(start, `README has a "${heading}" section`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('REQ-1503 — the README carries a procedure a stuck agent can follow', () => {
  it('has a recovery section, positioned where a reader looks for it', () => {
    expect(lines.some((l) => l.trimEnd() === RECOVERY_SECTION), 'the section exists').toBe(true);

    // After the timeout section (which is what sends a reader here) and before
    // the security model (which the routes change). Both positions are load-
    // bearing: a section buried at the bottom of a 500-line README is not a
    // documented way back.
    const at = (h: string) => lines.findIndex((l) => l.trimEnd() === h);
    expect(at(RECOVERY_SECTION), 'it follows the timeouts that lead a reader to it').toBeGreaterThan(
      at(TIMEOUT_SECTION),
    );
    expect(at(RECOVERY_SECTION), 'and precedes the security model its routes amend').toBeLessThan(
      at(SECURITY_SECTION),
    );
  });

  it('keeps the two failure cases separate, because they have different answers', () => {
    const body = section(RECOVERY_SECTION);
    // The card's incident was a dead PROCESS, and conflating the two cases is how
    // a document ends up promising a route that cannot help. Each case needs its
    // own name in the prose.
    expect(body, 'the lost-channel case is named').toMatch(/channel/i);
    expect(body, 'the lost-process case is named separately').toMatch(/process/i);
  });

  it('names the bridge-info file and the way to find it', () => {
    const body = section(RECOVERY_SECTION);
    // Discovery is the whole problem: an agent that has lost its tools cannot ask
    // a tool where the bridge is. A path with no way to find it is not a step.
    expect(body, 'the file is named by its own name').toMatch(/bridge-[\w<>{}.-]*\.json|bridge-<port>\.json/i);
    expect(body, 'and a reader is told how to list it').toMatch(/ls\b|readdir|glob/i);
    expect(body, 'the discovery is scoped to the temp dir it actually lands in').toMatch(/figpea-mcp/);
  });

  it('documents both routes with the header the gate actually requires', () => {
    const body = section(RECOVERY_SECTION);
    expect(body, 'the read-only probe').toMatch(/GET \/state|`\/state`/);
    expect(body, 'the call route').toMatch(/POST \/call|`\/call`/);
    // The gate, named as a header. A document that showed a working call without
    // the header teaches a 401 and a confused reader.
    expect(body, 'and the header that carries the token').toContain('x-figpea-token');
    // …and the routes are never documented as browser-reachable, which they are
    // not: no CORS headers are sent on either.
    expect(body, 'the browser story is told honestly').not.toMatch(/open .{0,30}\/call.{0,40}(in a browser|from a page)/i);
  });

  it('shows a real curl with a real response envelope, beside the failure it prevents', () => {
    const body = section(RECOVERY_SECTION);
    expect(body, 'a copyable command, not a description of one').toMatch(/curl\s/);
    // A success AND a failure, which is this README's own convention: the
    // successful call beside the one that reported success wrongly is what makes
    // a reader check the envelope instead of assuming it.
    expect(body, 'the success shape is shown').toMatch(/"ok"\s*:\s*true/);
    expect(body, 'and so is the failure shape').toMatch(/"ok"\s*:\s*false/);
    expect(body, 'the failure carries a code').toMatch(/"code"\s*:\s*"/);
  });

  it('documents the liveness field, its tokens, and what they do NOT prove', () => {
    const body = section(RECOVERY_SECTION);
    expect(body, 'the field is named').toContain('liveness');
    for (const token of ['unpaired', 'unknown', 'responsive', 'unresponsive']) {
      expect(body, `the \`${token}\` token is documented`).toContain(token);
    }
    // The honest half, and the part a reader is most likely to need: a token is
    // an observation, not a diagnosis. Without this the section teaches an agent
    // to abandon live work.
    expect(body, 'and it is stated that liveness reports observation, not cause').toMatch(
      /observed[^.]{0,80}(not|never)[^.]{0,40}(why|cause|proof)|not proof/i,
    );
    expect(body, 'and the limit is stated as a limit').toMatch(/not proof|no liveness|does not prove|says nothing/i);
  });

  it('the liveness table is the shipped one, in BOTH directions', async () => {
    const { LIVENESS_STATES, NEXT_STEP } = await import('./tabLiveness');
    const body = section(RECOVERY_SECTION);

    // REQ-1394's discipline, applied to the new vocabulary: the table is read
    // from the same map the payload is, so a doc reword and a code change cannot
    // drift apart in either direction. Without this the README would be a fourth
    // copy of the sentences, free to disagree with the three that ship them.
    const rowFor = (token: string): string | null =>
      body.split('\n').find((l) => l.trimStart().startsWith(`| \`${token}\` |`)) ?? null;
    for (const token of LIVENESS_STATES) {
      const row = rowFor(token);
      expect(row, `the liveness table has a row for \`${token}\``).not.toBeNull();
      const cells = row!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      expect(cells[2], `\`${token}\`'s documented action matches NEXT_STEP`).toBe(NEXT_STEP[token]);
    }
    // …and the inverse: no row for a token the payload cannot report, because a
    // reader told to act on one is being sent somewhere that does not exist.
    const documented = [...body.matchAll(/^[ \t]*\|[ \t]*`([a-z_]+)`[ \t]*\|/gm)].map((m) => m[1]);
    const known = new Set<string>(LIVENESS_STATES);
    for (const name of documented) {
      expect(known.has(name), `the recovery section documents "${name}", which liveness cannot report`).toBe(true);
    }
  });

  it('the table lives OUTSIDE the connection-diagnosis section, whose scan window would read it as vocabulary', async () => {
    // `req1394ReadmeDiagnosis.test.ts` asserts every row in the
    // `### Diagnosing a connection` window whose first cell is a backticked
    // lowercase token is a member of CONNECTION_EVENTS. A liveness table placed
    // there turns a shipped suite red for a reason unrelated to any requirement —
    // the same trap `req1457ReadmeBuild.test.ts` documents for the build section.
    const diagnosisStart = lines.findIndex((l) => l.trimEnd() === '### Diagnosing a connection');
    expect(diagnosisStart, 'the diagnosis section exists').toBeGreaterThan(-1);
    const rest = lines.slice(diagnosisStart + 1);
    const end = rest.findIndex((l) => /^#{2,3} /.test(l));
    const window = (end === -1 ? rest : rest.slice(0, end)).join('\n');
    const { LIVENESS_STATES } = await import('./tabLiveness');
    for (const token of LIVENESS_STATES) {
      expect(window.includes(`\`${token}\``), `\`${token}\` is documented outside the diagnosis scan window`).toBe(false);
    }
  });

  it('says which field to read on these routes, since a deliberate request changes the pairing ledger', () => {
    const body = section(RECOVERY_SECTION);
    // The re-check `connectionDiagnosis.ts` asks for of exactly this change: both
    // new routes open a TCP socket on the shared listener, so before any tab pairs
    // `connection.lastEvent` reads `transport_only` — exactly as a `/file` fetch
    // already does. The state is honest (a socket did reach the port with no
    // handshake) but `connection.nextStep` points at reloading a tab, which is the
    // wrong advice for a reader who just proved they are on the right port. Saying
    // so here is what keeps the document honest without rewriting REQ-1394's
    // vocabulary, whose eight tokens are all about the transport.
    expect(body, 'the interaction is disclosed, not left to be discovered').toMatch(/transport_only|lastEvent/);
    expect(body, 'and the field to read instead is named').toMatch(/`?liveness`?\.state|read `?liveness/);
  });

  it('says plainly that a dead bridge process is outside the package\'s reach', () => {
    const body = section(RECOVERY_SECTION);
    // The single most important honesty sentence in this REQ. `POST /call` is a
    // second door into the same process, not a resurrection: the bridge starts
    // inside the stdio process and closes with it, so when the process is gone
    // the routes are gone too.
    expect(body, 'the process case is answered honestly').toMatch(/process/i);
    expect(
      body,
      'a reader is told the package cannot outlive its own process',
    ).toMatch(/cannot|no route|nothing in this package|re-pair|start a fresh/i);
    // And what to do instead, because a limit with no action is the advice-with-
    // no-route this whole mechanism exists to end.
    expect(body, 'with the action that does work').toMatch(/re-pair|pair again|start a fresh|new figpea-mcp/i);
  });

  it('quotes the envelope clause from the module that emits it, rather than paraphrasing it', async () => {
    const body = section(RECOVERY_SECTION);
    const { recoveryHint } = await import('./tabLiveness');
    const emitted = recoveryHint('layer', 'create');

    // Same string, byte for byte. A paraphrase is the REQ-1282 failure mode in a
    // new costume, and this text is read by an agent matching on it.
    expect(body, 'the clause is quoted exactly as the relay emits it').toContain(emitted);
    // …and the quoting points at the diagnosis rather than restating it.
    expect(body, 'and it points at the module that owns the wording').toMatch(/callTimeout|stateCheckHint|recoveryHint/);
  });

  it('never tells a reader to restart the MCP server as RECOVERY', () => {
    const body = section(RECOVERY_SECTION);
    // The host owns that process; this package has never respawned or hot-reloaded
    // it and cannot. Writing "restart the MCP server" in a recovery procedure is
    // the REQ-1282 shape again — advice with no route, in a section whose whole
    // subject is routes.
    expect(body, 'restarting the MCP server is not offered as the way out').not.toMatch(
      /restart the (?:MCP |figpea-mcp )?(?:mcp )?server/i,
    );
  });

  it('keeps the pairing-copy traps the README is already pinned for', () => {
    const body = section(RECOVERY_SECTION);
    // `req1396ReadmePairingCopy.test.ts` scans `Diagnosing a connection` and
    // `Troubleshooting` for exactly these. This section is not in that list, and
    // the rule stands anyway: the editor dials the bridge on load, so "press
    // Connect" has not been true since REQ-720.
    expect(body, 'the steps say open the pairing URL').toMatch(/pairing URL/i);
    expect(body, 'and never describe a gate').not.toMatch(/consent[- ]gate|click(?:ing|s|ed)?\s+(?:the\s+)?\*{0,2}connect\b/i);
    // The whole-file negative pin `readme.test.ts` carries.
    expect(readme.toLowerCase()).not.toContain('is in progress');
  });
});

describe('REQ-1503 — the Security model stops claiming something that became false', () => {
  it('the "no credentials" sentence survives, because the token on disk is now a credential', () => {
    const body = section(SECURITY_SECTION);
    // This build writes its own per-run pairing token to disk, so "The server
    // holds no credentials" is no longer true — and the natural amendment ("no
    // third-party credentials") silently drops the contiguous substring
    // `src/req1492ReadmeSlots.test.ts:98` asserts over this section. That pin is
    // load-bearing and is NOT re-pinned here: the wording below is strictly more
    // precise than the sentence it replaces, so the pin passes untouched.
    expect(body, 'the existing pin still holds').toMatch(/no credentials/i);
    expect(body, 'and the sentence now scopes it').toMatch(/other than its own per-run pairing token/i);
    // And the thing that makes it accurate: what the file is and who may read it.
    expect(body, 'the bridge-info file is disclosed as what holds it').toMatch(/bridge-info/i);
    expect(body, 'with its owner-only mode').toMatch(/0600|owner-only/i);
    expect(body, 'and it says the file goes when the process exits').toMatch(/removed when it exits|removed with/i);
    // The other pins in that section must not have been traded away for this one.
    expect(body, 'the loopback bind is still stated').toMatch(/127\.0\.0\.1/);
    expect(body, 'the per-run token is still stated').toMatch(/token/i);
    expect(body, 'the startup fetches and their opt-out are still stated').toMatch(/FIGPEA_DISABLE_CONTRACT_FETCH/);
    expect(body, 'files never leaving the machine is still stated').toMatch(/never leave your machine/i);
  });
});

describe('REQ-1503 — the two places a stuck reader lands both have an entry', () => {
  it('Troubleshooting covers the vanished namespace and the wedged-tab-with-true-bit case', () => {
    const troubleshooting = lines.slice(lines.findIndex((l) => l.trimEnd() === '## Troubleshooting') + 1);
    const end = troubleshooting.findIndex((l) => /^## /.test(l));
    const body = (end === -1 ? troubleshooting : troubleshooting.slice(0, end)).join('\n');

    // The first is the symptom the card opens with: the tools are simply gone.
    expect(body, 'the MCP namespace vanishing mid-session is documented').toMatch(/namespace|tools (?:vanished|disappeared)/i);
    // The second is the exact shape REQ-1460 measured: every call times out while
    // `tabConnected` is still true.
    expect(body, 'and so is every call timing out while tabConnected stays true').toMatch(/tabConnected/);
    expect(body, 'with the field that actually distinguishes them').toMatch(/liveness/);
    // Each must name an action, or it is a symptom list.
    expect(body, 'and at least one entry routes the reader onward').toMatch(/#recovering-a-lost-session/);
  });

  it('the Tool surface status row advertises the new block', () => {
    const row = lines.find((l) => l.trimStart().startsWith('| `status` |'));
    expect(row, 'the Tool surface table still documents `status`').toBeDefined();
    expect(row!, 'and names the liveness block it returns').toContain('liveness');
    // REQ-1457's pin: the row must not lose a claim it already made while gaining
    // this one.
    for (const claim of ['port', 'token', 'url', 'whether a tab is connected', 'contract version', 'tool count', 'connection']) {
      expect(row!, `the pre-existing claim about \`${claim}\` survives`).toContain(claim);
    }
  });
});
