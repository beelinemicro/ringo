// Quick sanity tests for the shared RINGO game logic.  Run: npm test

import assert from 'node:assert';
import {
  WILD, newGame, rollDice, legalCells, stealableCells, selectableCells,
  applyRoll, applyPlace, isLegal, winLineFor,
} from '../public/js/game.js';

function fresh() {
  return newGame([{ name: 'A' }, { name: 'B' }]);
}

// --- dice ---
for (let i = 0; i < 500; i++) {
  const d = rollDice();
  assert.ok(d.col === WILD || (d.col >= 0 && d.col <= 4), 'col face valid');
  assert.ok(d.row === WILD || (d.row >= 0 && d.row <= 4), 'row face valid');
}

// --- legal cells ---
{
  const s = fresh();
  assert.deepEqual(legalCells(s.board, { col: 2, row: 3 }), [[3, 2]], 'concrete roll → single cell');
  assert.equal(legalCells(s.board, { col: WILD, row: 3 }).length, 5, 'wild column → whole row');
  assert.equal(legalCells(s.board, { col: 2, row: WILD }).length, 5, 'wild row → whole column');
  assert.equal(legalCells(s.board, { col: WILD, row: WILD }).length, 25, 'double wild → anywhere');
  s.board[3][2] = 0;
  assert.equal(legalCells(s.board, { col: 2, row: 3 }).length, 0, 'occupied cell not open');
  assert.equal(legalCells(s.board, { col: WILD, row: 3 }).length, 4, 'wild skips occupied');
  assert.deepEqual(stealableCells(s.board, { col: 2, row: 3 }, 1), [[3, 2]], 'opponent cell stealable');
  assert.deepEqual(stealableCells(s.board, { col: 2, row: 3 }, 0), [], 'own cell not stealable');
}

// --- blocked roll on an opponent ring → steal-or-reroll choice ---
{
  const s = fresh();
  s.board[3][2] = 1;
  const result = applyRoll(s, { col: 2, row: 3 });
  assert.equal(result, 'blocked', 'opponent ring → blocked (steal or reroll)');
  assert.equal(s.current, 0, 'turn is NOT lost');
  assert.equal(s.phase, 'blocked');
  assert.ok(isLegal(s, 3, 2), 'the occupied spot is stealable');
  assert.ok(!isLegal(s, 0, 0), 'cannot place elsewhere while blocked');
  const { result: r2, stolen } = applyPlace(s, 3, 2);
  assert.equal(r2, 'next');
  assert.equal(stolen, 1, 'reports whose ring was stolen');
  assert.equal(s.board[3][2], 0, 'ring replaced with stealer\'s color');
  assert.equal(s.current, 1, 'turn advances after steal');
}

// --- blocked roll on your OWN ring → just roll again ---
{
  const s = fresh();
  s.board[3][2] = 0;
  const result = applyRoll(s, { col: 2, row: 3 });
  assert.equal(result, 'reroll', 'own ring → roll again');
  assert.equal(s.current, 0, 'still your turn');
  assert.equal(s.phase, 'roll');
}

// --- wild roll prefers empty cells; steals only when nothing is open ---
{
  const s = fresh();
  for (let c = 0; c < 5; c++) s.board[3][c] = c % 2 === 0 ? 1 : 0; // row 3 full, mixed owners
  const result = applyRoll(s, { col: WILD, row: 3 });
  assert.equal(result, 'blocked', 'full row + wild → steal choice');
  const steals = stealableCells(s.board, s.dice, 0);
  assert.deepEqual(steals, [[3, 0], [3, 2], [3, 4]], 'only opponent rings are stealable');
}

// --- wild unlocks stealing even when open spaces exist ---
{
  const s = fresh();
  s.board[3][1] = 1; // opponent ring in row 3
  s.board[3][2] = 0; // own ring in row 3
  assert.equal(applyRoll(s, { col: WILD, row: 3 }), 'place');
  const cells = selectableCells(s);
  assert.equal(cells.length, 4, '3 open + 1 opponent ring; own ring excluded');
  assert.ok(isLegal(s, 3, 1), 'wild can take an opponent spot');
  assert.ok(!isLegal(s, 3, 2), 'wild cannot take your own spot');
  assert.ok(isLegal(s, 3, 0), 'open spots still available');
  const { result, stolen } = applyPlace(s, 3, 1);
  assert.equal(result, 'next');
  assert.equal(stolen, 1, 'wild steal reports the victim');
  assert.equal(s.board[3][1], 0);
}

