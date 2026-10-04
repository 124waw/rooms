const http = require("http");
const fs = require("fs");
const path = require("path");
let WebSocketServer;
try { ({ WebSocketServer } = require("ws")); }
catch (e) { ({ WebSocketServer } = require("/usr/local/lib/node_modules/ws")); }

const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;
const MAX_PLAYERS = 4;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();
let nextId = 1;

function code4() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CHARS[(Math.random() * CHARS.length) | 0];
  return s;
}

function uniqueCode() {
  for (let i = 0; i < 40; i++) {
    const c = code4();
    if (!rooms.has(c)) return c;
  }
  return code4() + CHARS[(Math.random() * CHARS.length) | 0];
}

function mime(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function lobbyOf(room) {
  return {
    t: "lobby",
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    seed: room.seed,
    checkpoint: room.checkpoint,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      host: p.id === room.hostId,
      alive: p.alive
    }))
  };
}

function broadcast(room, obj, except) {
  const raw = JSON.stringify(obj);
  for (const p of room.players) {
    if (p === except) continue;
    if (p.ws.readyState === 1) p.ws.send(raw);
  }
}

function dropPlayer(p, reason) {
  if (!p || !p.room) return;
  const room = p.room;
  room.players = room.players.filter((x) => x !== p);
  p.room = null;
  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }
  if (p.id === room.hostId) room.hostId = room.players[0].id;
  broadcast(room, { t: "leave", id: p.id, reason: reason || "left", hostId: room.hostId });
  broadcast(room, lobbyOf(room));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url === "/" ? "/index.html" : url;
  if (rel.includes("..")) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end(err.code === "ENOENT" ? "not found" : "error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime(file),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const me = {
    ws,
    id: "p" + nextId++,
    name: "ç©å®¶",
    room: null,
    alive: true
  };

  send(ws, { t: "hello", id: me.id });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;
    const room = me.room;

    if (msg.t === "create") {
      if (me.room) dropPlayer(me, "switch");
      const name = String(msg.name || "ç©å®¶").slice(0, 10) || "ç©å®¶";
      me.name = name;
      me.alive = true;
      const code = uniqueCode();
      const r = {
        code,
        hostId: me.id,
        started: false,
        seed: (Math.random() * 1e9) | 0,
        checkpoint: 0,
        players: [me]
      };
      me.room = r;
      rooms.set(code, r);
      send(ws, { t: "created", id: me.id, code, host: true, seed: r.seed });
      send(ws, lobbyOf(r));
      return;
    }

    if (msg.t === "join") {
      const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const r = rooms.get(code);
      if (!r) { send(ws, { t: "err", msg: "æ¿é´ä¸å­å¨" }); return; }
      if (r.started) { send(ws, { t: "err", msg: "å¯¹å±å·²å¼å§" }); return; }
      if (r.players.length >= MAX_PLAYERS) { send(ws, { t: "err", msg: "æ¿é´å·²æ»¡" }); return; }
      if (me.room) dropPlayer(me, "switch");
      me.name = String(msg.name || "ç©å®¶").slice(0, 10) || "ç©å®¶";
      me.alive = true;
      me.room = r;
      r.players.push(me);
      send(ws, { t: "joined", id: me.id, code: r.code, host: me.id === r.hostId, seed: r.seed });
      broadcast(r, lobbyOf(r));
      return;
    }

    if (msg.t === "leave") {
      dropPlayer(me, "left");
      send(ws, { t: "left" });
      return;
    }

    if (!room) return;

    if (msg.t === "start") {
      if (me.id !== room.hostId) return;
      room.started = true;
      if (typeof msg.seed === "number") room.seed = msg.seed | 0;
      room.checkpoint = 0;
      for (const p of room.players) p.alive = true;
      broadcast(room, { t: "start", seed: room.seed, checkpoint: 0, hostId: room.hostId });
      return;
    }

    if (msg.t === "pos") {
      broadcast(room, {
        t: "pos",
        id: me.id,
        x: +msg.x || 0,
        y: +msg.y || 0,
        z: +msg.z || 0,
        yaw: +msg.yaw || 0,
        pitch: +msg.pitch || 0,
        hiding: !!msg.hiding,
        light: !!msg.light,
        door: msg.door | 0,
        name: me.name
      }, me);
      return;
    }

    if (msg.t === "open") {
      broadcast(room, { t: "open", id: me.id, door: msg.door | 0 });
      return;
    }

    if (msg.t === "loot") {
      broadcast(room, {
        t: "loot",
        id: me.id,
        kind: String(msg.kind || ""),
        seed: msg.seed | 0,
        x: +msg.x || 0,
        z: +msg.z || 0
      }, me);
      return;
    }

    if (msg.t === "spawn") {
      if (me.id !== room.hostId) return;
      broadcast(room, { t: "spawn", kind: String(msg.kind || ""), z: +msg.z || 0 }, me);
      return;
    }

    if (msg.t === "ents") {
      if (me.id !== room.hostId) return;
      broadcast(room, { t: "ents", list: Array.isArray(msg.list) ? msg.list.slice(0, 4) : [] }, me);
      return;
    }

    if (msg.t === "a90") {
      if (me.id !== room.hostId) return;
      broadcast(room, { t: "a90", phase: String(msg.phase || "") }, me);
      return;
    }

    if (msg.t === "kill") {
      me.alive = false;
      broadcast(room, { t: "kill", id: me.id, by: String(msg.by || ""), kind: String(msg.kind || "") }, me);
      return;
    }
  });

  ws.on("close", () => dropPlayer(me, "disconnect"));
  ws.on("error", () => dropPlayer(me, "error"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("ROOMS listening on " + PORT);
});
