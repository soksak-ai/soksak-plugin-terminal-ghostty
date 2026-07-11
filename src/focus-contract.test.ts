import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openWithoutImplicitFocus } from "./focus-contract.ts";
import { CompositionCommitState } from "./ime-preedit.ts";

describe("ghostty focus contract", () => {
  it("treats open as mount only and focuses exactly once on explicit intent", () => {
    let focusCalls = 0;
    const element = {
      focus: () => {
        focusCalls += 1;
      },
    } as unknown as HTMLElement;
    const terminal = {
      element: undefined as HTMLElement | undefined,
      focus: () => {},
      open(container: HTMLElement) {
        this.element = container;
        this.focus();
      },
    };

    openWithoutImplicitFocus(terminal, element);
    assert.equal(focusCalls, 0);

    terminal.focus();
    assert.equal(focusCalls, 1);
  });
});

describe("ghostty composition transfer", () => {
  it("commits the last preedit exactly once", () => {
    const composition = new CompositionCommitState();
    const sent: string[] = [];
    composition.start();
    composition.update("ㅎ");
    composition.update("한");

    assert.equal(composition.commit((data) => sent.push(data)), true);
    assert.equal(composition.commit((data) => sent.push(data)), false);
    assert.deepEqual(sent, ["한"]);
  });
});
