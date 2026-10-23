# Workspace Bridge MCP

<p align="center">
  <img src="media/readme-hero.png" alt="Workspace Bridge MCP — 连接你的工作区，权限留在你手中。" width="1280" />
</p>

<p align="center">
  <a href="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml"><img src="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml/badge.svg" alt="自动检查" /></a>
  <a href="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases"><img src="https://img.shields.io/github/v/release/Yari-tuber/vscode-workspace-bridge-mcp?color=55cdb0&amp;label=release" alt="最新版本" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/VS_Code-1.96%2B-007ACC" alt="需要 VS Code 1.96 或更新版本" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94a3b8" alt="MIT 开源许可" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong><br />
  <a href="#三步开始使用">开始使用</a> · <a href="docs/TOOLS.md">工具参考</a> · <a href="docs/GETTING-STARTED.md#中文上手指南">配置指南</a> · <a href="SECURITY.md">安全政策</a>
</p>

**让 AI 客户端用上 VS Code 已有的项目上下文。** 读取实时文件、跟踪代码符号、查看诊断、准备精确修改，访问权限由本地编辑器控制。

Workspace Bridge 是**运行在 VS Code 中的 MCP 服务端**，供外部 MCP 客户端连接。VS Code 内置 MCP 支持的方向相反：让 VS Code 作为客户端调用其他服务。要把当前工作区提供出去，无须再把本扩展配置成 VS Code 内部的 MCP 服务。

> **连接要求：**客户端支持 Streamable HTTP 和自定义 `Authorization: Bearer …` 请求头。Bearer 认证不等于 OAuth；强制要求 OAuth 的在线连接器可能不兼容。本扩展不会自动创建公网隧道。

![VS Code 中真实运行的 Workspace Bridge 连接面板与示例代码](media/screenshots/control-panel.jpg)

*v0.2.0 隔离开发配置中的真实截图，使用专门创建的演示项目，不包含密钥或个人项目。顶部横幅和下方流程图为原创示意图。*

## 三步开始使用

1. **安装。** 从 [Releases](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases/latest) 下载 `.vsix`，核对 SHA-256，在 VS Code 选择 **扩展 → … → 从 VSIX 安装…**。
2. **启动。** 打开可信任的文件夹，在活动栏进入 **Workspace Bridge / 工作区桥接**，点击 **启动桥接**，确认面板显示的工作区。
3. **连接。** 点击 **复制客户端配置**，填入兼容的 MCP 客户端，再使用 **复制起步提示词**，先发现工作区并读取内容。

启动后默认允许读取；编辑和终端执行需要你在本地开启。每个窗口有独立 Token。连接配置包含这个秘密，请放入客户端受保护的设置，不要提交到仓库或粘贴进聊天。

