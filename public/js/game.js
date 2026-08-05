// Shared RINGO game logic — used by both the browser client and the server.
//
// Rules (as the family played it):
//  - 5x5 board. Columns are labeled R-I-N-G-O, rows are numbered 1-5.
//  - Two dice: one with R,I,N,G,O + a wild face; one with 1-5 + a wild face.
//  - On your turn, roll both dice and place a ring of your color on the
//    matching space. A wild lets you pick any row (or column, or both).
//  - If the rolled space is taken by an opponent, you choose: STEAL the spot
//    (replace their ring with yours) or roll again. If it's your own ring,
//    you just roll again.
//  - A wild is powerful: it lets you place on any open matching space OR
//    steal any opponent ring the dice can reach.
//  - First player with five same-colored rings in a row (across, down, or
//    diagonal) — or all FOUR CORNERS — shouts "RINGO!" and wins.

// Bump this whenever the rules change. Servers stamp it on every message;
// clients that see a newer number show the "refresh for new rules" banner.
export const GAME_VERSION = 4;

export const SIZE = 5;
export const WILD = 'W';
export const COL_LABELS = ['R', 'I', 'N', 'G', 'O'];

export const COLORS = [
  { name: 'Red', hex: '#e5484d' },
  { name: 'Yellow', hex: '#f0b000' },
  { name: 'Blue', hex: '#3a7bd5' },
  { name: 'Green', hex: '#30a46c' },
  { name: 'Black', hex: '#262626' },
];

export const MAX_PLAYERS = COLORS.length;

export function newGame(players, startingPlayer = 0) {
  return {
    board: Array.from({ length: SIZE }, () => Array(SIZE).fill(null)),
    players, // [{ name, isBot?, disconnected? }] — color = player index
    current: startingPlayer,
    phase: 'roll', // 'roll' | 'place' | 'blocked' | 'over'
    dice: null, // { col: 0-4 | 'W', row: 0-4 | 'W' }
    winner: null, // player index
    winLine: null, // [[r,c] x5]
    lastPlaced: null,
  };
}

export function rollDice(rng = Math.random) {
  const face = () => {
    const i = Math.floor(rng() * 6);
    return i === 5 ? WILD : i;
  };
  return { col: face(), row: face() };
}

export function legalCells(board, dice) {
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== null) continue;
      if ((dice.row === WILD || dice.row === r) && (dice.col === WILD || dice.col === c)) {
        cells.push([r, c]);
      }
    }
  }
  return cells;
}

export function boardFull(board) {
  return board.every((row) => row.every((cell) => cell !== null));
}

// Opponent-occupied cells matching the dice — candidates for a steal.
export function stealableCells(board, dice, player) {
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === null || board[r][c] === player) continue;
      if ((dice.row === WILD || dice.row === r) && (dice.col === WILD || dice.col === c)) {
        cells.push([r, c]);
      }
    }
  }
  return cells;
}

export const ALL_LINES = (() => {
  const lines = [];
  for (let i = 0; i < SIZE; i++) {
    lines.push([0, 1, 2, 3, 4].map((j) => [i, j])); // rows
    lines.push([0, 1, 2, 3, 4].map((j) => [j, i])); // columns
  }
  lines.push([0, 1, 2, 3, 4].map((i) => [i, i]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, SIZE - 1 - i]));
  return lines;
})();

export const CORNERS = [[0, 0], [0, SIZE - 1], [SIZE - 1, 0], [SIZE - 1, SIZE - 1]];

// Every way to win: the twelve 5-in-a-row lines, plus the four corners.
export const WIN_LINES = [...ALL_LINES, CORNERS];

export function winLineFor(board, player) {
  return WIN_LINES.find((line) => line.every(([r, c]) => board[r][c] === player)) || null;
}

export function nextPlayer(state) {
  let n = state.current;
  do {
    n = (n + 1) % state.players.length;
  } while (state.players[n].disconnected && n !== state.current);
  state.current = n;
}

// Applies a roll for the current player. Returns:
//   'place'   — at least one open matching space; place a ring normally
//   'blocked' — only opponent rings match; choose to steal one or roll again
//   'reroll'  — only your own rings match; roll again
export function applyRoll(state, dice) {
  state.dice = dice;
  if (legalCells(state.board, dice).length > 0) {
    state.phase = 'place';
    return 'place';
  }
  if (stealableCells(state.board, dice, state.current).length > 0) {
    state.phase = 'blocked';
    return 'blocked';
  }
  state.phase = 'roll';
  return 'reroll';
}

export function hasWild(dice) {
  return !!dice && (dice.col === WILD || dice.row === WILD);
}

// Every cell the current player may claim right now. In the 'place' phase a
// wild also unlocks stealing any opponent ring the dice can reach; in the
// 'blocked' phase only the occupied spot(s) are up for grabs.
export function selectableCells(state) {
  if (state.phase === 'place') {
    const open = legalCells(state.board, state.dice);
    if (hasWild(state.dice)) {
      return open.concat(stealableCells(state.board, state.dice, state.current));
    }
    return open;
  }
  if (state.phase === 'blocked') {
    return stealableCells(state.board, state.dice, state.current);
  }
  return [];
}

export function isLegal(state, r, c) {
  return selectableCells(state).some(([rr, cc]) => rr === r && cc === c);
}

// Places (or steals) the current player's ring at (r, c).
// Returns { result: 'win' | 'next', stolen: previousOwner | null }.
export function applyPlace(state, r, c) {
  const p = state.current;
  const stolen = state.board[r][c];
  state.board[r][c] = p;
  state.lastPlaced = [r, c];
  const line = winLineFor(state.board, p);
  if (line) {
    state.phase = 'over';
    state.winner = p;
    state.winLine = line;
    return { result: 'win', stolen };
  }
  nextPlayer(state);
  state.phase = 'roll';
  state.dice = null;
  return { result: 'next', stolen };
}

export function diceLabel(dice) {
  const col = dice.col === WILD ? '★' : COL_LABELS[dice.col];
  const row = dice.row === WILD ? '★' : String(dice.row + 1);
  return `${col}-${row}`;
}
