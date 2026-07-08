# Accessibility

TaskManager is a personal productivity tool. The following notes describe the current state of accessibility support and known limitations.

## What works

- **Keyboard navigation**: The task grid is fully keyboard-navigable. Arrow keys move between cells, Enter/Shift+Enter increment and decrement completion counts, N opens Add Task, E opens Edit, and ? shows the keyboard shortcut reference. All keybinds are customizable in Settings.
- **Focus management**: Dialogs (task modal, keyboard help panel) return focus to the trigger element on close.
- **Screen reader labels**: Interactive controls include `aria-label`, `aria-haspopup`, and `aria-expanded` attributes where applicable.
- **Color is not the sole indicator**: Urgency levels use both color and font-weight. Completion state is shown with a distinct box shape in addition to color.
- **Contrast**: The default color scheme targets sufficient contrast for body text and key data.
- **Reduced motion**: The animated node-and-edge network in the top bar and on the loading screen respects the `prefers-reduced-motion` system setting. When reduced motion is requested, the animation is rendered as a single static frame with no movement or cursor interaction. The network is decorative and marked `aria-hidden`.

## Known limitations

- The main spreadsheet grid is a dense `<table>` with many columns. Screen reader navigation through hundreds of date cells may be verbose.
- Date cells do not have individual `aria-label` descriptions. Screen readers will announce the column header (date) and row data, but not a composed description.
- The Paper Workstation theme uses a warm palette that may have slightly lower contrast on certain displays. Sheets Classic is the higher-contrast alternative.
- Mobile and touch input are not supported. The app is designed for pointer + keyboard on a desktop or laptop.
- No dedicated high-contrast mode is implemented (Sheets Classic is the higher-contrast of the two themes).
- The decorative top-bar network is a `<canvas>` element. It is `aria-hidden` and non-interactive, but it has not been reviewed against a full range of assistive technologies.
- Focus management, color/contrast, and screen-reader labelling still need a thorough end-to-end review.

## Ongoing effort

Accessibility here is a good-faith, ongoing effort on a pre-public, local-first project. Nothing on this page is a claim of WCAG conformance or a completed accessibility certification.

## Reporting issues

This is a personal-use tool with no formal support channel. Feedback can be recorded by opening a note in the app or editing this file locally.
