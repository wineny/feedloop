/**
 * Feedloop 웹 위젯 — 의존성 0, 바닐라 JS.
 *
 * 붙이는 법:
 *   <script src="https://<도메인>/widget.js" data-feedloop="<botId>" async></script>
 *
 * 호스트 사이트의 CSS 가 위젯을 망가뜨리지 않도록 Shadow DOM 안에서 그린다.
 * iframe 이 아닌 이유는 호스트 origin 의 localStorage 를 그대로 써서 방문자 세션을 잇기 위해서다.
 *
 * 화면 상태 (설계 §3, UI v2 2026-09-11):
 *   닫힘   — 우측 하단 56px 원형 = 프로필 이미지(흰 링). 미읽음이면 배지에 개수
 *   처음   — 헤더 + 첫 인사말 + «시작 줄 두 개»
 *              「자주 묻는 질문」 — 운영자가 정한 질문 문장. 누르면 바로 전송된다
 *              「의견 남기기」    — 불편·기능 알약. 누르면 입력창이 채워진다
 *   대기   — 유저 말풍선 + 우리 쪽 타이핑 점 3개
 *   첫 답변 — AI 답변 바로 뒤에 인라인 연락처 폼. 대화당 1회, 안 남겨도 계속
 *   대화   — 우리 쪽은 왼쪽에 프로필 + 이름·시각. 연속이면 아바타·이름을 첫 줄에만
 *   되돌림 — 강조색 틴트 카드 + 체크 + PR 링크 (해결 여부 확인 링크)
 *   도구   — 입력창 «위» 알약 두 개: 「화면에서 선택하기」「상담원 연결」. 한 자리가 세 상태를 산다 —
 *            선택하면 그 칩이 첨부(틴트 + 이름 + ×)로, 상담원에게 넘기면 그 칩이 상태 줄로. 크레딧은 맨 아래
 *   상담원 — 「상담원 연결」 칩 + AI 대기 문구 밑 같은 칩. 누르면 「상담원에게 남길 말」 폼
 *            (마지막 내 말을 미리 채움, 이메일 없으면 연락처 칸) → POST /escalate. 그 말은 AI 가 답하지 않고
 *            사람에게 간다. 넘어간 동안 버튼 자리에 상태 줄. 답장 오면 사라짐. 서버 escalated 는
 *            «방문자가 직접 불렀나»다 — AI 가 물러난 것만으로는 안 켜진다(2026-09-16)
 *   선택   — 「화면에서 선택하기」 → widget-pick.js 를 그때 받아 페이지에서 요소를 고른다 → 첨부 → context.target
 *   모바일 — 480px 이하 풀스크린 시트. 헤더 우측 닫기(X)
 * 색·간격은 랜딩 토큰(globals.css .landing)과 같다.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var botId = script.getAttribute('data-feedloop');
  if (!botId) {
    console.error('[feedloop] data-feedloop 속성에 botId 가 필요합니다');
    return;
  }

  var ORIGIN = new URL(script.src).origin;   // notifyParent 의 targetOrigin
  var apiBase = ORIGIN + '/api/widget/' + botId;
  var STORAGE_KEY = 'feedloop:visitor';
  var SKIP_KEY = 'feedloop:contact-skip:' + botId;
  var SEEN_KEY = 'feedloop:seen:' + botId;   // 마지막으로 창을 열어 본 시각 — 재방문 때 옛 답변을 미읽음으로 세지 않게
  var POLL_OPEN_MS = 5000;
  var POLL_CLOSED_MS = 60000;

  // ── 저장소 (시크릿 모드·저장 차단이면 이번 방문에만 유지) ──

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }

  // ── 방문자 식별 — 브라우저별로 하나. 바뀌면 다른 사람으로 본다(설계상 합치지 않는다) ──

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  var visitorId = lsGet(STORAGE_KEY);
  if (!visitorId) {
    visitorId = uuid();
    lsSet(STORAGE_KEY, visitorId);
  }

  // ── 기술 맥락 수집 (Gleap 차용 P0-1) ─────────────
  //
  // 텍스트만 받으면 자동 PR 이 "어느 페이지 얘긴지"조차 모른 채 레포 전체를 뒤진다.
  // 여기서 걷은 값이 PR 프롬프트의 재료가 된다.
  //
  // 원칙 셋 — 이 코드는 남의 사이트에서 돈다:
  //  1. 호스트 사이트의 동작을 바꾸지 않는다. 기존 핸들러를 반드시 다시 부른다
  //  2. 위젯 자신의 요청은 세지 않는다 (폴링 실패가 버그로 보고되면 곤란하다)
  //  3. 스크립트가 async 라 **위젯이 뜨기 전에 난 에러는 못 잡는다.** 한계로 안고 간다
  // 수집한 값의 마스킹·상한은 서버(lib/widget/context.ts)가 다시 건다.

  var MAX_KEPT = 5;
  var errorLog = [];
  var failedLog = [];

  // 방문자가 깔아 둔 확장(지갑·번역기·광고차단…)이 낸 에러는 **이 사이트의 버그가 아니다.**
  // 실어 보내면 요약이 그걸 증상으로 받아 적고, 묶기가 그 문자열을 기준으로 전혀 다른
  // 제보들을 한 묶음에 넣는다(I-45). 스택·출처에 확장 스킴이 보이면 애초에 안 담는다.
  // 서버(lib/widget/context.ts)도 같은 스킴을 한 번 더 거른다.
  var EXTENSION_ORIGIN = /(?:chrome|moz|safari-web|ms-browser)-extension:\/\//i;

  function fromExtension(text) {
    try {
      return !!text && EXTENSION_ORIGIN.test(String(text));
    } catch {
      return false;
    }
  }

  function keep(list, entry) {
    if (list.length >= MAX_KEPT) list.shift();
    list.push(entry);
  }

  var prevOnError = window.onerror;
  window.onerror = function (message, source, lineno) {
    try {
      // 담지 «않을» 뿐, 호스트 핸들러는 아래에서 그대로 부른다 (원칙 1).
      if (!fromExtension(source)) {
        var where = source ? ' (' + String(source).split('/').pop() + ':' + lineno + ')' : '';
        keep(errorLog, String(message) + where);
      }
    } catch {
      /* 수집 실패가 페이지를 망가뜨리면 안 된다 */
    }
    if (typeof prevOnError === 'function') return prevOnError.apply(this, arguments);
    return false;
  };

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var reason = ev && ev.reason;
      // rejection 은 출처가 안 실려 오므로 스택으로 가른다. 확장이 낸 것은 여기서 걸린다.
      if (fromExtension(reason && reason.stack)) return;
      keep(errorLog, 'Unhandled rejection: ' + String((reason && reason.message) || reason));
    } catch {
      /* 무시 */
    }
  });

  // fetch 래핑 — 4xx·5xx 와 네트워크 실패만 남긴다. 성공 요청은 관심 없다.
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch {
        /* 무시 */
      }
      var ours = url.indexOf(apiBase) === 0;
      return nativeFetch.apply(this, arguments).then(
        function (res) {
          try {
            if (res && !res.ok && !ours) keep(failedLog, res.status + ' ' + url.split('?')[0]);
          } catch {
            /* 무시 */
          }
          return res;
        },
        function (err) {
          try {
            if (!ours) keep(failedLog, 'network error ' + url.split('?')[0]);
          } catch {
            /* 무시 */
          }
          throw err;
        },
      );
    };
  }

  function collectContext() {
    var ctx = {};
    // 샌드박스 iframe 등에서 접근이 막힐 수 있다. 중간에 끊겨도 그때까지 채운 값은 보낸다.
    try {
      ctx.url = location.href;
      ctx.user_agent = navigator.userAgent;
      ctx.viewport = window.innerWidth + 'x' + window.innerHeight;
      ctx.screen = window.screen.width + 'x' + window.screen.height;
      ctx.language = navigator.language;
    } catch {
      /* 부분 수집으로 만족한다 */
    }
    if (errorLog.length) ctx.errors = errorLog.slice();
    if (failedLog.length) ctx.failed_requests = failedLog.slice();
    return ctx;
  }

  // ── 상태 ──────────────────────────────────────────

  var state = {
    open: false,
    sending: false,
    cfg: null,           // GET /config — 표시 이름·상태 문구·인사말·프로필·칩
    items: [],           // 타임라인 {id, kind: user|ai|operator|system|notice, body, at}
    seen: {},            // id → true (폴링 중복 제거)
    cursor: null,        // 마지막으로 받은 항목 시각
    unread: 0,
    lastSeen: lsGet(SEEN_KEY),   // ISO 시각. 이보다 오래된 항목은 이미 본 것
    notice: null,
    error: null,
    draft: '',           // 입력창 내용 — 재렌더에도 살아남게
    hint: null,          // 칩으로 시작했으면 bug|feature
    startersSeen: false, // 시작 줄 등장 애니메이션은 처음 한 번만 (재렌더마다 깜빡이지 않게)
    contact: { name: null, email: null, phone: null },
    contactSkipped: lsGet(SKIP_KEY) === '1',
    escalated: false,    // 담당자에게 넘어가 있는가(서버 GET escalated 가 정본)
    handoff: false,      // 「상담원에게 남길 말」 폼이 떠 있는가
    hf: { text: '', name: '', mail: '' },   // 그 폼의 입력 — 재렌더(에러·폴링)에도 살아남게
    asking: false,       // escalate 요청 중(버튼 잠금)
    confirming: null,    // 「해결됐나」 응답을 보내는 중인 되돌림 id
    target: null,        // 「화면에서 짚기」로 고른 요소 — 다음 메시지에 붙는다
    picking: false,      // 선택기가 떠 있는 동안(버튼 잠금)
    shot: null,          // 짚는 순간 찍은 화면(I-55) — 1 촬영 중 · -1 실패 · {id, thumb}
  };

  // ── DOM ───────────────────────────────────────────

  var host = document.createElement('div');
  host.setAttribute('data-feedloop-widget', '');
  var root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  var FONT = '"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif';

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:' + FONT + ';-webkit-font-smoothing:antialiased}',
    // 토큰: ink #191d1b · muted #6e6968 · faint #a39d9b · line #eeeae9 · chip #f6f3f2
    //       coral #F2645C · coral-tint #FDF1F0 · coral-tint-2 #FBE2E2 · radius 14(면)/12(입력)/999(버튼)
    // 운영자가 고른 색은 applyColors 가 CSS 변수로 얹는다. 폴백이 기본색이라
    // 아무것도 안 정한 봇은 예전과 한 픽셀도 다르지 않다.
    // --fl-accent(꽉 찬 배경) · --fl-accent-fg(그 위의 글자) · --fl-accent-strong
    // (흰 바탕 위의 글자·선) · --fl-accent-tint/-tint-2 · --fl-me · --fl-me-fg
    '.wrap{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px}',
    // 닫힘 — 플로팅 버튼
    '.fab{width:56px;height:56px;border-radius:999px;border:0;padding:0;cursor:pointer;position:relative;background:var(--fl-accent,#F2645C);color:var(--fl-accent-fg,#fff);box-shadow:0 8px 24px rgba(25,29,27,.18);display:flex;align-items:center;justify-content:center;transition:transform .15s cubic-bezier(.2,.7,.2,1)}',
    '.fab:hover{transform:scale(1.05)}',
    '.fab img{width:56px;height:56px;border-radius:999px;object-fit:cover;border:3px solid #fff;display:block}',
    '.fab .ini{font-size:22px;font-weight:700;letter-spacing:-0.02em}',
    '.fab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
    '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--fl-accent,#F2645C);color:var(--fl-accent-fg,#fff);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff}',
    // 패널
    '.panel{width:360px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 100px);background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(25,29,27,.2),0 4px 16px rgba(25,29,27,.08);display:flex;flex-direction:column;overflow:hidden;color:#191d1b}',
    '.hd{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid #eeeae9;flex-shrink:0}',
    '.hd .t{flex:1;min-width:0}',
    '.hd h3{margin:0;font-size:16px;font-weight:700;letter-spacing:-0.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hd p{margin:2px 0 0;font-size:12px;color:#6e6968}',
    '.x{border:0;background:none;color:#a39d9b;cursor:pointer;width:32px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;padding:0}',
    '.x:hover{background:#f6f3f2;color:#191d1b}',
    '.x svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}',
    // 아바타
    '.av{width:28px;height:28px;border-radius:999px;flex-shrink:0;background:var(--fl-accent,#F2645C);color:var(--fl-accent-fg,#fff);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.av img{width:100%;height:100%;object-fit:cover;display:block}',
    '.av.lg{width:36px;height:36px;font-size:15px}',
    // 타임라인
    '.body{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;background:#fff}',
    // 첫 화면은 인사말과 시작 줄뿐이라 위에 붙이면 아래가 통째로 빈다. 이 늘어나는
    // 빈 칸이 내용을 입력창 쪽으로 내린다 — 대화가 쌓이면 0 으로 줄어 그냥 사라진다.
    // justify-content:flex-end 를 쓰면 내용이 넘칠 때 위쪽이 잘려 스크롤로도 못 본다.
    '.fill{flex:1 1 0;min-height:0}',
    '.row{display:flex;gap:8px;align-items:flex-start}',
    '.row.me{justify-content:flex-end}',
    '.col{display:flex;flex-direction:column;gap:4px;max-width:78%;min-width:0}',
    '.who{font-size:11px;color:#6e6968;margin-left:2px;display:flex;align-items:center;gap:5px}',
    // 같은 발신자가 연속으로 말하면 아바타·이름을 첫 줄에만 둔다. 자리는 빈 칸으로 지킨다.
    '.sp{width:28px;flex-shrink:0}',
    '.who .tm{color:#a39d9b;font-size:10.5px;font-variant-numeric:tabular-nums}',
    '.who .ai{font-size:9.5px;font-weight:700;color:var(--fl-accent-strong,#F2645C);background:var(--fl-accent-tint,#FDF1F0);border-radius:999px;padding:1px 6px;line-height:1.4}',
    '.bub{padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;letter-spacing:-0.01em}',
    '.bub.me{background:var(--fl-me,#191d1b);color:var(--fl-me-fg,#fff);border-bottom-right-radius:4px}',
    '.bub.us{background:#f6f3f2;color:#191d1b;border-bottom-left-radius:4px}',
    '.bub.op{background:#fff;color:#191d1b;border:1px solid #eeeae9;border-bottom-left-radius:4px}',
    // 시작 줄 — 위는 「자주 묻는 질문」(누르면 바로 전송), 아래는 의견 알약(입력창 채우기).
    // 형태를 갈라 둔 이유: 둘은 누른 뒤 벌어지는 일이 다르다. 질문은 답이 오고,
    // 의견은 방문자가 이어 써야 한다. 같은 알약 세 개로 두면 그 차이가 안 보인다.
    '.starts{margin-left:36px;display:flex;flex-direction:column}',
    '.sl{font-size:11px;font-weight:700;color:#a39d9b;letter-spacing:0.02em;margin:0 0 7px 2px}',
    '.qs{display:flex;flex-direction:column;gap:6px}',
    '.q{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid #eeeae9;background:#fff;color:#191d1b;border-radius:999px;padding:7px 14px 7px 16px;font-size:13.5px;line-height:1.4;cursor:pointer;letter-spacing:-0.01em}',
    '.q span{flex:1;min-width:0}',
    '.q svg{width:14px;height:14px;flex-shrink:0;fill:none;stroke:var(--fl-accent-strong,#F2645C);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
    '.q:hover{border-color:var(--fl-accent-strong,#F2645C);background:var(--fl-accent-tint,#FDF1F0)}',
    // 의견 알약은 가로로 흐르고, 안 들어가면 다음 줄로 내려간다(칩 안에서 줄바꿈되지 않게).
    '.fbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
    '.chip{border:1px solid #eeeae9;background:#f6f3f2;color:#6e6968;border-radius:999px;padding:6px 13px;font-size:12.5px;cursor:pointer;line-height:1.3;white-space:nowrap}',
    '.chip:hover{border-color:#d9d3d1;background:#eeeae9;color:#191d1b}',
    // 등장은 처음 한 번만(.in). 재렌더마다 다시 돌면 칩이 깜빡인다.
    '.starts.in .q,.starts.in .chip{opacity:0;animation:fl-u .28s cubic-bezier(.2,.7,.2,1) forwards}',
    '@keyframes fl-u{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}',
    // 타이핑 점 3개
    '.dots{display:flex;gap:4px;padding:13px 14px}',
    '.dots i{width:6px;height:6px;border-radius:999px;background:#a39d9b;animation:fl-b 1.2s infinite}',
    '.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}',
    '@keyframes fl-b{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
    // 인라인 연락처 폼 (첫 답변 뒤)
    '.cform{margin-left:36px;max-width:calc(100% - 36px);background:#fff;border:1px solid #eeeae9;border-radius:14px;border-top-left-radius:4px;padding:12px;display:flex;flex-direction:column;gap:7px}',
    '.cform p{margin:0;font-size:13.5px;font-weight:700;line-height:1.45;color:#191d1b}',
    '.cform small{font-size:12px;line-height:1.5;color:#6e6968;margin-bottom:3px}',
    '.cform input{border:1px solid #eeeae9;border-radius:12px;padding:9px 11px;font-size:13px;outline:none;color:#191d1b;background:#fff;width:100%}',
    '.cform input:focus,.cform textarea:focus{border-color:var(--fl-accent-strong,#F2645C)}',
    '.cform textarea{border:1px solid #eeeae9;border-radius:12px;padding:9px 11px;font-size:13.5px;line-height:1.45;outline:none;color:#191d1b;background:#fff;width:100%;resize:none;height:72px}',
    '.hint{margin:2px 0 0 36px}',
    '.cform .acts{display:flex;align-items:center;justify-content:space-between;margin-top:3px}',
    '.pri{border:0;background:var(--fl-accent,#F2645C);color:var(--fl-accent-fg,#fff);border-radius:999px;padding:7px 18px;font-size:13px;font-weight:700;cursor:pointer}',
    '.pri:disabled{opacity:.5;cursor:default}',
    '.skip{border:0;background:none;color:#6e6968;font-size:12px;cursor:pointer;padding:6px 2px}',
    '.skip:hover{color:#191d1b}',
    // 연락처 확인 칩 (가운데)
    '.ok{align-self:center;background:#f6f3f2;color:#6e6968;border-radius:999px;padding:6px 12px;font-size:12px;max-width:92%;text-align:center;word-break:break-all}',
    // 되돌림 카드
    '.card{margin-left:36px;max-width:calc(100% - 36px);background:var(--fl-accent-tint,#FDF1F0);border:1px solid var(--fl-accent-tint-2,#FBE2E2);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}',
    '.card .ch{display:flex;align-items:center;gap:7px}',
    '.ck{width:17px;height:17px;border-radius:999px;flex-shrink:0;background:var(--fl-accent,#F2645C);display:flex;align-items:center;justify-content:center}',
    '.ck svg{width:9px;height:9px;fill:none;stroke:var(--fl-accent-fg,#fff);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}',
    '.card b{font-size:13.5px;color:#191d1b}',
    '.card p{margin:0;font-size:13px;line-height:1.55;color:#191d1b;white-space:pre-wrap;word-break:break-word}',
    '.card a{color:var(--fl-accent-strong,#F2645C);font-size:13px;font-weight:700;text-decoration:none}',
    '.card a:hover{text-decoration:underline}',
    '.cf{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px}',
    '.cf span{font-size:12.5px;color:#6e6968}',
    '.cf .chip{padding:5px 11px}',
    '.chip:disabled{opacity:.45;cursor:default}',
    '.notice{font-size:12px;color:#6e6968;text-align:center;padding:2px}',
    // 입력
    '.ft{flex-shrink:0;border-top:1px solid #eeeae9;background:#fff}',
    '.inp{display:flex;gap:8px;padding:8px 10px 6px;align-items:flex-end}',
    '.inp textarea{flex:1;resize:none;border:1px solid #eeeae9;border-radius:12px;padding:10px 12px;font-size:14px;line-height:1.4;height:42px;max-height:96px;outline:none;overflow-y:auto;color:#191d1b;background:#fff}',
    '.inp textarea:focus{border-color:var(--fl-accent-strong,#F2645C)}',
    '.send{border:0;background:var(--fl-accent,#F2645C);color:var(--fl-accent-fg,#fff);border-radius:999px;height:38px;padding:0 18px;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0}',
    '.send:disabled{opacity:.5;cursor:default}',
    '.err{color:#c0392b;font-size:12px;padding:0 12px 6px}',
    // 도구 줄 — 입력창 위 알약. 첫 화면의 의견 알약과 같은 문법이라 «누르면 무언가 된다»로 읽힌다.
    // 선택 칩은 첨부(.att)로, 상담원 칩은 상태(.st)로 «같은 자리에서» 바뀐다 — 화면이 안 흔들린다
    '.tools{display:flex;gap:6px;padding:10px 10px 0;align-items:center;min-width:0}',
    '.tool{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px 0 10px;border-radius:999px;border:1px solid #eeeae9;background:#fff;color:#191d1b;font-size:12.5px;font-weight:600;letter-spacing:-0.01em;cursor:pointer;white-space:nowrap;flex-shrink:0;min-width:0}',
    '.tool:hover{border-color:#d9d3d1;background:#f6f3f2}',
    '.tool:disabled{opacity:.5;cursor:default}',
    '.tool svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}',
    '.tool.att{background:var(--fl-accent-tint,#FDF1F0);border-color:var(--fl-accent-tint-2,#FBE2E2);flex-shrink:1;padding-right:6px}',
    '.tool.att .lbl{overflow:hidden;text-overflow:ellipsis}',
    '.tool .th{width:24px;height:24px;border-radius:6px;object-fit:cover;flex-shrink:0;margin-left:-5px;border:1px solid #eeeae9}',
    '.tool .rm{border:0;background:none;padding:0;width:20px;height:20px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#6e6968;cursor:pointer;flex-shrink:0}',
    '.tool .rm:hover{background:#fff;color:#191d1b}.tool .rm svg{width:12px;height:12px}',
    '.tool.st{border:0;background:none;color:#6e6968;font-weight:500;padding-left:2px;cursor:default;flex-shrink:1}',
    '.tool.st:hover{background:none}',
    '.tool.st i{width:6px;height:6px;border-radius:999px;background:var(--fl-accent,#F2645C);flex-shrink:0}',
    '.tool.st span{overflow:hidden;text-overflow:ellipsis}.tool.st b{color:#191d1b;font-weight:600}',
    '.credit{display:flex;justify-content:flex-end;padding:0 12px 9px}',
    '.pw{font-size:11px;color:#a39d9b;white-space:nowrap}',
    // 키보드 초점. :host{all:initial} 이라 브라우저 기본 아웃라인까지 지워져서
    // 지금까지 탭으로 이동하면 어디에 있는지 보이지 않았다.
    'button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--fl-accent-strong,#F2645C);outline-offset:2px}',
    // 모바일 — 풀스크린 시트. 480px 인 이유: 요즘 폰 폭이 390~430px 이라
    // 360px 기준이면 정작 흔한 기기에서 좌우 20px 을 남긴 카드로 떠 있었다.
    '@media (max-width:480px){.panel{position:fixed;inset:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0}.wrap.open .fab{display:none}}',
    // 움직임을 줄이겠다고 한 방문자에게는 등장·호버 확대를 걷어낸다.
    '@media (prefers-reduced-motion:reduce){.starts.in .q,.starts.in .chip{animation:none;opacity:1}.fab{transition:none}.fab:hover{transform:none}.dots i{animation:none}}',
  ].join('');
  root.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(wrap);

  // ── 운영자가 고른 색 ──────────────────────────────
  //
  // config 의 accentColor·visitorBubbleColor 를 CSS 변수로 얹는다. 없으면 안 얹고
  // CSS 폴백(코랄·잉크)이 그대로 쓰인다. 서버에서 이미 정규화된 값이지만 여기서
  // 한 번 더 본다 — 남의 사이트에서 스타일로 해석되는 문자열이다.
  //
  // 계산은 lib/bot/appearance.ts 와 «같아야» 한다(운영자 미리보기가 그걸 쓴다).
  // 두 구현이 같은 값을 내는지는 __tests__/appearance.test.ts 가 이 파일에서
  // 함수를 떼어내 실행으로 대조한다.
  var HEX6 = /^#[0-9a-f]{6}$/i;
  var INK = '#191d1b';

  function hex(value) {
    return typeof value === 'string' && HEX6.test(value.trim()) ? value.trim() : null;
  }

  function byte(color, i) { return parseInt(color.slice(1 + i * 2, 3 + i * 2), 16); }

  /** 두 색을 섞는다. ratio = 첫 색의 비율. appearance.ts mixColors 와 같은 계산. */
  function mix(color, other, ratio) {
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(byte(color, i) * ratio + byte(other, i) * (1 - ratio));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  /** WCAG 상대 명도. appearance.ts relativeLuminance 와 같은 계산. */
  function lum(color) {
    var weights = [0.2126, 0.7152, 0.0722];
    var total = 0;
    for (var i = 0; i < 3; i++) {
      var v = byte(color, i) / 255;
      total += weights[i] * (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    }
    return total;
  }

  /**
   * 꽉 찬 강조색 위에 올릴 글자색. 밝은 강조색에 흰 글씨면 안 읽힌다 —
   * 명도 0.5 초과면 잉크. appearance.ts readableTextOn 과 같은 임계값.
   */
  function readableOn(color) {
    return lum(color) > 0.5 ? INK : '#ffffff';
  }

  /**
   * 흰 바탕 위의 글자·선으로 쓸 강조색. 흰색 대비 3:1(명도 0.30) 아래로 내린다.
   * 코랄(0.288)은 이미 그 아래라 그대로 나온다 — 기존 봇은 안 바뀐다.
   * appearance.ts readableAccent 와 같은 계산.
   */
  function strongAccent(color) {
    for (var percent = 100; percent > 0; percent -= 5) {
      var candidate = mix(color, INK, percent / 100);
      if (lum(candidate) <= 0.3) return candidate;
    }
    return INK;
  }

  function applyColors() {
    var accent = hex(state.cfg && state.cfg.accentColor);
    if (accent) {
      // 틴트는 원색이 아니라 «어둡게 만든» 강조색에서 뽑는다. 밝은 강조색을
      // 그대로 12% 섞으면 흰색과 구별되지 않아 되돌림 카드가 통째로 사라진다.
      var strong = strongAccent(accent);
      wrap.style.setProperty('--fl-accent', accent);
      wrap.style.setProperty('--fl-accent-fg', readableOn(accent));
      wrap.style.setProperty('--fl-accent-strong', strong);
      wrap.style.setProperty('--fl-accent-tint', mix(strong, '#ffffff', 0.12));
      wrap.style.setProperty('--fl-accent-tint-2', mix(strong, '#ffffff', 0.2));
    }

    var me = hex(state.cfg && state.cfg.visitorBubbleColor);
    if (me) {
      wrap.style.setProperty('--fl-me', me);
      wrap.style.setProperty('--fl-me-fg', readableOn(me));
    }
  }

  // ── 렌더 ──────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;  // textContent — 호스트/유저 입력을 HTML 로 해석하지 않는다
    return n;
  }

  function icon(d) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  var ICON_X = 'M6 6l12 12M18 6L6 18';
  var ICON_NEXT = 'M9 6l6 6-6 6';      // 시작 질문 칩 — 누르면 다음으로 간다
  var ICON_CHECK = 'M4 12l5 5L20 6';   // 되돌림 카드
  var ICON_PICK = 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 2v3M12 19v3M2 12h3M19 12h3M12 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4';   // 조준점
  var ICON_PERSON = 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c0-4 3.6-7 8-7s8 3 8 7';
  var ICON_CHAT = 'M21 11.5a8.4 8.4 0 01-9 8.4 8.5 8.5 0 01-3.9-.9L3 21l1.9-5a8.4 8.4 0 01-.9-3.9 8.5 8.5 0 018.4-9h.5a8.5 8.5 0 018 8v.4z';

  function displayName() { return (state.cfg && state.cfg.displayName) || '의견 보내기'; }

  function avatar(large) {
    var a = el('div', 'av' + (large ? ' lg' : ''));
    if (state.cfg && state.cfg.profileImageUrl) {
      var img = el('img');
      img.src = state.cfg.profileImageUrl;
      img.alt = '';
      a.appendChild(img);
    } else {
      a.textContent = displayName().charAt(0).toUpperCase();
    }
    return a;
  }

  /** 시:분. 방문자 기기의 시간대로 읽는다. */
  function hhmm(at) {
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /**
   * 우리 쪽 말풍선 한 줄 — 왼쪽 프로필 + 이름·시각(+AI 배지) + 말풍선.
   *
   * cont 는 «바로 위 줄과 같은 발신자» 라는 뜻이다. 그때는 아바타와 이름을 지우고
   * 자리만 남긴다 — 답이 세 줄로 나뉘어 오면 프로필이 세 번 쌓여 벽처럼 보인다.
   * 시각도 그룹의 첫 줄에만 붙는다(한 번에 온 말이라 같은 시각이다).
   */
  function ourRow(kind, body, at, cont) {
    var row = el('div', 'row');
    row.appendChild(cont ? el('div', 'sp') : avatar(false));
    var col = el('div', 'col');

    // 인사말은 헤더 바로 밑이라 이름을 또 적지 않는다. 시각도 없다(보낸 말이 아니다).
    if (!cont && kind !== 'greeting') {
      var who = el('div', 'who');
      if (kind === 'operator') {
        who.appendChild(el('span', null, (state.cfg && state.cfg.operatorDisplayName) || displayName()));
      } else {
        who.appendChild(el('span', null, displayName()));
        if (kind === 'ai') who.appendChild(el('span', 'ai', 'AI'));
      }
      if (at) {
        var t = hhmm(at);
        if (t) who.appendChild(el('span', 'tm', t));
      }
      col.appendChild(who);
    }

    col.appendChild(el('div', 'bub ' + (kind === 'operator' ? 'op' : 'us'), body));
    row.appendChild(col);
    return row;
  }

  function myRow(body) {
    var row = el('div', 'row me');
    row.appendChild(el('div', 'bub me', body));
    return row;
  }

  /**
   * 되돌림 카드. 본문 안의 URL 은 PR 링크로 뽑고, 「그래서 고쳐졌나」를 **카드 안에서** 받는다.
   *
   * 예전에는 새 탭으로 `/feedback-confirm` 을 열었고 **되돌림 6건에 응답이 0건**이었다.
   * ⚠️ 그 페이지는 남아 있지만 **이제 아무도 링크하지 않는다** — 되돌림 메일의 CTA 도 사이트로
   * 간다(templates.ts). 진입점 0인 무인증 페이지다. 지울지는 별도 결정.
   */
  function systemCard(body, id, confirmation) {
    var card = el('div', 'card');
    var head = el('div', 'ch');
    var dot = el('div', 'ck');
    dot.appendChild(icon(ICON_CHECK));
    head.appendChild(dot);
    head.appendChild(el('b', null, '반영됐어요'));
    card.appendChild(head);
    var m = body.match(/https?:\/\/\S+/);
    var text = m ? body.replace(m[0], '').replace(/\(\s*\)/, '').trim() : body;
    if (text) card.appendChild(el('p', null, text));
    if (m) {
      var a = el('a', null, '바뀐 내용 보기 →');
      a.href = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.appendChild(a);
    }
    card.appendChild(confirmRow(id, confirmation));
    return card;
  }

  /** 확인 줄. 서버가 준 값이 정본이고, 응답을 기다리는 동안만 로컬로 잠근다. */
  function confirmRow(id, conf) {
    var row = el('div', 'cf');
    row.setAttribute('aria-live', 'polite');
    if (conf) {
      // 「아직」이면 서버가 대화를 escalated 로 올려 하단이 「상담원에게 전달됐어요」가 된다(의도).
      row.appendChild(el('span', null, conf === 'fixed'
        ? '해결됐다고 알려주셨어요. 고맙습니다 🙌'
        : '아직이라고 알려주셨어요. 담당자가 다시 봅니다'));
      return row;
    }
    if (state.confirming === id) {
      row.appendChild(el('span', null, '보내는 중…'));
      return row;
    }
    row.appendChild(el('span', null, '이제 잘 되나요?'));
    row.appendChild(confirmBtn(id, 'fixed', '네, 잘 돼요'));
    row.appendChild(confirmBtn(id, 'not_fixed', '아직 그대로예요'));
    return row;
  }

  function confirmBtn(id, value, label) {
    var b = el('button', 'chip', label);
    // 잠금은 전역이다(한 번에 하나만 보낸다). 그러면 «다른» 카드의 버튼도 눌리지 않는데,
    // 멀쩡해 보이면 눌러 놓고 아무 일도 안 일어나는 걸 본다 — 죽은 것은 죽어 보여야 한다.
    if (state.confirming) b.disabled = true;
    else b.onclick = function () { sendConfirm(id, value); };
    return b;
  }

  function typingRow(cont) {
    var row = el('div', 'row');
    row.appendChild(cont ? el('div', 'sp') : avatar(false));
    var col = el('div', 'col');
    if (!cont) {
      var who = el('div', 'who');
      who.appendChild(el('span', null, displayName()));
      col.appendChild(who);
    }
    var d = el('div', 'bub us dots');
    d.appendChild(el('i')); d.appendChild(el('i')); d.appendChild(el('i'));
    col.appendChild(d);
    row.appendChild(col);
    return row;
  }

  function hasContact() {
    var c = state.contact;
    return !!(c.name || c.email || c.phone);
  }

  // 인라인 연락처 폼 — 첫 답변 뒤(1회)와 담당자 호출 직후가 같이 쓴다. 전화 칸은 뺐다
  function contactForm(title, sub, skipLabel, onSkip, saveLabel, onSave) {
    var f = el('div', 'cform');
    f.appendChild(el('p', null, title));
    f.appendChild(el('small', null, sub));
    var nameIn = el('input'); nameIn.placeholder = '이름';
    var mailIn = el('input'); mailIn.placeholder = '이메일'; mailIn.type = 'email';
    f.appendChild(nameIn); f.appendChild(mailIn);

    var acts = el('div', 'acts');
    var skip = el('button', 'skip', skipLabel);
    skip.onclick = onSkip;
    var save = el('button', 'pri', saveLabel);
    save.onclick = function () { onSave(nameIn.value, mailIn.value); };
    acts.appendChild(skip);
    acts.appendChild(save);
    f.appendChild(acts);
    return f;
  }

  /** 첫 답변 뒤 슬롯 — 연락처 폼(1회) 또는 남긴 연락처 확인 칩 */
  function contactSlot() {
    if (state.handoff) return null;   // 상담원 폼과 나란히 서지 않게
    if (hasContact()) {
      var c = state.contact;
      var where = c.email || c.phone;
      return el('div', 'ok', c.name && where ? c.name + ' · ' + where + ' 로 답장을 보내드려요'
        : where ? where + ' 로 답장을 보내드려요'
        : c.name + ' 님께 답장을 보내드려요');
    }
    if (state.contactSkipped) return null;

    return contactForm(
      '답장 받을 곳을 남겨주세요',
      '팀이 답하거나 말씀하신 문제가 반영되면 이메일로 알려드려요.',
      '괜찮아요, 그냥 볼게요',
      function () {
        state.contactSkipped = true;
        lsSet(SKIP_KEY, '1');
        render();
      },
      '남기기',
      function (name, mail) { postContact(name, mail, ''); },
    );
  }

  /** 마지막 내 말 — 상담원 폼에 미리 채운다(고쳐 써도 된다). */
  function lastMine() {
    for (var i = state.items.length - 1; i >= 0; i--) if (state.items[i].kind === 'user') return state.items[i].body;
    return '';
  }

  /** 「상담원에게 남길 말」 폼. 그 말은 AI 가 답하지 않고 사람에게 간다. 이메일이 없으면 연락처 칸도. */
  function handoffForm() {
    var f = el('div', 'cform');
    f.appendChild(el('p', null, '상담원에게 남길 말'));
    var when = (state.cfg && state.cfg.statusText) || '';
    f.appendChild(el('small', null, 'AI 대신 사람이 읽고 답해요.' + (when ? ' ' + when + '.' : '')));
    // 입력은 state.hf 에 산다 — 에러·폴링 재렌더가 패널을 통째로 다시 만들어도 쓰던 글이 안 사라진다
    var hf = state.hf;
    var ta = el('textarea'); ta.placeholder = '무엇을 도와드릴까요?'; ta.value = hf.text;
    ta.oninput = function () { hf.text = ta.value; };
    f.appendChild(ta);
    if (!state.contact.email) {
      var nameIn = el('input'); nameIn.placeholder = '이름 (선택)'; nameIn.value = hf.name;
      nameIn.oninput = function () { hf.name = nameIn.value; };
      var mailIn = el('input'); mailIn.placeholder = '답을 받을 이메일 (선택)'; mailIn.type = 'email'; mailIn.value = hf.mail;
      mailIn.oninput = function () { hf.mail = mailIn.value; };
      f.appendChild(nameIn); f.appendChild(mailIn);
    }
    var acts = el('div', 'acts');
    var cancel = el('button', 'skip', '취소');
    cancel.onclick = function () { state.handoff = false; render(); };
    var go = el('button', 'pri', '상담원에게 보내기');
    go.disabled = state.asking;
    go.onclick = function () {
      var text = hf.text.trim();
      if (!text && !hasUserMsg()) { state.error = '상담원에게 남길 말을 적어주세요'; render(); return; }
      // 미리 채운 마지막 내 말을 그대로 보내면 같은 문장이 두 벌 저장된다 — 그땐 대화만 넘긴다
      if (text === lastMine().trim()) text = '';
      postEscalate(text, state.contact.email ? '' : hf.name, state.contact.email ? '' : hf.mail);
    };
    acts.appendChild(cancel); acts.appendChild(go);
    f.appendChild(acts);
    return f;
  }

  /** AI 대기 문구 밑의 제안 칩 — 못 답한 바로 그 자리에서 사람을 부른다. */
  function handoffHint() {
    var box = el('div', 'hint');
    var b = el('button', 'chip', '상담원 연결');
    b.onclick = askHuman;
    box.appendChild(b);
    return box;
  }

  function hasUserMsg() {
    return state.items.some(function (it) { return it.kind === 'user'; });
  }

  /**
   * 첫 화면의 시작 줄 — 위는 「자주 묻는 질문」, 아래는 의견 알약.
   *
   * 둘의 동작이 다르다. 질문은 «누르면 곧장 전송»된다. 방문자가 답을 받으러 온
   * 것이라 한 번 더 누르게 할 이유가 없다. 의견은 입력창을 채우기만 한다 —
   * 「불편한 점이 있어요」만 보내면 AI 가 무엇이 불편한지 되물을 수밖에 없다.
   */
  function starterBlock() {
    var questions = (state.cfg && state.cfg.starterQuestions) || [];
    var chips = (state.cfg && state.cfg.chips) || [];
    if (!questions.length && !chips.length) return null;

    var box = el('div', 'starts' + (state.startersSeen ? '' : ' in'));
    var step = 0;

    if (questions.length) {
      box.appendChild(el('div', 'sl', '자주 묻는 질문'));
      var list = el('div', 'qs');
      questions.forEach(function (text) {
        if (typeof text !== 'string' || !text) return;
        var b = el('button', 'q');
        b.appendChild(el('span', null, text));
        b.appendChild(icon(ICON_NEXT));
        b.style.animationDelay = step++ * 45 + 'ms';
        b.onclick = function () { dropShot(); state.target = null; send(text, 'question'); };   // 질문엔 짚은 요소를 안 싣는다
        list.appendChild(b);
      });
      box.appendChild(list);
    }

    if (chips.length) {
      var pills = el('div', 'fbs');
      chips.forEach(function (c) {
        var b = el('button', 'chip', c.label);
        b.style.animationDelay = step++ * 45 + 'ms';
        b.onclick = function () {
          state.draft = c.label;
          state.hint = c.hint;
          render();
          var ta = root.querySelector('textarea');
          if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        };
        pills.appendChild(b);
      });
      box.appendChild(pills);
    }

    return box;
  }

  function renderBody(body) {
    // 아직 아무 말도 오가지 않았으면 내용을 아래로 내린다(위 .fill 주석 참고)
    if (!state.items.length && !state.sending) body.appendChild(el('div', 'fill'));

    // 첫 인사말은 항상 맨 위 — 봇이 먼저 건넨 말이다 (AI 배지 없음)
    var greeting = state.cfg && state.cfg.greeting;
    if (greeting) body.appendChild(ourRow('greeting', greeting, null, false));

    // 바로 위 줄의 발신자. 같으면 아바타·이름을 생략해 한 덩어리로 읽히게 한다.
    // 인사말과 AI 답변은 이름이 같아도 잇지 않는다 — AI 배지 유무가 달라서
    // 이으면 첫 답변에 배지가 사라진다. ('greeting' 은 타임라인 kind 에 없는 값이라
    //  그 자체로 "절대 안 이어짐" 이 된다.)
    var prev = greeting ? 'greeting' : null;

    if (!hasUserMsg() && !state.sending) {
      var starts = starterBlock();
      if (starts) {
        body.appendChild(starts);
        state.startersSeen = true;   // 붙은 뒤에 세운다 — 안 그리고도 태우면 안 된다
        prev = null;                 // 시작 줄이 끼어들었으니 다음 말풍선은 새 그룹
      }
    }

    var slotDone = false;

    state.items.forEach(function (it) {
      if (it.kind === 'user') {
        body.appendChild(myRow(it.body));
      } else if (it.kind === 'system') {
        body.appendChild(systemCard(it.body, it.id, it.confirmation));
      } else if (it.kind === 'notice') {
        body.appendChild(el('div', 'ok', it.body));
        prev = null;
        return;
      } else {
        body.appendChild(ourRow(it.kind, it.body, it.at, prev === it.kind));
        // AI 가 모른다고 물러난 답(대기 문구)이 마지막이면 그 밑에 「상담원 연결」 — 리터럴은 holding.ts HOLDING_MESSAGE
        if (it.kind === 'ai' && it.body.indexOf('담당자가 확인하고 있어요') >= 0 && it === state.items[state.items.length - 1] && !state.handoff && !state.sending && !state.escalated) {
          body.appendChild(handoffHint());
        }
      }
      prev = it.kind;

      // 첫 답변(AI 또는 운영자) 바로 뒤에 연락처 슬롯
      if (!slotDone && (it.kind === 'ai' || it.kind === 'operator')) {
        slotDone = true;
        var slot = contactSlot();
        if (slot) {
          body.appendChild(slot);
          prev = null;  // 폼이 끼어들면 다음 말풍선은 새 그룹이다
        }
      }
    });

    if (state.sending) body.appendChild(typingRow(false));
    if (state.notice) body.appendChild(el('div', 'notice', state.notice));
    if (state.handoff) body.appendChild(handoffForm());
  }

  function render() {
    wrap.textContent = '';
    wrap.className = 'wrap' + (state.open ? ' open' : '');

    if (state.open) {
      var panel = el('div', 'panel');

      var hd = el('div', 'hd');
      hd.appendChild(avatar(true));
      var t = el('div', 't');
      t.appendChild(el('h3', null, displayName()));
      t.appendChild(el('p', null, (state.cfg && state.cfg.statusText) || ''));
      hd.appendChild(t);
      var x = el('button', 'x');
      x.setAttribute('aria-label', '닫기');
      x.appendChild(icon(ICON_X));
      x.onclick = toggle;
      hd.appendChild(x);
      panel.appendChild(hd);

      var body = el('div', 'body');
      renderBody(body);
      panel.appendChild(body);

      var ft = el('div', 'ft');
      if (state.cfg && !state.handoff) ft.appendChild(toolsRow());
      var inp = el('div', 'inp');
      var ta = el('textarea');
      ta.placeholder = '무엇이든 편하게 남겨주세요';
      ta.rows = 1;
      ta.value = state.draft;
      ta.oninput = function () {
        state.draft = ta.value;
        // 칩 문장을 통째로 지우면 힌트도 버린다 — 딴 얘기일 수 있다
        if (!ta.value.trim()) state.hint = null;
      };
      ta.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      };
      // 이름이 send 면 render() 전체에서 모듈 함수 send() 를 가린다(var 호이스팅).
      var sendBtn = el('button', 'send', '보내기');
      sendBtn.disabled = state.sending;
      sendBtn.onclick = submit;
      inp.appendChild(ta);
      inp.appendChild(sendBtn);
      ft.appendChild(inp);
      if (state.error) ft.appendChild(el('div', 'err', state.error));
      var credit = el('div', 'credit');
      credit.appendChild(el('span', 'pw', 'Powered by Feedloop'));
      ft.appendChild(credit);
      panel.appendChild(ft);
      wrap.appendChild(panel);

      // 첫 화면에서는 맨 위(인사말)를 보여준다 — 맨 아래로 붙이면 인사말이 화면 밖으로
      // 밀려 올라간다. 단 «내용이 넘칠 때는» 아래를 보여준다. 인사말이 길면(상한 300자)
      // 시작 질문 줄이 통째로 스크롤 밖에 있게 되는데, 그러면 물어봐도 된다는 걸
      // 알릴 방법이 없다. 못 읽은 인사말은 위로 밀어 올려 읽을 수 있다.
      var first = !state.items.length && !state.sending && !state.handoff;
      var place = function () {
        var overflows = body.scrollHeight > body.clientHeight;
        body.scrollTop = first && !overflows ? 0 : body.scrollHeight;
      };
      place();
      requestAnimationFrame(place);
    }

    // 설정 전에는 안 그린다 — 그리면 폴백 코랄이 떴다가 운영자 색으로 갈아탄다
    // (실측 느린 4G 160ms). 부트 open 은 false 라 패널도 없고, config 가 실패해도
    // poll 이 serviceName 으로 cfg 를 만들어 그때 그린다.
    if (!state.cfg) return;

    var fab = el('button', 'fab');
    fab.setAttribute('aria-label', state.open ? '의견창 닫기' : '의견 보내기');
    if (state.open) {
      fab.appendChild(icon(ICON_X));
    } else if (state.cfg && state.cfg.profileImageUrl) {
      var img = el('img');
      img.src = state.cfg.profileImageUrl;
      img.alt = displayName();
      fab.appendChild(img);
    } else if (state.cfg) {
      fab.appendChild(el('span', 'ini', displayName().charAt(0).toUpperCase()));
    } else {
      fab.appendChild(icon(ICON_CHAT));
    }
    if (!state.open && state.unread > 0) fab.appendChild(el('span', 'badge', String(state.unread)));
    fab.onclick = toggle;
    wrap.appendChild(fab);
  }

  // ── 네트워크 ──────────────────────────────────────

  function takeContact(c) {
    if (!c) return;
    state.contact = { name: c.name || null, email: c.email || null, phone: c.phone || null };
  }

  function absorb(items) {
    if (!items || !items.length) return 0;
    var added = 0;
    items.forEach(function (it) {
      if (state.seen[it.id]) return;
      state.seen[it.id] = true;
      state.items.push(it);
      if (!state.cursor || it.at > state.cursor) state.cursor = it.at;
      if (it.kind !== 'user' && (!state.lastSeen || it.at > state.lastSeen)) added++;
    });
    state.items.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    return added;
  }

  function loadConfig() {
    return fetch(apiBase + '/config')
      .then(function (r) {
        if (r.status === 404) { host.remove(); return null; }  // 없는 봇 — 아예 안 그린다
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (cfg) { state.cfg = cfg; applyColors(); render(); }
      })
      .catch(function () { /* 다음 폴링이 serviceName 폴백을 준다 */ });
  }

  function poll() {
    var url = apiBase + '/messages?visitorId=' + encodeURIComponent(visitorId);
    if (state.cursor) url += '&after=' + encodeURIComponent(state.cursor);

    fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var cfgArrived = false;
        if (!state.cfg && data.serviceName) {
          state.cfg = { displayName: data.serviceName, chips: [] };
          cfgArrived = true;
        }
        if (data.contact) takeContact(data.contact);
        var added = absorb(data.items);
        // 늦은 답이 도착하면 「확인하고 바로 답 드릴게요」 안내는 할 일을 다했다 — 지운다.
        // 안 지우면 답 말풍선 «밑에» 안내가 계속 남는다(안내는 항목 뒤에 그려진다).
        if (added > 0) state.notice = null;
        var esc = !!data.escalated;
        var escChanged = esc !== state.escalated;
        state.escalated = esc;
        if (state.open) markSeen();
        else if (added > 0) state.unread += added;
        if (added > 0 || escChanged || cfgArrived) render();
      })
      .catch(function () { /* 폴링 실패는 조용히 넘긴다 — 다음 주기에 다시 시도한다 */ });
  }

  // 데모 알림 — iframe 안일 때만, 우리 오리진에만 제보 id 를 건넨다.
  // '*' 로 뿌리면 고객 사이트를 iframe 에 넣은 아무나 방문자 제보 id 를 줍는다.
  // 데모 알림 — iframe 안일 때만, 우리 오리진에만 보낸다.
  // '*' 로 뿌리면 고객 사이트를 iframe 에 넣은 아무나 방문자 제보 id 를 줍는다.
  // 보내는 것: 제보 접수(feedback) · 창 열림(opened).
  function notifyParent(msg) {
    if (window.parent === window) return;
    try {
      msg.source = 'feedloop-widget';
      msg.botId = botId;
      window.parent.postMessage(msg, ORIGIN);
    } catch (e) { /* 오리진이 다르면 브라우저가 버린다 */ }
  }

  /** 입력창에 쓴 걸 보낸다. 시작 질문 칩은 send() 를 직접 부른다. */
  function submit() {
    var text = (state.draft || '').trim();
    if (!text || state.sending) return;
    var hint = state.hint;
    var target = state.target;
    var sh = state.shot, wait = state.shotP;
    state.draft = '';
    state.hint = null;
    // 촬영 중이면 최대 5초만 기다린다 — 촬영이 보내기를 막으면 안 된다. 안 끝나면 위치만 간다.
    // 기다리는 동안 칩(「촬영 중…」)과 말풍선을 남겨 둔다 — 비우면 방문자는 글이 사라졌다고 읽는다
    if (target && sh === 1) {
      state.sending = true;
      state.items.push({ id: 'tmp-w', kind: 'user', body: text, at: new Date().toISOString() });
      render();
      return Promise.race([wait, new Promise(function (ok) { setTimeout(ok, 5000); })]).then(function (r) {
        state.sending = false;
        state.items = state.items.filter(function (it) { return it.id !== 'tmp-w'; });
        state.target = null;
        state.shot = null;
        shotSeq++;
        if (r && r.id) target.shot = r.id;
        send(text, hint, target, r);
      });
    }
    state.target = null;
    state.shot = null;
    shotSeq++;
    if (target && sh && sh.id) target.shot = sh.id;
    send(text, hint, target, sh);
  }

  /**
   * 한 마디 보내기. 입력창 경로와 시작 질문 칩이 같은 길을 탄다.
   * 실패하면 보내려던 문장을 입력창에 돌려준다 — 칩으로 보낸 것도 그렇게 하면
   * 방문자가 고쳐 쓰거나 다시 누를 수 있다.
   */
  function send(raw, hint, target, sh) {
    var text = (raw || '').trim();
    if (!text || state.sending) return;

    // 실패하면 문장과 «힌트를 같이» 되돌린다. 힌트만 빠지면 방문자가 [보내기] 를
    // 다시 눌렀을 때 분류 힌트 없이 나가, 골라둔 카테고리가 조용히 사라진다.
    var restore = function () {
      if (!state.draft) {
        // 쓰던 글이 있으면 덮지 않는다 — 시작 질문 칩은 입력창을 안 거치므로
        // 방문자가 따로 쓰던 문장을 이 복구가 지울 수 있다.
        state.draft = text;
        state.hint = hint || null;
        if (target && !state.target) { state.target = target; state.shot = sh && sh.id ? sh : null; }
      }
    };

    var payload = { visitorId: visitorId, text: text, context: collectContext() };
    if (hint) payload.hint = hint;
    if (target) payload.context.target = target;

    state.sending = true;
    state.error = null;
    state.notice = null;
    state.handoff = false;
    // 서버가 저장한 항목이 오기 전까지 유저 말풍선은 임시로 보여준다 (대기 상태)
    var tmpId = 'tmp-' + Date.now();
    state.items.push({ id: tmpId, kind: 'user', body: text, at: new Date().toISOString() });
    render();

    fetch(apiBase + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        state.sending = false;
        state.items = state.items.filter(function (it) { return it.id !== tmpId; });
        if (!res.ok) {
          restore();
          state.error = res.data && res.data.error ? res.data.error : '전송에 실패했어요';
          render();
          return;
        }
        state.notice = res.data.notice || null;
        if (res.data.contact) takeContact(res.data.contact);
        absorb(res.data.items);
        if (res.data.messageId) notifyParent({ type: 'feedback', messageId: res.data.messageId, visitorId: visitorId });
        markSeen();
        render();
      })
      .catch(function () {
        state.sending = false;
        state.items = state.items.filter(function (it) { return it.id !== tmpId; });
        restore();
        state.error = '네트워크 오류로 보내지 못했어요';
        render();
      });
  }

  /**
   * 입력창 위 도구 줄. 왼쪽 칩 = 선택 → 첨부(같은 자리), 오른쪽 칩 = 상담원 연결 → 전달됨 상태(같은 자리).
   * 첨부 칩 전체가 「다시 고르기」, 그 안의 × 만 「빼기」.
   */
  function toolsRow() {
    var row = el('div', 'tools');
    if (state.target) {
      var att = el('div', 'tool att');
      att.setAttribute('role', 'button');
      att.tabIndex = 0;
      att.title = '다시 고르려면 누르세요';
      var sh = state.shot;
      if (sh && sh.thumb) {
        var th = el('img', 'th');
        th.src = sh.thumb;
        th.alt = '';
        att.appendChild(th);
      } else att.appendChild(icon(ICON_PICK));
      att.appendChild(el('span', 'lbl', sh === -1 ? '화면은 담지 못했어요 · 위치는 함께 보내요' : targetLabel(state.target) + (sh === 1 ? ' · 촬영 중…' : '')));
      var rm = el('button', 'rm');
      rm.setAttribute('aria-label', '선택한 요소 빼기');
      rm.appendChild(icon(ICON_X));
      rm.onclick = function (e) { e.stopPropagation(); if (state.sending) return; dropShot(); state.target = null; render(); };
      rm.disabled = state.sending;   // 촬영을 기다리며 보내는 중엔 빼기·다시 고르기를 막는다 — 뺀 화면이 그대로 붙어 나갔다
      att.appendChild(rm);
      att.onclick = startPick;
      att.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startPick(); } };
      row.appendChild(att);
    } else {
      var pk = el('button', 'tool');
      pk.appendChild(icon(ICON_PICK));
      pk.appendChild(el('span', null, state.picking ? '선택하는 중…' : '화면에서 선택하기'));
      pk.disabled = state.picking;
      pk.onclick = startPick;
      row.appendChild(pk);
    }
    if (state.escalated) {
      var st = el('div', 'tool st');
      st.setAttribute('aria-live', 'polite');
      st.appendChild(el('i'));
      var sb = el('span');
      // 기대치(「보통 몇 분 안에 답해요」)는 안 붙인다 — 헤더 부제와 타임라인 안내 칩에 이미 있고,
      // 같은 줄의 「화면에서 선택하기」에 밀려 「보통 몇 …」로 잘렸다(2026-09-16).
      sb.appendChild(el('b', null, '상담원에게 전달됐어요'));
      st.appendChild(sb);
      row.appendChild(st);
    } else {
      var hb = el('button', 'tool');
      hb.appendChild(icon(ICON_PERSON));
      hb.appendChild(el('span', null, state.asking ? '전달 중…' : '상담원 연결'));
      hb.disabled = state.asking;
      hb.onclick = askHuman;
      row.appendChild(hb);
    }
    return row;
  }

  /** 「「쿠폰 받기」 버튼」·「「오늘의 PICK」 구역 · 1120×973」 — lib/widget/pick.ts targetLabel 과 같다(테스트 대조) */
  function targetLabel(t) {
    var cut = function (s) { var c = Array.from(s); return '「' + (c.length > 24 ? c.slice(0, 24).join('') + '…' : s) + '」 '; };
    var h = (t.heading || '').trim(), r = t.rect;
    if (h) return cut(h) + '구역' + (r && r.w > 0 && r.h > 0 ? ' · ' + r.w + '×' + r.h : '');
    var name = (t.text || t.label || '').trim();
    var kind = t.kind || '영역';
    return name ? cut(name) + kind : kind;
  }

  // 선택기·촬영기는 별도 파일 — 누르는 방문자만 받는다(widget.js 상한 보호).
  var jsLoad = {};
  function loadJs(name, g) {
    if (window[g]) return Promise.resolve();
    return jsLoad[name] || (jsLoad[name] = new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = ORIGIN + '/' + name;
      s.async = true;
      s.onload = ok;
      s.onerror = function () { jsLoad[name] = null; fail(); };
      document.head.appendChild(s);
    }));
  }

  // 짚은 순간 뷰포트를 찍어 올린다(I-55). 다시 고르거나 빼면 shotSeq 가 올라 늦게 끝난 촬영은 버린다
  var shotSeq = 0;
  function dropShot() {
    if (state.shot && state.shot.thumb) URL.revokeObjectURL(state.shot.thumb);
    state.shot = null;
    shotSeq++;
  }
  function takeShot() {
    dropShot();
    var seq = shotSeq;
    state.shot = 1;
    state.shotP = loadJs('widget-shot.js', '__feedloopShot')
      .then(function () { return window.__feedloopShot({ ignore: host, api: apiBase, visitorId: visitorId }); })
      .catch(function () { return null; })
      .then(function (r) {
        if (seq === shotSeq) { state.shot = r || -1; render(); }
        else if (r && r.thumb && !state.sending) URL.revokeObjectURL(r.thumb);
        return r;
      });
  }

  /** 패널을 숨기고(그 뒤를 짚어야 한다) 고른 요소를 첨부로 둔다 */
  function startPick() {
    if (state.picking || state.sending) return;
    state.picking = true;
    state.error = null;
    render();
    loadJs('widget-shot.js', '__feedloopShot').catch(function () {});   // 고르는 동안 미리 받는다
    loadJs('widget-pick.js', '__feedloopPick')
      .then(function () {
        wrap.style.display = 'none';
        return window.__feedloopPick({ ignore: host, accent: hex(state.cfg && state.cfg.accentColor) });
      })
      .then(function (t) {
        if (t && t.error) state.error = '요소 정보를 읽지 못했어요. 다른 곳을 짚어 주세요';
        else if (t) { state.target = t; takeShot(); }
      }, function () { state.error = '선택 도구를 불러오지 못했어요'; })
      .then(function () {
        wrap.style.display = '';
        state.picking = false;
        if (state.target && !state.open) toggle();   // 로딩 중 창을 닫았어도 첨부 칩은 보여야 한다
        render();
        var ta = root.querySelector('textarea');
        if (ta) ta.focus();
      });
  }

  function postContact(name, email, phone) {
    state.error = null;
    fetch(apiBase + '/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, name: name, email: email, phone: phone }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          state.error = res.data && res.data.error ? res.data.error : '저장하지 못했어요';
        } else {
          takeContact(res.data.contact);
        }
        render();
      })
      .catch(function () {
        state.error = '네트워크 오류로 저장하지 못했어요';
        render();
      });
  }

  function askHuman() {
    if (state.asking) return;
    state.handoff = true;
    state.error = null;
    if (!state.hf.text) state.hf.text = lastMine();   // 처음 열 때만 미리 채운다(쓰던 글은 안 덮는다)
    render();
    var ta = root.querySelector('.cform textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  /** 상담원에게 보내기. text 가 비어도(이미 말한 게 있으면) 대화 자체를 넘긴다. */
  function postEscalate(text, name, email) {
    if (state.asking) return;
    state.error = null;
    state.asking = true;
    render();
    var payload = { visitorId: visitorId };
    if (text) { payload.text = text; payload.context = collectContext(); }
    if (name) payload.name = name;
    if (email) payload.email = email;
    fetch(apiBase + '/escalate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        state.asking = false;
        if (!res.ok) {
          // 폼은 남긴다 — 고쳐 쓰거나 취소할 수 있게
          state.error = res.data && res.data.error ? res.data.error : '전달하지 못했어요';
        } else {
          state.handoff = false;
          state.hf = { text: '', name: '', mail: '' };
          state.escalated = true;
          if (res.data.contact) takeContact(res.data.contact);
          absorb(res.data.items);
          markSeen();
        }
        render();
      })
      .catch(function () {
        state.asking = false;
        state.error = '네트워크 오류로 전달하지 못했어요';
        render();
      });
  }

  /**
   * 「해결됐나」 응답을 보낸다. 서버가 확정한 값을 그 항목에 새긴다 —
   * 다음 폴링(5초) 전까지 버튼이 되살아나면 방금 답한 사람이 같은 질문을 다시 본다.
   */
  function sendConfirm(id, value) {
    if (state.confirming) return;   // 연타·두 카드 동시 클릭 잠금
    state.confirming = id;
    state.error = null;
    render();
    // 멈춘 요청은 «거부»되지 않아 catch 가 안 돈다 → 잠금이 안 풀려 확인 버튼이 전부 죽는다.
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    var unlock = function () { clearTimeout(timer); state.confirming = null; };
    fetch(apiBase + '/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, responseId: id, confirmation: value }),
      signal: ctl ? ctl.signal : undefined,
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        unlock();
        if (!res.ok) state.error = (res.data && res.data.error) || '보내지 못했어요';
        else markConfirmed(id, res.data.confirmation);
        render();
      })
      .catch(function () {
        unlock();
        state.error = '네트워크가 느려 보내지 못했어요. 다시 눌러주세요';
        render();
      });
  }

  function markConfirmed(id, value) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { state.items[i].confirmation = value; break; }
    }
  }

  // ── 폴링 주기 ─────────────────────────────────────

  var timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, state.open ? POLL_OPEN_MS : POLL_CLOSED_MS);
  }

  function markSeen() {
    if (!state.cursor) return;
    state.lastSeen = state.cursor;
    lsSet(SEEN_KEY, state.cursor);
  }

  function toggle() {
    state.open = !state.open;
    if (state.open) {
      state.unread = 0;
      markSeen();
      poll();
      notifyParent({ type: 'opened' });
    } else {
      markSeen();
    }
    schedule();
    render();
  }

  // 랜딩 데모 팝업이 안내 말풍선을 대신 눌러 준다.
  // ⚠️ **우리 오리진에서 온 것만** 받는다 — 이 위젯은 남의 사이트에서도 돈다. 아무나 그 사이트를
  //    iframe 에 넣고 방문자 화면의 창을 열게 두면 안 된다. 오리진은 브라우저가 붙여 위조 못 한다.
  if (window.parent !== window) {
    window.addEventListener('message', function (e) {
      if (e.origin !== ORIGIN) return;
      var d = e.data;
      if (!d || d.source !== 'feedloop-demo' || d.type !== 'open') return;
      if (!state.open) toggle();
    });
  }

  // 탭이 백그라운드면 폴링을 멈춘다 — 배터리·요청 수를 아낀다.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer) clearInterval(timer);
      timer = null;
    } else {
      poll();
      schedule();
    }
  });

  render();
  loadConfig();
  poll();
  schedule();
})();
