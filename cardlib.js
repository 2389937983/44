(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  root.SlowCardLib = {
    init(host) {
      const M = root.ChatModel;
      const page = document.querySelector('#page-cards');
      const groupsBox = document.querySelector('#card-groups');
      const cardsPane = document.querySelector('#cards-pane');
      const pokesPane = document.querySelector('#pokes-pane');
      const modeButtons = [...document.querySelectorAll('#card-modes .mode-chip')];
      const listBox = document.querySelector('#card-list');
      const emptyBox = document.querySelector('#cards-empty');
      const search = document.querySelector('#card-search');
      const addRow = document.querySelector('#card-add-row');
      const newCard = document.querySelector('#card-new');
      const pokeList = document.querySelector('#poke-list');
      const pokeNew = document.querySelector('#poke-new');
      const pokeCount = document.querySelector('#poke-count');

      let mode = 'cards', group = 'all';
      /* 单梦角：字卡只有一套，不再分两个范围。
         第二个 tab 现在是「拍一拍」，点过去就是动作池。 */
      function setMode(next) {
        mode = next === 'pokes' ? 'pokes' : 'cards';
        render();
      }

      const state = () => host.getState();
      function apply(next, message) {
        if (!host.persist(next)) { host.toast('没能保存这次改动，请检查浏览器存储空间。'); return false; }
        render();
        if (message) host.toast(message);
        return true;
      }
      function setLib(lib) { return Object.assign({}, state(), { cardLib: lib }); }

      /* ---------------- 渲染 ---------------- */
      function render() {
        const s = state();
        modeButtons.forEach(button => {
          const active = button.dataset.mode === mode;
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-selected', String(active));
        });
        if (cardsPane) cardsPane.hidden = mode !== 'cards';
        if (pokesPane) pokesPane.hidden = mode !== 'pokes';
        if (mode === 'pokes') { renderPokes(s); return; }
        const groups = M.libGroups(s.cardLib);
        if (group !== 'all' && !groups.some(g => g.id === group)) group = 'all';
        /* 固定布局例外②：一排可横向滑动的 tab 条，第一颗固定「全部」，单选。 */
        const chips = [{ id: 'all', name: '全部', count: groups.reduce((n, g) => n + g.items.length, 0) }].concat(groups.map(g => ({ id: g.id, name: g.name, hidden: g.hidden, count: g.items.length })));
        groupsBox.replaceChildren(...chips.map(chip => {
          const button = el('button', 'chip' + (group === chip.id ? ' is-active' : '') + (chip.hidden ? ' is-hidden' : ''));
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          use.setAttribute('href', '#i-folder');
          svg.setAttribute('aria-hidden', 'true');
          svg.append(use);
          button.append(svg, el('span', 'folder-name', chip.name), el('span', 'folder-count', String(chip.count)));
          button.type = 'button';
          button.setAttribute('aria-label', chip.name + '，' + chip.count + ' 条短句' + (chip.hidden ? '，已隐藏' : ''));
          button.dataset.group = chip.id;
          button.setAttribute('role', 'tab');
          button.setAttribute('aria-selected', String(group === chip.id));
          button.addEventListener('click', () => { group = chip.id; render(); });
          return button;
        }));
        const query = (search.value || '').trim().toLowerCase();
        const pool = [];
        groups.forEach(g => {
          if (group !== 'all' && g.id !== group) return;
          g.items.forEach(card => pool.push({ group: g, card }));
        });
        const filtered = pool.filter(({ card }) => !query || card.text.toLowerCase().includes(query));
        document.querySelector('#library-selection').textContent = group === 'all' ? '全部' : groups.find(g => g.id === group).name;
        document.querySelector('#library-count').textContent = filtered.length + ' 条短句';
        listBox.replaceChildren(...filtered.map(({ group: g, card }) => cardNode(g, card)));
        emptyBox.hidden = filtered.length > 0;
        if (!filtered.length) emptyBox.textContent = query ? '还没有找到这句话，换个词试试吧。' : '这个分组还是空的，加一句进去吧。';
        renderPokes(s);
      }
      function cardNode(g, card) {
        const article = el('article', 'word-card');
        article.dataset.cardId = card.id;
        article.append(el('small', '', g.name));
        article.append(el('p', '', card.text));
        const actions = el('div', 'word-card-actions');
        const use = el('button', 'card-use', '写进聊天');
        use.type = 'button';
        use.append(el('span', '', '↗'));
        use.setAttribute('aria-label', '使用字卡：' + card.text.replace(/\n/g, ''));
        use.addEventListener('click', () => useCard(card.text));
        const edit = el('button', 'card-edit', '编辑');
        edit.type = 'button';
        edit.addEventListener('click', () => {
          host.prompt({
            title: '编辑字卡', label: '这张字卡要说的话', value: card.text, multiline: true,
            onSubmit(value) { const r = M.libCardUpdate(state().cardLib, g.id, card.id, value); if (r.ok) apply(setLib(r.lib), '字卡已更新。'); else host.toast(r.reason); }
          });
        });
        const del = el('button', 'card-del', '删除');
        del.type = 'button';
        del.addEventListener('click', () => {
          host.confirm({
            title: '删除这张字卡？', text: card.text, confirmLabel: '删除', danger: true,
            onConfirm() { const r = M.libCardDelete(state().cardLib, card.id); if (r.ok) apply(setLib(r.lib), '已删除。'); else host.toast(r.reason); }
          });
        });
        actions.append(use, edit, del);
        article.append(actions);
        return article;
      }
      function renderPokes(s) {
        pokeCount.textContent = s.pokes.length + ' 条';
        pokeList.replaceChildren(...s.pokes.map((phrase, index) => {
          const row = el('div', 'poke-row');
          row.append(el('p', '', phrase));
          const del = el('button', '', '删除');
          del.type = 'button';
          del.setAttribute('aria-label', '删除动作：' + phrase);
          del.addEventListener('click', () => {
            const list = state().pokes.slice();
            list.splice(index, 1);
            apply(Object.assign({}, state(), { pokes: M.normPokes(list) }), '已从动作池移除。');
          });
          row.append(del);
          return row;
        }));
      }
      function useCard(text) {
        const input = document.querySelector('#message-input');
        if (!input) return;
        if (input.value.trim()) { host.toast('输入框里还有未发送的话，先发送或清空，再选择字卡。'); return; }
        input.value = text;
        host.closeDetail();
        if (host.resizeInput) host.resizeInput();
        input.focus();
        host.toast('字卡已放入输入框，点击发送即可。');
      }

      /* 新增字卡：目标分组。选着「全部」时放进同范围的「未分组」。 */
      function targetGroup() {
        const s = state();
        if (group !== 'all') return group;
        const ensured = M.ensureUncat(s.cardLib);
        if (ensured.lib !== s.cardLib) host.persist(Object.assign({}, s, { cardLib: ensured.lib }));
        return ensured.group.id;
      }
      document.querySelector('#card-add-open').addEventListener('click', () => {
        addRow.hidden = !addRow.hidden;
        if (!addRow.hidden) newCard.focus();
      });
      document.querySelector('#card-add-do').addEventListener('click', () => {
        const value = newCard.value;
        const gid = targetGroup();
        const r = M.libCardAdd(state().cardLib, gid, value, host.newId);
        if (!r.ok && !r.added) { host.toast(r.reason); return; }
        newCard.value = '';
        addRow.hidden = true;
        apply(setLib(r.lib), '已加入 ' + r.added.length + ' 张字卡。');
      });

      /* 分组管理：改名 / 隐藏 / 删除（删除时问清楚字卡要不要一起删）。 */
      document.querySelector('#group-new').addEventListener('click', () => {
        host.prompt({
          title: '新建分组', label: '分组名字', placeholder: '比如：晚安',
          onSubmit(value) {
            const r = M.libGroupAdd(state().cardLib, { name: value }, host.newId);
            if (!r.ok) { host.toast(r.reason); return; }
            group = r.group.id;
            apply(setLib(r.lib), '新建了分组。');
          }
        });
      });
      document.querySelector('#group-manage').addEventListener('click', () => {
        if (group === 'all') { host.toast('先选一个分组，再管理它。'); return; }
        const s = state(), g = M.findGroup(s.cardLib, group);
        if (!g) return;
        const items = [];
        if (g.name !== M.UNCAT) {
          items.push({ label: '改名', description: '把「' + g.name + '」换个名字', onSelect() {
            host.prompt({
              title: '重命名分组', label: '分组名字', value: g.name,
              onSubmit(value) { const r = M.libGroupRename(state().cardLib, g.id, value); if (r.ok) apply(setLib(r.lib), '分组已改名。'); else host.toast(r.reason); }
            });
          } });
          items.push({ label: g.hidden ? '显示这个分组' : '隐藏这个分组', description: g.hidden ? '重新参与 TA 抽卡' : '隐藏后 TA 不会从这里抽卡，字卡还在库里', onSelect() {
            const r = M.libGroupHide(state().cardLib, g.id, !g.hidden);
            if (r.ok) apply(setLib(r.lib), g.hidden ? '分组已显示。' : '分组已隐藏，TA 不会再抽到它。'); else host.toast(r.reason);
          } });
        }
        if (g.name !== M.UNCAT) {
          const n = g.items.length;
          items.push({ label: '删除分组', danger: true, description: n ? '接下来问你：这 ' + n + ' 张字卡怎么办' : '这个分组是空的，直接删掉', onSelect() {
            askDeleteGroup(g, n);
          } });
        }
        host.choose({ title: '分组设置', items });
      });
      function askDeleteGroup(g, n) {
        if (!n) {
          host.confirm({
            title: '删除分组「' + g.name + '」？', text: '这个分组是空的，删掉不会丢字卡。', confirmLabel: '删除', danger: true,
            onConfirm() { const r = M.libGroupDelete(state().cardLib, g.id); if (r.ok) { group = 'all'; apply(setLib(r.lib), '分组已删除。'); } else host.toast(r.reason); }
          });
          return;
        }
        host.choose({
          title: '分组里有 ' + n + ' 张字卡',
          text: '选「只删分组」会移进同范围的「未分组」，不会丢；选「连字卡一起删」则这 ' + n + ' 张一起消失，删掉就找不回来了。',
          items: [
            { label: '只删分组', description: n + ' 张字卡移进「未分组」', onSelect() { const r = M.libGroupDelete(state().cardLib, g.id, { withCards: false }); if (r.ok) { group = 'all'; apply(setLib(r.lib), r.moved + ' 张字卡进了未分组。'); } else host.toast(r.reason); } },
            { label: '连字卡一起删', danger: true, description: '这 ' + n + ' 张一起消失，找不回来', onSelect() { const r = M.libGroupDelete(state().cardLib, g.id, { withCards: true }); if (r.ok) { group = 'all'; apply(setLib(r.lib), '分组和组内 ' + r.deleted + ' 张都删了。'); } else host.toast(r.reason); } }
          ]
        });
      }

      /* 拍一拍动作池：可增可删。 */
      document.querySelector('#poke-add-do').addEventListener('click', () => {
        const value = M.cleanText(pokeNew.value, 60);
        if (!value) { host.toast('先写一句拍一拍的动作。'); return; }
        if (state().pokes.includes(value)) { host.toast('动作池里已经有这句了。'); return; }
        pokeNew.value = '';
        apply(Object.assign({}, state(), { pokes: M.normPokes(state().pokes.concat([value])) }), '已加入动作池。');
      });
      pokeNew.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#poke-add-do').click(); }
      });

      modeButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));

      const exportBtn = document.querySelector('#card-export');
      if (exportBtn) exportBtn.addEventListener('click', () => host.exportCards());
      const importBtn = document.querySelector('#card-import');
      if (importBtn) importBtn.addEventListener('click', () => host.importCards());

      search.addEventListener('input', render);

      const api = {
        render,
        reset() { mode = 'cards'; group = 'all'; if (search) search.value = ''; },
        setMode,
        get mode() { return mode; },
        get group() { return group; }
      };
      return api;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
