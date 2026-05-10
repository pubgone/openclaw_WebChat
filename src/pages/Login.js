import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';

// 动态获取 API 配置
const getApiConfig = async () => {
  try {
    const response = await fetch('/api-config.json');
    const config = await response.json();
    return config.API_BASE_URL;
  } catch {
    return 'http://localhost:4000';
  }
};

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://localhost:4000');
  const navigate = useNavigate();

  useEffect(() => {
    getApiConfig().then(url => setBaseUrl(url));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '登录失败');
      }

      // 登录成功，跳转到AI命令页面
      navigate('/ai-command');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1>登录</h1>
        {error && <div className="error-message">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              required
            />
          </div>
          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              required
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        <p className="auth-link">
          还没有账号？<Link to="/register">立即注册</Link>
        </p>
      </div>
    </div>
  );
}

export default Login;
