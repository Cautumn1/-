const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

function frontendClock(deviceOffset = 0) {
  let tick = 0;
  let wall = 1800000000000 + deviceOffset;
  const context = { exports: {}, Date: { now: () => wall } };
  const source = fs.readFileSync(path.join(__dirname, "../src/focus-clock.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return {
    ...context.exports,
    clock: context.exports.createFocusClock(() => tick),
    advance(ms) { tick += ms; },
    changeWall(ms) { wall += ms; },
  };
}

function backend() {
  let now = 1800000000000;
  const presence = { activeByMember: {} };
  const apiPath = path.join(__dirname, "../functions/study-checkin-api/index.js");
  const apiRequire = createRequire(apiPath);
  const db = {
    command: { set: (value) => value },
    collection: () => ({ doc: () => ({
      get: async () => ({ data: presence }),
      update: async (changes) => {
        for (const [key, value] of Object.entries(changes)) {
          if (key.startsWith("activeByMember.")) presence.activeByMember[key.split(".")[1]] = value;
        }
      },
    }) }),
  };
  class ServerDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    exports: {}, Date: ServerDate,
    require: (name) => name === "@cloudbase/node-sdk"
      ? { init: () => ({ database: () => db }) } : apiRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(apiPath, "utf8") +
    "\nexports.focusTest = { startFocus, setFocusPaused, activeElapsedSeconds, studyDurationSeconds };", context);
  return { ...context.exports.focusTest, advance(ms) { now += ms; }, now: () => now };
}

test("设备快慢20秒都立即计时，暂停/继续不倒退，普通计时与番茄钟一致", async () => {
  for (const offset of [-20000, 20000]) {
    for (const timerMode of ["stopwatch", "pomodoro"]) {
      for (const token of ["user1", "user2"]) {
        const api = backend();
        const client = frontendClock(offset);
        let result = await api.startFocus({ token, day: "2027-01-15", taskId: null,
          timerMode, focusMinutes: 20, breakMinutes: 10 });
        const id = result.session.id;
        client.clock.sync(result.serverNow);
        client.advance(1000); api.advance(1000);
        assert.equal(client.elapsedSeconds(result.session, client.clock.now()), 1);
        client.advance(24000); api.advance(24000);
        result = await api.setFocusPaused({ token, paused: true });
        client.clock.sync(result.serverNow);
        assert.equal(client.elapsedSeconds(result.session, client.clock.now()), 25);
        client.advance(30000); api.advance(30000);
        assert.equal(client.elapsedSeconds(result.session, client.clock.now()), 25);
        result = await api.setFocusPaused({ token, paused: false });
        client.clock.sync(result.serverNow);
        assert.equal(client.elapsedSeconds(result.session, client.clock.now()), 25);
        client.advance(4000); api.advance(4000);
        assert.equal(client.elapsedSeconds(result.session, client.clock.now()), 29);
        assert.equal(api.activeElapsedSeconds(result.session, api.now()), 29);
        assert.equal(api.studyDurationSeconds(result.session, api.now()), 29);
        assert.equal(result.session.id, id);
        // Repeated resume requests do not accumulate another pause.
        const repeated = await api.setFocusPaused({ token, paused: false });
        assert.equal(repeated.serverNow, api.now());
        assert.equal(repeated.session.pausedDurationMs, 30000);
      }
    }
  }
});

test("系统时间校准或改动不会冻结、跳回或加速本地计时", () => {
  const client = frontendClock();
  client.clock.sync(1800000000000);
  client.advance(1000);
  client.changeWall(-120000);
  assert.equal(client.clock.now(), 1800000001000);
  client.advance(1000);
  client.changeWall(3600000);
  assert.equal(client.clock.now(), 1800000002000);
  client.clock.sync(undefined); // Compatibility with an older mutation response.
  assert.equal(client.clock.now(), 1800000002000);
});

test("暂停/继续/结束前或进行中发出的旧刷新不能覆盖操作结果", () => {
  const guard = frontendClock().createFocusReadGuard();
  const before = guard.capture();
  assert.equal(guard.accepts(before), true);
  guard.begin();
  const during = guard.capture();
  assert.equal(guard.accepts(before), false);
  assert.equal(guard.accepts(during), false);
  guard.end();
  assert.equal(guard.accepts(before), false);
  assert.equal(guard.accepts(during), false);
  assert.equal(guard.accepts(guard.capture()), true);
});
