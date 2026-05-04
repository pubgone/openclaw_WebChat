const mysql = require('mysql2/promise');
const { createClient } = require('redis');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1234',
  database: process.env.DB_NAME || 'react_app',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4'
});

// Redis 缓存客户端
const redisClient = createClient({ url: 'redis://localhost:6379' });
redisClient.on('error', (err) => console.log('Redis Cache Error', err));

const CACHE_TTL = 300; // 5分钟

// ========== Redis 缓存工具 ==========

const getCache = async (key) => {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error('Cache get error:', err);
    return null;
  }
};

const setCache = async (key, value, ttl = CACHE_TTL) => {
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(value));
  } catch (err) {
    console.error('Cache set error:', err);
  }
};

const deleteCache = async (key) => {
  try {
    await redisClient.del(key);
  } catch (err) {
    console.error('Cache delete error:', err);
  }
};

const invalidateUserCache = async (userId) => {
  await deleteCache(`conversations:${userId}`);
};

// ========== 会话操作 ==========

const createConversation = async (userId, title) => {
  const id = Date.now().toString();
  const now = new Date();
  await pool.execute(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, title || '', now, now]
  );
  await invalidateUserCache(userId);
  return { id, userId, title, createdAt: now, updatedAt: now };
};

const getConversationsByUserId = async (userId) => {
  const cacheKey = `conversations:${userId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const [rows] = await pool.execute(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
    [userId]
  );
  const conversations = rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));

  await setCache(cacheKey, conversations);
  return conversations;
};

const updateConversationUpdatedAt = async (conversationId) => {
  await pool.execute(
    'UPDATE conversations SET updated_at = ? WHERE id = ?',
    [new Date(), conversationId]
  );
};

// ========== 消息操作 ==========

const saveMessage = async (conversationId, role, content, commandId = null) => {
  const id = Date.now().toString();
  const now = new Date();
  await pool.execute(
    'INSERT INTO messages (id, conversation_id, role, content, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, conversationId, role, content, commandId, now]
  );
  await updateConversationUpdatedAt(conversationId);
  await deleteCache(`messages:${conversationId}`);
  return { id, conversationId, role, content, commandId, createdAt: now };
};

const getMessagesByConversationId = async (conversationId) => {
  const cacheKey = `messages:${conversationId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const [rows] = await pool.execute(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId]
  );
  const messages = rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    commandId: row.command_id,
    createdAt: row.created_at
  }));

  await setCache(cacheKey, messages);
  return messages;
};

const updateMessageByCommandId = async (commandId, content) => {
  const [rows] = await pool.execute(
    'SELECT * FROM messages WHERE command_id = ?',
    [commandId]
  );
  if (rows.length > 0) {
    await pool.execute(
      'UPDATE messages SET content = ? WHERE id = ?',
      [content, rows[0].id]
    );
  }
};

const updateMessageContent = async (messageId, content) => {
  await pool.execute(
    'UPDATE messages SET content = ? WHERE id = ?',
    [content, messageId]
  );
};

module.exports = {
  pool,
  redisClient,
  createConversation,
  getConversationsByUserId,
  updateConversationUpdatedAt,
  saveMessage,
  getMessagesByConversationId,
  updateMessageByCommandId,
  updateMessageContent,
  invalidateUserCache
};
