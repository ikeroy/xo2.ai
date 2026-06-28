"use strict";

const BOARD_GROUPS = 9;
const BOARD_CELLS = 9;
const NUM_MOVES = 81;
const NO_MOVE = 10;
const CANONICAL_PLANES = 15;
const MODEL_URL = "./model-transformer-15p.onnx?v=20260628-2";
const CURRENT_PLAYER_CELLS = 0;
const OPPONENT_CELLS = 1;
const LAST_MOVE = 2;
const LEGAL_MOVES = 3;
const FORCED_BOARD = 4;
const CURRENT_PLAYER_WON_BOARDS = 5;
const OPPONENT_WON_BOARDS = 6;
const CLOSED_BOARDS = 7;
const GIVES_OPPONENT_FREE_CHOICE = 8;
const CURRENT_LOCAL_WIN_THREATS = 9;
const OPPONENT_LOCAL_WIN_THREATS = 10;
const CURRENT_MACRO_WIN_THREATS = 11;
const OPPONENT_MACRO_WIN_THREATS = 12;
const SENDS_OPPONENT_TO_LOCAL_WIN = 13;
const OPPONENT_SENDS_CURRENT_TO_LOCAL_WIN = 14;
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

let session = null;
let board = makeBoard();
let player = 0;
let turn = 0;
let lastGroup = NO_MOVE;
let lastCell = NO_MOVE;
let humanPlayer = 0;
let busy = false;
const moveLog = [];

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");
const evalEl = document.getElementById("eval");
const movesEl = document.getElementById("moves");
const tempEl = document.getElementById("temperature");
const visitsEl = document.getElementById("visits");
const visitsValueEl = document.getElementById("visits-value");
const useGumbelEl = document.getElementById("use-gumbel");
const evalBarEl = document.getElementById("eval-bar");
const evalXEl = document.getElementById("eval-x");
const evalOEl = document.getElementById("eval-o");
const evalDrawEl = document.getElementById("eval-draw");
const settingsToggleEl = document.getElementById("settings-toggle");
const evalCache = new Map();

visitsEl.addEventListener("input", () => {
  visitsValueEl.textContent = visitsEl.value;
});

settingsToggleEl.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("settings-collapsed");
  settingsToggleEl.setAttribute("aria-expanded", String(!collapsed));
});

function makeBoard() {
  return Array.from({ length: BOARD_GROUPS }, () => Array(BOARD_CELLS).fill(0));
}

function playerSign(p = player) {
  return p === 0 ? 1 : -1;
}

function groupCellToPhysical(group, cell) {
  return {
    row: Math.floor(group / 3) * 3 + Math.floor(cell / 3),
    col: (group % 3) * 3 + (cell % 3),
  };
}

function physicalToGroupCell(row, col) {
  return {
    group: Math.floor(row / 3) * 3 + Math.floor(col / 3),
    cell: (row % 3) * 3 + (col % 3),
  };
}

function groupWinner(group) {
  for (const line of WIN_LINES) {
    const a = board[group][line[0]];
    if (a !== 0 && board[group][line[1]] === a && board[group][line[2]] === a) {
      return a;
    }
  }
  return 0;
}

function groupFull(group) {
  return board[group].every((v) => v !== 0);
}

function groupPlayable(group) {
  return groupWinner(group) === 0 && !groupFull(group);
}

function boardWinnerAbsolute() {
  const wins = Array.from({ length: BOARD_GROUPS }, (_, g) => groupWinner(g));
  for (const line of WIN_LINES) {
    const a = wins[line[0]];
    if (a !== 0 && wins[line[1]] === a && wins[line[2]] === a) {
      return a;
    }
  }
  return 0;
}

