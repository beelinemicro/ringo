// Computer player for RINGO. Scores each legal cell by how much it extends
// the bot's own lines and how much it blocks an opponent's line, with a small
// random tiebreak so games don't play out identically.

import { selectableCells, WIN_LINES } from './game.js';

// Difficulty knobs:
//   blunder — chance of ignoring strategy and playing any legal cell
//   stealAt — how valuable a blocked spot must be before stealing it
//             (easy's 2900 means "only when it blocks or wins outright")
//   threat  — bonus per four-in-a-line threat a placement creates; hard
//             mode's one-move lookahead, which loves forcing double threats
//   spite   — weight on the damage a steal does to the victim's lines, on
//             top of what the cell is worth to the bot itself
export const LEVELS = {
  easy: { blunder: 0.45, stealAt: 2900, threat: 0, spite: 0 },
  normal: { blunder: 0, stealAt: 3.5, threat: 0, spite: 0 },
  hard: { blunder: 0, stealAt: 1.8, threat: 400, spite: 3 },
};

const cfgFor = (level) => LEVELS[level] || LEVELS.normal;

// How many win lines would sit one-away after I take (r, c)? Two or more is
// usually game over next turn — the opponent can only block one of them.
function threatsAfter(state, r, c) {
  const me = state.current;
  const b = state.board;
  const prev = b[r][c];
  b[r][c] = me;
  let n = 0;
  for (const line of WIN_LINES) {
    let mine = 0;
    let empty = 0;
    let other = 0;
    for (const [lr, lc] of line) {
      const v = b[lr][lc];
      if (v === me) mine++;
      else if (v === null) empty++;
      else other++;
    }
    if (other === 0 && empty === 1 && mine === line.length - 1) n++;
  }
  b[r][c] = prev;
  return n;
}

// How much the ring at (r, c) is worth to the player who owns it — the sum
// of their progress in every still-winnable line through that cell. This is
// what a steal destroys.
function ringValueToOwner(board, r, c) {
  const owner = board[r][c];
  let v = 0;
  for (const line of WIN_LINES) {
    if (!line.some(([lr, lc]) => lr === r && lc === c)) continue;
    const cells = line.map(([lr, lc]) => board[lr][lc]);
    if (cells.some((o) => o !== null && o !== owner)) continue; // dead line
    v += cells.filter((o) => o === owner).length ** 2;
  }
  return v;
}

// Value of the current player owning cell (r, c), ignoring whatever ring is
// there now. Rewards extending winnable lines and blocking opponent lines.
// WIN_LINES includes the four-corners win, so corner cells score richly.
function scoreCell(state, r, c, cfg) {
  const me = state.current;
  let score = Math.random() * 0.5;
  for (const line of WIN_LINES) {
    if (!line.some(([lr, lc]) => lr === r && lc === c)) continue;
    const rest = line.length - 1; // cells in the line besides this one
    const owners = line
      .filter(([lr, lc]) => !(lr === r && lc === c))
      .map(([lr, lc]) => state.board[lr][lc])
      .filter((v) => v !== null);
    const mine = owners.filter((o) => o === me).length;
    const others = owners.filter((o) => o !== me);

    if (others.length === 0) {
      // Line is still winnable for me — completing it is an instant win.
      score += mine === rest ? 10000 : (mine + 1) ** 2;
    } else if (mine === 0 && new Set(others).size === 1) {
      // Line is winnable for exactly one opponent — blocking value.
      score += others.length === rest ? 3000 : others.length ** 2 * 0.8;
    }
    // Lines with rings from two different players are dead — worth nothing.
  }
  if (cfg.threat) score += cfg.threat * threatsAfter(state, r, c);
  const victim = state.board[r][c];
  if (cfg.spite && victim !== null && victim !== me) {
    score += cfg.spite * ringValueToOwner(state.board, r, c);
  }
  return score;
}

function bestOf(state, cells, cfg) {
  let best = null;
  let bestScore = -Infinity;
  for (const [r, c] of cells) {
    const score = scoreCell(state, r, c, cfg);
    if (score > bestScore) {
      bestScore = score;
      best = [r, c];
    }
  }
  return { best, bestScore };
}

// Place phase: open cells plus, on a wild, any reachable opponent ring.
export function chooseCell(state, level = 'normal') {
  const cfg = cfgFor(level);
  const cells = selectableCells(state);
  if (cfg.blunder && Math.random() < cfg.blunder) {
    return cells[Math.floor(Math.random() * cells.length)] || null;
  }
  return bestOf(state, cells, cfg).best;
}

// Blocked roll: returns a cell to steal, or null to roll again. Steals when
// the spot is genuinely valuable; otherwise gambles on a fresh roll.
export function chooseSteal(state, level = 'normal') {
  const cfg = cfgFor(level);
  const { best, bestScore } = bestOf(state, selectableCells(state), cfg);
  if (!best) return null;
  const emptyLeft = state.board.flat().filter((v) => v === null).length;
  if (emptyLeft === 0) return best; // nothing to gain by re-rolling
  return bestScore >= cfg.stealAt ? best : null;
}
