# WebPrint 安卓客户端（薄壳 APK）

对接 [web-print](../readme.md) 自托管打印网关的安卓客户端。

**设计定位**：薄壳（thin shell）WebView 容器。服务端会安装在**多台电脑**上，客户端只负责
「记住并管理多个服务器地址 → 选一个 → 加载它的网页界面」；打印、任务队列、配额、登录等
全部由服务端网页提供。客户端本身**不含任何打印业务逻辑**。

这样做的理由是：服务端网页已经是移动端可用的，重写一套原生 UI 的收益远小于它的维护成本。
详见 [移动端可行性评估与开发计划](../flutter-client/mobile-app-plan.md)。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 多服务器管理 | 手动添加 / 切换 / 长按删除，可给每台机器起中文别名 |
| **扫码添加** | 扫描服务端网页「手机接入」卡片显示的二维码，自动填入地址 |
| 网页界面 | WebView 加载服务端网页，支持登录、上传文件、查看任务 |
| 文件上传 | 已实现 `onShowFileChooser`，网页里的「点击选择文件」在壳内可用 |
| **分享面板打印** | 在微信/相册/文件管理器里「分享 → 打印助手」即可直接打印，无需先打开 App |
| **仅允许 HTTPS** | 只接受 `https://` 地址；`http://` 会被拒绝，且系统层面禁止明文流量 |
| 证书确认 | 证书无法验证时弹窗让用户决定「继续 / 取消」，取消为默认安全分支 |
| 中文界面 | 全部界面文案在 `res/values/strings.xml` |

## 使用流程

> **前提**：客户端只允许 HTTPS，因此必须先在打印主机上启用 **Cloudflare 隧道**。
> 明文局域网地址（`http://192.168.x.x:3000`）手机端无法使用。

1. 在打印主机上启动 Web 服务，并在「Cloudflare 隧道」页启动隧道（快速或命名隧道）。
2. 打开网页端（`http://127.0.0.1:3000`），页面里的 **「手机接入」** 卡片会自动选中隧道地址。
3. 手机 App →「扫码添加」扫描该二维码；或点「手动添加」输入 `https://xxx.trycloudflare.com`。
4. 在服务器列表里点选该服务器，App 即加载它的网页界面。
5. 若使用自签证书，首次访问会弹出证书确认框，选择「继续」即可。

> 扫码得到的内容就是一个**纯 URL**（例如 `https://xxxx.trycloudflare.com`），
> 因此任何扫码 App 都能识别；用系统相机扫也会直接打开该网页。

## 分享面板打印

在**任意 App**里选中内容 → 分享 → 选择「打印助手」，即可直接打印，不必先打开 App 再上传。

- 支持的分享内容：**文字**（`text/plain`）、**文件**（PDF / 图片 / Word / Excel / PPT / txt），
  以及一次分享**多个文件**（`ACTION_SEND_MULTIPLE`）。
- 打开后会有一个**确认页**：显示「即将打印」的内容（文件名+大小，或文字摘要）、
  服务器（多个服务器时为下拉选择）、份数，然后是「打印 / 取消」。
- 打印按钮会把内容上传到服务器，成功后显示 `已提交打印（OK task=<任务号>），剩余 N 次`。
- 上传时**复用 WebView 的登录会话**（读取同一个 Cookie），因此登录状态下按用户配额计，
  未登录则按游客配额计。
- 不会重复上传：一次批量全部成功后按钮会被禁用。

> 服务端错误会原样显示，例如配额用尽时是「打印次数已用完（HTTP 429）：…」。

## 构建

### 前置

- JDK 17 或更高（本机用 JDK 21 验证）
- Android SDK：`platforms;android-34`、`build-tools;34.0.0`、`platform-tools`
- 首次构建需要联网（下载 Gradle 与 Android Gradle Plugin）

### 配置 SDK 路径

在 `android-client/local.properties` 写入（该文件已被 gitignore）：

```properties
sdk.dir=C:/Users/<你的用户名>/AppData/Local/Android/Sdk
```

### 构建 APK

```bat
cd android-client
gradlew.bat assembleDebug
```

macOS / Linux 用 `./gradlew assembleDebug`。

产物：`android-client/app/build/outputs/apk/debug/app-debug.apk`

首次执行 `gradlew` 会自动下载 Gradle 8.9 到 `~/.gradle`。若本机已装 Gradle 8.7+，
也可以直接 `gradle assembleDebug`。

### 安装到手机

