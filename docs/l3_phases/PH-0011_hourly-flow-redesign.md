# PH-0011: 毎時フロー刷新（hourly-js）

## 概要

`runHourlyJS()` を dataflow.md §5 の新設計で全面刷新する。

**旧設計の問題点**:

- Phase D2 がタイトル前方一致（series-titles.json）で seriesId を解決 → タイトル変化・新シリーズで失敗
- Phase D3 が「マッチしたシリーズのみ nvapi seed」→ 再生数更新漏れ
- RSS 新着ゼロでも state 書き出し・new.json 更新が走る（無駄）
- rss.json の件数上限がない

**新設計の要点**:

- Phase D2: resolved → series-index で解決 / rss_only → `fetchWatchSeriesInfo(watchId)` で解決
- Phase D3: 解決済み seriesId **全件** nvapi v2/series → 全話 count/登録日時/尺/サムネ 更新
- RSS 新着ゼロ → 即終了（watch/nvapi/deploy 一切なし）
- rss.json 200件 trim（oldest/resolved 優先削除・rss_only 最後）

依存: **PH-0010 完了後**に実装する（`fetchWatchSeriesInfo` が必要）。

---

## スコープ

### 変更ファイル

| ファイル                  | 変更内容                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/fetch.mjs`       | `runHourlyJS()` を全面書き換え（後述）                                                                                              |
| `scripts/nico/rss.mjs`    | `fetchRssMultiPage` の `maxPages` デフォルト値を 3→5 に変更（または呼び出し側で指定）                                               |
| `scripts/store/store.mjs` | `upsertRssItems`（= `storeUpsertRss`）が `description` フィールドを保存できるよう拡張（RssItem.description = RSS HTML CDATA as-is） |

### 廃止（fetch.mjs から削除）

| 関数                     | 理由                                  |
| ------------------------ | ------------------------------------- |
| `matchRssOnlyFromTitles` | watch.mjs 経由に置換                  |
| `matchRssOnlyToSeries`   | 同上                                  |
| `matchOrphanEpsToSeries` | 日次 A2 で対応（hourly では使わない） |

---

## `runHourlyJS()` 新実装フロー

```
Phase D: RSS fetch
  ・fetchRssMultiPage(lastGuid, { maxPages: 5 })
      → guid HWM でページ単位早期終了（filterNewRssItems）
      → watchId Map で item 単位 dedup（fetchRssMultiPage 内）
  ・新 item ゼロ:
      → new.json 更新 + state（meta/rss）書き戻し → 即終了
  ・新 item あり:
      → storeUpsertRss（description = RSS <description> HTML CDATA as-is）
      → rss.json 200件 trim（trimRss で oldest→resolved 優先削除・rss_only 最後）
      → meta.rssLastGuid 更新

Phase D2: seriesId 解決
  ・resolved items:
      → resolvedContentId → series-index[resolvedContentId] → seriesId（watch 不要）
  ・rss_only items:
      → fetchWatchSeriesInfo(watchId) per item（≈700ms、ToS 待機込み）
          OK: resolvedContentId + seriesId 記録・resolutionStatus → 'resolved'
          NG (null / channelId != 'ch2632720'): warn ログ・rss_only 据え置き

  ・解決済み seriesId が 0 件:
      → new.json 更新 + state 書き戻し → 終了

Phase D3: nvapi 更新
  ・解決済み seriesId 全件 × nvapi v2/series
      → 全話 viewCounter / commentCounter / likeCounter / mylistCounter
             / registeredAt / duration / thumbnailUrl を取得
  ・storeUpsertEps（実変化チェック → _dirtySeries 更新）
      → 新規 ep の description = 対応 RssItem の description
         （contentId で照合、なければ null のまま）

書き出し:
  ・_dirtySeries 非空 → writeSeriesFiles + series-index 更新
  ・new.json 更新（常時）
  ・state（meta/rss）書き戻し（常時）

deploy:
  ・insertedEpisodes > 0 → .deploy-needed ファイル生成
  ・count 変化のみ → ファイル更新のみ（deploy なし）
```

---

## rss.json trim ルール

```javascript
function trimRss(items, cap = 200) {
  // oldest → resolved を優先削除（rss_only は最後まで保持）
  // 優先削除順: resolutionStatus === 'resolved' → その中で pubDate が古い順
  // rss_only は削除しない（次の毎時でリトライが必要なため）
  if (items.length <= cap) return items
  const [rssOnly, resolved] = partition(items, (i) => i.resolutionStatus === 'rss_only')
  // resolved を oldest first でソートして上限に収まる分だけ保持
  resolved.sort((a, b) => (a.pubDate ?? '').localeCompare(b.pubDate ?? ''))
  const keep = resolved.slice(resolved.length - (cap - rssOnly.length))
  return [...keep, ...rssOnly]
}
```

---

## series-index との整合

- `series-index.json` の構造: `{ [contentId: string]: seriesId: number }` ← 既存の形式を維持
- Phase D2 resolved 解決: `contentToSeries.get(resolvedContentId) → seriesId`
- Phase D2 watch 解決成功後: `series-index[contentId] = seriesId` でエントリを追加
- series-index の書き戻し: `writeSeriesIndex(stateDir, contentToSeries)` で atomic rename

---

## 受け入れ条件

1. **RSS 新着ゼロ → 即終了**: nvapi/watch 呼び出しゼロ・.deploy-needed 生成なし。new.json / state は更新される。
2. **Phase D2 resolved 解決**: `resolutionStatus === 'resolved'` の item に対して watch ページ取得が行われないこと（ログ確認）。
3. **Phase D2 rss_only 解決**: `fetchWatchSeriesInfo(watchId)` が呼ばれ、成功時に `resolutionStatus → 'resolved'`、失敗時は rss_only 据え置き。
4. **Phase D3 nvapi 全件**: 解決済み seriesId の数だけ nvapi が呼ばれること（ログ `nvapi v2/series count: N`）。
5. **deploy=insertedEpisodes>0のみ**: count のみ変化した場合は `.deploy-needed` が生成されないこと。
6. **rss.json 200件 cap**: 200件超の状態で hourly を走らせると trim されること。
7. **`matchRssOnlyFromTitles` / `matchRssOnlyToSeries`** が fetch.mjs から削除されていること。
8. **series-titles.json 読み込みコード** が hourly から消えていること。

---

## 検証方法

```bash
# dry run（実際の RSS fetch だけして nvapi は呼ばない確認）
# → RSS 新着ゼロのケースを再現するには lastGuid を現在の最新に合わせる
node scripts/fetch.mjs --mode=hourly-js

# ログで確認:
# [info] phase D: RSS (hourly) → new items count
# [info] D2: resolved N items (no watch needed)
# [info] D2: rss_only N items → fetchWatchSeriesInfo x N
# [info] D3: nvapi v2/series x N
# [info] hourly done { insertedEpisodes: N }
```
