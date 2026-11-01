// Voice planner client: chat, speech recognition/synthesis, agenda panel, reminders.
// Plain ES modules, no build step.

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const micEl = $("#mic");
const statusEl = $("#voice-status");
const agendaEl = $("#agenda-list");
const examplesEl = $("#examples");
const ttsToggle = $("#tts-toggle");

const TYPE_ICON = { task: "✅", meeting: "👥", reminder: "⏰" };
const TYPE_NAME = { task: "задача", meeting: "встреча", reminder: "напоминание" };
const ACTION_NAME = {
  created: "Добавлено",
  updated: "Изменено",
  deleted: "Удалено",
  completed: "Отмечено",
  restored: "Восстановлено",
  found: "Найдено",
  listed: "",
};

// ---------- identity & API ----------

function userId() {
  let id = localStorage.getItem("vp-user");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    localStorage.setItem("vp-user", id);
  }
  return id;
}
const USER = userId();
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const isRaw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: {
      "x-user-id": USER,
      "x-timezone": ZONE,
      ...(body && !isRaw ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ---------- rendering ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function cardsHtml(actions) {
  const shown = (actions || []).filter((a) => a.kind !== "listed" || a.items.length <= 8);
  const cards = shown.flatMap((a) =>
    a.items.slice(0, 8).map(
      (i) => `
      <div class="card ${a.kind === "deleted" ? "deleted" : ""}">
        <span class="kind" aria-hidden="true">${TYPE_ICON[i.type]}</span>
        <span class="title">${esc(i.title)}${i.status === "done" ? " ✓" : ""}</span>
        <span class="when">${ACTION_NAME[a.kind] ? `<span class="tag">${ACTION_NAME[a.kind]}</span> · ` : ""}${esc(i.when)}${i.recurrence ? ` · ${esc(i.recurrence)}` : ""}</span>
      </div>`,
    ),
  );
  return cards.length ? `<div class="cards">${cards.join("")}</div>` : "";
}

function addMessage(role, text, { actions = [], awaiting = false, at = new Date(), engine = "" } = {}) {
  const el = document.createElement("div");
  el.className = `msg ${role === "user" ? "user" : "bot"}${awaiting ? " awaiting" : ""}`;
  el.innerHTML = `<div class="bubble">${esc(text)}</div>${role !== "user" ? cardsHtml(actions) : ""}<span class="meta">${timeLabel(at)}${engine ? ` · ${esc(engine)}` : ""}</span>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function showTyping() {
  const el = document.createElement("div");
  el.className = "msg bot typing";
  el.innerHTML = `<div class="bubble"><span class="dots">Думаю</span></div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

// ---------- agenda ----------

let agendaView = "upcoming";
let flashIds = new Set();

async function loadAgenda() {
  try {
    const { items } = await api(`/api/agenda?view=${agendaView}`);
    renderAgenda(items);
  } catch (err) {
    agendaEl.innerHTML = `<p class="empty">Не удалось загрузить: ${esc(err.message)}</p>`;
  }
}

function dayKey(item) {
  if (!item.start) return "Без срока";
  return item.when.replace(/\s+(в|с)\s+\d{1,2}:\d{2}.*$/, "");
}

function renderAgenda(items) {
  if (!items.length) {
    agendaEl.innerHTML = `<p class="empty">Пока пусто. Скажите, например: «Напомни завтра в 10 позвонить Ивану».</p>`;
    return;
  }
  let html = "";
  let lastDay = null;
  for (const i of items) {
    const day = agendaView === "all" ? null : dayKey(i);
    if (day !== null && day !== lastDay) {
      html += `<div class="day-head">${esc(day)}</div>`;
      lastDay = day;
    }
    const time = i.start && !i.allDay ? (i.when.match(/\d{1,2}:\d{2}/g) ?? []).join("–") : "";
    const sub = [agendaView === "all" ? i.when : time, TYPE_NAME[i.type], i.recurrence].filter(Boolean).join(" · ");
    html += `
      <div class="row ${i.status === "done" ? "done" : ""} ${flashIds.has(i.id) ? "flash" : ""}" data-id="${esc(i.id)}">
        <input type="checkbox" ${i.status === "done" ? "checked" : ""} aria-label="Выполнено" />
        <span class="dot ${i.type}" aria-hidden="true"></span>
        <div class="text"><div class="title">${esc(i.title)}</div><div class="sub">${esc(sub)}</div></div>
        <button class="del" type="button" title="Удалить" aria-label="Удалить">✕</button>
      </div>`;
  }
  agendaEl.innerHTML = html;
  flashIds = new Set();
}

agendaEl.addEventListener("click", async (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.matches("input[type=checkbox]")) {
    await api(`/api/items/${id}/complete`, { method: "POST", body: { done: e.target.checked } });
    loadAgenda();
  } else if (e.target.matches(".del")) {
    await api(`/api/items/${id}`, { method: "DELETE" });
    toast("Удалено. Скажите «верни», чтобы восстановить.");
    loadAgenda();
  }
});

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    agendaView = tab.dataset.view;
    loadAgenda();
  }),
);

