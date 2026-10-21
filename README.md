# Codex Remote Provider

适用于 Windows 和 macOS 的桌面工具，帮助使用 Codex 桌面版、Codex++ 和 SSH 远程主机的用户管理远端供应商与代理。

## 功能

- 将指定远程主机切换到官方 ChatGPT 登录、Codex++ 中转站，或与本机相同的供应商。
- 让远程主机使用本机代理（例如 Clash Verge）：局域网模式在远端 `~/.bashrc`／`~/.zshrc` 写入受管理的配置；SSH 隧道模式在软件运行期间保持 `ssh -R` 连接。
- 修改远端配置前会创建带时间戳的备份（`*.bak-<时间戳>`），修改后重启远端 `codex app-server`。

软件从 `~/.codex/.codex-global-state.json` 读取主机列表，从 `~/.codex/backups/codex-plus-live-*` 读取中转站配置。软件设置和日志保存在 `~/.codex/provider-sync/`。

切换供应商会修改远端 Codex 配置；首次操作前请确认目标主机和所选供应商。SSH 隧道模式需要软件持续运行，关闭软件后隧道随之断开。

## 下载与运行

从本仓库的 [Releases 页面](https://github.com/camerakang/Codex-Remote-Provider/releases) 下载对应系统的安装包：

- Windows：`*-win-setup.exe` 为安装版，`*-win-portable.exe` 为便携版。
- macOS：按处理器选择 `*-mac-arm64.dmg` 或 `*-mac-x64.dmg`；同时提供 ZIP 包。

macOS 版本使用临时签名，首次启动时可在 Finder 中右键应用并选择“打开”。如仍被隔离，可在确认下载来源后运行：

```sh
xattr -dr com.apple.quarantine "/Applications/Codex Remote Provider.app"
```

## 从源码构建

需要 Node.js 和 npm。在对应系统上执行：

```sh
npm ci
npm run dist:win   # Windows：输出 dist/*-win-setup.exe、*-win-portable.exe
npm run dist:mac   # macOS：输出 dist/*-mac-arm64.dmg、*-mac-x64.dmg 等
```

如果下载 Electron 依赖时需要代理，先设置 `HTTPS_PROXY=http://127.0.0.1:7897` 和 `ELECTRON_GET_USE_PROXY=1`；端口按本机代理配置调整。

## 命令行用法

命令行工具与桌面界面使用同一套核心逻辑。下面是常用示例：

```sh
npm run cli -- status
npm run cli -- official forlinx
npm run cli -- relay forlinx --dry-run
npm run cli -- proxy-set lan forlinx
```

`forlinx` 是示例主机名，请替换成自己的 SSH 主机名。执行 `npm run cli` 可查看其他命令。
