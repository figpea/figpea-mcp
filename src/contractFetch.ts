/**
 * REQ-699: Fetches the static contract artifact from the editor origin at startup.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export const EXPECTED_ENV_VERSION = 2;

export interface ContractArtifactLike {
  surfaceVersion?: string;
  envVersion?: number;
  manifest?: unknown;
  errorCodes?: unknown;
}

export type FetchContractResult =
  | { status: 'ok'; surfaceVersion: string; manifest: unknown; errorCodes: unknown }
  | { status: 'fetch_failed' }
  | { status: 'env_mismatch'; fetched: number; expected: number };

export async function fetchContract(editorBaseUrl: string, timeoutMs = 5000): Promise<FetchContractResult> {
  const url = new URL('/agent/contract.json', editorBaseUrl).toString();
  const lib = url.startsWith('https') ? https : http;

  try {
    const rawData = await new Promise<string>((resolve, reject) => {
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP status ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });

    const parsed = JSON.parse(rawData) as ContractArtifactLike;
    if (!parsed || typeof parsed !== 'object') {
      console.error(`[figpea-mcp] contract fetch parse error: invalid JSON at ${url}`);
      return { status: 'fetch_failed' };
    }

    const envVersion = typeof parsed.envVersion === 'number' ? parsed.envVersion : 1;
    if (envVersion !== EXPECTED_ENV_VERSION) {
      console.error(
        `[figpea-mcp] ERROR: contract envVersion mismatch. Fetched envVersion=${envVersion}, but package speaks expected envVersion=${EXPECTED_ENV_VERSION}. Required action: update figpea-mcp package to a version compatible with envelope version ${envVersion}.`
      );
      return { status: 'env_mismatch', fetched: envVersion, expected: EXPECTED_ENV_VERSION };
    }

    const surfaceVersion = typeof parsed.surfaceVersion === 'string' ? parsed.surfaceVersion : 'unknown';
    const manifest = parsed.manifest ?? {};
    const errorCodes = parsed.errorCodes ?? {};

    return { status: 'ok', surfaceVersion, manifest, errorCodes };
  } catch (err) {
    console.error(`[figpea-mcp] contract fetch failed from ${url}:`, err instanceof Error ? err.message : String(err));
    return { status: 'fetch_failed' };
  }
}
