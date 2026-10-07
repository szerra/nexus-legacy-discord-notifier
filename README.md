# Nexus Legacy 精準 Discord 通知與星系自動偵查

目前版本：`2.8.1`

## 安裝

[點此安裝 Tampermonkey 使用者腳本](https://raw.githubusercontent.com/szerra/nexus-legacy-discord-notifier/main/NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js)

安裝後可在 [原站](https://nl.luulyuan.cc/) 或 [RDP 站](http://rdp.luulyuan.cc:38212/) 使用。腳本會沿用原本儲存在 Tampermonkey 的 Apps Script `/exec` 網址與 `NEXUS_PLUGIN_SECRET`。原始碼不包含上述密鑰、Discord Webhook 或遊戲登入資料。

## 功能

- 艦隊返航、建築完成、研究完成與造船完成後，經伺服器再次確認才通知 Discord。
- 顯示研究、建築與造船佇列的開始時間、所需時間及預計完成時間。
- 在星系與艦隊畫面補上海盜情報和快速定位。
- 在船塢卡片旁顯示目前擁有的艦船數量。
- 可手動選擇並啟用「礦＋氫偵查」、「星系掃描（找海盜）」或「營地兵力偵查」；三種模式不會同時派船。

## 星系自動偵查

首次安裝預設關閉。更新會保留既有模式與啟用狀態；切換模式會先停止，必須在星系頁左下角重新啟用。新模式不會因更新而自行派船。

- 切換模式時停止新派遣；已派出的任務照常完成。請只在一個遊戲分頁啟用自動偵查，避免多分頁競爭相同艦隊空位。
- 每輪先讀取伺服器回傳的艦隊上限及所有進行中任務，再計算空閒艦隊欄位。
- 同時派遣數取「所選模式的可用船數」與「空閒艦隊欄位」兩者較小值，不會超派。
- 每輪都從家園座標重新計算，嚴格由近到遠選擇目標，不使用循環游標。
- 氫氣不足或艦隊欄位已滿時不會強行派出。
- 啟用後，只要 Nexus Legacy 分頁仍在執行，切換到建築、研究或船塢頁也會繼續循環。

### 礦＋氫偵查

- 只使用遊戲允許的 `Probe`／`Spy Probe`，每個尚未偵查的礦場或氫氣田派 1 艘。
- 只處理 `ore` 與 `gas` 資源田，不會重複派往正在偵查的目標。

### 星系掃描（找海盜，原「海盜偵查」）

- 只使用 `Stealth Ship`（隱形艦），每個星系每次派 1 艘。
- 只使用遊戲 `/api/fleet/survey-cooldowns` 回傳的可掃描星系。
- 冷卻中的星系不會派遣；冷卻結束後可再次掃描。
- 星系已有存活海盜仍可掃描；只要 CD 已到且伺服器回傳該星系可掃描，就會加入由近到遠的候選清單（2.8.1 移除海盜存在限制）。
- 正在執行系統掃描的星系不會重複派遣。

### 營地兵力偵查（2.8.0 新增）

- 對已出現的海盜營地偵查兵力，不是重新掃描星系。
- 只使用家園可用的 `Spy Probe`（間諜探測器）與 `Stealth Ship`（隱形艦），每營地 1 艘；不使用普通 `Probe`。兩種船依伺服器艦隊清單順序使用，不額外假定哪種較強。
- 每輪以家園座標由近到遠選擇營地；同星系有多個營地時按各自 `campId` 處理，不會整個星系一起跳過。
- 從即時 `/api/fleet/missions` 的 `cargo.campId` 排除偵查中的營地（包含返航中），也會避開手動派出的任務。
- 跳過完整兵力情報、已毀滅、清理中、已過期的營地。部分情報等任務完成後可再次偵查；營地恢復後是否需要新情報，以伺服器目前的 `hasFleetIntel` 為準。
- 派遣前做燃料預估；派遣後重新讀取可用船數、艦隊空位及營地情報。只呼叫 `/api/fleet/scout-camp`，不會攻擊營地。
- 燃料預估使用 `pirate_scout` 與 `targetSystemId`；真正派遣使用 `campId`，不可混用。
- 遊戲可能自動增加觀測艦伴航，插件不指定額外伴航船。偵查會消耗氫氣，也可能失敗或損失艦船。
- 派遣錯誤時停止自動偵查。逾時、斷線或 5xx 回應的營地保留派遣追蹤，不因等了幾秒就自動重送；看到該營地任務完成或情報更新才解除。若一直未確認，先查遊戲艦隊，不要重複按派遣。
- 不新增收藏、報告整理、標記已讀或刪除報告功能。

## 驗證

離線測試不連線、不派船：

```powershell
node --check NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js
node --test tests/nexus-auto-scout.test.cjs
```

Chrome 已核對現行營地偵查介面與前端 API 格式；測試涵蓋同星系多營地、船種限制、空位、情報篩選、停止／切換模式及不確定回應防重送。未以真實派遣驗證伺服器同星系多隊並行。

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
