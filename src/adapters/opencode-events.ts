export interface OpenCodeStepStartEvent {
  type: "step_start";
  timestamp: number;
  sessionID: string;
  part: unknown;
}

export interface OpenCodeToolUseEvent {
  type: "tool_use";
  timestamp: number;
  sessionID: string;
  part: {
    type: "tool";
    tool: string;
    callID: string;
    state: { status: string; input: unknown; output: unknown };
  };
}

export interface OpenCodeTextEvent {
  type: "text";
  timestamp: number;
  sessionID: string;
  part: { type: "text"; text: string };
}

export interface OpenCodeStepFinishEvent {
  type: "step_finish";
  timestamp: number;
  sessionID: string;
  part: {
    type: "step-finish";
    reason: string;
    tokens: { total: number; input: number; output: number; reasoning: number; cache: { write: number; read: number } };
    cost: number;
  };
}

export type OpenCodeEvent =
  | OpenCodeStepStartEvent
  | OpenCodeToolUseEvent
  | OpenCodeTextEvent
  | OpenCodeStepFinishEvent;

export function parseOpenCodeLine(line: string): OpenCodeEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("type" in raw)) return null;
  const type = (raw as { type: unknown }).type;
  if (type === "step_start" || type === "tool_use" || type === "text" || type === "step_finish") {
    return raw as OpenCodeEvent;
  }
  return null;
}
