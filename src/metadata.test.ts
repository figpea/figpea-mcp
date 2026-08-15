import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-088 AC-3 — package metadata is complete, correct, and points at the
 * standalone repo's permanent home; a LICENSE file with MIT text exists.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

describe('package.json metadata (AC-3)', () => {
  it('is unscoped, independently versioned, and MIT-licensed', () => {
    expect(pkg.name).toBe('figpea-mcp');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBeUndefined();
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
