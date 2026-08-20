const tcb = require("@cloudbase/node-sdk");
const crypto = require("node:crypto");

const app = tcb.init({ env: tcb.SYMBOL_DEFAULT_ENV });
const db = app.database();
const command = db.command;

const GROUP_ID = "study-checkin-fixed-pair";
const FOCUS_PRESENCE_ID = `focus-presence-${GROUP_ID}`;
const STUDY_DAY_START_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const MEMBER_DEFINITIONS = [
  { id: "study-user-1", userKey: "user1", name: "蔡", color: "#4f6bf6" },
  { id: "study-user-2", userKey: "user2", name: "刘", color: "#7c5cfc" },
];
const DEFAULT_TASKS = {
  user1: [
    { id: "words-1", title: "英语单词学习 · 第 1 次" },
    { id: "words-2", title: "英语单词学习 · 第 2 次" },
    { id: "review", title: "英语单词复习" },
    { id: "computer-2", title: "计算机二级" },
    { id: "civil-service", title: "考公课程" },
  ],
  user2: [],
};

class PublicError extends Error {}

function success(data) {
  return { ok: true, data };
}

function failure(error) {
  const message = error instanceof PublicError ? error.message : "服务暂时不可用，请稍后再试";
  if (!(error instanceof PublicError)) console.error(error);
  return { ok: false, error: message };
}

function first(result) {
  if (!result || !result.data) return null;
  return Array.isArray(result.data) ? result.data[0] ?? null : result.data;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

function dayInChina(date) {
  const studyDate = new Date(date.getTime() - STUDY_DAY_START_HOUR * HOUR_MS);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(studyDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOffset(day, offset) {
  const date = new Date(`${day}T12:00:00+08:00`);
  date.setDate(date.getDate() + offset);
  return dayInChina(date);
}

function cleanStoredTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 12).flatMap((task) => {
    const id = typeof task?.id === "string" ? task.id.trim() : "";
    const title = typeof task?.title === "string" ? task.title.trim().slice(0, 30) : "";
    return id && title ? [{ id, title }] : [];
  });
}

function cleanTaskInput(tasks) {
  if (!Array.isArray(tasks)) throw new PublicError("任务列表格式不正确");
  const seen = new Set();
  const cleaned = [];
  for (const raw of tasks.slice(0, 12)) {
    const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 30) : "";
    if (!title) continue;
    let id = typeof raw?.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(raw.id)
      ? raw.id
      : `custom-${crypto.randomBytes(6).toString("hex")}`;
    while (seen.has(id)) id = `custom-${crypto.randomBytes(6).toString("hex")}`;
    seen.add(id);
    cleaned.push({ id, title });
  }
  return cleaned;
}

function tasksFor(member, day) {
  if (member.taskOverrides && Object.prototype.hasOwnProperty.call(member.taskOverrides, day)) {
    return cleanStoredTasks(member.taskOverrides[day]);
  }
  const recurringSince = typeof member.recurringTasksSince === "string" ? member.recurringTasksSince : "";
  if (Array.isArray(member.recurringTasks) && (!recurringSince || day >= recurringSince)) {
    return cleanStoredTasks(member.recurringTasks);
  }
  return DEFAULT_TASKS[member.userKey] ?? [];
}

function focusStateId(memberId) {
  return `focus-state-${memberId}`;
}

function newSummaryRevision() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function publicFocusSession(session) {
  if (!session) return null;
  const timerMode = session.timerMode === "pomodoro" ? "pomodoro" : "stopwatch";
  const pausedAtValue = Number(session.pausedAt);
  const pausedAt = Number.isFinite(pausedAtValue) && pausedAtValue > 0 ? pausedAtValue : null;
  const pausedDurationMs = Math.max(0, Number(session.pausedDurationMs) || 0);
  const pomodoro = timerMode === "pomodoro" ? {
    focusMinutes: Math.max(1, Number(session.pomodoro?.focusMinutes) || 25),
    breakMinutes: Math.max(1, Number(session.pomodoro?.breakMinutes) || 5),
  } : null;
  return {
    id: session.id || session._id,
    memberId: session.memberId,
    day: session.day,
    taskId: session.taskId || null,
    taskTitle: session.taskTitle || "自由自习",
    startedAt: session.startedAt,
    timerMode,
    pomodoro,
    pausedAt,
    pausedDurationMs,
  };
}

