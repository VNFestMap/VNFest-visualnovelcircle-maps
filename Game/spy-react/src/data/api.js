/* ==========================================================================
   谁是卧底 · 后端接口封装
   [HERE] Game/spy-react/src/data/api.js
   服务端端点：api/spy_rooms.php / spy_table.php / spy_actions.php
   封套统一为 {success, ...}；失败时 message 是给玩家看的人话。
   ========================================================================== */

const ROOMS = '../../api/spy_rooms.php';
const TABLE = '../../api/spy_table.php';
const ACTIONS = '../../api/spy_actions.php';

async function post(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError('网络连接异常，请稍后重试。', 'network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('服务器响应异常，请稍后重试。', 'bad_response');
  }
  if (!res.ok || !data || data.success !== true) {
    throw new ApiError((data && data.message) || '操作失败，请稍后重试。', 'api', res.status);
  }
  return data;
}

export class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/* ---- 房间生命周期（spy_rooms.php） ---- */
export const listRooms = () => post(ROOMS, { action: 'list' });
export const createRoom = (patch) => post(ROOMS, { action: 'create', ...patch });
export const joinRoom = (code, joinCode = '') => post(ROOMS, { action: 'join', code, join_code: joinCode });
export const leaveRoom = (code) => post(ROOMS, { action: 'leave', code });
export const configRoom = (code, patch) => post(ROOMS, { action: 'config', code, patch });
export const setReady = (code, ready) => post(ROOMS, { action: 'ready', code, ready: ready ? 1 : 0 });
export const startGame = (code) => post(ROOMS, { action: 'start', code });
export const closeRoom = (code) => post(ROOMS, { action: 'close', code });

/* ---- 圆桌快照（spy_table.php）。since=rev 增量轮询 ---- */
export const fetchTable = (code, since = 0) => post(TABLE, { action: 'table', code, since });

/* ---- 玩家与房主动作（spy_actions.php） ---- */
export const submitSentence = (code, body, skip = false) =>
  post(ACTIONS, { action: 'sentence', code, body, skip: skip ? 1 : 0 });
export const castVote = (code, toSeat) =>
  post(ACTIONS, { action: 'vote', code, to_seat: toSeat });
export const nightAction = (code, targetSeat) =>
  post(ACTIONS, { action: 'night', code, target_seat: targetSeat });
export const blankGuess = (code, guessA, guessB) =>
  post(ACTIONS, { action: 'guess', code, guess_a: guessA, guess_b: guessB });
export const advancePhase = (code) => post(ACTIONS, { action: 'advance', code });
export const resolveTie = (code, ruling, seat = null) =>
  post(ACTIONS, { action: 'resolve', code, ruling, seat });
export const assignRole = (code, seat, role) =>
  post(ACTIONS, { action: 'assign', code, seat, role });
