const crypto = require("node:crypto");

const SITE = "https://a1-d4gbxgxqmc01c0e55-1462114738.tcloudbaseapp.com/";
const SCOPES = "study:read study:write";
const OWNER = "user1";
const GRANT_ID = "study-assistant-grant-user1";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const plain = (value) => { const { _id, ...rest } = value || {}; return rest; };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const daySchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "北京时间05:00换日的学习日，YYYY-MM-DD。" };
const TOOLS = [
  {
    name: "get_study_progress", title: "读取蔡的学习进度",
    description: "读取蔡指定学习日的最新任务、完成状态、各项学习时长和自习状态。安排或保存计划前必须读取；未记录的单词数量、视频位置等信息不可猜测。只返回蔡的数据。",
    inputSchema: { type: "object", properties: { day: daySchema }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["study:read"] }],
  },
  {
    name: "update_study_plan", title: "保存蔡的单日学习计划",
    description: "用户明确要求保存/修改计划时使用。提交当天完整任务列表及刚读取的revision；沿用已有任务id，新增才省略id。必须原样保留protected任务。最多20项，普通标题50字；只改当天，不改模板、打卡或计时。发生冲突先重新读取，不盲目重试。成功后返回重新读取的结果，向用户说明变化。",
    inputSchema: { type: "object", properties: {
      day: daySchema,
      revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
      requestId: { type: "string", minLength: 8, maxLength: 80, description: "本次保存的唯一标识；网络重试沿用原标识及完全相同的参数。" },
      tasks: { type: "array", maxItems: 20, items: { type: "object", properties: {
        id: { type: "string", maxLength: 40 }, title: { type: "string", minLength: 1, maxLength: 60 },
      }, required: ["title"], additionalProperties: false } },
    }, required: ["day", "revision", "requestId", "tasks"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["study:read", "study:write"] }],
  },
];

