// tm-clean 13: remappable keyboard shortcuts. Adapted from drift-ref's
// frontend/tests/simplify.test.mjs (keybind parts). Run from frontend/: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYBINDS, KEYBIND_HELP, buildResolvedFromOverrides, matchKeybind, findBindingConflict,
  captureEventToBinding, writeKbOverrides, loadKbOverrides, resolveKeybinds, jumpDigit,
  bindingLabel, canDismiss,
} from '../src/keybinds.js';

const event = (key, modifiers = {}) => ({ key, ...modifiers });
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };

test('every keyboard action is editable, persists, resolves, and appears in help', () => {
  for (const [action, binding] of Object.entries(KEYBINDS)) {
    assert.equal(binding.customizable, true, action);
    const changed = captureEventToBinding(event('F8', { altKey: true }));
    writeKbOverrides({ [action]: changed });
    assert.deepEqual(loadKbOverrides()[action], changed);
    assert.equal(matchKeybind(event('F8', { altKey: true }), resolveKeybinds()[action]), true, action);
    assert.equal(bindingLabel(resolveKeybinds()[action]), 'Alt+F8');
    assert.ok(KEYBIND_HELP.some((g) => g.items.some((i) => i.action === action)), action);
  }
  writeKbOverrides({});
  assert.deepEqual(resolveKeybinds(), buildResolvedFromOverrides({}));
});

test('default registry has no conflicts; sheet navigation conflicts in both sheets', () => {
  const kb = resolveKeybinds();
  for (const [action, binding] of Object.entries(kb)) assert.equal(findBindingConflict(binding, action, kb), null, action);
  assert.equal(findBindingConflict(kb.MOVE_DOWN, 'READING_NEW_BOOK', kb), 'MOVE_DOWN');
  assert.equal(findBindingConflict(kb.NEW_TASK, 'EDIT_TASK', kb), 'NEW_TASK');
  assert.equal(findBindingConflict(kb.READING_NEW_BOOK, 'NEW_TASK', kb), null);
  // '/' stays per-sheet: grid task search and reading search share it.
  assert.equal(findBindingConflict(kb.FOCUS_SEARCH, 'READING_FOCUS_SEARCH', kb), null);
});

test('defaults keep b15a9f6 keys', () => {
  const kb = resolveKeybinds();
  assert.equal(matchKeybind(event('ArrowLeft'), kb.MOVE_LEFT), true);
  assert.equal(matchKeybind(event('ArrowLeft', { shiftKey: true }), kb.RANGE_LEFT), true);
  assert.equal(matchKeybind(event('ArrowLeft', { shiftKey: true }), kb.MOVE_LEFT), false);
  assert.equal(matchKeybind(event('Enter'), kb.INCREMENT), true);
  assert.equal(matchKeybind(event('Enter', { shiftKey: true }), kb.DECREMENT), true);
  assert.equal(matchKeybind(event('Delete'), kb.DELETE_CELL), true);
  assert.equal(matchKeybind(event('Backspace'), kb.BACKSPACE_CELL), true);
  assert.equal(matchKeybind(event('Escape'), kb.CLEAR_SELECTION), true);
  assert.equal(matchKeybind(event('Enter'), kb.READING_CHECKPOINT), true);
  assert.equal(matchKeybind(event('/'), kb.FOCUS_SEARCH), true);
});

test('Shift+digit jump is layout-independent (event.code), like b15a9f6', () => {
  const kb = resolveKeybinds();
  assert.equal(jumpDigit(event('#', { shiftKey: true, code: 'Digit3' }), kb), '3');
  assert.equal(jumpDigit(event('§', { shiftKey: true, code: 'Digit3' }), kb), '3'); // non-US layout
  assert.equal(jumpDigit(event('!', { shiftKey: true }), kb), '1');                  // no code: US mapping
  assert.equal(jumpDigit(event('3', { code: 'Digit3' }), kb), null);                  // unshifted
  assert.deepEqual(captureEventToBinding(event('£', { shiftKey: true, code: 'Digit3' })), { key: '3', shift: true, meta: false, ctrl: false, alt: false });
});

test('changed bindings drive jump, range, completion, delete and Escape', () => {
  const kb = buildResolvedFromOverrides({ JUMP_3: { key: 'j' }, RANGE_LEFT: { key: 'h', alt: true }, INCREMENT: { key: 'i' }, DELETE_CELL: { key: 'd' }, CLEAR_SELECTION: { key: 'x' } });
  assert.equal(jumpDigit(event('j'), kb), '3');
  assert.equal(jumpDigit(event('#', { shiftKey: true, code: 'Digit3' }), kb), null);
  assert.equal(matchKeybind(event('h', { altKey: true }), kb.RANGE_LEFT), true);
  assert.equal(matchKeybind(event('i'), kb.INCREMENT), true);
  assert.equal(matchKeybind(event('d'), kb.DELETE_CELL), true);
  const typing = { closest: () => ({}) };
  assert.equal(canDismiss(event('x', { target: typing }), kb.CLEAR_SELECTION), false); // never eats typed text
  assert.equal(canDismiss(event('x'), kb.CLEAR_SELECTION), true);
  assert.equal(canDismiss(event('Escape', { target: typing }), kb.CLEAR_SELECTION), true); // native Esc still dismisses editors
  assert.equal(findBindingConflict(captureEventToBinding(event('!', { shiftKey: true, code: 'Digit1' })), 'EDIT_TASK', buildResolvedFromOverrides({})), 'JUMP_1');
});
