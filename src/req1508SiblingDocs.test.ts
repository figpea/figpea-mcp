import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';

/**
 * REQ-1508 T3 — AC-3 text pins: the `figpea_call` tool description and
 * `figpea-mcp/README.md` both state that `returnAs` is a sibling of
 * group/method/args, and show the failing form.
 *
 * WHAT IS ASSERTED, AND WHERE FROM. The description is read out of a REAL
 * `tools/list` over the SDK's `InMemoryTransport`, never out of the zod shape
 * (the REQ-1282 lesson: the SDK serves the `meta` half, so a test against the
 * shape would pass while `tools/list` stayed silent). The README is read off
 * disk, scoped to its § *Off-band binary returns* section, so prose added
 * anywhere else does not satisfy the pin.
 */

const MANIFEST = {
  version: '1.8.0',
  export: {
    artboard: { doc: 'Exports an artboard as a raster image.', params: { id: { type: 'string', required: true } }, result: {} },
  },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function compactClient(): Promise<Client> {
  const server = createMcpServer(
    {
      port: 54321,
      token: 'test-token-abc',
      isTabConnected: () => true,
      onDescribe: (handler: any) => handler(MANIFEST),
      callTab: async () => ({ ok: true, value: null }),
      close: async () => {},
    } as any,
    { toolMode: 'compact' },
  );
  const client = new Client({ name: 'req-1508-sibling-docs', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The sibling-ness claim AC-3 demands, asserted on whichever surface carries it. */
function expectSiblingClaim(text: string, where: string): void {
  expect(text, `${where} carries the claim at all`).toBeTruthy();
  expect(text, `${where}: states returnAs is a sibling of group/method/args`).toMatch(/sibling of group\/method\/args/);
  expect(text, `${where}: says the key is never read from inside args`).toMatch(/never read from inside args/);
}

/** The failing form AC-3 demands be shown: returnAs nested inside args. */
function expectFailingForm(text: string, where: string): void {
  expect(text, `${where}: shows the failing nested form`).toMatch(/args:\[.*returnAs:"path"/);
}

describe('REQ-1508 AC-3: the figpea_call description states the sibling rule with the failing form', () => {
  it('from a real tools/list dump', async () => {
    const client = await compactClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call');
    expect(tool, 'figpea_call is registered in compact mode').toBeDefined();
    expectSiblingClaim(tool!.description ?? '', 'figpea_call description');
    expectFailingForm(tool!.description ?? '', 'figpea_call description');
  });
});

describe('REQ-1508 AC-3: README § Off-band binary returns states the same rule', () => {
  it('in the section the card scopes', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
    const sectionStart = readme.indexOf('### Off-band binary returns');
    expect(sectionStart, 'the Off-band binary returns section exists').toBeGreaterThanOrEqual(0);
    const nextSection = readme.indexOf('\n## ', sectionStart + 1);
    const section = nextSection < 0 ? readme.slice(sectionStart) : readme.slice(sectionStart, nextSection);
    expectSiblingClaim(section, 'README § Off-band binary returns');
    expect(section, 'README shows the position the refusal names').toContain('args[1].returnAs');
  });
});
