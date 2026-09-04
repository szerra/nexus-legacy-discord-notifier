// ==UserScript==
// @name         Nexus Legacy 精準 Discord 完成通知
// @namespace    https://nl.luulyuan.cc/
// @version      2.7.1
// @description  追蹤艦隊、建築、研究與船艦製造完成時間，顯示海盜情報，並可切換自動偵查礦氫資源或海盜星系。
// @updateURL    https://raw.githubusercontent.com/szerra/nexus-legacy-discord-notifier/main/NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js
// @downloadURL  https://raw.githubusercontent.com/szerra/nexus-legacy-discord-notifier/main/NexusLegacy_Exact_Discord_Notifications_v2.0.0.user.js
// @match        https://nl.luulyuan.cc/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_NAME = 'Nexus Legacy 精準 Discord 完成通知';
  const SCRIPT_VERSION = '2.7.1';
  const DEFAULT_GAS_URL = '';
  const AUTH_STORAGE_KEY = 'galaxytest-auth';
  const ACTIVE_SYNC_MS = 30_000;
  const HIDDEN_SYNC_MS = 60_000;
  const VERIFY_GRACE_MS = 500;
  const MAX_TIMEOUT_MS = 2_147_000_000;

  const STORAGE = {
    // 保留 v1 的儲存鍵，讓原 LINE 版已設定的 /exec 與密鑰可直接沿用。
    gasUrl: 'nexus_line_gas_url_v1',
    secret: 'nexus_line_secret_v1',
    tasks: 'nexus_line_tasks_v1',
    pending: 'nexus_line_pending_v1',
    sent: 'nexus_line_sent_v1',
    // 使用新鍵，避免舊版礦氣偵查曾經啟用時，升級後立刻自行派船。
    autoScoutEnabled: 'nexus_auto_system_survey_enabled_v1',
    autoScoutMode: 'nexus_auto_scout_mode_v1'
  };

  const runtime = {
    tasks: loadMap(STORAGE.tasks),
    pending: loadMap(STORAGE.pending),
    sent: loadMap(STORAGE.sent),
    catalog: new Map(),
    serverOffsetMs: 0,
    lastServerNowIso: '',
    lastSyncAt: 0,
    lastError: '',
    waitingExact: 0,
    syncPromise: null,
    flushPromise: null,
    periodicTimer: 0,
    wakeTimer: 0,
    badge: null,
    queueTimeline: [],
    shipCatalog: new Map(),
    shipCountsByPlanet: {},
    shipCountsUpdatedAt: {},
    shipCountRefreshPromise: null,
    shipCountRefreshTimer: 0,
    shipCountLastAttemptAt: 0,
    panel: null,
    panelBody: null,
    pirateCamps: [],
    pirateObserver: null,
    pirateRenderTimer: 0,
    pirateNavigation: null,
    pirateNavigationSignature: '',
    autoScoutEnabled: Boolean(GM_getValue(STORAGE.autoScoutEnabled, false)),
    autoScoutMode: normalizedAutoScoutMode(GM_getValue(STORAGE.autoScoutMode, 'pirate')),
    autoScoutPanel: null,
    autoScoutStatusNode: null,
    autoScoutToggleButton: null,
    autoScoutModeSelect: null,
    autoScoutTimer: 0,
    autoScoutPromise: null,
    autoScoutPreviewTargets: [],
    autoScoutSnapshot: {
      maxFleetSlots: 0,
      usedFleetSlots: 0,
      dispatchCapacity: 0,
      availableResourceScouts: 0,
      availableStealthShips: 0,
      freeFleetSlots: 0,
      activeFieldScans: 0,
      readyFields: 0,
      activeSurveys: 0,
      readySystems: 0,
      coolingSystems: 0,
      pirateBlockedSystems: 0
    },
    autoScoutLastAction: '尚未執行',
    autoScoutLastError: ''
  };

  function loadMap(key) {
    try {
      const raw = GM_getValue(key, '{}');
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  }

  function saveMap(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function persistState() {
    pruneHistory();
    saveMap(STORAGE.tasks, runtime.tasks);
    saveMap(STORAGE.pending, runtime.pending);
    saveMap(STORAGE.sent, runtime.sent);
    renderBadge();
    renderQueuePanel();
    schedulePirateIntelRender();
  }

  function pruneHistory() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, value] of Object.entries(runtime.sent)) {
      if (!value || Number(value.sentAt || 0) < cutoff) delete runtime.sent[key];
    }
    for (const [key, value] of Object.entries(runtime.pending)) {
      if (!value || Date.parse(value.createdAt || 0) < cutoff) delete runtime.pending[key];
    }
  }

  function getPageAuth() {
    try {
      const raw = unsafeWindow.localStorage.getItem(AUTH_STORAGE_KEY);
      const parsed = JSON.parse(raw || '{}');
      const value = parsed && parsed.state && typeof parsed.state === 'object'
        ? parsed.state
        : parsed;
      const sessionToken = String(value && value.sessionToken || '');
      if (!sessionToken) return null;
      return {
        sessionToken,
        currentPlanetId: value.currentPlanetId == null ? null : value.currentPlanetId
      };
    } catch (_error) {
      return null;
    }
  }

  function extractServerNow(data) {
    return data && (
      data.serverNow ||
      (data.state && data.state.serverNow) ||
      (data.data && data.data.serverNow)
    );
  }

  function updateServerClock(data, requestStartedAt, responseReceivedAt) {
    const raw = extractServerNow(data);
    const parsed = Date.parse(raw || '');
    if (!Number.isFinite(parsed)) return;
    const midpoint = (requestStartedAt + responseReceivedAt) / 2;
    runtime.serverOffsetMs = parsed - midpoint;
    runtime.lastServerNowIso = new Date(parsed).toISOString();
  }

  function serverNowMs() {
    return Date.now() + runtime.serverOffsetMs;
  }

  function serverNowIso() {
    return new Date(serverNowMs()).toISOString();
  }

  async function apiJson(path) {
    const auth = getPageAuth();
    if (!auth) throw new Error('遊戲登入資料尚未就緒');

    const startedAt = Date.now();
    const response = await unsafeWindow.fetch(new URL(path, location.origin).href, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + auth.sessionToken
      },
      cache: 'no-store',
      credentials: 'omit'
    });
    const receivedAt = Date.now();

    if (!response.ok) {
      throw new Error('遊戲 API ' + response.status + '：' + path);
    }

    const data = await response.json();
    updateServerClock(data, startedAt, receivedAt);
    return data;
  }

  async function apiJsonRequest(path, options = {}) {
    const auth = getPageAuth();
    if (!auth) throw new Error('遊戲登入資料尚未就緒');

    const method = String(options.method || 'GET').toUpperCase();
    const startedAt = Date.now();
    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + auth.sessionToken
    };
    const request = {
      method,
      headers,
      cache: 'no-store',
      credentials: 'omit'
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }

    const response = await unsafeWindow.fetch(new URL(path, location.origin).href, request);
    const receivedAt = Date.now();
    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_error) {
          data = { message: text };
        }
      }
    }

    if (!response.ok) {
      const detail = String(
        data && (data.message || data.error || data.code) || ''
      ).trim();
      throw new Error(
        '遊戲 API ' + response.status + '：' + path + (detail ? '（' + detail + '）' : '')
      );
    }

    updateServerClock(data, startedAt, receivedAt);
    return data;
  }

  function arrayFrom(value) {
    return Array.isArray(value) ? value : [];
  }

  function apiArray(value, key) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value[key])) return value[key];
    const data = value && value.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data[key])) return data[key];
    return [];
  }

  function pirateShipName(ship) {
    const name = String(ship && ship.name || '').trim();
    if (name) return name;
    const key = String(ship && ship.key || '').trim();
    if (key) {
      return key
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
    const definitionId = ship && (ship.shipDefId || ship.definitionId || ship.id);
    return definitionId == null ? '未知船種' : '船種 #' + definitionId;
  }

  function pirateCampComposition(camp) {
    if (!camp || camp.hasFleetIntel !== true) return [];
    const source = arrayFrom(camp.fleetIntel).length
      ? arrayFrom(camp.fleetIntel)
      : arrayFrom(camp.fleetComposition);
    const grouped = new Map();
    for (const ship of source) {
      const quantity = Math.max(
        0,
        Math.floor(Number(ship && ship.quantity) || 0) +
          Math.floor(Number(ship && ship.damagedQuantity) || 0)
      );
      if (!quantity) continue;
      const name = pirateShipName(ship);
      grouped.set(name, Number(grouped.get(name) || 0) + quantity);
    }
    return [...grouped.entries()].map(([name, quantity]) => ({ name, quantity }));
  }

  function pirateCampPlanetName(camp) {
    return String(camp && (
      camp.planetName ||
      camp.targetPlanetName ||
      camp.locationName
    ) || '').trim();
  }

  function renderPirateIntelOnGalaxy() {
    if (!document.body) return;
    const onGalaxy = location.pathname === '/galaxy' || location.pathname.startsWith('/galaxy/');
    if (!onGalaxy) {
      for (const node of document.querySelectorAll('.nexus-pirate-fleet-composition')) node.remove();
      return;
    }

    const campsByPlanetName = new Map();
    for (const camp of runtime.pirateCamps) {
      if (!camp || camp.destroyedAt || camp.cleanupInProgress === true) continue;
      const planetName = pirateCampPlanetName(camp);
      const composition = pirateCampComposition(camp);
      if (planetName && composition.length && !campsByPlanetName.has(planetName)) {
        campsByPlanetName.set(planetName, { camp, composition });
      }
    }

    for (const card of document.querySelectorAll('.planet-card')) {
      const nameNode = card.querySelector('.planet-card-name > span:not(.planet-moon-count)');
      const planetName = String(nameNode && nameNode.textContent || '').trim();
      const summary = card.querySelector('.pirate-camp-summary');
      const existing = card.querySelector('.nexus-pirate-fleet-composition');
      const match = campsByPlanetName.get(planetName);
      if (!summary || !match) {
        if (existing) existing.remove();
        continue;
      }

      const compositionText = match.composition
        .map((ship) => ship.name + ' ×' + ship.quantity.toLocaleString('zh-TW'))
        .join(' · ');
      const text = '已偵查艦隊：' + compositionText;
      let badge = existing;
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'nexus-pirate-fleet-composition';
        applyStyles(badge, {
          marginTop: '6px',
          padding: '6px 8px',
          border: '1px solid rgba(245, 158, 11, .42)',
          borderLeft: '3px solid #f59e0b',
          borderRadius: '7px',
          background: 'rgba(73, 43, 9, .32)',
          color: '#ffd58d',
          fontSize: '12px',
          fontWeight: '700',
          lineHeight: '1.45'
        });
        summary.insertAdjacentElement('afterend', badge);
      }
      if (badge.dataset.composition !== text) {
        badge.dataset.composition = text;
        badge.textContent = text;
      }
    }
  }

  function pirateScoutReportTarget(card) {
    const campName = String(
      card && card.querySelector('.mission-header > strong')?.textContent || ''
    ).trim();
    let systemName = '';
    for (const strong of card ? card.querySelectorAll('.mission-details strong') : []) {
      const value = String(strong.textContent || '').trim();
      if (/^Z\d+-\d+$/i.test(value)) {
        systemName = value;
        break;
      }
    }
    if (!systemName) {
      const match = campName.match(/^(Z\d+-\d+)/i);
      systemName = match ? match[1] : '';
    }
    return campName && systemName ? { campName, systemName } : null;
  }

  function pirateCampGalaxyUrl(target) {
    const url = new URL('/galaxy', location.origin);
    url.searchParams.set('nexusPirateSystem', target.systemName);
    url.searchParams.set('nexusPirateCamp', target.campName);
    return url.href;
  }

  function openPirateCampOnGalaxy(target) {
    unsafeWindow.location.href = pirateCampGalaxyUrl(target);
  }

  function renderPirateScoutReportShortcuts() {
    if (location.pathname !== '/fleet') return;
    for (const card of document.querySelectorAll('.pirate-scout-report')) {
      const target = pirateScoutReportTarget(card);
      if (!target) continue;

      if (card.dataset.nexusPirateShortcut !== 'ready') {
        card.dataset.nexusPirateShortcut = 'ready';
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        card.title = '點擊後前往星系並定位這座海盜營地';
        card.style.cursor = 'pointer';
        card.addEventListener('click', (event) => {
          if (
            event.target &&
            typeof event.target.closest === 'function' &&
            event.target.closest('a, button, input, select, textarea')
          ) return;
          const selection = unsafeWindow.getSelection && String(unsafeWindow.getSelection() || '');
          if (selection) return;
          openPirateCampOnGalaxy(target);
        });
        card.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openPirateCampOnGalaxy(target);
        });
      }

      if (!card.querySelector('.nexus-pirate-report-locate')) {
        const link = document.createElement('a');
        link.className = 'nexus-pirate-report-locate';
        link.href = pirateCampGalaxyUrl(target);
        link.textContent = '在星系定位';
        link.title = '前往 ' + target.systemName + ' 並定位 ' + target.campName;
        applyStyles(link, {
          display: 'inline-block',
          marginTop: '9px',
          padding: '6px 10px',
          border: '1px solid rgba(56, 189, 248, .58)',
          borderRadius: '7px',
          background: 'rgba(14, 116, 144, .2)',
          color: '#9de8ff',
          fontSize: '12px',
          fontWeight: '800',
          cursor: 'pointer',
          textDecoration: 'none'
        });
        card.appendChild(link);
      }
    }
  }

  function getPirateNavigationRequest() {
    const params = new URLSearchParams(location.search);
    const systemName = String(params.get('nexusPirateSystem') || '').trim();
    const campName = String(params.get('nexusPirateCamp') || '').trim();
    const signature = location.pathname + '|' + systemName + '|' + campName;
    if (location.pathname !== '/galaxy' || !systemName || !campName) {
      if (runtime.pirateNavigationSignature !== signature) {
        runtime.pirateNavigationSignature = signature;
        runtime.pirateNavigation = null;
      }
      return null;
    }
    if (
      runtime.pirateNavigationSignature === signature &&
      runtime.pirateNavigation
    ) return runtime.pirateNavigation;
    runtime.pirateNavigationSignature = signature;
    runtime.pirateNavigation = {
      systemName,
      campName,
      startedAt: Date.now(),
      searchDispatchedAt: 0,
      systemClicked: false,
      systemClickAt: 0,
      completedAt: 0,
      recoveryAttempts: 0,
      completed: false
    };
    return runtime.pirateNavigation;
  }

  function setGalaxySearchValue(input, value) {
    const prototype = unsafeWindow.HTMLInputElement && unsafeWindow.HTMLInputElement.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new unsafeWindow.Event('input', { bubbles: true }));
    input.dispatchEvent(new unsafeWindow.Event('change', { bubbles: true }));
  }

  function normalizedGalaxySystemName(value) {
    const text = String(value || '').trim();
    const match = text.match(/^Z(\d+)-(\d+)$/i);
    if (!match) return text.toUpperCase();
    return 'Z' + Number(match[1]) + '-' + Number(match[2]);
  }

  function activateGalaxySearchResult(button) {
    const pageDocument = unsafeWindow.document || document;
    const pageButton = [...pageDocument.querySelectorAll('button')].find((candidate) => {
      const text = String(candidate.textContent || '').replace(/\s+/g, ' ').trim();
      const buttonText = String(button.textContent || '').replace(/\s+/g, ' ').trim();
      return text === buttonText;
    }) || button;
    const reactPropsKey = Object.keys(pageButton).find((key) =>
      key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')
    );
    const onClick = reactPropsKey && pageButton[reactPropsKey] && pageButton[reactPropsKey].onClick;
    if (typeof onClick === 'function') {
      onClick();
      return true;
    }
    pageButton.click();
    return false;
  }

  function advancePirateGalaxyNavigation() {
    const request = getPirateNavigationRequest();
    if (document.documentElement) {
      document.documentElement.dataset.nexusPirateNavigation = request
        ? JSON.stringify({
            version: SCRIPT_VERSION,
            systemName: request.systemName,
            campName: request.campName,
            systemClicked: request.systemClicked,
            recoveryAttempts: request.recoveryAttempts,
            completed: request.completed
          })
        : JSON.stringify({ version: SCRIPT_VERSION, active: false });
    }
    if (!request || (!request.completed && Date.now() - request.startedAt > 30_000)) return;

    const requestedSystemKey = normalizedGalaxySystemName(request.systemName);
    const planetCards = [...document.querySelectorAll('.planet-card')];
    const currentSystemLoaded = planetCards.some((card) => {
      const name = String(
        card.querySelector('.planet-card-name > span:not(.planet-moon-count)')?.textContent || ''
      ).trim();
      return normalizedGalaxySystemName(name.replace(/-P\d+$/i, '')) === requestedSystemKey;
    });

    if (!currentSystemLoaded) {
      const now = Date.now();
      if (request.completed) {
        const recentlyOverwritten = now - request.completedAt < 12_000;
        if (!recentlyOverwritten || request.recoveryAttempts >= 1) return;
        request.completed = false;
        request.systemClicked = false;
        request.systemClickAt = 0;
        request.recoveryAttempts += 1;
        // 家園初始化已完成，可立即重試，不必再等待冷啟動緩衝。
        request.startedAt = now - 3_000;
      }
      // 冷啟動時遊戲會稍後恢復家園星系；先等它穩定再選擇報告目標。
      if (!request.systemClicked && request.recoveryAttempts === 0 && now - request.startedAt < 2_500) {
        setTimeout(schedulePirateIntelRender, 350);
        return;
      }
      const waitingForSystem = request.systemClicked && now - request.systemClickAt < 3_500;
      const searchInput = [...document.querySelectorAll('input')].find((input) => {
        const placeholder = String(input.placeholder || '').toLowerCase();
        return placeholder.includes('搜索系统') || placeholder.includes('search system');
      });
      if (
        !waitingForSystem &&
        searchInput &&
        (searchInput.value !== request.systemName || now - request.searchDispatchedAt > 1_200)
      ) {
        setGalaxySearchValue(searchInput, request.systemName);
        request.searchDispatchedAt = now;
      }

      const systemButton = [...document.querySelectorAll('button')].find((button) => {
        const text = String(button.textContent || '').replace(/\s+/g, ' ').trim();
        return text.startsWith(request.systemName) &&
          !text.startsWith(request.systemName + '-P') &&
          (text.includes('Arm') || text.includes('星区') || text.includes('星區'));
      });
      if (systemButton && (!request.systemClicked || now - request.systemClickAt >= 3_500)) {
        request.systemClicked = true;
        request.systemClickAt = now;
        activateGalaxySearchResult(systemButton);
      }
      setTimeout(schedulePirateIntelRender, 450);
      return;
    }

    const normalizeCampName = (value) => String(value || '')
      .replace(/\s+/g, '')
      .replace(/號/g, '号')
      .trim();
    const requestedCampName = normalizeCampName(request.campName);
    const camp = runtime.pirateCamps.find((item) => {
      if (!item || item.destroyedAt) return false;
      const sameCamp = normalizeCampName(item.name || item.campName) === requestedCampName;
      const sameSystem = !item.systemName ||
        normalizedGalaxySystemName(item.systemName) === requestedSystemKey;
      return sameCamp && sameSystem;
    });
    const planetName = pirateCampPlanetName(camp);
    let targetCard = planetCards.find((card) => {
      const name = String(
        card.querySelector('.planet-card-name > span:not(.planet-moon-count)')?.textContent || ''
      ).trim();
      return planetName && name === planetName;
    });

    // 部分伺服器版本的營地 API 名稱欄位會與偵查報告不同；
    // 此時以目前星系中已偵查的海盜行星卡作為可靠備援。
    if (!targetCard) {
      const pirateCards = planetCards.filter((card) => card.querySelector('.pirate-camp-summary'));
      const scoutedPirateCards = pirateCards.filter((card) =>
        card.querySelector('.nexus-pirate-fleet-composition')
      );
      if (scoutedPirateCards.length === 1) {
        targetCard = scoutedPirateCards[0];
      } else if (pirateCards.length === 1) {
        targetCard = pirateCards[0];
      } else {
        const ordinalMatch = request.campName.match(/(\d+)\s*[號号]\s*海盜營地/i);
        const ordinal = ordinalMatch ? Number(ordinalMatch[1]) : 0;
        if (ordinal > 0 && ordinal <= pirateCards.length) targetCard = pirateCards[ordinal - 1];
      }
    }
    if (!targetCard) {
      setTimeout(schedulePirateIntelRender, 450);
      return;
    }

    if (!request.completed) request.completedAt = Date.now();
    request.completed = true;
    targetCard.classList.add('nexus-pirate-target-card');
    targetCard.style.outline = '2px solid #38bdf8';
    targetCard.style.boxShadow = '0 0 0 4px rgba(56, 189, 248, .16), 0 0 24px rgba(56, 189, 248, .28)';
    if (!targetCard.querySelector('.nexus-pirate-location-marker')) {
      const marker = document.createElement('div');
      marker.className = 'nexus-pirate-location-marker';
      marker.textContent = '已從偵查報告定位到這裡';
      applyStyles(marker, {
        margin: '7px 0',
        padding: '5px 8px',
        borderRadius: '6px',
        background: 'rgba(14, 116, 144, .28)',
        color: '#9de8ff',
        fontSize: '12px',
        fontWeight: '800'
      });
      const header = targetCard.querySelector('.planet-card-header');
      if (header) header.insertAdjacentElement('afterend', marker);
      else targetCard.prepend(marker);
    }
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function normalizeShipyardShipKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  function shipyardShipKeyFromLink(link) {
    try {
      const url = new URL(link.getAttribute('href') || '', location.origin);
      const match = url.pathname.match(/^\/shipyard\/([^/]+)\/?$/i);
      return match ? normalizeShipyardShipKey(decodeURIComponent(match[1])) : '';
    } catch (_error) {
      return '';
    }
  }

  function nativeShipyardOwnedCounts() {
    const counts = new Map();
    const totalNodes = document.querySelectorAll(
      '[aria-label*="總計"][aria-label*="艘"],' +
      '[aria-label*="总计"][aria-label*="艘"],' +
      '[title*="總計"][title*="艘"],' +
      '[title*="总计"][title*="艘"]'
    );

    for (const totalNode of totalNodes) {
      const label = String(
        totalNode.getAttribute('aria-label') ||
        totalNode.getAttribute('title') ||
        ''
      );
      const totalMatch = label.match(/(?:總計|总计)\s*([\d,]+)\s*艘/i);
      if (!totalMatch) continue;

      let card = totalNode;
      let shipImage = null;
      for (let depth = 0; card && depth < 10; depth += 1, card = card.parentElement) {
        const images = [...card.querySelectorAll('img[alt]')]
          .filter((image) => normalizeShipyardShipKey(image.getAttribute('alt')));
        if (images.length === 1) {
          shipImage = images[0];
          break;
        }
      }
      if (!card || !shipImage) continue;

      const key = normalizeShipyardShipKey(shipImage.getAttribute('alt'));
      if (!key) continue;

      const nativeTotal = Math.max(0, Number(totalMatch[1].replace(/,/g, '')) || 0);
      const availableMatch = label.match(/(?:可派遣)\s*([\d,]+)/i);
      const damagedMatch = String(card.textContent || '')
        .match(/(?:損壞|损坏)\s*([\d,]+)/i);
      const available = availableMatch
        ? Math.max(0, Number(availableMatch[1].replace(/,/g, '')) || 0)
        : 0;
      const damaged = damagedMatch
        ? Math.max(0, Number(damagedMatch[1].replace(/,/g, '')) || 0)
        : 0;
      const owned = Math.max(nativeTotal, available + damaged);
      if (owned > 0) counts.set(key, owned);
    }

    return counts;
  }

  function indexShipCatalog(catalogData) {
    const list = Array.isArray(catalogData)
      ? catalogData
      : arrayFrom(catalogData && (catalogData.ships || catalogData.data));
    if (!list.length) return;
    runtime.shipCatalog.clear();
    for (const item of list) {
      const id = item && (item.id || item.definitionId);
      if (id != null) runtime.shipCatalog.set(String(id), item);
    }
  }

  function fleetEntryShipKey(entry) {
    const definition = entry && entry.definition;
    const definitionId = entry && (
      entry.shipDefId ||
      entry.definitionId ||
      (definition && definition.id)
    );
    const catalog = definitionId == null
      ? null
      : runtime.shipCatalog.get(String(definitionId));
    return normalizeShipyardShipKey(entry && (
      entry.shipKey ||
      entry.key ||
      (definition && definition.key) ||
      (entry.ship && entry.ship.key) ||
      (catalog && catalog.key)
    ));
  }

  function apiShipyardOwnedCounts(fleetData) {
    const counts = new Map();
    for (const entry of planetFleetEntries(fleetData)) {
      const shipKey = fleetEntryShipKey(entry);
      if (!shipKey) continue;
      const damaged = Math.max(0, Math.floor(Number(entry.damagedQuantity) || 0));
      const available = Math.max(0, Math.floor(Number(entry.availableQuantity) || 0));
      const owned = entry.quantity == null
        ? available + damaged
        : Math.max(0, Math.floor(Number(entry.quantity) || 0));
      if (owned > 0) {
        counts.set(shipKey, Number(counts.get(shipKey) || 0) + owned);
      }
    }
    return counts;
  }

  function indexShipyardOwnedCounts(planetId, fleetData) {
    const key = String(planetId == null ? '' : planetId);
    if (!key) return;
    runtime.shipCountsByPlanet[key] = Object.fromEntries(apiShipyardOwnedCounts(fleetData));
    runtime.shipCountsUpdatedAt[key] = Date.now();
  }

  function currentShipyardPlanetId() {
    const auth = getPageAuth();
    return auth && auth.currentPlanetId != null ? String(auth.currentPlanetId) : '';
  }

  function refreshCurrentShipyardOwnedCounts() {
    if (location.pathname !== '/shipyard' || runtime.shipCountRefreshPromise) {
      return runtime.shipCountRefreshPromise;
    }
    const planetId = currentShipyardPlanetId();
    if (!planetId) return null;
    runtime.shipCountLastAttemptAt = Date.now();
    runtime.shipCountRefreshPromise = apiJson(
      '/api/planets/' + encodeURIComponent(planetId) + '/fleet'
    ).then((fleetData) => {
      indexShipyardOwnedCounts(planetId, fleetData);
      renderOwnedFleetOnShipyard();
    }).catch((error) => {
      console.warn('[' + SCRIPT_NAME + '] 艦隊數量 API 讀取失敗，暫用頁面資料', error);
    }).finally(() => {
      runtime.shipCountRefreshPromise = null;
    });
    return runtime.shipCountRefreshPromise;
  }

  function scheduleCurrentShipyardOwnedCountsRefresh() {
    if (location.pathname !== '/shipyard' || runtime.shipCountRefreshTimer) return;
    const elapsed = Date.now() - runtime.shipCountLastAttemptAt;
    const delay = Math.max(80, 15_000 - elapsed);
    runtime.shipCountRefreshTimer = setTimeout(() => {
      runtime.shipCountRefreshTimer = 0;
      refreshCurrentShipyardOwnedCounts();
    }, delay);
  }

  function renderOwnedFleetOnShipyard() {
    const badgeSelector = '.nexus-ship-owned-count';
    if (location.pathname !== '/shipyard') {
      for (const badge of document.querySelectorAll(badgeSelector)) badge.remove();
      return;
    }

    const planetId = currentShipyardPlanetId();
    const apiCounts = planetId && runtime.shipCountsByPlanet[planetId];
    const counts = apiCounts
      ? new Map(Object.entries(apiCounts))
      : nativeShipyardOwnedCounts();
    const source = apiCounts ? 'api' : 'native-dom-fallback';
    const apiAge = planetId
      ? Date.now() - Number(runtime.shipCountsUpdatedAt[planetId] || 0)
      : Number.POSITIVE_INFINITY;
    if (!apiCounts || apiAge >= 15_000) scheduleCurrentShipyardOwnedCountsRefresh();

    const activeBadges = new Set();
    for (const link of document.querySelectorAll('main a[href^="/shipyard/"]')) {
      const shipKey = shipyardShipKeyFromLink(link);
      const heading = link.closest('h1, h2, h3, h4, h5, h6');
      if (!shipKey || !heading) continue;

      const owned = Math.max(0, Math.floor(Number(counts.get(shipKey)) || 0));
      let badge = heading.querySelector(badgeSelector);
      if (!owned) {
        if (badge) badge.remove();
        continue;
      }

      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nexus-ship-owned-count';
        applyStyles(badge, {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: '22px',
          marginLeft: '7px',
          padding: '1px 7px',
          border: '1px solid rgba(96, 165, 250, .52)',
          borderRadius: '999px',
          background: 'rgba(30, 64, 175, .2)',
          color: '#bfdbfe',
          fontSize: '12px',
          fontWeight: '800',
          lineHeight: '1.45',
          verticalAlign: 'middle'
        });
        link.insertAdjacentElement('afterend', badge);
      }

      const countText = owned.toLocaleString('zh-TW');
      if (badge.dataset.ownedCount !== String(owned)) {
        badge.dataset.ownedCount = String(owned);
        badge.dataset.shipKey = shipKey;
        badge.textContent = countText;
        badge.title = '目前擁有 ' + countText + ' 艘（包含外派與損壞）';
        badge.setAttribute('aria-label', badge.title);
      }
      activeBadges.add(badge);
    }

    for (const badge of document.querySelectorAll(badgeSelector)) {
      if (!activeBadges.has(badge)) badge.remove();
    }

    if (document.documentElement) {
      const snapshot = JSON.stringify(Object.fromEntries(counts));
      if (document.documentElement.dataset.nexusShipOwnedCounts !== snapshot) {
        document.documentElement.dataset.nexusShipOwnedCounts = snapshot;
      }
      document.documentElement.dataset.nexusShipOwnedCountsSource = source;
    }
  }

  function renderPirateFeatures() {
    renderPirateIntelOnGalaxy();
    renderPirateScoutReportShortcuts();
    advancePirateGalaxyNavigation();
    renderOwnedFleetOnShipyard();
  }

  function schedulePirateIntelRender() {
    clearTimeout(runtime.pirateRenderTimer);
    runtime.pirateRenderTimer = setTimeout(() => {
      runtime.pirateRenderTimer = 0;
      renderPirateFeatures();
    }, 60);
  }

  function ensurePirateIntelObserver() {
    if (!document.body || runtime.pirateObserver) return;
    runtime.pirateObserver = new MutationObserver(() => schedulePirateIntelRender());
    runtime.pirateObserver.observe(document.body, { childList: true, subtree: true });
    schedulePirateIntelRender();
  }

  function sameId(left, right) {
    return String(left == null ? '' : left) === String(right == null ? '' : right);
  }

  function validDeadline(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }

  function isDoneStatus(value) {
    const status = String(value || '').toLowerCase();
    return ['completed', 'complete', 'done', 'finished', 'arrived', 'returned']
      .some((word) => status.includes(word));
  }

  function isActiveStatus(value) {
    const status = String(value || '').toLowerCase();
    if (!status) return true;
    return !['cancelled', 'canceled', 'failed', 'aborted'].some((word) => status.includes(word));
  }

  function currentLevel(entry) {
    const candidates = [
      entry && entry.level,
      entry && entry.currentLevel,
      entry && entry.completedLevel,
      entry && entry.researchedLevel
    ];
    for (const value of candidates) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function gameDurationSeconds(value) {
    const seconds = Math.ceil(Number(value) || 0);
    return Math.max(1, Math.min(24 * 60 * 60, seconds));
  }

  function durationBetween(startAt, endAt) {
    const start = Date.parse(startAt || '');
    const end = Date.parse(endAt || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.max(1, Math.round((end - start) / 1000));
  }

  function isoFromMs(value) {
    return Number.isFinite(value) ? new Date(value).toISOString() : '';
  }

  function formatDuration(value) {
    const total = Math.max(0, Math.round(Number(value) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const seconds = total % 60;
    const parts = [];
    if (days) parts.push(days + '天');
    if (hours || days) parts.push(hours + '時');
    if (minutes || hours || days) parts.push(minutes + '分');
    parts.push(seconds + '秒');
    return parts.join('');
  }

  function formatQueueDate(value) {
    const parsed = Date.parse(value || '');
    if (!Number.isFinite(parsed)) return '等待前項開始';
    return new Date(parsed).toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function pendingBuildingDurationSeconds(planetData, building) {
    if (!planetData || !building) return 0;
    if (building.queueKind && building.queueKind !== 'build') return 0;
    const definition = runtime.catalog.get(String(building.definitionId));
    const targetLevel = Number(building.queueTargetLevel);
    if (!definition || !Number.isFinite(targetLevel) || targetLevel <= 0) return 0;

    const baseBuildTime = Number(definition.baseBuildTime);
    const buildTimeFactor = Number(definition.buildTimeFactor);
    if (!(baseBuildTime > 0) || !(buildTimeFactor > 0)) return 0;

    const baseSeconds = Math.max(
      1,
      Math.floor(baseBuildTime * Math.pow(buildTimeFactor, Math.max(0, targetLevel - 1)))
    );
    const buildSpeedMult = Number(planetData.buildSpeedMult);
    const upgradeSpeedMult = Number(planetData.buildingUpgradeSpeedMultiplier);
    return gameDurationSeconds(
      baseSeconds * (buildSpeedMult > 0 ? buildSpeedMult : 1) /
      (upgradeSpeedMult > 0 ? upgradeSpeedMult : 1)
    );
  }

  function queueStatusLabel(value) {
    const status = String(value || '').toLowerCase();
    if (status === 'in_progress' || status === 'active') return '進行中';
    if (status === 'paused') return '已暫停';
    return '排隊中';
  }

  function sortByQueueId(left, right) {
    return Number(left && (left.queueId || left.id) || 0) -
      Number(right && (right.queueId || right.id) || 0);
  }

  function expandBuildingQueueEntries(buildings) {
    return arrayFrom(buildings)
      .filter((entry) =>
        entry &&
        entry.queueId != null &&
        entry.queueKind !== 'repair' &&
        (entry.isUpgrading || String(entry.queueStatus || '').toLowerCase() === 'pending')
      )
      .sort((left, right) => {
        if (Boolean(left.isUpgrading) !== Boolean(right.isUpgrading)) {
          return left.isUpgrading ? -1 : 1;
        }
        return sortByQueueId(left, right);
      })
      .flatMap((entry) => {
        const current = Number(entry.level || 0);
        const target = Number(entry.queueTargetLevel || current + 1);
        if (
          entry.queueKind !== 'build' ||
          !Number.isFinite(target) ||
          target <= current + 1
        ) {
          return [entry];
        }

        return Array.from({ length: target - current }, (_, index) => {
          const targetLevel = current + index + 1;
          const isCurrentStage = index === 0 && Boolean(entry.isUpgrading);
          return {
            ...entry,
            sourceQueueId: entry.queueId,
            queueId: String(entry.queueId) + ':' + targetLevel,
            queueTargetLevel: targetLevel,
            queueStatus: isCurrentStage ? 'in_progress' : 'pending',
            isUpgrading: isCurrentStage,
            upgradeStartedAt: isCurrentStage ? entry.upgradeStartedAt || null : null,
            upgradeEndsAt: isCurrentStage ? entry.upgradeEndsAt || null : null
          };
        });
      });
  }

  function shipyardDataRoot(data) {
    if (!data || typeof data !== 'object') return {};
    const nested = data.data;
    if (
      nested &&
      typeof nested === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(nested, 'planetaryQueue') ||
        Object.prototype.hasOwnProperty.call(nested, 'planetaryQueueAll') ||
        Object.prototype.hasOwnProperty.call(nested, 'orbitalQueue') ||
        Object.prototype.hasOwnProperty.call(nested, 'orbitalQueueAll')
      )
    ) {
      return nested;
    }
    return data;
  }

  function shipyardQueueEntries(data) {
    const root = shipyardDataRoot(data);
    const entries = [
      ...arrayFrom(root.planetaryQueueAll),
      ...arrayFrom(root.orbitalQueueAll)
    ];
    for (const single of [root.planetaryQueue, root.orbitalQueue]) {
      if (single && !entries.some((entry) => sameId(entry && entry.id, single.id))) {
        entries.push(single);
      }
    }
    const seen = new Set();
    return entries
      .filter((entry) => {
        if (!entry) return false;
        const key = String(
          entry.id == null
            ? [entry.queueType, entry.shipDefId, entry.startedAt, entry.endsAt].join(':')
            : entry.id
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => {
        const leftEnd = Date.parse(left && left.endsAt || '');
        const rightEnd = Date.parse(right && right.endsAt || '');
        return (
          (Number.isFinite(leftEnd) ? leftEnd : Number.MAX_SAFE_INTEGER) -
            (Number.isFinite(rightEnd) ? rightEnd : Number.MAX_SAFE_INTEGER) ||
          String(left && left.queueType || '').localeCompare(String(right && right.queueType || '')) ||
          Number(left && left.id || 0) - Number(right && right.id || 0)
        );
      });
  }

  function isShipBuildQueue(entry) {
    if (!entry || entry.isRepair === true) return false;
    const operation = String(entry.operation || 'build').toLowerCase();
    return operation === 'build';
  }

  function shipyardShipName(entry) {
    const name = String(entry && (entry.shipName || entry.name) || '').trim();
    if (name) return name;
    const key = String(entry && entry.shipKey || '').trim();
    if (key) {
      return key
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
    const definitionId = entry && (entry.shipDefId || entry.definitionId);
    return definitionId == null ? '未知船艦' : '船艦 #' + definitionId;
  }

  function planetFleetEntries(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.fleet)) return data.fleet;
    if (data.data && Array.isArray(data.data.fleet)) return data.data.fleet;
    return [];
  }

  function fleetQuantityForShip(data, definitionId) {
    return planetFleetEntries(data).reduce((total, entry) => {
      const entryDefinitionId = entry && (
        entry.shipDefId ||
        entry.definitionId ||
        (entry.definition && entry.definition.id)
      );
      if (!sameId(entryDefinitionId, definitionId)) return total;
      return total +
        Math.max(0, Math.floor(Number(entry.quantity) || 0)) +
        Math.max(0, Math.floor(Number(entry.damagedQuantity) || 0));
    }, 0);
  }

  function buildQueueTimeline(planets, snapshots) {
    const timeline = [];

    for (const planet of planets) {
      const planetId = String(planet.id);
      const planetName = String(planet.name || '未知星球');
      const planetData = snapshots.planets[planetId];
      const researchData = snapshots.research[planetId];

      if (planetData) {
        const queue = expandBuildingQueueEntries(planetData.buildings);
        let cursorMs = null;

        for (let index = 0; index < queue.length; index += 1) {
          const entry = queue[index];
          const status = String(entry.queueStatus || '').toLowerCase();
          const exactStartAt = validDeadline(entry.upgradeStartedAt);
          const exactEndAt = validDeadline(entry.upgradeEndsAt);
          let durationSeconds = durationBetween(exactStartAt, exactEndAt);
          if (!durationSeconds) durationSeconds = pendingBuildingDurationSeconds(planetData, entry);

          let startsAt = exactStartAt;
          let endsAt = exactEndAt;
          let timeKind = exactEndAt ? 'exact' : 'waiting';
          if (!exactEndAt && status === 'pending' && Number.isFinite(cursorMs) && durationSeconds > 0) {
            startsAt = isoFromMs(cursorMs);
            endsAt = isoFromMs(cursorMs + durationSeconds * 1000);
            timeKind = 'estimated';
          }
          if (exactEndAt) cursorMs = Date.parse(exactEndAt);
          else if (endsAt) cursorMs = Date.parse(endsAt);

          const definition = runtime.catalog.get(String(entry.definitionId)) || {};
          timeline.push({
            key: 'timeline:building:' + planetId + ':' + entry.queueId,
            type: 'building',
            order: index + 1,
            planetId,
            planetName,
            id: String(entry.queueId),
            definitionId: String(entry.definitionId),
            name: String(definition.name || entry.name || ('建築 #' + entry.definitionId)),
            targetLevel: Number(entry.queueTargetLevel || Number(entry.level || 0) + 1),
            status,
            statusLabel: queueStatusLabel(status),
            durationSeconds,
            startsAt,
            endsAt,
            timeKind
          });
        }
      }

      if (researchData) {
        const queue = getActiveResearchEntries(researchData).sort(sortByQueueId);
        let cursorMs = null;

        for (let index = 0; index < queue.length; index += 1) {
          const entry = queue[index];
          const status = String(entry.queueStatus || entry.status || '').toLowerCase();
          const exactStartAt = validDeadline(entry.startsAt);
          const exactEndAt = validDeadline(entry.endsAt);
          let durationSeconds = Math.max(0, Math.round(Number(entry.durationSeconds) || 0));
          if (!durationSeconds) durationSeconds = durationBetween(exactStartAt, exactEndAt);

          let startsAt = exactStartAt;
          let endsAt = exactEndAt;
          let timeKind = exactEndAt ? 'exact' : 'waiting';
          if (!exactEndAt && status.includes('pending') && Number.isFinite(cursorMs) && durationSeconds > 0) {
            startsAt = isoFromMs(cursorMs);
            endsAt = isoFromMs(cursorMs + durationSeconds * 1000);
            timeKind = 'estimated';
          }
          if (exactEndAt) cursorMs = Date.parse(exactEndAt);
          else if (endsAt) cursorMs = Date.parse(endsAt);

          timeline.push({
            key: 'timeline:research:' + planetId + ':' + researchJobId(entry),
            type: 'research',
            order: index + 1,
            planetId,
            planetName,
            id: String(researchJobId(entry)),
            definitionId: String(researchDefinitionId(entry)),
            name: String(entry.name || entry.key || ('研究 #' + researchDefinitionId(entry))),
            targetLevel: Number(entry.targetLevel || Number(entry.level || 0) + 1),
            status,
            statusLabel: queueStatusLabel(status),
            durationSeconds,
            startsAt,
            endsAt,
            timeKind
          });
        }
      }

      const shipyardData = snapshots.shipyard && snapshots.shipyard[planetId];
      if (shipyardData) {
        const queue = shipyardQueueEntries(shipyardData).filter(isShipBuildQueue);
        for (let index = 0; index < queue.length; index += 1) {
          const entry = queue[index];
          const status = String(entry.status || entry.queueStatus || '').toLowerCase();
          const startsAt = validDeadline(entry.startedAt || entry.startsAt);
          const endsAt = validDeadline(entry.endsAt || entry.completesAt);
          const durationSeconds =
            durationBetween(startsAt, endsAt) ||
            Math.max(0, Math.round(Number(entry.durationSeconds) || 0));
          const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
          timeline.push({
            key: 'timeline:shipyard:' + planetId + ':' + entry.id,
            type: 'shipyard',
            order: index + 1,
            planetId,
            planetName,
            id: String(entry.id),
            definitionId: String(entry.shipDefId || entry.definitionId || ''),
            name: quantity + '× ' + shipyardShipName(entry),
            quantity,
            queueType: String(entry.queueType || ''),
            status,
            statusLabel: queueStatusLabel(status),
            durationSeconds,
            startsAt,
            endsAt,
            timeKind: endsAt ? 'exact' : 'waiting'
          });
        }
      }
    }

    return timeline
      .filter((entry) => entry.endsAt || entry.durationSeconds > 0 || entry.status)
      .sort((left, right) => {
        const typeOrder = { research: 0, building: 1, shipyard: 2 };
        const leftTypeOrder = typeOrder[left.type] == null ? 9 : typeOrder[left.type];
        const rightTypeOrder = typeOrder[right.type] == null ? 9 : typeOrder[right.type];
        return leftTypeOrder - rightTypeOrder ||
          left.planetName.localeCompare(right.planetName, 'zh-Hant') ||
          left.order - right.order;
      });
  }

  function missionHomeEta(mission) {
    return validDeadline(
      mission && (mission.estimatedReturnAt || mission.returnArrivesAt)
    );
  }

  function buildFleetTask(mission) {
    const deadlineAt = missionHomeEta(mission);
    if (!deadlineAt || !isActiveStatus(mission.status) || isDoneStatus(mission.status)) return null;

    const id = mission.id;
    return {
      key: 'fleet:' + id,
      type: 'fleet',
      id: String(id),
      name: String(mission.targetName || mission.missionType || '艦隊任務'),
      sourcePlanetName: String(mission.sourcePlanetName || mission.originPlanetName || '母星'),
      missionType: String(mission.missionType || ''),
      deadlineAt,
      firstSeenAt: serverNowIso(),
      updatedAt: serverNowIso(),
      nextCheckAtMs: 0,
      verifyAttempts: 0
    };
  }

  function buildBuildingTask(planet, building) {
    const deadlineAt = validDeadline(building.upgradeEndsAt);
    const queueId = building.queueId;
    const sourceQueueId = building.sourceQueueId == null
      ? queueId
      : building.sourceQueueId;
    if (
      !deadlineAt ||
      queueId == null ||
      String(building.queueStatus || '').toLowerCase() !== 'in_progress'
    ) {
      return null;
    }

    const definitionId = building.definitionId;
    const catalog = runtime.catalog.get(String(definitionId)) || {};
    return {
      key: 'building:' + planet.id + ':' + queueId,
      type: 'building',
      id: String(sourceQueueId),
      queueEntryId: String(queueId),
      planetId: String(planet.id),
      planetName: String(planet.name || '未知星球'),
      definitionId: String(definitionId),
      name: String(catalog.name || building.name || ('建築 #' + definitionId)),
      targetLevel: Number(building.queueTargetLevel || Number(building.level || 0) + 1),
      deadlineAt,
      firstSeenAt: serverNowIso(),
      updatedAt: serverNowIso(),
      nextCheckAtMs: 0,
      verifyAttempts: 0
    };
  }

  function buildShipyardTask(planet, entry, fleetData, expectedQuantity) {
    const deadlineAt = validDeadline(entry && (entry.endsAt || entry.completesAt));
    const id = entry && entry.id;
    const status = String(entry && (entry.status || entry.queueStatus) || '').toLowerCase();
    if (
      !deadlineAt ||
      id == null ||
      !isShipBuildQueue(entry) ||
      !isActiveStatus(status) ||
      isDoneStatus(status)
    ) {
      return null;
    }

    const definitionId = entry.shipDefId || entry.definitionId;
    const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    const baselineQuantity = fleetQuantityForShip(fleetData, definitionId);
    return {
      key: 'shipyard:' + planet.id + ':' + id,
      type: 'shipyard',
      id: String(id),
      planetId: String(planet.id),
      planetName: String(planet.name || '未知星球'),
      definitionId: String(definitionId),
      shipKey: String(entry.shipKey || ''),
      name: shipyardShipName(entry),
      quantity,
      queueType: String(entry.queueType || ''),
      baselineQuantity,
      expectedQuantity: Math.max(
        baselineQuantity + quantity,
        Math.floor(Number(expectedQuantity) || 0)
      ),
      startedAt: validDeadline(entry.startedAt || entry.startsAt),
      deadlineAt,
      firstSeenAt: serverNowIso(),
      updatedAt: serverNowIso(),
      nextCheckAtMs: 0,
      verifyAttempts: 0
    };
  }

  function researchJobId(entry) {
    return entry && (entry.jobId || entry.queueId || entry.id);
  }

  function researchDefinitionId(entry) {
    return entry && (entry.researchDefId || entry.researchId || entry.definitionId || entry.id);
  }

  function buildResearchTask(planet, entry) {
    const deadlineAt = validDeadline(entry && entry.endsAt);
    const id = researchJobId(entry);
    if (!deadlineAt || id == null || !isActiveStatus(entry.status) || isDoneStatus(entry.status)) {
      return null;
    }

    return {
      key: 'research:' + planet.id + ':' + id,
      type: 'research',
      id: String(id),
      planetId: String(planet.id),
      planetName: String(planet.name || '未知星球'),
      definitionId: String(researchDefinitionId(entry)),
      name: String(entry.name || entry.key || ('研究 #' + researchDefinitionId(entry))),
      targetLevel: Number(entry.targetLevel || Number(entry.level || 0) + 1),
      deadlineAt,
      firstSeenAt: serverNowIso(),
      updatedAt: serverNowIso(),
      nextCheckAtMs: 0,
      verifyAttempts: 0
    };
  }

  function preserveRuntimeFields(task) {
    const previous = runtime.tasks[task.key];
    if (!previous) return task;
    const sameDeadline = previous.deadlineAt === task.deadlineAt;
    const preserved = {
      ...previous,
      ...task,
      firstSeenAt: previous.firstSeenAt || task.firstSeenAt,
      nextCheckAtMs: sameDeadline ? Number(previous.nextCheckAtMs || 0) : 0,
      verifyAttempts: sameDeadline ? Number(previous.verifyAttempts || 0) : 0
    };
    if (task.type === 'shipyard' && previous.type === 'shipyard') {
      preserved.baselineQuantity = Number(previous.baselineQuantity);
      preserved.expectedQuantity = Number(previous.expectedQuantity);
    }
    return preserved;
  }

  function parsePlanetList(authData) {
    const planets = arrayFrom(authData && authData.planets);
    if (planets.length) return planets;

    const auth = getPageAuth();
    if (auth && auth.currentPlanetId != null) {
      return [{ id: auth.currentPlanetId, name: '目前星球' }];
    }
    return [];
  }

  function indexCatalog(catalogData) {
    const list = Array.isArray(catalogData)
      ? catalogData
      : arrayFrom(catalogData && (catalogData.buildings || catalogData.data));
    runtime.catalog.clear();
    for (const item of list) {
      const id = item && (item.id || item.definitionId);
      if (id != null) runtime.catalog.set(String(id), item);
    }
  }

  function indexFleet(data, nextTasks) {
    for (const mission of arrayFrom(data && data.missions)) {
      const task = buildFleetTask(mission);
      if (task) nextTasks[task.key] = preserveRuntimeFields(task);
    }
  }

  function indexPlanet(planet, planetData, nextTasks) {
    for (const building of expandBuildingQueueEntries(planetData && planetData.buildings)) {
      if (
        building &&
        building.queueId != null &&
        String(building.queueStatus || '').toLowerCase() === 'pending' &&
        !validDeadline(building.upgradeEndsAt)
      ) {
        runtime.waitingExact += 1;
      }
      const task = buildBuildingTask(planet, building);
      if (task) nextTasks[task.key] = preserveRuntimeFields(task);
    }
  }

  function getActiveResearchEntries(data) {
    const candidates = [
      data && data.activeResearch,
      ...arrayFrom(data && data.activeResearches)
    ].filter(Boolean);
    const seen = new Set();
    return candidates.filter((entry) => {
      const id = researchJobId(entry);
      const key = String(id == null ? JSON.stringify(entry) : id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function indexResearch(planet, data, nextTasks) {
    for (const entry of getActiveResearchEntries(data)) {
      if (
        entry &&
        !validDeadline(entry.endsAt) &&
        String(entry.queueStatus || entry.status || '').toLowerCase().includes('pending')
      ) {
        runtime.waitingExact += 1;
      }
      const task = buildResearchTask(planet, entry);
      if (task) nextTasks[task.key] = preserveRuntimeFields(task);
    }
  }

  function indexShipyard(planet, data, fleetData, nextTasks) {
    const entries = shipyardQueueEntries(data).filter(isShipBuildQueue);
    const cumulativeByDefinition = new Map();

    for (const entry of entries) {
      if (
        entry &&
        !validDeadline(entry.endsAt || entry.completesAt) &&
        String(entry.status || entry.queueStatus || '').toLowerCase().includes('pending')
      ) {
        runtime.waitingExact += 1;
      }

      const definitionId = entry && (entry.shipDefId || entry.definitionId);
      const definitionKey = String(definitionId == null ? '' : definitionId);
      const quantity = Math.max(1, Math.floor(Number(entry && entry.quantity) || 1));
      const cumulativeQuantity =
        Number(cumulativeByDefinition.get(definitionKey) || 0) + quantity;
      cumulativeByDefinition.set(definitionKey, cumulativeQuantity);
      if (!fleetData) continue;

      const baselineQuantity = fleetQuantityForShip(fleetData, definitionId);
      const task = buildShipyardTask(
        planet,
        entry,
        fleetData,
        baselineQuantity + cumulativeQuantity
      );
      if (task) nextTasks[task.key] = preserveRuntimeFields(task);
    }
  }

  function findResearchDefinition(data, task) {
    return arrayFrom(data && data.research).find((entry) => {
      const ids = [
        entry && entry.id,
        entry && entry.researchId,
        entry && entry.researchDefId,
        entry && entry.definitionId
      ];
      return ids.some((id) => sameId(id, task.definitionId));
    });
  }

  function evaluateFleet(task, data) {
    const missions = arrayFrom(data && data.missions);
    const mission = missions.find((item) => sameId(item && item.id, task.id));
    const now = serverNowMs();

    if (!mission) {
      return now + VERIFY_GRACE_MS >= Date.parse(task.deadlineAt)
        ? { state: 'completed' }
        : { state: 'cancelled' };
    }
    if (mission.completedAt || isDoneStatus(mission.status)) return { state: 'completed' };

    const deadlineAt = missionHomeEta(mission);
    if (deadlineAt) {
      return {
        state: 'active',
        task: preserveRuntimeFields({
          ...task,
          name: String(mission.targetName || task.name),
          deadlineAt,
          updatedAt: serverNowIso()
        })
      };
    }
    return { state: 'waiting' };
  }

  function evaluateBuilding(task, data) {
    const buildings = arrayFrom(data && data.buildings);
    const queued = buildings.find((item) => sameId(item && item.queueId, task.id));
    const definition = buildings.find((item) =>
      sameId(item && item.definitionId, task.definitionId)
    );

    if (queued) {
      const level = currentLevel(queued);
      if (
        isDoneStatus(queued.queueStatus) ||
        (level != null && level >= Number(task.targetLevel))
      ) {
        return { state: 'completed' };
      }

      const deadlineAt = validDeadline(queued.upgradeEndsAt);
      if (deadlineAt && String(queued.queueStatus || '').toLowerCase() === 'in_progress') {
        return {
          state: 'active',
          task: preserveRuntimeFields({
            ...task,
            deadlineAt,
            updatedAt: serverNowIso()
          })
        };
      }
      if (String(queued.queueStatus || '').toLowerCase() === 'pending') {
        return { state: 'waiting' };
      }
    }

    const level = currentLevel(definition);
    if (level != null && level >= Number(task.targetLevel)) return { state: 'completed' };
    return serverNowMs() < Date.parse(task.deadlineAt)
      ? { state: 'cancelled' }
      : { state: 'unknown' };
  }

  function evaluateShipyard(task, shipyardData, fleetData) {
    const queued = shipyardQueueEntries(shipyardData).find((entry) =>
      sameId(entry && entry.id, task.id)
    );
    const now = serverNowMs();

    if (queued) {
      const status = String(queued.status || queued.queueStatus || '').toLowerCase();
      if (isDoneStatus(status)) return { state: 'completed' };
      if (!isActiveStatus(status)) return { state: 'cancelled' };

      const deadlineAt = validDeadline(queued.endsAt || queued.completesAt);
      if (deadlineAt) {
        return {
          state: 'active',
          task: preserveRuntimeFields({
            ...task,
            name: shipyardShipName(queued),
            quantity: Math.max(1, Math.floor(Number(queued.quantity) || task.quantity || 1)),
            startedAt: validDeadline(queued.startedAt || queued.startsAt) || task.startedAt,
            deadlineAt,
            updatedAt: serverNowIso()
          })
        };
      }
      return { state: 'waiting' };
    }

    const expectedQuantity = Number(task.expectedQuantity);
    const currentQuantity = fleetQuantityForShip(fleetData, task.definitionId);
    if (
      Number.isFinite(expectedQuantity) &&
      currentQuantity >= expectedQuantity &&
      now + VERIFY_GRACE_MS >= Date.parse(task.deadlineAt)
    ) {
      return { state: 'completed' };
    }
    return now < Date.parse(task.deadlineAt)
      ? { state: 'cancelled' }
      : { state: 'unknown' };
  }

  function evaluateResearch(task, data) {
    const active = getActiveResearchEntries(data).find((entry) =>
      sameId(researchJobId(entry), task.id)
    );

    if (active) {
      if (active.completedAt || isDoneStatus(active.status)) return { state: 'completed' };
      const deadlineAt = validDeadline(active.endsAt);
      if (deadlineAt) {
        return {
          state: 'active',
          task: preserveRuntimeFields({
            ...task,
            name: String(active.name || task.name),
            deadlineAt,
            updatedAt: serverNowIso()
          })
        };
      }
      return { state: 'waiting' };
    }

    const definition = findResearchDefinition(data, task);
    const level = currentLevel(definition);
    if (level != null && level >= Number(task.targetLevel)) return { state: 'completed' };
    if (definition && isDoneStatus(definition.status)) return { state: 'completed' };

    return serverNowMs() < Date.parse(task.deadlineAt)
      ? { state: 'cancelled' }
      : { state: 'unknown' };
  }

  function eventForTask(task, verifiedAt) {
    const suffix = String(task.targetLevel || Date.parse(task.deadlineAt));
    const eventId = ('nexus:' + task.type + ':' + task.id + ':' + suffix)
      .replace(/[^A-Za-z0-9:_-]/g, '_')
      .slice(0, 180);

    if (task.type === 'fleet') {
      return {
        eventId,
        category: 'fleet',
        title: '艦隊已返回',
        message: task.sourcePlanetName + ' 的艦隊已返航；任務地點：' + task.name + '。',
        deadlineAt: task.deadlineAt,
        verifiedAt
      };
    }
    if (task.type === 'building') {
      return {
        eventId,
        category: 'building',
        title: task.name + ' 建造完成',
        message: task.planetName + '：' + task.name + ' 已升至 Lv.' + task.targetLevel + '。',
        deadlineAt: task.deadlineAt,
        verifiedAt
      };
    }
    if (task.type === 'shipyard') {
      const quantity = Math.max(1, Math.floor(Number(task.quantity) || 1));
      return {
        eventId,
        category: 'shipyard',
        title: quantity + '× ' + task.name + ' 製造完成',
        message: task.planetName + '：' + quantity + ' 艘 ' + task.name + ' 已製造完成。',
        deadlineAt: task.deadlineAt,
        verifiedAt
      };
    }
    return {
      eventId,
      category: 'research',
      title: task.name + ' 研究完成',
      message: task.planetName + '：' + task.name + ' Lv.' + task.targetLevel + ' 已研究完成。',
      deadlineAt: task.deadlineAt,
      verifiedAt
    };
  }

  async function markCompleted(task, verifiedAt) {
    const event = eventForTask(task, verifiedAt || serverNowIso());
    delete runtime.tasks[task.key];

    if (!runtime.sent[event.eventId]) {
      runtime.pending[event.eventId] = {
        ...event,
        kind: 'nexus_legacy_verified_notification',
        createdAt: new Date().toISOString()
      };
    }

    persistState();
    scheduleWakeTimer();
    await flushPendingDiscord();
  }

  function retryDelay(attempts) {
    if (attempts <= 1) return 2_000;
    if (attempts === 2) return 5_000;
    if (attempts === 3) return 10_000;
    return 30_000;
  }

  async function applyEvaluation(task, result, verifiedAt) {
    if (!result) return;
    if (result.state === 'completed') {
      await markCompleted(task, verifiedAt);
      return;
    }
    if (result.state === 'cancelled') {
      delete runtime.tasks[task.key];
      persistState();
      return;
    }
    if (result.state === 'active' && result.task) {
      runtime.tasks[task.key] = result.task;
      if (Date.parse(result.task.deadlineAt) <= serverNowMs() + VERIFY_GRACE_MS) {
        const attempts = Number(result.task.verifyAttempts || 0) + 1;
        runtime.tasks[task.key].verifyAttempts = attempts;
        runtime.tasks[task.key].nextCheckAtMs = serverNowMs() + retryDelay(attempts);
      }
      persistState();
      return;
    }

    const attempts = Number(task.verifyAttempts || 0) + 1;
    runtime.tasks[task.key] = {
      ...task,
      verifyAttempts: attempts,
      nextCheckAtMs: serverNowMs() + retryDelay(attempts)
    };

    // 建築/研究/造船若連續十分鐘都沒有完成證據，視為取消；寧可不報也不誤報。
    if (
      task.type !== 'fleet' &&
      serverNowMs() > Date.parse(task.deadlineAt) + 10 * 60 * 1000
    ) {
      delete runtime.tasks[task.key];
    }
    persistState();
  }

  async function verifyTask(task) {
    try {
      let data;
      let result;
      if (task.type === 'fleet') {
        data = await apiJson('/api/fleet/missions');
        result = evaluateFleet(task, data);
      } else if (task.type === 'building') {
        data = await apiJson('/api/planets/' + encodeURIComponent(task.planetId));
        result = evaluateBuilding(task, data);
      } else if (task.type === 'shipyard') {
        const [shipyardData, fleetData] = await Promise.all([
          apiJson('/api/planets/' + encodeURIComponent(task.planetId) + '/shipyard'),
          apiJson('/api/planets/' + encodeURIComponent(task.planetId) + '/fleet')
        ]);
        data = shipyardData;
        result = evaluateShipyard(task, shipyardData, fleetData);
      } else {
        data = await apiJson(
          '/api/research?planetId=' + encodeURIComponent(task.planetId)
        );
        result = evaluateResearch(task, data);
      }

      const verifiedAt = extractServerNow(data) || serverNowIso();
      runtime.lastError = '';
      await applyEvaluation(task, result, verifiedAt);
    } catch (error) {
      runtime.lastError = String(error && error.message ? error.message : error);
      const attempts = Number(task.verifyAttempts || 0) + 1;
      runtime.tasks[task.key] = {
        ...task,
        verifyAttempts: attempts,
        nextCheckAtMs: serverNowMs() + retryDelay(attempts)
      };
      persistState();
    }
  }

  async function runDueChecks() {
    clearTimeout(runtime.wakeTimer);
    runtime.wakeTimer = 0;

    const now = serverNowMs();
    const due = Object.values(runtime.tasks).filter((task) => {
      const deadline = Date.parse(task.deadlineAt || '');
      const nextCheck = Number(task.nextCheckAtMs || 0);
      return Number.isFinite(deadline) &&
        Math.max(deadline, nextCheck) <= now + VERIFY_GRACE_MS;
    });

    for (const task of due) {
      if (runtime.tasks[task.key]) await verifyTask(runtime.tasks[task.key]);
    }
    scheduleWakeTimer();
  }

  function scheduleWakeTimer() {
    clearTimeout(runtime.wakeTimer);
    runtime.wakeTimer = 0;

    const candidates = Object.values(runtime.tasks)
      .map((task) => {
        const deadline = Date.parse(task.deadlineAt || '');
        if (!Number.isFinite(deadline)) return null;
        return Math.max(deadline, Number(task.nextCheckAtMs || 0));
      })
      .filter(Number.isFinite);

    if (!candidates.length) return;
    const target = Math.min(...candidates);
    const delay = Math.max(0, target - serverNowMs() + VERIFY_GRACE_MS);
    runtime.wakeTimer = setTimeout(runDueChecks, Math.min(delay, MAX_TIMEOUT_MS));
  }

  async function reconcileMissingTasks(nextTasks, snapshots) {
    const previousTasks = Object.values(runtime.tasks);
    for (const task of previousTasks) {
      if (nextTasks[task.key]) continue;

      let result = null;
      let verifiedAt = serverNowIso();
      if (task.type === 'fleet' && snapshots.fleet) {
        result = evaluateFleet(task, snapshots.fleet);
      } else if (task.type === 'building' && snapshots.planets[task.planetId]) {
        const data = snapshots.planets[task.planetId];
        result = evaluateBuilding(task, data);
        verifiedAt = extractServerNow(data) || verifiedAt;
      } else if (task.type === 'research' && snapshots.research[task.planetId]) {
        const data = snapshots.research[task.planetId];
        result = evaluateResearch(task, data);
        verifiedAt = extractServerNow(data) || verifiedAt;
      } else if (task.type === 'shipyard' && snapshots.shipyard[task.planetId]) {
        const data = snapshots.shipyard[task.planetId];
        result = evaluateShipyard(task, data, snapshots.planetFleet[task.planetId]);
        verifiedAt = extractServerNow(data) || verifiedAt;
      }

      if (!result) {
        nextTasks[task.key] = task;
      } else if (result.state === 'completed') {
        await markCompleted(task, verifiedAt);
      } else if (result.state === 'active' && result.task) {
        nextTasks[task.key] = result.task;
      } else if (result.state === 'waiting' || result.state === 'unknown') {
        nextTasks[task.key] = task;
      }
    }
  }

  async function syncAll(reason = 'timer') {
    if (runtime.syncPromise) return runtime.syncPromise;

    runtime.syncPromise = (async () => {
      try {
        const auth = getPageAuth();
        if (!auth) throw new Error('等待 Nexus Legacy 登入狀態');

        runtime.waitingExact = 0;
        const shouldSyncPirateIntel =
          location.pathname === '/galaxy' || location.pathname.startsWith('/galaxy/');
        const pirateCampsRequest = shouldSyncPirateIntel
          ? apiJson('/api/fleet/pirate-camps').catch((error) => {
              console.warn('[' + SCRIPT_NAME + '] 海盜營地情報讀取失敗', error);
              return null;
            })
          : Promise.resolve(null);
        const [authData, catalogData, shipCatalogData, fleetData, pirateCampsData] = await Promise.all([
          apiJson('/api/auth/me'),
          apiJson('/api/catalog/buildings'),
          runtime.shipCatalog.size
            ? Promise.resolve(null)
            : apiJson('/api/catalog/ships').catch(() => null),
          apiJson('/api/fleet/missions'),
          pirateCampsRequest
        ]);
        indexCatalog(catalogData);
        if (shipCatalogData) indexShipCatalog(shipCatalogData);
        if (pirateCampsData) runtime.pirateCamps = apiArray(pirateCampsData, 'camps');

        const planets = parsePlanetList(authData);
        const snapshots = {
          fleet: fleetData,
          planets: {},
          research: {},
          shipyard: {},
          planetFleet: {}
        };
        const nextTasks = {};
        indexFleet(fleetData, nextTasks);

        const planetResults = await Promise.all(planets.map(async (planet) => {
          const [planetResult, researchResult, shipyardResult, planetFleetResult] =
            await Promise.allSettled([
            apiJson('/api/planets/' + encodeURIComponent(planet.id)),
            apiJson('/api/research?planetId=' + encodeURIComponent(planet.id)),
            apiJson('/api/planets/' + encodeURIComponent(planet.id) + '/shipyard'),
            apiJson('/api/planets/' + encodeURIComponent(planet.id) + '/fleet')
          ]);
          return {
            planet,
            planetResult,
            researchResult,
            shipyardResult,
            planetFleetResult
          };
        }));

        for (const item of planetResults) {
          const planetId = String(item.planet.id);
          if (item.planetResult.status === 'fulfilled') {
            snapshots.planets[planetId] = item.planetResult.value;
            indexPlanet(item.planet, item.planetResult.value, nextTasks);
          }
          if (item.researchResult.status === 'fulfilled') {
            snapshots.research[planetId] = item.researchResult.value;
            indexResearch(item.planet, item.researchResult.value, nextTasks);
          }
          if (item.shipyardResult.status === 'fulfilled') {
            snapshots.shipyard[planetId] = item.shipyardResult.value;
          }
          if (item.planetFleetResult.status === 'fulfilled') {
            snapshots.planetFleet[planetId] = item.planetFleetResult.value;
            indexShipyardOwnedCounts(planetId, item.planetFleetResult.value);
          }
          if (snapshots.shipyard[planetId]) {
            indexShipyard(
              item.planet,
              snapshots.shipyard[planetId],
              snapshots.planetFleet[planetId],
              nextTasks
            );
          }
        }

        runtime.queueTimeline = buildQueueTimeline(planets, snapshots);

        await reconcileMissingTasks(nextTasks, snapshots);
        runtime.tasks = { ...runtime.tasks, ...nextTasks };

        // 已由 reconcile 完成/取消的舊項目不應被舊狀態加回來。
        for (const key of Object.keys(runtime.tasks)) {
          if (
            !nextTasks[key] &&
            !Object.values(runtime.pending).some((event) =>
              event && String(event.eventId || '').includes(':' + runtime.tasks[key].id + ':')
            )
          ) {
            const task = runtime.tasks[key];
            const scopeAvailable =
              task.type === 'fleet' ||
              (task.type === 'building' && snapshots.planets[task.planetId]) ||
              (task.type === 'research' && snapshots.research[task.planetId]) ||
              (task.type === 'shipyard' && snapshots.shipyard[task.planetId]);
            if (scopeAvailable) delete runtime.tasks[key];
          }
        }

        runtime.lastSyncAt = Date.now();
        runtime.lastError = '';
        persistState();
        scheduleWakeTimer();
        await flushPendingDiscord();
        console.info('[' + SCRIPT_NAME + '] 同步完成：' + reason, {
          tracking: Object.keys(runtime.tasks).length,
          waitingExact: runtime.waitingExact,
          pendingDiscord: Object.keys(runtime.pending).length
        });
      } catch (error) {
        runtime.lastError = String(error && error.message ? error.message : error);
        renderBadge();
        console.warn('[' + SCRIPT_NAME + '] 同步失敗', error);
      } finally {
        runtime.syncPromise = null;
        schedulePeriodicSync();
      }
    })();

    return runtime.syncPromise;
  }

  function gmPostJson(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          Accept: 'application/json'
        },
        data: JSON.stringify(payload),
        timeout: 20_000,
        onload(response) {
          const text = String(response.responseText || '');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (_error) {
            reject(new Error('Discord 後端不是 JSON（HTTP ' + response.status + '）'));
            return;
          }
          if (response.status < 200 || response.status >= 300 || !parsed.ok) {
            reject(new Error(parsed.error || ('Discord 後端 HTTP ' + response.status)));
            return;
          }
          resolve(parsed);
        },
        onerror() {
          reject(new Error('無法連線 Discord 後端'));
        },
        ontimeout() {
          reject(new Error('Discord 後端逾時'));
        }
      });
    });
  }

  async function flushPendingDiscord() {
    if (runtime.flushPromise) return runtime.flushPromise;

    runtime.flushPromise = (async () => {
      const gasUrl = String(GM_getValue(STORAGE.gasUrl, DEFAULT_GAS_URL) || '').trim();
      const secret = String(GM_getValue(STORAGE.secret, '') || '').trim();
      if (!gasUrl || !secret) {
        runtime.lastError = '尚未設定 Discord 後端 URL 與密鑰';
        renderBadge();
        return;
      }

      for (const [eventId, event] of Object.entries(runtime.pending)) {
        try {
          const result = await gmPostJson(gasUrl, { ...event, secret });
          runtime.sent[eventId] = {
            sentAt: Date.now(),
            backendSentAt: result.sentAt || '',
            duplicate: Boolean(result.duplicate)
          };
          delete runtime.pending[eventId];
          runtime.lastError = '';
          persistState();
        } catch (error) {
          runtime.lastError = String(error && error.message ? error.message : error);
          persistState();
          break;
        }
      }
    })().finally(() => {
      runtime.flushPromise = null;
    });

    return runtime.flushPromise;
  }

  function schedulePeriodicSync() {
    clearTimeout(runtime.periodicTimer);
    const delay = document.visibilityState === 'hidden'
      ? HIDDEN_SYNC_MS
      : ACTIVE_SYNC_MS;
    runtime.periodicTimer = setTimeout(() => syncAll('periodic'), delay);
  }

  function syncSoon(reason) {
    clearTimeout(runtime.periodicTimer);
    runtime.periodicTimer = setTimeout(() => syncAll(reason), 500);
  }

  function configureDiscord() {
    const currentGasUrl = String(GM_getValue(STORAGE.gasUrl, DEFAULT_GAS_URL) || '');
    const gasUrl = unsafeWindow.prompt(
      'Discord 通知後端 Apps Script Web App URL：\n（請填入以 /exec 結尾的部署網址）',
      currentGasUrl
    );
    if (gasUrl == null) return;
    const trimmedGasUrl = gasUrl.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(trimmedGasUrl)) {
      unsafeWindow.alert('Web App URL 格式不正確，請填入 Google Apps Script 的 /exec 網址。');
      return;
    }
    GM_setValue(STORAGE.gasUrl, trimmedGasUrl);

    const currentSecret = String(GM_getValue(STORAGE.secret, '') || '');
    const secret = unsafeWindow.prompt(
      'NEXUS_PLUGIN_SECRET：\n（已設定時留空可保留目前密鑰）',
      ''
    );
    if (secret == null) return;
    const trimmedSecret = secret.trim();
    if (!trimmedSecret && !currentSecret) return;
    if (trimmedSecret) GM_setValue(STORAGE.secret, trimmedSecret);
    runtime.lastError = '';
    renderBadge();
    syncSoon('configured');
  }

  async function sendDiscordTest() {
    const eventId = 'nexus:test:' + Date.now();
    runtime.pending[eventId] = {
      kind: 'nexus_legacy_verified_notification',
      eventId,
      category: 'test',
      title: '精準通知連線測試',
      message: 'Nexus Legacy 艦隊、建築、研究與造船通知已連上這個 Discord 頻道。',
      deadlineAt: serverNowIso(),
      verifiedAt: serverNowIso(),
      createdAt: new Date().toISOString()
    };
    persistState();
    await flushPendingDiscord();
    if (!runtime.pending[eventId]) {
      unsafeWindow.alert('Discord 測試已送出。');
    } else {
      unsafeWindow.alert('Discord 測試未送出：' + (runtime.lastError || '未知錯誤'));
    }
  }

  function applyStyles(element, styles) {
    Object.assign(element.style, styles);
    return element;
  }

  function appendTextLine(parent, label, value, valueColor) {
    const line = applyStyles(document.createElement('div'), {
      display: 'grid',
      gridTemplateColumns: '92px minmax(0, 1fr)',
      gap: '8px',
      alignItems: 'baseline',
      marginTop: '4px'
    });
    const labelNode = document.createElement('span');
    labelNode.textContent = label;
    labelNode.style.color = '#8ca9b4';
    const valueNode = document.createElement('strong');
    valueNode.textContent = value;
    valueNode.style.color = valueColor || '#e5f8ff';
    valueNode.style.fontWeight = '600';
    valueNode.style.overflowWrap = 'anywhere';
    line.append(labelNode, valueNode);
    parent.appendChild(line);
  }

  function ensureQueuePanel() {
    if (!document.body) return null;
    if (runtime.panel && runtime.panel.isConnected) return runtime.panel;

    const panel = applyStyles(document.createElement('section'), {
      position: 'fixed',
      right: '12px',
      bottom: '54px',
      zIndex: '2147483646',
      width: 'min(480px, calc(100vw - 24px))',
      maxHeight: 'min(76vh, 720px)',
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
      border: '1px solid rgba(98, 255, 203, .48)',
      borderRadius: '14px',
      background: 'rgba(5, 17, 25, .97)',
      color: '#e5f8ff',
      boxShadow: '0 12px 38px rgba(0, 0, 0, .58)',
      font: '13px/1.42 system-ui, sans-serif'
    });
    panel.id = 'nexus-exact-discord-queue-panel';
    panel.setAttribute('aria-label', 'Nexus Legacy 研究、建造與造船佇列時間');

    const header = applyStyles(document.createElement('header'), {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '11px 12px',
      borderBottom: '1px solid rgba(98, 255, 203, .18)'
    });
    const title = document.createElement('strong');
    title.textContent = '研究、建造與造船佇列時間';
    title.style.flex = '1';
    title.style.fontSize = '14px';

    const refresh = applyStyles(document.createElement('button'), {
      border: '1px solid rgba(98, 255, 203, .42)',
      borderRadius: '8px',
      padding: '4px 8px',
      background: 'rgba(22, 65, 76, .7)',
      color: '#b9ffe8',
      cursor: 'pointer'
    });
    refresh.type = 'button';
    refresh.textContent = '重新同步';
    refresh.addEventListener('click', () => syncSoon('queue-panel'));

    const close = applyStyles(document.createElement('button'), {
      border: '0',
      borderRadius: '8px',
      padding: '4px 8px',
      background: 'transparent',
      color: '#b9cbd2',
      cursor: 'pointer',
      fontSize: '16px'
    });
    close.type = 'button';
    close.setAttribute('aria-label', '關閉佇列時間');
    close.textContent = '×';
    close.addEventListener('click', () => {
      panel.style.display = 'none';
    });

    const body = applyStyles(document.createElement('div'), {
      padding: '10px 12px 12px',
      overflowY: 'auto',
      overscrollBehavior: 'contain'
    });
    header.append(title, refresh, close);
    panel.append(header, body);
    document.body.appendChild(panel);
    runtime.panel = panel;
    runtime.panelBody = body;
    return panel;
  }

  function renderQueuePanel() {
    const panel = runtime.panel;
    const body = runtime.panelBody;
    if (!panel || !panel.isConnected || !body || panel.style.display === 'none') return;
    body.replaceChildren();

    const summary = document.createElement('div');
    summary.textContent = runtime.lastSyncAt
      ? '最後同步：' + new Date(runtime.lastSyncAt).toLocaleString('zh-TW', { hour12: false })
      : '正在等待第一次同步…';
    applyStyles(summary, {
      marginBottom: '9px',
      color: '#91aeb8',
      fontSize: '12px'
    });
    body.appendChild(summary);

    if (!runtime.queueTimeline.length) {
      const empty = document.createElement('p');
      empty.textContent = runtime.lastError
        ? '暫時無法讀取佇列：' + runtime.lastError
        : '目前沒有研究、建造或造船佇列。';
      empty.style.margin = '12px 0';
      body.appendChild(empty);
      return;
    }

    let currentType = '';
    for (const item of runtime.queueTimeline) {
      if (item.type !== currentType) {
        currentType = item.type;
        const isResearch = item.type === 'research';
        const isShipyard = item.type === 'shipyard';
        const typeColor = isResearch ? '#8dd6ff' : isShipyard ? '#c7a8ff' : '#ffd58d';
        const section = document.createElement('div');
        section.textContent = isResearch ? '研究佇列' : isShipyard ? '造船佇列' : '建造佇列';
        applyStyles(section, {
          marginTop: currentType === runtime.queueTimeline[0].type ? '2px' : '14px',
          paddingBottom: '5px',
          borderBottom: '1px solid rgba(137, 194, 213, .28)',
          color: typeColor,
          fontSize: '13px',
          fontWeight: '800'
        });
        body.appendChild(section);
      }
      const card = applyStyles(document.createElement('article'), {
        marginTop: '8px',
        padding: '10px',
        border: '1px solid rgba(137, 194, 213, .2)',
        borderRadius: '10px',
        background: 'rgba(15, 38, 49, .72)'
      });
      const heading = applyStyles(document.createElement('div'), {
        display: 'flex',
        alignItems: 'baseline',
        gap: '7px',
        flexWrap: 'wrap'
      });
      const kind = document.createElement('span');
      kind.textContent = item.type === 'research'
        ? '研究 #' + item.order
        : item.type === 'shipyard'
          ? '造船 #' + item.order
          : '建造 #' + item.order;
      kind.style.color = item.type === 'research'
        ? '#8dd6ff'
        : item.type === 'shipyard'
          ? '#c7a8ff'
          : '#ffd58d';
      kind.style.fontWeight = '700';
      const name = document.createElement('strong');
      name.textContent = item.name +
        (item.type !== 'shipyard' && item.targetLevel ? ' Lv.' + item.targetLevel : '');
      name.style.fontSize = '14px';
      const state = document.createElement('span');
      state.textContent = item.statusLabel;
      state.style.marginLeft = 'auto';
      state.style.color = item.timeKind === 'exact' ? '#76f5bd' : '#ffd58d';
      heading.append(kind, name, state);
      card.appendChild(heading);

      const planet = document.createElement('div');
      planet.textContent = item.planetName;
      applyStyles(planet, { marginTop: '2px', color: '#91aeb8', fontSize: '12px' });
      card.appendChild(planet);

      appendTextLine(card, '所需工期', item.durationSeconds ? formatDuration(item.durationSeconds) : '等待伺服器資料');
      appendTextLine(card, item.timeKind === 'exact' ? '實際開始' : '預計開始', formatQueueDate(item.startsAt));
      appendTextLine(
        card,
        item.timeKind === 'exact' ? '精確完成' : '預計完成',
        formatQueueDate(item.endsAt),
        item.timeKind === 'exact' ? '#76f5bd' : '#ffd58d'
      );

      const note = document.createElement('div');
      note.textContent = item.timeKind === 'exact'
        ? '伺服器精確時間'
        : item.timeKind === 'estimated'
          ? '依前項完成時間與伺服器工期推算；開始後自動校正'
          : '等待前一項開始後取得精確時間';
      applyStyles(note, { marginTop: '7px', color: '#78939e', fontSize: '11px' });
      card.appendChild(note);
      body.appendChild(card);
    }
  }

  function toggleQueuePanel() {
    const panel = ensureQueuePanel();
    if (!panel) return;
    const opening = panel.style.display === 'none';
    panel.style.display = opening ? 'flex' : 'none';
    if (opening) {
      renderQueuePanel();
      syncSoon('queue-panel-open');
    }
  }

  function normalizedAutoScoutMode(value) {
    return String(value || '') === 'resource' ? 'resource' : 'pirate';
  }

  function autoScoutModeLabel(mode = runtime.autoScoutMode) {
    return normalizedAutoScoutMode(mode) === 'resource' ? '礦＋氫偵查' : '海盜偵查';
  }

  function autoScoutCatalogRows(data) {
    return apiArray(data, 'ships');
  }

  function autoScoutFleetRows(data) {
    return apiArray(data, 'fleet');
  }

  function autoScoutMissionRows(data) {
    return apiArray(data, 'missions');
  }

  function autoScoutFieldIndexRows(data) {
    const systems = apiArray(data, 'systems');
    return systems.length ? systems : apiArray(data, 'fields');
  }

  function saveAutoScoutState() {
    GM_setValue(STORAGE.autoScoutEnabled, Boolean(runtime.autoScoutEnabled));
    GM_setValue(STORAGE.autoScoutMode, normalizedAutoScoutMode(runtime.autoScoutMode));
  }

  function autoScoutResourceLabel(fieldType) {
    if (fieldType === 'ore') return '礦';
    if (fieldType === 'gas') return '氣';
    return '';
  }

  function autoScoutAvailableUnits(fleetData, catalogData, requiredShipKeys) {
    const allowedShipKeys = new Set(
      (Array.isArray(requiredShipKeys) ? requiredShipKeys : [requiredShipKeys]).map(String)
    );
    const catalog = new Map(autoScoutCatalogRows(catalogData).map((ship) => [
      Number(ship.id),
      ship
    ]));
    const units = [];
    const rows = autoScoutFleetRows(fleetData)
      .map((entry) => {
        const definition = catalog.get(Number(entry.shipDefId)) || entry.definition || {};
        const quantity = Math.max(0, Math.floor(Number(entry.quantity) || 0));
        const damaged = Math.max(0, Math.floor(Number(entry.damagedQuantity) || 0));
        const fallbackAvailable = Math.max(0, quantity - damaged);
        return {
          shipDefId: Number(entry.shipDefId ?? definition.id),
          shipKey: String(definition.key || entry.shipKey || ''),
          shipName: String(definition.name || entry.shipName || ''),
          available: Math.max(0, Math.floor(Number(
            entry.availableQuantity ?? fallbackAvailable
          )))
        };
      })
      .filter((entry) =>
        Number.isFinite(entry.shipDefId) &&
        entry.available > 0 &&
        allowedShipKeys.has(entry.shipKey)
      );
    for (const row of rows) {
      for (let index = 0; index < row.available; index += 1) {
        units.push({
          shipDefId: row.shipDefId,
          shipKey: row.shipKey,
          shipName: row.shipName || row.shipKey
        });
      }
    }
    return units;
  }

  function autoScoutAvailableStealthUnits(fleetData, catalogData) {
    return autoScoutAvailableUnits(fleetData, catalogData, 'stealth_ship');
  }

  function autoScoutAvailableResourceUnits(fleetData, catalogData) {
    return autoScoutAvailableUnits(fleetData, catalogData, ['probe', 'spy_probe']);
  }

  function autoScoutMissionIsActive(mission) {
    const status = String(mission && mission.status || '').toLowerCase();
    return !['completed', 'cancelled', 'canceled', 'failed'].includes(status);
  }

  function autoScoutResourceFieldRows(indexData) {
    const targets = [];
    const seen = new Set();

    function addRow(row, inherited = {}) {
      if (!row || typeof row !== 'object') return;
      const systemId = row.systemId ?? inherited.systemId ?? inherited.id;
      const systemName = row.systemName ?? inherited.systemName ?? inherited.name ?? systemId;
      const systemX = row.systemX ?? row.x ?? inherited.systemX ?? inherited.x;
      const systemY = row.systemY ?? row.y ?? inherited.systemY ?? inherited.y;
      const nestedContext = { systemId, systemName, systemX, systemY };

      for (const field of arrayFrom(row.fields)) addRow(field, nestedContext);

      const fieldType = String(
        row.fieldType ?? row.resourceType ?? row.unscannedField?.fieldType ?? ''
      ).toLowerCase();
      if (!['ore', 'gas'].includes(fieldType)) return;

      const unscanned = row.unscannedField && typeof row.unscannedField === 'object'
        ? row.unscannedField
        : null;
      const directIsUnscanned = row.isScanned === false || row.scanned === false;
      const fieldId = (unscanned && (unscanned.id ?? unscanned.fieldId)) ??
        row.unscannedFieldId ??
        (directIsUnscanned ? row.fieldId ?? row.id : null);
      if (fieldId == null || systemId == null) return;

      const key = String(fieldId);
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({
        fieldId: Number.isFinite(Number(fieldId)) ? Number(fieldId) : fieldId,
        fieldName: String(
          unscanned && (unscanned.name || unscanned.fieldName) ||
          row.unscannedFieldName || row.fieldName || row.name || fieldId
        ),
        fieldType,
        systemId: Number.isFinite(Number(systemId)) ? Number(systemId) : systemId,
        systemName: String(systemName || systemId),
        systemX: Number(systemX),
        systemY: Number(systemY)
      });
    }

    for (const row of autoScoutFieldIndexRows(indexData)) addRow(row);
    return targets;
  }

  function autoScoutCandidateFields(snapshot) {
    const activeFieldIds = new Set(
      autoScoutMissionRows(snapshot.missionData)
        .filter((mission) =>
          mission &&
          String(mission.missionType || '') === 'field_scan' &&
          autoScoutMissionIsActive(mission) &&
          mission.targetFieldId != null
        )
        .map((mission) => String(mission.targetFieldId))
    );
    const homeSystemId = String(snapshot.planet.systemId);
    const homeX = Number(snapshot.planet.systemX);
    const homeY = Number(snapshot.planet.systemY);
    const targets = autoScoutResourceFieldRows(snapshot.fieldIndexData)
      .filter((field) =>
        String(field.systemId) !== homeSystemId &&
        !activeFieldIds.has(String(field.fieldId)) &&
        [homeX, homeY, field.systemX, field.systemY].every(Number.isFinite)
      )
      .map((field) => ({
        ...field,
        distance: Math.hypot(field.systemX - homeX, field.systemY - homeY)
      }));

    targets.sort((left, right) =>
      left.distance - right.distance ||
      left.systemName.localeCompare(right.systemName, 'zh-Hant') ||
      ['ore', 'gas'].indexOf(left.fieldType) - ['ore', 'gas'].indexOf(right.fieldType) ||
      left.fieldName.localeCompare(right.fieldName, 'zh-Hant')
    );
    return {
      targets,
      activeFieldIds,
      activeSurveyIds: new Set(),
      coolingIds: new Set(),
      pirateBlockedSystems: 0
    };
  }

  function autoScoutHasActivePirate(camp) {
    if (!camp || camp.destroyedAt || camp.cleanupInProgress === true) return false;
    const hp = Number(camp.currentHpPercent);
    return !Number.isFinite(hp) || hp > 0;
  }

  function autoScoutSystemRows(mapData) {
    return apiArray(mapData, 'systems');
  }

  function autoScoutCandidateSystems(snapshot) {
    const now = serverNowMs();
    const availableIds = new Set(
      apiArray(snapshot.cooldownData, 'availableSystemIds').map((id) => String(id))
    );
    const coolingIds = new Set(
      apiArray(snapshot.cooldownData, 'cooldowns')
        .filter((entry) => Date.parse(entry && entry.cooldownEndsAt || '') > now)
        .map((entry) => String(entry.systemId))
    );
    const pirateIds = new Set(
      apiArray(snapshot.pirateData, 'camps')
        .filter(autoScoutHasActivePirate)
        .map((camp) => String(camp.systemId))
    );
    const activeSurveyIds = new Set(
      autoScoutMissionRows(snapshot.missionData)
        .filter((mission) =>
          mission &&
          ['survey', 'system_scan'].includes(String(mission.missionType || '')) &&
          autoScoutMissionIsActive(mission)
        )
        .map((mission) => String(mission.targetSystemId))
    );
    const homeSystemId = String(snapshot.planet.systemId);
    const homeX = Number(snapshot.planet.systemX);
    const homeY = Number(snapshot.planet.systemY);
    const targets = [];
    const seen = new Set();
    let pirateBlockedSystems = 0;

    for (const system of autoScoutSystemRows(snapshot.mapData)) {
      const systemId = String(system && system.id);
      if (!system || seen.has(systemId) || systemId === homeSystemId) continue;
      seen.add(systemId);
      if (!availableIds.has(systemId)) continue;
      if (system.visibility && String(system.visibility) !== 'full') continue;
      if (coolingIds.has(systemId) || activeSurveyIds.has(systemId)) continue;
      if (pirateIds.has(systemId)) {
        pirateBlockedSystems += 1;
        continue;
      }
      const systemX = Number(system.x ?? system.systemX);
      const systemY = Number(system.y ?? system.systemY);
      if (![homeX, homeY, systemX, systemY].every(Number.isFinite)) continue;
      targets.push({
        systemId: Number(system.id),
        systemName: String(system.name || system.id),
        systemX,
        systemY,
        distance: Math.hypot(systemX - homeX, systemY - homeY)
      });
    }

    targets.sort((left, right) =>
      left.distance - right.distance ||
      left.systemName.localeCompare(right.systemName, 'zh-Hant')
    );
    return {
      targets,
      activeFieldIds: new Set(),
      activeSurveyIds,
      coolingIds,
      pirateIds,
      pirateBlockedSystems
    };
  }

  async function loadAutoScoutSnapshot(forWork) {
    const auth = getPageAuth();
    if (!auth) throw new Error('遊戲登入資料尚未就緒');
    const mode = normalizedAutoScoutMode(runtime.autoScoutMode);
    const [meData, missionData, catalogData] = await Promise.all([
      apiJson('/api/auth/me'),
      apiJson('/api/fleet/missions'),
      apiJson('/api/catalog/ships')
    ]);
    const planets = apiArray(meData, 'planets');
    const planet = planets.find((item) => item && item.isHomeworld) ||
      planets.find((item) => Number(item.id) === Number(auth.currentPlanetId)) ||
      planets[0];
    if (!planet) throw new Error('找不到家園出發星球');

    const workRequests = [
      apiJson('/api/planets/' + encodeURIComponent(planet.id) + '/fleet')
    ];
    if (forWork) {
      if (mode === 'resource') {
        workRequests.push(apiJson('/api/galaxy/field-index'));
      } else {
        workRequests.push(
          apiJson('/api/fleet/survey-cooldowns'),
          apiJson('/api/fleet/pirate-camps'),
          apiJson('/api/galaxy/map')
        );
      }
    }
    const workResults = await Promise.all(workRequests);
    const fleetData = workResults[0];
    const fieldIndexData = forWork && mode === 'resource' ? workResults[1] : null;
    const cooldownData = forWork && mode === 'pirate' ? workResults[1] : null;
    const pirateData = forWork && mode === 'pirate' ? workResults[2] : null;
    const mapData = forWork && mode === 'pirate' ? workResults[3] : null;
    const missions = autoScoutMissionRows(missionData);
    const maxFleetSlots = Math.max(0, Number(
      missionData && (
        missionData.maxFleetSlots ??
        missionData.fleetSlotLimit ??
        missionData.data?.maxFleetSlots
      )
    ) || 0);
    const usedFleetSlots = missions.filter((mission) =>
      mission &&
      autoScoutMissionIsActive(mission) &&
      mission.doesNotConsumeFleetSlot !== true
    ).length;
    const availableResourceUnits = autoScoutAvailableResourceUnits(fleetData, catalogData);
    const availableStealthUnits = autoScoutAvailableStealthUnits(fleetData, catalogData);
    const freeFleetSlots = Math.max(0, maxFleetSlots - usedFleetSlots);
    let candidateResult = {
      targets: [],
      activeSurveyIds: new Set(),
      coolingIds: new Set(),
      pirateBlockedSystems: 0,
      activeFieldIds: new Set()
    };

    if (forWork && mode === 'resource') {
      candidateResult = autoScoutCandidateFields({ planet, missionData, fieldIndexData });
    } else if (forWork) {
      candidateResult = autoScoutCandidateSystems({
        planet,
        missionData,
        cooldownData,
        pirateData,
        mapData
      });
      runtime.pirateCamps = apiArray(pirateData, 'camps');
    }

    const availableUnits = mode === 'resource' ? availableResourceUnits : availableStealthUnits;
    runtime.autoScoutPreviewTargets = candidateResult.targets.slice(0, 20);

    runtime.autoScoutSnapshot = {
      mode,
      maxFleetSlots,
      usedFleetSlots,
      dispatchCapacity: Math.min(availableUnits.length, freeFleetSlots),
      availableResourceScouts: availableResourceUnits.length,
      availableStealthShips: availableStealthUnits.length,
      freeFleetSlots,
      activeFieldScans: candidateResult.activeFieldIds.size,
      readyFields: mode === 'resource' ? candidateResult.targets.length : 0,
      activeSurveys: candidateResult.activeSurveyIds.size,
      readySystems: mode === 'pirate' ? candidateResult.targets.length : 0,
      coolingSystems: candidateResult.coolingIds.size,
      pirateBlockedSystems: candidateResult.pirateBlockedSystems
    };

    return {
      mode,
      auth,
      planet,
      missionData,
      catalogData,
      fleetData,
      cooldownData,
      pirateData,
      mapData,
      fieldIndexData,
      availableUnits,
      candidateResult,
      freeFleetSlots
    };
  }

  async function dispatchAutoScoutMissions(snapshot) {
    const dispatchLimit = Math.min(
      snapshot.availableUnits.length,
      snapshot.freeFleetSlots
    );
    if (dispatchLimit <= 0) {
      runtime.autoScoutLastAction = snapshot.availableUnits.length
        ? '目前沒有可用艦隊空位'
        : snapshot.mode === 'resource'
          ? '目前沒有可派遣的資源偵查船（Probe／Spy Probe）'
          : '目前沒有可派遣的隱形艦（Stealth Ship）';
      return { dispatched: 0, candidates: 0 };
    }

    const targets = snapshot.candidateResult.targets.slice(0, dispatchLimit);
    if (!targets.length) {
      runtime.autoScoutLastAction = snapshot.mode === 'resource'
        ? '目前沒有尚未偵查的礦場或氫氣田'
        : '目前沒有冷卻完畢且無海盜的可掃描星系';
      return { dispatched: 0, candidates: 0 };
    }

    let dispatched = 0;
    const names = [];
    for (let index = 0; index < targets.length; index += 1) {
      if (
        !runtime.autoScoutEnabled ||
        normalizedAutoScoutMode(runtime.autoScoutMode) !== snapshot.mode
      ) break;
      const target = targets[index];
      const unit = snapshot.availableUnits[index];
      if (!unit) break;
      try {
        const ships = [{ shipDefId: unit.shipDefId, quantity: 1 }];
        const targetPayload = snapshot.mode === 'resource'
          ? { targetFieldId: target.fieldId }
          : { targetSystemId: target.systemId };
        const missionType = snapshot.mode === 'resource' ? 'field_scan' : 'survey';
        const estimate = await apiJsonRequest('/api/fleet/fuel-estimate', {
          method: 'POST',
          body: {
            sourcePlanetId: Number(snapshot.planet.id),
            ...targetPayload,
            missionType,
            ships
          }
        });
        if (estimate && estimate.sufficient === false) {
          runtime.autoScoutLastAction =
            '氫氣不足，最近未派出的目標：' +
            (snapshot.mode === 'resource' ? target.fieldName : target.systemName);
          break;
        }
        await apiJsonRequest(
          snapshot.mode === 'resource' ? '/api/fleet/field-scan' : '/api/fleet/survey',
          {
          method: 'POST',
          body: {
            sourcePlanetId: Number(snapshot.planet.id),
            ...targetPayload,
            ships
          }
          }
        );
        dispatched += 1;
        names.push(snapshot.mode === 'resource'
          ? target.systemName + ' ' + autoScoutResourceLabel(target.fieldType)
          : target.systemName
        );
      } catch (error) {
        runtime.autoScoutLastError = String(error && error.message ? error.message : error);
      }
    }

    if (dispatched) {
      const unitCountKey = snapshot.mode === 'resource'
        ? 'availableResourceScouts'
        : 'availableStealthShips';
      runtime.autoScoutSnapshot[unitCountKey] = Math.max(
        0,
        runtime.autoScoutSnapshot[unitCountKey] - dispatched
      );
      runtime.autoScoutSnapshot.freeFleetSlots = Math.max(
        0,
        runtime.autoScoutSnapshot.freeFleetSlots - dispatched
      );
      runtime.autoScoutSnapshot.dispatchCapacity = Math.max(
        0,
        runtime.autoScoutSnapshot.dispatchCapacity - dispatched
      );
      runtime.autoScoutLastAction =
        '已派出 ' + dispatched + ' 艘：' + names.slice(0, 4).join('、') +
        (names.length > 4 ? '…' : '');
    } else if (runtime.autoScoutLastError) {
      runtime.autoScoutLastAction = '本輪未能派出偵查機';
    }
    return { dispatched, candidates: snapshot.candidateResult.targets.length };
  }

  function changeAutoScoutMode(event) {
    const nextMode = normalizedAutoScoutMode(event && event.target && event.target.value);
    if (nextMode === runtime.autoScoutMode) return;
    runtime.autoScoutMode = nextMode;
    runtime.autoScoutLastError = '';
    runtime.autoScoutLastAction = runtime.autoScoutEnabled
      ? '已切換成「' + autoScoutModeLabel(nextMode) + '」；已派出的任務不受影響'
      : '已選擇「' + autoScoutModeLabel(nextMode) + '」；尚未啟用';
    saveAutoScoutState();
    renderAutoScoutPanel();
    autoScoutSoon('mode-changed');
  }

  function renderAutoScoutPanel() {
    const panel = runtime.autoScoutPanel;
    if (!panel || !panel.isConnected) return;
    const onGalaxy = location.pathname === '/galaxy';
    panel.style.display = onGalaxy ? 'flex' : 'none';
    if (!onGalaxy) return;

    const snapshot = runtime.autoScoutSnapshot;
    const resourceMode = runtime.autoScoutMode === 'resource';
    if (runtime.autoScoutModeSelect) {
      runtime.autoScoutModeSelect.value = runtime.autoScoutMode;
    }
    if (runtime.autoScoutToggleButton) {
      runtime.autoScoutToggleButton.textContent = runtime.autoScoutEnabled
        ? '停止自動偵查'
        : '啟用自動偵查';
      runtime.autoScoutToggleButton.style.background = runtime.autoScoutEnabled
        ? 'rgba(110, 39, 52, .88)'
        : 'rgba(18, 92, 82, .88)';
    }
    if (runtime.autoScoutStatusNode) {
      runtime.autoScoutStatusNode.replaceChildren();
      const lines = resourceMode ? [
        '模式：礦＋氫偵查｜狀態：' +
          (runtime.autoScoutEnabled ? '執行中' : '關閉（不會派船）'),
        '可用資源偵查船：' + snapshot.availableResourceScouts +
          '｜艦隊空位：' + snapshot.freeFleetSlots + '/' + snapshot.maxFleetSlots +
          '｜本輪最多可派：' + snapshot.dispatchCapacity,
        '偵查中：' + snapshot.activeFieldScans +
          '｜可偵查礦氫田：' + snapshot.readyFields,
        '規則：只用 Probe／Spy Probe，每個礦場或氫氣田 1 艘；從家園嚴格由近到遠',
        '最近：' + runtime.autoScoutLastAction
      ] : [
        '狀態：' + (runtime.autoScoutEnabled ? '執行中' : '關閉（不會派船）'),
        '可用隱形艦：' + snapshot.availableStealthShips +
          '｜艦隊空位：' + snapshot.freeFleetSlots + '/' + snapshot.maxFleetSlots +
          '｜本輪最多可派：' + snapshot.dispatchCapacity,
        '掃描中：' + snapshot.activeSurveys,
        '可掃描：' + snapshot.readySystems +
          '｜冷卻中：' + snapshot.coolingSystems +
          '｜有海盜暫停：' + snapshot.pirateBlockedSystems,
        '規則：只用 Stealth Ship，每星系 1 艘；從家園嚴格由近到遠',
        '循環：冷卻完再掃；發現海盜先跳過，消滅後恢復掃描',
        '最近：' + runtime.autoScoutLastAction
      ];
      if (runtime.autoScoutLastError) lines.push('錯誤：' + runtime.autoScoutLastError);
      for (const text of lines) {
        const line = document.createElement('div');
        line.textContent = text;
        runtime.autoScoutStatusNode.appendChild(line);
      }
    }
  }

  async function toggleAutoScout() {
    if (runtime.autoScoutEnabled) {
      runtime.autoScoutEnabled = false;
      runtime.autoScoutLastAction = '已停止；已派出的偵查任務不受影響';
      saveAutoScoutState();
      renderAutoScoutPanel();
      return;
    }

    const resourceMode = runtime.autoScoutMode === 'resource';
    const confirmed = unsafeWindow.confirm(resourceMode
      ? '啟用「礦＋氫偵查」後：\n' +
        '• 只使用 Probe／Spy Probe，每個礦場或氫氣田派 1 艘\n' +
        '• 派遣數自動取「可用船數」與「伺服器艦隊空位」較小值\n' +
        '• 每輪從家園嚴格由近到遠，不重複派往偵查中的資源田\n' +
        '• 啟用後在 Nexus Legacy 任一頁面都會持續執行\n\n' +
        '要啟用嗎？'
      : '啟用「海盜偵查」後：\n' +
        '• 只使用隱形艦（Stealth Ship），每個星系派 1 艘\n' +
        '• 派遣數自動取「可用船數」與「伺服器艦隊空位」較小值\n' +
        '• 每次都從家園重新計算，嚴格由近到遠\n' +
        '• 只掃描伺服器判定已冷卻完畢的星系\n' +
        '• 星系有存活海盜時跳過；消滅海盜後恢復循環\n' +
        '• 啟用後在 Nexus Legacy 任一頁面都會持續執行\n\n' +
        '要啟用嗎？'
    );
    if (!confirmed) return;

    try {
      runtime.autoScoutEnabled = true;
      runtime.autoScoutLastError = '';
      runtime.autoScoutLastAction = runtime.autoScoutMode === 'resource'
        ? '已啟用，正在尋找家園附近未偵查的礦場與氫氣田'
        : '已啟用，正在尋找家園附近可重新掃描的星系';
      saveAutoScoutState();
      renderAutoScoutPanel();
      autoScoutSoon('enabled');
    } catch (error) {
      runtime.autoScoutLastError = String(error && error.message ? error.message : error);
      renderAutoScoutPanel();
    }
  }

  function ensureAutoScoutPanel() {
    if (!document.body) return null;
    if (runtime.autoScoutPanel && runtime.autoScoutPanel.isConnected) {
      renderAutoScoutPanel();
      return runtime.autoScoutPanel;
    }

    const panel = applyStyles(document.createElement('section'), {
      position: 'fixed',
      left: '12px',
      bottom: '12px',
      zIndex: '2147483645',
      width: 'min(360px, calc(100vw - 24px))',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px',
      border: '1px solid rgba(95, 210, 255, .48)',
      borderRadius: '12px',
      background: 'rgba(5, 17, 25, .95)',
      color: '#e5f8ff',
      boxShadow: '0 8px 28px rgba(0, 0, 0, .5)',
      font: '12px/1.45 system-ui, sans-serif'
    });
    panel.id = 'nexus-auto-field-scout-panel';
    panel.dataset.nexusVersion = SCRIPT_VERSION;

    const header = applyStyles(document.createElement('div'), {
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    });
    const title = document.createElement('strong');
    title.textContent = '星系自動偵查';
    title.style.flex = '1';
    title.style.fontSize = '13px';
    const modeSelect = applyStyles(document.createElement('select'), {
      border: '1px solid rgba(95, 210, 255, .48)',
      borderRadius: '7px',
      padding: '4px 6px',
      background: '#0b2633',
      color: '#e5f8ff',
      font: '12px/1.3 system-ui, sans-serif',
      cursor: 'pointer'
    });
    modeSelect.setAttribute('aria-label', '自動偵查模式');
    for (const [value, label] of [
      ['resource', '礦＋氫偵查'],
      ['pirate', '海盜偵查']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.appendChild(option);
    }
    modeSelect.value = runtime.autoScoutMode;
    modeSelect.addEventListener('change', changeAutoScoutMode);
    header.append(title, modeSelect);

    const status = applyStyles(document.createElement('div'), {
      display: 'grid',
      gap: '2px',
      color: '#a9c7d2'
    });
    const actions = applyStyles(document.createElement('div'), {
      display: 'grid'
    });
    const toggle = applyStyles(document.createElement('button'), {
      border: '1px solid rgba(98, 255, 203, .42)',
      borderRadius: '8px',
      padding: '6px 8px',
      color: '#eafff8',
      cursor: 'pointer'
    });
    toggle.type = 'button';
    toggle.addEventListener('click', toggleAutoScout);
    actions.append(toggle);
    panel.append(header, status, actions);
    document.body.appendChild(panel);

    runtime.autoScoutPanel = panel;
    runtime.autoScoutStatusNode = status;
    runtime.autoScoutToggleButton = toggle;
    runtime.autoScoutModeSelect = modeSelect;
    renderAutoScoutPanel();
    return panel;
  }

  function scheduleAutoScoutTick() {
    clearTimeout(runtime.autoScoutTimer);
    const delay = runtime.autoScoutEnabled
      ? document.visibilityState === 'hidden' ? HIDDEN_SYNC_MS : ACTIVE_SYNC_MS
      : HIDDEN_SYNC_MS;
    runtime.autoScoutTimer = setTimeout(() => autoScoutTick('periodic'), delay);
  }

  function autoScoutSoon(reason) {
    clearTimeout(runtime.autoScoutTimer);
    runtime.autoScoutTimer = setTimeout(() => autoScoutTick(reason), 500);
  }

  async function autoScoutTick(reason) {
    ensureAutoScoutPanel();
    if (runtime.autoScoutPromise) return runtime.autoScoutPromise;

    runtime.autoScoutPromise = (async () => {
      try {
        runtime.autoScoutLastError = '';
        const snapshot = await loadAutoScoutSnapshot(runtime.autoScoutEnabled);
        if (runtime.autoScoutEnabled) {
          await dispatchAutoScoutMissions(snapshot);
        } else if (reason === 'startup' || reason === 'visible') {
          runtime.autoScoutLastAction = runtime.autoScoutMode === 'resource'
            ? '關閉中；只讀取資源偵查船與艦隊空位'
            : '關閉中；只讀取隱形艦與艦隊空位';
        }
      } catch (error) {
        runtime.autoScoutLastError = String(error && error.message ? error.message : error);
      } finally {
        renderAutoScoutPanel();
      }
    })().finally(() => {
      runtime.autoScoutPromise = null;
      scheduleAutoScoutTick();
    });
    return runtime.autoScoutPromise;
  }

  function statusText() {
    const configured = Boolean(
      String(GM_getValue(STORAGE.gasUrl, '') || '').trim() &&
      String(GM_getValue(STORAGE.secret, '') || '').trim()
    );
    const lastSync = runtime.lastSyncAt
      ? new Date(runtime.lastSyncAt).toLocaleString('zh-TW')
      : '尚未同步';
    const scoutedPirateCamps = runtime.pirateCamps.filter(
      (camp) => pirateCampComposition(camp).length > 0
    ).length;
    return [
      SCRIPT_NAME,
      '',
      'Discord：' + (configured ? '已設定' : '待設定'),
      '追蹤中的精準時間：' + Object.keys(runtime.tasks).length,
      '等待伺服器開始時間：' + runtime.waitingExact,
      '研究、建造與造船佇列：' + runtime.queueTimeline.length,
      '已偵查海盜營地：' + scoutedPirateCamps,
      '自動偵查：' + autoScoutModeLabel() + '／' +
        (runtime.autoScoutEnabled ? '執行中' : '關閉'),
      '可用偵查船／艦隊空位／本輪可派：' +
        (runtime.autoScoutMode === 'resource'
          ? runtime.autoScoutSnapshot.availableResourceScouts
          : runtime.autoScoutSnapshot.availableStealthShips) + '／' +
        runtime.autoScoutSnapshot.freeFleetSlots + '／' +
        runtime.autoScoutSnapshot.dispatchCapacity,
      '等待送 Discord：' + Object.keys(runtime.pending).length,
      '最後同步：' + lastSync,
      '目前誤差校正：' + Math.round(runtime.serverOffsetMs) + ' ms',
      runtime.lastError ? '錯誤：' + runtime.lastError : ''
    ].filter(Boolean).join('\n');
  }

  function showStatus() {
    unsafeWindow.alert(statusText());
  }

  function renderBadge() {
    if (!document.body) return;
    if (!runtime.badge || !runtime.badge.isConnected) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'nexus-exact-discord-status';
      button.addEventListener('click', () => {
        const configured = Boolean(
          String(GM_getValue(STORAGE.gasUrl, '') || '').trim() &&
          String(GM_getValue(STORAGE.secret, '') || '').trim()
        );
        if (!configured) configureDiscord();
        else toggleQueuePanel();
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        configureDiscord();
      });
      Object.assign(button.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '2147483646',
        border: '1px solid rgba(98, 255, 203, .55)',
        borderRadius: '999px',
        padding: '6px 10px',
        background: 'rgba(6, 20, 28, .92)',
        color: '#b9ffe8',
        font: '12px/1.2 system-ui, sans-serif',
        boxShadow: '0 2px 12px rgba(0,0,0,.35)',
        cursor: 'pointer',
        opacity: '.86'
      });
      button.title = '左鍵查看研究、建造與造船佇列時間；右鍵可重新設定後端與密鑰';
      document.body.appendChild(button);
      runtime.badge = button;
    }

    runtime.badge.dataset.nexusVersion = SCRIPT_VERSION;

    const configured = Boolean(
      String(GM_getValue(STORAGE.gasUrl, '') || '').trim() &&
      String(GM_getValue(STORAGE.secret, '') || '').trim()
    );
    const pendingCount = Object.keys(runtime.pending).length;
    runtime.badge.textContent = !configured
      ? 'Discord 精準通知：待設定'
      : runtime.lastError
        ? 'Discord 精準通知：需檢查'
        : pendingCount
          ? 'Discord 精準通知：待送 ' + pendingCount
          : 'Discord 精準通知：追蹤 ' + Object.keys(runtime.tasks).length +
            '｜佇列 ' + runtime.queueTimeline.length;
    runtime.badge.style.borderColor = runtime.lastError || !configured
      ? 'rgba(255, 189, 89, .75)'
      : 'rgba(98, 255, 203, .55)';
  }

  function registerMenus() {
    GM_registerMenuCommand('Nexus Discord：設定後端與密鑰', configureDiscord);
    GM_registerMenuCommand('Nexus Discord：立即同步並檢查', () => syncSoon('manual'));
    GM_registerMenuCommand('Nexus Discord：傳送測試通知', sendDiscordTest);
    GM_registerMenuCommand('Nexus Discord：查看研究、建造與造船佇列', toggleQueuePanel);
    GM_registerMenuCommand('Nexus Discord：查看狀態', showStatus);
    GM_registerMenuCommand('Nexus 星系：啟用／停止自動偵查', toggleAutoScout);
  }

  function start() {
    registerMenus();
    const onReady = () => {
      ensurePirateIntelObserver();
      renderBadge();
      ensureAutoScoutPanel();
      syncSoon('startup');
      autoScoutSoon('startup');
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      onReady();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncSoon('visible');
        autoScoutSoon('visible');
      } else {
        schedulePeriodicSync();
        scheduleAutoScoutTick();
      }
    });
    unsafeWindow.addEventListener('focus', () => {
      syncSoon('focus');
      autoScoutSoon('focus');
    });
    unsafeWindow.addEventListener('online', () => syncSoon('online'));
    unsafeWindow.addEventListener('pageshow', () => {
      syncSoon('pageshow');
      autoScoutSoon('pageshow');
    });
    unsafeWindow.addEventListener('popstate', () => autoScoutSoon('navigation'));
    unsafeWindow.addEventListener('storage', (event) => {
      if (event.key === AUTH_STORAGE_KEY) syncSoon('auth-changed');
    });

    scheduleWakeTimer();
  }

  // 只讀診斷介面，方便在瀏覽器主控台或自動測試確認追蹤狀態。
  unsafeWindow.NexusLegacyExactDiscordNotifier = Object.freeze({
    syncNow: () => syncAll('diagnostic'),
    flushDiscord: () => flushPendingDiscord(),
    getState: () => JSON.parse(JSON.stringify({
      tasks: runtime.tasks,
      pending: runtime.pending,
      sent: runtime.sent,
      queueTimeline: runtime.queueTimeline,
      shipOwnedCounts: runtime.shipCountsByPlanet,
      shipOwnedCountsUpdatedAt: runtime.shipCountsUpdatedAt,
      autoScout: {
        enabled: runtime.autoScoutEnabled,
        mode: runtime.autoScoutMode,
        snapshot: runtime.autoScoutSnapshot,
        nearestTargets: runtime.autoScoutPreviewTargets,
        lastAction: runtime.autoScoutLastAction,
        lastError: runtime.autoScoutLastError
      },
      pirateIntel: runtime.pirateCamps
        .map((camp) => ({
          id: camp && camp.id,
          planetName: pirateCampPlanetName(camp),
          composition: pirateCampComposition(camp)
        }))
        .filter((camp) => camp.planetName && camp.composition.length),
      version: SCRIPT_VERSION,
      pirateNavigation: runtime.pirateNavigation,
      waitingExact: runtime.waitingExact,
      serverOffsetMs: runtime.serverOffsetMs,
      lastSyncAt: runtime.lastSyncAt,
      lastError: runtime.lastError
    }))
  });

  start();
})();
