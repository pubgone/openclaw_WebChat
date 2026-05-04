const WebSocket = require('ws');
const logger = require('./logger');

// Agent WebSocket 配置
const AGENT_WS_URL = 'ws://127.0.0.1:18789/v1/agent/chat';
// Shared token
const SHARED_TOKEN = 'f62f02fb948ee39b74b418f1f4fc3d4b0805764c6ace19c1';

let ws = null;
let reconnectTimer = null;
let isConnected = false;
let deviceToken = null;  // 认证成功后获得的设备令牌
let isFirstConnect = true;  // 首次连接用 shared token

// 待处理的命令队列（用于关联 AI 回复与 commandId）
let pendingCommandIds = [];

// commandId 到 conversationId 的映射
let commandIdToConvId = new Map();

// 回调
let statusCallback = null;
let chatMessageCallback = null;

const STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error'
};

// 设置回调
const setStatusCallback = (cb) => {
  statusCallback = cb;
};

const setChatMessageCallback = (cb) => {
  chatMessageCallback = cb;
};

// 连接状态
const getStatus = () => {
  if (!ws) return STATUS.DISCONNECTED;
  if (ws.readyState === WebSocket.CONNECTING) return STATUS.CONNECTING;
  if (ws.readyState === WebSocket.OPEN) return STATUS.CONNECTED;
  return STATUS.DISCONNECTED;
};

// 连接
const connect = () => {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    logger.ws.connecting(AGENT_WS_URL);
    return;
  }

  logger.ws.connecting(AGENT_WS_URL);
  notifyStatus(STATUS.CONNECTING);

  try {
    ws = new WebSocket(AGENT_WS_URL, {
      headers: { 'Origin': 'http://localhost:18789' }
    });

    ws.on('open', () => {
      logger.ws.connected();
      isConnected = true;
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        logger.ws.messageReceived('unknown', message.event || message.type);

        // connect.challenge
        if (message.type === 'event' && message.event === 'connect.challenge') {
          sendConnectRequest();
          return;
        }

        // hello-ok 认证成功
        if (message.type === 'res' && message.payload?.type === 'hello-ok') {
          logger.ws.authSuccess();
          if (message.payload.auth?.deviceToken) {
            deviceToken = message.payload.auth.deviceToken;
          }
          isFirstConnect = false;
          notifyStatus(STATUS.CONNECTED);
          return;
        }

        // hello-error 认证失败
        if (message.type === 'res' && message.payload?.type === 'hello-error') {
          logger.ws.authFailed(JSON.stringify(message.payload));
          notifyStatus(STATUS.ERROR);
          return;
        }

        // session.message - AI 回复
        if (message.type === 'event' && message.event === 'session.message') {
          if (chatMessageCallback) {
            chatMessageCallback(message.payload);
          }
          return;
        }

        // agent 事件 - AI 回复（流式 chunk）
        if (message.type === 'event' && message.event === 'agent') {
          const payload = message.payload;
          // stream: "assistant" 包含回复文本（可能有多个 chunk）
          if (payload.stream === 'assistant' && payload.data?.text) {
            const receiveTime = Date.now();
            const commandId = pendingCommandIds[0] || Date.now().toString();
            const conversationId = commandIdToConvId.get(commandId) || commandId;
            logger.ws.messageReceived(commandId, 'agent-chunk');
            if (chatMessageCallback) {
              chatMessageCallback({ content: payload.data.text, commandId: commandId, conversationId: conversationId, isFinal: false });
            }
          }
          return;
        }

        // chat 事件 - AI 回复（最终格式）
        if (message.type === 'event' && message.event === 'chat') {
          const payload = message.payload;
          // state: "final" 表示最终回复
          if (payload.state === 'final' && payload.message?.content) {
            const receiveTime = Date.now();
            const text = payload.message.content[0]?.text || payload.message.content;
            const commandId = pendingCommandIds.shift() || Date.now().toString();
            const conversationId = commandIdToConvId.get(commandId) || commandId;
            commandIdToConvId.delete(commandId);
            logger.ws.messageReceived(commandId, 'chat-final');
            if (chatMessageCallback) {
              chatMessageCallback({ content: text, commandId: commandId, conversationId: conversationId, isFinal: true });
            }
          }
          return;
        }

      } catch (err) {
        logger.ws.error(err.message);
      }
    });

    ws.on('error', (err) => {
      logger.ws.error(err.message);
      notifyStatus(STATUS.ERROR);
    });

    ws.on('close', () => {
      logger.ws.disconnected();
      isConnected = false;
      notifyStatus(STATUS.DISCONNECTED);
      scheduleReconnect();
    });

  } catch (err) {
    logger.ws.connectFailed(err.message);
    notifyStatus(STATUS.ERROR);
    scheduleReconnect();
  }
};

// 发送 connect 请求
const sendConnectRequest = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  console.log('[WebSocket] Auth with: shared token + openclaw-control-ui client');

  const connectRequest = {
    type: 'req',
    id: '1',
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'openclaw-control-ui', version: 'control-ui', platform: 'Win32', mode: 'webchat' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: SHARED_TOKEN },
      locale: 'zh-CN'
    }
  };

  ws.send(JSON.stringify(connectRequest));
  console.log('[WebSocket] Connect request sent');
};

// 发送聊天消息
const sendChatMessage = (content, commandId, conversationId) => {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[WebSocket] Not connected');
      resolve(false);
      return;
    }

    const id = commandId || Math.random().toString(36);
    const msg = {
      type: 'req',
      id: id,
      method: 'chat.send',
      params: {
        message: content,
        idempotencyKey: id,
        sessionKey: 'main'
      }
    };

    // 将 commandId 加入待处理队列，并保存 commandId 到 conversationId 的映射
    pendingCommandIds.push(commandId);
    commandIdToConvId.set(commandId, conversationId);

    const sendTime = Date.now();
    logger.ws.messageSent(commandId, content);

    ws.send(JSON.stringify(msg));

    resolve(true);
  });
};

// 查询聊天历史
const queryChatHistory = () => {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ error: 'not connected' });
      return;
    }

    const msg = {
      type: 'req',
      id: 'history_' + Date.now(),
      method: 'chat.history',
      params: {
        sessionKey: 'agent:main:main',
        limit: 10
      }
    };

    ws.send(JSON.stringify(msg));
    console.log('[WebSocket] Chat history requested');
    resolve(true);
  });
};

// 断开连接
const disconnect = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
  notifyStatus(STATUS.DISCONNECTED);
};

// 定时重连
const scheduleReconnect = () => {
  if (reconnectTimer) return;
  logger.ws.reconnecting(5000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
};

// 通知状态变化
const notifyStatus = (status) => {
  if (statusCallback) {
    statusCallback(status);
  }
};

module.exports = {
  STATUS,
  connect,
  disconnect,
  sendChatMessage,
  queryChatHistory,
  getStatus,
  setStatusCallback,
  setChatMessageCallback
};
