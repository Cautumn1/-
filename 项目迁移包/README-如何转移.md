# 如何把本次工作转移到新项目

这个包用于迁移“继续开发所需的上下文”，不是 Codex/ChatGPT 聊天气泡的逐字备份。

## 最推荐的方法

1. 创建一个新的 Codex 项目。
2. 把整个工作区文件夹 `study-checkin-cloudbase` 作为该项目的根目录打开，而不是只放前端子目录。
3. 根目录的 `AGENTS.md` 会告诉 Codex必须遵守的规则；`PROJECT_CONTEXT.md` 包含完整需求、架构、部署状态、历史修复和验收清单。
4. 在新任务中发送：

```text
请先完整阅读 AGENTS.md 和 PROJECT_CONTEXT.md，再从当前状态继续。不要创建新 CloudBase 环境，不要开通或升级任何付费资源。
```

## 如果只能上传文件到聊天项目

至少上传：

- `AGENTS.md`
- `PROJECT_CONTEXT.md`
- `验收清单.md`

需要修改代码时，还必须把实际源码目录一并提供；上下文文件不会代替源代码。

## 安全说明

- 迁移包故意不包含 `.env.production`、访问密钥、临时凭证、`node_modules`、`dist` 或日志。
- 生产配置仍留在原本地工程中。若移动源码，请通过安全方式单独迁移 `.env.production`，不要上传到聊天或公开仓库。
- 迁移过程本身不会写入 CloudBase，也不会产生付费资源。

## 权威性

`PROJECT_CONTEXT.md` 和 `AGENTS.md` 是当前权威说明。前端工程里的旧 `README.md` 与 `CODEX_DEPLOY_PROMPT.txt` 仍描述已经废弃的共享码/PIN 方案，不要让新对话按它们恢复旧功能。
