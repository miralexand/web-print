# web-print｜Web 打印服务（Docker + Cloudflare Tunnel + 宿主机打印 Agent）

> 仓库地址：https://github.com/miralexand/web-print
> 环境：电脑A 共享网络给电脑B，电脑B 位于 137 网段且可访问互联网。
> 目标：打包 Docker 部署在电脑B；Cloudflare Tunnel 对外提供网页打印服务。

```bash
git clone https://github.com/miralexand/web-print.git
cd web-print
```

一个可直接运行的网页打印系统，包含两部分：

| 模块 | 运行位置 | 职责 |
| --- | --- | --- |
| **Web 打印服务** (`src/`) | 电脑B 的 Docker 容器 | 登录鉴权、文件上传与校验、打印参数、任务队列、状态与日志、调用宿主机接口 |
| **打印 Agent** (`host-print-agent/`) | 电脑B Windows 宿主机 | Office/图片转 PDF、调用 Windows 打印驱动、返回打印结果 |

## 整体架构

```
外网浏览器
   │ HTTPS
   ▼
Cloudflare Tunnel（cloudflared 在电脑B）
   │ http://127.0.0.1:3000
   ▼
Docker 容器：Web 打印服务（Node.js / Express）
   │ HTTP multipart，http://host.docker.internal:8081
   ▼
Windows 宿主机：打印 Agent（Node.js）
   │ LibreOffice 转 PDF + pdf-to-printer
   ▼
Windows 打印服务 / 本地打印机
```

> **为什么需要宿主机 Agent？**
> Windows 下 Docker 容器**无法直接访问宿主机打印机驱动**。因此容器只负责 Web 应用（接收文件、任务队列、网页前端），真正打印由宿主机上的小型本地 API 完成。
> （若宿主机是 Linux，可改用容器内 CUPS；本场景电脑B 为 Windows，故采用 Agent 方案。）

**一次打印的完整链路**

1. 浏览器上传 PDF / 图片 / Office 文档
2. 容器内 Web 服务校验文件、写入临时目录、创建任务并进入队列
3. 队列顺序取出任务，将文件与参数 POST 给宿主机 `127.0.0.1:8081`
4. 宿主机 Agent：Office/图片先用 LibreOffice 转 PDF，再调用打印机
5. 打印结果回传，Web 服务更新任务状态并清理临时文件

## 一、功能清单

- 账号密码登录、会话保持、退出登录
- 网页上传 PDF / 图片 / Word / Excel / PPT
- 打印参数：份数（1–99）、黑白/彩色、纸张尺寸（A3/A4/A5/B5/Letter/Legal）、指定打印机
- 内存 + 磁盘持久化的打印任务队列（顺序执行，重启后中断任务标记失败）
- 任务状态：等待中 / 打印中 / 已完成 / 失败 / 已取消，支持取消等待中的任务
- 任务日志（`logs/tasks.json` + `logs/app.log`）
- Office/图片由宿主机 LibreOffice 自动转 PDF
- 文件安全校验：后缀白名单 + 文件头（magic number）校验 + 大小限制，打印后自动清理临时文件
- Cloudflare Tunnel 一键对外，本地服务仅监听本机 / 容器网络

## 二、项目结构

```
web-print/
├── Dockerfile                 # Web 服务镜像
├── docker-compose.yml         # 一键编排
├── .env.example               # 环境变量示例（复制为 .env）
├── package.json               # Web 服务依赖
├── src/                       # ===== Web 打印服务（容器内运行）=====
│   ├── app.js                 # Express 入口：会话、静态资源、路由、错误处理
│   ├── config.js              # 环境变量集中配置
│   ├── middleware/
│   │   └── auth.js            # 登录校验中间件
│   ├── routes/
│   │   ├── auth.js            # /api/login /api/logout /api/me
│   │   └── print.js           # /api/print /api/tasks /api/printers /api/status
│   ├── services/
│   │   ├── fileValidator.js   # 文件类型 / 大小 / 文件头校验
│   │   ├── hostPrint.js       # 调用宿主机打印 Agent
│   │   ├── queue.js           # 打印任务队列 + 持久化
│   │   └── logger.js          # 日志
│   └── public/                # 前端网页（原生 HTML/CSS/JS）
│       ├── index.html
│       ├── style.css
│       └── main.js
├── host-print-agent/          # ===== 宿主机打印 Agent（Windows 运行）=====
│   ├── agent.js
│   ├── package.json
│   └── README.md
├── logs/                      # 任务记录与日志（挂载进容器）
└── tmp/                       # 上传临时文件（打印后自动清理）
```

