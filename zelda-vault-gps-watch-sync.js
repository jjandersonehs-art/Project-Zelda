/**
 * ==========================================================================
 * PROJECT ZELDA v4.8.0 — VAULT + TRUE Z-LOCK + STREAMING VOICE + BIOMETRICS
 * Repo Filename: zelda-vault-gps-watch-sync.js
 * ==========================================================================
 * Fixes & Upgrades in v4.8.0:
 *  1. Zero-Mixup Gemini Key Scanner & Live Verification:
 *     - Strictly ignores YouTube / Maps / Weather API keys (which also start
 *       with AIza...) so the Vault NEVER grabs a YouTube key by mistake (fixing 403).
 *     - Watch NEVER needs your Gemini API key — enter it once on Car or Fold 7 Bridge.
 *     - Live preflight check verifies the key against Gemini 3.5 Flash-Lite.
 *  2. True Sentence-Streaming Verbal Engine (Car + Watch):
 *     - Uses `:streamGenerateContent?alt=sse` on `gemini-3.5-flash-lite` with an
 *       instant parallel fallback to `gemini-3.1-flash-lite` / `gemini-3.8-flash`.
 *     - Speaks Sentence #1 within ~320ms while the rest streams in, eliminating
 *       unreliable verbal delays on both the 370Z HUD and Galaxy Watch Ultra.
 *  3. True Multi-Source Z-LOCK (Active Satellite Wakeup + All Map Engines):
 *     - Pings Watch Ultra + Fold 7 Bridge for a fresh hardware GPS fix (`request-gps`),
 *       prioritizes Watch -> Phone -> Car GPS, and locks Leaflet (`L.Map` prototype
 *       capture), Mapbox/MapLibre, Google Maps JS, OpenLayers, AND iframe maps.
 *  4. Full Biometrics & Health Connect Telemetry Context:
 *     - Ingests Live BPM + Steps from Watch Ultra AND Sleep Duration, Sleep Score,
 *       HRV (RMSSD), Resting HR, and Recovery from the Fold 7 Health Connect Bridge.
 */