function timerConfigFromEvent(event) {
  if (event.timerMode !== "pomodoro") return { timerMode: "stopwatch", pomodoro: null };
  const focusMinutes = Number(event.focusMinutes);
  const breakMinutes = Number(event.breakMinutes);
  if (!Number.isInteger(focusMinutes) || focusMinutes < 1 || focusMinutes > 180) {
    throw new PublicError("专注时长需设置为 1 到 180 分钟");
  }
  if (!Number.isInteger(breakMinutes) || breakMinutes < 1 || breakMinutes > 60) {
    throw new PublicError("休息时长需设置为 1 到 60 分钟");
  }
  return { timerMode: "pomodoro", pomodoro: { focusMinutes, breakMinutes } };
}

function totalPausedMilliseconds(session, endedAt) {
  const completedPause = Math.max(0, Number(session.pausedDurationMs) || 0);
  const currentPause = session.pausedAt
    ? Math.max(0, endedAt - Number(session.pausedAt))
    : 0;
  return completedPause + currentPause;
}

function activeElapsedSeconds(session, endedAt) {
  const wallMilliseconds = Math.max(0, endedAt - Number(session.startedAt));
  return Math.max(0, Math.floor((wallMilliseconds - totalPausedMilliseconds(session, endedAt)) / 1000));
}

function studyDurationSeconds(session, endedAt) {
  const activeSeconds = activeElapsedSeconds(session, endedAt);
  if (session.timerMode !== "pomodoro") return activeSeconds;
  const focusSeconds = Math.max(1, Number(session.pomodoro?.focusMinutes) || 25) * 60;
  const breakSeconds = Math.max(1, Number(session.pomodoro?.breakMinutes) || 5) * 60;
  const cycleSeconds = focusSeconds + breakSeconds;
  const fullCycles = Math.floor(activeSeconds / cycleSeconds);
  return fullCycles * focusSeconds + Math.min(activeSeconds % cycleSeconds, focusSeconds);
}

async function loadFocusState(member, day) {
  const collection = db.collection("sessions");
  const id = focusStateId(member.id);
  const existing = first(await collection.doc(id).get());
  if (existing) {
    const { _id, ...state } = existing;
    return state;
  }

  // One-time compatibility migration from the first self-study release.
  const [legacyActiveRow, legacyDailyRow] = await Promise.all([
    collection.doc(`focus-active-${member.id}`).get(),
    collection.doc(`focus-day-${member.id}-${day}`).get(),
  ]);
  const legacyActive = first(legacyActiveRow);
  const legacyDaily = first(legacyDailyRow);
  const state = {
    id,
    kind: "focus-state",
    groupId: GROUP_ID,
    memberId: member.id,
    active: publicFocusSession(legacyActive),
    days: legacyDaily ? { [day]: {
      totalSeconds: Math.max(0, Number(legacyDaily.totalSeconds) || 0),
      segments: Array.isArray(legacyDaily.segments) ? legacyDaily.segments : [],
    } } : {},
    updatedAt: Date.now(),
  };
  await collection.doc(id).set(state);
  return state;
}

async function loadFocusPresence(members, day, knownStates = null) {
  const collection = db.collection("sessions");
  const existing = first(await collection.doc(FOCUS_PRESENCE_ID).get());
  if (existing) {
    const { _id, ...presence } = existing;
    return presence;
  }

  const states = knownStates || await Promise.all(members.map((member) => loadFocusState(member, day)));
  const activeByMember = {};
  members.forEach((member, index) => {
    activeByMember[member.id] = publicFocusSession(states[index]?.active || null);
  });
  const presence = {
    id: FOCUS_PRESENCE_ID,
    kind: "focus-presence",
    groupId: GROUP_ID,
    activeByMember,
    summaryRevision: newSummaryRevision(),
    updatedAt: Date.now(),
  };
  await collection.doc(FOCUS_PRESENCE_ID).set(presence);
  return presence;
}

async function updateFocusPresence(memberId, session, summaryChanged = false) {
  const summaryRevision = summaryChanged ? newSummaryRevision() : null;
  const changes = {
    [`activeByMember.${memberId}`]: command.set(publicFocusSession(session)),
    updatedAt: Date.now(),
  };
  if (summaryRevision) changes.summaryRevision = summaryRevision;
  await db.collection("sessions").doc(FOCUS_PRESENCE_ID).update(changes);
  return summaryRevision;
}

async function markFocusSummaryChanged() {
  const summaryRevision = newSummaryRevision();
  await db.collection("sessions").doc(FOCUS_PRESENCE_ID).update({
    summaryRevision,
    updatedAt: Date.now(),
  });
  return summaryRevision;
}

