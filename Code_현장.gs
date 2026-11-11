/**
 * RP 주임단 워크숍 현장용 Apps Script
 * - 조별 결과 사진(photo.html) → 구글 드라이브 폴더 + "사진" 탭
 * - 한줄다짐(pledge.html)      → "한줄다짐" 탭
 * - 만족도 조사(feedback.html) → "만족도" 탭
 * - 우수 사례 제출(submit.html) → "우수사례" 탭 + 구글 드라이브 폴더(제출자별)
 * - 진행 화면(screen.html)이 GET으로 현황·사진·다짐을 읽어 갑니다.
 *
 * 사용법: 새 구글 시트 → 확장 프로그램 → Apps Script → 이 코드 붙여 넣기 → 저장
 *        → 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자) → URL을 config.js에 입력
 */

const TEAMS = 10;            // config.js와 같게
const MAX_PHOTOS = 3;        // config.js와 같게
const FOLDER_NAME = 'RP 주임단 워크숍_조별 사진';
const TAB = { photo: '사진', pledge: '한줄다짐', survey: '만족도', case: '우수사례' };
const CASE_FOLDER = 'RP 주임단 워크숍_우수사례 자료';
const CASE_MAX_FILES = 5;
const CASE_HEADERS = ['응답ID', '제출시각', '지점명', '이름', '담당 업무/근무 기간', '발표 제목',
  '1. 힘들었던 점', '2. 해 본 것', '3. 달라진 점', '4. 동료에게 한마디', '첨부 파일', '첨부 폴더'];

/* ---------------- 저장 (POST) ---------------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.kind === 'photo') return json_(savePhoto_(p));
    if (p.kind === 'pledge') return json_(savePledge_(p));
    if (p.kind === 'survey') return json_(saveSurvey_(p));
    if (p.kind === 'case') return json_(saveCase_(p));
    if (p.kind === 'cleanup') return json_(cleanupTests_());
    return json_({ ok: false, error: 'unknown kind' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function savePhoto_(p) {
  const team = parseInt(p.team, 10);
  if (!(team >= 1 && team <= TEAMS)) return { ok: false, error: 'bad team' };
  const m = String(p.data || '').match(/^data:image\/(jpeg|png);base64,(.+)$/);
  if (!m) return { ok: false, error: 'bad image' };
  if (m[2].length > 8 * 1024 * 1024) return { ok: false, error: 'too large' };

  const sh = sheet_(TAB.photo, ['시각', '조', '파일ID', '파일명', '상태', '기기']);
  const rows = activePhotoRows_(sh, team);

  if (p.replace) {
    rows.forEach(r => {
      sh.getRange(r.row, 5).setValue('교체됨');
      try { DriveApp.getFileById(r.fileId).setTrashed(true); } catch (e) {}
    });
  } else if (rows.length >= MAX_PHOTOS) {
    return { ok: false, error: 'full', count: rows.length };
  }

  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'HHmmss');
  const name = team + '조_' + stamp + '.' + (m[1] === 'png' ? 'png' : 'jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], name);
  const file = folder_().createFile(blob);
  sh.appendRow([new Date(), team, file.getId(), name, '', String(p.id || '').slice(0, 64)]);
  return { ok: true, count: (p.replace ? 0 : rows.length) + 1 };
}

function savePledge_(p) {
  const text = String(p.text || '').trim().slice(0, 80);
  if (text.length < 2) return { ok: false, error: 'empty' };
  const id = String(p.id || '').slice(0, 64);
  const team = parseInt(p.team, 10);
  const values = [id, new Date(), team >= 1 && team <= TEAMS ? team : '', String(p.name || '').trim().slice(0, 10), text, ''];
  const sh = sheet_(TAB.pledge, ['기기', '시각', '조', '이름', '다짐', '숨김(Y)']);
  const row = findRow_(sh, 1, id);
  if (row && id) {
    const hiddenFlag = sh.getRange(row, 6).getValue();
    values[5] = hiddenFlag;
    sh.getRange(row, 1, 1, values.length).setValues([values]);
  } else {
    sh.appendRow(values);
  }
  return { ok: true };
}

function saveSurvey_(p) {
  const id = String(p.id || '').slice(0, 64);
  const row = p.row || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TAB.survey);
  if (!sh) sh = ss.insertSheet(TAB.survey);

  const keys = ['응답ID', '제출시각'].concat(Object.keys(row));
  let headers = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  const missing = keys.filter(k => headers.indexOf(k) === -1);
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  const values = headers.map(h => h === '응답ID' ? id : h === '제출시각' ? new Date() : (row[h] == null ? '' : String(row[h]).slice(0, 1000)));
  const existing = id ? findRow_(sh, 1, id) : 0;
  if (existing) sh.getRange(existing, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);
  return { ok: true };
}

/* 우수 사례 제출: 같은 사람이 다시 내면 행이 하나 더 쌓입니다(가장 아래 행이 최신본). */
function saveCase_(p) {
  const s = (k, n) => cell_(String(p[k] || '').trim().slice(0, n || 3000));
  if (!s('branch') || !s('name')) return { ok: false, error: 'missing' };
  const files = (Array.isArray(p.files) ? p.files : []).slice(0, CASE_MAX_FILES).filter(f => f && f.data);
  const links = [];
  let folderUrl = '';
  if (files.length) {
    const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MMdd_HHmm');
    const folder = folderNamed_(CASE_FOLDER).createFolder(s('branch', 40) + '_' + s('name', 20) + '_' + stamp);
    files.forEach(f => {
      const blob = Utilities.newBlob(Utilities.base64Decode(String(f.data)), String(f.type || 'application/octet-stream'), String(f.name || 'file').slice(0, 120));
      const file = folder.createFile(blob);
      links.push(file.getName() + '\n' + file.getUrl());
    });
    folderUrl = folder.getUrl();
  }
  const sh = sheet_(TAB.case, CASE_HEADERS);
  sh.appendRow([String(p.id || '').slice(0, 64), new Date(), s('branch', 40), s('name', 20), s('role', 100), s('title', 100),
    s('q1'), s('q2'), s('q3'), s('q4'), links.join('\n'), folderUrl]);
  return { ok: true };
}

