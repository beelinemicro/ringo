// RINGO — client application: screens, rendering, turn flow, and online play.

import {
  GAME_VERSION, SIZE, WILD, COL_LABELS, COLORS,
  newGame, rollDice, applyRoll, applyPlace, isLegal, selectableCells, diceLabel,
} from './game.js';
import { chooseCell, chooseSteal } from './ai.js';
import { sfx, unlock, setMuted, isMuted } from './sound.js';
import { burst as confettiBurst, stop as confettiStop } from './confetti.js';

const $ = (id) => document.getElementById(id);

// ---------- app state ----------

let mode = null; // 'local' | 'ai' | 'online'
let state = null; // game state (authoritative locally; server copy when online)
let busy = false; // true while dice are animating
let startingPlayer = 0; // rotates on "play again" in local modes
let net = null; // { ws, code, myIndex, isHost }

const cellEls = []; // [r][c] -> element
const colLabelEls = [];
const rowLabelEls = [];

// ---------- screens ----------

const SCREENS = ['screen-menu', 'screen-setup', 'screen-lobby', 'screen-game'];

function show(id) {
  SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

// ---------- menu ----------

$('btn-mode-local').addEventListener('click', () => { unlock(); sfx.click(); openSetup('local'); });
$('btn-mode-ai').addEventListener('click', () => { unlock(); sfx.click(); openSetup('ai'); });
$('btn-mode-online').addEventListener('click', () => { unlock(); sfx.click(); openSetup('online'); });
$('btn-rules').addEventListener('click', () => { sfx.click(); $('rules-modal').classList.remove('hidden'); });
$('btn-rules-close').addEventListener('click', () => { sfx.click(); $('rules-modal').classList.add('hidden'); });
$('btn-story').addEventListener('click', () => { sfx.click(); $('story-modal').classList.remove('hidden'); });
$('btn-story-close').addEventListener('click', () => { sfx.click(); $('story-modal').classList.add('hidden'); });

// ---------- setup ----------

function colorDot(i) {
  return `<span class="player-color-dot" style="border-color:${COLORS[i].hex}"></span>`;
}

function segButtons(values, initial, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  values.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v;
    if (v === initial) b.classList.add('on');
    b.addEventListener('click', () => {
      sfx.click();
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(v);
    });
    wrap.appendChild(b);
  });
  return wrap;
}

function savedName() {
  return localStorage.getItem('ringoName') || '';
}

function openSetup(m) {
  mode = m;
  const body = $('setup-body');
  body.innerHTML = '';
  $('btn-setup-go').classList.toggle('hidden', m === 'online');

  if (m === 'local') {
    $('setup-title').textContent = 'Pass & Play';
    let count = 2;
    const nameFields = document.createElement('div');

    const renderNames = () => {
      nameFields.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const f = document.createElement('div');
        f.className = 'field';
        f.innerHTML = `<label>${colorDot(i)}${COLORS[i].name} player</label>
          <input type="text" maxlength="14" placeholder="Player ${i + 1}" data-name-idx="${i}">`;
        nameFields.appendChild(f);
      }
    };

    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = '<label>How many players?</label>';
    f.appendChild(segButtons([2, 3, 4, 5], 2, (v) => { count = v; renderNames(); }));
    body.appendChild(f);
    body.appendChild(nameFields);
    renderNames();

    $('btn-setup-go').onclick = () => {
      const players = [...nameFields.querySelectorAll('input')].map((inp, i) => ({
        name: inp.value.trim() || `Player ${i + 1}`,
      }));
      startLocalGame(players);
    };
  }

  if (m === 'ai') {
    $('setup-title').textContent = 'Play vs Computer';
    let bots = 1;
    let level = localStorage.getItem('ringoDiff') || 'normal';
    body.innerHTML = `<div class="field">
        <label>${colorDot(0)}Your name</label>
        <input type="text" id="ai-name" maxlength="14" placeholder="You" value="${savedName()}">
      </div>`;
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = '<label>How many computer players?</label>';
    f.appendChild(segButtons([1, 2, 3, 4], 1, (v) => { bots = v; }));
    body.appendChild(f);
    const fd = document.createElement('div');
    fd.className = 'field';
    fd.innerHTML = '<label>How tough should they be?</label>';
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    fd.appendChild(segButtons(['Easy', 'Normal', 'Hard'], cap(level), (v) => { level = v.toLowerCase(); }));
    body.appendChild(fd);

    $('btn-setup-go').onclick = () => {
      const you = $('ai-name').value.trim() || 'You';
      localStorage.setItem('ringoName', you);
      localStorage.setItem('ringoDiff', level);
      const botNames = ['Chip', 'Sparky', 'Gizmo', 'Bolt'];
      const players = [{ name: you }];
      for (let i = 0; i < bots; i++) players.push({ name: botNames[i], isBot: true, level });
      startLocalGame(players);
    };
  }

  if (m === 'online') {
    $('setup-title').textContent = 'Play Online';
    body.innerHTML = `
      <div class="field">
        <label>Your name</label>
        <input type="text" id="online-name" maxlength="14" placeholder="Your name" value="${savedName()}">
      </div>
      <div class="setup-actions">
        <button class="btn btn-primary" id="btn-create-room">Create a Room</button>
      </div>
      <div class="field">
        <label>&hellip;or join a room with a code</label>
        <input type="text" id="online-code" maxlength="4" placeholder="CODE" style="text-transform:uppercase; letter-spacing:0.3em; text-align:center;">
      </div>
      <div class="setup-actions">
        <button class="btn" id="btn-join-room">Join Room</button>
      </div>
      <p class="hint" id="online-status"></p>`;

    $('btn-create-room').addEventListener('click', () => connectOnline(null));
    $('btn-join-room').addEventListener('click', () =>
      connectOnline($('online-code').value.trim().toUpperCase()));
  }

  show('screen-setup');
}

