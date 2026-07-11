import { parse as parseYaml } from "yaml";

export interface TaskBlock {
  id: string;
  priority: number;
  files?: string[];
  depends?: string[];
  acceptance: string[];
  body: string;
}

export interface OpenSpec {
  frontmatter: Record<string, unknown>;
  body: string;
  tasks: TaskBlock[];
}

export function parseOpenSpec(md: string): OpenSpec {
  const frontMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = frontMatch ? parseYaml(frontMatch[1]) : {};
  const afterFront = frontMatch ? md.slice(frontMatch[0].length) : md;
  const body = afterFront.replace(/<task\s+([^>]+)>([\s\S]*?)<\/task>/g, "");
  const tasks: TaskBlock[] = [];
  const taskRe = /<task\s+([^>]+)>([\s\S]*?)<\/task>/g;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(afterFront)) !== null) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const rawBody = m[2].trim();
    const acceptance = [...rawBody.matchAll(/^-\s+\[[x? ]?\]\s*(.+)$/gm)].map((x) => x[1].trim());
    tasks.push({
      id: attrs.id,
      priority: Number(attrs.priority ?? 1),
      files: attrs.files?.split(",").map((s) => s.trim()),
      depends: attrs.depends?.split(",").map((s) => s.trim()),
      acceptance,
      body: rawBody,
    });
  }
  return { frontmatter, body: body.trim(), tasks };
}
