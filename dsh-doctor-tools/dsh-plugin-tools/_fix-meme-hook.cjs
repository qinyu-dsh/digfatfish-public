#!/usr/bin/env node
const fs = require('node:fs');
const P = process.env.USERPROFILE + '/.dsh/profiles/web/node_modules/dsh-meme/client.js';
const raw = fs.readFileSync(P, 'utf8');
const crlf = /\r\n/.test(raw);
let s = raw.split('\r\n').join('\n');

const edits = [
  // A) MemeButton：hook 必须在渲染期调用（原来被我放进 onClick → Invalid hook call）
  ['      return function MemeButton(props) {\n        const open = React.useSyncExternalStore(store.subscribe, store.get)\n        return React.createElement(\'button\', {',
   '      return function MemeButton(props) {\n        const open = React.useSyncExternalStore(store.subscribe, store.get)\n        const useInputHook = (typeof props.useInput === \'function\' ? props.useInput : function () { return void 0 })\n        const liveDraft0 = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))\n        return React.createElement(\'button\', {'],
  // B) onClick 里只读渲染期拿到的值
  ['            if (!store.get()) {\n              const useInputHook = props.useInput || (function () { return void 0 })\n              const liveDraft0 = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))\n              const d = (typeof liveDraft0 === \'string\' ? liveDraft0 : (props && props.input && typeof props.input.draft === \'string\' ? props.input.draft : \'\'))\n              store.setBase(d)\n            }',
   '            if (!store.get()) {\n              const d = (typeof liveDraft0 === \'string\' ? liveDraft0 : (props && props.input && typeof props.input.draft === \'string\' ? props.input.draft : \'\'))\n              store.setBase(d)\n            }'],
  // C) MemeBoard：同样给个类型守卫
  ['      const useInputHook = props.useInput || (function () { return void 0 })\n      const liveDraft = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))',
   '      const useInputHook = (typeof props.useInput === \'function\' ? props.useInput : function () { return void 0 })\n      const liveDraft = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))'],
];
let i = 0;
for (const [from, to] of edits) {
  i++;
  const n = s.split(from).length - 1;
  if (n !== 1) { console.log('ABORT edit#' + i + ' x' + n); console.log(JSON.stringify(from.slice(0, 80))); process.exit(1); }
  s = s.split(from).join(to);
}
fs.writeFileSync(P, crlf ? s.split('\n').join('\r\n') : s, 'utf8');
console.log('fixed: hook moved to render scope (' + edits.length + '/3 edits)');
