# Codex Remote Provider 1.3.0

- 新增“无法验证的思考记录”清理：Claude 等模型经中转站生成的加密思考记录，ChatGPT 官方后端无法解密，切换后继续旧对话会报 `The encrypted content for item rs_msg_… could not be verified`。扫描会统计这类记录，可清理“非 OpenAI 生成的”或“全部思考记录”。
- 清理时保留对话文字、工具调用和每行记录的序号，只把思考条目替换为 Codex 不会发送给模型的占位记录；压缩历史中的同类条目一并移除。修改前自动备份，失败回滚。
- 支持本机和远端；修复本机前需完全退出 Codex 桌面版。

修复功能需要 Python 3。Windows 提供安装版和便携版；macOS 提供 Apple Silicon、Intel 的 DMG 和 ZIP。macOS 包未经过 Apple 公证，首次打开时请在 Finder 中右键选择“打开”。
