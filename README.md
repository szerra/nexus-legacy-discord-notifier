# Nexus Legacy 精準 Discord 通知與星系自動偵查

目前版本：`2.7.1`

## 安裝

[點此安裝 Tampermonkey 使用者腳本](https://raw.githubusercontent.com/szerra/nexus-legacy-discord-notifier/main/NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js)

安裝後開啟 [Nexus Legacy](https://nl.luulyuan.cc/)，腳本會沿用原本儲存在 Tampermonkey 的 Apps Script `/exec` 網址與 `NEXUS_PLUGIN_SECRET`。原始碼不包含上述密鑰、Discord Webhook 或遊戲登入資料。

## 功能

- 艦隊返航、建築完成、研究完成與造船完成後，經伺服器再次確認才通知 Discord。
- 顯示研究、建築與造船佇列的開始時間、所需時間及預計完成時間。
- 在星系與艦隊畫面補上海盜情報和快速定位。
- 在船塢卡片旁顯示目前擁有的艦船數量。
- 可手動選擇並啟用「礦＋氫偵查」或「海盜偵查」；兩種模式不會同時派船。

## 星系自動偵查

這項功能更新後預設關閉，必須在星系頁左下角手動啟用。

- 面板可切換「礦＋氫偵查」與「海盜偵查」；切換只影響之後的新任務，已派出的任務照常完成。
- 每輪先讀取伺服器回傳的艦隊上限及所有進行中任務，再計算空閒艦隊欄位。
- 同時派遣數取「所選模式的可用船數」與「空閒艦隊欄位」兩者較小值，不會超派。
- 每輪都從家園座標重新計算，嚴格由近到遠選擇目標，不使用循環游標。
- 氫氣不足或艦隊欄位已滿時不會強行派出。
- 啟用後，只要 Nexus Legacy 分頁仍在執行，切換到建築、研究或船塢頁也會繼續循環。

### 礦＋氫偵查

- 只使用遊戲允許的 `Probe`／`Spy Probe`，每個尚未偵查的礦場或氫氣田派 1 艘。
- 只處理 `ore` 與 `gas` 資源田，不會重複派往正在偵查的目標。

### 海盜偵查

- 只使用 `Stealth Ship`（隱形艦），每個星系每次派 1 艘。
- 只使用遊戲 `/api/fleet/survey-cooldowns` 回傳的可掃描星系。
- 冷卻中的星系不會派遣；冷卻結束後可再次掃描。
- 有存活海盜的星系會暫停掃描；海盜被消滅或清理完成後，該星系會重新加入循環。
- 正在執行系統掃描的星系不會重複派遣。

## Discord 設定

1. 在 Tampermonkey 選單執行「Nexus Discord：設定後端與密鑰」。
2. 輸入目前使用、以 `/exec` 結尾的 Apps Script Web App 網址。
3. 輸入與 Apps Script 指令碼屬性相同的 `NEXUS_PLUGIN_SECRET`。
4. 執行「Nexus Discord：傳送測試通知」。

Discord Webhook 只應保存在 Apps Script 的 `NEXUS_DISCORD_WEBHOOK_URL` 指令碼屬性，不要貼進使用者腳本。

## 檔案

- `NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js`：Tampermonkey 使用者腳本。
- `NexusLegacy_Discord_Addon_v2.0.0.gs`：Google Apps Script Discord 後端範例。
- `NexusLegacy_Discord_doPost_patch.txt`：把 Discord 路由整合進既有 Apps Script 專案時使用。
