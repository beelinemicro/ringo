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
import { chooseCell, chooseSteal } from './public/js/ai.js';

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

// ---------- presence & usage log ----------

const presence = new Set(); // sockets that said 'hello' (one per open page)

// "2026-08-05 14:03:22 CDT" — Intl handles the CST/CDT switch for us.
function centralTime(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

// Overridable so the test suite can sandbox its writes.
const USAGE_LOG = process.env.RINGO_USAGE_LOG
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage.log');

function logVisit(ip) {
  const now = new Date();
  const line = `${now.toISOString()}  ${centralTime(now)}  ${ip || 'unknown'}`;
  console.log(`visit: ${line}`);
  fs.appendFile(USAGE_LOG, `${line}\n`, (err) => {
    if (err) console.error('usage log:', err);
  });
}

function broadcastPresence() {
  const msg = { type: 'presence', v: GAME_VERSION, count: presence.size };
  presence.forEach((ws) => sendTo(ws, msg));
}

// ---------- hall of fame ----------

const STATS_FILE = process.env.RINGO_STATS_FILE
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'stats.json');

// { players: { key: {name, wins, losses, streak, bestStreak, legendary} },
//   h2h:     { 'a|b': {aName, bName, aWins, bWins} },
//   legends: [ {name, lines, utc, central, code, isBot} ] }
let stats = { players: {}, h2h: {}, legends: [] };
try {
  const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  stats = raw.players ? raw : { players: raw, h2h: {} }; // migrate the old flat shape
  stats.legends = stats.legends || [];
} catch { /* first run */ }

const byRank = (a, b) => b.wins - a.wins || a.losses - b.losses;

function topStats() {
  return Object.values(stats.players).sort(byRank).slice(0, 5);
}

// Everything for the "Full family stats" view: the whole leaderboard plus
// every rivalry, biggest first.
function fullStats() {
  return {
    players: Object.values(stats.players).sort(byRank),
    h2h: Object.values(stats.h2h)
      .map((x) => ({ a: x.aName, b: x.bName, aWins: x.aWins, bWins: x.bWins }))
      .sort((p, q) => (q.aWins + q.bWins) - (p.aWins + p.bWins)),
    legends: [...stats.legends].sort((a, b) => (a.utc < b.utc ? 1 : -1)),
  };
}

// Menus refresh live: everyone on the site gets the new standings the
// moment a game ends.
function broadcastStats() {
  const msg = { type: 'stats', v: GAME_VERSION, top: topStats() };
  presence.forEach((ws) => sendTo(ws, msg));
}

function recordResult(room) {
  const winner = room.state.winner;
  const lines = (room.state.winLines || []).length || 1;
  const humans = room.state.players
    .map((p, i) => ({ name: p.name, key: p.name.trim().toLowerCase(), i }))
    .filter((p) => !room.state.players[p.i].isBot && p.key); // bots never make the board

  humans.forEach((p) => {
    const won = p.i === winner;
    const s = stats.players[p.key]
      || (stats.players[p.key] = { name: p.name, wins: 0, losses: 0, streak: 0, bestStreak: 0, legendary: 0 });
    s.name = p.name; // keep the latest capitalization
    if (won) s.wins++;
    else s.losses++;
    s.streak = won ? (s.streak || 0) + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak || 0, s.streak);
    if (won && lines >= 2) s.legendary = (s.legendary || 0) + 1;
  });

  // A multi-line finish goes in the permanent book of legends — even a
  // bot's (the family will want to remember the betrayal).
  if (lines >= 2) {
    const wp = room.state.players[winner];
    const now = new Date();
    stats.legends.push({
      name: wp.name, lines, utc: now.toISOString(), central: centralTime(now),
      code: room.code, isBot: !!wp.isBot,
    });
  }

  // Head-to-head: the winner logs a result against every other human.
  const w = humans.find((p) => p.i === winner);
  if (w) {
    humans.filter((p) => p.i !== winner).forEach((p) => {
      const [a, b] = [w, p].sort((x, y) => (x.key < y.key ? -1 : 1));
      const r = stats.h2h[`${a.key}|${b.key}`]
        || (stats.h2h[`${a.key}|${b.key}`] = { aName: a.name, bName: b.name, aWins: 0, bWins: 0 });
      r.aName = a.name;
      r.bName = b.name;
      if (a === w) r.aWins++;
      else r.bWins++;
    });
  }

  fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), (err) => {
    if (err) console.error('stats:', err);
  });
  broadcastStats();
}

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
      token: room.players[i].token, // secret; lets this player rejoin later
      players: room.players.map((p) => ({ name: p.name, away: !!p.disconnected, isBot: !!p.isBot, level: p.level })),
    });
  });
}

function broadcastState(room, event) {
  broadcast(room, { type: 'state', v: GAME_VERSION, state: room.state, event });
}

