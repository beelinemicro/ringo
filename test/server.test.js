// End-to-end tests for the room server (server.js).  Run: npm test
//
// Spawns the real server on a test port — sandboxed to a temp dir so
// usage.log / stats.json in the repo are untouched, with bot pacing turned
// way down — and drives it with real WebSocket clients through the whole
// online protocol: presence, stats, lobby life-cycle, invite-era seat
// tokens, silent-drop survival, rejoin, ghost pruning, bots and their
// difficulty levels, reactions, and a full game to a recorded win.
//
// The Lambda (aws/ws-handler) speaks the identical protocol; this suite is
// the regression net for both halves' shared behavior.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { selectableCells } from '../public/js/game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3210;
const URL = `ws://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ringo-test-'));
const STATS_FILE = path.join(TMP, 'stats.json');
const USAGE_LOG = path.join(TMP, 'usage.log');

// Whole-suite watchdog: a hung WebSocket must not hang CI forever.
const watchdog = setTimeout(() => {
  console.error('server tests timed out');
  process.exit(1);
}, 90_000);

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    RINGO_BOT_DELAY: '25',
    RINGO_USAGE_LOG: USAGE_LOG,
    RINGO_STATS_FILE: STATS_FILE,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function cleanup() {
  clearTimeout(watchdog);
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A test client: records every message, with polling helpers to await one.
function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.sendJ = (o) => ws.send(JSON.stringify(o));
    ws.last = (type) => [...ws.msgs].reverse().find((m) => m.type === type);
    ws.waitFor = async (type, pred = () => true, ms = 5000) => {
      const t0 = Date.now();
      for (;;) {
        const m = [...ws.msgs].reverse().find((x) => x.type === type && pred(x));
        if (m) return m;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for '${type}'`);
        await sleep(20);
      }
    };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('RINGO is ready')) resolve(); });
  server.on('exit', () => reject(new Error('server died on startup')));
  setTimeout(() => reject(new Error('server never became ready')), 5000);
});

