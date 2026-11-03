(function () {
  'use strict';

  const model = window.ChatModel;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const storageKey = model.STORE_KEY;

  let state = model.createState();
  let loadError = false;
  try { state = model.normalizeState(JSON.parse(localStorage.getItem(storageKey))); }
  catch { loadError = true; }

  let toastTimer;
  let viewStack = [{ type: 'chat' }];
  let returnFocus = $('#menu-open');
  const titles = { cards: '字卡库', settings: '设置', appearance: '美化', history: '决策历史', calls: '通话' };
  let imageRequest = null;
  let pendingQuote = null;   /* 待引用：{id,text,target}，只在内存里，切页面不丢 */
  let chat = null, cardlib = null, settings = null, decision = null, call = null;

  /* ---------------- 基础 ---------------- */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3400);
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); return true; }
    catch { toast('浏览器空间不足或不允许保存，本次修改仍可使用，但刷新后可能丢失。'); return false; }
  }
  function persist(next) {
    if (!next || typeof next !== 'object') return false;
    state = next;
    return save();
  }

  /* ---------------- 弹层：确认 / 输入 / 选择 ---------------- */
  let sheetOpen = false;
  let sheetReturnFocus = null;
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    $('#sheet-wrap').hidden = true;
    $('#sheet').replaceChildren();
    if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus({ preventScroll: true });
    sheetReturnFocus = null;
  }
  function showSheet(node, focusEl) {
    sheetReturnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    $('#sheet').replaceChildren(node);
    $('#sheet-wrap').hidden = false;
    sheetOpen = true;
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
  function sheetFrame(title, bodyNodes, actions) {
    const frame = el('div', 'sheet-panel');
    frame.append(el('h3', 'sheet-title', title));
    bodyNodes.forEach(node => frame.append(node));
    const row = el('div', 'sheet-actions');
    actions.forEach(action => row.append(action));
    frame.append(row);
    return frame;
  }
  function sheetButton(label, cls, onClick) {
    const button = el('button', cls, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }
  function confirmSheet(opts) {
    const o = opts || {};
    const body = [];
    if (o.text) body.push(el('p', 'sheet-text', o.text));
    const cancel = sheetButton(o.cancelLabel || '取消', 'secondary-button', closeSheet);
    const ok = sheetButton(o.confirmLabel || '确定', 'primary-button' + (o.danger ? ' danger' : ''), () => {
      closeSheet();
      if (o.onConfirm) o.onConfirm();
    });
    showSheet(sheetFrame(o.title || '确认', body, [cancel, ok]), ok);
  }
  function promptSheet(opts) {
    const o = opts || {};
    const body = [];
    if (o.label) body.push(el('p', 'sheet-text', o.label));
    const input = o.multiline ? el('textarea', 'sheet-input') : el('input', 'sheet-input');
    input.value = o.value || '';
    if (o.placeholder) input.placeholder = o.placeholder;
    if (o.multiline) input.rows = 3; else input.type = 'text';
    if (o.maxLength) input.maxLength = o.maxLength;
    body.push(input);
    const cancel = sheetButton('取消', 'secondary-button', closeSheet);
    const ok = sheetButton(o.confirmLabel || '保存', 'primary-button', () => {
      const value = input.value;
      closeSheet();
      if (o.onSubmit) o.onSubmit(value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !o.multiline) { event.preventDefault(); ok.click(); }
    });
    showSheet(sheetFrame(o.title || '编辑', body, [cancel, ok]), input);
  }
  function chooseSheet(opts) {
    const o = opts || {};
    const body = [];
    if (o.text) body.push(el('p', 'sheet-text', o.text));
    const list = el('div', 'sheet-list');
    (o.items || []).forEach(item => {
      const button = sheetButton(item.label, 'sheet-item' + (item.danger ? ' danger' : ''), () => {
        closeSheet();
        if (item.onSelect) item.onSelect();
      });
      if (item.description) button.append(el('small', '', item.description));
      list.append(button);
    });
    body.push(list);
    showSheet(sheetFrame(o.title || '选择', body, [sheetButton('取消', 'secondary-button', closeSheet)]));
  }
  $('#sheet-wrap').addEventListener('click', event => { if (event.target === $('#sheet-wrap')) closeSheet(); });

  /* ---------------- 引用（工单第1单#16） ---------------- */
  function quoteTextOf(m) {
    if (!m) return '';
    const snap = model.messagePlain(m).replace(/\s*\n\s*/g, ' ');
    return snap.slice(0, 120);
  }
  function setPendingQuote(msg) {
    if (!msg) { pendingQuote = null; renderQuoteBar(); return; }
    const snap = quoteTextOf(msg);
    if (!snap) { toast('这条没有可以引用的文字。'); return; }
    pendingQuote = { id: msg.id, text: snap, target: msg.role === 'self' ? (state.selfName || '我') : (state.peerName || '对方') };
    renderQuoteBar();
    $('#message-input').focus();
  }
  function renderQuoteBar() {
    const bar = $('#quote-bar');
    if (!bar) return;
    bar.hidden = !pendingQuote;
    if (!pendingQuote) return;
    $('#quote-bar-text').textContent = pendingQuote.text;
  }

  /* ---------------- 外观 ---------------- */
  /* 气泡样式挂两个独立节点，都在 <head> 末尾、都只写 textContent（不拼 HTML）：
       #bubble-skin 内置皮肤 → 前；#bubble-css 用户 CSS → 后。
     同特异性下后写的胜，所以「自己上传的 CSS」天然盖过内置皮肤，用户不用纠结叠加顺序。
     空串就把节点整个摘掉，不留空 style 拖着样式重算。 */
  function writeStyleNode(id, css) {
    let node = document.getElementById(id);
    if (!css) { if (node && node.parentNode) node.parentNode.removeChild(node); return; }
    if (!node) { node = document.createElement('style'); node.id = id; document.head.appendChild(node); }
    if (node.textContent !== css) node.textContent = css;
  }
  function applyBubbleLayers() {
    const shapeCss = model.bubbleSkinCss(state.bubbleSkin).replace(/(?:background(?:-color)?|color|border-color)\s*:[^;}]+;?/g, '');
    writeStyleNode('bubble-skin', model.adaptUserCss(shapeCss));
    const comicCss = state.palette === 'black-white' ? '\n#app :where(.message-row.self) .bubble { border-width:var(--self-border-width);border-style:solid;box-shadow:var(--row-shadow); }' : '';
    writeStyleNode('bubble-palette', '#app .bubble { background:var(--row-bubble);color:var(--row-text);border-color:var(--row-border, var(--bubble-border)); }' + comicCss);
    writeStyleNode('bubble-css', model.adaptUserCss(model.sanitizeUserCss(state.bubbleCss)));
    const custom = $('#bubble-css');
    if (custom) document.head.append(custom);
  }
  function applyAppearance() {
    const app = $('#app');
    const appearance = window.Appearance44.normalize(state);
    app.dataset.theme = appearance.theme;
    document.documentElement.dataset.theme = appearance.theme;
    app.dataset.palette = appearance.palette;
    document.querySelector('meta[name="theme-color"]').content = appearance.theme === 'dark' ? '#1e1e1e' : '#ffffff';
    const colors = window.Appearance44.colors(appearance.theme, appearance.palette);
    app.style.setProperty('--peer-bubble', colors.peer);
    app.style.setProperty('--self-bubble', colors.selfBackground);
    app.style.setProperty('--self-border', colors.selfBorder);
    app.style.setProperty('--self-border-width', colors.selfBorderWidth);
    app.style.setProperty('--self-shadow', colors.selfShadow);
    app.style.setProperty('--peer-text', colors.peerText);
    app.style.setProperty('--self-text', colors.selfText);
    $$('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === appearance.theme)));
    $$('button[data-palette]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.palette === appearance.palette)));
    app.dataset.background = state.background;
    app.dataset.showTime = String(state.showTime);
    app.style.setProperty('--message-size', state.fontSize + 'px');
    /* 气泡大小：只写一个系数变量，样式表里 calc() 相乘 —— 不重绘任何东西。 */
    app.style.setProperty('--bub-k', String(model.bubClamp(state.bubScale) / 100));
    const conversation = $('#conversation');
    conversation.classList.toggle('has-wall', !!state.walls.chat);
    if (state.walls.chat) conversation.style.setProperty('--chat-wall', "url('" + state.walls.chat + "')");
    else conversation.style.removeProperty('--chat-wall');
    $$('.background-option').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.background === state.background)));
    $$('.font-options button').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.font) === state.fontSize)));
    $$('[data-skin]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.skin === state.bubbleSkin)));
    syncBubScale();
    applyBubbleLayers();
  }
  /* 气泡大小滑块：拖动时只改变量 + 两个文本节点，绝不重绘（重绘会把手指按着的滑块换掉）。 */
  function syncBubScale() {
    const pct = model.bubClamp(state.bubScale);
    const range = $('#bub-range');
    const out = $('#bub-pct');
    if (range && Number(range.value) !== pct) range.value = String(pct);
    if (out) out.textContent = pct + '%';
  }
  function setBubScale(value) {
    state = Object.assign({}, state, { bubScale: model.bubClamp(value) });
    save();
    $('#app').style.setProperty('--bub-k', String(model.bubClamp(state.bubScale) / 100));
    syncBubScale();
  }
  function setBubbleSkin(id) {
    if (!model.BUBBLE_SKINS.some(skin => skin.id === id)) return;
    state = Object.assign({}, state, { bubbleSkin: id });
    save();
    applyAppearance();
    renderSkinGrid();
    const hit = model.BUBBLE_SKINS.find(skin => skin.id === id);
    toast(hit && hit.css ? '气泡换成「' + hit.name + '」了。' : '气泡回到经典样式。');
  }
  function setBubbleCss(css) {
    state = Object.assign({}, state, { bubbleCss: model.sanitizeUserCss(css) });
    save();
    applyAppearance();
    renderSkinGrid();
  }
  /* ---------------- 气泡皮肤面板 ---------------- */
  /* 皮肤小样直接用皮肤自己的 CSS 观感（内联 swatch），选中的那颗有描边 —— 不用真渲染一遍聊天。 */
  function renderSkinGrid() {
    const box = $('#bubble-skins');
    if (!box) return;
    box.replaceChildren(...model.BUBBLE_SKINS.map(skin => {
      const button = el('button', 'skin-chip' + (state.bubbleSkin === skin.id ? ' is-active' : ''));
      button.type = 'button';
      button.dataset.skin = skin.id;
      button.setAttribute('aria-pressed', String(state.bubbleSkin === skin.id));
      const swatch = el('span', 'skin-swatch');
      swatch.setAttribute('style', skin.swatch || '');
      button.append(swatch, el('small', '', skin.name));
      button.addEventListener('click', () => setBubbleSkin(skin.id));
      return button;
    }));
    const reset = $('#bubble-css-reset');
    const note = $('#bubble-css-state');
    const len = model.sanitizeUserCss(state.bubbleCss).length;
    if (reset) reset.hidden = !len;
    if (note) note.textContent = len
      ? '你已经自己写了 ' + len + ' 个字符的 CSS，它会盖在内置皮肤上面。'
      : '还没有自己上传的 CSS，先用上面的皮肤。';
  }

  /* 自定义 CSS 弹层：写 / 贴 / 传文件三条路，最后都落到同一个 setBubbleCss。 */
  function openBubbleCss() {
    const frame = el('div', 'sheet-panel css-panel');
    frame.append(el('h3', 'sheet-title', '自定义气泡 CSS'));
    frame.append(el('p', 'sheet-text', '改的是聊天里那个气泡。可以只写声明（自动套到双方气泡上），也可以写选择器；.bubble 是气泡本体，.message-row.self / .message-row.peer 是我 / 对方那一行。'));
    const area = el('textarea', 'sheet-input css-area');
    area.rows = 10;
    area.spellcheck = false;
    area.value = state.bubbleCss || '';
    area.placeholder = '.bubble {\n  border-radius: 18px;\n  box-shadow: 0 2px 10px #0000001f;\n}';
    area.setAttribute('aria-label', '自定义气泡 CSS');
    frame.append(area);
    const ref = el('div', 'css-ref');
    ref.append(el('b', '', '可用的名字'));
    const list = el('p', '', '.bubble 气泡 · .message-row.self 我那一行 · .message-row.peer 对方那一行 · .message-avatar 头像 · .message-meta 时间 · .messages 消息区');
    ref.append(list);
    ref.append(el('p', '', '外面抄来的 .msg-bubble / .msg-in / .msg-out / .message-sent 这些名字会自动映射过来；body、html 这类整页规则不生效。'));
    ref.append(el('p', '', '@import 会被拦掉；图片挂件可以写 url("https://…")（要联网）或 data: 图（离线自带）。最多 8000 个字符。'));
    frame.append(ref);
    const row = el('div', 'sheet-actions');
    const upload = sheetButton('上传 .css 文件', 'secondary-button', () => { $('#bubble-file').value = ''; $('#bubble-file').click(); });
    const cancel = sheetButton('取消', 'secondary-button', closeSheet);
    const save = sheetButton('应用', 'primary-button', () => { setBubbleCss(area.value); closeSheet(); toast('气泡 CSS 已应用。'); });
    row.append(upload, cancel, save);
    frame.append(row);
    showSheet(frame, area);
    /* 边打边生效：输入时只写 <style>，不重画任何一层（重画会把光标弄丢）。 */
    area.addEventListener('input', () => setBubbleCss(area.value));
  }
  $('#bubble-file').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const css = model.sanitizeUserCss(String(reader.result));
      if (!css) { toast('这个文件里没有能用的 CSS。'); return; }
      setBubbleCss(css);
      const area = $('.css-area');
      if (area) area.value = css;
      renderSkinGrid();
      toast('已载入 ' + css.length + ' 个字符的 CSS。');
    };
    reader.onerror = () => toast('这个文件读不出来，换一个 .css 或 .txt 再试。');
    reader.readAsText(file);
  });

  function updateIdentity() {
    $('#peer-name').textContent = state.peerName;
    $$('[data-profile-name]').forEach(label => {
      label.textContent = state[label.dataset.profileName + 'Name'];
    });
    $$('[data-avatar]').forEach(img => {
      const which = img.dataset.avatar;
      img.src = state[which + 'Avatar'] || ('assets/' + which + '.svg');
      img.alt = state[which + 'Name'] + '的头像';
    });
  }
  function updateUnread() {
    /* 未读要在三个位置都看得见：聊天页顶栏（#unread-dot）、功能页返回键、全屏菜单的「回到聊天」。 */
    ['#unread-dot', '#unread-dot-back', '#unread-dot-return'].forEach(selector => {
      const dot = $(selector);
      if (!dot) return;
      dot.hidden = !state.unread;
      if (state.unread) dot.textContent = String(state.unread);
    });
    $('#menu-open').setAttribute('aria-label', state.unread ? '打开全屏功能菜单（' + state.unread + ' 条新消息）' : '打开全屏功能菜单');
    const back = $('#detail-back');
    if (back) back.setAttribute('aria-label', state.unread ? '返回上一页（' + state.unread + ' 条新消息）' : '返回上一页');
  }
  function refreshChrome() { updateIdentity(); applyAppearance(); updateUnread(); }

  /* ---------------- 路由 ---------------- */
  function resizeInput() {
    const input = $('#message-input');
    input.style.height = '44px';
    input.style.height = Math.min(120, Math.max(44, input.scrollHeight)) + 'px';
    $('#send-button').disabled = !input.value.trim();
    $('#composer').classList.toggle('has-text', !!input.value.trim());
  }
  function toggleQuick(open) {
    if (open) toggleEmoji(false);
    $('#quick-actions').hidden = !open;
    $('#quick-toggle').setAttribute('aria-expanded', String(open));
    $('#quick-toggle').setAttribute('aria-label', open ? '收起更多功能' : '展开更多功能');
  }
  function toggleProfile(open) {
    if (open) toggleEmoji(false);
    $('#profile-menu').hidden = !open;
    $('#more-open').setAttribute('aria-expanded', String(open));
  }
  function showCurrent() {
    const view = viewStack[viewStack.length - 1];
    $('#chat-view').hidden = view.type !== 'chat';
    $('#menu-view').hidden = view.type !== 'menu';
    $('#detail-view').hidden = view.type !== 'detail';
    if (view.type === 'detail') {
      $$('.detail-page').forEach(page => { page.hidden = page.id !== 'page-' + view.page; });
      $('#detail-title').textContent = titles[view.page];
      $('#detail-view').setAttribute('aria-label', titles[view.page]);
      if (view.page === 'cards') { cardlib.render(); }
      if (view.page === 'settings') { settings.render(); }
      if (view.page === 'history') decision.renderHistoryPage();
      if (view.page === 'calls') renderCallsPage();
      if (view.page === 'appearance') { applyAppearance(); renderSkinGrid(); }
      $('#detail-back').focus({ preventScroll: true });
    } else if (view.type === 'menu') {
      $('#menu-view [data-close]').focus({ preventScroll: true });
    } else {
      if (state.unread) { state = Object.assign({}, state, { unread: 0 }); save(); updateUnread(); }
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    }
    if (call) call.syncMini();
  }
  function navigate(page, source) {
    if (!titles[page]) return;
    if (viewStack.length === 1) returnFocus = source || $('#quick-toggle');
    toggleProfile(false);
    toggleQuick(false);
    viewStack.push({ type: 'detail', page });
    showCurrent();
  }
  function closeToChat() {
    toggleQuick(false);
    toggleProfile(false);
    viewStack = [{ type: 'chat' }];
    showCurrent();
    chat.render(false);
    /* 通话小窗的显隐按「有通话 且 全屏没开着」判 —— 每次回到聊天都要重新对齐一次，
       否则「通话中直接切走」会变成谁也看不见的空洞（工单坑②）。 */
    if (call) call.syncMini();
  }

  /* ---------------- 通话记录页（模拟通话） ----------------
     记录与本月统计都是本地数据；「全部 / 各梦角」的筛选在单梦角形态下没有意义，
     所以这里只呈现当前这一位，但记录本身照样带 cid（换多梦角时不用改形状）。 */
  function callRowNode(log) {
    const C = window.Call44;
    const mine = log.dir !== 'in';
    const row = el('div', 'call-row' + (log.st === 'missed' ? ' miss' : ''));
    const ic = el('span', 'call-row-ic');
    ic.append(icon('phone'));
    const body = el('span', 'call-row-body');
    body.append(el('strong', '', mine ? '我打给梦角' : '梦角打来'));
    const when = new Date(log.ts);
    const stamp = when.getMonth() + 1 + '月' + when.getDate() + '日 ' +
      pad2(when.getHours()) + ':' + pad2(when.getMinutes());
    body.append(el('small', '', (C.CALL_ST_TXT[log.st] || '') + ' · ' + stamp));
    const right = el('span', 'call-row-right', log.st === 'connected' ? C.formatDur(log.sec) : (C.CALL_ST_TXT[log.st] || ''));
    row.append(ic, body, right);
    return row;
  }
  function renderCallsPage() {
    const C = window.Call44;
    if (!C) return;
    const box = $('#call-stat');
    const list = $('#call-list');
    if (!box || !list) return;
    const calls = state.calls || [];
    const stats = C.statsOf(calls, Date.now());
    box.replaceChildren();
    [['通话次数', String(stats.n)], ['接听', String(stats.ok)], ['未接', String(stats.miss)], ['总时长', C.formatDur(stats.sec)]]
      .forEach(([label, value]) => {
        const cell = el('div', 'call-stat-cell');
        cell.append(el('b', '', value), el('span', '', label));
        box.append(cell);
      });
    list.replaceChildren(...calls.slice(0, 60).map(callRowNode));
    $('#call-count').textContent = calls.length + ' 条';
    $('#call-empty').hidden = calls.length > 0;
    const dial = $('#call-dial');
    if (dial) {
      const label = dial.lastChild;
      const name = state.peerName || '梦角';
      if (label && label.nodeType === 3) label.nodeValue = '打电话给' + name;
    }
  }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* ---------------- 图片通道：头像方形裁切 / 背景保比例 ---------------- */
  function requestImage(kind, done) {
    imageRequest = { kind, done };
    $('#avatar-file').value = '';
    $('#avatar-file').click();
  }
  function compress(file, kind) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (kind === 'background') {
            const scale = Math.min(1, 1100 / image.naturalWidth);
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
          } else {
            const side = Math.min(image.naturalWidth, image.naturalHeight);
            if (!side) throw new Error('empty');
            const target = Math.min(240, side);
            canvas.width = canvas.height = target;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, target, target);
            context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, target, target);
          }
          resolve(canvas.toDataURL('image/jpeg', 0.87));
        } catch (error) { reject(error); } finally { URL.revokeObjectURL(url); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      image.src = url;
    });
  }
  $('#avatar-file').addEventListener('change', event => {
    const file = event.target.files[0];
    const request = imageRequest;
    imageRequest = null;
    if (!file || !request) return;
    const error = model.validateImage(file);
    if (error) { toast(error); return; }
    compress(file, request.kind).then(dataUrl => {
      if (request.done) request.done(dataUrl);
    }).catch(() => toast('这张图片暂时无法读取，请换一张 JPG 或 PNG 图片。'));
  });
  /* 换头像要同时刷新两处：顶栏/菜单的 [data-avatar]，以及聊天流里每条消息旁的头像。
     后者是 chat.js 渲染时写死的 <img>，只有重画消息流才会跟着换（不改这里就是「顶栏换了、聊天里没换」）。 */
  function updateAvatar(which, dataUrl) {
    state = Object.assign({}, state, { [which + 'Avatar']: dataUrl });
    save();
    refreshChrome();
    if (chat) chat.render(false);
  }
  function updateWall(dataUrl) {
    state = Object.assign({}, state, { walls: { chat: dataUrl } });
    save();
    applyAppearance();
  }

  /* ---------------- 数据管理 ---------------- */
  function downloadText(name, text) {
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch { return false; }
  }
  /* 字卡库导出：全部分组 + 范围；「导出字卡时带上拍一拍动作池」打开时一并带走（工单第2单#5）。 */
  function exportCards() {
    const payload = model.exportCards(state.cardLib, { pokes: state.settings.exportPokes ? state.pokes : [] });
    if (downloadText('慢慢说-字卡-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(payload, null, 2))) toast('字卡已导出。');
    else toast('导出失败了，请换一个浏览器再试。');
  }
  /* 字卡库导入：单梦角没有第二个范围可挑，读完文件直接确认一次（工单第2单附加规范 5.1 的确认步骤保留）。 */
  function openCardImport() { $('#card-file').value = ''; $('#card-file').click(); }
  function askImportTarget(parsed, cards) {
    const count = cards.groups.reduce((n, g) => n + g.items.length, 0) + cards.ungrouped.length;
    const summary = (cards.groups.length ? cards.groups.length + ' 个分组、' : '') + count + ' 张字卡' +
      (cards.pokes.length ? '、' + cards.pokes.length + ' 条拍一拍' : '');
    confirmSheet({
      title: '导入这份字卡？',
      text: '认出 ' + summary + '。同名分组会并进去，重复的字卡自动跳过。',
      confirmLabel: '导入',
      onConfirm() { applyCardImport(parsed, cards); }
    });
  }
  function applyCardImport(parsed, cards) {
    const merged = model.mergeImportedCards(state.cardLib, 'public', cards, model.newId);
    if (!merged.ok) { toast('这些字卡已经在库里了，没有新增。'); return; }
    let next = Object.assign({}, state, { cardLib: merged.lib });
    let pokeAdded = 0;
    if (cards.pokes.length) {
      const pool = (next.pokes || []).slice();
      cards.pokes.forEach(p => { if (!pool.includes(p)) { pool.push(p); pokeAdded += 1; } });
      next = Object.assign({}, next, { pokes: model.normPokes(pool) });
    }
    persist(next);
    cardlib.render();
    refreshChrome();
    const notes = ['导入 ' + merged.report.cards + ' 张字卡'];
    if (merged.report.groups) notes.push(merged.report.groups + ' 个新分组');
    if (pokeAdded) notes.push(pokeAdded + ' 条拍一拍');
    if (merged.report.skipped) notes.push(merged.report.skipped + ' 张重复已跳过');
    toast(notes.join(' / ') + '。');
  }
  $('#card-file').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(String(reader.result)); }
      catch { toast('这份文件读不出来，换一份 JSON 备份再试。'); return; }
      const cards = model.importCards(parsed);
      if (!cards.source || cards.source === 'none') { toast('没有找到可导入的字卡或拍一拍。'); return; }
      askImportTarget(parsed, cards);
    };
    reader.onerror = () => toast('这份文件读不出来，换一份 JSON 备份再试。');
    reader.readAsText(file);
  });

  function exportBackup() {
    try {
      const payload = JSON.stringify({ app: 'slowly-chat-order44', v: 1, exportedAt: new Date().toISOString(), state }, null, 2);
      if (!downloadText('慢慢说-备份-' + new Date().toISOString().slice(0, 10) + '.json', payload)) throw new Error('download');
      toast('备份已导出。');
    } catch { toast('导出失败了，请换一个浏览器再试。'); }
  }
  function applyImported(next) {
    state = next;
    save();
    cardlib.reset();
    chat.render(true);
    refreshChrome();
    if (viewStack[viewStack.length - 1].page === 'settings') settings.render();
    toast('备份已导入。');
  }
  $('#backup-file').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const raw = parsed && parsed.state ? parsed.state : parsed;
        const next = model.normalizeState(raw);
        confirmSheet({ title: '导入这份备份？', text: '导入会替换掉现在的聊天记录、字卡库与设置。', confirmLabel: '导入', onConfirm() { applyImported(next); } });
      } catch { toast('这份文件读不出来，换一份备份再试。'); }
    };
    reader.onerror = () => toast('这份文件读不出来，换一份备份再试。');
    reader.readAsText(file);
  });
  function resetAll() {
    try { localStorage.removeItem(storageKey); } catch { /* 忽略：清不掉也要继续重置内存 */ }
    state = model.createState();
    save();
    cardlib.reset();
    closeToChat();
    chat.render(true);
    refreshChrome();
    renderSkinGrid();
    toast('已经回到刚打开时的样子。');
  }

  /* ---------------- 宿主接口 ---------------- */
  const host = {
    getState: () => state,
    persist,
    newId: model.newId,
    toast,
    refresh: refreshChrome,
    onUnread: updateUnread,
    isChatVisible: () => !$('#chat-view').hidden,
    closeDetail: closeToChat,
    resizeInput,
    confirm: confirmSheet,
    prompt: promptSheet,
    choose: chooseSheet,
    openSheet: showSheet,
    closeSheet,
    sheetButton,
    sendChoice: draft => chat.sendChoice(draft),
    quote: msg => setPendingQuote(msg),
    exportCards: () => exportCards(),
    importCards: () => openCardImport(),
    clearQuote() { pendingQuote = null; renderQuoteBar(); },
    getPendingQuote: () => pendingQuote,
    requestImage,
    updateAvatar,
    updateWall,
    exportBackup,
    importBackup: () => { $('#backup-file').value = ''; $('#backup-file').click(); },
    resetAll,
    setSetting(key, value) {
      state = model.setSetting(state, key, value);
      save();
      if (chat) chat.settingsChanged();
    },
    setProfile(key, value) {
      const next = model.cleanText(value, 24);
      if (!next) return;
      state = Object.assign({}, state, { [key]: next });
      save();
      refreshChrome();
    },
    setShowTime(value) {
      state = Object.assign({}, state, { showTime: !!value });
      save();
      applyAppearance();
    },
    updateAppearance: applyAppearance
  };

  cardlib = window.SlowCardLib.init(host);
  settings = window.SlowSettings.init(host);
  decision = window.SlowDecision.init(host);
  chat = window.SlowChat.init(host);
  /* 通话控制器：宿主只提供状态读写、toast、聊天重画与 TA 补话这几条缝，
     业务（四结局/计时/来电/小窗）全在 call.js 里，不散回 app.js。 */
  call = window.Call44.init({
    getState: () => state,
    persist: next => { if (next) { state = next; save(); } return true; },
    newId: model.newId,
    toast,
    renderChat: force => chat.render(force),
    renderCallsPage,
    peerLine(text, delay) {
      if (typeof text !== 'string' || !text) return;
      setTimeout(() => {
        const next = model.appendPeerMessage(state, { id: model.newId('m'), text, date: new Date().toISOString() });
        if (next && persist(next)) { chat.render(false); }
      }, Math.max(0, Number(delay) || 0));
    },
    prepare() { closeSheet(); closeToChat(); toggleEmoji(false); },
    isChatVisible: () => !$('#chat-view').hidden && viewStack.length === 1,
    closeDetail: () => { if (viewStack.length > 1) closeToChat(); }
  });
  chat.setTickSink(() => call.tick());
  chat.startHeartbeat();
  /* 验收用的只读/测试把手：不改变产品行为，供浏览器冒烟脚本钉住概率与时序。 */
  window.SlowApp = { getState: () => state, chat, cardlib, settings, decision, call, setSetting: host.setSetting, setProfile: host.setProfile, setShowTime: host.setShowTime, closeToChat, navigate, quote: setPendingQuote, get pendingQuote() { return pendingQuote; }, exportCards, applyCardImport, askImportTarget, renderCallsPage };

  /* ---------------- 绑定 ---------------- */
  $('#peer-avatar-button').addEventListener('click', () => {
    toggleProfile(false);
    requestImage('avatar-peer', dataUrl => { updateAvatar('peer', dataUrl); toast('梦角头像已更换'); });
  });
  $('#self-avatar-button').addEventListener('click', () => {
    toggleProfile(false);
    requestImage('avatar-self', dataUrl => { updateAvatar('self', dataUrl); toast('我的头像已更换'); });
  });
  $('#menu-open').addEventListener('click', () => {
    returnFocus = $('#menu-open');
    toggleProfile(false);
    toggleQuick(false);
    viewStack.push({ type: 'menu' });
    showCurrent();
  });
  $('#more-open').addEventListener('click', () => { toggleProfile($('#profile-menu').hidden); toggleQuick(false); });
  $('#quick-toggle').addEventListener('click', () => { toggleQuick($('#quick-actions').hidden); toggleProfile(false); });
  $$('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page, button)));
  $$('[data-close]').forEach(button => button.addEventListener('click', closeToChat));
  $('#detail-back').addEventListener('click', () => { if (viewStack.length > 1) viewStack.pop(); showCurrent(); });
  document.addEventListener('click', event => { if (!event.target.closest('.more-wrap')) toggleProfile(false); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('#emoji-picker').hidden) { toggleEmoji(false); $('#emoji-open').focus(); return; }
    if (sheetOpen) { closeSheet(); return; }
    if (!$('#profile-menu').hidden) { toggleProfile(false); $('#more-open').focus(); }
    else if (viewStack.length > 1) { viewStack.pop(); showCurrent(); }
    else { toggleQuick(false); $('#quick-toggle').focus(); }
  });
  $('#message-input').addEventListener('input', resizeInput);
  $('#message-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#message-input');
    if (!input.value.trim()) return;
    const draft = { text: input.value };
    if (pendingQuote) { draft.quote = '引用 ' + pendingQuote.target + '：' + pendingQuote.text; draft.qid = pendingQuote.id; }
    if (chat.send(draft)) {
      input.value = '';
      resizeInput();
      toggleQuick(false);
      if (pendingQuote) { pendingQuote = null; renderQuoteBar(); }
      input.focus();
    }
  });
  $$('[data-background]').filter(button => button.tagName === 'BUTTON').forEach(button => button.addEventListener('click', () => {
    state = Object.assign({}, state, { background: button.dataset.background });
    save();
    applyAppearance();
  }));
  $$('[data-font]').forEach(button => button.addEventListener('click', () => {
    state = Object.assign({}, state, { fontSize: Number(button.dataset.font) });
    save();
    applyAppearance();
  }));
  $('#bub-range').addEventListener('input', event => setBubScale(event.target.value));
  $('#bubble-css-open').addEventListener('click', openBubbleCss);
  $('#bubble-css-reset').addEventListener('click', () => {
    confirmSheet({
      title: '清空自己写的气泡 CSS？', text: '清掉之后气泡回到内置皮肤的样子，这段 CSS 就找不回来了。',
      confirmLabel: '清空', danger: true,
      onConfirm() { setBubbleCss(''); renderSkinGrid(); toast('已清空自己写的 CSS。'); }
    });
  });
  $('#quote-bar-cancel').addEventListener('click', () => { pendingQuote = null; renderQuoteBar(); });
  $('#card-export').addEventListener('click', exportCards);
  $('#card-import').addEventListener('click', openCardImport);

  /* 决策入口在「更多功能」，不是独立页；历史页空态也能直接开抉择。 */
  $('#quick-decision').addEventListener('click', () => { toggleQuick(false); decision.open(); });
  $('#history-empty-cta').addEventListener('click', () => decision.open());

  /* 44：主题、气泡配色与表情均独立于聊天存档内容，不改变输入草稿。 */
  function toggleEmoji(open) {
    $('#emoji-picker').hidden = !open;
    $('#emoji-open').setAttribute('aria-expanded', String(open));
  }
  ['♡', '☺', '☾', '✧', '☀', '☁', '♪', '✿', '（抱抱）', '（点头）', '（晚安）', '（想你）'].forEach(text => {
    const button = el('button', '', text); button.type = 'button'; button.setAttribute('aria-label', '插入 ' + text);
    button.addEventListener('click', () => {
      const input = $('#message-input');
      if (input.value.length + text.length > input.maxLength) { toast('输入框已满，请先发送一部分。'); return; }
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      resizeInput(); input.focus(); toggleEmoji(false);
    });
    $('#emoji-picker').append(button);
  });
  $('#emoji-open').addEventListener('click', () => { const open = $('#emoji-picker').hidden; toggleQuick(false); toggleProfile(false); toggleEmoji(open); });
  document.addEventListener('click', event => { if (!event.target.closest('#emoji-picker, #emoji-open')) toggleEmoji(false); });
  $('#call-open').addEventListener('click', () => call.open());
  $('#quick-call').addEventListener('click', () => call.open());
  $('#call-dial').addEventListener('click', () => call.dial());
  $('#call-incoming').addEventListener('click', () => {
    if (!call.incoming()) toast(state.settings.callOn && state.settings.callInOn ? '正在通话中，先结束这一通' : '先把模拟通话与 TA 主动来电打开');
  });
  $$('[data-theme-choice]').forEach(button => button.addEventListener('click', () => { state = { ...state, theme: button.dataset.themeChoice }; save(); applyAppearance(); }));
  window.Appearance44.palettes.forEach(palette => {
    const button = el('button', 'palette-option'); button.type = 'button'; button.dataset.palette = palette.id;
    const swatch = el('span', 'palette-swatch');
    const sample = el('i');
    const colors = window.Appearance44.colors(state.theme, palette.id);
    sample.style.background = colors.selfBackground;
    if (palette.border) {
      sample.style.border = colors.selfBorderWidth + ' solid ' + colors.selfBorder;
      sample.style.boxShadow = colors.selfShadow;
    }
    swatch.append(sample); button.append(swatch, el('small', '', palette.name));
    button.addEventListener('click', () => { state = { ...state, palette: palette.id }; save(); applyAppearance(); });
    $('#palette-options').append(button);
  });

  /* 软键盘：视口被顶起时把输入区抬进可视区（工单第1单#13，visualViewport）。 */
  (function keyboardGuard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const app = $('#app');
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      app.style.setProperty('--kb-inset', inset + 'px');
      app.classList.toggle('kb-open', inset > 80);
    };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  })();

  refreshChrome();
  renderSkinGrid();
  resizeInput();
  renderQuoteBar();
  if (loadError) toast('本地记录无法读取，已使用默认界面。');
})();
