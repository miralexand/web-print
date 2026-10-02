# web-print · WebPrint 打印助手

[![License](https://img.shields.io/badge/license-MulanPSL--2.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/miralexand/web-print)](https://github.com/miralexand/web-print/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)
[![Build](https://github.com/miralexand/web-print/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/miralexand/web-print/actions/workflows/build-desktop.yml)

> 一个可自托管的网页打印系统。**一体化桌面应用，一个 exe 同时内置网页服务、本地打印与 Cloudflare Tunnel，完全无需 Docker。**

- 仓库地址：<https://github.com/miralexand/web-print>
- 下载地址：<https://github.com/miralexand/web-print/releases>
- 开源协议：[木兰宽松许可证 第2版 (MulanPSL-2.0)](./LICENSE)

![架构示意](https://img.shields.io/badge/网页上传-%E2%86%92%20%E6%9C%AC%E6%9C%BA%E6%89%93%E5%8D%B0-0071e3)

---

## 快速开始

1. 打开 [Releases](https://github.com/miralexand/web-print/releases)，下载：
   - `WebPrintTray-Setup-<版本>.exe`（安装版，推荐）或
   - `WebPrintTray-<版本>-x64.zip`（免安装绿色版）
2. 运行程序，托盘出现图标，窗口自动打开；**Web 服务与打印服务会自动启动**。
3. 点击「打开 Web 打印界面」或访问 <http://127.0.0.1:3000>，默认账号 `admin / admin123`（登录后可在「用户管理」中修改）。
4. 上传文件即可打印。需要外网访问时，在「Cloudflare 隧道」页一键启动即可。

> 前置：本机打印机驱动已安装、Windows 可正常打印；Office 转 PDF 会优先使用 **LibreOffice**，未安装时自动回退到本机 **Microsoft Office / WPS**（任一即可）。

## 特性

- **一体化、零 Docker**：单个桌面应用同时运行网页服务与本地打印代理
- **Apple · 北欧极简 UI**：桌面端侧边栏毛玻璃导航；网页端（3000）同为 Apple / 北欧极简风格，大圆角、留白与柔和阴影
- **Cloudflare Tunnel**：快速隧道（临时公网地址）与命名隧道（Token）两种模式，一键启停，内置**傻瓜教程**
- **网页打印**：上传 PDF、图片、Word/Excel/PPT，支持**文档预览**、**移除重选**、**起止页码**、份数、黑白/彩色、纸张、指定打印机
- **局域网可用**：Web 服务默认绑定 `0.0.0.0`，同网段手机/电脑可用 `http://本机IP:3000` 访问（可在设置关闭）
- **任务管理**：任务列表可**删除**（等待中的会退还配额），状态实时可见
- **账号与配额**：游客默认每 3 小时 5 次；管理员可增删改用户、单独设置每人配额
- **任务队列**：顺序执行、状态实时可见、失败/取消自动退还配额
- **Office 转 PDF**：优先 LibreOffice，未安装时自动回退到 Microsoft Office / WPS 的 COM 转换
- **任务自动重试**：本地打印服务未就绪时自动重试，避免偶发“无法连接”直接失败
- **安全**：`scrypt` 密码哈希、登录防爆破、文件后缀 + 文件头校验、打印后清理临时文件
- **托盘常驻**：关闭窗口最小化到系统托盘，托盘菜单可开关各服务
- **关于页**：内置版本、仓库地址、组件信息与快捷入口

## 架构

```
外网浏览器
   │ HTTPS
   ▼
Cloudflare Tunnel（应用内置管理 cloudflared）
   │ http://127.0.0.1:3000
   ▼
WebPrintTray（单个 Electron 应用）
   ├── 内嵌 Web 服务（Node/Express，端口 3000）── 网页界面 / API / 任务队列
   └── 内嵌打印服务（端口 8081）── LibreOffice 转 PDF + pdf-to-printer
                                        │
                                        ▼
                              Windows 打印服务 / 本地打印机
```

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Web 网页打印服务 | `http://127.0.0.1:3000` | 网页界面与接口，可在设置中改端口 |
| 本地打印服务 | `http://127.0.0.1:8081` | 接收转发、调用打印机，可在设置中改端口 |
| Cloudflare 隧道 | 启动后生成 | 把 Web 服务发布到公网 |

## 界面说明

**桌面应用**左侧为导航栏（圆角卡片、毛玻璃质感）：

- **概览**：三个服务卡片（Web / 打印 / 隧道）状态与快捷开关，运行日志
- **打印机**：本机打印机与支持的纸张列表
- **Cloudflare 隧道**：模式选择、目标地址 / Token、cloudflared 路径与一键下载、实时日志、公网地址复制，以及内置**傻瓜教程**
- **设置**：Web 端口、打印端口、访问令牌、LibreOffice 路径、开机自启、数据目录
- **关于**：版本号、[仓库地址](https://github.com/miralexand/web-print)、问题反馈、检查更新、开源协议与组件版本

**网页端**（本机 <http://127.0.0.1:3000>，局域网 `http://本机IP:3000`）同样采用 Apple / 北欧极简设计：大圆角卡片、柔和阴影、留白与 Apple 蓝主色。支持**选择文件后即时预览**（PDF/图片内嵌预览，Office 显示提示），可**移除并重选**；可用**起止页**选择要打印的页（如第 2 页到第 5 页）并设置**份数**；任务列表可**删除**。

## Cloudflare Tunnel 傻瓜教程

> 完整图文教程见 [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)，应用内「Cloudflare 隧道 → 傻瓜教程」也有同款分步指引。

**方式一 · 快速隧道（30 秒上手）**

1. 「Cloudflare 隧道」页 → 模式选 **快速隧道**，目标地址保持 `http://127.0.0.1:3000`
2. 点 **保存并启动** → 得到形如 `https://xxxx.trycloudflare.com` 的公网地址
3. 点「复制」发给他人即可（地址每次重启会变化）

**方式二 · 命名隧道（固定域名，推荐）**

1. 把域名接入 Cloudflare（修改 NS 服务器）
2. Cloudflare 控制台 → **Zero Trust → Networks → Tunnels → Create a tunnel**（类型 Cloudflared）
3. 复制生成的 **Tunnel Token**
4. 该隧道 **Public Hostname** 添加：Type=`HTTP`，URL=`127.0.0.1:3000`，Subdomain 自定义
5. 回到应用：模式选 **命名隧道** → 粘贴 Token → **保存并启动**
6. 访问 `https://你的子域名.你的域名`

**已经用 `cloudflared service install eyJ...` 装过？**

应用会自动检测名为 `cloudflared` 的 Windows 服务：服务在运行时显示「隧道由系统托管」，**不会重复启动、不再报错**。也可以把整条命令直接粘贴进 Token 框（应用自动提取 `eyJ...`），或用页面上的「安装为 Windows 服务 / 卸载系统服务」按钮。

**把打印服务（8081）以「域名 + 路径」暴露（跨机部署时）**

1. 「设置」页填写「打印服务路径前缀」如 `/agent`，并设置**访问令牌**
2. Cloudflare **Public Hostname**：Path=`/agent`，Type=`HTTP`，URL=`127.0.0.1:8081`
3. 远端 Web 服务设 `HOST_PRINT_API=https://你的域名/agent`、`HOST_PRINT_TOKEN=同一令牌`
4. 访问 `https://你的域名/agent/health` 验证

> 安全：暴露公网务必设置访问令牌。完整步骤见 [`docs/cloudflare-tunnel.md`](./docs/cloudflare-tunnel.md)。

**安全建议**：尽快修改默认账号 `admin/admin123`；可在 Cloudflare **Access** 增加登录策略。

## 端口与数据

- 默认监听 `0.0.0.0`（Web 服务），局域网内可访问；如需仅本机使用，在「设置」关闭「局域网访问」。对外网暴露请使用 Cloudflare 隧道。
- 数据目录：
  - 安装版：`%APPDATA%\WebPrintTray\`
  - 便携/绿色版：在 exe 同目录放置一个空文件 `portable.flag`，数据即保存到 exe 同目录
  - 其中网页服务数据在 `web\data`（用户库 `users.json`、用量 `usage.json`），日志在 `web\logs`，程序日志在 `desktop.log`
- 默认管理员：`admin / admin123`，请登录网页后尽快修改。

## 从源码构建

```bash
# 依赖 Node.js 20+
cd desktop
npm install
npm start           # 开发运行（自动把 ../src 复制为内置服务）
npm run dist        # 打包，产物在 desktop/release/
```

产物：

- `WebPrintTray-Setup-<版本>.exe`：NSIS 安装包
- `WebPrintTray-<版本>-x64.zip`：免安装绿色版

> 网页服务源码位于根目录 `src/`，构建时由 `desktop/scripts/copy-server.js` 复制进应用；UI 依赖 `vue`、`element-plus` 由 `npm run vendor` 本地化到 `renderer/vendor`，离线可用。

**GitHub Actions 自动构建**

`.github/workflows/build-desktop.yml` 在推送 `v*` 标签时自动构建并发布到 Release，也可在 Actions 页手动触发。

### 代码签名（推荐，可消除杀软误报）

在仓库 `Settings → Secrets and variables → Actions` 添加：

- `WINDOWS_CSC_LINK`：`.pfx` 证书的 base64 或可访问 URL
- `WINDOWS_CSC_KEY_PASSWORD`：证书密码

之后打 tag 构建会自动签名并加时间戳。

## 用户与配额

### 游客（未登录）

- 无需登录即可打印，默认 **每 3 小时最多 5 次**
- 超出返回 `429` 并提示等待时间；任务失败/取消自动退还

### 用户与管理员

- 首次启动自动创建初始管理员（`admin / admin123`）
- 管理员在网页「用户管理」中可新增/修改/停用/删除用户，并设置每人配额（`0` 表示不限）
- 系统始终保留至少一名启用管理员；用户被停用/删除后会话立即失效

## 网页接口（内嵌 Web 服务，端口 3000）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 否 | 健康检查 |
| POST | `/api/login` | 否 | 登录 |
| POST | `/api/logout` | 否 | 退出 |
| GET | `/api/me` | 否 | 当前身份与剩余配额 |
| POST | `/api/print` | 否* | 上传并创建打印任务（受配额限制） |
| GET | `/api/tasks` | 否* | 任务列表（管理员看全部，其余看自己） |
| DELETE | `/api/tasks/:id` | 否* | 取消等待中的任务并退还配额 |
| GET | `/api/printers` | 否 | 本机打印机列表 |
| GET | `/api/status` | 否 | 打印服务在线状态 |

管理员接口（`admin` 角色）：`GET/POST /api/admin/users`、`PATCH/DELETE /api/admin/users/:id`、`GET /api/admin/usage`、`POST /api/admin/usage/reset`。

## 关于杀毒软件误报（Windows Defender / SmartScreen）

**为什么会误报？**

1. **未做代码签名**：未签名的 Electron 程序会被 SmartScreen 标为“未知发布者”，ML 引擎也容易把安装包判为可疑。
2. **内置 pdf 打印组件**：`pdf-to-printer` 自带 `SumatraPDF`，程序运行时会在本机目录释放并执行一个第三方 PE 文件，符合“释放并执行可执行文件”的启发式特征。
3. **运行时下载**：应用可下载 `cloudflared`（用户主动触发）也会增加“下载器”嫌疑。

**如何解决（按推荐程度）**

1. **代码签名（根治）**：购买 OV/EV 代码签名证书，按上文配置 Secrets，重新打 tag 即自动签名，SmartScreen / 杀软误报基本消除。
2. **向微软提交误报**：<https://www.microsoft.com/wdsi/filesubmission> 选择“软件开发者”，上传 exe 说明为误报，通常 24–72 小时解除。
3. **使用绿色 zip 版**：1.0.2 起已移除自解压目标，改用标准 zip，显著降低启发式命中。
4. **本机临时放行**：Defender「排除项」加入程序目录，或 SmartScreen 选择“仍要运行”（仅建议自用）。

## 项目结构

```
web-print/
├── src/                       # 网页服务源码（构建时复制进桌面应用）
│   ├── app.js                 # Express：会话、静态资源、路由、start/stop
│   ├── config.js
│   ├── middleware/ routes/ services/ public/
├── desktop/                   # Electron 桌面应用（主交付）
│   ├── main.js                # 窗口、托盘、内嵌 Web/打印/隧道生命周期
│   ├── preload.js
│   ├── lib/printService.js    # 本地打印服务
│   ├── lib/cloudflared.js     # Cloudflare Tunnel 管理
│   ├── renderer/              # Apple 风格界面（Vue3 + Element Plus）
│   ├── scripts/               # copy-server.js / copy-vendor.js / make-icons.js
│   ├── build/                 # 图标资源
│   └── server/                # 由 src 复制而来（构建产物，gitignore）
├── .github/workflows/         # GitHub Actions 构建与发布
└── LICENSE
```

## 可选扩展

- 打印任务人工审核
- 按用户绑定默认打印机 / 多打印机切换
- 邮件、企业微信通知打印状态
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
