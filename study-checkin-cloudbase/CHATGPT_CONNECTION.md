# 学习计划 ChatGPT 接入

版本保持 1.7.0；沿用现有 CloudBase 环境与 `study-checkin-api`，不新增环境、数据库集合、计时心跳或常驻服务器。

## 能力和边界

- `get_study_progress`：读取蔡最近7天至未来6天某一学习日的任务、完成状态、已记录时长与当前自习状态。默认当天，北京时间05:00换日。
- `update_study_plan`：保存含今天在内的7天中某一天的完整任务列表，返回保存后重新读取的进度。每天20项，普通标题50字，保持稳定ID。
- 保留已完成、自习中（包括暂停）和已有学习时长的任务及标题。不操作打卡、计时、默认模板、刘或其他日期。自动课程保留原ID和标题。
- 保存必须携带刚读取的修订标记与唯一请求ID。数据库事务检查并发修改；网络重试同一请求不重复新增。
- 未记录的单词数量、网课位置等仍是未知。插件不会在聊天结束后持续监控。
- 默认关闭；配置未完成时 HTTP 返回503，未授权返回401，不执行网页原有业务动作。

## 授权

使用 OAuth 授权码 + PKCE S256；只接受 ChatGPT 官方回调地址。授权码5分钟、访问令牌1小时、可轮换刷新令牌30天。`sessions` 只保存令牌的SHA256，不保存明文。

只有管理员绑定的匿名浏览器可以确认/撤销连接，不能只凭选择蔡授权。绑定值来自云函数运行时的真实 CloudBase `uid` 的SHA256，不接受客户端提供的uid。网页身份选择体验不变。

绑定浏览器的站点登录信息被清除后，需要维护者重新绑定。改变绑定值会使旧令牌失效。一次只保留一个活动连接；重新授权替换旧连接。蔡可在侧边栏“连接ChatGPT”撤销连接。

现有网站的“直接选择蔡/刘”仍是原有信任模型；这次增加的是插件授权的浏览器绑定，不是对整个网站新增账户认证。

## 发布与配置顺序

1. 运行 `npm install`、`npm test`、`npm run build`。发布前备份旧云函数包和静态文件。
2. 在原 `study-checkin-api` 发布包含 `study-assistant.js` 的完整代码包，保持普通云函数、Node.js18或以上、`index.main`、现有权限与自动安装依赖。
3. 将新 `dist` 发布到原静态托管。此时接口仍关闭。用用户平时使用的浏览器选择蔡，打开“连接ChatGPT”，取得“接入标识”。这个值只是绑定指纹，不是生产访问密钥。
4. 在原函数配置两个环境变量（不改 `.env.production`）：

   - `STUDY_ASSISTANT_BASE_URL`：`https://a1-d4gbxgxqmc01c0e55-1462114738.ap-shanghai.app.tcloudbase.com/study-assistant`
   - `STUDY_ASSISTANT_OWNER_UID_HASH`：上一步的64位接入标识。

5. 在**已经启用**的原 HTTP 网关添加以下路径到同一 `study-checkin-api`。须保留完整路径、查询字符串、请求头和请求体，禁止缓存；使用处理器返回的HTTP状态码、头和响应体。网关不代替这里的OAuth校验；原SDK的函数认证规则保持不变。

   - `/study-assistant`（前缀匹配，路径透传）
   - `/.well-known/oauth-authorization-server/study-assistant`（OAuth元数据）

   `/study-assistant/oauth/authorize` 为授权跳转，`/oauth/register` 为限定ChatGPT回调的公开客户端登记，`/oauth/token` 为令牌交换，`/mcp` 为实际工具接口。对应地址均位于第一条路径下。

6. 核查网关是否会产生新增收费或需开通资源；如提示收费、升级或开通，停止并让用户决定。日常工具调用仍会消耗现有函数与数据库资源，不能承诺零消耗。默认域名受腾讯云开发测试限制；需实际验证ChatGPT连接，不以元数据可访问代替完整接通。
7. 在 ChatGPT → 插件 → 添加 → 添加自定义 MCP 服务器创建个人插件“自习计划”。连接地址是上方BASE_URL加 `/mcp`，认证OAuth，使用动态客户端注册（不要填写云端访问密钥）。用户本人完成新增访问授权与网站确认。
8. 安装插件，在“学习计划安排”对话里 `@自习计划` 读取真实进度。首轮只读核验，然后测试经用户确认的保存并重新读取。不能仅凭创建成功声称全链路可用。

不在代码、文档、提交、聊天或压缩包中放入 `.env.production` 的访问密钥。插件不需要腾讯云管理密钥或OpenAI模型API密钥。

## 推荐对话指令

> 使用“自习计划”插件，先读取蔡今天最新的学习进度，再根据剩余时间调整未完成计划。保留受保护任务和稳定ID，不推断未记录的学习进度。只有我要求保存时才写入；保存后重新读取核验。出现修订冲突先重新读取再安排。

## 本地验证

- `npm test`：原有回归与授权、数据隔离、稳定ID、限额、修订冲突、事务并发、撤销和重试测试。
- `node tests/assistant-browser.mjs`：只在 `127.0.0.1:5174` 启动独立的内存界面夹具，替换CloudBase适配器，不访问生产数据。支持连接界面、`?connection=disabled` 未配置状态，以及普通/番茄钟操作的界面验收。该脚本不进入构建产物。

官方参考：[ChatGPT自定义MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[OAuth要求](https://developers.openai.com/plugins/build/auth)、[CloudBase HTTP访问](https://docs.cloudbase.net/service/access-cloud-function)。
