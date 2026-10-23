# Workspace Bridge MCP

<img src="media/icon.png" width="88" height="88" alt="Workspace Bridge MCP：连接代码括号的工作区桥梁" />

[![自动检查](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml) · [MIT 开源许可](LICENSE) · [验收记录](docs/VALIDATION.md)

图标用代码括号和中间的连接线表示：让编辑器与 AI 客户端通过明确的工作区权限相连。
[English](README.md) · [简体中文](README.zh-CN.md) · [安全政策](SECURITY.md)

让 MCP 客户端访问 VS Code 中打开的工作区：读取项目文件、查看代码诊断，并通过 AI 工具完成可控的文件修改。权限开关保留在本地编辑器中。

默认开放读取。编辑和终端执行需要在本地为当前会话启用，终端命令还需要逐次批准。服务只监听本机回环地址，强制使用 Bearer Token；不会自动创建公网隧道，也不收集遥测。

**0.1.0** 为早期版本。目前以 Windows 作为验证平台；macOS、Linux 是目标平台，尚需分别验收。具体发布证据范围见[发布检查表](docs/RELEASE-CHECKLIST.md)。

## 可以做什么

| 用途 | 权限边界 |
| --- | --- |
| 识别当前工作区、发现可用能力 | 请求携带工作区标识；过期或不匹配的请求会被拒绝。 |
| 列目录、搜索和读取项目文件 | 检查工作区信任、真实路径边界、敏感文件名和读取大小。 |
| 查看 VS Code 诊断 | 返回编辑器现有诊断，不会替你安装或运行语言服务器。 |
| 创建或更新项目文件 | 本地启用本次会话的编辑权限；更新已有文件需要匹配 SHA-256。 |
| 执行终端命令 | 本地启用本次会话的终端权限，再对每条命令单独批准。 |
| 管理连接 | 本地控制面板、快捷操作选择、状态栏、Token 轮换与连接配置复制。 |

工具名称、参数及读取后修改的操作顺序见[工具参考](docs/TOOLS.md)。

## 安装与连接

1. 在 [GitHub Releases](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases) 下载 `.vsix`，核对发布页提供的 SHA-256。
2. 在 VS Code 打开 **扩展 → … → 从 VSIX 安装…**，选择下载的文件。
3. 打开可信任的文件夹，在活动栏进入 **Workspace Bridge / 工作区桥接** 面板并点击 **启动桥接**。也可以在命令面板运行 **启动桥接**（`workspaceBridge.start`）。
4. 确认面板显示的工作区，复制连接配置。首选端口被占用时，实际端口可能变化。
5. 将配置添加到可信任的 MCP 客户端。客户端需要支持 **Streamable HTTP** 和 **Authorization 请求头**。先用测试文件完成一次读取。

连接配置包含 Bearer Token。请存入客户端受保护的设置中，不要提交到仓库或粘贴到聊天、公开问题中；同时留意系统剪贴板历史。每个 VS Code 窗口有独立 Token，即使打开同一个文件夹也不共用。重载或重新打开窗口后会生成新 Token，需要重新复制配置。

不同客户端的配置格式可能不同。下面展示连接信息的结构，实际值以运行中面板复制的内容为准：

```json
{
  "mcpServers": {
    "workspace-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

`<PORT>`、`<TOKEN>` 是占位符。部分客户端使用其他传输名称或配置结构；只支持 stdio 的客户端不能直接使用这个 HTTP 地址。本版本不提供 OAuth 授权服务器，因此要求 OAuth 或不能自定义请求头的在线连接器可能不兼容。

## 编辑与终端

修改文件前，先读取文件并保留返回的 SHA-256，在本地面板启用编辑，再携带该哈希提交新内容。桥接会在本实例内串行处理同一文件的写入，并在实际应用前复核当前内容。若文件已经变化，应重新读取并合并内容；不要直接换一个新哈希强行重试。

终端默认关闭。启用后，编辑器仍会对每条命令要求本地批准。批准前确认命令和工作目录。命令使用系统 Shell 和你当前操作系统账户的权限执行，**这不是沙箱**：获批命令可以访问工作区之外的文件，也可以联网。

停止服务或切换工作区会重置编辑和终端权限。同一窗口内停止再启动会复用 Token，主动轮换可立即撤销旧凭据。重载窗口或切换工作区后会生成新 Token；扩展正常退出时删除当前 SecretStorage 记录。Token 改变后需要更新客户端保存的配置。

## 隐私与安全

- Token 通过 VS Code SecretStorage 保存；手动复制 Token 或连接配置会将秘密写入剪贴板和所选客户端。
- 文件工具按工作区相对路径检查真实位置，拒绝符号链接、目录联接和多硬链接文件，并在异步加载编辑器后、修改操作前后重新校验。这些检查降低风险，但不提供操作系统隔离，无法保证挡住本机恶意进程极速替换文件路径。常见敏感文件名和可识别凭据格式会被过滤，仍无法识别所有秘密。
- 本地活动记录与导出的桥接诊断报告仅保留运行元数据，不包含文件正文、终端输出、Bearer Token 或用户绝对路径。工具按需返回的代码诊断属于另一类结果，其中包含编辑器错误信息。
- 文件内容和命令结果返回给 MCP 客户端后，由该客户端及其模型提供商的日志、存储和保留政策决定后续处理方式。
- 远程访问需要你自行配置 TLS 转发、Host 允许列表和 Bearer 认证。公开端点前请阅读[远程访问说明](docs/REMOTE-ACCESS.md)。

详细边界见[安全政策](SECURITY.md)、[威胁模型](docs/THREAT-MODEL.md)和[审计说明](docs/SECURITY-AUDIT.md)。扫描无命中、测试通过不能证明完全没有漏洞，也不能证明历史安装从未发生过信息披露。

## 从源码构建

使用 `package.json` 所支持的 Node.js 和 npm 版本：

```sh
git clone https://github.com/Yari-tuber/vscode-workspace-bridge-mcp.git
cd vscode-workspace-bridge-mcp
npm ci
npm test
npm run privacy
npm run build
npm run test:integration
npm run package
```

需要 **VS Code 1.96 或更新版本**；源码构建需要 **Node.js 22 或更新版本**。集成脚本使用独立的 VS Code 配置和临时工作区；若未通过 `VSCODE_EXECUTABLE` 指定现有程序，会下载 VS Code 测试版本。打包产物位于 `artifacts/workspace-bridge-mcp-0.1.0.vsix`。开发与验收请使用只含虚构数据的临时工作区。

开发和代码审查约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 设置

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `workspaceBridge.autoStart` | `false` | 在可信工作区自动启动；权限开关仍从关闭状态开始。 |
| `workspaceBridge.port` | `3338` | 首选本地端口；占用时尝试后续 9 个端口。填 `0` 可直接请求可用端口。 |
| `workspaceBridge.allowedHosts` | `[]` | 用户自行转发时允许的额外精确主机名，不填协议、端口或通配符；本机回环访问仍可使用。 |

以上为机器级设置。编辑与终端授权通过本地面板管理，仅限当前会话，不存成工作区永久授权。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 客户端无法连接 | 确认服务已启动，重新复制配置取得实际端口，确认客户端支持 Streamable HTTP。 |
| 认证失败 | 使用当前窗口的配置；轮换 Token、重载或重开窗口、切换工作区后重新复制。不要在公开问题中贴 Token。 |
| 工作区请求被拒绝 | 重新发现当前工作区。不要直接复用另一个窗口或旧工作区的标识。 |
| 文件访问被拒绝 | 检查工作区信任、相对路径、敏感文件名、符号链接和读取限制。 |
| 写入发生冲突 | 重新读取当前文件，合并内容后再提交。 |
| 命令没有执行 | 在本地启用终端权限，并批准该次请求。拒绝或无人处理的请求不构成授权。 |
| 在线连接器不兼容 | 检查 HTTPS 转发、Host 允许列表、认证头透传，以及连接器本身的认证要求。 |

报告问题时，提供扩展、系统、VS Code 和客户端版本，以及使用虚构文件的复现步骤。删去秘密与私人内容；安全漏洞请走[私密报告流程](SECURITY.md)。

## 许可证与致谢

采用 [MIT 许可证](LICENSE)，依赖的原始版权和许可文本保留于[第三方声明](THIRD_PARTY_NOTICES.md)。上游灵感及协议 SDK 见[致谢](docs/ACKNOWLEDGEMENTS.md)。本项目为全新实现，不代表 VS Code、上游项目或客户端厂商的背书。
