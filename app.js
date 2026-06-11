// ══ STORAGE ══
const DB_KEY='receipt_db_v1', PROJ_KEY='projects_v1', CARD_KEY='cards_v1';

// localStorage 차단 시 메모리 저장으로 자동 전환 (모바일 쿠키 차단 대응)
var _memStore = {};
var store = (function(){
  try {
    localStorage.setItem('__chk__','1');
    localStorage.removeItem('__chk__');
    return localStorage;
  } catch(e) {
    return {
      getItem: function(k){ return _memStore[k]||null; },
      setItem: function(k,v){ _memStore[k]=v; },
      removeItem: function(k){ delete _memStore[k]; }
    };
  }
})();

// ── 설정 변경 시 드라이브로 자동 동기화 (디바운스) ──
// 아래 키들이 바뀌면 1.5초 뒤 settings.json만 업로드 (개별 함수 수정 없이 한 곳에서 커버)
var SYNCED_SETTING_KEYS = ['employees_v1','admin_pin_v1','projects_v1','cards_v1','biz_number_v1','biz_email_v1','biz_cert_v1'];
var _settingsPushTimer = null;
var _suppressSettingsPush = false;   // 드라이브에서 불러오는 중엔 되쏘기 방지
store = (function(orig){
  return {
    getItem:    function(k){ return orig.getItem(k); },
    setItem:    function(k,v){
      orig.setItem(k,v);
      if (!_suppressSettingsPush && SYNCED_SETTING_KEYS.indexOf(k) !== -1) scheduleSettingsPush();
    },
    removeItem: function(k){ orig.removeItem(k); }
  };
})(store);
function scheduleSettingsPush(){
  clearTimeout(_settingsPushTimer);
  _settingsPushTimer = setTimeout(function(){ try { pushSettings(); } catch(e){} }, 1500);
}

// ── IndexedDB 이미지 저장소 (용량 무제한)
var _imgDB = null;
var _imgMemory = {};
function openImgDB() {
  return new Promise(function(resolve) {
    if (_imgDB) { resolve(_imgDB); return; }
    try {
      var req = indexedDB.open('receipt_images', 1);
      req.onupgradeneeded = function(e) { e.target.result.createObjectStore('images'); };
      req.onsuccess = function(e) { _imgDB = e.target.result; resolve(_imgDB); };
      req.onerror = function() { resolve(null); };
    } catch(e) { resolve(null); }
  });
}
function saveImage(receiptId, dataUrl) {
  if (!dataUrl) return;
  _imgMemory[receiptId] = dataUrl;
  openImgDB().then(function(db) {
    if (!db) return;
    try { db.transaction('images','readwrite').objectStore('images').put(dataUrl, receiptId); } catch(e) {}
  });
}
function loadImage(receiptId) {
  if (_imgMemory[receiptId]) return Promise.resolve(_imgMemory[receiptId]);
  return openImgDB().then(function(db) {
    if (!db) return Promise.resolve(null);
    return new Promise(function(resolve) {
      try {
        var req = db.transaction('images','readonly').objectStore('images').get(receiptId);
        req.onsuccess = function() { if (req.result) _imgMemory[receiptId]=req.result; resolve(req.result||null); };
        req.onerror = function() { resolve(null); };
      } catch(e) { resolve(null); }
    });
  });
}
function deleteImage(receiptId) {
  delete _imgMemory[receiptId];
  delete _thumbMemory[receiptId];
  openImgDB().then(function(db) {
    if (!db) return;
    try {
      var os = db.transaction('images','readwrite').objectStore('images');
      os.delete(receiptId);
      os.delete(receiptId + ':thumb');
    } catch(e) {}
  });
}

// ── 드라이브에서 사진 받아오기 (다른 기기에서 올린 사진을 표시) ──
var _thumbMemory = {};

// 범용 IndexedDB get/put (썸네일은 'id:thumb' 키 사용)
function loadFromIDB(key){
  return openImgDB().then(function(db){
    if (!db) return null;
    return new Promise(function(resolve){
      try {
        var req = db.transaction('images','readonly').objectStore('images').get(key);
        req.onsuccess = function(){ resolve(req.result || null); };
        req.onerror   = function(){ resolve(null); };
      } catch(e){ resolve(null); }
    });
  });
}
function saveToIDB(key, val){
  openImgDB().then(function(db){
    if (!db) return;
    try { db.transaction('images','readwrite').objectStore('images').put(val, key); } catch(e){}
  });
}

function getQYForReceipt(r){
  var y = new Date().getFullYear(), q = 2;
  try { y = new Date(r.date).getFullYear(); q = getQuarter(r.date); } catch(e){}
  return { y:y, q:q };
}

// Apps Script ?action=image 로 사진(opts.thumb면 썸네일)을 data URL로 받음 (실패 시 null)
async function fetchImageFromDrive(r, opts){
  opts = opts || {};
  var scriptUrl = getAppsScriptUrl();
  if (!scriptUrl || !r || !r.filename) return null;
  var qy = getQYForReceipt(r);
  var url = scriptUrl + '?action=image&filename=' + encodeURIComponent(r.filename)
          + '&year=' + qy.y + '&quarter=' + qy.q
          + (opts.thumb ? '&thumb=1' : '') + '&t=' + Date.now();
  try {
    var res  = await fetch(url);
    var data = await res.json();
    if (data && data.ok && data.image) return data.image;
  } catch(e){}
  return null;
}

// 썸네일 로드: 메모리 → 로컬 풀이미지(있으면 그대로) → IndexedDB(id:thumb) → 드라이브 썸네일
// PC처럼 풀이미지를 이미 가진 기기는 드라이브를 안 거치고, 모바일만 작은 썸네일을 받음
function loadThumb(r){
  var id = r.id;
  if (_thumbMemory[id]) return Promise.resolve(_thumbMemory[id]);
  if (_imgMemory[id])   return Promise.resolve(_imgMemory[id]);
  return loadFromIDB(id + ':thumb').then(function(t){
    if (t){ _thumbMemory[id] = t; return t; }
    return loadFromIDB(id).then(function(full){
      if (full){ _imgMemory[id] = full; return full; }
      return fetchImageFromDrive(r, { thumb:true }).then(function(img){
        if (img){ _thumbMemory[id] = img; saveToIDB(id + ':thumb', img); }
        return img;
      });
    });
  });
}

// 풀이미지 로드: 메모리 → IndexedDB(id) → 드라이브 풀이미지 (상세보기용)
function loadFullImage(r){
  var id = r.id;
  if (_imgMemory[id]) return Promise.resolve(_imgMemory[id]);
  return loadFromIDB(id).then(function(local){
    if (local){ _imgMemory[id] = local; return local; }
    return fetchImageFromDrive(r, { thumb:false }).then(function(img){
      if (img){ saveImage(id, img); }   // 메모리+IndexedDB 캐시
      return img;
    });
  });
}
function loadDB(){
  try {
    const data = JSON.parse(store.getItem(DB_KEY)||'[]');
    // 기존에 imagePreview 저장된 경우 제거해서 용량 확보
    const hasBig = data.some(function(r){ return r.imagePreview && r.imagePreview.length > 100; });
    if (hasBig) {
      const slim = data.map(function(r){ const s = Object.assign({}, r); s.imagePreview = null; return s; });
      try { store.setItem(DB_KEY, JSON.stringify(slim)); } catch(e) {}
      return slim;
    }
    return data;
  } catch(e) { return []; }
}
function saveDB(d){
  // imagePreview 제외하고 저장 (사진은 Drive에만 보관)
  const slim = d.map(function(r){ const s = Object.assign({}, r); s.imagePreview = null; return s; });
  try {
    store.setItem(DB_KEY, JSON.stringify(slim));
  } catch(e) {
    // 용량 초과시 최근 50건만 유지
    try {
      store.setItem(DB_KEY, JSON.stringify(slim.slice(0, 50)));
    } catch(e2) { console.error('saveDB failed', e2); }
  }
}
function loadProjects(){
  try{const p=JSON.parse(store.getItem(PROJ_KEY));if(p&&p.length)return p}catch{}
  return[
    {id:'lab904',name:'lab904',icon:'🎨',color:'#2145F0',completed:false},
    {id:'louis',name:'루이스네이처',icon:'🌿',color:'#12B981',completed:false},
    {id:'fractal',name:'프랙탈노이즈',icon:'🌀',color:'#F97316',completed:false},
    {id:'interior',name:'인테리어 A동',icon:'🏠',color:'#7C3AED',completed:false},
  ];
}
function saveProjects(p){store.setItem(PROJ_KEY,JSON.stringify(p))}
function loadCards(){
  try{const c=JSON.parse(store.getItem(CARD_KEY));if(c&&c.length)return c}catch{}
  return[
    {id:'shinhan',name:'신한카드',color:'#0059B8'},
    {id:'kookmin',name:'국민카드',color:'#DE2626'},
    {id:'samsung',name:'삼성카드',color:'#1A1A1A'},
  ];
}
function saveCards(c){store.setItem(CARD_KEY,JSON.stringify(c))}

let receipts=loadDB(), projects=loadProjects(), cards=loadCards();

const CATEGORIES=[
  // 인건비·복지
  '복리후생비','접대비','교육훈련비',
  // 이동·차량
  '여비교통비','유류비','차량유지비',
  // 사무·운영
  '통신비','소모품비','도서인쇄비','임차료','공과금',
  // 영업·마케팅
  '광고선전비',
  // 인테리어·설계
  '설계비','현장조사비','모형제작비','감리비',
  '철거비','가구·비품비','조명기구비','마감재비','전기공사비','설비공사비',
  // 외주·공사 (일반)
  '외주비','재료비','외주공사비','운반비','수선비',
  // 기타
  '보험료','세금과공과','잡비',
];

const VOUCHER_TYPES=[
  {id:'card_slip', label:'신용카드전표', icon:'💳', vatOk:true,  payTypes:['card'],              badge:'✅ 부가세 공제 가능 — 카드전표 자동 적용'},
  {id:'cash_rcpt', label:'현금영수증',   icon:'🖨️', vatOk:true,  payTypes:['cash'],              badge:'✅ 부가세 공제 가능 — 사업자번호 발급 필수'},
  {id:'simple',    label:'간이영수증',   icon:'📄', vatOk:false, payTypes:['cash'],              badge:'⚠️ 부가세 공제 불가 — 비용 처리는 가능'},
  {id:'tax_inv',   label:'세금계산서',   icon:'🧾', vatOk:true,  payTypes:['transfer','cash'],   badge:'✅ 부가세 공제 가능 — 매입세액 환급 대상'},
  {id:'statement', label:'계산서',       icon:'📋', vatOk:false, payTypes:['transfer'],          badge:'ℹ️ 면세 거래 — 부가세 없음'},
  {id:'used_transfer',label:'이체확인증', icon:'🧾', vatOk:false, payTypes:['used'],  badge:'⚠️ 부가세 공제 불가 — 이체내역이 핵심 증빙'},
  {id:'used_chat',    label:'채팅내역',   icon:'💬', vatOk:false, payTypes:['used'],  badge:'⚠️ 이체확인증과 함께 보관 — 품목·금액 증명'},
  {id:'used_none',    label:'영수증없음', icon:'📵', vatOk:false, payTypes:['used'],  badge:'⚠️ 소명 어려움 — 최소 이체확인증 확보 필요'},
];
function getVoucherType(id){ return VOUCHER_TYPES.find(v=>v.id===id)||null; }

// 접대비 연간 한도 (중소기업 기준)
const ENTERTAINMENT_LIMIT = 12000000;


// 계정과목별 세무 아이콘
const CAT_ICON = {
  // 인건비·복지
  '복리후생비': '🍱',  // 직원 식사·회식·간식
  '접대비':     '🤝',  // 거래처 식사·접대
  '교육훈련비': '📚',  // 직원 교육·세미나·강의
  // 이동·차량
  '여비교통비': '🚆',  // 출장·택시·KTX·항공
  '유류비':     '⛽',  // 주유비·가스비
  '차량유지비': '🚗',  // 차량 보험·주차·점검
  // 사무·운영
  '통신비':     '📡',  // 전화·인터넷·구독료
  '소모품비':   '🖊️',  // 사무용 소모품
  '도서인쇄비': '📖',  // 서적·인쇄·명함·카탈로그
  '임차료':     '🏢',  // 사무실·장비 렌탈
  '공과금':     '⚡',  // 전기·수도·가스
  // 영업·마케팅
  '광고선전비': '📣',  // 마케팅·홍보물·SNS광고
  // 외주·공사
  '외주비':     '💼',  // 프리랜서·외주 용역
  '재료비':     '🧱',  // 공사 자재·부자재
  '외주공사비': '🔨',  // 협력업체 공사비
  '운반비':     '🚚',  // 자재 운송·배송
  '수선비':     '🔧',  // 시설·장비 수리
  // 기타
  '보험료':     '🛡️',  // 사업·현장·차량 보험
  '세금과공과': '🏛️',  // 협회비·면허료·부과금
  '잡비':       '💰',  // 기타 소액 지출
  // 인테리어·설계
  '설계비':     '📐',  // 설계·디자인 작업비
  '현장조사비': '🔍',  // 현장 실측·조사
  '모형제작비': '🏗️',  // 축소 모형·목업 제작
  '감리비':     '👁️',  // 공사 감리·감독
  '철거비':     '⛏️',  // 기존 구조물 철거
  '가구·비품비':'🪑',  // 인테리어 가구·비품
  '조명기구비': '💡',  // 조명 기구·설치
  '마감재비':   '🪵',  // 도배·타일·바닥재 등 마감
  '전기공사비': '🔌',  // 전기 시설 공사
  '설비공사비': '🔩',  // 배관·냉난방 설비 공사
};
function getCatIcon(cat) { return CAT_ICON[cat] || '📋'; }


// ══ UPLOAD STATE ══
let state={mode:'photo',imageFile:null,imagePreview:null,date:todayStr(),project:null,amount:'',usage:'',category:null,payType:null,card:null,voucherType:null,usedPlatform:null,usedPayer:'company',usedPayerName:'',usedSettled:false};
let aiTimer=null, screenHistory=['screen-home'], filterProj='all', filterQuery='', settleQuarter=curQuarter(), taxFilter='all';

// ══ UTILS ══
function todayStr(){return new Date().toISOString().slice(0,10)}
function yesterdayStr(){const d=new Date();d.setDate(d.getDate()-1);return d.toISOString().slice(0,10)}
function fmtDate(s){if(!s)return'';const[y,m,d]=s.split('-');return`${y.slice(2)}${m}${d}`}
function fmtDateKo(s){if(!s)return'';const[y,m,d]=s.split('-');return`${y}.${m}.${d}`}
function fmtAmount(n){return Number(n||0).toLocaleString('ko-KR')}
function getQuarter(d){return Math.ceil(parseInt((d||'').split('-')[1]||'1')/3)}
function curQuarter(){return getQuarter(todayStr())}
function getProjById(id){return projects.find(p=>p.id===id)||{name:id,color:'#aaa',icon:'📄',completed:false}}
function showToast(msg,dur=2400){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),dur)}

// ══ SCREEN NAV ══
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(screenHistory[screenHistory.length-1]!==id)screenHistory.push(id);
  if(id==='screen-home')renderHome();
  if(id==='screen-list')renderList();
  if(id==='screen-settle')renderSettle();
  if(id==='screen-settings')renderSettings();
  if(id==='screen-viewer')initViewer();
  if(id==='screen-upload')initUpload();
}
function goBack(){
  screenHistory.pop();
  const prev=screenHistory[screenHistory.length-1]||'screen-home';
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(prev).classList.add('active');
  if(prev==='screen-home')renderHome();
  if(prev==='screen-list')renderList();
}

// ══ SHEETS ══
function openSheet(title,bodyHTML){
  document.getElementById('sheet-title').textContent=title;
  document.getElementById('sheet-body').innerHTML=bodyHTML;
  document.getElementById('sheet-overlay').classList.add('show');
  document.getElementById('bottom-sheet').classList.add('show');
}
function closeSheet(){
  document.getElementById('sheet-overlay').classList.remove('show');
  document.getElementById('bottom-sheet').classList.remove('show');
}

// ── PROJECT SHEETS ──
function showAddProjectSheet(editId){
  const existing=editId?getProjById(editId):null;
  const title=editId?'프로젝트 수정':'새 프로젝트 추가';
  const ICONS=['🎨','🏠','🌿','🌀','💼','🏗️','🖥️','📸','🛠️','✨','🏢','🌊'];
  const COLORS=['#2145F0','#12B981','#F97316','#7C3AED','#EF4444','#0891B2','#EC4899','#84CC16'];
  openSheet(title,`
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <div class="form-label">아이콘</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="sheet-icon-row">
          ${ICONS.map((ic,i)=>`<span style="font-size:26px;cursor:pointer;padding:6px;border-radius:10px;border:2px solid ${existing&&existing.icon===ic?'var(--primary)':i===0&&!existing?'var(--primary)':'transparent'}" onclick="selectSheetIcon(this,'${ic}')">${ic}</span>`).join('')}
        </div>
        <input type="hidden" id="new-proj-icon" value="${existing?existing.icon:'🎨'}">
      </div>
      <div>
        <div class="form-label">프로젝트 이름 *</div>
        <input class="form-input" id="new-proj-name" placeholder="예: 인테리어 B동" value="${existing?existing.name:''}" style="margin-top:4px">
      </div>
      <div>
        <div class="form-label">설명 (선택)</div>
        <input class="form-input" id="new-proj-desc" placeholder="예: 강남구 사무실 리모델링" value="${existing&&existing.desc?existing.desc:''}" style="margin-top:4px">
      </div>
      <div>
        <div class="form-label">색상</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="sheet-color-row">
          ${COLORS.map(c=>`<div style="width:38px;height:38px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${existing&&existing.color===c?'rgba(0,0,0,.35)':c===COLORS[0]&&!existing?'rgba(0,0,0,.35)':'transparent'};transition:border-color .15s" onclick="selectSheetColor(this,'${c}')"></div>`).join('')}
        </div>
        <input type="hidden" id="new-proj-color" value="${existing?existing.color:COLORS[0]}">
      </div>
      ${editId?`
      <div style="padding:12px;background:var(--gray-50);border-radius:var(--radius-md);border:1px solid var(--gray-200)">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--gray-800)">프로젝트 상태</div>
        <div style="display:flex;gap:8px">
          <button type="button" class="btn btn-sm ${!existing.completed?'btn-primary':'btn-secondary'}" onclick="setProjectStatus('${editId}',false)">🟢 진행중</button>
          <button type="button" class="btn btn-sm ${existing.completed?'btn-danger':'btn-secondary'}" onclick="setProjectStatus('${editId}',true)">✅ 완료 처리</button>
        </div>
        <div style="font-size:11px;color:var(--gray-400);margin-top:8px">완료 처리하면 영수증 등록 화면에서 숨겨집니다</div>
      </div>`:''}
      <div style="display:flex;gap:10px;margin-top:4px">
        <button type="button" class="btn btn-primary" style="flex:1" onclick="saveProject('${editId||''}')">
          ${editId?'수정 완료':'프로젝트 생성'}
        </button>
        ${editId?`<button type="button" class="btn btn-danger btn-sm" onclick="deleteProject('${editId}')">삭제</button>`:''}
      </div>
    </div>
  `);
}

function selectSheetIcon(el,icon){
  document.querySelectorAll('#sheet-icon-row span').forEach(s=>s.style.borderColor='transparent');
  el.style.borderColor='var(--primary)';
  document.getElementById('new-proj-icon').value=icon;
}
function selectSheetColor(el,color){
  document.querySelectorAll('#sheet-color-row div').forEach(d=>d.style.borderColor='transparent');
  el.style.borderColor='rgba(0,0,0,.35)';
  document.getElementById('new-proj-color').value=color;
}

function saveProject(editId){
  const name=document.getElementById('new-proj-name').value.trim();
  if(!name){showToast('프로젝트 이름을 입력해주세요');return}
  const icon=document.getElementById('new-proj-icon').value;
  const color=document.getElementById('new-proj-color').value;
  const desc=document.getElementById('new-proj-desc').value.trim();
  if(editId){
    const i=projects.findIndex(p=>p.id===editId);
    if(i>=0){projects[i]={...projects[i],name,icon,color,desc}}
  } else {
    projects.push({id:'proj_'+Date.now(),name,icon,color,desc,completed:false});
  }
  saveProjects(projects);
  closeSheet();
  showToast(editId?`"${name}" 수정 완료 ✓`:`"${name}" 프로젝트 추가 ✓`);
  renderSettings();
}

function setProjectStatus(id,completed){
  const i=projects.findIndex(p=>p.id===id);
  if(i>=0){projects[i].completed=completed;saveProjects(projects)}
  closeSheet();
  const p=getProjById(id);
  showToast(completed?`"${p.name}" 완료 처리 — 업로드에서 숨겨집니다`:`"${p.name}" 진행중으로 변경`);
  renderSettings();
}

function deleteProject(id){
  const p=getProjById(id);
  if(!confirm(`"${p.name}" 프로젝트를 삭제할까요?\n(기존 영수증 데이터는 유지됩니다)`))return;
  projects=projects.filter(p=>p.id!==id);
  saveProjects(projects);
  closeSheet();
  showToast(`"${p.name}" 삭제 완료`);
  renderSettings();
}

// ── CARD SHEET ──
function showAddCardSheet(){
  const CCOLORS=['#0059B8','#DE2626','#1A1A1A','#0891B2','#7C3AED','#F59E0B'];
  openSheet('카드 추가',`
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <div class="form-label">카드 이름</div>
        <input class="form-input" id="new-card-name" placeholder="예: 법인 신한카드" style="margin-top:4px">
      </div>
      <div>
        <div class="form-label">카드 번호 <span style="font-size:10px;font-weight:400;color:var(--gray-400);text-transform:none">뒷 4자리만 입력 (선택)</span></div>
        <div style="position:relative;margin-top:4px">
          <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:14px;color:var(--gray-400);font-family:var(--mono);letter-spacing:2px;pointer-events:none">••••  ••••  ••••</span>
          <input class="form-input" id="new-card-number" type="text" inputmode="numeric" maxlength="4"
            placeholder="" style="padding-left:130px;font-family:var(--mono);font-size:16px;letter-spacing:3px;font-weight:700"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        </div>
      </div>
      <div>
        <div class="form-label">카드 색상</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="sheet-card-color-row">
          ${CCOLORS.map((c,i)=>`<div style="width:38px;height:38px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${i===0?'rgba(0,0,0,.35)':'transparent'}" onclick="selectSheetCardColor(this,'${c}')"></div>`).join('')}
        </div>
        <input type="hidden" id="new-card-color" value="${CCOLORS[0]}">
      </div>
      <button type="button" class="btn btn-primary" style="margin-top:4px" onclick="addCard()">카드 추가</button>
    </div>
  `);
}
function selectSheetCardColor(el,color){
  document.querySelectorAll('#sheet-card-color-row div').forEach(d=>d.style.borderColor='transparent');
  el.style.borderColor='rgba(0,0,0,.35)';
  document.getElementById('new-card-color').value=color;
}
function addCard(){
  const name=document.getElementById('new-card-name').value.trim();
  if(!name){showToast('카드 이름을 입력해주세요');return}
  const color=document.getElementById('new-card-color').value;
  const number=document.getElementById('new-card-number').value.trim();
  cards.push({id:'card_'+Date.now(),name,color,number});
  saveCards(cards);
  closeSheet();
  showToast(`"${name}" 카드가 추가되었어요 ✓`);
  renderCardChips();
  renderSettings();
}

function showEditCardSheet(id){
  const c = cards.find(c=>c.id===id);
  if(!c) return;
  const CCOLORS=['#0059B8','#DE2626','#1A1A1A','#0891B2','#7C3AED','#F59E0B'];
  openSheet('카드 수정',`
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <div class="form-label">카드 이름</div>
        <input class="form-input" id="edit-card-name" value="${c.name}" placeholder="예: 법인 신한카드" style="margin-top:4px">
      </div>
      <div>
        <div class="form-label">카드 번호 <span style="font-size:10px;font-weight:400;color:var(--gray-400);text-transform:none">뒷 4자리만 (선택)</span></div>
        <div style="position:relative;margin-top:4px">
          <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:14px;color:var(--gray-400);font-family:var(--mono);letter-spacing:2px;pointer-events:none">••••  ••••  ••••</span>
          <input class="form-input" id="edit-card-number" type="text" inputmode="numeric" maxlength="4"
            value="${c.number||''}" placeholder=""
            style="padding-left:130px;font-family:var(--mono);font-size:16px;letter-spacing:3px;font-weight:700"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4)">
        </div>
      </div>
      <div>
        <div class="form-label">카드 색상</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px" id="edit-card-color-row">
          ${CCOLORS.map(col=>`<div style="width:38px;height:38px;border-radius:50%;background:${col};cursor:pointer;border:3px solid ${col===c.color?'rgba(0,0,0,.35)':'transparent'}" onclick="selectEditCardColor(this,'${col}')"></div>`).join('')}
        </div>
        <input type="hidden" id="edit-card-color" value="${c.color}">
        <input type="hidden" id="edit-card-id" value="${id}">
      </div>
      <button type="button" class="btn btn-primary" style="margin-top:4px" onclick="saveEditCard()">저장하기</button>
      <button type="button" class="btn btn-ghost" style="color:var(--red);border-color:var(--red-light)" onclick="deleteCard('${id}','${c.name.replace(/'/g,"\\'")}');closeSheet()">이 카드 삭제하기</button>
    </div>
  `);
}

