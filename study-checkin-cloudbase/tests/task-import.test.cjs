const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeImportedTasks, parseTaskImportText } = require("../functions/study-checkin-api/task-import");

const PLAN_DAYS = [
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
  "2026-09-19",
  "2026-09-20",
  "2026-09-21",
  "2026-09-22",
];

test("可按月日批量导入同一天和不同天的任务", () => {
  const result = parseTaskImportText([
    "9/16 某某任务",
    "9/16 某某某任务",
    "9月17日：xx任务",
  ].join("\n"), PLAN_DAYS);
  assert.deepEqual(result.map(({ day, title }) => ({ day, title })), [
    { day: "2026-09-16", title: "某某任务" },
    { day: "2026-09-16", title: "某某某任务" },
    { day: "2026-09-17", title: "xx任务" },
  ]);
});

test("星期和周写法会匹配当前7天内唯一的日期", () => {
  const result = parseTaskImportText([
    "星期一 背单词",
    "周二：刷题",
    "礼拜天 复盘",
  ].join("\n"), PLAN_DAYS);
  assert.deepEqual(result.map(({ day, title }) => ({ day, title })), [
    { day: "2026-09-21", title: "背单词" },
    { day: "2026-09-22", title: "刷题" },
    { day: "2026-09-20", title: "复盘" },
  ]);
});

test("支持完整年月日和跨年7天窗口", () => {
  const days = [
    "2026-12-29",
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
    "2027-01-04",
  ];
  const result = parseTaskImportText("2027/1/1 新年计划\n1/4 周总结", days);
  assert.deepEqual(result.map(({ day }) => day), ["2027-01-01", "2027-01-04"]);
});

test("拒绝当前7天以外的日期", () => {
  assert.throws(
    () => parseTaskImportText("9/23 超出窗口", PLAN_DAYS),
    /第1行日期不在当前7天计划内/,
  );
});

test("格式错误时指出具体行", () => {
  assert.throws(
    () => parseTaskImportText("9/16 正常任务\n没有日期的任务", PLAN_DAYS),
    /第2行格式无法识别/,
  );
});

test("追加时保留原任务ID并跳过同日同名任务", () => {
  let nextId = 1;
  const result = mergeImportedTasks(
    [{ id: "stable-existing", title: "背单词" }],
    [{ title: "背单词" }, { title: "刷题" }, { title: "  刷题  " }],
    () => `custom-${nextId++}`,
  );
  assert.deepEqual(result.tasks, [
    { id: "stable-existing", title: "背单词" },
    { id: "custom-1", title: "刷题" },
  ]);
  assert.equal(result.imported, 1);
  assert.equal(result.skippedDuplicates, 2);
});

test("任务内容允许31至50字，日期和星期不计入字数", () => {
  for (const prefix of ["9/16", "2026/9/16", "星期一"]) {
    for (const length of [31, 50]) {
      const title = "学".repeat(length);
      const items = parseTaskImportText(`${prefix} ${title}`, PLAN_DAYS);
      const result = mergeImportedTasks([], items, () => "custom-long");
      assert.equal(result.tasks[0].title, title);
    }
  }
});

test("任务内容超过50字时指出行号和新上限", () => {
  assert.throws(
    () => parseTaskImportText(`9/16 正常任务\n星期一 ${"学".repeat(51)}`, PLAN_DAYS),
    /第2行任务超过50个字/,
  );
});

test("某天超过上限时不改动原任务数组", () => {
  const existing = Array.from({ length: 20 }, (_, index) => ({ id: `task-${index}`, title: `任务${index}` }));
  assert.throws(
    () => mergeImportedTasks(existing, [{ title: "第21项" }], () => "custom-new"),
    /超过 20 项任务/,
  );
  assert.equal(existing.length, 20);
});
