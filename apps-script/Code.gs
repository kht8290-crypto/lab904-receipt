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

// ═══════════════════════════════════
function doPost(e) {
  try {
    var raw = (e.postData && e.postData.contents) ? e.postData.contents : '';
    if (!raw) return res({ success: false, error: 'body 없음' });

    var data = JSON.parse(raw);

    if (data.action === 'sync')   return handleSync(data);
    if (data.action === 'delete') return handleDelete(data);

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
    if (action === 'read') return handleRead();
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

  // 1. master.json 업데이트
  var master = {
    lastUpdated: Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss"),
    count: payload.length,
    receipts: payload.map(function(r) {
      var s = {};
      for (var k in r) if (k !== 'imagePreview') s[k] = r[k];
      return s;
    })
  };
  createOrReplace(dataF, 'master.json', JSON.stringify(master, null, 2), MimeType.PLAIN_TEXT);

  // 1b. 관리자 설정 저장   ★추가
  //     직원이 1명 이상일 때만 저장 → 아직 불러오기 전인 기기가 빈 설정으로 덮어쓰는 사고 방지
  if (data.settings && data.settings.employees && data.settings.employees.length > 0) {
    createOrReplace(dataF, 'settings.json', JSON.stringify(data.settings, null, 2), MimeType.PLAIN_TEXT);
  }

  // 2. 일별 백업 (오늘 백업이 없을 때만)
  var today  = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var bkName = today + '.json';
  var existing = dataF.getFoldersByName('백업').hasNext()
    ? backF.getFilesByName(bkName)
    : null;
  var hasTodayBackup = existing && existing.hasNext();
  if (!hasTodayBackup) {
    backF.createFile(bkName, JSON.stringify(master, null, 2), MimeType.PLAIN_TEXT);
    Logger.log('일별 백업 생성: ' + bkName);
    // 30일 초과 백업 삭제
    cleanOldBackups(backF, 30);
  }

  // 3. 이미지 저장
  var imgs = 0;
  payload.forEach(function(r) {
    if (r.imagePreview && r.imagePreview.indexOf('data:image') === 0) {
      try { saveImg(photoF, r.filename || ('receipt_' + r.id), r.imagePreview); imgs++; }
      catch(e) { Logger.log('이미지 저장 실패: ' + e.message); }
    }
  });

  var msg = '동기화 완료: ' + payload.length + '건, 이미지 ' + imgs + '장';
  Logger.log(msg);
  return res({ success: true, message: msg });
}

// ═══════════════════════════════════
// DELETE — master.json에서 해당 항목 제거 + 사진 삭제
function handleDelete(data) {
  var receiptId = data.receiptId;
  var filename  = data.filename;
  var year      = data.year     ? String(data.year) : String(new Date().getFullYear());
  var quarter   = data.quarter  || 2;
  var deleted   = 0;

  try {
    var rootF = DriveApp.getRootFolder().getFoldersByName(ROOT);
    if (!rootF.hasNext()) return res({ success: true, message: '폴더 없음' });
    var root = rootF.next();

    // 1. master.json에서 항목 제거
    var dataF = root.getFoldersByName('데이터');
    if (dataF.hasNext()) {
      var df = dataF.next();
      var masterFiles = df.getFilesByName('master.json');
      if (masterFiles.hasNext()) {
        var mf = masterFiles.next();
        try {
          var content = JSON.parse(mf.getBlob().getDataAsString());
          var before = content.receipts ? content.receipts.length : 0;
          content.receipts = (content.receipts || []).filter(function(r) { return r.id !== receiptId; });
          content.count = content.receipts.length;
          content.lastUpdated = Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss");
          mf.setContent(JSON.stringify(content, null, 2));
          deleted += before - content.receipts.length;
          Logger.log('master.json 항목 삭제: ' + deleted + '건');
        } catch(e) { Logger.log('master.json 파싱 오류: ' + e.message); }
      }
    }

    // 2. 사진 파일 삭제
    if (filename) {
      try {
        var photoQ = root.getFoldersByName('사진');
        if (photoQ.hasNext()) {
          var yearF = photoQ.next().getFoldersByName(year);
          if (yearF.hasNext()) {
            var qF = yearF.next().getFoldersByName('Q' + quarter + '분기');
            if (qF.hasNext()) {
              var quarterF = qF.next();
              var base = filename.replace(/\.(jpg|jpeg|png|manual|json)$/i, '');
              [filename, base+'.jpg', base+'.png', base+'.manual'].forEach(function(n) {
                var f = quarterF.getFilesByName(n);
                while (f.hasNext()) { f.next().setTrashed(true); deleted++; }
              });
            }
          }
        }
      } catch(e) { Logger.log('사진 삭제 오류: ' + e.message); }
    }
  } catch(err) {
    Logger.log('삭제 오류: ' + err.message);
  }

  return res({ success: true, message: 'Drive 삭제: ' + deleted + '건' });
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
  folder.createFile(blob);
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
