const express = require('express');
const os = require('os');

// 获取本机 IP 地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '0.0.0.0';
}

const LOCAL_IP = getLocalIP();
console.log(`[启动] 本机IP: ${LOCAL_IP}`);

// 生成前端配置文件
const fs = require('fs');
const path = require('path');
const configPath = path.join(__dirname, '../public/api-config.json');
const frontendUrl = `http://${LOCAL_IP}:4000`;
fs.writeFileSync(configPath, JSON.stringify({ API_BASE_URL: frontendUrl }, null, 2));
console.log(`[启动] 已生成前端配置文件: ${configPath}`);

const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const { createClient } = require('redis');
const { pool, saveMessage, getMessagesByConversationId, updateMessageByCommandId, createConversation, getConversationsByUserId, redisClient } = require('./db');
const websocket = require('./websocket');
const logger = require('./logger');

const app = express();
const PORT = 4000;

// ========== 安全中间件 ==========

// Helmet - 安全 HTTP Headers
app.use(helmet());

// CORS - 自动允许请求来源
app.use(cors({
  origin: true,
  credentials: true
}));

// JSON 解析 - 限制请求体大小
app.use(express.json({ limit: '10kb' }));

// 减速器 - 多次请求后降速
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 100,
  delayMs: () => 500
});
app.use(speedLimiter);

// 限流器
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: '请求过于频繁，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试次数过多，请15分钟后再试' }
});

// Session（使用内存存储，重启会丢失登录态）
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// ========== MySQL 用户操作函数 ==========

const saveUser = async (user) => {
  const sql = `
    INSERT INTO users (id, username, email, password, created_at, login_fail_count, locked_until)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      username = VALUES(username),
      email = VALUES(email),
      password = VALUES(password),
      login_fail_count = VALUES(login_fail_count),
      locked_until = VALUES(locked_until)
  `;
  await pool.execute(sql, [
    user.id,
    user.username,
    user.email,
    user.password,
    new Date(user.createdAt),
    user.loginFailCount || 0,
    user.lockedUntil || null
  ]);
};

const getUserById = async (id) => {
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
  if (rows.length === 0) return null;
  const user = rows[0];
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    password: user.password,
    createdAt: user.created_at.toISOString(),
    loginFailCount: user.login_fail_count,
    lockedUntil: user.locked_until
  };
};

const getUserByUsername = async (username) => {
  const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
  if (rows.length === 0) return null;
  const user = rows[0];
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    password: user.password,
    createdAt: user.created_at.toISOString(),
    loginFailCount: user.login_fail_count,
    lockedUntil: user.locked_until
  };
};

const getAllUsers = async () => {
  const [rows] = await pool.execute('SELECT email FROM users');
  return rows.map(row => ({ email: row.email }));
};

// ========== 验证函数 ==========

const validatePassword = (password) => {
  if (!password || password.length < 8) return '密码至少需要8个字符';
  if (!/[A-Z]/.test(password)) return '密码需要包含大写字母';
  if (!/[a-z]/.test(password)) return '密码需要包含小写字母';
  if (!/[0-9]/.test(password)) return '密码需要包含数字';
  return null;
};

// ========== 路由 ==========

// 注册
app.post('/api/auth/register',
  authLimiter,
  [
    body('username').trim().isLength({ min: 3, max: 20 }).withMessage('用户名需要3-20个字符'),
    body('email').isEmail().normalizeEmail().withMessage('请输入有效的邮箱'),
    body('password').isLength({ min: 8 }).withMessage('密码至少8个字符')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { username, email, password } = req.body;

      const passwordError = validatePassword(password);
      if (passwordError) {
        return res.status(400).json({ error: passwordError });
      }

      // 检查用户名是否存在
      const existingUser = await getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: '用户名已存在' });
      }

      // 检查邮箱是否存在（需要遍历）
      const allUsers = await getAllUsers();
      const existingEmail = allUsers.find(u => u.email === email);
      if (existingEmail) {
        return res.status(400).json({ error: '邮箱已被注册' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = {
        id: Date.now().toString(),
        username,
        email,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        loginFailCount: 0,
        lockedUntil: null
      };

      await saveUser(user);

      logger.auth.registerSuccess(username);
      res.status(201).json({ message: '注册成功', userId: user.id });

    } catch (error) {
      logger.auth.registerFail(username, error.message);
      res.status(500).json({ error: '服务器错误' });
    }
  }
);

