const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = Object.freeze({
  totalDays: 20,
  hoursPerDay: 8,
  deadline: "",
  deductLunchBreak: false,
  lunchStart: "12:00",
  lunchEnd: "13:00",
  workStart: "09:00",
  workEnd: "17:00"
});

const DB_NAME = "nenkyu_manager";
const DB_STORE = "handles";
const DB_KEY = "lastFile";
const FILE_TYPE_OPTIONS = [
  {
    description: "JSON",
    accept: { "application/json": [".json"] }
  }
];
const DATA_VERSION = 2;

const app = {
  state: createDefaultState(),
  fileHandle: null,
  persistQueue: Promise.resolve()
};

let quickPatterns = [];

function createDefaultState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    records: []
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function toMinutes(hhmm) {
  if (!hhmm || !hhmm.includes(":")) return null;
  const [hour, minute] = hhmm.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function minutesToHHMM(minutes) {
  const total = Math.round(minutes);
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatHours(hours) {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatDate(dateString) {
  if (!dateString) return "-";
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).format(date);
}

function getTotalHours() {
  return app.state.settings.totalDays * app.state.settings.hoursPerDay;
}

function calcPartialHours(startTime, endTime) {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null || end <= start) return 0;

  let diff = end - start;
  if (app.state.settings.deductLunchBreak) {
    const lunchStart = toMinutes(app.state.settings.lunchStart);
    const lunchEnd = toMinutes(app.state.settings.lunchEnd);
    if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart) {
      const overlap = Math.max(0, Math.min(end, lunchEnd) - Math.max(start, lunchStart));
      diff -= overlap;
    }
  }

  return Math.max(diff, 0) / 60;
}

function calcRecordHours(record) {
  if (record.type === "full") return app.state.settings.hoursPerDay;
  return calcPartialHours(record.startTime, record.endTime);
}

function getRecordPeriod(record) {
  if (record.type !== "partial") return null;
  if (record.period === "am" || record.period === "pm") return record.period;

  const settings = app.state.settings;
  if (record.startTime === settings.workStart && record.endTime === settings.lunchStart) return "am";
  if (record.startTime === settings.lunchEnd && record.endTime === settings.workEnd) return "pm";
  return null;
}

function getRecordTypeLabel(record) {
  if (record.type === "full") return "全休";
  const period = getRecordPeriod(record);
  if (period === "am") return "午前休";
  if (period === "pm") return "午後休";
  return "時間休";
}

function inferRangeMode(record) {
  if (record.type !== "partial" || getRecordPeriod(record)) return "start";
  if (record.startTime === app.state.settings.workStart) return "start";
  if (record.endTime === app.state.settings.workEnd) return "end";
  return "custom";
}

function getAcquiredHours() {
  return app.state.records.reduce((total, record) => total + calcRecordHours(record), 0);
}

function getRemainingInfo() {
  const acquired = getAcquiredHours();
  const total = getTotalHours();
  const remaining = total - acquired;
  const hoursPerDay = app.state.settings.hoursPerDay;
  const remainingDays = hoursPerDay > 0 ? remaining / hoursPerDay : null;
  const usageRate = total > 0 ? Math.min(acquired / total, 1) : 0;

  return {
    acquired,
    total,
    remaining,
    remainingDays,
    usageRate
  };
}

function createPayload() {
  return JSON.stringify({
    version: DATA_VERSION,
    settings: app.state.settings,
    entries: app.state.records
  }, null, 2);
}

