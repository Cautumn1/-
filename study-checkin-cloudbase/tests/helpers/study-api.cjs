const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Isolated in-memory CloudBase boundary; execute the real API handlers.
function createStudyApi(documents = {}, options = {}) {
  const store = structuredClone(documents);
  const writes = [];
  const range = (matches) => ({ matches, and: (other) => range((value) => matches(value) && other.matches(value)) });
  const command = {
    set: (value) => ({ operation: "set", value }),
    remove: () => ({ operation: "remove" }),
    gte: (min) => range((value) => value >= min),
    lte: (max) => range((value) => value <= max),
  };
  const db = { command, collection(name) {
    const table = store[name] ??= {};
    function query(filter) {
      let offset = 0;
      let limit = Infinity;
      return {
        orderBy() { return this; },
        skip(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async get() {
          return { data: structuredClone(Object.entries(table).map(([id, row]) => ({ _id: id, ...row })).filter((row) => Object.entries(filter).every(([key, value]) => (
            typeof value?.matches === "function" ? value.matches(row[key]) : row[key] === value
          ))).slice(offset, offset + limit)) };
        },
      };
    }
    return {
      where: query,
      doc(id) { return { _coll: name, id,
        async get() { return { data: table[id] ? [structuredClone(table[id])] : [] }; },
        async set(value) { table[id] = structuredClone(value); writes.push([name, id, "set"]); },
        async update(changes) {
          table[id] ??= {};
          for (const [key, change] of Object.entries(changes)) {
            const parts = key.split(".");
            const field = parts.pop();
            let target = table[id];
            for (const part of parts) target = target[part] ??= {};
            if (change?.operation === "remove") delete target[field];
            else target[field] = structuredClone(change?.operation === "set" ? change.value : change);
          }
          writes.push([name, id, "update"]);
        },
        async remove() { delete table[id]; writes.push([name, id, "remove"]); },
      }; },
    };
  } };
  db.startTransaction = async () => {
    options.beforeTransaction?.(store);
    const readSet = [];
    const pending = [];
    return {
      collection(name) { return { doc(id) { return {
        async get() {
          const value = structuredClone(store[name]?.[id] || null);
          readSet.push([name, id, value]);
          return { data: value };
        },
        async set(value) { pending.push([name, id, structuredClone(value)]); },
      }; } }; },
      async commit() {
        options.beforeCommit?.(store);
        for (const [name, id, original] of readSet) {
          if (JSON.stringify(store[name]?.[id] || null) !== JSON.stringify(original)) throw new Error("Transaction conflict");
        }
        for (const [name, id, value] of pending) {
          (store[name] ??= {})[id] = value;
          writes.push([name, id, "transaction"]);
        }
      },
      async rollback() {},
    };
  };
  const apiPath = path.join(__dirname, "../../functions/study-checkin-api/index.js");
  const apiRequire = createRequire(apiPath);
  const context = {
    exports: {}, console, process: { env: options.env || {} },
    require: (name) => name === "@cloudbase/node-sdk"
      ? { init: () => ({ database: () => db, auth: () => ({ getUserInfo: () => ({ uid: options.uid || "fixture-uid" }) }) }) } : apiRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(apiPath, "utf8") + "\nexports.tasksForTest = tasksFor;", context);
  return { store, writes, call: context.exports.main, tasksFor: context.exports.tasksForTest };
}

module.exports = { createStudyApi };