// 登录
app.post('/api/auth/login',
  loginLimiter,
  [
    body('username').trim().notEmpty(),
    body('password').notEmpty()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: '请输入用户名和密码' });
      }

      const { username, password } = req.body;

      const user = await getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      // 检查账号是否被锁定
      if (user.lockedUntil && Date.now() < user.lockedUntil) {
        const remainingMinutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
        return res.status(423).json({
          error: `账号已被锁定，请在 ${remainingMinutes} 分钟后重试`
        });
      }

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        user.loginFailCount = (user.loginFailCount || 0) + 1;

        if (user.loginFailCount >= 5) {
          user.lockedUntil = Date.now() + 15 * 60 * 1000;
          user.loginFailCount = 0;
          await saveUser(user);
          logger.auth.accountLocked(username);
          return res.status(423).json({ error: '连续登录失败次数过多，账号已被锁定15分钟' });
        }

        await saveUser(user);
        logger.auth.loginFail(username, `剩余${5 - user.loginFailCount}次机会`);
        return res.status(401).json({ error: '用户名或密码错误' });
      }

      // 登录成功
      user.loginFailCount = 0;
      user.lockedUntil = null;
      await saveUser(user);

      req.session.userId = user.id;
      req.session.username = user.username;
      logger.auth.loginSuccess(username);

      res.json({
        message: '登录成功',
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
      });

    } catch (error) {
      logger.auth.loginFail(username, error.message);
      res.status(500).json({ error: '服务器错误' });
    }
  }
);

// 退出登录
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: '退出失败' });
    }
    res.json({ message: '已退出登录' });
  });
});

// 获取当前用户
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const user = await getUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email
    }
  });
});

// ========== AI 命令接口 ==========

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: '请求过于频繁，请稍后再试' }
});

app.post('/api/ai/command',
  aiLimiter,
  [
    body('message').trim().isLength({ min: 1, max: 2000 }).withMessage('消息长度需在1-2000字符之间')
  ],
  async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { message, conversationId } = req.body;
      const commandId = Date.now().toString();
      let convId = conversationId;

      // 创建新会话（如果需要）
      if (!convId) {
        const conv = await createConversation(req.session.userId, message.substring(0, 50));
        convId = conv.id;
      }

      // 将用户消息写入 Redis 队列（由 Worker 异步写入 MySQL）
      await redisClient.lPush('messages:pending', JSON.stringify({
        conversationId: convId,
        role: 'user',
        content: message,
        commandId: commandId,
        userId: req.session.userId
      }));

      // 通过 WebSocket 发送聊天消息给 Agent
      const wsStatus = websocket.getStatus();
      const wsConnected = wsStatus === websocket.STATUS.CONNECTED;
      if (wsConnected) {
        await websocket.sendChatMessage(message, commandId, convId, req.session.userId);
        logger.message.sent(commandId, convId, message);
      } else {
        // 如果 WebSocket 未连接，放入队列（保留轮询接口作为后备）
        await redisClient.lPush('ai:commands:pending', JSON.stringify({
          id: commandId,
          userId: req.session.userId,
          username: req.session.username,
          message: message,
          conversationId: convId,
          timestamp: new Date().toISOString()
        }));
        logger.ws.disconnected();
      }

      logger.message.sent(commandId, convId, message);

      // 立即返回成功，让前端知道消息已接收
      res.json({
        success: true,
        commandId: commandId,
        conversationId: convId,
        message: message,
        status: 'pending'
      });

    } catch (error) {
      logger.api.validationFailed('message');
      res.status(500).json({ error: '处理命令失败' });
    }
  }
);

