const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const logger = require('./logger');

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

const CACHE_TTL = 60; // 1分钟（原5分钟，缩短提升一致性）

// ========== Redis 缓存工具 ==========

// 缓存数据结构：{ _t: 时间戳, d: 数据 }

const getCache = async (key) => {
  try {
    const data = await redisClient.get(key);
    if (!data) {
      logger.cache.miss(key);
      return null;
    }

    const cache = JSON.parse(data);
    const cacheTime = cache._t || 0;
    const now = Date.now();

    // 检查缓存是否过期
    if (now - cacheTime > CACHE_TTL * 1000) {
      // 缓存过期，删除并返回 null
      logger.cache.expired(key);
      await redisClient.del(key);
      return null;
    }

    const age = Math.round((now - cacheTime) / 1000);
    logger.cache.hit(key, age);
    return cache.d;
  } catch (err) {
    logger.cache.error('get', err.message);
    return null;
  }
};

const setCache = async (key, value, ttl = CACHE_TTL) => {
  try {
    // 存入缓存数据 + 时间戳
    const cache = { _t: Date.now(), d: value };
    await redisClient.setEx(key, ttl, JSON.stringify(cache));
    logger.cache.set(key, ttl);
  } catch (err) {
    logger.cache.error('set', err.message);
  }
};

const deleteCache = async (key) => {
  try {
    await redisClient.del(key);
    logger.cache.delete(key);
  } catch (err) {
    logger.cache.error('delete', err.message);
  }
};

// 双删策略：删除缓存后延迟再删除（防止并发读导致缓存重建）
const deleteCacheWithDelay = async (key, delayMs = 500) => {
  await deleteCache(key);
  setTimeout(() => deleteCache(key), delayMs);
};

const invalidateUserCache = async (userId) => {
  // 双删策略
  await deleteCacheWithDelay(`conversations:${userId}`);
};

// ========== 会话操作 ==========

const createConversation = async (userId, title) => {
  const id = Date.now().toString();
  const now = new Date();
  await pool.execute(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, title || '', now, now]
  );
  // 双删策略：立即删除 + 延迟500ms后再删除
  await deleteCacheWithDelay(`conversations:${userId}`);
  return { id, userId, title, createdAt: now, updatedAt: now };
};

const getConversationsByUserId = async (userId) => {
  const cacheKey = `conversations:${userId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    // 缓存命中 → 立即返回，同时后台异步刷新
    refreshCacheAsync(() => queryConversationsFromDB(userId), cacheKey);
    return cached;
  }

  // 缓存未命中 → 必须查数据库
  const conversations = await queryConversationsFromDB(userId);
  await setCache(cacheKey, conversations);
  return conversations;
};

// 查询会话列表（供缓存刷新复用）
const queryConversationsFromDB = async (userId) => {
  const [rows] = await pool.execute(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
};

// 后台异步刷新缓存
const refreshCacheAsync = async (queryFn, cacheKey) => {
  try {
    const data = await queryFn();
    await setCache(cacheKey, data);
    logger.cache.refresh(cacheKey);
  } catch (err) {
    logger.cache.error('refresh', err.message);
  }
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
  // 双删策略：立即删除 + 延迟500ms后再删除
  await deleteCacheWithDelay(`messages:${conversationId}`);
  return { id, conversationId, role, content, commandId, createdAt: now };
};

const getMessagesByConversationId = async (conversationId) => {
  const cacheKey = `messages:${conversationId}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    // 缓存命中 → 立即返回，同时后台异步刷新
    refreshCacheAsync(() => queryMessagesFromDB(conversationId), cacheKey);
    return cached;
  }

  // 缓存未命中 → 必须查数据库
  const messages = await queryMessagesFromDB(conversationId);
  await setCache(cacheKey, messages);
  return messages;
};

// 查询消息列表（供缓存刷新复用）
const queryMessagesFromDB = async (conversationId) => {
  const [rows] = await pool.execute(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId]
  );
  return rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    commandId: row.command_id,
    createdAt: row.created_at
  }));
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
