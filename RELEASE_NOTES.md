# Codex Remote Provider 1.2.0

本版修复“切换登录方式后旧对话报 model is not supported”的问题，并支持修复本机对话。

- 旧对话会记住上一轮使用的模型（例如 Codex++ 聚合模型 `cpx-relay-xxx/claude-opus-5-5`）。切换到 ChatGPT 官方登录后，Codex 继续对话前会先用这个旧模型压缩上下文，被官方账号拒绝。
- “修复旧对话”页新增“旧对话锁定的模型”：扫描会话文件和索引里出现过的模型，勾选不可用的旧模型，统一改成目标模型（例如 `gpt-6.1-sol`）。只改 `turn_context` 和线程设置里的模型名，并移除旧模型的压缩兼容标记，对话内容不变。
- 新增“本机”卡片，可扫描和修复本机 `~/.codex`。修复本机前需完全退出 Codex 桌面版，程序检测到 Codex 仍在运行会拒绝修改。
- 修改前备份数据库和命中的会话文件到 `~/.codex/provider-sync/repair-backups/`，写入失败时回滚。

修复功能需要 Python 3。Windows 提供安装版和便携版；macOS 提供 Apple Silicon、Intel 的 DMG 和 ZIP。macOS 包未经过 Apple 公证，首次打开时请在 Finder 中右键选择“打开”。

使用方法、构建命令和代理模式说明见仓库 README。