async function readFocusSummary(members, day) {
  const states = await Promise.all(members.map((member) => loadFocusState(member, day)));
  const presence = await loadFocusPresence(members, day, states);
  const activeByMember = {};
  const todaySecondsByMember = {};
  const todayTaskSecondsByMember = {};

  members.forEach((member, index) => {
    const state = states[index];
    const active = publicFocusSession(presence.activeByMember?.[member.id] || null);
    const daily = state.days?.[day] || null;
    const segments = Array.isArray(daily?.segments) ? daily.segments : [];
    const taskSeconds = {};
    for (const segment of segments) {
      const key = segment.taskId || "free";
      taskSeconds[key] = (taskSeconds[key] || 0) + Math.max(0, Number(segment.durationSeconds) || 0);
    }
    activeByMember[member.id] = active;
    todaySecondsByMember[member.id] = Math.max(0, Number(daily?.totalSeconds) || 0);
    todayTaskSecondsByMember[member.id] = taskSeconds;
  });

  return {
    serverNow: Date.now(),
    summaryRevision: typeof presence.summaryRevision === "string" ? presence.summaryRevision : "",
    activeByMember,
    todaySecondsByMember,
    todayTaskSecondsByMember,
  };
}

async function ensureFixedSpace() {
  const groupCollection = db.collection("groups");
  const memberCollection = db.collection("members");
  let group = first(await groupCollection.doc(GROUP_ID).get());
  if (!group) {
    const createdAt = Date.now();
    await groupCollection.doc(GROUP_ID).set({
      id: GROUP_ID,
      mode: "fixed-pair",
      createdAt,
    });
    group = { id: GROUP_ID, mode: "fixed-pair", createdAt };
  }

  const members = [];
  for (const definition of MEMBER_DEFINITIONS) {
    let member = first(await memberCollection.doc(definition.id).get());
    if (!member) {
      member = {
        ...definition,
        groupId: GROUP_ID,
        createdAt: Date.now(),
        taskOverrides: {},
      };
      await memberCollection.doc(definition.id).set(member);
    } else if (member.name !== definition.name || member.color !== definition.color) {
      await memberCollection.doc(definition.id).update({
        name: definition.name,
        color: definition.color,
        updatedAt: Date.now(),
      });
      member = { ...member, name: definition.name, color: definition.color };
    }
    members.push(member);
  }
  return { group, members };
}

async function selectUser(event) {
  if (!MEMBER_DEFINITIONS.some((member) => member.userKey === event.userKey)) {
    throw new PublicError("请选择蔡或刘");
  }
  await ensureFixedSpace();
  return { token: event.userKey };
}

function requireIdentity(token) {
  const definition = MEMBER_DEFINITIONS.find((member) => member.userKey === token);
  if (!definition) throw new PublicError("请先选择用户身份");
  return definition;
}

async function readCurrentMember(token) {
  const definition = requireIdentity(token);
  const member = first(await db.collection("members").doc(definition.id).get());
  return member || { ...definition, groupId: GROUP_ID, taskOverrides: {} };
}

async function requireSession(token) {
  const definition = requireIdentity(token);
  const collection = db.collection("members");
  const rows = await Promise.all(MEMBER_DEFINITIONS.map((item) => collection.doc(item.id).get()));
  const members = MEMBER_DEFINITIONS.map((item, index) => (
    first(rows[index]) || { ...item, groupId: GROUP_ID, taskOverrides: {} }
  ));
  const member = members.find((item) => item.userKey === token);
  if (!member) throw new PublicError("没有找到当前用户");
  return { member: { ...member, ...definition }, group: { id: GROUP_ID }, members };
}

async function readCheckins(groupId, from, to = null) {
  const rows = [];
  let offset = 0;
  const dayRange = to ? command.gte(from).and(command.lte(to)) : command.gte(from);
  while (true) {
    const result = await db.collection("checkins")
      .where({ groupId, day: dayRange })
      .orderBy("day", "desc")
      .skip(offset)
      .limit(100)
      .get();
    const batch = result.data || [];
    rows.push(...batch);
    if (batch.length < 100) break;
    offset += batch.length;
  }
  return rows;
}