function normalizeSettings(rawSettings = {}) {
  const safeHoursPerDay = Number(rawSettings.hoursPerDay ?? DEFAULT_SETTINGS.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay;
  let totalDays = Number(rawSettings.totalDays ?? DEFAULT_SETTINGS.totalDays);

  if (rawSettings.totalDays === undefined && rawSettings.totalHours !== undefined) {
    totalDays = Number(rawSettings.totalHours) / safeHoursPerDay;
  }

  const deductLunchBreak = Boolean(rawSettings.deductLunchBreak ?? DEFAULT_SETTINGS.deductLunchBreak);
  const lunchStart = rawSettings.lunchStart ?? DEFAULT_SETTINGS.lunchStart;
  const lunchEnd = rawSettings.lunchEnd ?? DEFAULT_SETTINGS.lunchEnd;
  const workStart = rawSettings.workStart || DEFAULT_SETTINGS.workStart;

  let workEnd = rawSettings.workEnd;
  if (!workEnd) {
    // 旧データには始業・終業がないため、1日の労働時間と昼休憩から終業時刻を補完する
    const startMinutes = toMinutes(workStart) ?? toMinutes(DEFAULT_SETTINGS.workStart);
    const lunchMinutes = deductLunchBreak
      ? Math.max(0, (toMinutes(lunchEnd) ?? 0) - (toMinutes(lunchStart) ?? 0))
      : 0;
    const endMinutes = startMinutes + safeHoursPerDay * 60 + lunchMinutes;
    workEnd = endMinutes > 0 && endMinutes < 1440 ? minutesToHHMM(endMinutes) : DEFAULT_SETTINGS.workEnd;
  }

  return {
    totalDays: Number.isFinite(totalDays) ? totalDays : DEFAULT_SETTINGS.totalDays,
    hoursPerDay: safeHoursPerDay,
    deadline: rawSettings.deadline ?? DEFAULT_SETTINGS.deadline,
    deductLunchBreak,
    lunchStart,
    lunchEnd,
    workStart,
    workEnd
  };
}

function normalizeRecord(record) {
  const type = record.type === "partial" ? "partial" : "full";
  const period = type === "partial" && (record.period === "am" || record.period === "pm")
    ? record.period
    : null;

  return {
    id: record.id ?? crypto.randomUUID(),
    date: record.date ?? todayStr(),
    type,
    period,
    startTime: record.startTime ?? null,
    endTime: record.endTime ?? null,
    note: record.note ?? record.memo ?? ""
  };
}

function loadStateFromJSON(text) {
  const parsed = JSON.parse(text);
  const sourceRecords = Array.isArray(parsed?.entries)
    ? parsed.entries
    : Array.isArray(parsed?.records)
      ? parsed.records
      : null;

  if (!parsed || !sourceRecords) {
    throw new Error("JSON の形式が正しくありません。");
  }

  app.state = {
    settings: normalizeSettings(parsed.settings),
    records: sourceRecords.map(normalizeRecord)
  };
}

function render() {
  renderSummary();
  renderChart();
  renderTable();
  renderQuickPatterns();
}

function setValueWithClass(element, html, extraClass = "") {
  element.innerHTML = html;
  element.className = `sum-val${extraClass ? ` ${extraClass}` : ""}`;
}

function renderSummary() {
  const { acquired, total, remaining, remainingDays, usageRate } = getRemainingInfo();
  const hoursPerDay = app.state.settings.hoursPerDay;
  const deadline = app.state.settings.deadline;
  const deadlineDiff = deadline
    ? Math.ceil((new Date(`${deadline}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000)
    : null;

  setValueWithClass($("sAcquired"), `${formatHours(acquired)}<span class="sum-unit">h</span>`);

  if (total > 0) {
    const remainingClass = remaining < 0 ? "is-danger" : remaining < hoursPerDay ? "is-warn" : "";
    setValueWithClass($("sRemaining"), `${formatHours(remaining)}<span class="sum-unit">h</span>`, remainingClass);
  } else {
    setValueWithClass($("sRemaining"), "-");
  }

  if (remainingDays !== null) {
    const dayClass = remainingDays < 0 ? "is-danger" : remainingDays < 1 ? "is-warn" : "";
    setValueWithClass($("sDays"), `${formatHours(remainingDays)}<span class="sum-unit">日</span>`, dayClass);
  } else {
    setValueWithClass($("sDays"), "-");
  }

  if (deadlineDiff !== null) {
    const deadlineClass = deadlineDiff < 0 ? "is-danger" : deadlineDiff < 14 ? "is-warn" : "";
    setValueWithClass($("sDeadline"), `${deadlineDiff}<span class="sum-unit">日</span>`, deadlineClass);
  } else {
    setValueWithClass($("sDeadline"), "-");
  }

  renderGauge({ acquired, total, remaining, usageRate });
}

function renderGauge({ acquired, total, remaining, usageRate }) {
  const taken = $("gaugeTaken");
  const takenLabel = $("gaugeTakenLbl");
  const restLabel = $("gaugeRestLbl");
  const meta = $("gaugeMeta");
  const percent = total > 0 ? Math.round(usageRate * 100) : 0;

  taken.style.width = `${percent}%`;
  taken.className = `gauge-taken${usageRate >= 1 ? " is-danger" : usageRate >= 0.8 ? " is-warn" : ""}`;
  takenLabel.textContent = percent > 12 ? `${formatHours(acquired)}h 消化済み` : "";
  restLabel.textContent = total > 0 ? `残り ${formatHours(remaining)}h` : "付与日数を設定してください";
  meta.textContent = total > 0 ? `${percent}% 使用中 / 合計 ${formatHours(total)}h` : "年間付与を設定すると表示されます";
}

function buildMonthBuckets() {
  const records = [...app.state.records].sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length) return [];

  const totalsByMonth = {};
  for (const record of records) {
    const month = record.date.slice(0, 7);
    totalsByMonth[month] = (totalsByMonth[month] || 0) + calcRecordHours(record);
  }

  const currentMonth = todayStr().slice(0, 7);
  const startMonth = records[0].date.slice(0, 7);
  const deadlineMonth = app.state.settings.deadline ? app.state.settings.deadline.slice(0, 7) : currentMonth;
  const endMonth = deadlineMonth > currentMonth ? deadlineMonth : currentMonth;

  const months = [];
  let cursor = startMonth;
  while (cursor <= endMonth) {
    months.push({
      ym: cursor,
      value: totalsByMonth[cursor] || 0,
      isCurrent: cursor === currentMonth
    });

    const [year, month] = cursor.split("-").map(Number);
    cursor = month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, "0")}`;
  }

  return months;
}

function renderChart() {
  const chart = $("monthChart");
  const buckets = buildMonthBuckets();
  if (!buckets.length) {
    chart.innerHTML = '<div class="mc-empty">まだ記録はありません。</div>';
    return;
  }

  const maxValue = Math.max(...buckets.map((bucket) => bucket.value), 0.001);

  chart.innerHTML = buckets.map((bucket) => {
    const height = bucket.value > 0 ? Math.max(8, Math.round((bucket.value / maxValue) * 116)) : 8;
    const label = `${Number(bucket.ym.slice(5))}月`;
    const barClass = `mc-bar${bucket.isCurrent ? " mc-current" : bucket.value > 0 ? " mc-data" : ""}`;
    const valueClass = `mc-val${bucket.isCurrent ? " mc-current" : ""}`;
    const monthClass = `mc-month${bucket.isCurrent ? " mc-current" : ""}`;

    return `
      <div class="mc-col">
        ${bucket.value > 0 ? `<span class="${valueClass}">${formatHours(bucket.value)}h</span>` : ""}
        <div class="${barClass}" style="height:${height}px"></div>
        <div class="${monthClass}">${label}</div>
      </div>
    `;
  }).join("");
}

function renderTable() {
  const list = $("recTbody");
  const empty = $("emptyMsg");
  const editingId = $("editId").value;
  const records = [...app.state.records].sort((a, b) => b.date.localeCompare(a.date));

  $("recCount").textContent = `${records.length}件`;

  if (!records.length) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  // 今日の日付
  const today = todayStr();
  // 未来分の一番下（過去との境界）を探す
  let boundaryIdx = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].date > today) boundaryIdx = i;
    else break;
  }
  let html = "";
  for (let i = 0; i < records.length; i++) {
    // 未来分の一番下の直後に区切り線を挿入
    if (i === boundaryIdx + 1 && boundaryIdx !== -1) {
      html += `<div class="history-future-sep"><span>ここから未来の予定</span></div>`;
    }
    const record = records[i];

    const hours = `${formatHours(calcRecordHours(record))} h`;
    const timeRange = record.type === "partial"
      ? `${record.startTime ?? "-"} - ${record.endTime ?? "-"}`
      : "終日";
    html += `
      <article class="history-row${record.id === editingId ? ' is-editing-row' : ''}">
        <div class="history-main">
          <div class="history-cell history-date mono">
            <span class="history-label">日付</span>
            <div class="table-cell-date">
              <span>${formatDate(record.date)}</span>
            </div>
          </div>

          <div class="history-cell history-hours num">
            <span class="history-label">取得時間</span>
            <span>${hours}</span>
          </div>
          <div class="history-cell history-time-range mono">
            <span class="history-label">時間帯</span>
            <span>${timeRange}</span>
          </div>
          <div class="history-cell history-actions">
            <button class="btn btn-row btn-row-edit" data-action="edit" data-id="${record.id}">編集</button>
            <button class="btn btn-row btn-row-del" data-action="delete" data-id="${record.id}">削除</button>
          </div>
        </div>
        ${record.note ? `
          <div class="history-note-row">
            <span class="history-note-label">メモ</span>
            <p class="history-note-text">${escapeHTML(record.note)}</p>
          </div>
        ` : ""}
      </article>
    `;
  }
  list.innerHTML = html;
}

