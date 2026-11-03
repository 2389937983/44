(function (root) {
  'use strict';

  const RECALL_DELAY = 5000;   /* TA 撤回：先完整发出，5 秒后才收回（29 口径） */
  const READ_DELAY = 900;      /* 「已送达」→「已读」 */
  const TYPING_DELAY = 520;    /* 回复前的打字中动画 */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  root.SlowChat = {
    init(host) {
      const M = root.ChatModel;
      const messagesBox = document.querySelector('#messages');
      const conversation = document.querySelector('#conversation');
      const chatView = document.querySelector('#chat-view');

      const probe = { rand: null, replyDelay: null, recallDelay: null, suggestDelay: null, auto: true, readNo: null, poke: null, quote: null };
      const timers = [];
      let typing = false, heartbeat = 0, tickSink = null;

      const rand = () => probe.rand ? probe.rand() : Math.random();
      const state = () => host.getState();
      const peerName = () => state().peerName || '对方';
      const selfName = () => state().selfName || '我';
      const isChatVisible = () => chatView ? !chatView.hidden : true;

      function later(fn, ms) {
        const at = Date.now() + ms;
        const id = setTimeout(() => {
          const i = timers.findIndex(t => t.id === id);
          if (i >= 0) timers.splice(i, 1);
          fn();
        }, ms);
        timers.push({ id, at, fn });
        return id;
      }
      function clearTimers() { timers.forEach(t => clearTimeout(t.id)); timers.length = 0; typing = false; }
      /* 测试专用：把「即将到期」的延迟按计划顺序跑完（不改真实延迟语义）。
         传 maxDelay 只推进该窗口内的定时器，留给长延迟（如 TA 撤回的 5 秒）真实等待。 */
      function flush(maxDelay) {
        const horizon = maxDelay == null ? Infinity : Date.now() + maxDelay;
        const queue = timers.filter(t => t.at <= horizon).sort((a, b) => a.at - b.at).map(t => ({ id: t.id, at: t.at, fn: t.fn }));
        queue.forEach(t => {
          const i = timers.findIndex(x => x.id === t.id);
          if (i < 0) return;
          clearTimeout(t.id);
          timers.splice(i, 1);
          t.fn();
        });
      }
      /* 概率：0 关闭、100 必中；覆盖值为布尔/数字时直接短路（29 的 setPokeOverride 口径）。 */
      function roll(value, override) {
        if (typeof override === 'boolean') return override;
        if (typeof override === 'number') return override > 0;
        return rand() * 100 < value;
      }
      function valueOf(key) {
        const v = state().settings[key];
        return Number.isFinite(v) ? v : M.SETTINGS[key].def;
      }

      /* ---------------- 渲染 ---------------- */
      function timeOf(iso) { return M.formatTime(new Date(iso)); }
      function pokeWords(m, s) { return m.text || ''; }
      function recallWords(m, s) {
        const who = m.recBy === 'me' ? (s.selfName || '我') : (s.peerName || '对方');
        let extra = '';
        if (m.recBy === 'ta' && s.settings.recShow) {
          const snap = M.recallSnapshot(m);
          extra = snap ? '：' + snap : '';
        }
        return who + '撤回了一条消息' + extra;
      }
      /* 抉择卡：命运之选卡显示结果与选项数；「请帮我选」卡只给问题和全部选项，结果由 TA 后续那条承接。 */
      function choiceBubble(m) {
        const bubble = el('div', 'bubble choice-bubble');
        bubble.append(el('span', 'choice-tag', m.mode === 'character' ? '请帮我选' : '命运之选'));
        bubble.append(el('p', 'choice-question', m.question));
        if (m.mode === 'character') {
          const list = el('ul', 'choice-options');
          (m.options || []).forEach(text => list.append(el('li', '', text)));
          bubble.append(list);
        } else {
          bubble.append(el('p', 'choice-result', m.result));
          bubble.append(el('small', 'choice-meta', (m.options || []).length + ' 个选项'));
        }
        return bubble;
      }
      function textBubble(m) {
        const bubble = el('div', 'bubble');
        /* 拼字卡：几张卡拼成一句，卡与卡之间空格顿开。
           ⚠️ 光换成空格不够 —— 字卡文本自己带换行（种子卡就是两行写法），
           而 .bubble p 是 pre-wrap，卡内那个 \n 照样断行。
           所以逐张先把空白压平（M.flatCardText），再统一用空格连起来。 */
        if (m.cards && m.cards.length) {
          bubble.append(el('p', '', M.composeCards(m.cards)));
        } else {
          bubble.append(el('p', '', m.text));
        }
        return bubble;
      }
      /* 通话卡（工单第10单第3条）：状态 + 时长，点一下回拨。
         没有正文，所以不进复制/引用菜单（messagePlain 返回空，菜单里那两项会自动隐藏）。 */
      function callBubble(m) {
        const C = root.Call44;
        const meta = m.call || {};
        const st = String(meta.st || 'connected');
        const mine = m.role === 'self';
        let title = C ? (C.CALL_ST_TXT[st] || '通话') : '通话';
        if (st === 'missed') title = mine ? '对方无人接听' : '未接来电';
        let sub = '没有接通';
        /* 已接通一律报时长（0 秒也写 0:00）—— 否则标题与副行都是「已接通」，读起来是重复的 */
        if (st === 'connected') sub = '通话时长 ' + (C ? C.formatDur(meta.sec) : (meta.sec || 0) + ' 秒');
        else if (st === 'busy') sub = '对方正在通话中';
        else if (st === 'rejected') sub = mine ? '对方拒接了' : '已拒接';
        const bubble = el('div', 'bubble call-bubble');
        bubble.dataset.act = 'call-redial';
        const head = el('div', 'call-bubble-head');
        head.append(icon('phone'));
        const col = el('span', 'call-bubble-col');
        col.append(el('strong', '', title), el('small', '', sub));
        head.append(col);
        bubble.append(head, el('span', 'call-bubble-foot', '点击回拨'));
        return bubble;
      }
      function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        svg.setAttribute('aria-hidden', 'true');
        use.setAttribute('href', '#i-' + name);
        svg.append(use);
        return svg;
      }
      function messageNode(m, s) {
        if (m.type === 'poke') return el('div', 'message-poke', pokeWords(m, s));
        if (m.rec === 1) return el('div', 'message-recall', recallWords(m, s));
        const self = m.role === 'self';
        const row = el('article', 'message-row ' + (self ? 'self' : 'peer'));
        row.dataset.mid = m.id;
        const who = self ? (s.selfName || '我') : (s.peerName || '对方');
        row.setAttribute('aria-label', who + '的消息');
        const meta = el('div', 'message-meta');
        const avatarBox = el('div', 'message-avatar');
        const img = el('img');
        img.src = (self ? s.selfAvatar : s.peerAvatar) || ('assets/' + (self ? 'self' : 'peer') + '.svg');
        img.alt = who + '的头像';
        avatarBox.append(img);
        if (!self) { avatarBox.title = '双击拍一拍' + s.peerName; avatarBox.setAttribute('role', 'button'); }
        meta.append(avatarBox, el('time', '', timeOf(m.date)));
        if (self) meta.append(el('span', 'message-receipt', m.read === 1 ? '已读' : '已送达'));
        const stack = el('div', 'message-stack');
        stack.append(m.type === 'choice' ? choiceBubble(m) : m.type === 'call' ? callBubble(m) : textBubble(m));
        if (m.quote) stack.append(el('blockquote', 'message-quote', m.quote));
        row.append(meta, stack);
        return row;
      }
      /* 打字中：三点动画 + 一行小字（工单第1单#6）。 */
      function typingNode() {
        const node = el('div', 'message-typing');
        node.setAttribute('aria-label', peerName() + ' 正在输入');
        const dots = el('span', 'typing-dots');
        dots.append(el('i'), el('i'), el('i'));
        node.append(dots, el('span', '', peerName() + ' 正在输入…'));
        return node;
      }
      /* 时间分隔条：第一条前面一条（就是原来「一段对话的开始」的位置），
         之后每次静默满 30 分钟再来消息，就在那条消息上方再来一条。 */
      function gapNode(date) {
        const node = el('div', 'message-gap');
        node.append(el('span', 'gap-note', M.GAP_NOTE), el('time', 'gap-time', M.gapText(date)));
        node.setAttribute('role', 'separator');
        return node;
      }
      function render(forceBottom) {
        const s = state();
        const node = conversation;
        const nearBottom = !node || (node.scrollHeight - node.scrollTop - node.clientHeight) < 90;
        const frag = document.createDocumentFragment();
        const gaps = M.gapFlags(s.messages);
        // Look both ways: the last bubble reopens its lower outside corner.
        // Keep group membership identical to the existing avatar/spacing logic.
        const continues = s.messages.map((m, i) => {
          const previous = s.messages[i - 1];
          return !!(!gaps[i] && previous && previous.role === m.role && previous.type !== 'poke' && !previous.rec && m.type !== 'poke' && !m.rec);
        });
        s.messages.forEach((m, i) => {
          if (gaps[i]) frag.append(gapNode(m.date));
          const node = messageNode(m, s);
          if (node.classList.contains('message-row')) {
            const fromPrevious = continues[i], toNext = !!continues[i + 1];
            node.dataset.groupPosition = fromPrevious ? (toNext ? 'middle' : 'end') : (toNext ? 'start' : 'single');
            if (fromPrevious) node.classList.add('is-continuation');
          }
          frag.append(node);
        });
        if (typing) frag.append(typingNode());
        messagesBox.replaceChildren(frag);
        if (forceBottom !== false && (forceBottom === true || nearBottom)) {
          if (node) node.scrollTop = node.scrollHeight;
        }
        if (host.refresh) host.refresh();
      }

      /* ---------------- 发送与回复 ---------------- */
      function send(draft) {
        try {
          /* id/date 由接入层补：appendMyMessage 对缺失 id 的草稿直接拒绝（这正是它防重复的手段）。 */
          const next = M.appendMyMessage(state(), Object.assign({ id: host.newId('m'), date: new Date().toISOString() }, draft || {}));
          if (!host.persist(next)) { host.toast('消息没能保存，先检查一下浏览器存储空间。'); return false; }
          render(true);
          scheduleReceipt();
          scheduleReply();
          return true;
        } catch (e) { host.toast(e.message); return false; }
      }
      /* 抉择卡走这里：与文字消息同一条发送链，但带 type/mode 字段，字符模式的 TA 建议按 2~5 秒回。 */
      function sendChoice(draft) {
        try {
          const d = Object.assign({ id: host.newId('m'), date: new Date().toISOString(), type: 'choice' }, draft || {});
          const next = M.appendMyMessage(state(), d);
          if (!host.persist(next)) { host.toast('这次抉择没能保存，请检查浏览器存储空间。'); return false; }
          render(true);
          scheduleReceipt();
          if (d.mode === 'character' && d.result) scheduleSuggestion(d.id, d.result);
          return true;
        } catch (e) { host.toast(e.message); return false; }
      }
      /* 路径二的即时回应链：TA 在 2~5 秒后给出建议；answered 标记保证重绘/恢复时不会重复发送。 */
      function scheduleSuggestion(mid, suggestion) {
        const wait = probe.suggestDelay != null ? probe.suggestDelay : (2000 + Math.round(rand() * 3000));
        later(() => {
          const s = state();
          const card = s.messages.find(m => m.id === mid);
          if (!card || card.answered === 1) return;
          const draft = { id: host.newId('m'), text: '我的建议是：' + suggestion, date: new Date().toISOString() };
          const next = M.appendPeerMessage(s, draft);
          if (!next || !host.persist(M.markChoiceAnswered(next, mid))) return;
          render(true);
          afterPeerMessage(draft.id);
        }, wait);
      }
      function scheduleReceipt() {
        later(() => {
          const next = M.markRead(state());
          if (next !== state() && host.persist(next)) render(false);
        }, READ_DELAY);
      }
      /* TA 引用我：只从「最近 8 条且 30 分钟内」的我方消息里挑，命中时整条带引用块（工单第1单#16）。 */
      function withQuote(draft, s) {
        const cands = M.quoteCandidates(s, { now: Date.now() });
        if (!cands.length) return draft;
        if (!roll(valueOf('quoteProb'), probe.quote)) return draft;
        const pick = cands[Math.min(cands.length - 1, Math.floor(rand() * cands.length))];
        const snap = M.messagePlain(pick).replace(/\s*\n\s*/g, ' ').slice(0, 120);
        if (!snap) return draft;
        return Object.assign({}, draft, { quote: '你说：' + snap, qid: pick.id });
      }
      function replyDelay() {
        if (probe.replyDelay != null) return probe.replyDelay;
        const s = state().settings, min = s.replyMin * 1000, max = s.replyMax * 1000;
        return Math.round(min + rand() * Math.max(0, max - min));
      }
      function scheduleReply() {
        const wait = replyDelay();
        const pokeHit = roll(valueOf('pokeReplyProb'), probe.poke && probe.poke.reply);
        if (!pokeHit) maybeTyping(wait);
        later(() => {
          typing = false;
          if (pokeHit && doPoke('peer')) return;
          if (roll(valueOf('readNoP'), probe.readNo)) {
            render(false);
            host.toast(peerName() + ' 已读，但没有回你');
            return;
          }
          const s = state(), drawn = M.drawCards(s, { rand, idFn: host.newId });
          const draft = withQuote({ id: host.newId('m'), text: '', cards: drawn.cards, date: new Date().toISOString() }, s);
          if (!drawn.cards.length && drawn.texts.length) draft.text = drawn.texts[0];
          const next = M.appendPeerMessage(s, draft);
          if (!next || !host.persist(next)) return;
          render(true);
          afterPeerMessage(draft.id);
        }, wait);
      }
      function maybeTyping(wait) {
        if (wait < TYPING_DELAY * 2) return;
        later(() => { typing = true; render(false); }, TYPING_DELAY);
      }
      /* TA 发完之后才掷撤回，5 秒后才真正收回（不是当场消失）。 */
      function afterPeerMessage(mid) {
        if (!isChatVisible()) {
          const s = state();
          if (host.persist(Object.assign({}, s, { unread: Math.min(99, s.unread + 1) })) && host.onUnread) host.onUnread();
          host.toast(peerName() + ' 发来一条消息');
        }
        if (!roll(valueOf('recallProb'), null)) return;
        later(() => {
          const result = M.recallMessage(state(), mid, 'ta');
          if (result.ok && host.persist(result.state)) { render(false); host.toast(peerName() + ' 撤回了一条消息'); }
        }, probe.recallDelay != null ? probe.recallDelay : RECALL_DELAY);
      }

      /* ---------------- 拍一拍 ---------------- */
      /* 动作池为空时按工单退回普通消息：返回 false，由调用方走正常一条。 */
      function doPoke(from) {
        const s = state(), pool = s.pokes;
        if (!pool.length) return false;
        const phrase = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
        const next = M.appendPoke(s, { id: host.newId('p'), from, phrase, date: new Date().toISOString() });
        if (!next || !host.persist(next)) return false;
        render(true);
        if (from === 'peer' && !isChatVisible()) {
          const cur = state();
          if (host.persist(Object.assign({}, cur, { unread: Math.min(99, cur.unread + 1) })) && host.onUnread) host.onUnread();
        }
        return true;
      }
      function poke() {
        if (!doPoke('self')) { host.toast('拍一拍动作池是空的，去字卡库加一条吧。'); return; }
        if (!roll(valueOf('pokeBack'), probe.poke && probe.poke.back)) return;
        const wait = 1500 + Math.round(rand() * 2000);
        later(() => doPoke('peer'), wait);
      }

      /* ---------------- 主动消息 ---------------- */
      let nextAutoAtLocal = 0;
      function settingsChanged() { scheduleAuto(); }
      function scheduleAuto() {
        if (probe.auto === false) return;
        const s = state().settings;
        if (!s.autoOn) { nextAutoAtLocal = 0; return; }
        const min = s.autoMin * 60000, max = s.autoMax * 60000;
        nextAutoAtLocal = Date.now() + Math.round(min + rand() * Math.max(0, max - min));
      }
      function checkAuto(ignoreTime) {
        if (probe.auto === false) return false;
        if (!ignoreTime && (!nextAutoAtLocal || Date.now() < nextAutoAtLocal)) return false;
        const s = state();
        if (!s.settings.autoOn) { nextAutoAtLocal = 0; return false; }
        if (roll(valueOf('pokeMsgProb'), probe.poke && probe.poke.msg) && doPoke('peer')) { scheduleAuto(); return true; }
        const drawn = M.drawCards(s, { rand, idFn: host.newId });
        const draft = withQuote({ id: host.newId('m'), text: '', cards: drawn.cards, date: new Date().toISOString() }, s);
        if (!drawn.cards.length && drawn.texts.length) draft.text = drawn.texts[0];
        const next = M.appendPeerMessage(s, draft);
        if (next && host.persist(next)) {
          render(true);
          host.toast(peerName() + ' 找你说话啦');
          afterPeerMessage(draft.id);
        }
        scheduleAuto();
        return true;
      }
      function startHeartbeat() {
        if (heartbeat) return;
        scheduleAuto();
        heartbeat = setInterval(() => {
          checkAuto(false);
          /* 全站只有这一处 1 秒心跳：通话计时、TA 来电、中途挂断都挂在它上面，
             通话模块自己不再起一个 setInterval（工单口径：唯一调度器）。 */
          if (tickSink) { try { tickSink(); } catch { /* 通话侧异常不该打断聊天 */ } }
        }, 1000);
      }
      function setTickSink(fn) { tickSink = typeof fn === 'function' ? fn : null; }

      /* ---------------- 操作：撤回 ---------------- */
      function askRecall(mid) {
        const s = state(), m = s.messages.find(x => x.id === mid);
        if (!m || m.role !== 'self' || m.rec === 1) return;
        host.confirm({
          title: '撤回这条消息？',
          text: '撤回后这条会换成一行提示，原文不再显示。',
          confirmLabel: '撤回',
          danger: true,
          onConfirm() {
            const result = M.recallMessage(state(), mid, 'me');
            if (result.ok && host.persist(result.state)) { render(false); host.toast('已撤回。'); }
            else host.toast(result.reason || '没能撤回这条消息。');
          }
        });
      }

      /* ---------------- 操作：复制 / 删除 ---------------- */
      /* 剪贴板：navigator.clipboard 优先，file:// 下不可用时回退 execCommand（工单第1单#16）。 */
      function copyText(text) {
        const done = () => host.toast('已复制。');
        const fail = () => host.toast('复制不了，请长按气泡手动选择文字。');
        const legacy = () => {
          try {
            const area = el('textarea', 'copy-buffer');
            area.value = text;
            area.setAttribute('readonly', 'readonly');
            document.body.append(area);
            area.select();
            area.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            area.remove();
            if (ok) done(); else fail();
          } catch { fail(); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(legacy);
        } else legacy();
      }
      function askDelete(mid) {
        const m = state().messages.find(x => x.id === mid);
        if (!m || m.type === 'poke') return;
        host.confirm({
          title: '删除这条消息？',
          text: '删掉就从聊天记录里去掉，找不回来了。只想让它不显示原文，用「撤回」。',
          confirmLabel: '删除',
          danger: true,
          onConfirm() {
            const result = M.removeMessage(state(), mid);
            if (result.ok && host.persist(result.state)) { render(false); host.toast('已删除。'); }
            else host.toast(result.reason || '没能删掉这条消息。');
          }
        });
      }
      const MENU_ACTIONS = [
        { id: 'copy', label: '复制' },
        { id: 'quote', label: '引用' },
        { id: 'recall', label: '撤回', selfOnly: true },
        { id: 'delete', label: '删除', danger: true }
      ];
      let menuMid = '';
      const menu = document.querySelector('#msg-actions');
      function closeMenu() {
        menuMid = '';
        if (menu) { menu.hidden = true; menu.replaceChildren(); }
      }
      function openMenuAt(mid, anchor) {
        if (!menu) return;
        const m = state().messages.find(x => x.id === mid);
        if (!m) return;
        /* 灰条（拍一拍/撤回）没有可复制的正文，不弹菜单；已撤回的仍留「删除」。 */
        if (m.type === 'poke') return;
        const items = MENU_ACTIONS.filter(action => {
          if (action.id === 'recall') return m.role === 'self' && m.rec !== 1;
          if (action.id === 'delete') return true;
          if (action.id === 'copy') return !!M.messagePlain(m) && m.rec !== 1;
          if (action.id === 'quote') return !!M.messagePlain(m) && m.rec !== 1;
          return true;
        });
        if (!items.length) return;
        menuMid = mid;
        menu.replaceChildren(...items.map(action => {
          const button = el('button', 'msg-action' + (action.danger ? ' danger' : ''), action.label);
          button.type = 'button';
          button.dataset.action = action.id;
          button.addEventListener('click', () => {
            const target = state().messages.find(x => x.id === mid);
            closeMenu();
            if (!target) return;
            if (action.id === 'copy') { copyText(M.messagePlain(target)); return; }
            if (action.id === 'quote') { host.quote(target); return; }
            if (action.id === 'recall') { askRecall(mid); return; }
            if (action.id === 'delete') askDelete(mid);
          });
          return button;
        }));
        menu.hidden = false;
        /* 菜单贴住气泡：优先显示在气泡上方，放不下就落到下方（工单第1单#16）。 */
        const box = anchor.getBoundingClientRect();
        const chatBox = chatView.getBoundingClientRect();
        const width = menu.offsetWidth, height = menu.offsetHeight;
        let left = box.left - chatBox.left + box.width / 2 - width / 2;
        left = Math.max(8, Math.min(chatBox.width - width - 8, left));
        let top = box.top - chatBox.top - height - 8;
        if (top < 8) top = box.bottom - chatBox.top + 8;
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
      }

      /* ---------------- 事件 ---------------- */
      messagesBox.addEventListener('click', event => {
        /* 通话卡：点一下回拨（工单第10单第3条）。
           单一会话门在 call.dial 里，正在通话时它会拦住并提示，不会开第二通。 */
        const callCard = event.target.closest('.call-bubble');
        if (callCard) {
          if (root.SlowApp && root.SlowApp.call) root.SlowApp.call.dial();
          return;
        }
        const bubble = event.target.closest('.bubble');
        if (!bubble) return;
        const row = bubble.closest('.message-row');
        if (row && row.dataset.mid) openMenuAt(row.dataset.mid, bubble);
      });
      messagesBox.addEventListener('dblclick', event => {
        const avatar = event.target.closest('.message-row.peer .message-avatar');
        if (avatar) { poke(); return; }
      });
      /* 点菜单外或滚动消息流就收起菜单。 */
      document.addEventListener('click', event => {
        if (!menu || menu.hidden) return;
        if (event.target.closest('#msg-actions')) return;
        if (event.target.closest('.message-row .bubble')) return;
        closeMenu();
      });
      if (conversation) conversation.addEventListener('scroll', () => { if (menu && !menu.hidden) closeMenu(); });

      render(true);

      const api = {
        render, send, sendChoice, poke, scheduleAuto, checkAuto, settingsChanged, closeMenu, openMenuAt, askDelete, copyText,
        askRecall, startHeartbeat, setTickSink, clearTimers,
        probe, flush, valueOf,
        stop() { clearTimers(); if (heartbeat) clearInterval(heartbeat); heartbeat = 0; }
      };
      return api;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
