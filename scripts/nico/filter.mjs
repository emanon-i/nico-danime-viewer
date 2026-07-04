// scripts/nico/filter.mjs
// 支店フィルタ: channelId == 2632720 のエピソードのみ採用（本店データ混入防止）

import { BRANCH_CHANNEL_ID } from '../config.mjs'
export { BRANCH_CHANNEL_ID }

/**
 * @param {unknown[]} episodes - snapshot API のレスポンス data[]
 * @returns {unknown[]} channelId == 2632720 のみ
 */
export function filterBranchEpisodes(episodes) {
  return episodes.filter((ep) => Number(ep.channelId) === BRANCH_CHANNEL_ID)
}