function buildQuickPatterns() {
  const patterns = new Map();

  for (const record of app.state.records) {
    if (record.type === "partial" && (!record.startTime || !record.endTime)) continue;

    const key = [
      record.type,
      getRecordPeriod(record) ?? "",
      record.startTime ?? "",
      record.endTime ?? "",
      (record.note ?? "").trim()
    ].join("|");

    const existing = patterns.get(key);
    if (existing) {
      existing.count += 1;
      if (record.date > existing.latest) existing.latest = record.date;
    } else {
      patterns.set(key, { record, count: 1, latest: record.date });
    }
  }

  return [...patterns.values()]
    .sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest))
    .slice(0, 3);
}

function quickPatternLabel(record) {
  const note = (record.note ?? "").trim();
  let detail;

  if (record.type === "full") {
    detail = "全休";
  } else {
    const period = getRecordPeriod(record);
    detail = period === "am"
      ? "午前休"
      : period === "pm"
        ? "午後休"
        : `${record.startTime ?? "-"}-${record.endTime ?? "-"}`;
  }

  return note ? `${detail}・${note}` : detail;
}

function renderQuickPatterns() {
  const wrap = $("quickPatterns");
  const list = $("quickPatternList");
  if (!wrap || !list) return;

  const isEditing = Boolean($("editId").value);
  quickPatterns = isEditing ? [] : buildQuickPatterns();

  if (isEditing || !quickPatterns.length) {
    wrap.classList.add("is-hidden");
    list.innerHTML = "";
    return;
  }

  wrap.classList.remove("is-hidden");
  list.innerHTML = quickPatterns.map((pattern, index) => `
    <button type="button" class="pattern-chip" data-pattern-index="${index}">${escapeHTML(quickPatternLabel(pattern.record))}</button>
  `).join("");
}

