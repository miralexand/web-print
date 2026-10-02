# web-print · Web 打印服务

[![License](https://img.shields.io/badge/license-MulanPSL--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED.svg?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

> 一个可自托管的网页打印系统：浏览器上传文件 → Docker 服务排队 → Windows 宿主机调用打印机。配合 Cloudflare Tunnel 可安全地对外提供打印服务。

- 仓库地址：<https://github.com/miralexand/web-print>
- 开源协议：[木兰宽松许可证 第2版 (MulanPSL-2.0)](./LICENSE)

---

## 快速开始（TL;DR）

> 前置：Windows 电脑已安装 Docker Desktop（WSL2）、Node.js 20+、LibreOffice，且本机可正常打印。

```bash
# 1) 克隆并配置
git clone https://github.com/miralexand/web-print.git
cd web-print
copy .env.example .env          # Linux/macOS 用 cp
# 编辑 .env：修改 AUTH_USER / AUTH_PASS / SESSION_SECRET

# 2) 启动宿主机打印 Agent（新开一个终端，在 Windows 上运行）
cd host-print-agent
npm install
npm start                        # 监听 127.0.0.1:8081
# 或改用 desktop/ 打包的托盘版 exe（见「Windows 托盘应用」）

# 3) 回到项目根目录，启动 Web 服务（Docker）
cd ..
docker compose up -d --build
```

打开 <http://127.0.0.1:3000>。游客可直接打印（受配额限制）；用 `.env` 中的初始管理员账号登录后，可进入「用户管理」新增用户并调整配额。

> 对外发布（可选）：运行 `cloudflared tunnel --url http://127.0.0.1:3000`，或按下方「部署」绑定自有域名。

一分钟自检：

```bash
curl http://127.0.0.1:3000/health       # Web 服务
curl http://127.0.0.1:8081/health       # 宿主机 Agent
```

---

## 特性

- **登录鉴权**：账号密码登录、会话保持，密码使用 `scrypt` 加盐哈希存储
- **游客打印配额**：未登录用户默认每 **3 小时最多打印 5 次**（可配置），超过则拒绝
- **用户管理**：管理员可新增 / 修改 / 停用 / 删除用户，设置角色与每人打印配额
- **多格式上传**：PDF、图片（PNG/JPG）、Office（Word/Excel/PPT）
- **打印参数**：份数（1–99）、黑白/彩色、纸张尺寸、指定打印机
- **任务队列**：内存 + 磁盘持久化，顺序执行；任务状态实时可见、等待任务可取消
- **配额退还**：任务失败、被取消或服务重启中断时自动退还配额次数
- **任务日志**：`logs/tasks.json`（结构化记录）与 `logs/app.log`（运行日志）
- **自动转换**：Office/图片由宿主机 LibreOffice 转 PDF 后打印
- **安全校验**：后缀白名单 + 文件头（magic number）+ 大小限制，打印后自动清理临时文件
- **登录防爆破**：同一 IP 在窗口内失败次数过多将临时锁定
- **托盘 exe**：宿主机侧可选图形化托盘应用（Vue3 + Element Plus），内置打印服务与 Cloudflare Tunnel 管理，可打包为安装包 / 免安装 zip 绿色版
- **轻量部署**：Web 端基于 `node:20-alpine`，宿主机 Agent 仅监听本机

## 整体架构

```
外网浏览器
   │ HTTPS
   ▼
Cloudflare Tunnel（cloudflared 运行在宿主机）
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

| 模块 | 运行位置 | 职责 |
| --- | --- | --- |
| **Web 打印服务** (`src/`) | Docker 容器 | 登录鉴权、游客配额、用户管理、文件上传与校验、打印参数、任务队列、状态与日志、调用宿主机接口 |
| **打印 Agent** (`host-print-agent/`) | Windows 宿主机 | Office/图片转 PDF、调用 Windows 打印驱动、返回打印结果 |

> **为什么需要宿主机 Agent？**
> Windows 下 Docker 容器**无法直接访问宿主机打印机驱动**，因此容器只负责 Web 应用，真正打印由宿主机上的小型本地 API 完成。
> 宿主机侧提供两种等价实现：命令行 Node 版（`host-print-agent/`）或图形托盘版（`desktop/`，可打包成 exe）。
> 若宿主机是 Linux，可改用容器内 CUPS；本场景宿主机为 Windows，故采用 Agent 方案。

**一次打印的完整链路**

1. 浏览器上传 PDF / 图片 / Office 文档（无需登录也可，受游客配额限制）
2. Web 服务校验文件与配额、写入临时目录、创建任务并进入队列
3. 队列顺序取出任务，将文件与参数 POST 给宿主机 `127.0.0.1:8081`
4. 宿主机 Agent：Office/图片先用 LibreOffice 转 PDF，再调用打印机
5. 结果回传，Web 服务更新任务状态并清理临时文件；失败/取消会退还配额

## 项目结构

```
web-print/
├── Dockerfile                 # Web 服务镜像
├── docker-compose.yml         # 一键编排
├── .env.example               # 环境变量示例（复制为 .env）
├── LICENSE                    # 木兰宽松许可证 第2版
├── package.json               # Web 服务依赖
├── src/                       # ===== Web 打印服务（容器内运行）=====
│   ├── app.js                 # Express 入口：会话、静态资源、路由、错误处理、优雅退出
│   ├── config.js              # 环境变量集中配置
│   ├── middleware/auth.js     # attachUser / requireAuth / requireAdmin
│   ├── routes/
│   │   ├── auth.js            # /api/login /api/logout /api/me
│   │   ├── print.js           # /api/print /api/tasks /api/printers /api/status
│   │   └── admin.js           # /api/admin/users /api/admin/usage
│   ├── services/
│   │   ├── fileValidator.js   # 文件类型 / 大小 / 文件头校验
│   │   ├── hostPrint.js       # 调用宿主机打印 Agent
│   │   ├── identity.js        # 请求身份识别与配额 key
│   │   ├── queue.js           # 打印任务队列 + 持久化 + 配额退还
│   │   ├── usageLimiter.js    # 配额限流（滚动窗口、持久化）
│   │   ├── userStore.js       # 用户存储（scrypt 哈希、原子写入）
│   │   └── logger.js          # 日志
│   └── public/                # 前端网页（原生 HTML/CSS/JS）
│       ├── index.html
│       ├── style.css
│       └── main.js
├── host-print-agent/          # ===== 宿主机打印 Agent（Node 版，可命令行运行）=====
│   ├── agent.js
│   ├── package.json
│   └── README.md
├── desktop/                   # ===== Windows 托盘应用（Electron，可打包 exe）=====
│   ├── main.js                # 主进程：窗口、托盘、服务与隧道生命周期
│   ├── preload.js             # 安全桥接（contextBridge）
│   ├── lib/
│   │   ├── printService.js    # 内置打印服务（与 Agent 等效）
│   │   └── cloudflared.js     # Cloudflare Tunnel 子进程管理
│   ├── renderer/              # 界面（Vue3 + Element Plus）
│   │   └── vendor/            # 本地化的 vue / element-plus 资源
│   ├── scripts/               # make-icons.js / copy-vendor.js
│   └── build/                 # 图标资源（icon.png / icon.ico / tray.png）
├── .github/workflows/         # GitHub Actions：Windows 打包与 Release
├── data/                      # 用户库与用量数据（挂载进容器）
├── logs/                      # 任务记录与日志（挂载进容器）
└── tmp/                       # 上传临时文件（打印后自动清理）
```

## 部署

### 0. 前置准备（Windows 宿主机）

1. 安装 **Docker Desktop**，启用 WSL2
2. 安装 **Node.js 20+**（运行宿主机打印 Agent）
3. 本地打印机驱动安装完成，Windows 里可正常打印
4. 安装 **LibreOffice**（用于 Office/图片转 PDF）
5. 准备托管在 **Cloudflare** 的域名，并下载 `cloudflared`（可选，用于对外）

### 1. 配置环境变量

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

编辑 `.env`，至少修改登录账号密码与会话密钥：

```ini
# 初始管理员（仅首次初始化用户库时生效）
AUTH_USER=admin
AUTH_PASS=your-strong-password
SESSION_SECRET=某个随机长字符串

# 游客配额：每 3 小时 5 次
ANON_PRINT_LIMIT=5
ANON_WINDOW_HOURS=3

HOST_PRINT_API=http://host.docker.internal:8081
HOST_PRINT_TOKEN=
MAX_FILE_SIZE=20971520
```

### 2. 启动宿主机打印 Agent

```powershell
cd host-print-agent
npm install
# 可选：令牌需与 Web 服务侧 HOST_PRINT_TOKEN 保持一致
$env:AGENT_TOKEN=""
# 如 LibreOffice 不在默认路径，手动指定：
$env:SOFFICE_PATH="C:\Program Files\LibreOffice\program\soffice.exe"
npm start
```

看到 `打印 Agent 已启动：http://127.0.0.1:8081` 即成功。浏览器访问 <http://127.0.0.1:8081/printers> 可检查打印机列表。

> 不想装 Node？可直接使用下方「Windows 托盘应用（Electron）」打包的 exe，功能与命令行 Agent 等价。

### 3. 构建并启动 Web 服务

```bash
# 在项目根目录
docker compose up -d --build
docker compose logs -f webprint
```

本地访问 <http://127.0.0.1:3000>，游客可直接打印；用 `.env` 中的初始管理员登录后可管理用户与配额。

### 4. 配置 Cloudflare Tunnel（可选，对外访问）

1. 运行 `cloudflared`，创建隧道并指向 `http://127.0.0.1:3000`
2. 在 Cloudflare 后台绑定域名，例如 `print.yourdomain.com`
3. Cloudflare 安全配置：
   - 强制 HTTPS
   - 关闭缓存（对打印域名 Bypass Cache）
   - 可选开启 **Cloudflare Access** 做二次身份验证
4. 外网访问：`https://print.yourdomain.com`

## Windows 托盘应用（Electron）

`desktop/` 是一个图形化的宿主机打印助手，内置打印服务，可最小化到任务托盘常驻，适合不想开命令行终端的场景。

**功能**

- 一键启动 / 停止本地打印服务（默认 `127.0.0.1:8081`）
- 实时显示服务状态、LibreOffice 路径、打印机列表与运行日志
- 可修改监听端口、访问令牌、LibreOffice 路径，支持开机自启
- **Cloudflare Tunnel 管理**：内置快速隧道（临时 `*.trycloudflare.com` 地址）与命名隧道（Token）两种模式，可启停、复制 / 打开公网地址、查看 cloudflared 日志，支持一键下载 cloudflared
- 界面基于 **Vue 3 + Element Plus**（资源已本地化到 `renderer/vendor`，离线可用）
- 关闭窗口自动最小化到任务托盘；托盘菜单可显示界面 / 开关服务 / 开关隧道 / 打开 Web 界面 / 退出
- 可打包为 **NSIS 安装包** 与 **免安装 zip 绿色版**

**绿色版 / 便携模式**

- `WebPrintTray-<版本>-x64.zip` 解压即用，无需安装
- 默认配置与数据保存在用户目录；若在 exe 同目录放置一个名为 `portable.flag` 的空文件，即切换为便携模式：配置与数据改存 exe 同目录的 `webprint-config.json`，随程序一起携带

**开发运行**

```bash
cd desktop
npm install
npm start
```

**打包 exe**

```bash
cd desktop
npm run dist        # 生成 release/ 下的安装包与绿色 zip
# 或
npm run pack        # 仅生成免安装目录 release/win-unpacked/
```

产物位于 `desktop/release/`：

- `WebPrintTray-Setup-<版本>.exe`：NSIS 安装包（可选择安装目录、创建桌面快捷方式）
- `WebPrintTray-<版本>-x64.zip`：免安装绿色版，解压双击 `WebPrintTray.exe` 即用

**GitHub Actions 自动构建**

`.github/workflows/build-desktop.yml` 会在以下情况自动构建 Windows 安装包与绿色版：

- 推送形如 `v*` 的标签（如 `v1.0.2`）：构建产物自动发布到对应的 GitHub Release
- 手动触发（Actions → Build Windows Desktop → Run workflow）

> 如需自定义图标，修改 `desktop/scripts/make-icons.js` 后执行 `node scripts/make-icons.js`，会重新生成 `build/` 下的 `icon.png`、`icon.ico`、`tray.png`。
> 升级 Vue / Element Plus 后执行 `npm run vendor` 重新同步 `renderer/vendor` 资源。

> Windows 上若本地打包时下载 Electron 出现证书错误，可先设置 `NODE_OPTIONS=--use-system-ca`，必要时配合镜像：`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### 关于杀毒软件误报（Windows Defender / SmartScreen）

**为什么会误报？**

这类误报不是程序包含病毒，而是以下因素叠加触发了启发式 / 机器学习判定：

1. **未做代码签名**：没有数字签名的 Electron 程序会被 SmartScreen 标为“未知发布者”，卡巴、Defender 的 ML 引擎也常把 NSIS 自解压包判为 `Trojan:Win32/Wacatac.B!ml` 之类。
2. **内置 pdf 打印组件**：`pdf-to-printer` 自带 `SumatraPDF-x.x.x-32.exe`，程序运行时会在临时目录释放并执行一个第三方 PE 文件，符合“释放并执行可执行文件”的启发式特征。
3. **自解压 / 运行时下载**：旧的 portable 自解压包，以及“下载 cloudflared 并运行”的功能，都会增加“下载器”嫌疑。

**如何解决（按推荐程度）**

1. **代码签名（根治）**：购买 OV/EV 代码签名证书，在 CI 中通过 Secrets 配置即可自动签名：
   - 在仓库 `Settings → Secrets and variables → Actions` 添加
     - `WINDOWS_CSC_LINK`：证书（`.pfx`）的 base64，或证书文件的可访问 URL
     - `WINDOWS_CSC_KEY_PASSWORD`：证书密码
   - 之后打 tag 构建时会自动签名与时间戳，SmartScreen / 杀软误报基本消除。EV 证书可立即获得 SmartScreen 信誉，OV 需要一定下载量积累。
2. **向微软提交误报**：在 <https://www.microsoft.com/wdsi/filesubmission> 选择“软件开发者”，上传 exe 并说明为误报，通常 24-72 小时可解除；也可提交给其它杀软厂商。
3. **使用绿色 zip 版**：1.0.2 起已**移除自解压 portable 目标**，改用标准 zip 分发，显著降低启发式命中。
4. **本机临时放行**：在 Defender「病毒和威胁防护 → 排除项」中加入程序目录，或在 SmartScreen 提示中选择“仍要运行”（仅建议自用）。
5. **不要使用第三方二次打包**：从官方 Release 下载，避免被再次封装引入可疑特征。

## 用户与配额

### 游客（未登录）

- 无需登录即可上传打印，默认 **每 3 小时最多 5 次**（`ANON_PRINT_LIMIT` / `ANON_WINDOW_HOURS`）
- 按客户端 IP 计数，超出后返回 `429`，页面会提示剩余等待时间
- 任务失败、被取消或服务重启中断时，配额自动退还

### 用户与管理员

- 系统首次启动会自动创建初始管理员（来自 `AUTH_USER` / `AUTH_PASS`）
- 管理员在网页右上角「用户管理」中可：
  - 新增用户、修改用户名 / 密码 / 角色 / 状态
  - 为每个用户单独设置打印配额（`0` 表示不限次数）与配额窗口
  - 查看并重置游客 / IP 的用量记录
- 系统始终保证至少保留一名启用状态的管理员，禁止删除或停用最后一名管理员
- 用户被停用或删除后，其已登录会话立即失效

## 接口说明

### Web 服务（容器，端口 3000）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 否 | 健康检查 |
| POST | `/api/login` | 否 | 登录，Body：`{ username, password }` |
| POST | `/api/logout` | 否 | 退出登录 |
| GET | `/api/me` | 否 | 当前身份与剩余配额（游客返回 `anonymous:true`） |
| POST | `/api/print` | 否* | 上传并创建打印任务（multipart/form-data），受配额限制 |
| GET | `/api/tasks` | 否* | 任务列表：管理员看全部，用户/游客看自己 |
| GET | `/api/tasks/:id` | 否* | 单个任务详情（仅本人或管理员） |
| DELETE | `/api/tasks/:id` | 否* | 取消等待中的任务（仅本人或管理员），退还配额 |
| GET | `/api/printers` | 否 | 宿主机打印机列表（代理 Agent） |
| GET | `/api/status` | 否 | 宿主机 Agent 在线状态 |

> `否*` 表示无需登录即可访问，但未登录身份按 IP 计入游客配额，且只能访问自己 IP 的任务。

管理员接口（需 `admin` 角色）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 新增用户 `{ username, password, role, enabled, printQuota, quotaWindowHours }` |
| PATCH | `/api/admin/users/:id` | 修改用户（字段同上，`password` 留空则不修改） |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/usage` | 游客 / IP 用量快照 |
| POST | `/api/admin/usage/reset` | 重置某来源用量 `{ key }` |

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

请求头 `x-print-token` 需与 `AGENT_TOKEN` 一致（未设置则跳过校验）。详见 [`host-print-agent/README.md`](./host-print-agent/README.md)。

## 环境变量

### Web 服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `AUTH_USER` | `admin` | 初始管理员账号（仅首次初始化用户库时使用） |
| `AUTH_PASS` | `admin123` | 初始管理员密码（务必修改） |
| `SESSION_SECRET` | `please-change-this-secret` | 会话密钥（务必修改） |
| `SESSION_HOURS` | `12` | 登录会话有效小时数 |
| `ANON_PRINT_LIMIT` | `5` | 游客每窗口最多打印次数 |
| `ANON_WINDOW_HOURS` | `3` | 游客配额窗口（小时） |
| `LOGIN_MAX_ATTEMPTS` | `10` | 登录窗口内允许的失败次数 |
| `LOGIN_WINDOW_MINUTES` | `15` | 登录失败统计窗口（分钟） |
| `TRUST_PROXY` | `1` | 反向代理层数（本机直连设 `0`，Cloudflare Tunnel 保持 `1`） |
| `HOST_PRINT_API` | `http://host.docker.internal:8081` | 宿主机 Agent 地址 |
| `HOST_PRINT_TOKEN` | 空 | 与 Agent 约定的令牌 |
| `HOST_PRINT_TIMEOUT` | `180000` | 调用 Agent 超时（毫秒） |
| `TMP_FOLDER` | `/app/tmp` | 临时文件目录 |
| `LOG_FOLDER` | `/app/logs` | 日志目录 |
| `DATA_FOLDER` | `/app/data` | 用户库与用量数据目录 |
| `MAX_FILE_SIZE` | `20971520`（20MB） | 单文件大小上限（字节） |

### 宿主机 Agent

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8081` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（保持本机） |
| `AGENT_TOKEN` | 空 | 请求令牌，空则不校验 |
| `SOFFICE_PATH` | 自动探测 | LibreOffice 可执行文件路径 |
| `WORK_DIR` | 系统临时目录 | 上传/转换临时目录 |

## 安全建议

1. 游客可匿名打印，但受配额限制（默认每 3 小时 5 次）；对外场景建议用 Cloudflare Access 再收一层
2. 文件校验：后缀白名单 + 文件头校验 + MIME 类型，打印完成自动清理临时文件
3. 密码使用 `scrypt` 加盐哈希存储，登录失败次数超限会临时锁定该 IP
4. 宿主机打印 Agent 仅监听 `127.0.0.1`，禁止暴露外网；可加 `AGENT_TOKEN` 令牌
5. 使用 Cloudflare Access 再加一层身份防护，双重保险
6. 限制上传文件大小，防止超大文件攻击
7. 容器内服务不挂载敏感系统目录；`.env` 与 `data/`、`logs/`、`tmp/` 已加入 `.gitignore`
8. 及时修改默认管理员密码与 `SESSION_SECRET`

> 生产建议：默认使用 `express-session` 内存存储，重启会清空登录态；如需多实例或持久会话，可替换为 `connect-redis` 等存储。

## 测试流程

1. 启动宿主机 Agent，访问 `http://127.0.0.1:8081/health` 确认在线
2. 启动 Docker 服务，访问 `http://127.0.0.1:3000`，以游客身份上传 PDF 测试打印
3. 连续打印验证游客配额：第 6 次应被拒绝并提示等待时间
4. 用初始管理员登录，进入「用户管理」新增用户并设置配额，验证其登录与限额
5. 上传 Word / Excel / PPT，验证 LibreOffice 转 PDF 后正常打印
6. 测试彩色/黑白、不同纸张、多份数参数
7. 启动 cloudflared 隧道，内网其他设备访问域名测试
8. 外网手机/电脑访问域名，提交打印任务
9. 网页「任务列表」查看状态；必要时查看 `logs/tasks.json`、`logs/app.log`

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 页面提示「打印服务离线」 | Agent 是否运行；`127.0.0.1:8081/health` 是否可访问；`HOST_PRINT_API` 是否正确 |
| 容器无法访问宿主机接口 | 确认 compose 中 `host.docker.internal` 与 `extra_hosts` 配置；Windows 防火墙放行 |
| 上传成功但不打印 | 查看任务状态与错误信息；宿主机打印 API、打印机驱动是否正常 |
| 游客提示达到上限 | 属正常配额限制；可调整 `ANON_PRINT_LIMIT`/`ANON_WINDOW_HOURS`，或在用户管理里重置用量 |
| 登录提示尝试过于频繁 | 触发了登录防爆破，等待窗口结束或重启服务（`data/usage.json` 可清空） |
| Office 文件转换失败 | 检查宿主机 LibreOffice 是否安装、`SOFFICE_PATH` 是否正确 |
| Cloudflare 域名打不开 | cloudflared 进程是否运行；隧道是否指向 `127.0.0.1:3000`；缓存是否关闭 |
| 登录后立刻掉线 | `SESSION_SECRET` 是否稳定；容器是否频繁重启；账号是否被停用 |

## 本地开发（不使用 Docker）

```bash
npm install
# Linux/macOS
AUTH_USER=admin AUTH_PASS=admin123 npm start
# PowerShell
$env:AUTH_PASS="admin123"; npm start
```

前端为原生静态文件，修改 `src/public/` 后刷新即可。宿主机 Agent 同理进入 `host-print-agent/` 运行 `npm start`。

## 可选扩展

- 打印任务审核：提交后管理员手动确认打印
- 多打印机切换 / 按用户绑定默认打印机
- 打印任务过期自动删除、历史清理
- 邮件 / 企业微信通知打印状态
- 打印页数统计与用量报表

## 开源协议

本项目基于 [木兰宽松许可证 第2版 (MulanPSL-2.0)](./LICENSE) 开源。

```
Copyright (c) 2026 miralexand
web-print is licensed under Mulan PSL v2.
You can use this software according to the terms and conditions of the Mulan PSL v2.
You may obtain a copy of Mulan PSL v2 at:
         http://license.coscl.org.cn/MulanPSL2
```
