(function (root) {
  'use strict';

  /* ==========================================================
     44 · 语音通话（模拟）· 依 reuse-hub「模拟语音通话 / 通话小窗」口径
     ----------------------------------------------------------
     工单第10单 7 条：呼出四结局 / 接通计时+中途挂断 / 记录+本月统计 /
                     TA 来电 / 小窗悬浮球可拖 / 设置 8 项 / 单一会话门

     与来源（客单29 的 42_call.js）的口径对齐：
       · 四结局等待时长 忙线1.4s / 拒接2.4s / 接通2.2s / 无人接听7s；
       · 结局判定顺序固定「忙线 → 拒接 → 接通」，三概率和不足 100 的部分算无人接听，
         这样把某个概率钉成 100 就能确定复现（判据的前提）；
       · 接通后 10 秒保护期内绝不判中途挂断，之后每 callHgSec 秒掷一次（每次 6%）；
       · TA 来电 30 秒未接 = 漏接；单日上限 3 次（设置表里没有这一项，用固定值防刷）；
       · 通话中小窗显隐按「有通话 且 不在全屏通话屏」判，不只看「用户收起过」。

     44 的宿主与 29 不同（没有 hash 路由、只有一套 viewStack），所以：
       · 显隐收口在 syncLayer()，由 app.js 在每次切页/收起后调用一次；
       · 计时不另起 setInterval —— 复用 chat.js 那唯一一处 1 秒心跳（host.tick）。

     ⚠️ 全程不申请麦克风、不建 WebRTC、不拨号、不采集音频：静音只是演示状态。
     ========================================================== */

  /* 结局标记与文案 */
  const CALL_ST = ['connected', 'busy', 'rejected', 'missed'];
  const CALL_ST_TXT = { connected: '已接通', busy: '对方忙线', rejected: '已拒接', missed: '无人接听' };
  /* 四种结局的等待时长（工单第1条） */
  const CALL_WAIT = { busy: 1400, rejected: 2400, connected: 2200, missed: 7000 };
  const CALL_GUARD_SEC = 10;     /* 接通后的保护期：这段时间内绝不判中途挂断 */
  const CALL_HANG_P = 6;         /* 每个检查点掷一次的概率（%），不是整场一次 */
  const CALL_IN_RING_SEC = 30;   /* TA 来电 30 秒未接 = 漏接 */
  const CALL_IN_CAP = 3;         /* TA 主动来电单日上限 */
  const CALL_MINI_PAD = 10;      /* 小窗离 #app 四边的留白 */
  const CALL_MINI_DRAG_SLOP = 3; /* 位移超过它才算拖动（否则算轻点展开） */
  const CALL_MINI_CLICK_GUARD = 400; /* 拖动后浏览器补发的 click，这段时间内忽略 */

  const CALL_BUSY_LINES = ['我这边还有一点事，晚点打给你', '在忙，等我一下下', '手上有点事，马上就好了'];
  const CALL_MISS_LINES = ['刚刚没看到手机…', '抱歉，那会儿不在旁边', '错过了，现在方便吗'];
  const CALL_BACK_LINES = ['在忙吗？', '方便的时候回我一下', '怎么没接呀'];
  const CALL_OPEN_LINES = ['喂，是我', '刚好在想你', '嗯，我在'];

  const pad2 = n => String(n).padStart(2, '0');
  const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));

  /* ---------------- 纯状态机（可单测，不碰 DOM） ----------------
     保留 44 原有的 initial / transition / duration 三个入口与 idle→ringing→connected→ended
     的对外语义；新增 phase 用来区分「我打出去」与「TA 打进来」两种响铃。
     对外 status 由 phase 推导并**显式落库**，避免调用方两套字段各说各话。 */
  const STATUS_OF = { idle: 'idle', calling: 'ringing', incoming: 'ringing', active: 'connected', ended: 'ended' };

  function initial() {
    return { phase: 'idle', status: 'idle', dir: 'out', cid: 'ta', startedAt: null, endedAt: null, muted: false };
  }
  function transition(state, event, now = Date.now()) {
    const s = state || initial();
    if (event === 'start' && ['idle', 'ended'].includes(s.phase)) {
      return { ...initial(), phase: 'calling', status: STATUS_OF.calling };
    }
    if (event === 'ring' && ['idle', 'ended'].includes(s.phase)) {
      return { ...initial(), phase: 'incoming', status: STATUS_OF.incoming, dir: 'in' };
    }
    if (event === 'accept' && ['calling', 'incoming'].includes(s.phase)) {
      return { ...s, phase: 'active', status: STATUS_OF.active, startedAt: now, muted: false };
    }
    if (event === 'mute' && s.phase === 'active') return { ...s, muted: !s.muted };
    if (event === 'end' && ['calling', 'incoming', 'active'].includes(s.phase)) {
      return { ...s, phase: 'ended', status: STATUS_OF.ended, endedAt: now };
    }
    return s;
  }
  /* 计时只认「接通时刻」：响铃期间不计时（工单第2条），且用绝对时间差算，
     定时器被节流也不会走慢（后台标签页会把 setInterval 压到分钟级）。 */
  function duration(state, now = Date.now()) {
    if (!state || state.startedAt === null || state.startedAt === undefined) return 0;
    const end = state.endedAt === null || state.endedAt === undefined ? now : state.endedAt;
    return Math.max(0, Math.floor((end - state.startedAt) / 1000));
  }
  function formatDur(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(n / 60) + ':' + pad2(n % 60);
  }
  /* 本月键：**不补零**（'2026-11'），与 29 的 dayKey 口径一致。
     ⚠️ 29 的老坑是拿 pad2(月) 去 indexOf，1~9 月永远匹配不上、本月恒为 0；
     这里两边都走同一个 monthKey，补不补零都不可能对不上。 */
  function monthKey(ts) {
    const d = new Date(Number(ts) || 0);
    return d.getFullYear() + '-' + (d.getMonth() + 1);
  }
  /* 呼出结局：顺序固定不随机化（判据要能把某个概率钉成 100 来复现） */
  function rollOutcome(settings, rand) {
    const st = settings || {};
    const busy = clampNum(Number(st.callBusyP) || 0, 0, 100);
    const rej = clampNum(Number(st.callRejectP) || 0, 0, 100);
    const ans = clampNum(Number(st.callAnswerP) || 0, 0, 100);
    const r = (typeof rand === 'function' ? rand : Math.random)() * 100;
    if (r < busy) return 'busy';
    if (r < busy + rej) return 'rejected';
    if (r < busy + rej + ans) return 'connected';
    return 'missed';
  }
  /* 本月统计：次数 / 接听 / 未接 / 接听总时长（秒） */
  function statsOf(calls, now) {
    const ym = monthKey(now === undefined ? Date.now() : now);
    const out = { n: 0, ok: 0, miss: 0, sec: 0 };
    (Array.isArray(calls) ? calls : []).forEach(c => {
      if (!c || c.deleted) return;
      if (monthKey(c.ts) !== ym) return;
      out.n += 1;
      if (c.st === 'connected') { out.ok += 1; out.sec += Math.max(0, Number(c.sec) || 0); }
      else if (c.st === 'missed') out.miss += 1;
    });
    return out;
  }

  /* ---------------- 控制器 ---------------- */
  function init(host) {
    const doc = root.document;
    const $ = sel => doc.querySelector(sel);
    const view = $('#call-view');
    const mini = $('#call-mini');
    if (!view) return { open() {}, close() {}, getState: () => initial(), tick() {}, destroy() {} };

    /* 判据用的确定性把手：默认全关，改它不改变产品行为。 */
    const probe = { rand: null, forceOutcome: null, waitScale: 1, hang: null };

    let state = initial();
    let timers = [];             /* 本模块自己的 timeout（不是心跳） */
    let returnFocus = null;
    let previousInert = [];
    let inertOn = false;
    let drag = null;             /* 拖动中的临时量 */
    let lastDragAt = 0;
    let lastTapAt = 0;           /* 拖完补发的那次 click 要挡掉，别顺势展开 */
    let nextIncomingAt = 0;      /* TA 主动来电的下一个检查点（由心跳推进） */

    const st = () => host.getState();
    const rand = () => (typeof probe.rand === 'function' ? probe.rand() : Math.random());
    const after = (fn, ms) => {
      const delay = Math.round(ms * (typeof probe.waitScale === 'number' ? probe.waitScale : 1));
      const id = root.setTimeout(() => {
        timers = timers.filter(t => t.id !== id);
        fn();
      }, Math.max(0, delay));
      timers.push({ id });
      return id;
    };
    function clearTimers() { timers.forEach(t => root.clearTimeout(t.id)); timers.length = 0; }

    function persist(next) {
      if (!next) return;
      const live = state.phase === 'idle' || state.phase === 'ended' ? null : {
        cid: state.cid, dir: state.dir, phase: state.phase,
        startTs: state.startTs || Date.now(), connectTs: state.startedAt || 0,
        mini: !!state.mini
      };
      host.persist(Object.assign({}, next, { callLive: live }));
    }
    function saveState() { persist(st()); }

    /* ---------------- 记录 / 聊天卡 ---------------- */
    function callSec() {
      const c = state;
      if (c.phase === 'active' && c.startedAt) return duration(c);
      return Math.max(0, Math.floor(((c.endedAt || Date.now()) - (c.startTs || Date.now())) / 1000));
    }
    function addLog(dir, endSt, sec) {
      const s = st();
      const list = (s.calls || []).slice();
      list.unshift({ id: host.newId('cl'), cid: s.peerId || 'ta', dir: dir === 'in' ? 'in' : 'out', st: endSt, ts: Date.now(), sec: Math.max(0, Math.round(sec || 0)) });
      return list.slice(0, 200);
    }
    function pushCard(dir, endSt, sec) {
      const s = st();
      const next = root.ChatModel.appendCallCard(s, {
        id: host.newId('m'), from: dir === 'in' ? 'peer' : 'self',
        st: endSt, sec: Math.max(0, Math.round(sec || 0)), date: new Date().toISOString()
      });
      if (next) host.persist(next);
      if (host.renderChat) host.renderChat(true);
    }
    /* TA 补一句话：忙线/漏接要让 TA 解释一句（方向不同，语气也得反） */
    function taLine(text, delay) {
      if (host.peerLine) host.peerLine(text, delay);
    }

    /* ---------------- 结束一通 ---------------- */
    function finish(endSt, opts) {
      const o = opts || {};
      const dir = state.dir;
      const sec = state.phase === 'active' && state.startedAt ? duration(state) : 0;
      /* 在小窗里挂断时人还停在聊天页：这时再弹整屏「通话已结束」会打断聊天，
         所以直接收掉（dismissed），不再抢一次整屏。只有在通话屏上挂断才留结束态。 */
      const fromMini = view.hidden;
      const s = st();
      const next = Object.assign({}, s, { calls: addLog(dir, endSt, sec) });
      host.persist(next);
      state = transition(Object.assign({}, state, { endedAt: Date.now() }), 'end');
      /* ended 态的显示时长要落在这一次上 */
      state.endedSec = sec;
      if (fromMini) state.dismissed = true;
      saveState();
      setInert(false);
      view.hidden = true;
      syncMini();
      pushCard(dir, endSt, sec);

      if (endSt === 'busy') taLine(pick(CALL_BUSY_LINES), 900);
      else if (endSt === 'missed' && dir === 'out') taLine(pick(CALL_MISS_LINES), 2600);
      else if (endSt === 'missed' && dir === 'in') taLine(pick(CALL_BACK_LINES), 1400);

      if (endSt === 'busy') host.toast('对方正在忙');
      else if (endSt === 'rejected') host.toast(dir === 'in' ? '已拒接' : 'TA 拒接了');
      else if (endSt === 'missed') host.toast(dir === 'in' ? '未接来电' : '无人接听');
      else host.toast('通话结束 · ' + formatDur(sec));
      if (host.renderCallsPage) host.renderCallsPage();
      if (o.byTa) state.byTa = true;
      paint();
    }
    function pick(list) { const arr = list || []; return arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))] || arr[0]; }

    /* ---------------- 呼出 / 来电 / 接听 / 挂断 ---------------- */
    function dial() {
      const s = st();
      if (!s.settings.callOn) { host.toast('模拟通话是关着的，去设置里打开'); return false; }
      /* 单一会话门（工单第7条）：换人也不行，正在通话时再拨要拦住并提示 */
      if (state.phase === 'calling' || state.phase === 'active' || state.phase === 'incoming') {
        host.toast('正在通话中，先结束这一通');
        return false;
      }
      clearTimers();
      state = transition(initial(), 'start');
      state.cid = s.peerId || 'ta';
      state.dir = 'out';
      state.startTs = Date.now();
      state.endedSec = 0;
      state.dismissed = false;
      showView();
      paint();
      saveState();

      const outcome = probe.forceOutcome || rollOutcome(s.settings, rand);
      after(() => {
        if (state.phase !== 'calling') return;   /* 已挂断/重开，丢弃这次回调 */
        if (outcome === 'connected') connect();
        else finish(outcome);
      }, CALL_WAIT[outcome] || 2000);
      return true;
    }
    function connect() {
      const now = Date.now();
      state = transition(state, 'accept', now);
      state.startTs = state.startTs || now;
      state.hgNext = CALL_GUARD_SEC + hangSec();
      paint();
      saveState();
    }
    function incoming() {
      const s = st();
      if (!s.settings.callOn || !s.settings.callInOn) return false;
      if (['calling', 'active', 'incoming'].includes(state.phase)) return false;
      clearTimers();
      state = transition(initial(), 'ring');
      state.cid = s.peerId || 'ta';
      state.dir = 'in';
      state.startTs = Date.now();
      state.endedSec = 0;
      state.dismissed = false;
      showView();
      paint();
      saveState();
      host.toast(s.peerName + ' 打来电话');
      after(() => {
        if (state.phase === 'incoming') finish('missed');   /* 30 秒没接 = 漏接 */
      }, CALL_IN_RING_SEC * 1000);
      return true;
    }
    function accept() {
      if (state.phase !== 'incoming' && state.phase !== 'calling') { paint(); return; }
      clearTimers();
      connect();
      if (state.dir === 'in') taLine(pick(CALL_OPEN_LINES), 700);
    }    function hangup() {
      if (state.phase === 'active') finish('connected');
      else if (state.phase === 'incoming') finish('rejected');
      else if (state.phase === 'calling') finish('missed');
    }
    function reject() { if (state.phase === 'incoming') finish('rejected'); }

    /* ---------------- 小窗 ----------------
       显隐口径（工单坑②）：「有通话」且「全屏通话屏不该占着」。
       后者有两个来源：用户自己点了收起（state.mini），或者用户切去了别的功能页 ——
       44 的通话屏是盖在 .app 上的浮层，切页时它还留在最上面就是「点了没反应」，
       所以切页一律让出、收成小窗；回到聊天再按 state.mini 决定要不要铺开。
       收口在 syncLayer()：app.js 每次切页/回聊天都调一次，不靠「用户点过收起」。 */
    function isLive() { return ['calling', 'incoming', 'active'].includes(state.phase); }
    function syncLayer(opts) {
      const o = opts || {};
      const chatVisible = o.chatVisible !== false;
      if (!mini) return;
      /* 结束态单独处理：44 原本就是「挂断后停在通话屏，给一颗回到聊天」，
         这条界面不要因为我加了小窗逻辑就丢掉 —— 挂断瞬间整屏消失是很突兀的。 */
      if (state.phase === 'ended') {
        view.hidden = !!state.dismissed;
        view.dataset.phase = 'ended';
        mini.hidden = true;
        setInert(!state.dismissed);
        return;
      }
      if (!isLive()) {
        view.hidden = true;
        mini.hidden = true;
        setInert(false);
        return;
      }
      if (chatVisible && !state.mini) {
        view.hidden = false;
        view.dataset.phase = state.phase;
        mini.hidden = true;
        setInert(true);
        return;
      }
      /* 让位：切去功能页就收成小窗；「回到聊天 + 用户之前收起过」也保持小窗 */
      view.hidden = true;
      setInert(false);
      mini.hidden = false;
      applyMiniPos();
      paintMini();
    }
    function syncMini() { syncLayer({ chatVisible: host.isChatVisible ? host.isChatVisible() : true }); }
    function applyMiniPos() {
      if (!mini) return;
      const p = st().callMiniPos;
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && p.x >= 0 && p.y >= 0) {
        mini.style.left = p.x + 'px';
        mini.style.top = p.y + 'px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
      } else {
        mini.style.left = 'auto';
        mini.style.right = '14px';
        mini.style.top = 'auto';
        mini.style.bottom = '96px';
      }
    }
    function saveMiniPos(x, y) {
      host.persist(Object.assign({}, st(), { callMiniPos: { x: Math.round(x), y: Math.round(y) } }));
    }
    /* 局部坐标系：容器 = #app（position:relative、祖先链无 transform）。
       pointer 给的是视口视觉坐标，必须换算成 #app 的局部坐标再写 left/top，
       否则小窗不是跟手走、而是跳到指针位移那个绝对坐标上（客单12/29 都踩过）。 */
    function screenRect() {
      const box = $('#app') || doc.body;
      const r = box.getBoundingClientRect();
      const lw = box.clientWidth || r.width;
      const lh = box.clientHeight || r.height;
      const s = lw && r.width ? r.width / lw : 1;
      return { s, left: r.left, top: r.top, w: lw, h: lh };
    }
    function bindDrag() {
      if (!mini || mini.__dragBound) return;
      mini.__dragBound = true;
      mini.addEventListener('pointerdown', e => {
        /* 只有 ✕ 不参与拖动（它要留给 click 去挂断）。
           ⚠️ 不能写 e.target.closest('button') —— 小窗本体就是一个 <button>，
           那样等于整个小窗都不拖，症状正是「小窗无法移动」。 */
        if (e.target.closest('#call-mini-hang')) return;
        const f = screenRect();
        drag = {
          dx: (e.clientX - f.left) - mini.offsetLeft * f.s,
          dy: (e.clientY - f.top) - mini.offsetTop * f.s,
          sx: e.clientX, sy: e.clientY, moved: false, lx: -1, ly: -1
        };
        mini.classList.add('dragging');
        try { mini.setPointerCapture(e.pointerId); } catch { /* 某些环境不支持，忽略 */ }
        e.preventDefault();
      });
      mini.addEventListener('pointermove', e => {
        if (!drag) return;
        const f = screenRect();
        let lx = (e.clientX - drag.dx - f.left) / f.s;
        let ly = (e.clientY - drag.dy - f.top) / f.s;
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > CALL_MINI_DRAG_SLOP) drag.moved = true;
        lx = clampNum(lx, CALL_MINI_PAD, Math.max(CALL_MINI_PAD, f.w - mini.offsetWidth - CALL_MINI_PAD));
        ly = clampNum(ly, CALL_MINI_PAD, Math.max(CALL_MINI_PAD, f.h - mini.offsetHeight - CALL_MINI_PAD));
        drag.lx = lx; drag.ly = ly;
        mini.style.left = Math.round(lx) + 'px';
        mini.style.top = Math.round(ly) + 'px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
      });
      const up = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        mini.classList.remove('dragging');
        if (d.moved && d.lx >= 0) { lastDragAt = Date.now(); saveMiniPos(d.lx, d.ly); return; }
        /* 没有位移 = 轻点。⚠️ setPointerCapture 会把后续事件（含 click）重定向到小窗本体，
           内层 #call-mini-expand 收不到那次 click —— 所以展开必须在这里自己判，
           不能只靠内层按钮的 click 监听（否则轻点小窗毫无反应，只有 ✕ 能用）。 */
        if (Date.now() - lastDragAt > CALL_MINI_CLICK_GUARD) {
          lastTapAt = Date.now();
          expand();
        }
      };
      mini.addEventListener('pointerup', up);
      mini.addEventListener('pointercancel', up);
    }

    /* ---------------- 绘制 ----------------
       ⚠️ 小窗必须留在可交互集合里：inert 元素不参与命中测试，
       一旦把小窗也设成 inert，它就既接不到 pointerdown（拖不动），
       ✕ 和「展开」也点不动 —— 这正是「通话小窗无法移动」的病根。
       另：on=true 时会覆盖保存的旧值，所以只在「由关转开」时快照一次，
       否则重复调用会把上一轮的 true 记成基线，再也还原不回来。

       inert 同时写属性与属性值两路：浏览器里 .inert 是反射属性，
       但测试环境（jsdom）没有这个反射，只写 .inert 会变成看不见的自定义字段。 */
    function markInert(node, on) {
      node.inert = on;
      if (on) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    }
    function setInert(on) {
      const app = $('#app');
      if (!app) return;
      if (on) {
        if (!inertOn) {
          previousInert = [...app.children]
            .filter(node => node !== view && node !== mini && node.id !== 'toast')
            .map(node => [node, node.inert]);
          inertOn = true;
        }
        previousInert.forEach(([node]) => markInert(node, true));
      } else {
        previousInert.forEach(([node, inert]) => markInert(node, inert));
        previousInert = [];
        inertOn = false;
      }
    }
    function showView() {
      state.mini = false;
      view.hidden = false;
      view.dataset.phase = state.phase;
      setInert(true);
      syncMini();
    }
    function paint() {
      const s = st();
      const live = ['calling', 'incoming', 'active'].includes(state.phase);
      view.dataset.phase = state.phase;
      const avatar = $('#call-avatar');
      if (avatar) { avatar.src = s.peerAvatar || 'assets/peer.svg'; avatar.alt = (s.peerName || '对方') + '的头像'; }
      const name = $('#call-name');
      if (name) name.textContent = s.peerName || '对方';

      const sec = state.phase === 'ended' ? (state.endedSec || 0) : callSec();
      const timer = $('#call-timer');
      if (timer) {
        timer.hidden = !(state.phase === 'active' || (state.phase === 'ended' && sec > 0));
        timer.textContent = formatDur(sec);
      }
      const status = $('#call-status');
      if (status) {
        status.textContent =
          state.phase === 'calling' ? '正在呼叫…' :
          state.phase === 'incoming' ? '来电中…' :
          state.phase === 'active' ? '通话中 · 模拟' :
          state.phase === 'ended' ? '模拟通话已结束' :
          '模拟电话';
      }
      toggle($('#call-accept'), state.phase === 'incoming');
      toggle($('#call-mute'), state.phase === 'active');
      toggle($('#call-collapse'), state.phase === 'active');
      toggle($('#call-end'), state.phase === 'calling' || state.phase === 'incoming' || state.phase === 'active');
      toggle($('#call-return'), state.phase === 'ended');
      toggle($('#call-close'), true);
      const endLabel = $('#call-end-label');
      if (endLabel) endLabel.textContent = state.phase === 'calling' ? '取消呼叫' : state.phase === 'incoming' ? '拒接' : '挂断';
      const muteBtn = $('#call-mute');
      if (muteBtn) muteBtn.setAttribute('aria-pressed', String(!!state.muted));
      const muteLabel = $('#call-mute-label');
      if (muteLabel) muteLabel.textContent = state.muted ? '已静音' : '静音';
      if (!live) { /* 结束态：小窗一定收起 */ }
      syncMini();
      if (host.renderCallsPage) host.renderCallsPage();
    }
    function toggle(node, on) { if (node) node.hidden = !on; }
    function paintMini() {
      if (!mini) return;
      const s = st();
      const avatar = mini.querySelector('.call-mini-avatar');
      if (avatar) { avatar.src = s.peerAvatar || 'assets/peer.svg'; avatar.alt = (s.peerName || '对方') + '的头像'; }
      const text = mini.querySelector('.call-mini-text');
      if (text) {
        text.textContent = (s.peerName || '对方') + ' · ' +
          (state.phase === 'active' ? '通话中 ' + formatDur(callSec()) : state.phase === 'incoming' ? '来电中' : '正在呼叫');
      }
      mini.dataset.phase = state.phase;
    }

    /* ---------------- 心跳（复用 chat.js 那唯一一处 1 秒定时器） ---------------- */
    function hangSec() {
      return clampNum(Number(st().settings.callHgSec) || 30, 5, 600);
    }
    function tick() {
      const s = st();
      if (state.phase === 'active') {
        paintMini();
        const timer = $('#call-timer');
        if (timer && !view.hidden) timer.textContent = formatDur(duration(state));
        const miniText = mini && mini.querySelector('.call-mini-text');
        if (miniText && !mini.hidden) miniText.textContent = (s.peerName || '对方') + ' · 通话中 ' + formatDur(duration(state));
        if (!s.settings.callHangOn) return;
        const sec = duration(state);
        if (sec < CALL_GUARD_SEC) return;                 /* 保护期内绝不挂（工单第2条） */
        if (sec < (state.hgNext || 0)) return;            /* 检查点门：每 callHgSec 秒才真掷一次 */
        state.hgNext = sec + hangSec();
        const p = typeof probe.hang === 'number' ? probe.hang : CALL_HANG_P;
        if (rand() * 100 < p) finish('connected', { byTa: true });
        return;
      }
      /* TA 主动来电：到点才来；单日上限先查再 bump（先 bump 再判会永远不生效） */
      if (!s.settings.callOn || !s.settings.callInOn) { nextIncomingAt = 0; return; }
      if (['calling', 'active', 'incoming'].includes(state.phase)) return;
      const now = Date.now();
      if (!nextIncomingAt) { nextIncomingAt = now + incomingGap(); return; }
      if (now < nextIncomingAt) return;
      nextIncomingAt = now + incomingGap();
      if (dayCount() >= CALL_IN_CAP) return;
      bumpDay();
      incoming();
    }
    function incomingGap() {
      const s = st().settings;
      const a = Number(s.callInMin) || 60, b = Number(s.callInMax) || 240;
      return Math.round((Math.min(a, b) + rand() * Math.abs(b - a)) * 60000);
    }
    function dayKey() {
      const d = new Date();
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
    function dayCount() {
      const s = st();
      return s.callInDay === dayKey() ? (Number(s.callInN) || 0) : 0;
    }
    function bumpDay() {
      const s = st();
      host.persist(Object.assign({}, s, { callInDay: dayKey(), callInN: dayCount() + 1 }));
    }

    /* ---------------- 开合 ---------------- */
    function open() {
      /* 已经有通话就只是把全屏露出来，不重开一通（单一会话门） */
      if (['calling', 'incoming', 'active'].includes(state.phase)) {
        showView();
        paint();
        return;
      }
      returnFocus = doc.activeElement;
      if (host.prepare) host.prepare();
      dial();
      const acceptBtn = state.phase === 'incoming' ? $('#call-accept') : $('#call-end');
      if (acceptBtn && acceptBtn.focus) acceptBtn.focus({ preventScroll: true });
    }
    function collapse() {
      if (!isLive()) return;
      state.mini = true;
      view.hidden = true;
      setInert(false);
      syncMini();
      if (returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    }
    function expand() {
      if (!isLive()) return;
      state.mini = false;
      /* 展开要回到聊天屏：通话屏是盖在 .app 上的整屏浮层，
         留在功能页上展开会变成「通话页下面是字卡库」，收起来又不知道回哪。 */
      if (host.closeDetail) host.closeDetail();
      showView();
      paint();
    }
    function close() {
      /* 「收起」= 收成小窗，通话本身继续（工单第5条：通话中总要有可见入口） */
      if (isLive()) { collapse(); return; }
      state.dismissed = true;
      view.hidden = true;
      setInert(false);
      syncMini();
      saveState();
      if (returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
      else { const back = $('#call-open'); if (back) back.focus({ preventScroll: true }); }
    }

    /* ---------------- 跨刷新恢复 ----------------
       接通中继续走秒（connectTs 是绝对时间戳，不会走慢）；
       呼叫中的那通重新掷一次结局，别让它永远停在「正在呼叫」。 */
    function restore() {
      const s = st();
      const live = s.callLive;
      if (!live || !['calling', 'active', 'incoming'].includes(live.phase)) {
        state = initial();
        view.hidden = true;
        setInert(false);
        syncMini();
        return;
      }
      state = initial();
      state.phase = live.phase;
      state.status = STATUS_OF[live.phase];
      state.dir = live.dir || 'out';
      state.cid = live.cid || 'ta';
      state.startTs = Number(live.startTs) || Date.now();
      state.startedAt = live.phase === 'active' ? (Number(live.connectTs) || Date.now()) : null;
      state.mini = !!live.mini;
      state.endedSec = 0;
      state.hgNext = CALL_GUARD_SEC + hangSec();
      if (state.mini) { view.hidden = true; syncMini(); }
      else { showView(); paint(); }
      if (state.phase === 'calling') {
        const outcome = probe.forceOutcome || rollOutcome(s.settings, rand);
        after(() => { if (state.phase === 'calling') { if (outcome === 'connected') connect(); else finish(outcome); } }, CALL_WAIT[outcome] || 2000);
      }
      if (state.phase === 'incoming') {
        after(() => { if (state.phase === 'incoming') finish('missed'); }, CALL_IN_RING_SEC * 1000);
      }
      paint();
    }

    /* ---------------- 绑定 ---------------- */
    const on = (sel, fn) => { const node = $(sel); if (node) node.addEventListener('click', fn); };
    on('#call-accept', accept);
    on('#call-reject', reject);
    on('#call-mute', () => { if (state.phase === 'active') { state = transition(state, 'mute'); paint(); saveState(); } });
    on('#call-end', hangup);
    on('#call-collapse', collapse);
    on('#call-close', close);
    on('#call-return', () => {
      state.dismissed = true;
      view.hidden = true;
      setInert(false);
      syncMini();
      saveState();
    });
    /* 键盘/辅助技术触发的 click 走这里；指针那一路已经在 pointerup 里处理过，
       靠 lastTapAt 挡掉重复展开（同一次轻点只展开一次）。 */
    on('#call-mini-expand', () => {
      if (Date.now() - lastDragAt < CALL_MINI_CLICK_GUARD) return;
      if (Date.now() - lastTapAt < CALL_MINI_CLICK_GUARD) return;
      expand();
    });
    on('#call-mini-hang', hangup);

    doc.addEventListener('keydown', event => {
      if (view.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      if (event.key === 'Tab') {
        const buttons = [...view.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled);
        if (!buttons.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }, true);

    bindDrag();
    restore();

    return {
      open, close, collapse, expand, dial, incoming, accept, reject, hangup, tick, syncMini, syncLayer,
      getState: () => ({ ...state }), probe,
      peekOutcome: () => rollOutcome(st().settings, rand),
      destroy() { clearTimers(); }
    };
  }

  const api = {
    initial, transition, duration, formatDur, monthKey, rollOutcome, statsOf,
    CALL_ST, CALL_WAIT, CALL_ST_TXT, CALL_GUARD_SEC, CALL_IN_RING_SEC, CALL_IN_CAP, init
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Call44 = api;
})(typeof window !== 'undefined' ? window : globalThis);
