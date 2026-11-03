(function (root) {
  'use strict';
  const palettes = [
    { id: 'gray-blue', name: '灰蓝', self: '#c4d0da' },
    { id: 'pink-white', name: '粉白', self: '#f8edf0' },
    { id: 'pink-gray', name: '粉灰', self: '#d8c5cc' },
    { id: 'black-white', name: '漫画纸片', self: '#ffffff', border: '#242426' },
    { id: 'gray-white', name: '灰白', self: '#e7e7e9' }
  ];
  function normalize(value) {
    const v = value || {};
    return { theme: v.theme === 'light' ? 'light' : 'dark', palette: palettes.some(p => p.id === v.palette) ? v.palette : 'gray-blue' };
  }
  function colors(theme, palette) {
    const p = palettes.find(p => p.id === palette) || palettes[0];
    const dark = theme !== 'light';
    return {
      peer: dark ? '#373737' : '#ffffff', peerText: dark ? '#f5f5f5' : '#34343a',
      self: p.self, selfText: p.border ? '#242426' : '#34343a',
      selfBackground: p.self,
      selfBorder: p.border || 'var(--bubble-border)',
      selfBorderWidth: p.border ? '2px' : '1px',
      selfShadow: p.border ? '3px 3px 0 #242426' : 'none'
    };
  }
  const api = { palettes, normalize, colors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Appearance44 = api;
})(typeof window !== 'undefined' ? window : globalThis);
