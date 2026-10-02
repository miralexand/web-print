# 宿主机打印 Agent（Windows）

Docker 容器无法直接访问 Windows 打印机驱动，因此由这个仅监听本机的 Node 服务承担最后一步打印。

## 功能
- `POST /print`：接收文件 + 打印参数，Office/图片自动用 LibreOffice 转 PDF，再调用本机打印机
- `GET /printers`：返回本机打印机列表
- `GET /health`：健康检查

## 安装与运行
```powershell
cd host-print-agent
npm install
# 可选：设置令牌，和 Docker 侧 HOST_PRINT_TOKEN 保持一致
$env:AGENT_TOKEN="my-secret"
$env:SOFFICE_PATH="C:\Program Files\LibreOffice\program\soffice.exe"
npm start
```

## 开源协议

基于 [木兰宽松许可证 第2版 (MulanPSL-2.0)](../LICENSE) 开源。

默认监听 `127.0.0.1:8081`，仅本机可访问，不要暴露到公网。

## 环境变量
| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8081` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，保持本机 |
| `AGENT_TOKEN` | 空 | 请求令牌，空则不校验 |
| `SOFFICE_PATH` | 自动探测 | LibreOffice 可执行文件路径 |
| `WORK_DIR` | 系统临时目录 | 上传/转换临时目录 |

## 作为 Windows 服务常驻（可选）
可用 [NSSM](https://nssm.cc/) 将 `npm start` 注册为开机自启服务：
```powershell
nssm install WebPrintAgent "C:\Program Files\nodejs\node.exe" "E:\project\web-print\host-print-agent\agent.js"
nssm set WebPrintAgent AppEnvironmentExtra AGENT_TOKEN=my-secret
nssm start WebPrintAgent
```
