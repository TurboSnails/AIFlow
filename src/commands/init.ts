import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface InitResult {
  created: boolean;
  reason?: string;
}

const MODELS_YAML_TEMPLATE = `profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY
  alt-reviewer:
    channel: http
    provider: REPLACE_ME_VERIFY_VIA_DOCTOR
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: ALT_REVIEWER_API_KEY
`;

const PROJECT_YAML_TEMPLATE = `{}
`;

const TEMPLATES_DIR = join(import.meta.dir, "init-templates");
const PIPELINE_TEMPLATE_NAMES = ["ralph-only"];

export function runInit(cwd: string): InitResult {
  const configDir = join(cwd, ".aiflow", "config");
  if (existsSync(configDir)) {
    return { created: false, reason: ".aiflow/config already exists; refusing to overwrite" };
  }

  mkdirSync(join(configDir, "pipelines"), { recursive: true });
  writeFileSync(join(configDir, "models.yaml"), MODELS_YAML_TEMPLATE);
  for (const name of PIPELINE_TEMPLATE_NAMES) {
    const content = readFileSync(join(TEMPLATES_DIR, `${name}.yaml`), "utf-8");
    writeFileSync(join(configDir, "pipelines", `${name}.yaml`), content);
  }
  writeFileSync(join(configDir, "project.yaml"), PROJECT_YAML_TEMPLATE);

  const gitignorePath = join(cwd, ".gitignore");
  const ignoreLine = ".aiflow/runs/";
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    if (!existing.includes(ignoreLine)) {
      appendFileSync(gitignorePath, `\n${ignoreLine}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${ignoreLine}\n`);
  }

  return { created: true };
}
