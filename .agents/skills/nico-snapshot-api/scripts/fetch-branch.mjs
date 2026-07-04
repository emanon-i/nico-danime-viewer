// fetch-branch.mjs
//
// ニコニコ snapshot 検索API v2 から dアニメストア「ニコニコ支店」の作品を取得するサンプル。
// 「支店の取り方」を実コードで示すリファレンス兼ヘルパ。
// 本番の scripts/fetch.mjs を実装するときの雛形として流用してよい。
//
// 実行:
//   NICO_USER_AGENT="nico-danime-viewer/0.1 (contact: you@example.com)" \
//     node .claude/skills/nico-snapshot-api/scripts/fetch-branch.mjs
//
// 注意（ToS）: 非営利 / User-Agent 必須 / 低頻度。索引は毎日 AM5:00 更新。

const ENDPOINT =
  'https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search';

const BRANCH_CHANNEL_ID = 2632720; // dアニメストア ニコニコ支店（filter 不可・取得のみ）
const APP_CONTEXT = 'nico-danime-viewer';
const USER_AGENT =
  process.env.NICO_USER_AGENT || 'nico-danime-viewer/0.1 (set NICO_USER_AGENT)';

const SLEEP_MS = 500; // リクエスト間隔（低頻度アクセス）
const PAGE_LIMIT = 100; // _limit 上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * snapshot 検索API を1ページ取得する。
 * @param {number} offset _offset（最大 100000）
 */
async function fetchPage(offset) {
  const params = new URLSearchParams({
    q: 'dアニメストア',
    targets: 'tagsExact', // タグ「dアニメストア」完全一致
    fields: [
      'contentId',
      'title',
      'viewCounter',
      'tags',
      'genre',
      'startTime',
      'thumbnailUrl',
      'channelId', // ← 支店判定に必須（取得のみ可）
    ].join(','),
    _sort: '-viewCounter', // 再生数の多い順
    _offset: String(offset),
    _limit: String(PAGE_LIMIT),
    _context: APP_CONTEXT,
  });

  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`snapshot API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** channelId === 2632720 のみ残す（クライアント側フィルタ＝支店の取り方の肝） */
function onlyBranch(items) {
  return items.filter((v) => v.channelId === BRANCH_CHANNEL_ID);
}

async function main() {
  if (!process.env.NICO_USER_AGENT) {
    console.warn('[warn] NICO_USER_AGENT 未設定。連絡先入りの UA を設定してください。');
  }

  // デモとして先頭 3 ページ（最大 300 件）だけ取得して支店分を数える。
  // 全件取得する場合は totalCount まで _offset を進め、100000 超は
  // filters[startTime][gte]/[lt] で投稿期間ウィンドウを区切ってずらす。
  const branch = [];
  let total = null;

  for (let page = 0; page < 3; page++) {
    const offset = page * PAGE_LIMIT;
    const json = await fetchPage(offset);
    total ??= json.meta?.totalCount;
    const hits = onlyBranch(json.data ?? []);
    branch.push(...hits);
    console.log(
      `page=${page} offset=${offset} 取得=${json.data?.length ?? 0} 支店該当=${hits.length}`,
    );
    if ((json.data?.length ?? 0) < PAGE_LIMIT) break;
    await sleep(SLEEP_MS);
  }

  console.log(`\nmeta.totalCount(タグ一致全体) = ${total}`);
  console.log(`支店(channelId=${BRANCH_CHANNEL_ID})該当 = ${branch.length} 件（デモ範囲）`);
  if (branch[0]) {
    const v = branch[0];
    console.log(`例: ${v.title} / view=${v.viewCounter} / ${v.contentId}`);
  }

  // 本番では branch を data/*.json に書き出す（生成物は git 管理外）。
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
