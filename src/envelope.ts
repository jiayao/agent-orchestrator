// Streaming envelope parser.
// Agents emit envelopes inside stdout:
//   <<<TEAM_EVENT_V1\n{...json...}\nTEAM_EVENT_V1>>>
//   <<<TEAM_RESULT_V1\n{...json...}\nTEAM_RESULT_V1>>>
// The orchestrator tails stdout and extracts these as they arrive.
// Fallback chain when no RESULT envelope is present:
//   last fenced ```post block -> whole stdout flagged unstructured:true.
// Malformed output is never silently dropped.

export type EnvelopeKind = "TEAM_EVENT_V1" | "TEAM_RESULT_V1";

export interface ExtractedEnvelope {
  kind: EnvelopeKind;
  /** raw text between the markers */
  raw: string;
  /** parsed JSON, or null on parse failure */
  json: unknown | null;
  /** set when json parse failed */
  parse_error?: string;
}

const OPEN_RE = /<<<(TEAM_EVENT_V1|TEAM_RESULT_V1)[ \t]*\r?\n/;
const OPEN_G = new RegExp(OPEN_RE.source, "g");

/** Incremental parser: feed chunks of stdout; complete envelopes come back. */
export class EnvelopeStreamParser {
  private buf = "";

  /** Feed a chunk; returns any envelopes completed by it. */
  feed(chunk: string): ExtractedEnvelope[] {
    this.buf += chunk;
    const out: ExtractedEnvelope[] = [];
    for (;;) {
      const m = OPEN_RE.exec(this.buf);
      if (!m) break;
      const kind = m[1] as EnvelopeKind;
      const close = kind + ">>>";
      const contentStart = m.index + m[0].length;
      const end = this.buf.indexOf(close, contentStart);
      // Resync: while seeking the closer, a new valid opener may appear first —
      // the envelope under scan was truncated. Emit the dead partial as a
      // malformed record (the log still sees it) and resume at the new opener,
      // so a torn envelope can never swallow the ones after it.
      OPEN_G.lastIndex = contentStart;
      const nm = OPEN_G.exec(this.buf);
      if (nm && (end === -1 || nm.index < end)) {
        out.push({
          kind,
          raw: this.buf.slice(m.index, nm.index).trim(),
          json: null,
          parse_error: "unterminated envelope; resynchronized at next opener",
        });
        this.buf = this.buf.slice(nm.index);
        continue;
      }
      if (end === -1) {
        // incomplete envelope; keep everything from the opening marker
        if (m.index > 0) this.buf = this.buf.slice(m.index);
        break;
      }
      const raw = this.buf.slice(contentStart, end).trim();
      out.push(makeEnvelope(kind, raw));
      this.buf = this.buf.slice(end + close.length);
    }
    // cap buffer growth between markers is unnecessary: stdout is capped upstream
    return out;
  }

  /** Text still buffered (partial envelope or trailing output). */
  flushRemainder(): string {
    const s = this.buf;
    this.buf = "";
    return s;
  }
}

function makeEnvelope(kind: EnvelopeKind, raw: string): ExtractedEnvelope {
  try {
    return { kind, raw, json: JSON.parse(raw) };
  } catch (e) {
    return { kind, raw, json: null, parse_error: (e as Error).message };
  }
}

/** Non-streaming helper: extract all complete envelopes from a string. */
export function extractEnvelopes(text: string): ExtractedEnvelope[] {
  const p = new EnvelopeStreamParser();
  const envs = p.feed(text);
  p.flushRemainder();
  return envs;
}

/** Remove envelope blocks from text (for the whole-stdout fallback). */
export function stripEnvelopes(text: string): string {
  return text.replace(
    /<<<(TEAM_EVENT_V1|TEAM_RESULT_V1)[ \t]*\r?\n[\s\S]*?\1>>>/g,
    ""
  );
}

/** Last fenced ```post block, if any. */
export function lastFencedPost(text: string): string | null {
  const re = /```post[ \t]*\r?\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  return last === null ? null : last.trim();
}

export interface FallbackResult {
  body: string;
  extraction: "envelope" | "fenced_post" | "unstructured";
}

/**
 * Given raw stdout and whether a result envelope was already consumed,
 * decide the final body per the fallback chain.
 */
export function resolveFinalBody(stdout: string): FallbackResult {
  const fenced = lastFencedPost(stdout);
  if (fenced !== null && fenced.length > 0) {
    return { body: fenced, extraction: "fenced_post" };
  }
  const stripped = stripEnvelopes(stdout).trim();
  return { body: stripped.length ? stripped : stdout.trim(), extraction: "unstructured" };
}
