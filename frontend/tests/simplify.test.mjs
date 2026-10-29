import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYBINDS, KEYBIND_HELP, buildResolvedFromOverrides, matchKeybind, findBindingConflict, captureEventToBinding, writeKbOverrides, loadKbOverrides, resolveKeybinds, jumpDigit, bindingLabel, canDismiss } from '../src/keybinds.js';
import { navigationMatches, nextSearchIndex } from '../src/navigation.js';
const event = (key, modifiers = {}) => ({ key, ...modifiers });
test('navigation matches every destination; keyboard wrapping handles no results', () => {
  for (const name of ['Main', 'Grid', 'Reading', 'Calendar', 'Reports', 'Settings']) {
    assert.equal(navigationMatches(name)[0].label, name);
  }
  assert.equal(navigationMatches('Grid')[0].view, 'grid');
  assert.deepEqual(navigationMatches('nothing matches'), []);
  assert.equal(nextSearchIndex(0, -1, 3), 2);
  assert.equal(nextSearchIndex(0, 1, 0), 0);
});
test('every listed keyboard action is editable, persists, resolves, and updates help', () => {
  const memory = new Map();
  globalThis.localStorage = { getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) };
  for (const [action, binding] of Object.entries(KEYBINDS)) {
    assert.equal(binding.customizable, true, action);
    const changed = captureEventToBinding(event('F8', { altKey: true }));
    writeKbOverrides({ [action]: changed });
    assert.deepEqual(loadKbOverrides()[action], changed);
    assert.equal(matchKeybind(event('F8', { altKey: true }), resolveKeybinds()[action]), true, action);
    assert.equal(bindingLabel(resolveKeybinds()[action]), 'Alt+F8');
    assert.ok(KEYBIND_HELP.some(g => g.items.some(i => i.action === action)));
  }
  writeKbOverrides({});
  assert.deepEqual(resolveKeybinds(), buildResolvedFromOverrides({}));
});
test('default registry has no conflicts; shared sheet navigation conflicts in both sheets', () => {
  const kb = resolveKeybinds();
  for (const [action, binding] of Object.entries(kb)) assert.equal(findBindingConflict(binding, action, kb), null, action);
  assert.equal(findBindingConflict(kb.MOVE_DOWN, 'READING_NEW_BOOK', kb), 'MOVE_DOWN');
  assert.equal(findBindingConflict(kb.NEW_TASK, 'EDIT_TASK', kb), 'NEW_TASK');
  assert.equal(findBindingConflict(kb.READING_NEW_BOOK, 'NEW_TASK', kb), null);
});
test('jump digits, ranges, completion, delete and Escape resolve changed bindings', () => {
  const kb = buildResolvedFromOverrides({ JUMP_3: { key: 'j' }, RANGE_LEFT: { key: 'h', alt: true }, INCREMENT: { key: 'i' }, DELETE_CELL: { key: 'd' }, CLEAR_SELECTION: { key: 'x' } });
  assert.equal(jumpDigit(event('j'), kb), '3');
  assert.equal(jumpDigit(event('#', { shiftKey: true }), kb), null);
  assert.equal(jumpDigit(event('!', { shiftKey: true }), kb), '1');
  assert.equal(matchKeybind(event('h', { altKey: true }), kb.RANGE_LEFT), true);
  assert.equal(matchKeybind(event('i'), kb.INCREMENT), true);
  assert.equal(matchKeybind(event('d'), kb.DELETE_CELL), true);
  assert.equal(canDismiss(event('x', { target: { closest: () => ({}) } }), kb.CLEAR_SELECTION), false);
  assert.equal(canDismiss(event('x'), kb.CLEAR_SELECTION), true);
  assert.equal(canDismiss(event('Escape', { target: { closest: () => ({}) } }), kb.CLEAR_SELECTION), true);
  assert.equal(findBindingConflict(captureEventToBinding(event('!', { shiftKey: true })), 'EDIT_TASK', buildResolvedFromOverrides({})), 'JUMP_1');
});