/* ---------------- 조회 (GET) ---------------- */
function doGet(e) {
  const type = (e && e.parameter && e.parameter.type) || 'status';
  try {
    if (type === 'ping') return json_({ ok: true, time: new Date().toISOString() });
    if (type === 'status') return json_(status_());
    if (type === 'pledges') return json_({ ok: true, items: pledges_() });
    if (type === 'photos') return json_({ ok: true, items: photos_(parseInt(e.parameter.team, 10)) });
    return json_({ ok: false, error: 'unknown type' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function status_() {
  const photos = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.photo);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
      if (r[4]) return;
      photos[r[1]] = (photos[r[1]] || 0) + 1;
    });
  }
  return { ok: true, photos: photos, pledges: pledges_().length, surveys: count_(TAB.survey) };
}

function pledges_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.pledge);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
    .filter(r => r[4] && String(r[5]).toUpperCase() !== 'Y')
    .map((r, i) => ({ id: i + 2, team: r[2], name: r[3], text: r[4] }));
}

function photos_(team) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.photo);
  if (!sh || !(team >= 1)) return [];
  return activePhotoRows_(sh, team).map(r => {
    try {
      const blob = DriveApp.getFileById(r.fileId).getBlob();
      return { name: r.name, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
    } catch (e) { return null; }
  }).filter(Boolean);
}

/* 연결 점검(check.html)이 남긴 TEST- 행을 지웁니다. 실제 응답에는 손대지 않습니다. */
function cleanupTests_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = { ok: true, photos: 0, pledges: 0, surveys: 0, cases: 0 };
  const ph = ss.getSheetByName(TAB.photo);
  if (ph && ph.getLastRow() > 1) {
    ph.getRange(2, 1, ph.getLastRow() - 1, 6).getValues().forEach((r, i) => {
      if (String(r[5]).indexOf('TEST-') === 0 && !r[4]) {
        ph.getRange(i + 2, 5).setValue('테스트삭제');
        try { DriveApp.getFileById(r[2]).setTrashed(true); } catch (e) {}
        out.photos++;
      }
    });
  }
  [[TAB.pledge, 'pledges'], [TAB.survey, 'surveys'], [TAB.case, 'cases']].forEach(([name, key]) => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]).indexOf('TEST-') === 0) { sh.deleteRow(i + 2); out[key]++; }
    }
  });
  return out;
}

/* ---------------- 도우미 ---------------- */
function activePhotoRows_(sh, team) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .map((r, i) => ({ row: i + 2, team: r[1], fileId: r[2], name: r[3], state: r[4] }))
    .filter(r => Number(r.team) === team && !r.state);
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRow_(sh, col, value) {
  if (!value || sh.getLastRow() < 2) return 0;
  const vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === value) return i + 2;
  return 0;
}

function count_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  return sh ? Math.max(0, sh.getLastRow() - 1) : 0;
}

function folder_() { return folderNamed_(FOLDER_NAME); }

function folderNamed_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/* =, +, -, @로 시작하는 글은 시트가 수식으로 읽지 않게 막습니다. */
function cell_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* 행사 전에 한 번 실행해 권한을 승인하고 탭·폴더를 미리 만듭니다. */
function setup() {
  sheet_(TAB.photo, ['시각', '조', '파일ID', '파일명', '상태', '기기']);
  sheet_(TAB.pledge, ['기기', '시각', '조', '이름', '다짐', '숨김(Y)']);
  sheet_(TAB.case, CASE_HEADERS);
  folder_();
  folderNamed_(CASE_FOLDER);
}