async function getData(event) {
  if (!validDay(event.day)) throw new PublicError("日期格式错误");
  const current = await requireSession(event.token);
  const [rows, focus] = await Promise.all([
    readCheckins(current.group.id, event.day, event.day),
    readFocusSummary(current.members, event.day),
  ]);
  const completedByDay = {};

  for (const row of rows) {
    const key = `${row.memberId}:${row.day}`;
    if (!completedByDay[key]) completedByDay[key] = [];
    completedByDay[key].push(row.taskId || row.task);
  }

  const members = current.members
    .sort((a, b) => String(a.userKey).localeCompare(String(b.userKey)))
    .map(({ id, userKey, name, color }) => ({ id, userKey, name, color }));
  const tasksByMember = {};
  for (const member of current.members) {
    const completed = new Set(completedByDay[`${member.id}:${event.day}`] || []);
    tasksByMember[member.id] = tasksFor(member, event.day).map((task) => ({
      ...task,
      completed: completed.has(task.id),
    }));
  }

  return {
    me: members.find((member) => member.id === current.member.id),
    members,
    tasksByMember,
    repeatDaily: Array.isArray(current.member.recurringTasks),
    focus,
  };
}

async function getStudyHistory(event) {
  if (!validDay(event.fromDay) || !validDay(event.toDay) || event.toDay < event.fromDay) {
    throw new PublicError("历史日期范围不正确");
  }
  if (typeof event.month !== "string" || !/^\d{4}-\d{2}$/.test(event.month)) {
    throw new PublicError("月份格式不正确");
  }

  const requestedDays = [];
  let day = event.fromDay;
  while (day <= event.toDay && requestedDays.length <= 42) {
    requestedDays.push(day);
    day = dateOffset(day, 1);
  }
  if (requestedDays.length !== 42 || requestedDays[requestedDays.length - 1] !== event.toDay) {
    throw new PublicError("历史日期范围过大");
  }

  const current = await requireSession(event.token);
  const [rows, state] = await Promise.all([
    readCheckins(current.group.id, event.fromDay, event.toDay),
    loadFocusState(current.member, event.toDay),
  ]);
  const completedByDay = {};
  for (const row of rows) {
    if (row.memberId !== current.member.id) continue;
    if (!completedByDay[row.day]) completedByDay[row.day] = [];
    completedByDay[row.day].push(row.taskId || row.task);
  }

  const storedHistory = state.history && typeof state.history === "object" ? state.history : {};
  const resultDays = {};
  let totalSeconds = 0;
  let studyDays = 0;
  let completedDays = 0;
  for (const requestedDay of requestedDays) {
    const tasks = tasksFor(current.member, requestedDay);
    const completedIds = new Set(completedByDay[requestedDay] || []);
    const completed = tasks.filter((task) => completedIds.has(task.id)).length;
    const seconds = Math.max(0, Number(storedHistory[requestedDay] ?? state.days?.[requestedDay]?.totalSeconds) || 0);
    const allDone = tasks.length > 0 && completed === tasks.length;
    resultDays[requestedDay] = { totalSeconds: seconds, completed, total: tasks.length, allDone };
    if (requestedDay.startsWith(event.month)) {
      totalSeconds += seconds;
      if (seconds > 0) studyDays += 1;
      if (allDone) completedDays += 1;
    }
  }

  return { days: resultDays, totalSeconds, studyDays, completedDays };
}

async function getFocusStatus(event) {
  if (!validDay(event.day)) throw new PublicError("日期格式错误");
  requireIdentity(event.token);
  const presence = await loadFocusPresence(MEMBER_DEFINITIONS, event.day);
  const activeByMember = {};
  for (const member of MEMBER_DEFINITIONS) {
    activeByMember[member.id] = publicFocusSession(presence.activeByMember?.[member.id] || null);
  }
  return {
    serverNow: Date.now(),
    summaryRevision: typeof presence.summaryRevision === "string" ? presence.summaryRevision : "",
    activeByMember,
  };
}

async function startFocus(event) {
  if (!validDay(event.day)) throw new PublicError("日期格式错误");
  const definition = requireIdentity(event.token);
  const member = event.taskId ? await readCurrentMember(event.token) : definition;
  const presence = await loadFocusPresence(MEMBER_DEFINITIONS, event.day);
  if (presence.activeByMember?.[definition.id]) throw new PublicError("你已经在自习中了");

  let taskId = null;
  let taskTitle = "自由自习";
  if (event.taskId !== null && event.taskId !== undefined && event.taskId !== "") {
    if (typeof event.taskId !== "string") throw new PublicError("无效的自习任务");
    const task = tasksFor(member, event.day).find((item) => item.id === event.taskId);
    if (!task) throw new PublicError("这个任务已不存在，请刷新后重试");
    taskId = task.id;
    taskTitle = task.title;
  }

  const timer = timerConfigFromEvent(event);
  const session = {
    id: `focus-active-${definition.id}`,
    kind: "focus-active",
    groupId: GROUP_ID,
    memberId: definition.id,
    day: event.day,
    taskId,
    taskTitle,
    startedAt: Date.now(),
    timerMode: timer.timerMode,
    pomodoro: timer.pomodoro,
    pausedAt: null,
    pausedDurationMs: 0,
  };
  await updateFocusPresence(definition.id, session);
  return { session: publicFocusSession(session) };
}

