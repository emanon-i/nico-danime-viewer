# DB 設計＆更新パイプライン（SQLite・L2）

> `dataflow.md` の詳細。**ビルド/CI 時の加工用 SQLite（ファイル DB・サーバ無し）**のスキーマ・インデックス・UPSERT/delta・PRAGMA・2 ジョブ更新フローを定める。
> 配信物は静的 JSON のみ（DB は配信に出さない）。コードは書かない（L3 / gen-code）。出典は本書末尾。

## 0. 方針（調査の結論）

- **一括ロードはトランザクションで一括**（公式 FAQ Q19: 個別 INSERT は数十 tx/s だが `BEGIN…COMMIT` でまとめると **50,000+ inserts/s**、commit コストを全 INSERT で償却）・**prepared statement＋バッチ（executemany 相当）**・**インデックスは一括 INSERT 後に作成**・**集計は set-based**（行ごとループを避ける）。
- ビルド時 DB は**再生成可能な中間生成物**なので**耐久性 PRAGMA は緩めてよい**（速度優先）。
- delta（前日比）は **prev 値を 1 スロット退避**して `今回 − 前回` で得る（**無制限履歴にしない**）。**7 スロット ring は v1 非対象・将来用**（UI ランキングに使わない）。

## 1. スキーマ（SQLite）

```sql
-- シリーズ（作品単位）
CREATE TABLE series (
  series_id        INTEGER PRIMARY KEY,   -- nicovideo series id（数値）
  title            TEXT NOT NULL,
  col_key          TEXT,                  -- 五十音の行（あ〜わ。list.json 由来）
  thumbnail_url    TEXT,
  description_first TEXT,                 -- 第1話 description（HTML 除去）
  first_seen       TEXT,                  -- シリーズ初出 = MIN(episodes.start_time)
  last_seen        TEXT,                  -- 直近の話の start_time
  cours            TEXT,                  -- 年-季（period 由来。NULL=不明）
  franchise_key    TEXT,                  -- 正規化フランチャイズタグ（NULL 可）
  is_available     INTEGER DEFAULT 1,     -- 0=配信情報欠損（empty 表示）
  updated_at       TEXT
);

-- 各話（動画単位）
CREATE TABLE episodes (
  content_id        TEXT PRIMARY KEY,     -- 'so…'
  series_id         INTEGER REFERENCES series(series_id),
  episode_no        INTEGER,              -- 話順（nvapi series の並び）
  title             TEXT,
  view_counter      INTEGER,              -- 累計再生数（最新）
  prev_view_counter INTEGER,              -- 前回フル時の値（delta 用・1スロット）
  comment_counter   INTEGER,
  like_counter      INTEGER,
  mylist_counter    INTEGER,
  length_seconds    INTEGER,
  start_time        TEXT,                 -- ISO8601（投稿時間）
  thumbnail_url     TEXT,
  last_updated      TEXT
);

-- RSS 新着のステージング（watch id を contentId に解決してから episodes へ統合）
CREATE TABLE rss_items (
  watch_id           TEXT PRIMARY KEY,    -- RSS の数値 watch id（snapshot の contentId 'so…' とは形式が違う）
  guid               TEXT,                -- HWM cursor
  pub_date           TEXT,
  title              TEXT,
  title_norm         TEXT,                -- 正規化タイトル（突合用）
  link               TEXT,                -- nicovideo.jp/watch/<watch_id>
  resolved_content_id TEXT,              -- 解決済み 'so…'（未解決は NULL）
  resolution_status  TEXT DEFAULT 'unresolved' -- unresolved / resolved / rss_only
);

-- 正規化タグ（フラット）
CREATE TABLE tags (
  tag_id         INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,    -- 正規化済みラベル
  is_curated     INTEGER DEFAULT 0        -- dアニメ キュレーション由来=1
);
-- シリーズ×タグ（m:n）
CREATE TABLE series_tags (
  series_id  INTEGER REFERENCES series(series_id),
  tag_id     INTEGER REFERENCES tags(tag_id),
  PRIMARY KEY (series_id, tag_id)
);

-- 増分 cursor / 状態（単一行 or key-value）
CREATE TABLE meta_state (
  id                               INTEGER PRIMARY KEY CHECK (id = 1),
  rss_last_guid                    TEXT,   -- 毎時 RSS の HWM
  snapshot_last_start_time         TEXT,   -- snapshot 差分の HWM（最大 startTime）
  snapshot_version_last_modified   TEXT,   -- version ゲート（前回の last_modified）
  last_full_refresh_at             TEXT
);

-- 将来用（v1 非対象・UI ランキングに使わない）: 7スロットの bounded ring（週次 delta の実験用）。
-- v1 の delta は prev_view_counter の 1 スロットのみ。これは作らない。
CREATE TABLE episode_view_history (
  content_id  TEXT REFERENCES episodes(content_id),
  slot        INTEGER,                    -- 0..6（曜日 or 日インデックス・上書き循環）
  view_counter INTEGER,
  taken_at    TEXT,
  PRIMARY KEY (content_id, slot)
);

-- 指標（実体集計テーブル・set-based で再計算）
CREATE TABLE series_metrics (
  series_id    INTEGER PRIMARY KEY REFERENCES series(series_id),
  total_views  INTEGER,                   -- Σ各話 view_counter（累計合算）
  delta_views  INTEGER,                   -- Σ(view_counter − prev_view_counter)＝前回比の伸び
  velocity     REAL,                      -- total_views ÷ 公開からの経過日数
  recency      REAL,                      -- 直近性（最新話 start_time の新しさ）
  hot_score    REAL,                      -- 勢い＝delta/velocity/recency のブレンド（係数 L3）
  updated_at   TEXT
);
```