function applyQuickPattern(record) {
  $("iType").value = getRecordPeriod(record) ?? record.type;
  $("iRangeMode").value = inferRangeMode(record);
  $("iNote").value = record.note ?? "";
  syncTypeInputs();

  if (record.type === "partial") {
    if (record.startTime) $("iStart").value = record.startTime;
    if (record.endTime) $("iEnd").value = record.endTime;
  }

  $("formErr").textContent = "";
  syncFormHint();
}

function setFormMode(mode) {
  const isEdit = mode === "edit";
  $("formTitle").textContent = isEdit ? "記録を編集" : "新しい記録を追加";
  $("btnSubmit").textContent = isEdit ? "更新する" : "追加する";
  $("btnCancel").style.display = isEdit ? "inline-flex" : "none";
  $("formCard").classList.toggle("is-editing", isEdit);
  $("editBanner").style.display = isEdit ? "flex" : "none";
  renderQuickPatterns();
}

function applyTimeDefaultsForType(type, mode) {
  const settings = app.state.settings;

  if (type === "am") {
    $("iStart").value = settings.workStart;
    $("iEnd").value = settings.lunchStart;
    return;
  }

  if (type === "pm") {
    $("iStart").value = settings.lunchEnd;
    $("iEnd").value = settings.workEnd;
    return;
  }

  if (type === "partial") {
    $("iStart").value = settings.workStart;
    $("iEnd").value = settings.workEnd;
  }
}



