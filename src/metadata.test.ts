import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-088 AC-3 — package metadata is complete, correct, and points at the
 * standalone repo's permanent home; a LICENSE file with MIT text exists.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** REQ-188 AC-5 — the contract `major.minor` this package targets.
 *
 * LOCKSTEP RULE (decided 2026-08-15): this package's `major.minor` tracks the
 * `window.figpea` contract's `major.minor`, and the PATCH slot belongs to
 * figpea-mcp alone, for its own bugfixes. So contract 1.8.0 => 1.8.x here,
 * and a fix that needs no contract change ships as 1.8.1 without inventing a
 * contract version that does not exist. This works because the contract only
 * ever bumps minor/major, never patch.
 *
 * Why the rule exists: with no such coupling this package sat at 0.1.0 while
 * the contract advanced to 1.8.0 — 22 minor bumps and a major — and, because
 * the tool list is generated at runtime, it kept "working" while silently
 * losing every parameter schema (REQ-188). Nothing failed anywhere.
 *
 * ⚠️ Bumping this literal is NOT the whole job. It is a hand-maintained pin
 * until REQ-695 lands the build-breaking sync gate that reads v3's VERSION
 * directly; until then, nothing here can tell you the contract has moved. */
const TARGET_CONTRACT_MAJOR_MINOR = '1.8';

describe('package.json metadata (AC-3)', () => {
  it('is unscoped, independently versioned, and MIT-licensed', () => {
    expect(pkg.name).toBe('figpea-mcp');
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBeUndefined();
  });

  it('tracks the contract major.minor, reserving the patch slot for its own fixes (REQ-188 AC-5)', () => {
    const [major, minor, patch] = String(pkg.version).split('.');
    expect(`${major}.${minor}`).toBe(TARGET_CONTRACT_MAJOR_MINOR);
    // The patch slot is ours: any value is legitimate, but it must exist, so
    // the version stays a well-formed semver triple.
    expect(patch).toMatch(/^\d+$/);
  });

  it('reports the same version over MCP as it declares in package.json', () => {
    // A drifting SERVER_VERSION would misreport the server's identity to
    // every connected client while package.json looked correct.
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'mcpServer.ts'), 'utf8');
    const declared = /const SERVER_VERSION = '([^']+)'/.exec(source)?.[1];
    expect(declared).toBe(pkg.version);
  });

  it('has a non-empty description and keyword list, with no "-alternative" framing', () => {
    expect(typeof pkg.description).toBe('string');
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.description).not.toMatch(/REQ-\d+/);
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.keywords.some((k: string) => k.includes('alternative'))).toBe(false);
  });

  it('points repository/homepage/bugs at the standalone repo', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/figpea/figpea-mcp.git');
    expect(pkg.homepage).toBe('https://github.com/figpea/figpea-mcp#readme');
    expect(pkg.bugs?.url).toBe('https://github.com/figpea/figpea-mcp/issues');
  });

  it('declares bin/files/engines and a prepublishOnly build+typecheck gate', () => {
    expect(pkg.bin['figpea-mcp']).toBe('dist/cli.js');
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.engines?.node).toBeTruthy();
    expect(pkg.scripts.prepublishOnly).toMatch(/build/);
    expect(pkg.scripts.prepublishOnly).toMatch(/typecheck/);
  });

  it('ships a LICENSE file with MIT text', () => {
    const license = fs.readFileSync(path.join(PACKAGE_ROOT, 'LICENSE'), 'utf8');
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Permission is hereby granted, free of charge/);
  });
});
