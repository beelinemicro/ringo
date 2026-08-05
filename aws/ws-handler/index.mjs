// RINGO WebSocket handler — the AWS Lambda twin of server.js.
//
// API Gateway WebSocket routes ($connect / $disconnect / $default) all land
// here. Room state lives in DynamoDB (single table, on-demand):
//   ROOM#<code>     — players, host, started flag, game state, rematch rotation
//   CONN#<id>       — reverse lookup so $disconnect can find its room
//   PRESENCE#<id>   — one per open page (the client says 'hello' on load);
//                     short TTL, refreshed by keepalive pings, so the live
//                     "people here now" count self-heals from missed disconnects
//   LOG#<utc>#<id>  — permanent visit log: UTC + Central time and source IP
//
// Writes use optimistic locking: every room carries a `rev` counter and saves
// are conditional on the rev they read. Simultaneous joins (five family
// members tapping the same code at once) retry instead of clobbering each
// other.
//
// The deploy script copies public/js/game.js next to this file so the exact
// same rules run in the cloud, in the browser, and in local server.js.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { GAME_VERSION, newGame, rollDice, applyRoll, applyPlace, isLegal, nextPlayer } from './game.js';

const TABLE = process.env.RINGO_TABLE || 'ringo';
const TTL_HOURS = 24;
const MAX_ROOM_PLAYERS = 5;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
let mgmt = null;

export const handler = async (event) => {
  const rc = event.requestContext;
  mgmt = new ApiGatewayManagementApiClient({ endpoint: `https://${rc.domainName}/${rc.stage}` });
  const connId = rc.connectionId;

  if (rc.routeKey === '$connect') return { statusCode: 200 };
  if (rc.routeKey === '$disconnect') {
    await onDisconnect(connId).catch((e) => console.error('disconnect:', e));
    return { statusCode: 200 };
  }

  let msg;
  try {
    msg = JSON.parse(event.body);
  } catch {
    return { statusCode: 200 };
  }
  try {
    await onMessage(connId, msg, rc.identity?.sourceIp);
  } catch (e) {
    console.error('message handler:', e);
    await sendTo(connId, { type: 'error', message: 'Something went wrong on the server.' });
  }
  return { statusCode: 200 };
};

// ---------- storage ----------

const ttl = () => Math.floor(Date.now() / 1000) + TTL_HOURS * 3600;

async function getItem(pk) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk } }));
  return r.Item || null;
}

const getRoom = (code) => getItem(`ROOM#${code}`);

// Conditional save: succeeds only if the stored rev still matches the one we
// read. Returns false on a lost race so the caller can reload and retry.
async function trySaveRoom(room) {
  const prev = room.rev || 0;
  room.rev = prev + 1;
  room.ttl = ttl();
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: room,
      ConditionExpression: 'attribute_not_exists(pk) OR rev = :prev',
      ExpressionAttributeValues: { ':prev': prev },
    }));
    return true;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      room.rev = prev;
      return false;
    }
    throw e;
  }
}

// Load-mutate-save with retry. The mutator returns:
//   true     — save the room
//   'delete' — remove the room instead
//   false    — validation failed; save nothing
// Returns { room, out } where room is null if the code doesn't exist.
async function mutateRoom(code, mutator) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = await getRoom(code);
    if (!room) return { room: null, out: null };
    const out = mutator(room);
    if (out === false) return { room, out };
    if (out === 'delete') {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: room.pk } }));
      return { room, out };
    }
    if (await trySaveRoom(room)) return { room, out };
  }
  throw new Error(`room ${code}: too much write contention`);
}

async function mapConnection(connId, code, idx) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `CONN#${connId}`, code, idx, ttl: ttl() },
  }));
}

// ---------- presence & usage log ----------

const PRESENCE_TTL_MIN = 15; // clients ping every 4 min; survives a couple misses

const presenceTtl = () => Math.floor(Date.now() / 1000) + PRESENCE_TTL_MIN * 60;

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

