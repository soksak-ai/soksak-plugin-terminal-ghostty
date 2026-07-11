interface GhosttyFocusableTerminal {
  element?: HTMLElement;
  focus(): void;
  open(container: HTMLElement): void;
}

/**
 * ghostty-web open() calls focus() and its stock focus schedules a second sticky
 * focus. Mount is not focus intent, so suppress that call while opening and
 * replace the instance method with one synchronous, container-owned focus.
 */
export function openWithoutImplicitFocus<T extends GhosttyFocusableTerminal>(
  terminal: T,
  container: HTMLElement,
): void {
  terminal.focus = () => {};
  try {
    terminal.open(container);
  } finally {
    terminal.focus = () => terminal.element?.focus();
  }
}
