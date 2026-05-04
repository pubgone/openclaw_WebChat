import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import API_CONFIG from '../config';

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
  const navigate = useNavigate();

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // 轮询 WebSocket 状态
    if (!loading) {
      const wsPollInterval = setInterval(async () => {
        try {
          const response = await fetch(`${API_CONFIG.BASE_URL}/api/ai/ws-status`);
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
    // 关闭之前的连接
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const eventSource = new EventSource(`${API_CONFIG.BASE_URL}/api/ai/stream?conversationId=${convId}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('connected', (e) => {
      console.log('[SSE] Connected', e.data);
    });

    eventSource.addEventListener('history', (e) => {
      console.log('[SSE] History message', e.data);
      const msg = JSON.parse(e.data);
      if (msg.role === 'assistant') {
        setMessages(prev => {
          // 检查是否已有相同的 commandId 消息，有则更新
          const existingIndex = prev.findIndex(m => m.commandId === msg.commandId);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = { ...updated[existingIndex], content: msg.content };
            return updated;
          }
          return [...prev, {
            id: Date.now() + Math.random(),
            role: msg.role,
            content: msg.content,
            commandId: msg.commandId
          }];
        });
      } else {
        // 用户消息也添加到历史中
        setMessages(prev => [...prev, {
          id: Date.now() + Math.random(),
          role: msg.role,
          content: msg.content,
          commandId: msg.commandId
        }]);
      }
    });

    eventSource.addEventListener('history_done', (e) => {
      console.log('[SSE] History done');
    });

    eventSource.addEventListener('chunk', (e) => {
      console.log('[SSE] Chunk received:', e.data);
      const data = JSON.parse(e.data);

      setMessages(prev => {
        // 查找是否有这个 commandId 的消息
        const existingIndex = prev.findIndex(m => m.commandId === data.id);
        if (existingIndex >= 0) {
          // 追加内容
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            content: updated[existingIndex].content + data.content
          };
          return updated;
        } else {
          // 新建消息
          return [...prev, {
            id: Date.now() + Math.random(),
            role: 'assistant',
            content: data.content,
            commandId: data.id
          }];
        }
      });
    });

    eventSource.addEventListener('done', (e) => {
      console.log('[SSE] Done', e.data);
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
    if (!loading && conversationId) {
      connectSSE(conversationId);
    }
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [loading, conversationId, connectSSE]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // 加载会话列表
  const loadConversations = async () => {
    try {
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/conversations`, {
        credentials: 'include'
      });
      if (!response.ok) {
        console.error('加载会话失败，状态:', response.status);
        return;
      }
      const data = await response.json();
      console.log('加载会话成功:', data.conversations);
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
  };

  // 删除会话
  const handleDeleteConversation = async (convId, e) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/conversations/${convId}`, {
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
    loadMessages(conv.id);
    setShowSidebar(false);
  };

  // 加载指定会话的消息
  const loadMessages = async (convId) => {
    try {
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/conversations/${convId}/messages`, {
        credentials: 'include'
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data.messages) {
        setMessages(data.messages.map(msg => ({
          id: Date.now() + Math.random(),
          role: msg.role,
          content: msg.content,
          commandId: msg.commandId
        })));
      }
    } catch (err) {
      console.error('加载消息失败:', err);
    }
  };

  const checkAuth = async () => {
    try {
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/auth/me`, {
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
      id: Date.now(),
      role: 'user',
      content: input
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInput = input;
    setInput('');
    setSending(true);

    try {
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/ai/command`, {
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
          id: Date.now() + 1,
          role: 'assistant',
          content: data.error || '发送失败',
          commandId: null
        }]);
        setSending(false);
      }
      // 成功时等待 SSE 推送，发送按钮保持禁用状态直到 done 事件

    } catch (err) {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: '网络错误，请重试',
        commandId: null
      }]);
      setSending(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_CONFIG.BASE_URL}/api/auth/logout`, {
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
        <div className="welcome-message">
          <p>👋 你好！我是 AI 助手</p>
          <p>有什么我可以帮你的吗？</p>
        </div>

        {messages.map((message) => (
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
                  <ReactMarkdown>{sending && message.commandId ? message.content + ' ▌' : message.content}</ReactMarkdown>
                </div>
              ) : (
                <div className="message-text">{message.content}</div>
              )}
            </div>
          </div>
        ))}
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
