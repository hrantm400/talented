import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import type { Project } from "@shared/schema";

let wss: WebSocketServer | null = null;
const clients: Set<WebSocket> = new Set();

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[ws] client error:", err);
      clients.delete(ws);
      try {
        ws.terminate();
      } catch {}
    });
  });

  return wss;
}

export function broadcastProjectUpdate(project: Project) {
  if (!wss) return;

  const payload = JSON.stringify({
    type: "PROJECT_UPDATE",
    project,
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
