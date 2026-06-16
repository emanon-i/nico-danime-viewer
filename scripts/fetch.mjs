// scripts/fetch.mjs
// pnpm fetch エントリポイント: snapshot → assert → SQLite UPSERT のオーケストレーション
//
// 環境変数:
//   NICO_USER_AGENT  問い合わせ先を含む UA 文字列（必須）

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  openDatabase,
  createSchema,
  createIndexes,
  bulkUpsertEpisodes,
  getMetaState,
  updateMetaState,
} from './db/db.mjs'
import { fetchAllBranchEpisodes } from './nico/snapshot.mjs'
import { assertSnapshotOk } from './nico/assert.mjs'
import { logger } from './lib/logger.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')
const DB_PATH = join(DATA_DIR, 'build.sqlite')

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })

  const db = openDatabase(DB_PATH)
  createSchema(db)

  const meta = getMetaState(db)
  const storedVersion = meta.snapshot_version_last_modified ?? null

  logger.info('fetch', 'starting snapshot fetch', { storedVersion })

  const result = await fetchAllBranchEpisodes(storedVersion)

  if (result.skipped) {
    logger.info('fetch', 'snapshot version unchanged, nothing to do')
    return
  }

  const { episodes, newVersion } = result

  // アサート失敗時は throw → catch で非ゼロ終了。DB は未更新のまま保護される。
  assertSnapshotOk({ meta: { status: 200, totalCount: episodes.length }, data: episodes }, null)

  const now = new Date().toISOString()
  bulkUpsertEpisodes(db, episodes, now)
  createIndexes(db)

  // version は DB コミット成功後にのみ保存
  updateMetaState(db, { snapshot_version_last_modified: newVersion, last_full_refresh_at: now })

  logger.info('fetch', 'snapshot fetch complete', { count: episodes.length, version: newVersion })
}

main().catch((err) => {
  logger.error('fetch', err.message, err.assertFields ?? {})
  process.exit(1)
})
