const test = require("node:test");
const assert = require("node:assert/strict");
const {
  combineDailyTasks,
  courseIsActive,
  courseTasksForDay,
  filterActiveCourseTasks,
  fixedPlanDays,
  makeupTasksForDay,
  mergeUniqueTasks,
  tasksForScheduleDay,
} = require("../functions/study-checkin-api/course-plan");

test("自动课程和待补课程排在普通任务之前", () => {
  const combined = combineDailyTasks(
    [{ id: "ordinary", title: "计算机二级" }],
    [{ id: "scheduled", title: "英语单词｜第7单元 · 第1课", kind: "course" }],
    [{ id: "makeup", title: "英语单词｜第6单元 · 第4课", kind: "course" }],
  );
  assert.deepEqual(combined.map((task) => task.id), ["scheduled", "makeup", "ordinary"]);
});

test("课程停用后不再保留旧课程的待补资格", () => {
  const member = {
    courseSchedules: [unitSchedule({ endDay: "2026-09-03" })],
  };
  assert.equal(courseIsActive(member, "course-english", "2026-09-03"), true);
  assert.equal(courseIsActive(member, "course-english", "2026-09-04"), false);
});

test("课程停用后会清除单日快照和移入任务中的旧课程", () => {
  const member = {
    courseSchedules: [unitSchedule({ endDay: "2026-09-03" })],
  };
  const oldCourseTask = tasksForScheduleDay(member.courseSchedules[0], "2026-08-24")[0];
  const snapshot = [oldCourseTask, { id: "ordinary", title: "计算机二级" }];
  assert.deepEqual(
    filterActiveCourseTasks(member, "2026-09-04", snapshot).map((task) => task.id),
    ["ordinary"],
  );
  assert.deepEqual(
    filterActiveCourseTasks(member, "2026-09-03", snapshot).map((task) => task.id),
    [oldCourseTask.id, "ordinary"],
  );
});

function unitSchedule(overrides = {}) {
  return {
    id: "schedule-english",
    courseId: "course-english",
    name: "英语单词",
    structure: "unit",
    units: [{ unit: 6, lessons: 7 }, { unit: 7, lessons: 5 }],
    startIndex: 3,
    weeklyCounts: [1, 1, 1, 1, 1, 1, 2],
    startDay: "2026-08-24",
    autoContinue: true,
    ...overrides,
  };
}

test("按周一至周日课数连续排课并跨单元", () => {
  const schedule = unitSchedule();
  const days = fixedPlanDays("2026-08-24");
  assert.equal(days.length, 7);
  const titles = days.flatMap((day) => tasksForScheduleDay(schedule, day).map((task) => task.title));
  assert.deepEqual(titles, [
    "英语单词｜第6单元 · 第4课",
    "英语单词｜第6单元 · 第5课",
    "英语单词｜第6单元 · 第6课",
    "英语单词｜第6单元 · 第7课",
    "英语单词｜第7单元 · 第1课",
    "英语单词｜第7单元 · 第2课",
    "英语单词｜第7单元 · 第3课",
    "英语单词｜第7单元 · 第4课",
  ]);
});

test("整套顺延只改变课程偏移，7天窗口始终恰好7天", () => {
  const schedule = unitSchedule();
  const member = {
    courseSchedules: [schedule],
    courseActions: [{
      key: "2026-08-24|missed",
      mode: "shift",
      scheduleId: schedule.id,
      courseId: schedule.courseId,
      sourceDay: "2026-08-24",
      targetDay: "2026-08-25",
    }],
  };
  const days = fixedPlanDays("2026-08-25");
  assert.equal(days.length, 7);
  assert.equal(days[0], "2026-08-25");
  assert.equal(days[6], "2026-08-31");
  assert.equal(courseTasksForDay(member, "2026-08-25")[0].title, "英语单词｜第6单元 · 第4课");
  assert.equal(courseTasksForDay(member, "2026-08-31")[0].title, "英语单词｜第7单元 · 第4课");
  assert.equal(courseTasksForDay(member, "2026-09-01")[0].title, "英语单词｜第7单元 · 第5课");
});

test("仅移到今天不会挤动原计划，并按任务ID去重", () => {
  const schedule = unitSchedule();
  const missed = tasksForScheduleDay(schedule, "2026-08-24")[0];
  const member = {
    courseSchedules: [schedule],
    courseActions: [{
      key: `2026-08-24|${missed.id}`,
      mode: "move",
      sourceDay: "2026-08-24",
      targetDay: "2026-08-25",
      task: missed,
    }],
  };
  const scheduled = courseTasksForDay(member, "2026-08-25");
  const makeup = makeupTasksForDay(member, "2026-08-25");
  const combined = mergeUniqueTasks(scheduled, makeup);
  assert.equal(scheduled[0].title, "英语单词｜第6单元 · 第5课");
  assert.equal(makeup[0].title, "英语单词｜第6单元 · 第4课");
  assert.equal(combined.length, 2);
});

test("关闭自动续排后只在明确生成的日期出现", () => {
  const schedule = unitSchedule({ autoContinue: false });
  const member = {
    courseSchedules: [schedule],
    courseGeneratedDays: { "2026-08-24": [schedule.id] },
  };
  assert.equal(courseTasksForDay(member, "2026-08-24").length, 1);
  assert.equal(courseTasksForDay(member, "2026-08-25").length, 0);
});

test("跨月时固定7天窗口不多不少", () => {
  assert.deepEqual(fixedPlanDays("2026-08-29"), [
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
});
