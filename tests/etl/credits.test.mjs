import { describe, it, expect } from 'vitest'
import {
  extractCredits,
  normalizePersonKey,
  isStructuredCredits,
  countRecurrence,
  summarizeCreditExtraction,
} from '../../scripts/etl/credits.mjs'

// 構造版 = <br> または stripHtml 済みの \n\n 区切り。本エンジンは両方を読む。
const br = (parts) => parts.join('<br><br>')
// **実保存形式**（data/series/*.json の description）＝ HTML strip 済みの \n\n 段落・／区切り。
const stored = (parts) => parts.join('\n\n')
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

  it('ノイズ除外: 製作委員会名・年号のみ copyright・曲順番号・役割語は出さない', () => {
    expect(names(br(['s。', '製作:アニメ「X」製作委員会']))).toEqual([])
    expect(names(br(['s。', '01:オープニング曲／02:エンディング曲']))).toEqual([])
    // 年号＋製作委員会だけの copyright は実体ゼロ（年号と委員会は noise で落ちる）
    expect(extractCredits(br(['s。', '©2016 ガンダム製作委員会'])).tags).toEqual([])
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

// ──────────────────────────────────────────────────────────────────────────
// 品質回帰防止（自動タグ抽出の粗・実データ由来）。**実保存形式（\n\n）**で検証する。
// ──────────────────────────────────────────────────────────────────────────
describe('credits.mjs — ノイズ根絶（実保存形式 \\n\\n での回帰防止）', () => {
  it('① 役割語残存: 代表作注記/埋め込み役割語/タイトル後の役割語を人名タグにしない', () => {
    // (「作品」役職) の代表作注記が org→studio 化していたケース（key で正規化を検証）
    const a = stored(['s。', 'キャラクターデザイン:原 由美子（「こどものじかん」作画監督）'])
    expect(keys(a)).toEqual(['原由美子'])
    // 『作品』の後に役職が残るケース（奥田 陽介『…』作画監督 → 奥田陽介・名前が砕けない）
    const b = stored([
      's。',
      'キャラクターデザイン:奥田 陽介『劇場版 ソードアート・オンライン』作画監督',
    ])
    expect(keys(b)).toEqual(['奥田陽介'])
    // 原作:構成/A 漫画/B の埋め込み役割語（構成/漫画）を落とし、名前だけ残す（実データは半角 /）
    const c = stored(['s。', '原作:構成/竹内良輔 漫画/三好 輝（集英社「ジャンプSQ.」連載）'])
    expect(keys(c)).toEqual(['竹内良輔', '三好輝'])
  })

  it('② カンマ/読点: 複数人を分割（池尻裕、名嘉真法久）', () => {
    expect(names(stored(['s。', '脚本:池尻裕、名嘉真法久']))).toEqual(['池尻裕', '名嘉真法久'])
  })

  it('③-括弧: [レーベル/注記 断片を分離し名前だけにする', () => {
    expect(names(stored(['s。', '原作:ヤマグチノボル[MF文庫Jシリーズ]']))).toEqual([
      'ヤマグチノボル',
    ])
    expect(names(stored(['s。', '美術:立田一郎[スタジオ風雅]']))).toEqual(['立田一郎'])
  })

  it('③-全角空白: 兵頭　秀明 は 1 人（姓名）＝分割しない', () => {
    expect(keys(stored(['s。', 'キャスト:兵頭　秀明']))).toEqual(['兵頭秀明'])
    // 混在（佐野 岳[半] [全]鈴木勝大）＝半角は姓名・全角は人物間 → 2 人
    expect(keys(stored(['s。', '出演:佐野 岳　鈴木勝大']))).toEqual(['佐野岳', '鈴木勝大'])
    // 全角 3 名以上のリストは分割（舞台アンサンブル）
    expect(keys(stored(['s。', '出演:安島萌　荒木栄人　伊地華鈴']))).toEqual([
      '安島萌',
      '荒木栄人',
      '伊地華鈴',
    ])
  })

  it('読み仮名: 漢字名(ふりがな) は読みを捨て漢字名だけ（高村 佳偉人(たかむら かいと)）', () => {
    const raw = stored([
      's。',
      'キャスト:高村 佳偉人(たかむら かいと)、兵頭　秀明(ひょうどう ひであき)',
    ])
    expect(keys(raw)).toEqual(['高村佳偉人', '兵頭秀明']) // 読み（たかむらかいと等）は出さない
    // 正規のひらがな芸名（読みではない）は残す
    expect(names(stored(['s。', '監督:あらいずみるい']))).toEqual(['あらいずみるい'])
    // 短い全ひらがなの所属（スタジオぴえろ）は所属として温存（読み仮名と誤認しない）
    expect(names(stored(['s。', '原画:Ａ氏（ぴえろ）']))).toContain('ぴえろ')
  })

  it('④ ハッシュ/話数断片は落とすが、実在名の ～ は守る', () => {
    expect(keys(stored(['s。', '監督:上田 繁（第一話～第十話）']))).toEqual(['上田繁']) // 話数注記は捨てる
    expect(names(stored(['s。', '原作:山形石雄、既刊1〜5']))).toEqual(['山形石雄']) // 既刊レンジは捨てる
    expect(names(stored(['s。', 'コーナー:#コンパス戦闘摂理解析システム']))).toEqual([]) // ハッシュ断片
    // ～ を含む実在名は保持
    expect(names(stored(['s。', '出演:富永 み～な']))).toEqual(['富永 み～な'])
    expect(names(stored(['s。', '出演:キャイ～ン']))).toEqual(['キャイ～ン'])
  })

  it('タイトル: ネスト引用符内の読点で誤分割しない（「名湯『異世界の湯』開拓記 ～…～」）', () => {
    const raw = stored([
      's。',
      '原作:綿涙粉緒「名湯『異世界の湯』開拓記 ～アラフォー温泉マニアの転生先は、のんびり温泉天国でした～」（HJノベルス）',
    ])
    expect(names(raw)).toEqual(['綿涙粉緒']) // タイトル断片を人名化しない
  })

  it('副題: 引用符無しで名前に続く ～サブタイトル～ を除去（茨木野～…～）', () => {
    const raw = stored([
      's。',
      '原作:茨木野『不遇職【鑑定士】が実は最強だった』～奈落で鍛えた最強の【神眼】で無双する～（講談社）',
    ])
    expect(names(raw)).toEqual(['茨木野'])
  })

  it('製作委員会: A・B製作委員会 を `・` 分割で断片化させず丸ごと捨てる', () => {
    expect(names(stored(['s。', '製作:ペルソナ～トリニティ・ソウル～製作委員会']))).toEqual([])
  })

  it('孤立閉じ括弧のプロ―ズ断片は名前部分だけ残す（松岡由貴)からそう告げられた…）', () => {
    expect(names(stored(['s。', '出演:松岡由貴)からそう告げられた刀太は']))).toEqual(['松岡由貴'])
  })

  it('#4 半角読点 ､(U+FF64) も分割対象（分割前に幅統一）＝結合残存しない', () => {
    // U+FF64 が分割集合から漏れると NFKC で 、 化して 1 キーに結合残存する回帰を防ぐ
    expect(keys(stored(['s。', '撮影:池尻裕､名嘉真法久']))).toEqual(['池尻裕', '名嘉真法久'])
    expect(keys(stored(['s。', '撮影:池尻裕、名嘉真法久']))).toEqual(['池尻裕', '名嘉真法久'])
  })

  it('#3 copyright マイニング: ©著者／出版社・制作会社 を救出（role:値が無くても）', () => {
    // role:値 を持たない © 行から制作実体を拾う（ユーザー要件＝recall）
    expect(names(stored(['s。', '©藤本タツキ／集英社・MAPPA']))).toEqual([
      '藤本タツキ',
      '集英社',
      'MAPPA',
    ])
    // ◯◯製作委員会・年号は noise で落ちる（著者/スタジオだけ残す）
    expect(names(stored(['s。', '©カラー／EVA製作委員会']))).toEqual(['カラー'])
    expect(names(stored(['s。', '©三好 輝／集英社・憂国のモリアーティ製作委員会']))).toEqual([
      '三好 輝',
      '集英社',
    ])
    // 英語法人格 CO., LTD. は分割前に剥がして社名に寄せる（LTD./Inc. 断片を出さない）
    expect(names(stored(['s。', '©2020 SANRIO CO., LTD.']))).toEqual(['SANRIO'])
  })

  it('#3 copyright: role:値がある copyright 行は従来どおり parseBlock で拾う', () => {
    expect(
      names(stored(['s。', '原作:谷口悟朗／アニメーション制作:サンライズ ©サンライズ']))
    ).toContain('谷口悟朗')
  })

  it('summarizeCreditExtraction: 実保存形式（\\n\\n）で正しく数える（0% に張り付かない）', () => {
    const descs = [
      stored(['あらすじ。', '監督:山田太郎／脚本:鈴木花子']), // 構造あり・credit あり
      stored(['あらすじだけ。', '続きの段落。']), // 構造あり・credit なし
      '<p>フラットなRSS本文 原作:誰か</p>', // フラット（分解しない）
    ]
    const m = summarizeCreditExtraction(descs)
    expect(m.total).toBe(3)
    expect(m.withCredits).toBe(1)
    expect(m.flat).toBe(1)
    expect(m.creditCoveragePct).toBeGreaterThan(0) // 旧 description.mjs はここが 0 に張り付いていた
    expect(m.totalTags).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 独立再確認で残った粗の根治（出版注記・ラテン中黒・半角2名・主題歌ラベル・委員会空白・© run-on）。
// ──────────────────────────────────────────────────────────────────────────
describe('credits.mjs — 残課題の根治（実保存形式 \\n\\n）', () => {
  it('#1a 出版注記: ◯◯刊/連載 は実出版社に寄せ、雑誌/◯◯文庫は落とす', () => {
    // 末尾「刊」「連載」を剥がして実出版社を回収（集英社・講談社・KADOKAWA）
    expect(names(stored(['s。', '©藤本タツキ／集英社刊']))).toEqual(['藤本タツキ', '集英社'])
    expect(names(stored(['s。', '©原作者／KADOKAWA刊']))).toEqual(['原作者', 'KADOKAWA'])
    expect(names(stored(['s。', '©作者／講談社 連載']))).toEqual(['作者', '講談社'])
    // 雑誌（月刊/週刊）・レーベル（◯◯文庫）は publication note ＝落とす
    expect(names(stored(['s。', '©作者／月刊Gファンタジー']))).toEqual(['作者'])
    expect(names(stored(['s。', '©作者／週刊少年マガジン']))).toEqual(['作者'])
    expect(names(stored(['s。', '©作者／角川文庫刊']))).toEqual(['作者'])
    expect(names(stored(['s。', '©作者／富士見ファンタジア文庫']))).toEqual(['作者'])
  })

  it('#2 ラテン社名の中黒: role 値の純ラテン名（HALF H・P STUDIO）は割らない', () => {
    expect(names(stored(['s。', 'アニメーション制作:HALF H・P STUDIO']))).toEqual([
      'HALF H・P STUDIO',
    ])
    // 日本語人名↔ラテン名の連結は従来どおり割る
    expect(names(stored(['s。', '原作:奈須きのこ・TYPE-MOON']))).toEqual([
      '奈須きのこ',
      'TYPE-MOON',
    ])
    // © 行の中黒は別権利者の区切り＝割る（ATLUS・TMS / SCEI・IPA は別社）
    expect(names(stored(['s。', '©ATLUS・TMS']))).toEqual(['ATLUS', 'TMS'])
    expect(names(stored(['s。', '©2000 Production I.G／ANX・SCEI・IPA']))).toContain('SCEI')
    expect(names(stored(['s。', '©2000 Production I.G／ANX・SCEI・IPA']))).toContain('IPA')
  })

  it('#3 半角スペース 2 名: 純漢字 4+4 は 2 人・姓 名（短い側）は 1 人', () => {
    expect(names(stored(['s。', '脚本:三好智樹 橋本智広']))).toEqual(['三好智樹', '橋本智広'])
    // 姓 名（井上 喜久子=2+3 / 佐々木 研太郎=3+3）は 1 人＝割らない（誤分割回避）
    expect(keys(stored(['s。', '出演:井上 喜久子']))).toEqual(['井上喜久子'])
    expect(keys(stored(['s。', '出演:佐々木 研太郎']))).toEqual(['佐々木研太郎'])
  })

  it('#4 主題歌ラベル: ラベルは区切りに化けて曲名は捨て、人名だけ残す', () => {
    // 音楽 role の音楽ブロック（作曲者＋主題歌アーティスト混在）をラベル境界で分離
    const raw = stored([
      's。',
      '音楽:Dolce Triade オープニングテーマ｢Cloud Age Symphony｣OKINO,SHUNTARO,エンディングテーマ｢Over The Sky｣Hitomi',
    ])
    const ns = names(raw)
    expect(ns).toEqual(['Dolce Triade', 'OKINO', 'SHUNTARO', 'Hitomi'])
    expect(ns).not.toContain('オープニングテーマ')
    expect(ns).not.toContain('エンディングテーマ')
    // ラベル単体（曲名のみ）はタグにしない
    expect(names(stored(['s。', 'オープニング主題歌アーティスト:オープニングテーマ']))).toEqual([])
    // 末尾にラベルが付いた実在アーティストはラベルだけ落とす（山田花子エンディングテーマ→山田花子）
    expect(names(stored(['s。', '音楽:山田花子エンディングテーマ']))).toEqual(['山田花子'])
  })

  it('#5 委員会の空白混入: パートナーズ内の空白を無視して委員会を落とす', () => {
    expect(names(stored(['s。', '製作:こまねこフィルムパー トナーズ']))).toEqual([])
  })

  it('#1b © run-on: 役割語/部署/法人格 boilerplate を剥がして実体を分離', () => {
    // 埋め込み役割語（原作）を境界に分離
    expect(names(stored(['s。', '©MilkyCartoon 原作 Naomi Iwata']))).toEqual([
      'MilkyCartoon',
      'Naomi Iwata',
    ])
    // 末尾部署（企画製作部）・先頭役割語（制作協力）を剥がす
    expect(names(stored(['s。', '製作:TOブックス企画製作部']))).toEqual(['TOブックス'])
    expect(names(stored(['s。', 'アニメーション制作:制作協力ENGI']))).toEqual(['ENGI'])
    // 孤立法人格接頭・英語 boilerplate を剥がして実名を回収（編集室は実スタジオ名なので守る）
    expect(names(stored(['s。', '©CyberAgent, Inc. developed by QualiArts']))).toEqual([
      'CyberAgent',
      'QualiArts',
    ])
    expect(keys(stored(['s。', '編集:森田編集室']))).toEqual(['森田編集室'])
  })

  it('#1c generic プロジェクト/埋め込み年号: 委員会代理は落とし実制作会社は拾う', () => {
    // copyright/studio の generic ◯◯プロジェクトは委員会代理＝落とす
    expect(names(stored(['s。', '©新テニスの王子様プロジェクト']))).toEqual([])
    expect(names(stored(['s。', '製作:舞台化プロジェクト']))).toEqual([])
    // 実在スタジオ（project No.9）・先頭が プロジェクト の作品名（プロジェクトラブライブ！）は守る
    expect(names(stored(['s。', 'アニメーション制作:project No.9']))).toEqual(['project No.9'])
    expect(names(stored(['s。', '製作:プロジェクトラブライブ！']))).toEqual([
      'プロジェクトラブライブ！',
    ])
    // 埋め込み年号で実制作会社を分離（製作:竜の子… 1993 日本コロムビア…）
    expect(keys(stored(['s。', '製作:竜の子プロダクション 1993 日本コロムビア株式会社']))).toEqual([
      '竜の子プロダクション',
      '日本コロムビア',
    ])
  })

  it('#年号 著作権年号（先頭/末尾/年付き範囲）を剥がして実名を残す', () => {
    expect(names(stored(['s。', '©2020 SANRIO CO., LTD.']))).toEqual(['SANRIO'])
    expect(names(stored(['s。', '©1990年－1994年 ぴえろ']))).toEqual(['ぴえろ'])
    expect(names(stored(['s。', '©Benesse Corporation1988－']))).toEqual(['Benesse']) // 年範囲＋法人格除去
  })
})
