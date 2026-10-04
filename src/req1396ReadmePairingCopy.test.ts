import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * REQ-1396 AC-1 — `figpea-mcp/README.md` must not claim a mandatory manual
 * Connect click, and its guided-pairing walkthrough must reflect the flow the
 * editor actually ships.
 *
 * ## Why this is a separate guard file, and why it asserts absence as well as presence
 *
 * The defect AC-1 was filed for is a sentence that is *present* and *wrong*. A
 * test that only pinned the correct sentences would keep passing while any of the
 * false ones survived — and the false one is in the section a first-time reader
 * is most likely to read, and again in the headless-harness section that the
 * 2026-09-30 report's author followed. So every assertion here is a pair: the
 * claim that must be gone, and the fact that must be there instead.
 *
 * ## These assertions are written against the AC, not against a proposed wording
 *
 * They pin the *claims* (an unconditional dial; the browser's LNA permission is
 * what gates; a `failed` card offers a manual retry) and the *vocabulary of a
 * gate* that must not appear. A different wording, a different paragraph
 * structure or a different sentence order would pass exactly as the AC requires.
 */

const README = resolve(__dirname, "../README.md");
const readme = readFileSync(README, "utf8");

/**
 * AC-1's parenthetical — "granted → auto-connects; prompt/denied → manual Connect
 * remains" — describes no state that exists: `client.ts:646-666` dials
 * unconditionally in every state, and on a settled denial the Connect button is
 * removed outright because no click can clear a browser-level block. So the
 * AC-1 test asserts ABSENCE of the gate claim rather than that per-state table;
 * writing the table into the README would ship the very falsehood this
 * requirement exists to remove.
 */
/**
 * The body of one `## `/`### ` section, matched on its exact heading text.
 *
 * Needed because several of the assertions below are about a *region* of the
 * document rather than the document as a whole: a ban that is right for the
 * pairing prose is wrong for the call-timeout section, which legitimately
 * documents millisecond figures this REQ must not touch.
 */
function extractSections(md: string, headings: string[]): string[] {
  const lines = md.split("\n");
  const starts: number[] = [];
  lines.forEach((line, i) => {
    const m = /^#{2,3}\s+(.*)$/.exec(line);
    if (m && headings.includes(m[1].trim())) starts.push(i);
  });
  return starts.map((start) => {
    const level = /^#+/.exec(lines[start])![0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{2,3})\s+/.exec(lines[i]);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  });
}

/** The leading blockquote block that opens the README, matched by its first line. */
function extractHeadingBlock(md: string, firstLine: RegExp): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => firstLine.test(l));
  if (start === -1) return "";
  let end = start;
  while (end < lines.length && lines[end].startsWith(">")) end++;
  return lines.slice(start, end).join("\n");
}

const GATE_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
  { label: "an explicit Connect consent gate", pattern: /consent[- ]gate/i },
  { label: "clicking Connect as the step that attaches the session", pattern: /click(?:ing|s|ed)?\s+(?:the\s+)?\*{0,2}Connect\b/i },
  { label: "attaching the session safely on a click", pattern: /attaches? the session/i },
  { label: "the editor waiting for the reader to choose", pattern: /until you (?:choose|approve|allow|confirm)/i },
  { label: "the editor never auto-connecting", pattern: /never auto-connects?/i },
  { label: "nothing opening until the reader presses it", pattern: /nothing opens until you press/i },
  { label: "nothing connecting when the page loads", pattern: /nothing connects (?:when|until)/i },
  { label: "approving the connection as the user's act", pattern: /(?:you |the user )?(?:must )?approve the connection/i },
  { label: "the retired gate described as a security property", pattern: /protected against unauthorized bridge attachments/i },
];

