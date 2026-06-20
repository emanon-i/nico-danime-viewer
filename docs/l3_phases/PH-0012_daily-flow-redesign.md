# PH-0012: 日次フロー刷新（full-js）

## 概要

`runFullJS()` を dataflow.md §5 の新設計で全面刷新する。

**旧設計の問題点**:

- Phase B が `programlist.json` で isAvailable を管理 → snapshot 由来の論理と分離できていない
- Phase C（nvapi 週次全件 seed）が重く、dataflow.md では明示的に廃止
- Phase D（日次も RSS を処理）→ 毎時専用に変更、日次からは除去
- E3 クール が programlist + period HTML に依存 → タグ主源のみに整理
- 取得漏れ（seriesId=null の ep）の救出手段がタイトル照合のみで不確実
- isAvailable が list.json の有無で評価 → snapshot 由来 grace に変更

**新設計の要点**:

- version gate 変化なし → 即終了（A2/B/E/deploy 一切なし）
- Phase A: lastSeenAt 記録・snapshotFetchedAt 記録・取得漏れ特定
- Phase A2: 最小 watch 数ループで取得漏れ救出（series-index 直接 + watch + nvapi 交差）
- Phase B: col_key パッチのみ（isAvailable 不可侵）
- Phase E7: isAvailable grace（lastSeenAt + snapshotFetchedAt + 2日）
- Phase E8: prev-views.json 差分 → hot スコア delta
- 廃止: Phase C（nvapi 週次）/ Phase D（日次 RSS）/ programlist.json / period HTML / series-titles.json 生成

依存: **PH-0010 完了後**に実装する（`fetchWatchSeriesInfo` が必要）。

---

## スコープ

### 変更ファイル

| ファイル                  | 変更内容                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scripts/fetch.mjs`       | `runFullJS()` を全面書き換え（後述）                                                                     |
| `scripts/store/store.mjs` | `upsertEpisodes` で `series.lastSeenAt` を更新（contentId の channelId=2632720 ep が upsert されたとき） |
| `scripts/etl/cours.mjs`   | `runCoursPipelineFromStore` を「タグ主源のみ」に簡素化（programlist / period HTML 処理を削除）           |
| `scripts/etl/metrics.mjs` | `recalcSeriesMetrics` に prevViewCounter delta パラメータを追加（Phase E8 で渡す）                       |

### 廃止（削除または無効化）

| コード                         | 場所                                          | 理由                               |
| ------------------------------ | --------------------------------------------- | ---------------------------------- |
| Phase C（nvapi 週次 seed）     | `runFullJS()` 内                              | 廃止                               |
| Phase D（日次 RSS）            | `runFullJS()` 内                              | 毎時専用に移管                     |
| `programlist.json` 取得・利用  | `runFullJS()` + `runCoursPipelineFromStore()` | 廃止                               |
| `period HTML` クール補完       | `derivePastCoursFromStore()` + 呼び出し       | 廃止（タグ主源で十分）             |
| `series-titles.json` 生成      | `runFullJS()` 末尾                            | 廃止（hourly が watch.mjs に移行） |
| `mintFromProgramlist` ロジック | Phase B 内                                    | 廃止                               |
| `matchOrphanEpsToSeries`       | `runFullJS()` 内                              | Phase A2 に置換                    |

---

## `runFullJS()` 新実装フロー

```
version gate チェック:
  ・fetchSnapshotVersion() → newVersion
  ・store.meta.snapshotVersionLastModified === newVersion かつ !NICO_FORCE_SNAPSHOT
      → 即終了（何も書き出さない・deploy なし）
  ・変化あり / force → 以下を実行

前処理: prev-views.json 保存
  ・{contentId: viewCounter} を state/prev-views.json に atomic write
  ・（Phase E8 の hot スコア delta 計算に使う）

Phase A: snapshot 全件取得
  ・fetchAllBranchEpisodes(null)  ← version gate 通過後は全件取得
  ・storeUpsertEps:
      → viewCounter / tags / description / lengthSeconds 等の実変化チェック
      → channelId=2632720 ep の series.lastSeenAt = now
      → _dirtySeries 更新
  ・取得漏れ特定: channelId=2632720 かつ ep.seriesId=null の ep を収集 → missedContentIds
  ・meta.snapshotFetchedAt = now / meta.snapshotVersionLastModified = newVersion

