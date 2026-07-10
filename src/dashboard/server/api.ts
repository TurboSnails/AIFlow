import { join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { getRuns, getEventsForRun, getStageEventsForRun, getCostForRun } from "./db";
import { readGateAnswer, writeGateAnswer } from "../../gate-answer/answer";

export interface ApiDeps {
  db: Database;
  runsRoot?: string;
}

const GateAnswerSchema = z.object({
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

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json({ runs: getRuns(deps.db) });
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
    const events = getStageEventsForRun(deps.db, runId);
    res.json({ stages: events });
  });

  app.get("/api/runs/:id/stories", (_req: Request, res: Response) => {
    res.json({ stories: [] });
  });

  app.get("/api/runs/:id/debates", (_req: Request, res: Response) => {
    res.json({ debates: [] });
  });

  app.get("/api/runs/:id/reviews", (_req: Request, res: Response) => {
    res.json({ reviews: [] });
  });

  app.get("/api/runs/:id/cost", (req: Request, res: Response) => {
    const runId = req.params.id as string;
    if (deps.runsRoot && !safeRunDir(deps.runsRoot, runId)) {
      res.status(400).json({ error: "invalid run id" });
      return;
    }
    res.json(getCostForRun(deps.db, runId));
  });

  app.post("/api/runs/:id/gates/:stage/answer", (req: Request, res: Response) => {
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
    const existing = readGateAnswer(runDir);
    const prompt = existing?.prompt ?? "";
    writeGateAnswer(runDir, {
      stage,
      prompt,
      status: "answered",
      answered_at: new Date().toISOString(),
      action,
      reason: reason ?? null,
    });
    res.json({ ok: true });
  });

  return app;
}