async function setFocusPaused(event) {
  if (typeof event.paused !== "boolean") throw new PublicError("暂停状态不正确");
  const definition = requireIdentity(event.token);
  const presence = await loadFocusPresence(MEMBER_DEFINITIONS, dayInChina(new Date()));
  const active = publicFocusSession(presence.activeByMember?.[definition.id] || null);
  if (!active) throw new PublicError("当前没有进行中的自习");

  const alreadyPaused = Boolean(active.pausedAt);
  if (alreadyPaused === event.paused) return { session: active };

  const changedAt = Date.now();
  const session = {
    ...active,
    pausedAt: event.paused ? changedAt : null,
    pausedDurationMs: event.paused
      ? active.pausedDurationMs
      : active.pausedDurationMs + Math.max(0, changedAt - Number(active.pausedAt)),
  };
  await updateFocusPresence(definition.id, session);
  return { session: publicFocusSession(session) };
}

async function stopFocus(event) {
  const definition = requireIdentity(event.token);
  const collection = db.collection("sessions");
  const presence = await loadFocusPresence(MEMBER_DEFINITIONS, dayInChina(new Date()));
  const active = publicFocusSession(presence.activeByMember?.[definition.id] || null);
  if (!active) throw new PublicError("当前没有进行中的自习");
  const state = await loadFocusState(definition, dayInChina(new Date()));

  const endedAt = Date.now();
  const wallDurationSeconds = Math.max(0, Math.floor((endedAt - Number(active.startedAt)) / 1000));
  const pausedDurationSeconds = Math.floor(totalPausedMilliseconds(active, endedAt) / 1000);
  const durationSeconds = studyDurationSeconds(active, endedAt);
  const sessionId = `focus-${hash(`${definition.id}|${active.startedAt}`).slice(0, 34)}`;
  const completed = {
    id: sessionId,
    kind: "focus-session",
    status: "completed",
    groupId: GROUP_ID,
    memberId: definition.id,
    day: active.day,
    taskId: active.taskId || null,
    taskTitle: active.taskTitle || "自由自习",
    startedAt: Number(active.startedAt),
    endedAt,
    durationSeconds,
    wallDurationSeconds,
    pausedDurationSeconds,
    timerMode: active.timerMode,
    pomodoro: active.pomodoro,
  };

  await collection.doc(sessionId).set(completed);
  const daily = state.days?.[active.day] || null;
  const segments = Array.isArray(daily?.segments) ? daily.segments : [];
  const alreadyRecorded = segments.some((segment) => segment.id === sessionId);
  const nextSegments = alreadyRecorded ? segments : [...segments, {
    id: sessionId,
    taskId: completed.taskId,
    taskTitle: completed.taskTitle,
    startedAt: completed.startedAt,
    endedAt,
    durationSeconds,
    wallDurationSeconds,
    pausedDurationSeconds,
    timerMode: completed.timerMode,
    pomodoro: completed.pomodoro,
  }];
  const days = { ...(state.days || {}), [active.day]: {
    totalSeconds: nextSegments.reduce((sum, segment) => sum + Math.max(0, Number(segment.durationSeconds) || 0), 0),
    segments: nextSegments,
  } };
  const history = { ...(state.history || {}) };
  for (const [historyDay, value] of Object.entries(state.days || {})) {
    if (!Object.prototype.hasOwnProperty.call(history, historyDay)) {
      history[historyDay] = Math.max(0, Number(value?.totalSeconds) || 0);
    }
  }
  history[active.day] = days[active.day].totalSeconds;
  for (const oldDay of Object.keys(history).sort().reverse().slice(730)) delete history[oldDay];
  for (const oldDay of Object.keys(days).sort().reverse().slice(60)) delete days[oldDay];
  await collection.doc(focusStateId(definition.id)).set({
    ...state,
    active: null,
    days,
    history,
    updatedAt: endedAt,
  });
  const summaryRevision = await updateFocusPresence(definition.id, null, true);

  return {
    sessionId,
    day: active.day,
    taskId: completed.taskId,
    taskTitle: completed.taskTitle,
    durationSeconds,
    wallDurationSeconds,
    pausedDurationSeconds,
    timerMode: completed.timerMode,
    summaryRevision,
  };
}

