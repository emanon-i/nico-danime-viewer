/**
 * タグ UI 表示フィルタ（§68）。クール由来タグ（「2026年春アニメ」等）はクール絞り込みで
 * 扱うため、タグの表示・サイドバー候補・検索オートコンプリート・詳細のタグチップから除外する。
 * ※クール導出（cours-from-tags / ETL 側）はこれらタグをそのまま使うので、ここは「UI に出さない」だけ。
 *
 * パターンは ETL の導出形（`YYYY年<季>アニメ`）に対応。アンカーで完全一致のみ除外し、
 * 「2022年春アニメワースト枠」のような実タグ（接尾付き）は残す。
 */
const COURS_TAG = /^\d{4}年(春|夏|秋|冬)アニメ$/

export function isCoursTag(name: string): boolean {
  return COURS_TAG.test(name)
}

/** クール由来タグを除いたタグ名配列を返す。 */
export function withoutCoursTagNames(names: string[]): string[] {
  return names.filter((n) => !isCoursTag(n))
}

/**
 * タグ照合用の正規化（§82）。`?tag=` のデコード値と格納タグ（works.tags）を**同じ規則**で
 * 突き合わせるための鍵。NFKC でトリム＋互換正規化（半角カナ ﾘｽﾞ↔リズ・全角括弧（）↔()・
 * 互換記号）を吸収し、リンク生成（encodeURIComponent）／URL parse／格納形のどこかで
 * 全半角・互換文字のズレがあっても確実に一致させる。表示やURL値そのものは変えない（照合専用）。
 *
 * 注: → (U+2192) や ≒ (U+2252) は NFKC でも不変＝そのまま比較される（元から一致する）。
 */
export function normalizeTagForMatch(name: string): string {
  return name.normalize('NFKC').trim()
}
