import { join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { getRuns, getEventsForRun, getStageEventsForRun, getCostForRun } from "./db";
import { writeFileAtomic } from "../../atomic/atomic-write";

export interface ApiDeps {
  db: Database;
  runsRoot?: string;
}

const GateAnswerSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

const ControlSchema = z.object({
  action: z.enum(["pause", "resume", "abort"]),
});

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json({ runs: getRuns(deps.db) });
  });

  app.get("/api/runs/:id", (req: Request, res: Response) => {
    const runId = req.params.id;
    const events = getEventsForRun(deps.db, runId);
    if (events.length === 0) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ run_id: runId, events });
  });

  app.get("/api/runs/:id/stages", (req: Request, res: Response) => {
    res.json({ stages: getStageEventsForRun(deps.db, req.params.id) });
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
    res.json(getCostForRun(deps.db, req.params.id));
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
    const runId = req.params.id;
    const stage = req.params.stage;
    const { action, reason } = parse.data;
    const answer = { stage, action, reason, answeredAt: new Date().toISOString() };
    writeFileAtomic(join(deps.runsRoot, runId, "gate-answer.json"), JSON.stringify(answer, null, 2));
    res.json({ ok: true });
  });

  app.post("/api/runs/:id/control", (req: Request, res: Response) => {
    const parse = ControlSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    if (!deps.runsRoot) {
      res.status(503).json({ error: "runsRoot not configured" });
      return;
    }
    const runId = req.params.id;
    const { action } = parse.data;
    const control = { action, requestedAt: new Date().toISOString() };
    writeFileAtomic(join(deps.runsRoot, runId, "control.json"), JSON.stringify(control, null, 2));
    res.json({ ok: true, action });
  });

  return app;
}
