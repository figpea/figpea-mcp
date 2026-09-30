import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1283 — a `filePath` handed to `session.openFile` loses its extension, and
 * the editor then blames corruption.
 *
 * The incident: an agent writes a perfectly valid `.fp`, then calls
 * `session_openFile({ input: { filePath: '/abs/…/design.fp', name: 'design' } })`
 * — a `name` with no extension, which the descriptor explicitly allows
 * ("Accepts 'name' as an alias for 'fileName'"). The relay translates the path
 * into `http://localhost:<port>/file?path=%2Fabs%2F…%2Fdesign.fp`, where the
 * extension survives only as a **query parameter**, and the URL's own path is
 * the constant `/file`. It also defaults `fileName` to `path.basename(filePath)`
 * — but *only when the caller supplied neither `fileName` nor `name`*. Supply
 * `name` and the default is skipped, `name` is forwarded verbatim, and the
 * editor is handed `file.name === 'design'`. No decoder's extension check
 * matches, so v3 walks into the zip-contents branch of `performOpen`, finds no
 * decoder that claims `main.fpe`/`repo.json`, and answers
 * `open_failed` / "file may be corrupt, unsupported, or empty" about a file
 * that is not corrupt at all. (The editor-side half of that sentence — the
 * actionable `open_failed` message — is REQ-1283's v3 worktree, pinned by
 * `v3/src/tests/unit/agent/req-1283-open-failed-message.test.ts` and the
 * `req-1283-openfile-extension-message.spec.ts` e2e.)
 *
 * Vehicle: this package has no Playwright lane, so the end-to-end vehicle is a
 * real MCP SDK `Client` over `InMemoryTransport` driving the real server, with
 * a stub tab standing in for the paired editor. The **relayed positional
 * args** are the observable — the exact object the editor's `session.openFile`
 * would receive — which is the thing every AC here is about. Real
 * `startBridgeServer` supplies `getFileUrl`, so the URL asserted on is the
 * product's own string (the REQ-1301 lesson from `req1017FileTranslation`).
 *
 * Both relay sites are exercised: the compact `figpea_call` dispatcher
 * (`mcpServer.ts:812`) and full mode's generated `session_openFile` tool
 * (`mcpServer.ts:1333`). `resolveToolMode` defaults to `'compact'`
 * (`cli.ts:79`), so a fix on the full-mode site alone would leave the *default*
 * path broken — and every row below is therefore asserted in **both** modes.
 *
 * AC map (see `docs/plans/REQ-1283-6ab85e83.md` §Use cases → task → test):
 *  - AC-1  the repro: a dotless caller `name` must not strip the extension
 *  - AC-2  the fix: the relayed input carries the extension from the path
 *  - AC-3  regression guard: with no `name` at all the relayed name is
 *          `path.basename(filePath)` — already correct on arrival, and pinned
 *          so it stays correct
 *  - AC-5  a `url`-only open is relayed verbatim; no `fileName` is injected
 *  - AC-7  the whole translation table, as behaviour, in both modes
 *
 * RED on the unfixed worktree: the AC-1 and rule-3 rows fail because the
 * relayed input's effective name (`fileName ?? name`, the exact precedence
 * `v3/src/facade/session/session.impl.ts:273` applies) has no extension, so
 * the editor cannot select a decoder. The AC-3 and AC-5 rows pass on arrival —
 * they guard behaviour that already works, which is why they are recorded as
 * green rather than hunted for a defect.
 */

type Mode = 'compact' | 'full';

/** The real `session.openFile` input shape (v3 `session.descriptor.ts:33-45`).
 *  Every key the tests send must be declared here: full mode's zod parse drops
 *  an undeclared key before the handler ever sees it, and `unknownParams` then
 *  reports it, so a shape missing `name`/`fileName` would test nothing. */
const MANIFEST = {
  session: {
    openFile: {
      doc: 'Opens a design file into the active session. Accepts name as an alias for fileName.',
      params: {
        input: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
            filePath: { type: 'string', required: false },
            type: { type: 'string', required: false },
            fileName: { type: 'string', required: false },
            name: { type: 'string', required: false },
          },
        },
      },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

let cleanup: Array<() => Promise<void>> = [];
let tempDirs: string[] = [];

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

/** A real file on disk — the relay stats it before translating, so a synthetic
 *  path would be rejected with `file not found or not readable` and nothing
 *  about the extension would be exercised. */
function realFile(fileName: string, content = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1283-mcp-'));
  tempDirs.push(dir);
  const fp = path.join(dir, fileName);
  fs.writeFileSync(fp, content);
  return fp;
}

interface Relay {
  /** The exact object the editor's `openFile(input)` would receive. */
  input: Record<string, unknown> | undefined;
  /** `callTab(group, method, args)` — the group/method pair, to prove the call
   *  reached the tab at all (a relay that never fires is not a pass). */
  group: string;
  method: string;
}

async function relayOpenFile(
  input: Record<string, unknown>,
  mode: Mode,
): Promise<{ relay: Relay; envelope: any }> {
  const realBridge: any = await startBridgeServer({ port: 0 });
  let captured: Relay | undefined;
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => h(MANIFEST),
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured = { input: args[0] as Record<string, unknown>, group, method };
      return { ok: true, value: undefined };
    },
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
  };
  const server = createMcpServer(stub as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req-1283-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });

  const result: any = await client.callTool(
    mode === 'full'
      ? ({ name: 'session_openFile', arguments: { input } } as never)
      : ({ name: 'figpea_call', arguments: { group: 'session', method: 'openFile', args: [input] } } as never),
  );
  const block = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text');
  const text = block?.text ?? '';
  const envelope = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : { ok: false, code: 'non_envelope', message: text };
  return { relay: captured as Relay, envelope };
}

