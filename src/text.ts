/** 問題文を1文字ずつ送るための分割。絵文字や結合文字を割らないよう書記素単位で切る */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

export function splitGraphemes(text: string): string[] {
  // Intl.Segmenter が無い環境ではコードポイント単位にする（サロゲートペアは割れない）
  if (!segmenter) return Array.from(text);
  return [...segmenter.segment(text)].map((part) => part.segment);
}
