// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  sanitizeOverview,
  normalizeIngestText,
  validateExternalUrl,
} from '../../web/src/shared/sanitize'
import { watchLink, seriesLink } from '../../web/src/shared/deeplink'
import { renderDetail } from '../../web/src/features/detail/detail'
import type { SeriesDetail } from '../../web/src/data/types'

const SERIES_STUB: SeriesDetail = {
  seriesId: 1,
  title: 'テスト作品',
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: [],
  cours: null,
  colKey: null,
  relatedSeries: [],
  episodes: [
    {
      contentId: 'so12345',
      episodeNo: 1,
      title: 'ep1',
      viewCounter: 100,
      startTime: '2024-01-01T00:00:00+09:00',
      thumbnailUrl: null,
    },
  ],
}

describe('F-0040: XSS サニタイズ', () => {
  describe('test_sanitize_overview_allowlist', () => {
    it('<script> タグをコンテンツごと除去する', () => {
      const result = sanitizeOverview('<script>alert(1)</script>内容')
      expect(result).not.toContain('<script>')
      expect(result).not.toContain('alert')
      expect(result).toContain('内容')
    })

    it('on* イベント属性を除去する', () => {
      const result = sanitizeOverview('<img onerror="alert(1)" src="x.jpg">')
      expect(result).not.toContain('onerror')
      expect(result).not.toContain('alert')
    })

    it('style 属性を除去する', () => {
      const result = sanitizeOverview('<span style="display:none">text</span>')
      expect(result).not.toContain('style')
      expect(result).toContain('text')
    })

    it('<br> タグを残す', () => {
      const result = sanitizeOverview('line1<br>line2<br/>line3')
      expect(result).toContain('<br>')
    })

    it('許可外タグを除去しコンテンツは残す', () => {
      const result = sanitizeOverview('<p>段落<b>太字</b></p>')
      expect(result).not.toContain('<p>')
      expect(result).not.toContain('<b>')
      expect(result).toContain('段落')
      expect(result).toContain('太字')
    })

    it('javascript: href を無効化する', () => {
      const result = sanitizeOverview('<a href="javascript:alert(1)">click</a>')
      expect(result).not.toContain('javascript:')
    })
  })

  describe('test_ingest_normalizes_html', () => {
    it('NUL 文字 (U+0000) を除去する', () => {
      const nul = String.fromCharCode(0x0000)
      const result = normalizeIngestText('text' + nul + 'normal')
      expect(result).not.toContain(nul)
      expect(result).toContain('normal')
    })

    it('BEL (U+0007) を除去する', () => {
      const bel = String.fromCharCode(0x0007)
      const result = normalizeIngestText('text' + bel + 'normal')
      expect(result).not.toContain(bel)
      expect(result).toContain('text')
    })

    it('LF (\\n) は保持する', () => {
      const result = normalizeIngestText('line1\nline2')
      expect(result).toBe('line1\nline2')
    })

    it('TAB (\\t) は保持する', () => {
      const result = normalizeIngestText('col1\tcol2')
      expect(result).toBe('col1\tcol2')
    })
  })
})

describe('F-0041: 外部リンク安全化', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_external_link_rel: detail の外部リンクに noopener noreferrer が付く', () => {
    renderDetail(container, SERIES_STUB)
    const externalLinks = container.querySelectorAll('a[target="_blank"]')
    expect(externalLinks.length).toBeGreaterThan(0)
    externalLinks.forEach((a) => {
      const rel = a.getAttribute('rel') ?? ''
      expect(rel).toContain('noopener')
      expect(rel).toContain('noreferrer')
    })
  })

  describe('test_url_allowlist_rejects_bad_scheme_host', () => {
    it('javascript: URL を拒否する', () => {
      expect(validateExternalUrl('javascript:alert(1)')).toBeNull()
    })

    it('http: を拒否する（https のみ許可）', () => {
      expect(validateExternalUrl('http://www.nicovideo.jp/watch/so123')).toBeNull()
    })

    it('許可外ホストを拒否する', () => {
      expect(validateExternalUrl('https://evil.com/path')).toBeNull()
      expect(validateExternalUrl('https://nicovideo.jp.evil.com/')).toBeNull()
    })

    it('https://www.nicovideo.jp を許可する', () => {
      expect(validateExternalUrl('https://www.nicovideo.jp/watch/so123')).not.toBeNull()
    })

    it('https://*.nimg.jp を許可する', () => {
      expect(validateExternalUrl('https://nicovideo-cdn.nimg.jp/thumbnails/x.jpg')).not.toBeNull()
    })

    it('不正 URL 文字列を拒否する', () => {
      expect(validateExternalUrl('not-a-url')).toBeNull()
      expect(validateExternalUrl('')).toBeNull()
    })
  })

  describe('test_deeplink_id_validation', () => {
    it('不正 contentId で watchLink が null を返す', () => {
      expect(watchLink('invalid')).toBeNull()
      expect(watchLink('sv1234')).toBeNull()
      expect(watchLink('')).toBeNull()
      expect(watchLink('123')).toBeNull()
    })

    it('正常 contentId で watchLink が URL を返す', () => {
      const url = watchLink('so12345')
      expect(url).not.toBeNull()
      expect(url).toContain('nicovideo.jp')
      expect(url).toContain('so12345')
    })

    it('不正 seriesId で seriesLink が null を返す', () => {
      expect(seriesLink(-1)).toBeNull()
      expect(seriesLink(0)).toBeNull()
      expect(seriesLink(1.5)).toBeNull()
    })

    it('正常 seriesId で seriesLink が URL を返す', () => {
      const url = seriesLink(123)
      expect(url).not.toBeNull()
      expect(url).toContain('nicovideo.jp')
      expect(url).toContain('123')
    })
  })
})
