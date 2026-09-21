const { weekdayIndex } = require("./course-plan");

const MAX_IMPORT_TEXT_LENGTH = 5000;
const MAX_IMPORT_LINES = 100;
const WEEKDAY_INDEX = {
  一: 0,
  二: 1,
  三: 2,
  四: 3,
  五: 4,
  六: 5,
  日: 6,
  天: 6,
};

function paddedDay(year, month, day) {
  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
  ) return "";
  return candidate;
}

function taskTitle(value, lineNumber) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) throw new Error(`第${lineNumber}行缺少任务内容`);
  if (title.length > 50) throw new Error(`第${lineNumber}行任务超过50个字`);
  return title;
}

function normalizedTaskTitle(title) {
  return String(title || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function mergeImportedTasks(currentTasks, importedItems, createId, maxTasks = 20) {
  const nextTasks = Array.isArray(currentTasks) ? [...currentTasks] : [];
  const existingTitles = new Set(nextTasks.map((task) => normalizedTaskTitle(task?.title)));
  let imported = 0;
  let skippedDuplicates = 0;
  for (const item of Array.isArray(importedItems) ? importedItems : []) {
    const titleKey = normalizedTaskTitle(item?.title);
    if (!titleKey || existingTitles.has(titleKey)) {
      skippedDuplicates += 1;
      continue;
    }
    if (nextTasks.length >= maxTasks) throw new Error(`导入后会超过 ${maxTasks} 项任务`);
    nextTasks.push({ id: createId(), title: item.title });
    existingTitles.add(titleKey);
    imported += 1;
  }
  return { tasks: nextTasks, imported, skippedDuplicates };
}

function parseTaskImportText(text, planDays) {
  if (typeof text !== "string" || !text.trim()) throw new Error("请先输入要导入的任务");
  if (text.length > MAX_IMPORT_TEXT_LENGTH) throw new Error("导入内容过长，请分批导入");
  if (!Array.isArray(planDays) || planDays.length !== 7) throw new Error("当前7天计划不可用，请刷新后重试");

  const validDays = new Set(planDays);
  const lines = text.split(/\r?\n/)
    .map((value, index) => ({ value: value.trim(), lineNumber: index + 1 }))
    .filter((line) => line.value);
  if (!lines.length) throw new Error("请先输入要导入的任务");
  if (lines.length > MAX_IMPORT_LINES) throw new Error(`一次最多导入${MAX_IMPORT_LINES}行任务`);

  return lines.map(({ value, lineNumber }) => {
    let day = "";
    let title = "";
    let match = value.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:日)?(?:\s+|[：:]\s*)(.+)$/);
    if (match) {
      day = paddedDay(match[1], match[2], match[3]);
      title = taskTitle(match[4], lineNumber);
    } else {
      match = value.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:日)?(?:\s+|[：:]\s*)(.+)$/);
      if (match) {
        const suffix = `-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
        day = planDays.find((candidate) => candidate.endsWith(suffix)) || "";
        title = taskTitle(match[3], lineNumber);
      } else {
        match = value.match(/^(\d{1,2})月(\d{1,2})日?(?:\s+|[：:]\s*)(.+)$/);
        if (match) {
          const suffix = `-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
          day = planDays.find((candidate) => candidate.endsWith(suffix)) || "";
          title = taskTitle(match[3], lineNumber);
        } else {
          match = value.match(/^(?:星期|周|礼拜)([一二三四五六日天])(?:\s+|[：:]\s*)(.+)$/);
          if (match) {
            const targetWeekday = WEEKDAY_INDEX[match[1]];
            day = planDays.find((candidate) => weekdayIndex(candidate) === targetWeekday) || "";
            title = taskTitle(match[2], lineNumber);
          }
        }
      }
    }

    if (!title) throw new Error(`第${lineNumber}行格式无法识别，请以日期或星期开头`);
    if (!day || !validDays.has(day)) throw new Error(`第${lineNumber}行日期不在当前7天计划内`);
    return { day, title, lineNumber };
  });
}

module.exports = {
  MAX_IMPORT_LINES,
  MAX_IMPORT_TEXT_LENGTH,
  mergeImportedTasks,
  normalizedTaskTitle,
  parseTaskImportText,
};
