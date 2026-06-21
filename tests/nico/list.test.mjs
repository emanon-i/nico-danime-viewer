import { describe, it, expect } from 'vitest'
import {
  extractSeriesTitle,
  provisionalSeriesId,
  contentIdFromThumbnail,
  resolveByTitle,
  sanitizeTitle,
  trimSeriesTitle,
  buildWatchColKeyMap,
} from '../../scripts/nico/list.mjs'

describe('buildWatchColKeyMap', () => {
  it('/watch/soXXXX エントリのみ contentId→{colKey,title} に写像（/series/ は除外）', () => {
    const items = [
      { title: 'ああっ女神さまっ', col_key: 'あ', url: 'https://www.nicovideo.jp/series/109288' },
      { title: '春を抱いていた Ⅰ', col_key: 'は', url: 'https://www.nicovideo.jp/watch/so39381031' },
      { title: 'パパンがパンダ! その2', col_key: 'は', url: 'https://www.nicovideo.jp/watch/so37527849' },
      { title: 'col_key欠落', col_key: '', url: 'https://www.nicovideo.jp/watch/so1' },
    ]
    const m = buildWatchColKeyMap(items)
    expect(m.size).toBe(2)
    expect(m.get('so39381031')).toEqual({ colKey: 'は', title: '春を抱いていた Ⅰ' })
    expect(m.get('so37527849')?.colKey).toBe('は')
    expect(m.has('so1')).toBe(false) // col_key 欠落は除外
  })
})

// ===== extractSeriesTitle =====
// 主系は resolveByTitle（list.json 前方一致）。本関数は仮シリーズ命名専用フォールバック。
// 実データ 2140 件分析結果に基づくテストケース（全パターン実例使用）

