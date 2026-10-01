// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingPicker } from "../../../apps/web/src/components/thinking-picker";
import type { ModelSource } from "../../../apps/web/src/components/model-picker";
import type { ModelInfoDTO } from "@pi-agent-ui/protocol/src/contracts";
import { MODEL_DEFAULT } from "../../../apps/web/src/ws/draft-model";

afterEach(cleanup);
function source(items: readonly ModelInfoDTO[]): ModelSource {
  const snapshot = { state: "ready", models: { status: "ok" as const, items, cause: null } };
  return { requestModels: vi.fn(), requestRoots: vi.fn(), subscribe: () => () => {}, getSnapshot: () => snapshot };
}
const model: ModelInfoDTO = { provider: "controlled", id: "reasoner", thinking: "yes", thinkingLevels: ["off", "low", "high"] };
const option = (select: HTMLSelectElement, value: string) => Array.from(select.options).find((o) => o.value === value)!;
function props(items: readonly ModelInfoDTO[] = [model]) { return { source: source(items), choice: "controlled/reasoner", freeText: "", level: null, onChange: vi.fn() }; }

describe("next-prompt thinking menu", () => {
  it("uses exact supported levels, disables and explains other levels, default remains enabled", () => {
    const p = props(); const page = render(React.createElement(ThinkingPicker, p));
    const select = page.getByRole("combobox") as HTMLSelectElement;
    expect(option(select, "").disabled).toBe(false); expect(option(select, "low").disabled).toBe(false);
    expect(option(select, "high").disabled).toBe(false); expect(option(select, "max").disabled).toBe(true);
    expect(option(select, "max").textContent).toContain("此模型不支持");
    fireEvent.change(select, { target: { value: "max" } }); expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "low" } }); expect(p.onChange).toHaveBeenCalledWith("low");
  });
  it("legacy yes/no is not a capability list; unknown stays default-only with explanation", () => {
    const p = props([{ provider: "controlled", id: "reasoner", thinking: "yes" }]);
    const page = render(React.createElement(ThinkingPicker, p)); const select = page.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(select.options).filter((o) => !o.disabled).map((o) => o.value)).toEqual([""]);
    expect(option(select, "high").textContent).toContain("能力未确认");
    fireEvent.change(select, { target: { value: "high" } }); expect(p.onChange).not.toHaveBeenCalled();
  });
  it("model changes preserve an existing unsupported choice, never silently clamp or configure", () => {
    const p = { ...props(), level: "high" as const };
    const page = render(React.createElement(ThinkingPicker, p));
    page.rerender(React.createElement(ThinkingPicker, { ...p, source: source([{ ...model, thinkingLevels: ["off"] }]) }));
    const select = page.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("high"); expect(option(select, "high").disabled).toBe(true);
    expect(p.onChange).not.toHaveBeenCalled(); expect(page.container.textContent).toContain("选择已保留");
    fireEvent.change(select, { target: { value: "" } }); expect(p.onChange).toHaveBeenCalledWith(null);
  });
  it("only a unique short alias may inherit metadata; ambiguity stays unknown", () => {
    const p = { ...props(), choice: MODEL_DEFAULT, freeText: "reasoner" };
    const page = render(React.createElement(ThinkingPicker, p)); const select = page.getByRole("combobox") as HTMLSelectElement;
    expect(option(select, "high").disabled).toBe(false);
    page.rerender(React.createElement(ThinkingPicker, { ...p, source: source([model, { ...model, provider: "other" }]) }));
    expect(option(select, "high").disabled).toBe(true); expect(p.onChange).not.toHaveBeenCalled();
  });
  it("default pi model has no guessed identity/capabilities even when the catalog is known", () => {
    const page = render(React.createElement(ThinkingPicker, { ...props(), choice: MODEL_DEFAULT }));
    const select = page.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(select.options).filter((o) => !o.disabled).map((o) => o.value)).toEqual([""]);
  });
});
