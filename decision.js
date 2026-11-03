(function (root) {
  'use strict';

  const MAX_Q = 100, MAX_OPTION = 50, MIN_OPTIONS = 2, MAX_OPTIONS = 10, SHEET_HISTORY = 20;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function dayLabel(ts, now = new Date()) {
    const d = new Date(ts);
    if (sameDay(d, now)) return '今天';
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameDay(d, yesterday)) return '昨天';
    const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
  }
  const clock = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };

  root.SlowDecision = {
    init(host) {
      const M = root.ChatModel;
      const cid = M.PEER_ID;
      const state = () => host.getState();
      const draft = { question: '', options: ['', ''], result: '', eventId: '', phase: 'input', historyOpen: false };
      let panel = null;

      /* ---------------- 抉择弹层 ---------------- */
      function open() {
        draft.phase = 'input';
        draft.result = '';
        paint();
        host.openSheet(panel, null);
      }
      function paint() {
        panel = panel && panel.isConnected ? panel : el('div', 'sheet-panel decision-sheet');
        panel.replaceChildren();
        if (draft.phase === 'result') buildResult();
        else buildInput();
      }
      function historyBlock() {
        const wrap = el('div', 'decision-history');
        const all = M.choiceHistory(state(), cid);
        const toggle = el('button', 'decision-history-toggle', (draft.historyOpen ? '收起历史记录' : '历史记录') + '（' + all.length + '）');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(draft.historyOpen));
        const body = el('div', 'decision-history-body');
        body.hidden = !draft.historyOpen;
        if (!all.length) body.append(el('p', 'decision-history-empty', '还没有留下抉择。'));
        else all.slice(0, SHEET_HISTORY).forEach(it => {
          const row = el('div', 'decision-history-row');
          const head = el('div', 'decision-history-head');
          head.append(el('span', 'decision-history-day', dayLabel(it.ts) + ' ' + clock(it.ts)));
          head.append(el('span', 'decision-history-mode', it.mode === 'character' ? 'TA 的建议' : '命运之选'));
          row.append(head);
          row.append(el('p', 'decision-history-question', it.question));
          row.append(el('strong', 'decision-history-result', it.result));
          body.append(row);
        });
        toggle.addEventListener('click', () => {
          draft.historyOpen = !draft.historyOpen;
          body.hidden = !draft.historyOpen;
          toggle.textContent = (draft.historyOpen ? '收起历史记录' : '历史记录') + '（' + all.length + '）';
          toggle.setAttribute('aria-expanded', String(draft.historyOpen));
        });
        wrap.append(toggle, body);
        return wrap;
      }
      function buildInput() {
        panel.append(el('h3', 'sheet-title', '帮我抉择'));
        panel.append(el('p', 'sheet-text', '写下一个问题和几个选项。可以自己掷一个，也可以交给 TA 在聊天里给建议。'));

        const qLabel = el('label', 'decision-field');
        qLabel.append(el('span', 'decision-caption', '你在纠结什么？（最多 ' + MAX_Q + ' 字）'));
        const qInput = el('input', 'sheet-input decision-question-input');
        qInput.type = 'text';
        qInput.maxLength = MAX_Q;
        qInput.value = draft.question;
        qInput.placeholder = '比如：晚饭吃什么？';
        qLabel.append(qInput);
        panel.append(qLabel);

        const caption = el('span', 'decision-caption', '');
        caption.append(el('span', '', '选项（2~' + MAX_OPTIONS + ' 个，每个最多 ' + MAX_OPTION + ' 字）'));
        const count = el('small', 'decision-count', '');
        caption.append(count);
        panel.append(caption);

        const listBox = el('div', 'decision-options');
        const values = (draft.options.length ? draft.options.slice(0, MAX_OPTIONS) : ['', '']);
        while (values.length < MIN_OPTIONS) values.push('');
        const actions = el('div', 'sheet-actions');
        const randomBtn = host.sheetButton('开始抉择', 'secondary-button', () => run('random'));
        const charBtn = host.sheetButton('让 TA 帮我定', 'primary-button', () => run('character'));
        actions.append(randomBtn, charBtn);

        function refresh() {
          const filled = values.map(v => v.trim()).filter(Boolean);
          const ok = qInput.value.trim().length > 0 && filled.length >= MIN_OPTIONS;
          randomBtn.disabled = !ok;
          charBtn.disabled = !ok;
          count.textContent = filled.length + ' / ' + MAX_OPTIONS + ' 个有效选项';
        }
        function paintOptions(focusAt) {
          listBox.replaceChildren();
          values.forEach((value, i) => {
            const row = el('div', 'decision-option-row');
            row.append(el('span', 'decision-index', String(i + 1)));
            const input = el('input', 'sheet-input decision-option-input');
            input.type = 'text';
            input.maxLength = MAX_OPTION;
            input.value = value;
            input.placeholder = i === 0 ? '第一个选项' : '再写一个';
            input.addEventListener('input', () => { values[i] = input.value; refresh(); });
            row.append(input);
            const remove = el('button', 'decision-remove', '×');
            remove.type = 'button';
            remove.disabled = values.length <= MIN_OPTIONS;
            remove.setAttribute('aria-label', '删掉第 ' + (i + 1) + ' 个选项');
            remove.addEventListener('click', () => { values.splice(i, 1); paintOptions(); refresh(); });
            row.append(remove);
            if (i === values.length - 1) {
              const add = el('button', 'decision-add', '+');
              add.type = 'button';
              add.disabled = values.length >= MAX_OPTIONS;
              add.setAttribute('aria-label', '加一个选项');
              add.addEventListener('click', () => { values.push(''); paintOptions(values.length - 1); refresh(); });
              row.append(add);
            }
            listBox.append(row);
          });
          if (focusAt != null && listBox.querySelectorAll('input')[focusAt]) listBox.querySelectorAll('input')[focusAt].focus();
        }
        qInput.addEventListener('input', refresh);
        paintOptions();
        refresh();
        panel.append(listBox, actions);

        function readDraft() {
          return {
            question: qInput.value.trim().slice(0, MAX_Q),
            options: values.map(v => v.trim()).filter(Boolean).slice(0, MAX_OPTIONS)
          };
        }
        function run(mode) {
          const input = readDraft();
          if (!input.question || input.options.length < MIN_OPTIONS) { host.toast('先写一个问题，并至少留下两个选项。'); return; }
          draft.question = input.question;
          draft.options = input.options;
          const suggest = (mode === 'character');
          const result = input.options[M.secureIndex(input.options.length)];
          const eventId = host.newId('ch');
          const added = M.appendChoice(state(), { id: eventId, cid, question: input.question, options: input.options, result, mode: suggest ? 'character' : 'random', ts: Date.now() });
          if (!added.ok) { host.toast(added.reason); return; }
          if (!host.persist(added.state)) { host.toast('这次抉择没能保存，请检查浏览器存储空间。'); return; }
          if (!suggest) {
            draft.result = result;
            draft.eventId = eventId;
            draft.phase = 'result';
            paint();
            return;
          }
          /* 路径二：先把不含结果的「请帮我选」卡发进当前聊天，TA 之后给建议。 */
          host.closeSheet();
          host.closeDetail();
          if (!host.sendChoice({ eventId, question: input.question, options: input.options, result, mode: 'character' })) return;
          host.toast('已经把问题交给 TA 了。');
        }
        panel.append(historyBlock());
        qInput.focus();
      }
      function buildResult() {
        panel.append(el('h3', 'sheet-title', '命运之选'));
        const card = el('div', 'decision-card');
        card.append(el('p', 'decision-card-question', draft.question));
        card.append(el('p', 'decision-card-answer', draft.result));
        card.append(el('small', 'decision-card-note', draft.options.length + ' 个选项 · 已经记进抉择历史'));
        panel.append(card);
        const actions = el('div', 'sheet-actions');
        actions.append(
          host.sheetButton('发送到聊天', 'secondary-button', () => {
            if (!host.sendChoice({ eventId: draft.eventId, question: draft.question, options: draft.options, result: draft.result, mode: 'random' })) return;
            host.closeSheet();
            host.closeDetail();
            host.toast('已经发到聊天里了。');
          }),
          host.sheetButton('再来一次', 'primary-button', again)
        );
        panel.append(actions);
        const back = host.sheetButton('改一下问题和选项', 'text-button decision-back', () => { draft.phase = 'input'; paint(); });
        panel.append(back);
        panel.append(historyBlock());
      }
      function again() {
        const result = draft.options[M.secureIndex(draft.options.length)];
        const eventId = host.newId('ch');
        const added = M.appendChoice(state(), { id: eventId, cid, question: draft.question, options: draft.options, result, mode: 'random', ts: Date.now() });
        if (!added.ok || !host.persist(added.state)) { host.toast('这次抉择没能保存。'); return; }
        draft.result = result;
        draft.eventId = eventId;
        paint();
      }

      /* ---------------- 菜单里的「决策历史」页：按日期分组 ---------------- */
      function historyCard(it) {
        const article = el('article', 'history-item');
        const time = el('time', '', clock(it.ts));
        time.dateTime = new Date(it.ts).toISOString();
        article.append(time);
        article.append(el('h4', '', it.question));
        const result = el('p', 'history-result');
        result.append(el('span', 'history-mode', it.mode === 'character' ? 'TA 的建议' : '命运之选'));
        result.append(el('strong', '', it.result));
        article.append(result);
        if (it.options.length) article.append(el('small', 'history-options', '选项：' + it.options.join(' / ')));
        return article;
      }
      function renderHistoryPage() {
        const listBox = document.querySelector('#history-list');
        const emptyBox = document.querySelector('#history-empty');
        const actions = document.querySelector('#history-actions');
        if (!listBox) return;
        const all = M.choiceHistory(state(), cid);
        emptyBox.hidden = all.length > 0;
        if (actions) actions.hidden = !all.length;
        const days = new Map();
        all.forEach(it => { const key = dayKey(it.ts); if (!days.has(key)) days.set(key, []); days.get(key).push(it); });
        const nodes = [];
        days.forEach(items => {
          const section = el('section', 'history-day');
          const head = el('h4', 'history-date');
          head.append(el('span', '', dayLabel(items[0].ts)));
          head.append(el('small', '', items.length + ' 条'));
          section.append(head);
          const body = el('div', 'history-day-list');
          items.slice().sort((a, b) => b.ts - a.ts).forEach(it => body.append(historyCard(it)));
          section.append(body);
          nodes.push(section);
        });
        listBox.replaceChildren(...nodes);
      }

      const clearBtn = document.querySelector('#history-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        host.confirm({
          title: '清空抉择历史？',
          text: '所有已记录的抉择都会消失，聊天里的那几张卡还在。清掉就找不回来了。',
          confirmLabel: '清空',
          danger: true,
          onConfirm() {
            if (!host.persist(M.clearChoices(state(), cid))) { host.toast('清空没有保存成功。'); return; }
            renderHistoryPage();
            host.toast('抉择历史已清空。');
          }
        });
      });

      return { open, renderHistoryPage };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);


