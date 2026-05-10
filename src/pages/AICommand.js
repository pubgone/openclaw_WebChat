import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';

// 动态获取 API 配置
const getApiConfig = async () => {
  try {
    const response = await fetch('/api-config.json');
    const config = await response.json();
    return { BASE_URL: config.API_BASE_URL };
  } catch {
    return { BASE_URL: 'http://localhost:4000' };
  }
};

function AICommand() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [showSidebar, setShowSidebar] = useState(false);
  const [wsStatus, setWsStatus] = useState('disconnected');
  const messagesEndRef = useRef(null);
  const eventSourceRef = useRef(null);
  const sseConvIdRef = useRef(null); // 当前 SSE 连接对应的 conversationId
  const convertedCommandIdsRef = useRef(new Set()); // 已从 user 转换为 assistant 的 commandId，防止重复创建
  const apiConfigRef = useRef({ BASE_URL: 'http://localhost:4000' }); // 默认值
  const [configReady, setConfigReady] = useState(false);
  const navigate = useNavigate();

  // 初始化 API 配置
  useEffect(() => {
    getApiConfig().then(config => {
      apiConfigRef.current = config;
      setConfigReady(true);
    });
  }, []);

  useEffect(() => {
    // 等配置加载完成后才检查认证
    if (configReady) {
      checkAuth(apiConfigRef.current.BASE_URL);
    }
  }, [configReady]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // 轮询 WebSocket 状态
    if (!loading) {
      const wsPollInterval = setInterval(async () => {
        try {
          const response = await fetch(`${apiConfigRef.current.BASE_URL}/api/ai/ws-status`);
          const data = await response.json();
          setWsStatus(data.wsStatus || 'disconnected');
        } catch (err) {
          setWsStatus('disconnected');
        }
      }, 3000);
      return () => clearInterval(wsPollInterval);
    }
  }, [loading]);

  // 连接 SSE 获取流式响应
  const connectSSE = useCallback((convId) => {
    console.log('[connectSSE] connecting to:', convId);

    if (eventSourceRef.current) {
      console.log('[connectSSE] closing existing');
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    sseConvIdRef.current = convId;
    console.log('[connectSSE] sseConvIdRef set to:', convId);

    const eventSource = new EventSource(`${apiConfigRef.current.BASE_URL}/api/ai/stream?conversationId=${convId}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('history', (e) => {
      const msg = JSON.parse(e.data);
      if (!msg.commandId) return;
      setMessages(prev => {
        const existingIndex = prev.findIndex(m => m.commandId === msg.commandId);
        if (existingIndex >= 0) {
          return prev;
        }
        return [...prev, {
          id: `${msg.commandId}-${msg.role}`,
          role: msg.role,
          content: msg.content,
          commandId: msg.commandId
        }];
      });
    });

    eventSource.addEventListener('history_done', (e) => {
    });

    eventSource.addEventListener('chunk', (e) => {
      const data = JSON.parse(e.data);
      console.log('[chunk]', data.id, 'len:', data.content.length, 'preview:', data.content.substring(0, 30));

      setMessages(prev => {
        console.log('[chunk] prev count:', prev.length);

        // 优先查找是否有已转换的 assistant 消息（commandId 为 data.id + '-assistant'）
        const convertedIndex = prev.findIndex(m => m.commandId === data.id + '-assistant');
        if (convertedIndex >= 0) {
          console.log('[chunk] found converted message, updating');
          const updated = [...prev];
          updated[convertedIndex] = { ...updated[convertedIndex], content: data.content };
          return updated;
        }

        // 查找原始 commandId
        const existingIndex = prev.findIndex(m => m.commandId === data.id);
        console.log('[chunk] existingIndex:', existingIndex, 'existing role:', existingIndex >= 0 ? prev[existingIndex].role : 'none');
        if (existingIndex >= 0) {
          // 如果已存在的消息是 user 的，不覆盖，直接创建新消息
          if (prev[existingIndex].role === 'user') {
            console.log('[chunk] found user message with same commandId, creating new assistant message instead');
            convertedCommandIdsRef.current.add(data.id);
            return [...prev, {
              id: data.id.toString() + '-assistant',
              role: 'assistant',
              content: data.content,
              commandId: data.id + '-assistant'
            }];
          }
          // 正常更新 assistant 消息
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            content: data.content
          };
          return updated;
        } else {
          // 检查是否已转换过（避免重复创建）
          if (convertedCommandIdsRef.current.has(data.id)) {
            console.log('[chunk] already converted, skipping');
            return prev;
          }
          console.log('[chunk] creating new message with role: assistant, commandId:', data.id);
          return [...prev, {
            id: data.id.toString(),
            role: 'assistant',
            content: data.content,
            commandId: data.id
          }];
        }
      });
    });

    eventSource.addEventListener('done', (e) => {
      console.log('[SSE] Done');
      setSending(false);
    });

    eventSource.addEventListener('error', (e) => {
      console.error('[SSE] Error', e);
      eventSource.close();
      eventSourceRef.current = null;
    });

    return () => {
      eventSource.close();
    };
  }, []);

  // 切换会话时重新连接 SSE
  useEffect(() => {
    console.log('[useEffect] loading:', loading, 'convId:', conversationId);
    if (!loading && conversationId) {
      console.log('[useEffect] connecting SSE to', conversationId);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      connectSSE(conversationId);
    }
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      sseConvIdRef.current = null;
    };
  }, [loading, conversationId, connectSSE]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // 加载会话列表
  const loadConversations = async () => {
    try {
      const response = await fetch(`${apiConfigRef.current.BASE_URL}/api/conversations`, {
        credentials: 'include'
      });
      if (!response.ok) {
        console.error('加载会话失败，状态:', response.status);
        return;
      }
      const data = await response.json();
      setConversations(data.conversations || []);
      if (data.conversations && data.conversations.length > 0) {
        const latestConv = data.conversations[0];
        setConversationId(latestConv.id);
        loadMessages(latestConv.id);
      }
    } catch (err) {
      console.error('加载会话失败:', err);
    }
  };

  // 新建会话
  const handleNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    convertedCommandIdsRef.current.clear();
  };

  // 删除会话
  const handleDeleteConversation = async (convId, e) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`${apiConfigRef.current.BASE_URL}/api/conversations/${convId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert('删除失败: ' + (data.error || '未知错误'));
        return;
      }

      if (convId === conversationId) {
        setMessages([]);
        setConversationId(null);
      }
      loadConversations();
    } catch (err) {
      console.error('删除会话失败:', err);
      alert('删除会话失败，请检查网络');
    } finally {
      setDeleting(false);
    }
  };

  // 切换会话
  const handleSelectConversation = (conv) => {
    setConversationId(conv.id);
    convertedCommandIdsRef.current.clear();
    loadMessages(conv.id);
    setShowSidebar(false);
  };

  // 加载指定会话的消息
  const loadMessages = async (convId) => {
    try {
      const response = await fetch(`${apiConfigRef.current.BASE_URL}/api/conversations/${convId}/messages`, {
        credentials: 'include'
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data.messages) {
        setMessages(data.messages.map((msg, idx) => ({
          id: msg.commandId ? `${msg.commandId}-${msg.role}` : `loaded-${idx}`,
          role: msg.role,
          content: msg.content,
          commandId: msg.commandId
        })));
      }
    } catch (err) {
      console.error('加载消息失败:', err);
    }
  };

  const checkAuth = async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        credentials: 'include'
      });

      if (!response.ok) {
        navigate('/login');
        return;
      }

      const data = await response.json();
      setUser(data.user);
      loadConversations();
      setLoading(false);
    } catch (err) {
      navigate('/login');
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const userMessage = {
      id: 'user-' + Date.now(),
      role: 'user',
      content: input
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInput = input;
    setInput('');
    setSending(true);

    try {
      const response = await fetch(`${apiConfigRef.current.BASE_URL}/api/ai/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: currentInput,
          conversationId: conversationId
        })
      });

      const data = await response.json();

      if (!data.success) {
        setMessages(prev => [...prev, {
          id: 'error-' + Date.now(),
          role: 'assistant',
          content: data.error || '发送失败',
          commandId: null
        }]);
        setSending(false);
      } else if (data.conversationId && data.conversationId !== conversationId) {
        console.log('[handleSend] New conv:', data.conversationId, 'old:', conversationId);
        setConversationId(data.conversationId);
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        id: 'neterror-' + Date.now(),
        role: 'assistant',
        content: '网络错误，请重试',
        commandId: null
      }]);
      setSending(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${apiConfigRef.current.BASE_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } catch (err) {
      console.error('退出失败:', err);
    }
    navigate('/login');
  };

  if (loading) {
    return (
      <div className="chat-container">
        <div className="chat-loading">加载中...</div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      <header className="chat-header">
        <div className="header-left">
          <button className="btn-menu" onClick={() => setShowSidebar(!showSidebar)}>☰</button>
          <h1>AI 助手</h1>
          <span className="user-info">欢迎, {user?.username}</span>
          <span className={`ws-status ws-${wsStatus}`}>
            {wsStatus === 'connected' ? '🟢 Agent在线' : wsStatus === 'connecting' ? '🟡 连接中...' : '🔴 Agent离线'}
          </span>
        </div>
        <div className="header-right">
          <button className="btn-new" onClick={handleNewConversation}>新建会话</button>
          <button onClick={handleLogout} className="btn-logout">退出</button>
        </div>
      </header>

      {showSidebar && (
        <div className="sidebar">
          <div className="sidebar-header">
            <h3>会话历史</h3>
            <button className="btn-close" onClick={() => setShowSidebar(false)}>×</button>
          </div>
          <div className="conversation-list">
            {conversations.map(conv => (
              <div
                key={conv.id}
                className={`conversation-item ${conv.id === conversationId ? 'active' : ''}`}
                onClick={() => handleSelectConversation(conv)}
              >
                <span className="conversation-title">{conv.title || '新会话'}</span>
                <button
                  className="btn-delete"
                  onClick={(e) => handleDeleteConversation(conv.id, e)}
                  disabled={deleting}
                >🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !sending && (
          <div className="welcome-message">
            <p>👋 你好！我是 AI 助手</p>
            <p>有什么我可以帮你的吗？</p>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={message.id}
            className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}
          >
            <div className="message-avatar">
              {message.role === 'user' ? '👤' : '🤖'}
            </div>
            <div className="message-content">
              {message.role === 'assistant' ? (
                <div className="message-text">
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              ) : (
                <div className="message-text">{message.content}</div>
              )}
            </div>
          </div>
        ))}


        {sending && (
          <div className="message assistant-message">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="message-text">
                <span className="thinking-text">思考中</span>
                <span className="thinking-dot">.</span>
                <span className="thinking-dot">.</span>
                <span className="thinking-dot">.</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-area" onSubmit={handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息..."
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? '发送中...' : '发送'}
        </button>
      </form>
    </div>
  );
}

export default AICommand;
