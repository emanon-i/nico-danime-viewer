// scripts/nico/filter.mjs
// 支店フィルタ: channelId == 2632720 のエピソードのみ採用（本店データ混入防止）

export const BRANCH_CHANNEL_ID = 2632720

/**
 * @param {unknown[]} episodes - snapshot API のレスポンス data[]
 * @returns {unknown[]} channelId == 2632720 のみ
 */
export function filterBranchEpisodes(episodes) {
  return episodes.filter((ep) => Number(ep.channelId) === BRANCH_CHANNEL_ID)
}
