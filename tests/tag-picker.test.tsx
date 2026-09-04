// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagPicker } from "../src/TagPicker";

const OPTIONS = [
  { tag: "★★☆", count: 20 },
  { tag: "哺乳類", count: 12 },
  { tag: "植物･果物", count: 9 },
];

afterEach(cleanup);

describe("TagPicker", () => {
  it("候補をタップすると付き、選択中のチップをタップすると外れる", () => {
    const onChange = vi.fn();
    render(<TagPicker value={["★★☆"]} options={OPTIONS} onChange={onChange} allowNew={false} />);
    fireEvent.click(screen.getByRole("button", { name: "タグ「哺乳類」を付ける（12枚）" }));
    expect(onChange).toHaveBeenLastCalledWith(["★★☆", "哺乳類"]);
    fireEvent.click(screen.getByRole("button", { name: "タグ「★★☆」を外す" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("選択中のタグは候補から消える", () => {
    render(<TagPicker value={["哺乳類"]} options={OPTIONS} onChange={() => undefined} allowNew={false} />);
    const options = screen.getByRole("group", { name: "タグの候補" });
    expect(options.textContent).not.toContain("哺乳類");
    expect(options.textContent).toContain("植物･果物");
  });

  it("検索で候補を絞り込む", () => {
    render(<TagPicker value={[]} options={OPTIONS} onChange={() => undefined} allowNew={false} />);
    fireEvent.change(screen.getByLabelText("タグを検索"), { target: { value: "植物" } });
    const options = screen.getByRole("group", { name: "タグの候補" });
    expect(options.textContent).toContain("植物･果物");
    expect(options.textContent).not.toContain("哺乳類");
  });

  it("allowNew のときだけ、明示のボタンで新しいタグを作れる", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TagPicker value={[]} options={OPTIONS} onChange={onChange} allowNew={false} />);
    fireEvent.change(screen.getByLabelText("タグを検索"), { target: { value: "爬虫類" } });
    expect(screen.queryByText(/新しいタグとして追加/)).toBeNull();
    expect(screen.getByText("このデッキでは既存のタグからだけ選べます")).toBeTruthy();

    rerender(<TagPicker value={[]} options={OPTIONS} onChange={onChange} allowNew={true} />);
    fireEvent.click(screen.getByText(/“爬虫類” を新しいタグとして追加/));
    expect(onChange).toHaveBeenLastCalledWith(["爬虫類"]);
  });

  it("既存タグと同じ綴りは新規追加ボタンを出さない（重複を作らない）", () => {
    render(<TagPicker value={[]} options={OPTIONS} onChange={() => undefined} allowNew={true} />);
    fireEvent.change(screen.getByLabelText("タグを検索"), { target: { value: "哺乳類" } });
    expect(screen.queryByText(/新しいタグとして追加/)).toBeNull();
  });
});
