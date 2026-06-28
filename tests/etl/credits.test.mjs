import { describe, it, expect } from 'vitest'
import {
  extractCredits,
  normalizePersonKey,
  isStructuredCredits,
  countRecurrence,
} from '../../scripts/etl/credits.mjs'

// 構造版 = <br> または stripHtml 済みの \n\n 区切り。本エンジンは両方を読む。
const br = (parts) => parts.join('<br><br>')
const names = (raw) => extractCredits(raw).tags.map((t) => t.display)
const keys = (raw) => extractCredits(raw).tags.map((t) => t.key)

describe('credits.mjs — 発見タグ抽出（1カテゴリ統合 + 正規化）', () => {
  it('cast/staff/studio を 1 列に統合し、名前（value）だけを返す（役名/役割は捨てる）', () => {
    const raw = br([
      'あらすじ。',
      '主人公:声優A／ヒロイン:声優B',
      '原作:作者X／監督:監督Y／アニメーション制作:スタジオZ',
    ])
    expect(names(raw)).toEqual(['声優A', '声優B', '作者X', '監督Y', 'スタジオZ'])
  })

  it('正規化キー: 内部空白除去で「諏訪部 順一」と「諏訪部順一」が同一キーになる', () => {
    expect(normalizePersonKey('諏訪部 順一')).toBe('諏訪部順一')
    expect(normalizePersonKey('諏訪部順一')).toBe('諏訪部順一')
    // NFKC: 全角ラテンは半角小文字化（ＭＡＰＰＡ↔MAPPA↔mappa）
    expect(normalizePersonKey('ＭＡＰＰＡ')).toBe('mappa')
    expect(normalizePersonKey('MAPPA')).toBe('mappa')
    // 法人格除去
    expect(normalizePersonKey('株式会社トレノバ')).toBe('トレノバ')
  })

  it('連結値の分割: 中黒・読点で複数名に割る（須藤友徳・田畑壽之・碇谷敦→3名）', () => {
    const raw = br(['s。', 'キャラクターデザイン:須藤友徳・田畑壽之・碇谷敦'])
    expect(names(raw)).toEqual(['須藤友徳', '田畑壽之', '碇谷敦'])
  })

  it('連結分割: 原作「奈須きのこ・TYPE-MOON」は 2 タグ（人物＋会社）に割る', () => {
    const raw = br(['s。', '原作:奈須きのこ・TYPE-MOON'])
    expect(names(raw)).toEqual(['奈須きのこ', 'TYPE-MOON'])
    expect(keys(raw)).toEqual(['奈須きのこ', 'type-moon'])
  })

  it('頭文字を中黒で繋いだ 1 名（声優「M・A・O」）は割らない', () => {
    const raw = br(['s。', '主人公:M・A・O'])
    expect(names(raw)).toEqual(['M・A・O'])
  })

  it('Western 名（リリー・フランキー）は中黒で割らない（全カタカナ）', () => {
    const raw = br(['s。', 'コナー:リリー・フランキー'])
    expect(names(raw)).toEqual(['リリー・フランキー'])
  })

  it('スタッフ名末尾の所属括弧を分離: 米山和仁（劇団ホチキス）→ 人物＋会社', () => {
    const raw = br(['s。', '脚本・演出:米山和仁（劇団ホチキス）'])
    expect(names(raw)).toEqual(['米山和仁', '劇団ホチキス'])
  })

  it('出版社注記の括弧は捨ててクリーン名にする: 岸本斉史（集英社…連載）→ 岸本斉史', () => {
    const raw = br(['s。', '原作:岸本斉史（集英社「週刊少年ジャンプ」連載）'])
    expect(names(raw)).toEqual(['岸本斉史'])
  })

  it('原作系 role の括弧注記は構造的に捨てる（出版社名リストに無い架空社でも）', () => {
    // role ベース（原作/原案/漫画…）で括弧を注記とみなす＝既知出版社リストに依存しない
    expect(names(br(['s。', '原作:架空太郎（架空書房「架空誌」掲載）']))).toEqual(['架空太郎'])
    // 一方 原作系でない role（脚本/演出）の括弧は所属会社として残す
    expect(names(br(['s。', '脚本・演出:米山和仁（劇団ホチキス）']))).toEqual([
      '米山和仁',
      '劇団ホチキス',
    ])
  })

  it('混在ブロック（おしりたんてい型）: 声優も監督も制作会社も per-segment で全部拾う', () => {
    const raw = br([
      's。',
      'おしりたんてい:三瓶由布子／ブラウン:齋藤彩夏／原作:トロル／監督:セトウケンジ／制作:東映アニメーション',
    ])
    expect(names(raw)).toEqual([
      '三瓶由布子',
      '齋藤彩夏',
      'トロル',
      'セトウケンジ',
      '東映アニメーション',
    ])
  })

  it('copyright 行から制作実体を救出（役:値があれば再パース）', () => {
    const raw = br([
      's。',
      '原作:武田綾乃／監督:石原立也／アニメーション制作:京都アニメーション／製作:『響け！』製作委員会',
    ])
    // 製作委員会を含む段落でも staff/studio を救出（委員会名自体はノイズで落ちる）
    expect(names(raw)).toContain('石原立也')
    expect(names(raw)).toContain('京都アニメーション')
    expect(names(raw)).not.toContain('『響け！』製作委員会')
  })

  it('主題歌: 曲名は捨て、作詞/作曲/歌の人名だけ救出', () => {
    const raw = br([
      's。',
      'エンディング主題歌:『ダンス』作詞：藤本記子　作曲：小杉保夫　歌：伊勢大貴',
    ])
    const ns = names(raw)
    expect(ns).toContain('藤本記子')
    expect(ns).toContain('小杉保夫')
    expect(ns).toContain('伊勢大貴')
    expect(ns).not.toContain('ダンス')
  })

  it('2.5次元舞台「キャラ 役：俳優」形式 → 俳優名だけ救出', () => {
    const raw = br(['s。', '出演:小野田坂道 役：糠信泰州、今泉俊輔 役：猪野広樹'])
    expect(names(raw)).toEqual(['糠信泰州', '猪野広樹'])
  })

  it('声の出演（単一行・読点リスト）も cast 源にする', () => {
    const raw = br(['s。', '声の出演:戸田恵子、内海賢二、森功至'])
    expect(names(raw)).toEqual(['戸田恵子', '内海賢二', '森功至'])
  })

  it('ノイズ除外: 製作委員会名・年号 copyright・曲順番号・役割語は出さない', () => {
    expect(names(br(['s。', '製作:アニメ「X」製作委員会']))).toEqual([])
    expect(names(br(['s。', '01:オープニング曲／02:エンディング曲']))).toEqual([])
    expect(extractCredits(br(['s。', '©2016 Thunderbolt Fantasy Project'])).tags).toEqual([])
  })

  it('各話概要/あらすじ（プロ―ズ）は ／ とコロンを含んでも抽出しない', () => {
    const raw = br(['導入。', '第1話：おたすけ依頼が来た。／第2話：衝撃の展開。'])
    expect(names(raw)).toEqual([])
  })

  it('フラット（<br>/\\n\\n 無し）は分解しない＝誤検知源', () => {
    expect(isStructuredCredits('<p>あらすじ 原作:作者 ©委員会</p>')).toBe(false)
    expect(extractCredits('<p>あらすじ 原作:作者 ©委員会</p>').tags).toEqual([])
  })

  it('構造判定: <br> でも stripHtml 済みの \\n\\n でも structured', () => {
    expect(isStructuredCredits('a<br><br>b')).toBe(true)
    expect(isStructuredCredits('a\n\nb')).toBe(true)
  })

  it('series 内 dedup（同一 key は 1 つ）', () => {
    const raw = br(['s。', '主人公:杉山紀彰／別人:杉山 紀彰'])
    expect(keys(raw)).toEqual(['杉山紀彰']) // 空白違いも同一キーで 1 つ
  })

  it('countRecurrence: canonical key 単位で出現シリーズ数を数える', () => {
    const a = extractCredits(br(['s。', '監督:山田太郎'])).tags
    const b = extractCredits(br(['s。', '脚本:山田 太郎'])).tags // 空白違い＝同キー
    const c = extractCredits(br(['s。', '監督:鈴木花子'])).tags
    const recur = countRecurrence([a, b, c])
    // recurrence は将来の序列/facet 用ユーティリティ（UI のクリック可否には不使用）。
    expect(recur.get('山田太郎')).toBe(2) // 2 シリーズに登場（空白違いも同キーに集約）
    expect(recur.get('鈴木花子')).toBe(1) // 1 シリーズ（それでも UI ではクリック可能）
  })
})
