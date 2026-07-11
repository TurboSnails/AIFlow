import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { getRuns, getEventsForRun, getStagesForRun, getCostForRun } from "./db";
import { readEvents } from "../../events/events";
import { readSpecBoard } from "../../specboard/specboard";
import { readGateAnswer, writeGateAnswer } from "../../gate-answer/answer";
import { runApprove } from "../../commands/approve";
import type { EngineState } from "../../engine/state";
import { acquireRunLock, LockWaitAbortedError } from "../../lock";

export interface ApiDeps {
  db: Database;
  runsRoot?: string;
  runApprove?: typeof runApprove;
}

const GateAnswerSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

const GateAnswerBodySchema = z.object({
  stage: z.string(),
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

const VALID_RUN_ID = /^[A-Za-z0-9_-]+$/;

function safeRunDir(runsRoot: string, runId: string): string | undefined {
  if (!VALID_RUN_ID.test(runId)) return undefined;
  const runDir = resolve(runsRoot, runId);
  const root = resolve(runsRoot);
  if (!runDir.startsWith(root + "/") && runDir !== root) return undefined;
  return runDir;
}

function readStateJson(runDir: string): EngineState | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8")) as EngineState;
  } catch {
    return undefined;
  }
}

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json({ runs: getRuns(deps.db, deps.runsRoot) });
  });

  app.get("/api/runs/:id", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const events = getEventsForRun(deps.db, runId);
    if (events.length === 0) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ run_id: runId, events });
  });

  app.get("/api/runs/:id/stages", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const stages = deps.runsRoot ? getStagesForRun(deps.db, deps.runsRoot, runId) : [];
    res.json({ stages });
  });

  app.get("/api/runs/:id/stories", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runDir = safeRunDir(deps.runsRoot, runId)!;
    let stories: Array<{ id: string; title: string }> = [];
    try {
      const board = readSpecBoard(runDir);
      stories = Object.entries(board.artifacts).map(([id]) => ({ id, title: id }));
    } catch {
      // ignore missing/unreadable specboard
    }
    res.json({ stories });
  });

  app.get("/api/runs/:id/debates", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runDir = safeRunDir(deps.runsRoot, runId)!;
    const events = readEvents(runDir).filter(
      (e) => e.type === "debate_round" || e.type === "debate_end",
    );
    res.json({ debates: events });
  });

  app.get("/api/runs/:id/reviews", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runDir = safeRunDir(deps.runsRoot, runId)!;
    const events = readEvents(runDir).filter((e) => e.type === "review_verdict");
    let matrix: Array<{ story_id: string; entry: unknown }> = [];
    try {
      const board = readSpecBoard(runDir);
      matrix = Object.entries(board.review_matrix).map(([story_id, entry]) => ({
        story_id,
        entry,
      }));
    } catch {
      // ignore missing/unreadable specboard
    }
    res.json({ reviews: events, matrix });
  });

  app.get("/api/runs/:id/cost", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    res.json(getCostForRun(deps.db, runId));
  });

  app.post("/api/runs/:id/gates/:stage/answer", async (req: Request, res: Response) => {
    const parse = GateAnswerSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runId = req.params.id as string;
    const runDir = safeRunDir(deps.runsRoot, runId);
    if (!runDir) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    const stage = req.params.stage as string;
    const { action, reason } = parse.data;

    const projectRoot = dirname(dirname(deps.runsRoot));
    const { acquireRunLock, LockWaitAbortedError } = await import("../../lock");
    let lock: { release: () => void };
    try {
      lock = await acquireRunLock(projectRoot, runId, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        res.status(503).json({ error: "could not acquire run lock" });
        return;
      }
      res.status(500).json({ error: "lock error" });
      return;
    }

    try {
      const state = readStateJson(runDir);
      if (!state) {
        res.status(409).json({ error: "stage not waiting" });
        return;
      }
      const target = state.stages.find((s) => s.id === stage);
      if (!target || target.status !== "waiting_human") {
        res.status(409).json({ error: "stage not waiting" });
        return;
      }
      const existing = readGateAnswer(runDir);
      writeGateAnswer(runDir, {
        stage,
        prompt: existing?.prompt ?? "",
        status: "answered",
        answered_at: new Date().toISOString(),
        action,
        reason: reason ?? null,
      });
      res.json({ ok: true });
    } finally {
      lock.release();
    }
  });

  app.post("/api/runs/:runId/gate-answer", async (req: Request, res: Response) => {
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runId = req.params.runId as string;
    const runDir = safeRunDir(deps.runsRoot, runId);
    if (!runDir) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    const parse = GateAnswerBodySchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const { stage, action, reason } = parse.data;

    // Acquire the run lock before mutating gate-answer.json so dashboard and CLI
    // cannot race on the same waiting_human stage.
    let lock: { release: () => void };
    try {
      lock = await acquireRunLock(dirname(dirname(deps.runsRoot)), runId, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        res.status(503).json({ error: "could not acquire run lock" });
        return;
      }
      res.status(500).json({ error: "lock error" });
      return;
    }

    try {
      const state = readStateJson(runDir);
      if (!state) {
        res.status(409).json({ error: "stage not waiting" });
        return;
      }
      const target = state.stages.find((s) => s.id === stage);
      if (!target || target.status !== "waiting_human") {
        res.status(409).json({ error: "stage not waiting" });
        return;
      }
      const existing = readGateAnswer(runDir);
      writeGateAnswer(runDir, {
        stage,
        prompt: existing?.prompt ?? "",
        status: "answered",
        answered_at: new Date().toISOString(),
        action,
        reason: reason ?? null,
      });
    } finally {
      lock.release();
    }

    res.json({ ok: true });

    // Resume asynchronously so the HTTP response returns immediately. The lock is
    // already released; runApprove will re-acquire it before mutating state.
    const cwd = dirname(dirname(deps.runsRoot));
    (deps.runApprove ?? runApprove)(cwd, {
      runId,
      stage,
      action,
      by: "dashboard",
      reason: reason ?? null,
    }).catch((err: unknown) => {
      console.error("gate-answer resume failed", err);
    });
  });

  const clientDist = join(dirname(import.meta.dir), "client", "dist");
  app.use(express.static(clientDist));
  app.get("/{*splat}", (_req: Request, res: Response) => {
    res.sendFile(join(clientDist, "index.html"));
  });

  return app;
}
