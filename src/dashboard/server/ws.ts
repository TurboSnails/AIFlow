import type { WebSocketServer } from "ws";

export function broadcastEvent(wss: WebSocketServer, event: object): void {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}
