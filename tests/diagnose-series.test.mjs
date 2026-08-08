import { describe, expect, it } from 'vitest'

import {
  extractServerResponse,
  extractSeriesPageContentIds,
  parseContentIds,
  parseSeriesIds,
  summarizeSeriesResponse,
  summarizeSeriesPageResponse,
  summarizeWatchResponse,
} from '../scripts/diagnose-series.mjs'

describe('diagnose-series', () => {
  it('診断対象を検証して重複を除く', () => {
    expect(parseSeriesIds('569817, 572284,569817')).toEqual([569817, 572284])
    expect(parseContentIds('so46602808, so46602072')).toEqual(['so46602808', 'so46602072'])
    expect(() => parseSeriesIds('569817,nope')).toThrow(/invalid diagnostic target/)
    expect(() => parseContentIds('sm9')).toThrow(/invalid diagnostic target/)
  })

  it('視聴ページの埋め込みJSONからseries IDを診断する', () => {
    const source = {
      meta: { status: 200 },
      data: {
        response: {
          series: {
            id: 572284,
            title: '魔法少女猫たると',
            video: { first: { id: 'so46604391', owner: { id: 'ch2632720' } } },
          },
        },
      },
    }
    const html = `<meta name="server-response" content="${JSON.stringify(source).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" />`
    const result = summarizeWatchResponse('so46602808', 200, extractServerResponse(html))
    expect(result).toMatchObject({
      contentId: 'so46602808',
      seriesId: 572284,
      seriesTitle: '魔法少女猫たると',
      firstContentId: 'so46604391',
      ownerId: 'ch2632720',
    })
  })

  it('HTTP 200でもitems欠落を成功扱いせず可視化する', () => {
    expect(summarizeSeriesResponse(569817, { detail: {} })).toMatchObject({
      seriesId: 569817,
      isBranchSeries: false,
      itemsType: 'undefined',
      itemCount: null,
      contentIds: [],
    })
  })

  it('支店seriesの話IDと話順を記録する', () => {
    const result = summarizeSeriesResponse(569817, {
      detail: { title: '幼女戦記Ⅱ', owner: { channel: { id: 'ch2632720' } } },
      items: [
        { meta: { order: 1 }, video: { id: 'so46522236', title: '第1話' } },
        { meta: { order: 2 }, video: { id: 'so46548806', title: '第2話' } },
      ],
    })
    expect(result).toMatchObject({
      isBranchSeries: true,
      itemCount: 2,
      contentIds: ['so46522236', 'so46548806'],
      orders: [1, 2],
    })
  })

  it('seriesページHTMLから話IDを出現順に重複なく記録する', () => {
    const html = [
      '<a href="/watch/so46522236">第1話</a>',
      '<a href="/watch/so46547458">第2話</a>',
      '<a href="/watch/so46522236">第1話への重複リンク</a>',
    ].join('')
    expect(extractSeriesPageContentIds(html)).toEqual(['so46522236', 'so46547458'])
    expect(summarizeSeriesPageResponse(569817, 200, html)).toMatchObject({
      seriesId: 569817,
      httpStatus: 200,
      itemCount: 2,
      contentIds: ['so46522236', 'so46547458'],
    })
  })
})
