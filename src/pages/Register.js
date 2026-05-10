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

function Register() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://localhost:4000');
  const navigate = useNavigate();

  useEffect(() => {
    getApiConfig().then(url => setBaseUrl(url));
  }, []);

  // 密码强度检查
  const getPasswordStrength = (pwd) => {
    if (!pwd) return { level: 0, text: '' };
    let level = 0;
    const checks = {
      length: pwd.length >= 8,
      upper: /[A-Z]/.test(pwd),
      lower: /[a-z]/.test(pwd),
      number: /[0-9]/.test(pwd)
    };

    if (checks.length) level++;
    if (checks.upper) level++;
    if (checks.lower) level++;
    if (checks.number) level++;

    const texts = ['', '弱', '中等', '强', '非常强'];
    const colors = ['', '#ff4757', '#ffa502', '#2ed573', '#1e90ff'];
    return { level, text: texts[level], color: colors[level] };
  };

  const passwordStrength = getPasswordStrength(password);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (username.length < 3 || username.length > 20) {
      setError('用户名需要3-20个字符');
      return;
    }

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    // 前端初步验证
    if (password.length < 8) {
      setError('密码至少需要8个字符');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '注册失败');
      }

      alert('注册成功，请登录');
      navigate('/login');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1>注册</h1>
        {error && <div className="error-message">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-20个字符"
              required
            />
          </div>
          <div className="form-group">
            <label>邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="请输入邮箱"
              required
            />
          </div>
          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少8位，包含大小写和数字"
              required
            />
            {password && (
              <div className="password-strength">
                <div className="strength-bar">
                  <div
                    className="strength-fill"
                    style={{
                      width: `${passwordStrength.level * 25}%`,
                      backgroundColor: passwordStrength.color
                    }}
                  />
                </div>
                <span style={{ color: passwordStrength.color }}>
                  强度: {passwordStrength.text}
                </span>
              </div>
            )}
            <div className="password-hints">
              <span className={password.length >= 8 ? 'ok' : ''}>8+字符</span>
              <span className={/[A-Z]/.test(password) ? 'ok' : ''}>大写字母</span>
              <span className={/[a-z]/.test(password) ? 'ok' : ''}>小写字母</span>
              <span className={/[0-9]/.test(password) ? 'ok' : ''}>数字</span>
            </div>
          </div>
          <div className="form-group">
            <label>确认密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="请再次输入密码"
              required
            />
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={loading || passwordStrength.level < 3}
          >
            {loading ? '注册中...' : '注册'}
          </button>
        </form>
        <p className="auth-link">
          已有账号？<Link to="/login">立即登录</Link>
        </p>
      </div>
    </div>
  );
}

export default Register;
