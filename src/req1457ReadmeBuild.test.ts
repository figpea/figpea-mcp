import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-1457 T7 — the README describes the build identity it ships (docs).
 *
 * A README is a shared page: REQ-449's rule and Universal §7's both say a
 * change that alters a documented surface has to update that documentation in
 * the SAME change, not leave it to a follow-up. Two of these four obligations
 * are MANDATORY rather than tidy, and the reason is not stylistic:
 *
 *  - the `status` JSON example is a **full verbatim payload**. The moment a
 *    field is added, an example that drops it teaches an agent to read a shape
 *    the server stopped returning — and the reader here is a program, so a
 *    stale example does not get misread, it gets acted on.
 *  - the `status` row of the Tool surface table is an INVENTORY of what the tool
 *    returns, so an incomplete one is incomplete by definition.
 *
 * This file asserts only what THIS requirement promises. It is deliberately
 * NOT a byte pin of prose REQ-1394 owns, and it deliberately does not re-pin
 * anything `readme.test.ts` or `req1394ReadmeDiagnosis.test.ts` already hold —
 * a second pin on the same sentence makes the next honest rewording a two-file
 * negotiation instead of a one-line edit.
 *
 * The three content obligations the card's parenthetical creates, which are the
 * ones a reader cannot infer from the payload shape:
 *
 *  1. what the identifier IS;
 *  2. what `stale` is computed AGAINST;
 *  3. **the no-change-rebuild false positive** — without it, a reader told only
 *     "stale = my fix is missing" chases a fix that is already shipped.
 */

/** The fields the shipped payload carries under `build`. */
const BUILD_FIELDS = ['version', 'buildId', 'builtAt', 'servedAt', 'root'];

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');

const lines = readme.split('\n');

/** The body of one `###` section, heading-to-next-`#{2,3}` — the same slice
 *  `req1394ReadmeDiagnosis.test.ts` uses, so the two agree on what a section is. */
