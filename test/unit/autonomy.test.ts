import { test, expect } from "bun:test";
import { shouldPause } from "../../src/policy/autonomy";

test("full autonomy skips after_brainstorm when no open questions", () => {
  expect(shouldPause("full", "after_brainstorm", { open_questions_count: 0 })).toBe("proceed");
});

test("full autonomy pauses on unresolved questions", () => {
  expect(shouldPause("full", "unresolved_questions", { open_questions_count: 1 })).toBe("pause");
});

test("main_dev_decides exempts unresolved questions", () => {
  expect(shouldPause("full", "unresolved_questions", { open_questions_count: 1, on_unresolved: "main_dev_decides" })).toBe("proceed");
});
