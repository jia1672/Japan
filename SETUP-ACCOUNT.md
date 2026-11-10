# 계정 연동 설정 (Firebase, 무료)

PC·모바일에서 같은 계정으로 학습 기록을 연동하려면 Firebase 프로젝트를 한 번만 만들면 됩니다.

1. https://console.firebase.google.com 접속 → **프로젝트 추가** (이름 자유, Google 애널리틱스는 꺼도 됨)
2. **빌드 → Authentication → 시작하기** → 로그인 방법에서 **Google**을 사용 설정 (프로젝트 지원 이메일 선택)
   - 이렇게 하면 누구나 자기 Google 계정으로 접속해 각자의 기록을 따로 저장합니다. 별도 가입 절차는 없습니다.
3. Authentication → **설정 → 승인된 도메인**에 `jia1672.github.io` 추가 (`localhost`는 기본 포함)
4. **빌드 → Firestore Database → 데이터베이스 만들기** (프로덕션 모드, 위치는 `asia-northeast3 (서울)` 권장)
5. Firestore → **규칙** 탭에 `firestore.rules` 파일 내용을 붙여 넣고 **게시**
6. 프로젝트 설정(톱니바퀴) → **내 앱** → 웹 앱(`</>`) 추가 → 표시되는 `firebaseConfig` 값을 복사
7. 그 값을 `firebase-config.js`의 `window.FIREBASE_CONFIG = { ... }` 에 붙여 넣기

이후 사이트의 **설정** 화면에서 가입·로그인할 수 있습니다.