## 三、前置准备（电脑B Windows）

1. 安装 **Docker Desktop**，启用 WSL2
2. 安装 **Node.js 20+**（用于运行宿主机打印 Agent）
3. 本地打印机驱动安装完成，Windows 里可正常打印
4. 安装 **LibreOffice**（宿主机安装，用于 Office/图片转 PDF）
5. 准备托管在 **Cloudflare** 的域名
6. 下载 `cloudflared` 客户端

## 四、快速开始

### 1. 配置环境变量

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

编辑 `.env`，至少修改登录账号密码与会话密钥：

```ini
AUTH_USER=admin
AUTH_PASS=your-strong-password
SESSION_SECRET=某个随机长字符串
HOST_PRINT_API=http://host.docker.internal:8081
HOST_PRINT_TOKEN=
MAX_FILE_SIZE=20971520
```

### 2. 启动宿主机打印 Agent（电脑B，Windows）

```powershell
cd host-print-agent
npm install
# 可选：令牌需与 Web 服务侧 HOST_PRINT_TOKEN 一致
$env:AGENT_TOKEN=""
# 如 LibreOffice 不在默认路径，手动指定：
$env:SOFFICE_PATH="C:\Program Files\LibreOffice\program\soffice.exe"
npm start
```

看到 `打印 Agent 已启动：http://127.0.0.1:8081` 即成功。可用浏览器访问 `http://127.0.0.1:8081/printers` 检查打印机列表。

### 3. 构建并启动 Docker 容器（电脑B）

```bash
# 在项目根目录
docker compose build
docker compose up -d
docker compose logs -f webprint
```

本地访问 `http://127.0.0.1:3000`，用 `.env` 中的账号登录并测试上传打印。

### 4. 配置 Cloudflare Tunnel（电脑B）

1. 运行 `cloudflared`，创建隧道并指向 `http://127.0.0.1:3000`
2. 在 Cloudflare 后台绑定域名，例如 `print.yourdomain.com`
3. Cloudflare 安全配置：
   - 强制 HTTPS
   - 关闭缓存（Cache Rules 对打印域名 Bypass）
   - 可选开启 **Cloudflare Access** 做二次身份验证
4. 外网访问：`https://print.yourdomain.com`

## 五、接口说明

### Web 服务（容器，端口 3000）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 否 | 健康检查 |
| POST | `/api/login` | 否 | 登录，Body：`{ username, password }` |
| POST | `/api/logout` | 否 | 退出登录 |
| GET | `/api/me` | 否 | 获取当前登录用户 |
| POST | `/api/print` | 是 | 上传并创建打印任务（multipart/form-data） |
| GET | `/api/tasks` | 是 | 任务列表（最新在前） |
| GET | `/api/tasks/:id` | 是 | 单个任务详情 |
| DELETE | `/api/tasks/:id` | 是 | 取消等待中的任务 |
| GET | `/api/printers` | 是 | 宿主机打印机列表（代理 Agent） |
| GET | `/api/status` | 是 | 宿主机 Agent 在线状态 |

`POST /api/print` 表单字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 待打印文件 |
| `copies` | 否 | 份数，默认 1 |
| `color` | 否 | `mono`（黑白，默认）/ `color`（彩色） |
| `paperSize` | 否 | `A4`（默认）/`A3`/`A5`/`B5`/`Letter`/`Legal` |
| `printer` | 否 | 打印机名称，留空使用默认打印机 |

### 宿主机打印 Agent（本机 127.0.0.1:8081）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 LibreOffice 路径与打印机数量 |
| GET | `/printers` | 本机打印机列表 |
| POST | `/print` | 接收文件与参数，转换并打印 |