function syncFormHint() {
  const type = $("iType").value;
  const perDay = app.state.settings.hoursPerDay;

  if (type === "full") {
    $("formHint").textContent = `全休は 1日あたりの ${formatHours(perDay)}h を取得として計算します。`;
    return;
  }

  const start = $("iStart").value;
  const end = $("iEnd").value;
  const hours = calcPartialHours(start, end);
  const label = type === "am" ? "午前休" : type === "pm" ? "午後休" : "時間休";

  if (start && end && hours > 0) {
    $("formHint").textContent = `${label}: ${start}〜${end}（${formatHours(hours)}h）`;
    return;
  }

  $("formHint").textContent = type === "partial"
    ? "開始・終了時間から取得時間を自動計算します。"
    : `${label}の時間設定を確認してください。`;
}

function syncTypeInputs() {
  const type = $("iType").value;
  const settings = app.state.settings;

  if (type === "full") {
    $("iStart").value = settings.workStart;
    $("iEnd").value = settings.workEnd;
    $("iStart").disabled = true;
    $("iEnd").disabled = true;
  } else if (type === "am") {
    $("iStart").value = settings.workStart;
    $("iEnd").value = settings.lunchStart;
    $("iStart").disabled = true;
    $("iEnd").disabled = true;
  } else if (type === "pm") {
    $("iStart").value = settings.lunchEnd;
    $("iEnd").value = settings.workEnd;
    $("iStart").disabled = true;
    $("iEnd").disabled = true;
  } else {
    $("iStart").disabled = false;
    $("iEnd").disabled = false;
  }


  $("formErr").textContent = "";
  syncFormHint();
}

function setRangeMode(mode) {
  if (!["start", "end", "custom"].includes(mode)) return;
  $("iRangeMode").value = mode;
  applyTimeDefaultsForType("partial", mode);
  syncTypeInputs();
}

function handleTypeChange() {
  const type = $("iType").value;
  if (type === "partial") {
    applyTimeDefaultsForType(type, $("iRangeMode").value);
  }
  syncTypeInputs();
}

function resetForm() {
  $("editId").value = "";
  $("iDate").value = todayStr();
  $("iType").value = "full";
  $("iRangeMode").value = "start";
  $("iStart").value = "";
  $("iEnd").value = "";
  $("iNote").value = "";
  $("editBannerTitle").textContent = "編集中";
  $("editBannerText").textContent = "";
  $("sSettingsErr").textContent = "";
  syncTypeInputs();
  setFormMode("create");
}

function validateForm() {
  const date = $("iDate").value;
  const type = $("iType").value;
  const start = $("iStart").value;
  const end = $("iEnd").value;

  if (!date) {
    return "取得日を入力してください。";
  }

  if (type !== "full") {
    if (!start || !end) {
      return "開始時間と終了時間を入力してください。";
    }

    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
      return "終了時間は開始時間より後にしてください。";
    }

    const partialHours = calcPartialHours(start, end);
    if (partialHours <= 0) {
      return "取得時間が 0 時間以下です。昼休憩設定も確認してください。";
    }

    if (partialHours > app.state.settings.hoursPerDay) {
      return `取得時間の ${formatHours(partialHours)}h が 1日あたりの ${formatHours(app.state.settings.hoursPerDay)}h を超えています。`;
    }
  }

  return "";
}