// ---------- speech synthesis ----------

let ttsEnabled = localStorage.getItem("vp-tts") !== "off";
ttsToggle.setAttribute("aria-pressed", String(ttsEnabled));
ttsToggle.textContent = ttsEnabled ? "🔊" : "🔈";
ttsToggle.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  localStorage.setItem("vp-tts", ttsEnabled ? "on" : "off");
  ttsToggle.setAttribute("aria-pressed", String(ttsEnabled));
  ttsToggle.textContent = ttsEnabled ? "🔊" : "🔈";
  if (!ttsEnabled) speechSynthesis?.cancel();
});

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const ru = voices.filter((v) => v.lang?.toLowerCase().startsWith("ru"));
  return ru.find((v) => /google|milena|yandex|natural|premium|enhanced/i.test(v.name)) ?? ru[0] ?? null;
}

/** Speaks text; resolves when finished (or immediately when TTS is off/unavailable). */
function speak(text) {
  return new Promise((resolve) => {
    if (!ttsEnabled || !window.speechSynthesis) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[«»]/g, ""));
    u.lang = "ru-RU";
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = 1.05;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
window.speechSynthesis?.addEventListener?.("voiceschanged", pickVoice);

// ---------- speech recognition ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let lastInputWasVoice = false;
let serverStt = false;
let mediaRecorder = null;

function setListening(on, note = "") {
  listening = on;
  micEl.classList.toggle("listening", on);
  micEl.setAttribute("aria-label", on ? "Остановить" : "Говорить");
  statusEl.textContent = note;
}

function startBrowserRecognition() {
  recognizer = new Recognition();
  recognizer.lang = "ru-RU";
  recognizer.interimResults = true;
  recognizer.continuous = false;
  recognizer.maxAlternatives = 1;
  let finalText = "";
  recognizer.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    inputEl.value = (finalText + interim).trim();
  };
  recognizer.onerror = (e) => {
    const messages = {
      "not-allowed": "Нет доступа к микрофону — разрешите его в настройках браузера.",
      "no-speech": "Ничего не услышал. Нажмите на микрофон и говорите.",
      network: "Распознавание речи недоступно (нет сети). Можно ввести текст.",
    };
    setListening(false, messages[e.error] ?? `Ошибка распознавания: ${e.error}`);
  };
  recognizer.onend = () => {
    const text = inputEl.value.trim();
    if (listening) setListening(false);
    if (text) {
      lastInputWasVoice = true;
      send(text);
    }
  };
  speechSynthesis?.cancel();
  inputEl.value = "";
  recognizer.start();
  setListening(true, "Слушаю… говорите");
}

async function startServerRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    setListening(false, "Распознаю…");
    try {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const { text } = await api("/api/stt", { method: "POST", body: blob, headers: { "content-type": blob.type } });
      statusEl.textContent = "";
      if (text) {
        lastInputWasVoice = true;
        send(text);
      } else statusEl.textContent = "Ничего не распознано.";
    } catch (err) {
      statusEl.textContent = `Ошибка распознавания: ${err.message}`;
    }
  };
  mediaRecorder.start();
  setListening(true, "Говорите и нажмите ещё раз, чтобы закончить");
  setTimeout(() => mediaRecorder?.state === "recording" && mediaRecorder.stop(), 15000);
}

