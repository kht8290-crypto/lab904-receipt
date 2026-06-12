# lab904 영수증 정산 앱 — Claude 작업 브리핑

> 이 파일을 Claude 챗에 올리거나, Claude Code로 이 폴더를 열면 바로 작업을 이어갈 수 있습니다.

## 한 줄 소개
인테리어 회사(lab904)의 영수증 관리 웹앱. 사진 업로드→AI 추출→분류→Google Drive 동기화→분기 세무 정산 + 인테리어 프로젝트별 원가 관리.

## 핵심 정보
- **라이브**: https://kht8290-crypto.github.io/lab904-receipt/
- **저장소**: https://github.com/kht8290-crypto/lab904-receipt (main 브랜치 push = 자동 배포)
- **스택**: Vanilla JS 단일 페이지 — `index.html` + `app.js` + `style.css` (빌드 없음)
- **백엔드**: `apps-script/Code.gs` — Google Apps Script 웹앱 (Drive 동기화 + Claude API 프록시)
- **로컬 프리뷰**: `.claude/launch.json`의 receipt-app (python http.server 8765)

## ⚠️ 꼭 지킬 것
1. **Code.gs 수정 시**: git push만으로는 반영 안 됨 — 사용자가 Apps Script 편집기에 붙여넣고 "배포 관리 → 새 버전 → 배포"를 직접 해야 함. 수정하면 반드시 재배포 요청할 것.
2. **카드 전체번호 절대 금지**: 16자리 카드번호는 Apps Script Script Properties(`CARD_FULL`)에만 존재. 코드·파일·응답에 절대 쓰지 말 것. settings.json엔 뒤 4자리만.
3. **master.json 안전장치**: 빈 배열로 덮어쓰지 않게 돼 있음(handleSync). 이 보호를 제거하지 말 것.
4. **테스트 주의**: saveReceipt/saveEdit는 실제 Drive로 동기화됨. 프리뷰 테스트 시 `window.autoSyncToDrive=async()=>{}` + `_suppressSettingsPush=true`로 막고, 끝나면 테스트 데이터 정리+새로고침.
5. **캐시버스팅 자동**: pre-commit 훅(.githooks/pre-commit)이 ?v=버전·version.txt를 자동 갱신 — 직접 만질 필요 없음. 클라이언트는 version.txt 비교로 자동 새로고침.
6. **데모 시드 금지**: seedIfEmpty()는 비활성화돼 있고, 로드 시 s1~s5 잔재 자동 제거. 되살리지 말 것.

## 데이터 구조 (Google Drive: 영수증정산/)
```
데이터/
  master.json      ← 전체 영수증 (영수증↔사진 매칭키 driveFileId 포함)
  settings.json    ← 직원/PIN/프로젝트/카드(뒤4자리)/사업자정보
  프로젝트별/       ← 인테리어 프로젝트별 JSON (합계 미리 계산: bySubCat/byProcess/예산)
  백업/            ← 일별 백업(30일 보관)
사진/{년}/{Q분기}/  ← 영수증 이미지 (삭제 시 같은 폴더의 '휴지통/'으로 이동, 영구삭제 X)
```

## 영수증 필드 (rec)
id(r_타임스탬프), date, project, amount, usage, category(계정과목), **subCat**(인건비/자재비/경비), **processCat**(공정), payType(card/cash/transfer/used), card/cardName, voucherType/voucherLabel/vatOk/supplyAmt/vatAmt(증빙·부가세), mode(photo/manual), filename, **driveFileId**(Drive 사진 매칭), uploader, createdAt

## 프로젝트 필드
id, name, icon, color, desc, completed, **type**('default'=세무공통 | 'interior'=인테리어), **customProcesses**[](직접설정 공정), **budgetTotal**, **budgetByProcess**{공정:금액}

## 주요 기능 현황 (v1.1.0+, 2026-06-12 기준)
- 사진 업로드 → Claude(sonnet-4-6)가 금액/날짜/상호/카드그룹(card1~4)/계정과목 추출, 날짜는 올해 기준 연-월-일 추론
- 카드 매칭: 서버측 전체번호 매칭(extractReceipt가 cardMatchId 반환), 내 카드·기업은행 우선 정렬, 카드색 칩
- 직접입력 시 '가 영수증' PNG 자동생성(makeManualReceiptImage) — 모든 영수증이 사진 보유. 수정에서 📷 사진 변경 가능
- 미입력 상시 빨간테두리(사진/금액/용도/프로젝트/세부·공정분류/결제수단/카드/계정과목/증빙) — getMissingFields/markMissingFields
- 인테리어 프로젝트: 등록 시 세부분류·공정분류 필수, 정산 상세 시트(전체기간: 세부/공정별 집계+예산 게이지+엑셀 다운로드+예산 설정)
- 하단 6탭: 홈/등록/조회/프로젝트/정산/설정. 홈 헤더 🔄 = 드라이브 새로고침(manualRefresh)
- 분기 정산(세무, 전 프로젝트 공통): ZIP(엑셀+이미지 전체, 누락 시 txt 동봉)·엑셀(18컬럼: 세부·공정분류 포함)
- 증빙 미입력 관리: isVoucherMissing(카드·중고 제외) 기준으로 필터/배지/카운트 일원화
- 삭제: master.json 갱신 + 사진을 분기폴더/휴지통으로(driveFileId 우선, 파일명 재귀검색 폴백). cleanupPhotos 액션=고아 정리
- 라이트(화이트) 테마, meta charset은 index.html 1번 줄(이동 금지 — 첫 1024바이트 안에 있어야 함)

## Apps Script 액션 (Code.gs)
- POST: sync(master+settings+사진+프로젝트별JSON), delete, cleanupPhotos, syncSettings, extractReceipt(비전), setCards(토큰 필요), classify
- GET: read(tk 토큰), image(fileId 우선/filename 폴백, thumb=1), classify
- Script Properties: ANTHROPIC_API_KEY, CARD_FULL, (APP_TOKEN — 아직 미설정=하위호환)

## 작업 관례
- 커밋: 한국어 컨벤셔널(feat:/fix:/perf:/chore:) + 본문 상세, push까지
- 검증: 프리뷰(preview_eval)로 기능 검증 후 커밋. Drive 확인은 ?action=read fetch 또는 Drive 검색
- 프리뷰에서 curl POST는 411 에러남 — 브라우저 fetch(no-cors) 사용
- index.html 구조 특이: DOCTYPE 앞에 오버레이 HTML 있음(의도된 상태, 1번 줄 meta charset 유지)
