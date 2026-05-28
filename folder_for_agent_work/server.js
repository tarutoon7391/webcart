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

// プレイヤーがどのルームに所属しているかの逆引きマップ
const playerRoom = new Map();

io.on('connection', (socket) => {
  // ルーム参加イベント
  socket.on('join_room', ({ name, roomId }) => {
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

    room.set(socket.id, { name, position: null, rotation: null, speed: 0 });
    playerRoom.set(socket.id, roomId);
    socket.join(roomId);

    // ルーム内全プレイヤーリストをブロードキャスト
    broadcastRoomUpdate(roomId);
  });

  // カート状態更新イベント
  socket.on('kart_update', ({ position, rotation, speed }) => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;

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
  socket.on('item_hit', ({ targetId, itemType }) => {
    // ターゲットのソケットに直接送信
    io.to(targetId).emit('hit_by_item', {
      fromId: socket.id,
      itemType,
    });
  });

  // ラップ完了イベント
  socket.on('lap_complete', ({ lap }) => {
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