function createStudyAssistant(deps) {
  const { db, first, PublicError, tasksFor, dayInChina, dateOffset, focusStateId,
    loadFocusState, loadFocusPresence, studyDurationSeconds, definitions, presenceId, groupId } = deps;
  const owner = definitions.find((item) => item.userKey === OWNER);
  const grantRef = () => db.collection("sessions").doc(GRANT_ID);
  const fail = (message) => { throw new PublicError(message); };
  function config() {
    const raw = deps.baseUrl();
    if (!raw || !/^[a-f0-9]{64}$/.test(deps.ownerUidHash() || "")) fail("ChatGPT连接尚未配置，请先完成HTTP入口配置");
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/study-assistant"
      || url.hostname !== "a1-d4gbxgxqmc01c0e55-1462114738.ap-shanghai.app.tcloudbase.com" || url.port) {
      fail("ChatGPT连接地址配置无效");
    }
    return url.href.replace(/\/$/, "");
  }
  function allowedDay(value, write = false) {
    const today = dayInChina(new Date());
    const day = value === undefined ? today : value;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
      || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
      || day < dateOffset(today, write ? 0 : -7) || day > dateOffset(today, 6)) {
      fail(write ? "只能修改含今天在内的7天计划" : "只能读取最近7天至未来6天的计划");
    }
    return day;
  }
  function own(token) { if (token !== OWNER) fail("此连接仅支持蔡的学习计划"); }
  function callerFingerprint() {
    const uid = deps.callerUid();
    if (typeof uid !== "string" || !uid) fail("请刷新网站，恢复登录状态后重试");
    return sha(uid);
  }
  function boundOwner(token) {
    own(token);
    if (callerFingerprint() !== deps.ownerUidHash()) fail("请使用已绑定的浏览器确认或撤销连接");
  }
  const errorCode = (error) => typeof error?.code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code)
    ? error.code : error instanceof TypeError ? "TypeError" : "UNKNOWN";
  async function diagnose(token) {
    boundOwner(token);
    let stage = "grant-read";
    let tx;
    try {
      const existing = await grantRef().get();
      if (existing?.code) throw existing;
      stage = "transaction-start";
      tx = await db.startTransaction();
      stage = "transaction-read";
      const result = await tx.collection("sessions").doc(GRANT_ID).get();
      if (result?.code) throw result;
      stage = "transaction-rollback";
      await tx.rollback(); tx = null;
      return { available: true };
    } catch (error) {
      if (tx) await tx.rollback().catch(() => {});
      return { available: false, stage, code: errorCode(error) };
    }
  }
  async function transaction(work) {
    // The package also contains an obsolete transaction.js. Its actual entry
    // imports transaction/index.js, whose API is collection().doc().get/set.
    let tx;
    try { tx = await db.startTransaction(); }
    catch (error) { fail(`连接存储暂不可用（事务启动：${errorCode(error)}）`); }
    const document = (ref) => tx.collection(ref._coll).doc(ref.id);
    let stage = "事务读取";
    const checked = (result) => {
      if (result?.code) throw result;
      return result;
    };
    const read = async (ref) => { stage = "事务读取"; return first(checked(await document(ref).get())); };
    const writer = { set: async (ref, data) => { stage = "事务保存"; return checked(await document(ref).set(data)); } };
    try { const result = await work(writer, read); stage = "事务提交"; await tx.commit(); return result; }
    catch (error) {
      await tx.rollback().catch(() => {});
      if (error instanceof PublicError) throw error;
      fail(`连接存储暂不可用（${stage}：${errorCode(error)}）`);
    }
  }
  function usableGrant(grant, tokenHash) {
    return grant && !grant.revoked && grant.userKey === OWNER
      && grant.bindingHash === deps.ownerUidHash()
      && grant.accessHash === tokenHash && grant.accessExpiresAt > Date.now();
  }
  function makeSnapshot(day, member, state, presence, rows) {
    const completed = new Set(rows.filter((row) => row.memberId === owner.id && row.day === day)
      .map((row) => row.taskId || row.task));
    const active = presence?.activeByMember?.[owner.id] || null;
    const current = active?.day === day ? active : null;
    const daily = state?.days?.[day] || {};
    const seconds = {};
    for (const segment of daily.segments || []) {
      seconds[segment.taskId] = (seconds[segment.taskId] || 0) + Math.max(0, Number(segment.durationSeconds) || 0);
    }
    const original = tasksFor(member, day);
    const tasks = original.map((task) => ({ ...task, completed: completed.has(task.id),
      recordedSeconds: seconds[task.id] || 0, active: current?.taskId === task.id,
      protected: completed.has(task.id) || current?.taskId === task.id || (seconds[task.id] || 0) > 0,
    }));
    const revision = sha(canonical({ day, original, completed: [...completed].sort(),
      daily, active: current }));
    return { day, identity: { userKey: OWNER, name: owner.name }, revision, tasks,
      completedCount: tasks.filter((task) => task.completed).length, totalCount: tasks.length,
      recordedSeconds: Math.max(0, Number(daily.totalSeconds) || 0),
      active: current ? { taskId: current.taskId, taskTitle: current.taskTitle,
        paused: current.pausedAt != null, mode: current.timerMode || "stopwatch",
        effectiveSeconds: studyDurationSeconds(current, Date.now()) } : null,
      observedAt: Date.now(), limits: { tasksPerDay: 20, ordinaryTitleLength: 50 },
      note: "只包含网站已记录的进度；未记录的词数、视频位置等未知。",
    };
  }
  async function readState(day) {
    const [member, state, presence, rows] = await Promise.all([
      db.collection("members").doc(owner.id).get().then(first),
      loadFocusState(owner, day), loadFocusPresence(definitions, day),
      db.collection("checkins").where({ groupId, day }).limit(100).get(),
    ]);
    if (!member) fail("请先在网站选择蔡并初始化学习空间");
    return { member, state, presence, rows: rows.data || [] };
  }
  async function progress(args = {}) {
    if (!object(args) || Object.keys(args).some((key) => key !== "day")) fail("读取参数不正确");
    const day = allowedDay(args.day);
    const state = await readState(day);
    return makeSnapshot(day, state.member, state.state, state.presence, state.rows);
  }
  function cleanedPlan(args, snapshot) {
    if (!Array.isArray(args.tasks) || args.tasks.length > 20) fail("每天最多20项任务");
    const existing = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const seen = new Set();
    const tasks = args.tasks.map((item) => {
      if (!object(item) || Object.keys(item).some((key) => !["id", "title"].includes(key))) fail("任务参数不正确");
      if (typeof item.title !== "string" || !item.title.trim()) fail("任务标题不能为空");
      const title = item.title.trim();
      const old = item.id ? existing.get(item.id) : null;
      if (item.id !== undefined && (!old || seen.has(item.id))) fail("任务ID无效或重复，请重新读取计划");
      if (title.length > (old?.kind === "course" ? 60 : 50)) fail("普通任务标题最多50字");
      if (old?.kind === "course" && title !== old.title) fail("自动课程请保留原ID和标题；需要调整时请在网站编辑课程");
      const id = old?.id || `custom-${crypto.randomBytes(6).toString("hex")}`;
      seen.add(id);
      if (!old) return { id, title };
      const { completed, recordedSeconds, active, protected: protectedTask, ...stored } = old;
      return { ...stored, title };
    });
    for (const task of snapshot.tasks.filter((item) => item.protected)) {
      if (!tasks.some((item) => item.id === task.id && item.title === task.title)) {
        fail("必须原样保留已完成、自习中和已有学习时长的任务");
      }
    }
    return tasks;
  }
  async function update(args, accessHash) {
    if (!object(args) || Object.keys(args).some((key) => !["day", "revision", "tasks", "requestId"].includes(key))
      || !/^[a-f0-9]{64}$/.test(args.revision || "")
      || typeof args.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId)) fail("保存参数不正确");
    const day = allowedDay(args.day, true);
    if (!args.day) fail("保存必须指定学习日");
    const state = await readState(day);
    const payloadHash = sha(canonical(args));
    const result = await transaction(async (tx, read) => {
      allowedDay(day, true);
      const memberRef = db.collection("members").doc(owner.id);
      const presenceRef = db.collection("sessions").doc(presenceId);
      const member = await read(memberRef);
      const presence = await read(presenceRef);
      const focus = await read(db.collection("sessions").doc(focusStateId(owner.id)));
      const grant = await read(grantRef());
      if (!usableGrant(grant, accessHash)) fail("连接已过期或被撤销，请重新授权");
      if (grant.lastWrite?.requestId === args.requestId) {
        if (grant.lastWrite.payloadHash !== payloadHash) fail("同一请求标识不能用于不同的计划");
        return { ...grant.lastWrite.result, replayed: true };
      }
      const tasks = tasksFor(member, day);
      // Read missing deterministic check-in documents as well: a completion
      // racing this save must conflict with the transaction, not be lost.
      const checkinIds = new Set(tasks.map((task) => sha(`${owner.id}|${day}|${task.id}`).slice(0, 40)));
      for (const row of state.rows.filter((row) => row.memberId === owner.id)) {
        if (row._id || row.id) checkinIds.add(row._id || row.id);
      }
      const rows = [];
      for (const id of checkinIds) {
        const row = await read(db.collection("checkins").doc(id));
        if (row) rows.push(row);
      }
      const snapshot = makeSnapshot(day, member, focus, presence, rows);
      if (snapshot.revision !== args.revision) fail("计划或学习进度已变化，请重新读取后再安排");
      const next = cleanedPlan(args, snapshot);
      const removedIds = new Set(tasks.filter((task) => !next.some((item) => item.id === task.id)).map((task) => task.id));
      const nextMember = { ...plain(member), taskOverrides: { ...member.taskOverrides, [day]: next }, updatedAt: Date.now() };
      if (Array.isArray(member.courseActions)) {
        nextMember.courseActions = member.courseActions.map((action) => (
          action?.mode === "move" && action.targetDay === day && removedIds.has(action.task?.id)
            ? { ...action, removedFromPlan: true } : action
        ));
      }
      const unchanged = canonical(next) === canonical(tasks);
      const receipt = { saved: true, unchanged, day, taskIds: next.map((task) => task.id), requestId: args.requestId };
      // A retry or an explicit "save unchanged" must not turn an automatically
      // generated day into an override or trigger unnecessary partner refreshes.
      if (!unchanged) {
        await tx.set(memberRef, nextMember);
        await tx.set(presenceRef, { ...plain(presence), summaryRevision: random(), updatedAt: Date.now() });
      }
      await tx.set(grantRef(), { ...plain(grant), lastWrite: { requestId: args.requestId, payloadHash, result: receipt } });
      return receipt;
    });
    return { ...result, progress: await progress({ day }) };
  }
  function redirectAllowed(uri) {
    return typeof uri === "string" && (/^https:\/\/chatgpt\.com\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(uri)
      || uri === "https://chatgpt.com/connector_platform_oauth_redirect");
  }
  const clientId = (redirect) => `study-chatgpt-${sha(redirect)}`;
  function authRequest(params) {
    const base = config();
    if (!object(params) || params.response_type !== "code" || !redirectAllowed(params.redirect_uri)
      || params.client_id !== clientId(params.redirect_uri) || params.code_challenge_method !== "S256"
      || !/^[a-zA-Z0-9_-]{43}$/.test(params.code_challenge || "")
      || typeof params.state !== "string" || params.state.length < 8 || params.state.length > 1024
      || params.resource !== `${base}/mcp`
      || (params.scope !== undefined && (typeof params.scope !== "string"
        || params.scope.split(" ").some((scope) => !SCOPES.split(" ").includes(scope))))) {
      fail("ChatGPT授权请求无效，请从插件重新连接");
    }
    return { client_id: params.client_id, redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge, code_challenge_method: "S256", state: params.state,
      response_type: "code", resource: `${base}/mcp`, scope: params.scope || SCOPES };
  }
  async function connectionStatus(token) {
    own(token);
    const fingerprint = callerFingerprint();
    let base; try { base = config(); } catch { return { configured: false, connected: false, setupFingerprint: fingerprint }; }
    if (fingerprint !== deps.ownerUidHash()) return { configured: false, connected: false, setupFingerprint: fingerprint };
    const grant = first(await grantRef().get());
    return { configured: true, mcpUrl: `${base}/mcp`, connected: Boolean(grant && !grant.revoked
      && grant.bindingHash === deps.ownerUidHash()
      && grant.refreshExpiresAt > Date.now()), name: owner.name };
  }
  async function authorize(event) {
    boundOwner(event.token);
    const request = authRequest(event.authorization);
    const code = random();
    // Consent replaces only a pending code. A bad verifier must not revoke an
    // already working connection; the exchange atomically activates the grant.
    await transaction(async (tx, read) => {
      const previous = await read(grantRef());
      await tx.set(grantRef(), { ...plain(previous), userKey: OWNER, memberId: owner.id,
        pending: { ...request, bindingHash: deps.ownerUidHash(), codeHash: sha(code), expiresAt: Date.now() + 5 * 60 * 1000 } });
    });
    const target = new URL(request.redirect_uri);
    target.searchParams.set("code", code); target.searchParams.set("state", request.state); target.searchParams.set("iss", config());
    return { redirectUrl: target.href };
  }
  function deny(event) {
    own(event.token);
    const request = authRequest(event.authorization);
    const target = new URL(request.redirect_uri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("state", request.state); target.searchParams.set("iss", config());
    return { redirectUrl: target.href };
  }
  async function revoke(token) {
    boundOwner(token);
    await transaction(async (tx) => { await tx.set(grantRef(), { userKey: OWNER, memberId: owner.id, revoked: true, updatedAt: Date.now() }); });
    return { revoked: true };
  }
  async function exchange(params) {
    return transaction(async (tx, read) => {
      const grant = await read(grantRef());
      const base = config();
      if (!grant || params.resource !== `${base}/mcp`) fail("授权已失效，请重新连接");
      let scope;
      if (params.grant_type === "authorization_code") {
        const pending = grant.pending;
        if (!pending || pending.bindingHash !== deps.ownerUidHash() || pending.expiresAt <= Date.now() || sha(String(params.code || "")) !== pending.codeHash
          || params.client_id !== pending.client_id || params.redirect_uri !== pending.redirect_uri
          || !/^[a-zA-Z0-9._~-]{43,128}$/.test(params.code_verifier || "")
          || crypto.createHash("sha256").update(params.code_verifier).digest("base64url") !== pending.code_challenge) fail("授权码或校验信息无效");
        scope = pending.scope;
      } else if (params.grant_type === "refresh_token") {
        if (grant.revoked || grant.bindingHash !== deps.ownerUidHash() || grant.refreshExpiresAt <= Date.now() || sha(String(params.refresh_token || "")) !== grant.refreshHash
          || params.client_id !== grant.clientId) fail("连接已过期或被撤销，请重新授权");
        scope = grant.scope;
      } else fail("不支持的授权方式");
      const access = random(); const refresh = random();
      const next = { ...plain(grant), pending: null, revoked: false, scope,
        bindingHash: deps.ownerUidHash(),
        clientId: params.client_id, accessHash: sha(access), refreshHash: sha(refresh),
        accessExpiresAt: Date.now() + 60 * 60 * 1000, refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        connectedAt: Date.now() };
      await tx.set(grantRef(), next);
      return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope };
    });
  }
  const response = (statusCode, body, extra = {}) => ({ statusCode, isBase64Encoded: false,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
    body: body === undefined ? "" : JSON.stringify(body) });
  function parseBody(event) {
    if (event.isBase64Encoded) fail("不支持编码请求体");
    if (typeof event.body !== "string" || Buffer.byteLength(event.body) > 32768) fail("请求体格式或大小不正确");
    const type = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
    if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(event.body));
    if (!type.startsWith("application/json")) fail("请使用JSON或表单请求体");
    try { return JSON.parse(event.body); } catch { fail("JSON格式不正确"); }
  }
  async function http(event) {
    let base;
    try { base = config(); } catch { return response(503, { error: "assistant_not_configured" }); }
    const path = event.path;
    const method = event.httpMethod;
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    if (headers.origin && headers.origin !== "https://chatgpt.com") return response(403, { error: "origin_not_allowed" });
    const prefix = new URL(base).pathname;
    if (method === "GET" && path === `${prefix}/.well-known/oauth-protected-resource`) {
      return response(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SCOPES.split(" ") });
    }
    if (method === "GET" && [ `${prefix}/.well-known/oauth-authorization-server`,
      `/.well-known/oauth-authorization-server${prefix}` ].includes(path)) {
      return response(200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: SCOPES.split(" "), authorization_response_iss_parameter_supported: true });
    }
    try {
      if (path === `${prefix}/oauth/register` && method === "POST") {
        const body = parseBody(event);
        if (!object(body) || !Array.isArray(body.redirect_uris) || body.redirect_uris.length !== 1
          || !redirectAllowed(body.redirect_uris[0]) || (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none")) fail("只允许ChatGPT公开客户端回调地址");
        return response(201, { client_id: clientId(body.redirect_uris[0]), redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
      }
      if (path === `${prefix}/oauth/authorize` && method === "GET") {
        const request = authRequest(event.queryStringParameters);
        const target = new URL(SITE); target.searchParams.set("assistant_authorize", JSON.stringify(request));
        return response(302, undefined, { Location: target.href });
      }
      if (path === `${prefix}/oauth/token` && method === "POST") return response(200, await exchange(parseBody(event)));
    } catch (error) {
      return response(400, { error: path === `${prefix}/oauth/token` ? "invalid_grant" : "invalid_request",
        error_description: error instanceof PublicError ? error.message : "授权服务暂不可用" });
    }
    if (path !== `${prefix}/mcp`) return response(404, { error: "not_found" });
    const bearer = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(headers.authorization || "");
    const accessHash = bearer ? sha(bearer[1]) : "";
    const grant = bearer ? first(await grantRef().get()) : null;
    if (!usableGrant(grant, accessHash)) return response(401, { error: "unauthorized" }, {
      "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
    if (method !== "POST") return response(405, { error: "method_not_allowed" }, { Allow: "POST" });
    let message;
    try { message = parseBody(event); } catch { return response(400, { error: "invalid_request" }); }
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
      || (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) {
      return response(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }
    if (message.id === undefined) return response(202);
    const rpc = (result) => response(200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") return rpc({ protocolVersion: PROTOCOLS.includes(message.params?.protocolVersion)
      ? message.params.protocolVersion : "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "study-checkin", version: "1.7.0" },
      instructions: "只管理蔡的计划。先读取真实进度再调整，未记录的数据视为未知。仅用户要求保存时写入，遇冲突重新读取。保留受保护任务和稳定ID，不操作刘、打卡或自习计时。" });
    if (message.method === "ping") return rpc({});
    if (message.method === "tools/list") return rpc({ tools: TOOLS });
    if (message.method !== "tools/call") return response(200, { jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "Method not found" } });
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const needed = name === "update_study_plan" ? ["study:read", "study:write"] : ["study:read"];
      if (needed.some((scope) => !(grant.scope || "").split(" ").includes(scope))) fail("此连接没有所需权限，请重新授权");
      const result = name === "get_study_progress" ? await progress(args)
        : name === "update_study_plan" ? await update(args, accessHash) : fail("未知工具");
      return rpc({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return rpc({ isError: true, content: [{ type: "text", text: error instanceof PublicError ? error.message : "操作暂时失败；请先读取最新进度核实结果" }] });
    }
  }
  return { http, connectionStatus, authorize, deny, revoke, diagnose };
}

module.exports = { createStudyAssistant };
