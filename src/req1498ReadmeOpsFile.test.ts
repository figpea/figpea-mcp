import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * REQ-1498 (supporting rows) — the payload-from-file option must be
 * DOCUMENTED in the surface that owns it, and the claims the marketing brief
 * forbids must stay forbidden.
 *
 * A separate guard file (REQ-1492's precedent, not appended to the shared
 * `readme.test.ts`) because this requirement's contract is two-sided: the copy
 * has to ADD two option names, a worked example per lane, a cross-link and a
 * budget clause, AND it must not start claiming the budget moved, that a new
 * capability exists, or that anything is uploaded or unbounded. A test that only
 * asserted the additions would keep passing while a forbidden claim grew next
 * to them.
 *
 * ⛔ THE ASSERTIONS ARE WRITTEN AGAINST THE AC AND THE BRIEF'S ❌ LIST, never
 * against a proposed wording. Each one is a claim-present / claim-absent pair,
 * so a different paragraph structure, sentence order or phrasing passes exactly
 * as the requirement requires and a forbidden claim fails however it is spelled.
 *
 * ⛔ THEY ARE SCOPED TO THE REGIONS THIS REQUIREMENT EDITS. `README.md` is a
 * shared hotspot: a whole-file scan would either be meaningless (a phrase banned
 * in the new section is legitimate somewhere else) or a brittle pin on prose
 * this requirement does not own.
 */

// ── region extraction ───────────────────────────────────────────────────────

function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,4}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (start === -1) throw new Error(`README has no section heading "${heading}"`);
  const level = /^#+/.exec(lines[start])![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,4})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The body of one `## `/`### ` section, matched on its exact heading text. */
function topSection(md: string, heading: string): string {
  return section(md, heading);
}

/** Everything the requirement is allowed to have added: the dispatcher section
 *  (nesting rule, JSON-string route, the budget), the `returnAs` section, and
 *  the tool table. The absence assertions run over exactly this set. */
function editedRegions(md: string): string {
  return [
    topSection(md, 'Tool surface'),
    topSection(md, 'Tool modes & `figpea_call` dispatcher'),
    topSection(md, 'Configuration'),
  ].join('\n');
}

// ── the document ────────────────────────────────────────────────────────────

const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
const dispatcher = topSection(readme, 'Tool modes & `figpea_call` dispatcher');
const budget = section(readme, 'Per-call argument budget');
const returnAs = topSection(readme, 'Off-band binary returns (`returnAs: "path"`)');
const toolSurface = topSection(readme, 'Tool surface');

// ── the option is documented, per lane ──────────────────────────────────────