- **タグ正規化の格納**: 取り込み時に `dアニメ` マーカー（`_dアニメ(ストア)?$` または `^dアニメ_`）除去 → `/` 分割 → 大小・全半角統一 → エイリアス吸収した**ラベルを `tags.name` に UNIQUE 格納**、`series_tags` で関連。素の `dアニメストア`（配信元）は除外。`is_curated=1` で優先表示に使える。

## 2. インデックス（一括ロード後に作成）

```sql
CREATE INDEX ix_episodes_start_time ON episodes(start_time);   -- HWM・新着・期間ウィンドウ
CREATE INDEX ix_episodes_series     ON episodes(series_id);
CREATE INDEX ix_series_tags_tag     ON series_tags(tag_id);    -- タグ絞り
CREATE INDEX ix_series_cours        ON series(cours);
CREATE INDEX ix_series_franchise    ON series(franchise_key);
CREATE INDEX ix_series_colkey       ON series(col_key);        -- 五十音
CREATE INDEX ix_metrics_hot         ON series_metrics(hot_score);   -- 勢い順
CREATE INDEX ix_metrics_total       ON series_metrics(total_views); -- 累計順
CREATE INDEX ix_metrics_velocity    ON series_metrics(velocity);
```

- **インデックスは初回シードの一括 INSERT 後にまとめて作成**（行ごとに索引更新するより速い）。日次の差分 UPSERT 時は既存索引のまま。
- ロード後に **`ANALYZE`**（プランナ統計の更新）。

## 3. UPSERT と delta（前日比）

