const test = require("node:test");
const assert = require("node:assert/strict");
const { createStudyApi } = require("./helpers/study-api.cjs");
const { courseTasksForDay } = require("../functions/study-checkin-api/course-plan");

const DAY = "2026-10-17";
const NEXT_DAY = "2026-10-18";
const GROUP_ID = "study-checkin-fixed-pair";
const PRESENCE_ID = `focus-presence-${GROUP_ID}`;
const task = (id) => ({ id, title: id });

function fixture(userKey = "user1") {
  const id = userKey === "user1" ? "study-user-1" : "study-user-2";
  const schedule = { id: "schedule-test", courseId: "course-test", name: "英语", structure: "sequence",
    startIndex: 0, weeklyCounts: [1, 1, 1, 1, 1, 1, 1], startDay: "2026-10-16", autoContinue: true };
  const member = { id, userKey, name: userKey === "user1" ? "蔡" : "刘", groupId: GROUP_ID,
    taskTemplate: [task("done"), task("unfinished"), task("studied"), task("active")],
    taskOverrides: { [NEXT_DAY]: [task("tomorrow")] }, courseSchedules: [schedule] };
  const makeup = courseTasksForDay(member, "2026-10-16")[0];
  member.courseActions = [{ key: `2026-10-16|${makeup.id}`, mode: "move", sourceDay: "2026-10-16",
    targetDay: DAY, taskId: makeup.id, courseId: schedule.courseId, scheduleId: schedule.id, task: makeup },
  { key: "other-day", mode: "move", sourceDay: "2026-10-15", targetDay: NEXT_DAY,
    taskId: makeup.id, courseId: schedule.courseId, scheduleId: schedule.id, task: makeup }];
  const state = { id: `focus-state-${id}`, memberId: id, days: { [DAY]: {
    totalSeconds: 600, segments: [{ taskId: "studied", durationSeconds: 600 }],
  } } };
  const checkin = { id: "completed", groupId: GROUP_ID, memberId: id, day: DAY, taskId: "done" };
  const api = createStudyApi({ members: { [id]: member }, checkins: { completed: checkin }, sessions: {
    [state.id]: state,
    [PRESENCE_ID]: { activeByMember: { [id]: { id: "running", memberId: id, taskId: "active", day: DAY,
      startedAt: Date.now(), pausedAt: null, taskTitle: "active" } } },
  } });
  return { ...api, id, member: api.store.members[id] };
}

test("蔡/刘批量移除未完成任务后，刷新不再出现课程，保留完成/自习数据及其他日期", async () => {
  for (const userKey of ["user1", "user2"]) {
    const api = fixture(userKey);
    const before = structuredClone(api.store);
    const original = api.tasksFor(api.member, DAY);
    const kept = original.filter(({ id }) => ["done", "active"].includes(id));
    const removedIds = original.filter(({ id }) => !["done", "active"].includes(id)).map(({ id }) => id);
    const result = await api.call({ action: "saveTasks", token: userKey, day: DAY,
      tasks: kept, removeUnfinishedTaskIds: removedIds });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Array.from(api.tasksFor(api.member, DAY), (item) => item.id), ["done", "active"]);
    const restored = createStudyApi(api.store);
    assert.deepEqual(Array.from(restored.tasksFor(restored.store.members[api.id], DAY), (item) => item.id), ["done", "active"]);
    assert.equal(api.member.courseActions[0].removedFromPlan, true);
    assert.equal(api.member.courseActions[1].removedFromPlan, undefined);
    assert.deepEqual(api.member.taskOverrides[NEXT_DAY], before.members[api.id].taskOverrides[NEXT_DAY]);
    assert.deepEqual(api.member.taskTemplate, before.members[api.id].taskTemplate);
    assert.deepEqual(api.member.courseSchedules, before.members[api.id].courseSchedules);
    assert.deepEqual(api.store.checkins, before.checkins);
    assert.deepEqual(api.store.sessions[`focus-state-${api.id}`], before.sessions[`focus-state-${api.id}`]);
    assert.deepEqual(api.store.sessions[PRESENCE_ID].activeByMember, before.sessions[PRESENCE_ID].activeByMember);
    assert.ok(api.writes.every(([name, id]) => name === "members" || (name === "sessions" && id === PRESENCE_ID)));
  }
});

test("可以清空全部未完成任务，空数组不会恢复默认任务或自动课程", async () => {
  const api = fixture();
  api.store.checkins = {};
  api.store.sessions[PRESENCE_ID].activeByMember = {};
  const removedIds = api.tasksFor(api.member, DAY).map(({ id }) => id);
  const result = await api.call({ action: "saveTasks", token: "user1", day: DAY,
    tasks: [], removeUnfinishedTaskIds: removedIds });
  assert.equal(result.ok, true, result.error);
  assert.equal(api.tasksFor(api.member, DAY).length, 0);
  assert.equal(api.member.taskOverrides[DAY].length, 0);
  assert.equal(api.store.sessions[`focus-state-${api.id}`].days[DAY].totalSeconds, 600);
});

test("普通单项删除仍保护已有学习记录", async () => {
  const api = fixture();
  const tasks = api.tasksFor(api.member, DAY).filter(({ id }) => id !== "studied");
  const result = await api.call({ action: "saveTasks", token: "user1", day: DAY, tasks });
  assert.equal(result.ok, false);
  assert.match(result.error, /不能删除/);
  assert.equal(api.writes.length, 0);
});

test("批量删除以服务器完成状态为准，不能删掉编辑期间新打卡的任务", async () => {
  const api = fixture();
  api.store.checkins.justCompleted = { groupId: GROUP_ID, memberId: api.id, day: DAY, taskId: "unfinished" };
  const result = await api.call({ action: "saveTasks", token: "user1", day: DAY,
    tasks: api.tasksFor(api.member, DAY).filter(({ id }) => id !== "unfinished"),
    removeUnfinishedTaskIds: ["unfinished"] });
  assert.equal(result.ok, false);
  assert.match(result.error, /不能删除/);
  assert.equal(api.writes.length, 0);
});

test("批量删除仍保护进行中或暂停的自习任务", async () => {
  for (const pausedAt of [null, Date.now()]) {
    const api = fixture();
    api.store.sessions[PRESENCE_ID].activeByMember[api.id].pausedAt = pausedAt;
    const result = await api.call({ action: "saveTasks", token: "user1", day: DAY,
      tasks: api.tasksFor(api.member, DAY).filter(({ id }) => id !== "active"),
      removeUnfinishedTaskIds: ["active"] });
    assert.equal(result.ok, false);
    assert.equal(api.writes.length, 0);
  }
});