$('btn-setup-back').addEventListener('click', () => { sfx.click(); show('screen-menu'); });

// ---------- board construction ----------

function buildBoard() {
  // Reactions only make sense with people on other screens.
  $('react-bar').classList.toggle('hidden', mode !== 'online');
  const board = $('board');
  board.innerHTML = '';
  cellEls.length = 0;
  colLabelEls.length = 0;
  rowLabelEls.length = 0;

  const corner = document.createElement('div');
  corner.className = 'board-corner';
  board.appendChild(corner);

  COL_LABELS.forEach((l) => {
    const el = document.createElement('div');
    el.className = 'board-label';
    el.textContent = l;
    colLabelEls.push(el);
    board.appendChild(el);
  });

  for (let r = 0; r < SIZE; r++) {
    const num = document.createElement('div');
    num.className = 'board-label';
    num.textContent = r + 1;
    rowLabelEls.push(num);
    board.appendChild(num);
    cellEls.push([]);
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.addEventListener('click', () => onCellClick(r, c));
      cellEls[r].push(cell);
      board.appendChild(cell);
    }
  }
}

// ---------- rendering ----------

function myTurn() {
  if (!state || state.phase === 'over') return false;
  if (mode === 'online') return state.current === net.myIndex;
  return !state.players[state.current].isBot;
}

function renderChips() {
  const wrap = $('player-chips');
  wrap.innerHTML = '';
  state.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    if (i === state.current && state.phase !== 'over') chip.classList.add('active');
    if (p.disconnected) chip.classList.add('disconnected');
    const you = mode === 'online' && i === net.myIndex ? ' (you)' : '';
    const bot = p.isBot ? ' 🤖' : '';
    chip.innerHTML = `<span class="chip-ring" style="border-color:${COLORS[i].hex}"></span>${p.name}${you}${bot}`;
    const canRename = !p.disconnected &&
      (mode === 'online' ? i === net.myIndex : !p.isBot);
    if (canRename) {
      chip.classList.add('editable');
      chip.title = 'Tap to rename';
      chip.innerHTML += '<span class="pencil">✏️</span>';
      chip.addEventListener('click', () => renamePlayer(i));
    }
    wrap.appendChild(chip);
  });
}

function renamePlayer(i) {
  const current = state.players[i].name;
  const entered = prompt('New name:', current);
  if (entered === null) return;
  const name = entered.trim().slice(0, 14);
  if (!name || name === current) return;
  sfx.click();
  if (mode === 'online') {
    localStorage.setItem('ringoName', name);
    send({ type: 'rename', name });
    return; // the server broadcasts the updated roster
  }
  if (mode === 'ai' && i === 0) localStorage.setItem('ringoName', name);
  state.players[i].name = name;
  renderAll();
}

function renderBoard() {
  const legal = selectableCells(state);
  const canClick = myTurn() && legal.length > 0 && !busy;
  const winCells = state.winLines ? state.winLines.flat() : (state.winLine || []);
  const winSet = new Set(winCells.map(([r, c]) => `${r},${c}`));

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const el = cellEls[r][c];
      const owner = state.board[r][c];
      el.innerHTML = owner === null ? '' : `<div class="ring p${owner}"></div>`;
      const isLegalCell = canClick && legal.some(([rr, cc]) => rr === r && cc === c);
      el.classList.toggle('legal', isLegalCell);
      // A selectable cell that already holds a ring is a steal target.
      el.classList.toggle('steal', isLegalCell && owner !== null);
      el.classList.toggle('win-cell', winSet.has(`${r},${c}`));
      if (isLegalCell) el.style.setProperty('--hl', COLORS[state.current].hex);
    }
  }

  const diceShown = state.dice && (state.phase === 'place' || state.phase === 'blocked');
  colLabelEls.forEach((el, i) =>
    el.classList.toggle('hot', !!diceShown && (state.dice.col === i || state.dice.col === WILD)));
  rowLabelEls.forEach((el, i) =>
    el.classList.toggle('hot', !!diceShown && (state.dice.row === i || state.dice.row === WILD)));
}