// One log entry per page visit. No ttl attribute, so unlike rooms these
// items never expire — this is the permanent usage log.
async function logVisit(connId, ip) {
  const now = new Date();
  const utc = now.toISOString();
  const central = centralTime(now);
  console.log(`visit: ${utc}  ${central}  ${ip}`);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `LOG#${utc}#${connId.slice(0, 8)}`, utc, central, ip: ip || 'unknown' },
  }));
}

// Everyone currently on the site (unexpired PRESENCE items).
async function presenceConnIds() {
  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  let key;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(pk, :p) AND #ttl > :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':p': 'PRESENCE#', ':now': now },
      ExclusiveStartKey: key,
    }));
    for (const it of r.Items || []) ids.push(it.pk.slice('PRESENCE#'.length));
    key = r.LastEvaluatedKey;
  } while (key);
  return ids;
}

async function broadcastPresence() {
  const ids = await presenceConnIds();
  const msg = { type: 'presence', v: GAME_VERSION, count: ids.length };
  await Promise.all(ids.map((id) => sendTo(id, msg)));
}

// ---------- messaging ----------

async function sendTo(connId, msg) {
  if (!connId) return false;
  try {
    await mgmt.send(new PostToConnectionCommand({
      ConnectionId: connId,
      Data: JSON.stringify(msg),
    }));
    return true;
  } catch {
    return false; // gone/stale connection
  }
}

async function broadcastLobby(room) {
  await Promise.all(room.players.map((p, i) => sendTo(p.connectionId, {
    type: 'lobby',
    v: GAME_VERSION,
    code: room.code,
    you: i,
    host: room.host,
    token: p.token, // secret; lets this player rejoin later
    players: room.players.map((q) => ({ name: q.name, away: !!q.disconnected })),
  })));
}

async function broadcastState(room, event) {
  await Promise.all(room.players.map((p) =>
    sendTo(p.connectionId, { type: 'state', v: GAME_VERSION, state: room.state, event })));
}

