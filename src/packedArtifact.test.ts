import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * REQ-088 AC-2/AC-4 — the *packed*, *installed* artifact must be exactly
 * what AC-2 announces, and must actually serve MCP over stdio (AC-4). Builds
 * fresh, packs into a scratch dir, installs the tarball into a clean temp
 * project (no access to this repo's own node_modules/source), then spawns
 * the installed bin.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');

let scratchDir: string;
let tarballPath: string;
let manifest: { files: Array<{ path: string }>; entryCount: number };
let installDir: string;

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' });

  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figpea-mcp-pack-'));
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', scratchDir],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  );
  const [entry] = JSON.parse(packOutput);
  manifest = entry;
  tarballPath = path.join(scratchDir, entry.filename);

  installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figpea-mcp-install-'));
  execFileSync('npm', ['init', '-y'], { cwd: installDir, stdio: 'pipe' });
  execFileSync('npm', ['install', tarballPath], { cwd: installDir, stdio: 'pipe' });
}, 60_000);

afterAll(() => {
  for (const dir of [scratchDir, installDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('npm pack manifest (AC-2)', () => {
  it('contains exactly dist/**, README.md, LICENSE, package.json — nothing from src/, tests, or node_modules', () => {
    const paths = manifest.files.map((f) => f.path).sort();
    for (const p of paths) {
      const isAllowed =
        p.startsWith('dist/') || p === 'README.md' || p === 'LICENSE' || p === 'package.json';
      expect(isAllowed, `unexpected packed file: ${p}`).toBe(true);
    }
    expect(paths).toContain('dist/cli.js');
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('package.json');
    expect(paths.some((p) => p.startsWith('src/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.test.'))).toBe(false);
  });

  it('preserves the shebang on the packed dist/cli.js', () => {
    const distCliInTarball = path.join(scratchDir, 'package', 'dist', 'cli.js');
    execFileSync('tar', ['-xzf', tarballPath, '-C', scratchDir]);
    const firstLine = fs.readFileSync(distCliInTarball, 'utf8').split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('npm publish --dry-run succeeds (no "private" refusal)', () => {
    const output = execFileSync('npm', ['publish', '--dry-run'], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
    expect(output).not.toMatch(/private/i);
    expect(output).toMatch(/figpea-mcp@0\.1\.0/);
  });
});

describe('installed tarball — stdio MCP handshake (AC-4)', () => {
  it('spawns the installed bin and completes initialize + tools/list over stdio', async () => {
    const binPath = path.join(installDir, 'node_modules', '.bin', 'figpea-mcp');
    expect(fs.existsSync(binPath)).toBe(true);

    const transport = new StdioClientTransport({ command: binPath, args: [] });
    const client = new Client({ name: 'req-088-packed-install-smoke', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['open_editor', 'status']);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 20_000);
});
