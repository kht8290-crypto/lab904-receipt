/**
 * 영수증 정리 앱 — Google Drive 동기화 (Apps Script)
 *
 * 폴더 구조:
 *   영수증정산/
 *     ├── 데이터/
 *     │   ├── master.json        ← 전체 마스터 데이터(영수증)
 *     │   ├── settings.json      ← 관리자 설정(직원/PIN/카드/프로젝트/사업자정보)  ★추가
 *     │   └── 백업/
 *     │       └── YYYYMMDD.json  ← 일별 자동 백업 (30일 후 삭제)
 *     └── 사진/
 *         └── 2026/
 *             └── Q2분기/
 *                 └── 사진파일들
 *
 * 액션:
 *   POST {action:'sync'}    → master.json + settings.json 저장 + 사진 + 백업
 *   POST {action:'delete'}  → 항목/사진 삭제
 *   GET  ?action=read       → {ok, receipts, settings} 반환  ★추가 (다기기 동기화)
 *
 * ※ 코드 수정 후 반드시 "배포 > 배포 관리 > 편집(연필) > 새 버전 > 배포" 해야 반영됩니다.
 */

const ROOT = '영수증정산';

// 앱 CATEGORIES와 동일 (클라이언트가 목록을 안 보낼 때의 기본값)
const DEFAULT_CATEGORIES = '복리후생비, 접대비, 교육훈련비, 여비교통비, 유류비, 차량유지비, '
  + '통신비, 소모품비, 도서인쇄비, 임차료, 공과금, 광고선전비, 설계비, 현장조사비, 모형제작비, '
  + '감리비, 철거비, 가구·비품비, 조명기구비, 마감재비, 전기공사비, 설비공사비, 외주비, 재료비, '
  + '외주공사비, 운반비, 수선비, 보험료, 세금과공과, 잡비';

// ═══════════════════════════════════
function doPost(e) {
  try {
    var raw = (e.postData && e.postData.contents) ? e.postData.contents : '';
    if (!raw) return res({ success: false, error: 'body 없음' });

    var data = JSON.parse(raw);

    if (data.action === 'sync')           return handleSync(data);
    if (data.action === 'delete')         return handleDelete(data);
    if (data.action === 'cleanupPhotos')  return handleCleanupPhotos(data);   // ★추가: 사진 폴더 정리
    if (data.action === 'syncSettings')   return handleSyncSettings(data);   // ★추가
    if (data.action === 'extractReceipt') return handleExtractReceipt(data); // ★추가: 사진→금액
    if (data.action === 'setCards')       return handleSetCards(data);       // ★추가: 카드 전체번호 저장

    return res({ success: false, error: '알 수 없는 액션: ' + data.action });
  } catch(err) {
    Logger.log('doPost 오류: ' + err.message);
    return res({ success: false, error: err.message });
  }
}

// ★추가: GET ?action=read 로 데이터/설정을 내려줌 (모바일 등 다른 기기에서 불러오기)
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
    if (action === 'read')     return checkToken(e.parameter.tk) ? handleRead() : res({ ok:false, error:'토큰 필요' });
    if (action === 'image')    return handleImage(e.parameter);     // ★추가: 사진/썸네일 내려주기
    if (action === 'classify') return handleClassify(e.parameter);  // ★추가: AI 계정과목 분류
  } catch(err) {
    Logger.log('doGet 오류: ' + err.message);
    return res({ ok: false, error: err.message });
  }
  return ContentService
    .createTextOutput('영수증 정리 앱 연동 정상 작동 중 ✓')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ═══════════════════════════════════
// READ — master.json(영수증) + settings.json(설정) 반환   ★추가
function handleRead() {
  var receipts = [];
  var settings = null;

  var rootArr = DriveApp.getRootFolder().getFoldersByName(ROOT);
  if (rootArr.hasNext()) {
    var root = rootArr.next();
    var dataArr = root.getFoldersByName('데이터');
    if (dataArr.hasNext()) {
      var df = dataArr.next();

      var mf = df.getFilesByName('master.json');
      if (mf.hasNext()) {
        try {
          var m = JSON.parse(mf.next().getBlob().getDataAsString());
          receipts = m.receipts || [];
        } catch(e) { Logger.log('master.json 읽기 오류: ' + e.message); }
      }

      var sf = df.getFilesByName('settings.json');
      if (sf.hasNext()) {
        try {
          settings = JSON.parse(sf.next().getBlob().getDataAsString());
        } catch(e) { Logger.log('settings.json 읽기 오류: ' + e.message); }
      }
    }
  }

  return res({ ok: true, receipts: receipts, settings: settings });
}

