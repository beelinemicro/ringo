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
    body.innerHTML = `<div class="field">
        <label>${colorDot(0)}Your name</label>
        <input type="text" id="ai-name" maxlength="14" placeholder="You" value="${savedName()}">
      </div>`;
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = '<label>How many computer players?</label>';
    f.appendChild(segButtons([1, 2, 3, 4], 1, (v) => { bots = v; }));
    body.appendChild(f);

    $('btn-setup-go').onclick = () => {
      const you = $('ai-name').value.trim() || 'You';
      localStorage.setItem('ringoName', you);
      const botNames = ['Chip', 'Sparky', 'Gizmo', 'Bolt'];
      const players = [{ name: you }];
      for (let i = 0; i < bots; i++) players.push({ name: botNames[i], isBot: true });
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
    wrap.appendChild(chip);
  });
}

function renderBoard() {
  const legal = selectableCells(state);
  const canClick = myTurn() && legal.length > 0 && !busy;
  const winSet = new Set((state.winLine || []).map(([r, c]) => `${r},${c}`));

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
    endLocalGame(`${state.players[placedBy].name} wins!`, placedBy);
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
        const cell = chooseCell(state);
        if (cell) doLocalPlace(cell[0], cell[1]);
      }
    }, 1000);
  } else if (state.phase === 'blocked') {
    setTimeout(() => {
      if (state.phase !== 'blocked' || !state.players[state.current].isBot) return;
      const cell = chooseSteal(state);
      if (cell) doLocalPlace(cell[0], cell[1]);
      else doLocalRoll();
    }, 1100);
  }
}

function endLocalGame(subtitle, winnerIdx) {
  setTimeout(() => {
    showBanner('RINGO!', subtitle, winnerIdx);
    if (mode === 'ai' && state.players[winnerIdx].isBot) {
      sfx.lose();
    } else {
      sfx.win();
      confettiBurst($('confetti'), [COLORS[winnerIdx].hex, '#ffd34d', '#ffffff']);
    }
  }, 700);
}

// ---------- banner ----------

function showBanner(text, sub, winnerIdx) {
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
  if (net) { clearInterval(net.keepalive); net.ws.onclose = null; net.ws.close(); net = null; }
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

function connectOnline(joinCode) {
  const name = ($('online-name').value.trim() || 'Player').slice(0, 14);
  localStorage.setItem('ringoName', name);
  if (joinCode !== null && joinCode.length !== 4) {
    onlineStatus('Room codes are 4 letters.');
    return;
  }
  sfx.click();
  onlineStatus('Connecting…');

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

  ws.onopen = () => {
    send(joinCode === null ? { type: 'create', name } : { type: 'join', code: joinCode, name });
  };
  ws.onerror = () => onlineStatus('Could not connect. Run the game with "npm start" to play online.');
  ws.onclose = () => {
    clearInterval(keepalive);
    if (mode === 'online' && state && state.phase !== 'over') {
      showBanner('OOPS', 'Connection lost. Head back to the menu.', null);
      $('btn-banner-again').classList.add('hidden');
    } else if (!$('screen-lobby').classList.contains('hidden')) {
      show('screen-menu');
    }
    net = null;
  };
  ws.onmessage = (ev) => handleServer(JSON.parse(ev.data));
}

function send(msg) {
  if (net?.ws?.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(msg));
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
    case 'error':
      onlineStatus(msg.message);
      $('lobby-status').textContent = msg.message;
      break;

    case 'lobby': {
      net.code = msg.code;
      net.myIndex = msg.you;
      net.isHost = msg.you === msg.host;
      $('lobby-code').textContent = msg.code;
      const list = $('lobby-players');
      list.innerHTML = '';
      msg.players.forEach((p, i) => {
        const li = document.createElement('li');
        li.innerHTML = `${colorDot(i)}${p.name}${i === msg.host ? ' 👑' : ''}${i === msg.you ? ' (you)' : ''}`;
        list.appendChild(li);
      });
      $('btn-lobby-start').classList.toggle('hidden', !net.isHost);
      $('btn-lobby-start').disabled = msg.players.length < 2;
      $('lobby-status').textContent = net.isHost
        ? (msg.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!')
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
        if (myTurn()) sfx.yourTurn();
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
            showBanner('RINGO!', `${state.players[state.winner].name} wins!`, state.winner);
            if (state.winner === net.myIndex) {
              sfx.win();
              confettiBurst($('confetti'), [COLORS[state.winner].hex, '#ffd34d', '#ffffff']);
            } else {
              sfx.lose();
            }
          }, 700);
        } else {
          if (ev.stolen !== null && ev.stolen !== undefined) {
            setMessage(`${ev.by} stole the spot from ${state.players[ev.stolen].name}!`);
            setTimeout(() => renderAll(), 2000);
          }
          if (myTurn() && state.phase === 'roll') sfx.yourTurn();
        }
        break;
      }

      if (ev.kind === 'left') {
        renderAll();
        setMessage(`${ev.name} left the game.`);
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

// ---------- boot ----------

show('screen-menu');
