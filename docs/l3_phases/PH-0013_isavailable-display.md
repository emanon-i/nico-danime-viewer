# PH-0013: isAvailable 表示（バックエンド + フロント）

## 概要

PH-0012 で `isAvailable` フィールドが Store に入った後、それをフロントエンドに公開し、
「取得不可」作品の表示トグルを実装する。

依存: **PH-0012 完了後**に実装する（`isAvailable` フィールドが works.json に入っている必要がある）。

---

## スコープ

### バックエンド変更

| ファイル                    | 変更内容                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/store/project.mjs` | `exportWorks()`: `isAvailable=false` のシリーズも出力対象に含める。`thumbnailUrl` フィールドも含める。`isAvailable` を works.json の各エントリに追加。 |
| `scripts/store/project.mjs` | `exportKana()`: `isAvailable` 条件を外す。`colKey` が null でないシリーズのみ出力（isAvailable 問わず）。                                              |

### フロント変更

| ファイル / 対象                                       | 変更内容                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `web/src/types.ts`（または型定義ファイル）            | `Work` 型に `isAvailable: boolean` フィールド追加                                                        |
| `web/src/lib/filter.ts`（またはフィルタ関連ファイル） | `filterWorks(works, options)` に `showUnavailable: boolean` オプション追加。デフォルト `false`（非表示） |
| `web/src/lib/settings.ts`（または localStorage 管理） | `show-unavailable` キーで localStorage 読み書き                                                          |
| 設定 UI コンポーネント                                | 「配信終了作品を表示」トグルを設定パネルに追加（localStorage 連動）                                      |
| 作品カードコンポーネント                              | `isAvailable=false` のカードに半透明グレーオーバーレイ + 「取得不可」ラベルを追加                        |

---

## works.json 出力仕様

`exportWorks()` の変更点:

```javascript
// 変更前: isAvailable=true のみ出力
works.filter(s => s.isAvailable)

// 変更後: isAvailable=false も含める（フロントがフィルタ）
// isAvailable フィールドを各エントリに追加
{
  seriesId: s.seriesId,
  title: s.title,
  isAvailable: s.isAvailable ?? true,  // 後方互換: undefined → true
  thumbnailUrl: s.thumbnailUrl ?? null, // isAvailable=false でも出力
  // ... 既存フィールド ...
}
```

---

## カード表示仕様

dataflow.md §11 の契約：

| 状態                | サムネあり                                              | サムネなし                      |
| ------------------- | ------------------------------------------------------- | ------------------------------- |
| `isAvailable=false` | サムネ ＋ 半透明グレーオーバーレイ ＋「取得不可」ラベル | グレー背景 ＋「取得不可」ラベル |
| `isAvailable=true`  | 通常表示                                                | グレー背景（ラベルなし）        |

**実装**:

- オーバーレイ: CSS で `position: absolute; inset: 0; background: rgba(0,0,0,0.45)` 相当
- ラベル: `"取得不可"` 1 種類のみ（「配信終了」は使わない）
- サムネなし: 既存の「グレー背景」コンポーネントをそのまま使用

---

## filterWorks の変更

```typescript
export function filterWorks(works: Work[], options: FilterOptions): Work[] {
  return works.filter((w) => {
    if (!options.showUnavailable && !w.isAvailable) return false
    // ... 既存フィルタ条件 ...
    return true
  })
}
```

デフォルト: `showUnavailable = false`（localStorage 未設定時）

---

## 設定トグル UI

- localStorage キー: `nico-danime-show-unavailable` (文字列 `"true"` / `"false"`)
- 設定パネル（既存の localStorage 設定 UI があればそこに追加）
- ラベル: 「配信終了/取得不可の作品を表示」または「取得不可の作品を表示」
- トグル変更時にリアクティブに作品一覧を再フィルタ

---

## kana.json の変更

```javascript
// 変更前
works.filter((w) => w.isAvailable && w.colKey)

// 変更後
works.filter((w) => w.colKey) // isAvailable 問わず colKey があれば五十音に含める
```

---

## 受け入れ条件

1. **works.json 包含**: `isAvailable=false` のシリーズが `works.json` に含まれていること（`jq '[.works[] | select(.isAvailable == false)] | length'` で 0 超）。
2. **thumbnailUrl 出力**: `isAvailable=false` のシリーズの `thumbnailUrl` が works.json で `null` 以外であれば出力されていること。
3. **デフォルト非表示**: `showUnavailable=false` の状態で `isAvailable=false` の作品が一覧に表示されないこと。
4. **トグルで表示**: 「取得不可の作品を表示」トグルを ON にすると `isAvailable=false` の作品がカード一覧に出ること。
5. **カード描画（サムネあり）**: `isAvailable=false` かつ `thumbnailUrl` ありのカードに半透明グレーオーバーレイと「取得不可」ラベルが表示されること。
6. **カード描画（サムネなし）**: `isAvailable=false` かつ `thumbnailUrl=null` のカードにグレー背景と「取得不可」ラベルが表示されること。
7. **kana.json**: `isAvailable=false` のシリーズでも `colKey` があれば五十音一覧に含まれること。
8. **localStorage 永続**: ページリロード後もトグル状態が維持されること。

---

## 検証方法

```bash
# works.json に isAvailable=false が含まれるか確認
node -e "
  const w = require('./data/works.json')
  const unavail = w.works.filter(x => x.isAvailable === false)
  console.log('unavailable in works.json:', unavail.length)
"

# フロント確認（pnpm dev 起動後）
# 1. 設定パネルを開く → 「取得不可の作品を表示」トグルがあること
# 2. トグル OFF → isAvailable=false の作品が非表示
# 3. トグル ON  → 取得不可カード（グレーオーバーレイ+ラベル）が表示
# 4. リロード後も状態維持
pnpm dev
```
