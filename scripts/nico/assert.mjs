// scripts/nico/assert.mjs
// 上流変更検知アサート: 取得結果を公開前に検査。失敗時は Error を throw して caller に非ゼロ終了させる。

import { BRANCH_CHANNEL_ID } from './filter.mjs'

export const assertConfig = {
  snapshot: {
    minBranchCount: 100, // 支店エピソード最低件数
    maxDropRate: 0.2, // totalCount が前回比 20% 超減で fail
    requiredFields: ['contentId', 'startTime', 'viewCounter'],
  },
  rss: {
    minItemCount: 1,
  },
}

/**
 * snapshot API レスポンス検査
 * @param {{ meta: { status: number; totalCount?: number }, data: unknown[] }} response
 * @param {number | null} previousTotalCount - 前回の totalCount（null = 初回）
 */
export function assertSnapshotOk(response, previousTotalCount = null) {
  const { meta, data } = response

  if (meta?.status !== 200) {
    throw assertFail('snapshot', 'meta.status != 200', {
      sourceName: 'snapshot',
      expectedMin: 200,
      actual: meta?.status,
      context: 'meta.status check',
    })
  }

  if (!data?.length) {
    throw assertFail('snapshot', 'data[] is empty', {
      sourceName: 'snapshot',
      expectedMin: 1,
      actual: 0,
      context: 'data array empty',
    })
  }

  for (const field of assertConfig.snapshot.requiredFields) {
    if (data[0][field] === undefined) {
      throw assertFail('snapshot', `missing required field: ${field}`, {
        sourceName: 'snapshot',
        expectedMin: 1,
        actual: 0,
        context: `field=${field}`,
      })
    }
  }

  const branchCount = data.filter((e) => Number(e.channelId) === BRANCH_CHANNEL_ID).length
  if (branchCount < assertConfig.snapshot.minBranchCount) {
    throw assertFail('snapshot', 'branch episode count below threshold', {
      sourceName: 'snapshot',
      expectedMin: assertConfig.snapshot.minBranchCount,
      actual: branchCount,
      context: 'channelId==2632720 count check',
    })
  }

  if (previousTotalCount !== null && previousTotalCount > 0 && meta.totalCount !== undefined) {
    const dropRate = 1 - meta.totalCount / previousTotalCount
    if (dropRate > assertConfig.snapshot.maxDropRate) {
      throw assertFail('snapshot', 'totalCount dropped too much', {
        sourceName: 'snapshot',
        expectedMin: Math.floor(previousTotalCount * (1 - assertConfig.snapshot.maxDropRate)),
        actual: meta.totalCount,
        context: `drop rate ${(dropRate * 100).toFixed(1)}%`,
      })
    }
  }
}

function assertFail(source, message, fields) {
  const err = new Error(`[assert:${source}] ${message}`)
  err.assertFields = fields
  return err
}
