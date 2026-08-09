import Papa from "papaparse";

export interface CsvRow {
  front: string;
  back: string;
  note?: string;
  tags?: string[];
}

export interface CsvParseResult {
  rows: CsvRow[];
  warnings: string[];
}

const REQUIRED_HEADERS = ["front", "back"] as const;

/**
 * カード CSV を解析する。ヘッダ行 `front,back,note,tags` が必須（note/tags は省略可）。
 * tags セルは `;` 区切り。front/back が欠けた行は警告してスキップする。
 */
export function parseCardsCsv(text: string): CsvParseResult {
  const result = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  const fatal = result.errors.find((error) => error.type === "Delimiter" || error.code === "MissingQuotes");
  if (fatal) {
    throw new Error(`CSV を解析できませんでした: ${fatal.message}`);
  }
  const fields = result.meta.fields ?? [];
  for (const required of REQUIRED_HEADERS) {
    if (!fields.includes(required)) {
      throw new Error(`ヘッダ行に「${required}」列がありません。1行目は front,back,note,tags にしてください。`);
    }
  }

  const rows: CsvRow[] = [];
  const warnings: string[] = [];
  result.data.forEach((record, index) => {
    const line = index + 2; // ヘッダの次の行が2行目
    const front = (record.front ?? "").trim();
    const back = (record.back ?? "").trim();
    if (front === "" && back === "") return;
    if (front === "" || back === "") {
      warnings.push(`${line}行目: front と back の両方が必要なためスキップしました`);
      return;
    }
    const note = (record.note ?? "").trim();
    const tags = (record.tags ?? "")
      .split(";")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    rows.push({
      front,
      back,
      ...(note !== "" ? { note } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
  });
  if (rows.length === 0) {
    throw new Error("取り込めるカードが1件もありません。");
  }
  return { rows, warnings };
}