/** The name v3 will actually read: `session.impl.ts:273` is
 *  `obj.fileName ?? obj.name ?? 'unnamed'`, so a relay that sets `fileName`
 *  while forwarding the caller's `name` verbatim is correct — and a relay that
 *  sets neither is not. Asserting on this one expression is what makes these
 *  tests about the editor's view rather than about one particular key. */
function effectiveName(input: Record<string, unknown> | undefined): string {
  const fileName = input?.fileName;
  if (typeof fileName === 'string' && fileName) return fileName;
  const name = input?.name;
  if (typeof name === 'string' && name) return name;
  return 'unnamed';
}

const MODES: Mode[] = ['compact', 'full'];

function forEachMode(run: (mode: Mode) => void): void {
  for (const mode of MODES) run(mode);
}

// ─────────────────────────────────────────────────── AC-1 — the repro ──

describe('REQ-1283 AC-1 — a caller `name` without an extension must not strip the extension', () => {
  it('relays an input whose effective name carries the file path’s extension (both modes)', async () => {
    for (const mode of MODES) {
      const fp = realFile('design.fp', '{"k":"v"}');
      const { relay } = await relayOpenFile({ filePath: fp, name: 'design' }, mode);
      expect(relay, `[${mode}] the tab received the call`).toBeDefined();
      expect(relay!.group).toBe('session');
      expect(relay!.method).toBe('openFile');
      // The editor keys decoder selection off the name it receives; without
      // the extension no decoder can be selected, and the editor reports a
      // valid `.fp` as "may be corrupt, unsupported, or empty".
      expect(effectiveName(relay!.input), `[${mode}] effective relayed name`).toBe('design.fp');
      // The path is still translated, and stripped from the relayed input.
      expect(relay!.input!.url as string).toMatch(/^http:\/\/localhost:\d+\/file\?path=/);
      expect(relay!.input!.filePath, `[${mode}] filePath stripped before relay`).toBeUndefined();
    }
  });
});

// ───────────────────────────────── AC-2 / AC-7 — the translation table ──

/**
 * AC-7's table, as behaviour and not as a copy of the implementation: each row
 * is a real file on disk plus a real relay round trip, and the expectation is
 * the name the *editor* will read. Rows are named for the rule they pin.
 */
interface RuleRow {
  rule: string;
  /** The file actually created on disk (its name IS the input path). */
  onDisk: string;
  /** What the caller passes besides `filePath`. */
  caller: Record<string, unknown>;
  /** The name v3's `fileName ?? name` will resolve to. */
  expectEffectiveName: string;
  /** The relay must not have added its own `fileName` key at all. */
  expectNoInjectedFileName?: boolean;
  why: string;
}

