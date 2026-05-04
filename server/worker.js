/**
 * 后台 Worker：消费 Redis 队列，批量写入 MySQL
 */
const { createClient } = require('redis');
const mysql = require('mysql2/promise');
const logger = require('./logger');

const MESSAGE_QUEUE = 'messages:pending';
const BATCH_SIZE = 10;
const POLL_INTERVAL = 1000; // 1秒

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1234',
  database: process.env.DB_NAME || 'react_app',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

const redisClient = createClient({ url: 'redis://localhost:6379' });
redisClient.on('error', (err) => logger.redis.operationFailed('connect', err.message));

// 缓存管理（从 db.js 复用逻辑）
const CACHE_TTL = 300;
const getCache = async (key) => {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) { return null; }
};
const setCache = async (key, value, ttl = CACHE_TTL) => {
  try { await redisClient.setEx(key, ttl, JSON.stringify(value)); } catch (err) {}
};
const deleteCache = async (key) => {
  try { await redisClient.del(key); } catch (err) {}
};
const invalidateUserCache = async (userId) => {
  await deleteCache(`conversations:${userId}`);
};

const processMessage = async (msg) => {
  const { conversationId, role, content, commandId, userId } = msg;

  const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
  const now = new Date();

  // 检查会话是否还存在
  const [convRows] = await pool.execute(
    'SELECT id FROM conversations WHERE id = ?',
    [conversationId]
  );

  if (convRows.length === 0) {
    logger.worker.conversationNotFound(conversationId);
    return;
  }

  const startTime = Date.now();

  // 写入 MySQL
  await pool.execute(
    'INSERT INTO messages (id, conversation_id, role, content, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, conversationId, role, content, commandId, now]
  );

  // 更新会话更新时间
  await pool.execute(
    'UPDATE conversations SET updated_at = ? WHERE id = ?',
    [now, conversationId]
  );

  // 清除缓存
  await deleteCache(`messages:${conversationId}`);
  if (userId) {
    await invalidateUserCache(userId);
  }

  logger.worker.messageProcessed(id, Date.now() - startTime);
};

const startWorker = async () => {
  try {
    await redisClient.connect();
    logger.redis.connected();

    // 测试 MySQL 连接
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    logger.db.querySuccess('ping', 0);

    logger.worker.started();

    // 主循环：轮询 Redis 队列
    while (true) {
      try {
        const messages = [];
        let msg = await redisClient.rPop(MESSAGE_QUEUE);

        while (msg && messages.length < BATCH_SIZE) {
          messages.push(JSON.parse(msg));
          msg = await redisClient.rPop(MESSAGE_QUEUE);
        }

        if (messages.length > 0) {
          for (const m of messages) {
            try {
              await processMessage(m);
            } catch (err) {
              logger.worker.processingFailed(err.message);
              // 处理失败的消息重新放回队列
              await redisClient.lPush(MESSAGE_QUEUE, JSON.stringify(m));
            }
          }
        }
      } catch (err) {
        logger.redis.operationFailed('poll', err.message);
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
  } catch (err) {
    console.error('[Worker] Startup error:', err);
  }
};

startWorker();
