// scripts/fetch.mjs
//
// 【雛形・未実装】ニコニコ snapshot 検索 API から dアニメストア ニコニコ支店の
// 作品メタデータを取得し、data/*.json として静的出力する。
//
// 設計メモ（実装は次段）:
//   - エンドポイント:
//       https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search
//   - クエリ: q=dアニメストア / targets=tagsExact
//   - 取得フィールド: contentId,title,viewCounter,tags,genre,startTime,thumbnailUrl
//   - 支店絞り込み: レスポンスの channelId === 2632720 のみ採用
//       （channelId は API の filter 不可・取得のみ可 → クライアント側で絞る）
//   - User-Agent ヘッダ必須（公開・非営利。節度あるアクセス）
//   - ページング: _offset / _limit。取得結果は data/ に JSON 化
//
// 環境変数（予定）:
//   NICO_USER_AGENT  ... 必須。問い合わせ先を含む UA 文字列

const NICO_BRANCH_CHANNEL_ID = 2632720; // dアニメストア ニコニコ支店

async function main() {
  console.error('[fetch] 未実装です。docs/ の仕様に従って実装してください。');
  console.error(`[fetch] 対象 channelId = ${NICO_BRANCH_CHANNEL_ID}`);
  process.exit(1);
}

main();