function cleanName(raw) {
  return String(raw || 'Player').replace(/[^\w !?'.-]/g, '').trim().slice(0, 14) || 'Player';
}

// No ambiguous letters (I/L/O look like 1/0).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const randomCode = () => Array.from({ length: 4 }, () =>
  CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

// ---------- message handling ----------

async function onMessage(connId, msg, ip) {
  switch (msg.type) {
    case 'ping':
      return;

    // Sent once when a page loads: registers this connection as "on the
    // site", records the visit, and pushes the fresh count to everyone.
    case 'hello': {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `PRESENCE#${connId}`, ttl: presenceTtl() },
      }));
      await logVisit(connId, ip);
      await broadcastPresence();
      return;
    }

    // Keepalive from a presence connection — just refresh its TTL.
    case 'presence-ping': {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `PRESENCE#${connId}` },
        UpdateExpression: 'SET #ttl = :t',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':t': presenceTtl() },
      })).catch(() => {}); // expired-and-swept item; next hello re-registers
      return;
    }

    case 'create': {
      for (let tries = 0; tries < 10; tries++) {
        const code = randomCode();
        const room = {
          pk: `ROOM#${code}`,
          code,
          rev: 0,
          players: [{ name: cleanName(msg.name), connectionId: connId, disconnected: false, token: crypto.randomUUID() }],
          host: 0,
          started: false,
          state: null,
          firstPlayer: 0,
        };
        if (await getRoom(code)) continue;
        if (await trySaveRoom(room)) {
          await mapConnection(connId, code, 0);
          await broadcastLobby(room);
          return;
        }
      }
      throw new Error('could not allocate a room code');
    }

    case 'join': {
      const code = String(msg.code || '').toUpperCase();
      let err = null;
      let seat = -1;
      const { room, out } = await mutateRoom(code, (r) => {
        err = null;
        if (r.started) { err = 'That game already started.'; return false; }
        if (r.players.length >= MAX_ROOM_PLAYERS) {
          err = `That room is full (${MAX_ROOM_PLAYERS} players max).`;
          return false;
        }
        r.players.push({ name: cleanName(msg.name), connectionId: connId, disconnected: false, token: crypto.randomUUID() });
        seat = r.players.length - 1;
        return true;
      });
      if (!room) return sendTo(connId, { type: 'error', message: 'No room with that code.' });
      if (out === false) return sendTo(connId, { type: 'error', message: err });
      await mapConnection(connId, code, seat);
      await broadcastLobby(room);
      return;
    }

    // A player whose connection dropped mid-game reclaims their seat by
    // presenting the seat token they got when they first joined.
    case 'rejoin': {
      const code = String(msg.code || '').toUpperCase();
      const token = String(msg.token || '');
      let seat = -1;
      let name = null;
      const { room, out } = await mutateRoom(code, (r) => {
        seat = token ? r.players.findIndex((p) => p.token === token) : -1;
        if (seat === -1) return false;
        r.players[seat].connectionId = connId;
        r.players[seat].disconnected = false;
        if (r.started) r.state.players[seat].disconnected = false;
        name = r.players[seat].name;
        return true;
      });
      if (!room || out !== true) return sendTo(connId, { type: 'rejoin-failed', v: GAME_VERSION });
      await mapConnection(connId, code, seat);
      if (!room.started) return broadcastLobby(room); // back in the lobby
      await sendTo(connId, {
        type: 'rejoined', v: GAME_VERSION,
        code, you: seat, host: room.host, token,
      });
      await broadcastState(room, { kind: 'rejoined', name });
      return;
    }
  }

  // Everything below needs an existing room membership.
  const conn = await getItem(`CONN#${connId}`);
  if (!conn) return;
  const idx = conn.idx;

  switch (msg.type) {
    case 'start': {
      const { room, out } = await mutateRoom(conn.code, (r) => {
        if (r.started || idx !== r.host) return false;
        // Prune ghosts — lobby seats whose players dropped and never returned.
        const host = r.players[idx];
        r.players = r.players.filter((p) => !p.disconnected);
        r.host = r.players.indexOf(host);
        if (r.players.length < 2) return false;
        r.firstPlayer %= r.players.length;
        r.started = true;
        r.state = newGame(r.players.map((p) => ({ name: p.name })), r.firstPlayer);
        return true;
      });
      if (room && out === true) {
        // Pruning may have re-numbered seats — refresh every mapping.
        await Promise.all(room.players.map((p, i) => mapConnection(p.connectionId, room.code, i)));
        await broadcastState(room, { kind: 'start' });
      }
      return;
    }

    // Deliberately giving up a lobby seat (the Leave button). A silent
    // disconnect keeps the seat instead — phones drop the socket the moment
    // the browser is backgrounded (e.g. to text the invite link).
    case 'leave': {
      const { room, out } = await mutateRoom(conn.code, (r) => {
        if (r.started) return false; // mid-game leave = plain disconnect
        if (!r.players[idx] || r.players[idx].connectionId !== connId) return false;
        r.players.splice(idx, 1);
        if (r.players.length === 0) return 'delete';
        if (idx < r.host) r.host -= 1;
        else if (idx === r.host) r.host = 0;
        if (r.host >= r.players.length) r.host = 0;
        return true;
      });
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `CONN#${connId}` } }));
      if (room && out === true) {
        // Seats shifted — refresh every remaining connection's mapping.
        await Promise.all(room.players.map((p, i) =>
          p.connectionId ? mapConnection(p.connectionId, room.code, i) : null));
        await broadcastLobby(room);
      }
      return;
    }

    case 'roll': {
      let event = null;
      const { room, out } = await mutateRoom(conn.code, (r) => {
        event = null;
        if (!r.started) return false;
        const phase = r.state.phase;
        if (phase !== 'roll' && phase !== 'blocked') return false;
        if (idx !== r.state.current) return false;
        const dice = rollDice();
        const result = applyRoll(r.state, dice); // 'place' | 'blocked' | 'reroll'
        event = { kind: result === 'place' ? 'roll' : result, dice, by: r.players[idx].name };
        return true;
      });
      if (room && out === true) await broadcastState(room, event);
      return;
    }

    case 'place': {
      let event = null;
      const { room, out } = await mutateRoom(conn.code, (r) => {
        event = null;
        if (!r.started) return false;
        const phase = r.state.phase;
        if (phase !== 'place' && phase !== 'blocked') return false;
        if (idx !== r.state.current) return false;
        const row = Number(msg.r);
        const col = Number(msg.c);
        if (!isLegal(r.state, row, col)) return false;
        const { result, stolen } = applyPlace(r.state, row, col);
        event = {
          kind: result === 'next' ? 'place' : result,
          cell: [row, col],
          stolen,
          by: r.players[idx].name,
        };
        return true;
      });
      if (room && out === true) await broadcastState(room, event);
      return;
    }

    case 'rename': {
      let evt = null;
      const { room, out } = await mutateRoom(conn.code, (r) => {
        evt = null;
        const p = r.players[idx];
        if (!p || p.disconnected) return false;
        const to = cleanName(msg.name);
        if (to === p.name) return false;
        evt = { kind: 'rename', from: p.name, to };
        p.name = to;
        if (r.started && r.state.players[idx]) r.state.players[idx].name = to;
        return true;
      });
      if (room && out === true) {
        if (!room.started) await broadcastLobby(room);
        else await broadcastState(room, evt);
      }
      return;
    }

    case 'again': {
      const { room, out } = await mutateRoom(conn.code, (r) => {
        if (!r.started || r.state.phase !== 'over' || idx !== r.host) return false;
        r.firstPlayer = (r.firstPlayer + 1) % r.players.length;
        r.state = newGame(
          r.players.map((p) => ({ name: p.name, disconnected: p.disconnected })),
          r.firstPlayer,
        );
        // Don't hand the first turn to someone who already left.
        if (r.state.players[r.state.current].disconnected) nextPlayer(r.state);
        return true;
      });
      if (room && out === true) await broadcastState(room, { kind: 'start' });
      return;
    }
  }
}

