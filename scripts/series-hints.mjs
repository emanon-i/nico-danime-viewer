// GitHub shared runner ではニコニコの有料各話・series関連情報が空で返る。
// list.json 掲載前にローカル公開ページで確認できた series ID の最小補助表。
// list.json に同じタイトルが載った後も同一IDであることを検証してから併合する。

export const SERIES_TITLE_HINTS = [
  { seriesId: 572284, title: '魔法少女猫たると' },
  { seriesId: 572266, title: '渡くんの××が崩壊寸前' },
]

export function mergeSeriesTitleHints(byTitle, bySeriesId = null) {
  for (const hint of SERIES_TITLE_HINTS) {
    const existingId = byTitle.get(hint.title)
    if (existingId != null && existingId !== hint.seriesId) {
      throw new Error(
        `series title hint conflict: ${hint.title} (${existingId} != ${hint.seriesId})`
      )
    }
    if (bySeriesId) {
      const existingTitle = bySeriesId.get(hint.seriesId)
      if (existingTitle != null && existingTitle !== hint.title) {
        throw new Error(
          `series ID hint conflict: ${hint.seriesId} (${existingTitle} != ${hint.title})`
        )
      }
      bySeriesId.set(hint.seriesId, hint.title)
    }
    byTitle.set(hint.title, hint.seriesId)
  }
  return byTitle
}