function cleanName(raw) {
  return String(raw || 'Player').replace(/[^\w !?'.-]/g, '').trim().slice(0, 14) || 'Player';
}

// ---------- bots ----------

const BOT_NAMES = ['Chip', 'Sparky', 'Gizmo', 'Bolt'];
const BOT_LEVELS = ['easy', 'normal', 'hard'];

// ~1s between bot actions feels human; the test suite turns it way down.
const BOT_DELAY = Number(process.env.RINGO_BOT_DELAY || 850);

const cleanLevel = (l) => (BOT_LEVELS.includes(l) ? l : 'normal');

const REACTIONS = ['🎉', '😂', '😱', '😈', '💪', '❤️'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plays out consecutive bot turns, broadcasting each roll and placement so
// clients animate them exactly like human moves.
async function runBots(room) {
  if (room.botsBusy) return; // one driver per room at a time
  room.botsBusy = true;
  try {
    while (rooms.has(room.code) && room.started && room.state.phase !== 'over') {
      const st = room.state;
      const bot = room.players[st.current];
      if (!bot?.isBot) return;
      if (!room.players.some((p, i) => !p.isBot && room.sockets[i])) return; // nobody watching
      await sleep(BOT_DELAY);
      if (!rooms.has(room.code) || !room.started || st !== room.state || st.phase === 'over') return;

      let cell = null;
      if (st.phase === 'place') cell = chooseCell(st, bot.level);
      else if (st.phase === 'blocked') cell = chooseSteal(st, bot.level);

      let event;
      if (cell) {
        const { result, stolen } = applyPlace(st, cell[0], cell[1]);
        event = { kind: result === 'next' ? 'place' : result, cell, stolen, by: bot.name };
      } else {
        // 'roll' phase, or blocked and not worth stealing — roll (again).
        const dice = rollDice();
        const result = applyRoll(st, dice);
        event = { kind: result === 'place' ? 'roll' : result, dice, by: bot.name };
      }
      broadcastState(room, event);
      if (event.kind === 'win') return recordResult(room);
    }
  } finally {
    room.botsBusy = false;
  }
}

// ---------- websocket handling ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
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

  ws.on('close', () => {
    if (presence.delete(ws)) broadcastPresence();
    handleLeave(ws);
  });
});

function handleMessage(ws, msg) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

  switch (msg.type) {
    // Sent once when a page loads: registers this connection as "on the
    // site", records the visit, and pushes the fresh count to everyone.
    case 'hello': {
      presence.add(ws);
      logVisit(ws.ip);
      broadcastPresence();
      sendTo(ws, { type: 'stats', v: GAME_VERSION, top: topStats() });
      break;
    }

    case 'presence-ping': // keepalive only matters for API Gateway
      break;

    // The "Full family stats" view, requested over the presence socket.
    case 'fullstats':
      sendTo(ws, { type: 'fullstats', v: GAME_VERSION, ...fullStats() });
      break;

    case 'create': {
      if (room) return;
      const r = makeRoom();
      r.players.push({ name: cleanName(msg.name), token: crypto.randomUUID() });
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
      r.players.push({ name: cleanName(msg.name), token: crypto.randomUUID() });
      r.sockets.push(ws);
      ws.roomCode = r.code;
      ws.playerIdx = r.players.length - 1;
      broadcastLobby(r);
      break;
    }

    // A player whose connection dropped mid-game reclaims their seat by
    // presenting the seat token they got when they first joined.
    case 'rejoin': {
      if (room) return; // this socket is already seated somewhere
      const r = rooms.get(String(msg.code || '').toUpperCase());
      const token = String(msg.token || '');
      const idx = r && token ? r.players.findIndex((p) => p.token === token) : -1;
      if (!r || idx === -1) {
        return sendTo(ws, { type: 'rejoin-failed', v: GAME_VERSION });
      }
      const old = r.sockets[idx];
      if (old && old !== ws) { old.roomCode = null; old.close(); } // stale socket
      r.sockets[idx] = ws;
      ws.roomCode = r.code;
      ws.playerIdx = idx;
      r.players[idx].disconnected = false;
      if (!r.started) { broadcastLobby(r); break; } // back in the lobby
      r.state.players[idx].disconnected = false;
      sendTo(ws, {
        type: 'rejoined', v: GAME_VERSION,
        code: r.code, you: idx, host: r.host, token,
      });
      broadcastState(r, { kind: 'rejoined', name: r.players[idx].name });
      break;
    }

    // Host fills an empty seat with a computer player.
    case 'addbot': {
      if (!room || room.started || ws.playerIdx !== room.host) return;
      if (room.players.length >= 5) return;
      const name = BOT_NAMES.find((n) => !room.players.some((p) => p.name === n));
      if (!name) return;
      room.players.push({ name, isBot: true, level: cleanLevel(msg.level) });
      room.sockets.push(null);
      broadcastLobby(room);
      break;
    }

    // Host cycles a bot's difficulty: easy → normal → hard → easy.
    case 'botlevel': {
      if (!room || room.started || ws.playerIdx !== room.host) return;
      const p = room.players[Number(msg.i)];
      if (!p?.isBot) return;
      p.level = BOT_LEVELS[(BOT_LEVELS.indexOf(cleanLevel(p.level)) + 1) % BOT_LEVELS.length];
      broadcastLobby(room);
      break;
    }

    case 'removebot': {
      if (!room || room.started || ws.playerIdx !== room.host) return;
      const bi = Number(msg.i);
      if (!room.players[bi]?.isBot) return;
      room.players.splice(bi, 1);
      room.sockets.splice(bi, 1);
      room.sockets.forEach((s, i) => { if (s) s.playerIdx = i; });
      if (bi < room.host) room.host -= 1;
      broadcastLobby(room);
      break;
    }

    // Deliberately giving up a lobby seat (the Leave button). A silent
    // disconnect keeps the seat instead — phones drop the socket the moment
    // the browser is backgrounded (e.g. to text the invite link).
    case 'leave': {
      if (!room || room.started) return; // mid-game leave = plain disconnect
      const idx = ws.playerIdx;
      ws.roomCode = null;
      room.players.splice(idx, 1);
      room.sockets.splice(idx, 1);
      room.sockets.forEach((s, i) => { if (s) s.playerIdx = i; });
      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }
      if (idx < room.host) room.host -= 1;
      else if (idx === room.host) room.host = 0;
      if (room.host >= room.players.length) room.host = 0;
      broadcastLobby(room);
      break;
    }

    case 'start': {
      if (!room || room.started) return;
      if (ws.playerIdx !== room.host) return;
      // Prune ghosts — lobby seats whose players dropped and never returned.
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].disconnected) {
          room.players.splice(i, 1);
          room.sockets.splice(i, 1);
        }
      }
      room.sockets.forEach((s, i) => { if (s) s.playerIdx = i; });
      room.host = room.sockets.indexOf(ws);
      if (room.players.length < 2) {
        broadcastLobby(room);
        return;
      }
      room.firstPlayer %= room.players.length;
      room.started = true;
      room.state = newGame(room.players.map((p) => ({ name: p.name, isBot: p.isBot })), room.firstPlayer);
      broadcastState(room, { kind: 'start' });
      runBots(room);
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
      if (result === 'win') recordResult(room);
      else runBots(room);
      break;
    }

    // Emoji reaction — validated against the allowlist, stamped with the
    // sender's name, shown big on every screen in the room.
    case 'react': {
      if (!room?.started) return;
      if (!REACTIONS.includes(msg.e)) return;
      const now = Date.now();
      if (ws.lastReact && now - ws.lastReact < 900) return; // spam brake
      ws.lastReact = now;
      broadcast(room, { type: 'react', v: GAME_VERSION, e: msg.e, by: room.players[ws.playerIdx].name });
      break;
    }

    case 'rename': {
      if (!room) return;
      const idx = ws.playerIdx;
      const p = room.players[idx];
      if (!p || p.disconnected) return;
      const from = p.name;
      const to = cleanName(msg.name);
      if (to === from) return;
      p.name = to;
      if (room.started && room.state.players[idx]) room.state.players[idx].name = to;
      if (!room.started) broadcastLobby(room);
      else broadcastState(room, { kind: 'rename', from, to });
      break;
    }

    case 'again': {
      if (!room?.started || room.state.phase !== 'over') return;
      if (ws.playerIdx !== room.host) return;
      room.firstPlayer = (room.firstPlayer + 1) % room.players.length;
      const players = room.players.map((p) => ({ name: p.name, isBot: p.isBot, disconnected: p.disconnected }));
      room.state = newGame(players, room.firstPlayer);
      // Don't hand the first turn to someone who already left.
      if (room.state.players[room.state.current].disconnected) nextPlayer(room.state);
      broadcastState(room, { kind: 'start' });
      runBots(room);
      break;
    }
  }
}

