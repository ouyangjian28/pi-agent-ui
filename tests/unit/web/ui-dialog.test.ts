// @vitest-environment jsdom
// D3-F 扩展问答对话框组件测试（UiDialog）：四方法渲染+答案构造（value∈options/confirmed/cancelled）、
// editor prefill、timeoutMs 提示、多提问堆叠、空列表不占位。仓惯例 .test.ts 无 JSX，用 React.createElement。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UiDialog } from "../../../apps/web/src/components/ui-dialog";
import type { UiAnswer, UiRequest } from "../../../apps/web/src/ws/subscribe-client";

afterEach(cleanup);

function mount(requests: readonly UiRequest[]) {
  const answers: Array<{ requestId: string; answer: UiAnswer }> = [];
  const view = render(
    React.createElement(UiDialog, {
      requests,
      onAnswer: (requestId, answer) => answers.push({ requestId, answer }),
    }),
  );
  return { answers, view };
}

describe("UiDialog 四方法渲染与答案构造", () => {
  it("空列表整体不渲染（不占位）", () => {
    const { view } = mount([]);
    expect(view.container.firstChild).toBeNull();
    expect(screen.queryByLabelText("扩展提问")).toBeNull();
  });

  it("select：选项逐个渲染为按钮，点击答案 value 必为 options 其一", () => {
    const { answers } = mount([
      { requestId: "ui-1", method: "select", title: "选哪个？", options: ["甲", "乙", "丙"] },
    ]);
    expect(screen.getByRole("dialog", { name: "选哪个？" })).toBeTruthy();
    for (const option of ["甲", "乙", "丙"]) expect(screen.getByRole("button", { name: option })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "乙" }));
    expect(answers).toEqual([{ requestId: "ui-1", answer: { value: "乙" } }]);
    expect(["甲", "乙", "丙"]).toContain((answers[0]!.answer as { value: string }).value);
  });

  it("confirm：题面 message 呈现；确认/否分别回 confirmed:true/false", () => {
    const { answers } = mount([{ requestId: "ui-1", method: "confirm", message: "允许删除文件吗？" }]);
    expect(screen.getByText("允许删除文件吗？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(answers[0]).toEqual({ requestId: "ui-1", answer: { confirmed: true } });

    cleanup();
    const second = mount([{ requestId: "ui-2", method: "confirm", message: "继续吗？" }]);
    fireEvent.click(screen.getByRole("button", { name: "否" }));
    expect(second.answers[0]).toEqual({ requestId: "ui-2", answer: { confirmed: false } });
  });

  it("input：placeholder 呈现；输入后提交回 value:string（未输入=空串）", () => {
    const { answers } = mount([{ requestId: "ui-1", method: "input", placeholder: "输入目标路径" }]);
    const input = screen.getByLabelText("回答输入");
    expect(input.getAttribute("placeholder")).toBe("输入目标路径");
    fireEvent.change(input, { target: { value: "/tmp/out" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(answers).toEqual([{ requestId: "ui-1", answer: { value: "/tmp/out" } }]);
  });

  it("editor：prefill 进多行初稿；修改后提交回修改后全文", () => {
    const { answers } = mount([{ requestId: "ui-1", method: "editor", prefill: "第一行\n第二行" }]);
    const area = screen.getByLabelText("回答编辑");
    expect((area as HTMLTextAreaElement).value).toBe("第一行\n第二行");
    fireEvent.change(area, { target: { value: "改过的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(answers).toEqual([{ requestId: "ui-1", answer: { value: "改过的内容" } }]);
  });

  it("取消按钮：任何方法都回 cancelled:true（恰其一字段）", () => {
    const { answers } = mount([
      { requestId: "ui-1", method: "select", options: ["甲"] },
      { requestId: "ui-2", method: "confirm" },
      { requestId: "ui-3", method: "input" },
      { requestId: "ui-4", method: "editor" },
    ]);
    const cancels = screen.getAllByRole("button", { name: "取消" });
    expect(cancels).toHaveLength(4);
    for (const btn of cancels) fireEvent.click(btn);
    expect(answers).toEqual([
      { requestId: "ui-1", answer: { cancelled: true } },
      { requestId: "ui-2", answer: { cancelled: true } },
      { requestId: "ui-3", answer: { cancelled: true } },
      { requestId: "ui-4", answer: { cancelled: true } },
    ]);
  });

  it("timeoutMs 仅展示提示文案（秒级取整），不自动作答/撤框", () => {
    mount([{ requestId: "ui-1", method: "confirm", timeoutMs: 30_000 }]);
    expect(screen.getByText("30 秒内未答将自动取消")).toBeTruthy();
    // 无 timeoutMs 则无提示
    cleanup();
    mount([{ requestId: "ui-2", method: "confirm" }]);
    expect(screen.queryByText(/秒内未答/)).toBeNull();
  });

  it("title 缺省回退方法默认题；多提问堆叠且作答互不影响", () => {
    const { answers } = mount([
      { requestId: "ui-1", method: "confirm", message: "第一题" },
      { requestId: "ui-2", method: "select", options: ["A", "B"] },
    ]);
    expect(screen.getByLabelText("扩展提问").querySelectorAll(".ui-dialog")).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "请确认" })).toBeTruthy(); // 默认题
    expect(screen.getByRole("dialog", { name: "请选择一项" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(answers).toEqual([
      { requestId: "ui-2", answer: { value: "A" } },
      { requestId: "ui-1", answer: { confirmed: true } },
    ]);
  });
});