function setDieFace(el, value, isCol) {
  const face = el.querySelector('.die-face');
  if (value === WILD) {
    face.textContent = '★';
    el.classList.add('wild-face');
  } else {
    face.textContent = isCol ? COL_LABELS[value] : String(value + 1);
    el.classList.remove('wild-face');
  }
}

function renderDice() {
  if (state.dice) {
    setDieFace($('die-col'), state.dice.col, true);
    setDieFace($('die-row'), state.dice.row, false);
  }
}

function setMessage(text) {
  $('message').textContent = text;
}

function defaultMessage() {
  const cur = state.players[state.current];
  if (state.phase === 'roll') {
    if (mode === 'online') {
      return state.current === net.myIndex ? 'Your turn — roll the dice!' : `Waiting for ${cur.name} to roll…`;
    }
    return cur.isBot ? `${cur.name} is rolling…` : `${cur.name}: roll the dice!`;
  }
  if (state.phase === 'place') {
    const d = state.dice;
    const wilds = (d.col === WILD ? 1 : 0) + (d.row === WILD ? 1 : 0);
    const who = myTurn() ? 'Pick a highlighted space' : `${cur.name} is placing a ring`;
    if (wilds === 2) return `Double wild! ${who} — anywhere, even an opponent's ring!`;
    if (wilds === 1) return `Wild! ${who} — open spots or an opponent's ring.`;
    return `Rolled ${diceLabel(d)}. ${who}.`;
  }
  if (state.phase === 'blocked') {
    return myTurn()
      ? `Rolled ${diceLabel(state.dice)} — that spot is taken! Steal the ring, or roll again.`
      : `${cur.name} rolled ${diceLabel(state.dice)} — deciding whether to steal or roll again…`;
  }
  return '';
}

function renderAll() {
  renderChips();
  renderBoard();
  renderDice();
  const canRoll = (state.phase === 'roll' || state.phase === 'blocked') && myTurn() && !busy;
  $('btn-roll').disabled = !canRoll;
  $('btn-roll').textContent = state.phase === 'blocked' ? 'Roll Again!' : 'Roll!';
  setMessage(defaultMessage());
}

// ---------- dice animation ----------

function animateRoll(dice, done) {
  busy = true;
  $('btn-roll').disabled = true;
  sfx.roll();
  const dieCol = $('die-col');
  const dieRow = $('die-row');
  dieCol.classList.add('rolling');
  dieRow.classList.add('rolling');
  const spin = setInterval(() => {
    setDieFace(dieCol, Math.floor(Math.random() * 5), true);
    setDieFace(dieRow, Math.floor(Math.random() * 5), false);
  }, 90);
  setTimeout(() => {
    clearInterval(spin);
    dieCol.classList.remove('rolling');
    dieRow.classList.remove('rolling');
    setDieFace(dieCol, dice.col, true);
    setDieFace(dieRow, dice.row, false);
    if (dice.col === WILD || dice.row === WILD) sfx.wild();
    busy = false;
    done();
  }, 750);
}

// ---------- local game flow ----------

function startLocalGame(players) {
  sfx.click();
  startingPlayer = 0;
  state = newGame(players, startingPlayer);
  buildBoard();
  $('banner').classList.add('hidden');
  confettiStop($('confetti'));
  show('screen-game');
  renderAll();
  maybeBotAct();
}

$('btn-roll').addEventListener('click', () => {
  const canRoll = (state?.phase === 'roll' || state?.phase === 'blocked') && myTurn() && !busy;
  if (!canRoll) return;
  if (mode === 'online') {
    send({ type: 'roll' });
    return;
  }
  doLocalRoll();
});

function doLocalRoll() {
  const dice = rollDice();
  animateRoll(dice, () => {
    const roller = state.players[state.current].name;
    const result = applyRoll(state, dice);
    renderAll();
    if (result === 'blocked') {
      sfx.pass();
    } else if (result === 'reroll') {
      sfx.pass();
      setMessage(`${roller} rolled ${diceLabel(dice)} — that's ${myTurn() ? 'your' : 'their'} own ring! Roll again.`);
    }
    maybeBotAct();
  });
}

function onCellClick(r, c) {
  if (busy || !state || !myTurn()) return;
  if (state.phase !== 'place' && state.phase !== 'blocked') return;
  if (mode === 'online') {
    send({ type: 'place', r, c });
    return;
  }
  if (!isLegal(state, r, c)) return;
  doLocalPlace(r, c);
}

function doLocalPlace(r, c) {
  const placedBy = state.current;
  const { result, stolen } = applyPlace(state, r, c);
  if (stolen !== null) sfx.steal();
  else sfx.place();
  renderAll();
  if (stolen !== null && result !== 'win') {
    setMessage(`${state.players[placedBy].name} stole the spot from ${state.players[stolen].name}!`);
  }
  if (result === 'win') {
    endLocalGame(placedBy);
  } else {
    maybeBotAct();
  }
}

