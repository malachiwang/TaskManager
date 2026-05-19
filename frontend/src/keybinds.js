// Centralized keyboard shortcut definitions — Keyboard Workflow Phase 1.
//
// Phase 1: these are read-only constants imported directly by TaskGrid.
// Future phase: load user overrides from localStorage('taskos-keybinds')
// and merge with these defaults before passing to the handler.
//
// Each entry: { key: string, shift: boolean, label: string }
//   key   — KeyboardEvent.key value
//   shift — whether Shift must be held
//   label — short display text for the keyboard legend

export const KEYBINDS = {
  INCREMENT:       { key: 'Enter',      shift: false, label: '↵ mark'    },
  DECREMENT:       { key: 'Enter',      shift: true,  label: '⇧↵ −1'     },
  MOVE_LEFT:       { key: 'ArrowLeft',  shift: false, label: '←'         },
  MOVE_RIGHT:      { key: 'ArrowRight', shift: false, label: '→'         },
  MOVE_UP:         { key: 'ArrowUp',    shift: false, label: '↑'         },
  MOVE_DOWN:       { key: 'ArrowDown',  shift: false, label: '↓'         },
  EDIT_TASK:       { key: 'e',          shift: false, label: 'E edit'     },
  NEW_TASK:        { key: 'n',          shift: false, label: 'N new'      },
  CLEAR_SELECTION: { key: 'Escape',     shift: false, label: 'Esc clear'  },
};

// Compact single-line legend text — kept for reference, no longer rendered inline.
export const KBD_LEGEND = '↵ mark  ⇧↵ −1  ←↑↓→ move  E edit  N new  Esc clear';

// Structured shortcut reference for the keyboard help panel — P4.
// Groups: Navigation, Editing, View.
export const KEYBIND_HELP = [
  {
    group: 'Navigation',
    items: [
      { keys: '↑ / ↓', desc: 'Move selection between tasks' },
      { keys: '← / →', desc: 'Move selection between dates' },
    ],
  },
  {
    group: 'Editing',
    items: [
      { keys: '↵',     desc: 'Increment completion for selected cell' },
      { keys: '⇧ ↵',   desc: 'Decrement completion for selected cell' },
      { keys: 'E',     desc: 'Edit the selected task' },
      { keys: 'N',     desc: 'Add a new task' },
    ],
  },
  {
    group: 'View',
    items: [
      { keys: 'Esc', desc: 'Close modal, close help, or clear selection' },
      { keys: '?',   desc: 'Show or hide keyboard shortcuts' },
    ],
  },
];