describe('extractSeriesTitle — 実データ由来・全パターン', () => {
  // --- 基本: 第N話（算用数字 73.7%）---
  it('第N話 算用数字（最頻出）', () => {
    expect(extractSeriesTitle('mofusand animation　第24話　トイレ')).toBe('mofusand animation')
  })
  it('第N話 3桁', () => {
    expect(extractSeriesTitle('もちにゃん　第116話　クレーンゲームにハマるにゃ！')).toBe(
      'もちにゃん'
    )
  })
  it('第N話 サブタイあり', () => {
    expect(extractSeriesTitle('心臓に復讐を誓って　第14話　クズ男との決別')).toBe(
      '心臓に復讐を誓って'
    )
  })
  it('第1話 サブタイなし', () => {
    expect(extractSeriesTitle('ゆるキャン△　第12話')).toBe('ゆるキャン△')
  })
  it('第N巻', () => {
    expect(extractSeriesTitle('タイトル　第3巻　副題')).toBe('タイトル')
  })

  // --- 第N話（漢数字 4.2%）実データサンプル ---
  it('第十二話 漢数字（実例: 黄泉のツガイ）', () => {
    expect(extractSeriesTitle('黄泉のツガイ　第十二話　番小者と祈祷師')).toBe('黄泉のツガイ')
  })
  it('第拾参話 大字（実例: 春夏秋冬代行者）', () => {
    expect(extractSeriesTitle('春夏秋冬代行者 春の舞　第拾参話　奪還')).toBe(
      '春夏秋冬代行者 春の舞'
    )
  })
  it('第一話 基本漢数字', () => {
    expect(extractSeriesTitle('ヒナまつり　第一話　超能力少女現る！')).toBe('ヒナまつり')
  })
  it('第十一章 章形式（実例: 自称悪役令嬢）', () => {
    expect(
      extractSeriesTitle('自称悪役令嬢な婚約者の観察記録。　第11章　自称悪役令嬢と王家の観察記録。')
    ).toBe('自称悪役令嬢な婚約者の観察記録。')
  })
  it('第十二輪 輪形式（実例: リィンカーネーション）', () => {
    expect(extractSeriesTitle('リィンカーネーションの花弁　第十二輪　声が届くまで')).toBe(
      'リィンカーネーションの花弁'
    )
  })
  it('第十一章 章形式・漢数字（実例: 本好きの下剋上）', () => {
    expect(extractSeriesTitle('本好きの下剋上 領主の養女　第十一章　グーテンベルクの集い')).toBe(
      '本好きの下剋上 領主の養女'
    )
  })

  // --- #N（半角 9.1%）---
  it('#N 半角（実例: クラスで2番目）', () => {
    expect(
      extractSeriesTitle('クラスで2番目に可愛い女の子と友だちになった　#11　『恋人』との年末年始')
    ).toBe('クラスで2番目に可愛い女の子と友だちになった')
  })
  it('#N 半角（実例: NEEDY GIRL）', () => {
    expect(extractSeriesTitle('NEEDY GIRL OVERDOSE　#11　Canon a 3 Violinis con Basso c.')).toBe(
      'NEEDY GIRL OVERDOSE'
    )
  })
  it('＃N 全角（実例: ダイヤのA）', () => {
    expect(extractSeriesTitle('ダイヤのA actⅡ -Second Season-　＃11　相棒として')).toBe(
      'ダイヤのA actⅡ -Second Season-'
    )
  })

  // --- EP N（0.1%・実例）---
  it('EP11 形式（実例: 一畳間）', () => {
    expect(extractSeriesTitle('一畳間まんきつ暮らし！　EP11　漫画喫茶ヘッジホッグ')).toBe(
      '一畳間まんきつ暮らし！'
    )
  })
  it('EP11 形式（実例: キルアオ）', () => {
    expect(extractSeriesTitle('キルアオ　EP11　第一回殺し屋会議（サミット）')).toBe('キルアオ')
  })

  // --- 数字のみ（1.7%）---
  it('数字のみ（実例: 不死身な僕の日常 シーズン3）', () => {
    expect(extractSeriesTitle('不死身な僕の日常　シーズン3　11　太陽島へ突撃')).toBe(
      '不死身な僕の日常　シーズン3'
    )
  })
  it('数字のみ（実例: ルパン三世 PART1）', () => {
    expect(extractSeriesTitle('ルパン三世 PART1　1　ルパンは燃えているか…?!')).toBe(
      'ルパン三世 PART1'
    )
  })

  // --- シリーズ名に半角スペース含む（30%・重要ケース）---
  it('シリーズ名に半角スペース: Mr.War', () => {
    expect(extractSeriesTitle('Mr.War -最強の元軍人-　第1話　裏切られた最強の男')).toBe(
      'Mr.War -最強の元軍人-'
    )
  })
  it('シリーズ名に半角スペース: mofusand animation', () => {
    expect(extractSeriesTitle('mofusand animation　第24話　トイレ')).toBe('mofusand animation')
  })
  it('シリーズ名に半角スペース＋漢数字: 春夏秋冬代行者 春の舞', () => {
    expect(extractSeriesTitle('春夏秋冬代行者 春の舞　第拾参話　奪還')).toBe(
      '春夏秋冬代行者 春の舞'
    )
  })

  // --- エッジケース ---
  it('話数なし（返値=タイトル全体）', () => {
    expect(extractSeriesTitle('タイトルだけ')).toBe('タイトルだけ')
  })
  it('null は空文字を返す', () => {
    expect(extractSeriesTitle(null)).toBe('')
  })
  it('undefined は空文字を返す', () => {
    expect(extractSeriesTitle(undefined)).toBe('')
  })
})

// ===== resolveByTitle — アポストロフィ正規化 =====
// DOG DAYS'/'' 実データ: エピソードタイトルは U+2019、list.json は U+0027
describe('resolveByTitle — アポストロフィ正規化', () => {
  it("DOG DAYS' U+2019 エピソードが U+0027 list.json にヒット", () => {
    const byTitle = new Map([["DOG DAYS'", 102754]])
    // エピソードタイトルの ' は U+2019（RIGHT SINGLE QUOTATION MARK）
    expect(resolveByTitle('DOG DAYS’　EPISODE 7　封印洞窟戦！', byTitle)).toBe(102754)
  })
  it("DOG DAYS'' U+2019x2 エピソードが U+0027x2 list.json にヒット", () => {
    const byTitle = new Map([["DOG DAYS''", 102755]])
    expect(resolveByTitle("DOG DAYS''　第12話　「帰郷」", byTitle)).toBe(102755)
  })
  it('U+0027 同士は従来通り一致', () => {
    const byTitle = new Map([["DOG DAYS'", 102754]])
    expect(resolveByTitle("DOG DAYS'　第12話　テスト", byTitle)).toBe(102754)
  })
  it('アポストロフィ正規化で誤マッチしない（別シリーズを区別）', () => {
    const byTitle = new Map([
      ['DOG DAYS', 102753],
      ["DOG DAYS'", 102754],
      ["DOG DAYS''", 102755],
    ])
    // DOG DAYS'' エピソードは DOG DAYS(102753) でなく DOG DAYS''(102755) にヒット
    expect(resolveByTitle("DOG DAYS''　第12話　帰郷", byTitle)).toBe(102755)
  })
})