function selectEditCardColor(el, color){
  document.querySelectorAll('#edit-card-color-row div').forEach(d=>d.style.borderColor='transparent');
  el.style.borderColor='rgba(0,0,0,.35)';
  document.getElementById('edit-card-color').value=color;
}

function saveEditCard(){
  const name=document.getElementById('edit-card-name').value.trim();
  if(!name){showToast('카드 이름을 입력해주세요');return}
  const color=document.getElementById('edit-card-color').value;
  const number=document.getElementById('edit-card-number').value.trim();
  const id=document.getElementById('edit-card-id').value;
  const idx=cards.findIndex(c=>c.id===id);
  if(idx<0)return;
  cards[idx]={...cards[idx],name,color,number};
  saveCards(cards);
  closeSheet();
  showToast(`"${name}"으로 수정됐어요 ✓`);
  renderCardChips();
  renderSettings();
}

function deleteCard(id, name){
  if(!confirm(`"${name}" 카드를 삭제할까요?
이 카드로 등록된 영수증의 카드명은 유지됩니다.`)) return;
  cards=cards.filter(c=>c.id!==id);
  saveCards(cards);
  showToast(`"${name}" 카드가 삭제되었어요`);
  renderCardChips();
  renderSettings();
}

// ══ UPLOAD INIT ══
function initUpload(){
  state={mode:'photo',imageFile:null,imagePreview:null,date:todayStr(),project:null,amount:'',usage:'',category:null,payType:null,card:null,voucherType:null,usedPlatform:null,usedPayer:'company',usedPayerName:'',usedSettled:false};
  document.getElementById('upload-zone').className='upload-zone';
  document.getElementById('upload-icon').textContent='📷';
  document.getElementById('upload-icon').style.display='';
  document.getElementById('upload-text').textContent='사진을 찍거나 업로드하세요';
  document.getElementById('upload-text').style.display='';
  document.getElementById('upload-sub').textContent='JPG, PNG, HEIC 지원';
  document.getElementById('upload-sub').style.display='';
  document.getElementById('preview-img').style.display='none';
  document.getElementById('usage').value='';
  document.getElementById('amount').value='';
  document.getElementById('manual-amount').value='';
  document.getElementById('manual-store').value='';
  document.getElementById('ai-box').style.display='none';
  catExpanded=false;
  document.getElementById('filename-preview').style.display='none';
  document.getElementById('card-select-group').style.display='none';
  document.querySelectorAll('#pay-type-chips .chip').forEach(c=>c.className='chip');
  document.querySelectorAll('#date-chips .chip').forEach(c=>c.classList.remove('sel'));
  document.querySelectorAll('#date-chips .chip')[0].classList.add('sel');
  document.getElementById('custom-date').style.display='none';
  setMode('photo');
  renderProjectChips();
  renderCardChips();
  renderCategoryChips();
  renderVoucherChips();
  updateSaveBtn();
}

function setMode(m){
  state.mode=m;
  document.getElementById('mode-photo-btn').classList.toggle('active',m==='photo');
  document.getElementById('mode-manual-btn').classList.toggle('active',m==='manual');
  document.getElementById('photo-zone').style.display=m==='photo'?'block':'none';
  document.getElementById('manual-zone').style.display=m==='manual'?'block':'none';
  document.getElementById('amount-group').style.display=m==='photo'?'block':'none';
  updateFilename();updateSaveBtn();
}

// ══ FILE ══
function triggerFileInput(){if(!state.imageFile)document.getElementById('file-input').click()}
function onDragOver(e){e.preventDefault();document.getElementById('upload-zone').classList.add('drag-over')}
function onDragLeave(){document.getElementById('upload-zone').classList.remove('drag-over')}
function onDrop(e){e.preventDefault();document.getElementById('upload-zone').classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f&&f.type.startsWith('image/'))setImage(f)}
function handleFile(e){const f=e.target.files[0];if(f)setImage(f);e.target.value=''}
function setImage(file){
  state.imageFile=file;
  const r=new FileReader();
  r.onload=ev=>{
    state.imagePreview=ev.target.result;
    const zone=document.getElementById('upload-zone');
    zone.classList.add('has-image');
    ['upload-icon','upload-text','upload-sub'].forEach(id=>document.getElementById(id).style.display='none');
    const img=document.getElementById('preview-img');
    img.src=ev.target.result;img.style.display='block';
    showToast('사진이 등록되었어요 ✓');updateSaveBtn();
    extractReceiptInfo();   // 사진 등록 즉시 금액 자동 읽기
  };
  r.readAsDataURL(file);
}

// 이미지 데이터URL을 maxDim 이하로 축소 (전송 용량/비용 절감)
function downscaleDataUrl(dataUrl, maxDim, quality){
  return new Promise(function(resolve){
    try{
      const img=new Image();
      img.onload=function(){
        const w=img.width,h=img.height;
        const scale=Math.min(1, maxDim/Math.max(w,h));
        const cw=Math.max(1,Math.round(w*scale)), ch=Math.max(1,Math.round(h*scale));
        const cv=document.createElement('canvas'); cv.width=cw; cv.height=ch;
        cv.getContext('2d').drawImage(img,0,0,cw,ch);
        try{ resolve(cv.toDataURL('image/jpeg', quality||0.85)); }
        catch(e){ resolve(dataUrl); }
      };
      img.onerror=function(){ resolve(dataUrl); };
      img.src=dataUrl;
    }catch(e){ resolve(dataUrl); }
  });
}

// 영수증 사진 → Claude Haiku 비전 → 금액 자동 입력 (Apps Script 프록시)
async function extractReceiptInfo(){
  if(!state.imagePreview) return;
  const scriptUrl=getAppsScriptUrl();
  if(!scriptUrl) return;
  const amtEl=document.getElementById('amount');
  const prevPH=amtEl?amtEl.placeholder:'';
  if(amtEl && !amtEl.value){ amtEl.placeholder='💡 AI가 읽는 중...'; }
  showToast('💡 영수증 분석 중...',2500);
  try{
    const small=await downscaleDataUrl(state.imagePreview, 1200, 0.85);
    const comma=small.indexOf(',');
    const mediaType=(small.slice(5,comma).split(';')[0])||'image/jpeg';
    const b64=small.slice(comma+1);
    const res=await fetch(scriptUrl,{method:'POST',headers:{'Content-Type':'text/plain'},
      body:JSON.stringify({action:'extractReceipt',imageBase64:b64,mediaType:mediaType,categories:CATEGORIES})});
    const data=await res.json();
    if(!data||!data.ok||!data.result) throw new Error((data&&data.error)||'실패');
    const missing=applyExtractedInfo(data.result);
    if(missing.length===0) showToast('✅ 자동 입력 완료! 확인 후 저장하세요',3500);
    else showToast('⚠️ 못 읽은 항목: '+missing.join(', ')+' — 직접 선택해주세요',5000);
  }catch(e){
    showToast('영수증 분석 실패 — 직접 입력해주세요');
  }finally{
    if(amtEl){ amtEl.placeholder=prevPH||'0'; }
  }
}

// 칩 요소 찾기 (onclick에 타입 문자열 포함된 칩)
function findChipByType(containerId, type){
  return [...document.querySelectorAll('#'+containerId+' .chip')]
    .find(c => (c.getAttribute('onclick')||'').indexOf("'"+type+"'") !== -1) || null;
}

// AI가 추출한 정보를 폼에 반영. 못 채운 항목명 배열 반환
function applyExtractedInfo(r){
  r = r || {};
  const missing = [];

  // 금액
  const amtEl=document.getElementById('amount');
  if(r.amount && !isNaN(r.amount) && amtEl){ amtEl.value=Math.round(r.amount); }
  else missing.push('금액');

  // 날짜
  if(r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)){
    state.date=r.date;
    const cd=document.getElementById('custom-date');
    document.querySelectorAll('#date-chips .chip').forEach(c=>c.classList.remove('sel'));
    let dc;
    if(r.date===todayStr()){ dc=findChipByType('date-chips','today'); if(cd)cd.style.display='none'; }
    else if(r.date===yesterdayStr()){ dc=findChipByType('date-chips','yesterday'); if(cd)cd.style.display='none'; }
    else { dc=findChipByType('date-chips','custom'); if(cd){cd.style.display='block'; cd.value=r.date;} }
    if(dc) dc.classList.add('sel');
  } else missing.push('날짜');

  // 상호명 → 용도
  const usageEl=document.getElementById('usage');
  if(r.store && usageEl){ usageEl.value=r.store; state.usage=r.store; }
  else missing.push('상호명');

  // 결제수단
  if(r.payType && ['card','cash','transfer'].indexOf(r.payType)!==-1){
    const pc=findChipByType('pay-type-chips', r.payType);
    if(pc) selectPayType(r.payType, pc);
  } else missing.push('결제수단');

  // 카드 (카드결제일 때만): 뒤 4자리로 등록 카드 매칭
  if(r.payType==='card'){
    if(r.cardLast4){
      const last4=String(r.cardLast4).replace(/\D/g,'').slice(-4);
      const matched=cards.find(c=>c.number && String(c.number).slice(-4)===last4);
      if(matched) selectCard(matched.id);
      else missing.push('카드(•'+last4+' 미등록)');
    } else missing.push('카드');
  }

  // 계정과목 (유니코드 정규화로 매칭 — NFC/NFD 불일치 방지)
  const catNorm = r.category ? String(r.category).normalize('NFC') : '';
  const matchedCat = catNorm ? CATEGORIES.find(c=>c.normalize('NFC')===catNorm) : null;
  if(matchedCat){
    state.category=matchedCat;
    if(catExpanded) toggleCategoryPanel();   // 펼쳐져 있으면 닫기
    updateCatSelectedDisplay();
  } else missing.push('계정과목');

  // 증빙유형 (선택사항 — 못 읽어도 missing에 안 넣음)
  if(r.voucherType && VOUCHER_TYPES.find(v=>v.id===r.voucherType)){
    state.voucherType=r.voucherType;
    renderVoucherChips();
  }

  // 공통 갱신
  updateFilename(); updateSaveBtn(); if(typeof updateVATBox==='function') updateVATBox();
  return missing;
}

// ══ CHIPS ══
function renderProjectChips(){
  const row=document.getElementById('project-chips');
  // 완료되지 않은 프로젝트만 표시
  const active=projects.filter(p=>!p.completed);
  row.innerHTML=active.map(p=>`
    <div class="chip" data-proj="${p.id}" onclick="selectProject('${p.id}',this)"
      style="border-color:${p.id===state.project?p.color:''};background:${p.id===state.project?p.color+'22':''};color:${p.id===state.project?p.color:''}">
      ${p.icon} ${p.name}
    </div>`).join('')+
    `<div class="chip" onclick="showAddProjectSheet()" style="color:var(--primary);border-color:var(--primary);background:var(--primary-light)">+ 추가</div>`;
}
function selectProject(id,el){state.project=id;renderProjectChips();updateFilename();updateSaveBtn()}

function renderCardChips(){
  const row=document.getElementById('card-chips');
  row.innerHTML=cards.map(c=>`
    <div class="chip${state.card===c.id?' sel':''}" onclick="selectCard('${c.id}')">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.color};margin-right:5px;vertical-align:middle"></span>${c.name}${c.number?`<span style="font-family:var(--mono);font-size:10px;opacity:.6;margin-left:4px">•${c.number}</span>`:''}
    </div>`).join('');
}
function selectCard(id){state.card=id;renderCardChips();updateFilename()}

// 계정과목 그룹 정의
const CAT_GROUPS = [
  { label:'인건비·복지',   color:'#2145F0', items:['복리후생비','접대비','교육훈련비'] },
  { label:'이동·차량',     color:'#F97316', items:['여비교통비','유류비','차량유지비'] },
  { label:'사무·운영',     color:'#6C757D', items:['통신비','소모품비','도서인쇄비','임차료','공과금'] },
  { label:'영업·마케팅',   color:'#EC4899', items:['광고선전비'] },
  { label:'인테리어·설계', color:'#7C3AED', items:['설계비','현장조사비','모형제작비','감리비','철거비','가구·비품비','조명기구비','마감재비','전기공사비','설비공사비'] },
  { label:'외주·공사',     color:'#059669', items:['외주비','재료비','외주공사비','운반비','수선비'] },
  { label:'기타',          color:'#ADB5BD', items:['보험료','세금과공과','잡비'] },
];

let catExpanded = false;

function toggleCategoryPanel() {
  catExpanded = !catExpanded;
  const chips = document.getElementById('category-chips');
  if (chips) chips.style.display = catExpanded ? 'flex' : 'none';
  _refreshCatBtn();
  if (catExpanded) renderCategoryChips();
}

function _refreshCatBtn() {
  const btn = document.getElementById('cat-toggle-btn');
  if (!btn) return;
  const label = state.category ? '변경 ' : '직접 선택 ';
  const rot   = catExpanded ? 'rotate(180deg)' : '';
  const col   = catExpanded ? 'var(--primary)' : 'var(--gray-600)';
  const bc    = catExpanded ? 'var(--primary)' : 'var(--gray-200)';
  btn.innerHTML = `${label}<span style="font-size:10px;transition:transform .2s;display:inline-block;transform:${rot}">▼</span>`;
  btn.style.color       = col;
  btn.style.borderColor = bc;
}

function updateCatSelectedDisplay() {
  const icon = document.getElementById('cat-selected-icon');
  const text = document.getElementById('cat-selected-text');
  const disp = document.getElementById('cat-selected-display');
  if (!disp) return;
  if (state.category) {
    const group = CAT_GROUPS.find(g => g.items.includes(state.category));
    const ac = group ? group.color : 'var(--primary)';
    if (icon) icon.textContent = getCatIcon(state.category);
    if (text) { text.textContent = state.category; text.style.color = ac; text.style.fontWeight = '700'; }
    disp.style.borderColor = ac;
    disp.style.background  = ac + '12';
  } else {
    if (icon) icon.textContent = '📋';
    if (text) { text.textContent = 'AI가 자동 분류합니다'; text.style.color = 'var(--gray-400)'; text.style.fontWeight = '400'; }
    disp.style.borderColor = 'var(--gray-200)';
    disp.style.background  = 'var(--gray-50)';
  }
  _refreshCatBtn();
}

