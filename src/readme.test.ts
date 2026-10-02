import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-088 AC-5 — README exists, its quickstart config block parses as valid
 * JSON and invokes `figpea-mcp`, and every MCP tool name it references
 * exists in the static tool set or a real `group_method` from the v3
 * agent-API contract (guards against README rot as the contract evolves).
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');

const STATIC_TOOLS = ['open_editor', 'status', 'figpea_skill', 'figpea_call', 'figpea_describe'];
// The literal placeholder pattern name the README uses to describe the
// live-generated tool naming convention — not a real tool name itself.
const DOCUMENTED_PLACEHOLDERS = ['group_method'];
// Real group_method names from v3's agent-API contract (src/agent/index.ts's
// registerGroup calls + the layer/canvas/export descriptors), used as README
// examples of live-generated contract tools.
const REAL_CONTRACT_TOOL_EXAMPLES = [
  'layer_setPosition',
  'canvas_screenshot',
  'export_project',
  // REQ-772 AC-5: named in the Call-timeouts retry guidance / state-check
  // advice — all real v3 contract tools.
  'layer_create',
  'session_layerTree',
  // REQ-1020 T7: the image-returning tools newly documented for returnAs —
  // all real v3 contract tools (export group's layer/artboard methods).
  'export_layer',
  'export_artboard',
];
// REQ-772 AC-5 — the known-slow methods whose raised defaults the README's
// "Call timeouts" section documents. All six are real contract tools.
const TIMEOUT_TABLE_METHODS = [
  'session_openFile',
  'session_waitForIdle',
  'export_project',
  'export_specBundle',
  'export_assetHarvest',
  'export_figmaKit',
];