// Agent 获取待处理命令（轮询接口）
app.get('/api/ai/commands', async (req, res) => {
  try {
    // 从队列取出命令（最新优先）
    const commands = [];
    let cmd = await redisClient.rPop('ai:commands:pending');
    while (cmd && commands.length < 10) {
      commands.push(JSON.parse(cmd));
      cmd = await redisClient.rPop('ai:commands:pending');
    }

    res.json({
      commands: commands,
      count: commands.length
    });
  } catch (error) {
    console.error('获取命令错误:', error);
    res.status(500).json({ error: '获取命令失败' });
  }
});

// Agent 提交处理结果
app.post('/api/ai/result',
  [
    body('id').notEmpty(),
    body('result').notEmpty(),
    body('conversationId').notEmpty().withMessage('conversationId is required')
  ],
  async (req, res) => {
    try {
      const { id, result, conversationId } = req.body;

      // 将 AI 回复写入 Redis 队列（由 Worker 异步写入 MySQL）
      await redisClient.lPush('messages:pending', JSON.stringify({
        conversationId: conversationId,
        role: 'assistant',
        content: result,
        commandId: id,
        userId: null
      }));

      // 存入结果队列（供前端轮询）
      await redisClient.lPush('ai:results:pending', JSON.stringify({
        id: id,
        result: result,
        timestamp: new Date().toISOString()
      }));

      res.json({ success: true });
    } catch (error) {
      console.error('提交结果错误:', error);
      res.status(500).json({ error: '提交结果失败' });
    }
  }
);

// 前端轮询获取结果
app.get('/api/ai/results', async (req, res) => {
  try {
    const results = [];
    let result = await redisClient.rPop('ai:results:pending');
    while (result && results.length < 10) {
      results.push(JSON.parse(result));
      result = await redisClient.rPop('ai:results:pending');
    }

    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: '获取结果失败' });
  }
});

app.get('/api/ai/status', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '请先登录' });
  }

  res.json({
    status: 'ready',
    openclaws: 'not_connected'
  });
});

// WebSocket 状态检查
app.get('/api/ai/ws-status', (req, res) => {
  res.json({
    wsStatus: websocket.getStatus()
  });
});