// --- no wild → no steal option while open spots exist ---
{
  const s = fresh();
  s.board[3][2] = 1;
  assert.equal(applyRoll(s, { col: 1, row: 3 }), 'place'); // concrete roll, open cell
  assert.ok(isLegal(s, 3, 1));
  assert.ok(!isLegal(s, 3, 2), 'concrete roll on open cell cannot steal elsewhere');
}

// --- double wild: place or steal anywhere ---
{
  const s = fresh();
  s.board[0][0] = 1;
  s.board[4][4] = 0;
  assert.equal(applyRoll(s, { col: WILD, row: WILD }), 'place');
  assert.equal(selectableCells(s).length, 24, '23 open + 1 opponent; own ring excluded');
  assert.ok(isLegal(s, 0, 0), 'double wild reaches any opponent ring');
  assert.ok(!isLegal(s, 4, 4), 'never your own ring');
}

// --- place + turn advance ---
{
  const s = fresh();
  assert.equal(applyRoll(s, { col: 0, row: 0 }), 'place');
  assert.ok(isLegal(s, 0, 0));
  assert.ok(!isLegal(s, 1, 1));
  assert.deepEqual(applyPlace(s, 0, 0), { result: 'next', stolen: null });
  assert.equal(s.board[0][0], 0);
  assert.equal(s.current, 1);
}

// --- wins: row, column, both diagonals ---
{
  const s = fresh();
  for (let c = 0; c < 5; c++) s.board[2][c] = 0;
  assert.ok(winLineFor(s.board, 0), 'row win detected');
  assert.equal(winLineFor(s.board, 1), null, 'no win for other player');
}
{
  const s = fresh();
  for (let r = 0; r < 5; r++) s.board[r][4] = 1;
  assert.ok(winLineFor(s.board, 1), 'column win detected');
}
{
  const s = fresh();
  for (let i = 0; i < 5; i++) s.board[i][i] = 0;
  assert.ok(winLineFor(s.board, 0), 'main diagonal win detected');
}
{
  const s = fresh();
  for (let i = 0; i < 5; i++) s.board[i][4 - i] = 0;
  assert.ok(winLineFor(s.board, 0), 'anti-diagonal win detected');
}

// --- win via applyPlace sets state ---
{
  const s = fresh();
  for (let c = 0; c < 4; c++) s.board[0][c] = 0;
  applyRoll(s, { col: 4, row: 0 });
  assert.equal(applyPlace(s, 0, 4).result, 'win');
  assert.equal(s.winner, 0);
  assert.equal(s.phase, 'over');
  assert.equal(s.winLine.length, 5);
}

// --- win by stealing the fifth spot ---
{
  const s = fresh();
  for (let c = 0; c < 4; c++) s.board[0][c] = 0;
  s.board[0][4] = 1; // opponent holds the winning spot
  assert.equal(applyRoll(s, { col: 4, row: 0 }), 'blocked');
  const { result, stolen } = applyPlace(s, 0, 4);
  assert.equal(result, 'win', 'stealing can complete RINGO');
  assert.equal(stolen, 1);
  assert.equal(s.winner, 0);
}

// --- full board never dead-ends: every roll offers a steal or a reroll ---
{
  const s = fresh();
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) s.board[r][c] = (r + c) % 2;
  const result = applyRoll(s, { col: 2, row: 2 });
  assert.ok(result === 'blocked' || result === 'reroll', 'game continues on a full board');
  assert.equal(s.current, 0, 'turn is never forfeited');
}

// --- five players (Black is player index 4) ---
{
  const s = newGame([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]);
  assert.equal(s.players.length, 5);
  for (let i = 0; i < 4; i++) { s.current = i; applyRoll(s, { col: i, row: 0 }); applyPlace(s, 0, i); }
  assert.equal(s.current, 4, 'turn reaches the fifth player');
  for (let c = 0; c < 4; c++) s.board[4][c] = 4;
  applyRoll(s, { col: 4, row: 4 });
  assert.equal(applyPlace(s, 4, 4).result, 'win');
  assert.equal(s.winner, 4, 'fifth player (Black) can win');
}

// --- disconnected players are skipped ---
{
  const s = newGame([{ name: 'A' }, { name: 'B', disconnected: true }, { name: 'C' }]);
  applyRoll(s, { col: 0, row: 0 });
  applyPlace(s, 0, 0);
  assert.equal(s.current, 2, 'skips disconnected player');
}

console.log('All RINGO logic tests passed ✔');
