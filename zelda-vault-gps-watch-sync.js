/**
 * ==========================================================================
 * PROJECT ZELDA v4.7.0 — VAULT + Z-LOCK GPS + KITT WATCH VOICE COMLINK
 * Repo Filename: zelda-vault-gps-watch-sync.js
 * ==========================================================================
 * Upgrades in v4.7.0:
 *  1. HUD PTT Removal & Car Mic Kill-Switch:
 *     - Hides Push-to-Talk (PTT), Open Speak, and Mic clutter on the 370Z HUD.
 *     - Stops background car-mic polling so XYAuto audio focus stays clean.
 *  2. Sub-Second Turbo Brain for Fluent Watch Conversation:
 *     - Instant (<50ms) local command router for YouTube transport & Z-LOCK.
 *     - Direct low-latency Gemini 2.5 Flash fast-path (thinkingBudget: 0,
 *       rolling 10-turn memory, live Watch GPS context) for ~500ms responses.
 *     - Full fallback interceptor for HUD fetch / speechSynthesis / NativeVoice.
 *  3. Wrist-First KITT Audio Routing:
 *     - Streams spoken replies (`type: "speak"`) directly to Galaxy Watch Ultra's
 *       speaker + 3-bar KITT Voice Modulator while keeping 370Z music uninterrupted.
 */