// ═══════════════════════════════════
// IMAGE — 사진 파일을 base64 data URL로 반환 (thumb=1이면 작은 썸네일)   ★추가
function handleImage(p) {
  var filename = p.filename || '';
  var wantThumb = (p.thumb === '1' || p.thumb === 'true');
  var file = null;

  // ① fileId로 직접 조회 (master.json의 driveFileId — 가장 정확)
  if (p.fileId) {
    try {
      var f = DriveApp.getFileById(p.fileId);
      if (f && !f.isTrashed()) file = f;
    } catch(e) {}
  }

  // ② 파일명 탐색 폴백
  if (!file) {
    if (!filename) return res({ ok: false, error: 'filename 없음' });
    var rootArr = DriveApp.getRootFolder().getFoldersByName(ROOT);
    if (!rootArr.hasNext()) return res({ ok: false, error: '폴더 없음' });
    var root = rootArr.next();
    var photoArr = root.getFoldersByName('사진');
    if (!photoArr.hasNext()) return res({ ok: false, error: '사진 폴더 없음' });
    // 확장자 변형 후보 (.png/.jpg/.jpeg/.svg+xml + 원본)
    var base = filename.replace(/\.(jpg|jpeg|png|manual|json|svg\+xml|svg)$/i, '');
    var candidates = [filename, base + '.png', base + '.jpg', base + '.jpeg', base + '.svg+xml'];
    // 사진 트리 전체를 재귀 탐색 (분기 폴더 위치가 달라도 찾음)
    file = findImageFile(photoArr.next(), candidates);
  }
  if (!file) return res({ ok: false, error: '이미지 없음' });

  try {
    var blob;
    if (wantThumb) {
      var th = file.getThumbnail();      // 드라이브 자동 썸네일 (작음). 아직 없으면 null
      blob = th ? th : file.getBlob();   // 썸네일 없으면 원본으로 폴백
    } else {
      blob = file.getBlob();
    }
    var dataUrl = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
    return res({ ok: true, image: dataUrl });
  } catch(e) {
    return res({ ok: false, error: e.message });
  }
}

// 폴더 트리에서 후보 이름의 파일을 재귀로 찾기
function findImageFile(folder, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var fi = folder.getFilesByName(candidates[i]);
    if (fi.hasNext()) return fi.next();
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (sub.getName() === '휴지통') continue;   // 삭제 보관 폴더는 건너뜀
    var found = findImageFile(sub, candidates);
    if (found) return found;
  }
  return null;
}

// 삭제 사진을 '분기폴더/휴지통'으로 이동 (Drive 기본 휴지통이 아니라 폴더에 보관)
function moveToTrashFolder(file) {
  try {
    var parents = file.getParents();
    var parent = parents.hasNext() ? parents.next() : null;
    if (!parent) { file.setTrashed(true); return; }   // 부모 못 찾으면 안전하게 Drive 휴지통
    if (parent.getName() === '휴지통') return;          // 이미 휴지통 폴더에 있음
    var trashF = getOrCreate(parent, '휴지통');
    file.moveTo(trashF);
  } catch(e) { Logger.log('휴지통 이동 실패: ' + e.message); try { file.setTrashed(true); } catch(e2){} }
}

