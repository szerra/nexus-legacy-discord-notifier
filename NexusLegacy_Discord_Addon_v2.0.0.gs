/**
 * Nexus Legacy 精準 Discord 完成通知｜FishSnack Apps Script 外掛 v2.0.0
 *
 * 使用方式：
 * 1. 把本檔新增到既有 FishSnack LINE Apps Script 專案。
 * 2. 依 NexusLegacy_Discord_doPost_patch.txt 修改原 Code.gs 的 doPost(e)。
 * 3. 在「專案設定 → 指令碼屬性」設定 NEXUS_PLUGIN_SECRET。
 * 4. 在同處新增 NEXUS_DISCORD_WEBHOOK_URL，值為 Discord 頻道的 Webhook URL。
 * 5. 重新部署既有 Web App（沿用相同部署與 /exec URL）。
 *
 * Discord Webhook URL 只保存在 Apps Script 指令碼屬性，不會傳給瀏覽器端。
 */

const NEXUS_NOTIFY_KIND = 'nexus_legacy_verified_notification';
const NEXUS_SENT_STATE_KEY = 'NEXUS_SENT_EVENTS';
const NEXUS_SENT_KEEP_DAYS = 14;
const NEXUS_SENT_KEEP_COUNT = 120;

function handleNexusLegacyNotification_(payload) {
  const expectedSecret = String(
    PropertiesService.getScriptProperties().getProperty('NEXUS_PLUGIN_SECRET') || ''
  );
  const receivedSecret = String(payload && payload.secret || '');

  if (!expectedSecret) {
    return json_({ ok: false, error: 'nexus_secret_not_configured' });
  }
  if (!receivedSecret || receivedSecret !== expectedSecret) {
    safeWriteLog_('warn', 'nexus', 'NEXUS_PLUGIN_SECRET 不一致', '');
    return json_({ ok: false, error: 'bad_nexus_secret' });
  }

  const eventId = String(payload.eventId || '').trim();
  const category = String(payload.category || '').trim().toLowerCase();
  const title = cleanNexusText_(payload.title, 120);
  const message = cleanNexusText_(payload.message, 1500);
  const verifiedAt = asDate_(payload.verifiedAt);
  const deadlineAt = asDate_(payload.deadlineAt);

  if (!/^[A-Za-z0-9:_-]{8,180}$/.test(eventId)) {
    return json_({ ok: false, error: 'bad_event_id' });
  }
  if (['fleet', 'building', 'research', 'shipyard', 'test'].indexOf(category) < 0) {
    return json_({ ok: false, error: 'bad_category' });
  }
  if (!title || !message || !verifiedAt) {
    return json_({ ok: false, error: 'missing_verified_event_fields' });
  }

  const now = new Date();
  if (verifiedAt.getTime() > now.getTime() + 2 * 60 * 1000) {
    return json_({ ok: false, error: 'verified_at_in_future' });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const eventHash = nexusEventHash_(eventId);
    const sentState = loadNexusSentState_();
    if (sentState.some(function (item) { return item && item.h === eventHash; })) {
      return json_({ ok: true, duplicate: true, eventId: eventId });
    }

    const lines = [
      'Nexus Legacy 完成通知',
      '',
      '【' + title + '】',
      message
    ];
    if (deadlineAt) lines.push('原定完成：' + formatDate_(deadlineAt));
    lines.push('伺服器確認：' + formatDate_(verifiedAt));

    sendNexusDiscordWebhook_(lines.join('\n'));

    sentState.push({ h: eventHash, t: now.toISOString() });
    saveNexusSentState_(sentState);
    safeWriteLog_('info', 'nexus', 'Discord 完成通知已送出', JSON.stringify({
      category: category,
      eventHash: eventHash
    }));

    return json_({
      ok: true,
      duplicate: false,
      eventId: eventId,
      sentAt: now.toISOString()
    });
  } catch (err) {
    safeWriteLog_('error', 'nexus', 'Discord 完成通知失敗', stack_(err));
    return json_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {}
  }
}

function sendNexusDiscordWebhook_(content) {
  const webhookUrl = String(
    PropertiesService.getScriptProperties().getProperty('NEXUS_DISCORD_WEBHOOK_URL') || ''
  ).trim();

  if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(webhookUrl)) {
    throw new Error('NEXUS_DISCORD_WEBHOOK_URL 尚未設定或格式不正確');
  }

  const payload = JSON.stringify({
    username: 'Nexus Legacy 通知',
    content: cleanNexusText_(content, 2000),
    allowed_mentions: { parse: [] }
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = UrlFetchApp.fetch(webhookUrl + '?wait=true', {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status >= 200 && status < 300) return;

    if (status === 429 && attempt < 2) {
      let retrySeconds = 1;
      try {
        const body = JSON.parse(response.getContentText() || '{}');
        const parsed = Number(body.retry_after);
        if (Number.isFinite(parsed) && parsed > 0) retrySeconds = parsed;
      } catch (err) {}
      Utilities.sleep(Math.min(15000, Math.max(500, Math.ceil(retrySeconds * 1000) + 250)));
      continue;
    }

    throw new Error('Discord Webhook HTTP ' + status);
  }
}

function cleanNexusText_(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, Math.max(1, Number(maxLength) || 1));
}

function nexusEventHash_(eventId) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(eventId),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (value) {
    const unsigned = value < 0 ? value + 256 : value;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('').slice(0, 32);
}

function loadNexusSentState_() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(NEXUS_SENT_STATE_KEY) || '[]';
  let items = [];
  try {
    items = JSON.parse(raw);
  } catch (err) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];

  const cutoff = Date.now() - NEXUS_SENT_KEEP_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(function (item) {
    const time = item && Date.parse(item.t);
    return item && typeof item.h === 'string' && time && time >= cutoff;
  }).slice(-NEXUS_SENT_KEEP_COUNT);
}

function saveNexusSentState_(items) {
  PropertiesService.getScriptProperties().setProperty(
    NEXUS_SENT_STATE_KEY,
    JSON.stringify((Array.isArray(items) ? items : []).slice(-NEXUS_SENT_KEEP_COUNT))
  );
}