Phase A2: 取得漏れ救出ループ
  ・① series-index にある contentId → 直接 seriesId 解決（watch 不要）
  ・② 残りの missedContentIds に対して最小 watch 数ループ:
      a. missedContentIds から 1件 pick → fetchWatchSeriesInfo(contentId) → seriesId
      b. seriesId → nvapi v2/series → 全話 contentId 一覧
      c. 一覧 ∩ missedContentIds → 同一シリーズを一括解決
      d. 救出済みを missedContentIds から除外
      e. 残りがあれば a に戻る
      f. watch 回数 = 発見した seriesId 数（最小化）
  ・storeUpsertEps（全話・話順）→ _dirtySeries 更新

Phase B: list.json → col_key パッチのみ
  ・fetchListJson() → {seriesId, colKey} のみ抽出
  ・colKey が null の Series に付与（upsertSeries は常に _dirtySeries に追加）
  ・isAvailable には一切触れない
  ・programlist.json は取得しない

Phase E: ETL 派生
  E1: descriptionFirst（最古話 description → series.descriptionFirst）
  E2: tags 正規化（deriveSeriesTagsFromStore）
  E3: cours（タグ主源のみ・deriveCoursFromTagsFromStore）
      ※ programlist / period HTML は廃止
  E4: franchiseKey（computeFranchiseKeys）
  E5: timestamps 同期（storeSyncTimestamps）
  E6: thumbnails 同期（storeSyncThumbs）
  E7: isAvailable grace
      snapshotFetchedAt が 3 日以上前 → 評価しない（版gate連続skip保護）
      各 Series の lastSeenAt を確認:
        lastSeenAt < (snapshotFetchedAt - 2日) → series.isAvailable = false, dirty
        lastSeenAt >= (snapshotFetchedAt - 2日) かつ !isAvailable → true に戻す, dirty
  E8: prevViewCounter delta（hot スコア）
      prev-views.json を読み、series ごとに viewCounter 差分を計算
      recalcSeriesMetrics(store, { prevViews }) に渡す

detectShrink:
  ・countSeriesWithEpisodes(store) < Math.floor(baseline * 0.9)
      → meta.json のみ atomic write → export/deploy スキップ → 終了