// ═══════════════════════════════════
// CLASSIFY — Claude Haiku로 영수증 용도 → 계정과목 자동 분류   ★추가
// API 키는 Script Properties(ANTHROPIC_API_KEY)에 저장 — 외부 노출 안 됨
function handleClassify(p) {
  var text = (p.text || '').toString().slice(0, 200);
  if (!text) return res({ ok: false, error: 'text 없음' });

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return res({ ok: false, error: 'API 키 미설정(Script Properties의 ANTHROPIC_API_KEY)' });

  // 계정과목 목록: 클라이언트가 cats(| 구분)로 보내면 그걸 사용 (앱 CATEGORIES와 항상 동기화)
  var categories = p.cats ? p.cats.split('|').join(', ') : DEFAULT_CATEGORIES;
  var sys = '당신은 한국 세무 회계 전문가입니다. 영수증 용도(매장명/내역)를 보고 계정과목을 분류해주세요.\n'
          + '계정과목 목록: ' + categories + '\n'
          + 'JSON으로만 응답 (마크다운 없이): {"primary":"계정과목명","alternatives":["대안1","대안2"],"confidence":0~100,"reason":"한 문장"}';

  var payload = {
    model: 'claude-sonnet-4-6',   // 분류 정확도 향상 (사진 추출과 동일 모델로 통일)
    max_tokens: 200,
    system: sys,
    messages: [{ role: 'user', content: '용도: "' + text + '"' }]
  };

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data.error) return res({ ok: false, error: (data.error.message || 'API 오류') });

    var rawText = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    var parsed;
    try {
      var cjs = rawText.indexOf('{'), cje = rawText.lastIndexOf('}');
      parsed = JSON.parse(rawText.substring(cjs, cje + 1));
    } catch(e) {
      parsed = { primary: '소모품비', alternatives: [], confidence: 50, reason: '분류 실패' };
    }
    return res({ ok: true, result: parsed });
  } catch(e) {
    return res({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════
// EXTRACT RECEIPT — Claude Haiku 비전으로 영수증 사진에서 금액 추출   ★추가
function handleExtractReceipt(data) {
  var img = data.imageBase64 || '';
  var mediaType = data.mediaType || 'image/jpeg';
  if (!img) return res({ ok: false, error: '이미지 없음' });

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return res({ ok: false, error: 'API 키 미설정(ANTHROPIC_API_KEY)' });

  // 계정과목 목록: 클라이언트가 보낸 categories를 우선 사용 (앱 CATEGORIES와 항상 동기화)
  var categories = (data.categories && data.categories.length)
    ? (Array.isArray(data.categories) ? data.categories.join(', ') : String(data.categories))
    : DEFAULT_CATEGORIES;
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var yyyy = today.slice(0,4), yy = today.slice(2,4);
  var prompt = '이 영수증/카드전표 사진을 분석해 아래 항목을 추출하세요. 확실하지 않으면 해당 값을 null로 하세요.\n'
    + '- amount: 총 결제 금액(원, 정수). 부가세 포함 최종 결제액\n'
    + '- date: 결제일을 YYYY-MM-DD로 변환. 오늘은 ' + today + '(올해 ' + yyyy + '년)이고 영수증 날짜는 대개 올해이거나 최근. '
    + '날짜가 2자리-2자리-2자리(예 "26-02-24")면 YY-MM-DD 또는 DD-MM-YY 순서일 수 있음 — '
    + '세 숫자 중 연도는 올해 끝두자리(' + yy + ')와 같거나 가장 가까운 두자리이고, 가운데는 항상 월(01~12), 나머지가 일. 이를 추론해 올바른 순서로 변환. '
    + '예) 오늘이 ' + yyyy + '년이면 "' + yy + '-02-24"→' + yyyy + '-02-24(YY-MM-DD), "24-02-' + yy + '"→' + yyyy + '-02-24(DD-MM-YY). 절대 ' + yy + '를 일/월로 오인하지 말 것\n'
    + '- store: 상호명/가맹점명(짧게)\n'
    + '- payType: "card"(신용/체크카드) | "cash"(현금) | "transfer"(계좌이체) 중 하나\n'
    + '- card1,card2,card3,card4: 카드번호를 앞에서부터 4자리씩 4개 그룹으로 읽으세요. '
    + '그 그룹의 4자리가 모두 또렷이 보이면 그 4자리(문자열), 한 자리라도 가려졌으면(★●*x 공백 등) null. '
    + '예) "4140-0328-8546-****" → card1:"4140",card2:"0328",card3:"8546",card4:null. '
    + '"4265-86★★-★★★★-8889" → card1:"4265",card2:null,card3:null,card4:"8889". 카드결제 아니면 모두 null\n'
    + '- category: 계정과목, 다음 중 하나만 → ' + categories + '\n'
    + '- voucherType: "card_slip"(신용카드매출전표) | "cash_rcpt"(현금영수증) | "tax_inv"(세금계산서) | "statement"(계산서) | "simple"(간이영수증) 중 하나\n'
    + '반드시 아래 형식의 JSON 객체 하나만 출력하세요. 설명·문장·코드블록 절대 금지: '
    + '{"amount":정수|null,"date":"YYYY-MM-DD"|null,"store":문자열|null,"payType":문자열|null,"card1":문자열|null,"card2":문자열|null,"card3":문자열|null,"card4":문자열|null,"category":문자열|null,"voucherType":문자열|null}';

  var payload = {
    model: 'claude-sonnet-4-6',   // 사진 OCR 정확도 향상 (계정과목 분류는 Haiku 유지)
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: img } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var d = JSON.parse(resp.getContentText());
    if (d.error) return res({ ok: false, error: (d.error.message || 'API 오류') });

    var rawText = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '';
    var parsed;
    try {
      var js = rawText.indexOf('{'), je = rawText.lastIndexOf('}');
      parsed = JSON.parse(rawText.substring(js, je + 1));   // 앞뒤 설명이 있어도 객체만 추출
    } catch(e) { return res({ ok: false, error: '파싱 실패', raw: rawText.slice(0, 200) }); }
    // ★ 서버에서 전체 카드번호로 4그룹 매칭 → 카드ID만 반환 (전체번호는 응답에 절대 안 나감)
    try { parsed.cardMatchId = matchCardGroups(parsed); } catch(e) {}
    parsed.cardLast4 = (parsed.card4 && /^[0-9]{4}$/.test(parsed.card4)) ? parsed.card4 : null;  // 클라 표시/폴백용
    // card1~4(영수증에 보이는 그룹)는 민감하지 않으므로 그대로 둠(투명성/디버깅)
    return res({ ok: true, result: parsed });
  } catch(e) {
    return res({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════
// 카드 전체번호 — Script Properties(CARD_FULL)에만 보관. 어떤 응답으로도 안 나감.   ★추가
function getCardFull(){
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('CARD_FULL') || '{}'); }
  catch(e){ return {}; }
}
// 토큰 검사 (APP_TOKEN 미설정 시 통과 — 하위호환)
function checkToken(t){
  var real = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!real) return true;
  return String(t || '') === real;
}
// 카드 전체번호 저장 (토큰 필요). data.cards = { cardId: "16자리숫자", ... }
function handleSetCards(data){
  if (!checkToken(data.token)) return res({ ok:false, error:'토큰 불일치' });
  var map = data.cards || {};
  var clean = {};
  for (var id in map){ var n = String(map[id]).replace(/[^0-9]/g,''); if (n) clean[id] = n; }
  PropertiesService.getScriptProperties().setProperty('CARD_FULL', JSON.stringify(clean));
  return res({ ok:true, count: Object.keys(clean).length });
}
// 영수증에서 읽은 4그룹(card1~4, 가려진 그룹은 null)으로 등록 카드 매칭 → 카드ID (애매하면 null)
function matchCardGroups(p){
  var full = getCardFull();
  var ids = Object.keys(full);
  if (!ids.length) return null;
  function g(v){ return (v && /^[0-9]{4}$/.test(String(v))) ? String(v) : null; }
  var rg = [ g(p.card1), g(p.card2), g(p.card3), g(p.card4) ];
  if (!rg.some(function(x){ return x; })) return null;   // 보이는 그룹이 하나도 없으면 매칭 불가
  var cand = [];
  for (var i=0;i<ids.length;i++){
    var num = full[ids[i]];
    if (!num || num.length !== 16) continue;
    var fg = [ num.slice(0,4), num.slice(4,8), num.slice(8,12), num.slice(12,16) ];
    var ok = true, score = 0;
    for (var k=0;k<4;k++){
      if (!rg[k]) continue;            // 가려진 그룹은 와일드카드
      if (rg[k] !== fg[k]){ ok = false; break; }
      score++;
    }
    if (ok && score >= 1) cand.push({ id:ids[i], score:score });
  }
  if (!cand.length) return null;
  cand.sort(function(a,b){ return b.score - a.score; });
  if (cand.length > 1 && cand[0].score === cand[1].score) return null;  // 동점=구분 불가 → 자동선택 안 함
  return cand[0].id;
}

// ═══════════════════════════════════
// SYNC SETTINGS — settings.json만 저장 (master.json은 건드리지 않음)   ★추가
function handleSyncSettings(data) {
  var s = data.settings;
  if (!s || !s.employees || !s.employees.length) {
    return res({ success: false, error: '빈 설정 — 저장 안 함' });
  }
  var rootF = getOrCreate(null,  ROOT);
  var dataF = getOrCreate(rootF, '데이터');
  createOrReplace(dataF, 'settings.json', JSON.stringify(s, null, 2), MimeType.PLAIN_TEXT);
  return res({ success: true, message: '설정 저장됨' });
}

// ═══════════════════════════════════
// SYNC — 마스터 JSON 업데이트 + 설정 저장 + 사진 저장 + 일별 백업
function handleSync(data) {
  var payload  = data.payload  || [];
  var year     = data.year     ? String(data.year) : String(new Date().getFullYear());
  var quarter  = data.quarter  || 2;

  // 폴더 구조 생성
  var rootF  = getOrCreate(null,  ROOT);
  var dataF  = getOrCreate(rootF, '데이터');
  var backF  = getOrCreate(dataF, '백업');
  var photoF = getOrCreate(getOrCreate(getOrCreate(rootF, '사진'), year), 'Q' + quarter + '분기');

  // 기존 master 읽기: id→filename(rename 판단용) + 기존 영수증 전체(병합용)
  var prevNames = {};
  var existingRecs = [];
  try {
    var pmf = dataF.getFilesByName('master.json');
    if (pmf.hasNext()) {
      var pm = JSON.parse(pmf.next().getBlob().getDataAsString());
      existingRecs = pm.receipts || [];
      existingRecs.forEach(function(r) { if (r.id) prevNames[r.id] = r.filename; });
    }
  } catch(e) {}

  // 0. 이미지 처리 + 영수증↔사진 파일ID 인덱싱
  //    - 신규 이미지: 저장 후 파일ID 기록
  //    - 기존 이미지(수정): 파일명이 '실제로' 바뀐 경우에만 Drive 파일명 rename(고아 방지)
  //    - 레거시(파일ID 없음): 파일명으로 찾아 파일ID 백필
  var imgs = 0;
  var idToFileId = {};
  payload.forEach(function(r) {
    if (r.imagePreview && r.imagePreview.indexOf('data:image') === 0) {
      try {
        var fid = saveImg(photoF, r.filename || ('receipt_' + r.id), r.imagePreview);
        if (fid) {
          // 사진 교체(수정): 이전 파일이 다른 파일이면 분기폴더/휴지통으로 이동(고아 방지)
          if (r.driveFileId && r.driveFileId !== fid) {
            try {
              var oldF = DriveApp.getFileById(r.driveFileId);
              if (oldF && !oldF.isTrashed()) moveToTrashFolder(oldF);
            } catch(e2) {}
          }
          idToFileId[r.id] = fid;
        }
        imgs++;
      } catch(e) { Logger.log('이미지 저장 실패: ' + e.message); }
    } else if (r.driveFileId) {
      idToFileId[r.id] = r.driveFileId;
      // 파일명이 실제로 바뀐 경우에만 Drive 호출(매 동기화 불필요한 호출 방지)
      if (r.filename && prevNames[r.id] && prevNames[r.id] !== r.filename) {
        try { DriveApp.getFileById(r.driveFileId).setName(r.filename); }
        catch(e) { Logger.log('파일명 동기화 실패: ' + e.message); }
      }
    } else if (r.filename) {
      try {
        var found = findPhotoByName(rootF, r.filename);
        if (found) idToFileId[r.id] = found.getId();   // 레거시 백필
      } catch(e) {}
    }
  });

  // 1. master.json 업데이트 (imagePreview 제외, driveFileId 부여 = 영수증↔사진 매칭 데이터)
  //    ★ id 기준 병합: 들어온 영수증(우선) + 기존 master에만 있던 영수증(보존).
  //      다기기에서 한 기기가 목록 전체를 덮어써 다른 기기의 영수증이 사라지는 사고 방지.
  //      (삭제는 handleDelete가 별도로 master에서 제거하므로 병합과 충돌하지 않음)
  var incoming = payload.map(function(r) {
    var s = {};
    for (var k in r) if (k !== 'imagePreview') s[k] = r[k];
    if (idToFileId[r.id]) s.driveFileId = idToFileId[r.id];
    return s;
  });
  var mergedById = {};
  existingRecs.forEach(function(r) { if (r && r.id) mergedById[r.id] = r; });   // 기존 보존
  incoming.forEach(function(r) { if (r && r.id) mergedById[r.id] = r; });        // 들어온 것 우선
  var mergedReceipts = Object.keys(mergedById).map(function(k) { return mergedById[k]; });
  var master = {
    lastUpdated: Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss"),
    count: mergedReceipts.length,
    receipts: mergedReceipts
  };
  // ★안전장치: 영수증이 1건 이상일 때만 master.json 덮어쓰기 (빈 배열로 전체 삭제되는 사고 방지)
  if (payload.length > 0) {
    createOrReplace(dataF, 'master.json', JSON.stringify(master, null, 2), MimeType.PLAIN_TEXT);
  }

  // 1b. 관리자 설정 저장   ★추가
  //     직원이 1명 이상일 때만 저장 → 아직 불러오기 전인 기기가 빈 설정으로 덮어쓰는 사고 방지
  if (data.settings && data.settings.employees && data.settings.employees.length > 0) {
    createOrReplace(dataF, 'settings.json', JSON.stringify(data.settings, null, 2), MimeType.PLAIN_TEXT);
  }

  // 2. 일별 백업 (오늘 백업이 없을 때만) + 월별 영구 백업(유실 방지)
  var today  = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var bkName = today + '.json';
  var existing = dataF.getFoldersByName('백업').hasNext()
    ? backF.getFilesByName(bkName)
    : null;
  var hasTodayBackup = existing && existing.hasNext();
  if (payload.length > 0) {
    if (!hasTodayBackup) {
      backF.createFile(bkName, JSON.stringify(master, null, 2), MimeType.PLAIN_TEXT);
      Logger.log('일별 백업 생성: ' + bkName);
      cleanOldBackups(backF, 30);   // 30일 초과 '일별' 백업만 삭제(월별은 안 건드림)
    }
    // 월별 영구 백업: 백업/월별/YYYYMM.json — 30일 정리 대상이 아님. 데이터 영구 보존용.
    try {
      var monthDir = getOrCreate(backF, '월별');
      var ym = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMM');
      createOrReplace(monthDir, ym + '.json', JSON.stringify(master, null, 2), MimeType.PLAIN_TEXT);
    } catch(e) { Logger.log('월별 백업 실패: ' + e.message); }
  }

  // 4. 인테리어 프로젝트별 JSON (데이터/프로젝트별/) — 세부분류·공정분류 합계 미리 계산(차후 계산용)
  try {
    var projs = (data.settings && data.settings.projects) || null;
    if (!projs) {
      var sf2 = dataF.getFilesByName('settings.json');
      if (sf2.hasNext()) projs = (JSON.parse(sf2.next().getBlob().getDataAsString()).projects) || [];
    }
    var interiors = (projs || []).filter(function(p) { return p.type === 'interior'; });
    if (interiors.length && payload.length) {
      var projDir = getOrCreate(dataF, '프로젝트별');
      interiors.forEach(function(p) {
        var rs = master.receipts.filter(function(r) { return r.project === p.id; });
        if (!rs.length) return;
        var bySub = {}, byProc = {};
        rs.forEach(function(r) {
          var sk = r.subCat || '미분류';     bySub[sk]  = (bySub[sk]  || 0) + (r.amount || 0);
          var pk = r.processCat || '미분류'; byProc[pk] = (byProc[pk] || 0) + (r.amount || 0);
        });
        var doc = {
          projectId: p.id,
          projectName: p.name,
          lastUpdated: master.lastUpdated,
          count: rs.length,
          total: rs.reduce(function(s, r) { return s + (r.amount || 0); }, 0),
          budgetTotal: p.budgetTotal || null,
          budgetByProcess: p.budgetByProcess || {},
          totals: { bySubCat: bySub, byProcess: byProc },
          receipts: rs
        };
        var safeName = String(p.name).replace(/[\\/:*?"<>|]/g, '_');
        createOrReplace(projDir, safeName + '_' + p.id + '.json', JSON.stringify(doc, null, 2), MimeType.PLAIN_TEXT);
      });
    }
  } catch(e) { Logger.log('프로젝트별 JSON 생성 실패: ' + e.message); }

  var msg = '동기화 완료: ' + payload.length + '건, 이미지 ' + imgs + '장';
  Logger.log(msg);
  return res({ success: true, message: msg });
}

// ═══════════════════════════════════
// DELETE — master.json에서 해당 항목 제거 + 사진 삭제
function handleDelete(data) {
  var receiptId = data.receiptId;
  var filename  = data.filename;
  var removed   = 0;   // master.json에서 제거된 건수
  var trashed   = 0;   // 휴지통으로 옮긴 사진 수

  try {
    var rootF = DriveApp.getRootFolder().getFoldersByName(ROOT);
    if (!rootF.hasNext()) return res({ success: true, message: '폴더 없음' });
    var root = rootF.next();

    // 1. master.json에서 항목 제거 + 그 영수증의 driveFileId/filename 확보
    var driveFileId = null;
    var dataF = root.getFoldersByName('데이터');
    if (dataF.hasNext()) {
      var df = dataF.next();
      var masterFiles = df.getFilesByName('master.json');
      if (masterFiles.hasNext()) {
        var mf = masterFiles.next();
        try {
          var content = JSON.parse(mf.getBlob().getDataAsString());
          var recs = content.receipts || [];
          var target = recs.filter(function(r) { return r.id === receiptId; })[0];
          if (target) {
            driveFileId = target.driveFileId || null;
            if (!filename) filename = target.filename;   // 클라이언트가 안 보냈으면 데이터 파일에서
          }
          var before = recs.length;
          content.receipts = recs.filter(function(r) { return r.id !== receiptId; });
          content.count = content.receipts.length;
          content.lastUpdated = Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss");
          mf.setContent(JSON.stringify(content, null, 2));
          removed = before - content.receipts.length;
          Logger.log('master.json 항목 삭제: ' + removed + '건');
        } catch(e) { Logger.log('master.json 파싱 오류: ' + e.message); }
      }
    }

    // 2. 사진을 '분기폴더/휴지통'으로 이동 — ① driveFileId(정확) 우선 ② 파일명 전체 재귀 검색
    if (driveFileId) {
      try {
        var f1 = DriveApp.getFileById(driveFileId);
        if (f1 && !f1.isTrashed()) { moveToTrashFolder(f1); trashed++; }
      } catch(e) { Logger.log('파일ID 이동 실패: ' + e.message); }
    }
    if (trashed === 0 && filename) {
      try {
        var f2 = findPhotoByName(root, filename);   // findPhotoByName은 휴지통 폴더 제외
        if (f2) { moveToTrashFolder(f2); trashed++; }
      } catch(e) { Logger.log('파일명 이동 실패: ' + e.message); }
    }
  } catch(err) {
    Logger.log('삭제 오류: ' + err.message);
  }

  return res({ success: true, message: '삭제 완료: 데이터 ' + removed + '건, 사진 휴지통 ' + trashed + '장' });
}

// 사진 폴더 정리(고아 사진 휴지통) — 클라이언트가 명시적으로 호출
function handleCleanupPhotos(data) {
  try {
    var rootF = DriveApp.getRootFolder().getFoldersByName(ROOT);
    if (!rootF.hasNext()) return res({ success: true, trashed: 0, message: '폴더 없음' });
    var n = reconcilePhotos(rootF.next());
    return res({ success: true, trashed: n, message: '사진 정리: 고아 ' + n + '장 휴지통' });
  } catch(e) {
    return res({ success: false, error: e.message });
  }
}

// ═══════════════════════════════════
// 유틸 함수들

function cleanOldBackups(backupFolder, keepDays) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  var files = backupFolder.getFiles();
  var removed = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getDateCreated() < cutoff) {
      f.setTrashed(true);
      removed++;
      Logger.log('오래된 백업 삭제: ' + f.getName());
    }
  }
  if (removed > 0) Logger.log(removed + '개 백업 삭제됨');
}

function saveImg(folder, filename, dataUrl) {
  var parts = dataUrl.split(',');
  var mime  = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  var ext   = mime.split('/')[1].replace('jpeg', 'jpg');
  var name  = filename.replace(/\.(jpg|jpeg|png|manual)$/i, '') + '.' + ext;
  var blob  = Utilities.newBlob(Utilities.base64Decode(parts[1]), mime, name);
  var ex = folder.getFilesByName(name);
  while (ex.hasNext()) ex.next().setTrashed(true);
  var created = folder.createFile(blob);
  return created.getId();   // 영수증↔사진 매칭용 파일ID 반환
}

// 사진 폴더 전체를 재귀 탐색해 파일명(확장자 변형 포함)으로 파일 찾기
function findPhotoByName(rootF, name) {
  var photoArr = rootF.getFoldersByName('사진');
  if (!photoArr.hasNext()) return null;
  return walkFindByName(photoArr.next(), name);
}
function walkFindByName(folder, name) {
  var base  = String(name).replace(/\.(jpg|jpeg|png|manual)$/i, '');
  var cands = [name, base + '.jpg', base + '.png', base + '.jpeg', base + '.manual'];
  for (var i = 0; i < cands.length; i++) {
    var f = folder.getFilesByName(cands[i]);
    if (f.hasNext()) return f.next();
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (sub.getName() === '휴지통') continue;   // 삭제 보관 폴더는 건너뜀
    var r = walkFindByName(sub, name);
    if (r) return r;
  }
  return null;
}

// 사진 폴더 정리: master.json에 없는(매칭 안 되는) 사진을 휴지통으로 — 수정/삭제로 생긴 고아 파일 정리
function reconcilePhotos(root) {
  var df = root.getFoldersByName('데이터');
  if (!df.hasNext()) return 0;
  var mf = df.next().getFilesByName('master.json');
  if (!mf.hasNext()) return 0;
  var master;
  try { master = JSON.parse(mf.next().getBlob().getDataAsString()); } catch(e) { return 0; }
  var validNames = {}, validIds = {};
  (master.receipts || []).forEach(function(r) {
    if (r.filename) {
      validNames[r.filename] = 1;
      validNames[String(r.filename).replace(/\.(jpg|jpeg|png|manual)$/i, '')] = 1;
    }
    if (r.driveFileId) validIds[r.driveFileId] = 1;
  });
  var photoArr = root.getFoldersByName('사진');
  if (!photoArr.hasNext()) return 0;
  var trashed = { n: 0 };
  walkTrashOrphans(photoArr.next(), validNames, validIds, trashed);
  return trashed.n;
}
function walkTrashOrphans(folder, validNames, validIds, acc) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.isTrashed()) continue;
    var nm = file.getName();
    var base = nm.replace(/\.(jpg|jpeg|png|manual)$/i, '');
    if (validIds[file.getId()] || validNames[nm] || validNames[base]) continue; // 매칭 → 유지
    moveToTrashFolder(file); acc.n++;                                           // 고아 → 휴지통 폴더
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (sub.getName() === '휴지통') continue;   // 휴지통 폴더는 정리 대상 아님
    walkTrashOrphans(sub, validNames, validIds, acc);
  }
}

