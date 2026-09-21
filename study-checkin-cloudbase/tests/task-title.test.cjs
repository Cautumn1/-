const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Exercise the actual read/edit sanitizers without connecting to CloudBase.
const apiPath = path.join(__dirname, "../functions/study-checkin-api/index.js");
const apiRequire = createRequire(apiPath);
const context = {
  exports: {},
  require(name) {
    if (name === "@cloudbase/node-sdk") {
      return { init: () => ({ database: () => ({ command: {} }) }) };
    }
    return apiRequire(name);
  },
};
vm.runInNewContext(fs.readFileSync(apiPath, "utf8") +
  "\nexports.titleHelpers = { cleanStoredTasks, cleanTaskInput };", context);
const { cleanStoredTasks, cleanTaskInput } = context.exports.titleHelpers;

test("50字导入任务读取、编辑再保存后保留完整标题和稳定ID", () => {
  const original = { id: "custom-imported", title: "学".repeat(50) };
  const loaded = cleanStoredTasks([original]);
  const saved = cleanTaskInput(loaded, loaded);
  const reloaded = cleanStoredTasks(saved);
  assert.equal(reloaded[0].title, original.title);
  assert.equal(reloaded[0].id, original.id);
});
