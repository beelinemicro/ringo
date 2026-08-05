// RINGO server — serves the game and hosts online rooms over WebSockets.
//
//   npm install
//   npm start          → http://localhost:3000
//
// The server is authoritative for online games: it rolls the dice, validates
// placements, and broadcasts the resulting state to every player in the room.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GAME_VERSION, newGame, rollDice, applyRoll, applyPlace, isLegal, nextPlayer } from './public/js/game.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// ---------- static file server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- rooms ----------

const rooms = new Map(); // code -> room

// No ambiguous letters (I/L/O look like 1/0).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeRoom() {
  const room = {
    code: makeCode(),
    sockets: [], // parallel to players; null once disconnected
    players: [], // [{ name, disconnected }]
    host: 0,
    started: false,
    state: null,
    firstPlayer: 0, // rotates each rematch
  };
  rooms.set(room.code, room);
  return room;
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  room.sockets.forEach((ws) => sendTo(ws, msg));
}

function broadcastLobby(room) {
  room.sockets.forEach((ws, i) => {
    sendTo(ws, {
      type: 'lobby',
      v: GAME_VERSION,
      code: room.code,
      you: i,
      host: room.host,
      players: room.players.map((p) => ({ name: p.name })),
    });
  });
}

function broadcastState(room, event) {
  broadcast(room, { type: 'state', v: GAME_VERSION, state: room.state, event });
}

function cleanName(raw) {
  return String(raw || 'Player').replace(/[^\w !?'.-]/g, '').trim().slice(0, 14) || 'Player';
}

// ---------- websocket handling ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
      sendTo(ws, { type: 'error', message: 'Something went wrong on the server.' });
    }
  });

  ws.on('close', () => handleLeave(ws));
});

function handleMessage(ws, msg) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

  switch (msg.type) {
    case 'create': {
      if (room) return;
      const r = makeRoom();
      r.players.push({ name: cleanName(msg.name) });
      r.sockets.push(ws);
      ws.roomCode = r.code;
      ws.playerIdx = 0;
      broadcastLobby(r);
      break;
    }

    case 'join': {
      if (room) return;
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) return sendTo(ws, { type: 'error', message: 'No room with that code.' });
      if (r.started) return sendTo(ws, { type: 'error', message: 'That game already started.' });
      if (r.players.length >= 5) return sendTo(ws, { type: 'error', message: 'That room is full (5 players max).' });
      r.players.push({ name: cleanName(msg.name) });
      r.sockets.push(ws);
      ws.roomCode = r.code;
      ws.playerIdx = r.players.length - 1;
      broadcastLobby(r);
      break;
    }

    case 'start': {
      if (!room || room.started) return;
      if (ws.playerIdx !== room.host) return;
      if (room.players.length < 2) return;
      room.started = true;
      room.state = newGame(room.players.map((p) => ({ name: p.name })), room.firstPlayer);
      broadcastState(room, { kind: 'start' });
      break;
    }

    case 'ping':
      break;

    case 'roll': {
      if (!room?.started) return;
      const phase = room.state.phase;
      if (phase !== 'roll' && phase !== 'blocked') return;
      if (ws.playerIdx !== room.state.current) return;
      const dice = rollDice();
      const by = room.players[ws.playerIdx].name;
      const result = applyRoll(room.state, dice); // 'place' | 'blocked' | 'reroll'
      broadcastState(room, { kind: result === 'place' ? 'roll' : result, dice, by });
      break;
    }

    case 'place': {
      if (!room?.started) return;
      const phase = room.state.phase;
      if (phase !== 'place' && phase !== 'blocked') return;
      if (ws.playerIdx !== room.state.current) return;
      const r = Number(msg.r);
      const c = Number(msg.c);
      if (!isLegal(room.state, r, c)) return;
      const by = room.players[ws.playerIdx].name;
      const { result, stolen } = applyPlace(room.state, r, c);
      broadcastState(room, { kind: result === 'next' ? 'place' : result, cell: [r, c], stolen, by });
      break;
    }

    case 'again': {
      if (!room?.started || room.state.phase !== 'over') return;
      if (ws.playerIdx !== room.host) return;
      room.firstPlayer = (room.firstPlayer + 1) % room.players.length;
      const players = room.players.map((p) => ({ name: p.name, disconnected: p.disconnected }));
      room.state = newGame(players, room.firstPlayer);
      // Don't hand the first turn to someone who already left.
      if (room.state.players[room.state.current].disconnected) nextPlayer(room.state);
      broadcastState(room, { kind: 'start' });
      break;
    }
  }
}

function handleLeave(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const idx = ws.playerIdx;

  if (!room.started) {
    room.players.splice(idx, 1);
    room.sockets.splice(idx, 1);
    room.sockets.forEach((s, i) => { if (s) s.playerIdx = i; });
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      if (room.host >= room.players.length) room.host = 0;
      broadcastLobby(room);
    }
    return;
  }

  // Mid-game: mark the player as gone and skip their turns.
  const name = room.players[idx].name;
  room.players[idx].disconnected = true;
  room.state.players[idx].disconnected = true;
  room.sockets[idx] = null;

  if (room.sockets.every((s) => s === null)) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === idx) {
    room.host = room.sockets.findIndex((s) => s !== null);
  }
  if (room.state.phase !== 'over' && room.state.current === idx) {
    // Advance past the departed player.
    let n = room.state.current;
    do { n = (n + 1) % room.state.players.length; } while (room.state.players[n].disconnected && n !== idx);
    room.state.current = n;
    room.state.phase = 'roll';
    room.state.dice = null;
  }
  broadcastState(room, { kind: 'left', name });
}

// Keep connections alive through proxies; drop dead sockets.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`RINGO is ready → http://localhost:${PORT}`);
});
