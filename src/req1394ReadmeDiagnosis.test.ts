import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONNECTION_EVENTS, NEXT_STEP, type ConnectionEvent } from './connectionDiagnosis';

/**
 * REQ-1394 T5 — the documented vocabulary cannot drift from the shipped one
 * (AC-3, AC-5).
 *
 * The README is the package's only storefront and the only surface guaranteed
 * to reach every consumer, so it has to enumerate the same tokens the payload
 * publishes — and, per AC-3, say what to DO about each one. An enumeration
 * without an action per token is exactly what AC-3 rejects, and a table that
 * quietly falls behind the code is worse than no table: an agent reads it,
 * trusts it, and acts on a token that no longer exists.
 *
 * The parity check below is what makes that impossible: every action cell is
 * compared for EQUALITY against `NEXT_STEP`, the one source the payload itself
 * reads. Changing a sentence in one place without the other turns this file
 * red.
 *
 * AC-5's documentation half: the counters are per-process, start at zero when
 * the MCP server starts, and are not a historical record — and that is stated
 * rather than left for the reader to infer.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');

/** The row of the new table that documents one token, or null if absent. */
function rowFor(token: ConnectionEvent): string | null {
  const line = readme.split('\n').find((l) => l.trimStart().startsWith(`| \`${token}\` |`));
  return line ?? null;
}

/** The action cell of a table row, trimmed of its Markdown pipes. */
function actionCell(token: ConnectionEvent): string | null {
  const row = rowFor(token);
  if (row === null) return null;
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  // token | meaning | what to do next
  return cells[2] ?? null;
}

/** The body of the "Diagnosing a connection" section, table rows included. */
function diagnosisSection(): string {
  // Matched as a whole LINE, not a substring: the `status` row links to this
  // section by name, so a substring search finds the link first and returns
  // everything up to the heading — no table, no rows.
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === '### Diagnosing a connection');
  expect(start, 'README has a "Diagnosing a connection" section').toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,3} /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('REQ-1394 AC-3 — the README enumerates the shipped vocabulary', () => {
  it('names every token the payload can report', () => {
    for (const token of CONNECTION_EVENTS) {
      expect(readme, `README documents the \`${token}\` token`).toContain(`\`${token}\``);
    }
  });

  it('documents no token the payload cannot report', () => {
    // A row for a retired token is the drift this file exists to catch: the
    // reader is told to act on something that can never come back. Scoped to
    // the diagnosis section, so the tool-surface and timeout tables (which
    // legitimately name tool names) are not read as vocabulary.
    const known = new Set<string>(CONNECTION_EVENTS);
    const documented = [...diagnosisSection().matchAll(/^[ \t]*\|[ \t]*`([a-z_]+)`[ \t]*\|/gm)].map((m) => m[1]);
    expect(documented.length, 'the diagnosis table has rows').toBeGreaterThan(0);
    for (const name of documented) {
      expect(known.has(name), `README documents "${name}", which the payload cannot report`).toBe(true);
    }
  });

  it('gives every token a what-to-do-next cell, not just a name', () => {
    for (const token of CONNECTION_EVENTS) {
      const cell = actionCell(token);
      expect(cell, `\`${token}\` has an action cell in the diagnosis table`).not.toBeNull();
      expect(cell!.length, `\`${token}\`'s action is non-empty`).toBeGreaterThan(0);
    }
  });

  it('every action cell equals the sentence the payload ships — the two cannot drift (AC-3)', () => {
    for (const token of CONNECTION_EVENTS) {
      expect(actionCell(token), `\`${token}\`'s documented action matches NEXT_STEP`).toBe(NEXT_STEP[token]);
    }
  });

  it('explains what each token MEANS, so the table is not a bare enumeration', () => {
    for (const token of CONNECTION_EVENTS) {
      const row = rowFor(token)!;
      const meaning = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')[1]?.trim() ?? '';
      expect(meaning.length, `\`${token}\` has a meaning cell`).toBeGreaterThan(0);
    }
  });

  it('the `status` tool-surface row mentions the diagnosis (AC-3)', () => {
    const row = readme.split('\n').find((l) => l.trimStart().startsWith('| `status` |'));
    expect(row, 'the Tool surface table still documents `status`').toBeDefined();
    expect(row!, 'the status row names the diagnosis').toMatch(/connection|diagnos/i);
  });

  it('says the `no_tab` payload carries the same diagnosis (AC-4)', () => {
    expect(readme, 'the docs state that no_tab carries the diagnosis').toMatch(/no_tab[^\n]*connection|connection[^\n]*no_tab/i);
  });

  it("the README's own front-page `no_tab` example shows the block too, not a payload that no longer exists", () => {
    // The README prints this payload twice — here in the Guided Pairing callout,
    // and again in the diagnosis section. An example that silently drops a field
    // teaches an agent to read a shape the server stopped returning.
    const callout = readme.slice(0, readme.indexOf('## Quickstart'));
    // The callout is a blockquote, so every line carries a `> ` prefix — the
    // fences are `> ```text` / `> ````, not at column 0.
    const unquoted = callout.replace(/^> ?/gm, '');
    const block = unquoted.match(/```text\n([\s\S]*?)\n\s*```/);
    expect(block, 'the callout shows a payload example').toBeTruthy();
    expect(block![1], 'the callout example carries the diagnosis').toContain('"connection"');
    expect(block![1], 'and names the field an agent reads').toContain('"lastEvent"');
  });

  it('the troubleshooting `no_tab` bullet points at the diagnosis, not only at "open a tab" (AC-3)', () => {
    const bullet = readme.split('\n').find((l) => l.trimStart().startsWith('- **`no_tab`**'));
    expect(bullet, 'the Troubleshooting section still has a no_tab bullet').toBeDefined();
    expect(bullet!, 'and it names what to read').toMatch(/lastEvent|connection|status/);
  });
});

describe('REQ-1394 AC-5 — the counter semantics are stated, not implied', () => {
  it('states the counters cover this process only', () => {
    expect(readme).toMatch(/per[- ]process|this (MCP )?server process|current server process/i);
  });

  it('states they begin at zero when the server restarts', () => {
    expect(readme, 'the README says the counters reset on restart').toMatch(/reset|start at zero|begin at zero|zero when/i);
  });

  it('states they are not a record of any earlier run', () => {
    expect(readme, 'the README says the counters are per-run, not historical').toMatch(
      /not a (historical )?record|previous run|earlier run|earlier server run|past run/i,
    );
  });

  it('names connection.startedAt as the field that dates the run (AC-5)', () => {
    expect(readme, 'the README names the field that dates the counters').toContain('startedAt');
  });

  it('says what the field reports rather than why the failure happened', () => {
    // The claims discipline the marketing brief carries: this reports what
    // THIS process observed. A README promising to explain why a pairing failed
    // would be claiming more than a bridge on one port can know.
    expect(readme.toLowerCase()).not.toMatch(/diagnose your connection problems/);
  });
});