function maybeBotAct() {
  if (mode === 'online' || !state || state.phase === 'over') return;
  const cur = state.players[state.current];
  if (!cur.isBot) return;
  if (state.phase === 'roll') {
    setTimeout(() => { if (state.phase === 'roll' && state.players[state.current].isBot) doLocalRoll(); }, 900);
  } else if (state.phase === 'place') {
    setTimeout(() => {
      if (state.phase === 'place' && state.players[state.current].isBot) {
        const cell = chooseCell(state, state.players[state.current].level);
        if (cell) doLocalPlace(cell[0], cell[1]);
      }
    }, 1000);
  } else if (state.phase === 'blocked') {
    setTimeout(() => {
      if (state.phase !== 'blocked' || !state.players[state.current].isBot) return;
      const cell = chooseSteal(state, state.players[state.current].level);
      if (cell) doLocalPlace(cell[0], cell[1]);
      else doLocalRoll();
    }, 1100);
  }
}

function endLocalGame(winnerIdx) {
  setTimeout(() => {
    showBanner(winTitle(state), winSub(state), winnerIdx);
    if (mode === 'ai' && state.players[winnerIdx].isBot) {
      sfx.lose();
    } else {
      celebrateWin(state, [COLORS[winnerIdx].hex, '#ffd34d', '#ffffff']);
    }
  }, 700);
}

// ---------- banner ----------

// One ring, more than one line: 2 = DOUBLE, 3 = TRIPLE, and the
// corner-only 4 = QUADRUPLE RINGO. Legendary, and recorded as such.
function winTitle(st) {
  const n = st?.winLines?.length || 1;
  return ['RINGO!', 'DOUBLE RINGO!', 'TRIPLE RINGO!', 'QUADRUPLE RINGO!'][n - 1] || 'RINGO!';
}

function winSub(st) {
  const n = st?.winLines?.length || 1;
  const name = st.players[st.winner].name;
  return n >= 2 ? `${name} wins with a legendary ${n}-line finish!` : `${name} wins!`;
}

function celebrateWin(st, colors) {
  const n = st?.winLines?.length || 1;
  sfx.win();
  confettiBurst($('confetti'), colors);
  if (n >= 2) {
    sfx.wild();
    for (let i = 1; i < n; i++) setTimeout(() => confettiBurst($('confetti'), colors), i * 450);
  }
}

function showBanner(text, sub, winnerIdx) {
  $('banner-text').classList.toggle('legendary', /DOUBLE|TRIPLE|QUADRUPLE/.test(text));
  $('banner-text').textContent = text;
  $('banner-sub').innerHTML = winnerIdx !== null
    ? `<span class="player-color-dot" style="border-color:${COLORS[winnerIdx].hex}"></span>${sub}`
    : sub;
  $('btn-banner-again').classList.toggle('hidden', mode === 'online' && !net?.isHost);
  $('banner').classList.remove('hidden');
}

$('btn-banner-again').addEventListener('click', () => {
  sfx.click();
  $('banner').classList.add('hidden');
  confettiStop($('confetti'));
  if (mode === 'online') {
    send({ type: 'again' });
    return;
  }
  startingPlayer = (startingPlayer + 1) % state.players.length;
  state = newGame(state.players, startingPlayer);
  renderAll();
  maybeBotAct();
});

$('btn-banner-menu').addEventListener('click', () => { sfx.click(); quitToMenu(); });
$('btn-quit').addEventListener('click', () => { sfx.click(); quitToMenu(); });

function quitToMenu() {
  send({ type: 'leave' }); // frees a lobby seat for real (vs. a phone blip)
  if (net) { clearInterval(net.keepalive); net.ws.onclose = null; net.ws.close(); net = null; }
  clearSeat(); // leaving on purpose — don't auto-rejoin this game later
  rejoinAttempts = 0;
  state = null;
  busy = false;
  $('banner').classList.add('hidden');
  confettiStop($('confetti'));
  show('screen-menu');
}

// ---------- sound toggle ----------

$('btn-mute').addEventListener('click', () => {
  setMuted(!isMuted());
  $('btn-mute').textContent = isMuted() ? '🔇' : '🔊';
});

// ---------- online play ----------

function onlineStatus(text) {
  const el = $('online-status');
  if (el) el.textContent = text;
}

// The seat token lets us reclaim our spot in a game after a dropped
// connection (phone locked, app switched, wifi blip). Rooms expire after
// 24h, so older saved seats are useless.
function saveSeat(code, token) {
  localStorage.setItem('ringoSeat', JSON.stringify({ code, token, ts: Date.now() }));
}

function savedSeat() {
  try {
    const s = JSON.parse(localStorage.getItem('ringoSeat'));
    if (s && s.code && s.token && Date.now() - s.ts < 24 * 3600 * 1000) return s;
  } catch { /* corrupt entry */ }
  return null;
}

