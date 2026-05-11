/**
 * 日志模块 - 同时输出到终端和文件，自动清理过期日志
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
const MAX_LOG_AGE_DAYS = 7; // 保留7天

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 获取当天日志文件路径
const getLogFilePath = () => {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `server-${date}.log`);
};

// 格式化时间戳 (不含毫秒，更清晰)
const formatTime = () => {
  const now = new Date();
  return now.toISOString().split('T')[0] + ' ' + now.toTimeString().split(' ')[0];
};

// 清理过期日志
const cleanupOldLogs = () => {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const now = Date.now();
    const maxAge = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

    files.forEach(file => {
      if (!file.startsWith('server-') || !file.endsWith('.log')) return;
      const filePath = path.join(LOG_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`[Log] 已删除过期日志: ${file}`);
      }
    });
  } catch (err) {
    console.error('[Log] 清理日志失败:', err);
  }
};

// 启动时清理过期日志
cleanupOldLogs();

// 定时清理（每天检查一次）
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// 日志写入函数
const writeLog = (level, module, message, data = null) => {
  const timestamp = formatTime();
  let logLine = `[${timestamp}] [${level}] [${module}] ${message}`;
  if (data) {
    if (typeof data === 'object') {
      logLine += ` | ${JSON.stringify(data)}`;
    } else {
      logLine += ` | ${data}`;
    }
  }

  // 输出到终端
  console.log(logLine);

  // 写入文件
  try {
    fs.appendFileSync(getLogFilePath(), logLine + '\n');
  } catch (err) {
    console.error('[Log] 写入日志文件失败:', err);
  }
};

// 模块化的日志方法
const logger = {
  // 认证模块
  auth: {
    loginSuccess: (username) => writeLog('INFO', 'AUTH', '登录成功', { username }),
    loginFail: (username, reason) => writeLog('WARN', 'AUTH', '登录失败', { username, reason }),
    registerSuccess: (username) => writeLog('INFO', 'AUTH', '注册成功', { username }),
    registerFail: (username, reason) => writeLog('WARN', 'AUTH', '注册失败', { username, reason }),
    logout: (username) => writeLog('INFO', 'AUTH', '登出', { username }),
    accountLocked: (username) => writeLog('WARN', 'AUTH', '账号被锁定', { username }),
  },

  // 会话模块
  conversation: {
    created: (conversationId, title) => writeLog('INFO', 'CONV', '会话创建', { conversationId, title }),
    deleted: (conversationId) => writeLog('INFO', 'CONV', '会话删除', { conversationId }),
    listLoaded: (count) => writeLog('INFO', 'CONV', '会话列表加载', { count }),
    switchTo: (conversationId) => writeLog('INFO', 'CONV', '切换会话', { conversationId }),
  },

  // 消息模块
  message: {
    sent: (commandId, conversationId, preview) => writeLog('INFO', 'MSG', '消息发送', { commandId, conversationId, preview: preview?.substring(0, 30) }),
    received: (commandId, content, isFinal) => writeLog('INFO', 'MSG', '消息接收', { commandId, content: String(content).substring(0, 30), isFinal }),
    historyLoaded: (conversationId, count) => writeLog('INFO', 'MSG', '历史消息加载', { conversationId, count }),
    persisted: (messageId, role) => writeLog('INFO', 'MSG', '消息持久化', { messageId, role }),
  },

  // SSE模块
  sse: {
    clientConnected: (conversationId, totalClients) => writeLog('INFO', 'SSE', '客户端连接', { conversationId, totalClients }),
    clientDisconnected: (conversationId, remainingClients) => writeLog('INFO', 'SSE', '客户端断开', { conversationId, remainingClients }),
    chunkSent: (conversationId, size) => writeLog('DEBUG', 'SSE', '数据块发送', { conversationId, size }),
    pushSuccess: (conversationId, duration) => writeLog('DEBUG', 'SSE', '推送耗时', { conversationId, duration: `${duration}ms` }),
    pushFailed: (conversationId, error) => writeLog('ERROR', 'SSE', '推送失败', { conversationId, error }),
    historySent: (conversationId, count) => writeLog('INFO', 'SSE', '历史消息发送', { conversationId, count }),
  },

  // WebSocket模块
  ws: {
    connecting: (url) => writeLog('INFO', 'WS', '正在连接', { url }),
    connected: () => writeLog('INFO', 'WS', '连接成功', null),
    connectFailed: (error) => writeLog('ERROR', 'WS', '连接失败', { error }),
    authSuccess: () => writeLog('INFO', 'WS', '认证成功', null),
    authFailed: (reason) => writeLog('ERROR', 'WS', '认证失败', { reason }),
    messageSent: (commandId, preview) => writeLog('INFO', 'WS', '消息已发送', { commandId, preview: preview?.substring(0, 30) }),
    messageReceived: (commandId, event) => writeLog('INFO', 'WS', '消息已接收', { commandId, event }),
    error: (error) => writeLog('ERROR', 'WS', '错误', { error }),
    disconnected: () => writeLog('WARN', 'WS', '连接断开', null),
    reconnecting: (delay) => writeLog('INFO', 'WS', '准备重连', { delay: `${delay}ms` }),
  },

  // 数据库模块
  db: {
    querySuccess: (operation, duration) => writeLog('DEBUG', 'DB', '查询成功', { operation, duration: `${duration}ms` }),
    queryFailed: (operation, error) => writeLog('ERROR', 'DB', '查询失败', { operation, error }),
    insertSuccess: (table, id) => writeLog('INFO', 'DB', '插入成功', { table, id }),
    updateSuccess: (table, id) => writeLog('INFO', 'DB', '更新成功', { table, id }),
    deleteSuccess: (table, id) => writeLog('INFO', 'DB', '删除成功', { table, id }),
  },

  // Redis模块
  redis: {
    connected: () => writeLog('INFO', 'REDIS', '连接成功', null),
    connectFailed: (error) => writeLog('ERROR', 'REDIS', '连接失败', { error }),
    pushSuccess: (queue, size) => writeLog('DEBUG', 'REDIS', '写入队列', { queue, size }),
    popSuccess: (queue) => writeLog('DEBUG', 'REDIS', '读取队列', { queue }),
    operationFailed: (operation, error) => writeLog('ERROR', 'REDIS', '操作失败', { operation, error }),
  },

  // 缓存模块
  cache: {
    miss: (key) => writeLog('INFO', 'CACHE', '缓存未命中', { key }),
    hit: (key, age) => writeLog('INFO', 'CACHE', '缓存命中', { key, age: `${age}s ago` }),
    expired: (key) => writeLog('INFO', 'CACHE', '缓存过期', { key }),
    set: (key, ttl) => writeLog('INFO', 'CACHE', '缓存设置', { key, ttl: `${ttl}s` }),
    delete: (key) => writeLog('INFO', 'CACHE', '缓存删除', { key }),
    refresh: (key) => writeLog('INFO', 'CACHE', '缓存刷新', { key }),
    error: (operation, error) => writeLog('ERROR', 'CACHE', '缓存错误', { operation, error }),
  },

  // Worker模块
  worker: {
    started: () => writeLog('INFO', 'WORKER', 'Worker启动', null),
    messageProcessed: (messageId, duration) => writeLog('INFO', 'WORKER', '消息处理', { messageId, duration: `${duration}ms` }),
    processingFailed: (error) => writeLog('ERROR', 'WORKER', '处理失败', { error }),
    conversationNotFound: (conversationId) => writeLog('WARN', 'WORKER', '会话不存在，跳过', { conversationId }),
  },

  // API模块
  api: {
    request: (method, path, ip) => writeLog('DEBUG', 'API', '请求', { method, path, ip }),
    response: (method, path, statusCode, duration) => writeLog('DEBUG', 'API', '响应', { method, path, statusCode, duration: `${duration}ms` }),
    rateLimited: (ip) => writeLog('WARN', 'API', '请求受限', { ip }),
    validationFailed: (field) => writeLog('WARN', 'API', '验证失败', { field }),
  },

  // 系统模块
  system: {
    serverStarted: (port) => writeLog('INFO', 'SYSTEM', '服务启动', { port }),
    serverError: (error) => writeLog('ERROR', 'SYSTEM', '服务错误', { error }),
    cleanup: (filesDeleted) => writeLog('INFO', 'SYSTEM', '日志清理', { filesDeleted }),
  }
};

module.exports = logger;