// Redis 调试端点
app.get('/api/debug/redis', async (req, res) => {
  try {
    const isOpen = redisClient.isOpen;
    const len = await redisClient.lLen('ai:results:pending');
    const testSet = await redisClient.lPush('ai:results:pending', JSON.stringify({id: 'debug', result: 'test'}));
    const afterLen = await redisClient.lLen('ai:results:pending');
    const first = await redisClient.rPop('ai:results:pending');
    res.json({
      redisIsOpen: isOpen,
      queueLength: len,
      afterPushLength: afterLen,
      lastPopped: first
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// WebSocket 调试端点
app.get('/api/debug/ws', (req, res) => {
  res.json({
    wsStatus: websocket.getStatus(),
    statusConnected: websocket.STATUS.CONNECTED
  });
});

// 查询聊天历史
app.get('/api/debug/chat-history', (req, res) => {
  websocket.queryChatHistory();
  res.json({ message: 'Chat history requested' });
});

// ========== SSE 客户端管理 ==========
const sseClients = new Map(); // conversationId -> Set of response objects

const addSSEClient = (conversationId, res) => {
  if (!sseClients.has(conversationId)) {
    sseClients.set(conversationId, new Set());
  }
  sseClients.get(conversationId).add(res);
  logger.sse.clientConnected(conversationId, sseClients.get(conversationId).size);
};

const removeSSEClient = (conversationId, res) => {
  if (sseClients.has(conversationId)) {
    sseClients.get(conversationId).delete(res);
    const remaining = sseClients.get(conversationId).size;
    logger.sse.clientDisconnected(conversationId, remaining);
    if (remaining === 0) {
      sseClients.delete(conversationId);
    }
  }
};

const sendToSSEClient = (conversationId, event, data) => {
  if (sseClients.has(conversationId)) {
    const clients = sseClients.get(conversationId);
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    console.log(`[SSE Push] convId:${conversationId} event:${event} clients:${clients.size} dataLen:${data.content?.length || JSON.stringify(data).length}`);
    for (const client of clients) {
      client.write(message);
    }
  } else {
    console.log(`[SSE Push] convId:${conversationId} event:${event} - NO CLIENTS`);
  }
};

// SSE 流式端点
app.get('/api/ai/stream', (req, res) => {
  const { conversationId } = req.query;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId required' });
  }

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // 发送初始连接成功消息
  res.write(`event: connected\ndata: ${JSON.stringify({ conversationId })}\n\n`);

  // 添加客户端
  addSSEClient(conversationId, res);

  // 如果有之前的消息，发送历史
  const sendHistory = async () => {
    try {
      const messages = await getMessagesByConversationId(conversationId);
      for (const msg of messages) {
        res.write(`event: history\ndata: ${JSON.stringify(msg)}\n\n`);
      }
      res.write(`event: history_done\ndata: ${JSON.stringify({})}\n\n`);
      logger.sse.historySent(conversationId, messages.length);
    } catch (err) {
      logger.sse.pushFailed(conversationId, err.message);
    }
  };
  sendHistory();

  // 清理函数
  req.on('close', () => {
    removeSSEClient(conversationId, res);
  });
});

// ========== WebSocket 消息处理 ==========
// 设置聊天消息回调 - 处理 agent 流式 chunk 和 chat 最终回复
websocket.setChatMessageCallback(async (payload) => {
  if (!payload.content) return;

  try {
    const resultId = payload.commandId || Date.now().toString();
    const conversationId = payload.conversationId;

    if (payload.isFinal) {
      // chat 事件的最终回复 - 发送 done 事件
      sendToSSEClient(conversationId, 'done', { id: resultId });
      await redisClient.lPush('messages:pending', JSON.stringify({
        conversationId: conversationId,
        role: 'assistant',
        content: payload.content,
        commandId: resultId,
        userId: null
      }));
      logger.message.persisted(resultId, 'assistant');
    } else {
      // agent 事件的流式 chunk - 发送 chunk 事件
      sendToSSEClient(conversationId, 'chunk', {
        id: resultId,
        content: payload.content
      });
    }
  } catch (err) {
    logger.sse.pushFailed('unknown', err.message);
  }
});

// ========== 会话和消息接口 ==========

// 获取用户的所有会话
app.get('/api/conversations', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const conversations = await getConversationsByUserId(req.session.userId);
    res.json({ conversations });
  } catch (error) {
    console.error('获取会话错误:', error);
    res.status(500).json({ error: '获取会话失败' });
  }
});

// 获取会话的所有消息
app.get('/api/conversations/:conversationId/messages', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const messages = await getMessagesByConversationId(req.params.conversationId);
    res.json({ messages });
  } catch (error) {
    console.error('获取消息错误:', error);
    res.status(500).json({ error: '获取消息失败' });
  }
});

// 删除会话
app.delete('/api/conversations/:conversationId', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: '请先登录' });
    }
    const { conversationId } = req.params;
    // 删除会话下的所有消息
    await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    // 删除会话
    await pool.execute('DELETE FROM conversations WHERE id = ? AND user_id = ?', [conversationId, req.session.userId]);
    // 清除缓存
    await redisClient.del(`conversations:${req.session.userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('删除会话错误:', error);
    res.status(500).json({ error: '删除会话失败' });
  }
});

// ========== 启动 ==========

const start = async () => {
  try {
    // 测试 MySQL 连接
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('MySQL 连接成功');

    // 连接 Redis (AI 队列用)
    await redisClient.connect();
    logger.redis.connected();

    // 连接 Agent WebSocket
    websocket.connect();

    app.listen(PORT, '0.0.0.0', () => {
      logger.system.serverStarted(PORT);
    });
  } catch (err) {
    logger.system.serverError(err.message);
  }
};

start();