describe("REQ-1396 AC-1 — figpea-mcp README describes the shipped pairing flow", () => {
  describe("the consent-gate claims are gone from every section", () => {
    for (const { label, pattern } of GATE_CLAIMS) {
      it(`never claims ${label}`, () => {
        expect(readme).not.toMatch(pattern);
      });
    }
  });

  it("the headless-harness step no longer tells a reader to click Connect", () => {
    // The second instance of the same falsehood, inside AC-1's own file. Fixing
    // only the Guided Pairing paragraph leaves a headless harness being told to
    // drive a control that is not what starts the connection — and this is the
    // exact instruction the 2026-09-30 report's author followed.
    expect(readme).not.toMatch(/programmatically click connect/i);
    expect(readme).not.toMatch(/\d\.\s*\**Programmatically click/i);
  });

  it("keeps the two strings the headless section is actually for", () => {
    // The section does not lose its reason for existing: a headless browser still
    // cannot answer an LNA prompt, so granting permission remains necessary. It
    // simply is not what *starts* the connection.
    expect(readme).toContain("Automated Browser & Agent Harness Pairing");
    expect(readme).toContain("Browser.grantPermissions");
    expect(readme).toContain("LocalNetworkAccessAllowedForUrls");
    expect(readme).toMatch(/Localhost exemption/i);
  });

  describe("the shipped flow is stated positively", () => {
    it("says the editor dials on its own, so nothing is waiting on a click", () => {
      // The positive half of AC-1. Phrased as a set of alternatives so this is a
      // claim about the meaning, not about one sentence: any honest phrasing of
      // "the dial happens by itself" satisfies it.
      const claimsUnconditional =
        /on its own|automatically|by itself|without (?:a )?(?:click|clicking|you)|starts? (?:the )?connect(?:ion|ing)/i;
      expect(readme).toMatch(claimsUnconditional);
    });

    it("names the browser's Local Network Access permission as what actually gates", () => {
      // The thing that does gate is the browser's own LNA permission — which is
      // why the headless section still exists.
      expect(readme).toMatch(/Local Network Access|permission/i);
    });

    it("describes what the in-app notice is for — it reports the phase, it is not a gate", () => {
      const describesNotice =
        /notice[^\n]{0,200}(?:report|names?|address|phase|status)|(?:report|names?|phase|status)[^\n]{0,200}notice/i;
      expect(readme).toMatch(describesNotice);
    });

    it("points at the manual control that does survive: `Try again` on a failed card", () => {
      // The only surviving manual control in the shipped product. A README that
      // removes the gate claim without saying what replaces it leaves the reader
      // with no idea what to do when a pairing genuinely fails.
      expect(readme).toMatch(/`?Try again`?/);
      expect(readme).toMatch(/fail(?:ed|ure|s)?[^\n]{0,200}Try again|Try again[^\n]{0,200}fail/i);
    });

    it("points at the `no_tab` payload's diagnosis instead of speculation", () => {
      expect(readme).toContain("no_tab");
      expect(readme).toContain("connection.lastEvent");
    });
  });

  describe("what this REQ must not touch", () => {
    it("keeps the loopback-bind security claim, which is about the bind and is true", () => {
      // Scoped exception to the ban on security framing: this sentence is about
      // `127.0.0.1` + IPv4-only, not about the retired gate. A blanket "strip
      // security claims" sweep would destroy a correct claim.
      expect(readme).toMatch(/it is a security property/i);
      expect(readme).toMatch(/loopback only, never a public interface/i);
    });

    it("keeps the Guided Pairing heading, the LNA explainer and the pairing URL prefix", () => {
      // Existing pins (readme.test.ts) and the site's mirror depend on these.
      expect(readme).toContain("Guided Pairing & Local Network Access (LNA)");
      expect(readme).toContain("https://editor.figpea.com/?agent=1&bridgePort=");
    });

    it("adds no latency or success-frequency claim to the pairing description", () => {
      // Scoped to the pairing SECTIONS on purpose. REQ-772's call-timeout section
      // legitimately documents `120000 ms` caps, and REQ-1301's security section
      // legitimately says "instant" about a DNS resolution — banning those
      // document-wide would force this REQ to delete correct documentation it
      // does not own. Scoping by heading (not by keyword) is what keeps the ban
      // on the prose this REQ actually writes.
      const pairingProse = [
        extractHeadingBlock(readme, /^>\s*\*\*Guided Pairing/),
        ...extractSections(readme, ["How pairing works", "Automated Browser & Agent Harness Pairing"]),
      ].join("\n\n");
      expect(pairingProse).toMatch(/pair|bridge|Local Network/i);
      // The two idiom bans are paired with a word that must actually be nearby,
      // so they cannot fire on an unrelated sense of the word — `"instant"` here is
      // REQ-1394's ISO-8601 `startedAt` glossary, and `"under Nms"` is a claim about
      // how long a pairing takes, not about a timeout cap.
      expect(pairingProse).not.toMatch(/\binstant(?:ly)?\b[^.\n]{0,60}\b(?:pair|connect|bridge|dial)/i);
      expect(pairingProse).not.toMatch(/\b(?:pair|connect|bridge|dial)[^.\n]{0,60}\binstant(?:ly)?\b/i);
      expect(pairingProse).not.toMatch(/\balways pairs?\b/i);
      expect(pairingProse).not.toMatch(/\bunder \d+\s*m?s\b/i);
      // No bare millisecond figure in the pairing prose either.
      expect(pairingProse).not.toMatch(/\b\d{3,4}\s*ms\b/);
    });

    it("never promises that pairing succeeds on its own", () => {
      // Automatic *retry* is real and bounded; automatic *success* is not. The
      // exhausted budget is a reachable state, so "retries until it connects" is
      // exactly the kind of promise that misleads.
      expect(readme).not.toMatch(/retries? until it connects?/i);
      expect(readme).not.toMatch(/will (?:always )?connect/i);
    });
  });

  it("the pairing prose contains no sentence telling the reader to press Connect", () => {
    // Scoped to the pairing regions rather than the whole document, because the
    // README legitimately instructs a reader to press Connect in a place this
    // requirement has nothing to do with — the editor's own "File → Connect to
    // Agent…" dialog, which is a real, correct manual action. A document-wide
    // sweep would have to delete that instruction to pass, which would make this
    // REQ worse.
    const pairingProse = [
      extractHeadingBlock(readme, /^>\s*\*\*Guided Pairing/),
      ...extractSections(readme, [
        "How pairing works",
        "Mid-session pairing — copy the connection string",
        "Diagnosing a connection",
        "Automated Browser & Agent Harness Pairing",
        "Troubleshooting",
      ]),
    ].join("\n\n");
    const offenders = pairingProse
      .split(/\n{2,}/)
      .flatMap((block) => block.split(/(?<=[.!?])\s+/))
      .filter((s) => /consent[- ]gate|click(?:ing|s|ed)?\s+(?:the\s+)?\*{0,2}connect\b|until you (?:choose|approve)/i.test(s));
    expect(offenders, `pairing sentences that still describe a gate:\n${offenders.join("\n---\n")}`).toHaveLength(0);
  });
});