// ---------- disconnect ----------

async function onDisconnect(connId) {
  // Presence connection closing (tab closed / navigated away)?
  const pres = await getItem(`PRESENCE#${connId}`);
  if (pres) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `PRESENCE#${connId}` } }));
    await broadcastPresence();
  }

  const conn = await getItem(`CONN#${connId}`);
  if (conn) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `CONN#${connId}` } }));
  if (!conn) return;

  let mode = null; // 'lobby' | 'game' | null
  let name = null;
  const { room, out } = await mutateRoom(conn.code, (r) => {
    mode = null;
    const idx = conn.idx;
    // Stale mapping (e.g. this seat was re-numbered after a lobby leave).
    if (!r.players[idx] || r.players[idx].connectionId !== connId) return false;

    if (!r.started) {
      // Keep the seat — this is usually a phone backgrounding the browser
      // for a moment. The player rejoins by token; 'start' prunes any
      // lingering ghosts and the room itself expires via TTL.
      r.players[idx].disconnected = true;
      r.players[idx].connectionId = null;
      mode = 'lobby';
      return true;
    }

    // Mid-game: mark the player as gone and skip their turns. Even with
    // everyone disconnected the room survives (phones may all be
    // backgrounded at once) — TTL reclaims it if nobody returns.
    name = r.players[idx].name;
    r.players[idx].disconnected = true;
    r.players[idx].connectionId = null;
    r.state.players[idx].disconnected = true;
    if (r.host === idx && r.players.some((p) => !p.disconnected)) {
      r.host = r.players.findIndex((p) => !p.disconnected);
    }
    if (r.state.phase !== 'over' && r.state.current === idx && r.players.some((p) => !p.disconnected)) {
      nextPlayer(r.state);
      r.state.phase = 'roll';
      r.state.dice = null;
    }
    mode = 'game';
    return true;
  });

  if (!room || out !== true) return;
  if (mode === 'lobby') await broadcastLobby(room);
  else if (mode === 'game') await broadcastState(room, { kind: 'left', name });
}
