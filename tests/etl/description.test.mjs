import { describe, it, expect } from 'vitest'
import { parseDescription, summarizeDescriptionParse } from '../../scripts/etl/description.mjs'

// nvapi 構造版 = <br><br> 区切り。フラット = <p> ラッパのみ（<br> 無し）。
const STRUCTURED = [
  '本文あらすじ。',
  '蔵馬(南野秀一):緒方恵美／飛影:檜山修之',
  '原作:冨樫義博（集英社）／監督・絵コンテ:阿部記之／アニメーション制作:studioぴえろ',
  '©ぴえろ／集英社',
  '次話→so44540860　第一話→so10000000',
].join('<br><br>')

describe('parseDescription (PH-0014 F-0057)', () => {
  it('構造版: synopsis/cast/staff/studios/copyright/episodeLinks を抽出', () => {
    const r = parseDescription(STRUCTURED)
    expect(r.structured).toBe(true)
    expect(r.synopsis).toBe('本文あらすじ。')
    expect(r.cast).toEqual([
      { role: '蔵馬(南野秀一)', actors: ['緒方恵美'] }, // 括弧付き役名を保持
      { role: '飛影', actors: ['檜山修之'] },
    ])
    expect(r.staff).toEqual([
      { role: '原作', names: ['冨樫義博（集英社）'] },
      { role: '監督・絵コンテ', names: ['阿部記之'] }, // 複合役を保持
      { role: 'アニメーション制作', names: ['studioぴえろ'] }, // 英字社名を保持
    ])
    expect(r.studios).toEqual(['studioぴえろ'])
    expect(r.copyright).toBe('©ぴえろ／集英社')
    expect(r.episodeLinks).toEqual({ next: 'so44540860', first: 'so10000000' })
  })

  it('全角コロン：も役:値の区切りとして扱う', () => {
    const r = parseDescription('s。<br><br>主人公：声優Ａ／脇役：声優Ｂ')
    expect(r.cast).toEqual([
      { role: '主人公', actors: ['声優Ａ'] },
      { role: '脇役', actors: ['声優Ｂ'] },
    ])
  })

  it('フラット（<br>無し）は分解せず synopsis フォールバック', () => {
    const r = parseDescription('<p>あらすじとクレジットが連結 原作:作者 ©委員会</p>')
    expect(r.structured).toBe(false)
    expect(r.cast).toEqual([])
    expect(r.staff).toEqual([])
    expect(r.synopsis).toContain('あらすじとクレジットが連結')
  })

  it('誤検知ゼロ: 各話要約「#3：文／#4：文」を cast にしない（synopsis 温存）', () => {
    const r = parseDescription('導入。<br><br>#3：敵が現れる。／#4：戦いが始まる。')
    expect(r.cast).toEqual([])
    expect(r.synopsis).toContain('#3：敵が現れる。')
    expect(r.unclassified.length).toBeGreaterThan(0) // 温存を記録
  })

  it('誤検知ゼロ: ／を含む synopsis（【各話概要】A編／B編）を cast にしない', () => {
    const r = parseDescription('【各話概要】A編／B編<br><br>原作:X')
    expect(r.cast).toEqual([])
    expect(r.synopsis).toContain('【各話概要】A編／B編')
    expect(r.staff).toEqual([{ role: '原作', names: ['X'] }])
  })

  it('作品名の 。（『バクマン。』『娘。』）は文末扱いせず値に保持', () => {
    const r = parseDescription('s。<br><br>原作:大場つぐみ（『バクマン。』集英社）')
    expect(r.staff).toEqual([{ role: '原作', names: ['大場つぐみ（『バクマン。』集英社）'] }])
  })

  it('copyright の各種表記（©/(C)/製作委員会/原作／）を検出', () => {
    expect(parseDescription('s。<br><br>(C)2020 製作委員会').copyright).toContain('製作委員会')
    expect(parseDescription('s。<br><br>原作／作者「タイトル」').copyright).toContain('原作／')
  })

  it('null/空は空構造を返す', () => {
    const r = parseDescription(null)
    expect(r.structured).toBe(false)
    expect(r.synopsis).toBeNull()
    expect(r.cast).toEqual([])
  })

  it('summarizeDescriptionParse: 集計メトリクスを返す', () => {
    const m = summarizeDescriptionParse([STRUCTURED, '<p>flat 原作:x</p>', null])
    expect(m.total).toBe(3)
    expect(m.structured).toBe(1)
    expect(m.flatFallback).toBe(2)
    expect(m.withCast).toBe(1)
    expect(m.withStaff).toBe(1)
  })
})