describe('README.md (AC-5)', () => {
  it('exists and is non-empty', () => {
    expect(readme.length).toBeGreaterThan(0);
  });

  it('has a quickstart JSON block that parses and invokes figpea-mcp', () => {
    const match = readme.match(/```json\n([\s\S]*?)\n```/);
    expect(match, 'no fenced json block found').toBeTruthy();
    const parsed = JSON.parse(match![1]);
    const figpeaEntry = parsed.mcpServers?.figpea;
    expect(figpeaEntry).toBeTruthy();
    expect(figpeaEntry.command).toBe('npx');
    expect(figpeaEntry.args).toContain('figpea-mcp');
  });

  it('only references tool names in the static set or the real agent-API contract', () => {
    // Real group_method tool names are prefixed with a known agent-API group
    // name (layer/canvas/export/session/history) -- scoping the match this
    // way excludes unrelated backtick-quoted snake_case strings (error codes
    // like `no_tab`, env vars, etc.) that aren't tool names at all.
    const GROUP_NAMES = ['layer', 'canvas', 'export', 'session', 'history'];
    const groupMethodPattern = new RegExp('`((?:' + GROUP_NAMES.join('|') + ')_[a-zA-Z0-9]+)`', 'g');
    const referenced = [
      ...[...readme.matchAll(groupMethodPattern)].map((m) => m[1]),
      ...STATIC_TOOLS.filter((name) => readme.includes('`' + name + '`')),
    ];
    const allowed = new Set([
      ...STATIC_TOOLS,
      ...REAL_CONTRACT_TOOL_EXAMPLES,
      // REQ-772 AC-5: the known-slow methods named in the "Call timeouts"
      // section are real contract tools too.
      ...TIMEOUT_TABLE_METHODS,
      ...DOCUMENTED_PLACEHOLDERS,
    ]);
    for (const name of referenced) {
      expect(allowed.has(name), `README references unknown tool name: ${name}`).toBe(true);
    }
  });

  it('never claims a "Figma alternative"', () => {
    expect(readme.toLowerCase()).not.toMatch(/figma alternative/);
  });

  it('documents FIGPEA_DISABLE_CONTRACT_FETCH and startup contract prefetch in README (REQ-699 AC-10)', () => {
    expect(readme).toContain('FIGPEA_DISABLE_CONTRACT_FETCH');
    expect(readme).toContain('/agent/contract.json');
    expect(readme).not.toContain('pure localhost relay: it holds no credentials and ships no telemetry');
  });

  it('documents the Connect click and browser permission prompt as expected first-run pairing steps (AC-8)', () => {
    // Shipped first-run pairing steps: actionable pairing URL, Connect consent gate, and LNA permission explainer
    expect(readme).toContain('Guided Pairing & Local Network Access (LNA)');
    expect(readme).toContain('no_tab');
    expect(readme).toContain('https://editor.figpea.com/?agent=1&bridgePort=');
    expect(readme).toContain('Connect');
    expect(readme).toMatch(/Local Network Access|permission/i);

    // Assert pre-REQ placeholder sentence is absent
    expect(readme).not.toMatch(/guided connect flow.*is in progress/i);
    expect(readme.toLowerCase()).not.toContain('is in progress');
  });

  it('documents automated-browser and agent harness pairing options (AC-10)', () => {
    expect(readme).toContain('Automated Browser');
  });

  // REQ-772 AC-5 — the four content pins from the marketing brief §2: the
  // reserved key, the cap number, the table method names, and the AC-3
  // ambiguity phrasing, plus clamp-not-error semantics.
  it('documents call timeouts: reserved _timeoutMs key, cap, table methods, and honest retry guidance (REQ-772 AC-5)', () => {
    expect(readme).toContain('_timeoutMs');
    expect(readme, 'the documented cap number matches MAX_CALL_TIMEOUT_MS').toContain('120000');
    expect(readme, 'values above the cap are clamped, not rejected').toMatch(/clamp/i);
    for (const method of TIMEOUT_TABLE_METHODS) {
      expect(readme, `README documents the raised default for ${method}`).toContain(method);
    }
    expect(readme, 'the AC-3 ambiguity clause is quoted in the retry guidance').toContain('may still be executing');
    expect(readme, 'never forwarded to the tab-side method is stated').toMatch(/never forwarded|not forwarded/i);
  });

  // REQ-1282 T7 — the README is the published mirror of the timeout ladder, so
  // every number T2 changed has to be pinned here. Without these, the section
  // is documentation nobody maintains: it kept promising a flat 10-second
  // default for a package whose floor became 60 s, and the plan's own
  // complaint is that a shipped doc which is merely incomplete is still wrong.
  it('documents the raised flat default, not the 10-second one it replaced (REQ-1282)', () => {
    expect(readme, 'the flat default is documented with its real value').toMatch(/flat 60-second default/i);
    expect(
      readme,
      'the old flat 10-second default is GONE - a doc that still promises it is worse than one that says nothing',
    ).not.toMatch(/flat 10-second default/i);
    expect(readme, 'and the reason it is not 10 s is stated, so the number is not arbitrary').toMatch(
      /render-settle|settle window/i,
    );
  });

  it('documents the burst advice and the host request timeout the cap cannot raise (REQ-1282)', () => {
    expect(readme, 'the burst case is named').toMatch(/burst of mutations/i);
    expect(readme, 'passing _timeoutMs deliberately is the documented response').toMatch(
      /_timeoutMs`? deliberately|deliberately.*_timeoutMs/i,
    );
    expect(readme, 'the host side has its own request timeout, named as such').toMatch(/host.{0,60}request timeout/i);
    expect(readme, 'and the host ceiling is explicitly not raisable from here').toMatch(
      /host.{0,80}(cannot|can't|no parameter|not raisable)/i,
    );
  });

  it('documents the concrete state-check routes the timeout envelope now names (REQ-1282)', () => {
    expect(readme, 'a create is checked by name').toContain('session.find({name');
    expect(readme, 'a patch is checked by id').toContain('session.layerById(');
  });

  // REQ-1018 AC-5 — compact mode default, figpea_call, configuration
  it('documents compact mode default, figpea_call, and --mode/FIGPEA_TOOL_MODE (REQ-1018 AC-5)', () => {
    expect(readme).toMatch(/Tool modes.*figpea_call|figpea_call.*Tool modes/i);
    expect(readme).toContain('figpea_call');
    expect(readme).toMatch(/compact mode.*default|default.*compact/i);
    expect(readme).toMatch(/500.*9,500|9,500.*500|90.*95|95.*90/i);
    expect(readme).toContain('--mode');
    expect(readme).toContain('FIGPEA_TOOL_MODE');
    // at least one figpea_call example (layer.create)
    expect(readme).toMatch(/figpea_call[\s\S]*layer[\s\S]*create|group.*layer.*method.*create/i);
    expect(readme).toMatch(/when to use full|full mode/i);
  });

  // REQ-1020 T7 — off-band image returns: reserved key, payload shape, coded
  // write failure, and the token-saving rule of thumb.
  it('documents returnAs path mode: reserved key, session file payload, and coded failure (REQ-1020 AC-1/AC-4)', () => {
    expect(readme).toContain('returnAs');
    expect(readme).toMatch(/"path"|path.*mode/i);
    expect(readme, 'the three image tools are named').toContain('canvas_screenshot');
    expect(readme).toContain('export_layer');
    expect(readme).toContain('export_artboard');
    expect(readme, 'coded write failure is documented').toContain('return_path_write_failed');
    expect(readme, 'fail-loud on typos is documented').toContain('invalid_params');
    expect(readme, 'the token-saving rule of thumb is stated').toMatch(/1\.3 tokens/);
  });

  // REQ-1279 T6 — the rot-guard for the change that made the section above
  // stop being true as written: the key is no longer scoped to three image
  // tools, and the payload is no longer image-shaped. The three image tool
  // names stay pinned above — they are still examples, just not the limit.
  // REQ-1280 T4 — the rot-guard for the paragraph that stopped being true as
  // written: it described `_rawJson` as a top-level-param feature, which is
  // the FULL mode's surface. Compact mode is the default, and there the only
  // thing that takes a payload is `figpea_call`'s positional `args`.
  it('documents _rawJson on both tool modes, with a figpea_call example and the loud-failure rule (REQ-1280)', () => {
    expect(readme).toContain('_rawJson');
    // The full-mode statement stays true and is kept…
    expect(readme).toMatch(/figpea_layer_create/);
    // …and the compact path is documented beside it, with a copyable payload.
    expect(readme).toMatch(/figpea_call[\s\S]{0,400}?"_rawJson":\s*true/);
    expect(readme, 'the batch ops example is the nested case the flag exists for').toMatch(/"method":\s*"batch"/);
    // Both modes are named as places the flag works, so "every tool" is no
    // longer a full-mode-only claim.
    expect(readme).toMatch(/\*\*Full mode\*\*/);
    expect(readme).toMatch(/\*\*Compact mode/);
    // The loud-failure behaviour is stated, not implied.
    expect(readme).toMatch(/invalid_params/);
    expect(readme, 'the refusal is documented as naming the flag').toMatch(/naming `_rawJson`|names `_rawJson`/);
    // ⛔ RE-POINTED TWICE, and stronger each time. The original line pinned one
    // word, `opt-in`, guarding "the fix is opt-in only" — a sentence REQ-1318
    // made FALSE, because a structured parameter may now travel as a JSON
    // string with no flag at all. REQ-1318 kept the word (the flag IS still
    // opt-in) and added a companion, because it split what one word used to
    // conflate into two claims that can now drift apart independently: a
    // structured param needs NO FLAG, while `_rawJson` remains the opt-in
    // route.
    //
    // REQ-1338 then re-pointed THAT companion. It read
    // /schema-blind/i — one word, asserting a property the flag no longer has:
    // since this REQ the flag's parse is declaration-scoped too, so at a
    // declared `string`/`number`/`boolean` it does nothing the default does
    // not already do. Three statements are asserted where one was, each saying
    // what the reader now needs to be able to rely on — the position nothing
    // declares, the declared scalar left alone, and the falsified framing
    // pinned as ABSENT so a future REQ cannot quietly restore the "broader"
    // pitch. Deleting the pin would have been the finding; the absence guard is
    // REQ-1318's own technique, applied to the word that replaced it.
    expect(readme, 'a structured parameter needs no flag at all').toMatch(/no flag/i);
    expect(readme, 'the flag remains opt-in').toMatch(/opt-in/i);
    expect(readme, 'the flag parses where nothing declares the position').toMatch(/declares nothing|nothing about|manifest fetched/i);
    expect(readme, 'a declared string is left exactly as sent').toMatch(/left exactly as you sent it|never parsed|provably never touched/i);
    expect(readme, 'the falsified "schema-blind" framing is GONE').not.toMatch(/schema-blind/);
  });

  // REQ-1318 T4 — the rot-guards for the discoverability this requirement
  // owes. The escape hatch is worthless as a capability if an agent cannot
  // find it, and the README is where a human or an agent reading the package
  // looks before the first call.
  it('documents the JSON-string escape hatch with a copyable payload (REQ-1318)', () => {
    // The route is named where the nesting rule lives — that is the paragraph
    // an agent reads when a nested array is the thing that bit them.
    expect(readme, 'the nesting rule names the JSON-string route').toMatch(/JSON string/i);
    // A payload to copy, not an abstract rule (the REQ-1268 idiom).
    expect(readme, 'a copyable stringified batch payload is shown').toMatch(/"group":\s*"layer",\s*"method":\s*"batch"/);
    // The reason a string is the right carrier, so the rule is not read as an
    // arbitrary encoding preference.
    expect(readme, 'the hint says why a string is the safe carrier').toMatch(/scalar/i);
    // The call that teaches the shape, so the paragraph is not a dead end.
    expect(readme).toContain('figpea_describe');
  });

  it('the superseded "forwarded as the plain string" claim is GONE from the _rawJson paragraph (REQ-1318)', () => {
    // This sentence was true when REQ-1280 shipped and is false now. Left in
    // place it would contradict the new rule two paragraphs earlier, so it is
    // pinned as absent rather than left to rot.
    expect(readme).not.toMatch(/without `_rawJson` a stringified object or array is forwarded as the plain string it is/);
    // …and the correction actually replaced it with the true statement. The
    // label below was re-pointed by REQ-1338 because it named the framing the
    // README no longer uses ("the broader route"): the flag is now the route
    // for a position nothing declares, which is why A2 keeps the literal
    // "both routes" and the assertion still passes on that. The ASSERTION is
    // untouched — it is the pin REQ-1318 put there, and the copy it was
    // written for still contains one of its three words.
    expect(readme, 'the flag is documented as one of the two routes, not the only one').toMatch(/broader|either route|both routes/i);
  });

  // The rot-guard for the failure class this package's own docs kept walking
  // into: a method whose parameter is a plain OBJECT. The section documented
  // array-nesting and the JSON-string escape hatch, and said nothing about the
  // shape that actually cost a /design run three round trips — including one
  // that answered `open_fetch_failed: HTTP 404` for a file that exists, sending
  // the reader to the filesystem instead of to their own argument shape. The
  // transport is right and the calls were wrong, so the only thing that can keep
  // teaching the right shape is the document — which is exactly the kind of doc
  // that goes stale quietly, hence these pins. They assert the three correct
  // call shapes, the three error strings that make each trap recognisable, the
  // positional-slot-only limit on the JSON-string route, and that every
  // counter-example is labelled, so a wrong call can never be copied out of
  // here as if it were a right one.
  it('documents the object-valued-parameter rule with openFile/stylePatch/setPageFill (designfix 2026-10-01)', () => {
    // The rule itself, and that it is stated as the object being the slot.
    expect(readme, 'the object-is-the-positional-slot rule is stated').toMatch(/object IS the positional slot/i);

    // The three correct shapes, copyable and unambiguous.
    expect(readme, 'openFile passes the input object as args[0]').toMatch(
      /"method":\s*"openFile",\s*"args":\s*\[\{\s*"filePath"/,
    );
    expect(readme, 'stylePatch passes flat style keys at args[1]').toMatch(
      /"method":\s*"stylePatch",\s*"args":\s*\[\s*"L_\w+",\s*\{\s*"font[^"]*"/,
    );
    expect(readme, 'setPageFill is a scalar then an object').toMatch(
      /"method":\s*"setPageFill",\s*"args":\s*\[\s*"P_\d+",\s*\{\s*"fill"/,
    );

    // The trap each correct shape exists to defuse, named by its own message —
    // so a reader who has ALREADY hit the failure recognises it here.
    expect(readme, 'the misleading 404 on an existing file is called out').toContain('open_fetch_failed');
    expect(readme, 'the flat-vs-nested style asymmetry is named').toContain('unsupported_style_key');
    expect(readme, 'a stringified patch is refused as a string').toMatch(/patch must be object \(got string\)/);

    // The create/stylePatch contrast, which is a real asymmetry and the thing
    // most likely to be "tidied" back into a single spelling.
    expect(readme, 'create nests style and stylePatch does not').toMatch(/create\(\) nests them and stylePatch does NOT/i);

    // The JSON-string route's limit: whole positional slot only, never nested
    // inside a real object. Pinned because the route reads as universally
    // applicable, and the nesting trap is precisely its blind spot.
    expect(readme, 'the string route is scoped to a whole positional slot').toMatch(
      /string must be the whole positional slot/i,
    );
    expect(readme, 'and the reason is stated, not just the rule').toMatch(/never descends into an object/i);

    // The escape hatch that makes the rule checkable rather than memorised.
    expect(readme, 'figpea_describe is named as the authoritative shape').toContain('figpea_describe');

    // Every counter-example is labelled, so a wrong call cannot be mistaken for
    // a right one by a reader skimming the JSON block.
    expect(readme, 'counter-examples are marked WRONG').toMatch(/^\/\/ WRONG —/m);
  });

  // The COHERENCE pin — the one the presence-only pins above structurally
  // cannot do: an example must be paired with the error it actually produces.
  //
  // How this shipped a wrong pair. The section showed the setPageFill
  // counter-example as two positional args and quoted `patch must be object
  // (got string)`. That message comes from the editor's entry-time validator,
  // which can only see a string in `patch` AFTER the single-object wrapper has
  // been expanded to positional order — and expansion runs only for a call of
  // exactly one argument (v3 registry.ts:130, `raw.length !== 1`). Two
  // positional args therefore never expand, `patch` stays an object, entry
  // validation passes, and the page-fill validator rejects the unknown key with
  // a DIFFERENT message: `unsupported page fill key "patch"`. Every pin above
  // was still green, because each of them only asked whether a string was
  // PRESENT.
  //
  // So this one asserts the example's SHAPE — parsed as JSON, one argument, an
  // object, keyed by the method's own parameter names, `patch` a string — which
  // is the only shape for which the quoted message is reachable. It is
  // deliberately structural rather than textual: the comment may be reworded,
  // rewrapped, recoloured, or have its id names changed without breaking it.
  //
  // IF THIS FAILS: the example and the message have drifted apart again, and
  // they must be re-derived together against the live editor — do not relax the
  // assertion to make it green. Relaxing it is what let the misquote through.
  it('pairs each counter-example with the error that call actually produces, not merely with an error string', () => {
    const lines = readme.split('\n');
    // The setPageFill counter-example: the one call in the section that carries a
    // stringified `patch`. (The correct example beside it is a real object, so
    // `"patch":` + a quote only matches the failing one.)
    const idx = lines.findIndex((l) => l.includes('"method": "setPageFill"') && /"patch":\s*"/.test(l));
    expect(idx, 'the setPageFill counter-example line was found').toBeGreaterThan(-1);

    // Shape: the SINGLE-OBJECT WRAPPER, which is both the observed /design
    // failure and the only shape whose quoted message is reachable.
    const call = JSON.parse(lines[idx]!.trim());
    expect(call.group, 'the example is a layer call').toBe('layer');
    expect(call.method).toBe('setPageFill');
    expect(
      Array.isArray(call.args) ? call.args.length : -1,
      'the counter-example is the single-object wrapper form — the 2-positional-arg form does NOT expand, so it yields a different error',
    ).toBe(1);
    expect(typeof call.args[0], 'args[0] is the wrapper object, not a pageId string').toBe('object');
    expect(Object.keys(call.args[0]).sort()).toEqual(['pageId', 'patch']);
    expect(typeof call.args[0].patch, 'the mistake is that patch is a STRING where an object was required').toBe('string');

    // Pairing: the message the comment quotes is the one attached to THIS
    // example, read from the comment block immediately above it. Walks back over
    // contiguous `//` lines, so rewrapping the comment is fine but moving the
    // message onto a different example is not.
    const comment: string[] = [];
    for (let i = idx - 1; i >= 0 && /^\s*\/\//.test(lines[i]!); i--) comment.unshift(lines[i]!);
    expect(comment.join('\n'), 'the message is quoted on the example it belongs to').toMatch(
      /patch must be object \(got string\)/,
    );
    expect(comment.join('\n'), 'the example is still labelled a counter-example').toMatch(/WRONG/);
  });

  it('documents returnAs path mode as reaching every binary export, not only image tools (REQ-1279)', () => {
    expect(readme, 'the section is no longer image-scoped').toContain('Off-band binary returns');
    expect(readme, 'the old image-only section title is gone').not.toContain('Off-band image returns');
    expect(readme, 'the qualifying payload shape is stated, image or not').toMatch(/\{bytes, mime, filename\}/);
    expect(readme, 'the key is stated to reach every binary result').toMatch(/every|any/i);
    // The worked example is the case the requirement exists for.
    expect(readme, 'the native .fp export is the worked example').toMatch(/export_project[\s\S]{0,600}?\.fp/);
    // The naming rule: a payload names itself, so a .fp never lands as .bin.
    expect(readme, 'the naming rule and its .bin contrast are documented').toMatch(/\.bin/);
    // The conditional key: canvas.screenshot carries no filename, and an
    // agent deciding whether a key is missing should be told why.
    expect(readme, 'the conditional filename key is documented').toMatch(/only when the payload carried one/i);
  });

  // REQ-1295 — the section this lands in currently CONTRADICTS itself: `:176`
  // says "you never wrap it in a second envelope keyed by the parameter's own
  // name", while `:199-200` says a name-keyed single object "is a legal `args`,
  // and it expands to positional order". Both are true; the missing qualifier is
  // a fact in the editor (`registry.ts:130` — expansion runs only when the call
  // carries exactly one argument). These pins are structural rather than
  // presence-only, for the reason the coherence pin above already records: an
  // example paired with a rule it does not actually obey is exactly what let
  // the contradiction ship.
  it('states the one legal wrapper and the exactly-one-argument reason for it (REQ-1295 R1)', () => {
    // The prohibition itself survives verbatim — it is true as far as it goes.
    expect(readme, 'the object-is-the-positional-slot rule is still stated').toMatch(/object IS the positional slot/i);
    // …and the exception that makes it true rather than a contradiction.
    expect(readme, 'the single-object whole-args wrapper is named as legal').toMatch(/only while it is the whole of `args`|the whole of `args`, keyed by the method/i);
    // The reason, stated rather than asserted: expansion is a one-argument fact.
    expect(readme, 'and the reason is the exactly-one-argument rule').toMatch(/exactly one argument/i);
    // …and what stops it, named as the thing an agent actually did.
    expect(readme, 'the positional argument in front is what breaks it').toMatch(/goes in front of it|goes in front/i);
    // Claims discipline: no adverb this change cannot measure.
    expect(readme, 'no unmeasured reliability adverb').not.toMatch(/now correct|lossless|never wastes a round trip/i);
  });

  it('carries the stylePatch WRONG example beside the flat one, and the same wrapper shown legal on its own (REQ-1295 R2)', () => {
    const lines = readme.split('\n');
    const wrongIdx = lines.findIndex((l) => l.includes('"method": "stylePatch"') && /"args":\s*\[\s*"L_\w+",\s*\{\s*"patch"/.test(l));
    expect(wrongIdx, 'the two-positional-argument stylePatch counter-example is present').toBeGreaterThan(-1);
    // The flat form is still there beside it, unchanged.
    const flatIdx = lines.findIndex((l) => l.includes('"method": "stylePatch"') && /"args":\s*\[\s*"L_\w+",\s*\{\s*"font/.test(l));
    expect(flatIdx, 'the flat stylePatch example survived').toBeGreaterThan(-1);
    // The load-bearing third line: the SAME wrapper, correct on its own.
    const legalIdx = lines.findIndex((l) => l.includes('"method": "stylePatch"') && /"args":\s*\[\s*\{\s*"id":\s*"L_/.test(l));
    expect(legalIdx, 'the same wrapper is shown legal as the whole of args').toBeGreaterThan(-1);
    // The error is named, and READ as the wrapper mistake rather than a bad key.
    expect(readme, 'the editor code is named so the failure is recognisable').toContain('unsupported_style_key');
    expect(readme, 'and it is read as the declaration, not a style key').toMatch(/is not a style key|instead of its contents/i);
  });

  // The STRUCTURAL coherence pin (brief §3e): the WRONG example really does
  // carry two positional arguments with the declared key inside the object, the
  // flat form sits beside it, and the single-object wrapper is its own example.
  // Asserted by parsing the three calls, NOT by "both strings appear" — the
  // shape is the entire claim, and a rewording of the prose must not be able to
  // make it true.
  it('the three stylePatch examples are structurally distinct — a wrapper at two args, the flat form, and the wrapper alone (REQ-1295)', () => {
    const lines = readme.split('\n');
    const pick = (re: RegExp) => {
      const idx = lines.findIndex((l) => re.test(l));
      expect(idx, `an example matching ${re} exists`).toBeGreaterThan(-1);
      return { idx, call: JSON.parse(lines[idx]!.trim()) };
    };
    const wrong = pick(/"method":\s*"stylePatch"[^\n]*"patch"\s*:\s*\{/);
    const flat = pick(/"method":\s*"stylePatch",\s*"args":\s*\[\s*"L_\w+",\s*\{\s*"font/);
    const legal = pick(/"method":\s*"stylePatch",\s*"args":\s*\[\s*\{\s*"id":/);

    // WRONG: two positional args, the declared key nested inside the object —
    // the exact shape the editor cannot expand.
    expect(wrong.call.group).toBe('layer');
    expect(wrong.call.method).toBe('stylePatch');
    expect(Array.isArray(wrong.call.args), 'the counter-example has an args array').toBe(true);
    expect(wrong.call.args.length, 'it carries TWO positional arguments, so nothing expands it').toBe(2);
    expect(typeof wrong.call.args[0], 'args[0] is the layer id').toBe('string');
    expect(Object.keys(wrong.call.args[1]), 'the object is keyed by the DECLARED param name').toEqual(['patch']);
    expect(typeof wrong.call.args[1].patch, 'and the real contents sit inside it').toBe('object');

    // FLAT: same method, two positional args, the contents at args[1] with no
    // envelope key at all.
    expect(flat.call.args.length).toBe(2);
    expect(typeof flat.call.args[0]).toBe('string');
    expect(Object.keys(flat.call.args[1]), 'nothing is wrapped').not.toContain('patch');

    // LEGAL: the SAME wrapper, as the whole of args — one argument.
    expect(legal.call.args.length, 'the legal form carries exactly ONE argument, which is why it expands').toBe(1);
    expect(Object.keys(legal.call.args[0]).sort()).toEqual(['id', 'patch']);

    // The counter-example is LABELLED, so a reader skimming the block cannot
    // copy it out as if it were a right one.
    const comment: string[] = [];
    for (let i = wrong.idx - 1; i >= 0 && /^\s*\/\//.test(lines[i]!); i--) comment.unshift(lines[i]!);
    expect(comment.join('\n'), 'the pair is labelled WRONG and quotes the code it produces').toMatch(/WRONG/);
    expect(comment.join('\n')).toMatch(/unsupported_style_key/);
  });

  it('says params is the DECLARATION not the encoding, and names the wire key it ships (REQ-1295 R4)', () => {
    expect(readme, 'the declaration/encoding distinction is stated').toMatch(/`params` is the \*\*declaration\*\*, not the \*\*encoding\*\*/);
    // The wire key, by the name actually shipped — the README and the tool
    // description must not drift onto two different names.
    expect(readme, 'the per-method wire key is documented').toMatch(/`wire`/);
    // …and it is described as derived, so a reader trusts it for a method the
    // document never names.
    expect(readme, 'the key is stated to be derived from the manifest').toMatch(/derived from the same manifest|derived from the manifest/i);
  });

  // REQ-1296 T5 — the rot-guard for the failure class this change closed. The
  // requirement found its way: an agent passed `filePath` to
  // `canvas_screenshot`, was answered `ok: true` with the image inline, and
  // wrote nothing — so a run's own log asserted evidence that did not exist.
  // An unrecognised parameter is now an `invalid_params` error naming the key,
  // and the README has to say so in the same section that teaches `returnAs`,
  // because that is the place an agent looks when it wonders what to do with a
  // capture. Pinning the KEY (`filePath`) and the real lane, not just the word
  // "invalid_params" (which the REQ-1020 pins above already cover), is what
  // stops the sentence rotting into a vaguer one that teaches nothing.
  it('documents that an unrecognised parameter is an invalid_params error naming the key (REQ-1296)', () => {
    expect(readme, 'the undeclared-parameter failure is documented in the README').toMatch(/invalid_params/);
    expect(readme, 'the message is documented as naming the offending key').toMatch(/unknown parameter/i);
    expect(readme, 'the evidence-persistence key that caused the incident is named').toContain('filePath');
    expect(readme, 'the real lane to disk is stated, not just the reserved key').toMatch(/returnAs: "path"/);
    expect(readme, 'the never-do-this is stated so an agent does not invent a second key').toMatch(
      /never pass a file path as a parameter/i,
    );
  });

  // REQ-1301 AC-5. The README is this package's only public doc surface, and
  // three of its statements became factually wrong the moment the banner and
  // the emitted URLs moved to `localhost`. These assertions pin the two hosts
  // as *distinct facts with different jobs* — the bind stays `127.0.0.1` and is
  // a security property; the emitted URL is `localhost` and exists so the tab
  // and the bridge share an address space. A README that collapsed them into
  // one sentence would pass a looser check and teach the next reader to
  // "tidy" the host back, which is the recurrence this case exists to prevent.
  it('distinguishes the loopback bind (127.0.0.1) from the emitted URL host (localhost), with the why (REQ-1301)', () => {
    expect(readme, 'the bind host is still documented as 127.0.0.1').toMatch(/binds? \*\*localhost only\*\* \(`127\.0\.0\.1`\)/);
    expect(readme, 'and the security claim that it is never a public interface survives').toMatch(/never a public interface/i);

    expect(readme, 'the stderr pair family is documented with the new localhost host').toMatch(
      /`localhost:<port>` \+ `pairing token: <uuid>`/,
    );
    expect(readme, 'the older 127.0.0.1 pair is still documented, for an already-installed server').toMatch(
      /`127\.0\.0\.1:<port>` \+ `pairing token: <uuid>`/,
    );
    expect(readme, 'the localhost form is described as what the server now prints').toMatch(/now prints/i);

    // The bind/URL distinction itself, and the reason it is deliberate. These
    // assert the documented *fact* (the two hosts are named separately, one of
    // them is the emitted one, and the split is called out as intentional),
    // not one particular sentence's phrasing — pinning the wording would fail
    // every harmless rewording while still letting a README that quietly
    // collapsed the two hosts back into one pass a looser reading.
    expect(readme, 'the bind is documented as 127.0.0.1').toMatch(/bind[^\n]{0,80}127\.0\.0\.1/i);
    expect(readme, 'the emitted URL host is documented as localhost').toMatch(/(?:emit\w*|URL)[^\n]{0,200}localhost/i);
    expect(readme, 'the two are explicitly called out as different, on purpose').toMatch(
      /(?:two|different)[^\n]{0,40}hosts?[^\n]{0,40}on purpose/i,
    );
    expect(readme, 'the reason the emitted host is localhost is stated, not just the fact').toMatch(
      /same address space|localhost exemption/i,
    );
    expect(readme, 'the bind staying IPv4-only is called out so it is not widened').toMatch(/IPv4-only|not widened|stays IPv4/i);
  });

  // REQ-1309 T5 — the rot-guard for the third pre-flight, and the one that
  // costs the most when it rots: a package user hitting `invalid_transform`
  // has to be able to READ the rule, not merely be told the call failed. The
  // pinning is deliberately specific — the CODE, the SOURCE of the applicable
  // set, and the before-the-round-trip claim are the three facts that go stale
  // first. Pinning only the word "props" would pass against a paragraph that
  // had quietly gone vague.
  it('documents that a prop which does not apply to the kind is refused before the tab is reached (REQ-1309)', () => {
    expect(readme, "the editor's own code is documented").toContain('invalid_transform');
    expect(readme, 'the method it applies to is named').toContain('layer_create');
    // The rule is read from the manifest, not from a list baked into this
    // package — that is the whole reason a future kind needs no edit here.
    expect(readme, "the applicable set is documented as the manifest's own derivation").toContain('params.props.shape');
    expect(readme, 'and as merged with the per-kind entry').toContain('byKind[kind]');
    expect(readme, 'the refusal is documented as happening before the tab is reached').toMatch(
      /before the (call reaches the )?(editor|tab)/i,
    );
    expect(readme, 'and as costing no tab round trip').toMatch(/round trip/i);
  });

  // REQ-1443 AC-5 — the build-before-test rule, documented in the one place a
  // contributor reads before running this package's suite. Three of these suites
  // spawn the BUILT dist/cli.js over real stdio, so on a cold checkout they fail
  // with the build precondition unmet. The failure now names its own remedy
  // (REQ-1443 T2), but a contributor should learn the order from the README
  // rather than by being lied to once.
  //
  // These pin the three *facts* AC-5 asks for — the order, the reason, and the
  // absence of an over-promise — not one phrasing. The last one matters most:
  // a testing section that said "npm test just works" would be a lie the
  // contributor discovers the hard way, since the cold run is REQUIRED to fail.
  it('documents the required order — build before test — and why three suites need it (REQ-1443)', () => {
    const testing = readme.match(/^## Testing\s*$([\s\S]*?)(?=^## )/m);
    expect(testing, 'README has no `## Testing` section').toBeTruthy();
    const section = testing![1];

    // The order, stated as an order: build first, then test.
    const buildAt = section.indexOf('npm run build');
    const testAt = section.indexOf('npm test');
    expect(buildAt, 'the testing section names the build step').toBeGreaterThan(-1);
    expect(testAt, 'the testing section names the test step').toBeGreaterThan(-1);
    expect(
      buildAt,
      'the build must come before the tests — these suites spawn a build artifact, so test-then-build is the wrong order',
    ).toBeLessThan(testAt);

    // The reason, not just the order: what is built, and why it matters.
    expect(section, 'it names the built entry the suites spawn').toMatch(/dist\/cli\.js/);
    expect(section, 'it says the suites drive the built entry').toMatch(/built/i);
    expect(section, 'it says how they drive it — a real process over stdio, not an import').toMatch(/stdio/i);

    // The honest limit: a cold run still fails, and the README must not say
    // otherwise (AC-1 requires the failure; promising otherwise would teach
    // the next contributor to trust a green gate that never ran).
    expect(section.toLowerCase(), 'it must not promise a suite that works with no build step').not.toMatch(
      /works? out of the box|no build step|no build required|npm test just works|ready to run without/,
    );
  });
});
