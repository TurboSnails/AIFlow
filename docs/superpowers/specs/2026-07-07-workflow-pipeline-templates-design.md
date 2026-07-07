# 工作流 Pipeline 模板库设计文档

> 承接：《多阶段 Pipeline Runner 设计文档》（2026-07-06）—— 该文档让引擎支持了 `brainstorm`/`spec`/`plan`/`human_gate`/`ralph_loop` 五种 stage 类型。本设计是它的下一个子项目：把 ralph / superpowers / spec-superflow / openspec 四种开发方法论，映射成 `aiflow init` 默认就会生成的 pipeline 配置。
> 状态：草案

---

## 1. 背景与问题

`aiflow init` 目前只脚手架一个 pipeline（`ralph-only.yaml`），且它的 YAML 内容是硬编码在 `src/commands/init.ts` 的一个 TS 多行字符串常量里。用户想要的"能快速切换多种工作流"，在当前架构下不需要任何新概念——`aiflow run --pipeline <name>` 早就支持按名字选择 pipeline；缺的只是"多准备几份配好的 pipeline 文件"。

本设计调研了四种方法论的真实工作流程（而非臆测），确定了它们各自能/不能被 AIFlow 现有 5 种 stage 类型表达的部分，并给出具体的模板内容与脚手架改造方案。

## 2. 方法论调研结论

| 方法论 | 真实阶段结构 | 与 AIFlow 现有能力的差距 |
|---|---|---|
| **ralph** | 单一循环：选最高优先级 story → 实现 → 门禁 → 提交 → 重复 | 无差距，已完整实现（`ralph_loop`） |
| **superpowers**（本仓库自己在用的方法论） | brainstorm → spec → 人工确认 → plan（写成可执行任务清单）→ 逐任务 TDD 实现 | 无差距，与现有 5 种 stage 类型逐一对应 |
| **openspec**（52k+ star，最活跃的开源 SDD 框架） | proposal（含 specs 场景）→ fast-forward 规划（design+tasks）→ apply（实现）→ archive（合并回主 spec 目录） | 官方哲学是"不强制阶段门禁，制品随时可改"——跟 `human_gate` 的强制卡点语义有张力；"archive/合并回主 spec 目录"这个收尾动作 AIFlow 没有对应能力 |
| **spec-superflow**（融合 openspec 规划引擎 + superpowers 执行纪律，8 阶段） | exploring → specifying → **bridging**（生成 execution-contract.md 桥接层）→ executing → **debugging**（强制 4 阶段根因分析）→ reviewing → closing → syncing | `bridging`/`debugging`/`closing`/`syncing` 都没有对应的 AIFlow stage 类型；`reviewing` 已经被 `ralph_loop` 自带的两层门禁覆盖，不需要单独建 stage |

**近似策略**（不追求 1:1 还原，明确记录舍弃了什么）：
- openspec 的"不强制门禁" → 模板里直接不放 `human_gate` stage（不是"放了但标记可选"，因为 AIFlow 目前没有"可选 stage"的概念）
- spec-superflow 的 `bridging`/`debugging`/`closing`/`syncing` → 均不单独建 stage：bridging 的产物本质就是 spec.md/prd.json 之间的衔接，已经由 `plan` stage 的 `input: spec.md` 约定覆盖；debugging 依赖 `ralph_loop` 自身的 `fix_list.md` 重试机制兜底；closing/syncing（archive 到主 spec 目录）暂不支持，留给以后
- **superpowers 和 spec-superflow 在 stage 拓扑上会完全一样**（都是 brainstorm→spec→human_gate→plan→ralph_loop）——两者真正的差异化特征（execution-contract、强制 debug 协议）目前无法用不同拓扑表达。已决定：仍保留两份独立文件，用不同的 stage `id` 和 `human_gate` 的 `prompt` 文案体现各自方法论的用词和侧重点，而不是假装它们在结构上不同。

## 3. 设计

### 3.1 一个必须解决的前置约束：channel 匹配

`brainstorm`/`plan` 两种 stage 只能引用 `channel: http` 的 profile（它们走 `callLlm`/`callLlmFanOut` 直连 API）；`spec`/`ralph_loop` 只能引用 `channel: opencode` 的 profile（走 `runAgentTask`）。`brainstorm` 的 `models` 字段 schema 要求至少 2 个（Task 2 已加的 `.min(2)`），而当前 `aiflow init` 默认的 `models.yaml` 只有一个 http profile（`reviewer`）。

**决定**：给 `MODELS_YAML_TEMPLATE` 新增第二个 http profile `alt-reviewer`（同样是 `REPLACE_ME_VERIFY_VIA_DOCTOR` 占位符风格），`api_key_env` 特意命名为 `ALT_REVIEWER_API_KEY`（不是复用 `MINIMAX_API_KEY`）——用命名提示用户"这里最好配一个不同厂商/模型"，而不是让人误以为两个 profile 应该配成完全一样的东西。

### 3.2 存储机制：从 TS 字符串常量改为独立 YAML 文件

现状：`src/commands/init.ts`里 `RALPH_ONLY_YAML_TEMPLATE` 是一个内嵌的多行字符串。这次要从 1 份变成 4 份，以后大概率还会为 GUI 的模板选择器继续加——继续堆 TS 字符串常量，可维护性和可扩展性都会变差（没有语法高亮、diff 可读性差、每加一个模板都要碰 TS 源码）。

**改动**：新增目录 `src/commands/init-templates/`，每个 pipeline 模板是一个独立的 `.yaml` 文件：

```
src/commands/init-templates/
├── ralph-only.yaml       # 内容与现有 RALPH_ONLY_YAML_TEMPLATE 完全一致，原样搬过来
├── superpowers.yaml      # 新增
├── spec-superflow.yaml   # 新增
└── openspec.yaml         # 新增
```