const RULE_ROWS: RuleRow[] = [
  {
    rule: '3 — caller name has no extension, path does: keep the stem, restore the extension',
    onDisk: 'design.fp',
    caller: { name: 'design' },
    expectEffectiveName: 'design.fp',
    why: 'the defect: this is AC-1/AC-2, and it is the row that is RED before the fix',
  },
  {
    rule: '3 — the same rule through the `fileName` alias',
    onDisk: 'hero.psd',
    caller: { fileName: 'hero' },
    expectEffectiveName: 'hero.psd',
    why: '`fileName` is the documented alias and the key v3 reads first',
  },
  {
    rule: '3 — a multi-dot filename loses only its final extension, never its stem',
    onDisk: 'checkpoint-01.fp',
    caller: { name: 'checkpoint' },
    expectEffectiveName: 'checkpoint.fp',
    why: 'the extension is copied from the filesystem, not re-derived from a table',
  },
  {
    rule: '2 — a caller name ending in `.something` is left alone even when the path disagrees',
    onDisk: 'checkpoint-01.backup.fp',
    caller: { name: 'checkpoint-01.backup' },
    expectEffectiveName: 'checkpoint-01.backup',
    expectNoInjectedFileName: true,
    why: 'the caller’s trailing `.backup` IS an extension by the same `lastIndexOf(".") > 0` rule, and an explicit signal outranks a derived one — the card puts the precedence order itself out of scope',
  },
  {
    rule: '4 — a multi-dot filename with no caller name keeps every dot but the last',
    onDisk: 'checkpoint-01.backup.fp',
    caller: {},
    expectEffectiveName: 'checkpoint-01.backup.fp',
    why: 'rule 4 returns the basename unchanged, so the earlier dot is part of the stem',
  },
  {
    rule: '2 — a caller name that already carries an extension is left alone (explicit signal wins)',
    onDisk: 'design.fp',
    caller: { name: 'design.psd' },
    expectEffectiveName: 'design.psd',
    expectNoInjectedFileName: true,
    why: 'the card puts the precedence order out of scope: a caller who names the file `.psd` gets `.psd`',
  },
  {
    rule: '2 — the same through the `fileName` alias',
    onDisk: 'design.fp',
    caller: { fileName: 'other.jpg' },
    expectEffectiveName: 'other.jpg',
    why: 'an explicit `fileName` is never overwritten by a derived one — the name itself is the assertion here, since the key is the caller’s',
  },
  {
    rule: '1 — a path with no extension never has one invented for it',
    onDisk: 'design',
    caller: { name: 'design' },
    expectEffectiveName: 'design',
    expectNoInjectedFileName: true,
    why: 'this is what keeps AC-5’s sniffing case untouched: no extension to preserve, none added',
  },
  {
    rule: '1 — a dotfile path carries no extension either',
    onDisk: '.hidden',
    caller: { name: '.config' },
    expectEffectiveName: '.config',
    expectNoInjectedFileName: true,
    why: 'a leading dot is not an extension, so neither side can smuggle a fake one past the other',
  },
  {
    rule: '3 — a leading-dot caller name is a stem, not an extension',
    onDisk: 'design.fp',
    caller: { name: '.design' },
    expectEffectiveName: '.design.fp',
    why: '`lastIndexOf(".") > 0`, the same guard v3’s own `ensureFileNameExtension` uses',
  },
  {
    rule: '4 — no caller name at all: today’s basename default, byte-for-byte',
    onDisk: 'checkpoint-01.fp',
    caller: {},
    expectEffectiveName: 'checkpoint-01.fp',
    why: 'AC-3 — already correct on mainline; pinned so the fix cannot regress it',
  },
  {
    rule: '4 — no caller name and a dotless path: basename unchanged',
    onDisk: 'design',
    caller: {},
    expectEffectiveName: 'design',
    why: 'AC-3/AC-5 for a genuinely extensionless file',
  },
];

describe('REQ-1283 AC-2 / AC-7 — the filePath→relayed-name translation table (both modes)', () => {
  for (const row of RULE_ROWS) {
    for (const mode of MODES) {
      it(`[${mode}] rule ${row.rule} — ${row.why}`, async () => {
        const fp = realFile(row.onDisk);
        const { relay, envelope } = await relayOpenFile({ filePath: fp, ...row.caller }, mode);
        expect(envelope.ok, `[${mode}] the relay succeeded`).toBe(true);
        expect(relay, `[${mode}] the tab received the call`).toBeDefined();
        expect(effectiveName(relay!.input), `[${mode}] effective relayed name`).toBe(row.expectEffectiveName);
        if (row.expectNoInjectedFileName) {
          expect(
            Object.prototype.hasOwnProperty.call(relay!.input ?? {}, 'fileName'),
            `[${mode}] no fileName was injected`,
          ).toBe(false);
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────── AC-5 — url opens ──

describe('REQ-1283 AC-5 — remote url opens are relayed verbatim', () => {
  const URL_CASES: Array<{ label: string; url: string }> = [
    { label: 'a url whose path carries an extension', url: 'https://cdn.example.com/assets/design.fp' },
    { label: 'a url whose path has no extension at all', url: 'https://cdn.example.com/assets/design' },
    { label: 'a url that ends in a slash', url: 'https://cdn.example.com/assets/' },
  ];

  for (const { label, url } of URL_CASES) {
    for (const mode of MODES) {
      it(`[${mode}] ${label}: unchanged, and no fileName is injected`, async () => {
        const { relay, envelope } = await relayOpenFile({ url }, mode);
        expect(envelope.ok, `[${mode}] the relay succeeded`).toBe(true);
        expect(relay!.input, `[${mode}] the tab received the call`).toBeDefined();
        expect(relay!.input!.url, `[${mode}] url untouched`).toBe(url);
        expect(
          Object.prototype.hasOwnProperty.call(relay!.input!, 'fileName'),
          `[${mode}] no fileName invented for a remote url`,
        ).toBe(false);
        expect(relay!.input!.filePath, `[${mode}] no filePath invented`).toBeUndefined();
        expect(effectiveName(relay!.input), `[${mode}] no name invented`).toBe('unnamed');
      });
    }
  }

  it('a url open carrying a dotless name is also relayed verbatim (the two do not interact)', async () => {
    for (const mode of MODES) {
      const { relay } = await relayOpenFile({ url: 'https://cdn.example.com/assets/design', name: 'design' }, mode);
      expect(relay!.input!.name, `[${mode}] the caller’s name is preserved`).toBe('design');
      expect(
        Object.prototype.hasOwnProperty.call(relay!.input!, 'fileName'),
        `[${mode}] no fileName invented for a remote url`,
      ).toBe(false);
    }
  });
});
