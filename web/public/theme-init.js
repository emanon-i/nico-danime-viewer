// FOUC 防止: <head> で同期ロード (async/defer 不可)。
// script-src 'self' 準拠 (インラインスクリプト不使用)。
;(function () {
  var v = localStorage.getItem('nico-danime-theme')
  if (v === 'dark' || v === 'light') {
    document.documentElement.dataset.theme = v
  }
  // 未設定 → data-theme なし → CSS prefers-color-scheme に委ねる
})()