function renderCategoryChips(){
  const wrap = document.getElementById('category-chips');
  if (!wrap) return;
  wrap.innerHTML = CAT_GROUPS.map(g => {
    const ac = g.color || '#888';
    return `<div style="margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">
        <span style="display:inline-block;width:3px;height:10px;background:${ac};border-radius:2px;flex-shrink:0"></span>
        <span style="font-size:9px;font-weight:700;color:${ac};text-transform:uppercase;letter-spacing:.5px">${g.label}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${g.items.map(c => {
          const sel = state.category === c;
          return `<div class="chip-sm${sel?' sel':''}" onclick="selectCategory('${c}')"
            style="${sel?`border-color:${ac};background:${ac}18;color:${ac};font-weight:700`:''}"
          >${getCatIcon(c)} ${c}</div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  updateCatSelectedDisplay();
}

function selectCategory(c) {
  state.category = c;
  // 선택 즉시 닫힘
  catExpanded = false;
  const chips = document.getElementById('category-chips');
  if (chips) chips.style.display = 'none';
  updateCatSelectedDisplay();
  updateFilename();
  updateSaveBtn();
}

function selectDate(type,el){
  document.querySelectorAll('#date-chips .chip').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
  const cd=document.getElementById('custom-date');
  if(type==='today'){state.date=todayStr();cd.style.display='none'}
  else if(type==='yesterday'){state.date=yesterdayStr();cd.style.display='none'}
  else{cd.style.display='block';cd.value=state.date}
  updateFilename();
}
function onCustomDate(){state.date=document.getElementById('custom-date').value;updateFilename()}

// 하단 상세 안내용 데이터
const GUIDE_DATA = {
  pay: {
    card:     { icon:'💳', color:'var(--primary)',  rows:[
      {icon:'✅', title:'신용카드전표 자동 적용', text:'카드 결제는 별도 요청 없이 전표가 증빙이 됩니다.'},
      {icon:'💰', title:'부가세 공제 가능', text:'매입세액으로 신고해 일부 환급받을 수 있습니다.'},
      {icon:'⚠️', title:'카드 내역서 중복 주의', text:'월말 카드 내역서로 처리되므로 세무 정산 시 자동 제외됩니다.'},
      {icon:'📌', title:'법인·개인카드 구분 권장', text:'카드를 별도 등록해두면 정산이 훨씬 깔끔해집니다.'},
    ], tip:'세무사 전달 시 카드 내역서와 앱 데이터를 함께 제공하면 중복을 직접 대조할 수 있습니다.'},
    cash:     { icon:'💵', color:'var(--success)', rows:[
      {icon:'🖨️', title:'현금영수증 → 부가세 공제 가능', text:'결제 시 "사업자 지출증빙"으로 요청하세요. 사업자번호 발급 필수.'},
      {icon:'📄', title:'간이영수증 → 부가세 공제 불가', text:'일반 영수증. 비용 처리는 되지만 VAT 환급이 안 됩니다.'},
      {icon:'💡', title:'3만원 초과 거래', text:'현금영수증이나 세금계산서를 받지 않으면 소명이 어렵습니다.'},
    ], tip:'홈택스(hometax.go.kr) → 현금영수증 → 사용내역 조회에서 수신 확인 가능합니다.'},
    transfer: { icon:'🏦', color:'var(--orange)',  rows:[
      {icon:'🧾', title:'세금계산서 → 부가세 공제 가능', text:'거래처에 발급 요청. 공급일 다음 달 10일까지 수취해야 인정됩니다.'},
      {icon:'📋', title:'계산서 → 면세 거래', text:'의료·교육·농산물 등 면세 사업자와 거래 시. 부가세 없음.'},
      {icon:'📎', title:'이체 확인증만 있는 경우', text:'비용 인정이 어려울 수 있습니다. 거래처에 사후 발급을 요청하세요.'},
    ], tip:'이체 후 세금계산서를 발급하지 않는 업체는 세무 리스크가 있습니다.'},
  },
  voucher: {
    card_slip: { color:'var(--primary)', rows:[
      {icon:'📖', title:'카드 단말기 발행 전표', text:'카드 결제 시 자동 발급. 별도 보관이 필요합니다.'},
      {icon:'✅', title:'부가세 공제 가능', text:'매입세액으로 신고해 환급 가능. 법인카드 5년, 개인카드 3년 이상 보관 권장.'},
      {icon:'⚠️', title:'카드 내역서 중복 제외', text:'이 앱은 카드 항목을 세무 정산에서 자동 제외 처리합니다.'},
    ]},
    cash_rcpt: { color:'var(--success)', rows:[
      {icon:'📖', title:'사업자번호로 발급받은 현금영수증', text:'홈택스에서 실시간 조회 가능합니다.'},
      {icon:'✅', title:'부가세 공제 가능', text:'반드시 "사업자 지출증빙"으로 요청해야 합니다. "소득공제용"은 공제 안 됨.'},
      {icon:'💡', title:'홈택스 수신 확인', text:'조회/발급 → 현금영수증 → 사용내역에서 확인.'},
    ]},
    simple: { color:'var(--orange)', rows:[
      {icon:'📖', title:'식당·마트 일반 종이 영수증', text:'부가세 표시가 없는 영수증.'},
      {icon:'⚠️', title:'부가세 공제 불가', text:'비용 처리는 가능하지만 VAT 환급은 안 됩니다.'},
      {icon:'💡', title:'3만원 초과 거래 주의', text:'현금영수증이나 세금계산서를 대신 받으면 공제가 가능합니다.'},
    ]},
    tax_inv: { color:'var(--primary)', rows:[
      {icon:'📖', title:'사업자 간 거래의 핵심 증빙', text:'전자세금계산서가 일반적. 홈택스 또는 이메일로 수신.'},
      {icon:'✅', title:'부가세 공제 가능', text:'매입세액 공제로 VAT 환급 신청 가능.'},
      {icon:'⚠️', title:'수취 기한 주의', text:'공급일 다음 달 10일까지 수취해야 해당 기간 공제 인정.'},
    ]},
    statement: { color:'var(--gray-600)', rows:[
      {icon:'📖', title:'면세 사업자 발행 서류', text:'의료, 교육, 농산물, 금융 등 부가세 없는 거래.'},
      {icon:'ℹ️', title:'부가세 없음', text:'공급가액 전체가 비용으로 처리됩니다.'},
      {icon:'💡', title:'세금계산서와 구별 관리', text:'병원비, 학원비, 농수산물 구매 등이 대표적.'},
    ]},
  },
};

function buildGuideHTML(payType, voucherType) {
  let html = '';
  const pd = GUIDE_DATA.pay[payType];
  const vd = voucherType ? GUIDE_DATA.voucher[voucherType] : null;

  if (pd) {
    const title = payType==='card'?'💳 카드 결제':payType==='cash'?'💵 현금 결제':'🏦 계좌이체';
    html += `<div style="padding:10px 14px 6px;font-size:11px;font-weight:700;color:${pd.color};text-transform:uppercase;letter-spacing:.5px;background:var(--gray-50);border-bottom:1px solid var(--gray-100)">${title}</div>`;
    html += pd.rows.map(r=>`<div class="guide-row"><div class="guide-row-icon">${r.icon}</div><div class="guide-row-body"><div class="guide-row-title">${r.title}</div><div class="guide-row-text">${r.text}</div></div></div>`).join('');
    html += `<div class="guide-tip" style="background:var(--gray-50);color:${pd.color}">💡 ${pd.tip}</div>`;
  }

  if (vd && voucherType !== 'card_slip') {
    const vt = VOUCHER_TYPES.find(v=>v.id===voucherType);
    html += `<div style="padding:10px 14px 6px;font-size:11px;font-weight:700;color:${vd.color};text-transform:uppercase;letter-spacing:.5px;background:var(--gray-50);border-top:2px solid var(--gray-200);border-bottom:1px solid var(--gray-100)">${vt?vt.label:''} 상세</div>`;
    html += vd.rows.map(r=>`<div class="guide-row"><div class="guide-row-icon">${r.icon}</div><div class="guide-row-body"><div class="guide-row-title">${r.title}</div><div class="guide-row-text">${r.text}</div></div></div>`).join('');

    // 현금영수증: 사업자 등록번호 공유 카드
    if (voucherType === 'cash_rcpt') {
      const num = store.getItem('biz_number_v1') || '';
      html += `<div style="border-top:1.5px solid var(--success-light);padding:12px 14px;background:var(--success-light)">
        <div style="font-size:10px;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">사업자 지출증빙 발급 요청</div>
        <div style="display:flex;align-items:center;gap:12px;background:var(--white);border-radius:var(--radius-md);padding:12px;border:1.5px solid var(--success)">
          <div style="width:44px;height:44px;background:var(--success);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">🔢</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--gray-900)">사업자 등록번호 공유하기</div>
            <div style="font-size:11px;color:var(--gray-600);margin-top:2px">사업자 지출증빙으로 발급 요청하세요</div>
            ${num
              ? `<div style="font-size:14px;color:var(--success);font-weight:700;font-family:var(--mono);letter-spacing:1px;margin-top:4px">${num}</div>`
              : `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚙️ 설정에서 사업자 등록번호를 먼저 등록해주세요</div>`}
          </div>
          ${num
            ? `<button type="button" onclick="shareBusinessNumber()" style="height:38px;padding:0 14px;background:var(--success);color:var(--white);border:none;border-radius:var(--radius-sm);font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0">공유</button>`
            : `<button type="button" onclick="showScreen('screen-settings')" style="height:38px;padding:0 12px;background:var(--orange-light);color:var(--orange);border:1.5px solid var(--orange);border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">등록하기</button>`}
        </div>
      </div>`;
    }

    // 간이영수증: 현금영수증 전환 안내 + 사업자번호 공유 카드
    if (voucherType === 'simple') {
      const num = store.getItem('biz_number_v1') || '';
      html += `<div style="border-top:1.5px solid var(--orange-light);padding:12px 14px;background:var(--orange-light)">
        <div style="font-size:10px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">💡 현금영수증으로 바꿀 수 있어요!</div>
        <div style="font-size:11px;color:var(--orange);margin-bottom:10px;line-height:1.5">사업자 등록번호를 알려주면 현금영수증으로 전환 발급 가능합니다. 부가세 공제를 받을 수 있어요.</div>
        <div style="display:flex;align-items:center;gap:12px;background:var(--white);border-radius:var(--radius-md);padding:12px;border:1.5px solid var(--orange)">
          <div style="width:44px;height:44px;background:var(--orange);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">🔢</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--gray-900)">사업자 등록번호 공유하기</div>
            <div style="font-size:11px;color:var(--gray-600);margin-top:2px">현금영수증 전환 요청 시 알려주세요</div>
            ${num
              ? `<div style="font-size:14px;color:var(--orange);font-weight:700;font-family:var(--mono);letter-spacing:1px;margin-top:4px">${num}</div>`
              : `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚙️ 설정에서 사업자 등록번호를 먼저 등록해주세요</div>`}
          </div>
          ${num
            ? `<button type="button" onclick="shareBusinessNumber()" style="height:38px;padding:0 14px;background:var(--orange);color:var(--white);border:none;border-radius:var(--radius-sm);font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0">공유</button>`
            : `<button type="button" onclick="showScreen('screen-settings')" style="height:38px;padding:0 12px;background:var(--orange-light);color:var(--orange);border:1.5px solid var(--orange);border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">등록하기</button>`}
        </div>
      </div>`;
    }

    // 세금계산서 전용: 메일 공유 + 사업자 등록증 이미지 공유 카드
    if (voucherType === 'tax_inv') {
      const email = store.getItem('biz_email_v1') || '';
      const cert  = store.getItem('biz_cert_v1')  || '';
      const num   = store.getItem('biz_number_v1')|| '';

      html += `<div style="border-top:1.5px solid var(--primary-light);padding:12px 14px 14px;background:var(--primary-light)">
        <div style="font-size:10px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">계산서 발행 요청</div>

        <!-- ① 메일 공유 카드 -->
        <div style="display:flex;align-items:center;gap:12px;background:var(--white);border-radius:var(--radius-md);padding:12px;border:1.5px solid var(--primary);margin-bottom:8px">
          <div style="width:44px;height:44px;background:var(--primary);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">📧</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--gray-900)">사업자 등록증 메일주소 공유하기</div>
            <div style="font-size:11px;color:var(--gray-600);margin-top:2px">계산서 발행을 요청하세요</div>
            ${email
              ? `<div style="font-size:12px;color:var(--primary);font-weight:600;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${email}</div>`
              : `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚙️ 설정에서 메일주소를 먼저 등록해주세요</div>`}
          </div>
          ${email
            ? `<button type="button" onclick="shareBusinessEmail()" style="height:38px;padding:0 14px;background:var(--primary);color:var(--white);border:none;border-radius:var(--radius-sm);font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0">공유</button>`
            : `<button type="button" onclick="showScreen('screen-settings')" style="height:38px;padding:0 12px;background:var(--orange-light);color:var(--orange);border:1.5px solid var(--orange);border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">등록하기</button>`}
        </div>

        <!-- ② 사업자 등록증 이미지 + 메일 함께 공유 카드 -->
        <div style="background:var(--white);border-radius:var(--radius-md);border:1.5px solid var(--primary);overflow:hidden">
          <div style="display:flex;align-items:center;gap:12px;padding:12px">
            <div style="width:44px;height:44px;background:var(--primary);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">📋</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:700;color:var(--gray-900)">사업자 등록증 이미지 공유하기</div>
              <div style="font-size:11px;color:var(--gray-600);margin-top:2px">메일주소·사업자번호와 함께 전송</div>
              ${!cert ? `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚙️ 설정에서 등록증 이미지를 먼저 업로드해주세요</div>` : ''}
            </div>
            ${cert
              ? `<button type="button" onclick="shareWithCert()" style="height:38px;padding:0 14px;background:var(--primary);color:var(--white);border:none;border-radius:var(--radius-sm);font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0">공유</button>`
              : `<button type="button" onclick="showScreen('screen-settings')" style="height:38px;padding:0 12px;background:var(--orange-light);color:var(--orange);border:1.5px solid var(--orange);border-radius:var(--radius-sm);font-family:var(--font);font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">업로드</button>`}
          </div>
          ${cert ? `<img src="${cert}" style="width:100%;max-height:180px;object-fit:cover;display:block;border-top:1px solid var(--primary-light)">` : ''}
        </div>
      </div>`;
    }
  }
  // 중고거래 개인 선결제 안내
  if (payType === 'used' && typeof state !== 'undefined' && state.usedPayer === 'personal') {
    html += getUsedPersonalGuideHTML();
  }
  return html;
}

function selectUsedPlatform(val, el) {
  state.usedPlatform = val;
  // 클래스 + 인라인 스타일 모두 초기화
  document.querySelectorAll('#used-platform-chips .chip').forEach(c => {
    c.className = 'chip';
    c.style.borderColor = '';
    c.style.background  = '';
    c.style.color       = '';
    c.style.fontWeight  = '';
  });
  el.className        = 'chip';
  el.style.borderColor= 'var(--orange)';
  el.style.background = 'var(--orange-light)';
  el.style.color      = 'var(--orange)';
  el.style.fontWeight = '700';
  updateFilename(); updateDetailGuide();
}

function selectUsedPayer(val, el) {
  state.usedPayer = val;
  // flex/text-align 레이아웃 스타일은 유지하고 색상만 초기화
  document.querySelectorAll('#used-payer-chips .chip').forEach(c => {
    c.className         = 'chip';
    c.style.borderColor = '';
    c.style.background  = '';
    c.style.color       = '';
    c.style.fontWeight  = '';
    // 레이아웃 복원
    c.style.flex        = '1';
    c.style.textAlign   = 'center';
  });
  el.style.borderColor= 'var(--orange)';
  el.style.background = 'var(--orange-light)';
  el.style.color      = 'var(--orange)';
  el.style.fontWeight = '700';
  document.getElementById('used-personal-fields').style.display = val === 'personal' ? 'block' : 'none';
  updateDetailGuide();
}
function toggleSettled() {
  state.usedSettled = !state.usedSettled;
  const track=document.getElementById('used-settled-track');
  const thumb=document.getElementById('used-settled-thumb');
  if(track) track.style.background = state.usedSettled?'var(--success)':'var(--gray-200)';
  if(thumb) thumb.style.left = state.usedSettled?'21px':'3px';
}

// ── 중고거래 GUIDE_DATA 추가
GUIDE_DATA.pay['used'] = {
  icon:'🥕', color:'var(--orange)',
  rows:[
    {icon:'⚠️', title:'적격증빙 발급 불가', text:'당근마켓 등 개인 간 거래는 세금계산서·현금영수증 발급이 불가합니다. 부가세 공제도 없습니다.'},
    {icon:'🧾', title:'이체확인증 — 필수 보관', text:'계좌이체 시 이체확인증이 핵심 증빙입니다. 인터넷뱅킹에서 PDF로 발급 가능합니다.'},
    {icon:'💬', title:'채팅내역 스크린샷 — 강력 권장', text:'당근마켓 채팅에서 품목명·금액·거래일이 확인되는 화면을 캡처해 첨부하세요.'},
    {icon:'📸', title:'물품 사진 — 권장', text:'구매한 물품 사진을 찍어두면 업무 관련성 소명에 도움이 됩니다.'},
    {icon:'💰', title:'비용 처리는 가능', text:'적격증빙은 없지만 업무 관련성이 인정되면 경비로 처리됩니다. 부가세 공제만 안 됩니다.'},
  ],
  tip:'이체확인증 + 채팅스크린샷 + 물품사진 3종 세트를 함께 첨부하면 세무사도 소명하기 수월합니다.',
};
GUIDE_DATA.voucher['used_transfer'] = { color:'var(--orange)', rows:[
  {icon:'📖', title:'계좌이체 확인증', text:'은행 앱 → 거래내역 → 해당 이체 건 → PDF 저장. 수취인·금액·일자가 명시되어야 합니다.'},
  {icon:'✅', title:'가장 강력한 중고거래 증빙', text:'금액 지급 사실을 직접 증명합니다. 세무 조사 시 핵심 자료입니다.'},
  {icon:'💡', title:'추가 보완', text:'채팅내역 스크린샷과 물품 사진을 함께 첨부하면 완벽한 소명 자료가 됩니다.'},
]};
GUIDE_DATA.voucher['used_chat'] = { color:'var(--orange)', rows:[
  {icon:'📖', title:'거래 채팅 스크린샷', text:'품목명·협의 금액·거래 날짜가 보이는 화면을 캡처하세요.'},
  {icon:'⚠️', title:'단독으로는 증빙 부족', text:'채팅내역 단독으로는 실제 지급 증명이 안 됩니다. 이체확인증과 함께 보관해야 합니다.'},
  {icon:'💡', title:'영수증 대신 활용', text:'거래 사실과 금액을 확인하는 보조 증빙으로 활용됩니다.'},
]};
GUIDE_DATA.voucher['used_none'] = { color:'var(--red)', rows:[
  {icon:'⚠️', title:'증빙 없음 — 리스크 주의', text:'비용 인정이 매우 어렵고 세무 조사 시 소명이 힘듭니다.'},
  {icon:'🛠️', title:'최소한 이체확인증 확보', text:'은행 앱에서 거래내역을 PDF로 저장하는 것이 가능합니다. 반드시 확보하세요.'},
  {icon:'💡', title:'3만원 미만 소액의 경우', text:'3만원 미만 거래는 영수증 없이도 비용 인정이 되는 경우가 있습니다.'},
]};

// 개인 선결제 케이스 별도 처리
function getUsedPersonalGuideHTML() {
  return `<div style="background:var(--orange-light);border-top:1.5px solid var(--orange);padding:12px 14px">
    <div style="font-size:10px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">👤 개인 선결제 처리 방법</div>
    <div style="background:var(--white);border-radius:var(--radius-md);border:1.5px solid var(--orange);overflow:hidden">
      ${[
        {step:'1',text:'개인이 당근마켓에서 구매 + 이체확인증 저장'},
        {step:'2',text:'이 앱에 영수증 등록 (개인 선결제로 표시)'},
        {step:'3',text:'회사→개인 계좌로 정산 이체'},
        {step:'4',text:'정산 이체확인증도 함께 보관'},
        {step:'5',text:'지출결의서(경비정산서) 작성 후 제출'},
      ].map(s=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-bottom:1px solid var(--orange-light)">
        <div style="width:20px;height:20px;background:var(--orange);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:white;flex-shrink:0">${s.step}</div>
        <div style="font-size:12px;color:var(--gray-900);padding-top:2px">${s.text}</div>
      </div>`).join('')}
      <div style="padding:10px 12px;background:var(--orange-light);font-size:11px;color:var(--orange);font-weight:600">
        💡 지출결의서 없이 개인 정산만 하면 업무 관련성 소명이 어렵습니다
      </div>
    </div>
  </div>`;
}

// 증빙유형 미입력 목록으로 이동
function goToMissingVoucher() {
  // viewer 초기화 후 noVoucher 필터만 켜기
  initViewer();
  vFilters.noVoucher = true;

  // 상단에 "미입력 필터 중" 배너 표시
  const searchEl = document.getElementById('viewer-search');
  if (searchEl) searchEl.placeholder = '🔍 증빙유형 미입력 건 표시 중 — 초기화하려면 탭';

  // 기간 칩 업데이트
  const allBtn = document.getElementById('vp-all');
  if (allBtn) {
    allBtn.textContent = '❌ 미입력 ' + receipts.filter(r=>!r.voucherType).length + '건';
    allBtn.style.borderColor = 'var(--red)';
    allBtn.style.background  = 'var(--red-light)';
    allBtn.style.color       = 'var(--red)';
  }

  renderViewer();
  showScreen('screen-viewer');
  setTimeout(() => showToast('증빙유형 미입력 건만 표시 중 — 탭해서 수정하세요'), 400);
}

function updateDetailGuide() {
  const sec = document.getElementById('detail-guide-section');
  const content = document.getElementById('guide-content');
  if (!sec || !content) return;
  if (!state.payType) { sec.style.display='none'; return; }
  const guideHtml = buildGuideHTML(state.payType, state.voucherType);
  if (!guideHtml) { sec.style.display='none'; return; }
  content.innerHTML = guideHtml;
  sec.style.display = 'block';
}

function updateVoucherStatusLine(vt) {
  const sl = document.getElementById('voucher-status-line');
  if (!sl) return;
  if (!vt) { sl.style.display='none'; return; }
  sl.style.display = 'block';
  sl.style.background = vt.vatOk ? 'var(--success-light)' : 'var(--orange-light)';
  sl.style.color      = vt.vatOk ? 'var(--success)'      : 'var(--orange)';
  sl.textContent      = vt.vatOk ? '✅ 부가세 공제 가능 — 매입세액 공제 대상' : '⚠️ 부가세 공제 불가 — 비용 처리는 가능';
}

function renderVoucherChips(){
  const row=document.getElementById('voucher-chips');
  const group=document.getElementById('voucher-group');
  const labelEl=document.getElementById('voucher-label');
  if(!row||!group)return;

  if(!state.payType){ group.style.display='none'; return; }
  group.style.display='block';

  const sl=document.getElementById('voucher-status-line');

  if(state.payType==='card'){
    if(labelEl) labelEl.innerHTML='🧾 증빙유형';
    row.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--primary-light);border-radius:var(--radius-sm);border:1.5px solid var(--primary);width:100%">
      <span>💳</span><span style="font-size:13px;font-weight:700;color:var(--primary)">신용카드전표 자동 적용</span>
      <span style="margin-left:auto;font-size:12px;color:var(--success);font-weight:700">✅ 공제 가능</span>
    </div>`;
    if(sl) sl.style.display='none';
    return;
  }

  if(state.payType==='cash')
    if(labelEl) labelEl.innerHTML='🧾 증빙유형 <span style="font-size:10px;font-weight:400;color:var(--red);text-transform:none;letter-spacing:0">현금영수증을 받으셨나요?</span>';
  if(state.payType==='used')
    if(labelEl) labelEl.innerHTML='📎 증빙자료 <span style="font-size:10px;font-weight:400;color:var(--orange);text-transform:none;letter-spacing:0">이체확인증이 핵심입니다</span>';
  if(state.payType==='transfer')
    if(labelEl) labelEl.innerHTML='🧾 증빙유형 <span style="font-size:10px;font-weight:400;color:var(--gray-400);text-transform:none;letter-spacing:0">거래처 발급 서류 선택</span>';

  const filtered=VOUCHER_TYPES.filter(v=>v.payTypes.includes(state.payType));
  row.innerHTML=filtered.map(v=>`
    <div class="chip${state.voucherType===v.id?' sel':''}" onclick="selectVoucher('${v.id}',this)"
      style="${state.voucherType===v.id?`border-color:${v.vatOk?'var(--primary)':'var(--orange)'};background:${v.vatOk?'var(--primary-light)':'var(--orange-light)'};color:${v.vatOk?'var(--primary)':'var(--orange)'}`:''}"
    >${v.icon} ${v.label}</div>`).join('');

  // 상태 라인 업데이트
  const selVt = VOUCHER_TYPES.find(v=>v.id===state.voucherType);
  updateVoucherStatusLine(selVt||null);
}

function selectVoucher(id,el){
  state.voucherType=id;
  renderVoucherChips();
  const vt=VOUCHER_TYPES.find(v=>v.id===id);
  updateVoucherStatusLine(vt||null);
  updateDetailGuide();
  updateVATBox();
  updateFilename();
  updateSaveBtn();
}

function updateVATBox(){
  const box=document.getElementById('vat-box');
  if(!box)return;
  const vt=VOUCHER_TYPES.find(v=>v.id===state.voucherType);
  const rawAmt=state.mode==='manual'
    ?parseInt(document.getElementById('manual-amount').value||0)
    :parseInt(document.getElementById('amount').value||0);
  if(!vt||!rawAmt){box.style.display='none';return;}
  const supply=Math.round(rawAmt/1.1);
  const vat=rawAmt-supply;
  document.getElementById('vat-supply').textContent='₩'+fmtAmount(supply);
  document.getElementById('vat-amount').textContent='₩'+fmtAmount(vat);
  const badge=document.getElementById('vat-badge');
  badge.textContent=vt.badge;
  badge.style.background=vt.vatOk?'var(--success-light)':'var(--orange-light)';
  badge.style.color=vt.vatOk?'var(--success)':'var(--orange)';
  box.style.display='block';
}

function selectPayType(type,el){
  state.payType=type;
  document.querySelectorAll('#pay-type-chips .chip').forEach(c=>c.className='chip');
  el.className='chip sel';
  document.getElementById('card-select-group').style.display=type==='card'?'block':'none';
  document.getElementById('used-trade-group').style.display=type==='used'?'block':'none';
  if(type==='used'){state.voucherType=null;} // 중고거래는 별도 증빙 칩으로

  if(type==='card'){
    state.voucherType='card_slip';
  } else {
    if(state.voucherType==='card_slip') state.voucherType=null;
  }

  renderVoucherChips();
  updateDetailGuide();
  updateVATBox();
  updateFilename();
  updateSaveBtn();
}


// ══════════════════════════════════════════════
// 사용자 로그인 / 관리자 모드 / Google Drive 동기화
// ══════════════════════════════════════════════
const CURRENT_USER_KEY = 'current_user_v1';
const EMPLOYEES_KEY    = 'employees_v1';
// v20260609_fix
const APPS_SCRIPT_KEY  = 'apps_script_url_v1';
// ★ 기본 Apps Script URL (앱 코드에 내장 — 별도 설정 불필요)
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx2BABqLJYoRZbFaYvVdaXkyrYwb6fczIB6bTdBVTYtGmaxHyYBdUSPpB3NKasIy9gtGA/exec';
function getAppsScriptUrl() {
  return store.getItem(APPS_SCRIPT_KEY) || DEFAULT_APPS_SCRIPT_URL;
}
const LAST_SYNC_KEY    = 'last_sync_v1';
const ADMIN_PIN_KEY    = 'admin_pin_v1';

let currentUser = store.getItem(CURRENT_USER_KEY) || '';
let employees   = JSON.parse(store.getItem(EMPLOYEES_KEY) || '[]');

// ── 앱 시작 시 로그인 체크
function checkLogin() {
  if (!currentUser) showLoginOverlay();
  else { hideLoginOverlay(); updateUserBadge(); }
}

function showLoginOverlay() {
  const ol = document.getElementById('login-overlay');
  if (ol) ol.style.display = 'flex';
  renderLoginList();
}
function hideLoginOverlay() {
  const ol = document.getElementById('login-overlay');
  if (ol) ol.style.display = 'none';
}

function renderLoginList() {
  const list = document.getElementById('user-select-list');
  if (!list) return;
  if (!employees.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--gray-400);font-size:14px;line-height:1.7;padding:8px 0">등록된 직원이 없어요<br><span style="font-size:12px">하단 관리자 버튼으로 직원을 추가하세요</span></div>`;
    return;
  }
  list.innerHTML = employees.map(name => `
    <button type="button" onclick="loginAs('${name.replace(/'/g,"\\'")}') "
      style="width:100%;height:56px;border:1.5px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);font-family:var(--font);font-size:17px;font-weight:700;color:var(--gray-900);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px;transition:all .12s"
      onmouseover="this.style.borderColor='var(--primary)';this.style.background='var(--primary-light)';this.style.color='var(--primary)'"
      onmouseout="this.style.borderColor='var(--gray-200)';this.style.background='var(--white)';this.style.color='var(--gray-900)'">
      <span style="font-size:22px">👤</span>${name}
    </button>`).join('');
}

function loginAs(name) {
  currentUser = name;
  store.setItem(CURRENT_USER_KEY, name);
  hideLoginOverlay();
  updateUserBadge();
  renderSettings();
  showToast('안녕하세요, ' + name + '님 👋');
}

function logoutUser() {
  if (!confirm('사용자를 변경할까요?')) return;
  currentUser = '';
  store.removeItem(CURRENT_USER_KEY);
  showLoginOverlay();
}

function updateUserBadge() {
  const badge = document.getElementById('current-user-badge');
  if (!badge) return;
  if (currentUser) { badge.textContent = '👤 ' + currentUser; badge.style.display = 'block'; }
  else badge.style.display = 'none';
}

// ── 관리자 PIN 시스템
let pinBuffer = '';

function showAdminLogin() {
  const overlay = document.getElementById('admin-pin-overlay');
  if (overlay) { overlay.style.display = 'flex'; pinBuffer = ''; updatePinDots(); }
}
function closeAdminPin() {
  const overlay = document.getElementById('admin-pin-overlay');
  if (overlay) overlay.style.display = 'none';
  pinBuffer = '';
}
function pinInput(val) {
  if (val === '⌫') {
    pinBuffer = pinBuffer.slice(0, -1);
  } else if (pinBuffer.length < 4) {
    pinBuffer += val;
  }
  updatePinDots();
  if (pinBuffer.length === 4) {
    setTimeout(() => {
      const savedPin = store.getItem(ADMIN_PIN_KEY) || '0000';
      if (pinBuffer === savedPin) {
        closeAdminPin();
        openAdminPanel();
      } else {
        // 틀림 - 흔들기
        [1,2,3,4].forEach(i => {
          const d = document.getElementById('pin-dot-' + i);
          if (d) { d.style.background = 'var(--red)'; }
        });
        setTimeout(() => { pinBuffer = ''; updatePinDots(); }, 600);
        showToast('PIN이 맞지 않아요');
      }
    }, 150);
  }
}
function updatePinDots() {
  [1,2,3,4].forEach(i => {
    const d = document.getElementById('pin-dot-' + i);
    if (d) d.style.background = i <= pinBuffer.length ? 'var(--primary)' : 'var(--gray-200)';
  });
}

// ── 관리자 패널
function openAdminPanel() {
  renderAdminPanel();
  // 로그인 오버레이 임시 숨김 (z-index 충돌 방지)
  const loginOl = document.getElementById('login-overlay');
  if (loginOl) loginOl.style.display = 'none';
  document.getElementById('admin-panel-overlay').classList.add('show');
  document.getElementById('admin-panel-sheet').classList.add('show');
}
function closeAdminPanel() {
  document.getElementById('admin-panel-overlay').classList.remove('show');
  document.getElementById('admin-panel-sheet').classList.remove('show');
  // 로그인 안 된 상태면 로그인 오버레이 다시 표시
  if (!currentUser) showLoginOverlay();
}

function renderAdminPanel() {
  // 직원 목록
  const listEl = document.getElementById('admin-employee-list');
  if (listEl) {
    if (!employees.length) {
      listEl.innerHTML = `<div style="padding:10px 0;font-size:12px;color:var(--gray-400);text-align:center">등록된 직원이 없어요</div>`;
    } else {
      listEl.innerHTML = `<div class="card" style="margin-bottom:8px;overflow:hidden">` +
        employees.map((name, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;${i>0?'border-top:1px solid var(--gray-100)':''}">
            <span style="font-size:16px">👤</span>
            <span style="flex:1;font-size:14px;font-weight:600;color:var(--gray-900)">${name}</span>
            <button type="button" onclick="adminRemoveEmployee('${name.replace(/'/g,"\\'")}') " style="height:28px;padding:0 10px;border:1.5px solid var(--red-light);border-radius:var(--radius-sm);background:var(--red-light);font-size:11px;font-weight:700;color:var(--red);cursor:pointer;font-family:var(--font)">삭제</button>
          </div>`).join('') + `</div>`;
    }
  }
  // Apps Script URL
  const url = getAppsScriptUrl() || '';
  const inputEl = document.getElementById('admin-apps-script-input');
  const savedEl = document.getElementById('admin-apps-saved');
  const rowEl   = document.getElementById('admin-apps-script-row');
  if (url) {
    if (inputEl) inputEl.value = url;
    if (savedEl) savedEl.style.display = 'flex';
    if (rowEl)   rowEl.style.display = 'none';
  } else {
    if (savedEl) savedEl.style.display = 'none';
    if (rowEl)   rowEl.style.display = 'flex';
  }
}

function adminAddEmployee() {
  const input = document.getElementById('admin-new-employee');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast('이름을 입력해주세요'); return; }
  if (employees.includes(name)) { showToast('이미 등록된 이름이에요'); return; }
  employees.push(name);
  store.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  input.value = '';
  renderAdminPanel();
  renderLoginList();
  showToast('"' + name + '" 추가됐어요 ✓');
}

function adminRemoveEmployee(name) {
  if (!confirm('"' + name + '"을 삭제할까요?')) return;
  employees = employees.filter(e => e !== name);
  store.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  if (currentUser === name) { currentUser = ''; store.removeItem(CURRENT_USER_KEY); }
  renderAdminPanel();
  renderLoginList();
  showToast('"' + name + '" 삭제됐어요');
}

function adminSaveAppsScript() {
  const input = document.getElementById('admin-apps-script-input');
  if (!input) return;
  const url = input.value.trim();
  if (!url || !url.startsWith('https://script.google.com')) {
    showToast('올바른 Apps Script URL이 아닙니다'); return;
  }
  store.setItem(APPS_SCRIPT_KEY, url);
  renderAdminPanel();
  showToast('Google Drive URL 저장됐어요 ✓');
}

function adminClearAppsScript() {
  if (!confirm('Drive 연동 URL을 삭제할까요?')) return;
  store.removeItem(APPS_SCRIPT_KEY);
  renderAdminPanel();
}

function adminSavePin() {
  const input = document.getElementById('admin-new-pin');
  if (!input) return;
  const pin = input.value.trim();
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    showToast('PIN은 숫자 4자리입니다'); return;
  }
  store.setItem(ADMIN_PIN_KEY, pin);
  input.value = '';
  showToast('PIN이 변경됐어요 ✓ (기본값: 0000)');
}

// ── 설정 화면 사용자 섹션
function renderUserSection() {
  const nameEl = document.getElementById('current-user-name-display');
  if (nameEl) nameEl.textContent = currentUser || '—';
  const label = document.getElementById('last-sync-label');
  const lastSync = store.getItem(LAST_SYNC_KEY);
  if (label) label.textContent = lastSync ? '마지막 동기화: ' + new Date(lastSync).toLocaleString('ko-KR') : '';
}

// ── 자동 동기화 (저장 시 자동 호출, 조용히 백그라운드)
async function autoSyncToDrive() {
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl || !currentUser) return;
  setSyncStatus('syncing');
  try {
    // no-cors: CORS 우회 — 응답 못 읽지만 데이터는 전송됨
    await fetch(scriptUrl, {
      method: 'POST',
      mode:   'no-cors',
      body:   JSON.stringify({ action:'sync', employee:currentUser, quarter:curQuarter(), year:new Date().getFullYear(), payload:receipts, settings:gatherSettings() }),
    });
    store.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus('ok');
  } catch(e) {
    setSyncStatus('fail');
  }
}

// ── 동기화 상태 아이콘 (헤더 우측)
function setSyncStatus(state) {
  let el = document.getElementById('sync-status-icon');
  if (!el) {
    // 헤더에 없으면 동적으로 추가
    const badge = document.getElementById('current-user-badge');
    if (badge) {
      el = document.createElement('span');
      el.id = 'sync-status-icon';
      el.style.cssText = 'font-size:14px;transition:opacity .3s';
      badge.parentNode.insertBefore(el, badge);
    }
  }
  if (!el) return;
  const map = { syncing:'☁️', ok:'✅', fail:'⚠️' };
  el.textContent = map[state] || '';
  el.title = state==='ok' ? '드라이브 저장 완료' : state==='fail' ? '드라이브 저장 실패 (재시도 필요)' : '드라이브 저장 중...';
  if (state === 'ok') setTimeout(() => { el.textContent = '☁️'; el.style.opacity='.4'; }, 3000);
  else el.style.opacity = '1';
}

// ── 수동 동기화 (설정 화면 버튼 용)
async function syncToGoogleDrive() {
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl) { showToast('관리자에게 Google Drive 설정을 요청하세요'); return; }
  if (!currentUser) { showLoginOverlay(); return; }
  if (!receipts.length) { showToast('동기화할 영수증이 없어요'); return; }
  showToast('☁️ Google Drive 동기화 중...', 3000);
  setSyncStatus('syncing');
  try {
    // no-cors: CORS 우회 — 데이터는 전송되지만 응답 확인 불가
    await fetch(scriptUrl, {
      method: 'POST',
      mode:   'no-cors',
      body:   JSON.stringify({ action:'sync', employee:currentUser, quarter:curQuarter(), year:new Date().getFullYear(), payload:receipts }),
    });
    store.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus('ok');
    renderUserSection();
    showToast('☁️ Drive 동기화 완료 ✓  ' + receipts.length + '건');
  } catch(err) {
    setSyncStatus('fail');
    showToast('동기화 실패 — URL을 확인해주세요');
  }
}


// ── 더미 함수들 (삭제된 UI 참조 방지)
function addEmployee(){}
function renderEmployeeSection(){ renderUserSection(); }
function renderAppsScriptSection(){ renderUserSection(); }



function checkLogin() {
  if (!currentUser) showLoginOverlay();
  else { hideLoginOverlay(); updateUserBadge(); }
}

function showLoginOverlay() {
  const ol = document.getElementById('login-overlay');
  if (ol) ol.style.display = 'flex';
  renderLoginList();
}
function hideLoginOverlay() {
  const ol = document.getElementById('login-overlay');
  if (ol) ol.style.display = 'none';
}

function renderLoginList() {
  const list = document.getElementById('user-select-list');
  if (!list) return;
  if (!employees.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--gray-400);font-size:13px;padding:8px 0;line-height:1.6">등록된 직원이 없어요<br>드라이브에서 불러오거나 아래에 직접 추가하세요</div>
      <button type="button" onclick="loadFromDrive({toast:true})" style="width:100%;height:48px;margin-top:8px;background:var(--primary-light);border:1.5px solid var(--primary);border-radius:var(--radius-md);font-family:var(--font);font-size:14px;font-weight:700;color:var(--primary);cursor:pointer">⬇️ 드라이브에서 직원 불러오기</button>`;
    return;
  }
  list.innerHTML = employees.map(name => `
    <button type="button" onclick="loginAs('${name.replace(/'/g,"\\'")}') "
      style="width:100%;height:54px;border:1.5px solid var(--gray-200);border-radius:var(--radius-md);background:var(--white);font-family:var(--font);font-size:16px;font-weight:700;color:var(--gray-900);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px"
      onmouseover="this.style.borderColor='var(--primary)';this.style.background='var(--primary-light)';this.style.color='var(--primary)'"
      onmouseout="this.style.borderColor='var(--gray-200)';this.style.background='var(--white)';this.style.color='var(--gray-900)'">
      <span style="font-size:20px">👤</span>${name}
    </button>`).join('');
}

function loginAs(name) {
  currentUser = name;
  store.setItem(CURRENT_USER_KEY, name);
  hideLoginOverlay();
  updateUserBadge();
  renderSettings();
  showToast('안녕하세요, ' + name + '님 👋');
}

function addAndLoginUser() {
  const input = document.getElementById('new-user-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast('이름을 입력해주세요'); return; }
  if (!employees.includes(name)) {
    employees.push(name);
    store.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  }
  input.value = '';
  loginAs(name);
}

function logoutUser() {
  if (!confirm('사용자를 변경할까요?')) return;
  currentUser = '';
  store.removeItem(CURRENT_USER_KEY);
  showLoginOverlay();
}

function updateUserBadge() {
  const badge = document.getElementById('current-user-badge');
  if (!badge) return;
  if (currentUser) { badge.textContent = '👤 ' + currentUser; badge.style.display = 'block'; }
  else badge.style.display = 'none';
}

function renderEmployeeSection() {
  const el = document.getElementById('employee-manage-section');
  if (!el) return;
  const nameEl = document.getElementById('current-user-name-display');
  if (nameEl) nameEl.textContent = currentUser || '—';
  if (!employees.length) {
    el.innerHTML = `<div style="margin-bottom:4px;padding:10px 14px;background:var(--gray-50);border-radius:var(--radius-sm);font-size:12px;color:var(--gray-400);text-align:center">등록된 직원이 없어요</div>`;
    return;
  }
  el.innerHTML = `<div class="card" style="margin-bottom:8px;overflow:hidden">` +
    employees.map((name, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;${i>0?'border-top:1px solid var(--gray-100)':''}">
        <span style="font-size:16px">👤</span>
        <span style="flex:1;font-size:14px;font-weight:${name===currentUser?'700':'400'};color:${name===currentUser?'var(--primary)':'var(--gray-900)'}">
          ${name}${name===currentUser?' ← 현재 사용자':''}
        </span>
        <button type="button" onclick="removeEmployee('${name.replace(/'/g,"\\'")}') " style="height:28px;padding:0 10px;border:1.5px solid var(--red-light);border-radius:var(--radius-sm);background:var(--red-light);font-size:11px;font-weight:700;color:var(--red);cursor:pointer;font-family:var(--font)">삭제</button>
      </div>`).join('') + `</div>`;
}

function addEmployee() {
  const input = document.getElementById('new-employee-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast('이름을 입력해주세요'); return; }
  if (employees.includes(name)) { showToast('이미 등록된 이름이에요'); return; }
  employees.push(name);
  store.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  input.value = '';
  renderEmployeeSection();
  showToast('"' + name + '" 추가됐어요 ✓');
}

function removeEmployee(name) {
  if (!confirm('"' + name + '"을 직원 목록에서 삭제할까요?')) return;
  employees = employees.filter(e => e !== name);
  store.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
  if (currentUser === name) { logoutUser(); return; }
  renderEmployeeSection();
  showToast('"' + name + '" 삭제됐어요');
}

function saveAppsScriptUrl() {
  const input = document.getElementById('apps-script-url-input');
  if (!input) return;
  const url = input.value.trim();
  if (!url || !url.startsWith('https://script.google.com')) {
    showToast('올바른 Apps Script URL이 아닙니다'); return;
  }
  store.setItem(APPS_SCRIPT_KEY, url);
  renderAppsScriptSection();
  showToast('Google Drive 연동 URL 저장됐어요 ✓');
}

function clearAppsScriptUrl() {
  if (!confirm('연동 URL을 삭제할까요?')) return;
  store.removeItem(APPS_SCRIPT_KEY);
  renderAppsScriptSection();
}

function renderAppsScriptSection() {
  const url      = getAppsScriptUrl() || '';
  const inputRow = document.getElementById('apps-script-input-row');
  const savedRow = document.getElementById('apps-script-saved-row');
  const input    = document.getElementById('apps-script-url-input');
  const label    = document.getElementById('last-sync-label');
  const lastSync = store.getItem(LAST_SYNC_KEY);
  if (url) {
    if (inputRow) inputRow.style.display = 'none';
    if (savedRow) savedRow.style.display = 'flex';
    if (input)    input.value = url;
  } else {
    if (inputRow) inputRow.style.display = 'flex';
    if (savedRow) savedRow.style.display = 'none';
  }
  if (label) label.textContent = lastSync ? '마지막 동기화: ' + new Date(lastSync).toLocaleString('ko-KR') : '';
}

async function syncToGoogleDrive() {
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl) { showToast('설정에서 Google Drive URL을 먼저 입력해주세요'); showScreen('screen-settings'); return; }
  if (!currentUser) { showLoginOverlay(); return; }
  if (!receipts.length) { showToast('동기화할 영수증이 없어요'); return; }
  showToast('☁️ 동기화 중... 잠시 기다려주세요', 3000);
  try {
    const res = await fetch(scriptUrl, {
      method: 'POST',
      body:   JSON.stringify({ action:'sync', employee:currentUser, quarter:curQuarter(), year:new Date().getFullYear(), payload:receipts, settings:gatherSettings() }),
      headers:{ 'Content-Type': 'text/plain' },
    });
    const result = await res.json();
    if (result.success) {
      store.setItem(LAST_SYNC_KEY, new Date().toISOString());
      renderAppsScriptSection();
      showToast('☁️ Google Drive 동기화 완료 ✓  ' + receipts.length + '건');
    } else {
      showToast('동기화 실패: ' + (result.error || result.message || '오류'));
    }
  } catch(err) {
    showToast('연결 실패 — URL을 확인해주세요');
  }
}

// ══════════════════════════════════════
// 다기기 동기화 — 드라이브에서 불러오기 (드라이브 우선 방식)
// ══════════════════════════════════════

// 관리자 설정을 한 묶음으로 모음 (직원/PIN/카드/프로젝트/사업자정보)
function gatherSettings() {
  return {
    employees: JSON.parse(store.getItem('employees_v1') || '[]'),
    adminPin:  store.getItem('admin_pin_v1') || '',
    projects:  JSON.parse(store.getItem('projects_v1') || 'null'),
    cards:     JSON.parse(store.getItem('cards_v1')    || 'null'),
    bizNumber: store.getItem('biz_number_v1') || '',
    bizEmail:  store.getItem('biz_email_v1')  || '',
    bizCert:   store.getItem('biz_cert_v1')   || ''
  };
}

// 드라이브에서 받은 설정을 로컬에 반영 (값이 있는 항목만 — 빈 값으로 덮어쓰기 방지)
// _suppressSettingsPush: 반영 중 발생하는 setItem이 자동 push를 또 트리거하지 않도록 억제
function applySettings(s) {
  if (!s) return;
  _suppressSettingsPush = true;
  try {
    if (Array.isArray(s.employees)) {
      employees = s.employees;
      store.setItem('employees_v1', JSON.stringify(employees));
    }
    if (s.adminPin) store.setItem('admin_pin_v1', s.adminPin);
    if (Array.isArray(s.projects) && s.projects.length) {
      projects = s.projects;
      store.setItem('projects_v1', JSON.stringify(projects));
    }
    if (Array.isArray(s.cards) && s.cards.length) {
      cards = s.cards;
      store.setItem('cards_v1', JSON.stringify(cards));
    }
    if (s.bizNumber) store.setItem('biz_number_v1', s.bizNumber);
    if (s.bizEmail)  store.setItem('biz_email_v1',  s.bizEmail);
    if (s.bizCert)   store.setItem('biz_cert_v1',   s.bizCert);
  } finally {
    _suppressSettingsPush = false;
  }
}

// 설정만 드라이브에 업로드 (settings.json만 저장 — master.json은 절대 건드리지 않음)
async function pushSettings() {
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl) return;
  const s = gatherSettings();
  if (!s.employees || !s.employees.length) return;  // 빈 설정 보호
  setSyncStatus('syncing');
  try {
    await fetch(scriptUrl, {
      method: 'POST',
      mode:   'no-cors',
      body:   JSON.stringify({ action:'syncSettings', settings:s }),
    });
    store.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus('ok');
  } catch(e) {
    setSyncStatus('fail');
  }
}

// 현재 보이는 화면 다시 그리기
function rerenderAll() {
  try { renderLoginList(); } catch(e) {}
  try { updateUserBadge(); } catch(e) {}
  const active = document.querySelector('.screen.active');
  if (!active) return;
  if (active.id === 'screen-home') renderHome();
  else if (active.id === 'screen-list') renderList();
  else if (active.id === 'screen-viewer') initViewer();
  else if (active.id === 'screen-settle') renderSettle();
  else if (active.id === 'screen-settings') renderSettings();
}

// 드라이브의 master.json + settings.json 을 받아 로컬에 반영
// opts.startup: 앱 시작 시 호출(조용히), opts.toast: 사용자 버튼(토스트 표시)
async function loadFromDrive(opts) {
  opts = opts || {};
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl) { if (opts.toast) showToast('설정에서 Google Drive URL을 먼저 입력해주세요'); return false; }
  if (opts.toast) showToast('☁️ 드라이브에서 불러오는 중...', 3000);
  setSyncStatus('syncing');
  try {
    const res  = await fetch(scriptUrl + '?action=read&t=' + Date.now());
    const data = await res.json();
    if (!data || !data.ok) throw new Error('형식 오류');
    if (Array.isArray(data.receipts)) {
      receipts = data.receipts;
      saveDB(receipts);
    }
    applySettings(data.settings);
    store.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus('ok');
    rerenderAll();
    if (opts.toast) showToast('☁️ 불러오기 완료 ✓  ' + (Array.isArray(data.receipts) ? data.receipts.length : 0) + '건');
    return true;
  } catch(err) {
    setSyncStatus('fail');
    if (opts.toast) showToast('불러오기 실패 — 잠시 후 다시 시도해주세요');
    return false;
  }
}

// ══ AI ══
function onUsageInput(){
  state.usage=document.getElementById('usage').value;
  updateFilename();
  // 자동 분류 안 함 — "AI 분류하기" 버튼을 눌러야 실행
}
// ══ AI ══
function onUsageInput(){
  state.usage=document.getElementById('usage').value;
  updateFilename();
  // 자동 분류 안 함 — "AI 분류하기" 버튼을 눌러야 실행
}
async function classifyUsage(text){
  const box=document.getElementById('ai-box');
  const dot=document.getElementById('ai-dot');
  const label=document.getElementById('ai-label');
  const area=document.getElementById('ai-result-area');
  box.style.display='block';dot.style.animation='pulse 1.5s ease-in-out infinite';
  label.textContent='Claude Haiku 분석 중...';area.innerHTML='';
  try{
    // Apps Script 프록시 경유 (API 키는 서버에만 보관 — 외부 노출 안 됨)
    const scriptUrl=getAppsScriptUrl();
    if(!scriptUrl){label.textContent='Drive 연동이 필요해요 (설정)';return}
    const res=await fetch(scriptUrl+'?action=classify&text='+encodeURIComponent(text)+'&cats='+encodeURIComponent(CATEGORIES.join('|'))+'&t='+Date.now());
    const data=await res.json();
    if(!data||!data.ok)throw new Error((data&&data.error)||'분류 실패');
    const parsed=data.result;
    dot.style.animation='none';
    label.textContent=`✦ AI 분류 완료 · 신뢰도 ${parsed.confidence}%`;
    area.innerHTML=`<div style="margin-bottom:6px;font-size:12px;color:#7C3AED99">${parsed.reason}</div>
      <div class="ai-chips">
        ${[parsed.primary,...(parsed.alternatives||[]).slice(0,2)].map((c,i)=>
          `<div class="ai-chip${i===0?' ai-sel':''}" onclick="pickAICategory('${c}',this)">${c}</div>`
        ).join('')}
      </div>`;
    if(!state.category||state.category!==parsed.primary){state.category=parsed.primary;catExpanded=false;const _c=document.getElementById('category-chips');if(_c)_c.style.display='none';updateCatSelectedDisplay();updateFilename()}
    updateSaveBtn();
  }catch(e){
    dot.style.animation='none';
    label.textContent='분류할 수 없습니다 — 직접 선택해주세요';
    area.innerHTML='';
    showToast('분류할 수 없습니다. 계정과목을 직접 선택해주세요');
    openCategoryPanel();   // 직접 선택 패널 펼치기
  }
}

// "AI 분류하기" 버튼 — 누를 때마다 현재 용도로 분류 실행
async function runAIClassify(){
  const text=(state.usage||(document.getElementById('usage')||{}).value||'').trim();
  if(text.length<2){ showToast('용도를 먼저 입력해주세요'); return; }
  const btn=document.getElementById('ai-classify-btn');
  if(btn){ btn.disabled=true; btn.style.opacity='.6'; }
  try{ await classifyUsage(text); }
  finally{ if(btn){ btn.disabled=false; btn.style.opacity='1'; } }
}

// 계정과목 직접선택 패널 펼치기 (이미 펼쳐져 있으면 그대로)
function openCategoryPanel(){
  if(!catExpanded) toggleCategoryPanel();
}

function pickAICategory(cat,el){
  document.querySelectorAll('.ai-chip').forEach(c=>c.classList.remove('ai-sel'));
  el.classList.add('ai-sel');state.category=cat;catExpanded=false;const _pc=document.getElementById('category-chips');if(_pc)_pc.style.display='none';updateCatSelectedDisplay();updateFilename();updateSaveBtn();
}

// ══ FILENAME ══
function updateFilename(){
  const proj=state.project?getProjById(state.project).name:'';
  const projSlug=proj.replace(/\s/g,'');
  const dateStr=fmtDate(state.date);
  const cat=state.category||'';
  const rawUsage=state.mode==='manual'?document.getElementById('manual-store').value:document.getElementById('usage').value;
  const usage=rawUsage.trim().replace(/\s+/g,'').slice(0,10);
  const cardName=state.card?(cards.find(c=>c.id===state.card)||{}).name||'':'';
  const payLabel=state.payType==='card'&&cardName?cardName.replace(/\s/g,''):state.payType==='cash'?'현금':state.payType==='transfer'?'이체':'';
  if(!state.project||!state.date){document.getElementById('filename-preview').style.display='none';return}
  const ext=state.mode==='manual'?'manual':(state.imageFile?state.imageFile.name.split('.').pop():'jpg');
  const parts=[projSlug,`${new Date().getFullYear()}Q${getQuarter(state.date)}`,dateStr,cat,usage,payLabel].filter(Boolean);
  document.getElementById('filename-value').textContent=parts.join('_')+'.'+ext;
  document.getElementById('filename-preview').style.display='block';
}

// ══ SAVE BTN ══
function updateSaveBtn(){
  const btn=document.getElementById('save-btn');
  const photoOk=state.mode==='photo'&&state.imageFile;
  const manualOk=state.mode==='manual'&&parseInt(document.getElementById('manual-amount').value||0)>0;
  const ok=(photoOk||manualOk)&&state.project&&state.category&&state.payType;
  btn.className='btn btn-full '+(ok?'btn-primary':'btn-disabled');
}

// ══ SAVE ══
function saveReceipt(){
  try {
    const photoOk=state.mode==='photo'&&state.imageFile;
    const manualOk=state.mode==='manual'&&parseInt(document.getElementById('manual-amount').value||0)>0;
    if(!(photoOk||manualOk)||!state.project||!state.category||!state.payType){
      showToast('필수 항목을 모두 입력해주세요');return;
    }
    const amount=state.mode==='manual'
      ?parseInt(document.getElementById('manual-amount').value)||0
      :parseInt(document.getElementById('amount').value)||0;
    const usage=state.mode==='manual'
      ?(document.getElementById('manual-store').value||'직접입력')
      :(document.getElementById('usage').value||'직접입력');
    const cardId=state.payType==='card'?state.card:null;
    const cardObj=cardId?(cards.find(c=>c.id===cardId)||{}):null;
    const cardName=cardObj?cardObj.name||'':'';
    const proj=getProjById(state.project)||{name:state.project,color:'#aaa'};
    const projSlug=(proj.name||'').replace(/\s/g,'');
    const cat=state.category||'';
    const rawUsage=(usage||'').trim().replace(/\s+/g,'').slice(0,10);
    const payLabel=state.payType==='card'&&cardName?cardName.replace(/\s/g,''):state.payType==='cash'?'현금':'이체';
    const ext=state.mode==='manual'?'manual':(state.imageFile&&state.imageFile.name?state.imageFile.name.split('.').pop():'jpg');
    const yr=new Date().getFullYear();
    const parts=[projSlug,yr+'Q'+getQuarter(state.date),fmtDate(state.date),cat,rawUsage,payLabel].filter(Boolean);
    const filename=parts.join('_')+'.'+ext;
    const vt=VOUCHER_TYPES.find(v=>v.id===state.voucherType)||null;
    const supplyAmt=vt&&vt.vatOk?Math.round(amount/1.1):amount;
    const vatAmt=vt&&vt.vatOk?amount-supplyAmt:0;
    const payerName=(document.getElementById('used-payer-name')||{}).value||'';
    const rec={
      id:'r_'+Date.now(),
      date:state.date||todayStr(),
      project:state.project,
      amount:amount,
      usage:usage,
      category:cat,
      payType:state.payType,
      card:cardId,
      cardName:cardName,
      imagePreview:state.imagePreview||null,
      mode:state.mode,
      filename:filename,
      voucherType:state.voucherType||null,
      voucherLabel:vt?vt.label:'',
      vatOk:vt?vt.vatOk:null,
      supplyAmt:supplyAmt,
      vatAmt:vatAmt,
      usedPlatform:state.usedPlatform||null,
      usedPayer:state.usedPayer||'company',
      usedPayerName:payerName.trim(),
      usedSettled:state.usedSettled||false,
      uploader:currentUser||'',
      createdAt:new Date().toISOString()
    };
    receipts.unshift(rec);
    saveDB(receipts);
    if (rec.imagePreview) saveImage(rec.id, rec.imagePreview);
    showToast('저장되었어요 ✓');
    showScreen('screen-home');
    autoSyncToDrive();
  } catch(err) {
    showToast('저장 오류: '+err.message);
    console.error('saveReceipt error:', err);
  }
}

// ══ HOME RENDER ══
function renderHome(){
  const q=curQuarter();
  const qData=receipts.filter(r=>getQuarter(r.date)===q&&r.date.startsWith(new Date().getFullYear().toString()));
  const total=qData.reduce((s,r)=>s+r.amount,0);
  document.getElementById('home-quarter-label').textContent=`${q}분기 (${(q-1)*3+1}월~${q*3}월)`;
  document.getElementById('home-total').textContent=`₩ ${fmtAmount(total)}`;
  // proj summary
  const pm={};qData.forEach(r=>{pm[r.project]=(pm[r.project]||0)+r.amount});
  document.getElementById('home-proj-summary').innerHTML=Object.entries(pm).slice(0,3).map(([id,a])=>{
    const p=getProjById(id);
    return`<div class="hero-proj"><div class="hero-proj-name">${p.name}</div><div class="hero-proj-amt">₩${fmtAmount(a)}</div></div>`;
  }).join('');
  const list=document.getElementById('receipt-list-home');
  const recent=receipts.slice(0,5);
  list.innerHTML=recent.length?recent.map(r=>receiptItemHTML(r)).join('<div class="divider"></div>'):
    `<div style="text-align:center;padding:32px 16px;color:var(--gray-400)">아직 등록된 영수증이 없어요<br>📷 첫 영수증을 업로드해보세요</div>`;
}

function receiptItemHTML(r){
  const p=getProjById(r.project);
  const payBadge=r.payType==='card'?`<span class="badge badge-gray">💳 ${r.cardName||'카드'}</span>`:
    r.payType==='cash'?`<span class="badge badge-green">💵 현금</span>`:
    `<span class="badge badge-orange">🏦 이체</span>`;
  const taxBadge=r.payType==='card'?`<span class="badge badge-gray">💳 카드</span>`:`<span class="badge badge-green">✅ 세무포함</span>`;
  const thumb=r.imagePreview?
    `<div class="receipt-thumb" id="thumb-${r.id}"><img src="${r.imagePreview}"><div class="proj-dot" style="background:${p.color}"></div></div>`:
    `<div class="receipt-thumb" id="thumb-${r.id}" style="background:${p.color}22"><span style="font-size:20px">${getCatIcon(r.category)}</span><div class="proj-dot" style="background:${p.color}"></div></div>`;
  // 이미지 없으면 로컬→드라이브 썸네일 순으로 비동기 로드 (r.imagePreview는 풀이미지 전용이라 덮어쓰지 않음)
  if (!r.imagePreview && r.mode === 'photo') {
    loadThumb(r).then(function(img) {
      if (!img) return;
      const el = document.getElementById('thumb-'+r.id);
      if (el) el.innerHTML = '<img src="'+img+'" style="width:100%;height:100%;object-fit:cover"><div class="proj-dot" style="background:'+p.color+'"></div>';
    });
  }
  return`<div class="receipt-item" onclick="openDetail('${r.id}')">${thumb}
    <div class="receipt-info">
      <div class="receipt-proj">${p.name}</div>
      <div class="receipt-desc">${r.usage||'—'}</div>
      <div class="receipt-tags">${payBadge}${taxBadge}<span class="badge badge-blue">${r.category||''}</span></div>
    </div>
    <div class="receipt-right">
      <div class="receipt-date">${fmtDateKo(r.date)}</div>
      <div class="receipt-amount">₩${fmtAmount(r.amount)}</div>
    </div>
  </div>`;
}

// ══ LIST RENDER ══
function renderList(){renderListFilterChips();renderListItems()}
function renderListFilterChips(){
  const row=document.getElementById('list-filter-row');
  row.innerHTML=[{id:'all',name:'전체',icon:''},...projects].map(p=>`
    <div class="chip${filterProj===p.id?' sel':''}" onclick="setListFilter('${p.id}')">${p.id==='all'?'전체':(p.icon||'')+' '+p.name}${p.completed?' ✓':''}</div>
  `).join('');
}
function setListFilter(id){filterProj=id;renderListFilterChips();renderListItems()}
function filterList(q){filterQuery=q.toLowerCase();renderListItems()}
function renderListItems(){
  const main=document.getElementById('receipt-list-main');
  let filtered=receipts.filter(r=>{
    const pm=filterProj==='all'||r.project===filterProj;
    const q=filterQuery;
    const qm=!q||(r.usage||'').toLowerCase().includes(q)||getProjById(r.project).name.toLowerCase().includes(q)||String(r.amount).includes(q)||(r.category||'').includes(q);
    return pm&&qm;
  });
  if(!filtered.length){main.innerHTML=`<div style="text-align:center;padding:32px 16px;color:var(--gray-400)">검색 결과가 없어요</div>`;return}
  const groups={};
  filtered.forEach(r=>{const k=r.date.slice(0,7);if(!groups[k])groups[k]=[];groups[k].push(r)});
  main.innerHTML=Object.entries(groups).sort((a,b)=>b[0].localeCompare(a[0])).map(([key,items])=>{
    const total=items.reduce((s,r)=>s+r.amount,0);
    const[y,m]=key.split('-');
    return`<div class="month-header"><span>${y}년 ${parseInt(m)}월</span><span class="month-total">₩${fmtAmount(total)}</span></div>`
      +items.map(r=>receiptItemHTML(r)).join('<div class="divider"></div>');
  }).join('<div class="section-divider"></div>');
}

// ══ SETTLE RENDER ══
function renderSettle(){
  // 토글 상태 초기화
  cardExcluded = false; taxFilter = 'all';
  const track=document.getElementById('card-excl-track');
  const thumb=document.getElementById('card-excl-thumb');
  const desc=document.getElementById('card-excl-desc');
  if(track) track.style.background='var(--gray-200)';
  if(thumb) thumb.style.left='3px';
  if(desc)  desc.textContent='카드 내역 포함 중';
  const tabs=document.getElementById('quarter-tabs');
  tabs.innerHTML=[1,2,3,4].map(q=>`
    <div class="quarter-tab${settleQuarter===q?' active':''}" onclick="setSettleQ(${q})">${q}분기 (${(q-1)*3+1}~${q*3}월)</div>`).join('');
  renderSettleData();
}
function setSettleQ(q){settleQuarter=q;renderSettle()}
let cardExcluded = false;

function toggleCardExcl() {
  cardExcluded = !cardExcluded;
  taxFilter = cardExcluded ? 'excl' : 'all';
  // 토글 UI 업데이트
  const track = document.getElementById('card-excl-track');
  const thumb = document.getElementById('card-excl-thumb');
  const desc  = document.getElementById('card-excl-desc');
  if (track) track.style.background = cardExcluded ? 'var(--primary)' : 'var(--gray-200)';
  if (thumb) thumb.style.left = cardExcluded ? '23px' : '3px';
  if (desc)  desc.textContent = cardExcluded ? '카드 내역 제외 중' : '카드 내역 포함 중';
  renderSettleData();
}

function setTaxFilter(f){
  taxFilter = f;
  renderSettleData();
}
function getSettleData(){
  const qData=receipts.filter(r=>getQuarter(r.date)===settleQuarter&&r.date.startsWith(new Date().getFullYear().toString()));
  if(taxFilter==='excl')return qData.filter(r=>r.payType!=='card');
  if(taxFilter==='cash')return qData.filter(r=>r.payType==='cash'||r.payType==='transfer');
  return qData;
}
function renderSettleData(){
  const display=getSettleData();
  const total=display.reduce((s,r)=>s+r.amount,0);
  document.getElementById('settle-label').textContent=`${new Date().getFullYear()}년 ${settleQuarter}분기 합계`;
  document.getElementById('settle-amount').textContent=`₩ ${fmtAmount(total)}`;
  document.getElementById('settle-sub').textContent=`총 ${display.length}건${cardExcluded?' · 카드 제외':''}`;

  // ── 세무 적합성 요약
  const allQ=receipts.filter(r=>getQuarter(r.date)===settleQuarter&&r.date.startsWith(new Date().getFullYear().toString()));
  const noVoucher=allQ.filter(r=>!r.voucherType).length;
  const entTotal=receipts.filter(r=>r.category==='접대비'&&r.date.startsWith(new Date().getFullYear().toString())).reduce((s,r)=>s+r.amount,0);
  const entPct=Math.round(entTotal/ENTERTAINMENT_LIMIT*100);
  const vatRefund=allQ.filter(r=>r.vatOk===true).reduce((s,r)=>s+(r.vatAmt||Math.round(r.amount/11)),0);
  const vatOkAmt=allQ.filter(r=>r.vatOk===true).reduce((s,r)=>s+r.amount,0);
  const vatNgAmt=allQ.filter(r=>r.vatOk===false).reduce((s,r)=>s+r.amount,0);
  const summaryEl=document.getElementById('settle-tax-summary');
  if(summaryEl){
    summaryEl.innerHTML=`
    <div style="margin:0 16px;display:flex;flex-direction:column;gap:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:var(--success-light);border-radius:var(--radius-md);padding:12px;border:1px solid var(--success)">
          <div style="font-size:10px;font-weight:700;color:var(--success);text-transform:uppercase;margin-bottom:4px">✅ 적격증빙 합계</div>
          <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--gray-900)">₩${fmtAmount(vatOkAmt)}</div>
          <div style="font-size:10px;color:var(--success);margin-top:2px">부가세 공제 가능</div>
        </div>
        <div style="background:var(--orange-light);border-radius:var(--radius-md);padding:12px;border:1px solid var(--orange)">
          <div style="font-size:10px;font-weight:700;color:var(--orange);text-transform:uppercase;margin-bottom:4px">⚠️ 비적격증빙</div>
          <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--gray-900)">₩${fmtAmount(vatNgAmt)}</div>
          <div style="font-size:10px;color:var(--orange);margin-top:2px">공제 불가 · 비용 처리만</div>
        </div>
      </div>
      <div style="background:var(--primary-light);border-radius:var(--radius-md);padding:12px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--primary)">💰 매입세액 공제 예상액</div>
          <div style="font-size:10px;color:var(--gray-400);margin-top:2px">세금계산서·카드전표·현금영수증 기준</div>
        </div>
        <div style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--primary)">₩${fmtAmount(vatRefund)}</div>
      </div>
      ${noVoucher>0?`<div onclick="goToMissingVoucher()" role="button"
        style="background:var(--red-light);border-radius:var(--radius-md);padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border:1.5px solid var(--red);transition:opacity .15s"
        onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
        <span style="font-size:18px">❌</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--red)">증빙유형 미입력 ${noVoucher}건</div>
          <div style="font-size:10px;color:var(--red);margin-top:2px">세무 신고 전 증빙유형을 입력해야 해요 — 탭해서 목록 보기</div>
        </div>
        <div style="font-size:16px;color:var(--red);font-weight:700">→</div>
      </div>`:''}
      ${entTotal>0?`<div style="background:${entPct>=80?'var(--red-light)':'var(--orange-light)'};border-radius:var(--radius-md);padding:10px 12px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:12px;font-weight:700;color:${entPct>=80?'var(--red)':'var(--orange)'}">🤝 접대비 연간 한도</span>
          <span style="font-size:11px;font-weight:700;font-family:var(--mono);color:${entPct>=80?'var(--red)':'var(--orange)'}">₩${fmtAmount(entTotal)} / 1,200만원</span>
        </div>
        <div style="height:6px;background:rgba(0,0,0,.1);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${Math.min(entPct,100)}%;background:${entPct>=80?'var(--red)':'var(--orange)'};border-radius:3px"></div>
        </div>
        <div style="font-size:10px;color:${entPct>=80?'var(--red)':'var(--orange)'};margin-top:4px">${entPct}% 사용${entPct>=80?' — ⚠️ 한도 초과 시 법인세 추징!':''}</div>
      </div>`:''}
    </div>`;
  }
  // proj
  const pm={};display.forEach(r=>{pm[r.project]=(pm[r.project]||0)+r.amount});
  const pl=Object.entries(pm).sort((a,b)=>b[1]-a[1]);
  const mx=pl[0]?.[1]||1;
  document.getElementById('settle-proj-list').innerHTML=pl.length?pl.map(([id,amt])=>{
    const p=getProjById(id);const pct=Math.round(amt/total*100)||0;
    return`<div class="proj-row">
      <div style="font-size:22px;width:36px;text-align:center">${p.icon||'📄'}</div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-weight:700">${p.name}</span><span style="font-family:var(--mono);font-weight:700">₩${fmtAmount(amt)}</span>
        </div>
        <div class="proj-bar-bg"><div class="proj-bar-fill" style="width:${Math.round(amt/mx*100)}%;background:${p.color}"></div></div>
        <div style="display:flex;justify-content:space-between;margin-top:2px">
          <span style="font-size:11px;color:var(--gray-400)">${display.filter(r=>r.project===id).length}건</span>
          <span style="font-size:11px;color:var(--gray-400)">${pct}%</span>
        </div>
      </div>
    </div>`;
  }).join('<div class="divider"></div>'):
    `<div style="text-align:center;padding:24px;color:var(--gray-400)">이 분기 데이터가 없어요</div>`;
  // pay
  const all=receipts.filter(r=>getQuarter(r.date)===settleQuarter&&r.date.startsWith(new Date().getFullYear().toString()));
  const payMap={card:0,cash:0,transfer:0};
  all.forEach(r=>{payMap[r.payType]=(payMap[r.payType]||0)+r.amount});
  const payRows=[
    {key:'cash',icon:'💵',name:'현금',inc:true,color:'var(--success)'},
    {key:'transfer',icon:'🏦',name:'이체',inc:true,color:'var(--orange)'},
    {key:'card',icon:'💳',name:'카드',inc:false,color:'var(--gray-400)'},
  ];
  document.getElementById('settle-pay-list').innerHTML=payRows.filter(p=>payMap[p.key]>0).map(p=>`
    <div class="proj-row" style="${!p.inc&&taxFilter!=='all'?'opacity:.4':''}">
      <div style="font-size:22px;width:36px;text-align:center">${p.icon}</div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between">
          <span style="font-weight:700">${p.name}</span>
          <span style="font-family:var(--mono);font-weight:700">₩${fmtAmount(payMap[p.key])}</span>
        </div>
        <div style="margin-top:4px">
          <span class="badge ${p.inc?'badge-green':'badge-gray'}">${p.inc?'세무포함':'💳 카드'}</span>
          <span style="font-size:11px;color:var(--gray-400);margin-left:6px">${all.filter(r=>r.payType===p.key).length}건</span>
        </div>
      </div>
    </div>
  `).join('<div class="divider"></div>');
}

// ══ SETTINGS RENDER ══
function renderSettings(){
  // 사용자 + 직원 + Drive 섹션
  updateUserBadge();
  renderEmployeeSection();
  renderAppsScriptSection();
  // 사업자 등록증 + 번호 + 메일 섹션 초기화
  renderBizCertSection();
  renderBizNumberSection();
  renderBizEmailSection();
  // 프로젝트
  document.getElementById('project-manage-list').innerHTML=projects.map(p=>`
    <div class="proj-card${p.completed?' completed':''}">
      <div class="proj-card-header">
        <div class="proj-card-icon" style="background:${p.color}22">${p.icon}</div>
        <div class="proj-card-info">
          <div class="proj-card-name">${p.name}</div>
          <div class="proj-card-desc">${p.desc||''} ${p.completed?'<span class="badge badge-gray">완료</span>':''}</div>
        </div>
        <span class="badge ${p.completed?'badge-gray':'badge-green'}">${p.completed?'완료':'진행중'}</span>
      </div>
      <div class="proj-status-bar" style="background:${p.color};opacity:${p.completed?.3:1}"></div>
      <div class="proj-card-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick="showAddProjectSheet('${p.id}')">✏️ 수정</button>
        <button type="button" class="btn btn-sm ${p.completed?'btn-ghost':'btn-danger'}" onclick="setProjectStatus('${p.id}',${!p.completed})">
          ${p.completed?'🟢 재개':'✅ 완료 처리'}
        </button>
      </div>
    </div>
  `).join('');
  // 카드
  const cardListEl = document.getElementById('card-manage-list');
  if (!cards.length) {
    cardListEl.innerHTML = `<div style="margin:0 16px 8px;padding:16px;background:var(--gray-50);border-radius:var(--radius-md);text-align:center;color:var(--gray-400);font-size:13px">등록된 카드가 없어요</div>`;
  } else {
    cardListEl.innerHTML = `<div class="card" style="margin-bottom:0;overflow:hidden">` +
      cards.map((c,i) => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;${i>0?'border-top:1px solid var(--gray-100)':''}">
          <div style="width:32px;height:32px;border-radius:50%;background:${c.color};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:15px">💳</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:700;color:var(--gray-900)">${c.name}</div>
            ${c.number?`<div style="font-size:12px;color:var(--gray-400);font-family:var(--mono);margin-top:1px">•••• ${c.number}</div>`:''}
          </div>
          <button type="button" onclick="showEditCardSheet('${c.id}')"
            style="height:32px;padding:0 12px;border:1.5px solid var(--gray-200);border-radius:var(--radius-sm);background:var(--white);font-size:12px;font-weight:700;color:var(--gray-600);cursor:pointer;font-family:var(--font)">✏️ 수정</button>
          <button type="button" onclick="deleteCard('${c.id}','${c.name.replace(/'/g,'\\')}')"
            style="height:32px;padding:0 12px;border:1.5px solid var(--red-light);border-radius:var(--radius-sm);background:var(--red-light);font-size:12px;font-weight:700;color:var(--red);cursor:pointer;font-family:var(--font)">🗑</button>
        </div>`).join('') +
      `</div>`;
  }
  // "+ 카드 추가" 버튼 (목록 아래)
  let addBtn = document.getElementById('card-add-btn-wrap');
  if (!addBtn) {
    addBtn = document.createElement('div');
    addBtn.id = 'card-add-btn-wrap';
    addBtn.style.cssText = 'margin:8px 16px 0';
    cardListEl.parentNode.insertBefore(addBtn, cardListEl.nextSibling);
  }
  addBtn.innerHTML = `<button type="button" onclick="showAddCardSheet()" style="width:100%;height:44px;border:1.5px dashed var(--gray-200);border-radius:var(--radius-md);background:var(--white);font-family:var(--font);font-size:13px;font-weight:700;color:var(--primary);cursor:pointer">+ 카드 추가</button>`;
}

// ══ EXPORT: ZIP (엑셀 + 이미지) ══
async function exportZip(){
  const display=getSettleData();
  if(!display.length){showToast('이 분기에 데이터가 없어요');return}

  const overlay=document.getElementById('progress-overlay');
  const bar=document.getElementById('progress-bar');
  const sub=document.getElementById('progress-sub');
  overlay.classList.add('show');
  bar.style.width='5%';sub.textContent='ZIP 파일 준비 중...';

  try{
    const zip=new JSZip();
    const imgFolder=zip.folder('영수증_이미지');

    // XLSX 생성 (필터·4개 시트 포함)
    bar.style.width='20%';sub.textContent='정산 파일 생성 중...';
    if(typeof XLSX!=='undefined'){
      const wb=buildXLSX(display);
      const wbout=XLSX.write(wb,{bookType:'xlsx',type:'array'});
      zip.file(`${new Date().getFullYear()}_Q${settleQuarter}_영수증정산_세무용.xlsx`,wbout);
    } else {
      // fallback: CSV
      const rows=buildCSVRows(display);
      const csv='\uFEFF'+rows.map(r=>r.map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
      zip.file(`${new Date().getFullYear()}_Q${settleQuarter}_영수증정산.csv`,csv);
    }

    // 이미지 추가
    const withImg=display.filter(r=>r.imagePreview);
    const total=withImg.length;
    for(let i=0;i<total;i++){
      const r=withImg[i];
      bar.style.width=`${20+Math.round((i+1)/Math.max(total,1)*70)}%`;
      sub.textContent=`이미지 묶는 중... (${i+1}/${total})`;
      // base64 → binary
      const dataUrl=r.imagePreview;
      const base64=dataUrl.split(',')[1];
      const ext=dataUrl.split(';')[0].split('/')[1]||'jpg';
      const fname=r.filename||(r.id+'.'+ext);
      imgFolder.file(fname,base64,{base64:true});
      // 프레임 해제
      await new Promise(res=>setTimeout(res,0));
    }

    bar.style.width='95%';sub.textContent='파일 압축 중...';
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}},meta=>{
      bar.style.width=`${95+Math.round(meta.percent/100*5)}%`;
    });

    bar.style.width='100%';
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`영수증정산_${new Date().getFullYear()}_Q${settleQuarter}.zip`;
    a.click();
    overlay.classList.remove('show');
    showToast(`ZIP 다운로드 완료 ✓  (엑셀 + 이미지 ${withImg.length}장)`);
  }catch(e){
    overlay.classList.remove('show');
    showToast('ZIP 생성 중 오류가 발생했어요');
    console.error(e);
  }
}

function buildCSVRows(data) {
  const HEADERS = [
    'No.','날짜','분기','프로젝트','계정과목','용도',
    '합계금액(원)','공급가액(원)','부가세(원)',
    '결제수단','카드명','증빙유형',
    '부가세공제가능','세무신고포함여부',
    '파일명','비고'
  ];
  const toRow = (r, idx) => {
    const p = getProjById(r.project);
    const q = getQuarter(r.date);
    const payLabel = r.payType==='card'?'카드':r.payType==='cash'?'현금':'이체';
    const supply = r.supplyAmt || (r.voucherType ? Math.round(r.amount/1.1) : r.amount);
    const vat    = r.vatAmt    || (r.voucherType ? r.amount - supply : 0);
    const vatOkLabel = r.vatOk===true?'공제가능':r.vatOk===false?'공제불가':'미입력';
    const taxInclude = r.payType!=='card'?'포함':'제외(카드내역서)';
    const note = r.payType==='card'?'월별카드내역서 대조필요':
                 r.voucherType==='simple'?'현금영수증전환 권장':'';
    return [
      idx+1, r.date, `${q}분기`, p.name, r.category||'', r.usage||'',
      r.amount, supply, vat,
      payLabel, r.cardName||'', r.voucherLabel||'미입력',
      vatOkLabel, taxInclude,
      r.filename||'', note
    ];
  };
  return [HEADERS, ...data.map(toRow)];
}

// ══════════════════════════════════════════════
// XLSX 빌더 — 4개 시트 + 자동필터 + 헤더 고정
// ══════════════════════════════════════════════
function buildXLSX(data) {
  const wb = XLSX.utils.book_new();
  // 날짜순 정렬 (신고서 기준)
  const sorted = [...data].sort((a,b)=>a.date.localeCompare(b.date));

  // ── 스타일 헬퍼
  const S = {
    h1:  {font:{bold:true,color:{rgb:'FFFFFF'},sz:11},fill:{fgColor:{rgb:'0D1B5E'},patternType:'solid'},alignment:{horizontal:'left',vertical:'center'}},
    h2:  {font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'1A237E'},patternType:'solid'},alignment:{horizontal:'center',vertical:'center',wrapText:true}},
    sec: {font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'283593'},patternType:'solid'},alignment:{horizontal:'left',vertical:'center'}},
    tot: {font:{bold:true,sz:10},fill:{fgColor:{rgb:'EEF1FE'},patternType:'solid'}},
    ok:  {font:{bold:true,color:{rgb:'065F46'},sz:10},fill:{fgColor:{rgb:'D1FAE5'},patternType:'solid'}},
    ng:  {font:{bold:false,color:{rgb:'92400E'},sz:10},fill:{fgColor:{rgb:'FEF3C7'},patternType:'solid'}},
    warn:{font:{bold:true,color:{rgb:'991B1B'},sz:10},fill:{fgColor:{rgb:'FEE2E2'},patternType:'solid'}},
    num: {alignment:{horizontal:'right'}},
  };
  function applyS(ws, r, c, style){
    const a=XLSX.utils.encode_cell({r,c}); if(!ws[a])return;
    ws[a].s={...style,...(ws[a].s||{})};
  }
  function applyRow(ws, row, nc, style){
    for(let c=0;c<nc;c++) applyS(ws,row,c,style);
  }
  function styleHeader(ws,nc,row=0){ applyRow(ws,row,nc,S.h2); }
  function styleTotal(ws,row,nc)   { applyRow(ws,row,nc,S.tot); }

  const totalAmt = sorted.reduce((s,r)=>s+r.amount,0);
  const vatAmt   = sorted.reduce((s,r)=>s+(r.vatAmt||(r.voucherType?r.amount-Math.round(r.amount/1.1):0)),0);
  const taxAmt   = sorted.filter(r=>r.payType!=='card').reduce((s,r)=>s+r.amount,0);
  const cardAmt  = sorted.filter(r=>r.payType==='card').reduce((s,r)=>s+r.amount,0);
  const noVoucher= sorted.filter(r=>!r.voucherType).length;
  const entAmt   = receipts.filter(r=>r.category==='접대비'&&r.date.startsWith(new Date().getFullYear().toString())).reduce((s,r)=>s+r.amount,0);

  // 월별 집계 미리 계산
  const monthMap={};
  sorted.forEach(r=>{
    const m=r.date.slice(0,7);
    if(!monthMap[m])monthMap[m]={cnt:0,t:0,sup:0,vat:0,tax:0,noV:0};
    monthMap[m].cnt++;monthMap[m].t+=r.amount;
    monthMap[m].sup+=(r.supplyAmt||r.amount);
    monthMap[m].vat+=(r.vatAmt||0);
    if(r.payType!=='card')monthMap[m].tax+=r.amount;
    if(!r.voucherType)monthMap[m].noV++;
  });

  // ════════════════════════════════════════════


  // ════════════════════════════════════════════
  // Sheet 1: 전체 내역 (날짜순)
  // ════════════════════════════════════════════
  const csvRows=buildCSVRows(sorted); // sorted by date
  const s1=[...csvRows, new Array(16).fill(''),
    ['','','','','합  계','',totalAmt,'',vatAmt,'','','','','','',''],
    ['','','','','직접신고대상(카드제외)','',taxAmt,'','','','','','','','',''],
  ];
  const ws1=XLSX.utils.aoa_to_sheet(s1);
  ws1['!cols']=[{wch:4},{wch:12},{wch:7},{wch:15},{wch:15},{wch:22},{wch:13},{wch:13},{wch:10},{wch:8},{wch:13},{wch:14},{wch:12},{wch:16},{wch:36},{wch:20}];
  ws1['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:csvRows.length-1,c:15}})};
  ws1['!sheetViews']=[{state:'frozen',xSplit:0,ySplit:1,topLeftCell:'A2'}];
  styleHeader(ws1,16); styleTotal(ws1,s1.length-2,16); styleTotal(ws1,s1.length-1,16);
  XLSX.utils.book_append_sheet(wb,ws1,'📋전체내역(날짜순)');

  // ════════════════════════════════════════════


  // ════════════════════════════════════════════


  // ════════════════════════════════════════════
  // Sheet 2: 프로젝트별
  // ════════════════════════════════════════════
  const pm={};
  sorted.forEach(r=>{const n=getProjById(r.project).name;if(!pm[n])pm[n]={t:0,v:0,cnt:0,tax:0};pm[n].t+=r.amount;pm[n].v+=(r.vatOk?(r.vatAmt||Math.round(r.amount/11)):0);pm[n].cnt++;if(r.payType!=='card')pm[n].tax+=r.amount;});
  const s2=[
    ['프로젝트','건수','합계금액(원)','매입세액공제(원)','직접신고대상(원)','비율(%)'],
    ...Object.entries(pm).sort((a,b)=>b[1].t-a[1].t).map(([n,d])=>[n,d.cnt,d.t,d.v,d.tax,totalAmt?Math.round(d.t/totalAmt*1000)/10+'%':'0%']),
    ['합계',sorted.length,totalAmt,vatAmt,taxAmt,'100%'],
  ];
  const ws2=XLSX.utils.aoa_to_sheet(s2);
  ws2['!cols']=[{wch:16},{wch:6},{wch:14},{wch:16},{wch:16},{wch:8}];
  ws2['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:s2.length-2,c:5}})};
  ws2['!sheetViews']=[{state:'frozen',xSplit:0,ySplit:1,topLeftCell:'A2'}];
  styleHeader(ws2,6); styleTotal(ws2,s2.length-1,6);
  XLSX.utils.book_append_sheet(wb,ws2,'📂프로젝트별');

  return wb;
}


function exportExcel(){
  const display=getSettleData();
  if(!display.length){showToast('이 분기에 데이터가 없어요');return}
  if(typeof XLSX==='undefined'){showToast('엑셀 라이브러리 로딩 중... 잠시 후 다시 눌러주세요');return}
  const wb=buildXLSX(display);
  XLSX.writeFile(wb,`영수증정산_${new Date().getFullYear()}_Q${settleQuarter}_세무용.xlsx`);
  showToast('엑셀 다운로드 완료 ✓  필터·4개 시트 포함');
}
function exportCSVOnly(){ exportExcel(); }

// ══ SEED ══
function seedIfEmpty(){
  if(receipts.length>0)return;
  receipts=[
    {id:'s1',date:'2025-05-28',project:'lab904',amount:116600,usage:'팀 회식 저녁',category:'복리후생비',payType:'cash',card:null,cardName:'',imagePreview:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyODAiIGhlaWdodD0iMzYwIiB2aWV3Qm94PSIwIDAgMjgwIDM2MCI+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iMzYwIiBmaWxsPSIjZmFmYWY4Ii8+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iNTIiIGZpbGw9IiNmZmY4ZjAiLz4KPGxpbmUgeDE9IjAiIHkxPSI1MiIgeDI9IjI4MCIgeTI9IjUyIiBzdHJva2U9IiNkNGNmYzgiIHN0cm9rZS13aWR0aD0iMSIvPgo8dGV4dCB4PSIxNCIgeT0iMjIiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiPu2VnOyasOumrCDsi53ri7k8L3RleHQ+Cjx0ZXh0IHg9IjE0IiB5PSIzNiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjODg4Ij7shJzsmrgg66eI7Y+s6rWsIOyZgOyasOyCsOuhnCA4ODwvdGV4dD4KPHRleHQgeD0iMTQiIHk9IjQ3IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjkiIGZpbGw9IiM4ODgiPlRFTCAwMi0zMzMtNzg5MDwvdGV4dD4KPHJlY3QgeD0iMTQiIHk9IjU4IiB3aWR0aD0iNzIiIGhlaWdodD0iMTQiIGZpbGw9IiMxYTFhMWEiIHJ4PSIyIi8+Cjx0ZXh0IHg9IjE4IiB5PSI2OCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjZmFmYWY4Ij4yMDI1LjA1LjI4PC90ZXh0Pgo8cmVjdCB4PSI5MiIgeT0iNTgiIHdpZHRoPSI2MCIgaGVpZ2h0PSIxNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTJCOTgxIiBzdHJva2Utd2lkdGg9IjEiIHJ4PSIyIi8+Cjx0ZXh0IHg9Ijk2IiB5PSI2OCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjMTJCOTgxIj7tmITquIjqsrDsoJw8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjgwIiB4Mj0iMjY2IiB5Mj0iODAiIHN0cm9rZT0iI2NjYyIgc3Ryb2tlLWRhc2hhcnJheT0iNCwzIiBzdHJva2Utd2lkdGg9IjEiLz4KPHRleHQgeD0iMTQiIHk9Ijk1IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7tlZzsmrAg67aI6rOg6riwIMOXNDwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSI5NSIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSIgdGV4dC1hbmNob3I9ImVuZCI+NzIsMDAwPC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSIxMDAiIHgyPSIyMTAiIHkyPSIxMDAiIHN0cm9rZT0iI2U4ZTRkZSIgc3Ryb2tlLWRhc2hhcnJheT0iMiwyIiBzdHJva2Utd2lkdGg9IjAuNSIvPgo8dGV4dCB4PSIxNCIgeT0iMTE0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7rkJzsnqXssIzqsJwgw5c0PC90ZXh0Pgo8dGV4dCB4PSIyMDAiIHk9IjExNCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSIgdGV4dC1hbmNob3I9ImVuZCI+MjQsMDAwPC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSIxMjAiIHgyPSIyMTAiIHkyPSIxMjAiIHN0cm9rZT0iI2U4ZTRkZSIgc3Ryb2tlLWRhc2hhcnJheT0iMiwyIiBzdHJva2Utd2lkdGg9IjAuNSIvPgo8dGV4dCB4PSIxNCIgeT0iMTM0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7qs7XquLDrsKUg7LaU6rCAIMOXMjwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSIxMzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjIsMDAwPC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSIxNDAiIHgyPSIyMTAiIHkyPSIxNDAiIHN0cm9rZT0iI2U4ZTRkZSIgc3Ryb2tlLWRhc2hhcnJheT0iMiwyIiBzdHJva2Utd2lkdGg9IjAuNSIvPgo8dGV4dCB4PSIxNCIgeT0iMTU0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7snYzro4wgw5c0PC90ZXh0Pgo8dGV4dCB4PSIyMDAiIHk9IjE1NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSIgdGV4dC1hbmNob3I9ImVuZCI+OCwwMDA8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjE2MCIgeDI9IjIxMCIgeTI9IjE2MCIgc3Ryb2tlPSIjZThlNGRlIiBzdHJva2UtZGFzaGFycmF5PSIyLDIiIHN0cm9rZS13aWR0aD0iMC41Ii8+Cjx0ZXh0IHg9IjE0IiB5PSIxNzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZpbGw9IiM1NTUiPuu0ieyCrOujjCAoMTAlKTwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSIxNzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjEwLDYwMDwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTgyIiB4Mj0iMjY2IiB5Mj0iMTgyIiBzdHJva2U9IiNiYmIiIHN0cm9rZS1kYXNoYXJyYXk9IjQsMyIgc3Ryb2tlLXdpZHRoPSIxIi8+CjxsaW5lIHgxPSIxNCIgeTE9IjE4NiIgeDI9IjI2NiIgeTI9IjE4NiIgc3Ryb2tlPSIjMWExYTFhIiBzdHJva2Utd2lkdGg9IjIiLz4KPHRleHQgeD0iMTQiIHk9IjIwMiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMyIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSI+7ZWpICAgIOqzhDwvdGV4dD4KPHRleHQgeD0iMjY2IiB5PSIyMDIiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjExNiw2MDDsm5A8L3RleHQ+CjxyZWN0IHg9IjE0IiB5PSIyMTIiIHdpZHRoPSIyNTIiIGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzEyQjk4MSIgc3Ryb2tlLXdpZHRoPSIxLjUiIHJ4PSIyIi8+Cjx0ZXh0IHg9IjE0MCIgeT0iMjI3IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMTJCOTgxIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7shLjrrLTtj6ztlaggIMK3ICDrs7Xrpqztm4Tsg53ruYQ8L3RleHQ+CjxyZWN0IHg9IjE0IiB5PSIyNDIiIHdpZHRoPSI4MiIgaGVpZ2h0PSIxNCIgZmlsbD0iI0VDRkRGNSIgcng9IjIiLz4KPHRleHQgeD0iMTgiIHk9IjI1MiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjMTJCOTgxIj5sYWI5MDQgwrcgMjAyNVEyPC90ZXh0Pgo8bGluZSB4MT0iMCIgeTE9IjI2NCIgeDI9IjI4MCIgeTI9IjI2NCIgc3Ryb2tlPSIjZDRjZmM4IiBzdHJva2UtZGFzaGFycmF5PSI0LDMiIHN0cm9rZS13aWR0aD0iMSIvPgo8cmVjdCB4PSIwIiB5PSIyNjQiIHdpZHRoPSIyODAiIGhlaWdodD0iOTYiIGZpbGw9IiNmNWYzZWYiLz4KPHRleHQgeD0iMTQwIiB5PSIyODAiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iIzk5OSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+bGFiOTA0XzIwMjVRMl8wNTI4X+uzteumrO2bhOyDneu5hF/tmITquIguanBnPC90ZXh0Pgo8cmVjdCB4PSI2OCIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI3MiIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI3NyIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4MCIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4NCIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4OSIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI5MiIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI5NiIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI5OSIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMDQiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTA4IiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjExMSIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMTYiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTIwIiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjEyMyIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMjciIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTMyIiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjEzNSIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMzkiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTQ0IiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE0NyIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNTEiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTU2IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE2MCIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNjMiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTY4IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE3MiIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNzUiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTc5IiB5PSIyOTAiIHdpZHRoPSIzIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE4NCIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxODciIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTkxIiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE5NSIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxOTgiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMjAzIiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjIwNyIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMCIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIyMTAiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjAiIGZpbGw9IiMzMzMiLz4KPHRleHQgeD0iMTQwIiB5PSIzMjYiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iI2JiYiIgdGV4dC1hbmNob3I9Im1pZGRsZSI+6rCQ7IKs7ZWp64uI64ukLiDrmJAg67Cp66y47ZW07KO87IS47JqUITwvdGV4dD4KPHRleHQgeD0iMTQwIiB5PSIzMzgiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iNyIgZmlsbD0iI2NjYyIgdGV4dC1hbmNob3I9Im1pZGRsZSI+7IKs7JeF7J6Q67KI7Zi4OiAyMzQtNTYtNzg5MDE8L3RleHQ+Cjwvc3ZnPg==',mode:'photo',filename:'lab904_2025Q2_0528_복리후생비_팀회식저녁_현금.jpg',createdAt:new Date().toISOString()},
    {id:'s2',date:'2025-05-25',project:'louis',amount:56810,usage:'서울→부산 KTX 출장',category:'여비교통비',payType:'card',card:'shinhan',cardName:'신한카드',imagePreview:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyODAiIGhlaWdodD0iMzYwIiB2aWV3Qm94PSIwIDAgMjgwIDM2MCI+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iMzYwIiBmaWxsPSIjZmFmYWY4Ii8+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iNTIiIGZpbGw9IiNmMGY0ZmYiLz4KPGxpbmUgeDE9IjAiIHkxPSI1MiIgeDI9IjI4MCIgeTI9IjUyIiBzdHJva2U9IiNkNGNmYzgiIHN0cm9rZS13aWR0aD0iMSIvPgo8dGV4dCB4PSIxNCIgeT0iMjAiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiPuy9lOugiOydvCBLVFg8L3RleHQ+Cjx0ZXh0IHg9IjE0IiB5PSIzNCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjODg4Ij7sirnssKjqtowg7JiB7IiY7KadIMK3IOyEnOyauOyXrSDrsJzrp6Q8L3RleHQ+Cjx0ZXh0IHg9IjE0IiB5PSI0NyIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjODg4Ij53d3cubGV0c2tvcmFpbC5jb208L3RleHQ+CjxyZWN0IHg9IjE0IiB5PSI1OCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjE0IiBmaWxsPSIjMWExYTFhIiByeD0iMiIvPgo8dGV4dCB4PSIxOCIgeT0iNjgiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOSIgZmlsbD0iI2ZhZmFmOCI+MjAyNS4wNS4yNTwvdGV4dD4KPHJlY3QgeD0iOTIiIHk9IjU4IiB3aWR0aD0iNzQiIGhlaWdodD0iMTQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2FhYSIgc3Ryb2tlLXdpZHRoPSIxIiByeD0iMiIvPgo8dGV4dCB4PSI5NiIgeT0iNjgiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOSIgZmlsbD0iIzg4OCI+7Iug7ZWc7Lm065OcPC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSI4MCIgeDI9IjI2NiIgeTI9IjgwIiBzdHJva2U9IiNjY2MiIHN0cm9rZS1kYXNoYXJyYXk9IjQsMyIgc3Ryb2tlLXdpZHRoPSIxIi8+Cjx0ZXh0IHg9IjE0IiB5PSI5NSIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzU1NSI+7Je07LCo67KI7Zi4PC90ZXh0Pgo8dGV4dCB4PSIyMDAiIHk9Ijk1IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj5LVFggMTA1PC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSIxMDAiIHgyPSIyMTAiIHkyPSIxMDAiIHN0cm9rZT0iI2U4ZTRkZSIgc3Ryb2tlLWRhc2hhcnJheT0iMiwyIiBzdHJva2Utd2lkdGg9IjAuNSIvPgo8dGV4dCB4PSIxNCIgeT0iMTE0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7stpzrsJw8L3RleHQ+Cjx0ZXh0IHg9IjIwMCIgeT0iMTE0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj7shJzsmrggMDk6MzA8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjEyMCIgeDI9IjIxMCIgeTI9IjEyMCIgc3Ryb2tlPSIjZThlNGRlIiBzdHJva2UtZGFzaGFycmF5PSIyLDIiIHN0cm9rZS13aWR0aD0iMC41Ii8+Cjx0ZXh0IHg9IjE0IiB5PSIxMzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZpbGw9IiM1NTUiPuuPhOywqTwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSIxMzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPuu2gOyCsCAxMTo1NzwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTQwIiB4Mj0iMjEwIiB5Mj0iMTQwIiBzdHJva2U9IiNlOGU0ZGUiIHN0cm9rZS1kYXNoYXJyYXk9IjIsMiIgc3Ryb2tlLXdpZHRoPSIwLjUiLz4KPHRleHQgeD0iMTQiIHk9IjE1NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzU1NSI+7KKM7ISdPC90ZXh0Pgo8dGV4dCB4PSIyMDAiIHk9IjE1NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSIgdGV4dC1hbmNob3I9ImVuZCI+N+2YuOywqCAxMkE8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjE2MCIgeDI9IjIxMCIgeTI9IjE2MCIgc3Ryb2tlPSIjZThlNGRlIiBzdHJva2UtZGFzaGFycmF5PSIyLDIiIHN0cm9rZS13aWR0aD0iMC41Ii8+Cjx0ZXh0IHg9IjE0IiB5PSIxNzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZpbGw9IiM1NTUiPuyatOyehDwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSIxNzQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjU5LDgwMDwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTgwIiB4Mj0iMjEwIiB5Mj0iMTgwIiBzdHJva2U9IiNlOGU0ZGUiIHN0cm9rZS1kYXNoYXJyYXk9IjIsMiIgc3Ryb2tlLXdpZHRoPSIwLjUiLz4KPHRleHQgeD0iMTQiIHk9IjE5NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzU1NSI+7ZWg7J24ICg1JSk8L3RleHQ+Cjx0ZXh0IHg9IjIwMCIgeT0iMTk0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjRTA1QTVBIiB0ZXh0LWFuY2hvcj0iZW5kIj4tMiw5OTA8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjIwMCIgeDI9IjI2NiIgeTI9IjIwMCIgc3Ryb2tlPSIjYmJiIiBzdHJva2UtZGFzaGFycmF5PSI0LDMiIHN0cm9rZS13aWR0aD0iMSIvPgo8bGluZSB4MT0iMTQiIHkxPSIyMDQiIHgyPSIyNjYiIHkyPSIyMDQiIHN0cm9rZT0iIzFhMWExYSIgc3Ryb2tlLXdpZHRoPSIyIi8+Cjx0ZXh0IHg9IjE0IiB5PSIyMjAiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiPu2VqSAgICDqs4Q8L3RleHQ+Cjx0ZXh0IHg9IjI2NiIgeT0iMjIwIiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEzIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj41Niw4MTDsm5A8L3RleHQ+CjxyZWN0IHg9IjE0IiB5PSIyMzAiIHdpZHRoPSIyNTIiIGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2FhYSIgc3Ryb2tlLXdpZHRoPSIxLjUiIHJ4PSIyIi8+Cjx0ZXh0IHg9IjE0MCIgeT0iMjQ1IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjODg4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7subTrk5zsoJzsmbggIMK3ICDsl6zruYTqtZDthrXruYQ8L3RleHQ+CjxyZWN0IHg9IjE0IiB5PSIyNjAiIHdpZHRoPSIxMTYiIGhlaWdodD0iMTQiIGZpbGw9IiNmMWYzZjUiIHJ4PSIyIi8+Cjx0ZXh0IHg9IjE4IiB5PSIyNzAiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOSIgZmlsbD0iIzg4OCI+66Oo7J207Iqk64Sk7J207LKYIMK3IDIwMjVRMjwvdGV4dD4KPGxpbmUgeDE9IjAiIHkxPSIyODIiIHgyPSIyODAiIHkyPSIyODIiIHN0cm9rZT0iI2Q0Y2ZjOCIgc3Ryb2tlLWRhc2hhcnJheT0iNCwzIiBzdHJva2Utd2lkdGg9IjEiLz4KPHJlY3QgeD0iMCIgeT0iMjgyIiB3aWR0aD0iMjgwIiBoZWlnaHQ9Ijc4IiBmaWxsPSIjZjVmM2VmIi8+Cjx0ZXh0IHg9IjE0MCIgeT0iMjk4IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjcuNSIgZmlsbD0iIzk5OSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+66Oo7J207Iqk64Sk7J207LKYXzIwMjVRMl8wNTI1X+yXrOu5hOq1kO2Gteu5hF/si6DtlZzsubTrk5wuanBnPC90ZXh0Pgo8dGV4dCB4PSIxNDAiIHk9IjMxMSIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI4IiBmaWxsPSIjYmJiIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7subTrk5wg64K07Jet7IScIOykkeuztSDigJQg7IS466y0IOygnOyZuCDsspjrpqw8L3RleHQ+CjxyZWN0IHg9IjY4IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjcyIiB5PSIzMjAiIHdpZHRoPSIxIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9Ijc1IiB5PSIzMjAiIHdpZHRoPSIzIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjgwIiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9Ijg0IiB5PSIzMjAiIHdpZHRoPSIxIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9Ijg3IiB5PSIzMjAiIHdpZHRoPSIzIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjkyIiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9Ijk2IiB5PSIzMjAiIHdpZHRoPSIxIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9Ijk5IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjEwMyIgeT0iMzIwIiB3aWR0aD0iMyIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxMDgiIHk9IjMyMCIgd2lkdGg9IjEiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTExIiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjExNSIgeT0iMzIwIiB3aWR0aD0iMyIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxMjAiIHk9IjMyMCIgd2lkdGg9IjEiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTIzIiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjEyNyIgeT0iMzIwIiB3aWR0aD0iMyIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxMzIiIHk9IjMyMCIgd2lkdGg9IjEiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTM1IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjEzOSIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxNDIiIHk9IjMyMCIgd2lkdGg9IjMiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTQ3IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjE1MSIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxNTQiIHk9IjMyMCIgd2lkdGg9IjMiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTU5IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjE2MyIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxNjYiIHk9IjMyMCIgd2lkdGg9IjIiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTcwIiB5PSIzMjAiIHdpZHRoPSIzIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjE3NSIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxNzgiIHk9IjMyMCIgd2lkdGg9IjIiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTgyIiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjE4NiIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIxODkiIHk9IjMyMCIgd2lkdGg9IjMiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMTk0IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+CjxyZWN0IHg9IjE5OCIgeT0iMzIwIiB3aWR0aD0iMSIgaGVpZ2h0PSIxOCIgZmlsbD0iI2FhYSIvPgo8cmVjdCB4PSIyMDEiIHk9IjMyMCIgd2lkdGg9IjIiIGhlaWdodD0iMTgiIGZpbGw9IiNhYWEiLz4KPHJlY3QgeD0iMjA1IiB5PSIzMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjE4IiBmaWxsPSIjYWFhIi8+Cjx0ZXh0IHg9IjE0MCIgeT0iMzUyIiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjciIGZpbGw9IiNjY2MiIHRleHQtYW5jaG9yPSJtaWRkbGUiPuyCrOyXheyekOuyiO2YuDogMzQ1LTY3LTg5MDEyPC90ZXh0Pgo8L3N2Zz4=',mode:'photo',filename:'루이스네이처_2025Q2_0525_여비교통비_KTX출장_신한카드.jpg',createdAt:new Date().toISOString()},
    {id:'s3',date:'2025-06-01',project:'interior',amount:87600,usage:'타일 철거 자재 구입',category:'재료비',payType:'cash',card:null,cardName:'',imagePreview:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyODAiIGhlaWdodD0iMzgwIiB2aWV3Qm94PSIwIDAgMjgwIDM4MCI+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iMzgwIiBmaWxsPSIjZmFmYWY4Ii8+CjxyZWN0IHdpZHRoPSIyODAiIGhlaWdodD0iNTIiIGZpbGw9IiNmMGVkZTgiLz4KPGxpbmUgeDE9IjAiIHkxPSI1MiIgeDI9IjI4MCIgeTI9IjUyIiBzdHJva2U9IiNkNGNmYzgiIHN0cm9rZS13aWR0aD0iMSIvPgo8dGV4dCB4PSIxNCIgeT0iMjIiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiPuydtOuniO2KuCDqsJXrgqjsoJA8L3RleHQ+Cjx0ZXh0IHg9IjE0IiB5PSIzNiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjODg4Ij7shJzsmrgg6rCV64Ko6rWsIO2FjO2XpOuegOuhnCAyMzwvdGV4dD4KPHRleHQgeD0iMTQiIHk9IjQ3IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjkiIGZpbGw9IiM4ODgiPlRFTCAwMi01NTUtMTIzNDwvdGV4dD4KPHJlY3QgeD0iMTQiIHk9IjU4IiB3aWR0aD0iNzIiIGhlaWdodD0iMTQiIGZpbGw9IiMxYTFhMWEiIHJ4PSIyIi8+Cjx0ZXh0IHg9IjE4IiB5PSI2OCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjZmFmYWY4Ij4yMDI1LjA2LjAxPC90ZXh0Pgo8cmVjdCB4PSI5MiIgeT0iNTgiIHdpZHRoPSI2MCIgaGVpZ2h0PSIxNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjE0NUYwIiBzdHJva2Utd2lkdGg9IjEiIHJ4PSIyIi8+Cjx0ZXh0IHg9Ijk2IiB5PSI2OCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjMjE0NUYwIj7tmITquIjqsrDsoJw8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjgwIiB4Mj0iMjY2IiB5Mj0iODAiIHN0cm9rZT0iI2NjYyIgc3Ryb2tlLWRhc2hhcnJheT0iNCwzIiBzdHJva2Utd2lkdGg9IjEiLz4KPHRleHQgeD0iMTQiIHk9Ijk0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7soITshKAgMTVtIOuhpDwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSI5NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSIgdGV4dC1hbmNob3I9ImVuZCI+MTgsNTAwPC90ZXh0Pgo8bGluZSB4MT0iMTQiIHkxPSIxMDAiIHgyPSIyMTAiIHkyPSIxMDAiIHN0cm9rZT0iI2U4ZTRkZSIgc3Ryb2tlLWRhc2hhcnJheT0iMiwyIiBzdHJva2Utd2lkdGg9IjAuNSIvPgo8dGV4dCB4PSIxNCIgeT0iMTE0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjNTU1Ij7rsKnsiJgg7Iuk66as7L2YIOqxtDwvdGV4dD4KPHRleHQgeD0iMjAwIiB5PSIxMTQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjEyLDAwMDwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTIwIiB4Mj0iMjEwIiB5Mj0iMTIwIiBzdHJva2U9IiNlOGU0ZGUiIHN0cm9rZS1kYXNoYXJyYXk9IjIsMiIgc3Ryb2tlLXdpZHRoPSIwLjUiLz4KPHRleHQgeD0iMTQiIHk9IjEzNCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzU1NSI+7YOA7J28IOygkeywqeygnCDDlzM8L3RleHQ+Cjx0ZXh0IHg9IjIwMCIgeT0iMTM0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj40NSwwMDA8L3RleHQ+CjxsaW5lIHgxPSIxNCIgeTE9IjE0MCIgeDI9IjIxMCIgeTI9IjE0MCIgc3Ryb2tlPSIjZThlNGRlIiBzdHJva2UtZGFzaGFycmF5PSIyLDIiIHN0cm9rZS13aWR0aD0iMC41Ii8+Cjx0ZXh0IHg9IjE0IiB5PSIxNTQiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZpbGw9IiM1NTUiPuuniOyKpO2CuSDthYzsnbTtlIQ8L3RleHQ+Cjx0ZXh0IHg9IjIwMCIgeT0iMTU0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj4zLDIwMDwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTYwIiB4Mj0iMjEwIiB5Mj0iMTYwIiBzdHJva2U9IiNlOGU0ZGUiIHN0cm9rZS1kYXNoYXJyYXk9IjIsMiIgc3Ryb2tlLXdpZHRoPSIwLjUiLz4KPHRleHQgeD0iMTQiIHk9IjE3NCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzU1NSI+7J6l6rCRICgxMOy8pOugiCk8L3RleHQ+Cjx0ZXh0IHg9IjIwMCIgeT0iMTc0IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMWExYTFhIiB0ZXh0LWFuY2hvcj0iZW5kIj44LDkwMDwvdGV4dD4KPGxpbmUgeDE9IjE0IiB5MT0iMTgyIiB4Mj0iMjY2IiB5Mj0iMTgyIiBzdHJva2U9IiNiYmIiIHN0cm9rZS1kYXNoYXJyYXk9IjQsMyIgc3Ryb2tlLXdpZHRoPSIxIi8+CjxsaW5lIHgxPSIxNCIgeTE9IjE4NiIgeDI9IjI2NiIgeTI9IjE4NiIgc3Ryb2tlPSIjMWExYTFhIiBzdHJva2Utd2lkdGg9IjIiLz4KPHRleHQgeD0iMTQiIHk9IjIwMiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSIxMyIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhMWExYSI+7ZWpICAgIOqzhDwvdGV4dD4KPHRleHQgeD0iMjY2IiB5PSIyMDIiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTMiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYTFhMWEiIHRleHQtYW5jaG9yPSJlbmQiPjg3LDYwMOybkDwvdGV4dD4KPHJlY3QgeD0iMTQiIHk9IjIxMiIgd2lkdGg9IjI1MiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjE0NUYwIiBzdHJva2Utd2lkdGg9IjEuNSIgcng9IjIiLz4KPHRleHQgeD0iMTQwIiB5PSIyMjciIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iMTAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMyMTQ1RjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiPuyEuOustO2PrO2VqCAgwrcgIOyerOujjOu5hDwvdGV4dD4KPHJlY3QgeD0iMTQiIHk9IjI0MiIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxNCIgZmlsbD0iI0VFRjFGRSIgcng9IjIiLz4KPHRleHQgeD0iMTgiIHk9IjI1MiIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI5IiBmaWxsPSIjMjE0NUYwIj7snbjthYzrpqzslrRB64+ZIMK3IDIwMjVRMjwvdGV4dD4KPGxpbmUgeDE9IjAiIHkxPSIyNjQiIHgyPSIyODAiIHkyPSIyNjQiIHN0cm9rZT0iI2Q0Y2ZjOCIgc3Ryb2tlLWRhc2hhcnJheT0iNCwzIiBzdHJva2Utd2lkdGg9IjEiLz4KPHJlY3QgeD0iMCIgeT0iMjY0IiB3aWR0aD0iMjgwIiBoZWlnaHQ9IjExNiIgZmlsbD0iI2Y1ZjNlZiIvPgo8dGV4dCB4PSIxNDAiIHk9IjI4MCIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3LG1vbm9zcGFjZSIgZm9udC1zaXplPSI4IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7snbjthYzrpqzslrRB64+ZXzIwMjVRMl8wNjAxX+yerOujjOu5hF/tmITquIguanBnPC90ZXh0Pgo8cmVjdCB4PSI3MCIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI3NCIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI3NyIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4MiIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4NSIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI4OSIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI5MyIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSI5NiIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMDEiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTA1IiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjEwOCIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMTEiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTE2IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjEyMCIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMjMiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTI3IiB5PSIyOTAiIHdpZHRoPSIzIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjEzMiIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxMzUiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTM5IiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE0MiIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNDciIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTUxIiB5PSIyOTAiIHdpZHRoPSIxIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE1NCIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNTgiIHk9IjI5MCIgd2lkdGg9IjEiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTYxIiB5PSIyOTAiIHdpZHRoPSIzIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE2NiIgeT0iMjkwIiB3aWR0aD0iMiIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxNzAiIHk9IjI5MCIgd2lkdGg9IjEiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTczIiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE3NyIgeT0iMjkwIiB3aWR0aD0iMyIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxODIiIHk9IjI5MCIgd2lkdGg9IjEiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTg1IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjE4OSIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIxOTIiIHk9IjI5MCIgd2lkdGg9IjMiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMTk3IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+CjxyZWN0IHg9IjIwMSIgeT0iMjkwIiB3aWR0aD0iMSIgaGVpZ2h0PSIyMiIgZmlsbD0iIzMzMyIvPgo8cmVjdCB4PSIyMDQiIHk9IjI5MCIgd2lkdGg9IjIiIGhlaWdodD0iMjIiIGZpbGw9IiMzMzMiLz4KPHJlY3QgeD0iMjA4IiB5PSIyOTAiIHdpZHRoPSIyIiBoZWlnaHQ9IjIyIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjE0MCIgeT0iMzI2IiBmb250LWZhbWlseT0iQ291cmllciBOZXcsbW9ub3NwYWNlIiBmb250LXNpemU9IjgiIGZpbGw9IiNiYmIiIHRleHQtYW5jaG9yPSJtaWRkbGUiPiog67O4IOyYgeyImOymneydgCDsoJXtkojsnoXri4jri6QgKjwvdGV4dD4KPHRleHQgeD0iMTQwIiB5PSIzMzgiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iOCIgZmlsbD0iI2JiYiIgdGV4dC1hbmNob3I9Im1pZGRsZSI+6rCQ7IKs7ZWp64uI64ukLiDrmJAg67Cp66y47ZW07KO87IS47JqUITwvdGV4dD4KPHRleHQgeD0iMTQwIiB5PSIzNTIiIGZvbnQtZmFtaWx5PSJDb3VyaWVyIE5ldyxtb25vc3BhY2UiIGZvbnQtc2l6ZT0iNyIgZmlsbD0iI2NjYyIgdGV4dC1hbmNob3I9Im1pZGRsZSI+7IKs7JeF7J6Q67KI7Zi4OiAxMjMtNDUtNjc4OTA8L3RleHQ+Cjwvc3ZnPg==',mode:'photo',filename:'인테리어A동_2025Q2_0601_재료비_타일자재_현금.jpg',createdAt:new Date().toISOString()},
    {id:'s4',date:'2025-05-22',project:'fractal',amount:128000,usage:'장비 렌탈비',category:'임차료',payType:'transfer',card:null,cardName:'',imagePreview:null,mode:'manual',filename:'프랙탈노이즈_2025Q2_0522_임차료_장비렌탈비_이체.manual',createdAt:new Date().toISOString()},
    {id:'s5',date:'2025-06-05',project:'lab904',amount:24000,usage:'클라이언트 미팅 커피',category:'접대비',payType:'card',card:'kookmin',cardName:'국민카드',imagePreview:null,mode:'manual',filename:'lab904_2025Q2_0605_접대비_클라이언트미팅_국민카드.manual',createdAt:new Date().toISOString()},
  ];
  saveDB(receipts);
}

// ══ 사업자 등록번호 관련 ══
// ══ 사업자 등록증 이미지 관련 ══
const BIZ_CERT_KEY = 'biz_cert_v1';

function onBizCertSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    store.setItem(BIZ_CERT_KEY, ev.target.result);
    renderBizCertSection();
    showToast('사업자 등록증이 저장되었어요 ✓');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function clearBizCert() {
  if (!confirm('저장된 사업자 등록증 이미지를 삭제할까요?')) return;
  store.removeItem(BIZ_CERT_KEY);
  renderBizCertSection();
  showToast('삭제되었어요');
}

function renderBizCertSection() {
  const cert = store.getItem(BIZ_CERT_KEY) || '';
  const uploadArea  = document.getElementById('biz-cert-upload-area');
  const previewArea = document.getElementById('biz-cert-preview-area');
  const previewImg  = document.getElementById('biz-cert-preview-img');
  if (!uploadArea) return;
  if (cert) {
    uploadArea.style.display  = 'none';
    previewArea.style.display = 'block';
    if (previewImg) previewImg.src = cert;
  } else {
    uploadArea.style.display  = 'block';
    previewArea.style.display = 'none';
  }
}

async function shareWithCert() {
  const cert  = store.getItem(BIZ_CERT_KEY)  || '';
  const email = store.getItem('biz_email_v1') || '';
  const num   = store.getItem('biz_number_v1')|| '';

  if (!cert) { showToast('설정에서 사업자 등록증을 먼저 업로드해주세요'); return; }

  const text = [
    '세금계산서 발행을 요청드립니다.',
    '',
    email ? `발행 메일주소: ${email}` : '',
    num   ? `사업자 등록번호: ${num}` : '',
    '',
    '사업자 등록증 이미지를 첨부합니다.',
    '감사합니다.',
  ].filter(Boolean).join('\n');

  // base64 → File
  const arr  = cert.split(',');
  const mime = (arr[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bstr = atob(arr[1]);
  const u8   = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
  const file = new File([u8], '사업자등록증.jpg', { type: mime });

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '세금계산서 발행 요청', text });
      showToast('공유 완료 ✓');
      return;
    } catch(e) { /* 취소 또는 미지원 → 폴백 */ }
  }

  // 폴백: 이미지 다운로드 + 텍스트 클립보드
  const a = document.createElement('a');
  a.href = cert; a.download = '사업자등록증.jpg'; a.click();
  setTimeout(() => copyToClipboard(text), 400);
  showToast('이미지 저장 + 안내문 복사됐어요 ✓', 3000);
}

const BIZ_NUMBER_KEY = 'biz_number_v1';

function loadBizNumber() { return store.getItem(BIZ_NUMBER_KEY) || ''; }

function formatBizNumber(input) {
  let v = input.value.replace(/[^0-9]/g, '');
  if (v.length > 10) v = v.slice(0, 10);
  if (v.length > 5) v = v.slice(0,3) + '-' + v.slice(3,5) + '-' + v.slice(5);
  else if (v.length > 3) v = v.slice(0,3) + '-' + v.slice(3);
  input.value = v;
  const row = document.getElementById('biz-number-saved-row');
  if (row) row.style.display = 'none';
}

function saveBizNumber() {
  const input = document.getElementById('biz-number-input');
  if (!input) return;
  const raw = input.value.replace(/[^0-9]/g, '');
  if (raw.length !== 10) { showToast('사업자 등록번호는 10자리입니다 (예: 123-45-67890)'); return; }
  const formatted = raw.slice(0,3) + '-' + raw.slice(3,5) + '-' + raw.slice(5);
  store.setItem(BIZ_NUMBER_KEY, formatted);
  renderBizNumberSection();
  showToast('사업자 등록번호가 저장되었어요 ✓');
}

function clearBizNumber() {
  if (!confirm('저장된 사업자 등록번호를 삭제할까요?')) return;
  store.removeItem(BIZ_NUMBER_KEY);
  renderBizNumberSection();
  showToast('삭제되었어요');
}

function renderBizNumberSection() {
  const input = document.getElementById('biz-number-input');
  const savedRow = document.getElementById('biz-number-saved-row');
  const display = document.getElementById('biz-number-display');
  const num = loadBizNumber();
  const saveBtn = input ? input.nextElementSibling : null;
  if (num) {
    if (input) { input.value = ''; input.style.display = 'none'; }
    if (saveBtn) saveBtn.style.display = 'none';
    if (savedRow) { savedRow.style.display = 'flex'; }
    if (display) display.textContent = num;
  } else {
    if (input) { input.value = ''; input.style.display = 'block'; }
    if (saveBtn) saveBtn.style.display = 'block';
    if (savedRow) savedRow.style.display = 'none';
  }
}

function shareBusinessNumber() {
  const num = loadBizNumber();
  if (!num) { showToast('설정에서 사업자 등록번호를 먼저 등록해주세요'); return; }
  const vt = state.voucherType;
  let msg = '';
  if (vt === 'cash_rcpt') {
    msg = `현금영수증을 사업자 지출증빙으로 발급해 주시기 바랍니다.\n\n사업자 등록번호: ${num}\n\n감사합니다.`;
  } else if (vt === 'simple') {
    msg = `현금영수증으로 발급해 주시기 바랍니다.\n\n사업자 등록번호: ${num}\n(사업자 지출증빙용)\n\n감사합니다.`;
  } else {
    msg = `사업자 등록번호: ${num}`;
  }
  if (navigator.share) {
    navigator.share({ title: '사업자 등록번호', text: msg })
      .then(() => showToast('공유 완료 ✓'))
      .catch(() => copyToClipboard(num));
  } else {
    copyToClipboard(num);
  }
}

// ══ 사업자 메일 관련 ══
const BIZ_EMAIL_KEY = 'biz_email_v1';

function loadBizEmail() { return store.getItem(BIZ_EMAIL_KEY) || ''; }

function onBizEmailInput(val) {
  // 입력 중 저장된 주소 표시 숨김
  const row = document.getElementById('biz-email-saved-row');
  if (row) row.style.display = 'none';
}

function saveBizEmail() {
  const input = document.getElementById('biz-email-input');
  if (!input) return;
  const email = input.value.trim();
  if (!email) { showToast('메일주소를 입력해주세요'); return; }
  if (!email.includes('@')) { showToast('올바른 이메일 형식이 아닙니다'); return; }
  store.setItem(BIZ_EMAIL_KEY, email);
  renderBizEmailSection();
  showToast('메일주소가 저장되었어요 ✓');
}

function clearBizEmail() {
  if (!confirm('저장된 메일주소를 삭제할까요?')) return;
  store.removeItem(BIZ_EMAIL_KEY);
  renderBizEmailSection();
  showToast('삭제되었어요');
}

function renderBizEmailSection() {
  const input = document.getElementById('biz-email-input');
  const savedRow = document.getElementById('biz-email-saved-row');
  const display = document.getElementById('biz-email-display');
  const email = loadBizEmail();
  if (email) {
    if (input) { input.value = ''; input.style.display = 'none'; }
    if (savedRow) { savedRow.style.display = 'flex'; }
    if (display) display.textContent = email;
    // 저장 버튼 숨김
    const saveBtn = input ? input.nextElementSibling : null;
    if (saveBtn) saveBtn.style.display = 'none';
  } else {
    if (input) { input.value = ''; input.style.display = 'block'; }
    if (savedRow) savedRow.style.display = 'none';
    const saveBtn = input ? input.nextElementSibling : null;
    if (saveBtn) saveBtn.style.display = 'block';
  }
}

function shareBusinessEmail() {
  const email = loadBizEmail();
  if (!email) { showToast('설정에서 메일주소를 먼저 등록해주세요'); return; }
  const message = `세금계산서 발행을 요청드립니다.\n\n발행 메일주소: ${email}\n\n공급받는 자 사업자번호는 사업자등록증을 확인해주세요.\n감사합니다.`;

  if (navigator.share) {
    navigator.share({ title: '세금계산서 발행 요청', text: message })
      .then(() => showToast('공유 완료 ✓'))
      .catch(() => copyToClipboard(message));
  } else {
    copyToClipboard(message);
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('클립보드에 복사됐어요 ✓'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToast('클립보드에 복사됐어요 ✓');
  }
}

seedIfEmpty();
checkLogin();
renderHome();
// 앱 시작 시 드라이브에서 최신 데이터/설정을 받아 다른 기기 변경분 반영 (다기기 동기화)
loadFromDrive({ startup:true });

// ══════════════════════════════════════
// DETAIL MODAL — 영수증 상세 보기
// ══════════════════════════════════════
function openDetail(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  // 로컬(IndexedDB) → 드라이브 풀이미지 순으로 불러와 표시 (imagePreview가 없을 때)
  if (!r.imagePreview && r.mode === 'photo') {
    _renderDetail(r);  // 우선 즉시 렌더(플레이스홀더), 이미지는 도착 시 교체
    loadFullImage(r).then(function(img) {
      if (img) { r.imagePreview = img; _renderDetail(r); }
    });
  } else {
    _renderDetail(r);
  }
}
function _renderDetail(r) {
  const id = r.id; // 하위 호환성 유지
  const p = getProjById(r.project);
  const isCard = r.payType === 'card';
  const payLabel = isCard ? `💳 ${r.cardName||'카드'}` : r.payType==='cash' ? '💵 현금' : '🏦 이체';
  const taxLabel = isCard ? '💳 카드' : '세무포함';
  const taxClass = isCard ? 'badge-gray' : 'badge-green';

  // 헤더
  document.getElementById('detail-header').innerHTML = `
    <div class="detail-proj-icon" style="background:${p.color}22">${p.icon}</div>
    <div>
      <div class="detail-title">${r.usage||'—'}</div>
      <div style="font-size:12px;color:var(--gray-400);margin-top:2px">${p.name} · ${fmtDateKo(r.date)}</div>
    </div>
    <button type="button" class="detail-close" onclick="closeDetail()">✕</button>`;

  // 바디
  let imgHTML = '';
  if (r.imagePreview) {
    imgHTML = `<div class="detail-img-wrap">
      <img src="${r.imagePreview}" alt="영수증 이미지" onclick="toggleImgZoom(this)"
        style="cursor:zoom-in;transition:transform .2s">
      <div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.45);border-radius:999px;padding:4px 10px;font-size:11px;color:white;font-weight:600">탭하면 확대 🔍</div>
    </div>`;
  } else {
    imgHTML = `<div class="detail-img-wrap">
      <div class="detail-img-placeholder">
        <span>${r.mode==='manual' ? '✏️' : '📷'}</span>
        <p>${r.mode==='manual' ? '직접 입력된 내역입니다' : '이미지가 없습니다'}</p>
      </div>
    </div>`;
  }

  // 금액 색상: 카드면 흐림
  const amtColor = isCard ? 'color:var(--gray-400)' : '';

  document.getElementById('detail-body').innerHTML = `
    ${imgHTML}

    <div class="detail-amount-card">
      <div class="detail-amount-num" style="${amtColor}">₩${fmtAmount(r.amount)}</div>
      <div class="detail-amount-unit">원</div>
    </div>

    <div class="detail-rows">
      <div class="detail-row">
        <span class="detail-row-icon">📅</span>
        <span class="detail-row-label">날짜</span>
        <span class="detail-row-val">${fmtDateKo(r.date)} (${getQuarter(r.date)}분기)</span>
      </div>
      <div class="detail-row">
        <span class="detail-row-icon">${p.icon}</span>
        <span class="detail-row-label">프로젝트</span>
        <span class="detail-row-val">${p.name}</span>
        ${p.completed ? '<span class="detail-row-badge"><span class="badge badge-gray">완료</span></span>' : ''}
      </div>
      <div class="detail-row">
        <span class="detail-row-icon">✏️</span>
        <span class="detail-row-label">용도</span>
        <span class="detail-row-val">${r.usage||'—'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-row-icon">📋</span>
        <span class="detail-row-label">계정과목</span>
        <span class="detail-row-val">${getCatIcon(r.category)} ${r.category||'—'}</span>
        <span class="detail-row-badge"><span class="badge badge-blue">${r.category||''}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-row-icon">💳</span>
        <span class="detail-row-label">결제수단</span>
        <span class="detail-row-val">${payLabel}</span>
      </div>
      ${r.voucherLabel ? `
      <div class="detail-row">
        <span class="detail-row-icon">🧾</span>
        <span class="detail-row-label">증빙유형</span>
        <span class="detail-row-val">${r.voucherLabel}</span>
        <span class="detail-row-badge"><span class="badge ${r.vatOk?'badge-green':'badge-orange'}">${r.vatOk?'공제가능':'공제불가'}</span></span>
      </div>
      <div class="detail-row" style="background:${r.vatOk?'var(--success-light)':'var(--orange-light)'}">
        <span class="detail-row-icon">${r.vatOk?'✅':'⚠️'}</span>
        <span class="detail-row-label">공급가액</span>
        <span class="detail-row-val" style="font-family:var(--mono)">₩${fmtAmount(r.supplyAmt)}</span>
        <span class="detail-row-badge" style="font-family:var(--mono);font-size:12px;color:var(--success)">+VAT ₩${fmtAmount(r.vatAmt)}</span>
      </div>` : ''}

      <div class="detail-row">
        <span class="detail-row-icon">${isCard ? '🚫' : '✅'}</span>
        <span class="detail-row-label">세무</span>
        <span class="detail-row-val">${isCard ? '카드 내역서 처리 — 세무 제외' : '세무 신고 포함 대상'}</span>
        <span class="detail-row-badge"><span class="badge ${taxClass}">${taxLabel}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-row-icon">🕐</span>
        <span class="detail-row-label">등록일</span>
        <span class="detail-row-val" style="font-size:12px;color:var(--gray-400)">${r.createdAt ? new Date(r.createdAt).toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'}</span>
      </div>
    </div>

    ${r.filename ? `<div class="detail-filename">
      <div class="detail-filename-label">💾 저장 파일명</div>
      <div class="detail-filename-val">${r.filename}</div>
    </div>` : ''}

    <div class="detail-action-row">
      <button type="button" class="btn btn-primary" onclick="openEditSheet('${r.id}')">✏️ 수정하기</button>
      <button type="button" class="btn btn-secondary" onclick="openShareSheet('${r.id}')">📤 공유하기</button>
    </div>
    <div class="detail-action-row2">
      ${r.imagePreview ? `<button type="button" class="btn btn-secondary" style="flex:1" onclick="downloadImage('${r.id}')">⬇️ 이미지 저장</button>` : ''}
      <button type="button" class="btn btn-danger" style="flex:0;padding:0 18px;font-size:13px" onclick="deleteReceipt('${r.id}')">🗑️ 삭제</button>
    </div>
    <div style="height:8px"></div>
  `;

  document.getElementById('detail-modal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  document.getElementById('detail-modal').classList.remove('show');
  document.body.style.overflow = '';
  imgZoomed = false;
}

let imgZoomed = false;
function toggleImgZoom(img) {
  imgZoomed = !imgZoomed;
  img.style.transform = imgZoomed ? 'scale(1.8)' : 'scale(1)';
  img.style.cursor = imgZoomed ? 'zoom-out' : 'zoom-in';
  img.style.transformOrigin = 'center center';
}

function downloadImage(id) {
  const r = receipts.find(x => x.id === id);
  if (!r || !r.imagePreview) return;
  const a = document.createElement('a');
  a.href = r.imagePreview;
  a.download = r.filename || (r.id + '.jpg');
  a.click();
  showToast('이미지 저장됨 ✓');
}

// ══════════════════════════════════════
// EDIT SHEET
// ══════════════════════════════════════
let editingId = null;

function openEditSheet(id) {
  editingId = id;
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  const p = getProjById(r.project);

  const projChips = projects.filter(p2 => !p2.completed || p2.id === r.project).map(p2 => `
    <div class="edit-chip${r.project===p2.id?' on':''}" data-proj="${p2.id}" onclick="editSelectProj('${p2.id}',this)"
      style="${r.project===p2.id?`border-color:${p2.color};background:${p2.color}22;color:${p2.color}`:''}">
      ${p2.icon} ${p2.name}
    </div>`).join('');

  const catChips = CAT_GROUPS.map(g=>{
    const ac=g.color||'#888';
    return `<div style="margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">
        <span style="display:inline-block;width:3px;height:9px;background:${ac};border-radius:2px"></span>
        <span style="font-size:9px;font-weight:700;color:${ac};text-transform:uppercase;letter-spacing:.4px">${g.label}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${g.items.map(c=>`<div class="chip-sm${r.category===c?' sel':''}" data-cat="${c}" onclick="editSelectCat('${c}',this)"
          style="${r.category===c?`border-color:${ac};background:${ac}18;color:${ac};font-weight:700`:''}">${getCatIcon(c)} ${c}</div>`).join('')}
      </div>
    </div>`;
  }).join('');

  const payChips = [
    {key:'cash', label:'💵 현금'},
    {key:'card', label:'💳 카드'},
    {key:'transfer', label:'🏦 이체'},
  ].map(p2 => `
    <div class="edit-chip${r.payType===p2.key?' on':''}" data-pay="${p2.key}" onclick="editSelectPay('${p2.key}',this)">${p2.label}</div>`).join('');

  const cardChips = cards.map(c => `
    <div class="edit-chip${r.card===c.id?' on':''}" data-card="${c.id}" onclick="editSelectCard('${c.id}',this)">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.color};margin-right:5px;vertical-align:middle"></span>${c.name}
    </div>`).join('');

  document.getElementById('edit-sheet-body').innerHTML = `
    <div class="edit-field">
      <div class="edit-field-label">📅 날짜</div>
      <input class="edit-input" type="date" id="edit-date" value="${r.date}">
    </div>
    <div class="edit-field">
      <div class="edit-field-label">💰 금액</div>
      <div style="position:relative">
        <input class="edit-input amount" type="number" id="edit-amount" inputmode="numeric" value="${r.amount}" placeholder="0">
        <span style="position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:15px;color:var(--gray-600);pointer-events:none">원</span>
      </div>
    </div>
    <div class="edit-field">
      <div class="edit-field-label">✏️ 용도</div>
      <input class="edit-input" type="text" id="edit-usage" value="${r.usage||''}" placeholder="용도를 입력하세요">
    </div>
    <div class="edit-field">
      <div class="edit-field-label">📂 프로젝트</div>
      <div class="edit-chips" id="edit-proj-chips">${projChips}</div>
    </div>
    <div class="edit-field">
      <div class="edit-field-label">📋 계정과목</div>
      <div class="edit-chips" id="edit-cat-chips">${catChips}</div>
    </div>
    <div class="edit-field">
      <div class="edit-field-label">💳 결제 수단</div>
      <div class="edit-chips" id="edit-pay-chips">${payChips}</div>
    </div>
    <div class="edit-field" id="edit-card-field" style="${r.payType==='card'?'':'display:none'}">
      <div class="edit-field-label">카드 선택</div>
      <div class="edit-chips" id="edit-card-chips">${cardChips}</div>
    </div>
    <div style="height:8px"></div>
  `;

  document.getElementById('edit-overlay').classList.add('show');
  document.getElementById('edit-sheet').classList.add('show');
}

function closeEditSheet() {
  document.getElementById('edit-overlay').classList.remove('show');
  document.getElementById('edit-sheet').classList.remove('show');
}

function editSelectProj(id, el) {
  document.querySelectorAll('#edit-proj-chips .edit-chip').forEach(c => {
    c.classList.remove('on');
    c.style.borderColor = c.style.background = c.style.color = '';
  });
  const p = getProjById(id);
  el.classList.add('on');
  el.style.borderColor = p.color;
  el.style.background = p.color + '22';
  el.style.color = p.color;
}
function editSelectCat(c, el) {
  // 모든 chip-sm 초기화
  el.closest('[id^=edit]')?.querySelectorAll('.chip-sm').forEach(x => {
    x.classList.remove('sel');
    x.style.borderColor=''; x.style.background=''; x.style.color=''; x.style.fontWeight='';
  });
  // 선택된 칩 강조 (그룹 색상 유지)
  el.classList.add('sel');
  const group = CAT_GROUPS.find(g=>g.items.includes(c));
  if(group){
    const ac=group.color;
    el.style.borderColor=ac; el.style.background=ac+'18'; el.style.color=ac; el.style.fontWeight='700';
  }
}
function editSelectPay(type, el) {
  document.querySelectorAll('#edit-pay-chips .edit-chip').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('edit-card-field').style.display = type === 'card' ? 'block' : 'none';
}
function editSelectCard(id, el) {
  document.querySelectorAll('#edit-card-chips .edit-chip').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
}

function saveEdit() {
  const r = receipts.find(x => x.id === editingId);
  if (!r) return;

  const newDate   = document.getElementById('edit-date').value || r.date;
  const newAmt    = parseInt(document.getElementById('edit-amount').value) || r.amount;
  const newUsage  = document.getElementById('edit-usage').value.trim() || r.usage;
  const projEl    = document.querySelector('#edit-proj-chips .edit-chip.on');
  const catEl     = document.querySelector('#edit-cat-chips .edit-chip.on');
  const payEl     = document.querySelector('#edit-pay-chips .edit-chip.on');
  const cardEl    = document.querySelector('#edit-card-chips .edit-chip.on');

  const newProj   = projEl ? projEl.dataset.proj : r.project;
  const newCat    = catEl  ? catEl.dataset.cat   : r.category;
  const newPay    = payEl  ? payEl.dataset.pay   : r.payType;
  const newCard   = newPay === 'card' ? (cardEl ? cardEl.dataset.card : r.card) : null;
  const newCardName = newCard ? (cards.find(c => c.id === newCard)||{}).name||'' : '';

  // 파일명 재생성
  const proj = getProjById(newProj);
  const projSlug = proj.name.replace(/\s/g, '');
  const usageSlug = newUsage.replace(/\s+/g, '').slice(0, 10);
  const payLabel = newPay==='card' && newCardName ? newCardName.replace(/\s/g,'') : newPay==='cash' ? '현금' : '이체';
  const ext = r.imagePreview ? (r.filename||'jpg').split('.').pop() : 'manual';
  const parts = [projSlug, `${new Date().getFullYear()}Q${getQuarter(newDate)}`, fmtDate(newDate), newCat, usageSlug, payLabel].filter(Boolean);
  const newFilename = parts.join('_') + '.' + ext;

  Object.assign(r, {
    date: newDate, amount: newAmt, usage: newUsage,
    project: newProj, category: newCat,
    payType: newPay, card: newCard, cardName: newCardName,
    filename: newFilename, updatedAt: new Date().toISOString()
  });

  saveDB(receipts);
  closeEditSheet();
  showToast('수정 완료 ✓');

  // 상세 모달 새로고침
  setTimeout(() => openDetail(editingId), 180);

  // 현재 화면 새로고침
  const active = document.querySelector('.screen.active');
  if (active) {
    if (active.id === 'screen-home')   renderHome();
    if (active.id === 'screen-list')   renderList();
    if (active.id === 'screen-viewer') renderViewer();
  }
}

// ══════════════════════════════════════
// SHARE SHEET
// ══════════════════════════════════════
function openShareSheet(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  const p = getProjById(r.project);
  const hasImg = !!r.imagePreview;

  document.getElementById('share-sheet-body').innerHTML = `
    <div class="share-option" onclick="shareAsText('${id}')">
      <div class="share-icon" style="background:#EEF1FE">📋</div>
      <div>
        <div class="share-name">텍스트로 복사</div>
        <div class="share-desc">영수증 내역을 클립보드에 복사</div>
      </div>
    </div>
    ${hasImg ? `
    <div class="share-option" onclick="downloadImage('${id}');closeShareSheet()">
      <div class="share-icon" style="background:#ECFDF5">⬇️</div>
      <div>
        <div class="share-name">이미지 저장</div>
        <div class="share-desc">${r.filename||'영수증 이미지'}</div>
      </div>
    </div>
    <div class="share-option" onclick="shareImageNative('${id}')">
      <div class="share-icon" style="background:#FFF7ED">📲</div>
      <div>
        <div class="share-name">이미지 공유</div>
        <div class="share-desc">카카오톡, 메시지, 메일 등으로 전송</div>
      </div>
    </div>` : ''}
    <div class="share-option" onclick="shareReceiptCard('${id}')">
      <div class="share-icon" style="background:#F5F3FF">🖼️</div>
      <div>
        <div class="share-name">영수증 카드 저장</div>
        <div class="share-desc">내역이 정리된 카드 이미지로 저장</div>
      </div>
    </div>
    <div class="share-option" onclick="copyFilename('${id}')">
      <div class="share-icon" style="background:#F1F3F5">📎</div>
      <div>
        <div class="share-name">파일명 복사</div>
        <div class="share-desc">${r.filename||'—'}</div>
      </div>
    </div>
  `;

  document.getElementById('share-overlay').classList.add('show');
  document.getElementById('share-sheet').classList.add('show');
}

function closeShareSheet() {
  document.getElementById('share-overlay').classList.remove('show');
  document.getElementById('share-sheet').classList.remove('show');
}

function shareAsText(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  const p = getProjById(r.project);
  const payLabel = r.payType==='card' ? `카드 (${r.cardName||''})` : r.payType==='cash' ? '현금' : '이체';
  const taxLabel = r.payType==='card' ? '💳 카드' : '세무포함';
  const text = [
    `📋 영수증 내역`,
    `─────────────────`,
    `날짜: ${fmtDateKo(r.date)}`,
    `프로젝트: ${p.name}`,
    `용도: ${r.usage||'—'}`,
    `계정과목: ${r.category||'—'}`,
    `금액: ₩${fmtAmount(r.amount)}`,
    `결제: ${payLabel}`,
    `세무: ${taxLabel}`,
    `─────────────────`,
    `파일명: ${r.filename||'—'}`,
  ].join('\n');

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      closeShareSheet();
      showToast('클립보드에 복사됐어요 ✓');
    });
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    closeShareSheet();
    showToast('클립보드에 복사됐어요 ✓');
  }
}

function copyFilename(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  const fname = r.filename || r.id;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(fname).then(() => {
      closeShareSheet();
      showToast('파일명 복사됨 ✓');
    });
  } else {
    closeShareSheet();
    showToast('파일명: ' + fname);
  }
}