function clearSeat() {
  localStorage.removeItem('ringoSeat');
}

let rejoinAttempts = 0;

// Retry a dropped connection a few times before giving up. Returns false
// when there's no seat to reclaim or we're out of tries.
function scheduleRejoin() {
  const seat = savedSeat();
  if (!seat || rejoinAttempts >= 5) return false;
  rejoinAttempts++;
  setTimeout(() => {
    if (!net) connectGame({ type: 'rejoin', code: seat.code, token: seat.token });
  }, rejoinAttempts === 1 ? 300 : 2500);
  return true;
}

// Phones kill the socket the instant the browser is backgrounded (switching
// to Messages to paste an invite link, locking the screen). The moment we're
// foregrounded again, sit straight back down. Crucially, some browsers never
// deliver the close event for a socket that died while frozen — the page
// would sit deaf on a zombie connection, taps going nowhere. So after any
// real time away we don't trust an existing socket: drop it and rejoin.
let hiddenSince = null;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = Date.now();
    return;
  }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = null;
  const seat = savedSeat();
  if (!seat) return;
  const inGame = mode === 'online' && state && state.phase !== 'over';
  const inLobby = !$('screen-lobby').classList.contains('hidden');
  if (!inGame && !inLobby) return;
  if (net && away > 20_000) {
    const ws = net.ws;
    ws.onclose = null; // no double-rejoin from the close handler
    clearInterval(net.keepalive);
    net = null;
    ws.close();
  }
  if (!net) {
    rejoinAttempts = 1; // fresh round of retries
    connectGame({ type: 'rejoin', code: seat.code, token: seat.token });
  }
});