请求头 `x-print-token` 需与 `AGENT_TOKEN` 一致（未设置则跳过校验）。详见 `host-print-agent/README.md`。

## 六、环境变量

### Web 服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `AUTH_USER` | `admin` | 登录账号 |
| `AUTH_PASS` | `admin123` | 登录密码（务必修改） |
| `SESSION_SECRET` | `please-change-this-secret` | 会话密钥（务必修改） |
| `HOST_PRINT_API` | `http://host.docker.internal:8081` | 宿主机 Agent 地址 |
| `HOST_PRINT_TOKEN` | 空 | 与 Agent 约定的令牌 |
| `HOST_PRINT_TIMEOUT` | `180000` | 调用 Agent 超时（毫秒） |
| `TMP_FOLDER` | `/app/tmp` | 临时文件目录 |
| `LOG_FOLDER` | `/app/logs` | 日志目录 |
| `MAX_FILE_SIZE` | `20971520`（20MB） | 单文件大小上限（字节） |

## 七、安全重点

1. Web 应用必须开启登录鉴权，禁止匿名外网打印
2. 文件校验：后缀白名单 + 文件头校验 + MIME 类型，打印完成自动清理临时文件
3. 宿主机打印 Agent 仅监听 `127.0.0.1`，禁止暴露外网；可加 `AGENT_TOKEN` 令牌
4. Cloudflare Access 可再加一层身份防护，双重保险
5. 限制上传文件大小，防止超大文件攻击
6. 容器内服务不挂载敏感系统目录；`.env` 与 `logs/`、`tmp/` 已加入 `.gitignore`

> 生产建议：默认使用 `express-session` 的内存存储，重启会清空登录态；如需多实例或持久会话，可替换为 `connect-redis` 等存储。

## 八、测试流程

1. 启动宿主机 Agent，访问 `http://127.0.0.1:8081/health` 确认在线
2. 启动 Docker 服务，访问 `http://127.0.0.1:3000` 登录
3. 上传 PDF 测试打印，确认默认打印机出纸
4. 上传 Word / Excel / PPT，验证 LibreOffice 转 PDF 后正常打印
5. 测试彩色/黑白、不同纸张、多份数参数
6. 启动 cloudflared 隧道，内网其他设备访问域名测试
7. 外网手机/电脑访问域名，提交打印任务
8. 网页「任务列表」查看状态；必要时查看 `logs/tasks.json`、`logs/app.log`

## 九、故障排查

| 现象 | 排查方向 |
| --- | --- |
| 页面提示「打印服务离线」 | Agent 是否运行；`127.0.0.1:8081/health` 是否可访问；`HOST_PRINT_API` 是否正确 |
| 容器无法访问宿主机接口 | 确认 compose 中 `host.docker.internal` 与 `extra_hosts` 配置；Windows 防火墙放行 |
| 上传成功但不打印 | 查看任务状态与错误信息；宿主机打印 API、打印机驱动是否正常 |
| Office 文件转换失败 | 检查宿主机 LibreOffice 是否安装、`SOFFICE_PATH` 是否正确 |
| Cloudflare 域名打不开 | cloudflared 进程是否运行；隧道是否指向 `127.0.0.1:3000`；缓存是否关闭 |
| 登录后立刻掉线 | `SESSION_SECRET` 是否稳定；容器是否频繁重启 |

## 十、可选扩展

- 打印任务审核：提交后管理员手动确认打印
- 多打印机切换 / 按用户绑定默认打印机
- 打印任务过期自动删除、历史清理
- 邮件 / 企业微信通知打印状态
- 打印页数统计与用量报表
- 用户管理（多账号、角色权限）

## 十一、本地开发（不使用 Docker）

```bash
npm install
AUTH_USER=admin AUTH_PASS=admin123 npm start   # PowerShell: $env:AUTH_PASS="admin123"; npm start
```

前端为原生静态文件，修改 `src/public/` 后刷新即可。宿主机 Agent 同理进入 `host-print-agent/` 运行 `npm start`。
