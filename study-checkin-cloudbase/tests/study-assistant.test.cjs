const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createStudyApi } = require("./helpers/study-api.cjs");

const BASE = "https://a1-d4gbxgxqmc01c0e55-1462114738.ap-shanghai.app.tcloudbase.com/study-assistant";
const PREFIX = "/study-assistant";
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() - 5 * 60 * 60 * 1000));
const MEMBER = "study-user-1";
const GROUP = "study-checkin-fixed-pair";
const PRESENCE = `focus-presence-${GROUP}`;
const GRANT = "study-assistant-grant-user1";
const checkinId = (id) => sha(`${MEMBER}|${DAY}|${id}`).slice(0, 40);

function fixture(options = {}) {
  return createStudyApi({
    members: { [MEMBER]: { id: MEMBER, userKey: "user1", name: "蔡", groupId: GROUP,
      taskTemplate: ["done", "active", "studied", "remaining"].map((id) => ({ id, title: id })),
      taskOverrides: { "2099-01-01": [{ id: "future", title: "future" }] },
    }, "study-user-2": { id: "study-user-2", userKey: "user2", name: "刘", groupId: GROUP,
      taskTemplate: [{ id: "private-liu", title: "刘的任务" }] } },
    sessions: {
      [`focus-state-${MEMBER}`]: { id: `focus-state-${MEMBER}`, days: { [DAY]: {
        totalSeconds: 120, segments: [{ taskId: "studied", durationSeconds: 120 }],
      } } },
      [PRESENCE]: { activeByMember: { [MEMBER]: { id: "running", memberId: MEMBER, day: DAY,
        taskId: "active", taskTitle: "active", startedAt: Date.now() - 10000 } } },
    },
    checkins: { [checkinId("done")]: { id: checkinId("done"), memberId: MEMBER, groupId: GROUP, day: DAY, taskId: "done" } },
  }, { env: { STUDY_ASSISTANT_BASE_URL: BASE, STUDY_ASSISTANT_OWNER_UID_HASH: sha("fixture-uid") }, ...options });
}

