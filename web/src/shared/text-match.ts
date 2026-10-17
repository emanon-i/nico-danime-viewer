/**
 * 作品名検索の照合用正規化。題名と検索語の**両方**に同じ規則をかけてから部分一致させ、
 * 見た目が同じ（または読みが同じ）文字の表記ゆれで取りこぼさないようにする。表示値は変えない。
 *
 * - NFKC: 全角英数・記号・全角スペース・半角カナを互換正規化（Ｒｅ：ゼロ → Re:ゼロ）
 * - 小文字化（英字の大小を無視）
 * - ひらがな → カタカナ（はいきゅー → ハイキュー）
 * - 波ダッシュの統一（〜 U+301C と ~。全角チルダ ～ は NFKC で ~ になる）
 * - 空白をすべて除去（題名の全角スペース／半角スペースの打ち分けを無視）
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/〜/g, '~')
    .replace(/\s+/g, '')
}
