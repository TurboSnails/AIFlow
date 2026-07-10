import { parse as parseYaml } from "yaml";
import { OpenSpecMetaSchema, OpenSpecTaskSchema, type OpenSpec, type OpenSpecTask } from "./schema";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const TASK_RE = /<task\s+([^>]+)>([\s\S]*?)<\/task>/g;

function parseTaskAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function extractAcceptance(body: string): string[] {
  const match = body.match(/(?:Acceptance|验收):\s*\n((?:- \[ \] .*\n?)+)/);
  if (!match) return [];
  return match[1].split("\n").map((l) => l.replace(/^- \[ \] /, "").trim()).filter(Boolean);
}

function extractTitle(body: string): string {
  const m = body.match(/^##\s+(.*)$/m);
  return m ? m[1].trim() : "";
}

export function parseOpenSpec(text: string): { success: true; spec: OpenSpec } | { success: false; error: string } {
  const fmMatch = text.match(FRONTMATTER_RE);
  if (!fmMatch) return { success: false, error: "missing frontmatter" };
  const metaRaw = parseYaml(fmMatch[1]);
  const metaParsed = OpenSpecMetaSchema.safeParse(metaRaw);
  if (!metaParsed.success) return { success: false, error: metaParsed.error.message };
  const body = text.slice(fmMatch[0].length);
  const tasks: OpenSpecTask[] = [];
  let m: RegExpExecArray | null;
  while ((m = TASK_RE.exec(body)) !== null) {
    const attrs = parseTaskAttrs(m[1]);
    const taskBody = m[2].trim();
    const taskParsed = OpenSpecTaskSchema.safeParse({
      id: attrs.id,
      priority: Number(attrs.priority ?? 0),
      depends: attrs.depends ? attrs.depends.split(",").map((s) => s.trim()) : [],
      files: attrs.files ? attrs.files.split(",").map((s) => s.trim()) : [],
      title: extractTitle(taskBody),
      acceptance: extractAcceptance(taskBody),
      body: taskBody,
    });
    if (!taskParsed.success) return { success: false, error: taskParsed.error.message };
    tasks.push(taskParsed.data);
  }
  const spec: OpenSpec = { meta: metaParsed.data, body, tasks };
  return { success: true, spec };
}

export function lintOpenSpec(spec: OpenSpec): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of spec.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (t.acceptance.length === 0) errors.push(`task ${t.id} missing acceptance`);
  }
  return errors;
}
