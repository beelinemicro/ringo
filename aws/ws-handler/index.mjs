// RINGO WebSocket handler — the AWS Lambda twin of server.js.
//
// API Gateway WebSocket routes ($connect / $disconnect / $default) all land
// here. Room state lives in DynamoDB (single table, on-demand):
//   ROOM#<code> — players, host, started flag, game state, rematch rotation
//   CONN#<id>   — reverse lookup so $disconnect can find its room
//
// The deploy script copies public/js/game.js next to this file so the exact
// same rules run in the cloud, in the browser, and in local server.js.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { GAME_VERSION, newGame, rollDice, applyRoll, applyPlace, isLegal, nextPlayer } from './game.js';

const TABLE = process.env.RINGO_TABLE || 'ringo';
const TTL_HOURS = 24;

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

async function saveRoom(room) {
  room.ttl = ttl();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: room }));
}

async function deleteRoom(room) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: room.pk } }));
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

async function makeCode() {
  for (let tries = 0; tries < 10; tries++) {
    const code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    if (!(await getRoom(code))) return code;
  }
  throw new Error('could not allocate a room code');
}

// ---------- message handling ----------

async function onMessage(connId, msg) {
  switch (msg.type) {
    case 'ping':
      return;

    case 'create': {
      const code = await makeCode();
      const room = {
        pk: `ROOM#${code}`,
        code,
        players: [{ name: cleanName(msg.name), connectionId: connId, disconnected: false }],
        host: 0,
        started: false,
        state: null,
        firstPlayer: 0,
      };
      await mapConnection(connId, code, 0);
      await saveRoom(room);
      await broadcastLobby(room);
      return;
    }

    case 'join': {
      const room = await getRoom(String(msg.code || '').toUpperCase());
      if (!room) return sendTo(connId, { type: 'error', message: 'No room with that code.' });
      if (room.started) return sendTo(connId, { type: 'error', message: 'That game already started.' });
      if (room.players.length >= 4) return sendTo(connId, { type: 'error', message: 'That room is full (4 players max).' });
      room.players.push({ name: cleanName(msg.name), connectionId: connId, disconnected: false });
      await mapConnection(connId, room.code, room.players.length - 1);
      await saveRoom(room);
      await broadcastLobby(room);
      return;
    }
  }

  // Everything below needs an existing room membership.
  const conn = await getItem(`CONN#${connId}`);
  if (!conn) return;
  const room = await getRoom(conn.code);
  if (!room) return;
  const idx = conn.idx;

  switch (msg.type) {
    case 'start': {
      if (room.started || idx !== room.host || room.players.length < 2) return;
      room.started = true;
      room.state = newGame(room.players.map((p) => ({ name: p.name })), room.firstPlayer);
      await saveRoom(room);
      await broadcastState(room, { kind: 'start' });
      return;
    }

    case 'roll': {
      if (!room.started) return;
      const phase = room.state.phase;
      if (phase !== 'roll' && phase !== 'blocked') return;
      if (idx !== room.state.current) return;
      const dice = rollDice();
      const by = room.players[idx].name;
      const result = applyRoll(room.state, dice); // 'place' | 'blocked' | 'reroll'
      await saveRoom(room);
      await broadcastState(room, { kind: result === 'place' ? 'roll' : result, dice, by });
      return;
    }

    case 'place': {
      if (!room.started) return;
      const phase = room.state.phase;
      if (phase !== 'place' && phase !== 'blocked') return;
      if (idx !== room.state.current) return;
      const r = Number(msg.r);
      const c = Number(msg.c);
      if (!isLegal(room.state, r, c)) return;
      const by = room.players[idx].name;
      const { result, stolen } = applyPlace(room.state, r, c);
      await saveRoom(room);
      await broadcastState(room, { kind: result === 'next' ? 'place' : result, cell: [r, c], stolen, by });
      return;
    }

    case 'again': {
      if (!room.started || room.state.phase !== 'over' || idx !== room.host) return;
      room.firstPlayer = (room.firstPlayer + 1) % room.players.length;
      room.state = newGame(
        room.players.map((p) => ({ name: p.name, disconnected: p.disconnected })),
        room.firstPlayer,
      );
      // Don't hand the first turn to someone who already left.
      if (room.state.players[room.state.current].disconnected) nextPlayer(room.state);
      await saveRoom(room);
      await broadcastState(room, { kind: 'start' });
      return;
    }
  }
}

// ---------- disconnect ----------

async function onDisconnect(connId) {
  const conn = await getItem(`CONN#${connId}`);
  if (conn) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `CONN#${connId}` } }));
  if (!conn) return;
  const room = await getRoom(conn.code);
  if (!room) return;
  const idx = conn.idx;
  // Stale mapping (e.g. this seat was re-numbered after a lobby leave).
  if (!room.players[idx] || room.players[idx].connectionId !== connId) return;

  if (!room.started) {
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      await deleteRoom(room);
      return;
    }
    if (room.host >= room.players.length) room.host = 0;
    // Seats shifted — refresh every remaining connection's mapping.
    await Promise.all(room.players.map((p, i) => mapConnection(p.connectionId, room.code, i)));
    await saveRoom(room);
    await broadcastLobby(room);
    return;
  }

  // Mid-game: mark the player as gone and skip their turns.
  const name = room.players[idx].name;
  room.players[idx].disconnected = true;
  room.players[idx].connectionId = null;
  room.state.players[idx].disconnected = true;

  if (room.players.every((p) => p.disconnected)) {
    await deleteRoom(room);
    return;
  }
  if (room.host === idx) {
    room.host = room.players.findIndex((p) => !p.disconnected);
  }
  if (room.state.phase !== 'over' && room.state.current === idx) {
    nextPlayer(room.state);
    room.state.phase = 'roll';
    room.state.dice = null;
  }
  await saveRoom(room);
  await broadcastState(room, { kind: 'left', name });
}
