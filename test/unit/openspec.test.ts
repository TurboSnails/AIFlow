import { test, expect } from "bun:test";
import { parseOpenSpec, lintOpenSpec } from "../../src/openspec/parser";

const sample = `---
spec_id: s1
version: 1
branch: feat/x
verify_all: ["echo ok"]
depends: []
---

# Design

<task id="T1" priority="1" files="lib/**">
## Title
Acceptance:
- [ ] a
- [ ] b
</task>
`;

test("parses OpenSpec frontmatter and tasks", () => {
  const result = parseOpenSpec(sample);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.spec.meta.spec_id).toBe("s1");
  expect(result.spec.tasks[0].id).toBe("T1");
  expect(result.spec.tasks[0].acceptance).toEqual(["a", "b"]);
});

test("lint requires unique task ids", () => {
  const dup = sample.replace('id="T1"', 'id="T1"') + '\n<task id="T1" priority="2">\nAcceptance:\n- [ ] c\n</task>';
  const parsed = parseOpenSpec(dup);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const errors = lintOpenSpec(parsed.spec);
  expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
});