Phase F: writeBackStore（_dirtySeries の series/*.json + state/*.json 全量）
Phase G: projectAll（works / ranking / tags / kana / new 生成）→ Pages deploy
```

---

## isAvailable grace の実装詳細（Phase E7）

```javascript
function applyIsAvailableGrace(store) {
  const fetched = store.meta.snapshotFetchedAt
  if (!fetched) return // 一度も Phase A が走っていない → 評価しない
  const fetchedMs = new Date(fetched).getTime()
  const staleThresholdMs = 3 * 24 * 60 * 60 * 1000 // 3日
  const graceMs = 2 * 24 * 60 * 60 * 1000 // 2日
  const now = Date.now()

  if (now - fetchedMs > staleThresholdMs) return // 評価しない（連続skip保護）

  const cutoff = new Date(fetchedMs - graceMs).toISOString()
  for (const s of store.series.values()) {
    const seen = s.lastSeenAt
    const shouldBeAvailable = seen != null && seen >= cutoff
    if (!shouldBeAvailable && s.isAvailable) {
      s.isAvailable = false
      store._dirtySeries.add(s.seriesId)
    } else if (shouldBeAvailable && !s.isAvailable) {
      s.isAvailable = true
      store._dirtySeries.add(s.seriesId)
    }
  }
}
```

---

## Phase A2 取得漏れ救出ループの実装詳細

```javascript
async function rescueMissingEps(store, missedContentIds, contentToSeries) {
  // ① series-index から直接解決
  for (const cid of [...missedContentIds]) {
    const sid = contentToSeries.get(cid)
    if (sid != null) {
      const ep = store.episodes.get(cid)
      if (ep) {
        ep.seriesId = sid
        store._dirtySeries.add(sid)
      }
      missedContentIds.delete(cid)
    }
  }

  // ② 最小 watch 数ループ
  while (missedContentIds.size > 0) {
    const cid = [...missedContentIds][0]
    const info = await fetchWatchSeriesInfo(cid) // contentId で呼び出し
    if (!info || info.channelId !== 'ch2632720') {
      missedContentIds.delete(cid) // 支店外 or エラー → スキップ
      continue
    }
    const { seriesId } = info
    // nvapi v2/series → 全話 contentId 一覧
    const nvapiData = await fetchSeriesData(seriesId)
    const allContentIds = new Set((nvapiData?.items ?? []).map((i) => i.contentId))
    storeUpsertEps(store, mapNvapiEpisodes(seriesId, nvapiData?.items ?? []))
    contentToSeries.set(cid, seriesId)
    // 交差で同一シリーズの取得漏れを一括解決
    for (const missed of [...missedContentIds]) {
      if (allContentIds.has(missed)) {
        const ep = store.episodes.get(missed)
        if (ep) {
          ep.seriesId = seriesId
          store._dirtySeries.add(seriesId)
        }
        contentToSeries.set(missed, seriesId)
        missedContentIds.delete(missed)
      }
    }
  }
}
```

---

## `etl/cours.mjs` 変更

`runCoursPipelineFromStore()` から以下を**削除**:

- Phase 2: `fetchProgramlist()` 呼び出し・curMap 処理
- Phase 3: `derivePastCoursFromStore()` 呼び出し（period HTML）
- `period-cache.json` キャッシュ読み書き

残るのは:

- Phase 1（主源）: `deriveCoursFromTagsFromStore(store, chronoSort)` のみ

`derivePastCoursFromStore` / `runCoursPipelineFromStore` の programlist / period 関連コードは削除。
`mapCurrentCours` の呼び出しも削除。（`mapCurrentCours` 自体は cours.mjs に残してもよいが未使用になる）

---

## `etl/metrics.mjs` 変更

`recalcSeriesMetrics(store, options)` に `prevViews: Map<string, number>` オプション追加:

- `prevViews.get(contentId)` で前日の viewCounter を取得
- `delta = currentViewCounter - prevViewCounter` を hot スコアに組み込む
- prevViews が空 or undefined の場合は delta=0（互換性保持）

---

## 受け入れ条件

1. **version gate**: `NICO_FORCE_SNAPSHOT=1` なしで同一 version の場合、A2/B/E/deploy が一切走らないこと（ログに `version unchanged → exit` が出ること）。
2. **Phase A lastSeenAt**: snapshot 実行後、channelId=2632720 の ep を持つ Series の `lastSeenAt` が現在時刻に更新されていること（store dump で確認）。
3. **Phase A2 取得漏れ救出**: 手動で ep.seriesId=null の ep を作り、A2 実行後に seriesId が埋まること。watch 呼び出し回数が「発見した seriesId 数」に等しいこと（ログ確認）。
4. **Phase B col_key のみ**: list.json 取得後、`series.isAvailable` が Phase B の処理で変化しないこと（E7 が担当）。
5. **Phase E7 grace**: `snapshotFetchedAt=2日前・lastSeenAt=3日前` のシリーズが `isAvailable=false` になること。`snapshotFetchedAt=4日前` のとき評価されないこと。
6. **Phase C 廃止**: ログに `phase C: nvapi seed` が出ないこと。
7. **programlist / period 取得廃止**: ネットワークリクエストログに `programlist.json` / `period` URL が出ないこと。
8. **series-titles.json 生成廃止**: `runFullJS()` 完了後、`data/state/series-titles.json` が新規作成されないこと。
9. **detectShrink 保持**: ep>0件数が baseline×90% を割ったときに export がスキップされること（既存動作の維持）。

---

## 検証方法

```bash
# version gate テスト（NICO_FORCE_SNAPSHOT=1 なしで実行 → スキップ確認）
node scripts/fetch.mjs --mode=full-js
# ログで "version unchanged" を確認

# 強制実行（全 Phase を通す）
NICO_FORCE_SNAPSHOT=1 node scripts/fetch.mjs --mode=full-js

# isAvailable grace の確認
node -e "
  import('./scripts/store/store.mjs').then(m => m.loadStore('./data')).then(s => {
    const unavail = [...s.series.values()].filter(x => !x.isAvailable)
    console.log('unavailable:', unavail.length, unavail.slice(0,3).map(x => ({id: x.seriesId, lastSeenAt: x.lastSeenAt})))
  })
"
```