function connectGame(firstMsg) {
  // A deployed copy sets window.RINGO_WS_URL in config.js; local dev uses
  // the same host that served the page (server.js).
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = window.RINGO_WS_URL || `${proto}://${location.host}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    onlineStatus('Could not connect. Run the game with "npm start" to play online.');
    return;
  }

  // API Gateway drops idle sockets after 10 minutes — keep it warm.
  const keepalive = setInterval(() => send({ type: 'ping' }), 4 * 60 * 1000);
  net = { ws, code: null, myIndex: null, isHost: false, keepalive };

  ws.onopen = () => send(firstMsg);
  ws.onerror = () => onlineStatus('Could not connect. Run the game with "npm start" to play online.');
  ws.onclose = () => {
    clearInterval(keepalive);
    net = null;
    const inGame = mode === 'online' && state && state.phase !== 'over';
    const inLobby = !$('screen-lobby').classList.contains('hidden');
    if ((inGame || inLobby) && scheduleRejoin()) {
      if (inGame) setMessage('Connection lost — reconnecting…');
      else $('lobby-status').textContent = 'Connection lost — reconnecting…';
      return;
    }
    if (inGame) {
      showBanner('OOPS', 'Connection lost. Head back to the menu.', null);
      $('btn-banner-again').classList.add('hidden');
    } else if (inLobby) {
      show('screen-menu');
    }
  };
  ws.onmessage = (ev) => handleServer(JSON.parse(ev.data));
}

function connectOnline(joinCode) {
  const name = ($('online-name').value.trim() || 'Player').slice(0, 14);
  localStorage.setItem('ringoName', name);
  if (joinCode !== null && joinCode.length !== 4) {
    onlineStatus('Room codes are 4 letters.');
    return;
  }
  sfx.click();
  onlineStatus('Connecting…');
  connectGame(joinCode === null ? { type: 'create', name } : { type: 'join', code: joinCode, name });
}

function send(msg) {
  if (net?.ws?.readyState === WebSocket.OPEN) {
    net.ws.send(JSON.stringify(msg));
    return;
  }
  // Tap landed on a dead socket — recover the seat instead of eating it.
  const seat = savedSeat();
  if (seat && mode === 'online' && !net) {
    rejoinAttempts = 1;
    connectGame({ type: 'rejoin', code: seat.code, token: seat.token });
  }
}

// ---------- stale-version banner ----------

let updateBannerShown = false;

function checkVersion(serverVersion) {
  if (updateBannerShown || !serverVersion || serverVersion <= GAME_VERSION) return;
  updateBannerShown = true;
  $('update-banner').classList.remove('hidden');
}

$('update-banner').addEventListener('click', () => {
  const inGame = mode === 'online' && state && state.phase !== 'over';
  if (!inGame || confirm('Refreshing now will drop you out of the current game. Refresh anyway?')) {
    location.reload();
  }
});

function handleServer(msg) {
  checkVersion(msg.v);
  switch (msg.type) {
    case 'react':
      spawnReaction(msg.e, msg.by);
      break;

    case 'error':
      onlineStatus(msg.message);
      $('lobby-status').textContent = msg.message;
      break;

    // We're back in our seat after a dropped connection — restore identity
    // and jump straight to the board (the state broadcast follows).
    case 'rejoined': {
      mode = 'online';
      rejoinAttempts = 0;
      net.code = msg.code;
      net.myIndex = msg.you;
      net.isHost = msg.you === msg.host;
      saveSeat(msg.code, msg.token);
      buildBoard();
      $('banner').classList.add('hidden');
      confettiStop($('confetti'));
      show('screen-game');
      break;
    }

    // Room expired, game over and gone, or the token didn't match.
    case 'rejoin-failed': {
      clearSeat();
      const wasInGame = mode === 'online' && state && state.phase !== 'over';
      const wasInLobby = !$('screen-lobby').classList.contains('hidden');
      if (net) { net.ws.onclose = null; net.ws.close(); clearInterval(net.keepalive); net = null; }
      if (wasInGame) {
        showBanner('OOPS', 'Connection lost. Head back to the menu.', null);
        $('btn-banner-again').classList.add('hidden');
      } else if (wasInLobby) {
        show('screen-menu');
      }
      break;
    }

    case 'lobby': {
      mode = 'online'; // may be arriving via a lobby rejoin after a reload
      net.code = msg.code;
      net.myIndex = msg.you;
      net.isHost = msg.you === msg.host;
      rejoinAttempts = 0;
      if (msg.token) saveSeat(msg.code, msg.token);
      $('lobby-code').textContent = msg.code;
      const list = $('lobby-players');
      list.innerHTML = '';
      msg.players.forEach((p, i) => {
        const li = document.createElement('li');
        li.innerHTML = `${colorDot(i)}${p.name}${p.isBot ? ' 🤖' : ''}${p.away ? ' 💤' : ''}${i === msg.host ? ' 👑' : ''}${i === msg.you ? ' (you)' : ''}`;
        if (p.away) li.classList.add('away');
        if (p.isBot && net.isHost) {
          const x = document.createElement('span');
          x.className = 'kick';
          x.textContent = '✕';
          x.title = 'Remove computer player';
          x.addEventListener('click', () => { sfx.click(); send({ type: 'removebot', i }); });
          li.appendChild(x);
        }
        if (p.isBot) {
          const lvl = document.createElement('span');
          lvl.className = 'bot-level';
          lvl.textContent = p.level || 'normal';
          if (net.isHost) {
            lvl.classList.add('editable-level');
            lvl.title = 'Tap to change difficulty';
            lvl.addEventListener('click', () => { sfx.click(); send({ type: 'botlevel', i }); });
          }
          li.appendChild(lvl);
        }
        if (i === msg.you) {
          li.classList.add('editable');
          li.title = 'Tap to rename';
          li.innerHTML += '<span class="pencil">✏️</span>';
          li.addEventListener('click', () => {
            const entered = prompt('New name:', p.name);
            if (entered === null) return;
            const name = entered.trim().slice(0, 14);
            if (!name || name === p.name) return;
            sfx.click();
            localStorage.setItem('ringoName', name);
            send({ type: 'rename', name });
          });
        }
        list.appendChild(li);
      });
      const here = msg.players.filter((p) => !p.away).length;
      $('btn-lobby-start').classList.toggle('hidden', !net.isHost);
      $('btn-lobby-start').disabled = here < 2;
      $('btn-lobby-addbot').classList.toggle('hidden', !net.isHost || msg.players.length >= 5);
      $('lobby-status').textContent = net.isHost
        ? (here < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!')
        : 'Waiting for the host to start the game…';
      show('screen-lobby');
      break;
    }

    case 'state': {
      const prev = state;
      state = msg.state;
      const ev = msg.event || {};

      if (ev.kind === 'start') {
        buildBoard();
        $('banner').classList.add('hidden');
        confettiStop($('confetti'));
        show('screen-game');
        renderAll();
        if (myTurn()) { sfx.yourTurn(); notifyTurn(); }
        break;
      }

      if (ev.kind === 'roll' || ev.kind === 'blocked' || ev.kind === 'reroll') {
        animateRoll(ev.dice, () => {
          renderAll();
          if (ev.kind === 'blocked') {
            sfx.pass();
          } else if (ev.kind === 'reroll') {
            sfx.pass();
            setMessage(`${ev.by} rolled ${diceLabel(ev.dice)} — ${myTurn() ? 'your' : 'their'} own ring is there! Roll again.`);
          }
        });
        break;
      }

      if (ev.kind === 'place' || ev.kind === 'win') {
        if (ev.stolen !== null && ev.stolen !== undefined) sfx.steal();
        else sfx.place();
        renderAll();
        if (ev.kind === 'win') {
          setTimeout(() => {
            showBanner(winTitle(state), winSub(state), state.winner);
            if (state.winner === net.myIndex) {
              celebrateWin(state, [COLORS[state.winner].hex, '#ffd34d', '#ffffff']);
            } else {
              sfx.lose();
            }
          }, 700);
        } else {
          if (ev.stolen !== null && ev.stolen !== undefined) {
            setMessage(`${ev.by} stole the spot from ${state.players[ev.stolen].name}!`);
            setTimeout(() => renderAll(), 2000);
          }
          if (myTurn() && state.phase === 'roll') { sfx.yourTurn(); notifyTurn(); }
        }
        break;
      }

      if (ev.kind === 'left') {
        renderAll();
        setMessage(`${ev.name} left the game.`);
        setTimeout(() => renderAll(), 2000);
        break;
      }

      if (ev.kind === 'rejoined') {
        renderAll();
        // A rejoiner landing on a finished game should still see the result.
        if (state.phase === 'over') {
          showBanner(winTitle(state), winSub(state), state.winner);
        } else {
          setMessage(`${ev.name} is back!`);
          setTimeout(() => renderAll(), 2000);
          // If it's the rejoiner's own turn, let them know right away.
          if (myTurn() && ev.name === state.players[net.myIndex].name) {
            sfx.yourTurn();
            notifyTurn();
          }
        }
        break;
      }

      if (ev.kind === 'rename') {
        renderAll();
        setMessage(`${ev.from} is now ${ev.to}.`);
        setTimeout(() => renderAll(), 2000);
        break;
      }

      // Fallback (e.g. rejoining an in-progress render)
      if (!prev) buildBoard();
      renderAll();
      break;
    }
  }
}

$('btn-lobby-start').addEventListener('click', () => { sfx.click(); send({ type: 'start' }); });
$('btn-lobby-leave').addEventListener('click', () => { sfx.click(); quitToMenu(); });
$('btn-lobby-addbot').addEventListener('click', () => {
  sfx.click();
  // Default new bots to the difficulty last used vs the computer.
  send({ type: 'addbot', level: localStorage.getItem('ringoDiff') || 'normal' });
});

// One tap to text the room to the family: native share sheet where the
// browser has one (phones), clipboard everywhere else.
$('btn-lobby-share').addEventListener('click', async () => {
  sfx.click();
  if (!net?.code) return;
  const url = `${location.origin}${location.pathname}?join=${net.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'RINGO', text: 'Join my RINGO game!', url }); } catch { /* user closed the sheet */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    $('lobby-status').textContent = 'Invite link copied — paste it to your family!';
  } catch {
    $('lobby-status').textContent = url; // last resort: show it
  }
});