function section(heading: string): string {
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  expect(start, `README has a "${heading}" section`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,3} /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The `status` JSON example the diagnosis section prints. */
function statusExample(): string {
  const body = section('### Diagnosing a connection');
  const block = body.match(/```json\n([\s\S]*?)\n```/);
  expect(block, 'the diagnosis section prints the status payload').toBeTruthy();
  return block![1]!;
}

describe('REQ-1457 — the status example shows the build identity the server actually returns', () => {
  it('is a payload the server would really return, so every shipped field is present', () => {
    // STRUCTURAL, not presence-only: a reworded example cannot satisfy this and
    // a payload that quietly loses a key cannot pass it. The lesson that drove
    // the structural pins in `readme.test.ts` was exactly a doc pair that agreed
    // as strings while disagreeing in substance.
    const example = JSON.parse(statusExample()) as Record<string, any>;
    for (const field of BUILD_FIELDS) {
      expect(Object.keys(example.build ?? {}), `the example's build block names \`${field}\``).toContain(field);
    }
    expect(
      'buildStale' in example,
      'the top-level staleness flag is in the example too — it is the field an agent branches on',
    ).toBe(true);
    // Every key the example shows is one this REQ or a shipped REQ really
    // publishes. A typo here would teach a reader to read for a field that
    // never arrives, which is the whole failure this file exists to prevent.
    //
    // REQ-1492 (c919286) added `bridgeSlots`, `activeConnectionId`, `tab` and
    // `connections` to the payload AND to this example in the same change, so the
    // declared set grows here exactly as it does in
    // `req1457BuildStatus.test.ts`. It stays exact — the example dropping a
    // shipped field, or naming one the server never returns, still fails.
    expect(Object.keys(example).sort()).toEqual(
      [
        'build',
        'buildStale',
        'connection',
        'contractVersion',
        'port',
        'tabConnected',
        'token',
        'toolCount',
        'url',
        'bridgeSlots',
        'activeConnectionId',
        'tab',
        'connections',
      ].sort(),
    );
  });

  it('shows the two field kinds a reader has to tell apart', () => {
    const example = JSON.parse(statusExample()) as Record<string, any>;
    expect(typeof example.buildStale, 'the flag is a boolean, exactly as the AC words it').toBe('boolean');
    expect(String(example.build.buildId), 'the identifier has the shipped shape, so a reader can match it').toMatch(
      /^sha256:[0-9a-f]{12}$/,
    );
    expect(String(example.build.builtAt), 'both instants are ISO-8601, as shipped').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(example.build.servedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('REQ-1457 — the Tool surface table names what status returns', () => {
  it('the status row advertises the build identity and points at the new section', () => {
    const row = lines.find((l) => l.trimStart().startsWith('| `status` |'));
    expect(row, 'the Tool surface table still documents `status`').toBeDefined();
    expect(row!, 'the row names the build identity').toMatch(/build/i);
    expect(row!, 'and links the section that explains it').toMatch(/#which-build-is-this-server-running/);
  });

  it('the row keeps every claim REQ-1394 made — it gains a field, it does not lose one', () => {
    const row = lines.find((l) => l.trimStart().startsWith('| `status` |'))!;
    // The claims REQ-1394's row actually makes, quoted as it makes them. Three
    // of the six are backticked field names and three are prose ("whether a tab
    // is connected", not `tabConnected`) — pinning the prose it uses rather
    // than a tidier spelling it never had keeps this a gate on not LOSING a
    // claim, which is what AC-5 is about, and not a licence to rewrite the row.
    for (const claim of ['port', 'token', 'url', 'whether a tab is connected', 'contract version', 'tool count', 'connection']) {
      expect(row, `REQ-1394's claim about \`${claim}\` survives the edit`).toContain(claim);
    }
  });
});

describe('REQ-1457 — a reader can tell WHICH build this is, and what stale means', () => {
  const BUILD_SECTION = '### Which build is this server running?';

  it('states what stale is computed against, not just what it is called', () => {
    const body = section(BUILD_SECTION);
    expect(
      body,
      'the comparison is against figpea-mcp/dist on the machine running the MCP server — a reader who assumes "my checkout" is wrong whenever the two differ',
    ).toMatch(/figpea-mcp\/dist/);
    expect(body, 'and the machine qualifier is stated, since that is where it is actually read').toMatch(
      /machine running|this server|this process/i,
    );
  });

  it('states what the identifier is, and how to use it', () => {
    const body = section(BUILD_SECTION);
    expect(body, 'the identifier is described as a content hash, which is what makes it stable').toMatch(
      /content (hash|id|identifier)/i,
    );
    expect(body, 'and the reader is told what to do with it — match it, do not just read it').toMatch(
      /match|compare/i,
    );
  });

  it('names the no-change-rebuild false positive, which no reader could infer', () => {
    const body = section(BUILD_SECTION);
    expect(body, 'a rebuild with no code change still reports stale — said, not left to be discovered').toMatch(
      /rebuild/i,
    );
    expect(
      body,
      'the two cases are separated by the buildId being UNCHANGED, which is the only thing that makes the flag actionable',
      // Tolerant of the backticks a Markdown field name carries — the CLAIM is
      // pinned, not one spelling of the token around it.
    ).toMatch(/same\s*`?buildId|buildId`?[^.]{0,40}unchanged|unchanged[^.]{0,40}buildId/i);
  });

  it('says the remedy is restarting the MCP server, and that this package does not do it for you', () => {
    const body = section(BUILD_SECTION);
    expect(body, 'the action is named').toMatch(/restart/i);
    expect(
      body,
      'the host owns the process, so a reader is not left hunting for a respawn or hot-reload that does not exist here',
    ).toMatch(/host|client/i);
  });

  it('says the flag says nothing about the editor tab, so it cannot be over-read', () => {
    const body = section(BUILD_SECTION);
    expect(body, 'the tab is a different process and its build is a different fact').toMatch(/tab/i);
    expect(body, 'and the limit is stated as a limit, not implied').toMatch(/nothing about|says nothing|not about/i);
  });

  it('is a SIBLING ### section, not nested inside Diagnosing a connection', () => {
    // Load-bearing, not cosmetic. `req1394ReadmeDiagnosis.test.ts` slices that
    // section heading-to-next-`#{2,3}` and asserts every table row whose first
    // cell is a backticked lowercase token is a member of CONNECTION_EVENTS — so
    // a build row placed inside that window would turn a shipped suite red for a
    // reason unrelated to this requirement. A `####` heading would NOT end the
    // scan window; a `###` does.
    const buildHeading = lines.findIndex((l) => l.trimEnd() === BUILD_SECTION);
    expect(buildHeading, 'the build section is a `###` heading').toBeGreaterThan(-1);
    expect(lines[buildHeading]!.startsWith('### ')).toBe(true);
    expect(lines[buildHeading]!.startsWith('####'), 'and not a `####` nested under the connection section').toBe(false);

    const diagnosisStart = lines.findIndex((l) => l.trimEnd() === '### Diagnosing a connection');
    const afterDiagnosis = lines.slice(diagnosisStart + 1);
    const nextBoundary = afterDiagnosis.findIndex((l) => /^#{2,3} /.test(l));
    const window = afterDiagnosis.slice(0, nextBoundary === -1 ? afterDiagnosis.length : nextBoundary).join('\n');
    expect(
      window.includes(BUILD_SECTION),
      'the build section sits OUTSIDE the diagnosis scan window',
    ).toBe(false);
  });

  it('names fields in camelCase, so a backticked name can never be read as a connection token', () => {
    // Belt and braces with the sibling heading: `req1394ReadmeDiagnosis.test.ts`
    // captures `/`([a-z_]+)`/` in a row's FIRST cell and asserts membership in
    // CONNECTION_EVENTS. A camelCase name cannot match `[a-z_]+` at all, so this
    // holds even if the section is later moved.
    const body = section(BUILD_SECTION);
    expect(body, 'the flag is named by its real spelling').toContain('buildStale');
    expect(body, 'and the identifier too').toContain('buildId');
  });
});

describe('REQ-1457 — the timeout section says the message carries the stamp', () => {
  it('adds the clause without disturbing the quote readme.test.ts pins', () => {
    // APPEND, never rewrite: `readme.test.ts` pins `may still be executing` and
    // the retry-guidance prose around it, and AC-4 appends to the shipped
    // string, so the existing quote stays a valid PREFIX. One clause is added.
    const start = lines.findIndex((l) => l.startsWith('## Call timeouts'));
    expect(start, 'the Call timeouts section exists').toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^## /.test(l));
    const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');

    expect(body, 'the existing quoted envelope is still quoted').toContain('may still be executing');
    expect(body, 'and the clause now says the message also carries the build').toMatch(/serving build|build identity/i);
    expect(body, 'pointing at the section that explains it').toMatch(/#which-build-is-this-server-running/);
  });
});

describe('REQ-1457 — a stuck reader lands in Troubleshooting and finds the answer', () => {
  it('has a buildStale bullet that names the action', () => {
    const bullet = lines.find((l) => l.trimStart().startsWith('- **`buildStale: true`**'));
    expect(bullet, 'the Troubleshooting section has a buildStale bullet').toBeDefined();
    expect(bullet!, 'it names what to do').toMatch(/restart/i);
    // The `no_tab` bullet beside it is the model, and its own pin locates
    // bullets by line prefix rather than position — so adding this one cannot
    // disturb it, which is asserted rather than assumed.
    expect(
      lines.some((l) => l.trimStart().startsWith('- **`no_tab`**')),
      'the existing no_tab bullet is untouched',
    ).toBe(true);
  });
});