```bat
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

或把 APK 拷到手机点击安装（需允许「未知来源」）。

## 版本号与发布

### 版本号

客户端版本**只有一个来源**：[`gradle.properties`](gradle.properties)

```properties
webprint.versionName=2.2.0
webprint.versionCode=20200
```

- `versionName` 会显示在 App 菜单的「关于」对话框里
- `versionCode` 必须单调递增，约定 `major*10000 + minor*100 + patch`（2.2.0 → 20200）

打 tag 发布时 **CI 会用 tag 覆盖这两项**（tag `v2.2.0` → `2.2.0` / `20200`），
所以正式 APK 的版本号始终等于 tag，不会出现本地版本与发布版本对不上的情况。

换算逻辑放在 [`scripts/version.js`](scripts/version.js)，可以本地直接运行：

```bat
node scripts\version.js 2.2.0          :: 输出 name=2.2.0 与 code=20200
node scripts\version.js 2.2.0 --code   :: 只输出 20200
```

也支持 `2.2.0-beta` 这类预发布后缀：后缀保留在 `versionName`，`versionCode` 取数字部分。

### GitHub Actions 自动构建

工作流：[`.github/workflows/build-android.yml`](../.github/workflows/build-android.yml)

| 触发方式 | 行为 |
| --- | --- |
| 推送 `v*` tag | 用 tag 作为版本号构建，并把 APK 追加到同名 Release |
| 手动触发（Actions → Build Android Client → Run workflow） | 可用 `version_name` 指定版本，留空则用 `gradle.properties` 的默认值 |
| 改动 `android-client/**` 的 Pull Request | 只做构建验证，不发布 |

产物名为 `WebPrintClient-<版本>.apk`。同一个 tag 也会触发桌面端工作流，
两者各自往同一个 Release 追加文件，互不覆盖发布说明。

**可选：配置正式签名。** 在仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥口令 |

配置后工作流会自动输出**已签名**的 release APK；未配置时输出 debug APK
（可直接安装，但带 debuggable 标记，仅适合内部测试）。

### 发布步骤

```bat
:: 1. 本地确认构建通过
cd android-client
gradlew.bat assembleDebug

:: 2. 打 tag 并推送（同时触发桌面端与安卓端构建）
git tag v2.2.0
git push origin v2.2.0
```

## 技术选型

| 项 | 选择 | 原因 |
| --- | --- | --- |
| 语言 | **纯 Java** | 薄壳没有业务逻辑，不引入 Kotlin 插件可显著缩短构建链路 |
| UI 框架 | **无**（框架原生控件，代码内构建界面） | 避免 AndroidX / AppCompat / Material 依赖，APK 更小、构建更稳 |
| 依赖 | **仅 `com.google.zxing:core:3.5.3`** | 只用于二维码解码，纯 Java，无 Android 依赖 |
| minSdk / targetSdk | 24 / 34 | 覆盖 Android 7.0 及以上 |
| APK 体积 | 约 **345 KB** | — |

## 目录结构

```
android-client/
├─ settings.gradle / build.gradle / gradle.properties
├─ gradlew / gradlew.bat / gradle/wrapper/     # Gradle wrapper
├─ debug.keystore                              # 仅用于 debug 的密钥库（口令为标准 android）
├─ docs/screenshots/                           # 模拟器实测截图
└─ app/
   ├─ build.gradle
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ java/com/webprint/client/
      │  ├─ MainActivity.java          # WebView 壳：菜单、进度、错误页、文件选择
      │  ├─ ServersActivity.java       # 服务器列表：手动添加 / 扫码添加 / 切换 / 删除
      │  ├─ ScanActivity.java          # 相机预览 + ZXing 解码
      │  ├─ ShareActivity.java         # 分享面板入口：解析分享内容 + 确认页 + 上传
      │  ├─ ServerStore.java           # SharedPreferences 持久化 + 地址规范化
      │  └─ CaptureFileProvider.java   # 供网页「拍照」用的 ContentProvider
      └─ res/
         ├─ values/strings.xml         # 全部中文文案
         ├─ values/ids.xml             # 便于 UI 自动化测试的稳定控件 id
         └─ xml/network_security_config.xml  # 禁止明文 HTTP；信任系统与用户证书
```

## 服务端配套接口

本次为支持扫码接入，服务端新增两个**无需登录**的接口（实现见
[`src/routes/access.js`](../src/routes/access.js)、[`src/services/qrcode.js`](../src/services/qrcode.js)）：

### `GET /api/access-info`

返回当前访问地址、隧道地址与（可选）局域网入口，供网页端展示二维码。
**客户端只允许 HTTPS，因此默认只返回 https 候选**（`accessHttpsOnly` 默认开启，
设 `ACCESS_HTTPS_ONLY=0` 可恢复展示明文入口，仅供内网调试）。

```json
{
  "origin": "https://xxxx.trycloudflare.com",
  "publicUrl": "https://xxxx.trycloudflare.com",
  "port": 3000,
  "secure": true,
  "httpsOnly": true,
  "candidates": [
    { "url": "https://xxxx.trycloudflare.com", "label": "隧道地址（手机可直接访问）", "kind": "tunnel" },
    { "url": "https://xxxx.trycloudflare.com", "label": "当前访问地址", "kind": "current" }
  ],
  "hint": ""
}
```

没有可用 https 入口时，`candidates` 为空且 `hint` 给出指引，网页端会据此提示用户先启动隧道。

### `GET /api/qrcode`

返回二维码 **SVG**。不传 `data` 时编码当前访问地址。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `data` | 当前 origin | 要编码的内容，上限 1024 字节 |
| `scale` | 4 | 每模块像素，1–20 |
| `margin` | 4 | 静默区模块数，0–16 |
| `ecc` | `M` | 纠错级别，`L` 或 `M` |

二维码编码器是**纯 JavaScript、零依赖**实现（字节模式，版本 1–10，纠错 L/M），
未给服务端引入任何新的 npm 依赖。

## 已验证 / 未验证

以下为**本机 Android 14 模拟器（x86_64，API 34）实测**结果，截图见
[`docs/screenshots/`](docs/screenshots/)。

### 基础功能

| 项 | 结果 |
| --- | --- |
| Gradle 构建（含 `clean assembleDebug`） | ✅ BUILD SUCCESSFUL，APK 345 KB |
| 安装并启动 | ✅ 无崩溃 |
| 无服务器时自动进入「服务器」页 | ✅ 空状态文案正常 |
| WebView 加载服务端网页 | ✅ 完整渲染「新建打印任务」页 |
| 运行时相机权限申请 | ✅ 弹出系统授权弹窗 |
| `ScanActivity` 打开相机（legacy API） | ✅ `Camera API version 1` 连接成功，取景框与「取消」正常 |
| 服务端二维码可被 **App 同款 ZXing 3.5.3** 解码 | ✅ 5/5（含中文地址） |
| 服务端二维码可被独立解码器 jsQR 解码 | ✅ 17/17（含中文、参数钳制） |
| 二维码矩阵与 node-qrcode 参考实现比对 | ✅ 52/52 逐字节一致 |
| `normalizeUrl` 地址规范化 | ✅ 32/32（编译真实方法后逐例执行） |

### HTTPS-only 策略（本轮新增，模拟器实测）

测试环境：本机自签证书 + Node HTTPS 反向代理（TLS 终止 → 明文回源），模拟 Cloudflare 隧道。

| 项 | 结果 |
| --- | --- |
| 预置一条 `http://` 记录 → 启动后列表为空（地址被拒） | ✅ 进入「服务器」空状态页 |
| 预置一条 `https://` 记录 → 正常加载 | ✅ 进入 WebView 页 |
| 证书无法验证时弹出确认框 | ✅ 见 `05-ssl-confirm.png`，默认焦点在「取消」 |
| 选择「继续」后页面正常加载 | ✅ 见 `06-https-page.png` |
| 平台层禁止明文流量 | ✅ 合并后的 `network_security_config.xml` 为 `cleartextTrafficPermitted="false"` |
| 网页端二维码卡片改为展示隧道地址 | ✅ 见 `07-qr-tunnel-address.png`（`https://10.0.2.2:3443`，标注「推荐」） |
| 服务端只返回 https 候选 | ✅ `/api/access-info` 14/14 |
| `/api/qrcode` 默认编码隧道地址（而非明文 origin） | ✅ 独立解码器还原一致 |

### 分享面板打印（本轮新增，模拟器实测 16/16）

| 项 | 结果 |
| --- | --- |
| 系统分享面板注册 | ✅ `query-activities` 对 `text/plain`、`image/png`、`application/pdf`、`SEND_MULTIPLE` 均解析到本 App |
| 分享文字 → 确认页显示内容与字数 | ✅ 见 `08-share-text.png` |
| 分享图片 → 确认页显示文件名与大小 | ✅ 见 `09-share-file.png`（`share-test.png（8.3 KB）`） |
| 点「打印」上传文字 | ✅ `已提交打印（OK task=…），剩余 4 次`，见 `10-share-uploaded.png` |
| 点「打印」上传文件 | ✅ `已提交打印（OK task=…），剩余 3 次`，见 `11-share-file-uploaded.png` |
| **服务端确实收到**（`/api/tasks` 复核） | ✅ `kind=text` 25 字节；`kind=image` 8461 字节，**与源文件逐字节大小一致** |
| 配额按次扣减（5→4→3） | ✅ 说明会话/配额链路正确 |
| 上传过程无崩溃 | ✅ AndroidRuntime 无本应用记录 |

**未验证（需要在真机上确认）**：

- 用真实相机扫描真实二维码的完整链路（模拟器无法向摄像头注入画面）
- 文件选择器往返：网页里选文件 → 系统文件管理器 → 文件回传给网页（`onShowFileChooser`）
- 网页内「拍照」→ `CaptureFileProvider` 的 URI 是否被各机型文件管理器接受
- 旋转、后台恢复、错误页「重试」
- `CaptureFileProvider` 的路径穿越防护未经安全评审
- **证书确认框的「取消」分支**只做了代码审查，未在模拟器上点过取消
- 分享面板：一次分享**多个文件**、2 个以上服务器时的下拉选择、真实 `content://`
  （MediaStore/微信 FileProvider）来源——本次用的是应用私有目录的 `file://` URI
- 分享面板在 `onCreate` 里**主线程读取文件**（上限 20MB），20MB 级别会有可感知卡顿，
  建议后续挪到工作线程

## 已知限制与取舍

1. **仅允许 HTTPS**：`http://` 地址会被 `normalizeUrl` 拒绝，`network_security_config.xml`
   也在平台层禁止明文流量。**升级影响**：旧版本里保存过的 `http://` 地址会在
   `ServerStore.list()` 里被过滤掉，用户需要重新用 https 添加。
2. **证书无法验证时询问用户**（`onReceivedSslError` → 「继续 / 取消」对话框，默认在「取消」）。
   选择「继续」即跳过证书校验，存在中间人风险；这是为自签证书场景保留的出口，
   若你的环境全部使用 Cloudflare 隧道的合法证书，可以进一步收紧为直接拒绝。
   > 注意：**分享面板走的是 `HttpURLConnection`，它始终严格校验证书**，不受该对话框影响。
   > 自签证书环境下，网页能打开但分享上传会报 `Trust anchor … not found`。
3. **地址规范化会丢弃路径、查询串与锚点**。薄壳只需要站点根地址。若将来服务被反向代理到
   `https://host/print` 这类子路径，这里会静默丢掉 `/print`，需要一并调整
   `ServerStore.normalizeUrl`。
4. **网页内的 WebRTC 权限请求一律拒绝**（`onPermissionRequest`）。打印壳用不到网页摄像头。
5. **分享面板本地校验按扩展名**（对齐服务端的 `ALLOWED_EXT`），声明 MIME 与扩展名不一致时
   以扩展名为准；无扩展名的条目会按 MIME 补一个（`document.pdf` / `image.jpg`）。
6. **双击返回退出**（2 秒内），未在需求中，为防误触添加。
7. `android:allowBackup="true"`（沿用项目原有设置），服务器地址可能被系统备份带到新手机。
8. **Debug 构建**：仓库内的 `debug.keystore` 口令是标准的 `android`，仅供调试。
   正式分发请生成自己的 keystore 并在 `app/build.gradle` 配置 `release` 签名。

## 排错

| 现象 | 处理 |
| --- | --- |
| 构建报 `SDK location not found` | 检查 `local.properties` 的 `sdk.dir` |
| 构建报 `Could not resolve com.google.zxing:core` | 首次构建需联网访问 Maven Central |
| 添加地址时提示必须以 https 开头 | 客户端不支持明文 HTTP，请先启动隧道并使用隧道域名 |
| 网页打不开、提示连接失败 | 确认隧道已启动且域名可访问；在 App 菜单里「刷新」 |
| 每次都弹证书确认框 | 该地址使用的是自签证书；改用 Cloudflare 隧道的合法证书即可不再提示 |
| 网页能打开，但分享打印报 `Trust anchor … not found` | 分享上传强制校验证书，自签证书不被信任；请改用受信任证书（隧道域名） |
| 分享面板里找不到「打印助手」 | 该内容类型的分享未注册（如 zip）；或 App 被系统禁用 |
| 分享后提示「该文件类型服务器不支持」 | 服务端只接受 PDF / 图片 / Office / txt |
| 二维码扫不出来 | 调大网页端二维码尺寸；确认手机未贴太近；或改用「手动添加」 |
| 网页上传文件没反应 | 该机型文件管理器可能拦截；换用「文件」类应用重试 |
| 升级后服务器列表变空 | 旧记录是 `http://` 地址，已被 HTTPS-only 策略过滤，需重新添加 |


