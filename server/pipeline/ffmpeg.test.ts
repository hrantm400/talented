import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateASS } from "./ffmpeg";

describe("generateASS (Subtitle Formatter)", () => {
  const dummyWords = [
    { word: "Hello", start: 0.1, end: 0.5 },
    { word: "world", start: 0.6, end: 1.0 },
    { word: "this", start: 1.1, end: 1.5 },
    { word: "is", start: 1.6, end: 2.0 },
    { word: "a", start: 2.1, end: 2.5 },
    { word: "test", start: 2.6, end: 3.0 },
  ];

  it("outputs valid ASS header structure", () => {
    const ass = generateASS(dummyWords, "capcut_green");
    assert.ok(ass.includes("[Script Info]"));
    assert.ok(ass.includes("[V4+ Styles]"));
    assert.ok(ass.includes("[Events]"));
  });

  it("uses the correct color codes from the style dictionary", () => {
    const ass = generateASS(dummyWords, "capcut_green");
    assert.ok(ass.includes("\\c&H0000FF00"));

    const assYellow = generateASS(dummyWords, "capcut_yellow");
    assert.ok(assYellow.includes("\\c&H0000FFFF"));
  });

  it("groups words and generates dialogue events", () => {
    const ass = generateASS(dummyWords, "neon_pop");
    const dialogueLines = ass
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));

    assert.ok(dialogueLines.length > 0);
    assert.ok(ass.includes("HELLO"));
  });

  it("handles an empty array of words", () => {
    const ass = generateASS([], "minimal_white");
    const dialogueLines = ass
      .split("\n")
      .filter((line) => line.startsWith("Dialogue:"));

    assert.ok(ass.includes("[Events]"));
    assert.equal(dialogueLines.length, 0);
  });
});
