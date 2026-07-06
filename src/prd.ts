import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const StorySchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptance: z.array(z.string()),
  priority: z.number(),
  passes: z.boolean(),
  fixCount: z.number(),
  suspended: z.boolean().optional(),
});

export const PrdSchema = z.object({
  branchName: z.string(),
  stories: z.array(StorySchema),
});

export interface Story {
  id: string;
  title: string;
  acceptance: string[];
  priority: number;
  passes: boolean;
  fixCount: number;
  suspended?: boolean;
}

export interface Prd {
  branchName: string;
  stories: Story[];
}

export function readPrd(path: string): Prd {
  return JSON.parse(readFileSync(path, "utf-8")) as Prd;
}

export function writePrd(path: string, prd: Prd): void {
  writeFileSync(path, JSON.stringify(prd, null, 2));
}

export function selectNextStory(prd: Prd): Story | null {
  const candidates = prd.stories.filter((s) => !s.passes && !s.suspended);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => a.priority - b.priority)[0];
}

export function markStoryPassed(prd: Prd, storyId: string): Prd {
  return {
    ...prd,
    stories: prd.stories.map((s) => (s.id === storyId ? { ...s, passes: true } : s)),
  };
}

export function recordStoryFailure(prd: Prd, storyId: string, fixLimit: number): Prd {
  return {
    ...prd,
    stories: prd.stories.map((s) => {
      if (s.id !== storyId) return s;
      const fixCount = s.fixCount + 1;
      return { ...s, fixCount, suspended: fixCount > fixLimit };
    }),
  };
}
