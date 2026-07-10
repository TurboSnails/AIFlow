import { handleToolCall, listTools, type McpToolsDeps } from "./tools";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
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

function sendError(id: number | string, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
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
        sendError(0, -32700, "Parse error");
        continue;
      }
      handleMessage(message).catch((err) => {
        sendError(message.id ?? 0, -32603, err instanceof Error ? err.message : String(err));
      });
    }
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) {
      const message = JSON.parse(buffer) as JsonRpcMessage;
      handleMessage(message).catch(() => {});
    }
  });

  async function handleMessage(message: JsonRpcMessage): Promise<void> {
    const id = message.id ?? 0;
    switch (message.method) {
      case "initialize": {
        sendResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "aiflow-mcp", version: "0.1.0" },
        });
        return;
      }
      case "tools/list": {
        sendResult(id, { tools: listTools() });
        return;
      }
      case "tools/call": {
        const params = message.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments as Record<string, unknown>) ?? {};
        if (!name) {
          sendError(id, -32602, "Missing tool name");
          return;
        }
        const result = await handleToolCall(name, args, cwd, deps);
        sendResult(id, result);
        return;
      }
      default:
        sendError(id, -32601, `Method not found: ${message.method}`);
    }
  }
}

if (import.meta.main) {
  startMcpServer();
}
