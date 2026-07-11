import { test, expect } from "bun:test";
import { parseOpenSpec } from "../../src/spec/parse";

test("parseOpenSpec extracts frontmatter, tasks and acceptance", () => {
  const md = `---\nspec_id: x\n---\n# Body\n\n<task id="T1" priority="1" files="a.ts">\nDesc\n- [ ] accept\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.frontmatter.spec_id).toBe("x");
  expect(parsed.tasks[0].id).toBe("T1");
  expect(parsed.tasks[0].acceptance).toEqual(["accept"]);
});

test("parseOpenSpec returns empty frontmatter when no YAML front matter present", () => {
  const md = `# Just a body\n\n<task id="T1" priority="2">\n- [ ] do it\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.frontmatter).toEqual({});
  expect(parsed.tasks).toHaveLength(1);
  expect(parsed.tasks[0].id).toBe("T1");
  expect(parsed.tasks[0].priority).toBe(2);
});

test("parseOpenSpec strips task blocks from body", () => {
  const md = `---\nspec_id: y\n---\n# Intro\n\n<task id="T1" priority="1">\n- [ ] check\n</task>\n\nFinal line`;
  const parsed = parseOpenSpec(md);
  expect(parsed.body).toContain("Intro");
  expect(parsed.body).not.toContain("<task");
  expect(parsed.body).toContain("Final line");
});

test("parseOpenSpec parses multiple tasks with files and depends", () => {
  const md = `---\nspec_id: z\n---\n<task id="T1" priority="1" files="a.ts,b.ts" depends="">\n- [ ] a1\n</task>\n<task id="T2" priority="2" files="c.ts" depends="T1">\n- [ ] a2\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.tasks).toHaveLength(2);
  expect(parsed.tasks[0].files).toEqual(["a.ts", "b.ts"]);
  expect(parsed.tasks[1].depends).toEqual(["T1"]);
});

test("parseOpenSpec collects acceptance checklist items", () => {
  const md = `---\nspec_id: w\n---\n<task id="T1" priority="1">\n- [ ] first item\n- [x] second item\n- [ ] third item\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.tasks[0].acceptance).toEqual(["first item", "second item", "third item"]);
});

test("parseOpenSpec returns empty acceptance when no checklist", () => {
  const md = `---\nspec_id: v\n---\n<task id="T1" priority="1">\nJust a description with no checklist.\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.tasks[0].acceptance).toEqual([]);
});

test("parseOpenSpec filters empty strings when depends=\"\" or files=\"\"", () => {
  const md = `---\nspec_id: u\n---\n<task id="T1" priority="1" depends="" files="">\n- [ ] check\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.tasks[0].depends).toEqual([]);
  expect(parsed.tasks[0].files).toEqual([]);
});
