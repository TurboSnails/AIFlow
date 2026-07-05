import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Prd } from "../../src/prd";

function samplePrd(): Prd {
  return {
    branchName: "feat/us-1",
    stories: [
      { id: "US-1", title: "First", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 },
      { id: "US-2", title: "Second", acceptance: ["b"], priority: 2, passes: false, fixCount: 0 },
    ],
  };
}

test("writePrd then readPrd round-trips exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-prd-test-"));
  try {
    const path = join(dir, "prd.json");
    const prd = samplePrd();
    writePrd(path, prd);
    expect(readPrd(path)).toEqual(prd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectNextStory returns the lowest-priority story where passes is false and not suspended", () => {
  const prd = samplePrd();
  const next = selectNextStory(prd);
  expect(next?.id).toBe("US-1");
});

test("selectNextStory skips suspended stories", () => {
  const prd = samplePrd();
  prd.stories[0].suspended = true;
  const next = selectNextStory(prd);
  expect(next?.id).toBe("US-2");
});

test("selectNextStory returns null when all stories pass or are suspended", () => {
  const prd = samplePrd();
  prd.stories[0].passes = true;
  prd.stories[1].suspended = true;
  expect(selectNextStory(prd)).toBeNull();
});

test("markStoryPassed sets passes=true for the matching story only", () => {
  const prd = samplePrd();
  const updated = markStoryPassed(prd, "US-1");
  expect(updated.stories.find((s) => s.id === "US-1")?.passes).toBe(true);
  expect(updated.stories.find((s) => s.id === "US-2")?.passes).toBe(false);
});

test("recordStoryFailure increments fixCount and does not suspend below the limit", () => {
  const prd = samplePrd();
  const updated = recordStoryFailure(prd, "US-1", 3);
  const story = updated.stories.find((s) => s.id === "US-1")!;
  expect(story.fixCount).toBe(1);
  expect(story.suspended).toBeFalsy();
});

test("recordStoryFailure suspends the story once fixCount exceeds the limit", () => {
  let prd = samplePrd();
  prd.stories[0].fixCount = 3;
  prd = recordStoryFailure(prd, "US-1", 3);
  const story = prd.stories.find((s) => s.id === "US-1")!;
  expect(story.fixCount).toBe(4);
  expect(story.suspended).toBe(true);
});
