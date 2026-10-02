'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const logger = require('./services/logger');
const queue = require('./services/queue');
const { requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const printRoutes = require('./routes/print');

const app = express();

// 部署在 Cloudflare Tunnel 之后，需要信任代理以正确识别协议 / IP
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(
  session({
    name: 'webprint.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // Cloudflare Tunnel 在边缘已加密；如需强制 HTTPS 可置为 'auto'
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

app.get('/health', (req, res) => res.json({ ok: true, service: 'web-print' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', authRoutes);
app.use('/api', requireAuth, printRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: '接口不存在' });
  }
  return res.status(404).send('Not Found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof require('multer').MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `文件超过大小限制（最大 ${Math.round(config.maxFileSize / 1024 / 1024)}MB）`
      : `上传失败：${err.message}`;
    return res.status(400).json({ error: message });
  }
  logger.error('未处理的错误', err);
  return res.status(500).json({ error: '服务器内部错误' });
});

queue.load();

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`web-print 已启动，监听 0.0.0.0:${config.port}`);
  if (!process.env.AUTH_PASS) {
    logger.warn('未设置 AUTH_PASS 环境变量，正在使用默认密码 admin123，请尽快修改！');
  }
});

process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM，正在关闭服务...');
  server.close(() => process.exit(0));
});

module.exports = app;
