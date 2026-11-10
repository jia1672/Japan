(() => {
  const $app = document.getElementById('app');
  const $timer = document.getElementById('timer');
  const KEY = 'japan-study-v1';
  const GOAL_SEC = 20 * 60;
  const INTERVALS = [0, 1, 2, 4, 8, 16, 30]; // 박스별 복습 간격(일)
  const OLD_QUIZ_N = 12; // 퀴즈에 섞는 지난 단어 수
  const QTYPES = ['m1', 'm2', 'listen', 'sent'];

  // ── 유틸 ──
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => fmtDate(new Date());
  const addDays = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); return fmtDate(new Date(y, m - 1, d + n)); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const mmss = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const byId = Object.fromEntries(WORDS.map(w => [w.jp, w]));

  // ── 저장 데이터 ──
  let S = {};
  try { S = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  S = Object.assign({ words: {}, log: {}, plan: {}, newPerDay: 10 }, S);
  const localSave = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
  const save = () => { S.upd = Date.now(); localSave(); schedulePush(); };
  const dayLog = () => (S.log[today()] ||= { sec: 0, done: false });

  function streak() {
    let d = today(), c = 0;
    if (!S.log[d]?.done) d = addDays(d, -1);
    while (S.log[d]?.done) { c++; d = addDays(d, -1); }
    return c;
  }
  const dueIds = () => Object.entries(S.words).filter(([, v]) => v.due <= today()).map(([id]) => id);
  // 새 단어는 기초(lv1)와 중급(lv2)을 반반 섞어서, 파일에 적힌 순서대로 고른다.
  const BASIC_THEMES = ['기본 표현', '식당', '쇼핑', '길찾기·교통', '일상 대화'];
  const lvOf = w => w.lv || (BASIC_THEMES.includes(w.t) ? 1 : 2);
  function pickNew(n, skip = []) {
    const un = WORDS.filter(w => !S.words[w.jp] && !skip.includes(w.jp));
    const lo = un.filter(w => lvOf(w) === 1), hi = un.filter(w => lvOf(w) !== 1);
    const half = Math.ceil(n / 2);
    const take = [...lo.slice(0, half), ...hi.slice(0, n - half)];
    take.push(...un.filter(w => !take.includes(w)).slice(0, n - take.length));
    return take.map(w => w.jp);
  }
  function planIds() {
    if (S.plan.date !== today() || S.plan.n !== S.newPerDay) {
      S.plan = { date: today(), n: S.newPerDay, ids: pickNew(S.newPerDay) };
      save();
    }
    return S.plan.ids.filter(id => !S.words[id]);
  }

  // ── 계정 연동 (Firebase Auth + Firestore) ──
  // 설정값은 firebase-config.js. 비어 있으면 이 기능은 꺼지고 기존처럼 이 기기에만 저장된다.
  const FB_CFG = window.FIREBASE_CONFIG;
  let fb = null, fbUser = null, lastSync = null, syncMsg = '', pushTimer = null, authReady = false;
  const loadScript = src => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });

  // 두 기기의 기록을 합친다: 단어는 더 최근에 바뀐 쪽, 날짜별 학습은 시간 큰 쪽·완료 OR.
  // 초기화(epoch)가 더 늦은 쪽이 있으면 그쪽 전체를 따른다.
  function mergeState(a, b) {
    const ea = a.epoch || 0, eb = b.epoch || 0;
    if (ea !== eb) return ea > eb ? a : b;
    const out = { ...((a.upd || 0) >= (b.upd || 0) ? a : b), words: {}, log: {} };
    for (const id of new Set([...Object.keys(a.words || {}), ...Object.keys(b.words || {})])) {
      const x = a.words?.[id], y = b.words?.[id];
      out.words[id] = !x ? y : !y ? x : (x.u || 0) !== (y.u || 0) ? ((x.u || 0) > (y.u || 0) ? x : y) : (x.box >= y.box ? x : y);
    }
    for (const d of new Set([...Object.keys(a.log || {}), ...Object.keys(b.log || {})])) {
      const x = a.log?.[d] || { sec: 0, done: false }, y = b.log?.[d] || { sec: 0, done: false };
      out.log[d] = { sec: Math.max(x.sec || 0, y.sec || 0), done: !!(x.done || y.done) };
    }
    return out;
  }
  const normState = s => Object.assign({ words: {}, log: {}, plan: {}, newPerDay: 10 }, s);

  function schedulePush() {
    if (!fb || !fbUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 3000);
  }
  async function push() {
    if (!fb || !fbUser) return;
    try {
      await fb.db.doc('users/' + fbUser.uid).set({ state: JSON.stringify(S), upd: S.upd || 0 });
      lastSync = new Date(); syncMsg = '';
    } catch { syncMsg = '동기화에 실패했어요. 인터넷 연결을 확인해 주세요.'; }
    if (view === 'settings') renderSettings();
  }
  async function pull() {
    if (!fb || !fbUser || sess) return;
    try {
      // 다른 사람 계정의 기록이 남아 있으면 버리고 새로 시작 (기기를 같이 쓰는 경우)
      if (S.uid && S.uid !== fbUser.uid) { S = normState({}); localSave(); }
      const snap = await fb.db.doc('users/' + fbUser.uid).get();
      if (snap.exists && snap.data().state) {
        const cloud = JSON.parse(snap.data().state);
        S = normState(mergeState(S, normState(cloud)));
      }
      S.uid = fbUser.uid;
      localSave();
      await push();
      if (view === 'home' && !sess) renderHome();
    } catch { syncMsg = '기록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'; if (view === 'settings') renderSettings(); }
  }
  async function initSync() {
    if (!FB_CFG || !FB_CFG.apiKey) return;
    try {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      await loadScript(base + 'firebase-app-compat.js');
      await loadScript(base + 'firebase-auth-compat.js');
      await loadScript(base + 'firebase-firestore-compat.js');
      firebase.initializeApp(FB_CFG);
      fb = { auth: firebase.auth(), db: firebase.firestore() };
      fb.auth.onAuthStateChanged(async u => {
        fbUser = u;
        authReady = true;
        if (u) await pull();
        if (!sess) go(view);
      });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
    } catch { syncMsg = '계정 서비스에 연결하지 못했어요. 지금은 이 기기에만 저장돼요.'; authReady = true; if (!sess) go(view); }
  }
  // 접속하면 먼저 Google 로그인 화면을 보여 준다 (로그인 전에는 학습 화면이 열리지 않음)
  function renderGate() {
    $app.innerHTML = `<div class="card" style="text-align:center;margin-top:24px">
        <div style="font-size:48px">🇯🇵</div><h2 style="margin:6px 0">하루 20분 일본어 회화</h2>
        <p class="muted">Google 계정으로 로그인하면 PC·모바일 어디서든 학습 기록과 연속 학습일이 이어져요. 기록은 계정마다 따로 저장돼요.</p>
        <div id="autherr" style="color:var(--bad);margin:6px 0">${esc(syncMsg)}</div>
        <button class="primary" id="google">Google로 시작하기</button></div>`;
    bindAccount();
  }
  const AUTH_ERR = {
    'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
    'auth/too-many-requests': '시도가 너무 많아요. 잠시 후 다시 해 주세요.',
    'auth/popup-closed-by-user': '로그인 창이 닫혔어요.',
    'auth/unauthorized-domain': '이 주소는 Firebase 승인 도메인에 없어요. (SETUP-ACCOUNT.md 참고)',
    'auth/operation-not-allowed': 'Firebase에서 이 로그인 방식이 켜져 있지 않아요.',
  };
  const authErr = e => AUTH_ERR[e?.code] || '로그인에 실패했어요. (' + (e?.code || e?.message || '알 수 없는 오류') + ')';

  function accountCard() {
    if (!FB_CFG || !FB_CFG.apiKey)
      return `<div class="card muted">👤 <b>계정 연동</b>은 아직 설정되지 않았어요. 지금은 이 기기에만 기록이 저장됩니다.</div>`;
    if (!fb) return `<div class="card muted">👤 계정 서비스에 연결하는 중... ${esc(syncMsg)}</div>`;
    if (fbUser) return `<div class="card">
        <b>👤 ${esc(fbUser.displayName || fbUser.email || '로그인됨')}</b>
        <div class="muted">${esc(fbUser.email || '')}</div>
        <div class="muted">PC·모바일에서 같은 계정으로 로그인하면 연속 학습일과 단어 기록이 같이 이어져요.${lastSync ? ` · 마지막 동기화 ${pad(lastSync.getHours())}:${pad(lastSync.getMinutes())}` : ''}</div>
        ${syncMsg ? `<div style="color:var(--bad)">${esc(syncMsg)}</div>` : ''}
        <button class="ghost" id="syncnow">지금 동기화</button>
        <button class="ghost" id="logout">로그아웃</button></div>`;
    return '';
  }
  function bindAccount() {
    const q = s => $app.querySelector(s), err = m => { const e = q('#autherr'); if (e) e.textContent = m; };
    q('#google')?.addEventListener('click', async () => {
      const p = new firebase.auth.GoogleAuthProvider();
      try { await fb.auth.signInWithPopup(p); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) { try { await fb.auth.signInWithRedirect(p); } catch (e2) { err(authErr(e2)); } }
        else err(authErr(e));
      }
    });
    q('#syncnow')?.addEventListener('click', () => pull());
    q('#logout')?.addEventListener('click', async () => { await push(); await fb.auth.signOut(); S = normState({}); localSave(); fbUser = null; lastSync = null; go('home'); });
  }

  // ── 음성 (브라우저 내장 TTS) ──
  // 모바일 대응: 음성 목록은 비동기로 로드되고, 발화 객체가 GC되면 소리가 끊기며,
  // cancel 직후 바로 speak하면 안드로이드에서 무시되는 문제가 있어 보완한다.
  let jaVoice = null, utter = null, voiceWarned = false;
  const pickVoice = () => {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices().filter(v => v.lang.replace('_', '-').toLowerCase().startsWith('ja'));
    jaVoice = vs.find(v => v.localService) || vs[0] || null;
  };
  function speak(text, rate = 0.9) {
    if (!('speechSynthesis' in window)) { warnVoice('이 브라우저는 음성 재생을 지원하지 않아요. Chrome(안드로이드)이나 Safari(아이폰)를 써 보세요.'); return; }
    if (!jaVoice) pickVoice();
    if (!jaVoice && !voiceWarned && speechSynthesis.getVoices().length)
      warnVoice('이 기기에 일본어 음성이 없어서 소리가 나지 않을 수 있어요. 설정 > 언어/음성 > 텍스트 음성 변환에서 일본어를 설치해 주세요.');
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    setTimeout(() => {
      utter = new SpeechSynthesisUtterance(text);   // 전역에 잡아 둬야 모바일에서 끊기지 않음
      utter.lang = 'ja-JP'; utter.rate = rate;
      if (jaVoice) utter.voice = jaVoice;
      speechSynthesis.resume();
      speechSynthesis.speak(utter);
    }, 60);
  }
  function warnVoice(msg) {
    if (voiceWarned) return;
    voiceWarned = true;
    const d = document.createElement('div');
    d.className = 'card'; d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:70;border-color:var(--bad)';
    d.innerHTML = `<div>🔇 ${msg}</div><button class="ghost" style="margin-top:8px">닫기</button>`;
    d.querySelector('button').onclick = () => d.remove();
    document.body.appendChild(d);
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }
  const sayBtn = (t, slow) => `<button class="icon" data-say="${esc(t)}" ${slow ? 'data-slow="1" title="천천히"' : 'title="듣기"'}>${slow ? '🐢' : '🔊'}</button>`;

  // ── 렌더 조각 ──
  const hl = w => esc(w.s[0]).replace(esc(w.jp), m => `<mark>${m}</mark>`);
  // 예문 풀이: 단어·조사·어미를 나눠서 발음과 뜻을 보여 준다 (parts_*.js)
  const breakdown = w => {
    const p = PARTS[w.jp];
    if (!p) return '';
    return `<details class="parts"><summary>문장 풀이 (단어·조사 뜻)</summary>
      <div class="chunks">${p.map(([j, k, m]) => `<div class="chunk"><b>${esc(j)}</b><span class="ck">${esc(k)}</span><span class="cm">${esc(m)}</span></div>`).join('')}</div>
    </details>`;
  };
  const wordCard = w => `
    <div class="card">
      <span class="tag">${esc(w.t)}</span>
      <div class="jp">${esc(w.jp)} ${sayBtn(w.jp)}</div>
      <div class="ko">${esc(w.ko)}</div>
      <div class="mean">${esc(w.mean)}</div>
      <hr>
      <div class="sjp">${hl(w)} ${sayBtn(w.s[0])} ${sayBtn(w.s[0], true)}</div>
      <div class="sko">${esc(w.s[1])}</div>
      <div class="smean">${esc(w.s[2])}</div>
      ${breakdown(w)}
    </div>`;

  // ── 화면 이동 ──
  let view = 'home', sess = null;
  function go(v) {
    view = v;
    document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === v));
    if (FB_CFG?.apiKey && !authReady) { $app.innerHTML = '<div class="card muted">불러오는 중...</div>'; return; }
    if (fb && !fbUser) { renderGate(); return; }
    if (v === 'home') renderHome();
    else if (v === 'words') renderWords();
    else if (v === 'settings') renderSettings();
  }

  function renderHome() {
    const log = dayLog(), due = dueIds().length, news = planIds().length;
    const pct = Math.min(100, Math.round(log.sec / GOAL_SEC * 100));
    $app.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${streak()}일</b><span>연속 학습</span></div>
        <div class="stat"><b>${Object.keys(S.words).length}</b><span>배운 단어 / ${WORDS.length}</span></div>
        <div class="stat"><b>${due}</b><span>복습할 단어</span></div>
      </div>
      <div class="card">
        <b>오늘의 학습 ${log.done ? '✅ 완료' : ''}</b>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="muted">${mmss(log.sec)} / 20:00 · 새 단어 ${news}개 + 지난 단어 퀴즈 ${Math.min(OLD_QUIZ_N, Object.keys(S.words).length)}개</div>
        <button class="primary" id="start">${news === 0 ? '지난 단어 퀴즈 풀기' : log.sec > 0 && !log.done ? '이어서 하기' : '시작하기'}</button>
        ${news === 0 ? `<button class="ghost" id="extra">새 단어 ${S.newPerDay}개 더 배우기</button>` : ''}
      </div>
      <div class="card muted">진행 순서: ① 새 단어 학습 → ② 퀴즈 (오늘 새 단어 + 지난 단어, 틀렸던 단어가 더 자주 나와요)<br>🔊 소리를 꼭 따라 말해 보세요. 한글 발음을 보면서 입으로 말하는 게 핵심이에요.${fb && !fbUser ? '<br>👤 <b>설정</b>에서 로그인하면 PC·모바일 기록이 연동돼요.' : ''}</div>`;
    $app.querySelector('#start')?.addEventListener('click', startSession);
    $app.querySelector('#extra')?.addEventListener('click', () => {
      const more = pickNew(S.newPerDay, S.plan.ids);
      S.plan.ids.push(...more); save(); startSession();
    });
  }

  // 단어장에 보여 줄 주제 순서 (목록에 없는 주제는 맨 뒤에 붙는다)
  const THEME_ORDER = [
    '인사·기본 표현', '자기소개', '맞장구·반응', '감사·사과·축하', '접속사', '부사', '의문사', '지시어·대명사', '문형·표현',
    '숫자 0~10', '큰 수·금액·번호', '개수 〜つ', '사람 수 〜人', '개수·단위', '층·횟수', '시간·시각', '날짜·요일·계절', '월·일·나이', '위치·방향', '색깔·크기·모양',
    '동사 (기초)', '동사 (중급)', '형용사', '상태·분위기', '기분·감정', '성격·사람 묘사',
    '가족', '사람·호칭', '신체', '건강·병원', '긴급·사고', '옷·패션', '집·생활',
    '음식 이름', '식재료·조리', '맛·식감', '음료·술·카페', '식당 표현', '쇼핑·가격', '돈·결제', '편의점·마트',
    '공항·비행기', '대중교통', '길찾기·장소', '관광·자연', '여행·관광', '호텔·숙박', '날씨', '동물·식물',
    '약속·대화', '전화·메시지', 'IT·스마트폰', '직장·업무', '학교·공부', '취미·여가', '생활 서비스',
  ];
  function renderWords() {
    const all = [...new Set(WORDS.map(w => w.t))];
    const themes = [...THEME_ORDER.filter(t => all.includes(t)), ...all.filter(t => !THEME_ORDER.includes(t))];
    $app.innerHTML = themes.map(t => {
      const ws = WORDS.filter(w => w.t === t), done = ws.filter(w => S.words[w.jp]).length;
      return `<h3>${esc(t)} · ${done}/${ws.length}</h3><div class="card">` + ws.map(w => {
      const st = S.words[w.jp];
      return `<div class="row"><div class="grow"><b>${esc(w.jp)}</b> <span class="ko" style="font-size:15px">${esc(w.ko)}</span><div class="muted">${esc(w.mean)}</div></div>
        <span class="muted">${st ? '단계 ' + st.box : '새 단어'}</span>${sayBtn(w.jp)}</div>`;
      }).join('') + '</div>';
    }).join('');
  }

  function renderSettings() {
    $app.innerHTML = accountCard() + `
      <div class="card">
        <div class="row"><div class="grow">하루 새 단어 수</div>
          <select id="npd">${[5, 10, 15, 20].map(n => `<option ${n === S.newPerDay ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="muted">복습이 쌓이면 20분이 넘을 수 있어요. 10개가 기본이고, 시간이 모자라면 줄여 보세요.</div>
        <div class="row"><div class="grow">정답/오답 효과음</div>
          <input type="checkbox" id="sfx" ${S.sfx === false ? '' : 'checked'} style="width:22px;height:22px"></div>
        <button class="ghost" id="reset">학습 기록 초기화</button>
      </div>
      <div class="card muted">일본어 음성은 브라우저/OS에 설치된 일본어 음성을 사용해요. 소리가 안 나면 Windows 설정 → 시간 및 언어 → 언어에서 일본어를 추가하세요.</div>`;
    bindAccount();
    $app.querySelector('#npd').onchange = e => { S.newPerDay = +e.target.value; S.plan = {}; save(); };
    $app.querySelector('#sfx').onchange = e => { S.sfx = e.target.checked; save(); };
    $app.querySelector('#reset').onclick = () => { if (confirm('모든 학습 기록이 지워집니다. 계속할까요?')) { S.words = {}; S.log = {}; S.plan = {}; S.epoch = Date.now(); save(); go('home'); } };
  }

  // ── 학습 세션 ──
  let ticker = null, correctAll = 0, totalAll = 0;
  function startTimer() {
    stopTimer();
    ticker = setInterval(() => {
      if (document.hidden) return;
      const l = dayLog(); l.sec++;
      $timer.textContent = `⏱ ${mmss(l.sec)} / 20:00`;
      if (l.sec % 10 === 0) save();
    }, 1000);
    $timer.textContent = `⏱ ${mmss(dayLog().sec)} / 20:00`;
  }
  function stopTimer() { clearInterval(ticker); ticker = null; save(); }

  // 지난 단어 중 틀렸던 것·복습 시기가 된 것에 가중치를 줘서 무작위로 고른다
  const weight = id => { const st = S.words[id]; return 1 + 3 * Math.min(st.miss || 0, 3) + (st.due <= today() ? 3 : 0) + (st.box <= 1 ? 2 : 0); };
  function pickOld(exclude, n) {
    const pool = Object.keys(S.words).filter(id => byId[id] && !exclude.includes(id));
    const out = [];
    while (out.length < n && pool.length) {
      const ws = pool.map(weight);
      let r = Math.random() * ws.reduce((x, y) => x + y, 0), i = 0;
      while (i < ws.length - 1 && r > ws[i]) { r -= ws[i]; i++; }
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  function startSession() {
    sess = { news: planIds() };
    correctAll = totalAll = 0;
    startTimer();
    stageLearn();
  }

  function stageLearn() {
    const ids = sess.news;
    if (!ids.length) return stageQuiz();
    let i = 0;
    const show = () => {
      const w = byId[ids[i]];
      $app.innerHTML = `<div class="muted">① 새 단어 ${i + 1} / ${ids.length}</div>${wordCard(w)}
        <div class="muted">🔊 듣고 → 따라 말하기 → 예문도 한 번 소리 내어 읽어 보세요.</div>
        <button class="primary" id="nx">${i + 1 < ids.length ? '다음' : '퀴즈로 확인하기'}</button>
        ${i > 0 ? '<button class="ghost" id="pv">← 이전 단어</button>' : ''}`;
      $app.querySelector('#pv')?.addEventListener('click', () => { i--; show(); });
      speak(w.jp);
      S.words[w.jp] ||= { box: 1, due: addDays(today(), 1), miss: 0, u: Date.now() };
      save();
      $app.querySelector('#nx').onclick = () => { if (++i < ids.length) show(); else stageQuiz(); };
    };
    show();
  }

  // 퀴즈 하나로 합침: 오늘 새 단어 + 지난 단어. 단어마다 한 문제씩, 문제 유형은 골고루 섞는다.
  function stageQuiz() {
    const ids = shuffle([...sess.news, ...pickOld(sess.news, OLD_QUIZ_N)]);
    if (!ids.length) return finish();
    const types = ids.flatMap((_, i) => (i % QTYPES.length === 0 ? shuffle(QTYPES) : [])).slice(0, ids.length);
    const items = ids.map((id, i) => ({ id, type: types[i], used: [types[i]] }));
    runQuiz('② 퀴즈', items, (id, ok, first) => {
      if (!first) return;
      const st = S.words[id];
      if (!ok) { st.miss = (st.miss || 0) + 1; st.box = 1; st.due = addDays(today(), 1); }
      else {
        st.miss = Math.max(0, (st.miss || 0) - 1);
        if (!sess.news.includes(id) && st.due <= today()) { st.box = Math.min(st.box + 1, INTERVALS.length - 1); st.due = addDays(today(), INTERVALS[st.box]); }
      }
      st.u = Date.now();
      save();
    }, finish);
  }

  function finish() {
    const l = dayLog(); l.done = true;
    stopTimer();
    const acc = totalAll ? Math.round(correctAll / totalAll * 100) : 100;
    $app.innerHTML = `<div class="card" style="text-align:center">
      <div style="font-size:48px">🎉</div><h2>오늘 학습 끝!</h2>
      <p>오늘 학습 시간 <b>${mmss(l.sec)}</b> · 첫 시도 정답률 <b>${acc}%</b><br>연속 <b>${streak()}일</b> 째</p>
      <p class="muted">틀린 단어는 내일 다시 나와요. 내일 또 만나요!</p>
      <button class="primary" id="hm">홈으로</button></div>`;
    $app.querySelector('#hm').onclick = () => { $timer.textContent = ''; go('home'); };
  }

  // ── 퀴즈 엔진 ──
  function makeQ(type, w) {
    const others = key => shuffle(WORDS.filter(x => x !== w && x[key] !== w[key]));
    const pick = (key, label) => shuffle([
      { label: label(w), ok: true },
      ...others(key).slice(0, 3).map(x => ({ label: label(x), ok: false })),
    ]);
    const meanLabel = x => esc(x.mean);
    if (type === 'm1') return { prompt: `<div class="jp">${esc(w.jp)} ${sayBtn(w.jp)}</div><div class="ko">${esc(w.ko)}</div><div class="muted">무슨 뜻일까요?</div>`, opts: pick('mean', meanLabel), say: w.jp };
    if (type === 'm2') return { prompt: `<div class="mean" style="font-size:26px">${esc(w.mean)}</div><div class="muted">일본어로 알맞은 것은?</div>`, opts: pick('jp', x => `${esc(x.jp)}<small>${esc(x.ko)}</small>`) };
    if (type === 'listen') return { prompt: `<div style="font-size:42px">${sayBtn(w.jp)}</div><div class="muted">소리를 듣고 뜻을 고르세요 (한글 발음 힌트 없음)</div>`, opts: pick('mean', meanLabel), say: w.jp };
    return { prompt: `<div class="sjp">${sayBtn(w.s[0])} ${sayBtn(w.s[0], true)}</div><div class="muted">문장을 듣고 뜻을 고르세요</div>`, opts: pick('mean', x => esc(x.s[2])).map(o => o), say: w.s[0], sent: true };
  }

  // ── 정답/오답 효과 (화면 번쩍임 + 큰 배너 + 색종이 + 효과음 + 진동) ──
  let combo = 0, actx = null;
  function tone(freqs, step = 0.12, type = 'sine', vol = 0.18) {
    if (S.sfx === false) return;
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime;
      freqs.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * step;
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + step * 1.7);
        o.connect(g).connect(actx.destination);
        o.start(t); o.stop(t + step * 1.8);
      });
    } catch {}
  }
  function confetti(n) {
    const cols = ['#d6455d', '#2e9d6b', '#f2b01e', '#3b82f6', '#a855f7'];
    for (let i = 0; i < n; i++) {
      const d = document.createElement('i');
      d.className = 'confetti';
      d.style.left = 30 + Math.random() * 40 + 'vw';
      d.style.background = cols[i % cols.length];
      d.style.setProperty('--dx', Math.random() * 360 - 180 + 'px');
      d.style.setProperty('--dy', Math.random() * 300 - 40 + 'px');
      d.style.setProperty('--rot', Math.random() * 720 - 360 + 'deg');
      document.body.append(d);
      setTimeout(() => d.remove(), 1200);
    }
  }
  function fx(ok) {
    combo = ok ? combo + 1 : 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const flash = document.createElement('div'), ban = document.createElement('div');
    flash.className = 'fx-flash ' + (ok ? 'ok' : 'bad');
    ban.className = 'fx-banner ' + (ok ? 'ok' : 'bad');
    ban.innerHTML = ok
      ? `🎉 정답!${combo >= 2 ? `<small>🔥 ${combo}연속 정답</small>` : ''}`
      : '😵 아쉬워요<small>정답을 확인해 보세요</small>';
    document.body.append(flash, ban);
    setTimeout(() => { flash.remove(); ban.remove(); }, 1100);
    if (ok) { tone([660, 880, 1175]); if (!reduce) confetti(combo >= 3 ? 40 : 24); }
    else { tone([240, 170], 0.16, 'sawtooth', 0.12); try { navigator.vibrate?.(200); } catch {} }
  }

  function runQuiz(title, items, onAnswer, done) {
    const queue = items.map(i => ({ ...i, tries: 0 }));
    const next = () => {
      if (!queue.length) return done();
      const q = queue[0], w = byId[q.id], m = makeQ(q.type, w);
      $app.innerHTML = `<div class="muted">${title} · 남은 문제 ${queue.length}</div>
        <div class="card">${m.prompt}</div>
        <div id="opts">${m.opts.map((o, i) => `<button class="opt" data-i="${i}">${o.label}</button>`).join('')}</div>
        <div id="fb"></div>`;
      if (m.say) speak(m.say);
      $app.querySelectorAll('.opt').forEach(btn => btn.onclick = () => {
        const o = m.opts[+btn.dataset.i];
        q.tries++;
        const first = q.tries === 1;
        if (first) { totalAll++; if (o.ok) correctAll++; }
        onAnswer(q.id, o.ok, first);
        $app.querySelectorAll('.opt').forEach((b, i) => { b.disabled = true; if (m.opts[i].ok) b.classList.add('ok'); });
        if (!o.ok) btn.classList.add('bad');
        fx(o.ok);
        queue.shift();
        if (!o.ok) { const fresh = QTYPES.filter(t => !(q.used || []).includes(t)); q.type = fresh.length ? shuffle(fresh)[0] : shuffle(QTYPES)[0]; (q.used ||= []).push(q.type); queue.push(q); }
        $app.querySelector('#fb').innerHTML = wordCard(w) + `<button class="primary" id="nq">${o.ok ? '정답! 다음' : '다음 (이 문제는 다시 나와요)'}</button>`;
        $app.querySelector('#nq').onclick = next;
      });
    };
    next();
  }

  // ── 이벤트 ──
  document.addEventListener('click', e => {
    const s = e.target.closest('[data-say]');
    if (s) speak(s.dataset.say, s.dataset.slow ? 0.55 : 0.9);
    const n = e.target.closest('[data-nav]');
    if (n) { if (sess) { stopTimer(); sess = null; $timer.textContent = ''; } go(n.dataset.nav); }
  });
  document.getElementById('logo').onclick = () => go('home');
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  go('home');
  initSync();
})();
