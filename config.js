/* ============================================================
   RP 주임단 워크숍 현장 페이지 공통 설정
   아래 세 줄만 고치면 됩니다.
   ============================================================ */

// 1) Apps Script 웹 앱 URL (https://script.google.com/macros/s/…/exec)
const ENDPOINT = "https://script.google.com/macros/s/AKfycbzOa0B3IuK-BJUpEl-rAK9Zvi96asE3xf8gu6FdecvvTppu_hHt6GzP_x6QVFSNdlS4TQ/exec";

// 2) 조 개수 (Code_현장.gs 맨 위 TEAMS와 같게)
const TEAMS = 10;

// 3) 한 조가 올릴 수 있는 사진 수
const MAX_PHOTOS = 3;

/* ---------- 아래는 고치지 않아도 됩니다 ---------- */
const SITE = "https://richncohckim-bot.github.io/27jd-workshop/";
const PARAMS = new URLSearchParams(location.search);
const SIM = PARAMS.has("sim");                       // ?sim=1 → 리허설 모드
const LIVE = !SIM && ENDPOINT.startsWith("https://");

function pageUrl(file) {
  const u = new URL(file, location.protocol.startsWith("http") ? location.href : SITE);
  u.search = SIM ? "?sim=1" : "";
  return u.href;
}

let _deviceId = null;
function deviceId() {
  if (_deviceId) return _deviceId;
  try {
    _deviceId = localStorage.getItem("rpws-id");
    if (!_deviceId) {
      _deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("rpws-id", _deviceId);
    }
  } catch (e) {
    _deviceId = "anon-" + Math.random().toString(36).slice(2);
  }
  return _deviceId;
}

function store(key, value) {
  if (SIM) key = "sim:" + key;   // 리허설 기록이 실제 응답 상태와 섞이지 않게
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { return null; }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 본문을 text/plain으로 보내 Apps Script CORS 사전 요청을 피합니다.
async function api(payload) {
  if (SIM) return Sim.post(payload);
  const res = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload) });
  return res.json();
}

async function apiGet(params) {
  if (SIM) return Sim.get(params);
  const q = new URLSearchParams(params).toString();
  const res = await fetch(ENDPOINT + "?" + q);
  return res.json();
}

function setupNotice() {
  const n = document.getElementById("notice");
  if (!n) return;
  if (SIM) {
    n.innerHTML = "<b>리허설 모드</b> · 실제로 저장되지 않고 이 브라우저 안에서만 진행 화면과 연결됩니다.";
    n.hidden = false;
  } else if (!LIVE) {
    n.innerHTML = "<b>설정 필요</b> · config.js의 ENDPOINT에 Apps Script 웹 앱 URL을 넣어야 저장됩니다. 주소 끝에 <b>?sim=1</b>을 붙이면 리허설 모드로 써 볼 수 있습니다.";
    n.hidden = false;
  }
}

/* ============================================================
   리허설 모드 저장소 — Apps Script와 같은 응답 모양을 흉내 냅니다.
   같은 브라우저의 다른 탭(진행 화면 ↔ 참석자 페이지)과 localStorage로 공유됩니다.
   ============================================================ */
