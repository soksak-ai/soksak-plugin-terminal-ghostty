interface GhosttyFocusableTerminal {
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
  focus(): void;
  open(container: HTMLElement): void;
}

/**
 * ghostty-web open() calls focus() and its stock focus schedules a second sticky
 * focus. Mount is not focus intent, so suppress that call while opening and
 * replace the instance method with one synchronous focus aimed at the INPUT
 * surface: ghostty-web owns keyboard/IME through its hidden textarea, so that
 * is what must receive focus. Focusing the container instead displaced the
 * textarea focus ghostty-web had just taken (measured: same-millisecond
 * focusin/focusout/focusin flip on every click). The container remains only a
 * fallback for the window before the textarea exists.
 */
export function openWithoutImplicitFocus<T extends GhosttyFocusableTerminal>(
  terminal: T,
  container: HTMLElement,
): void {
  terminal.focus = () => {};
  try {
    terminal.open(container);
  } finally {
    terminal.focus = () => (terminal.textarea ?? terminal.element)?.focus();
  }
}
