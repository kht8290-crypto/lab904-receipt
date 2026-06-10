# CHANGELOG — lab904 영수증 정리 앱

---

## [2026-06-10] — 설정 자동 동기화 + 모바일 사진 표시

### 추가
- **설정 변경 자동 동기화**: 직원/PIN/카드/프로젝트/사업자정보 변경 시 1.5초 뒤 자동 업로드
  (`store.setItem` 래퍼 + `pushSettings`, `applySettings` 중 echo 억제)
- **모바일 사진 표시**: 다른 기기에서 올린 사진을 드라이브에서 받아 표시
  - 목록/홈/뷰어 썸네일 = 드라이브 자동 썸네일(~100KB대), 상세보기 = 풀이미지
  - `loadThumb`/`loadFullImage`/`fetchImageFromDrive`, IndexedDB 캐시(`id` / `id:thumb`)
- Apps Script: `?action=image`(사진/썸네일), `syncSettings`(설정 전용 저장),
  master.json 빈배열 덮어쓰기 방지 안전장치

### 검증
- 라이브 `?action=image&thumb=1` → image/png 썸네일 정상 반환
- 프리뷰: 자동 push 1회, echo 억제, 썸네일 로드/캐시, 콘솔 에러 0

---

## [2026-06-10] — 다기기 동기화 (method A: 드라이브 우선)

### 문제
- PC에서 수정한 영수증·관리자 설정이 모바일에 안 나타남
- 원인: 동기화가 "영수증만, 올리기만" 하는 한 방향 + 설정은 업로드 자체가 없었음

### 추가
- `loadFromDrive()`: 앱 시작 시 `?action=read`로 master.json + settings.json을 받아 로컬 반영
- 설정(직원/PIN/카드/프로젝트/사업자정보) 동기화: `gatherSettings`/`applySettings`
- 설정 화면 "⬇️ 드라이브에서 불러오기" 수동 버튼
- Apps Script: `doGet ?action=read` + `settings.json` 저장 (apps-script/Code.gs로 repo 보관)

### 주의
- 읽기 엔드포인트가 공개 URL이라 PIN/사업자정보 노출 가능 → 후속 보완 예정

---

## [2026-06-10] — Claude Code 전환

### 변경
- 단일 HTML → 파일 분리 (index.html 683줄 / app.js 3215줄 / style.css 302줄)
- receipt-app.html(중복본) 제거
- GitHub Pages 자동 배포 연결 (push → https://kht8290-crypto.github.io/lab904-receipt/)
- claude.ai Chrome 자동화 방식 종료

### 검증
- 브라우저 로드 확인: app.js/style.css 정상 로드, JS 콘솔 에러 없음
- 배포 확인: Pages에서 app.js 200 응답

---

## [2026-06-10] — 구조 개편

### 추가
- Google Drive PROJECT 폴더 생성 (CLAUDE.md, FEATURES.md, CHANGELOG.md)
- Claude Code 작업 파이프라인 세팅 시작

---

## [2026-06-09] — Apps Script v4

### 변경
- 기존 per-person JSON → master.json 단일 파일
- Drive 폴더 구조 개편:
  - `데이터/master.json` — 전체 마스터
  - `데이터/백업/YYYYMMDD.json` — 일별 백업 (30일 후 자동 삭제)
  - `사진/YYYY/Q{n}분기/` — 분기별 사진

---

## [2026-06-09] — 버그 수정 및 안정화

### 수정
- localStorage 용량 초과 → ImagePreview IndexedDB 분리
- `getVoucherType` 함수 누락 → 추가
- 모든 버튼 `type="button"` 추가 (96개)
- 2025 하드코딩 → 동적 연도 처리
- `saveReceipt` try-catch 추가
- `autoSyncToDrive` → `showScreen` 이후 실행으로 변경
- localStorage 차단 시 메모리 fallback (store 래퍼)

### 추가
- 삭제 시 Drive 동기화 (`syncDeleteToDrive`)
- IndexedDB 이미지 저장/불러오기
- 캐시 차단 메타태그

---

## [2026-06-09] — 초기 개발

### 구현
- 로그인 시스템 (직원 선택, 관리자 PIN)
- 영수증 등록 (사진/직접입력, AI 분류)
- 목록/조회/정산 화면
- 엑셀 내보내기 (SheetJS)
- Google Drive 동기화 (Apps Script)
- 카드/프로젝트/사업자 정보 관리