// ---------- emoji reactions ----------

// Tap an emoji, everyone in the room sees it fly. The server checks the
// allowlist and stamps the sender's name.
const REACTIONS = ['🎉', '😂', '😱', '😈', '💪', '❤️'];

let lastReactAt = 0;

(function buildReactBar() {
  const bar = $('react-bar');
  REACTIONS.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastReactAt < 1000) return; // one per second is plenty epic
      lastReactAt = now;
      sfx.click();
      send({ type: 'react', e });
    });
    bar.appendChild(b);
  });
})();

function spawnReaction(emoji, by) {
  sfx.react();
  const el = document.createElement('div');
  el.className = 'react-fly';
  el.style.left = `${10 + Math.random() * 75}%`;
  el.style.setProperty('--rot', `${(Math.random() * 36 - 18).toFixed(0)}deg`);
  const big = document.createElement('span');
  big.className = 'react-emoji';
  big.textContent = emoji;
  const name = document.createElement('span');
  name.className = 'react-name';
  name.textContent = by;
  el.append(big, name);
  $('react-layer').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- hall of fame & family stats ----------

// Online wins/losses per family member, kept by the server and pushed to
// every open menu the moment a game ends.
function renderHallOfFame(top) {
  if (!top || top.length === 0) {
    $('hof').classList.add('hidden');
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const list = $('hof-list');
  list.innerHTML = '';
  top.forEach((s, i) => {
    const li = document.createElement('li');
    const w = `${s.wins} win${s.wins === 1 ? '' : 's'}`;
    const l = s.losses ? ` · ${s.losses} loss${s.losses === 1 ? '' : 'es'}` : '';
    const fire = s.streak >= 2 ? ` 🔥${s.streak}` : '';
    li.textContent = `${medals[i] || '•'} ${s.name} — ${w}${l}${fire}`;
    list.appendChild(li);
  });
  $('hof').classList.remove('hidden');
}

// The deep-dive modal: full leaderboard with streaks, plus every rivalry.
function renderFullStats(msg) {
  const body = $('stats-players');
  body.innerHTML = '';
  msg.players.forEach((s) => {
    const tr = document.createElement('tr');
    const star = s.legendary ? ` ⭐${s.legendary > 1 ? `×${s.legendary}` : ''}` : '';
    [s.name + star, s.wins, s.losses, s.streak >= 2 ? `🔥${s.streak}` : s.streak || '–', s.bestStreak || '–']
      .forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i === 0) td.className = 'stats-name';
        tr.appendChild(td);
      });
    body.appendChild(tr);
  });
  const h2h = $('stats-h2h');
  h2h.innerHTML = '';
  if (msg.h2h.length === 0) {
    h2h.textContent = 'No head-to-head games yet — rivalries start with two humans in one room.';
  }
  msg.h2h.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'stats-h2h-row';
    const lead = r.aWins === r.bWins ? 'tied with' : (r.aWins > r.bWins ? 'leads' : 'trails');
    row.textContent = `${r.a} ${r.aWins} – ${r.bWins} ${r.b}`;
    row.title = `${r.a} ${lead} ${r.b}`;
    h2h.appendChild(row);
  });

  // The book of legends — hidden until somebody earns a page in it.
  const hasLegends = msg.legends && msg.legends.length > 0;
  $('stats-legends-h').classList.toggle('hidden', !hasLegends);
  $('stats-legends').classList.toggle('hidden', !hasLegends);
  if (hasLegends) {
    const kind = { 2: 'DOUBLE', 3: 'TRIPLE', 4: 'QUADRUPLE' };
    const box = $('stats-legends');
    box.innerHTML = '';
    msg.legends.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'stats-h2h-row';
      const day = (l.central || '').split(' ')[0];
      row.textContent = `🌟 ${l.name}${l.isBot ? ' 🤖' : ''} — ${kind[l.lines] || l.lines + '-line'} RINGO · ${day}`;
      box.appendChild(row);
    });
  }
  $('stats-modal').classList.remove('hidden');
}

