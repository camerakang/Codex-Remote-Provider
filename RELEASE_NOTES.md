# Codex Remote Provider 1.2.2

- “改为模型”改成下拉选择：自动读取当前登录方式支持的模型（中转站 / Codex++ 读 `model_catalog_json`，官方登录读 `models_cache.json`），默认选中当前配置的模型。当前不是官方登录时，额外列出“官方登录（ChatGPT）”的模型，方便切换前先修好。
- 旧模型列表里，目标模型所在登录方式不提供的模型会标红；“只选不支持的”一键勾选这些模型（替代原来的“只选 Claude / 聚合模型”）。读不到模型列表时退回手动填写。
- 保留“全选”和“清空”。

修复功能需要 Python 3。Windows 提供安装版和便携版；macOS 提供 Apple Silicon、Intel 的 DMG 和 ZIP。macOS 包未经过 Apple 公证，首次打开时请在 Finder 中右键选择“打开”。
