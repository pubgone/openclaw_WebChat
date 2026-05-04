# OpenClaw AI Chat

一个基于 React + Express 的 AI 聊天应用，连接 OpenClaw Agent 实现实时对话。

## 功能特性

- 用户注册/登录
- 实时 AI 对话（WebSocket + SSE）
- Markdown 消息渲染
- 会话管理（创建/删除/切换）
- 消息持久化（MySQL + Redis）
- 分模块日志系统

## 项目结构

```
├── src/                    # React 前端
│   ├── pages/             # 页面组件
│   │   ├── AICommand.js   # AI 聊天页面
│   │   ├── Login.js      # 登录页面
│   │   └── Register.js   # 注册页面
│   ├── App.js
│   ├── App.css
│   └── config.js         # API 配置
├── server/                 # Express 后端
│   ├── server.js         # 主服务
│   ├── websocket.js      # WebSocket 客户端
│   ├── worker.js         # 消息持久化 Worker
│   ├── db.js            # 数据库操作
│   └── logger.js        # 日志模块
└── logs/                  # 日志目录
```

## 快速开始

### 安装依赖

```bash
# 前端依赖
npm install

# 后端依赖
cd server && npm install
```

### 启动服务

```bash
# 启动后端 (端口 4000)
cd server && node server.js

# 启动前端 (端口 3000)
npm start
```

### 配置

1. 修改 `src/config.js` 中的 API 地址
2. 配置 OpenClaw Agent 连接信息（token, IP 等）

## 技术栈

- **前端**: React, react-router-dom, react-markdown
- **后端**: Express, WebSocket, SSE
- **数据库**: MySQL
- **缓存**: Redis
- **AI**: OpenClaw Agent

## 许可证

MIT
