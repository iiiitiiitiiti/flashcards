import type { SearchBrowser } from "./storage";

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

/**
 * 答えを Google で調べる URL。改行や連続する空白は 1 つに畳む（複数行の答えが 1 つの検索語になる）。
 * 括弧の読みや別解は消さない。検索エンジン側で十分に扱えるし、何を検索したかが URL から読める。
 * `noiga=1` は iOS で Google アプリに横取りされず既定のブラウザで開くための印。
 * google.com の apple-app-site-association が、このクエリを Universal Links の除外条件として公開している
 */
export function googleSearchUrl(query: string): string {
  const compact = query.replace(/\s+/g, " ").trim();
  return `https://www.google.com/search?q=${encodeURIComponent(compact)}&noiga=1`;
}

/** iPhone のホーム画面から起動した PWA か（`navigator.standalone` は iOS Safari だけが持つ） */
export function isIosStandalone(): boolean {
  return (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * 指定したブラウザのアプリで開くための URL。ホーム画面から起動した PWA では外部リンクがアプリ内のブラウザで開くので、
 * 各ブラウザが受け付けるスキームに差し替えてそのアプリへ渡す。
 * - Safari: `x-safari-https://`（非公開だが iOS 15 以降で広く使われている）
 * - Vivaldi: `vivaldi://`（Telegram iOS が「Vivaldi で開く」に使っている形）
 * - Chrome: `googlechromes://`（Chrome の公開仕様。https 用）
 * `inapp` はそのまま返す
 */
export function browserUrl(httpsUrl: string, browser: SearchBrowser): string {
  switch (browser) {
    case "safari":
      return httpsUrl.replace(/^https:\/\//, "x-safari-https://");
    case "vivaldi":
      return httpsUrl.replace(/^https:\/\//, "vivaldi://");
    case "chrome":
      return httpsUrl.replace(/^https:\/\//, "googlechromes://");
    default:
      return httpsUrl;
  }
}