function handleLeave(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const idx = ws.playerIdx;

  if (!room.started) {
    // Keep the seat — this is usually a phone backgrounding the browser
    // for a moment. The player rejoins by token; the room dies by sweeper
    // if nobody comes back, and 'start' prunes any lingering ghosts.
    room.players[idx].disconnected = true;
    room.sockets[idx] = null;
    broadcastLobby(room);
    return;
  }

  // Mid-game: mark the player as gone and skip their turns.
  const name = room.players[idx].name;
  room.players[idx].disconnected = true;
  room.state.players[idx].disconnected = true;
  room.sockets[idx] = null;

  // Even with everyone disconnected the room survives (phones may all be
  // backgrounded at once) — the sweeper below reclaims it after an hour.
  if (room.host === idx && room.sockets.some((s) => s !== null)) {
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
  runBots(room); // the departed player's turn may pass to a bot
}

// Reclaim rooms where every seat has been empty for an hour — nobody is
// coming back. (The Lambda version gets this for free from DynamoDB TTL.)
setInterval(() => {
  rooms.forEach((room, code) => {
    const dead = room.sockets.every((s) => s === null || s === undefined) && room.players.every((p) => p.disconnected);
    if (!dead) {
      room.emptySince = null;
    } else if (!room.emptySince) {
      room.emptySince = Date.now();
    } else if (Date.now() - room.emptySince > 3600_000) {
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

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
