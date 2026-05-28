const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'webkart-dev-secret-change-me';
if (IS_PRODUCTION && SESSION_SECRET === 'webkart-dev-secret-change-me') {
  console.warn(
    '[WebKart] 警告: 本番環境ですが SESSION_SECRET が未設定です。' +
    '必ず環境変数 SESSION_SECRET にランダムな文字列を設定してください。'
  );
}
const BCRYPT_ROUNDS = 10;

// ===========================================================================
// PostgreSQL (Railway) 接続設定
// ===========================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway の PostgreSQL は SSL 必須なケースが多いため有効化
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

/**
 * 起動時に users テーブルを自動作成する。
 */
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('[WebKart] DATABASE_URL が未設定のため DB 初期化をスキップします');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[WebKart] users テーブルを確認/作成しました');
}

// ===========================================================================
// Express ミドルウェア
// ===========================================================================
app.use(express.json());

if (IS_PRODUCTION) {
  // Railway などのリバースプロキシ配下で secure cookie を正しく扱う
  app.set('trust proxy', 1);
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION, // 本番環境では HTTPS のみで送信
    maxAge: 1000 * 60 * 60 * 24, // 24時間
  },
});
app.use(sessionMiddleware);

// --- 軽量な CSRF 対策: 状態変更系 API は同一オリジンからの POST のみ許可 ---
// SameSite=Lax と組み合わせて多くのクロスサイト攻撃をブロックする。
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/api/')) {
    const origin = req.get('origin') || req.get('referer') || '';
    if (origin) {
      const hostHeader = req.get('host');
      try {
        const url = new URL(origin);
        if (url.host !== hostHeader) {
          return res.status(403).json({ error: 'クロスサイトリクエストは拒否されました' });
        }
      } catch (e) {
        return res.status(403).json({ error: 'リクエスト元の検証に失敗しました' });
      }
    }
  }
  next();
});

// --- 簡易レートリミッタ: 認証エンドポイントのブルートフォース対策 ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateLimitBuckets = new Map(); // ip -> { count, windowStart }
function rateLimit(req, res, next) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const now = Date.now();
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateLimitBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてから再度お試しください' });
  }
  next();
}
// バケツの肥大化を防ぐため定期的にクリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitBuckets.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// public/ ディレクトリを静的配信
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io でも同じセッションを使う
io.engine.use(sessionMiddleware);

// ===========================================================================
// バリデーション
// ===========================================================================
const MAX_USERNAME_LENGTH = 50;
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 128;
const MAX_PLAYERS = 8;
const MAX_LAPS = 99;
const ROOM_ID_LENGTH = 6;
const ITEM_TYPES = ['🍄', '🍌', '🔴', '🔵'];
const LEGACY_ITEM_TYPES = ['shell', 'banana', 'mushroom', 'star', 'bomb'];
const COURSE_IDS = ['mario_circuit', 'desert', 'night'];

function isValidUsername(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_USERNAME_LENGTH &&
    // \w (a-zA-Z0-9_) と日本語(ひらがな/カタカナ/漢字)のみ許可
    /^[\w\-ぁ-んァ-ヶ一-龠]+$/u.test(value)
  );
}

function isValidPassword(value) {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  );
}

function isValidPosition(pos) {
  return (
    pos !== null &&
    typeof pos === 'object' &&
    typeof pos.x === 'number' && isFinite(pos.x) &&
    typeof pos.y === 'number' && isFinite(pos.y) &&
    typeof pos.z === 'number' && isFinite(pos.z)
  );
}

function isValidNumber(val) {
  return typeof val === 'number' && isFinite(val);
}

// ===========================================================================
// 認証 API
// ===========================================================================
app.post('/api/register', rateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'ユーザー名が無効です' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'パスワードは4文字以上必要です' });
    }
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'サーバーの DB 設定が未完了です' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ userId: user.id, username: user.username });
  } catch (err) {
    if (err && err.code === '23505') {
      // ユニーク制約違反
      return res.status(409).json({ error: 'このユーザー名は既に使われています' });
    }
    console.error('[WebKart] /api/register エラー:', err);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

app.post('/api/login', rateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      return res.status(400).json({ error: 'ユーザー名またはパスワードが無効です' });
    }
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'サーバーの DB 設定が未完了です' });
    }
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ userId: user.id, username: user.username });
  } catch (err) {
    console.error('[WebKart] /api/login エラー:', err);
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

app.post('/api/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      loggedIn: true,
      userId: req.session.userId,
      username: req.session.username,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ===========================================================================
// Socket.io ルーム管理
// ルーム情報: { hostId, players: Map<socketId, { username }>, courseId, status }
// status: 'lobby' | 'racing'
// ===========================================================================
const rooms = new Map();
const playerRoom = new Map(); // socketId -> roomId

/**
 * 6桁の英数字ルームIDを生成する（衝突回避）
 */
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 長さ32
  // 256 % 32 === 0 のため、0-255 → 0-31 はバイアスなし
  for (let attempt = 0; attempt < 30; attempt++) {
    const buf = crypto.randomBytes(ROOM_ID_LENGTH);
    let id = '';
    for (let i = 0; i < ROOM_ID_LENGTH; i++) {
      // 32 の倍数(256)で割れるためモジュロバイアスは発生しない
      id += chars[buf[i] & 0x1f];
    }
    if (!rooms.has(id)) return id;
  }
  // 全部衝突したら長めの ID で再試行
  return 'R' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * room の状態をクライアントへ送信するための整形
 */
function serializeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    hostId: room.hostId,
    courseId: room.courseId,
    status: room.status,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      username: p.username,
      isHost: id === room.hostId,
    })),
  };
}