async function toggleCheckin(event) {
  if (!validDay(event.day) || typeof event.taskId !== "string") {
    throw new PublicError("无效的打卡任务");
  }
  const member = await readCurrentMember(event.token);
  const task = tasksFor(member, event.day).find((item) => item.id === event.taskId);
  if (!task) throw new PublicError("这个任务已不存在，请刷新后重试");

  const id = hash(`${member.id}|${event.day}|${task.id}`).slice(0, 40);
  const collection = db.collection("checkins");
  const existing = first(await collection.doc(id).get());
  if (existing) {
    await collection.doc(id).remove();
    await markFocusSummaryChanged();
    return { completed: false };
  }

  await collection.doc(id).set({
    id,
    groupId: GROUP_ID,
    memberId: member.id,
    day: event.day,
    taskId: task.id,
    task: task.title,
    completedAt: Date.now(),
  });
  await markFocusSummaryChanged();
  return { completed: true };
}

async function saveTasks(event) {
  if (!validDay(event.day)) throw new PublicError("日期格式错误");
  const member = await readCurrentMember(event.token);
  const tasks = cleanTaskInput(event.tasks);
  const repeatProvided = typeof event.repeatDaily === "boolean";
  const repeatDaily = event.repeatDaily === true;
  const overrides = { ...(member.taskOverrides || {}) };
  if (repeatProvided && repeatDaily) {
    for (const day of Object.keys(overrides)) {
      if (day >= event.day) delete overrides[day];
    }
  } else {
    overrides[event.day] = tasks;
  }
  const days = Object.keys(overrides).sort().reverse();
  for (const oldDay of days.slice(60)) delete overrides[oldDay];

  const update = {
    taskOverrides: overrides,
    updatedAt: Date.now(),
  };
  if (repeatProvided) {
    update.recurringTasks = repeatDaily ? tasks : command.remove();
    update.recurringTasksSince = repeatDaily ? event.day : command.remove();
  }
  await db.collection("members").doc(member.id).update(update);

  const rows = await db.collection("checkins")
    .where({ groupId: GROUP_ID, day: event.day })
    .limit(100)
    .get();
  const validIds = new Set(tasks.map((task) => task.id));
  await Promise.all((rows.data || [])
    .filter((row) => row.memberId === member.id && !validIds.has(row.taskId || row.task))
    .map((row) => db.collection("checkins").doc(row._id || row.id).remove()));
  await markFocusSummaryChanged();
  return { tasks, repeatDaily: repeatProvided ? repeatDaily : Array.isArray(member.recurringTasks) };
}

async function resetTasks(event) {
  if (!validDay(event.day)) throw new PublicError("日期格式错误");
  const member = await readCurrentMember(event.token);
  await db.collection("members").doc(member.id).update({
    [`taskOverrides.${event.day}`]: command.remove(),
    recurringTasks: command.remove(),
    recurringTasksSince: command.remove(),
    updatedAt: Date.now(),
  });

  const rows = await db.collection("checkins")
    .where({ groupId: GROUP_ID, day: event.day })
    .limit(100)
    .get();
  await Promise.all((rows.data || []).filter((row) => row.memberId === member.id).map((row) => (
    db.collection("checkins").doc(row._id || row.id).remove()
  )));
  await markFocusSummaryChanged();
  return { reset: true };
}

exports.main = async (event) => {
  try {
    switch (event.action) {
      case "selectUser":
        return success(await selectUser(event));
      case "getData":
        return success(await getData(event));
      case "getStudyHistory":
        return success(await getStudyHistory(event));
      case "getFocusStatus":
        return success(await getFocusStatus(event));
      case "toggleCheckin":
        return success(await toggleCheckin(event));
      case "saveTasks":
        return success(await saveTasks(event));
      case "resetTasks":
        return success(await resetTasks(event));
      case "startFocus":
        return success(await startFocus(event));
      case "setFocusPaused":
        return success(await setFocusPaused(event));
      case "stopFocus":
        return success(await stopFocus(event));
      default:
        throw new PublicError("未知操作");
    }
  } catch (error) {
    return failure(error);
  }
};
