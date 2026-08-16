import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { fetchContract, EXPECTED_ENV_VERSION } from './contractFetch';

describe('contractFetch — REQ-699 contract fetching & envelope check', () => {
  let server: http.Server;
  let serverPort: number;
  let serverResponseData: any;
  let requestCount = 0;

  beforeEach(async () => {
    requestCount = 0;
    serverResponseData = {
      surfaceVersion: '1.8.0',
      envVersion: EXPECTED_ENV_VERSION,
      manifest: {
        session: {
          status: { doc: 'Get session status', params: {}, result: {} }
        }
      },
      errorCodes: { not_found: 'Item not found' }
    };

    server = http.createServer((req, res) => {
      requestCount++;
      if (req.url === '/agent/contract.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(serverResponseData));
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

  it('successfully fetches, parses, and validates matching contract artifact', async () => {
    const origin = `http://127.0.0.1:${serverPort}`;
    const result = await fetchContract(origin);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.surfaceVersion).toBe('1.8.0');
      expect(result.manifest).toBeDefined();
    }
    expect(requestCount).toBe(1);
  });

  it('returns fetch_failed and never throws when network is down / 404 / connection refused', async () => {
    const badOrigin = 'http://127.0.0.1:1'; // nothing listening
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchContract(badOrigin);
    expect(result.status).toBe('fetch_failed');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns env_mismatch and logs diagnostic when envVersion does not match EXPECTED_ENV_VERSION', async () => {
    serverResponseData.envVersion = EXPECTED_ENV_VERSION + 99; // mismatch
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const origin = `http://127.0.0.1:${serverPort}`;
    const result = await fetchContract(origin);
    expect(result.status).toBe('env_mismatch');
    if (result.status === 'env_mismatch') {
      expect(result.fetched).toBe(EXPECTED_ENV_VERSION + 99);
      expect(result.expected).toBe(EXPECTED_ENV_VERSION);
    }
    expect(stderrSpy).toHaveBeenCalled();
  });
});
