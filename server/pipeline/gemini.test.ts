import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { extractHighlights } from "./gemini";
import { db } from "../db";
import { db } from "../db";

const originalFetch = globalThis.fetch;

describe("extractHighlights (OpenRouter parsing)", () => {
  let originalDbSelect;
  before(() => {
    originalDbSelect = db.select;
    db.select = () => {
      const mockQueryBuilder = {
        from: () => mockQueryBuilder,
        where: () => mockQueryBuilder,
        limit: () => [{ defaultModelVideo: 'test-model', openrouterApiKey: 'test-key' }]
      };
      return mockQueryBuilder;
    };
  });
  after(() => {
    db.select = originalDbSelect;
  });
  before(() => {
    db.select = () => ({
      from: () => ({
        limit: () => [{ defaultModelVideo: 'test-model', openrouterApiKey: 'test-key' }],
        where: () => [{ defaultModelVideo: 'test-model', openrouterApiKey: 'test-key' }]
      })
    }) as any;
  });
  before(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const text = body.messages?.[0]?.content?.[0]?.text ?? "";

      let responseText: string;
      if (text.includes("BAD_JSON")) {
        responseText = "I found some highlights: [ { bad json";
      } else if (text.includes("EMPTY_ARRAY")) {
        responseText = "```json\n[]\n```";
      } else if (text.includes("NO_BRACKETS")) {
        responseText = "Here is the response without brackets.";
      } else {
        responseText =
          '[{"start": "00:00:10", "end": "00:00:30"}, {"start": "00:01:00", "end": "00:01:25"}]';
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responseText } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses valid JSON arrays from OpenRouter response", async () => {
    const highlights = await extractHighlights("fake.mp4", "GOOD_TRANSCRIPT", 120);
    assert.equal(Array.isArray(highlights), true);
    assert.equal(highlights.length, 2);
    assert.equal(highlights[0].start, "00:00:10");
  });

  it("returns a fallback 30s highlight for broken JSON", async () => {
    const highlights = await extractHighlights("fake.mp4", "BAD_JSON", 120);
    assert.equal(Array.isArray(highlights), true);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].start, "00:00:00");
    assert.equal(highlights[0].end, "00:00:30");
  });

  it("returns a fallback highlight for an empty array", async () => {
    const highlights = await extractHighlights("fake.mp4", "EMPTY_ARRAY", 120);
    assert.equal(Array.isArray(highlights), true);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].end, "00:00:30");
  });

  it("falls back gracefully when the response contains no brackets", async () => {
    const highlights = await extractHighlights("fake.mp4", "NO_BRACKETS", 120);
    assert.equal(Array.isArray(highlights), true);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].start, "00:00:00");
  });

  it("caps fallback end time to videoDuration for short videos", async () => {
    const highlights = await extractHighlights("fake.mp4", "BAD_JSON", 10);
    assert.equal(highlights[0].end, "00:00:10");
  });
});