`INSERT … ON CONFLICT(id) DO UPDATE` で、**DO UPDATE の SET 内では「素のカラム名＝更新前（既存）の値」、`excluded.カラム`＝今回 INSERT しようとした値**（[UPSERT 公式](https://sqlite.org/lang_upsert.html)）。これを使い、**旧値を `prev_view_counter` に退避しつつ最新値に更新**:

```sql
INSERT INTO episodes(content_id, series_id, view_counter, prev_view_counter,
                     comment_counter, like_counter, mylist_counter,
                     length_seconds, start_time, thumbnail_url, title, last_updated)
VALUES (:content_id, :series_id, :view, NULL, :comment, :like, :mylist,
        :length, :start_time, :thumb, :title, :now)
ON CONFLICT(content_id) DO UPDATE SET
  prev_view_counter = view_counter,            -- 素 = 既存(更新前)の値を prev に退避
  view_counter      = excluded.view_counter,   -- excluded = 今回の新しい値
  comment_counter   = excluded.comment_counter,
  like_counter      = excluded.like_counter,
  mylist_counter    = excluded.mylist_counter,
  last_updated      = excluded.last_updated;
```

- **delta = view_counter − prev_view_counter**（初回は prev=NULL → delta は 2 回目更新＝翌日から有効）。
- 公式どおり「`prev_x = x, x = excluded.x`」で旧値退避が成立（素カラム＝更新前値の確定挙動）。

## 4. 指標の再計算（set-based・行ループ禁止）

差分 UPSERT 後、**1 文で集計を作り直す**（行ごとループしない）:

```sql
INSERT INTO series_metrics(series_id, total_views, delta_views, velocity, recency, hot_score, updated_at)
SELECT s.series_id,
       SUM(e.view_counter)                                   AS total_views,
       SUM(e.view_counter - COALESCE(e.prev_view_counter, e.view_counter)) AS delta_views,
       CAST(SUM(e.view_counter) AS REAL)
         / MAX(1.0, julianday('now') - julianday(s.first_seen)) AS velocity,
       (julianday('now') - julianday(MAX(e.start_time)))     AS recency,
       0.0                                                   AS hot_score,  -- 下で更新
       :now
FROM series s JOIN episodes e ON e.series_id = s.series_id
GROUP BY s.series_id
ON CONFLICT(series_id) DO UPDATE SET
  total_views = excluded.total_views, delta_views = excluded.delta_views,
  velocity = excluded.velocity, recency = excluded.recency, updated_at = excluded.updated_at;

-- hot_score（勢い）の確定式（実装は scripts/etl/metrics.mjs の単一 INSERT OR REPLACE で
--  ep_agg → derived → ranges → normalized の CTE 連鎖により set-based に算出）:
--   hot_score = 0.5*delta_n + 0.3*velocity_n + 0.2*recency_n
--     delta_n    = min-max 正規化(delta_views)
--     velocity_n = min-max 正規化(log1p(velocity))
--     recency_n  = exp(-recency_days / tau)   -- tau=14 日・recency_days = now - MAX(start_time)
```

- 上記は2文に分けて示しているが、**実装は1文（`INSERT OR REPLACE … WITH …`）で正規化まで完結**する（全シリーズの min/max を `ranges` CTE で求め、同じ文内で `normalized` を計算）。
- ビュー（`CREATE VIEW`）でも可だが、**ランキング sort を頻繁に当てるので実体集計テーブル＋索引**が有利。generated column は固定式の派生に使う（例 velocity を保存列にするなら STORED）。
- **炎ティア（カードの Hot 表示・percentile ベース）【設計・未実装】**: `hot_score` の分布から percentile を求め、🔥🔥🔥＝上位1% / 🔥🔥＝上位5% / 🔥＝上位10% / それ未満は炎なし のティアをビルド時に算出して JSON へ付与する想定（`design-system.md` §9.6.1）。現状は tier 列を export せず、カードは数値を表示する。

## 5. PRAGMA（ビルド時・再生成可能なので緩めて速度優先）

```sql
PRAGMA journal_mode = WAL;     -- 速い・WALなら synchronous=NORMAL が安全（再生成可なら MEMORY/OFF も可）
PRAGMA synchronous  = NORMAL;  -- fsync を減らす（WAL で破損安全）。ビルド限定なら OFF も選択肢
PRAGMA temp_store   = MEMORY;  -- 一時索引/テーブルをメモリに
PRAGMA cache_size   = -65536;  -- 64MiB（負値=KiB 指定）
PRAGMA mmap_size    = 268435456; -- 256MiB（syscall を減らす）
PRAGMA foreign_keys = ON;      -- 整合性（FK）
```

- **DB は再生成可能な中間生成物**なので、最速重視なら `synchronous=OFF`／`journal_mode=MEMORY` でも可（クラッシュ時に失うのは作り直せる成果物のみ）。本番の堅牢性が要る用途ではない。
- 大きな blob を持たない方針なので `page_size` は既定で十分（必要時のみ調整）。

## 6. 更新フロー（2 ジョブ）

### 6.1 毎時ジョブ（軽量・短時間）

1. 状態（DB）を真実源から復元（§7）。
2. **RSS page1 のみ**取得（条件付き GET。304 ならスキップ）。
3. `meta_state.rss_last_guid` を HWM に、新しい item を **`rss_items` にステージング**（`watch_id` / `title_norm` / `pub_date`）。
4. **watch id → `contentId` 解決**: ① `nicovideo.jp/watch/<watch_id>` の redirect/解決で `so…` を得る、または ② **正規化タイトル＋pubDate 一致**で snapshot/既存 episodes と突合。
   - 解決できたら `resolved_content_id` を埋めて `episodes` に UPSERT・統合（`resolution_status='resolved'`）。
   - **未解決は `resolution_status='rss_only'`** とし、**RSS-only の「最新の動画」枠としてのみ export**（誤った id 統合・identity 破壊をしない）。後続の日次フルで解決を再試行。
5. 新着系の軽い JSON を export。状態を保存。

### 6.2 日次ジョブ（フル）

1. DB 復元 → **version ゲート**（`…/snapshot/version` の `last_modified` が `meta_state` と同じなら全件パスをスキップ）。
2. snapshot フル取得（`_offset` 上限は `startTime` 範囲分割・逐次・前回レスポンス時間ぶん待機・503 は 5 分バックオフ）。
3. **`BEGIN` … 一括 UPSERT（prev_view_counter に旧値退避）… `COMMIT`**。
4. nvapi series でシリーズ束ね（話順・支店判定）、タグ正規化（**各シリーズの最古話＝フル取得済み episode から導出。per-series の `contentId` 直引きはしない**）、フランチャイズ束ね、period クール結合（正規化タイトル＋信頼度＋手動 override）。
5. **set-based で `series_metrics` 再計算**（velocity＋delta＋recency＝hot_score）。
6. `first_seen`/`is_available` 等を更新（欠損作品は `is_available=0`）。
7. 用途別 **静的 JSON を export**（export メタに最終更新時刻）。`ANALYZE`。DB をキャッシュ保存。

- いずれも**変更検知アサート（`foundation.md` §5.4）**を通過したときだけ公開。**壊れ/空は公開しない**（前回正常物を保持）。

## 7. Actions でのファイル DB 運用（状態の真実源）

- **状態（DB・`prev_view_counter`・HWM cursor）の真実源は、専用 artifact もしくは専用 state ブランチ**に置く。
  `actions/cache` のエントリは key ごとに**不変**で、2 ジョブが古いキャッシュを復元して**分岐した不変キーを書く**と状態が割れるため、**`actions/cache` は高速化のフォールバック**に限定する。
- **単一 state-writer**: 状態を書くジョブは **concurrency group（同時実行 1・直列）**にし、毎時/日次が同時に状態を更新して壊さないようにする。
- 各ジョブ＝**真実源から復元 → 更新 → 真実源へ保存（コミット/アップロード）**。DB は再生成可能。
- **prev_view_counter は日次ジョブ間で生き残る必要がある**（delta のため）。真実源が失われた回は **delta を無効扱い（その回は velocity 主体）と正直に扱う**（壊さない）。
- **サイズ管理**: bounded 履歴（無制限にしない）、不要列を持たない、肥大時は `VACUUM`。

## 8. 出典

- **UPSERT**（DO UPDATE 内で素カラム＝更新前の値・`excluded.col`＝今回 INSERT しようとした値）: SQLite 公式 https://sqlite.org/lang_upsert.html
- **トランザクション一括の効果**（個別 INSERT は数十 tx/s ⇄ `BEGIN…COMMIT` で 50,000+ inserts/s。commit を全 INSERT で償却。ビルド限定なら `PRAGMA synchronous=OFF` も可）: SQLite 公式 FAQ Q19 https://sqlite.org/faq.html
- **PRAGMA**（`journal_mode=WAL` / `synchronous` / `temp_store=MEMORY` / `cache_size` / `mmap_size` 等）: SQLite 公式 https://sqlite.org/pragma.html ／ 性能解説 https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
- **インデックスは一括ロード後に作成・set-based 更新（行ループ回避）・ロード後 `ANALYZE`**: 上記 FAQ・性能解説・公式 docs に準拠。
