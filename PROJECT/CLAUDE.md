# lab904 영수증 정리 앱 — CLAUDE.md

> Claude Code 및 claude.ai에서 이 파일을 먼저 읽고 작업을 시작하세요.

---

## 프로젝트 개요

**회사**: lab904 (인테리어 디자인)
**목적**: 직원 2~5명이 사용하는 영수증 정리 모바일 웹앱 (세무/회계용)
**배포**: GitHub Pages (자동 배포) — URL 업데이트 필요
**계정**: kht8290@gmail.com

---

## 기술 스택

| 항목 | 내용 |
|------|------|
| 프론트엔드 | Vanilla HTML/CSS/JS (단일 파일 → 분리 예정) |
| 저장소 | localStorage + IndexedDB (이미지) |
| 백엔드 | Google Apps Script (Drive 동기화) |
| 배포 | GitHub Pages (git push → 자동) |
| 이미지 저장 | Google Drive `영수증정산/사진/YYYY/Q{n}분기/` |
| 데이터 저장 | Google Drive `영수증정산/데이터/master.json` |

---

## Google Drive 구조

```
영수증정산/                          ← ID: 1kOXPlXioXh0daa-SW74Ak8UlRm4dS6QV
  ├── PROJECT/                       ← 이 폴더 (문서)
  │   ├── CLAUDE.md                  ← 이 파일
  │   ├── FEATURES.md                ← 기능 명세
  │   └── CHANGELOG.md               ← 변경 이력
  ├── 데이터/
  │   ├── master.json                ← 전체 영수증 마스터
  │   └── 백업/
  │       └── YYYYMMDD.json          ← 일별 자동 백업 (30일 후 삭제)
  └── 사진/
      └── 2026/
          └── Q2분기/
              └── 영수증사진들
```

---

## Apps Script

- **프로젝트**: 영수증정리
- **URL**: `https://script.google.com/macros/s/AKfycbx2BABqLJYoRZbFaYvVdaXkyrYwb6fczIB6bTdBVTYtGmaxHyYBdUSPpB3NKasIy9gtGA/exec`
- **프로젝트 링크**: `https://script.google.com/home/projects/1-17tiOHZx8lOdqXj7rnmYIq8SXiWcNDuzPhG-iHH9W4aBlmTXa9MZxJf/edit`
- **현재 버전**: 버전 4 (2026-06-09)
- **액션**: `sync` (저장), `delete` (삭제)

---

## 화면 구조 (6개)

| screen-id | 이름 | 설명 |
|-----------|------|------|
| screen-home | 홈 | 분기 합계, 최근 영수증 5개, 빠른 업로드 |
| screen-upload | 영수증 등록 | 사진 업로드 / 직접 입력, AI 분류 |
| screen-list | 목록 | 전체 영수증 필터/검색/정렬 |
| screen-viewer | 조회 | 날짜/기간별 상세 조회 |
| screen-settle | 정산 | 분기별 세무 정산, 엑셀/ZIP 내보내기 |
| screen-settings | 설정 | 직원관리, 카드관리, 사업자정보, Drive 연동 |

---

## 데이터 구조

### 영수증 (Receipt)
```json
{
  "id": "r_1234567890",
  "date": "2026-06-09",
  "project": "lab904",
  "amount": 50000,
  "usage": "타일 자재 구입",
  "category": "재료비",
  "payType": "card | cash | transfer | used",
  "card": "card_id",
  "cardName": "신한카드",
  "mode": "photo | manual",
  "filename": "lab904_2026Q2_260609_재료비_타일자재구입_신한카드.jpg",
  "voucherType": "card_slip | cash_rcpt | simple | tax_inv | statement",
  "voucherLabel": "신용카드전표",
  "vatOk": true,
  "supplyAmt": 45455,
  "vatAmt": 4545,
  "uploader": "김현태",
  "createdAt": "2026-06-09T10:00:00.000Z"
}
```

### 증빙유형 (VOUCHER_TYPES)
| id | 이름 | 부가세 공제 |
|----|------|------------|
| card_slip | 신용카드전표 | ✅ |
| cash_rcpt | 현금영수증 | ✅ |
| simple | 간이영수증 | ❌ |
| tax_inv | 세금계산서 | ✅ |
| statement | 계산서 | ❌ |

---

## 핵심 기술 결정사항

1. **localStorage 대신 store 래퍼 사용** — 모바일 쿠키 차단 대응
2. **이미지는 IndexedDB 저장** — localStorage 용량 초과 방지
3. **버튼에 반드시 `type="button"`** — 모바일 form submit 방지
4. **autoSyncToDrive는 showScreen 이후** — UI 응답성 우선
5. **연도는 `new Date().getFullYear()` 동적 처리** — 하드코딩 금지
6. **no-cors 모드** — Apps Script CORS 우회

---

## 주의사항

- optional chaining (`?.`) 구형 모바일에서 오류 → `&&` 방식 사용
- 중복 함수 정의 주의 (JS는 마지막 정의가 유효)
- 샘플 데이터는 2025년 — 홈 화면 필터는 현재 연도 기준
- Apps Script 수정 후 반드시 **새 버전으로 배포** 필요

---

## GitHub 저장소 (설정 후 업데이트)

- **Repository**: 미설정
- **GitHub Pages URL**: 미설정
- **Branch**: main

---

## 작업 로그

- 2026-06-09: 초기 단일 HTML 파일로 개발 완료
- 2026-06-09: localStorage 용량 문제 → IndexedDB 이미지 저장으로 전환
- 2026-06-09: 삭제 시 Drive 동기화 추가
- 2026-06-09: Apps Script v4 — master.json + 백업 + 사진 폴더 분리
- 2026-06-10: Claude Code 방식으로 전환 시작 (이 파일 생성)