async function http(api, path, body, access, method = "POST") {
  const response = await api.call({ httpMethod: method, path, headers: {
    "content-type": "application/json", ...(access ? { authorization: `Bearer ${access}` } : {}),
  }, body: JSON.stringify(body) });
  return { ...response, data: response.body ? JSON.parse(response.body) : null };
}
async function connect(api, scope = "study:read study:write") {
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await http(api, `${PREFIX}/oauth/register`, { redirect_uris: [redirect], token_endpoint_auth_method: "none" });
  assert.equal(registration.statusCode, 201);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorization = { response_type: "code", client_id: registration.data.client_id,
    redirect_uri: redirect, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", state: "test-state-1234", resource: `${BASE}/mcp`, scope };
  const consent = await api.call({ action: "authorizeAssistant", token: "user1", authorization });
  assert.equal(consent.ok, true, consent.error);
  const code = new URL(consent.data.redirectUrl).searchParams.get("code");
  const params = { grant_type: "authorization_code", client_id: authorization.client_id,
    redirect_uri: redirect, code, code_verifier: verifier, resource: `${BASE}/mcp` };
  const exchanged = await http(api, `${PREFIX}/oauth/token`, params);
  assert.equal(exchanged.statusCode, 200);
  return { ...exchanged.data, params, authorization };
}
async function tool(api, access, name, args = {}) {
  const result = await http(api, `${PREFIX}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args } }, access);
  assert.equal(result.statusCode, 200);
  return result.data.result;
}

test("HTTP默认关闭；未授权不能读取数据或绕过SDK修改任务", async () => {
  const disabled = fixture({ env: {} });
  assert.equal((await http(disabled, `${PREFIX}/mcp`, {})).statusCode, 503);
  const api = fixture();
  const result = await http(api, `${PREFIX}/mcp`, { action: "resetTasks", token: "user1", day: DAY });
  assert.equal(result.statusCode, 401);
  assert.ok(result.headers["WWW-Authenticate"].includes("oauth-protected-resource"));
  assert.equal(api.writes.length, 0);
});

test("连接检查只允许绑定浏览器，失败仅返回阶段和安全错误码且不写数据", async () => {
  const api = fixture({ beforeTransaction() { const error = new Error("private token should not be returned"); error.code = "DATABASE_TRANSACTION_UNAVAILABLE"; throw error; } });
  const result = await api.call({ action: "diagnoseAssistantConnection", token: "user1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.available, false);
  assert.equal(result.data.stage, "transaction-start");
  assert.equal(result.data.code, "DATABASE_TRANSACTION_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("private token"), false);
  assert.equal(api.writes.length, 0);
  const stranger = fixture({ uid: "other-browser" });
  assert.equal((await stranger.call({ action: "diagnoseAssistantConnection", token: "user1" })).ok, false);
});

test("提交错误仅向授权端返回阶段和错误码，不返回原始错误信息", async () => {
  const api = fixture({ beforeCommit() { const error = new Error("private credential data"); error.code = "DATABASE_TRANSACTION_WRITE_FAILED"; throw error; } });
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const result = await api.call({ action: "authorizeAssistant", token: "user1", authorization: {
    response_type: "code", client_id: `study-chatgpt-${sha(redirect)}`, redirect_uri: redirect,
    code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "stage-test-state",
    resource: `${BASE}/mcp`, scope: "study:read study:write",
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /事务提交：DATABASE_TRANSACTION_WRITE_FAILED/);
  assert.equal(result.error.includes("private credential"), false);
  assert.equal(api.store.sessions[GRANT], undefined);
});

test("只有管理员绑定的匿名浏览器可授权，不能仅凭选择蔡建立连接", async () => {
  const api = fixture({ uid: "another-browser" });
  const status = await api.call({ action: "getAssistantConnection", token: "user1" });
  assert.equal(status.data.configured, false);
  assert.equal(status.data.setupFingerprint, sha("another-browser"));
  const result = await api.call({ action: "authorizeAssistant", token: "user1", authorization: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /已绑定/);
  assert.equal(api.writes.length, 0);
});

test("OAuth校验ChatGPT回调和PKCE，授权码只能交换一次且数据库不存明文令牌", async () => {
  const api = fixture();
  assert.equal((await http(api, `${PREFIX}/oauth/register`, { redirect_uris: ["https://evil.example/callback"] })).statusCode, 400);
  const auth = await connect(api);
  assert.equal((await http(api, `${PREFIX}/oauth/token`, auth.params)).statusCode, 400);
  const serialized = JSON.stringify(api.store);
  assert.equal(serialized.includes(auth.access_token), false);
  assert.equal(serialized.includes(auth.refresh_token), false);
  assert.equal(serialized.includes(auth.params.code), false);
  const initialize = await http(api, `${PREFIX}/mcp`, { jsonrpc: "2.0", id: 2, method: "initialize",
    params: { protocolVersion: "2025-03-26" } }, auth.access_token);
  assert.equal(initialize.data.result.protocolVersion, "2025-03-26");
  assert.equal(initialize.data.result.serverInfo.version, "1.7.0");
  assert.equal((await api.call({ action: "authorizeAssistant", token: "user2", authorization: auth.authorization })).ok, false);
});

test("读取仅返回蔡的进度、稳定ID和保护状态，不返回刘或凭证", async () => {
  const api = fixture(); const auth = await connect(api);
  const result = await tool(api, auth.access_token, "get_study_progress", { day: DAY });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.completedCount, 1);
  assert.equal(result.structuredContent.recordedSeconds, 120);
  assert.deepEqual(Array.from(result.structuredContent.tasks, (task) => task.protected), [true, true, true, false]);
  assert.equal(JSON.stringify(result).includes("private-liu"), false);
  const injected = await tool(api, auth.access_token, "get_study_progress", { day: DAY, token: "user2" });
  assert.equal(injected.isError, true);
});

test("按修订号保存后重新读取：保护记录、稳定ID、模板和其他日期，重试不重复新增", async () => {
  const api = fixture(); const auth = await connect(api);
  const before = structuredClone(api.store);
  const snapshot = (await tool(api, auth.access_token, "get_study_progress", { day: DAY })).structuredContent;
  const args = { day: DAY, revision: snapshot.revision, requestId: "request-first-save",
    tasks: [{ id: "active", title: "active" }, { id: "done", title: "done" },
      { id: "studied", title: "studied" }, { id: "remaining", title: "调整后的学习任务" }, { title: "新增任务" }] };
  const saved = await tool(api, auth.access_token, "update_study_plan", args);
  assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
  assert.equal(saved.structuredContent.progress.totalCount, 5);
  assert.equal(saved.structuredContent.progress.tasks[3].id, "remaining");
  assert.deepEqual(api.store.checkins, before.checkins);
  assert.deepEqual(api.store.sessions[`focus-state-${MEMBER}`], before.sessions[`focus-state-${MEMBER}`]);
  assert.deepEqual(api.store.sessions[PRESENCE].activeByMember, before.sessions[PRESENCE].activeByMember);
  assert.deepEqual(api.store.members[MEMBER].taskTemplate, before.members[MEMBER].taskTemplate);
  assert.deepEqual(api.store.members[MEMBER].taskOverrides["2099-01-01"], before.members[MEMBER].taskOverrides["2099-01-01"]);
  assert.deepEqual(api.store.members["study-user-2"], before.members["study-user-2"]);
  const replay = await tool(api, auth.access_token, "update_study_plan", args);
  assert.equal(replay.structuredContent.replayed, true);
  assert.deepEqual(Array.from(replay.structuredContent.taskIds), Array.from(saved.structuredContent.taskIds));
  const reused = await tool(api, auth.access_token, "update_study_plan", { ...args, tasks: [] });
  assert.equal(reused.isError, true);
});

test("原样保存不创建单日覆盖，也不改学习状态或触发对方汇总刷新", async () => {
  const api = fixture(); const auth = await connect(api);
  const snapshot = (await tool(api, auth.access_token, "get_study_progress", { day: DAY })).structuredContent;
  const memberBefore = structuredClone(api.store.members[MEMBER]);
  const presenceBefore = structuredClone(api.store.sessions[PRESENCE]);
  const result = await tool(api, auth.access_token, "update_study_plan", { day: DAY,
    revision: snapshot.revision, requestId: "unchanged-save-check",
    tasks: snapshot.tasks.map(({ id, title }) => ({ id, title })),
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.unchanged, true);
  assert.deepEqual(api.store.members[MEMBER], memberBefore);
  assert.deepEqual(api.store.sessions[PRESENCE], presenceBefore);
  assert.equal(api.store.members[MEMBER].taskOverrides[DAY], undefined);
});

test("删除/改名受保护任务、未知或重复ID、50字和20项上限均由后端拒绝", async () => {
  const api = fixture(); const auth = await connect(api);
  const snapshot = (await tool(api, auth.access_token, "get_study_progress", { day: DAY })).structuredContent;
  const base = snapshot.tasks.map(({ id, title }) => ({ id, title }));
  const cases = [base.filter((task) => task.id !== "done"), base.filter((task) => task.id !== "active"),
    base.filter((task) => task.id !== "studied"), base.map((task) => task.id === "done" ? { ...task, title: "改名" } : task),
    [...base, { id: "made-up", title: "伪造ID" }], [...base, base[0]], [...base, { title: "学".repeat(51) }],
    [...base, ...Array.from({ length: 17 }, () => ({ title: "超额" }))]];
  const writes = api.writes.length;
  for (const tasks of cases) {
    const result = await tool(api, auth.access_token, "update_study_plan", {
      day: DAY, revision: snapshot.revision, requestId: "request-invalid-save", tasks });
    assert.equal(result.isError, true);
  }
  assert.equal(api.writes.length, writes);
});

test("编辑期间打卡或计划变化会拒绝旧修订号；事务提交期间的新打卡也不会被覆盖", async () => {
  let race = false;
  const api = fixture({ beforeCommit(store) {
    if (race) store.checkins[checkinId("remaining")] = { id: checkinId("remaining"), memberId: MEMBER,
      groupId: GROUP, day: DAY, taskId: "remaining" };
  } });
  const auth = await connect(api);
  const snapshot = (await tool(api, auth.access_token, "get_study_progress", { day: DAY })).structuredContent;
  const args = { day: DAY, revision: snapshot.revision, requestId: "request-racing-save",
    tasks: snapshot.tasks.filter((task) => task.id !== "remaining").map(({ id, title }) => ({ id, title })) };
  race = true;
  assert.equal((await tool(api, auth.access_token, "update_study_plan", args)).isError, true);
  assert.equal(api.store.members[MEMBER].taskOverrides[DAY], undefined);
  race = false;
  const old = await tool(api, auth.access_token, "update_study_plan", args);
  assert.equal(old.isError, true);
  assert.match(old.content[0].text, /进度已变化/);
});

test("刷新令牌轮换、过期、只读权限与撤销立即生效", async () => {
  const api = fixture(); const auth = await connect(api, "study:read");
  const write = await tool(api, auth.access_token, "update_study_plan", {});
  assert.equal(write.isError, true);
  const params = { grant_type: "refresh_token", refresh_token: auth.refresh_token,
    client_id: auth.params.client_id, resource: `${BASE}/mcp` };
  const refreshed = await http(api, `${PREFIX}/oauth/token`, params);
  assert.equal(refreshed.statusCode, 200);
  assert.equal((await http(api, `${PREFIX}/oauth/token`, params)).statusCode, 400);
  assert.equal((await http(api, `${PREFIX}/mcp`, {}, auth.access_token)).statusCode, 401);
  api.store.sessions[GRANT].accessExpiresAt = Date.now() - 1;
  assert.equal((await http(api, `${PREFIX}/mcp`, {}, refreshed.data.access_token)).statusCode, 401);
  assert.equal((await api.call({ action: "revokeAssistant", token: "user1" })).ok, true);
  const status = await api.call({ action: "getAssistantConnection", token: "user1" });
  assert.equal(status.data.connected, false);
});

test("错误PKCE、过期授权码、错误resource和取消授权不会激活连接", async () => {
  const api = fixture(); const auth = await connect(api);
  const consent = await api.call({ action: "authorizeAssistant", token: "user1", authorization: auth.authorization });
  const params = { ...auth.params, code: new URL(consent.data.redirectUrl).searchParams.get("code") };
  assert.equal((await http(api, `${PREFIX}/oauth/token`, { ...params, code_verifier: "x".repeat(43) })).statusCode, 400);
  assert.equal((await http(api, `${PREFIX}/oauth/token`, { ...params, resource: "https://evil.example/mcp" })).statusCode, 400);
  assert.equal((await tool(api, auth.access_token, "get_study_progress")).isError, undefined);
  const denied = await api.call({ action: "denyAssistant", token: "user1", authorization: auth.authorization });
  const target = new URL(denied.data.redirectUrl);
  assert.equal(target.searchParams.get("error"), "access_denied");
  assert.equal(target.searchParams.get("iss"), BASE);
  api.store.sessions[GRANT].pending.expiresAt = Date.now() - 1;
  assert.equal((await http(api, `${PREFIX}/oauth/token`, params)).statusCode, 400);
});

test("只读元数据不访问数据库，非法日期/来源/批量RPC请求被拒绝", async () => {
  const api = fixture();
  const metadata = await http(api, `/.well-known/oauth-authorization-server${PREFIX}`, {}, null, "GET");
  assert.equal(metadata.data.issuer, BASE);
  assert.deepEqual(metadata.data.code_challenge_methods_supported, ["S256"]);
  assert.equal(api.writes.length, 0);
  const auth = await connect(api);
  assert.equal((await tool(api, auth.access_token, "get_study_progress", { day: "2026-02-30" })).isError, true);
  assert.equal((await http(api, `${PREFIX}/mcp`, [], auth.access_token)).statusCode, 400);
  const origin = await api.call({ httpMethod: "POST", path: `${PREFIX}/mcp`, headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(origin.statusCode, 403);
});