// ===== extractSeriesTitle — EPISODE 全大文字 =====
describe('extractSeriesTitle — EPISODE 全大文字', () => {
  it("EPISODE 全大文字（実例: DOG DAYS'）", () => {
    // DOG DAYS' は U+2019（実エピソードタイトル由来）
    expect(extractSeriesTitle('DOG DAYS’　EPISODE 7　封印洞窟戦！')).toBe('DOG DAYS’')
  })
  it('Episode（先頭大文字）は従来通り', () => {
    expect(extractSeriesTitle('シリーズ名　Episode 1　サブタイ')).toBe('シリーズ名')
  })
  it('episode（全小文字）も通る', () => {
    expect(extractSeriesTitle('シリーズ名　episode 1　サブタイ')).toBe('シリーズ名')
  })
})

// ===== provisionalSeriesId =====
describe('provisionalSeriesId', () => {
  it('同タイトルは同値（決定的）', () => {
    expect(provisionalSeriesId('黄泉のツガイ')).toBe(provisionalSeriesId('黄泉のツガイ'))
  })
  it('常に負数（本物 seriesId と区別）', () => {
    expect(provisionalSeriesId('テスト')).toBeLessThan(0)
    expect(provisionalSeriesId('黄泉のツガイ')).toBeLessThan(0)
    expect(provisionalSeriesId('Mr.War -最強の元軍人-')).toBeLessThan(0)
  })
  it('0 にならない', () => {
    expect(provisionalSeriesId('')).not.toBe(0)
    expect(provisionalSeriesId('テスト')).not.toBe(0)
  })
  it('異なるタイトルは異なる値（衝突なし確認）', () => {
    const ids = [
      '黄泉のツガイ',
      'Mr.War -最強の元軍人-',
      '一畳間まんきつ暮らし！',
      '春夏秋冬代行者 春の舞',
      'ヒナまつり',
      'ダイヤのA actⅡ -Second Season-',
    ].map(provisionalSeriesId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ===== sanitizeTitle — 二重化畳み込み・末尾除去 =====
describe('sanitizeTitle — 二重化畳み込み（U+3000 中点）', () => {
  it('U+3000 中点で前後が同一 → 前半に畳む（実例: APPLESEED）', () => {
    expect(sanitizeTitle('APPLESEED　APPLESEED')).toBe('APPLESEED')
  })
  it('複合タイトル+U+3000 中点（実例: 100万年地球の旅　バンダーブック）', () => {
    expect(sanitizeTitle('100万年地球の旅　バンダーブック　100万年地球の旅　バンダーブック')).toBe(
      '100万年地球の旅　バンダーブック'
    )
  })
  it('中間に劇場版が挟まる "A　劇場版　A" → A を返す（実例: MINKY MOMO）', () => {
    expect(sanitizeTitle('MINKY MOMO in 旅立ちの駅　劇場版　MINKY MOMO in 旅立ちの駅')).toBe(
      'MINKY MOMO in 旅立ちの駅'
    )
  })
  it('劇場版で始まる複合タイトル（実例: 劇場版　K　MISSING　KINGS）', () => {
    expect(sanitizeTitle('劇場版　K　MISSING　KINGS　劇場版　K　MISSING　KINGS')).toBe(
      '劇場版　K　MISSING　KINGS'
    )
  })
  it('前後が異なる場合はそのまま（正当なタイトル）', () => {
    expect(sanitizeTitle('イナズマデリバリー　シーズン2')).toBe('イナズマデリバリー　シーズン2')
  })
  it('U+3000 なしの短い正常タイトルは変更しない', () => {
    expect(sanitizeTitle('魔法少女まどか☆マギカ')).toBe('魔法少女まどか☆マギカ')
  })
  it('半角スペース区切りの正当タイトルは変更しない（P08 は U+3000 のみ）', () => {
    expect(sanitizeTitle('TARI TARI')).toBe('TARI TARI')
  })
})

describe('sanitizeTitle — 末尾の話数注記・本編を除去', () => {
  it('末尾 (第N話) を除去（半角カッコ）', () => {
    expect(sanitizeTitle('ニセコイ:OVA　シンコン(第2話)')).toBe('ニセコイ:OVA　シンコン')
  })
  it('末尾 （第N話） を除去（全角カッコ）', () => {
    expect(sanitizeTitle('タイトル（第1話）')).toBe('タイトル')
  })
  it('末尾 U+3000 + 本編 を除去', () => {
    expect(sanitizeTitle('JAM Project JAPAN CIRCUIT 2007 Break Out　本編')).toBe(
      'JAM Project JAPAN CIRCUIT 2007 Break Out'
    )
  })
  it('末尾 半角スペース + 本編 を除去', () => {
    expect(sanitizeTitle('こまねこのクリスマス 迷子になったプレゼント 本編')).toBe(
      'こまねこのクリスマス 迷子になったプレゼント'
    )
  })
  it('本編が中間にある場合は除去しない', () => {
    // 本編 が中間にある場合: extractSeriesTitle が捌くため sanitizeTitle は変更不要
    expect(sanitizeTitle('Series　本編　サブタイ')).toBe('Series　本編　サブタイ')
  })
  it('null は空文字を返す', () => {
    expect(sanitizeTitle(null)).toBe('')
  })
  it('空文字はそのまま', () => {
    expect(sanitizeTitle('')).toBe('')
  })
})

describe('extractSeriesTitle — 本編パターン（パターン7）', () => {
  it('シリーズ名　本編 → シリーズ名（本編で終わる）', () => {
    expect(extractSeriesTitle('CLANNAD番外編 「もうひとつの世界 智代編」　本編')).toBe(
      'CLANNAD番外編 「もうひとつの世界 智代編」'
    )
  })
  it('シリーズ名　本編　サブタイ → シリーズ名', () => {
    expect(
      extractSeriesTitle('ニセコイ:OVA　本編　シンコン／マジカルパティシエ小咲ちゃん!!(第2話)')
    ).toBe('ニセコイ:OVA')
  })
  it('#N を含む長いタイトルで本編末尾除去（ルパン三世TVSP #11）', () => {
    expect(
      extractSeriesTitle(
        "ルパン三世TVSP #11 愛のダ・カーポ ～ＦＵＪＩＫＯ's Ｕnlucky Ｄays～　本編"
      )
    ).toBe("ルパン三世TVSP #11 愛のダ・カーポ ～ＦＵＪＩＫＯ's Ｕnlucky Ｄays～")
  })
  it('フォールバック二重化も処理（APPLESEED　APPLESEED）', () => {
    expect(extractSeriesTitle('APPLESEED　APPLESEED')).toBe('APPLESEED')
  })
})

// ===== trimSeriesTitle — P08/P09なし・末尾trim＋ノイズ除去のみ =====
describe('trimSeriesTitle — シリーズタイトル専用・二重化不変', () => {
  it('末尾 U+3000+本編 を除去', () => {
    expect(trimSeriesTitle('JAM Project JAPAN CIRCUIT 2007 Break Out　本編')).toBe(
      'JAM Project JAPAN CIRCUIT 2007 Break Out'
    )
  })
  it('末尾 (第N話) を除去（半角カッコ）', () => {
    expect(trimSeriesTitle('タイトル(第1話)')).toBe('タイトル')
  })
  it('末尾 （第N話） を除去（全角カッコ）', () => {
    expect(trimSeriesTitle('タイトル（第1話）')).toBe('タイトル')
  })
  it('U+3000 区切りの正当なシリーズ名は変更しない（TARI　TARI）', () => {
    expect(trimSeriesTitle('TARI　TARI')).toBe('TARI　TARI')
  })
  it('半角スペース区切りの正当なシリーズ名は変更しない（TARI TARI）', () => {
    expect(trimSeriesTitle('TARI TARI')).toBe('TARI TARI')
  })
  it('二重化タイトルは変更しない（P08/P09 なし）', () => {
    expect(trimSeriesTitle('APPLESEED　APPLESEED')).toBe('APPLESEED　APPLESEED')
  })
  it('前後の空白を除去', () => {
    expect(trimSeriesTitle('  タイトル  ')).toBe('タイトル')
  })
  it('null は空文字を返す', () => {
    expect(trimSeriesTitle(null)).toBe('')
  })
  it('空文字はそのまま', () => {
    expect(trimSeriesTitle('')).toBe('')
  })
})

// ===== contentIdFromThumbnail =====
describe('contentIdFromThumbnail', () => {
  it('サムネ URL から so{N} を抽出', () => {
    expect(
      contentIdFromThumbnail('https://nicovideo.cdn.nimg.jp/thumbnails/46451801/46451801')
    ).toBe('so46451801')
  })
  it('null は null を返す', () => {
    expect(contentIdFromThumbnail(null)).toBeNull()
  })
  it('マッチしない URL は null', () => {
    expect(contentIdFromThumbnail('https://example.com/image.jpg')).toBeNull()
  })
})