function broadcastRoomUpdate(roomId) {
  const data = serializeRoom(roomId);
  if (!data) return;
  io.to(roomId).emit('room_update', data);
}

function leaveCurrentRoom(socket, reason) {
  const roomId = playerRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  playerRoom.delete(socket.id);
  socket.leave(roomId);
  if (!room) return;

  room.players.delete(socket.id);

  // ホストが抜けた、もしくは空になった場合はルームを解散
  if (room.hostId === socket.id || room.players.size === 0) {
    io.to(roomId).emit('room_closed', {
      roomId,
      reason: reason || (room.hostId === socket.id ? 'host_left' : 'empty'),
    });
    // 残りのプレイヤーも全員退出させる
    for (const otherId of Array.from(room.players.keys())) {
      const otherSocket = io.sockets.sockets.get(otherId);
      if (otherSocket) {
        otherSocket.leave(roomId);
      }
      playerRoom.delete(otherId);
    }
    rooms.delete(roomId);
  } else {
    broadcastRoomUpdate(roomId);
  }
}

io.on('connection', (socket) => {
  function getSessionUsername() {
    const session = socket.request.session;
    return session && session.username ? session.username : null;
  }

  // ルーム作成（ホストとして自動入室）
  socket.on('create_room', (payload = {}, ack) => {
    const username =
      getSessionUsername() ||
      (typeof payload.username === 'string' && payload.username.trim()) ||
      null;
    if (!username) {
      if (typeof ack === 'function') ack({ error: 'ログインが必要です' });
      return;
    }
    leaveCurrentRoom(socket, 'switched');

    const roomId = generateRoomId();
    rooms.set(roomId, {
      hostId: socket.id,
      players: new Map([[socket.id, { username }]]),
      courseId: null,
      status: 'lobby',
    });
    playerRoom.set(socket.id, roomId);
    socket.join(roomId);

    const data = serializeRoom(roomId);
    if (typeof ack === 'function') ack({ roomId, room: data });
    io.to(roomId).emit('room_update', data);
  });

  // ルーム入室
  socket.on('join_room', (payload = {}, ack) => {
    const { roomId } = payload;
    const username =
      getSessionUsername() ||
      (typeof payload.username === 'string' && payload.username.trim()) ||
      null;
    if (!username) {
      if (typeof ack === 'function') ack({ error: 'ログインが必要です' });
      return;
    }
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 32) {
      if (typeof ack === 'function') ack({ error: 'ルームIDが無効です' });
      return;
    }
    const normalizedRoomId = roomId.toUpperCase();
    const room = rooms.get(normalizedRoomId);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'ルームが見つかりません' });
      return;
    }
    if (room.status !== 'lobby') {
      if (typeof ack === 'function') ack({ error: 'すでにレースが開始されています' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      if (typeof ack === 'function') ack({ error: 'ルームが満員です' });
      return;
    }
    leaveCurrentRoom(socket, 'switched');

    room.players.set(socket.id, { username });
    playerRoom.set(socket.id, normalizedRoomId);
    socket.join(normalizedRoomId);

    const data = serializeRoom(normalizedRoomId);
    if (typeof ack === 'function') ack({ roomId: normalizedRoomId, room: data });
    io.to(normalizedRoomId).emit('room_update', data);
  });

  // ルーム退出
  socket.on('leave_room', () => {
    leaveCurrentRoom(socket, 'left');
  });

  // レース開始（ホストのみ）
  socket.on('start_race', (payload = {}) => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const { courseId } = payload;
    if (!COURSE_IDS.includes(courseId)) return;

    room.courseId = courseId;
    room.status = 'racing';
    io.to(roomId).emit('start_race', {
      roomId,
      courseId,
      players: serializeRoom(roomId).players,
    });
  });

  // カート状態同期
  socket.on('kart_update', (payload = {}) => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.players.has(socket.id)) return;

    const { position, rotation, speed } = payload;
    if (!isValidPosition(position) || !isValidNumber(rotation) || !isValidNumber(speed)) {
      return;
    }
    const player = room.players.get(socket.id);
    socket.to(roomId).emit('kart_update', {
      id: socket.id,
      username: player.username,
      position,
      rotation,
      speed,
    });
  });

  // カート衝突通知
  socket.on('collision', (payload = {}) => {
    const { targetId } = payload;
    if (typeof targetId !== 'string') return;
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;
    // 送信者と対象が同じルームにいることを確認
    if (playerRoom.get(targetId) !== roomId) return;
    // 対象プレイヤーに衝突を通知
    io.to(targetId).emit('collision');
  });

  // アイテムヒット
  socket.on('item_hit', (payload = {}) => {
    const { targetId, itemType } = payload;
    if (typeof targetId !== 'string') return;
    if (!ITEM_TYPES.includes(itemType) && !LEGACY_ITEM_TYPES.includes(itemType)) return;
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;
    if (playerRoom.get(targetId) !== roomId) return;
    io.to(targetId).emit('hit_by_item', {
      fromId: socket.id,
      itemType,
    });
  });

  // ラップ完了
  socket.on('lap_complete', (payload = {}) => {
    const { lap } = payload;
    if (!Number.isInteger(lap) || lap < 1 || lap > MAX_LAPS) return;
    const roomId = playerRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.players.has(socket.id)) return;
    const player = room.players.get(socket.id);
    io.to(roomId).emit('lap_complete', {
      id: socket.id,
      username: player.username,
      lap,
    });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket, 'disconnect');
  });
});

// ===========================================================================
// サーバー起動
// ===========================================================================
initDb()
  .catch((err) => {
    console.error('[WebKart] DB 初期化に失敗:', err);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`WebKart サーバー起動中: http://localhost:${PORT}`);
    });
  });