const Sim = {
  KEY: "rpws-sim-v1",
  mem: null,
  empty() { return { photos: [], pledges: [], surveys: [], cases: [] }; },
  load() {
    try { const d = JSON.parse(localStorage.getItem(this.KEY) || "null"); if (d) { d.cases = d.cases || []; return d; } } catch (e) {}
    return this.mem || this.empty();
  },
  save(d) {
    try { localStorage.setItem(this.KEY, JSON.stringify(d)); this.mem = null; }
    catch (e) {
      // 용량이 넘치면 오래된 사진부터 가벼운 대체 이미지로 바꿉니다.
      d.photos.forEach((p, i) => { if (i < d.photos.length - 6) p.data = ""; });
      try { localStorage.setItem(this.KEY, JSON.stringify(d)); } catch (e2) { this.mem = d; }
    }
  },
  reset() { try { localStorage.removeItem(this.KEY); } catch (e) {} this.mem = null; },
  wait() { return new Promise(r => setTimeout(r, 250 + Math.random() * 450)); },
  shrink(dataUrl) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 1000 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.6));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  },
  activePhotos(d, team) { return d.photos.filter(p => p.team === team && !p.state); },
  async post(p) {
    await this.wait();
    const d = this.load();
    if (p.kind === "photo") {
      const team = parseInt(p.team, 10);
      if (!(team >= 1 && team <= TEAMS)) return { ok: false, error: "bad team" };
      const act = this.activePhotos(d, team);
      if (p.replace) act.forEach(x => { x.state = "교체됨"; x.data = ""; });
      else if (act.length >= MAX_PHOTOS) return { ok: false, error: "full", count: act.length };
      const data = p.simData || await this.shrink(p.data);
      d.photos.push({ team, data, state: "", time: Date.now(), id: p.id });
      this.save(d);
      return { ok: true, count: this.activePhotos(d, team).length };
    }
    if (p.kind === "pledge") {
      const text = String(p.text || "").trim().slice(0, 80);
      if (text.length < 2) return { ok: false, error: "empty" };
      const row = { id: p.id, team: parseInt(p.team, 10) || "", name: String(p.name || "").slice(0, 10), text, time: Date.now() };
      const i = d.pledges.findIndex(x => x.id === p.id);
      if (i >= 0) d.pledges[i] = row; else d.pledges.push(row);
      this.save(d);
      return { ok: true };
    }
    if (p.kind === "survey") {
      const i = d.surveys.findIndex(x => x.id === p.id);
      const row = { id: p.id, row: p.row, time: Date.now() };
      if (i >= 0) d.surveys[i] = row; else d.surveys.push(row);
      this.save(d);
      return { ok: true };
    }
    if (p.kind === "case") {
      // 우수 사례 제출: 리허설에서는 첨부 파일 내용 없이 이름만 남깁니다.
      if (!String(p.branch || "").trim() || !String(p.name || "").trim()) return { ok: false, error: "missing" };
      d.cases.push({ id: p.id, branch: p.branch, name: p.name, title: p.title || "", files: (p.files || []).map(f => f.name), time: Date.now() });
      this.save(d);
      return { ok: true };
    }
    if (p.kind === "cleanup") { this.reset(); return { ok: true }; }
    return { ok: false, error: "unknown kind" };
  },
  async get(q) {
    await this.wait();
    const d = this.load();
    if (q.type === "ping") return { ok: true, time: new Date().toISOString(), sim: true };
    if (q.type === "status") {
      const photos = {};
      d.photos.filter(p => !p.state).forEach(p => { photos[p.team] = (photos[p.team] || 0) + 1; });
      return { ok: true, photos, pledges: d.pledges.length, surveys: d.surveys.length, cases: (d.cases || []).length };
    }
    if (q.type === "pledges") return { ok: true, items: d.pledges.map((p, i) => ({ id: "s" + i + "-" + p.time, team: p.team, name: p.name, text: p.text })) };
    if (q.type === "photos") {
      const team = parseInt(q.team, 10);
      return { ok: true, items: this.activePhotos(d, team).map(p => ({ data: p.data || Sim.placeholder(team) })) };
    }
    if (q.type === "surveys") return { ok: true, items: d.surveys.map(s => s.row) };
    return { ok: false, error: "unknown type" };
  },
  placeholder(team) {
    const c = document.createElement("canvas"); c.width = 800; c.height = 500;
    const g = c.getContext("2d");
    g.fillStyle = "#EFEDE7"; g.fillRect(0, 0, 800, 500);
    g.fillStyle = "#8A8780"; g.font = "36px sans-serif"; g.textAlign = "center";
    g.fillText(team + "조 사진 (리허설 용량 초과로 생략)", 400, 260);
    return c.toDataURL("image/jpeg", 0.7);
  }
};