function toggleMic() {
  if (listening) {
    recognizer?.stop();
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    return;
  }
  try {
    if (Recognition) startBrowserRecognition();
    else if (serverStt) startServerRecording();
  } catch (err) {
    setListening(false, `Микрофон недоступен: ${err.message}`);
  }
}
micEl.addEventListener("click", toggleMic);

// ---------- dialogue ----------

let busy = false;

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  window.speechSynthesis?.cancel();
  inputEl.value = "";
  examplesEl.classList.add("hidden");
  addMessage("user", text);
  const typing = showTyping();
  try {
    const res = await api("/api/chat", { method: "POST", body: { text } });
    typing.remove();
    addMessage("bot", res.reply, { actions: res.actions, awaiting: res.awaiting, engine: res.engine });
    for (const a of res.actions) if (a.kind !== "listed" && a.kind !== "found") a.items.forEach((i) => flashIds.add(i.id));
    loadAgenda();
    const voiceTurn = lastInputWasVoice;
    lastInputWasVoice = false;
    busy = false;
    await speak(res.reply);
    // Hands-free clarification: if the assistant asked a question after a voice request, listen again.
    if (res.awaiting && voiceTurn && Recognition && !listening && !busy) startBrowserRecognition();
  } catch (err) {
    typing.remove();
    addMessage("bot", `Не получилось обработать запрос: ${err.message}`);
  } finally {
    busy = false;
  }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  lastInputWasVoice = false;
  send(inputEl.value);
});

examplesEl.addEventListener("click", (e) => {
  if (e.target.matches(".chip")) send(e.target.textContent);
});

$("#reset-btn").addEventListener("click", async () => {
  await api("/api/session/reset", { method: "POST" });
  messagesEl.innerHTML = "";
  examplesEl.classList.remove("hidden");
  greet();
});

// ---------- reminders ----------

$("#notify-btn").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Браузер не поддерживает уведомления.");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Уведомления включены." : "Уведомления запрещены в браузере.");
});

async function pollReminders() {
  try {
    const { due } = await api("/api/reminders/due");
    for (const i of due) {
      const text = i.type === "meeting" ? `Скоро встреча: ${i.title}, ${i.when}` : `Напоминание: ${i.title}`;
      toast(`${TYPE_ICON[i.type]} ${text}`);
      if ("Notification" in window && Notification.permission === "granted") new Notification(text);
      speak(text);
    }
    if (due.length) loadAgenda();
  } catch {
    /* offline — try again later */
  }
}

// ---------- start ----------

function greet() {
  addMessage("bot", "Здравствуйте! Я веду ваши задачи, напоминания и встречи. Нажмите на микрофон и скажите, что запланировать, или спросите, что у вас сегодня.");
}

async function init() {
  $("#ics-link").href = `/calendar/${USER}.ics`;
  try {
    const health = await api("/api/health");
    serverStt = health.serverStt;
    const badge = $("#engine");
    badge.textContent = health.llm ? `LLM: ${health.engine}` : "Офлайн-режим (правила)";
    badge.classList.toggle("offline", !health.llm);
    badge.title = health.llm
      ? "Запросы понимает языковая модель; при её недоступности — встроенные правила"
      : "LLM не настроена: работает встроенный разбор русского языка";
  } catch {
    $("#engine").textContent = "сервер недоступен";
  }
  if (!Recognition && !serverStt) {
    micEl.disabled = true;
    micEl.title = "Этот браузер не умеет распознавать речь — используйте Chrome, Edge или Safari, либо вводите текст";
    statusEl.textContent = "Голосовой ввод недоступен в этом браузере — можно писать текстом.";
  }

  const { history } = await api("/api/history").catch(() => ({ history: [] }));
  if (history.length) {
    examplesEl.classList.add("hidden");
    for (const t of history.slice(-20)) addMessage(t.role === "user" ? "user" : "bot", t.text, { at: new Date(t.at) });
  } else greet();

  loadAgenda();
  pollReminders();
  setInterval(pollReminders, 30000);
  inputEl.focus();
}

init();