`init.ts` 用 `import.meta.dir`（Bun 提供，指向当前模块所在目录，不受调用方 `cwd` 影响）定位这个目录，遍历一份"模板名清单"逐个读取写入：

```ts
const TEMPLATES_DIR = join(import.meta.dir, "init-templates");
const PIPELINE_TEMPLATE_NAMES = ["ralph-only", "superpowers", "spec-superflow", "openspec"];

// 在 runInit 里，替换原来单独写 RALPH_ONLY_YAML_TEMPLATE 的那一行：
for (const name of PIPELINE_TEMPLATE_NAMES) {
  const content = readFileSync(join(TEMPLATES_DIR, `${name}.yaml`), "utf-8");
  writeFileSync(join(configDir, "pipelines", `${name}.yaml`), content);
}
```

以后加第五种方法论模板 = 加一个 `.yaml` 文件 + 在 `PIPELINE_TEMPLATE_NAMES` 里加一行，不用碰其余任何逻辑。

`MODELS_YAML_TEMPLATE`、`PROJECT_YAML_TEMPLATE` 这两个不在这次范围内——它们不会像 pipeline 模板一样持续增多，继续保持现状，避免不必要的改动面。

### 3.3 四份模板的具体内容

**`ralph-only.yaml`**：不变，原样迁移。

**`superpowers.yaml`**（对应本仓库自己在用的方法论）：

```yaml
name: superpowers
stages:
  - id: ideate
    type: brainstorm
    models: ["reviewer", "alt-reviewer"]
    synthesizer: reviewer
    output: brainstorm-report.md
  - id: spec
    type: spec
    model: main-dev
  - id: confirm-spec
    type: human_gate
    prompt: "Review spec.md and the brainstorm synthesis. Approve to proceed to planning, or reject to send this back for rework."
  - id: plan
    type: plan
    model: reviewer
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
```

**`spec-superflow.yaml`**（拓扑与上面完全一致，`id` 和 `human_gate` 的 `prompt` 换成它自己的术语，体现"execution contract"式的验收语气）：

```yaml
name: spec-superflow
stages:
  - id: exploring
    type: brainstorm
    models: ["reviewer", "alt-reviewer"]
    synthesizer: reviewer
    output: brainstorm-report.md
  - id: specifying
    type: spec
    model: main-dev
  - id: bridging-review
    type: human_gate
    prompt: "Confirm spec.md captures a complete execution contract (scope, acceptance criteria, and constraints) before implementation begins. Reject to send this back for another planning pass."
  - id: tasks
    type: plan
    model: reviewer
  - id: executing
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
```

**`openspec.yaml`**（最精简的一个——没有 brainstorm，没有 human_gate，对应 openspec"轻量、不强制门禁"的定位）：

```yaml
name: openspec
stages:
  - id: proposal
    type: spec
    model: main-dev
  - id: tasks
    type: plan
    model: reviewer
  - id: apply
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
```

`openspec.yaml`/`spec-superflow.yaml`/`superpowers.yaml` 都以 `spec`（或 `brainstorm`）开头，跑之前都需要 `aiflow run --pipeline <name> --requirement "..."` 或 `--requirement-file`（Task 10 已有的前置校验会在缺失时直接报错，不需要新逻辑）。`ralph-only.yaml` 因为只有 `ralph_loop`，不受此约束，行为不变。

### 3.4 README 更新

`README.md` 的 Configuration 一节需要新增一小段，说明 `aiflow init` 现在会生成 4 份参考 pipeline（列出各自对应哪种方法论、用一句话说明它跟纯 ralph 的区别），并提醒 openspec/spec-superflow 的近似程度（链接回本设计文档的"近似策略"一节，不在 README 里展开细节）。

## 4. 测试计划

- **`test/unit/init.test.ts`**：现有的"生成默认脚手架"测试扩展成断言全部 4 个 pipeline 文件都存在（`ralph-only.yaml`/`superpowers.yaml`/`spec-superflow.yaml`/`openspec.yaml`），新增一条断言 `models.yaml` 包含 `alt-reviewer` 这个 profile 名。
- **新增 `test/unit/init-templates.test.ts`**：对 `src/commands/init-templates/` 下的每一个 `.yaml` 文件，直接用 `loadPipelineConfig`（真实的 zod schema，不是 mock）解析，断言都能成功解析、且 `config.stages` 的 `type` 序列符合本文档 §3.3 里写的那样——这是防止未来 schema 变化（比如某个 stage 字段改成必填）却没人发现某个模板已经解析不过的回归测试，这批模板不会被 CI 之外的任何东西自动验证，必须有测试兜底。
- 不需要端到端跑通这 4 个 pipeline（那需要真实 LLM/OpenCode 调用，超出这次范围；schema 校验层面的正确性已经是这次改动能验证的全部）。

## 5. 不做的事

- 不新增任何 CLic 命令或参数（不做 `aiflow init --template <name>`）——`aiflow init` 一次性生成全部 4 份，选择通过已有的 `--pipeline` 参数完成。
- 不追求 openspec/spec-superflow 跟其官方工具的 1:1 行为还原（没有 execution-contract.md 桥接文件、没有强制 debug 协议、没有 archive 到独立 spec 目录）——本文档 §2 已经明确记录了舍弃了什么。
- 不改动 `MODELS_YAML_TEMPLATE` 之外的模型配置逻辑，不新增 profile 校验规则（比如"brainstorm 引用的 profile 必须是 http channel"这种校验，属于另一个可能有价值的子项目，这次不做）。
- 不做端到端真实调用测试（原因见 §4）。
