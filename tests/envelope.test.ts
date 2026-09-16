import { describe, expect, test } from "bun:test";
import {
  EnvelopeStreamParser,
  extractEnvelopes,
  lastFencedPost,
  resolveFinalBody,
  stripEnvelopes,
} from "../src/envelope.ts";

describe("envelope parsing", () => {
  test("parses valid TEAM_RESULT_V1 and TEAM_EVENT_V1 envelopes", () => {
    const text = [
      "some preamble noise",
      "<<<TEAM_EVENT_V1",
      '{"type":"issue","body":"weak assumption"}',
      "TEAM_EVENT_V1>>>",
      "interstitial",
      "<<<TEAM_RESULT_V1",
      '{"type":"critique","summary":"three weak points","claims":["a","b"]}',
      "TEAM_RESULT_V1>>>",
      "trailing noise",
    ].join("\n");
    const envs = extractEnvelopes(text);
    expect(envs).toHaveLength(2);
    expect(envs[0].kind).toBe("TEAM_EVENT_V1");
    expect((envs[0].json as Record<string, unknown>).body).toBe("weak assumption");
    expect(envs[1].kind).toBe("TEAM_RESULT_V1");
    expect((envs[1].json as Record<string, unknown>).summary).toBe("three weak points");
    expect(envs.every((e) => e.json !== null)).toBe(true);
  });

  test("envelope split across stream chunks still parses", () => {
    const p = new EnvelopeStreamParser();
    expect(p.feed("noise <<<TEAM_RESULT_V1\n{\"summary\":\"sp")).toHaveLength(0);
    const out = p.feed('lit across"}\nTEAM_RESULT_V1>>> tail');
    expect(out).toHaveLength(1);
    expect((out[0].json as Record<string, unknown>).summary).toBe("split across");
  });

  test("malformed JSON inside an envelope is captured, not thrown", () => {
    const envs = extractEnvelopes("<<<TEAM_RESULT_V1\n{not json}\nTEAM_RESULT_V1>>>");
    expect(envs).toHaveLength(1);
    expect(envs[0].json).toBeNull();
    expect(envs[0].parse_error).toBeTruthy();
    expect(envs[0].raw).toContain("not json");
  });

  test("incomplete envelope is held in the remainder", () => {
    const p = new EnvelopeStreamParser();
    expect(p.feed("before <<<TEAM_EVENT_V1\n{\"type\":\"x\"")).toHaveLength(0);
    const rem = p.flushRemainder();
    expect(rem).toContain("<<<TEAM_EVENT_V1");
  });
});

describe("fallback chain", () => {
  test("falls back to the last fenced ```post block", () => {
    const stdout = [
      "thinking out loud",
      "```post",
      "first draft",
      "```",
      "more noise",
      "```post",
      "final answer body",
      "```",
    ].join("\n");
    const fb = resolveFinalBody(stdout);
    expect(fb.extraction).toBe("fenced_post");
    expect(fb.body).toBe("final answer body");
    expect(lastFencedPost(stdout)).toBe("final answer body");
  });

  test("garbage stdout is kept and flagged unstructured, never dropped", () => {
    const garbage = "total garbage\nnot an envelope, not a fence \x00 binary-ish";
    const fb = resolveFinalBody(garbage);
    expect(fb.extraction).toBe("unstructured");
    expect(fb.body).toBe(garbage.trim());
  });

  test("envelopes are stripped before the unstructured fallback", () => {
    const stdout =
      "hello\n<<<TEAM_EVENT_V1\n{\"type\":\"note\",\"body\":\"x\"}\nTEAM_EVENT_V1>>>\nworld";
    const fb = resolveFinalBody(stdout);
    expect(fb.extraction).toBe("unstructured");
    expect(fb.body).toBe("hello\n\nworld");
    expect(stripEnvelopes(stdout)).not.toContain("TEAM_EVENT_V1");
  });

  test("stdout that is only envelopes resolves to the raw text", () => {
    const stdout = "<<<TEAM_RESULT_V1\n{bad\nTEAM_RESULT_V1>>>";
    const fb = resolveFinalBody(stdout);
    expect(fb.extraction).toBe("unstructured");
    expect(fb.body).toBe(stdout.trim());
  });
});