function validMoves() {
  const out = Array(NUM_MOVES).fill(0);
  const noLastMove = lastGroup === NO_MOVE && lastCell === NO_MOVE;
  if (noLastMove) {
    for (let g = 0; g < BOARD_GROUPS; g++) {
      for (let c = 0; c < BOARD_CELLS; c++) {
        if (board[g][c] !== 0) return out;
        out[g * BOARD_CELLS + c] = 1;
      }
    }
    return out;
  }
  if (lastCell < 0 || lastCell >= BOARD_GROUPS) return out;
  if (!groupPlayable(lastCell)) {
    for (let g = 0; g < BOARD_GROUPS; g++) {
      if (!groupPlayable(g)) continue;
      for (let c = 0; c < BOARD_CELLS; c++) {
        if (board[g][c] === 0) out[g * BOARD_CELLS + c] = 1;
      }
    }
    return out;
  }
  for (let c = 0; c < BOARD_CELLS; c++) {
    if (board[lastCell][c] === 0) out[lastCell * BOARD_CELLS + c] = 1;
  }
  return out;
}

function hasLegalMoves() {
  return validMoves().some(Boolean);
}

function gameResult() {
  const winner = boardWinnerAbsolute();
  if (winner > 0) return "X wins";
  if (winner < 0) return "O wins";
  if (!hasLegalMoves()) return "Draw";
  return null;
}

function cloneState() {
  return {
    board: board.map((group) => group.slice()),
    player,
    turn,
    lastGroup,
    lastCell,
  };
}

function stateSign(state) {
  return state.player === 0 ? 1 : -1;
}

function stateKey(state) {
  return `${state.player}|${state.lastGroup}|${state.lastCell}|${state.board.map((g) => g.join("")).join("/")}`;
}

function groupWinnerState(state, group) {
  for (const line of WIN_LINES) {
    const a = state.board[group][line[0]];
    if (a !== 0 && state.board[group][line[1]] === a && state.board[group][line[2]] === a) {
      return a;
    }
  }
  return 0;
}

function groupFullState(state, group) {
  return state.board[group].every((v) => v !== 0);
}

function groupPlayableState(state, group) {
  return groupWinnerState(state, group) === 0 && !groupFullState(state, group);
}

function boardWinnerAbsoluteState(state) {
  const wins = Array.from({ length: BOARD_GROUPS }, (_, g) => groupWinnerState(state, g));
  for (const line of WIN_LINES) {
    const a = wins[line[0]];
    if (a !== 0 && wins[line[1]] === a && wins[line[2]] === a) return a;
  }
  return 0;
}

function validMovesState(state) {
  const out = Array(NUM_MOVES).fill(0);
  const noLastMove = state.lastGroup === NO_MOVE && state.lastCell === NO_MOVE;
  if (noLastMove) {
    for (let g = 0; g < BOARD_GROUPS; g++) {
      for (let c = 0; c < BOARD_CELLS; c++) {
        if (state.board[g][c] !== 0) return out;
        out[g * BOARD_CELLS + c] = 1;
      }
    }
    return out;
  }
  if (state.lastCell < 0 || state.lastCell >= BOARD_GROUPS) return out;
  if (!groupPlayableState(state, state.lastCell)) {
    for (let g = 0; g < BOARD_GROUPS; g++) {
      if (!groupPlayableState(state, g)) continue;
      for (let c = 0; c < BOARD_CELLS; c++) {
        if (state.board[g][c] === 0) out[g * BOARD_CELLS + c] = 1;
      }
    }
    return out;
  }
  for (let c = 0; c < BOARD_CELLS; c++) {
    if (state.board[state.lastCell][c] === 0) out[state.lastCell * BOARD_CELLS + c] = 1;
  }
  return out;
}

function gameResultState(state) {
  const winner = boardWinnerAbsoluteState(state);
  if (winner > 0) return 1;
  if (winner < 0) return -1;
  if (!validMovesState(state).some(Boolean)) return 0;
  return null;
}

