import { DurableObject } from "cloudflare:workers";
import { handleAuthRequest } from "./auth.js";

export class SignalingServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.rooms = new Map(); // roomCode -> Set of ws
    this.socketRoom = new Map(); // ws -> roomCode
    this.socketId = new Map(); // ws -> socketId
    this.idSocket = new Map(); // socketId -> ws
    this.rebuilt = false;
  }

  ensureState() {
    if (this.rebuilt) return;
    this.rebuilt = true;
    try {
      const allSockets = this.ctx.getWebSockets();
      for (const ws of allSockets) {
        const att = ws.deserializeAttachment();
        if (att && att.socketId) {
          this.idSocket.set(att.socketId, ws);
          this.socketId.set(ws, att.socketId);
          if (att.roomCode) {
            if (!this.rooms.has(att.roomCode)) {
              this.rooms.set(att.roomCode, new Set());
            }
            this.rooms.get(att.roomCode).add(ws);
            this.socketRoom.set(ws, att.roomCode);
          }
        }
      }
    } catch (e) {
      console.error("Error rebuilding state from active sockets:", e);
    }
  }

  async fetch(request) {
    this.ensureState();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept server websocket into Hibernation runtime
    this.ctx.acceptWebSocket(server);

    const socketId = "s_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const url = new URL(request.url);
    const isSocketIo = url.pathname.startsWith("/socket.io");

    const attachment = {
      socketId,
      isSocketIo,
      roomCode: null
    };

    server.serializeAttachment(attachment);
    this.idSocket.set(socketId, server);
    this.socketId.set(server, socketId);

    // If connecting via Socket.IO, send Engine.IO v4 open handshake packet
    if (isSocketIo) {
      server.send(`0{"sid":"${socketId}","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`);
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  sendEvent(ws, isSocketIo, eventName, data) {
    try {
      if (isSocketIo) {
        ws.send(`42${JSON.stringify([eventName, data])}`);
      } else {
        ws.send(JSON.stringify({ event: eventName, data }));
      }
    } catch (err) {
      console.error("Failed to send event to socket:", err);
    }
  }

  async webSocketMessage(ws, message) {
    this.ensureState();
    if (typeof message !== "string") return;

    let attachment = ws.deserializeAttachment() || {};
    const socketId = attachment.socketId || this.socketId.get(ws);
    const isSocketIo = attachment.isSocketIo !== false;

    // Handle Engine.IO / Socket.IO wire protocol
    if (isSocketIo) {
      if (message === "2" || message === "2probe") {
        ws.send(message === "2probe" ? "3probe" : "3");
        return;
      }
      if (message === "5") {
        return; // Engine.IO upgrade acknowledgement
      }
      // Socket.IO Namespace Connect (packet type 40)
      if (message === "40" || message.startsWith("40")) {
        ws.send(`40{"sid":"${socketId}"}`);
        return;
      }
      if (message.startsWith("42")) {
        try {
          const parsed = JSON.parse(message.slice(2));
          const [eventName, eventData] = parsed;
          this.handleEvent(ws, socketId, isSocketIo, attachment, eventName, eventData);
        } catch (e) {
          console.error("Socket.IO message parse error:", e);
        }
        return;
      }
    }

    // Native WebSocket fallback
    try {
      const parsed = JSON.parse(message);
      this.handleEvent(ws, socketId, isSocketIo, attachment, parsed.event, parsed.data);
    } catch (e) {
      console.error("Native WebSocket message parse error:", e);
    }
  }

  handleEvent(ws, socketId, isSocketIo, attachment, eventName, eventData) {
    if (eventName === "create-room") {
      let roomCode = Math.floor(100000 + Math.random() * 900000).toString();
      while (this.rooms.has(roomCode)) {
        roomCode = Math.floor(100000 + Math.random() * 900000).toString();
      }

      const roomSet = new Set([ws]);
      this.rooms.set(roomCode, roomSet);
      attachment.roomCode = roomCode;
      ws.serializeAttachment(attachment);
      this.socketRoom.set(ws, roomCode);

      this.sendEvent(ws, isSocketIo, "room-created", { roomCode, code: roomCode, roomId: roomCode });
      return;
    }

    if (eventName === "join-room") {
      let roomCode = "";
      if (typeof eventData === "string") {
        roomCode = eventData.trim();
      } else if (eventData && typeof eventData === "object") {
        roomCode = (eventData.roomCode || eventData.code || "").toString().trim();
      }

      if (!roomCode || !this.rooms.has(roomCode)) {
        // Fallback: check if any active socket has this roomCode in attachment
        let found = false;
        for (const s of this.ctx.getWebSockets()) {
          const att = s.deserializeAttachment();
          if (att && att.roomCode === roomCode) {
            if (!this.rooms.has(roomCode)) {
              this.rooms.set(roomCode, new Set());
            }
            this.rooms.get(roomCode).add(s);
            found = true;
          }
        }
        if (!found) {
          this.sendEvent(ws, isSocketIo, "error-msg", "Room code not found or has expired.");
          return;
        }
      }

      const roomSet = this.rooms.get(roomCode);
      roomSet.add(ws);
      attachment.roomCode = roomCode;
      ws.serializeAttachment(attachment);
      this.socketRoom.set(ws, roomCode);

      // Notify joining peer
      this.sendEvent(ws, isSocketIo, "room-joined", { roomCode, code: roomCode, roomId: roomCode });

      // Notify peer(s) already in room
      for (const peerWs of roomSet) {
        if (peerWs !== ws) {
          const peerAtt = peerWs.deserializeAttachment() || {};
          this.sendEvent(peerWs, peerAtt.isSocketIo, "peer-joined", { peerId: socketId });
        }
      }
      return;
    }

    if (eventName === "signal") {
      if (!eventData) return;
      const { targetId, data } = eventData;
      if (!targetId) return;

      let targetWs = this.idSocket.get(targetId);
      if (!targetWs) {
        for (const s of this.ctx.getWebSockets()) {
          const att = s.deserializeAttachment();
          if (att && att.socketId === targetId) {
            targetWs = s;
            this.idSocket.set(targetId, s);
            break;
          }
        }
      }

      if (targetWs) {
        const targetAtt = targetWs.deserializeAttachment() || {};
        this.sendEvent(targetWs, targetAtt.isSocketIo, "signal", {
          senderId: socketId,
          data
        });
      }
      return;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.cleanupSocket(ws);
  }

  async webSocketError(ws, error) {
    this.cleanupSocket(ws);
  }

  cleanupSocket(ws) {
    this.ensureState();
    const attachment = ws.deserializeAttachment() || {};
    const socketId = attachment.socketId || this.socketId.get(ws);
    const roomCode = attachment.roomCode || this.socketRoom.get(ws);

    if (socketId) {
      this.idSocket.delete(socketId);
      this.socketId.delete(ws);
    }
    this.socketRoom.delete(ws);

    if (roomCode && this.rooms.has(roomCode)) {
      const roomSet = this.rooms.get(roomCode);
      roomSet.delete(ws);

      for (const peerWs of roomSet) {
        const peerAtt = peerWs.deserializeAttachment() || {};
        this.sendEvent(peerWs, peerAtt.isSocketIo, "peer-disconnected", { peerId: socketId });
      }

      if (roomSet.size === 0) {
        this.rooms.delete(roomCode);
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 0a. Enforce HTTPS 301 Redirect in production
    const cfVisitor = request.headers.get("cf-visitor");
    const isHttpCf = cfVisitor && cfVisitor.includes('"scheme":"http"');
    const proto = request.headers.get("x-forwarded-proto") || (isHttpCf ? "http" : url.protocol.replace(":", ""));
    if ((proto === "http" || isHttpCf) && !url.hostname.includes("localhost") && !url.hostname.includes("127.0.0.1")) {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

    // Helper to attach security headers and asset caching to responses
    function withSecurityHeaders(res, reqUrl = url) {
      if (!res) return res;
      const headers = new Headers(res.headers);
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "SAMEORIGIN");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()");
      headers.set("Content-Security-Policy", "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' wss: https:; frame-src 'self' https://accounts.google.com; object-src 'none'; base-uri 'self';");

      // Caching optimizations for static immutable assets
      if (reqUrl && reqUrl.pathname.match(/\.(?:js|css|webp|jpg|png|svg|ico|woff2?)$/)) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers
      });
    }

    // 0b. Cloudflare Worker KV Authentication Endpoints (/api/auth/*)
    if (url.pathname.startsWith("/api/auth")) {
      const authRes = await handleAuthRequest(request, env);
      if (authRes) return withSecurityHeaders(authRes);
    }

    // Alias clean /founder path to /about
    if (url.pathname === "/founder" || url.pathname === "/founder/") {
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(new Request(new URL("/about", request.url), request));
        return withSecurityHeaders(res);
      }
    }

    // 1. Health check endpoint
    if (url.pathname === "/healthz") {
      return new Response("OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 2. ICE Servers endpoint
    if (url.pathname === "/api/ice-servers") {
      const iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
      ];

      if (env.TURN_URL) {
        const urls = env.TURN_URL.split(",").map((u) => u.trim());
        const turnEntry = { urls };
        if (env.TURN_USERNAME) turnEntry.username = env.TURN_USERNAME;
        if (env.TURN_CREDENTIAL) turnEntry.credential = env.TURN_CREDENTIAL;
        iceServers.push(turnEntry);
      }

      return new Response(JSON.stringify({ iceServers }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 3. Socket.IO polling HTTP fallback handshake
    if (url.pathname.startsWith("/socket.io/") && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      if (request.method === "GET") {
        return new Response(`0{"sid":"${sid}","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000}`, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true"
          }
        });
      }
      return new Response("ok", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": "true"
        }
      });
    }

    // 4. Real-time WebRTC Signaling (WebSocket or Socket.IO over WebSocket)
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" || url.pathname === "/ws") {
      const id = env.SIGNALING.idFromName("global-room-hub");
      const stub = env.SIGNALING.get(id);
      return stub.fetch(request);
    }

    // 5. Static Assets fallback (index.html, app.js, style.css, assets, etc.)
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return withSecurityHeaders(res);
    }

    return new Response("Not Found", { status: 404 });
  }
};