(function () {
  'use strict';

  const ZELDA_SYNC_VERSION = '4.7.0';
  const VAULT_SNAPSHOT_KEY = '__zelda_master_vault_snapshot_v1';
  const LINK_CHANNEL_KEY = 'zelda_watch_channel_v1';
  const WRIST_ONLY_AUDIO_KEY = 'zelda_wrist_only_audio_v1';
  const IDB_NAME = 'ZeldaImmortalVaultDB';
  const IDB_STORE = 'kv';

  const relayState = {
    channel: '',
    sse: null,
    ws: null,
    connected: false,
    reconnectTimer: null,
    lastMsgId: '',
    remoteGps: null,
    nativeGps: null,
    geoWatchers: new Map(),
    nextWatchId: 9000,
    wristOnlyAudio: localStorage.getItem(WRIST_ONLY_AUDIO_KEY) !== '0',
    suppressCarTtsUntil: 0,
    lastSpokenReplySentAt: 0,
    convHistory: []
  };

  /* ========================================================================
   * PART 1: HIDE HUD PUSH-TO-TALK (PTT) & KILL CAR MIC POLLING
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
        if (typeof window.ZeldaNativeVoice.stopListening === 'function') {
          window.ZeldaNativeVoice.stopListening();
        }
        if (typeof window.ZeldaNativeVoice.setContinuous === 'function') {
          window.ZeldaNativeVoice.setContinuous(false);
        }
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
   * PART 2: IMMORTAL API KEY VAULT (SURVIVES CAR IGNITION OFF & ORIGIN SPLIT)
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

  function isImportantVaultKey(k) {
    return k && /api|key|gemini|openai|eleven|token|secret|zelda|voice|map|mapbox|google|cfg|config|setting|vault|channel/i.test(k);
  }

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

  function persistEverywhere(key, val) {
    if (!key || key === VAULT_SNAPSHOT_KEY) return;
    const strVal = String(val ?? '');
    if (!strVal) return;
    nativeVaultSet(key, strVal);
    if (isImportantVaultKey(key) && strVal.length < 512) writeCookieBackup(key, strVal);
    const snap = buildCurrentSnapshot();
    snap[key] = strVal;
    nativeVaultSet(VAULT_SNAPSHOT_KEY, JSON.stringify(snap));
    idbSetSnapshot(snap);
  }

  Storage.prototype.setItem = function (key, value) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage) persistEverywhere(String(key), value);
  };

  Storage.prototype.removeItem = function (key) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage && hasNativeVault()) {
      try { window.ZeldaNativeVault.removeItem?.(String(key)); } catch (_) {}
    }
  };

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
        'gemini_api_key', 'GEMINI_API_KEY', 'zelda_api_key', 'zelda_gemini_key',
        'apiKey', 'api_key', 'elevenlabs_api_key', 'ELEVENLABS_API_KEY',
        'zelda_config', 'zelda_settings', 'zelda_vault', LINK_CHANNEL_KEY
      ];
      for (const k of commonKeys) {
        if (!localStorage.getItem(k)) {
          const nvVal = nativeVaultGet(k);
          if (nvVal) origSetItem.call(localStorage, k, nvVal);
        }
      }
      const cookies = readAllCookieBackups();
      Object.entries(cookies).forEach(([k, v]) => {
        if (v && !localStorage.getItem(k)) origSetItem.call(localStorage, k, v);
      });
    } catch (_) {}
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
  }

  function bindDomApiKeyInputs() {
    const inputs = document.querySelectorAll('input, textarea');
    inputs.forEach((inp) => {
      if (inp.dataset.zeldaVaultBound) return;
      const sig = [inp.id || '', inp.name || '', inp.placeholder || '', inp.getAttribute('aria-label') || ''].join(' ');
      if (!/api|key|gemini|eleven|token|secret|ai\s*studio/i.test(sig)) return;

      inp.dataset.zeldaVaultBound = '1';
      const fieldSlotKey = 'zelda_dom_input__' + (inp.id || inp.name || sig.replace(/\W+/g, '_').slice(0, 40));
      const savedVal = localStorage.getItem(fieldSlotKey) || nativeVaultGet(fieldSlotKey);
      if (!inp.value && savedVal) {
        inp.value = savedVal;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const saveHandler = () => {
        const val = (inp.value || '').trim();
        if (val.length >= 12) {
          localStorage.setItem(fieldSlotKey, val);
          if (/^AIza[0-9A-Za-z\-_]{25,}$/.test(val)) {
            ['gemini_api_key', 'GEMINI_API_KEY', 'zelda_api_key', 'zelda_gemini_key', 'apiKey'].forEach((k) => {
              if (!localStorage.getItem(k)) localStorage.setItem(k, val);
            });
          }
        }
      };
      inp.addEventListener('input', saveHandler);
      inp.addEventListener('change', saveHandler);
      inp.addEventListener('blur', saveHandler);
    });
  }

  function findGeminiApiKey() {
    const directSlots = [
      'gemini_api_key', 'GEMINI_API_KEY', 'zelda_api_key', 'zelda_gemini_key', 'apiKey', 'api_key'
    ];
    for (const k of directSlots) {
      const v = (localStorage.getItem(k) || nativeVaultGet(k) || '').trim();
      if (/^AIza[0-9A-Za-z\-_]{25,}$/.test(v)) return v;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const raw = localStorage.getItem(k) || '';
      const match = raw.match(/AIza[0-9A-Za-z\-_]{25,}/);
      if (match) return match[0];
    }
    const inputs = document.querySelectorAll('input, textarea');
    for (const inp of inputs) {
      const m = (inp.value || '').match(/AIza[0-9A-Za-z\-_]{25,}/);
      if (m) return m[0];
    }
    return '';
  }

  hydrateSyncAtBoot();
  injectHudPttRemovalCss();

  /* ========================================================================
   * PART 3: Z-LOCK HIGH-PRECISION GPS OVERRIDE
   * ======================================================================== */
  function getBestAvailableGpsFix() {
    const now = Date.now();
    if (relayState.remoteGps && now - relayState.remoteGps.ts < 60000) return relayState.remoteGps;
    if (relayState.nativeGps && now - relayState.nativeGps.ts < 60000) return relayState.nativeGps;
    return null;
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
    relayState.geoWatchers.forEach((cb) => {
      try { if (typeof cb === 'function') cb(pos); } catch (_) {}
    });
    window.dispatchEvent(new CustomEvent('zelda:gps-fix', { detail: fix }));
  }

  window.onZeldaNativeGps = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data && isFinite(data.lat) && isFinite(data.lng)) {
        relayState.nativeGps = {
          lat: Number(data.lat), lng: Number(data.lng),
          accuracy: Number(data.accuracy || 10),
          speed: data.speed != null ? Number(data.speed) : null,
          heading: data.heading != null ? Number(data.heading) : null,
          ts: Date.now()
        };
        notifyAllGeoWatchers(relayState.nativeGps);
      }
    } catch (_) {}
  };

  function installGeolocationPrecisionWrapper() {
    if (!navigator.geolocation || navigator.geolocation._zeldaGpsWrapped) return;
    const origGetCurrent = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const origWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    const origClear = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    const hiAccOpts = (opts) => Object.assign({}, opts || {}, {
      enableHighAccuracy: true, maximumAge: 0, timeout: Math.max((opts && opts.timeout) || 0, 12000)
    });

    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      const best = getBestAvailableGpsFix();
      if (best && typeof success === 'function') { success(toGeoPositionObject(best)); return; }
      origGetCurrent(
        (pos) => {
          const ov = getBestAvailableGpsFix();
          success(ov && pos.coords.accuracy > 500 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix();
          if (ov && typeof success === 'function') success(toGeoPositionObject(ov));
          else if (typeof error === 'function') error(err);
        },
        hiAccOpts(options)
      );
    };

    navigator.geolocation.watchPosition = function (success, error, options) {
      const customId = ++relayState.nextWatchId;
      relayState.geoWatchers.set(customId, success);
      const best = getBestAvailableGpsFix();
      if (best && typeof success === 'function') setTimeout(() => success(toGeoPositionObject(best)), 20);
      const nativeId = origWatch(
        (pos) => {
          const ov = getBestAvailableGpsFix();
          success(ov && pos.coords.accuracy > 500 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix();
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
    navigator.geolocation._zeldaGpsWrapped = true;
  }

  function forceLockCarMapToLiveGps() {
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      [window.map, window.zeldaMap, window.navMap, window.hudMap, window.myMap, window.leafletMap]
        .filter(Boolean)
        .forEach((m) => {
          try {
            if (typeof m.flyTo === 'function') {
              if (m.getCenter && m.setView) m.setView([lat, lng], Math.max(m.getZoom?.() || 16, 16), { animate: true });
              else m.flyTo({ center: [lng, lat], zoom: 16 });
            } else if (typeof m.setView === 'function') m.setView([lat, lng], 16);
            else if (typeof m.panTo === 'function') m.panTo({ lat, lng });
          } catch (_) {}
        });
      const mapIframe = document.querySelector('#tab-map iframe, [data-tab-panel="map"] iframe, iframe[src*="maps.google"]');
      if (mapIframe && /google\.com\/maps/i.test(mapIframe.src || '')) {
        mapIframe.src = `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
      }
      window.dispatchEvent(new CustomEvent('zelda:zlock-engaged', { detail: { lat, lng, accuracy: pos.coords.accuracy } }));
    }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }

  function bindZLockButton() {
    const zLockBtn = Array.from(document.querySelectorAll('button, [role="button"], .hud-btn'))
      .find((el) => /^(?:🎯\s*)?Z[\s\-_]*LOCK$/i.test((el.textContent || '').trim()));
    if (zLockBtn && !zLockBtn.dataset.zeldaZlockBound) {
      zLockBtn.dataset.zeldaZlockBound = '1';
      zLockBtn.addEventListener('click', () => setTimeout(forceLockCarMapToLiveGps, 60), false);
    }
  }

  installGeolocationPrecisionWrapper();

  /* ========================================================================
   * PART 4: TURBO KITT WATCH COMLINK (SUB-SECOND AI + WRIST VOICE STREAMING)
   * ======================================================================== */
  function cleanSpeechText(raw) {
    return String(raw || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[*_`#~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sendSpokenReplyToWatch(spokenText) {
    const clean = cleanSpeechText(spokenText);
    if (!clean || !relayState.channel) return;
    relayState.lastSpokenReplySentAt = Date.now();
    fetch(`https://ntfy.sh/${encodeURIComponent(relayState.channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        source: 'zelda-car',
        type: 'speak',
        text: clean.slice(0, 320),
        ts: Date.now()
      })
    }).catch(() => {});
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

  async function askZeldaTurboGemini(userText, apiKey) {
    const gpsFix = getBestAvailableGpsFix();
    const mph = gpsFix && gpsFix.speed != null ? Math.round(gpsFix.speed * 2.23694) : null;
    const telemetryCtx = gpsFix
      ? `Live 370Z GPS: ${gpsFix.lat.toFixed(4)}, ${gpsFix.lng.toFixed(4)}${mph !== null ? `, Speed: ${mph} MPH` : ''}.`
      : '370Z Comlink active.';

    const systemPrompt = [
      "You are Zelda, an ultra-sharp, loyal Cyberpunk AI integrated into J's 2009 Nissan 370Z and Galaxy Watch Ultra KITT-style wrist comlink.",
      "Speak naturally, warmly, and concisely like KITT in Knight Rider mixed with a Night City netrunner.",
      "CRITICAL VOICE RULE: Keep replies to 1 or 2 short, punchy spoken sentences (max 35 words) unless J asks for detail. Never use markdown, bullet points, or asterisks.",
      telemetryCtx
    ].join(' ');

    relayState.convHistory.push({ role: 'user', parts: [{ text: userText }] });
    if (relayState.convHistory.length > 10) {
      relayState.convHistory = relayState.convHistory.slice(-10);
    }

    const callModel = async (model, includeThinkingZero) => {
      const genCfg = { temperature: 0.75, maxOutputTokens: 100 };
      if (includeThinkingZero) genCfg.thinkingConfig = { thinkingBudget: 0 };

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: relayState.convHistory,
            generationConfig: genCfg
          })
        }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(' ').trim() || '';
    };

    let reply = '';
    try {
      reply = await callModel('gemini-2.5-flash', true);
    } catch (_) {
      reply = await callModel('gemini-2.0-flash', false);
    }

    if (reply) {
      relayState.convHistory.push({ role: 'model', parts: [{ text: reply }] });
    }
    return reply;
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
      return `On it, J. Queuing ${track} on the main deck.`;
    }

    if (/^(?:zelda[,\s]+)?(?:next(?:\s+track|\s+song|\s+video)?|skip(?:\s+track|\s+song)?)$/i.test(s)) {
      if (typeof window.onZeldaVoiceResult === 'function') {
        window.onZeldaVoiceResult({ transcript: 'next video', isFinal: true, source: 'watch' });
      }
      return 'Skipping to the next track.';
    }

    if (/^(?:zelda[,\s]+)?(?:pause|stop\s+music|hold\s+audio)$/i.test(s)) {
      if (typeof window.onZeldaVoiceResult === 'function') {
        window.onZeldaVoiceResult({ transcript: 'pause', isFinal: true, source: 'watch' });
      }
      return 'Audio paused.';
    }

    if (/^(?:zelda[,\s]+)?(?:resume|unpause|continue\s+playing)$/i.test(s)) {
      if (typeof window.onZeldaVoiceResult === 'function') {
        window.onZeldaVoiceResult({ transcript: 'resume', isFinal: true, source: 'watch' });
      }
      return 'Resuming playback.';
    }

    return null;
  }

  async function processWatchVoiceCommand(spoken) {
    appendHudChatLog('J (WATCH)', spoken);

    if (relayState.wristOnlyAudio) {
      relayState.suppressCarTtsUntil = Date.now() + 15000;
    }

    const fastAck = tryFastLocalHudCommand(spoken);
    if (fastAck) {
      sendSpokenReplyToWatch(fastAck);
      appendHudChatLog('ZELDA', fastAck);
      return;
    }

    const apiKey = findGeminiApiKey();
    if (apiKey) {
      try {
        const reply = await askZeldaTurboGemini(spoken, apiKey);
        if (reply) {
          sendSpokenReplyToWatch(reply);
          appendHudChatLog('ZELDA', reply);
          return;
        }
      } catch (err) {
        console.warn('[ZeldaWatchRelay] Turbo Gemini fallback to HUD:', err);
      }
    }

    const sentBefore = relayState.lastSpokenReplySentAt;
    if (typeof window.onZeldaVoiceResult === 'function') {
      window.onZeldaVoiceResult({ transcript: spoken, isFinal: true, source: 'watch' });
    } else {
      const textInput = document.querySelector(
        'input[placeholder*="Zelda" i], input[placeholder*="Say" i], input[placeholder*="Ask" i], #zelda-chat-input, textarea'
      );
      if (textInput) {
        textInput.value = spoken;
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const sendBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^SEND$/i.test((b.textContent || '').trim())
      );
      if (sendBtn) sendBtn.click();
    }

    setTimeout(() => {
      if (relayState.lastSpokenReplySentAt === sentBefore) {
        sendSpokenReplyToWatch('Comlink active, J. Check API key in Vault settings.');
      }
    }, 5500);
  }

  function hookCarVoiceOutputMirror() {
    if (window.speechSynthesis && !window.speechSynthesis._zeldaKittMirror) {
      window.speechSynthesis._zeldaKittMirror = true;
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = function (utterance) {
        if (utterance && utterance.text) {
          if (Date.now() - relayState.lastSpokenReplySentAt > 1200) {
            sendSpokenReplyToWatch(utterance.text);
          }
          if (Date.now() < relayState.suppressCarTtsUntil) {
            return;
          }
        }
        return origSpeak(utterance);
      };
    }

    if (window.ZeldaNativeVoice && typeof window.ZeldaNativeVoice.speak === 'function' && !window.ZeldaNativeVoice._zeldaKittMirror) {
      window.ZeldaNativeVoice._zeldaKittMirror = true;
      const origNativeSpeak = window.ZeldaNativeVoice.speak.bind(window.ZeldaNativeVoice);
      window.ZeldaNativeVoice.speak = function (txt) {
        if (txt && Date.now() - relayState.lastSpokenReplySentAt > 1200) {
          sendSpokenReplyToWatch(txt);
        }
        if (Date.now() < relayState.suppressCarTtsUntil) return;
        return origNativeSpeak(txt);
      };
    }
  }

  /* ========================================================================
   * PART 5: NTFY SSE STREAM & HEADER COMLINK BADGE
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
    const shortCode = relayState.channel.replace(/^zelda-370z-/i, '').toUpperCase();
    const audioMode = relayState.wristOnlyAudio ? 'WRIST' : 'WRIST+CAR';
    badge.textContent = relayState.connected
      ? `⌚ KITT LINK // ${shortCode} [${audioMode}]`
      : `⌚ KITT IDLE // ${shortCode}`;
    badge.style.borderColor = relayState.connected ? '#ff1744' : 'rgba(252,238,10,0.45)';
    badge.style.color = relayState.connected ? '#00f0ff' : '#fcee0a';
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
      background: rgba(5, 7, 12, 0.92);
      color: #00f0ff;
      border: 1px solid #ff1744;
      padding: 4px 10px;
      font-family: 'Orbitron', 'Rajdhani', monospace, sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      cursor: pointer;
      border-radius: 2px;
      box-shadow: 0 0 12px rgba(255, 23, 68, 0.28);
    `;
    badge.addEventListener('click', function () {
      const currentShort = relayState.channel.replace(/^zelda-370z-/i, '').toUpperCase();
      const modeLabel = relayState.wristOnlyAudio ? 'WRIST SPEAKER ONLY' : 'WRIST + CAR STEREO';
      const entered = window.prompt(
        `KITT WATCH COMLINK (${modeLabel})\n` +
        `• Enter 4-char pairing code to change channel\n` +
        `• Or type AUDIO to toggle Wrist-Only vs Wrist+Car voice:`,
        currentShort
      );
      if (!entered || !entered.trim()) return;
      const clean = entered.trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
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

  function handleIncomingWatchPacket(rawEventData) {
    try {
      const envelope = typeof rawEventData === 'string' ? JSON.parse(rawEventData) : rawEventData;
      if (!envelope || envelope.event !== 'message') return;
      if (envelope.id && envelope.id === relayState.lastMsgId) return;
      relayState.lastMsgId = envelope.id || '';

      const payload = typeof envelope.message === 'string' ? JSON.parse(envelope.message) : envelope.message;
      if (!payload || payload.source !== 'zelda-watch') return;
      if (payload.ts && Math.abs(Date.now() - payload.ts) > 25000) return;

      if (payload.gps && isFinite(payload.gps.lat) && isFinite(payload.gps.lng)) {
        relayState.remoteGps = {
          lat: Number(payload.gps.lat),
          lng: Number(payload.gps.lng),
          accuracy: Number(payload.gps.accuracy || 6),
          speed: payload.gps.speed != null ? Number(payload.gps.speed) : null,
          heading: payload.gps.heading != null ? Number(payload.gps.heading) : null,
          ts: Date.now()
        };
        notifyAllGeoWatchers(relayState.remoteGps);
        if (payload.type === 'zlock') {
          forceLockCarMapToLiveGps();
          sendSpokenReplyToWatch('Coordinates locked to your watch signal, J.');
        }
      }

      if (payload.type === 'voice' && payload.transcript) {
        processWatchVoiceCommand(String(payload.transcript).trim());
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
      es.onmessage = (ev) => handleIncomingWatchPacket(ev.data);
      es.onerror = () => { relayState.connected = false; updateWatchBadgeUi(); };
    } catch (_) {
      try {
        const ws = new WebSocket(`wss://ntfy.sh/${encodeURIComponent(topic)}/ws`);
        relayState.ws = ws;
        ws.onopen = () => { relayState.connected = true; updateWatchBadgeUi(); };
        ws.onmessage = (ev) => handleIncomingWatchPacket(ev.data);
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
    hydrateAsyncAndBindInputs();
    injectWatchLinkBadge();
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
    speakToWatch: sendSpokenReplyToWatch,
    forceZLock: forceLockCarMapToLiveGps
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootZeldaSync);
  } else {
    bootZeldaSync();
  }
})();
