#!/usr/bin/env node
/**
 * fix-meme-draft.cjs - idempotently repair dsh-meme's "text + sticker" draft handling.
 *
 * Why a script instead of a pnpm patch: the patch file must match the package bytes exactly,
 * and GNU patch / pnpm disagree about CR handling on this file (CRLF, 1681 lines). A script
 * doing exact string replacements is deterministic and safe to re-run after any pnpm install.
 *
 * Usage: node fix-meme-draft.cjs [--check]
 */
const fs = require('node:fs');
const PKG = (process.env.USERPROFILE || 'C:/Users/<user>') + '/.dsh/profiles/web/node_modules/dsh-meme/client.js';
const raw = fs.readFileSync(PKG, 'utf8');
const crlf = /\r\n/.test(raw);
let s = raw.split('\r\n').join('\n');

if (s.includes('liveDraft0')) { console.log('already fixed - nothing to do'); process.exit(0); }
if (process.argv.includes('--check')) { console.log('NOT fixed'); process.exit(1); }

const edits = [
  ['(props) => React.createElement(MemeButton, { input: props.input }),',
   '(props) => React.createElement(MemeButton, { input: props.input, useInput: props.useInput }),'],
  ['        const open = React.useSyncExternalStore(store.subscribe, store.get)\n        return React.createElement(\'button\', {',
   '        const open = React.useSyncExternalStore(store.subscribe, store.get)\n        const useInputHook = (typeof props.useInput === \'function\' ? props.useInput : function () { return void 0 })\n        const liveDraft0 = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))\n        return React.createElement(\'button\', {'],
  ['              const d = props && props.input && typeof props.input.draft === \'string\' ? props.input.draft : \'\'',
   '              const d = (typeof liveDraft0 === \'string\' ? liveDraft0 : (props && props.input && typeof props.input.draft === \'string\' ? props.input.draft : \'\'))'],
  ['          inputActions: props.inputActions,\n          getConversation: () => ctx.get(\'conversation\'),',
   '          inputActions: props.inputActions,\n          useInput: props.useInput,\n          getConversation: () => ctx.get(\'conversation\'),'],
  ['      const actions = props.inputActions\n      const open = React.useSyncExternalStore(store.subscribe, store.get)',
   '      const actions = props.inputActions\n      const useInputHook = (typeof props.useInput === \'function\' ? props.useInput : function () { return void 0 })\n      const liveDraft = useInputHook((s) => (s && typeof s.draft === \'string\' ? s.draft : void 0))\n      const open = React.useSyncExternalStore(store.subscribe, store.get)'],
  ['        const cur = store.getBase() || \'\'',
   '        const cur = (typeof liveDraft === \'string\' && liveDraft !== \'\' ? liveDraft : (store.getBase() || \'\'))'],
  ['        try { if (actions && actions.submit) actions.submit() } catch (e) {}',
   '        try { if (actions && actions.submit) setTimeout(function () { try { actions.submit() } catch (e) {} }, 0) } catch (e) {}'],
];
let i = 0;
for (const [from, to] of edits) {
  i++;
  const n = s.split(from).length - 1;
  if (n !== 1) { console.log('ABORT edit#' + i + ' matched x' + n + ' -> ' + JSON.stringify(from.slice(0, 70))); process.exit(2); }
  s = s.split(from).join(to);
}
fs.writeFileSync(PKG, crlf ? s.split('\n').join('\r\n') : s, 'utf8');
console.log('fixed: dsh-meme draft handling (' + edits.length + ' edits) - hard refresh the browser to load it');
