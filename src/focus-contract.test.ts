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

  it("focus 는 입력면(textarea)을 겨냥한다 — 컨테이너는 폴백일 뿐(스톰프 금지)", () => {
    // 실측(코어 focus trace): renderer.focus()가 컨테이너를 포커스해, ghostty-web 이
    // 방금 잡은 textarea 포커스를 같은 ms 에 밀어냈다(triple-flip). 키보드·IME 의
    // 소유자는 textarea 다 — 있으면 반드시 그쪽을 포커스한다.
    let taFocus = 0;
    let elFocus = 0;
    const textarea = {
      focus: () => {
        taFocus += 1;
      },
    } as unknown as HTMLTextAreaElement;
    const element = {
      focus: () => {
        elFocus += 1;
      },
    } as unknown as HTMLElement;
    const terminal = {
      element: undefined as HTMLElement | undefined,
      textarea,
      focus: () => {},
      open(container: HTMLElement) {
        this.element = container;
        this.focus();
      },
    };

    openWithoutImplicitFocus(terminal, element);
    terminal.focus();
    assert.equal(taFocus, 1);
    assert.equal(elFocus, 0);
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
