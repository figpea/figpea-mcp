/**
 * REQ-705: Fetches the static skill artifact (/agent/skill.md) from the
 * editor origin at startup. Mirrors contractFetch.ts's http/https handling
 * almost exactly, but returns text, not JSON -- no `envVersion` check is
 * needed, since a markdown skill body carries no wire-protocol shape.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

/** `url` is the URL the body was actually read from -- the resolved
 * `/agent/skill.md` URL, reported rather than re-derived by the caller so the
 * provenance the figpea_skill answer prints can never disagree with where the fetch
 * really went (the 2026-10-01 design run paired a local tab against a process
 * started on the production origin, and the answer named neither). */
export type FetchSkillResult = { status: 'ok'; body: string; url: string } | { status: 'fetch_failed' };

export async function fetchSkill(editorBaseUrl: string, timeoutMs = 5000): Promise<FetchSkillResult> {
  const url = new URL('/agent/skill.md', editorBaseUrl).toString();
  const lib = url.startsWith('https') ? https : http;

  try {
    const body = await new Promise<string>((resolve, reject) => {
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

    return { status: 'ok', body, url };
  } catch (err) {
    console.error(`[figpea-mcp] skill fetch failed from ${url}:`, err instanceof Error ? err.message : String(err));
    return { status: 'fetch_failed' };
  }
}
