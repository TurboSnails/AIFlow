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

test("reports a full success when opencode is present, git repo is valid, and reviewer key works", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({ summary: "pong", issues: [] })),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBe("1.17.11");
  expect(report.gitOk).toBe(true);
  expect(report.reviewerKeyPresent).toBe(true);
  expect(report.reviewerReachable).toBe(true);
});

test("reports opencode missing when the version check returns null", async () => {
  const deps = {
    checkOpenCodeVersion: mock(async () => null),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({})),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBeNull();
});

test("reports reviewer key missing without attempting a network call", async () => {
  delete process.env.UNSET_DOCTOR_KEY;
  const profileWithMissingKey: ModelProfile = { ...reviewerProfile, api_key_env: "UNSET_DOCTOR_KEY" };
  const callReviewer = mock(async () => ({}));
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer,
  };
  const report = await runDoctorChecks("/tmp/whatever", profileWithMissingKey, deps);
  expect(report.reviewerKeyPresent).toBe(false);
  expect(report.reviewerReachable).toBeNull();
  expect(callReviewer).not.toHaveBeenCalled();
});

test("reports reviewer unreachable with the error message when the ping call throws", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => {
      throw new Error("401 unauthorized");
    }),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.reviewerReachable).toBe(false);
  expect(report.reviewerError).toContain("401 unauthorized");
});
