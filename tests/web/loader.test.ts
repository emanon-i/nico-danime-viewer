import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  loadWorks,
  loadRanking,
  loadTags,
  loadCours,
  loadKana,
  loadNew,
  loadSeriesDetail,
} from '../../web/src/data/loader'

const VALID_WORKS = {
  lastUpdated: '2026-06-16T00:00:00Z',
  works: [
    {
      seriesId: 1,
      title: 'テスト',
      thumbnailUrl: null,
      descriptionFirst: null,
      tags: [],
      cours: null,
      franchiseKey: null,
      colKey: null,
      relatedSeries: [],
    },
  ],
}

function mockOk(data: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(data) })
  )
}

function mockHttpError(status = 404) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce({ ok: false, status, json: () => Promise.resolve({}) })
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('loadWorks (F-0021)', () => {
  it('test_loader_typed_access: WorksJson 型で返す', async () => {
    mockOk(VALID_WORKS)
    const result = await loadWorks()
    expect(result.lastUpdated).toBe(VALID_WORKS.lastUpdated)
    expect(result.works).toHaveLength(1)
    expect(result.works[0].seriesId).toBe(1)
  })

  it('test_loader_rejects_bad_schema: スキーマ不一致で例外を投げる', async () => {
    mockOk({ wrong: 'schema' })
    await expect(loadWorks()).rejects.toThrow('[loader] schema mismatch')
  })

  it('HTTP エラーで例外を投げる', async () => {
    mockHttpError(404)
    await expect(loadWorks()).rejects.toThrow('[loader] HTTP 404')
  })
})

describe('loadRanking (F-0021)', () => {
  it('test_loader_typed_access: RankingJson 型で返す', async () => {
    const data = { lastUpdated: '2026-06-16T00:00:00Z', hot: [], popular: [] }
    mockOk(data)
    const result = await loadRanking()
    expect(result.lastUpdated).toBe(data.lastUpdated)
    expect(Array.isArray(result.hot)).toBe(true)
    expect(Array.isArray(result.popular)).toBe(true)
  })

  it('test_loader_rejects_bad_schema: スキーマ不一致で例外', async () => {
    mockOk({ lastUpdated: '2026-06-16T00:00:00Z', hot: [] }) // missing popular
    await expect(loadRanking()).rejects.toThrow('[loader] schema mismatch')
  })
})

describe('loadTags (F-0021)', () => {
  it('test_loader_typed_access: TagsJson 型で返す', async () => {
    const data = {
      lastUpdated: '2026-06-16T00:00:00Z',
      tags: [],
      topHotTags: [],
      topPopularTags: [],
    }
    mockOk(data)
    const result = await loadTags()
    expect(Array.isArray(result.tags)).toBe(true)
  })
})

describe('loadCours (F-0021)', () => {
  it('test_loader_typed_access: CoursJson 型で返す', async () => {
    const data = { lastUpdated: '2026-06-16T00:00:00Z', cours: [] }
    mockOk(data)
    const result = await loadCours()
    expect(Array.isArray(result.cours)).toBe(true)
  })
})

describe('loadKana (F-0021)', () => {
  it('test_loader_typed_access: KanaJson 型で返す', async () => {
    const data = { lastUpdated: '2026-06-16T00:00:00Z', kana: [] }
    mockOk(data)
    const result = await loadKana()
    expect(Array.isArray(result.kana)).toBe(true)
  })
})

describe('loadNew (F-0021)', () => {
  it('test_loader_typed_access: NewJson 型で返す', async () => {
    const data = { lastUpdated: '2026-06-16T00:00:00Z', items: [] }
    mockOk(data)
    const result = await loadNew()
    expect(Array.isArray(result.items)).toBe(true)
  })
})

describe('loadSeriesDetail (F-0021)', () => {
  it('test_loader_typed_access: SeriesDetailJson 型で返す', async () => {
    const data = {
      lastUpdated: '2026-06-16T00:00:00Z',
      seriesId: 1,
      title: 'ゆるキャン△',
      thumbnailUrl: null,
      descriptionFirst: null,
      tags: [],
      cours: null,
      colKey: null,
      relatedSeries: [],
      episodes: [],
    }
    mockOk(data)
    const result = await loadSeriesDetail(1)
    expect(result.seriesId).toBe(1)
    expect(Array.isArray(result.episodes)).toBe(true)
  })
})
