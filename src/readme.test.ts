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
    // Opt-in-ness is stated, so the fix is not read as changing the default.
    expect(readme).toMatch(/opt-in/i);
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
});
