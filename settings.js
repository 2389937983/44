(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  root.SlowSettings = {
    init(host) {
      const M = root.ChatModel;
      const body = document.querySelector('#settings-body');
      const state = () => host.getState();

      function write(key, value) { host.setSetting(key, value); }
      function rangeRow(key) {
        const def = M.SETTINGS[key], s = state();
        const row = el('label', 'setting-row');
        const info = el('span');
        info.append(el('strong', '', def.label));
        info.append(el('small', '', '默认 ' + def.def + (def.unit || '')));
        row.append(info);
        if (def.min === 0 && def.max === 1) {
          const input = el('input');
          input.type = 'checkbox';
          input.className = 'switch';
          input.dataset.setBool = key;
          input.checked = s.settings[key] === 1;
          input.addEventListener('change', () => write(key, input.checked ? 1 : 0));
          row.append(input);
        } else {
          const wrap = el('span', 'range-wrap');
          const input = el('input');
          input.type = 'range';
          input.className = 'range';
          input.dataset.setRange = key;
          input.min = String(def.min);
          input.max = String(def.max);
          input.step = '1';
          input.value = String(s.settings[key]);
          const out = el('span', 'range-value', s.settings[key] + (def.unit || ''));
          input.addEventListener('input', () => { out.textContent = input.value + (def.unit || ''); });
          input.addEventListener('change', () => write(key, Number(input.value)));
          wrap.append(input, out);
          row.append(wrap);
        }
        return row;
      }
      function nameField(key, label) {
        const labelEl = el('label', 'field-label', label);
        const input = el('input');
        input.maxLength = 24;
        input.autocomplete = 'off';
        input.dataset.setName = key;
        input.value = state()[key];
        input.addEventListener('input', () => host.setProfile(key, input.value));
        labelEl.append(input);
        return labelEl;
      }
      function avatarRow(which, label) {
        const s = state();
        const row = el('div', 'avatar-row');
        const preview = el('span', 'avatar-preview');
        const img = el('img');
        img.src = s[which + 'Avatar'] || ('assets/' + which + '.svg');
        img.alt = label + '预览';
        preview.append(img);
        const info = el('span', 'avatar-info');
        info.append(el('strong', '', label));
        info.append(el('small', '', s[which + 'Avatar'] ? '已换成自己的图片' : '还是默认头像'));
        const tools = el('span', 'avatar-tools');
        const pick = el('button', 'text-button', '更换');
        pick.type = 'button';
        pick.dataset.uploadAvatar = which;
        pick.addEventListener('click', () => host.requestImage('avatar-' + which, dataUrl => {
          host.updateAvatar(which, dataUrl);
          render();
        }));
        tools.append(pick);
        if (s[which + 'Avatar']) {
          const reset = el('button', 'text-button', '恢复默认');
          reset.type = 'button';
          reset.addEventListener('click', () => { host.updateAvatar(which, ''); render(); host.toast('已恢复默认头像。'); });
          tools.append(reset);
        }
        row.append(preview, info, tools);
        return row;
      }
      function backgroundGroup() {
        const s = state();
        const group = el('div', 'settings-group');
        group.append(el('h4', '', '聊天背景'));
        const preview = el('div', 'wall-preview');
        if (s.walls.chat) { const img = el('img'); img.src = s.walls.chat; img.alt = '聊天背景预览'; preview.append(img); }
        else preview.append(el('span', '', '跟随当前聊天主题'));
        group.append(preview);
        const tools = el('div', 'wall-tools');
        const pick = el('button', 'text-button', '上传背景');
        pick.type = 'button';
        pick.addEventListener('click', () => host.requestImage('background', dataUrl => { host.updateWall(dataUrl); render(); }));
        tools.append(pick);
        if (s.walls.chat) {
          const reset = el('button', 'text-button', '恢复默认');
          reset.type = 'button';
          reset.addEventListener('click', () => { host.updateWall(''); render(); host.toast('聊天背景已恢复默认。'); });
          tools.append(reset);
        }
        group.append(tools);
        group.append(el('p', 'local-note', '背景只作用在聊天消息区，换完即时生效，刷新后还在。'));
        return group;
      }
      function dataGroup() {
        const group = el('div', 'settings-group');
        group.append(el('h4', '', '数据管理'));
        const tools = el('div', 'data-tools');
        const exp = el('button', 'secondary-button', '导出备份');
        exp.type = 'button';
        exp.addEventListener('click', () => host.exportBackup());
        const imp = el('button', 'secondary-button', '导入备份');
        imp.type = 'button';
        imp.addEventListener('click', () => host.importBackup());
        const wipe = el('button', 'secondary-button danger', '清空重来');
        wipe.type = 'button';
        wipe.addEventListener('click', () => host.confirm({
          title: '清空重来？',
          text: '聊天记录、字卡库、拍一拍动作池、头像与背景都会被清掉，回到刚打开时的样子。清掉就找不回来了。',
          confirmLabel: '清空', danger: true,
          onConfirm() { host.resetAll(); }
        }));
        tools.append(exp, imp, wipe);
        group.append(tools);
        group.append(el('p', 'local-note', '字卡库自己还有「导出字卡 / 导入字卡」，可以只搬字卡；这里导出的是整站备份。'));
        return group;
      }

      /* 分组上的可选 sec：相邻同 sec 的组归并成一个 .setsec 大标题（29 的设置页分类口径）。 */
      function sectionList() {
        return [
          { title: '个人资料', build: () => [nameField('selfName', '我的昵称'), nameField('peerName', '梦角昵称')] },
          { title: '头像', build: () => [avatarRow('self', '我的头像'), avatarRow('peer', '对方头像')] },
          { title: '聊天显示', build: () => [(() => { const row = el('label', 'setting-row'); const info = el('span'); info.append(el('strong', '', '显示消息时间'), el('small', '', '灰色时间，显示在头像下方')); const input = el('input'); input.type = 'checkbox'; input.className = 'switch'; input.checked = state().showTime; input.addEventListener('change', () => host.setShowTime(input.checked)); row.append(info, input); return row; })()] },
          backgroundGroup(),
          { sec: '消息互动', title: '回复节奏', build: () => [rangeRow('replyMin'), rangeRow('replyMax'), rangeRow('cardMin'), rangeRow('cardMax'), rangeRow('readNoP'), rangeRow('quoteProb')] },
          { sec: '消息互动', title: '拍一拍', build: () => [rangeRow('pokeBack'), rangeRow('pokeReplyProb'), rangeRow('pokeMsgProb')] },
          { sec: '消息互动', title: '撤回', build: () => [rangeRow('recallProb'), rangeRow('recShow')] },
          { sec: '主动联系', title: '主动消息', build: () => [rangeRow('autoOn'), rangeRow('autoMin'), rangeRow('autoMax')] },
          /* 语音通话：工单第10单第6条的 8 项，一项不少；来电间隔是一对，写在同一组里。 */
          { sec: '模拟电话', title: '语音通话', build: () => [rangeRow('callOn'), rangeRow('callBusyP'), rangeRow('callRejectP'), rangeRow('callAnswerP'), rangeRow('callHangOn'), rangeRow('callHgSec'), rangeRow('callInOn'), rangeRow('callInMin'), rangeRow('callInMax')] },
          { sec: '存储与备份', title: '数据管理', build: () => [rangeRow('exportPokes'), dataGroup()] }
        ];
      }
      function render() {
        const nodes = [];
        let lastSec = null;
        sectionList().forEach(section => {
          if (section instanceof HTMLElement) { nodes.push(section); return; }
          if (section.sec && section.sec !== lastSec) {
            lastSec = section.sec;
            const heading = el('div', 'setsec');
            heading.append(el('span', '', section.sec));
            nodes.push(heading);
          } else if (!section.sec) { lastSec = null; }
          const group = el('div', 'settings-group');
          group.append(el('h4', '', section.title));
          section.build().forEach(node => group.append(node));
          nodes.push(group);
        });
        body.replaceChildren(...nodes);
      }

      return { render };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

