(function (root) {
  'use strict';

  /* 单梦角：cid 固定且改名不改它；字卡 scope 用 cid 而不是姓名。 */
  const PEER_ID = 'ta';
  const MAX_MSG = 300;
  const UNCAT = '未分组';
  const IMAGE_MAX = 1500000;
  const WALL_MAX = 2200000;
  const IMPORT_MAX_CARDS = 5000;
  const STORE_KEY = 'slowly-chat-order44-v1';

  const pad = value => String(value).padStart(2, '0');
  function formatTime(date = new Date()) {
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
  }
  /* 气泡大小（照 18 的第 29 单）：百分比 20~100，100 = 标准，也是上限 —— 即改动前的样子。
     只作用在聊天气泡上（字号 / 留白 / 最大宽度 / 小尾巴一起缩放），不动别的界面。
     写成 CSS 变量 --bub-k 由样式表 calc() 相乘，默认档 1 与改动前逐像素一致。 */
  const BUB_MIN = 20;
  const BUB_MAX = 100;
  const BUB_DEF = 100;
  function bubClamp(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return BUB_DEF;   /* ''/null/NaN 走默认，别被 +''=0 夹成下限 */
    return Math.max(BUB_MIN, Math.min(BUB_MAX, n));
  }
  function bubLabel(v) {
    const n = bubClamp(v);
    if (n <= 35) return '很小';
    if (n <= 60) return '偏小';
    if (n <= 85) return '接近标准';
    return '标准';
  }

  /* 时间分隔条：双方静默满 30 分钟后再来消息，就在那条消息上方插一条「时间 + 小字」。
     只在渲染时算，不写进消息里 —— 旧记录照样能补出分隔，删掉消息也不会留下孤儿分隔。 */
  const TIME_GAP = 30 * 60 * 1000;
  const GAP_NOTE = '未讀信息';
  function gapText(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 ' + formatTime(d).slice(0, 5);
  }
  /* 哪些消息上方要加分隔：第一条、以及比上一条晚满 30 分钟的 */
  function gapFlags(list, gap = TIME_GAP) {
    const out = [];
    let prev = NaN;
    (Array.isArray(list) ? list : []).forEach((m, i) => {
      const t = m && m.date ? new Date(m.date).getTime() : NaN;
      const first = i === 0;
      out.push(first || (!Number.isNaN(t) && !Number.isNaN(prev) && t - prev >= gap));
      if (!Number.isNaN(t)) prev = t;
    });
    return out;
  }

  function newId(prefix = 'm') {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  const cleanText = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const clampInt = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const isImage = (v, max = IMAGE_MAX) => typeof v === 'string' && v.length < max && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v);

  /* ---------------- 设置（聊天底盘参数 + 资料） ----------------
     每条：默认值 / 允许范围。0 表示关闭的键必须尊重 0，不能回落成默认值。 */
  const SETTINGS = {
    replyMin: { def: 3, min: 0, max: 60, label: '回复最短延迟', unit: '秒' },
    replyMax: { def: 12, min: 0, max: 120, label: '回复最长延迟', unit: '秒' },
    cardMin: { def: 1, min: 1, max: 10, label: '拼字卡最少张数', unit: '张' },
    cardMax: { def: 4, min: 1, max: 10, label: '拼字卡最多张数', unit: '张' },
    readNoP: { def: 20, min: 0, max: 100, label: '已读不回概率', unit: '%' },
    quoteProb: { def: 30, min: 0, max: 100, label: 'TA 引用我消息的概率', unit: '%' },
    exportPokes: { def: 1, min: 0, max: 1, label: '导出字卡时带上拍一拍动作池' },
    recallProb: { def: 10, min: 0, max: 100, label: 'TA 撤回概率', unit: '%' },
    recShow: { def: 1, min: 0, max: 1, label: '显示撤回了什么' },
    pokeBack: { def: 40, min: 0, max: 100, label: '回拍概率', unit: '%' },
    pokeReplyProb: { def: 20, min: 0, max: 100, label: '回复变拍一拍概率', unit: '%' },
    pokeMsgProb: { def: 20, min: 0, max: 100, label: '主动消息变拍一拍概率', unit: '%' },
    autoOn: { def: 1, min: 0, max: 1, label: 'TA 会主动找我' },
    autoMin: { def: 30, min: 1, max: 1440, label: '主动消息最短间隔', unit: '分钟' },
    autoMax: { def: 90, min: 1, max: 1440, label: '主动消息最长间隔', unit: '分钟' },
    /* 语音通话（模拟）8 项：开关 3 / 概率 3 / 检查秒数 1 / 来电间隔 1 对。
       呼出四结局的口径：忙线 → 拒接 → 接通 依次占掉概率，**剩下的部分才是「无人接听」**，
       所以三个概率之和不足 100 时差额自动落到无人接听，不用另设一项。 */
    callOn: { def: 1, min: 0, max: 1, label: '模拟通话总开关' },
    callInOn: { def: 1, min: 0, max: 1, label: 'TA 会主动打电话来' },
    callBusyP: { def: 10, min: 0, max: 100, label: '呼出时对方忙线概率', unit: '%' },
    callRejectP: { def: 15, min: 0, max: 100, label: '呼出时对方拒接概率', unit: '%' },
    callAnswerP: { def: 75, min: 0, max: 100, label: '呼出时接通概率', unit: '%' },
    callHangOn: { def: 1, min: 0, max: 1, label: '接通后 TA 可能中途挂断' },
    callHgSec: { def: 30, min: 5, max: 600, label: '中途挂断的检查间隔', unit: '秒' },
    callInMin: { def: 60, min: 1, max: 1440, label: 'TA 来电最短间隔', unit: '分钟' },
    callInMax: { def: 240, min: 1, max: 1440, label: 'TA 来电最长间隔', unit: '分钟' }
  };
  const SETTING_KEYS = Object.keys(SETTINGS);

  function normSettings(input) {
    const s = input && typeof input === 'object' ? input : {};
    const out = {};
    SETTING_KEYS.forEach(key => { out[key] = clampInt(s[key], SETTINGS[key].def, SETTINGS[key].min, SETTINGS[key].max); });
    if (out.replyMax < out.replyMin) out.replyMax = out.replyMin;
    if (out.cardMax < out.cardMin) out.cardMax = out.cardMin;
    if (out.autoMax < out.autoMin) out.autoMax = out.autoMin;
    if (out.callInMax < out.callInMin) out.callInMax = out.callInMin;
    return out;
  }
  function setSetting(state, key, value) {
    if (!SETTING_KEYS.includes(key)) return state;
    return Object.assign({}, state, { settings: normSettings(Object.assign({}, state.settings, { [key]: value })) });
  }

  /* ---------------- 气泡皮肤 + 自定义 CSS ----------------
     两套来源，可以叠加：
     ① bubbleSkin：内置皮肤，写在 BUBBLE_SKINS 里，是本站自己的 CSS，不进用户输入路径；
     ② bubbleCss：用户自己写 / 上传的 CSS（照参考站的做法：清洗后挂到独立的 <style> 上）。
     两者同时存在时用户 CSS 节点在后，同特异性下后写的胜 —— 也就是「自己传的盖过内置皮肤」。
     ⚠️ 写入永远只走 <style>.textContent：浏览器对 textContent 不做 HTML 解析，
        「</style><script>」只会变成一段无效 CSS，逃不成标签。 */
  const BUBBLE_MAX = 8000;
  const USER_CSS_SCOPE = '#app';
  const BACKSLASH = String.fromCharCode(92);
  const IMPORTANT_RE = /!\s*important\s*$/i;

  /* 内置皮肤：id / 名字 / CSS / 选择器里那颗小样块的内联样式（跟 CSS 是同一套观感）。
     CSS 用站内真实类名写，渲染时统一加作用域前缀，再写进独立的 <style>。 */
  const BUBBLE_SKINS = [
    {
      id: 'classic', name: '经典',
      swatch: 'background:#fff;border-radius:3px 12px 12px 12px;border:1px solid #ececec',
      css: ''
    },
    {
      id: 'round', name: '圆润',
      swatch: 'background:#fff;border-radius:16px;border:1px solid #f1f1f1;box-shadow:0 2px 10px #00000014',
      css: [
        '.bubble { border-radius: 18px; padding: 12px 16px; border: 1px solid #f1f1f1; box-shadow: 0 2px 10px #0000000d; }',
        '.bubble::before { display: none; }',
        '.self .bubble { border-color: transparent; box-shadow: 0 2px 12px #0000001f; }'
      ].join('\n')
    },
    {
      id: 'paper', name: '信纸',
      swatch: 'background:#fffdf6;border-radius:2px;border:1px solid #e6ddc8',
      css: [
        '.bubble { background: #fffdf6; border: 1px solid #e6ddc8; border-radius: 2px; color: #4a4034; box-shadow: 0 1px 0 #efe8d8; }',
        '.bubble::before { display: none; }',
        '.self .bubble { background: #f3eddd; border-color: #ddd2b6; color: #4a4034; }'
      ].join('\n')
    },
    {
      id: 'glass', name: '雾面',
      swatch: 'background:#ffffffd9;border-radius:14px;border:1px solid #fff',
      css: [
        '.bubble { background: #ffffffb8; border: 1px solid #ffffff; border-radius: 16px; box-shadow: 0 6px 20px #0000000f; backdrop-filter: blur(14px) saturate(1.35); -webkit-backdrop-filter: blur(14px) saturate(1.35); }',
        '.bubble::before { display: none; }',
        '.self .bubble { background: #303030c4; border-color: #ffffff2e; }'
      ].join('\n')
    },
    {
      id: 'ink', name: '墨线',
      swatch: 'background:#fff;border-radius:7px;border:1.5px solid #2b2b2b;box-shadow:3px 3px 0 #2b2b2b',
      css: [
        '.bubble { background: #fff; border: 1.5px solid #2b2b2b; border-radius: 8px; box-shadow: 3px 3px 0 #2b2b2b; }',
        '.bubble::before { display: none; }',
        '.self .bubble { background: #2b2b2b; border-color: #2b2b2b; box-shadow: 3px 3px 0 #d2d2d2; }'
      ].join('\n')
    },
    {
      id: 'pill', name: '药丸',
      swatch: 'background:#fff;border-radius:999px;border:1px solid #ececec',
      css: [
        '.bubble { border-radius: 999px; padding: 11px 20px; border: 1px solid #ececec; }',
        '.bubble::before { display: none; }',
        '.self .bubble { border-color: transparent; }'
      ].join('\n')
    }
  ];

  function bubbleSkinCss(id) {
    const hit = BUBBLE_SKINS.find(skin => skin.id === id);
    return hit ? hit.css : '';
  }

  /* 按分隔符切，跳过括号内与引号内的分隔符：选择器里会有 :is(.a,.b)，
     声明值里会有 url(data:image/png;base64,…)，硬 split 会把它们切碎。 */
  function splitTop(str, sep) {
    const out = [];
    let buf = '', depth = 0, quote = '';
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charAt(i);
      if (quote) {
        buf += c;
        if (c === BACKSLASH) { if (i + 1 < str.length) { buf += str.charAt(i + 1); i += 1; } }
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") { quote = c; buf += c; continue; }
      if (c === '(' || c === '[') { depth += 1; buf += c; continue; }
      if (c === ')' || c === ']') { depth -= 1; buf += c; continue; }
      if (c === sep && depth <= 0) { out.push(buf); buf = ''; continue; }
      buf += c;
    }
    out.push(buf);
    return out;
  }

  /* 外面抄来的聊天 CSS 基本都用 .msg-bubble / .msg-in 这类类名，在本站一个都不存在 ——
     不映射用户看到的就是「贴了等于没贴」。这里只改写选择器里的类名，声明体一个字节不碰。
     ⚠️ key 绝不能等于本站自己的类名，否则用户写 .bubble{…} 也会被改写。 */
  const USER_CSS_DICT = {
    'msg-bubble': '.bubble', 'message-bubble': '.bubble', 'chat-bubble': '.bubble',
    'bubble': '.bubble', 'bubble-content': '.bubble', 'message__bubble': '.bubble',
    'msg-text': '.bubble', 'message-text': '.bubble', 'bubble-text': '.bubble',
    'msg-body': '.bubble', 'message-body': '.bubble', 'msg-content': '.bubble', 'message': '.bubble',
    'msg-row': '.message-row', 'chat-row': '.message-row', 'msg-line': '.message-row',
    'message-line': '.message-row', 'msg-item': '.message-row', 'message-item': '.message-row',
    'chat-message': '.message-row',
    'msg-in': '.message-row.peer', 'incoming': '.message-row.peer', 'from-other': '.message-row.peer',
    'from-ta': '.message-row.peer', 'from-them': '.message-row.peer', 'msg-left': '.message-row.peer',
    'chat-in': '.message-row.peer', 'is-in': '.message-row.peer',
    'msg-out': '.message-row.self', 'outgoing': '.message-row.self', 'from-me': '.message-row.self',
    'from-self': '.message-row.self', 'msg-right': '.message-row.self',
    'chat-out': '.message-row.self', 'is-out': '.message-row.self',
    'received': '.message-row.peer .bubble', 'recv': '.message-row.peer .bubble',
    'message-received': '.message-row.peer .bubble', 'msg-received': '.message-row.peer .bubble',
    'bubble-in': '.message-row.peer .bubble', 'bubble-left': '.message-row.peer .bubble',
    'sent': '.message-row.self .bubble', 'sent-msg': '.message-row.self .bubble',
    'message-sent': '.message-row.self .bubble', 'msg-sent': '.message-row.self .bubble',
    'bubble-out': '.message-row.self .bubble', 'bubble-right': '.message-row.self .bubble',
    'avatar': '.message-avatar', 'av': '.message-avatar', 'user-avatar': '.message-avatar',
    'chat-avatar': '.message-avatar', 'msg-avatar': '.message-avatar', 'avatar-img': '.message-avatar',
    'portrait': '.message-avatar',
    'msg-time': '.message-meta', 'message-time': '.message-meta', 'timestamp': '.message-meta',
    'msg-date': '.message-meta', 'bubble-time': '.message-meta', 'msg-status': '.message-receipt',
    'msg-meta': '.message-meta',
    'chat-messages': '.messages', 'message-list': '.messages', 'thread': '.messages',
    'chat-body': '.messages', 'messages-wrap': '.messages'
  };

  const dictLookup = cls => USER_CSS_DICT[String(cls).toLowerCase()] || '';

  function rewriteSelectorChunk(text) {
    const s = String(text).replace(/\.(-?[A-Za-z_][-\w]*)/g, (all, name) => dictLookup(name) || all);
    /* 复合选择器修正：外来的 .message.message-sent 是「同一个元素上两个类」，
       而本站「气泡」与「方向」分属两个元素。逐词改写会得到 .bubble.message-row.self（永不匹配），
       改成后代形式 .message-row.self .bubble。三条 replace 的顺序不能换。 */
    return s
      .replace(/\.bubble\.message-row\.(self|peer)\s+\.bubble/g, '.message-row.$1 .bubble')
      .replace(/\.bubble\.message-row\.(self|peer)/g, '.message-row.$1 .bubble')
      .replace(/\.message-row\.(self|peer)\.bubble/g, '.message-row.$1 .bubble');
  }

  /* 整条选择器列表逐条加作用域前缀。加了之后特异性变成 (1,x,x)：压过站内所有类选择器，
     用户不带 !important 也能生效（这是「贴了不生效」最常见的一枪）。 */
  function scopeSelectorList(prelude) {
    return splitTop(prelude, ',').map(part => {
      const one = part.trim();
      return one ? USER_CSS_SCOPE + ' ' + one : '';
    }).filter(Boolean).join(', ');
  }

  /* 裸声明入口（整段没有 {）逐条补 !important：这个入口用户写不了 !important，由应用替他加。
     写了选择器的入口不加 —— 既然用户自己定义了选择器，层叠控制权就还给他。 */
  function forceImportant(decls) {
    return splitTop(String(decls), ';').map(one => {
      const text = one.trim();
      if (!text) return '';
      return IMPORTANT_RE.test(text) ? text : text + ' !important';
    }).filter(Boolean).join(';');
  }

  /* 把用户 CSS 改成「能真的打到本站 DOM」的样子：加作用域 + 映射类名。
     只动选择器前奏；声明体、注释、字符串原样照抄。用栈记上下文：
     @media / @supports 里面仍然是规则，@keyframes 里面是 from/to，@font-face 里面是声明。 */
  function adaptUserCss(css) {
    let s = String(css == null ? '' : css);
    if (!s) return '';
    if (s.indexOf('{') < 0) {
      const bare = forceImportant(s);
      if (!bare) return '';
      s = '.message-row.peer .bubble{' + bare + '}\n.message-row.self .bubble{' + bare + '}';
    }
    let out = '', buf = '', i = 0;
    const stack = [];
    let st = { decl: false, scope: true };
    const n = s.length;
    const flush = () => {
      if (st.decl) out += buf;
      else if (st.scope && !/^\s*@/.test(buf)) out += scopeSelectorList(rewriteSelectorChunk(buf));
      else out += rewriteSelectorChunk(buf);
      buf = '';
    };
    while (i < n) {
      const c = s.charAt(i);
      if (c === '/' && s.charAt(i + 1) === '*') {
        const end = s.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        buf += s.slice(i, stop); i = stop; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && s.charAt(j) !== c) { if (s.charAt(j) === BACKSLASH) j += 1; j += 1; }
        j = Math.min(j + 1, n);
        buf += s.slice(i, j); i = j; continue;
      }
      if (c === '{') {
        const pre = buf;
        flush(); out += '{'; i += 1; stack.push(st);
        if (!/^\s*@/.test(pre)) st = { decl: true, scope: false };
        else if (/^\s*@(-\w+-)?keyframes\b/i.test(pre)) st = { decl: false, scope: false };
        else if (/^\s*@(-\w+-)?(font-face|page|counter-style|property|font-feature-values)\b/i.test(pre)) st = { decl: true, scope: false };
        else st = { decl: false, scope: true };
        continue;
      }
      if (c === '}') { flush(); out += '}'; i += 1; st = stack.length ? stack.pop() : { decl: false, scope: true }; continue; }
      buf += c; i += 1;
    }
    flush();
    return out;
  }

  /* 清洗用户 CSS：整页 HTML 只取 <style>；拦 @import；限长；摘掉 html/body/:root 框架规则。
     ⚠️ 故意不拦 url(http(s)…)：用户贴的皮肤 CSS 里挂件几乎都是网络图，
        拦掉的表现是「挂了等于没挂、还看不出为什么」。想离线自带请用 data: 图。 */
  function sanitizeUserCss(value) {
    if (typeof value !== 'string') return '';
    let text = value;
    if (/<\s*(?:!doctype|html|head|body|style)\b/i.test(text)) {
      const blocks = [];
      const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
      let m;
      while ((m = re.exec(text))) blocks.push(m[1]);
      text = blocks.length ? blocks.join('\n') : text.replace(/<[^>]*>/g, '\n');
    }
    text = text.slice(0, BUBBLE_MAX);
    text = text.replace(/@import[^;]*(;|$)/gi, '');
    const frameworkRe = /(^|[};])\s*(?:html|body|:root)\s*\{[^{}]*\}/i;
    let guard = 0;
    while (frameworkRe.test(text) && guard < 20) { text = text.replace(frameworkRe, '$1'); guard += 1; }
    return text;
  }

  /* ---------------- 拍一拍动作池 ----------------
     视角约定：短语是「我拍 TA」时说的话，'你' 指对方；TA 拍我时把「你」换成「我」。 */
  const POKE_DEFAULT = [
    '拍了拍你的肩', '戳了戳你的脸颊', '捏了捏你的手指', '揉了揉你的头发',
    '把一颗糖放进你口袋', '轻轻抱住你', '在你肩上靠了一会儿', '拉了拉你的袖子',
    '摸了摸你的头', '把热牛奶放在你手边', '在你手心画了一颗心', '替你理了理衣领',
    '把耳机分你一只', '在你耳边说了句悄悄话', '用围巾把你裹起来', '拍了拍你的背'
  ];
  function normPokes(v) {
    /* 缺失/非数组才用默认池；空数组是用户删光的合法状态，不偷偷塞回默认动作。 */
    if (!Array.isArray(v)) return POKE_DEFAULT.slice();
    return [...new Set(v.map(x => cleanText(x, 60)).filter(Boolean))].slice(0, 200);
  }
  function setPokes(state, list) {
    return Object.assign({}, state, { pokes: normPokes(list) });
  }
  function pokeLine(state, from, phrase) {
    const peer = state.peerName || '对方';
    const actor = from === 'self' ? (state.selfName || '我') : peer;
    const target = from === 'self' ? peer : (state.selfName || '我');
    const p = cleanText(phrase, 60);
    if (!p) return actor + ' 拍了拍 ' + target;
    return actor + ' ' + (from === 'self' ? p : p.replace(/你/g, '我'));
  }

  /* ---------------- 字卡库：一套字卡 + 分组（单梦角，不再分两级范围） ---------------- */
  const SEED_GROUPS = [
    { id: 'g-daily', name: '日常', scope: 'public', items: [
      { id: 'c-d1', text: '今天，\n有没有好好吃饭？' },
      { id: 'c-d2', text: '普通的一天，\n因为你变得特别。' }
    ] },
    { id: 'g-miss', name: '想念', scope: 'public', items: [
      { id: 'c-m1', text: '没什么特别的事，\n只是想你了。' },
      { id: 'c-m2', text: '想把今天的月亮，\n也分一半给你。' }
    ] },
    { id: 'g-keep', name: '陪伴', scope: 'public', items: [
      { id: 'c-k1', text: '你慢慢说，\n我一直都在。' },
      { id: 'c-k2', text: '不用每次都很勇敢，\n偶尔也可以靠过来。' },
      { id: 'c-k3', text: '那些没说出口的话，\n我也愿意听。' }
    ] },
    { id: 'g-night', name: '晚安', scope: 'public', items: [
      { id: 'c-n1', text: '晚安。\n明天也要见面。' }
    ] },
    { id: 'g-uncat-public', name: UNCAT, scope: 'public', items: [] }
  ];
  function seedGroups() {
    return SEED_GROUPS.map(g => ({ id: g.id, name: g.name, scope: 'public', hidden: false, items: g.items.map(it => ({ id: it.id, text: it.text })) }));
  }

  function normCard(it) {
    if (!it || typeof it !== 'object') return null;
    const id = cleanText(it.id, 80), text = cleanText(it.text, 300);
    if (!id || !text) return null;
    return { id, text };
  }
  function normGroup(g, seenGroups, seenCards) {
    if (!g || typeof g !== 'object') return null;
    const id = cleanText(g.id, 80), name = cleanText(g.name, 40);
    if (!id || !name || seenGroups.has(id)) return null;
    seenGroups.add(id);
    const scope = g.scope === PEER_ID ? PEER_ID : 'public';
    const items = [];
    (Array.isArray(g.items) ? g.items : []).forEach(it => {
      const card = normCard(it);
      if (!card || seenCards.has(card.id)) return;
      seenCards.add(card.id);
      items.push(card);
    });
    return { id, name, scope, hidden: !!g.hidden, items: items.slice(0, 600) };
  }
  /* 单梦角：字卡只有一套，不分「公共 / 专属」。
     旧档里的专属分组在归一化时并进同一套：按名字合并，卡片按 id 去重，范围一律落回 'public'。
     这样老用户升级后卡片一张不丢，也不会多出一组同名的「未分组」。 */
  function normCardLib(input) {
    const lib = input && typeof input === 'object' && Array.isArray(input.groups) ? input : null;
    if (!lib) return { groups: seedGroups() };
    const seenGroups = new Set(), seenCards = new Set();
    const groups = [];
    lib.groups.forEach(g => {
      const group = normGroup(g, seenGroups, seenCards);
      if (!group) return;
      const same = groups.find(x => x.name === group.name);
      if (!same) { groups.push(group); return; }
      group.items.forEach(it => {
        if (!same.items.some(x => x.id === it.id || x.text === it.text)) same.items.push(it);
      });
      same.hidden = same.hidden && group.hidden;
    });
    if (!groups.length) groups.push({ id: 'g-public', name: '默认', scope: 'public', hidden: false, items: [] });
    return { groups: groups.map(g => Object.assign({}, g, { scope: 'public' })) };
  }
  /* 只有一个范围了，scope 形参留着兼容老调用点。 */
  function libGroups(lib) {
    return ((lib && lib.groups) || []).slice();
  }
  function findGroup(lib, gid) { return ((lib && lib.groups) || []).find(g => g.id === gid) || null; }
  function findCard(lib, cid) {
    for (const g of (lib && lib.groups) || []) {
      const card = g.items.find(it => it.id === cid);
      if (card) return { group: g, card };
    }
    return null;
  }
  function ensureUncat(lib, scope) {
    const s = 'public';
    const hit = libGroups(lib, s).find(g => g.name === UNCAT);
    if (hit) return { lib, group: hit };
    const group = { id: 'g-uncat-' + s, name: UNCAT, scope: s, hidden: false, items: [] };
    const next = { groups: (lib.groups || []).concat([group]) };
    return { lib: next, group };
  }
  function libClone(lib) {
    return normCardLib({ groups: (lib.groups || []).map(g => ({ id: g.id, name: g.name, scope: g.scope, hidden: g.hidden, items: g.items.map(it => ({ id: it.id, text: it.text })) })) });
  }
  function libGroupAdd(lib, draft, idFn) {
    const next = libClone(lib), d = draft || {};
    /* 单梦角：新分组只有一个范围，传什么都不再分公共 / 专属。 */
    const name = cleanText(d.name, 40), scope = 'public';
    if (!name) return { ok: false, reason: '分组名字不能为空。', lib: next };
    if (libGroups(next, scope).some(g => g.name === name)) return { ok: false, reason: '已有同名分组。', lib: next };
    const id = cleanText(d.id, 80) || (idFn ? idFn('g') : newId('g'));
    next.groups.push({ id, name, scope, hidden: false, items: [] });
    return { ok: true, lib: next, group: next.groups[next.groups.length - 1] };
  }
  function libGroupRename(lib, gid, name) {
    const next = libClone(lib), g = findGroup(next, gid), value = cleanText(name, 40);
    if (!g) return { ok: false, reason: '找不到这个分组。', lib: next };
    if (g.name === UNCAT) return { ok: false, reason: '「未分组」不能改名。', lib: next };
    if (!value) return { ok: false, reason: '分组名字不能为空。', lib: next };
    if (libGroups(next, g.scope).some(x => x.id !== gid && x.name === value)) return { ok: false, reason: '已有同名分组。', lib: next };
    g.name = value;
    return { ok: true, lib: next };
  }
  function libGroupHide(lib, gid, hidden) {
    const next = libClone(lib), g = findGroup(next, gid);
    if (!g) return { ok: false, reason: '找不到这个分组。', lib: next };
    if (g.name === UNCAT && hidden) return { ok: false, reason: '「未分组」不能隐藏。', lib: next };
    g.hidden = !!hidden;
    return { ok: true, lib: next };
  }
  /* 删分组：默认把组内字卡移进同范围的「未分组」（工单默认）；withCards=true 时连卡一起删。 */
  function libGroupDelete(lib, gid, opts) {
    const o = opts || {}, next = libClone(lib), g = findGroup(next, gid);
    if (!g) return { ok: false, reason: '找不到这个分组。', lib: next };
    if (g.name === UNCAT) return { ok: false, reason: '「未分组」不能删除。', lib: next };
    if (libGroups(next, g.scope).length <= 1) return { ok: false, reason: '至少要留一个分组。', lib: next };
    const cards = g.items.slice();
    if (o.withCards) {
      next.groups = next.groups.filter(x => x.id !== gid);
      return { ok: true, lib: next, moved: 0, deleted: cards.length };
    }
    if (cards.length) {
      const ensured = ensureUncat(next, g.scope);
      const uncat = ensured.group;
      cards.forEach(c => { if (!uncat.items.some(it => it.id === c.id)) uncat.items.push({ id: c.id, text: c.text }); });
    }
    next.groups = next.groups.filter(x => x.id !== gid);
    return { ok: true, lib: next, moved: cards.length, deleted: 0 };
  }
  function libCardAdd(lib, gid, input, idFn) {
    const next = libClone(lib), g = findGroup(next, gid);
    if (!g) return { ok: false, reason: '先选一个分组。', lib: next };
    const lines = (Array.isArray(input) ? input : String(input == null ? '' : input).split('\n'))
      .map(x => cleanText(x, 300)).filter(Boolean);
    if (!lines.length) return { ok: false, reason: '写一句想放进字卡库的话。', lib: next };
    const added = [], skipped = [];
    lines.forEach(text => {
      if (g.items.some(it => it.text === text)) { skipped.push(text); return; }
      const id = idFn ? idFn('c') : newId('c');
      const card = { id, text };
      g.items.push(card);
      added.push(card);
    });
    return { ok: added.length > 0, reason: added.length ? '' : '这些句子已经在分组里了。', lib: next, added, skipped };
  }
  function libCardUpdate(lib, gid, cid, text) {
    const next = libClone(lib), g = findGroup(next, gid);
    const value = cleanText(text, 300);
    if (!g) return { ok: false, reason: '找不到这个分组。', lib: next };
    const card = g.items.find(it => it.id === cid);
    if (!card) return { ok: false, reason: '找不到这张字卡。', lib: next };
    if (!value) return { ok: false, reason: '字卡不能是空的。', lib: next };
    card.text = value;
    return { ok: true, lib: next };
  }
  function libCardDelete(lib, cid) {
    const next = libClone(lib);
    let found = false;
    next.groups.forEach(g => {
      const before = g.items.length;
      g.items = g.items.filter(it => it.id !== cid);
      if (g.items.length !== before) found = true;
    });
    return found ? { ok: true, lib: next } : { ok: false, reason: '找不到这张字卡。', lib: next };
  }
  function libStats(lib) {
    const groups = libGroups(lib);
    const count = list => list.reduce((n, g) => n + g.items.length, 0);
    return { groups: groups.length, cards: count(groups), allCards: count(groups), visible: count(groups.filter(g => !g.hidden)) };
  }

  /* 参与抽卡的卡池：这套字卡里没被隐藏的分组。隐藏分组永远不参与。 */
  function peerPool(state) {
    const out = [];
    libGroups(state.cardLib).forEach(g => {
      if (g.hidden) return;
      g.items.forEach(it => out.push(it.text));
    });
    return [...new Set(out)];
  }
  const FALLBACK_TALK = ['嗯，我在。', '今天也想起你了。', '慢慢来，不着急。', '刚刚在忙，现在有空啦。', '有想说的，就告诉我。'];
  function drawCards(state, opts) {
    const o = opts || {}, rand = o.rand || Math.random, idFn = o.idFn || (() => newId('k'));
    const pool = peerPool(state);
    if (!pool.length) {
      return { cards: [], texts: [FALLBACK_TALK[Math.min(FALLBACK_TALK.length - 1, Math.floor(rand() * FALLBACK_TALK.length))]], fallback: true };
    }
    const min = Math.max(1, o.min != null ? o.min : state.settings.cardMin);
    const max = Math.max(min, o.max != null ? o.max : state.settings.cardMax);
    const want = Math.min(pool.length, min + Math.floor(rand() * (max - min + 1)));
    const bag = pool.slice(), picked = [];
    for (let i = 0; i < want; i += 1) {
      const at = Math.floor(rand() * bag.length);
      picked.push(bag.splice(at, 1)[0]);
    }
    return { cards: picked.map(text => ({ id: idFn('k'), text })), texts: picked, fallback: false };
  }

  /* ---------------- 抉择（choice） ---------------- */
  const CHOICE_MAX = 50, CHOICE_MIN_OPTIONS = 2, CHOICE_MAX_OPTIONS = 10;
  function secureRand() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof window !== 'undefined' && window.crypto) || null;
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      c.getRandomValues(buf);
      return buf[0] / 4294967296;
    }
    return Math.random();
  }
  /* 安全随机取下标；rand 只在测试里注入，产品路径永远走 secureRand。 */
  function secureIndex(total, rand) {
    const n = Math.max(1, Math.floor(Number(total) || 0));
    const pick = typeof rand === 'function' ? rand : secureRand;
    const v = Math.min(0.99999999, Math.max(0, Number(pick()) || 0));
    return Math.floor(v * n);
  }
  function normChoice(src) {
    const m = src && typeof src === 'object' ? src : {};
    const question = cleanText(m.question, 100);
    const options = (Array.isArray(m.options) ? m.options : []).map(o => cleanText(o, 50)).filter(Boolean).slice(0, CHOICE_MAX_OPTIONS);
    if (!question || options.length < CHOICE_MIN_OPTIONS) return null;
    return {
      question, options,
      mode: m.mode === 'character' ? 'character' : 'random',
      result: cleanText(m.result, 50),
      eventId: cleanText(m.eventId, 80)
    };
  }
  function normChoices(list, cid) {
    const scope = cleanText(cid, 40) || PEER_ID;
    const seen = new Set(), out = [];
    (Array.isArray(list) ? list : []).forEach(item => {
      const it = item && typeof item === 'object' ? item : {};
      const question = cleanText(it.question, 100);
      const result = cleanText(it.result, 50);
      const ts = Number.isFinite(Number(it.ts)) ? Number(it.ts) : Date.parse(it.at);
      if (!question || !result || !Number.isFinite(ts)) return;
      let id = cleanText(it.id, 80) || ('ch-' + ts.toString(36));
      while (seen.has(id)) id = id + '-x';
      seen.add(id);
      out.push({
        id, cid: cleanText(it.cid, 40) || scope, question,
        options: (Array.isArray(it.options) ? it.options : []).map(o => cleanText(o, 50)).filter(Boolean).slice(0, CHOICE_MAX_OPTIONS),
        result, mode: it.mode === 'character' ? 'character' : 'random', ts
      });
    });
    return out.sort((a, b) => b.ts - a.ts).slice(0, CHOICE_MAX);
  }
  function choiceHistory(state, cid) {
    const scope = cleanText(cid, 40) || PEER_ID;
    return normChoices(state.choices, PEER_ID).filter(it => it.cid === scope);
  }
  function appendChoice(state, draft, idFn) {
    const d = draft || {};
    const question = cleanText(d.question, 100);
    const options = (Array.isArray(d.options) ? d.options : []).map(o => cleanText(o, 50)).filter(Boolean).slice(0, CHOICE_MAX_OPTIONS);
    const result = cleanText(d.result, 50);
    if (!question || options.length < CHOICE_MIN_OPTIONS || !result) return { ok: false, reason: '先把问题和至少两个选项填好。', state };
    const entry = {
      id: cleanText(d.id, 80) || (idFn ? idFn('ch') : newId('ch')),
      cid: cleanText(d.cid, 40) || PEER_ID,
      question, options, result,
      mode: d.mode === 'character' ? 'character' : 'random',
      ts: Number.isFinite(Number(d.ts)) ? Number(d.ts) : Date.now()
    };
    const list = normChoices(state.choices, PEER_ID);
    return { ok: true, entry, state: Object.assign({}, state, { choices: normChoices([entry].concat(list), PEER_ID) }) };
  }
  function clearChoices(state, cid) {
    const scope = cleanText(cid, 40) || PEER_ID;
    return Object.assign({}, state, { choices: normChoices(state.choices, PEER_ID).filter(it => it.cid !== scope) });
  }
  /* 幂等闸：TA 的建议只发一次；重绘/恢复时靠这个标记挡住重复发送。 */
  function markChoiceAnswered(state, mid) {
    const id = cleanText(mid, 80);
    const messages = normMessages(state.messages).map(m => (m.id === id && m.type === 'choice' && m.answered !== 1) ? Object.assign({}, m, { answered: 1 }) : m);
    return Object.assign({}, state, { messages });
  }

  /* ---------------- 消息 ---------------- */
  function normMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const role = ['self', 'peer', 'sys'].includes(m.role) ? m.role : (['self', 'peer'].includes(m.side) ? m.side : '');
    const id = cleanText(m.id, 80) || newId('m');
    if (!role) return null;
    if (m.type === 'choice') {
      const choice = normChoice(m);
      if (!choice) return null;
      const picked = Object.assign({ id, role, type: 'choice', text: '', date: normalizeDate(m) }, choice);
      if (m.answered === 1) picked.answered = 1;
      if (role === 'self') picked.read = m.read === 1 ? 1 : 0;
      if (m.rec === 1) {
        picked.rec = 1;
        picked.recBy = m.recBy === 'ta' ? 'ta' : 'me';
        picked.recAt = Number.isFinite(Number(m.recAt)) ? Number(m.recAt) : 0;
      }
      return picked;
    }
    /* 通话卡：没有正文，载荷在 m.call（{st, sec}）。必须在早退之前处理，
       否则「没有 text 也没有 cards」会被当成坏消息丢掉（通话记录就永远进不了聊天流）。 */
    if (m.type === 'call') {
      const meta = m.call && typeof m.call === 'object' ? m.call : {};
      const st = CALL_ST.includes(String(meta.st)) ? String(meta.st) : 'connected';
      const out = {
        id, role, type: 'call', text: '', date: normalizeDate(m),
        call: { st, sec: Math.max(0, Math.round(Number(meta.sec) || 0)) }
      };
      if (role === 'self') out.read = m.read === 1 ? 1 : 0;
      if (m.rec === 1) {
        out.rec = 1;
        out.recBy = m.recBy === 'ta' ? 'ta' : 'me';
        out.recAt = Number.isFinite(Number(m.recAt)) ? Number(m.recAt) : 0;
      }
      return out;
    }
    const text = cleanText(m.text, 2000);
    const cards = (Array.isArray(m.cards) ? m.cards : []).map(c => cleanText(c && c.text !== undefined ? c.text : c, 300)).filter(Boolean).slice(0, 10);
    const type = ['text', 'card', 'poke'].includes(m.type) ? m.type : (cards.length && !text ? 'card' : 'text');
    if (!role || (!text && !cards.length)) return null;
    const out = { id, role, type: type === 'poke' ? 'text' : type, text, date: normalizeDate(m) };
    if (role === 'sys' && m.type === 'poke') {
      out.type = 'poke';
      out.from = m.from === 'peer' ? 'peer' : 'self';
    }
    if (cards.length) out.cards = cards;
    const quote = cleanText(m.quote, 200);
    if (quote) { out.quote = quote; if (m.qid) out.qid = cleanText(m.qid, 80); }
    if (role === 'self') out.read = m.read === 1 ? 1 : (m.read === 0 ? 0 : (m.read === undefined ? (m.tick === 1 ? 1 : 0) : 1));
    if (m.rec === 1) {
      out.rec = 1;
      out.recBy = m.recBy === 'ta' ? 'ta' : 'me';
      out.recAt = Number.isFinite(Number(m.recAt)) ? Number(m.recAt) : 0;
    }
    return out;
  }
  function normalizeDate(m) {
    const direct = Date.parse(m.date);
    if (Number.isFinite(direct)) return new Date(direct).toISOString();
    if (typeof m.time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(m.time)) {
      const [h, mi, s] = m.time.split(':').map(Number);
      const d = new Date();
      d.setHours(h, mi, s, 0);
      return d.toISOString();
    }
    return new Date().toISOString();
  }
  function normMessages(list) {
    const out = [], seen = new Set();
    (Array.isArray(list) ? list : []).forEach(m => {
      const msg = normMessage(m);
      if (!msg || seen.has(msg.id)) return;
      seen.add(msg.id);
      out.push(msg);
    });
    return out.slice(-MAX_MSG);
  }
  function appendMyMessage(state, draft) {
    const s = normMessages(state.messages), d = draft || {};
    const id = cleanText(d.id, 80);
    if (s.length >= MAX_MSG) throw new Error('已经存了 ' + MAX_MSG + ' 条消息，先清一清再发吧。');
    if (!id || s.some(m => m.id === id)) throw new Error('消息没能保存，请重新发送。');
    if (d.type === 'choice') {
      const choice = normChoice(d);
      if (!choice) throw new Error('先写一个问题，并至少留下两个选项。');
      const picked = Object.assign({ id, role: 'self', type: 'choice', text: '', date: normalizeDate(d), read: 0 }, choice);
      return Object.assign({}, state, { messages: s.concat([picked]) });
    }
    const text = cleanText(d.text);
    const cards = (Array.isArray(d.cards) ? d.cards : []).map(c => cleanText(c && c.text !== undefined ? c.text : c, 300)).filter(Boolean).slice(0, 10);
    if (!text && !cards.length) throw new Error('先写一句话，或者选一张字卡。');
    const msg = { id, role: 'self', type: cards.length && !text ? 'card' : 'text', text, date: normalizeDate(d) };
    msg.read = 0;
    if (cards.length) msg.cards = cards;
    if (d.quote) { msg.quote = cleanText(d.quote, 200); if (d.qid) msg.qid = cleanText(d.qid, 80); }
    return Object.assign({}, state, { messages: s.concat([msg]) });
  }
  function appendPeerMessage(state, draft) {
    const s = normMessages(state.messages), d = draft || {};
    if (s.length >= MAX_MSG) return null;
    const id = cleanText(d.id, 80);
    if (!id || s.some(m => m.id === id)) return null;
    const cards = (Array.isArray(d.cards) ? d.cards : []).map(c => cleanText(c && c.text !== undefined ? c.text : c, 300)).filter(Boolean).slice(0, 10);
    const text = cleanText(d.text, 2000) || cards.join(' ');
    if (!text) return null;
    const msg = { id, role: 'peer', type: cards.length && !text ? 'card' : 'text', text, date: normalizeDate(d) };
    if (cards.length) msg.cards = cards;
    if (d.quote) { msg.quote = cleanText(d.quote, 200); if (d.qid) msg.qid = cleanText(d.qid, 80); }
    return Object.assign({}, state, { messages: s.concat([msg]) });
  }
  function appendPoke(state, draft) {
    const d = draft || {}, s = normMessages(state.messages);
    if (s.length >= MAX_MSG) return null;
    const id = cleanText(d.id, 80);
    if (!id) return null;
    const from = d.from === 'peer' ? 'peer' : 'self';
    const msg = { id, role: 'sys', type: 'poke', from, text: pokeLine(state, from, d.phrase), date: normalizeDate(d) };
    return Object.assign({}, state, { messages: s.concat([msg]) });
  }
  /* 通话卡入聊天流（工单第10单第3条）：载荷是 {st, sec}，没有正文。 */
  function appendCallCard(state, draft) {
    const d = draft || {}, s = normMessages(state.messages);
    if (s.length >= MAX_MSG) return null;
    const id = cleanText(d.id, 80);
    if (!id || s.some(m => m.id === id)) return null;
    const from = d.from === 'peer' ? 'peer' : 'self';
    const msg = normMessage({
      id, role: from, type: 'call', date: d.date,
      call: { st: d.st, sec: d.sec }, read: from === 'self' ? 1 : undefined
    });
    if (!msg) return null;
    return Object.assign({}, state, { messages: s.concat([msg]) });
  }
  function recallMessage(state, id, by) {
    const s = normMessages(state.messages), mid = cleanText(id, 80), who = by === 'ta' ? 'ta' : 'me';
    const at = s.findIndex(m => m.id === mid);
    if (at < 0) return { ok: false, reason: '找不到这条消息了', state };
    const msg = s[at];
    if (msg.type === 'poke') return { ok: false, reason: '系统提示不能撤回', state };
    if (who === 'me' && msg.role !== 'self') return { ok: false, reason: '只能撤回自己发的消息', state };
    if (who === 'ta' && msg.role !== 'peer') return { ok: false, reason: '对方只能撤回它自己发的消息', state };
    if (msg.rec === 1) return { ok: true, state };
    const messages = s.slice();
    messages[at] = Object.assign({}, msg, { rec: 1, recBy: who, recAt: Date.now() });
    return { ok: true, state: Object.assign({}, state, { messages }) };
  }
  function markRead(state) {
    const s = normMessages(state.messages);
    let changed = false;
    const messages = s.map(m => {
      if (m.role === 'self' && m.read !== 1) { changed = true; return Object.assign({}, m, { read: 1 }); }
      return m;
    });
    return changed ? Object.assign({}, state, { messages }) : state;
  }
  function recallSnapshot(msg) {
    if (!msg) return '';
    if (msg.type === 'choice') return cleanText(msg.question, 140);
    if (msg.text) return cleanText(msg.text, 140);
    if (msg.cards && msg.cards.length) return cleanText(composeCards(msg.cards), 140);
    return '';
  }


  /* ---------------- 拼字卡：把几张卡拼成一句 ----------------
     ⚠️ 只把卡片之间的连接符换成空格是不够的 —— 字卡**文本自己**就带换行
     （种子卡是「没什么特别的事，\n只是想你了。」这种两行写法），
     而 .bubble p 是 white-space: pre-wrap，卡内那个 \n 照样断行。
     所以每张卡先把自己的连续空白压成单个空格，再统一用空格顿开。
     卡片库列表里仍按原文展示（那里是字卡的「原貌」，不是拼出来的句子）。 */
  function flatCardText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }
  function composeCards(cards) {
    if (!Array.isArray(cards)) return '';
    return cards.map(flatCardText).filter(Boolean).join(' ');
  }

  /* ---------------- 消息：复制 / 删除 / 引用候选 ---------------- */
  /* 复制用纯文本：文字优先，字卡拼成一句，抉择卡带题目与选项（工单第1单#16「复制」）。 */
  function messagePlain(msg) {
    if (!msg) return '';
    if (msg.type === 'choice') {
      const head = [cleanText(msg.question, 100)].concat((msg.options || []).map(o => '· ' + o));
      if (msg.result) head.push('结果：' + msg.result);
      return head.join('\n');
    }
    if (msg.text) return msg.text;
    /* 与聊天里一致：拼字卡是空格顿开的一句，卡内换行也压平。 */
    if (msg.cards && msg.cards.length) return composeCards(msg.cards);
    return '';
  }
  /* 删除：撤回只是标记位，删除是真删（工单第1单#18「双方消息支持删除」）。 */
  function removeMessage(state, id) {
    const s = normMessages(state.messages), mid = cleanText(id, 80);
    if (!s.some(m => m.id === mid)) return { ok: false, reason: '找不到这条消息了', state };
    return { ok: true, state: Object.assign({}, state, { messages: s.filter(m => m.id !== mid) }) };
  }
  /* TA 引用我时从那一条里挑：最近 8 条、30 分钟内的我方消息（工单第1单#16）。 */
  function quoteCandidates(state, opts) {
    const o = opts || {}, now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const limit = o.limit != null ? o.limit : 8;
    const windowMs = (o.windowMin != null ? o.windowMin : 30) * 60000;
    return normMessages(state.messages)
      .filter(m => m.role === 'self' && m.rec !== 1 && messagePlain(m))
      .slice(-limit)
      .filter(m => {
        const ts = Date.parse(m.date);
        return Number.isFinite(ts) ? (now - ts) <= windowMs : false;
      });
  }

  /* ---------------- 字卡库导入 / 导出 ----------------
     导出用本站自有格式（分组带 scope，工单第2单附加规范 5.4）；
     导入兼容 milk 备份：只取字卡、分组与拍一拍动作池，其余字段静默忽略（工单第2单#6）。 */
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function parseMaybe(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
    try { return JSON.parse(text); } catch { return value; }
  }
  function textList(value) {
    return (Array.isArray(value) ? value : []).map(item => {
      if (typeof item === 'string') return item;
      if (isPlainObject(item)) return item.text || item.content || item.value || '';
      return '';
    }).map(item => cleanText(item, 300)).filter(Boolean);
  }
  function groupList(value) {
    return (Array.isArray(value) ? value : []).map(g => {
      if (!isPlainObject(g)) return null;
      const name = cleanText(g.name || g.title, 40);
      if (!name) return null;
      return {
        name,
        hidden: !!(g.hidden || g.disabled),
        scope: g.scope === PEER_ID ? PEER_ID : (g.scope === 'public' ? 'public' : ''),
        items: textList(g.items || g.cards || g.replies)
      };
    }).filter(Boolean);
  }
  /* 任意深度抓 milk 的四类键：值可能是 JSON 字符串，包裹形态（localStorage/data）也要取到。 */
  function grabImport(node, bag, depth) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(item => grabImport(parseMaybe(item), bag, depth + 1)); return; }
    Object.keys(node).forEach(key => {
      const value = parseMaybe(node[key]);
      if (/customReplies$/i.test(key)) bag.replies.push(...textList(value));
      else if (/customReplyGroups$/i.test(key)) bag.groups.push(...groupList(value));
      else if (/customPokes$/i.test(key)) bag.pokes.push(...textList(value));
      else if (/customPokeGroups$/i.test(key)) bag.pokes.push(...textList(value), ...groupList(value).reduce((all, g) => all.concat(g.items), []));
      if (value && typeof value === 'object') grabImport(value, bag, depth + 1);
    });
  }
  function nativeCardGroups(node) {
    const candidates = [];
    if (node.cardLib) candidates.push(node.cardLib);
    if (node.state && node.state.cardLib) candidates.push(node.state.cardLib);
    candidates.push(node);
    for (const lib of candidates) {
      const groups = lib && Array.isArray(lib.groups) ? lib.groups : null;
      if (!groups) continue;
      const shaped = groups.filter(g => isPlainObject(g) && cleanText(g.name, 40) && Array.isArray(g.items) && (g.scope === PEER_ID || g.scope === 'public'));
      if (!shaped.length) continue;
      return {
        groups: shaped.map(g => ({ name: cleanText(g.name, 40), hidden: !!g.hidden, scope: g.scope === PEER_ID ? PEER_ID : 'public', items: textList(g.items) })),
        ungrouped: []
      };
    }
    return null;
  }
  function importCards(payload) {
    const root = parseMaybe(payload);
    const empty = { source: 'none', groups: [], ungrouped: [], pokes: [], hasScope: false };
    if (!root || typeof root !== 'object') return empty;
    const native = nativeCardGroups(root);
    if (native) {
      const pokes = textList((root.pokes || (root.state && root.state.pokes)) || []).slice(0, 500);
      const groups = native.groups.slice(0, 400);
      return {
        source: 'native', groups, ungrouped: native.ungrouped, pokes,
        hasScope: groups.some(g => !!g.scope)
      };
    }
    const bag = { replies: [], groups: [], pokes: [] };
    grabImport(root, bag, 0);
    const pokes = [...new Set(bag.pokes)].slice(0, 500);
    if (!bag.replies.length && !bag.groups.length && !pokes.length) return empty;
    /* 分账：milk 的 customReplies 是全部字卡的扁平表，组内 items 是它的子集 ——
       组内先归组，其余进「未分组」，两个列表不能各导一遍（工单第2单#6 踩坑）。 */
    const groups = bag.groups.slice(0, 400).map(g => ({ name: g.name, hidden: g.hidden, scope: g.scope, items: [...new Set(g.items)] }));
    const inGroups = new Set();
    groups.forEach(g => g.items.forEach(t => inGroups.add(t)));
    const replies = [...new Set(bag.replies)].slice(0, IMPORT_MAX_CARDS);
    const ungrouped = replies.filter(t => !inGroups.has(t));
    return { source: 'milk', groups, ungrouped, pokes, hasScope: groups.some(g => !!g.scope) };
  }
  /* targetScope：'public' / PEER_ID / 'file'（按文件里每组自带的 scope，缺省公共）。 */
  function mergeImportedCards(lib, targetScope, parsed, idFn) {
    let next = libClone(lib), report = { groups: 0, cards: 0, skipped: 0 };
    const scopeOf = () => 'public';   /* 单梦角：不再有第二个范围 */
    (parsed && Array.isArray(parsed.groups) ? parsed.groups : []).forEach(src => {
      const items = (src.items || []).map(t => cleanText(t, 300)).filter(Boolean).slice(0, 600);
      if (!items.length) return;
      const scope = scopeOf(src), name = cleanText(src.name, 40) || UNCAT;
      let target = libGroups(next, scope).find(g => g.name === name);
      if (!target) {
        target = { id: idFn ? idFn('g') : newId('g'), name, scope, hidden: !!src.hidden, items: [] };
        next.groups.push(target);
        report.groups += 1;
      }
      items.forEach(text => {
        if (target.items.some(it => it.text === text)) { report.skipped += 1; return; }
        target.items.push({ id: idFn ? idFn('c') : newId('c'), text });
        report.cards += 1;
      });
    });
    const loose = (parsed && Array.isArray(parsed.ungrouped) ? parsed.ungrouped : []).map(t => cleanText(t, 300)).filter(Boolean);
    if (loose.length) {
      const ensured = ensureUncat(next, scopeOf({ scope: '' }));
      next = ensured.lib;
      const uncat = findGroup(next, ensured.group.id);
      loose.forEach(text => {
        if (!uncat) return;
        if (uncat.items.some(it => it.text === text)) { report.skipped += 1; return; }
        uncat.items.push({ id: idFn ? idFn('c') : newId('c'), text });
        report.cards += 1;
      });
    }
    return { ok: report.cards > 0, lib: normCardLib(next), report };
  }
  function exportCards(lib, opts) {
    const o = opts || {};
    const payload = {
      app: 'slowly-chat-order44-cardlib', v: 1,
      exportedAt: new Date().toISOString(),
      groups: ((lib && lib.groups) || []).map(g => ({
        id: g.id, name: g.name, scope: 'public', hidden: !!g.hidden,
        items: g.items.map(it => ({ id: it.id, text: it.text }))
      }))
    };
    if (o.pokes) payload.pokes = (o.pokes || []).slice(0, 500);
    return payload;
  }

  /* ---------------- 语音通话（模拟）归一化 ----------------
     单梦角形态：记录里也带 cid（本站只有一位梦角，cid 恒为 PEER_ID），
     这样以后换多梦角时记录不必再改形状，只需按 cid 过滤。 */
  const CALL_ST = ['connected', 'busy', 'rejected', 'missed'];
  const CALL_LOG_MAX = 200;

  function normCallLog(x) {
    const o = x && typeof x === 'object' ? x : {};
    let st = String(o.st || '');
    if (!CALL_ST.includes(st)) st = 'connected';
    return {
      id: cleanText(o.id, 80) || newId('cl'),
      cid: cleanText(o.cid, 40) || PEER_ID,
      dir: o.dir === 'in' ? 'in' : 'out',
      st,
      ts: Number.isFinite(Number(o.ts)) ? Number(o.ts) : Date.now(),
      sec: Math.max(0, Math.round(Number(o.sec) || 0))
    };
  }
  /* 记录：非对象条目直接丢；新的在前；超过 200 条截断。 */
  function normCalls(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set(), out = [];
    raw.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const log = normCallLog(item);
      if (seen.has(log.id)) return;
      seen.add(log.id);
      out.push(log);
    });
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, CALL_LOG_MAX);
  }
  /* 进行态：认不出的 phase 一律当「没有通话」，避免刷新后卡在假状态里。
     active 却没有 connectTs = 坏档，退回 calling 重新判定，别让它永远空转。 */
  function normCallLive(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ph = String(raw.phase || '');
    if (!['calling', 'active', 'incoming'].includes(ph)) return null;
    const live = {
      cid: cleanText(raw.cid, 40) || PEER_ID,
      dir: raw.dir === 'in' ? 'in' : 'out',
      phase: ph,
      startTs: Number(raw.startTs) || Date.now(),
      connectTs: Number(raw.connectTs) || 0,
      mini: !!raw.mini
    };
    if (live.phase === 'active' && !live.connectTs) { live.phase = 'calling'; live.mini = false; }
    return live;
  }

  /* 小窗位置：只认两个有限数，形状不对就是「没记过」，回落到默认角。 */
  function normMiniPos(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x), y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }

  /* ---------------- 状态 ---------------- */
  function defaultMessages() {
    const base = Date.now() - 42000;
    const at = offset => new Date(base + offset).toISOString();
    return [
      { id: newId('m'), role: 'peer', type: 'text', text: '今天，有没有好好吃饭？', date: at(0) },
      { id: newId('m'), role: 'self', type: 'text', text: '有呀。你呢？', date: at(11), read: 1 },
      { id: newId('m'), role: 'peer', type: 'text', text: '我也有。\n只是突然有点想你。', date: at(23), quote: '你说：有呀。你呢？' },
      { id: newId('m'), role: 'peer', type: 'text', text: '想听你讲讲今天。', date: at(29) },
      { id: newId('m'), role: 'self', type: 'text', text: '那就陪我说一会儿话吧。', date: at(37), read: 1 },
      { id: newId('m'), role: 'self', type: 'text', text: '从刚刚遇见的那只猫开始。', date: at(41), read: 1 },
      { id: newId('m'), role: 'peer', type: 'text', text: '好。\n慢慢说，我在听。', date: at(45) }
    ];
  }
  function createState() {
    return {
      peerName: '对方', selfName: '我', peerTag: '字卡陪伴 · 本地', peerAvatar: '', selfAvatar: '',
      showTime: true, fontSize: 15, background: 'soft',
      theme: 'dark', palette: 'gray-blue',
      bubbleSkin: 'classic', bubbleCss: '', bubScale: BUB_DEF,
      startedAt: new Date().toISOString(), choices: [],
      walls: { chat: '' },
      settings: normSettings({}),
      cardLib: normCardLib(null),
      pokes: normPokes(undefined),
      calls: [],
      callLive: null,
      callMiniPos: null,
      callInDay: '',
      callInN: 0,
      unread: 0,
      messages: defaultMessages()
    };
  }
  function normalizeState(value) {
    const result = createState();
    if (!value || typeof value !== 'object') return result;
    if (['dark', 'light'].includes(value.theme)) result.theme = value.theme;
    if (['gray-blue', 'pink-white', 'pink-gray', 'black-white', 'gray-white'].includes(value.palette)) result.palette = value.palette;
    for (const key of ['peerName', 'selfName']) {
      if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim().slice(0, 24);
    }
    /* 名字下面那行小字（顶栏副标题）。与昵称不同：允许留空 —— 空就是「不显示」，
       不能像昵称那样把空值退回默认，否则用户删不掉这行字。 */
    if (typeof value.peerTag === 'string') result.peerTag = value.peerTag.replace(/\s+/g, ' ').trim().slice(0, 40);
    for (const key of ['peerAvatar', 'selfAvatar']) {
      if (isImage(value[key])) result[key] = value[key];
    }
    if (typeof value.showTime === 'boolean') result.showTime = value.showTime;
    if ([14, 15, 17].includes(value.fontSize)) result.fontSize = value.fontSize;
    if (['soft', 'white', 'paper'].includes(value.background)) result.background = value.background;
    /* 皮肤与自定义 CSS 都要归一：只写不归一 = 刷新就丢（本站的老教训）。 */
    if (BUBBLE_SKINS.some(skin => skin.id === value.bubbleSkin)) result.bubbleSkin = value.bubbleSkin;
    result.bubbleCss = sanitizeUserCss(value.bubbleCss);
    result.bubScale = bubClamp(value.bubScale);
    if (typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))) result.startedAt = value.startedAt;
    if (value.walls && isImage(value.walls.chat, WALL_MAX)) result.walls = { chat: value.walls.chat };
    result.settings = normSettings(value.settings);
    result.cardLib = normCardLib(value.cardLib);
    result.pokes = normPokes(value.pokes);
    result.calls = normCalls(value.calls);
    result.callLive = normCallLive(value.callLive);
    result.callMiniPos = normMiniPos(value.callMiniPos);
    /* 来电计数按天存：跨天自然作废（dayCount 会比对 callInDay），
       所以这里只做形状校验，不做清零 —— 否则刷新就能白刷掉上限。 */
    result.callInDay = cleanText(value.callInDay, 20);
    result.callInN = clampInt(value.callInN, 0, 0, 99);
    result.unread = clampInt(value.unread, 0, 0, 99);
    const messages = normMessages(value.messages);
    if (messages.length) result.messages = messages;
    /* 抉择历史：新档读 choices；旧档（早期只有「问题+结果」的 history）整条迁进来，不丢用户的选择。 */
    result.choices = normChoices(value.choices, PEER_ID);
    if (!result.choices.length && Array.isArray(value.history)) {
      result.choices = normChoices(value.history.map(h => (h && typeof h === 'object')
        ? { cid: PEER_ID, question: h.question, options: [], result: h.result, mode: 'random', ts: Date.parse(h.at) }
        : null), PEER_ID);
    }
    return result;
  }

  /* ---------------- 既有本地功能（保留原接口） ---------------- */
  function createMessage(text, date = new Date()) {
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 2000) return null;
    return { side: 'self', text: text.trim(), time: formatTime(date) };
  }
  function choose(options, random = Math.random) {
    if (!Array.isArray(options)) return null;
    const values = options.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
    if (values.length < 2) return null;
    return values[Math.max(0, Math.min(values.length - 1, Math.floor(random() * values.length)))];
  }
  function validateImage(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) return '请选择 JPG、PNG、WebP、GIF 或 AVIF 图片';
    if (file.size > 5 * 1024 * 1024) return '图片不能超过 5MB，请换一张小一点的图片';
    return '';
  }

  const api = {
    PEER_ID, UNCAT, STORE_KEY, MAX_MSG, IMAGE_MAX, WALL_MAX, IMPORT_MAX_CARDS,
    TIME_GAP, GAP_NOTE, gapText, gapFlags,
    BUB_MIN, BUB_MAX, BUB_DEF, bubClamp, bubLabel,
    SETTINGS, SETTING_KEYS, POKE_DEFAULT, SEED_GROUPS, FALLBACK_TALK,
    createState, normalizeState, formatTime, createMessage, choose, validateImage,
    newId, cleanText, clampInt, isImage,
    normSettings, setSetting, normPokes, setPokes, pokeLine,
    BUBBLE_MAX, BUBBLE_SKINS, USER_CSS_SCOPE, USER_CSS_DICT, bubbleSkinCss,
    splitTop, dictLookup, adaptUserCss, sanitizeUserCss, forceImportant,
    normCardLib, libGroups, findGroup, findCard, ensureUncat, libStats, peerPool, drawCards,
    libGroupAdd, libGroupRename, libGroupHide, libGroupDelete,
    libCardAdd, libCardUpdate, libCardDelete,
    normMessage, normMessages, appendMyMessage, appendPeerMessage, appendPoke, appendCallCard,
    flatCardText, composeCards,
    CALL_ST, CALL_LOG_MAX, normCallLog, normCalls, normCallLive, normMiniPos,
    recallMessage, markRead, recallSnapshot, messagePlain, removeMessage, quoteCandidates,
    importCards, mergeImportedCards, exportCards,
    CHOICE_MAX, CHOICE_MIN_OPTIONS, CHOICE_MAX_OPTIONS,
    secureRand, secureIndex, normChoice, normChoices, choiceHistory, appendChoice, clearChoices, markChoiceAnswered
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatModel = api;
})(typeof window !== 'undefined' ? window : globalThis);

