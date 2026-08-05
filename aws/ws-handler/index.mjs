// RINGO WebSocket handler — the AWS Lambda twin of server.js.
//
// API Gateway WebSocket routes ($connect / $disconnect / $default) all land
// here. Room state lives in DynamoDB (single table, on-demand):
//   ROOM#<code> — players, host, started flag, game state, rematch rotation
//   CONN#<id>   — reverse lookup so $disconnect can find its room
//
// Writes use optimistic locking: every room carries a `rev` counter and saves
// are conditional on the rev they read. Simultaneous joins (five family
// members tapping the same code at once) retry instead of clobbering each
// other.
//
// The deploy script copies public/js/game.js next to this file so the exact
// same rules run in the cloud, in the browser, and in local server.js.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
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
    await onMessage(connId, msg);
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
    players: room.players.map((q) => ({ name: q.name })),
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

async function onMessage(connId, msg) {
  switch (msg.type) {
    case 'ping':
      return;

    case 'create': {
      for (let tries = 0; tries < 10; tries++) {
        const code = randomCode();
        const room = {
          pk: `ROOM#${code}`,
          code,
          rev: 0,
          players: [{ name: cleanName(msg.name), connectionId: connId, disconnected: false }],
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
        r.players.push({ name: cleanName(msg.name), connectionId: connId, disconnected: false });
        seat = r.players.length - 1;
        return true;
      });
      if (!room) return sendTo(connId, { type: 'error', message: 'No room with that code.' });
      if (out === false) return sendTo(connId, { type: 'error', message: err });
      await mapConnection(connId, code, seat);
      await broadcastLobby(room);
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
        if (r.started || idx !== r.host || r.players.length < 2) return false;
        r.started = true;
        r.state = newGame(r.players.map((p) => ({ name: p.name })), r.firstPlayer);
        return true;
      });
      if (room && out === true) await broadcastState(room, { kind: 'start' });
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
      r.players.splice(idx, 1);
      if (r.players.length === 0) return 'delete';
      if (r.host >= r.players.length) r.host = 0;
      mode = 'lobby';
      return true;
    }

    // Mid-game: mark the player as gone and skip their turns.
    name = r.players[idx].name;
    r.players[idx].disconnected = true;
    r.players[idx].connectionId = null;
    r.state.players[idx].disconnected = true;
    if (r.players.every((p) => p.disconnected)) return 'delete';
    if (r.host === idx) r.host = r.players.findIndex((p) => !p.disconnected);
    if (r.state.phase !== 'over' && r.state.current === idx) {
      nextPlayer(r.state);
      r.state.phase = 'roll';
      r.state.dice = null;
    }
    mode = 'game';
    return true;
  });

  if (!room || out !== true) return;
  if (mode === 'lobby') {
    // Seats shifted — refresh every remaining connection's mapping.
    await Promise.all(room.players.map((p, i) => mapConnection(p.connectionId, room.code, i)));
    await broadcastLobby(room);
  } else if (mode === 'game') {
    await broadcastState(room, { kind: 'left', name });
  }
}