function shareImageNative(id) {
  const r = receipts.find(x => x.id === id);
  if (!r || !r.imagePreview) return;
  if (navigator.share) {
    // base64 → Blob → File
    const arr = r.imagePreview.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    const file = new File([u8], r.filename || 'receipt.jpg', { type: mime });
    navigator.share({ files: [file], title: r.usage || '영수증', text: `₩${fmtAmount(r.amount)} · ${fmtDateKo(r.date)}` })
      .then(() => { closeShareSheet(); showToast('공유 완료 ✓'); })
      .catch(() => { downloadImage(id); closeShareSheet(); });
  } else {
    downloadImage(id);
    closeShareSheet();
    showToast('이미지 저장됨 ✓ (공유 API 미지원)');
  }
}

function shareReceiptCard(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  const p = getProjById(r.project);
  const isCard = r.payType === 'card';
  const payLabel = isCard ? `💳 ${r.cardName||'카드'}` : r.payType==='cash' ? '💵 현금' : '🏦 이체';

  // SVG 카드 생성
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">
<rect width="480" height="280" fill="#ffffff" rx="16"/>
<rect width="6" height="280" fill="${p.color}" rx="3"/>
<rect x="6" width="474" height="280" fill="#fafafa" rx="0"/>
<rect x="6" width="474" height="280" fill="white" rx="0"/>
<text x="36" y="44" font-family="sans-serif" font-size="22" font-weight="700" fill="${p.color}">${p.icon} ${p.name}</text>
<text x="36" y="70" font-family="sans-serif" font-size="13" fill="#888">${fmtDateKo(r.date)} · ${getQuarter(r.date)}분기</text>
<text x="36" y="120" font-family="sans-serif" font-size="32" font-weight="700" fill="${isCard ? '#aaa' : '#1a1a1a'}">₩${fmtAmount(r.amount)}</text>
<rect x="36" y="140" width="408" height="1" fill="#eee"/>
<text x="36" y="168" font-family="sans-serif" font-size="14" fill="#555">용도</text>
<text x="160" y="168" font-family="sans-serif" font-size="14" font-weight="600" fill="#1a1a1a">${r.usage||'—'}</text>
<text x="36" y="196" font-family="sans-serif" font-size="14" fill="#555">계정과목</text>
<text x="160" y="196" font-family="sans-serif" font-size="14" font-weight="600" fill="#1a1a1a">${r.category||'—'}</text>
<text x="36" y="224" font-family="sans-serif" font-size="14" fill="#555">결제수단</text>
<text x="160" y="224" font-family="sans-serif" font-size="14" font-weight="600" fill="${isCard?'#888':'#1a1a1a'}">${payLabel}</text>
<rect x="36" y="244" width="${isCard?80:72}" height="22" fill="${isCard?'#f1f3f5':'#ECFDF5'}" rx="11"/>
<text x="${isCard?46:44}" y="259" font-family="sans-serif" font-size="11" font-weight="700" fill="${isCard?'#888':'#12B981'}">${isCard?'💳 카드':'세무포함'}</text>
<text x="444" y="265" font-family="sans-serif" font-size="10" fill="#ccc" text-anchor="end">영수증 정리 앱</text>
</svg>`;

  const blob = new Blob([svg], {type:'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `영수증카드_${r.filename||r.id}.svg`;
  a.click();
  URL.revokeObjectURL(url);
  closeShareSheet();
  showToast('영수증 카드 저장됨 ✓');
}

function deleteReceipt(id) {
  const r = receipts.find(x => x.id === id);
  if (!r) return;
  if (!confirm('"'+(r.usage||'이 영수증')+'"을 삭제할까요?')) return;
  receipts = receipts.filter(x => x.id !== id);
  saveDB(receipts);
  deleteImage(id);
  closeDetail();
  showToast('삭제되었어요');
  syncDeleteToDrive(r);
  const active = document.querySelector('.screen.active');
  if (active) {
    if (active.id === 'screen-home') renderHome();
    if (active.id === 'screen-list') renderList();
    if (active.id === 'screen-viewer') initViewer();
  }
}

async function syncDeleteToDrive(r) {
  const scriptUrl = getAppsScriptUrl();
  if (!scriptUrl || !currentUser) return;
  try {
    await fetch(scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({
        action: 'delete',
        employee: currentUser,
        filename: r.filename,
        receiptId: r.id,
        year: new Date(r.date).getFullYear(),
        quarter: getQuarter(r.date)
      }),
    });
  } catch(e) {}
}
// ══════════════════════════════════════
// VIEWER — 상세 조회 + 다차원 필터
// ══════════════════════════════════════
const vFilters = { pay:'all', tax:'all', proj:'all', cat:'all', period:'all', dateStart:null, dateEnd:null, noVoucher:false };
let vSortMode = 'date-desc';

// ── Calendar state
let calViewYear = new Date().getFullYear();
let calViewMonth = new Date().getMonth(); // 0-based
let calSelStart = null, calSelEnd = null, calHover = null;

function initViewer() {
  const pRow = document.getElementById('vf-proj');
  pRow.innerHTML = `<div class="vchip on" onclick="toggleVFilter('proj','all',this)">🗂 전체 프로젝트</div>` +
    projects.map(p => `<div class="vchip" onclick="toggleVFilter('proj','${p.id}',this)" style="border-color:${p.color}">${p.icon} ${p.name}</div>`).join('');
  const cRow = document.getElementById('vf-cat');
  cRow.innerHTML = `<div class="vchip on" onclick="toggleVFilter('cat','all',this)">📋 전체</div>` +
    CAT_GROUPS.flatMap(g=>g.items).map(c =>
      `<div class="vchip" onclick="toggleVFilter('cat','${c}',this)">${getCatIcon(c)} ${c}</div>`
    ).join('');
  Object.assign(vFilters, { pay:'all', tax:'all', proj:'all', cat:'all', period:'all', dateStart:null, dateEnd:null, noVoucher:false });
  document.getElementById('viewer-search').value = '';
  document.querySelectorAll('#vf-period .vchip').forEach(c => c.classList.remove('on','on-green','on-orange','on-purple','on-red'));
  const allBtn = document.getElementById('vp-all');
  if (allBtn) allBtn.classList.add('on');
  renderViewer();
}

function setPeriodPreset(val, el) {
  vFilters.period = val;
  vFilters.dateStart = null;
  vFilters.dateEnd = null;
  document.querySelectorAll('#vf-period .vchip').forEach(c => c.classList.remove('on','on-green','on-orange','on-purple','on-red'));
  el.classList.add('on');
  renderViewer();
}

function toggleVFilter(group, val, el) {
  vFilters[group] = val;
  // 같은 그룹 칩 on/off
  const row = document.getElementById('vf-' + group);
  if (row) {
    row.querySelectorAll('.vchip').forEach(c => {
      c.classList.remove('on','on-green','on-orange','on-purple','on-red');
    });
    const colorMap = { pay: {'cash':'on-green','card':'on','transfer':'on-orange'}, tax: {'include':'on-green','exclude':'on-red'} };
    const cls = (colorMap[group] && colorMap[group][val]) || 'on';
    el.classList.add(cls);
  }
  renderViewer();
}

function toggleSort() {
  const modes = ['date-desc','date-asc','amount-desc','amount-asc'];
  const labels = ['날짜순 ↓','날짜순 ↑','금액순 ↓','금액순 ↑'];
  const idx = modes.indexOf(vSortMode);
  vSortMode = modes[(idx + 1) % modes.length];
  document.getElementById('sort-toggle-btn').textContent = labels[(idx + 1) % modes.length];
  renderViewer();
}

function getViewerData() {
  const q = document.getElementById('viewer-search').value.toLowerCase().trim();
  let data = [...receipts];

  // 증빙유형 미입력 필터
  if (vFilters.noVoucher) data = data.filter(r => !r.voucherType);

  // 검색
  if (q) data = data.filter(r =>
    (r.usage||'').toLowerCase().includes(q) ||
    getProjById(r.project).name.toLowerCase().includes(q) ||
    (r.category||'').toLowerCase().includes(q) ||
    String(r.amount).includes(q) ||
    (r.cardName||'').toLowerCase().includes(q) ||
    (r.date||'').includes(q)
  );

  // 결제수단
  if (vFilters.pay !== 'all') data = data.filter(r => r.payType === vFilters.pay);

  // 세무
  if (vFilters.tax === 'include') data = data.filter(r => r.payType !== 'card');
  if (vFilters.tax === 'exclude') data = data.filter(r => r.payType === 'card');

  // 프로젝트
  if (vFilters.proj !== 'all') data = data.filter(r => r.project === vFilters.proj);

  // 계정과목
  if (vFilters.cat !== 'all') data = data.filter(r => r.category === vFilters.cat);

  // 분기
  if (vFilters.period === 'custom') {
    const s = vFilters.dateStart, e = vFilters.dateEnd;
    if (s) data = data.filter(r => r.date >= s);
    if (e) data = data.filter(r => r.date <= e);
  } else if (vFilters.period !== 'all') {
    const q2num = { q1:1, q2:2, q3:3, q4:4 };
    const qn = q2num[vFilters.period];
    data = data.filter(r => getQuarter(r.date) === qn);
  }

  // 정렬
  data.sort((a, b) => {
    if (vSortMode === 'date-desc') return b.date.localeCompare(a.date);
    if (vSortMode === 'date-asc')  return a.date.localeCompare(b.date);
    if (vSortMode === 'amount-desc') return b.amount - a.amount;
    if (vSortMode === 'amount-asc')  return a.amount - b.amount;
    return 0;
  });

  return data;
}

function renderViewer() {
  const data = getViewerData();
  const total = data.reduce((s,r) => s + r.amount, 0);
  const cardTotal = data.filter(r => r.payType==='card').reduce((s,r) => s + r.amount, 0);
  const taxTotal = data.filter(r => r.payType!=='card').reduce((s,r) => s + r.amount, 0);

  // 통계 카드
  document.getElementById('viewer-stats').innerHTML = `
    <div class="vstat">
      <div class="vstat-val">₩${fmtAmount(total)}</div>
      <div class="vstat-lbl">합계</div>
    </div>
    <div class="vstat">
      <div class="vstat-val" style="color:var(--success)">₩${fmtAmount(taxTotal)}</div>
      <div class="vstat-lbl">세무포함</div>
    </div>
    <div class="vstat">
      <div class="vstat-val" style="color:var(--gray-400)">₩${fmtAmount(cardTotal)}</div>
      <div class="vstat-lbl">카드(제외)</div>
    </div>`;

  if (!data.length) {
    document.getElementById('viewer-list').innerHTML = `
      <div class="viewer-empty">
        <div class="viewer-empty-icon">🔍</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:4px">결과 없음</div>
        <div style="font-size:13px">필터나 검색어를 바꿔보세요</div>
      </div>`;
    return;
  }

  // 그룹핑 결정: 날짜순이면 날짜별, 금액순이면 결제수단별
  let html = '';
  if (vSortMode.startsWith('date')) {
    // 날짜별 섹션
    const groups = {};
    data.forEach(r => {
      const k = r.date.slice(0, 7);
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    });
    Object.entries(groups).forEach(([key, items]) => {
      const gt = items.reduce((s,r) => s+r.amount, 0);
      const [y,m] = key.split('-');
      html += `<div class="viewer-section-head">
        <div class="vshead-label">📅 ${y}년 ${parseInt(m)}월 <span class="vshead-count">${items.length}건</span></div>
        <div class="vshead-total">₩${fmtAmount(gt)}</div>
      </div>`;
      items.forEach(r => { html += viewerRowHTML(r); });
      html += '<div style="height:1px;background:var(--gray-100);margin:0 16px"></div>';
    });
  } else {
    // 금액순: 결제수단별 섹션
    const sections = [
      { key: 'cash',     label: '💵 현금',  items: data.filter(r=>r.payType==='cash') },
      { key: 'transfer', label: '🏦 이체',  items: data.filter(r=>r.payType==='transfer') },
      { key: 'card',     label: '💳 카드',  items: data.filter(r=>r.payType==='card') },
    ].filter(s => s.items.length > 0);
    sections.forEach(s => {
      const gt = s.items.reduce((a,r)=>a+r.amount,0);
      html += `<div class="viewer-section-head">
        <div class="vshead-label">${s.label} <span class="vshead-count">${s.items.length}건</span></div>
        <div class="vshead-total">₩${fmtAmount(gt)}</div>
      </div>`;
      s.items.forEach(r => { html += viewerRowHTML(r); });
      html += '<div style="height:8px;background:var(--gray-50);border-top:1px solid var(--gray-100);border-bottom:1px solid var(--gray-100);margin:4px 0"></div>';
    });
  }

  document.getElementById('viewer-list').innerHTML = html;
}

function viewerRowHTML(r) {
  const p = getProjById(r.project);
  const isCard = r.payType === 'card';
  const payIcon = r.payType==='card' ? '💳' : r.payType==='cash' ? '💵' : '🏦';
  const payName = r.payType==='card' ? (r.cardName||'카드') : r.payType==='cash' ? '현금' : '이체';
  const taxBadgeClass = isCard ? 'badge-gray' : 'badge-green';
  const taxLabel = isCard ? '💳 카드' : '세무포함';
  const amtColor = isCard ? 'color:var(--gray-400)' : '';

  // 사진 없으면 렌더 후 로컬→드라이브 썸네일 비동기 로드
  if (!r.imagePreview && r.mode === 'photo') {
    setTimeout(function(){
      loadThumb(r).then(function(img){
        if (!img) return;
        var el = document.getElementById('vthumb-'+r.id);
        if (el) { el.innerHTML = '<img src="'+img+'" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">'; el.style.background = 'transparent'; }
      });
    }, 0);
  }
  return `<div class="viewer-row" onclick="openDetail('${r.id}')">
    <div class="vr-bar" style="background:${p.color}"></div>
    <div id="vthumb-${r.id}" style="width:36px;height:36px;border-radius:var(--radius-sm);background:${r.imagePreview?'transparent':p.color+'22'};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;overflow:hidden">${r.imagePreview?`<img src="${r.imagePreview}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm)">`:getCatIcon(r.category)}</div>
    <div class="vr-left">
      <div class="vr-date">${fmtDateKo(r.date)} · ${p.name}</div>
      <div class="vr-desc">${r.usage||'—'}</div>
      <div class="vr-tags">
        <span class="badge badge-blue" style="font-size:10px">${r.category||''}</span>
        <span class="badge badge-gray" style="font-size:10px">${payIcon} ${payName}</span>
        <span class="badge ${taxBadgeClass}" style="font-size:10px">${taxLabel}</span>
      </div>
    </div>
    <div class="vr-right">
      <div class="vr-amount" style="${amtColor}">₩${fmtAmount(r.amount)}</div>
      <div class="vr-proj" style="font-size:10px">${vSortMode.startsWith('amount') ? fmtDateKo(r.date) : ''}</div>
    </div>
  </div>`;
}// ══════════════════════════════════════
// CALENDAR DATE-RANGE PICKER
// ══════════════════════════════════════
function openCalendarSheet() {
  calViewYear = new Date().getFullYear();
  calViewMonth = new Date().getMonth();
  calSelStart = vFilters.dateStart || null;
  calSelEnd   = vFilters.dateEnd   || null;
  calHover    = null;
  renderCalendar();
  document.getElementById('cal-overlay').classList.add('show');
  document.getElementById('cal-sheet').classList.add('show');
}
function closeCalendarSheet() {
  document.getElementById('cal-overlay').classList.remove('show');
  document.getElementById('cal-sheet').classList.remove('show');
}
function resetCalendar() {
  calSelStart = calSelEnd = calHover = null;
  renderCalendar();
}
function applyCalendar() {
  if (!calSelStart) { showToast('시작일을 선택해주세요'); return; }
  vFilters.period    = 'custom';
  vFilters.dateStart = calSelStart;
  vFilters.dateEnd   = calSelEnd || calSelStart;
  // 기간 칩 업데이트
  document.querySelectorAll('#vf-period .vchip').forEach(c => c.classList.remove('on','on-green','on-orange','on-purple','on-red'));
  const customBtn = document.getElementById('vp-custom');
  if (customBtn) {
    const s = calSelStart.slice(5).replace('-','.'), e = (vFilters.dateEnd||calSelStart).slice(5).replace('-','.');
    customBtn.textContent = `📅 ${s} ~ ${e}`;
    customBtn.classList.add('on');
  }
  closeCalendarSheet();
  renderViewer();
}
function calMove(dir) {
  calViewMonth += dir;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  if (calViewMonth < 0)  { calViewMonth = 11; calViewYear--; }
  renderCalendar();
}

function renderCalendar() {
  renderCalMonth(calViewYear, calViewMonth, 'cal-grid', 'cal-month-label');
  const ny = calViewMonth === 11 ? calViewYear + 1 : calViewYear;
  const nm = calViewMonth === 11 ? 0 : calViewMonth + 1;
  renderCalMonth(ny, nm, 'cal-grid2', 'cal-month2-label');
  // 범위 표시 업데이트
  const KO_MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  const fmt = d => d ? `${d.slice(0,4)}년 ${KO_MONTHS[parseInt(d.slice(5,7))-1]} ${parseInt(d.slice(8,10))}일` : '선택 안됨';
  document.getElementById('cal-start-label').textContent = fmt(calSelStart);
  document.getElementById('cal-end-label').textContent   = fmt(calSelEnd);
}

function renderCalMonth(year, month, gridId, labelId) {
  const KO_MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  document.getElementById(labelId).textContent = `${year}년 ${KO_MONTHS[month]}`;
  const grid = document.getElementById(gridId);
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();
  let cells = '';
  // 빈 칸
  for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === today;
    const isSel = dateStr === calSelStart || dateStr === calSelEnd;
    const lo = calSelStart, hi = calSelEnd || calHover;
    const inRange = lo && hi && dateStr > Math.min(lo,hi) && dateStr < Math.max(lo,hi);
    const isRangeStart = lo && hi && dateStr === Math.min(lo,hi);
    const isRangeEnd   = lo && hi && dateStr === Math.max(lo,hi);
    const dow = new Date(year, month, d).getDay();
    const isSun = dow === 0, isSat = dow === 6;

    let bg = 'transparent', color = isSun ? 'var(--red)' : isSat ? 'var(--primary)' : 'var(--gray-900)', fw = '400', radius = '50%', extra = '';
    if (isSel || isRangeStart || isRangeEnd) { bg='var(--primary)'; color='white'; fw='700'; }
    else if (inRange) { bg='var(--primary-light)'; color='var(--primary)'; fw='500'; radius='0'; }
    if (isRangeStart) { extra = 'border-radius:50% 0 0 50%'; bg='var(--primary)'; }
    if (isRangeEnd)   { extra = 'border-radius:0 50% 50% 0'; bg='var(--primary)'; }
    if (isSel && calSelStart === calSelEnd) { extra = 'border-radius:50%'; }
    const todayRing = isToday && !isSel ? 'box-shadow:inset 0 0 0 1.5px var(--primary);' : '';

    cells += `<div onclick="calPickDate('${dateStr}')" onmouseover="calOnHover('${dateStr}')"
      style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;cursor:pointer;
      background:${bg};color:${color};font-weight:${fw};font-size:13px;${todayRing}border-radius:${radius};${extra};transition:background .1s">${d}</div>`;
  }
  grid.innerHTML = cells;
}

function calPickDate(dateStr) {
  if (!calSelStart || (calSelStart && calSelEnd)) {
    calSelStart = dateStr; calSelEnd = null;
  } else {
    if (dateStr < calSelStart) { calSelEnd = calSelStart; calSelStart = dateStr; }
    else if (dateStr === calSelStart) { calSelStart = calSelEnd = null; }
    else { calSelEnd = dateStr; }
  }
  calHover = null;
  renderCalendar();
}
function calOnHover(dateStr) {
  if (calSelStart && !calSelEnd) {
    calHover = dateStr;
    renderCalendar();
  }
}
