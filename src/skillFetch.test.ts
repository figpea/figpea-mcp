import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { fetchSkill } from './skillFetch';

/**
 * REQ-705 T5 — unit tests for the not-yet-existing `src/skillFetch.ts`
 * module (docs/plans/REQ-705.md Tasks T5/T6, Tech design §E). Mirrors
 * `contractFetch.test.ts`'s real-local-`http.createServer`-fixture
 * conventions exactly (route on `/agent/skill.md` instead of
 * `/agent/contract.json`; no `envVersion` check needed -- a markdown skill
 * body carries no wire-protocol shape, so there's no `env_mismatch` analog).
 *
 * RED today (unmodified worktree): `./skillFetch` does not exist yet.
 */
describe('skillFetch — REQ-705 skill.md fetching', () => {
  let server: http.Server;
  let serverPort: number;
  let serverBody: string;
  let requestCount = 0;

  beforeEach(async () => {
    requestCount = 0;
    serverBody = '# Figpea Agent Skill\n\nSome reference body.\n';

    server = http.createServer((req, res) => {
      requestCount++;
      if (req.url === '/agent/skill.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(serverBody);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as import('node:net').AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('successfully fetches and returns the skill body as text', async () => {
    const origin = `http://127.0.0.1:${serverPort}`;
    const result = await fetchSkill(origin);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.body).toBe(serverBody);
    }
    expect(requestCount).toBe(1);
  });

  it('returns fetch_failed and logs a distinct stderr diagnostic when network is down / connection refused, never throws', async () => {
    const badOrigin = 'http://127.0.0.1:1'; // nothing listening
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let threw = false;
    let result: Awaited<ReturnType<typeof fetchSkill>> | undefined;
    try {
      result = await fetchSkill(badOrigin);
    } catch {
      threw = true;
    }

    expect(threw, 'fetchSkill must never throw').toBe(false);
    expect(result!.status).toBe('fetch_failed');
    expect(stderrSpy, 'a distinct stderr diagnostic is logged on failure').toHaveBeenCalled();
  });

  it('returns fetch_failed on a non-200 response (e.g. 500) from a real /agent/skill.md route', async () => {
    const errorServer = http.createServer((req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await new Promise<void>((resolve) => errorServer.listen(0, '127.0.0.1', () => resolve()));
    const errorPort = (errorServer.address() as import('node:net').AddressInfo).port;
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await fetchSkill(`http://127.0.0.1:${errorPort}`);
      expect(result.status).toBe('fetch_failed');
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });
});
