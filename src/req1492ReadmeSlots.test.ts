import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * REQ-1492 T6 — the README may not describe a behaviour this change removed,
 * and must describe the one it added (docs are content, §7 forbids prose-only).
 *
 * ## Why this is a separate guard file, and why it asserts ABSENCE as well as presence
 *
 * The README is the package's only storefront, and the sentences this REQ makes
 * false are exactly the ones a reader acts on: "the newest connection always
 * wins" tells someone opening a second tab that it will take over, and the
 * security model's "Single active session" reads as a property of the protocol
 * rather than of one build. A test that only pinned the new sentences would keep
 * passing while any of the false ones survived — and it is precisely the FALSE
 * ones that caused the incident to be silent for 25 minutes.
 *
 * ## These assertions are written against the claims, not against a wording
 *
 * Every pair below names the *claim* that must be present and the *claim* that
 * must be gone. A different sentence, a different paragraph order or a different
 * phrasing of the same fact passes exactly as the AC requires; a reworded
 * falsehood does not.
 */

const README = resolve(__dirname, '../README.md');
const readme = readFileSync(README, 'utf8');

/** The body of one `## `/`### ` section, matched on its exact heading text. */
function extractSections(md: string, headings: string[]): string[] {
  const lines = md.split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    const m = /^#{2,3}\s+(.*)$/.exec(line);
    if (m && headings.includes(m[1].trim())) starts.push(i);
  });
  return starts.map((start) => {
    const level = /^#+/.exec(lines[start])![0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{2,3})\s+/.exec(lines[i]);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  });
}

/** The row of the Tool surface table documenting one tool, or null. */
function toolRow(name: string): string | null {
  const line = readme.split('\n').find((l) => l.trimStart().startsWith(`| \`${name}\` |`));
  return line ?? null;
}

/** Every line of a Markdown table row set that mentions `needle`, for
 *  "is this documented anywhere in that table" assertions. */
function tableLinesMatching(needle: RegExp): string[] {
  return readme.split('\n').filter((l) => l.trimStart().startsWith('|') && needle.test(l));
}

const pairing = extractSections(readme, ['How pairing works']);
const security = extractSections(readme, ['Security model']);

describe('REQ-1492 AC-7 — the README may not still promise a silent takeover', () => {
  it('no longer says one connected tab at a time with the newest connection winning', () => {
    // The sentence this REQ makes false. A reader who trusts it opens a second
    // tab expecting to take over — which is what lost ~60 authored layers twice.
    expect(
      readme,
      'the pairing prose must not describe the newest connection taking the slot',
    ).not.toMatch(/newest connection always wins/i);
    expect(readme, 'nor in any other form of the same claim').not.toMatch(/newest (?:valid )?connection always (?:wins|supersedes)/i);
    expect(pairing.join('\n'), 'and the pairing section says what now happens instead').toMatch(/refus/i);
    expect(pairing.join('\n'), 'naming the mode that lets a second tab pair').toMatch(/--bridge-slots=multi|FIGPEA_BRIDGE_SLOTS/);
    expect(
      pairing.join('\n'),
      'and saying the tab already paired keeps serving — a refusal displaces nothing',
    ).toMatch(/keeps? (?:its |still )?(?:serving|connected|its socket)|still (?:serving|connected)/i);
  });

  it('the security model no longer claims a single active session superseded by the newest', () => {
    expect(
      security.join('\n'),
      'the security model must not state the superseded-by-newest policy',
    ).not.toMatch(/newest valid connection always supersedes/i);
    expect(security.join('\n'), 'nor describe the session model as newest-wins').not.toMatch(/newest[- ]wins/i);
    // …and it keeps its OTHER bullets: the loopback bind, the per-run token, the
    // two startup fetches, no credentials, files never leave. A rewrite that
    // dropped them would shrink a security section, which is not a fix.
    expect(security.join('\n'), 'the loopback bind is still stated').toMatch(/127\.0\.0\.1/);
    expect(security.join('\n'), 'the per-run pairing token is still stated').toMatch(/token/i);
    expect(security.join('\n'), 'the startup fetches and their opt-out are still stated').toMatch(
      /FIGPEA_DISABLE_CONTRACT_FETCH/,
    );
    expect(security.join('\n'), 'holding no credentials is still stated').toMatch(/no credentials/i);
    expect(security.join('\n'), 'files never leaving the machine is still stated').toMatch(/never leave your machine/i);
  });
});

describe('REQ-1492 AC-4 — the tool table documents select_tab WITH ITS CONDITION', () => {
  it('has a row for it, and that row states it is multi-slot mode only and absent on the default bridge', () => {
    const row = toolRow('select_tab');
    expect(row, 'the Tool surface table documents `select_tab`').not.toBeNull();
    expect(row!, 'the row states the condition it is registered under').toMatch(/multi-slot/);
    expect(row!, 'and that it is absent on the default single-slot bridge').toMatch(/absent|not registered|only when|only in/i);
  });

  it('never claims the tool is always available', () => {
    // The one thing the plan's own first draft got wrong: an "always registered"
    // claim the default build cannot honour, and which six exact tool-list
    // assertions require to be false.
    const rows = tableLinesMatching(/select_tab/);
    for (const row of rows) {
      expect(row, 'no table row may call select_tab always registered').not.toMatch(/always registered/i);
      expect(row, 'nor available on every bridge').not.toMatch(/available on every bridge/i);
    }
    expect(readme, 'nor anywhere else in the prose').not.toMatch(/always[- ]registered/i);
  });

  it('the compact-mode tool count is not silently changed by it', () => {
    // The default flow advertises 5 tools. If `select_tab` were registered
    // unconditionally this sentence would become false without anyone noticing —
    // so the assertion is on the LIST it names (everything before the count),
    // not on the whole line: the line may legitimately mention select_tab as the
    // extra tool multi-slot mode adds.
    const compact = readme.split('\n').find((l) => /advertises only `open_editor`/.test(l));
    expect(compact, 'the compact-mode sentence still exists').toBeDefined();
    const list = compact!.split('—')[0];
    expect(list, 'the default list does not gain select_tab').not.toContain('select_tab');
    expect(compact!, 'and the stated count is unchanged').toMatch(/5 tools/);
    for (const name of ['open_editor', 'status', 'figpea_skill', 'figpea_call', 'figpea_describe']) {
      expect(list, `the default list still names ${name}`).toContain(name);
    }
  });
});

describe('REQ-1492 AC-6 — the status row documents the tab / connections block, originSource included', () => {
  it('names the tab block, the connections list and originSource', () => {
    const row = toolRow('status');
    expect(row, 'the Tool surface table still documents `status`').not.toBeNull();
    expect(row!, 'the status row names the tab block').toMatch(/\btab\b/);
    expect(row!, 'and the connections list').toMatch(/connections/);
    expect(row!, 'including originSource by name — a field nobody documents is a field nobody reads').toMatch(
      /originSource/,
    );
  });

  it('says the origin is unavailable rather than invented when the browser sent no header', () => {
    expect(readme, 'the README documents the originSource values').toMatch(/handshake/);
    expect(readme, 'both of them').toMatch(/absent/);
    const claims = readme
      .split('\n')
      .filter((l) => /originSource|no Origin header/i.test(l))
      .join('\n');
    expect(
      claims,
      'and states plainly that no header means no origin rather than a reconstructed one',
    ).toMatch(/null|not sent|declined|no Origin header|absent/i);
    expect(
      readme,
      'and never claims the bridge reconstructs an origin from the pairing URL or Host',
    ).not.toMatch(/reconstructs? (?:an|the) origin from/i);
  });

  it('names the mode, so a reader can tell why a tool is missing from their bridge', () => {
    expect(readme, 'the README names the bridgeSlots field').toContain('bridgeSlots');
    expect(readme, 'and its two values').toMatch(/bridgeSlots[^\n]*single/);
  });
});

describe('REQ-1492 — both configuration tables document the slot knob', () => {
  // Scoped to rows that spell the FLAG WITH ITS VALUES (`--bridge-slots=single`),
  // not to any row that mentions it: the Tool surface table's `select_tab` row
  // legitimately names the flag too, and asserting a configuration default on a
  // tool row would test nothing about the configuration table.
  const tables = tableLinesMatching(/--bridge-slots=single|FIGPEA_BRIDGE_SLOTS=single/);

  it('documents --bridge-slots=single|multi with single as the default and CLI winning over env', () => {
    const cli = tables.find((l) => l.includes('--bridge-slots=single'));
    expect(cli, 'the flag is in a configuration table').toBeDefined();
    expect(cli!, 'with both values').toMatch(/single/);
    expect(cli!, 'and multi').toMatch(/multi/);
    expect(cli!, 'and `single` as the default').toMatch(/`single`|\|\s*single\s*\|/);
    expect(cli!, 'and CLI-over-env precedence').toMatch(/CLI/i);
  });

  it('documents FIGPEA_BRIDGE_SLOTS as the environment fallback', () => {
    const env = tables.find((l) => l.includes('FIGPEA_BRIDGE_SLOTS'));
    expect(env, 'the env var is documented too').toBeDefined();
    expect(env!, 'with the same two values').toMatch(/single/);
    expect(env!, 'and multi').toMatch(/multi/);
  });

  it('states that an invalid value falls back to single rather than crashing the stdio channel', () => {
    // The knob's contract, stated where the other knob's identical contract is.
    const config = extractSections(readme, ['Configuration', 'Configuration & Environment Variables']).join('\n');
    expect(config, 'the surrounding configuration prose states the invalid-value handling').toMatch(
      /invalid/i,
    );
    expect(config, 'and that it is ignored, not rejected').toMatch(/ignor/i);
  });
});