function getFormData() {
  const type = $("iType").value;
  const isPartial = type !== "full";
  return {
    date: $("iDate").value,
    type: isPartial ? "partial" : "full",
    period: type === "am" || type === "pm" ? type : null,
    startTime: isPartial ? $("iStart").value : null,
    endTime: isPartial ? $("iEnd").value : null,
    note: $("iNote").value.trim()
  };
}

async function submitForm() {
  const errorMessage = validateForm();
  $("formErr").textContent = errorMessage;
  if (errorMessage) return;

  const payload = getFormData();
  const editId = $("editId").value;

  if (editId) {
    const index = app.state.records.findIndex((record) => record.id === editId);
    if (index !== -1) {
      app.state.records[index] = { ...app.state.records[index], ...payload };
    }
  } else {
    app.state.records.push({ id: crypto.randomUUID(), ...payload });
  }

  resetForm();
  render();
  await persist();
}

function startEdit(id) {
  const record = app.state.records.find((item) => item.id === id);
  if (!record) return;

  $("editId").value = record.id;
  $("iDate").value = record.date;
  $("iType").value = getRecordPeriod(record) ?? record.type;
  $("iRangeMode").value = inferRangeMode(record);
  $("iStart").value = "";
  $("iEnd").value = "";
  $("iNote").value = record.note ?? "";
  $("editBannerTitle").textContent = "この記録を編集中";
  $("editBannerText").textContent = `${record.date} / ${getRecordTypeLabel(record)} を更新できます`;
  syncTypeInputs();

  if (record.type === "partial") {
    if (record.startTime) $("iStart").value = record.startTime;
    if (record.endTime) $("iEnd").value = record.endTime;
    syncFormHint();
  }

  setFormMode("edit");
  renderTable();
  $("formCard").scrollIntoView({ behavior: "smooth", block: "start" });
  $("iDate").focus({ preventScroll: true });
}

function cancelEdit() {
  resetForm();
  renderTable();
}

async function deleteRecord(id) {
  const record = app.state.records.find((item) => item.id === id);
  if (!record) return;

  const confirmed = window.confirm(`${record.date} の記録を削除しますか？`);
  if (!confirmed) return;

  app.state.records = app.state.records.filter((item) => item.id !== id);
  if ($("editId").value === id) resetForm();
  render();
  await persist();
}

function syncLunchInputs() {
  const enabled = $("sDeductLunch").checked;
  $("sLunchStart").disabled = !enabled;
  $("sLunchEnd").disabled = !enabled;
  syncWorkHoursHint();
}

function syncWorkHoursHint() {
  const hint = $("workHoursHint");
  if (!hint) return;

  hint.classList.remove("is-warn");
  const start = toMinutes($("sWorkStart").value);
  const end = toMinutes($("sWorkEnd").value);
  const perDay = Number($("sPerDay").value);

  if (start === null || end === null || end <= start) {
    hint.textContent = "始業・終業時刻を確認してください。";
    hint.classList.add("is-warn");
    return;
  }

  let minutes = end - start;
  if ($("sDeductLunch").checked) {
    const lunchStart = toMinutes($("sLunchStart").value);
    const lunchEnd = toMinutes($("sLunchEnd").value);
    if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart) {
      minutes -= Math.max(0, Math.min(end, lunchEnd) - Math.max(start, lunchStart));
    }
  }

  const hours = Math.max(minutes, 0) / 60;
  const base = `所定労働 ${formatHours(hours)}h`;

  if (!Number.isFinite(perDay) || perDay <= 0) {
    hint.textContent = base;
    return;
  }

  const diff = Math.round((hours - perDay) * 100) / 100;
  if (diff !== 0) hint.classList.add("is-warn");
  hint.textContent = diff === 0
    ? `${base}（1日あたりの時間と一致）`
    : `${base}（1日あたりの ${formatHours(perDay)}h と ${formatHours(Math.abs(diff))}h ずれ）`;
}