[详细安装、客户端配置与故障排查 →](docs/GETTING-STARTED.md#中文上手指南)

## 用编辑器里的上下文完成工作

| 你想做的事 | 桥接提供的能力 |
| --- | --- |
| **熟悉项目** | 工作区标识、安全入口文件样本、文件列表、字面文本搜索和实时文件读取，包括尚未保存的编辑内容。 |
| **理解代码** | 编辑器现有诊断、文档符号、定义、引用、悬停类型提示，以及当前文件与选区位置。语言功能依赖已安装的语言服务。 |
| **精确修改** | 本地差异预览、SHA-256 冲突检查、全文写入、范围编辑和唯一字面文本替换。范围编辑与文本替换**默认只预览**。 |
| **运行必要检查** | 本地启用终端权限、逐条批准命令后，执行有时间和输出限制的终端检查。 |
| **管理连接** | 本地控制面板、状态栏、连接配置复制、Token 轮换、起步提示词与脱敏的桥接诊断报告。 |

服务提供 **15 个工具**和 `review_workspace` 提示词。[工具参考](docs/TOOLS.md)列出参数、结果限制及读取—预览—修改顺序。选区正文仅在客户端明确请求时返回。

<p align="center">
  <img src="media/readme-workflow.png" alt="外部 MCP 客户端通过带 Bearer 认证的 Streamable HTTP 连接 VS Code 中的 Workspace Bridge，再由编辑器 API 访问可信工作区。默认先读取，编辑需本地开启，终端命令逐条批准。" width="1280" />
</p>

## 权限清楚，操作可控

| 能力 | 初始状态 | 本地控制方式 |
| --- | --- | --- |
| 读取允许的文件与编辑器上下文 | 在可信工作区启动服务后可用 | 停止桥接即可结束访问；文件工具检查选定工作区边界并过滤敏感内容。 |
| 预览或保存修改 | **关闭** | 为当前会话开启编辑。修改已有文件需要当前 SHA-256，旧快照会被拒绝。 |
| 执行终端命令 | **关闭** | 先开启终端权限，再对**每条命令**及其工作目录批准。 |
| 远程连接 | 仅监听本机回环地址 | 自行配置 HTTPS 转发和允许的主机名，见[远程访问](docs/REMOTE-ACCESS.md)。 |

停止服务或切换工作区会重置编辑和终端权限。重载窗口会生成新 Token；主动轮换会立即撤销旧 Token。请使用目标窗口的连接配置，并在修改前重新确认工作区。

**获批终端命令使用你的操作系统账户权限，不在沙箱中运行。** 它可以访问工作区之外的文件，也可以联网。

## 连接客户端

从正在运行的面板复制实际配置。以下仅展示结构，不同客户端的配置格式可能不同：

```json
{
  "mcpServers": {
    "workspace-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

`<PORT>`、`<TOKEN>` 是占位符。只支持 stdio 的客户端需要自行添加 HTTP 适配层。远程客户端需要自建 HTTPS 转发；本版本没有 OAuth 授权服务器、自动隧道或多窗口路由器。

可以这样发起第一轮请求：

> 先发现当前工作区，读取 README 并查看现有代码诊断。用文件位置说明你的发现。不要修改文件，也不要运行终端命令。

## 隐私保护与实际边界

- **默认留在本机。** 回环地址监听、Bearer 认证、VS Code SecretStorage，无遥测。主动复制配置会将 Token 写入剪贴板和所选客户端。
- **文件访问受限。** 相对路径、真实路径检查、链接拒绝、敏感文件名/内容过滤和结果大小限制；过滤无法识别所有秘密，也不提供操作系统隔离。
- **桥接记录尽量精简。** 活动日志和导出的桥接报告不含文件正文、终端输出、Token 或用户绝对路径。按请求返回的文件、语言服务和命令结果仍会发给客户端，并受它的保留政策影响。

开放远程端点或启用终端前，请阅读[安全政策](SECURITY.md)、[威胁模型](docs/THREAT-MODEL.md)和[审计说明](docs/SECURITY-AUDIT.md)。扫描和测试通过不能证明完全没有漏洞。

## 验证范围与兼容性

发布流程在 **Windows、macOS、Linux** 上检查构建、单元测试、打包和隐私；另在隔离的 **Windows 与 Linux** 环境运行过真实编辑器集成检查。具体版本的证据以[验收记录](docs/VALIDATION.md)与 [CI 运行](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml)为准。

需要 **VS Code 1.96+**。WSL、SSH、容器及其他远程扩展宿主需单独验收；“本机”指实际运行扩展宿主的机器。客户端是否兼容取决于传输和认证能力，不能仅凭产品名称判断。

## 构建与参与贡献

需要 **Node.js 22+**：

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

集成测试使用独立 VS Code 配置和临时工作区；未通过 `VSCODE_EXECUTABLE` 指定现有程序时，会下载测试运行时。开发与验收请使用虚构数据。

| 继续了解 | 内容 |
| --- | --- |
| [配置与故障排查](docs/GETTING-STARTED.md#中文上手指南) | 安装、设置、Token 生命周期和连接错误 |
| [工具与示例](docs/TOOLS.md) | 参数、行号约定、编辑流程和错误处理 |
| [远程访问](docs/REMOTE-ACCESS.md) | HTTPS 转发、Host 校验和远程环境 |
| [相关项目与设计参考](docs/RELATED-PROJECTS.md) | 同类桥接、实现参考和后续方向 |
| [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md) | 开发约定与变更内容 |
| [项目致谢](docs/ACKNOWLEDGEMENTS.md) · [第三方声明](THIRD_PARTY_NOTICES.md) | 上游参考与依赖许可证 |

采用 [MIT 许可证](LICENSE)。本项目不代表 VS Code、MCP 客户端厂商或上游项目的背书。