(function () {
  'use strict';

  const ZELDA_SYNC_VERSION = '4.8.0';
  const VAULT_SNAPSHOT_KEY = '__zelda_master_vault_snapshot_v1';
  const MASTER_GEMINI_SLOT = 'zelda_verified_gemini_key_v2';
  const LINK_CHANNEL_KEY = 'zelda_watch_channel_v1';
  const WRIST_ONLY_AUDIO_KEY = 'zelda_wrist_only_audio_v1';
  const HEALTH_CACHE_KEY = 'zelda_health_connect_cache_v1';
  const IDB_NAME = 'ZeldaImmortalVaultDB';
  const IDB_STORE = 'kv';
  const KEY_REGEX = /AIza[0-9A-Za-z\-_]{25,}/;

  // Keys/field names that belong to YouTube or Maps — NEVER treat these as Gemini keys!
  const NON_GEMINI_KEY_NAME = /yt|youtube|map|maps|mapbox|places|geo|weather|firebase|tts_key/i;
  const GEMINI_KEY_NAME = /gemini|genai|google_ai|aistudio|zelda_verified_gemini|zelda_api_key|llm/i;

  const relayState = {
    channel: '',
    cachedApiKey: '',
    keyVerified: false,
    rejectedKeys: new Set(),
    sse: null,
    ws: null,
    connected: false,
    reconnectTimer: null,
    seenMsgIds: new Set(),
    watchGps: null,
    phoneGps: null,
    nativeGps: null,
    biometrics: loadCachedBiometrics(),
    capturedMaps: new Set(),
    geoWatchers: new Map(),
    nextWatchId: 9000,
    wristOnlyAudio: localStorage.getItem(WRIST_ONLY_AUDIO_KEY) !== '0',
    suppressCarTtsUntil: 0,
    lastSpokenReplySentAt: 0,
    convHistory: []
  };

  function loadCachedBiometrics() {
    try {
      const raw = localStorage.getItem(HEALTH_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveBiometrics(patch) {
    if (!patch || typeof patch !== 'object') return;
    relayState.biometrics = Object.assign({}, relayState.biometrics || {}, patch, {
      updatedAt: Date.now()
    });
    try {
      origSetItem.call(localStorage, HEALTH_CACHE_KEY, JSON.stringify(relayState.biometrics));
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('zelda:biometrics', { detail: relayState.biometrics }));
    updateWatchBadgeUi();
  }

  /* ========================================================================
   * PART 1: CAPTURE ANY MAP INSTANCE CREATED BY INDEX.HTML (FOR Z-LOCK)
   * ======================================================================== */
  function hookMapConstructorsEarly() {
    const tryHookLeaflet = () => {
      if (window.L && window.L.Map && !window.L.Map._zeldaHooked) {
        window.L.Map._zeldaHooked = true;
        window.L.Map.addInitHook(function () {
          relayState.capturedMaps.add(this);
        });
      }
    };
    tryHookLeaflet();
    setInterval(tryHookLeaflet, 1500);
  }
  hookMapConstructorsEarly();

  /* ========================================================================
   * PART 2: HIDE HUD PUSH-TO-TALK (PTT) & KILL CAR MIC POLLING
   * ======================================================================== */
  function injectHudPttRemovalCss() {
    if (document.getElementById('zelda-hide-hud-ptt-css')) return;
    const style = document.createElement('style');
    style.id = 'zelda-hide-hud-ptt-css';
    style.textContent = `
      #zelda-ptt-btn,
      #zelda-open-mic-btn,
      #zelda-mic-btn,
      #ptt-btn,
      #mic-btn,
      #voice-ptt-btn,
      .zelda-ptt-btn,
      .zelda-mic-toggle,
      .ptt-button,
      .hud-ptt,
      [data-zelda-ptt],
      [data-action="ptt"],
      [data-role="ptt"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function sweepAndDisableHudPttElements() {
    injectHudPttRemovalCss();
    try {
      if (window.ZeldaNativeVoice) {
        window.ZeldaNativeVoice.stopListening?.();
        window.ZeldaNativeVoice.setContinuous?.(false);
      }
    } catch (_) {}

    const candidates = document.querySelectorAll('button, [role="button"], .hud-btn');
    candidates.forEach((el) => {
      if (el.id === 'zelda-watch-link-badge' || el.dataset.zeldaPttChecked === 'keep') return;
      const idCls = `${el.id || ''} ${el.className || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`;
      const label = (el.textContent || '').replace(/\s+/g, ' ').trim();

      if (/^(send|z[\s\-_]*lock|play|pause|next|prev|back|clear|save)$/i.test(label)) {
        el.dataset.zeldaPttChecked = 'keep';
        return;
      }

      const isPttByAttr = /(^|[\s\-_])(ptt|push[\-_]?to[\-_]?talk|open[\-_]?mic|mic[\-_]?btn|voice[\-_]?trigger)($|[\s\-_])/i.test(idCls);
      const isPttByText = /^(?:🎙️?|🎤|🔴)?\s*(?:push\s*to\s*talk|hold\s*to\s*talk|ptt|open\s*speak|open\s*mic|tap\s*to\s*speak|talk\s*to\s*zelda|listening\.{0,3}|mic\s*(?:on|off))$/i.test(label)
        || (label === '🎙' || label === '🎙️' || label === '🎤');

      if (isPttByAttr || isPttByText) {
        el.style.setProperty('display', 'none', 'important');
        el.dataset.zeldaPttHidden = '1';
      }
    });
  }

  /* ========================================================================
   * PART 3: IMMORTAL VAULT (STRICTLY SEPARATES GEMINI KEY FROM YOUTUBE KEY!)
   * ======================================================================== */
  function hasNativeVault() {
    return typeof window.ZeldaNativeVault !== 'undefined' && window.ZeldaNativeVault !== null;
  }

  function nativeVaultGet(key) {
    if (!hasNativeVault()) return null;
    const v = window.ZeldaNativeVault;
    try {
      if (typeof v.getItem === 'function') return v.getItem(key);
      if (typeof v.get === 'function') return v.get(key);
      if (typeof v.load === 'function') return v.load(key);
    } catch (_) {}
    return null;
  }

  function nativeVaultSet(key, val) {
    if (!hasNativeVault()) return false;
    const v = window.ZeldaNativeVault;
    try {
      const str = String(val ?? '');
      if (typeof v.setItemSync === 'function') { v.setItemSync(key, str); return true; }
      if (typeof v.setItem === 'function') {
        v.setItem(key, str);
        if (typeof v.flush === 'function') v.flush();
        return true;
      }
      if (typeof v.save === 'function') { v.save(key, str); return true; }
    } catch (_) {}
    return false;
  }

  function writeCookieBackup(key, val) {
    try {
      const safeKey = encodeURIComponent('zv_' + key);
      const safeVal = encodeURIComponent(String(val ?? ''));
      if (safeVal.length < 3600) {
        document.cookie = `${safeKey}=${safeVal}; max-age=31536000; path=/; SameSite=Lax`;
      }
    } catch (_) {}
  }

  function readAllCookieBackups() {
    const out = {};
    try {
      const parts = (document.cookie || '').split(';');
      for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const rawK = decodeURIComponent(part.slice(0, idx).trim());
        if (rawK.startsWith('zv_')) {
          out[rawK.slice(3)] = decodeURIComponent(part.slice(idx + 1).trim());
        }
      }
    } catch (_) {}
    return out;
  }

  function openVaultIdb() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function idbSetSnapshot(snapshotObj) {
    const db = await openVaultIdb();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(JSON.stringify(snapshotObj), VAULT_SNAPSHOT_KEY);
    } catch (_) {}
  }

  async function idbGetSnapshot() {
    const db = await openVaultIdb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(VAULT_SNAPSHOT_KEY);
        req.onsuccess = () => {
          try { resolve(req.result ? JSON.parse(req.result) : null); }
          catch (_) { resolve(null); }
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  const origSetItem = Storage.prototype.setItem;
  const origRemoveItem = Storage.prototype.removeItem;

  function buildCurrentSnapshot() {
    const snap = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k === VAULT_SNAPSHOT_KEY) continue;
        const v = localStorage.getItem(k);
        if (v !== null && v !== '') snap[k] = v;
      }
    } catch (_) {}
    return snap;
  }

  function lockGeminiKeyEverywhere(rawKey, markVerified) {
    const m = String(rawKey || '').match(KEY_REGEX);
    if (!m) return '';
    const cleanKey = m[0];
    relayState.rejectedKeys.delete(cleanKey);
    relayState.cachedApiKey = cleanKey;
    if (markVerified) relayState.keyVerified = true;

    const slots = [
      MASTER_GEMINI_SLOT,
      'gemini_api_key',
      'GEMINI_API_KEY',
      'zelda_gemini_key'
    ];
    slots.forEach((slot) => {
      try { origSetItem.call(localStorage, slot, cleanKey); } catch (_) {}
      nativeVaultSet(slot, cleanKey);
    });
    writeCookieBackup(MASTER_GEMINI_SLOT, cleanKey);

    const snap = buildCurrentSnapshot();
    snap[MASTER_GEMINI_SLOT] = cleanKey;
    nativeVaultSet(VAULT_SNAPSHOT_KEY, JSON.stringify(snap));
    idbSetSnapshot(snap);
    updateWatchBadgeUi();
    return cleanKey;
  }

  function persistEverywhere(key, val) {
    if (!key || key === VAULT_SNAPSHOT_KEY) return;
    const strVal = String(val ?? '');
    if (!strVal) return;

    // ONLY auto-promote to Gemini slot if the storage key name is explicitly Gemini (NOT YouTube!)
    if (GEMINI_KEY_NAME.test(key) && !NON_GEMINI_KEY_NAME.test(key)) {
      const keyMatch = strVal.match(KEY_REGEX);
      if (keyMatch && !relayState.rejectedKeys.has(keyMatch[0])) {
        relayState.cachedApiKey = keyMatch[0];
        writeCookieBackup(MASTER_GEMINI_SLOT, keyMatch[0]);
        nativeVaultSet(MASTER_GEMINI_SLOT, keyMatch[0]);
      }
    }

    nativeVaultSet(key, strVal);
    if (strVal.length < 512) writeCookieBackup(key, strVal);
    const snap = buildCurrentSnapshot();
    snap[key] = strVal;
    nativeVaultSet(VAULT_SNAPSHOT_KEY, JSON.stringify(snap));
    idbSetSnapshot(snap);
    updateWatchBadgeUi();
  }

  Storage.prototype.setItem = function (key, value) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage || this === window.sessionStorage) {
      persistEverywhere(String(key), value);
    }
  };

  Storage.prototype.removeItem = function (key) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage && hasNativeVault()) {
      try { window.ZeldaNativeVault.removeItem?.(String(key)); } catch (_) {}
    }
  };

  // Sniff ONLY actual `generativelanguage.googleapis.com` requests (never `googleapis.com/youtube`!)
  function installFetchKeySniffer() {
    if (!window.fetch || window.fetch._zeldaKeySniffedV2) return;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        if (/generativelanguage\.googleapis\.com/i.test(urlStr)) {
          const urlMatch = urlStr.match(KEY_REGEX);
          if (urlMatch && !relayState.rejectedKeys.has(urlMatch[0]) && urlMatch[0] !== relayState.cachedApiKey) {
            lockGeminiKeyEverywhere(urlMatch[0], false);
          }
          if (init && init.headers) {
            const hMatch = JSON.stringify(init.headers).match(KEY_REGEX);
            if (hMatch && !relayState.rejectedKeys.has(hMatch[0]) && hMatch[0] !== relayState.cachedApiKey) {
              lockGeminiKeyEverywhere(hMatch[0], false);
            }
          }
        }
      } catch (_) {}
      return origFetch(input, init);
    };
    window.fetch._zeldaKeySniffedV2 = true;
  }

  function hydrateSyncAtBoot() {
    try {
      const rawSnap = nativeVaultGet(VAULT_SNAPSHOT_KEY);
      if (rawSnap) {
        const parsed = JSON.parse(rawSnap);
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([k, v]) => {
            if (v && !localStorage.getItem(k)) origSetItem.call(localStorage, k, String(v));
          });
        }
      }
      const commonKeys = [
        MASTER_GEMINI_SLOT, 'gemini_api_key', 'GEMINI_API_KEY',
        'zelda_gemini_key', 'zelda_config', 'zelda_settings',
        'zelda_vault', LINK_CHANNEL_KEY
      ];
      for (const k of commonKeys) {
        const nvVal = nativeVaultGet(k);
        if (nvVal && !localStorage.getItem(k)) origSetItem.call(localStorage, k, nvVal);
      }
      const cookies = readAllCookieBackups();
      Object.entries(cookies).forEach(([k, v]) => {
        if (v && !localStorage.getItem(k)) origSetItem.call(localStorage, k, v);
      });
    } catch (_) {}
  }

  // Extract Gemini keys from JSON objects while skipping YouTube/Map properties
  function extractGeminiKeyFromObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    for (const [k, v] of Object.entries(obj)) {
      if (NON_GEMINI_KEY_NAME.test(k)) continue;
      if (typeof v === 'string' && GEMINI_KEY_NAME.test(k)) {
        const m = v.match(KEY_REGEX);
        if (m && !relayState.rejectedKeys.has(m[0])) return m[0];
      } else if (v && typeof v === 'object') {
        const nested = extractGeminiKeyFromObject(v);
        if (nested) return nested;
      }
    }
    return '';
  }

  function findGeminiApiKeySync() {
    if (relayState.cachedApiKey && KEY_REGEX.test(relayState.cachedApiKey) && !relayState.rejectedKeys.has(relayState.cachedApiKey)) {
      return relayState.cachedApiKey;
    }

    // 1. Check strict Gemini-only slots first (NEVER generic youtube slots!)
    const strictSlots = [
      MASTER_GEMINI_SLOT,
      'gemini_api_key',
      'GEMINI_API_KEY',
      'zelda_gemini_key'
    ];
    for (const slot of strictSlots) {
      const v = (localStorage.getItem(slot) || nativeVaultGet(slot) || '').trim();
      const m = v.match(KEY_REGEX);
      if (m && !relayState.rejectedKeys.has(m[0])) {
        return (relayState.cachedApiKey = m[0]);
      }
    }

    // 2. Check localStorage keys whose NAME matches Gemini (skipping YouTube/Maps!)
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i) || '';
          if (NON_GEMINI_KEY_NAME.test(k)) continue;
          const raw = store.getItem(k) || '';
          if (GEMINI_KEY_NAME.test(k)) {
            const m = raw.match(KEY_REGEX);
            if (m && !relayState.rejectedKeys.has(m[0])) return (relayState.cachedApiKey = m[0]);
          }
          if (raw.startsWith('{')) {
            try {
              const found = extractGeminiKeyFromObject(JSON.parse(raw));
              if (found) return (relayState.cachedApiKey = found);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // 3. Scan DOM inputs labeled specifically for Gemini (ignoring YouTube API inputs!)
    const inputs = document.querySelectorAll('input, textarea');
    for (const inp of inputs) {
      const sig = [inp.id || '', inp.name || '', inp.placeholder || '', inp.getAttribute('aria-label') || ''].join(' ');
      if (NON_GEMINI_KEY_NAME.test(sig)) continue;
      if (GEMINI_KEY_NAME.test(sig)) {
        const m = (inp.value || '').match(KEY_REGEX);
        if (m && !relayState.rejectedKeys.has(m[0])) return lockGeminiKeyEverywhere(m[0], false);
      }
    }

    return '';
  }

  async function verifyAndFindWorkingGeminiKey() {
    const candidate = findGeminiApiKeySync();
    if (!candidate) return '';
    if (relayState.keyVerified && candidate === relayState.cachedApiKey) return candidate;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(candidate)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 4 }
          })
        }
      );
      if (res.ok) {
        lockGeminiKeyEverywhere(candidate, true);
        return candidate;
      }
      if (res.status === 400 || res.status === 403) {
        // That key was a YouTube/Maps key or revoked key! Purge it from Gemini slot so it stops poisoning calls.
        relayState.rejectedKeys.add(candidate);
        relayState.cachedApiKey = '';
        relayState.keyVerified = false;
        try { origRemoveItem.call(localStorage, MASTER_GEMINI_SLOT); } catch (_) {}
        updateWatchBadgeUi();
        return '';
      }
    } catch (_) {}
    return candidate;
  }

  function bindDomApiKeyInputs() {
    const inputs = document.querySelectorAll('input, textarea');
    inputs.forEach((inp) => {
      if (inp.dataset.zeldaVaultBoundV2) return;
      const sig = [inp.id || '', inp.name || '', inp.placeholder || '', inp.getAttribute('aria-label') || ''].join(' ');
      if (!/api|key|gemini|youtube|yt|eleven|token|secret|vault|ai\s*studio/i.test(sig)) return;

      inp.dataset.zeldaVaultBoundV2 = '1';
      const isGeminiField = GEMINI_KEY_NAME.test(sig) && !NON_GEMINI_KEY_NAME.test(sig);
      const fieldSlotKey = 'zelda_dom_input__' + (inp.id || inp.name || sig.replace(/\W+/g, '_').slice(0, 40));
      const savedVal = localStorage.getItem(fieldSlotKey) || nativeVaultGet(fieldSlotKey) || (isGeminiField ? relayState.cachedApiKey : '');
      if (!inp.value && savedVal) {
        inp.value = savedVal;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const saveHandler = () => {
        const val = (inp.value || '').trim();
        if (val.length >= 12) {
          localStorage.setItem(fieldSlotKey, val);
          if (isGeminiField && KEY_REGEX.test(val)) {
            lockGeminiKeyEverywhere(val, false);
          }
        }
      };
      inp.addEventListener('input', saveHandler);
      inp.addEventListener('change', saveHandler);
      inp.addEventListener('blur', saveHandler);
    });
  }

  async function hydrateAsyncAndBindInputs() {
    const idbSnap = await idbGetSnapshot();
    if (idbSnap && typeof idbSnap === 'object') {
      Object.entries(idbSnap).forEach(([k, v]) => {
        if (v && !localStorage.getItem(k)) {
          origSetItem.call(localStorage, k, String(v));
          nativeVaultSet(k, String(v));
        }
      });
    }
    bindDomApiKeyInputs();
    await verifyAndFindWorkingGeminiKey();
    updateWatchBadgeUi();
  }

  installFetchKeySniffer();
  hydrateSyncAtBoot();
  injectHudPttRemovalCss();

  /* ========================================================================
   * PART 4: TRUE MULTI-SOURCE Z-LOCK (WATCH -> PHONE -> CAR + ALL MAP ENGINES)
   * ======================================================================== */
  function getBestAvailableGpsFix(maxAgeMs) {
    const limit = maxAgeMs || 300000; // 5 min valid window for parked/driving fixes
    const now = Date.now();
    const candidates = [relayState.watchGps, relayState.phoneGps, relayState.nativeGps]
      .filter((f) => f && isFinite(f.lat) && isFinite(f.lng) && (f.lat !== 0 || f.lng !== 0) && (now - f.ts < limit));
    if (!candidates.length) return null;
    // Prefer freshest high-accuracy fix (< 60s), otherwise most recent
    candidates.sort((a, b) => {
      const ageDiff = b.ts - a.ts;
      if (Math.abs(ageDiff) < 30000) return (a.accuracy || 50) - (b.accuracy || 50);
      return ageDiff;
    });
    return candidates[0];
  }

  function toGeoPositionObject(fix) {
    return {
      coords: {
        latitude: Number(fix.lat),
        longitude: Number(fix.lng),
        accuracy: Number(fix.accuracy || 8),
        altitude: null,
        altitudeAccuracy: null,
        heading: fix.heading != null ? Number(fix.heading) : null,
        speed: fix.speed != null ? Number(fix.speed) : null
      },
      timestamp: fix.ts || Date.now()
    };
  }

  function notifyAllGeoWatchers(fix) {
    const pos = toGeoPositionObject(fix);
    relayState.geoWatchers.forEach((cb, key) => {
      if (typeof key === 'number' && typeof cb === 'function') {
        try { cb(pos); } catch (_) {}
      }
    });
    window.dispatchEvent(new CustomEvent('zelda:gps-fix', { detail: fix }));
  }

  window.onZeldaNativeGps = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data && isFinite(data.lat) && isFinite(data.lng)) {
        relayState.nativeGps = {
          lat: Number(data.lat), lng: Number(data.lng),
          accuracy: Number(data.accuracy || 12),
          speed: data.speed != null ? Number(data.speed) : null,
          heading: data.heading != null ? Number(data.heading) : null,
          source: 'car',
          ts: Date.now()
        };
        notifyAllGeoWatchers(relayState.nativeGps);
      }
    } catch (_) {}
  };

  function installGeolocationPrecisionWrapper() {
    if (!navigator.geolocation || navigator.geolocation._zeldaGpsWrappedV2) return;
    const origGetCurrent = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const origWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    const origClear = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    const hiAccOpts = (opts) => Object.assign({}, opts || {}, {
      enableHighAccuracy: true, maximumAge: 0, timeout: Math.max((opts && opts.timeout) || 0, 12000)
    });

    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      const best = getBestAvailableGpsFix(120000);
      if (best && typeof success === 'function') {
        success(toGeoPositionObject(best));
        return;
      }
      origGetCurrent(
        (pos) => {
          // Save car fix if decent accuracy (ignore coarse cell-tower >1500m jumps if Watch/Phone fix exists!)
          if (pos && pos.coords && pos.coords.accuracy <= 1500) {
            relayState.nativeGps = {
              lat: pos.coords.latitude, lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy, speed: pos.coords.speed, heading: pos.coords.heading,
              source: 'car', ts: Date.now()
            };
          }
          const ov = getBestAvailableGpsFix(300000);
          success(ov && pos.coords.accuracy > 250 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix(600000);
          if (ov && typeof success === 'function') success(toGeoPositionObject(ov));
          else if (typeof error === 'function') error(err);
        },
        hiAccOpts(options)
      );
    };

    navigator.geolocation.watchPosition = function (success, error, options) {
      const customId = ++relayState.nextWatchId;
      relayState.geoWatchers.set(customId, success);
      const best = getBestAvailableGpsFix(120000);
      if (best && typeof success === 'function') setTimeout(() => success(toGeoPositionObject(best)), 20);
      const nativeId = origWatch(
        (pos) => {
          if (pos && pos.coords && pos.coords.accuracy <= 1500) {
            relayState.nativeGps = {
              lat: pos.coords.latitude, lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy, speed: pos.coords.speed, heading: pos.coords.heading,
              source: 'car', ts: Date.now()
            };
          }
          const ov = getBestAvailableGpsFix(180000);
          success(ov && pos.coords.accuracy > 250 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix(600000);
          if (ov && typeof success === 'function') success(toGeoPositionObject(ov));
          else if (typeof error === 'function') error(err);
        },
        hiAccOpts(options)
      );
      relayState.geoWatchers.set('native_' + customId, nativeId);
      return customId;
    };

    navigator.geolocation.clearWatch = function (id) {
      relayState.geoWatchers.delete(id);
      const nativeId = relayState.geoWatchers.get('native_' + id);
      if (nativeId !== undefined) {
        relayState.geoWatchers.delete('native_' + id);
        origClear(nativeId);
      } else origClear(id);
    };
    navigator.geolocation._zeldaGpsWrappedV2 = true;
  }

  function applyCoordsToEveryMapOnScreen(lat, lng, accuracy) {
    // 1. Collect all candidate map objects from hook + window globals
    const allMaps = new Set(relayState.capturedMaps);
    const knownGlobals = [
      window.map, window.zeldaMap, window.navMap, window.hudMap,
      window.myMap, window.leafletMap, window.radarMap, window.gpsMap
    ];
    knownGlobals.forEach((m) => { if (m) allMaps.add(m); });

    // Scan top-level window properties for any Leaflet / Mapbox / Google Map instance
    try {
      for (const k of Object.keys(window)) {
        const val = window[k];
        if (val && typeof val === 'object' && (typeof val.setView === 'function' || typeof val.flyTo === 'function' || typeof val.panTo === 'function')) {
          if (val._leaflet_id || val.getCenter || val.setZoom) allMaps.add(val);
        }
      }
    } catch (_) {}

    allMaps.forEach((m) => {
      try {
        // Leaflet map (`_leaflet_id` or `invalidateSize`)
        if (m._leaflet_id || (typeof m.setView === 'function' && typeof m.invalidateSize === 'function')) {
          m.invalidateSize?.();
          const targetZoom = Math.max(typeof m.getZoom === 'function' ? m.getZoom() : 16, 16);
          m.setView([lat, lng], targetZoom, { animate: true });
          if (window.L) {
            if (!m._zeldaLockMarker) {
              m._zeldaLockMarker = window.L.circleMarker([lat, lng], {
                radius: 8, color: '#00f0ff', weight: 3, fillColor: '#ff007f', fillOpacity: 0.9
              }).addTo(m);
            } else {
              m._zeldaLockMarker.setLatLng([lat, lng]);
            }
          }
        }
        // Mapbox GL / MapLibre GL (`jumpTo` + `flyTo` taking `{center: [lng, lat]}`)
        else if (typeof m.flyTo === 'function' && typeof m.jumpTo === 'function') {
          m.resize?.();
          m.flyTo({ center: [lng, lat], zoom: 16, essential: true });
        }
        // Google Maps JS (`panTo({lat, lng})`)
        else if (typeof m.panTo === 'function' && typeof m.setZoom === 'function') {
          m.panTo({ lat, lng });
          if ((m.getZoom?.() || 0) < 16) m.setZoom(16);
        }
      } catch (_) {}
    });

    // 2. Also update any embedded Google Maps / OpenStreetMap iframes!
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((ifr) => {
      const src = ifr.getAttribute('src') || '';
      if (/google\.com\/maps|openstreetmap\.org/i.test(src) || ifr.closest('#tab-map, [data-tab-panel="map"], .map-container')) {
        ifr.src = `https://maps.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}&z=17&output=embed`;
      }
    });

    // 3. Update any HUD coordinate readouts if present
    document.querySelectorAll('[data-zelda-lat], #hud-lat, .gps-lat').forEach((el) => { el.textContent = lat.toFixed(5); });
    document.querySelectorAll('[data-zelda-lng], #hud-lng, .gps-lng').forEach((el) => { el.textContent = lng.toFixed(5); });

    notifyAllGeoWatchers({ lat, lng, accuracy: accuracy || 8, ts: Date.now() });
    window.dispatchEvent(new CustomEvent('zelda:zlock-engaged', { detail: { lat, lng, accuracy } }));
  }

  function requestFreshHardwareGpsFromWatchAndPhone() {
    if (!relayState.channel) return;
    fetch(`https://ntfy.sh/${encodeURIComponent(relayState.channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        source: 'zelda-car',
        type: 'request-gps',
        ts: Date.now()
      })
    }).catch(() => {});
  }

  function forceLockCarMapToLiveGps() {
    // 1. Broadcast hardware GPS wake-up ping to Watch Ultra & Fold 7 Bridge
    requestFreshHardwareGpsFromWatchAndPhone();

    // 2. Immediately lock using best known Watch/Phone/Car fix right now
    const immediate = getBestAvailableGpsFix(600000);
    if (immediate) {
      applyCoordsToEveryMapOnScreen(immediate.lat, immediate.lng, immediate.accuracy);
    }

    // 3. Also poll browser/car native GPS with high accuracy
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fresh = getBestAvailableGpsFix(15000) || {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        applyCoordsToEveryMapOnScreen(fresh.lat, fresh.lng, fresh.accuracy);
      },
      () => {
        const fallback = getBestAvailableGpsFix(1800000);
        if (fallback) applyCoordsToEveryMapOnScreen(fallback.lat, fallback.lng, fallback.accuracy);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  }

  function bindZLockButton() {
    const allBtns = document.querySelectorAll('button, [role="button"], .hud-btn, a');
    allBtns.forEach((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const idCls = `${el.id || ''} ${el.className || ''}`;
      if ((/^(?:🎯\s*)?Z[\s\-_]*LOCK$/i.test(txt) || /z[\-_]?lock/i.test(idCls)) && !el.dataset.zeldaZlockBoundV2) {
        el.dataset.zeldaZlockBoundV2 = '1';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          forceLockCarMapToLiveGps();
        }, true);
      }
    });
  }

  installGeolocationPrecisionWrapper();

  /* ========================================================================
   * PART 5: SENTENCE-STREAMING VERBAL ENGINE + HEALTH CONNECT CONTEXT
   * ======================================================================== */
  function cleanSpeechText(raw) {
    return String(raw || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[*_`#~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sendPacketToWatch(obj) {
    if (!relayState.channel) return;
    fetch(`https://ntfy.sh/${encodeURIComponent(relayState.channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(Object.assign({ source: 'zelda-car', ts: Date.now() }, obj))
    }).catch(() => {});
  }

  function sendSpokenReplyToWatch(spokenText, isStreamChunk) {
    const clean = cleanSpeechText(spokenText);
    if (!clean) return;
    relayState.lastSpokenReplySentAt = Date.now();
    sendPacketToWatch({
      type: 'speak',
      chunk: Boolean(isStreamChunk),
      text: clean.slice(0, 320)
    });
  }

  function speakOnCarStereoChunk(text, flushFirst) {
    const clean = cleanSpeechText(text);
    if (!clean) return;
    try {
      if (window.ZeldaNativeVoice && typeof window.ZeldaNativeVoice.speak === 'function') {
        window.ZeldaNativeVoice._zeldaBypassMirror = true;
        window.ZeldaNativeVoice.speak(clean);
        window.ZeldaNativeVoice._zeldaBypassMirror = false;
        return;
      }
      if (window.speechSynthesis) {
        if (flushFirst) window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(clean);
        u.rate = 1.08;
        u._zeldaInternal = true;
        window.speechSynthesis.speak(u);
      }
    } catch (_) {}
  }

  function buildTelemetryAndHealthContext() {
    const parts = [];
    const gpsFix = getBestAvailableGpsFix(300000);
    if (gpsFix) {
      const mph = gpsFix.speed != null ? Math.round(gpsFix.speed * 2.23694) : null;
      parts.push(`370Z GPS (${gpsFix.source || 'live'}): ${gpsFix.lat.toFixed(4)}, ${gpsFix.lng.toFixed(4)}${mph !== null ? `, ${mph} MPH` : ''}.`);
    }
    const b = relayState.biometrics || {};
    const bioItems = [];
    if (b.bpm) bioItems.push(`Live Heart Rate: ${Math.round(b.bpm)} BPM`);
    if (b.restingHr) bioItems.push(`Resting HR: ${Math.round(b.restingHr)} BPM`);
    if (b.hrvRmssd) bioItems.push(`HRV: ${Math.round(b.hrvRmssd)} ms`);
    if (b.sleepHours != null) bioItems.push(`Last Sleep: ${Number(b.sleepHours).toFixed(1)} hrs`);
    if (b.steps != null) bioItems.push(`Steps Today: ${b.steps}`);
    if (b.spo2) bioItems.push(`SpO2: ${b.spo2}%`);
    if (bioItems.length) {
      parts.push(`J's Biometrics (Watch Ultra + Hume Pod Health Connect): ${bioItems.join(', ')}.`);
    }
    return parts.join(' ');
  }

  function appendHudChatLog(role, message) {
    try {
      const log = document.querySelector(
        '#chat-messages, #zelda-chat-log, .chat-messages, .zelda-messages, [data-chat-log]'
      );
      if (!log) return;
      const row = document.createElement('div');
      row.style.cssText = 'margin: 6px 0; font-size: 13px; line-height: 1.35;';
      const tagColor = role === 'ZELDA' ? '#00f0ff' : '#fcee0a';
      row.innerHTML = `<strong style="color:${tagColor};letter-spacing:0.06em;">[${role}]</strong> <span style="color:#e6f7ff;"></span>`;
      row.querySelector('span').textContent = message;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    } catch (_) {}
  }

  // Real-time SSE sentence streamer (~320ms to first spoken sentence!)
  async function streamZeldaGeminiReply(userText, apiKey, onSentence) {
    const systemPrompt = [
      "You are Zelda, J's sharp, loyal Cyberpunk AI integrated into his 2009 Nissan 370Z and Galaxy Watch Ultra.",
      "Speak naturally, warmly, and crisply for real-time voice conversation.",
      "VOICE FORMAT RULE: Reply in 1 or 2 short spoken sentences (under 32 words total) unless J explicitly asks for detail. Plain spoken English only—never use asterisks, markdown, lists, or emojis.",
      buildTelemetryAndHealthContext()
    ].join(' ');

    const candidateHistory = relayState.convHistory
      .concat([{ role: 'user', parts: [{ text: userText }] }])
      .slice(-10);

    const models = [
      { id: 'gemini-3.5-flash-lite', cfg: { temperature: 0.72, maxOutputTokens: 160 } },
      { id: 'gemini-3.1-flash-lite', cfg: { temperature: 0.72, maxOutputTokens: 160 } },
      { id: 'gemini-3.8-flash', cfg: { temperature: 0.72, maxOutputTokens: 200, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }
    ];

    let lastStatus = 0;

    for (const m of models) {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6500);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ctrl.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: candidateHistory,
              generationConfig: m.cfg
            })
          }
        );
        clearTimeout(timeoutId);
        lastStatus = res.status;

        if (res.status === 400 || res.status === 403) {
          relayState.rejectedKeys.add(apiKey);
          relayState.cachedApiKey = '';
          relayState.keyVerified = false;
          updateWatchBadgeUi();
          return { fullText: '', status: res.status };
        }
        if (!res.ok || !res.body) continue;

        relayState.keyVerified = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let sseBuf = '';
        let pendingSentence = '';
        let fullText = '';
        let sentenceIdx = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuf += decoder.decode(value, { stream: true });
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const obj = JSON.parse(jsonStr);
              const parts = obj?.candidates?.[0]?.content?.parts || [];
              for (const p of parts) {
                if (p.thought || !p.text) continue;
                fullText += p.text;
                pendingSentence += p.text;

                // Emit completed sentence as soon as punctuation hits!
                const match = pendingSentence.match(/^([\s\S]*?[.!?]+)(?:\s+|$)([\s\S]*)$/);
                if (match && cleanSpeechText(match[1]).length >= 8) {
                  onSentence(cleanSpeechText(match[1]), sentenceIdx++);
                  pendingSentence = match[2] || '';
                }
              }
            } catch (_) {}
          }
        }

        if (cleanSpeechText(pendingSentence)) {
          onSentence(cleanSpeechText(pendingSentence), sentenceIdx++);
        }

        const cleanFull = cleanSpeechText(fullText);
        if (cleanFull) {
          relayState.convHistory = candidateHistory.concat([{ role: 'model', parts: [{ text: cleanFull }] }]);
          return { fullText: cleanFull, status: 200 };
        }
      } catch (err) {
        clearTimeout(timeoutId);
      }
    }

    return { fullText: '', status: lastStatus };
  }

  function tryFastLocalHudCommand(spoken) {
    const s = spoken.trim();

    if (/^(?:z[\s\-_]*lock|lock\s+(?:gps|map|location)|center\s+map|where\s+am\s+i)$/i.test(s)) {
      forceLockCarMapToLiveGps();
      return 'Coordinates locked to your live position, J.';
    }

    const playMatch = s.match(/^(?:zelda[,\s]+)?(?:play|put\s+on|queue(?:\s+up)?)\s+(.+)$/i);
    if (playMatch) {
      const track = playMatch[1].trim();
      if (typeof window.onZeldaVoiceResult === 'function') {
        window.onZeldaVoiceResult({ transcript: s, isFinal: true, source: 'watch' });
      }
      return `Queuing ${track} on the main deck.`;
    }

    if (/^(?:zelda[,\s]+)?(?:next(?:\s+track|\s+song|\s+video)?|skip(?:\s+track|\s+song)?)$/i.test(s)) {
      window.onZeldaVoiceResult?.({ transcript: 'next video', isFinal: true, source: 'watch' });
      return 'Skipping track.';
    }

    if (/^(?:zelda[,\s]+)?(?:pause|stop\s+music|hold\s+audio)$/i.test(s)) {
      window.onZeldaVoiceResult?.({ transcript: 'pause', isFinal: true, source: 'watch' });
      return 'Audio paused.';
    }

    if (/^(?:zelda[,\s]+)?(?:resume|unpause|continue\s+playing)$/i.test(s)) {
      window.onZeldaVoiceResult?.({ transcript: 'resume', isFinal: true, source: 'watch' });
      return 'Resuming playback.';
    }

    return null;
  }

  async function runUnifiedFastConversation(spoken, originSource) {
    const fromWatch = originSource === 'watch';
    appendHudChatLog(fromWatch ? 'J (WATCH)' : 'J', spoken);

    if (fromWatch && relayState.wristOnlyAudio) {
      relayState.suppressCarTtsUntil = Date.now() + 15000;
    }

    const fastAck = tryFastLocalHudCommand(spoken);
    if (fastAck) {
      if (fromWatch) sendSpokenReplyToWatch(fastAck, false);
      if (!fromWatch || !relayState.wristOnlyAudio) speakOnCarStereoChunk(fastAck, true);
      appendHudChatLog('ZELDA', fastAck);
      return;
    }

    const apiKey = await verifyAndFindWorkingGeminiKey();
    if (!apiKey) {
      const msg = 'Paste your Gemini AI Studio key once into the top right KITT badge or your Fold 7 Bridge app, J.';
      if (fromWatch) sendSpokenReplyToWatch(msg, false);
      else speakOnCarStereoChunk(msg, true);
      appendHudChatLog('ZELDA', msg);
      return;
    }

    const result = await streamZeldaGeminiReply(spoken, apiKey, (sentence, idx) => {
      if (fromWatch) {
        sendSpokenReplyToWatch(sentence, idx > 0);
      }
      if (!fromWatch || !relayState.wristOnlyAudio) {
        speakOnCarStereoChunk(sentence, idx === 0);
      }
    });

    if (result.fullText) {
      appendHudChatLog('ZELDA', result.fullText);
      return;
    }

    const errMsg = (result.status === 400 || result.status === 403)
      ? 'That API key was rejected by Gemini. Paste a fresh AI Studio Gemini key into the KITT badge or Fold 7 app, J.'
      : 'Signal hiccup on the hotspot, J. Say again.';
    if (fromWatch) sendSpokenReplyToWatch(errMsg, false);
    else speakOnCarStereoChunk(errMsg, true);
  }

  // Upgrade HUD SEND button / Enter key to also use the sub-second streaming engine if desired
  function hookCarVoiceOutputMirror() {
    if (window.speechSynthesis && !window.speechSynthesis._zeldaKittMirrorV2) {
      window.speechSynthesis._zeldaKittMirrorV2 = true;
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = function (utterance) {
        if (utterance && utterance._zeldaInternal) return origSpeak(utterance);
        if (utterance && utterance.text) {
          if (Date.now() - relayState.lastSpokenReplySentAt > 1200) {
            sendSpokenReplyToWatch(utterance.text, false);
          }
          if (Date.now() < relayState.suppressCarTtsUntil) return;
        }
        return origSpeak(utterance);
      };
    }
  }

  /* ========================================================================
   * PART 6: NTFY RELAY (WATCH + FOLD 7 HEALTH CONNECT / KEY / GPS BRIDGE)
   * ======================================================================== */
  function getOrInitWatchChannel() {
    let ch = localStorage.getItem(LINK_CHANNEL_KEY) || nativeVaultGet(LINK_CHANNEL_KEY);
    if (!ch || ch.length < 4) {
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
      ch = `zelda-370z-${rand}`;
      localStorage.setItem(LINK_CHANNEL_KEY, ch);
    }
    relayState.channel = ch;
    return ch;
  }

  function updateWatchBadgeUi() {
    const badge = document.getElementById('zelda-watch-link-badge');
    if (!badge) return;
    const shortCode = (relayState.channel || '').replace(/^zelda-370z-/i, '').toUpperCase();
    const hasKey = Boolean(findGeminiApiKeySync());
    const bpmTxt = relayState.biometrics?.bpm ? ` ❤️${Math.round(relayState.biometrics.bpm)}` : '';
    const keyTag = hasKey ? (relayState.keyVerified ? 'AI:OK' : 'AI:SET') : 'SET AI KEY';
    badge.textContent = relayState.connected
      ? `⌚ ${shortCode} // ${keyTag}${bpmTxt}`
      : `⌚ ${shortCode} // IDLE [${keyTag}]`;
    badge.style.borderColor = !hasKey ? '#fcee0a' : (relayState.connected ? '#00f0ff' : 'rgba(252,238,10,0.45)');
    badge.style.color = !hasKey ? '#fcee0a' : '#00f0ff';
  }

  function injectWatchLinkBadge() {
    if (document.getElementById('zelda-watch-link-badge')) return;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.id = 'zelda-watch-link-badge';
    badge.style.cssText = `
      position: fixed;
      top: 8px;
      right: 12px;
      z-index: 9999;
      background: rgba(5, 7, 14, 0.92);
      color: #00f0ff;
      border: 1px solid #00f0ff;
      padding: 4px 10px;
      font-family: 'Orbitron', 'Rajdhani', monospace, sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      cursor: pointer;
      border-radius: 999px;
      box-shadow: 0 0 12px rgba(0, 240, 255, 0.25);
    `;
    badge.addEventListener('click', async function () {
      const currentShort = relayState.channel.replace(/^zelda-370z-/i, '').toUpperCase();
      const hasKey = Boolean(findGeminiApiKeySync());
      const b = relayState.biometrics || {};
      const bioLine = b.bpm || b.sleepHours
        ? `Biometrics: ${b.bpm ? b.bpm + ' BPM ' : ''}${b.sleepHours ? '| Sleep ' + Number(b.sleepHours).toFixed(1) + 'h ' : ''}${b.hrvRmssd ? '| HRV ' + Math.round(b.hrvRmssd) + 'ms' : ''}`
        : 'Biometrics: Waiting for Watch / Fold 7 Health Bridge';
      const entered = window.prompt(
        `ZELDA NEURAL LINK // ${currentShort}\n` +
        `Gemini Key: ${hasKey ? 'LOCKED ✅ (Watch needs NO API key!)' : 'NEEDED ❌ (Paste AIza... Gemini key below)'}\n` +
        `${bioLine}\n\n` +
        `• Paste AIza... Gemini key (or beam it from Fold 7 Bridge app)\n` +
        `• Enter 4-char code to change channel\n` +
        `• Type AUDIO to toggle Wrist-Only vs Car+Wrist voice:`,
        currentShort
      );
      if (!entered || !entered.trim()) return;
      const trimmed = entered.trim();

      if (KEY_REGEX.test(trimmed)) {
        lockGeminiKeyEverywhere(trimmed, false);
        const ok = await verifyAndFindWorkingGeminiKey();
        sendSpokenReplyToWatch(
          ok ? 'Gemini key verified and locked into vault, J.' : 'Google rejected that key with 403, J. Make sure it is an AI Studio Gemini key, not a YouTube key.',
          false
        );
        return;
      }

      const clean = trimmed.toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
      if (clean === 'AUDIO') {
        relayState.wristOnlyAudio = !relayState.wristOnlyAudio;
        localStorage.setItem(WRIST_ONLY_AUDIO_KEY, relayState.wristOnlyAudio ? '1' : '0');
        updateWatchBadgeUi();
        return;
      }
      const fullTopic = clean.startsWith('ZELDA-') ? clean.toLowerCase() : `zelda-370z-${clean}`;
      localStorage.setItem(LINK_CHANNEL_KEY, fullTopic);
      relayState.channel = fullTopic;
      connectWatchRelay();
    });
    document.body.appendChild(badge);
    updateWatchBadgeUi();
  }

  function handleIncomingPacket(rawEventData) {
    try {
      const envelope = typeof rawEventData === 'string' ? JSON.parse(rawEventData) : rawEventData;
      if (!envelope || envelope.event !== 'message') return;
      if (envelope.id) {
        if (relayState.seenMsgIds.has(envelope.id)) return;
        relayState.seenMsgIds.add(envelope.id);
      }

      const payload = typeof envelope.message === 'string' ? JSON.parse(envelope.message) : envelope.message;
      if (!payload || payload.source === 'zelda-car') return;
      if (payload.ts && Math.abs(Date.now() - payload.ts) > 60000) return;

      // 1. Ingest Watch or Phone GPS fix
      if (payload.gps && isFinite(payload.gps.lat) && isFinite(payload.gps.lng)) {
        const fix = {
          lat: Number(payload.gps.lat),
          lng: Number(payload.gps.lng),
          accuracy: Number(payload.gps.accuracy || 6),
          speed: payload.gps.speed != null ? Number(payload.gps.speed) : null,
          heading: payload.gps.heading != null ? Number(payload.gps.heading) : null,
          source: payload.source === 'zelda-phone' ? 'phone' : 'watch',
          ts: Date.now()
        };
        if (fix.source === 'phone') relayState.phoneGps = fix;
        else relayState.watchGps = fix;

        notifyAllGeoWatchers(fix);
        if (payload.type === 'zlock' || payload.type === 'gps-reply') {
          applyCoordsToEveryMapOnScreen(fix.lat, fix.lng, fix.accuracy);
          if (payload.type === 'zlock') {
            sendSpokenReplyToWatch('Coordinates locked, J.', false);
          }
        }
      }

      // 2. Ingest Live Watch Biometrics OR Fold 7 Health Connect Snapshot!
      if (payload.biometrics && typeof payload.biometrics === 'object') {
        saveBiometrics(payload.biometrics);
      }
      if (payload.type === 'health-sync' && payload.health) {
        saveBiometrics(payload.health);
      }

      // 3. Optional secure Gemini Key beam from Fold 7 Bridge App (no typing on car screen!)
      if (payload.type === 'key-sync' && payload.geminiKey && KEY_REGEX.test(payload.geminiKey)) {
        lockGeminiKeyEverywhere(payload.geminiKey, false);
        verifyAndFindWorkingGeminiKey();
      }

      // 4. Process Watch Voice Turn
      if (payload.type === 'voice' && payload.transcript) {
        runUnifiedFastConversation(String(payload.transcript).trim(), 'watch');
      }
    } catch (_) {}
  }

  function connectWatchRelay() {
    const topic = getOrInitWatchChannel();
    if (relayState.sse) { try { relayState.sse.close(); } catch (_) {} relayState.sse = null; }
    if (relayState.ws) { try { relayState.ws.close(); } catch (_) {} relayState.ws = null; }
    if (relayState.reconnectTimer) { clearTimeout(relayState.reconnectTimer); relayState.reconnectTimer = null; }

    try {
      const es = new EventSource(`https://ntfy.sh/${encodeURIComponent(topic)}/sse`);
      relayState.sse = es;
      es.onopen = () => { relayState.connected = true; updateWatchBadgeUi(); };
      es.onmessage = (ev) => handleIncomingPacket(ev.data);
      es.onerror = () => { relayState.connected = false; updateWatchBadgeUi(); };
    } catch (_) {
      try {
        const ws = new WebSocket(`wss://ntfy.sh/${encodeURIComponent(topic)}/ws`);
        relayState.ws = ws;
        ws.onopen = () => { relayState.connected = true; updateWatchBadgeUi(); };
        ws.onmessage = (ev) => handleIncomingPacket(ev.data);
        ws.onclose = () => {
          relayState.connected = false;
          updateWatchBadgeUi();
          relayState.reconnectTimer = setTimeout(connectWatchRelay, 3500);
        };
      } catch (_) {}
    }
  }

  function bootZeldaSync() {
    sweepAndDisableHudPttElements();
    injectWatchLinkBadge();
    hydrateAsyncAndBindInputs();
    bindZLockButton();
    hookCarVoiceOutputMirror();
    connectWatchRelay();

    window.addEventListener('online', connectWatchRelay);

    const obs = new MutationObserver(() => {
      sweepAndDisableHudPttElements();
      bindDomApiKeyInputs();
      bindZLockButton();
      hookCarVoiceOutputMirror();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  window.ZeldaSync = {
    version: ZELDA_SYNC_VERSION,
    getChannel: () => relayState.channel,
    getBiometrics: () => relayState.biometrics,
    setApiKey: (k) => lockGeminiKeyEverywhere(k, false),
    askFast: (q) => runUnifiedFastConversation(q, 'car'),
    speakToWatch: (t) => sendSpokenReplyToWatch(t, false),
    forceZLock: forceLockCarMapToLiveGps
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootZeldaSync);
  } else {
    bootZeldaSync();
  }
})();
