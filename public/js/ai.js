// Computer player for RINGO. Scores each legal cell by how much it extends
// the bot's own lines and how much it blocks an opponent's line, with a small
// random tiebreak so games don't play out identically.

import { selectableCells, WIN_LINES } from './game.js';

// Value of the current player owning cell (r, c), ignoring whatever ring is
// there now. Rewards extending winnable lines and blocking opponent lines.
// WIN_LINES includes the four-corners win, so corner cells score richly.
function scoreCell(state, r, c) {
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
  return score;
}

function bestOf(state, cells) {
  let best = null;
  let bestScore = -Infinity;
  for (const [r, c] of cells) {
    const score = scoreCell(state, r, c);
    if (score > bestScore) {
      bestScore = score;
      best = [r, c];
    }
  }
  return { best, bestScore };
}

// Place phase: open cells plus, on a wild, any reachable opponent ring.
export function chooseCell(state) {
  return bestOf(state, selectableCells(state)).best;
}

// Blocked roll: returns a cell to steal, or null to roll again. Steals when
// the spot is genuinely valuable; otherwise gambles on a fresh roll.
export function chooseSteal(state) {
  const { best, bestScore } = bestOf(state, selectableCells(state));
  if (!best) return null;
  const emptyLeft = state.board.flat().filter((v) => v === null).length;
  if (emptyLeft === 0) return best; // nothing to gain by re-rolling
  return bestScore >= 3.5 ? best : null;
}