function moveWinsGroupState(state, group, cell, piece) {
  if (
    group < 0 ||
    group >= BOARD_GROUPS ||
    cell < 0 ||
    cell >= BOARD_CELLS ||
    piece === 0 ||
    !groupPlayableState(state, group) ||
    state.board[group][cell] !== 0
  ) {
    return false;
  }
  for (const line of WIN_LINES) {
    let winsLine = true;
    let containsCell = false;
    for (const c of line) {
      containsCell ||= c === cell;
      const value = c === cell ? piece : state.board[group][c];
      if (value !== piece) {
        winsLine = false;
        break;
      }
    }
    if (containsCell && winsLine) return true;
  }
  return false;
}

function moveWinsBoardState(state, group, cell, piece) {
  if (!moveWinsGroupState(state, group, cell, piece)) return false;
  const wins = Array.from({ length: BOARD_GROUPS }, (_, g) => groupWinnerState(state, g));
  wins[group] = piece;
  for (const line of WIN_LINES) {
    const a = wins[line[0]];
    if (a !== 0 && wins[line[1]] === a && wins[line[2]] === a) return true;
  }
  return false;
}

function playerHasLocalWinThreatState(state, group, piece, excludeCell = -1, excludePiece = 0) {
  if (group < 0 || group >= BOARD_GROUPS || piece === 0 || !groupPlayableState(state, group)) {
    return false;
  }
  for (let cell = 0; cell < BOARD_CELLS; cell++) {
    if (cell === excludeCell || state.board[group][cell] !== 0) continue;
    for (const line of WIN_LINES) {
      let winsLine = true;
      let containsCell = false;
      for (const c of line) {
        containsCell ||= c === cell;
        let value = state.board[group][c];
        if (c === cell) {
          value = piece;
        } else if (c === excludeCell) {
          value = excludePiece;
        }
        if (value !== piece) {
          winsLine = false;
          break;
        }
      }
      if (containsCell && winsLine) return true;
    }
  }
  return false;
}

function moveGivesOpponentFreeChoiceState(state, group, cell, piece) {
  const destination = cell;
  if (!groupPlayableState(state, destination)) return true;
  if (group !== cell) return false;
  let fullAfterMove = true;
  for (let c = 0; c < BOARD_CELLS; c++) {
    if (c !== cell && state.board[group][c] === 0) {
      fullAfterMove = false;
      break;
    }
  }
  if (fullAfterMove) return true;
  for (const line of WIN_LINES) {
    let winsLine = true;
    for (const c of line) {
      const value = c === cell ? piece : state.board[group][c];
      if (value !== piece) {
        winsLine = false;
        break;
      }
    }
    if (winsLine) return true;
  }
  return false;
}

