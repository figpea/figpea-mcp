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

const STATIC_TOOLS = ['open_editor', 'status', 'figpea_skill'];
// The literal placeholder pattern name the README uses to describe the
// live-generated tool naming convention — not a real tool name itself.
const DOCUMENTED_PLACEHOLDERS = ['group_method'];
// Real group_method names from v3's agent-API contract (src/agent/index.ts's
// registerGroup calls + the layer/canvas/export descriptors), used as README
// examples of live-generated contract tools.
const REAL_CONTRACT_TOOL_EXAMPLES = ['layer_setPosition', 'canvas_screenshot', 'export_project'];

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
    const allowed = new Set([...STATIC_TOOLS, ...REAL_CONTRACT_TOOL_EXAMPLES, ...DOCUMENTED_PLACEHOLDERS]);
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
});
