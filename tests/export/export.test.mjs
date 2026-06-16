import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportAll } from '../../scripts/export/export.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
  updateSeriesFields,
  replaceSeriesTags,
  bulkUpsertRssItems,
} from '../../scripts/db/db.mjs'
import { recalcSeriesMetrics } from '../../scripts/etl/metrics.mjs'

const NOW = '2026-06-16T00:00:00+09:00'

function setupDb() {
  const db = openDatabase(':memory:')
  createSchema(db)
  return db
}

function readJson(outDir, filename) {
  return JSON.parse(readFileSync(join(outDir, filename), 'utf-8'))
}

describe('exportAll (F-0020)', () => {
  let db
  let outDir

  beforeEach(() => {
    db = setupDb()
    outDir = join(tmpdir(), `nico-export-${process.pid}-${Date.now()}`)
    mkdirSync(outDir, { recursive: true })

    // series（colKey/cours は updateSeriesFields で別途セット）
    bulkUpsertSeries(
      db,
      [
        { seriesId: 1, title: 'ゆるキャン△' },
        { seriesId: 2, title: 'SAO' },
      ],
      NOW
    )
    updateSeriesFields(db, 1, { col_key: 'yu', cours: '2026-春', updated_at: NOW })
    updateSeriesFields(db, 2, { col_key: 'sa', updated_at: NOW })

    // episodes
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: '第1話',
          viewCounter: 1000,
          startTime: '2026-01-01T00:00:00+09:00',
        },
        {
          contentId: 'so2',
          seriesId: 2,
          title: '第1話',
          viewCounter: 500,
          startTime: '2026-01-01T00:00:00+09:00',
        },
      ],
      NOW
    )

    // tags（replaceSeriesTags は { name, isCurated } 配列を受け取る）
    replaceSeriesTags(db, 1, [{ name: 'ほのぼの', isCurated: false }])

    // metrics
    recalcSeriesMetrics(db, NOW)

    // rss items（bulkUpsertRssItems は全フィールドを受け取る）
    bulkUpsertRssItems(db, [
      {
        watchId: '111',
        title: 'テスト第1話',
        pubDate: '2026-06-16T00:00:00+09:00',
        guid: null,
        titleNorm: null,
        link: null,
      },
    ])
  })

  it('test_export_all_json_files: 6つのJSONファイルと series/ ディレクトリが出力される', () => {
    exportAll(db, outDir, NOW)

    const files = ['works.json', 'ranking.json', 'tags.json', 'cours.json', 'kana.json', 'new.json']
    for (const f of files) {
      expect(existsSync(join(outDir, f)), `${f} が存在しない`).toBe(true)
    }
    expect(existsSync(join(outDir, 'series')), 'series/ ディレクトリが存在しない').toBe(true)
  })

  it('test_works_json_structure: works.json に lastUpdated と works 配列がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'works.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.works)).toBe(true)
    expect(data.works.length).toBeGreaterThan(0)

    const work = data.works.find((w) => w.seriesId === 1)
    expect(work).toBeTruthy()
    expect(work.title).toBe('ゆるキャン△')
    expect(Array.isArray(work.tags)).toBe(true)
  })

  it('test_ranking_json_structure: ranking.json に hot と popular がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'ranking.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.hot)).toBe(true)
    expect(Array.isArray(data.popular)).toBe(true)

    if (data.hot.length > 0) {
      const entry = data.hot[0]
      expect(entry).toHaveProperty('seriesId')
      expect(entry).toHaveProperty('title')
      expect(entry).toHaveProperty('totalViews')
      expect(entry).toHaveProperty('hotScore')
    }
  })

  it('test_tags_json_structure: tags.json に tags 配列 + topHotTags + topPopularTags がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'tags.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.tags)).toBe(true)
    expect(Array.isArray(data.topHotTags)).toBe(true)
    expect(Array.isArray(data.topPopularTags)).toBe(true)
  })

  it('test_cours_json_structure: cours.json に cours 配列がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'cours.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.cours)).toBe(true)

    const spring = data.cours.find((c) => c.cours === '2026-春')
    expect(spring).toBeTruthy()
    expect(spring.seriesIds).toContain(1)
  })

  it('test_kana_json_structure: kana.json に kana 配列がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'kana.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.kana)).toBe(true)

    const yu = data.kana.find((k) => k.colKey === 'yu')
    expect(yu).toBeTruthy()
    expect(yu.seriesIds).toContain(1)
  })

  it('test_new_json_structure: new.json に items 配列がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'new.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBeGreaterThan(0)

    const item = data.items[0]
    expect(item).toHaveProperty('watchId')
    expect(item).toHaveProperty('title')
    expect(item).toHaveProperty('pubDate')
  })

  it('test_series_json_structure: series/{id}.json にシリーズ詳細 + episodes がある', () => {
    exportAll(db, outDir, NOW)
    const data = readJson(outDir, 'series/1.json')

    expect(data.lastUpdated).toBe(NOW)
    expect(data.seriesId).toBe(1)
    expect(data.title).toBe('ゆるキャン△')
    expect(Array.isArray(data.episodes)).toBe(true)
    expect(data.episodes.length).toBeGreaterThan(0)
    expect(data.episodes[0]).toHaveProperty('contentId')
    expect(data.episodes[0]).toHaveProperty('title')
  })
})