$('btn-fullstats').addEventListener('click', () => {
  sfx.click();
  if (presenceWs?.readyState === WebSocket.OPEN) {
    presenceWs.send(JSON.stringify({ type: 'fullstats' }));
  }
});
$('btn-stats-close').addEventListener('click', () => { sfx.click(); $('stats-modal').classList.add('hidden'); });

// ---------- turn nudges ----------

// When your turn arrives in an online game, buzz the phone and — if the tab
// is in the background — flash the title until you come back.

const BASE_TITLE = document.title;
let titleFlash = null;

function notifyTurn() {
  navigator.vibrate?.([100, 60, 100]);
  if (document.hidden && !titleFlash) {
    let on = false;
    titleFlash = setInterval(() => {
      on = !on;
      document.title = on ? '🎲 YOUR TURN — RINGO!' : BASE_TITLE;
    }, 1000);
  }
}

function stopTitleFlash() {
  if (!titleFlash) return;
  clearInterval(titleFlash);
  titleFlash = null;
  document.title = BASE_TITLE;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) stopTitleFlash();
});

// ---------- presence (the "N people here now" badge) ----------

// A second, lightweight socket that lives for the whole visit — separate from
// the game socket so browsing the menu counts the same as playing. The server
// answers 'hello' with live count broadcasts and logs the visit.

let presenceRetry = 5000;
let presenceWs = null; // also carries stats requests from the menu

function startPresence() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = window.RINGO_WS_URL || `${proto}://${location.host}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return; // opened from disk with no server — no badge, no retries
  }
  presenceWs = ws;
  let keepalive = null;

  ws.onopen = () => {
    presenceRetry = 5000;
    ws.send(JSON.stringify({ type: 'hello' }));
    // API Gateway drops idle sockets after 10 minutes — keep it warm.
    keepalive = setInterval(() => ws.send(JSON.stringify({ type: 'presence-ping' })), 4 * 60 * 1000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    checkVersion(msg.v);
    if (msg.type === 'presence') {
      $('presence-count').textContent = msg.count === 1
        ? 'Just you here right now'
        : `${msg.count} people here now`;
      $('presence').classList.remove('hidden');
    } else if (msg.type === 'stats') {
      renderHallOfFame(msg.top);
    } else if (msg.type === 'fullstats') {
      renderFullStats(msg);
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    clearInterval(keepalive);
    presenceWs = null;
    $('presence').classList.add('hidden');
    setTimeout(startPresence, presenceRetry);
    presenceRetry = Math.min(presenceRetry * 2, 5 * 60 * 1000);
  };
}

// ---------- boot ----------

// Installable app + offline local play. Registration failing (old browser,
// file:// open) just means no install button — the site works regardless.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

show('screen-menu');
startPresence();

// Invite link (?join=CODE): jump straight into that room. If we already know
// this player's name, join immediately; otherwise show setup with the code
// filled in. A fresh invite outranks any old saved seat.
const inviteCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
if (inviteCode) history.replaceState({}, '', location.pathname); // don't rejoin on refresh
if (/^[A-Z]{4}$/.test(inviteCode)) {
  clearSeat();
  openSetup('online');
  $('online-code').value = inviteCode;
  if (savedName()) connectOnline(inviteCode);
} else if (savedSeat()) {
  // A game was in progress the last time this page closed — try to sit
  // back down. On 'rejoined' we jump to the board; on 'rejoin-failed' the
  // seat is cleared and the menu simply stays put.
  const seat = savedSeat();
  connectGame({ type: 'rejoin', code: seat.code, token: seat.token });
}