function moveSendsToLocalWinThreatState(state, group, cell, piece, opponentPiece) {
  if (
    group < 0 ||
    group >= BOARD_GROUPS ||
    cell < 0 ||
    cell >= BOARD_CELLS ||
    state.board[group][cell] !== 0 ||
    piece === 0 ||
    opponentPiece === 0
  ) {
    return false;
  }

  if (moveGivesOpponentFreeChoiceState(state, group, cell, piece)) {
    for (let g = 0; g < BOARD_GROUPS; g++) {
      if (
        playerHasLocalWinThreatState(
          state,
          g,
          opponentPiece,
          group === g ? cell : -1,
          group === g ? piece : 0,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  const destination = cell;
  if (!groupPlayableState(state, destination)) return false;
  return playerHasLocalWinThreatState(
    state,
    destination,
    opponentPiece,
    group === destination ? cell : -1,
    group === destination ? piece : 0,
  );
}

function canonicalizedState(state) {
  const data = new Float32Array(CANONICAL_PLANES * 9 * 9);
  const sign = stateSign(state);
  const valids = validMovesState(state);
  const groupWinners = Array.from({ length: BOARD_GROUPS }, (_, g) => groupWinnerState(state, g));
  const groupClosed = Array.from(
    { length: BOARD_GROUPS },
    (_, g) => groupWinners[g] !== 0 || groupFullState(state, g),
  );
  function set(plane, row, col, value) {
    data[plane * 81 + row * 9 + col] = value;
  }
  for (let g = 0; g < BOARD_GROUPS; g++) {
    const winner = groupWinners[g];
    const closed = groupClosed[g];
    for (let c = 0; c < BOARD_CELLS; c++) {
      const { row, col } = groupCellToPhysical(g, c);
      const piece = state.board[g][c];
      set(CURRENT_PLAYER_CELLS, row, col, piece === sign ? 1 : 0);
      set(OPPONENT_CELLS, row, col, piece === -sign ? 1 : 0);
      set(LEGAL_MOVES, row, col, valids[g * BOARD_CELLS + c]);
      set(CURRENT_PLAYER_WON_BOARDS, row, col, winner === sign ? 1 : 0);
      set(OPPONENT_WON_BOARDS, row, col, winner === -sign ? 1 : 0);
      set(CLOSED_BOARDS, row, col, closed ? 1 : 0);
      if (
        valids[g * BOARD_CELLS + c] !== 0 &&
        (groupClosed[c] || (g === c && moveGivesOpponentFreeChoiceState(state, g, c, sign)))
      ) {
        set(GIVES_OPPONENT_FREE_CHOICE, row, col, 1);
      }
      if (!closed && piece === 0) {
        if (moveWinsGroupState(state, g, c, sign)) {
          set(CURRENT_LOCAL_WIN_THREATS, row, col, 1);
        }
        if (moveWinsGroupState(state, g, c, -sign)) {
          set(OPPONENT_LOCAL_WIN_THREATS, row, col, 1);
        }
        if (moveWinsBoardState(state, g, c, sign)) {
          set(CURRENT_MACRO_WIN_THREATS, row, col, 1);
        }
        if (moveWinsBoardState(state, g, c, -sign)) {
          set(OPPONENT_MACRO_WIN_THREATS, row, col, 1);
        }
        if (
          valids[g * BOARD_CELLS + c] !== 0 &&
          moveSendsToLocalWinThreatState(state, g, c, sign, -sign)
        ) {
          set(SENDS_OPPONENT_TO_LOCAL_WIN, row, col, 1);
        }
        if (moveSendsToLocalWinThreatState(state, g, c, -sign, sign)) {
          set(OPPONENT_SENDS_CURRENT_TO_LOCAL_WIN, row, col, 1);
        }
      }
    }
  }
  if (state.lastGroup !== NO_MOVE || state.lastCell !== NO_MOVE) {
    if (state.lastGroup >= 0 && state.lastGroup < BOARD_GROUPS && state.lastCell >= 0 && state.lastCell < BOARD_GROUPS) {
      const { row, col } = groupCellToPhysical(state.lastGroup, state.lastCell);
      set(LAST_MOVE, row, col, 1);
    }
  }
  if (state.lastCell >= 0 && state.lastCell < BOARD_GROUPS && groupPlayableState(state, state.lastCell)) {
    for (let c = 0; c < BOARD_CELLS; c++) {
      const { row, col } = groupCellToPhysical(state.lastCell, c);
      set(FORCED_BOARD, row, col, 1);
    }
  }
  return data;
}

function playMoveState(state, move) {
  const next = {
    board: state.board.map((group) => group.slice()),
    player: 1 - state.player,
    turn: state.turn + 1,
    lastGroup: Math.floor(move / BOARD_CELLS),
    lastCell: move % BOARD_CELLS,
  };
  next.board[next.lastGroup][next.lastCell] = stateSign(state);
  return next;
}

async function evaluateState(state) {
  const key = stateKey(state);
  const cached = evalCache.get(key);
  if (cached) return cached;
  const input = new ort.Tensor("float32", canonicalizedState(state), [1, CANONICAL_PLANES, 9, 9]);
  const outputs = await session.run({ canonical: input });
  const prediction = {
    value: outputs.value_probs.data,
    policy: outputs.policy_probs.data,
  };
  evalCache.set(key, prediction);
  if (evalCache.size > 20000) {
    const firstKey = evalCache.keys().next().value;
    evalCache.delete(firstKey);
  }
  return prediction;
}

function terminalValueForSideToMove(state) {
  const result = gameResultState(state);
  if (result === null) return null;
  if (result === 0) return 0;
  return result === stateSign(state) ? 1 : -1;
}

function canonicalized() {
  return canonicalizedState(cloneState());
}

async function evaluate() {
  if (!session) return null;
  return evaluateState(cloneState());
}

class SearchNode {
  constructor(state, prior = 1, move = -1, parent = null) {
    this.state = state;
    this.prior = prior;
    this.move = move;
    this.parent = parent;
    this.children = [];
    this.n = 0;
    this.w = 0;
  }

  get q() {
    return this.n > 0 ? this.w / this.n : 0;
  }
}

function gumbelSample() {
  const u = Math.min(1 - 1e-12, Math.max(1e-12, Math.random()));
  return -Math.log(-Math.log(u));
}

function normalizeLegalPolicy(policy, valids) {
  const priors = Array(NUM_MOVES).fill(0);
  let total = 0;
  for (let move = 0; move < NUM_MOVES; move++) {
    if (valids[move]) {
      priors[move] = Math.max(policy[move], 1e-12);
      total += priors[move];
    }
  }
  if (total <= 0) {
    const legalCount = valids.reduce((a, b) => a + (b ? 1 : 0), 0);
    for (let move = 0; move < NUM_MOVES; move++) {
      if (valids[move]) priors[move] = 1 / legalCount;
    }
    return priors;
  }
  for (let move = 0; move < NUM_MOVES; move++) priors[move] /= total;
  return priors;
}

async function expandNode(node) {
  const terminal = terminalValueForSideToMove(node.state);
  if (terminal !== null) return terminal;
  const prediction = await evaluateState(node.state);
  const valids = validMovesState(node.state);
  const priors = normalizeLegalPolicy(prediction.policy, valids);
  for (let move = 0; move < NUM_MOVES; move++) {
    if (valids[move]) {
      node.children.push(new SearchNode(playMoveState(node.state, move), priors[move], move, node));
    }
  }
  return prediction.value[0] - prediction.value[1];
}

function selectChild(node, allowedRootMoves = null, isRoot = false) {
  const sqrtN = Math.sqrt(Math.max(1, node.n));
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children) {
    if (isRoot && allowedRootMoves && !allowedRootMoves.has(child.move)) continue;
    const qFromParent = -child.q;
    const u = 1.5 * child.prior * sqrtN / (1 + child.n);
    const score = qFromParent + u;
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
}

function backprop(path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    node.n += 1;
    node.w += v;
    v = -v;
  }
}

function gumbelCandidateMoves(root, visits) {
  const legal = root.children.map((child) => ({
    child,
    score: gumbelSample() + Math.log(child.prior + 1e-12),
  }));
  if (!useGumbelEl.checked || legal.length === 0) {
    return new Set(root.children.map((c) => c.move));
  }
  const m = Math.max(1, Math.min(legal.length, visits, Math.round(Math.sqrt(visits) * 1.5)));
  legal.sort((a, b) => b.score - a.score);
  return new Set(legal.slice(0, m).map((entry) => entry.child.move));
}

function finalSearchMove(root, allowedMoves, visits) {
  let best = null;
  let bestScore = -Infinity;
  const sigma = 50 + Math.max(0, ...root.children.map((c) => c.n));
  for (const child of root.children) {
    if (!allowedMoves.has(child.move)) continue;
    const score = useGumbelEl.checked
      ? Math.log(child.prior + 1e-12) + sigma * (-child.q)
      : child.n;
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  if (best) return best.move;
  return chooseMoveFromVisits(root, visits);
}

function chooseMoveFromVisits(root) {
  let best = root.children[0];
  for (const child of root.children) {
    if (child.n > best.n) best = child;
  }
  return best.move;
}

async function searchMove(rootState, visits) {
  const root = new SearchNode(rootState);
  const rootValue = await expandNode(root);
  root.n = 1;
  root.w = rootValue;
  if (root.children.length === 0) return -1;
  const allowedRootMoves = gumbelCandidateMoves(root, visits);
  for (let i = 0; i < visits; i++) {
    let node = root;
    const path = [node];
    while (node.children.length > 0) {
      node = selectChild(node, allowedRootMoves, node === root);
      if (!node) break;
      path.push(node);
    }
    if (!node) continue;
    const value = await expandNode(node);
    backprop(path, value);
    if (i % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return finalSearchMove(root, allowedRootMoves, visits);
}

function chooseMove(policy) {
  const valids = validMoves();
  const temperature = Number(tempEl.value);
  if (temperature <= 0) {
    let bestMove = -1;
    let bestScore = -Infinity;
    for (let move = 0; move < NUM_MOVES; move++) {
      if (valids[move] && policy[move] > bestScore) {
        bestScore = policy[move];
        bestMove = move;
      }
    }
    return bestMove;
  }

  const weights = [];
  let total = 0;
  for (let move = 0; move < NUM_MOVES; move++) {
    const w = valids[move] ? Math.pow(Math.max(policy[move], 1e-12), 1 / temperature) : 0;
    weights[move] = w;
    total += w;
  }
  let r = Math.random() * total;
  for (let move = 0; move < NUM_MOVES; move++) {
    r -= weights[move];
    if (r <= 0) return move;
  }
  return valids.findIndex(Boolean);
}

function playMove(move) {
  const valids = validMoves();
  if (!valids[move]) return false;
  const group = Math.floor(move / BOARD_CELLS);
  const cell = move % BOARD_CELLS;
  board[group][cell] = playerSign();
  lastGroup = group;
  lastCell = cell;
  moveLog.push({ player, group, cell });
  player = 1 - player;
  turn += 1;
  return true;
}

function updateEvalText(value) {
  if (!value) {
    evalEl.textContent = "";
    const emptyTitle = "X/O/draw unavailable";
    evalBarEl.title = emptyTitle;
    evalXEl.title = emptyTitle;
    evalOEl.title = emptyTitle;
    evalDrawEl.title = emptyTitle;
    evalXEl.style.flexBasis = "0%";
    evalOEl.style.flexBasis = "0%";
    evalDrawEl.style.flexBasis = "0%";
    return;
  }
  const xWin = player === 0 ? value[0] : value[1];
  const oWin = player === 0 ? value[1] : value[0];
  const draw = value[2];
  const xPct = 100 * xWin;
  const oPct = 100 * oWin;
  const drawPct = 100 * draw;
  evalEl.textContent = `X/O/D: ${xPct.toFixed(1)}% / ${oPct.toFixed(1)}% / ${drawPct.toFixed(1)}%`;
  const title = `X win ${xPct.toFixed(1)}%, O win ${oPct.toFixed(1)}%, draw ${drawPct.toFixed(1)}%`;
  evalBarEl.title = title;
  evalXEl.title = title;
  evalOEl.title = title;
  evalDrawEl.title = title;
  evalXEl.style.flexBasis = `${xPct}%`;
  evalOEl.style.flexBasis = `${oPct}%`;
  evalDrawEl.style.flexBasis = `${drawPct}%`;
}

function pieceAsset(piece, large = false) {
  if (piece > 0) return large ? "./big_x.svg" : "./x.svg";
  if (piece < 0) return large ? "./big_o.svg" : "./o.svg";
  return "";
}

function pieceName(piece) {
  if (piece > 0) return "X";
  if (piece < 0) return "O";
  return "empty";
}

function appendPieceImage(parent, piece, large = false) {
  const src = pieceAsset(piece, large);
  if (!src) return;
  const img = document.createElement("img");
  img.className = large ? "overlay-piece" : "piece";
  img.src = src;
  img.alt = pieceName(piece);
  parent.appendChild(img);
}

function render() {
  const valids = validMoves();
  const result = gameResult();
  boardEl.innerHTML = "";
  for (let group = 0; group < BOARD_GROUPS; group++) {
    const smallBoard = document.createElement("div");
    const winner = groupWinner(group);
    smallBoard.className = "small-board";
    if (winner !== 0 || groupFull(group)) smallBoard.classList.add("board-closed");
    if (winner > 0) smallBoard.classList.add("board-won-x");
    if (winner < 0) smallBoard.classList.add("board-won-o");

    for (let cell = 0; cell < BOARD_CELLS; cell++) {
      const move = group * BOARD_CELLS + cell;
      const button = document.createElement("button");
      button.className = "cell";
      const piece = board[group][cell];
      button.setAttribute("aria-label", `Move (${group + 1}, ${cell + 1}), ${pieceName(piece)}`);
      button.title = `Move (${group + 1}, ${cell + 1})`;
      button.disabled = !session || busy || Boolean(result) || player !== humanPlayer || !valids[move];
      if (session && valids[move] && !result && player === humanPlayer) button.classList.add("legal");
      appendPieceImage(button, piece);
      if (group === lastGroup && cell === lastCell) button.classList.add("last");
      button.addEventListener("click", async () => {
        if (playMove(move)) await afterMove();
      });
      smallBoard.appendChild(button);
    }

    if (winner !== 0) {
      const overlay = document.createElement("span");
      overlay.className = `board-overlay ${winner > 0 ? "x" : "o"}`;
      appendPieceImage(overlay, winner, true);
      smallBoard.appendChild(overlay);
    }

    boardEl.appendChild(smallBoard);
  }

  statusEl.textContent = result || `${player === humanPlayer ? "Your" : "AI"} turn (${player === 0 ? "X" : "O"})`;
  movesEl.innerHTML = "";
  for (const entry of moveLog) {
    const li = document.createElement("li");
    li.textContent = `(${entry.group + 1}, ${entry.cell + 1})`;
    movesEl.appendChild(li);
  }
  const lastMoveEl = movesEl.lastElementChild;
  if (lastMoveEl) {
    lastMoveEl.classList.add("last-move");
    lastMoveEl.scrollIntoView({ block: "nearest" });
  }
}

async function afterMove() {
  render();
  const result = gameResult();
  if (result) {
    updateEvalText(null);
    return;
  }
  const prediction = await evaluate();
  updateEvalText(prediction.value);
  if (player !== humanPlayer) {
    busy = true;
    render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const aiPrediction = await evaluate();
    updateEvalText(aiPrediction.value);
    const visits = Math.max(1, Number(visitsEl.value) | 0);
    statusEl.textContent = `AI thinking (${visits} visits)...`;
    const move = visits <= 1 ? chooseMove(aiPrediction.policy) : await searchMove(cloneState(), visits);
    playMove(move);
    busy = false;
    await afterMove();
  } else {
    render();
  }
}

async function newGame(aiFirst) {
  board = makeBoard();
  player = 0;
  turn = 0;
  lastGroup = NO_MOVE;
  lastCell = NO_MOVE;
  humanPlayer = aiFirst ? 1 : 0;
  moveLog.length = 0;
  busy = false;
  await afterMove();
}

document.getElementById("new-human").addEventListener("click", () => newGame(false));
document.getElementById("new-ai").addEventListener("click", () => newGame(true));

async function boot() {
  render();
  updateEvalText(null);
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/";
  session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  await newGame(false);
}

boot().catch((error) => {
  console.error(error);
  statusEl.textContent = `Failed to load model: ${error.message || error}`;
});