function getOrCreate(parent, name) {
  var p = parent || DriveApp.getRootFolder();
  var f = p.getFoldersByName(name);
  return f.hasNext() ? f.next() : p.createFolder(name);
}

function createOrReplace(folder, name, content, mime) {
  var ex = folder.getFilesByName(name);
  while (ex.hasNext()) ex.next().setTrashed(true);
  folder.createFile(name, content, mime);
}

function res(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════
// 테스트 함수 (에디터에서 직접 실행)
function testSync() {
  var mock = {
    postData: {
      contents: JSON.stringify({
        action: 'sync',
        year: new Date().getFullYear(),
        quarter: 2,
        payload: [
          { id: 'test1', date: '2026-06-09', employee: '김현태', project: 'lab904',
            amount: 10000, usage: '테스트', category: '소모품비', payType: 'cash' }
        ],
        settings: { employees: ['김현태'], adminPin: '0000', projects: null, cards: null,
                    bizNumber: '', bizEmail: '', bizCert: '' }
      })
    }
  };
  Logger.log(doPost(mock).getContent());
}

function testRead() {
  Logger.log(doGet({ parameter: { action: 'read' } }).getContent());
}

function testClassify() {
  // API 키가 Script Properties에 있어야 동작
  Logger.log(doGet({ parameter: { action: 'classify', text: '스타벅스 아메리카노' } }).getContent());
}

function testImage() {
  // 썸네일 확인 (실제 파일명으로 바꿔서 테스트)
  var out = doGet({ parameter: {
    action: 'image',
    filename: '루이스네이처_2026Q2_260609_접대비_팀회식_현금.png',
    year: '2026', quarter: '2', thumb: '1'
  }}).getContent();
  Logger.log(out.length > 200 ? '썸네일 OK, 길이=' + out.length : out);
}

function testDelete() {
  var mock = {
    postData: {
      contents: JSON.stringify({
        action: 'delete',
        receiptId: 'test1',
        filename: 'test_receipt.jpg',
        year: 2026,
        quarter: 2
      })
    }
  };
  Logger.log(doPost(mock).getContent());
}
