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

/**
 * 構造的な定番タグ（§C）。全話 union（§A）で混ざる「内容を特徴づけない episode-meta」を
 * UI の候補・チップから隠す（データ＝works.tags/tags.json は保持）。
 * 対象: 最終回系（最終回/いい最終回だった/N期最終回…）・神回系（神回/超神回/約束された神回…・
 * ただし「神回避」は否定先読みで除外しない）・記念回・総集編系・各話番号（第N話/N話/#N/N話目）。
 * 非対象（残す）: 水着回・お風呂/温泉・SF/ファンタジー等のジャンル＝「内容タグ」。
 * 注: DF/クール跨りでは構造タグとジャンルを分離できない（ジャンルが最も普遍）ため、
 * 統計閾値ではなく意味ベースの少数キュレーションで判定する。
 */
const STRUCTURAL_TAG = /最終回|神回(?!避)|記念回|総集編|^第?\d+話$|^#\d+$|^\d+話目$/u

export function isStructuralTag(name: string): boolean {
  return STRUCTURAL_TAG.test(name)
}

/** UI のタグ候補・チップから隠すタグ＝クール由来（§68）＋構造的定番（§C）。データは消さない。 */
export function isHiddenTag(name: string): boolean {
  return isCoursTag(name) || isStructuralTag(name)
}

/** クール由来タグを除いたタグ名配列を返す。 */
export function withoutCoursTagNames(names: string[]): string[] {
  return names.filter((n) => !isCoursTag(n))
}

/** UI 非表示タグ（クール由来＋構造的定番）を除いたタグ名配列を返す（§C）。 */
export function withoutHiddenTagNames(names: string[]): string[] {
  return names.filter((n) => !isHiddenTag(n))
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
