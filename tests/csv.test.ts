import { describe, expect, it } from "vitest";
import { parseCardsCsv } from "../src/csv";

describe("parseCardsCsv", () => {
  it("ヘッダ付き CSV を解析する（tags は ; 区切り）", () => {
    const result = parseCardsCsv("front,back,note,tags\n問1,答1,メモ1,タグA;タグB\n問2,答2,,\n");
    expect(result.rows).toEqual([
      { front: "問1", back: "答1", note: "メモ1", tags: ["タグA", "タグB"] },
      { front: "問2", back: "答2" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("note / tags 列がなくても取り込める", () => {
    const result = parseCardsCsv("front,back\n問1,答1\n");
    expect(result.rows).toEqual([{ front: "問1", back: "答1" }]);
  });

  it("引用符・カンマ・改行入りセルを扱える", () => {
    const result = parseCardsCsv('front,back\n"問, カンマ入り","答\n改行入り"\n"引用""符""",答2\n');
    expect(result.rows).toEqual([
      { front: "問, カンマ入り", back: "答\n改行入り" },
      { front: '引用"符"', back: "答2" },
    ]);
  });

  it("BOM 付き・空行入りの CSV を扱える", () => {
    const result = parseCardsCsv("﻿front,back\n問1,答1\n\n\n問2,答2\n");
    expect(result.rows).toHaveLength(2);
  });

  it("front / back の欠けた行は警告してスキップする", () => {
    const result = parseCardsCsv("front,back\n問1,答1\n問だけ,\n,答だけ\n");
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("3行目");
  });

  it("ヘッダに front / back がなければ拒否する", () => {
    expect(() => parseCardsCsv("表面,裏面\n問1,答1\n")).toThrow("front");
    expect(() => parseCardsCsv("front,answer\n問1,答1\n")).toThrow("back");
  });

  it("取り込める行が1件もなければ拒否する", () => {
    expect(() => parseCardsCsv("front,back\n")).toThrow("1件も");
  });

  it("大文字ヘッダ・前後空白を許容する", () => {
    const result = parseCardsCsv(" Front , BACK \n問1,答1\n");
    expect(result.rows).toEqual([{ front: "問1", back: "答1" }]);
  });
});
