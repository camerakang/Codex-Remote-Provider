# Codex Remote Provider 1.2.1

- “旧对话锁定的模型”新增“全选”“只选 Claude / 聚合模型”“清空”三个按钮，并显示已选数量。目标模型自动排除在外。
- 修正待修改会话文件数：一个文件里出现多个选中模型时只算一次。

1.2.0 的功能：把旧对话锁定的不可用模型（例如切到 ChatGPT 官方登录后的 Codex++ 聚合模型 `cpx-relay-xxx/claude-opus-5-5`）改成目标模型，支持本机和远端；修复本机前需完全退出 Codex 桌面版。修改前自动备份到 `~/.codex/provider-sync/repair-backups/`，失败时回滚。

修复功能需要 Python 3。Windows 提供安装版和便携版；macOS 提供 Apple Silicon、Intel 的 DMG 和 ZIP。macOS 包未经过 Apple 公证，首次打开时请在 Finder 中右键选择“打开”。
