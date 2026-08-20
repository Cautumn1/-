# 一起进步｜双人学习打卡（CloudBase 版）

这是现有 Sites 网站的 CloudBase 迁移版。页面、四项任务、双人共享码/PIN、进度与连续打卡逻辑保持不变；Cloudflare D1/API 已替换为 CloudBase 云函数与文档数据库。

## 项目结构

- `src/`：React 前端
- `functions/study-checkin-api/`：CloudBase 普通云函数
- `dist/`：执行 `npm run build` 后生成，上传到静态网站托管
- `CODEX_DEPLOY_PROMPT.txt`：在本地 Codex 中粘贴的完整部署指令

## 本地构建

```powershell
npm install
npm run build
```

环境 ID 已写入 `.env.production`。如果以后更换 CloudBase 环境，请更新该文件后重新构建。

## 数据集合

- `groups`：双人空间及共享码
- `members`：两位成员及 PIN 哈希
- `sessions`：登录会话令牌
- `checkins`：每日任务打卡记录

PIN 不会明文保存在数据库中。数据库应禁止浏览器直接读写，只允许云函数使用服务端权限访问。

## 部署

打开本地 Codex，确认当前目录是本项目根目录，然后把 `CODEX_DEPLOY_PROMPT.txt` 的全部内容粘贴给 Codex。它会通过已配置的 CloudBase MCP 登录、创建资源、部署云函数和上传静态网站。
