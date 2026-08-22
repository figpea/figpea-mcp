import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-088 AC-3 — package metadata is complete, correct, and points at the
 * standalone repo's permanent home; a LICENSE file with MIT text exists.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** REQ-188 AC-5 → REQ-769 reconciliation. This package used to LOCKSTEP its
 * major.minor with the `window.figpea` contract's major.minor
 * (TARGET_CONTRACT_MAJOR_MINOR = e.g. '1.8'), reserving the patch slot for
 * figpea-mcp fixes. That hand-maintained pin is RETIRED as of REQ-699 +
 * REQ-769: contract currency is now enforced at RUNTIME by origin fetch
 * (`contractFetch.ts` fetches /agent/contract.json at startup and hard-fails
 * on an `envVersion` mismatch), replacing the hand-maintained pin the old
 * comment itself called temporary "until REQ-695". The package versions
 * independently (currently 2.0.x) while the contract VERSION stays 1.x —
 * the invariant worth keeping instead is `SERVER_VERSION === pkg.version`
 * (tested below), so the server never misreports its identity.
 *
 * The gate below is NOT vacuous: it reads the real fetch module and asserts
 * the runtime envVersion gate actually exists and is armed (EXPECTED_ENV_
 * VERSION declared and an env_mismatch failure status produced on drift). */
const EXPECTED_RUNTIME_ENV_GATE = 2;

describe('package.json metadata (AC-3)', () => {
  it('is unscoped, independently versioned, and MIT-licensed', () => {
    expect(pkg.name).toBe('figpea-mcp');
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBeUndefined();
  });

  it('versions independently of the contract, guarded at runtime by the envVersion gate (REQ-769, replacing the REQ-188 lockstep pin)', () => {
    // The package version is a well-formed semver triple, free to drift from
    // the contract's major.minor (currently contract 1.x vs package 2.0.x).
    expect(String(pkg.version)).toMatch(/^\d+\.\d+\.\d+$/);

    // The replacement for the hand-maintained lockstep pin is the RUNTIME
    // gate: assert it exists and is armed in the real fetch module — a
    // mismatched editor envelope must produce an explicit env_mismatch
    // failure status rather than silently relaying a stale contract.
    const fetchSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'contractFetch.ts'), 'utf8');
    const declaredGate = /export const EXPECTED_ENV_VERSION = (\d+)/.exec(fetchSource)?.[1];
    expect(declaredGate, 'contractFetch arms its envVersion gate with an explicit expected value').toBe(
      String(EXPECTED_RUNTIME_ENV_GATE),
    );
    expect(fetchSource).toContain("status: 'env_mismatch'");
    expect(fetchSource).toContain('envVersion !== EXPECTED_ENV_VERSION');
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
