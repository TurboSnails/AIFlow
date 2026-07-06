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
`;

const RALPH_ONLY_YAML_TEMPLATE = `name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
`;

const PROJECT_YAML_TEMPLATE = `{}
`;

export function runInit(cwd: string): InitResult {
  const configDir = join(cwd, ".aiflow", "config");
  if (existsSync(configDir)) {
    return { created: false, reason: ".aiflow/config already exists; refusing to overwrite" };
  }

  mkdirSync(join(configDir, "pipelines"), { recursive: true });
  writeFileSync(join(configDir, "models.yaml"), MODELS_YAML_TEMPLATE);
  writeFileSync(join(configDir, "pipelines", "ralph-only.yaml"), RALPH_ONLY_YAML_TEMPLATE);
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
