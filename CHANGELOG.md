---
title: Changelog
status: current
updated: 2026-08-08
---

# Changelog

このファイルは実装変更の経緯を記録する。`docs/l1_*` / `docs/l2_*` の仕様書は現行システムだけを記述し、過去との差分はここへ集約する。

## 2026-08-08

### Fixed

- GitHub hosted runner では nvapi series API が HTTP 200 と正しい `detail` を返しても、有料各話の `items` だけを空配列にする場合があるため、HTTP 成功と利用可能な各話取得を分離した。run 統計を `ok` / `failed` / `usable` / `empty` / `invalid` に分け、`nvapiLastOkAt` は `usable > 0` の場合だけ更新する。
- nvapi `items` が空配列の場合でも、支店所有、`detail.title` と候補タイトルの一致、対象全話の厳格タイトル照合が成立したときだけシリーズ所属を補完できるようにした。非空 `items` が得られた場合は contentId membership と配列順を引き続き優先する。
- `list.json` の正規タイトルから分かる正→正の不一致を B7 の巡回対象より先に毎日検証し、不一致が残る限り再試行するようにした。
- A2 の取得漏れ救出が B7 後に誤った正シリーズ所属を再導入できたため、A2 直後に既知不一致だけを再検証する B7b を追加した。これにより同じ日次 run の export 前に収束する。
- `第N話` と `#N` に加え、`BREAK N`、`にゃーのN`、`EPISODE N`、`Chapter N`、全角数字から話数を取得できるようにした。既存話のオフセットまたは候補群の最小表示話数から、続編の通算表記をシリーズ内話数へ変換する。

### Added

- `魔法少女猫たると`（series 572284）と `渡くんの××が崩壊寸前`（series 572266）の確認済み title hint を追加した。将来の `list.json` とタイトルまたは ID が衝突した場合は処理を停止する。
- `fetch-daily.yml` の手動実行に読み取り専用のシリーズ診断を追加した。series ID / content ID を指定すると watch ページ、シリーズ HTML、nvapi payload と run 統計を記録し、state 更新と deploy は行わない。

### Verified

- [PR #9](https://github.com/emanon-i/nico-danime-viewer/pull/9) の日次実行で、`魔法少女猫たると`、`渡くんの××が崩壊寸前`、`幼女戦記Ⅱ` の所属と話順が整合化されることを確認した。
- A2 後に残った `テイルズ オブ ゼスティリア ザ クロス 第2期` の所属を実 state で再現し、[PR #10](https://github.com/emanon-i/nico-danime-viewer/pull/10) の B7b により第2期の13話・シリーズ内話数1〜13へ収束することを確認した。

## 2026-07-18

### Changed

- 日次 B7 の対象を空シリーズだけに限定せず、空シリーズ全件と正 seriesId の 1/7 を巡回する方式へ変更した。
- 仮シリーズを毎時も実シリーズ候補と照合する D3b を追加し、候補が確認できれば日次を待たずに統合するようにした。

## 2026-07-15

### Fixed

- タイトル前方一致で別シーズンへ吸着しないよう、シーズン標識ガードを追加した。
- すでに正の seriesId を持つ各話も、確認済みの membership に基づいて別の正シリーズへ移動できるようにした。