try {
  // --- presence count, visit log, stats push on hello ---
  {
    const p1 = await client();
    p1.sendJ({ type: 'hello' });
    await p1.waitFor('presence', (m) => m.count === 1);
    await p1.waitFor('stats'); // menu standings arrive with the hello
    const p2 = await client();
    p2.sendJ({ type: 'hello' });
    await p1.waitFor('presence', (m) => m.count === 2);
    p2.close();
    await p1.waitFor('presence', (m) => m.count === 1);
    assert.equal(fs.readFileSync(USAGE_LOG, 'utf8').trim().split('\n').length, 2, 'one log line per visit');
    assert.match(fs.readFileSync(USAGE_LOG, 'utf8'), /C[SD]T/, 'log has Central time');
    p1.close();
    console.log('presence + usage log ✔');
  }

  // --- lobby: seat tokens, bots, difficulty levels, permissions ---
  {
    const host = await client();
    host.sendJ({ type: 'create', name: 'Steve' });
    const lobby = await host.waitFor('lobby');
    assert.match(lobby.code, /^[A-Z]{4}$/, 'room code shape');
    assert.ok(lobby.token, 'seat token issued');
    const guest = await client();
    guest.sendJ({ type: 'join', code: lobby.code, name: 'Dad' });
    await host.waitFor('lobby', (m) => m.players.length === 2);

    host.sendJ({ type: 'addbot', level: 'hard' });
    let m = await guest.waitFor('lobby', (x) => x.players.length === 3);
    assert.deepEqual(
      [m.players[2].isBot, m.players[2].level], [true, 'hard'],
      'bot arrives with isBot flag and level');
    host.sendJ({ type: 'botlevel', i: 2 });
    await host.waitFor('lobby', (x) => x.players[2]?.level === 'easy');
    guest.sendJ({ type: 'botlevel', i: 2 }); // not the host
    await sleep(150);
    assert.equal(host.last('lobby').players[2].level, 'easy', 'non-host cannot change difficulty');
    host.sendJ({ type: 'addbot', level: 'bogus' });
    m = await host.waitFor('lobby', (x) => x.players.length === 4);
    assert.equal(m.players[3].level, 'normal', 'unknown level sanitized');
    host.sendJ({ type: 'removebot', i: 3 });
    await host.waitFor('lobby', (x) => x.players.length === 3);
    host.close();
    guest.close();
    console.log('lobby: tokens, bots, levels ✔');
  }

  // --- silent drop keeps the lobby seat; rejoin reclaims it; leave frees it ---
  {
    const host = await client();
    host.sendJ({ type: 'create', name: 'Steve' });
    const seat = await host.waitFor('lobby');
    host.terminate(); // phone backgrounded mid-invite
    await sleep(150);

    const guest = await client();
    guest.sendJ({ type: 'join', code: seat.code, name: 'Dad' });
    const m = await guest.waitFor('lobby');
    assert.equal(m.players[0].away, true, 'room survived; host shown away');

    const back = await client();
    back.sendJ({ type: 'rejoin', code: seat.code, token: seat.token });
    const l2 = await back.waitFor('lobby');
    assert.deepEqual([l2.you, l2.host, l2.players[0].away], [0, 0, false], 'host reclaimed seat 0');

    guest.sendJ({ type: 'leave' });
    await back.waitFor('lobby', (x) => x.players.length === 1);
    back.close();
    console.log('lobby survival + rejoin + leave ✔');
  }

  // --- ghost pruning at start; bots play; mid-game rejoin; reactions ---
  {
    const host = await client();
    host.sendJ({ type: 'create', name: 'Steve' });
    const seat = await host.waitFor('lobby');
    const guest = await client();
    guest.sendJ({ type: 'join', code: seat.code, name: 'Dad' });
    const guestSeat = await guest.waitFor('lobby');
    const ghost = await client();
    ghost.sendJ({ type: 'join', code: seat.code, name: 'Ghost' });
    await host.waitFor('lobby', (m) => m.players.length === 3);
    host.sendJ({ type: 'addbot', level: 'normal' });
    await host.waitFor('lobby', (m) => m.players.length === 4);
    ghost.terminate(); // never comes back
    await host.waitFor('lobby', (m) => m.players[2]?.away === true);

    host.sendJ({ type: 'react', e: '🎉' }); // game not started yet
    host.sendJ({ type: 'start' });
    const started = await host.waitFor('state', (m) => m.event?.kind === 'start');
    assert.deepEqual(
      started.state.players.map((p) => p.name), ['Steve', 'Dad', 'Chip'],
      'ghost pruned at start; bot kept');
    assert.equal(host.msgs.filter((m) => m.type === 'react').length, 0, 'pre-start reaction ignored');

    host.sendJ({ type: 'react', e: '😈' });
    const r = await guest.waitFor('react');
    assert.deepEqual([r.e, r.by], ['😈', 'Steve'], 'reaction broadcast with sender name');
    host.sendJ({ type: 'react', e: '💪' }); // within the spam brake
    host.sendJ({ type: 'react', e: '🖕' }); // not on the allowlist
    await sleep(150);
    assert.equal(guest.msgs.filter((m) => m.type === 'react').length, 1, 'spam brake + allowlist hold');

    guest.terminate(); // drop mid-game
    await host.waitFor('state', (m) => m.event?.kind === 'left');
    const back = await client();
    back.sendJ({ type: 'rejoin', code: seat.code, token: guestSeat.token });
    const rj = await back.waitFor('rejoined');
    assert.equal(rj.you, 1, 'rejoiner back in seat 1');
    const st = await back.waitFor('state', (m) => m.event?.kind === 'rejoined');
    assert.equal(st.state.players[1].disconnected, false, 'seat live again');
    await host.waitFor('state', (m) => m.event?.kind === 'rejoined');

    const bad = await client();
    bad.sendJ({ type: 'rejoin', code: seat.code, token: 'wrong' });
    await bad.waitFor('rejoin-failed');
    bad.close();

    host.close();
    back.close();
    console.log('ghost pruning + reactions + mid-game rejoin ✔');
  }

  // --- a full game vs a bot, played to a recorded win ---
  {
    const menu = await client(); // watches the hall of fame from the menu
    menu.sendJ({ type: 'hello' });
    await menu.waitFor('stats');

    const host = await client();
    host.sendJ({ type: 'create', name: 'Steve' });
    await host.waitFor('lobby');
    host.sendJ({ type: 'addbot', level: 'hard' });
    await host.waitFor('lobby', (m) => m.players.length === 2);
    host.sendJ({ type: 'start' });
    await host.waitFor('state', (m) => m.event?.kind === 'start');

    // Play any legal move on our turn until somebody wins.
    let finished = null;
    for (let tick = 0; tick < 3000 && !finished; tick++) {
      const m = host.last('state');
      const st = m.state;
      if (st.phase === 'over') { finished = m; break; }
      if (st.current === 0) {
        if (st.phase === 'roll') host.sendJ({ type: 'roll' });
        else {
          const cells = selectableCells(st);
          if (cells.length) host.sendJ({ type: 'place', r: cells[0][0], c: cells[0][1] });
          else host.sendJ({ type: 'roll' });
        }
      }
      await sleep(25);
    }
    assert.ok(finished, 'game reached a winner');
    const chipMoves = host.msgs.filter((m) => m.type === 'state' && m.event?.by === 'Chip').length;
    assert.ok(chipMoves > 0, 'bot actually played');

    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    assert.ok(stats.steve, 'human result recorded');
    assert.equal(stats.steve.wins + stats.steve.losses, 1, 'exactly one game recorded');
    assert.ok(!stats.chip, 'bots never make the hall of fame');
    await menu.waitFor('stats', (m) => m.top.length === 1);

    menu.close();
    host.close();
    console.log(`full game vs bot (${finished.state.players[finished.state.winner].name} won) + stats ✔`);
  }

  console.log('All RINGO server tests passed ✔');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
