import { test, expect, mock } from "bun:test";
import { runDoctorChecks } from "../../src/commands/doctor";
import type { ModelProfile } from "../../src/config/schema";

const reviewerProfile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_DOCTOR_KEY",
};

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({ data: { summary: "pong", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } })),
    loadModelsConfig: mock(() => ({ profiles: {} })),
    loadProjectConfig: mock(() => ({ name: "demo", stages: [] })),
    listStaleWorktrees: mock(async () => []),
    ...overrides,
  };
}

test("reports a full success when opencode is present, git repo is valid, and reviewer key works", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = baseDeps({
    loadModelsConfig: mock(() => ({ profiles: { reviewer: reviewerProfile } })),
  });
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBe("1.17.11");
  expect(report.gitOk).toBe(true);
  expect(report.reviewerKeyPresent).toBe(true);
  expect(report.reviewerReachable).toBe(true);
});

test("reports opencode missing when the version check returns null", async () => {
  const deps = baseDeps({ checkOpenCodeVersion: mock(async () => null) });
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBeNull();
});

test("reports reviewer key missing without attempting a network call", async () => {
  delete process.env.UNSET_DOCTOR_KEY;
  const profileWithMissingKey: ModelProfile = { ...reviewerProfile, api_key_env: "UNSET_DOCTOR_KEY" };
  const callReviewer = mock(async () => ({ data: {}, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
  const deps = baseDeps({ callReviewer });
  const report = await runDoctorChecks("/tmp/whatever", profileWithMissingKey, deps);
  expect(report.reviewerKeyPresent).toBe(false);
  expect(report.reviewerReachable).toBeNull();
  expect(callReviewer).not.toHaveBeenCalled();
});

test("reports reviewer unreachable with the error message when the ping call throws", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = baseDeps({
    callReviewer: mock(async () => {
      throw new Error("401 unauthorized");
    }),
    loadModelsConfig: mock(() => ({ profiles: { reviewer: reviewerProfile } })),
  });
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.reviewerReachable).toBe(false);
  expect(report.reviewerError).toContain("401 unauthorized");
});

test("reports a pricing warning for a channel:http profile missing input_cost_per_1m/output_cost_per_1m", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = baseDeps({
    loadModelsConfig: mock(() => ({ profiles: { reviewer: reviewerProfile } })),
  });
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.pricingWarnings).toContain(
    'Profile "reviewer" is missing one or both of input_cost_per_1m/output_cost_per_1m; spend will be under-counted in budget and cost reports (missing fields are treated as $0).'
  );
});

test("reports config valid and stale worktrees when configs load", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = baseDeps({
    loadModelsConfig: mock(() => ({ profiles: { reviewer: reviewerProfile } })),
    loadProjectConfig: mock(() => ({ name: "demo", stages: [] })),
    listStaleWorktrees: mock(async () => [{ path: "/tmp/wt", branch: "aiflow/r1" }]),
  });
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.configOk).toBe(true);
  expect(report.staleWorktrees).toBe(1);
  expect(report.profileStatuses).toHaveLength(1);
  expect(report.profileStatuses[0].name).toBe("reviewer");
  expect(report.profileStatuses[0].reachable).toBe(true);
});

test("reports config invalid when config loading throws", async () => {
  const deps = baseDeps({
    loadModelsConfig: mock(() => {
      throw new Error("models.yaml invalid");
    }),
    loadProjectConfig: mock(() => ({ name: "demo", stages: [] })),
    listStaleWorktrees: mock(async () => []),
  });
  const report = await runDoctorChecks("/tmp/whatever", undefined, deps);
  expect(report.configOk).toBe(false);
  expect(report.configError).toContain("models.yaml invalid");
});

test("reports profile statuses for all http profiles with present keys", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const otherProfile: ModelProfile = { ...reviewerProfile, api_key_env: "TEST_DOCTOR_KEY" };
  const deps = baseDeps({
    loadModelsConfig: mock(() => ({
      profiles: { reviewer: reviewerProfile, coder: otherProfile },
    })),
  });
  const report = await runDoctorChecks("/tmp/whatever", undefined, deps);
  expect(report.profileStatuses).toHaveLength(2);
  expect(report.profileStatuses.map((p) => p.name).sort()).toEqual(["coder", "reviewer"]);
  expect(report.profileStatuses.every((p) => p.reachable === true)).toBe(true);
});

test("reports stale worktree count when listStaleWorktrees returns entries", async () => {
  const deps = baseDeps({
    listStaleWorktrees: mock(async () => [
      { path: "/tmp/wt1", branch: "aiflow/r1" },
      { path: "/tmp/wt2", branch: "aiflow/r2" },
    ]),
  });
  const report = await runDoctorChecks("/tmp/whatever", undefined, deps);
  expect(report.staleWorktrees).toBe(2);
});
