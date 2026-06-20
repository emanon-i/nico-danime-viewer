# PH-0010: watch.mjs + Store 型整備（seriesId 解決基盤）

## 概要

`scripts/nico/watch.mjs` を新規作成し、watch ページ HTML から seriesId を取得する。
あわせて Store 型に `Series.lastSeenAt` / `meta.snapshotFetchedAt` を追加する。
このフェーズは PH-0011（毎時）・PH-0012（日次）が共通で使う基盤。

---

## スコープ

### 新規作成

| ファイル                 | 内容                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `scripts/nico/watch.mjs` | `fetchWatchSeriesInfo(id)` — watch ページ HTML から seriesId / contentId / channelId / seriesTitle を返す |

### 変更

| ファイル                    | 変更                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/store/store.mjs`   | `Series` 型に `lastSeenAt: string \| null` フィールド追加。`Meta` 型に `snapshotFetchedAt: string \| null` フィールド追加。`loadStore` / `createStore` で初期値 null を設定。 |
| `scripts/store/project.mjs` | `Series.lastSeenAt` が追加されても既存 projection に影響しないこと（works.json への出力は不要）を確認のみ。変更不要なら無変更。                                               |

### 廃止（このフェーズで除去）

- `scripts/nico/rss.mjs` の `resolveRssItemsFromStore` 関数（PH-0011 で fetch.mjs から使われなくなる前提。この関数自体を削除する）
- `scripts/fetch.mjs` の `matchRssOnlyFromTitles` / `matchRssOnlyToSeries` / `matchOrphanEpsToSeries` 関数（PH-0011/0012 で不要になる。このフェーズで削除しても良いが PH-0011 の PR に含めても OK）

> **Note**: rss.mjs の `resolveRssItems`（SQLite 版）は `--mode=full-db`（旧後方互換）でのみ使用されるため残す。

---

## `scripts/nico/watch.mjs` の実装仕様

dataflow.md §6 の仕様に従う。

```javascript
export async function fetchWatchSeriesInfo(watchIdOrContentId) { ... }
```

- `fetchWithToS` を使用（識別 UA 付与・ToS 待機）
- ヘッダ: `Accept: text/html,application/xhtml+xml,*/*;q=0.9`
- HTML から `<meta name="server-response" content="...">` を正規表現で抽出
- HTML エンティティデコード（`&quot;` `&amp;` `&#39;` `&lt;` `&gt;`）後に JSON.parse
- パス: `data.response.series.id`（Number）/ `data.response.video.id`（contentId）/ `data.response.channel.id`（文字列 "ch2632720"）/ `data.response.series.title`
- `seriesId == null || contentId == null` → `return null`
- 全エラーケースで `return null`（warn ログのみ）

---

## Store 型変更詳細

`scripts/store/store.mjs` の `createStore()` で生成する Series オブジェクトと Meta オブジェクトの初期値：

```javascript
// Series
lastSeenAt: null,  // string | null: snapshot に最後に登場した ISO 8601

// Meta
snapshotFetchedAt: null,  // string | null: Phase A 完全実行完了日時
```

`loadStore()` で既存 JSON を読む際、`lastSeenAt` / `snapshotFetchedAt` フィールドが無い場合は `null` にフォールバック（後方互換）。

---

## 受け入れ条件

1. `fetchWatchSeriesInfo('sm12345')` を呼び出して、実際の watch ページ HTML を使ったユニットテスト（fixture HTML を使い `fetchWithToS` をモック）で `{ seriesId, contentId, channelId, seriesTitle }` を正しく返すこと。
2. meta タグが無い場合・JSON parse 失敗時・seriesId が null の場合はそれぞれ `return null` し、warn/info ログが出ること。
3. `loadStore()` 後、`store.meta.snapshotFetchedAt` が `null`（初期値）であること。
4. `loadStore()` 後、各 Series の `lastSeenAt` が `null`（初期値）であること。
5. `resolveRssItemsFromStore` が `scripts/nico/rss.mjs` から削除されていること（削除後に grep でヒットしないこと）。

---

## 検証方法

```bash
# unit test（fixture HTML で watchページパース確認）
pnpm test -- --grep watch

# store 型フィールド存在確認
node -e "import('./scripts/store/store.mjs').then(m => m.loadStore('./data')).then(s => console.log({snapshotFetchedAt: s.meta.snapshotFetchedAt, sample: [...s.series.values()][0]?.lastSeenAt}))"
```