function validateSettings() {
  const start = toMinutes($("sWorkStart").value);
  const end = toMinutes($("sWorkEnd").value);

  if (start === null || end === null) {
    return "始業・終業時刻を入力してください。";
  }

  if (end <= start) {
    return "終業時刻は始業時刻より後にしてください。";
  }

  const perDay = Number($("sPerDay").value);
  if (!Number.isFinite(perDay) || perDay <= 0) {
    return "1日あたりの時間を入力してください。";
  }

  return "";
}

function openSettings() {
  if (!app.fileHandle) return;
  $("sTotalDays").value = app.state.settings.totalDays;
  $("sPerDay").value = app.state.settings.hoursPerDay;
  $("sDeadlineInput").value = app.state.settings.deadline;
  $("sWorkStart").value = app.state.settings.workStart;
  $("sWorkEnd").value = app.state.settings.workEnd;
  $("sDeductLunch").checked = app.state.settings.deductLunchBreak;
  $("sLunchStart").value = app.state.settings.lunchStart;
  $("sLunchEnd").value = app.state.settings.lunchEnd;
  $("sSettingsErr").textContent = "";
  syncLunchInputs();
  $("modalOverlay").classList.add("open");
}

function closeSettings() {
  $("modalOverlay").classList.remove("open");
}

async function saveSettings() {
  const errorMessage = validateSettings();
  $("sSettingsErr").textContent = errorMessage;
  if (errorMessage) return;

  app.state.settings = normalizeSettings({
    totalDays: Number($("sTotalDays").value),
    hoursPerDay: Number($("sPerDay").value),
    deadline: $("sDeadlineInput").value,
    deductLunchBreak: $("sDeductLunch").checked,
    lunchStart: $("sLunchStart").value,
    lunchEnd: $("sLunchEnd").value,
    workStart: $("sWorkStart").value,
    workEnd: $("sWorkEnd").value
  });

  closeSettings();
  render();
  if ($("editId").value) {
    syncFormHint();
  } else {
    syncTypeInputs();
  }
  await persist();
}

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(handle) {
  try {
    const db = await openDB();
    db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(handle, DB_KEY);
  } catch (_) {
    // ignore restore cache errors
  }
}

async function loadStoredHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

function setFileBadge(text) {
  $("fileBadge").textContent = text;
}

function syncScreenState(hasFile) {
  $("mainContent").style.display = hasFile ? "flex" : "none";
  $("noFileScreen").style.display = hasFile ? "none" : "block";
  $("headerActions").classList.toggle("is-hidden", !hasFile);
}

async function persistNow() {
  if (!app.fileHandle) return;
  const writable = await app.fileHandle.createWritable();
  await writable.write(createPayload());
  await writable.close();

  setFileBadge(`${app.fileHandle.name} 保存済み`);
  clearTimeout($("fileBadge")._saveTimer);
  $("fileBadge")._saveTimer = setTimeout(() => {
    if (app.fileHandle) setFileBadge(app.fileHandle.name);
  }, 1200);
}

function persist() {
  app.persistQueue = app.persistQueue
    .then(() => persistNow())
    .catch((error) => {
      setFileBadge(`保存エラー: ${error.message}`);
      console.error("保存エラー", error);
    });

  return app.persistQueue;
}

async function readCurrentFile() {
  const file = await app.fileHandle.getFile();
  loadStateFromJSON(await file.text());
  await storeHandle(app.fileHandle);
  onFileReady();
}

function onFileReady() {
  setFileBadge(app.fileHandle.name);
  syncScreenState(true);
  $("btnRestore").style.display = "none";
  $("btnRestoreStart").style.display = "none";
  $("btnSettings").disabled = false;
  resetForm();
  render();
}

function buildPickerOptions(extra = {}) {
  const options = {
    types: FILE_TYPE_OPTIONS,
    ...extra
  };

  if (app.fileHandle) {
    options.startIn = app.fileHandle;
  }

  return options;
}

