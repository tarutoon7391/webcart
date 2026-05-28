const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// public/ ディレクトリを静的配信
app.use(express.static(path.join(__dirname, 'public')));

// ルーム管理（最大8人）
// rooms: Map<roomId, Map<socketId, { name, position, rotation, speed }>>
const rooms = new Map();
const MAX_PLAYERS = 8;
const MAX_NAME_LENGTH = 32;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_LAPS = 99;
const ITEM_TYPES = ['shell', 'banana', 'mushroom', 'star', 'bomb'];

// プレイヤーがどのルームに所属しているかの逆引きマップ
const playerRoom = new Map();

/**
 * 文字列が有効かチェックする（空でなく最大長以内）
 * @param {*} value
 * @param {number} maxLen
 * @returns {boolean}
 */
function isValidString(value, maxLen) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

/**
 * 座標オブジェクト { x, y, z } が有効な数値かチェックする
 * @param {*} pos
 * @returns {boolean}
 */
function isValidPosition(pos) {
  return (
    pos !== null &&
    typeof pos === 'object' &&
    typeof pos.x === 'number' &&
    isFinite(pos.x) &&
    typeof pos.y === 'number' &&
    isFinite(pos.y) &&
    typeof pos.z === 'number' &&
    isFinite(pos.z)
  );
}

/**
 * 回転値が有効な有限数値かチェックする
 * @param {*} val
 * @returns {boolean}
 */
function isValidNumber(val) {
  return typeof val === 'number' && isFinite(val);
}

io.on('connection', (socket) => {
  // ルーム参加イベント
  socket.on('join_room', ({ name, roomId } = {}) => {
    // 入力バリデーション
    if (!isValidString(name, MAX_NAME_LENGTH) || !isValidString(roomId, MAX_ROOM_ID_LENGTH)) {
      return;
    }

    // 既存ルームへの再参加を防ぐため、まず現在のルームから離脱
    leaveCurrentRoom(socket);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    const room = rooms.get(roomId);

    if (room.size >= MAX_PLAYERS) {
      socket.emit('room_full', { roomId });
      return;
    }

    // 名前をサニタイズ（制御文字を除去）
    const safeName = name.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (safeName.length === 0) return;

    room.set(socket.id, { name: safeName, position: null, rotation: null, speed: 0 });
    playerRoom.set(socket.id, roomId);
    socket.join(roomId);

    // ルーム内全プレイヤーリストをブロードキャスト
    broadcastRoomUpdate(roomId);
  });

  // カート状態更新イベント
  socket.on('kart_update', ({ position, rotation, speed } = {}) => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;

    // 入力バリデーション
    if (!isValidPosition(position) || !isValidNumber(rotation) || !isValidNumber(speed)) {
      return;
    }

    const player = room.get(socket.id);
    player.position = position;
    player.rotation = rotation;
    player.speed = speed;

    // 送信者以外の同ルームメンバー全員にブロードキャスト
    socket.to(roomId).emit('kart_update', {
      id: socket.id,
      position,
      rotation,
      speed,
    });
  });

  // アイテムヒットイベント
  socket.on('item_hit', ({ targetId, itemType } = {}) => {
    // 入力バリデーション
    if (
      typeof targetId !== 'string' ||
      !ITEM_TYPES.includes(itemType)
    ) {
      return;
    }

    // targetId が同じルーム内のプレイヤーかを確認
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;

    const targetRoomId = playerRoom.get(targetId);
    if (targetRoomId !== roomId) return;

    // ターゲットのソケットに直接送信
    io.to(targetId).emit('hit_by_item', {
      fromId: socket.id,
      itemType,
    });
  });

  // ラップ完了イベント
  socket.on('lap_complete', ({ lap } = {}) => {
    // 入力バリデーション
    if (!Number.isInteger(lap) || lap < 1 || lap > MAX_LAPS) {
      return;
    }

    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;

    const player = room.get(socket.id);

    // ルーム全員にブロードキャスト
    io.to(roomId).emit('lap_complete', {
      id: socket.id,
      name: player.name,
      lap,
    });
  });

  // 切断イベント
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

/**
 * プレイヤーを現在のルームから離脱させる
 * @param {import('socket.io').Socket} socket
 */
function leaveCurrentRoom(socket) {
  const roomId = playerRoom.get(socket.id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    // 空ルームは削除
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastRoomUpdate(roomId);
    }
  }

  playerRoom.delete(socket.id);
  socket.leave(roomId);
}

/**
 * ルーム内の全プレイヤーリストをブロードキャストする
 * @param {string} roomId
 */
function broadcastRoomUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const players = Array.from(room.entries()).map(([id, data]) => ({
    id,
    name: data.name,
  }));

  io.to(roomId).emit('room_update', { roomId, players });
}

server.listen(PORT, () => {
  console.log(`WebKart サーバー起動中: http://localhost:${PORT}`);
});
