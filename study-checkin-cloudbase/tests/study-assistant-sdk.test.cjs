const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { createRequire } = require("node:module");
const apiRequire = createRequire(path.join(__dirname, "../functions/study-checkin-api/index.js"));
const { Db } = apiRequire("@cloudbase/database");
const { EJSON } = apiRequire("bson");
const { createStudyAssistant } = require("../functions/study-checkin-api/study-assistant");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("实际安装SDK入口完成首次授权与PKCE交换：缺失文档、事务读取和写入契约正确", async () => {
  const OriginalRequest = Db.reqClass;
  const store = {};
  const calls = [];
  let transactions = 0;
  class LocalRequest {
    async send(action, params = {}) {
      calls.push({ action, transactionId: params.transactionId });
      if (action === "database.startTransaction") return { transactionId: `fixture-${++transactions}` };
      if (action === "database.commitTransaction" || action === "database.abortTransaction") return {};
      const id = EJSON.parse(params.query)._id;
      assert.equal(params.collectionName, "sessions");
      assert.ok(params.transactionId);
      if (action === "database.getDocument") return { data: { list: store[id] ? [EJSON.stringify(store[id])] : [] } };
      if (action === "database.modifyDocument") {
        store[id] = EJSON.parse(params.data);
        return { data: { updated: 1, upsert_id: id } };
      }
      throw new Error(`Unexpected SDK operation: ${action}`);
    }
  }
  Db.reqClass = LocalRequest;
  try {
    const base = "https://a1-d4gbxgxqmc01c0e55-1462114738.ap-shanghai.app.tcloudbase.com/study-assistant";
    const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const verifier = "v".repeat(43);
    const assistant = createStudyAssistant({ db: new Db({ env: "fixture" }),
      first: (result) => Array.isArray(result?.data) ? result.data[0] || null : result?.data || null,
      PublicError: class extends Error {}, definitions: [{ id: "study-user-1", userKey: "user1", name: "蔡" }],
      baseUrl: () => base, ownerUidHash: () => sha("bound-uid"), callerUid: () => "bound-uid",
    });
    const authorization = { response_type: "code", client_id: `study-chatgpt-${sha(redirect)}`,
      redirect_uri: redirect, code_challenge_method: "S256",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      state: "contract-test-state", resource: `${base}/mcp`, scope: "study:read study:write" };
    const consent = await assistant.authorize({ token: "user1", authorization });
    const code = new URL(consent.redirectUrl).searchParams.get("code");
    assert.ok(code);
    const exchanged = await assistant.http({ httpMethod: "POST", path: "/study-assistant/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: authorization.client_id,
        redirect_uri: redirect, resource: `${base}/mcp`, code, code_verifier: verifier }).toString(),
    });
    assert.equal(exchanged.statusCode, 200, exchanged.body);
    const credentials = JSON.parse(exchanged.body);
    assert.ok(credentials.access_token);
    assert.equal(JSON.stringify(store).includes(credentials.access_token), false);
    assert.equal(transactions, 2);
    assert.equal(calls.filter((item) => item.action === "database.commitTransaction").length, 2);
    assert.equal(calls.filter((item) => item.action === "database.abortTransaction").length, 0);
  } finally { Db.reqClass = OriginalRequest; }
});
