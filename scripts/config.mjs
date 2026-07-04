// scripts/config.mjs
// 支店チャンネル定数の単一情報源。dアニメストア ニコニコ支店 = ch2632720。
// 本店（docomo）は対象外。この値を変えるとサイト全体の対象チャンネルが変わる。
export const BRANCH_CHANNEL_ID = 2632720
export const BRANCH_CHANNEL = `ch${BRANCH_CHANNEL_ID}`
export const BRANCH_RSS_URL = `https://ch.nicovideo.jp/${BRANCH_CHANNEL}/video?rss=2.0`
