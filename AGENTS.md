# 双人学习打卡项目协作规则

开始任何工作前，先完整阅读 `PROJECT_CONTEXT.md`。它是本项目当前需求、架构、部署状态和历史决策的权威交接文件。

## 不可违反的约束

- 这是现有项目的持续迭代，不重做页面或整体架构；只做用户明确要求的修改和必要的小版本兼容。
- 只允许使用已有腾讯云 CloudBase 环境 `a1-d4gbxgxqmc01c0e55`。不得创建新环境。
- 不得开通、升级或启用任何可能收费的资源；一旦某一步可能收费，立即停止并向用户说明。
- 保持用户为“蔡”和“刘”，直接选择身份，不恢复共享码、邀请码或 PIN。
- 数据库集合 `groups`、`members`、`sessions`、`checkins` 必须保持客户端不可直接读写；业务数据只能通过普通云函数 `study-checkin-api` 访问。
- 不得把 `.env.production` 中的访问密钥写入文档、聊天、提交或压缩包。
- 任务必须使用稳定 `id` 关联完成记录与学习时长；排序时只改变数组顺序，绝不能按位置重建或交换任务 `id`。
- 优先节省 CloudBase 资源点：计时器本地每秒更新；可见页面每 3 分钟同步一次；隐藏页面停止轮询；不增加高频心跳、实时数据库监听或逐秒云端写入。

## 当前工程与验证

- 前端工程目录：`study-checkin-cloudbase/`
- 云函数目录：`study-checkin-cloudbase/functions/study-checkin-api/`
- 励志语录：`励志语录候选-1000条.md`
- 安装依赖：进入前端工程后执行 `npm install`。
- 构建：执行 `npm run build`，成功后只上传 `dist` 到现有静态网站托管根目录。
- 修改云函数时，仍部署为 `study-checkin-api`，Node.js 18 或更高普通云函数，并安装其 `package.json` 依赖。
- 每次改动至少验证桌面端、手机窄屏、蔡/刘身份切换、双方任务/进度、自习开始/暂停/继续/结束以及任务稳定 ID。

## 文档优先级

本文件和 `PROJECT_CONTEXT.md` 高于早期的 `study-checkin-cloudbase/README.md` 与 `study-checkin-cloudbase/CODEX_DEPLOY_PROMPT.txt`。后两者仍描述已经废弃的共享码/PIN 初始方案，只能作为历史资料，不能据此恢复旧逻辑。