describe('the payload-from-file option is documented for BOTH calling conventions', () => {
  it('names opsFile (full mode) and _opsFile (compact figpea_call), and says which is which', () => {
    // AC-2 names two lanes, so two names. An option documented for one
    // convention and discoverable in the other is the exact half-fix REQ-1283
    // recorded for this package.
    expect(dispatcher).toContain('opsFile');
    expect(dispatcher).toContain('_opsFile');
    // The unprefixed name belongs to the generated tools and the prefixed one
    // to the dispatcher; a reader who cannot tell them apart will use the wrong
    // one and be told it is an unknown parameter.
    expect(dispatcher).toMatch(/(full mode|generated tool)[^\n]{0,200}opsFile/i);
    expect(dispatcher).toMatch(/figpea_call[^\n]{0,200}_opsFile/i);
  });

  it('gives a copyable example for each lane', () => {
    // A name with no payload is a knob nobody uses. Both spellings, in real
    // call form, with the file's content shown too — because the file's content
    // IS the argument the server substitutes.
    const fullModeExample = /opsFile["']?\s*:\s*["'`]?\/[^\s"'`]+/;
    const compactExample = /_opsFile["']?\s*:\s*["'`]?\/[^\s"'`]+/;
    expect(dispatcher, 'a full-mode opsFile call form').toMatch(fullModeExample);
    expect(dispatcher, 'a compact _opsFile call form').toMatch(compactExample);
    // And the array itself, so the reader knows what goes in the file.
    expect(dispatcher).toMatch(/\[\s*\{\s*"?method"?\s*:/);
  });

  it('states that the file replaces the payload rather than accompanying it', () => {
    // The ambiguity has to be documented, not left to be discovered: a caller
    // that sends both would otherwise be guessing which one won. Asserted as a
    // CLAIM — some line that mentions the option must also declare the two
    // incompatible — rather than as the word "ambiguous", so a rewording that
    // says the same thing passes and a sentence that quietly drops the claim
    // does not.
    const linesWithTheOption = dispatcher.split('\n').filter((l) => l.includes('opsFile'));
    expect(linesWithTheOption.length, 'lines naming the option').toBeGreaterThan(0);
    expect(
      linesWithTheOption.some((l) => /\bboth\b/i.test(l)),
      'some line naming the option must say the array and the path are mutually exclusive',
    ).toBe(true);
  });
});

describe('the JSON-string route is presented as a SIBLING, not replaced', () => {
  it('the string route still works and is still documented in its own section', () => {
    // REQ-1498 does NOT remove the string route: it is still the right answer
    // for a harness that cannot SEND a nested value. A copy that replaced it
    // would be a behaviour claim this requirement never made.
    expect(dispatcher).toMatch(/JSON string/i);
    expect(dispatcher).toMatch(/parses it before the round trip|this server parses it/i);
  });

  it('the two routes are told apart by WHEN each applies', () => {
    // The string route rescues a host that cannot send nesting; the file route
    // rescues a payload too long to paste at all. Without the distinction the
    // reader picks one and the other failure is unexplained.
    expect(dispatcher).toMatch(/host harness|host harness|your harness|harness/i);
    expect(dispatcher).toMatch(/too long|pasted into|cannot send it at all|keep a long payload out of the call/i);
  });

  it('⛔ asserts the ABSENCE of "the JSON string is the only route" phrasing', () => {
    // The brief's explicit re-pin watch. The string route is not narrowed, so
    // any copy that declares it the ONLY route is false the moment this change
    // ships.
    for (const forbidden of [
      /only route/i,
      /only way to send a (nested|structured|array)/i,
      /the JSON string is the only/i,
      /no other route/i,
    ]) {
      expect(dispatcher, `"${forbidden}" must not appear in the dispatcher section`).not.toMatch(forbidden);
    }
  });
});

describe('the per-call argument budget is unchanged by a payload read from a file', () => {
  it('says the budget is enforced in the editor and still applies to a file-read payload', () => {
    // The single easiest wrong claim to make about this feature. If the copy
    // implies the file route moves or lifts the limit, an agent will author a
    // batch that is refused whole and lose the whole build.
    expect(budget).toMatch(/editor/i);
    expect(budget).toMatch(/(applies|unchanged|still applies)/i);
    expect(budget).toMatch(/opsFile|from a file|read from a file/i);
    // And the instruction not to hardcode today's number survives, because the
    // number is the editor's and can move.
    expect(budget).toMatch(/do not hardcode/i);
    // Chunking is still the remedy, restated rather than replaced.
    expect(budget).toMatch(/split/i);
  });

  it('⛔ asserts the ABSENCE of any "no limit" claim', () => {
    for (const forbidden of [
      /unlimited/i,
      /without limits?/i,
      /no (size |length )?cap/i,
      /bypass(es|ed)? the (argument |per-call )?budget/i,
      /no more size cap/i,
      /raise the limit/i,
      /larger batches (than|than before)/i,
    ]) {
      expect(budget, `"${forbidden}" must not appear in the budget section`).not.toMatch(forbidden);
      expect(dispatcher, `"${forbidden}" must not appear in the dispatcher section`).not.toMatch(forbidden);
    }
  });
});

describe('the openFile block carries the bare-string case as a worked line', () => {
  it('the third worked line is a bare path where the object belongs, and what it answers', () => {
    // AC-6/AC-7: the caller must be able to recognise this exact call and fix
    // it in one retry. The existing block already has the correct form and the
    // wrapped form; the bare form is the third, and it is the one the card hit.
    const openFileBlock = /\{ "group": "session", "method": "openFile"[\s\S]{0,4000}/.exec(dispatcher)?.[0] ?? '';
    expect(openFileBlock, 'the openFile worked-example block').toContain('"group": "session", "method": "openFile"');
    // A bare path in `args[0]`, shown as a call the reader can recognise…
    expect(openFileBlock).toMatch(/"args"\s*:\s*\[\s*"\/[^"]+"\s*\]/);
    // …and the named refusal it produces, so the message is recognisable too.
    expect(openFileBlock).toMatch(/filePath/);
  });

  it('does NOT teach that openFile takes a bare path — the refusal names a diagnostic, not a supported form', () => {
    // The refusal says "send {"filePath": …}". A reader who reads that as "a
    // path is accepted here" invents a third spelling. So the bare-path line must
    // be marked wrong the way the other two lines in that block already are —
    // and the mark in this block is a `// WRONG` comment, which in a JSON
    // example block sits on the line ABOVE the call rather than inside it. This
    // row reads both, because reading only the call line would pass on copy that
    // presents a bare path as a supported form.
    const openFileBlock = /\{ "group": "session", "method": "openFile"[\s\S]{0,4000}/.exec(dispatcher)?.[0] ?? '';
    const lines = openFileBlock.split('\n');
    const bareIndex = lines.findIndex((l) => /"args"\s*:\s*\[\s*"\/[^"]+"\s*\]/.test(l));
    expect(bareIndex, 'the bare-string worked line').toBeGreaterThanOrEqual(0);
    const callLine = lines[bareIndex];
    // The mark is a run of `//` comment lines directly ABOVE the call (an
    // example block annotates the line below it), so walk the whole run.
    const marks: string[] = [];
    for (let i = bareIndex - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) marks.unshift(lines[i]);
    expect(marks.join('\n')).toMatch(/WRONG|not|refus|invalid_params|instead/i);
  });
});

describe('the tool table and the returnAs section cross-link the new option', () => {
  it('the figpea_describe row states the encoding is STATED by the response', () => {
    // AC-5's fix is that `wire` now says what `params` cannot. A row that only
    // says "returns the wire shape" leaves the reader inferring the encoding
    // from a declaration, which is the defect.
    const row = /^\| `figpea_describe`.*$/m.exec(toolSurface)?.[0] ?? '';
    expect(row, 'the figpea_describe tool-table row').toBeTruthy();
    expect(row).toMatch(/state[sd]?\b/i);
    expect(row).toMatch(/array|args\[0\]|positional/i);
  });

  it('the figpea_call row carries the new reserved key', () => {
    const row = /^\| `figpea_call`.*$/m.exec(toolSurface)?.[0] ?? '';
    expect(row, 'the figpea_call tool-table row').toBeTruthy();
    expect(row).toMatch(/_opsFile/);
  });

  it('the returnAs section carries the one cross-link to the file route', () => {
    // The two file-writing features are one sentence apart and easy to
    // confuse: one puts a RESULT on disk, the other takes a PAYLOAD from disk.
    expect(returnAs).toMatch(/opsFile/);
    expect(returnAs).toMatch(/batch|payload|input/i);
  });
});

describe('⛔ the forbidden claims stay forbidden across every edited region', () => {
  it('no throughput, token or latency figure is claimed', () => {
    // Nothing in this requirement measures latency, and a bare "saves tokens"
    // number with no measurement is a claim the repo cannot support.
    const regions = editedRegions(readme);
    for (const forbidden of [/saves? (you )?\d+[\d,]*\s*tokens/i, /\d+%\s*(fewer|less)\s*tokens/i, /\d+\s*×\s*(faster|cheaper)/i]) {
      expect(regions, `"${forbidden}" must not appear in the edited regions`).not.toMatch(forbidden);
    }
  });

  it('no claim that the payload is uploaded, imported, synced, shared or "from the cloud"', () => {
    // The privacy framing this README already states — loopback only, files
    // never leave your machine — must not be softened by the new sentence.
    //
    // ⛔ `upload`/`import`/`sync` are banned only as AFFIRMATIVE claims. The
    // correct copy restates the privacy line ("nothing is uploaded"), so a blunt
    // word-ban would fail the very sentence the brief asks for. So each
    // occurrence must sit inside a sentence that negates it.
    const regions = editedRegions(readme);
    for (const forbidden of [/from the cloud/i, /shareable/i]) {
      expect(regions, `"${forbidden}" must not appear in the edited regions`).not.toMatch(forbidden);
    }
    for (const word of ['upload', 'import', 'sync']) {
      const sentences = regions
        .split(/(?<=[.!?])\s+/)
        .filter((s) => new RegExp(`\\b${word}`, 'i').test(s));
      for (const sentence of sentences) {
        expect(sentence, `"${word}" may only appear negated`).toMatch(/\b(not|nothing|never|no|nor)\b/i);
      }
    }
  });

  it('no claim that a new capability, feature or format support arrived', () => {
    const regions = editedRegions(readme);
    for (const forbidden of [/new (capability|feature|support for)/i, /now supports? /i]) {
      expect(regions, `"${forbidden}" must not appear in the edited regions`).not.toMatch(forbidden);
    }
  });

  it('no claim that the editor contract, its version or its error codes changed', () => {
    // The change is relay-side and mint no new error code; saying otherwise
    // would send a reader looking for a contract bump that does not exist.
    const regions = editedRegions(readme);
    for (const forbidden of [/contract (version )?(bump|changed|moved|incremented)/i, /error codes? (changed|added|are new)/i, /new error code/i]) {
      expect(regions, `"${forbidden}" must not appear in the edited regions`).not.toMatch(forbidden);
    }
  });

  it('✅ and it does say the editor behaviour is unchanged, once, plainly', () => {
    // The positive half of the same claim: an agent reading only this section
    // must be able to tell that nothing about `describe()`, the contract version
    // or the codes moved.
    expect(dispatcher).toMatch(/No editor behaviour changed/i);
  });
});