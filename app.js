// Claude文字起こし — 端末の音声認識で文字起こしし、Claude で整形・要約・質問応答を行う PWA
// 保存方針: 確定した文はすぐ IndexedDB に保存し、一定間隔でスナップショット（バックアップ）を別ストアに積む。

const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm";
const $ = (id) => document.getElementById(id);

/* ---------------- 設定 ---------------- */
const DEFAULTS = {
  apiKey: "", model: "claude-opus-5-5", effort: "medium", lang: "ja-JP",
  backupMin: 3, keepBackups: 10, recordAudio: true,
};
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("ct-settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function storeSettings() {
  try { localStorage.setItem("ct-settings", JSON.stringify(settings)); } catch {}
}

/* ---------------- IndexedDB ---------------- */
let dbPromise;
function db() {
  dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open("claude-transcriber", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("sessions", { keyPath: "id" });
      d.createObjectStore("backups", { keyPath: "id", autoIncrement: true }).createIndex("sessionId", "sessionId");
      d.createObjectStore("audio", { keyPath: ["sessionId", "seq"] }).createIndex("sessionId", "sessionId");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const idbPut = (store, v) => run(store, "readwrite", (s) => s.put(v));
const idbGet = (store, k) => run(store, "readonly", (s) => s.get(k));
const idbAll = (store) => run(store, "readonly", (s) => s.getAll());
const idbByIndex = (store, key) => run(store, "readonly", (s) => s.index("sessionId").getAll(key));
const idbDel = (store, k) => run(store, "readwrite", (s) => s.delete(k));
const idbDelByIndex = (store, key) => run(store, "readwrite", (s) => {
  s.index("sessionId").openKeyCursor(IDBKeyRange.only(key)).onsuccess = (e) => {
    const c = e.target.result;
    if (c) { s.delete(c.primaryKey); c.continue(); }
  };
});

/* ---------------- ユーティリティ ---------------- */
const pad = (n) => String(n).padStart(2, "0");
function hms(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function stamp(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
const clock = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateLabel = (t) => new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const rawText = (s) => s.segments.map((g) => `[${stamp(g.t)}] ${g.text}`).join("\n");
const charCount = (s) => s.segments.reduce((n, g) => n + g.text.length, 0);

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// 最小限の Markdown 表示（見出し・箇条書き・太字）
function md(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of esc(src).split("\n")) {
    const l = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    let m;
    if ((m = l.match(/^#{1,2}\s+(.*)/))) { close(); out.push(`<h3>${m[1]}</h3>`); }
    else if ((m = l.match(/^#{3,6}\s+(.*)/))) { close(); out.push(`<h4>${m[1]}</h4>`); }
    else if ((m = l.match(/^\s*[-*・]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${m[1]}</li>`); }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${m[1]}</li>`); }
    else if (!l.trim()) close();
    else { close(); out.push(`<p>${l}</p>`); }
  }
  close();
  return out.join("");
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "transcript";

/* ---------------- バックアップ ---------------- */
async function snapshot(session, reason) {
  const now = Date.now();
  await idbPut("backups", {
    sessionId: session.id, savedAt: now, reason,
    segCount: session.segments.length, chars: charCount(session),
    data: structuredClone(session),
  });
  const list = (await idbByIndex("backups", session.id)).sort((a, b) => b.savedAt - a.savedAt);
  for (const b of list.slice(settings.keepBackups)) await idbDel("backups", b.id);
  session.lastBackupAt = now;
  return now;
}

/* ---------------- 録音・文字起こし ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const isAndroid = /Android/i.test(navigator.userAgent);

const R = {
  session: null, active: false, paused: false,
  runStart: 0, baseMs: 0, run: 0,
  rec: null, recRunning: false, interim: "", restartDelay: 300,
  stream: null, mr: null, mrStopped: null,
  wakeLock: null, tick: null, backupTimer: null, saveTimer: null,
  lastBackupSeg: -1,
  elapsed() { return this.baseMs + (this.active && !this.paused ? Date.now() - this.runStart : 0); },
};

function newSession() {
  const now = Date.now();
  return {
    id: uid(), title: `${dateLabel(now)} の記録`, createdAt: now, updatedAt: now,
    durationMs: 0, status: "recording", segments: [], audioChunks: 0, audioRuns: 0,
    clean: { parts: [], segCount: 0, done: false }, summary: { kind: "", text: "" }, qa: [],
    lastBackupAt: null,
  };
}

async function startRecording(existing) {
  if (!SR) { toast("このブラウザは音声認識に対応していません（Chrome / Safari をお使いください）", 5000); return; }
  const s = existing || newSession();
  s.status = "recording";
  Object.assign(R, { session: s, active: true, paused: false, baseMs: s.durationMs || 0, runStart: Date.now(), interim: "", lastBackupSeg: -1 });
  await idbPut("sessions", s);
  requestPersist();

  showView("rec");
  renderLive();
  setRecUi();

  if (settings.recordAudio) await startAudio();
  startRecognition();
  lockScreen();

  R.tick = setInterval(() => { $("recTime").textContent = hms(R.elapsed()); }, 500);
  R.backupTimer = setInterval(periodicBackup, settings.backupMin * 60_000);
  await saveNow();
  await periodicBackup("start");
}

async function startAudio() {
  try {
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    R.mr = new MediaRecorder(R.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    const s = R.session, runNo = s.audioRuns++;
    R.mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = s.audioChunks++;
      idbPut("audio", { sessionId: s.id, seq, run: runNo, mime: R.mr.mimeType || mime, blob: e.data })
        .catch(() => warn("音声の保存に失敗しました（空き容量を確認してください）"));
    };
    R.mrStopped = new Promise((res) => { R.mr.onstop = res; });
    R.mr.start(10_000); // 10秒ごとに区切って保存
    $("recAudio").textContent = "音声: 保存中";
  } catch (e) {
    R.mr = null;
    $("recAudio").textContent = "音声: 保存なし";
    warn("マイクを音声保存に使えませんでした。文字起こしのみ続けます。");
  }
}

function startRecognition() {
  const rec = new SR();
  rec.lang = settings.lang;
  rec.interimResults = true;
  // Android Chrome は continuous=true だと確定結果が重複するため、1発話ごとに再起動する
  rec.continuous = !isAndroid;
  rec.onstart = () => { R.recRunning = true; };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) addSegment(r[0].transcript);
      else interim += r[0].transcript;
    }
    R.interim = interim;
    $("interim").textContent = interim;
    R.restartDelay = 300;
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      warn("マイクの使用が許可されていません。ブラウザの設定で許可してください。");
      stopRecording();
    } else if (e.error === "network") {
      warn("音声認識サーバーに接続できません。通信状況を確認してください（再接続を続けます）。");
      R.restartDelay = Math.min(R.restartDelay * 2, 5000);
    } else if (e.error === "audio-capture") {
      warn("マイクを取得できません。設定で「音声も保存する」をオフにすると改善する場合があります。");
      R.restartDelay = Math.min(R.restartDelay * 2, 5000);
    }
  };
  rec.onend = () => {
    R.recRunning = false;
    // 確定前に途切れた途中結果は失わないよう確定扱いにする
    if (R.interim.trim()) { addSegment(R.interim); R.interim = ""; $("interim").textContent = ""; }
    if (R.active && !R.paused) setTimeout(() => ensureRecognition(), R.restartDelay);
  };
  R.rec = rec;
  ensureRecognition();
}

function ensureRecognition() {
  if (!R.active || R.paused || R.recRunning || !R.rec) return;
  try { R.rec.start(); } catch { /* 既に開始済み */ }
}

function addSegment(text) {
  text = text.trim();
  if (!text || !R.session) return;
  const seg = { t: R.elapsed(), text };
  R.session.segments.push(seg);
  appendSeg(seg);
  $("recChars").textContent = `${charCount(R.session).toLocaleString()}文字`;
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  clearTimeout(R.saveTimer);
  const s = R.session;
  if (!s) return;
  s.durationMs = R.elapsed();
  s.updatedAt = Date.now();
  try {
    await idbPut("sessions", s);
    $("recSaved").textContent = `保存: ${clock(s.updatedAt)}`;
  } catch {
    warn("端末への保存に失敗しました。空き容量を確認し、テキストを書き出してください。");
  }
}
async function periodicBackup(reason = "auto") {
  const s = R.session;
  if (!s) return;
  if (reason === "auto" && s.segments.length === R.lastBackupSeg) return; // 変化がなければ積まない
  await saveNow();
  const t = await snapshot(s, reason);
  R.lastBackupSeg = s.segments.length;
  await idbPut("sessions", s);
  $("recBackup").textContent = `バックアップ: ${clock(t)}`;
}

async function togglePause() {
  if (!R.active) return;
  if (!R.paused) {
    R.baseMs = R.elapsed();
    R.paused = true;
    try { R.rec.stop(); } catch {}
    if (R.mr?.state === "recording") R.mr.pause();
    await saveNow();
  } else {
    R.paused = false;
    R.runStart = Date.now();
    if (R.mr?.state === "paused") R.mr.resume();
    ensureRecognition();
  }
  setRecUi();
}

async function stopRecording() {
  if (!R.active) return;
  R.baseMs = R.elapsed();
  R.active = false;
  clearInterval(R.tick);
  clearInterval(R.backupTimer);
  // 停止直後に届く最後の確定結果を取りこぼさないよう、認識の終了を少し待つ
  const ended = R.rec && R.recRunning
    ? new Promise((res) => { const prev = R.rec.onend; R.rec.onend = () => { prev(); res(); }; setTimeout(res, 1500); })
    : null;
  try { R.rec?.stop(); } catch {}
  await ended;
  if (R.mr && R.mr.state !== "inactive") { R.mr.stop(); await R.mrStopped; }
  R.stream?.getTracks().forEach((t) => t.stop());
  if (R.interim.trim()) addSegment(R.interim);
  Object.assign(R, { rec: null, mr: null, stream: null, interim: "" });
  releaseScreen();

  const s = R.session;
  s.status = "stopped";
  await saveNow();
  await periodicBackup("stop");
  R.session = null;
  toast("保存しました");
  openDetail(s.id);
}

function setRecUi() {
  $("recHead").classList.toggle("paused", R.paused);
  $("recState").textContent = R.paused ? "一時停止中" : "録音中";
  $("pauseBtn").textContent = R.paused ? "再開" : "一時停止";
}
function warn(msg) {
  const w = $("recWarn");
  w.textContent = msg;
  w.hidden = false;
}
function appendSeg(seg) {
  const box = $("liveText");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const p = document.createElement("p");
  p.className = "seg";
  p.innerHTML = `<time>${stamp(seg.t)}</time><span></span>`;
  p.lastChild.textContent = seg.text;
  box.insertBefore(p, $("interim"));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function renderLive() {
  const box = $("liveText");
  box.querySelectorAll(".seg").forEach((n) => n.remove());
  $("interim").textContent = "";
  R.session.segments.forEach(appendSeg);
  $("recWarn").hidden = true;
  $("recChars").textContent = `${charCount(R.session).toLocaleString()}文字`;
  $("recTime").textContent = hms(R.elapsed());
  $("recBackup").textContent = "バックアップ: -";
  $("recAudio").textContent = settings.recordAudio ? "" : "音声: 保存なし";
}

async function lockScreen() {
  try { R.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function releaseScreen() {
  try { R.wakeLock?.release(); } catch {}
  R.wakeLock = null;
}
async function requestPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (!R.active) return;
  if (document.visibilityState === "hidden") saveNow();
  else { lockScreen(); ensureRecognition(); }
});
window.addEventListener("pagehide", () => { if (R.active) saveNow(); });
window.addEventListener("beforeunload", (e) => { if (R.active) { saveNow(); e.preventDefault(); e.returnValue = ""; } });

/* ---------------- Claude ---------------- */
let sdkPromise;
async function claudeStream({ system, content, onText, signal, maxTokens = 32000 }) {
  if (!settings.apiKey) throw new Error("設定で Claude APIキーを入力してください");
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: settings.effort },
  };
  // 安全判定で断られた場合にサーバー側で別モデルに引き継ぐ（Haiku は非対応）
  if (settings.model !== "claude-haiku-5-5") {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = client.beta.messages.stream(params, { signal });
  stream.on("text", (delta) => onText?.(delta));
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude がこの内容の処理を辞退しました");
  return msg;
}
function claudeError(e) {
  if (e?.name === "AbortError" || /abort/i.test(e?.message || "")) return "中止しました";
  const st = e?.status;
  if (st === 401) return "APIキーが正しくありません";
  if (st === 429) return "利用上限に達しました。少し待ってから再実行してください";
  if (st >= 500) return "Claude 側が混み合っています。少し待ってから再実行してください";
  if (e instanceof TypeError) return "通信できませんでした。電波状況を確認してください";
  return e?.message || "エラーが発生しました";
}

const CLEAN_SYSTEM = `あなたは音声認識の文字起こしを読みやすく整える編集者です。
入力は端末の音声認識による会話の文字起こしで、句読点がなく、誤認識を含みます。各行の先頭の [mm:ss] は経過時間です。
次の方針で整形し、整形後の本文だけを出力してください。
- 句読点を付け、話題のまとまりごとに段落に分ける。各段落の先頭に、その段落の最初の行のタイムスタンプ [mm:ss] を残す。
- 「えー」「あのー」「まあ」などのフィラーと、言い直しによる重複を取り除く。
- 誤認識は、文脈から正しい語が確実にわかる場合だけ直す。自信がなければ原文のままにする。
- 話し手の交代が文脈から明らかな場合は「話者A：」「話者B：」のように示す。不明なら付けない。
- 内容を要約・追加・削除しない。言われていないことを書かない。`;

function chunkSegments(segments, maxChars = 3500) {
  const chunks = [];
  let cur = [], len = 0;
  for (const g of segments) {
    const line = `[${stamp(g.t)}] ${g.text}`;
    if (len + line.length > maxChars && cur.length) { chunks.push(cur.join("\n")); cur = []; len = 0; }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

let cleanAbort = null;
async function runClean() {
  const s = cur;
  if (!s.segments.length) return toast("文字起こしがまだありません");
  // 文字起こしが増えていれば最初からやり直し、同じなら続きから再開する
  if (s.clean.segCount !== s.segments.length) s.clean = { parts: [], segCount: s.segments.length, done: false };
  const chunks = chunkSegments(s.segments);
  cleanAbort = new AbortController();
  setBusy("clean", true);
  try {
    for (let i = s.clean.parts.length; i < chunks.length; i++) {
      $("cleanProgress").textContent = `整形中… ${i + 1} / ${chunks.length}`;
      const prev = s.clean.parts.at(-1)?.slice(-400) || "";
      const content = (prev ? `直前の整形済みの末尾（文脈・話者ラベルを揃えるための参考。出力に含めない）:\n${prev}\n\n---\n` : "")
        + `整形する文字起こし（${i + 1}/${chunks.length}）:\n${chunks[i]}`;
      let acc = "";
      const base = s.clean.parts.join("\n\n");
      await claudeStream({
        system: CLEAN_SYSTEM, content, signal: cleanAbort.signal,
        onText: (d) => { acc += d; $("cleanOut").textContent = (base ? base + "\n\n" : "") + acc; },
      });
      s.clean.parts.push(acc.trim());
      await persist(s);
    }
    s.clean.done = true;
    await persist(s);
    await snapshot(s, "clean");
    await idbPut("sessions", s);
    $("cleanProgress").textContent = "";
    toast("整形が完了しました");
  } catch (e) {
    $("cleanProgress").textContent = `${claudeError(e)}（もう一度押すと続きから再開します）`;
  } finally {
    setBusy("clean", false);
    renderClean();
  }
}

const SUMMARY_PROMPTS = {
  minutes: `以下の会話の議事録を作成してください。見出しは「## 概要」「## 話し合われたこと」「## 決定事項」「## ToDo」「## 要確認事項」とし、該当がない見出しには「なし」と書いてください。ToDo には担当者・期限が会話中にあれば併記してください。会話にない内容を補わないでください。`,
  summary: `以下の会話の要点を、重要な順に5〜10個の箇条書きでまとめてください。最初に1〜2文の全体要約を書いてください。会話にない内容を補わないでください。`,
  todo: `以下の会話から、誰かがやると言ったこと・頼まれたこと・次回までの宿題を漏れなく抽出し、「- [担当] 内容（期限）」の形式で箇条書きにしてください。担当や期限が不明なら「不明」と書いてください。該当がなければ「なし」とだけ書いてください。`,
};
function sourceText(s) {
  return s.clean.done && s.clean.segCount === s.segments.length ? s.clean.parts.join("\n\n") : rawText(s);
}

let summaryAbort = null;
async function runSummary() {
  const s = cur;
  if (!s.segments.length) return toast("文字起こしがまだありません");
  const kind = $("summaryKind").value;
  summaryAbort = new AbortController();
  setBusy("summary", true);
  $("summaryProgress").textContent = "作成中…";
  let acc = "";
  try {
    await claudeStream({
      system: "あなたは会議や会話の記録を正確にまとめるアシスタントです。文字起こしは音声認識由来で誤認識を含む可能性があります。",
      content: `${SUMMARY_PROMPTS[kind]}\n\n<transcript>\n${sourceText(s)}\n</transcript>`,
      signal: summaryAbort.signal,
      onText: (d) => { acc += d; $("summaryOut").innerHTML = md(acc); },
    });
    s.summary = { kind, text: acc.trim(), at: Date.now() };
    await persist(s);
    await snapshot(s, "summary");
    await idbPut("sessions", s);
    $("summaryProgress").textContent = "";
  } catch (e) {
    $("summaryProgress").textContent = claudeError(e);
  } finally {
    setBusy("summary", false);
  }
}

async function runAsk() {
  const s = cur;
  const q = $("askInput").value.trim();
  if (!q) return;
  if (!s.segments.length) return toast("文字起こしがまだありません");
  $("askBtn").disabled = true;
  const item = { q, a: "", at: Date.now() };
  s.qa.unshift(item);
  renderQa();
  try {
    await claudeStream({
      system: "あなたは会話の記録について質問に答えるアシスタントです。記録に書かれていることだけを根拠に、簡潔に日本語で答えてください。該当箇所があればタイムスタンプ [mm:ss] を添えてください。記録から分からないことは「記録からは分かりません」と答えてください。",
      // 記録部分はキャッシュし、同じ記録への2回目以降の質問を安く速くする
      content: [
        { type: "text", text: `<transcript>\n${sourceText(s)}\n</transcript>`, cache_control: { type: "ephemeral" } },
        { type: "text", text: `質問: ${q}` },
      ],
      maxTokens: 8000,
      onText: (d) => { item.a += d; renderQa(); },
    });
    $("askInput").value = "";
  } catch (e) {
    item.a = `（${claudeError(e)}）`;
  } finally {
    $("askBtn").disabled = false;
    renderQa();
    await persist(s);
  }
}

function setBusy(kind, on) {
  $(`${kind}Btn`).disabled = on;
  $(`${kind}Stop`).hidden = !on;
}
async function persist(s) {
  s.updatedAt = Date.now();
  await idbPut("sessions", s);
}

/* ---------------- 画面 ---------------- */
let cur = null; // 詳細表示中の記録

function showView(name) {
  for (const v of ["home", "rec", "detail"]) $(`view-${v}`).hidden = v !== name;
  $("backBtn").hidden = name !== "detail";
  $("settingsBtn").hidden = name === "rec";
  $("barTitle").textContent = name === "rec" ? "録音中" : name === "detail" ? "記録" : "Claude文字起こし";
  window.scrollTo(0, 0);
}

async function renderHome() {
  showView("home");
  $("hintBackup").textContent = settings.backupMin;
  const all = (await idbAll("sessions")).sort((a, b) => b.createdAt - a.createdAt);
  const ul = $("sessionList");
  ul.innerHTML = all.length ? "" : `<li class="empty">まだ記録はありません</li>`;
  for (const s of all) {
    const li = document.createElement("li");
    const tag = s.status === "interrupted" ? `<span class="tag warn">中断</span>`
      : s.summary?.text ? `<span class="tag ok">要約済</span>` : s.clean?.done ? `<span class="tag ok">整形済</span>` : "";
    li.innerHTML = `<button><span class="t"></span><span class="m">${hms(s.durationMs)} ・ ${charCount(s).toLocaleString()}文字${tag}</span></button>`;
    li.querySelector(".t").textContent = s.title;
    li.firstChild.onclick = () => openDetail(s.id);
    ul.append(li);
  }
  const interrupted = all.filter((s) => s.status === "interrupted");
  const b = $("recoverBanner");
  b.hidden = !interrupted.length;
  if (interrupted.length) {
    const s = interrupted[0];
    b.innerHTML = `<strong>前回の録音が途中で終了しました。</strong><br>「<span></span>」は ${hms(s.durationMs)} まで保存されています。<div class="row"><button class="small primary" data-a="resume">続きを録音</button><button class="small" data-a="open">開く</button></div>`;
    b.querySelector("span").textContent = s.title;
    b.querySelector('[data-a="resume"]').onclick = () => startRecording(s);
    b.querySelector('[data-a="open"]').onclick = () => openDetail(s.id);
  }
}

async function openDetail(id) {
  cur = await idbGet("sessions", id);
  if (!cur) return renderHome();
  cur.clean ??= { parts: [], segCount: 0, done: false };
  cur.summary ??= { kind: "", text: "" };
  cur.qa ??= [];
  showView("detail");
  $("titleInput").value = cur.title;
  $("detailMeta").innerHTML = `<span>${dateLabel(cur.createdAt)}</span><span>${hms(cur.durationMs)}</span><span>${charCount(cur).toLocaleString()}文字</span>`
    + (cur.audioChunks ? `<span>音声あり</span>` : "");
  $("exportAudioBtn").disabled = !cur.audioChunks;
  $("shareBtn").hidden = !navigator.share;
  $("rawOut").innerHTML = cur.segments.length
    ? cur.segments.map((g) => `<p class="seg"><time>${stamp(g.t)}</time><span>${esc(g.text)}</span></p>`).join("")
    : `<p class="empty">文字起こしはありません</p>`;
  renderClean();
  $("summaryOut").innerHTML = cur.summary.text ? md(cur.summary.text) : "";
  if (cur.summary.kind) $("summaryKind").value = cur.summary.kind;
  $("cleanProgress").textContent = "";
  $("summaryProgress").textContent = "";
  renderQa();
  renderBackups();
  selectTab("raw");
}

function renderClean() {
  const c = cur.clean;
  const stale = c.parts.length && c.segCount !== cur.segments.length;
  $("cleanOut").textContent = c.parts.join("\n\n");
  $("cleanBtn").textContent = c.done && !stale ? "整形し直す" : c.parts.length && !stale ? "続きから整形" : "Claudeで整形";
  if (stale) $("cleanProgress").textContent = "録音が追加されたため、整形し直すと最新の内容になります";
  if (c.done && !stale && $("cleanBtn").textContent === "整形し直す") {
    $("cleanBtn").onclick = () => { cur.clean = { parts: [], segCount: 0, done: false }; runClean(); };
  } else $("cleanBtn").onclick = runClean;
}
function renderQa() {
  $("qaOut").innerHTML = cur.qa.map((x) => `<div class="qa"><div class="q">Q. ${esc(x.q)}</div><div class="out">${esc(x.a || "考え中…")}</div></div>`).join("");
}
async function renderBackups() {
  const list = (await idbByIndex("backups", cur.id)).sort((a, b) => b.savedAt - a.savedAt);
  const label = { auto: "自動", start: "開始時", stop: "停止時", clean: "整形後", summary: "要約後", manual: "手動", restore: "復元前" };
  const box = $("backupList");
  box.innerHTML = list.length ? "" : `<p class="empty">バックアップはまだありません</p>`;
  for (const b of list) {
    const row = document.createElement("div");
    row.className = "bk";
    row.innerHTML = `<span>${dateLabel(b.savedAt)}:${pad(new Date(b.savedAt).getSeconds())} <span class="tag">${label[b.reason] || b.reason}</span><br><small class="hint">${b.segCount}文 ・ ${b.chars.toLocaleString()}文字</small></span><button class="small">この時点に戻す</button>`;
    row.querySelector("button").onclick = async () => {
      if (!confirm("この時点の内容に戻しますか？（現在の内容もバックアップとして残ります）")) return;
      await snapshot(cur, "restore");
      const restored = { ...b.data, id: cur.id, audioChunks: cur.audioChunks, audioRuns: cur.audioRuns, lastBackupAt: cur.lastBackupAt, status: "stopped" };
      await idbPut("sessions", restored);
      toast("復元しました");
      openDetail(cur.id);
    };
    box.append(row);
  }
}

function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

function sessionText(s) {
  const parts = [`${s.title}`, `${dateLabel(s.createdAt)} ／ 録音時間 ${hms(s.durationMs)}`, ""];
  if (s.summary?.text) parts.push("■ 要約", s.summary.text, "");
  if (s.clean?.parts?.length) parts.push("■ 整形済み", s.clean.parts.join("\n\n"), "");
  parts.push("■ 文字起こし（原文）", rawText(s));
  return parts.join("\n");
}

async function audioBlobs(s) {
  const chunks = (await idbByIndex("audio", s.id)).sort((a, b) => a.seq - b.seq);
  const runs = new Map();
  for (const c of chunks) {
    if (!runs.has(c.run)) runs.set(c.run, { mime: c.mime, parts: [] });
    runs.get(c.run).parts.push(c.blob);
  }
  return [...runs.values()].map((r, i, arr) => {
    const type = (r.mime || "audio/webm").split(";")[0];
    const ext = type.includes("mp4") ? "m4a" : "webm";
    return new File(r.parts, `${safeName(s.title)}${arr.length > 1 ? `_${i + 1}` : ""}.${ext}`, { type });
  });
}

/* ---------------- 設定ダイアログ ---------------- */
async function openSettings() {
  $("sKey").value = settings.apiKey;
  $("sModel").value = settings.model;
  $("sEffort").value = settings.effort;
  $("sLang").value = settings.lang;
  $("sBackup").value = String(settings.backupMin);
  $("sKeep").value = String(settings.keepBackups);
  $("sAudio").checked = settings.recordAudio;
  $("storageInfo").textContent = "";
  $("settingsDlg").showModal();
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $("storageInfo").textContent = `使用量 ${(usage / 1048576).toFixed(1)}MB ／ 上限の目安 ${(quota / 1073741824).toFixed(1)}GB`
      + (persisted ? " ・ 自動削除されない保存領域" : "");
  } catch {}
}
$("settingsDlg").addEventListener("close", () => {
  if ($("settingsDlg").returnValue !== "save") return;
  settings = {
    ...settings,
    apiKey: $("sKey").value.trim(), model: $("sModel").value, effort: $("sEffort").value, lang: $("sLang").value,
    backupMin: Number($("sBackup").value), keepBackups: Number($("sKeep").value), recordAudio: $("sAudio").checked,
  };
  storeSettings();
  $("hintBackup").textContent = settings.backupMin;
  toast("設定を保存しました");
});

async function exportAll() {
  const sessions = await idbAll("sessions");
  const blob = new Blob([JSON.stringify({ app: "claude-transcriber", version: 1, exportedAt: Date.now(), sessions }, null, 1)], { type: "application/json" });
  const d = new Date();
  download(blob, `transcriber-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`);
}
async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "claude-transcriber" || !Array.isArray(data.sessions)) throw new Error();
    let n = 0;
    for (const s of data.sessions) {
      if (!s.id || !Array.isArray(s.segments)) continue;
      const exists = await idbGet("sessions", s.id);
      const item = exists ? { ...s, id: uid(), title: `${s.title}（復元）` } : s;
      item.audioChunks = 0; // 音声は JSON に含まれない
      if (item.status === "recording") item.status = "stopped";
      await idbPut("sessions", item);
      n++;
    }
    toast(`${n}件を復元しました`);
    $("settingsDlg").close();
    renderHome();
  } catch {
    toast("このファイルは読み込めません");
  }
}

/* ---------------- イベント ---------------- */
$("newRecBtn").onclick = () => startRecording();
$("pauseBtn").onclick = togglePause;
$("stopBtn").onclick = stopRecording;
$("backBtn").onclick = () => { cleanAbort?.abort(); summaryAbort?.abort(); renderHome(); };
$("settingsBtn").onclick = openSettings;
$("exportAllBtn").onclick = exportAll;
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; };
document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => selectTab(b.dataset.tab); });

$("titleInput").onchange = async () => {
  cur.title = $("titleInput").value.trim() || cur.title;
  await persist(cur);
};
$("cleanStop").onclick = () => cleanAbort?.abort();
$("summaryBtn").onclick = runSummary;
$("summaryStop").onclick = () => summaryAbort?.abort();
$("askBtn").onclick = runAsk;
$("backupNowBtn").onclick = async () => { await snapshot(cur, "manual"); await persist(cur); renderBackups(); toast("バックアップしました"); };
$("resumeBtn").onclick = () => startRecording(cur);
$("exportTxtBtn").onclick = () => download(new Blob([sessionText(cur)], { type: "text/plain;charset=utf-8" }), `${safeName(cur.title)}.txt`);
$("exportAudioBtn").onclick = async () => {
  const files = await audioBlobs(cur);
  if (!files.length) return toast("音声は保存されていません");
  files.forEach((f) => download(f, f.name));
};
$("shareBtn").onclick = async () => {
  const txt = new File([sessionText(cur)], `${safeName(cur.title)}.txt`, { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [txt] })) await navigator.share({ files: [txt], title: cur.title });
    else await navigator.share({ title: cur.title, text: sessionText(cur) });
  } catch {}
};
$("deleteBtn").onclick = async () => {
  if (!confirm(`「${cur.title}」を削除しますか？ バックアップと音声も削除され、元に戻せません。`)) return;
  await idbDel("sessions", cur.id);
  await idbDelByIndex("backups", cur.id);
  await idbDelByIndex("audio", cur.id);
  toast("削除しました");
  renderHome();
};
document.querySelectorAll("[data-copy]").forEach((b) => {
  b.onclick = async () => {
    const kind = b.dataset.copy;
    const text = kind === "raw" ? rawText(cur) : kind === "clean" ? cur.clean.parts.join("\n\n") : cur.summary.text;
    try { await navigator.clipboard.writeText(text); toast("コピーしました"); } catch { toast("コピーできませんでした"); }
  };
});

/* ---------------- 起動 ---------------- */
(async function init() {
  // 録音中のままアプリが終了した記録は「中断」として扱い、続きから録音できるようにする
  for (const s of await idbAll("sessions")) {
    if (s.status === "recording") { s.status = "interrupted"; await idbPut("sessions", s); }
  }
  if (!SR) {
    const b = $("supportBanner");
    b.hidden = false;
    b.textContent = "このブラウザは音声認識に対応していません。Android は Chrome、iPhone は Safari で開いてください。";
  }
  renderHome();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