async function ensureReadWritePermission(handle) {
  const permission = await handle.requestPermission({ mode: "readwrite" });
  return permission === "granted";
}

async function openFile() {
  try {
    const [handle] = await window.showOpenFilePicker(buildPickerOptions());
    const granted = await ensureReadWritePermission(handle);
    if (!granted) {
      window.alert("読み書き権限が必要です。");
      return;
    }

    app.fileHandle = handle;
    await readCurrentFile();
  } catch (error) {
    if (error.name !== "AbortError") {
      window.alert(`ファイルを開けませんでした: ${error.message}`);
    }
  }
}

async function newFile() {
  try {
    const handle = await window.showSaveFilePicker(buildPickerOptions({
      suggestedName: "nenkyuu.json"
    }));

    app.fileHandle = handle;
    app.state = createDefaultState();
    await persistNow();
    await storeHandle(handle);
    onFileReady();
  } catch (error) {
    if (error.name !== "AbortError") {
      window.alert(`新規ファイルを作成できませんでした: ${error.message}`);
    }
  }
}

async function restoreFile() {
  const storedHandle = await loadStoredHandle();
  if (!storedHandle) return;

  const granted = await ensureReadWritePermission(storedHandle);
  if (!granted) {
    window.alert("復元するには読み書き権限が必要です。もう一度お試しください。");
    return;
  }

  app.fileHandle = storedHandle;
  await readCurrentFile();
}

async function tryAutoRestoreOnLaunch() {
  const storedHandle = await loadStoredHandle();
  if (!storedHandle) return;

  $("restoreName").textContent = storedHandle.name;
  $("restoreHint").style.display = "block";
  $("btnRestore").style.display = "inline-flex";
  $("btnRestoreStart").style.display = "inline-flex";

  const permission = await storedHandle.queryPermission({ mode: "readwrite" });
  if (permission === "granted") {
    app.fileHandle = storedHandle;
    await readCurrentFile();
  }
}

function bindEvents() {
  $("btnOpen").addEventListener("click", openFile);
  $("btnOpenStart").addEventListener("click", openFile);
  $("btnNew").addEventListener("click", newFile);
  $("btnNewStart").addEventListener("click", newFile);
  $("btnRestore").addEventListener("click", restoreFile);
  $("btnRestoreStart").addEventListener("click", restoreFile);

  $("btnSettings").addEventListener("click", openSettings);
  $("btnModalClose").addEventListener("click", closeSettings);
  $("btnModalCancel").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettings);
  $("sDeductLunch").addEventListener("change", () => {
    $("sSettingsErr").textContent = "";
    syncLunchInputs();
  });
  ["sWorkStart", "sWorkEnd", "sPerDay", "sLunchStart", "sLunchEnd"].forEach((id) => {
    $(id).addEventListener("input", () => {
      $("sSettingsErr").textContent = "";
      syncWorkHoursHint();
    });
  });

  $("btnSubmit").addEventListener("click", submitForm);
  $("btnCancel").addEventListener("click", cancelEdit);
  $("btnCancelBanner").addEventListener("click", cancelEdit);
  $("iType").addEventListener("change", handleTypeChange);
  ["iStart", "iEnd"].forEach((id) => {
    $(id).addEventListener("input", () => {
      $("formErr").textContent = "";
      syncFormHint();
    });
  });



  $("quickPatternList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-pattern-index]");
    if (!button) return;
    const pattern = quickPatterns[Number(button.dataset.patternIndex)];
    if (pattern) applyQuickPattern(pattern.record);
  });

  $("recTbody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    if (button.dataset.action === "edit") {
      startEdit(button.dataset.id);
      return;
    }

    if (button.dataset.action === "delete") {
      await deleteRecord(button.dataset.id);
    }
  });

  $("modalOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeSettings();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettings();
  });
}

async function init() {
  syncScreenState(false);
  resetForm();
  bindEvents();
  await tryAutoRestoreOnLaunch();
}

function escapeHTML(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
