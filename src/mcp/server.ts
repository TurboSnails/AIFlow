import { handleToolCall, listTools, type McpToolsDeps } from "./tools";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function writeMessage(message: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id: number | string, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function isNotification(message: JsonRpcMessage): boolean {
  return message.id === undefined;
}

export interface McpServerOptions {
  cwd?: string;
  deps?: McpToolsDeps;
}

export function startMcpServer(opts: McpServerOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const deps = opts.deps;

  process.stdin.setEncoding("utf-8");
  let buffer = "";

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        sendError(null, -32700, "Parse error");
        continue;
      }
      handleMessage(message).catch((err) => {
        if (!isNotification(message)) {
          sendError(message.id ?? null, -32603, err instanceof Error ? err.message : String(err));
        }
      });
    }
  });

  process.stdin.on("end", () => {
    if (!buffer.trim()) return;
    try {
      const message = JSON.parse(buffer) as JsonRpcMessage;
      handleMessage(message).catch(() => {});
    } catch {
      sendError(null, -32700, "Parse error");
    }
  });

  async function handleMessage(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    switch (message.method) {
      case "initialize": {
        if (!isNotification(message)) sendResult(id as number | string, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "aiflow-mcp", version: "0.1.0" },
        });
        return;
      }
      case "tools/list": {
        if (!isNotification(message)) sendResult(id as number | string, { tools: listTools() });
        return;
      }
      case "tools/call": {
        const params = message.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments as Record<string, unknown>) ?? {};
        if (!name) {
          if (!isNotification(message)) sendError(id ?? null, -32602, "Missing tool name");
          return;
        }
        const result = await handleToolCall(name, args, cwd, deps);
        if (!isNotification(message)) sendResult(id as number | string, result);
        return;
      }
      default:
        if (!isNotification(message)) sendError(id ?? null, -32601, `Method not found: ${message.method}`);
    }
  }
}

if (import.meta.main) {
  startMcpServer();
}
