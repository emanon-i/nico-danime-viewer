/** タグ・フィルタ用チップ anchor DOM を生成する */
export function chip(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'tag-chip'
  a.href = href
  a.textContent = label
  return a
}
