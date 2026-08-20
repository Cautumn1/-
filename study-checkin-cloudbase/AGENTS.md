# 双人学习打卡前端/云函数协作规则

本目录是实际 Vite React 工程。完整上下文位于上一级 `../PROJECT_CONTEXT.md`；开始工作前必须先读完它。

- 唯一 CloudBase 环境：`a1-d4gbxgxqmc01c0e55`。不得创建新环境，不得开通或升级付费资源。
- 用户固定显示为蔡和刘，直接选身份，不恢复共享码、邀请码或 PIN。
- 数据只经 `study-checkin-api` 访问；禁止前端直接读写 `groups`、`members`、`sessions`、`checkins`。
- 任务完成和学习时长依赖稳定 `taskId`。排序只移动完整任务对象，不按位置重建 ID。
- 自习计时每秒仅在本地更新；可见页面每 3 分钟同步一次，隐藏页面停止，无刷新次数上限，并保留 60 秒节流。
- 不泄露 `.env.production` 的 `VITE_CLOUDBASE_ACCESS_KEY`。
- 前端改动后依次运行 `npm install`、`npm run build`，只上传 `dist` 到现有静态托管。
- 云函数保持名称 `study-checkin-api`、Node.js 18 或更高普通云函数，安装其 `package.json` 依赖。
- 本目录的旧 `README.md` 与 `CODEX_DEPLOY_PROMPT.txt` 含已废弃的共享码/PIN 方案，不是当前需求依据。
