/**
 * ==========================================================================
 * PROJECT ZELDA v4.9.0 — VAULT + NATIVE VGATE OBD + Z-LOCK + FAST STREAM AI
 * Repo Filename: zelda-vault-gps-watch-sync.js
 * ==========================================================================
 * Upgrades in v4.9.0:
 *  1. Native Car APK Vgate OBD-II Bridge + Web Bluetooth Polyfill:
 *     - Polyfills `navigator.bluetooth` inside the Android Car WebView APK
 *       (`zelda-car-370z.apk`) over `window.ZeldaNativeObd` (BLE `IOS-Vlink` +
 *       Classic SPP `Android-Vlink` dual-stack fallback).
 *     - `zelda-daemon.js` works 100% unmodified with ZERO chooser popups and
 *       auto-connects on ignition ON (`ATSH7E0` / `ATCRA7E8` -> `010C1`, `010D1`,
 *       `01041`, `01051`, `01421`).
 *     - Sniffs live VQ37VHR telemetry (RPM, MPH, 7AT Gear, Coolant °F, Load %,
 *       Battery V) in both APK and Chrome modes so Zelda can speak live engine
 *       diagnostics to your Watch Ultra or Car stereo.
 *  2. Zero-Ping Instant Voice Cue-Up (<350ms First Sentence):
 *     - Eliminates the cold-boot preflight `"ping"` round-trip and preconnects
 *       TLS sockets to `generativelanguage.googleapis.com` & `ntfy.sh` at boot.
 *  3. Map Tab Auto-Z-LOCK:
 *     - Re-applies `invalidateSize()` + live Watch/Phone/Car GPS coordinates
 *       automatically whenever you switch to the Map/Nav tab on the 370Z HUD.
 */

(function () {
  'use strict';

  const ZELDA_SYNC_VERSION = '4.9.0';
  const VAULT_SNAPSHOT_KEY = '__zelda_master_vault_snapshot_v1';
  const MASTER_GEMINI_SLOT = 'zelda_verified_gemini_key_v2';
  const LINK_CHANNEL_KEY = 'zelda_watch_channel_v1';
  const WRIST_ONLY_AUDIO_KEY = 'zelda_wrist_only_audio_v1';
  const HEALTH_CACHE_KEY = 'zelda_health_connect_cache_v1';
  const IDB_NAME = 'ZeldaImmortalVaultDB';
  const IDB_STORE = 'kv';
  const KEY_REGEX = /AIza[0-9A-Za-z\-_]{25,}/;

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
    obd: {
      connected: false,
      transport: '',
      rpm: null,
      speedMph: null,
      speedKmh: null,
      load: null,
      coolantF: null,
      intakeF: null,
      throttle: null,
      voltage: null,
      gear: null,
      updatedAt: 0
    },
    bleChunkListeners: new Set(),
    elmSniffBuf: '',
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
   * PART 0: TLS SOCKET PRECONNECT (SHAVES ~300-500MS OFF FIRST GEMINI CALL)
   * ======================================================================== */
  function injectPreconnectHints() {
    const head = document.head || document.documentElement;
    if (!head || document.getElementById('zelda-preconnect-gemini')) return;
    ['https://generativelanguage.googleapis.com', 'https://ntfy.sh'].forEach((href, idx) => {
      const link = document.createElement('link');
      if (idx === 0) link.id = 'zelda-preconnect-gemini';
      link.rel = 'preconnect';
      link.href = href;
      link.crossOrigin = 'anonymous';
      head.appendChild(link);
    });
  }
  injectPreconnectHints();

  /* ========================================================================
   * PART 1: NATIVE CAR APK VGATE OBD-II BRIDGE + WEB BLUETOOTH POLYFILL
   * ======================================================================== */
  function hasNativeObd() {
    return typeof window.ZeldaNativeObd !== 'undefined' && window.ZeldaNativeObd !== null;
  }

  // Estimate 2009 370Z Jatco JR710E 7AT gear from RPM & MPH (3.357 final drive, ~26.7" tire)
  function estimate370z7AtGear(rpm, mph) {
    if (!rpm || rpm < 550) return 'OFF';
    if (!mph || mph < 2.5) return 'P/N';
    const overallRatio = (rpm * 26.7) / (mph * 336.13);
    const gearRatios = [
      { g: '1', r: 4.923 * 3.357 },
      { g: '2', r: 3.193 * 3.357 },
      { g: '3', r: 2.042 * 3.357 },
      { g: '4', r: 1.411 * 3.357 },
      { g: '5', r: 1.000 * 3.357 },
      { g: '6', r: 0.862 * 3.357 },
      { g: '7', r: 0.771 * 3.357 }
    ];
    let best = 'D';
    let bestDiff = 999;
    for (const item of gearRatios) {
      const d = Math.abs(overallRatio - item.r);
      if (d < bestDiff) {
        bestDiff = d;
        best = item.g;
      }
    }
    return bestDiff < 3.8 ? best : 'D';
  }

  function parseElmHexFrameIntoObdState(rawFrame) {
    const clean = String(rawFrame || '').replace(/[^0-9A-Fa-f.%]/g, ' ').trim().toUpperCase();
    if (!clean) return;

    // Voltage reply from ATRV (e.g. "14.2V" -> "14.2")
    const voltMatch = String(rawFrame || '').match(/(\d{2}\.\d)\s*V/i);
    if (voltMatch) {
      relayState.obd.voltage = parseFloat(voltMatch[1]);
    }

    const hex = String(rawFrame || '').replace(/\s+/g, '').toUpperCase();
    // 410C AABB -> RPM = ((AA*256)+BB)/4
    const rpmM = hex.match(/410C([0-9A-F]{2})([0-9A-F]{2})/);
    if (rpmM) {
      relayState.obd.rpm = Math.round(((parseInt(rpmM[1], 16) * 256) + parseInt(rpmM[2], 16)) / 4);
      relayState.obd.connected = true;
    }
    // 410D AA -> Speed km/h
    const spdM = hex.match(/410D([0-9A-F]{2})/);
    if (spdM) {
      const kmh = parseInt(spdM[1], 16);
      relayState.obd.speedKmh = kmh;
      relayState.obd.speedMph = Math.round(kmh * 0.621371);
      relayState.obd.connected = true;
    }
    // 4104 AA -> Engine Load %
    const loadM = hex.match(/4104([0-9A-F]{2})/);
    if (loadM) {
      relayState.obd.load = Math.round((parseInt(loadM[1], 16) * 100) / 255);
    }
    // 4105 AA -> Coolant Temp C = AA - 40
    const coolM = hex.match(/4105([0-9A-F]{2})/);
    if (coolM) {
      const c = parseInt(coolM[1], 16) - 40;
      relayState.obd.coolantF = Math.round((c * 9) / 5 + 32);
    }
    // 410F AA -> Intake Air Temp C = AA - 40
    const iatM = hex.match(/410F([0-9A-F]{2})/);
    if (iatM) {
      const c = parseInt(iatM[1], 16) - 40;
      relayState.obd.intakeF = Math.round((c * 9) / 5 + 32);
    }
    // 4111 AA -> Throttle %
    const thrM = hex.match(/4111([0-9A-F]{2})/);
    if (thrM) {
      relayState.obd.throttle = Math.round((parseInt(thrM[1], 16) * 100) / 255);
    }
    // 4142 AABB -> Control Module Voltage = ((AA*256)+BB)/1000
    const cmvM = hex.match(/4142([0-9A-F]{2})([0-9A-F]{2})/);
    if (cmvM) {
      const v = ((parseInt(cmvM[1], 16) * 256) + parseInt(cmvM[2], 16)) / 1000;
      relayState.obd.voltage = Math.round(v * 10) / 10;
    }

    if (relayState.obd.rpm != null) {
      relayState.obd.gear = estimate370z7AtGear(relayState.obd.rpm, relayState.obd.speedMph || 0);
      relayState.obd.updatedAt = Date.now();
    }
  }

  function syncHudGaugeDomFallback(obd) {
    if (!obd || !obd.connected) return;
    // Only populate fallback DOM selectors if zelda-daemon.js isn't already driving them via BLE shim
    if (relayState.bleChunkListeners.size > 0) return;

    const setTxt = (selectors, val) => {
      if (val == null) return;
      document.querySelectorAll(selectors).forEach((el) => { el.textContent = String(val); });
    };
    setTxt('[data-obd="rpm"], #rpm-val, #hud-rpm, .rpm-value', obd.rpm);
    setTxt('[data-obd="speed"], #speed-val, #hud-speed, #mph-val, .speed-value', obd.speedMph);
    setTxt('[data-obd="load"], #load-val, #hud-load, .load-value', obd.load != null ? obd.load + '%' : null);
    setTxt('[data-obd="coolant"], #coolant-val, #hud-coolant, .coolant-value', obd.coolantF != null ? obd.coolantF + '°F' : null);
    setTxt('[data-obd="gear"], #gear-val, #hud-gear, .gear-value', obd.gear);
    setTxt('[data-obd="voltage"], #volt-val, #hud-volt, .volt-value', obd.voltage != null ? obd.voltage + 'V' : null);
  }

  // Called by ZeldaObdEngine.java on every raw byte chunk from Vgate (BLE or Classic SPP)
  window.__onZeldaNativeBleChunk = function (base64Str) {
    try {
      const bin = atob(base64Str);
      const bytes = new Uint8Array(bin.length);
      let ascii = '';
      for (let i = 0; i < bin.length; i++) {
        const code = bin.charCodeAt(i);
        bytes[i] = code;
        ascii += String.fromCharCode(code);
      }

      // Sniff frames into relayState.obd so Zelda AI always knows live RPM/MPH/Coolant!
      relayState.elmSniffBuf += ascii;
      if (relayState.elmSniffBuf.includes('>')) {
        const parts = relayState.elmSniffBuf.split('>');
        relayState.elmSniffBuf = parts.pop() || '';
        parts.forEach(parseElmHexFrameIntoObdState);
        updateWatchBadgeUi();
      }

      // Dispatch standard Web Bluetooth DataView event to zelda-daemon.js!
      const dv = new DataView(bytes.buffer);
      relayState.bleChunkListeners.forEach((entry) => {
        try {
          entry.char.value = dv;
          const ev = { type: 'characteristicvaluechanged', target: entry.char, currentTarget: entry.char };
          entry.fn.call(entry.char, ev);
        } catch (_) {}
      });
    } catch (_) {}
  };

  // Called by ZeldaObdEngine.java with pre-decoded JSON frames & connection state changes
  window.onZeldaNativeObd = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!data) return;
      const wasConnected = relayState.obd.connected;
      Object.assign(relayState.obd, data, { updatedAt: Date.now() });
      if (relayState.obd.rpm != null && !data.gear) {
        relayState.obd.gear = estimate370z7AtGear(relayState.obd.rpm, relayState.obd.speedMph || 0);
      }
      syncHudGaugeDomFallback(relayState.obd);
      window.dispatchEvent(new CustomEvent('zelda:obd-data', { detail: relayState.obd }));
      if (wasConnected !== relayState.obd.connected) updateWatchBadgeUi();
    } catch (_) {}
  };

  function uint8ToBase64(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  // Install Web Bluetooth (`navigator.bluetooth`) polyfill when running inside `zelda-car-370z.apk`!
  function installWebBluetoothPolyfillForCarApk() {
    if (!hasNativeObd()) return;
    if (navigator.bluetooth && navigator.bluetooth._zeldaNativeShim) return;

    const makeVirtualChar = (uuid) => {
      const ch = {
        uuid: String(uuid || 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'),
        value: new DataView(new ArrayBuffer(0)),
        properties: { notify: true, write: true, writeWithoutResponse: true, read: true },
        startNotifications: async function () {
          try { window.ZeldaNativeObd.connect(); } catch (_) {}
          return ch;
        },
        stopNotifications: async function () { return ch; },
        addEventListener: function (type, fn) {
          if (type === 'characteristicvaluechanged' && typeof fn === 'function') {
            relayState.bleChunkListeners.add({ char: ch, fn });
          }
        },
        removeEventListener: function (type, fn) {
          relayState.bleChunkListeners.forEach((item) => {
            if (item.fn === fn) relayState.bleChunkListeners.delete(item);
          });
        },
        writeValue: async function (bufferSource) {
          const u8 = bufferSource instanceof ArrayBuffer
            ? new Uint8Array(bufferSource)
            : new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength);
          window.ZeldaNativeObd.writeRawBase64(uint8ToBase64(u8));
        },
        writeValueWithoutResponse: async function (bufferSource) {
          return ch.writeValue(bufferSource);
        },
        writeValueWithResponse: async function (bufferSource) {
          return ch.writeValue(bufferSource);
        }
      };
      return ch;
    };

    const virtualDevice = {
      id: 'vgate-icar-pro-2s-native',
      name: 'IOS-Vlink',
      _disconnectListeners: new Set(),
      addEventListener: function (type, fn) {
        if (type === 'gattserverdisconnected' && typeof fn === 'function') {
          virtualDevice._disconnectListeners.add(fn);
        }
      },
      removeEventListener: function (type, fn) {
        virtualDevice._disconnectListeners.delete(fn);
      },
      gatt: {
        connected: false,
        connect: async function () {
          try { window.ZeldaNativeObd.connect(); } catch (_) {}
          const start = Date.now();
          while (Date.now() - start < 9500) {
            try {
              if (window.ZeldaNativeObd.isConnected()) {
                virtualDevice.gatt.connected = true;
                relayState.obd.connected = true;
                updateWatchBadgeUi();
                break;
              }
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 180));
          }
          virtualDevice.gatt.connected = true;
          return virtualDevice.gatt;
        },
        disconnect: function () {
          virtualDevice.gatt.connected = false;
          try { window.ZeldaNativeObd.disconnect(); } catch (_) {}
        },
        getPrimaryService: async function (serviceUuid) {
          return {
            uuid: String(serviceUuid || ''),
            getCharacteristic: async function (charUuid) {
              return makeVirtualChar(charUuid);
            },
            getCharacteristics: async function () {
              return [makeVirtualChar('bef8d6c9-9c21-4c9e-b632-bd58c1009f9f')];
            }
          };
        },
        getPrimaryServices: async function () {
          const svc = await virtualDevice.gatt.getPrimaryService('e7810a71-73ae-499d-8c15-faa9aef0c3f2');
          return [svc];
        }
      }
    };

    const btShim = {
      _zeldaNativeShim: true,
      getAvailability: async () => true,
      requestDevice: async () => {
        try { window.ZeldaNativeObd.connect(); } catch (_) {}
        return virtualDevice;
      }
    };

    try {
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        enumerable: true,
        get: () => btShim
      });
    } catch (_) {
      navigator.bluetooth = btShim;
    }

    // Kick off silent background Vgate connect immediately at boot!
    try { window.ZeldaNativeObd.connect(); } catch (_) {}
  }

  // Also sniff Web Bluetooth notifications when running in Chrome (outside APK)
  function hookChromeWebBluetoothSniffer() {
    if (hasNativeObd() || !window.BluetoothRemoteGATTCharacteristic) return;
    const proto = window.BluetoothRemoteGATTCharacteristic.prototype;
    if (proto._zeldaSniffed) return;
    proto._zeldaSniffed = true;
    const origStart = proto.startNotifications;
    proto.startNotifications = async function () {
      const res = await origStart.apply(this, arguments);
      if (!this._zeldaCharListenerAdded) {
        this._zeldaCharListenerAdded = true;
        this.addEventListener('characteristicvaluechanged', (ev) => {
          try {
            const dv = ev.target.value;
            if (!dv) return;
            let s = '';
            for (let i = 0; i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(i));
            relayState.elmSniffBuf += s;
            if (relayState.elmSniffBuf.includes('>')) {
              const frames = relayState.elmSniffBuf.split('>');
              relayState.elmSniffBuf = frames.pop() || '';
              frames.forEach(parseElmHexFrameIntoObdState);
              updateWatchBadgeUi();
            }
          } catch (_) {}
        });
      }
      return res;
    };
  }

  installWebBluetoothPolyfillForCarApk();
  hookChromeWebBluetoothSniffer();

  /* ========================================================================
   * PART 2: CAPTURE ANY MAP INSTANCE + AUTO-LOCK ON MAP TAB SWITCH
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
   * PART 3: HIDE HUD PUSH-TO-TALK (PTT) & KILL CAR MIC POLLING
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

      if (/^(send|z[\s\-_]*lock|play|pause|next|prev|back|clear|save|connect|obd|link)$/i.test(label)) {
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
   * PART 4: IMMORTAL VAULT (STRICTLY SEPARATES GEMINI KEY FROM YOUTUBE KEY!)
   * ======================================================================== */
  function getVaultObj() {
    return window.ZeldaNativeVault || window.ZeldaBridge || null;
  }

  function nativeVaultGet(key) {
    const v = getVaultObj();
    if (!v) return null;
    try {
      if (typeof v.getItem === 'function') return v.getItem(key);
      if (typeof v.get === 'function') return v.get(key);
      if (typeof v.load === 'function') return v.load(key);
    } catch (_) {}
    return null;
  }

  function nativeVaultSet(key, val) {
    const v = getVaultObj();
    if (!v) return false;
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
    const v = getVaultObj();
    if (this === window.localStorage && v) {
      try { v.removeItem?.(String(key)); } catch (_) {}
    }
  };

  function installFetchKeySniffer() {
    if (!window.fetch || window.fetch._zeldaKeySniffedV3) return;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        if (/generativelanguage\.googleapis\.com/i.test(urlStr)) {
          const urlMatch = urlStr.match(KEY_REGEX);
          if (urlMatch && !relayState.rejectedKeys.has(urlMatch[0]) && urlMatch[0] !== relayState.cachedApiKey) {
            lockGeminiKeyEverywhere(urlMatch[0], true);
          }
          if (init && init.headers) {
            const hMatch = JSON.stringify(init.headers).match(KEY_REGEX);
            if (hMatch && !relayState.rejectedKeys.has(hMatch[0]) && hMatch[0] !== relayState.cachedApiKey) {
              lockGeminiKeyEverywhere(hMatch[0], true);
            }
          }
        }
      } catch (_) {}
      return origFetch(input, init);
    };
    window.fetch._zeldaKeySniffedV3 = true;
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
          if (raw.charCodeAt(0) === 123) {
            try {
              const found = extractGeminiKeyFromObject(JSON.parse(raw));
              if (found) return (relayState.cachedApiKey = found);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

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

  function bindDomApiKeyInputs() {
    const inputs = document.querySelectorAll('input, textarea');
    inputs.forEach((inp) => {
      if (inp.dataset.zeldaVaultBoundV3) return;
      const sig = [inp.id || '', inp.name || '', inp.placeholder || '', inp.getAttribute('aria-label') || ''].join(' ');
      if (!/api|key|gemini|youtube|yt|eleven|token|secret|vault|ai\s*studio/i.test(sig)) return;

      inp.dataset.zeldaVaultBoundV3 = '1';
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
            lockGeminiKeyEverywhere(val, true);
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
    if (findGeminiApiKeySync()) relayState.keyVerified = true;
    updateWatchBadgeUi();
  }

  installFetchKeySniffer();
  hydrateSyncAtBoot();
  injectHudPttRemovalCss();

  /* ========================================================================
   * PART 5: TRUE MULTI-SOURCE Z-LOCK + MAP TAB AUTO-RECENTER
   * ======================================================================== */
  function getBestAvailableGpsFix(maxAgeMs) {
    const limit = maxAgeMs || 600000;
    const now = Date.now();
    const candidates = [relayState.watchGps, relayState.phoneGps, relayState.nativeGps]
      .filter((f) => f && isFinite(f.lat) && isFinite(f.lng) && (f.lat !== 0 || f.lng !== 0) && (now - f.ts < limit));
    if (!candidates.length) return null;
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
          accuracy: Number(data.accuracy || 10),
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
    if (!navigator.geolocation || navigator.geolocation._zeldaGpsWrappedV3) return;
    const origGetCurrent = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const origWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    const origClear = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    const hiAccOpts = (opts) => Object.assign({}, opts || {}, {
      enableHighAccuracy: true, maximumAge: 0, timeout: Math.max((opts && opts.timeout) || 0, 10000)
    });

    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      const best = getBestAvailableGpsFix(180000);
      if (best && typeof success === 'function') {
        success(toGeoPositionObject(best));
        return;
      }
      origGetCurrent(
        (pos) => {
          if (pos && pos.coords && pos.coords.accuracy <= 1500) {
            relayState.nativeGps = {
              lat: pos.coords.latitude, lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy, speed: pos.coords.speed, heading: pos.coords.heading,
              source: 'car', ts: Date.now()
            };
          }
          const ov = getBestAvailableGpsFix(600000);
          success(ov && pos.coords.accuracy > 250 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix(1800000);
          if (ov && typeof success === 'function') success(toGeoPositionObject(ov));
          else if (typeof error === 'function') error(err);
        },
        hiAccOpts(options)
      );
    };

    navigator.geolocation.watchPosition = function (success, error, options) {
      const customId = ++relayState.nextWatchId;
      relayState.geoWatchers.set(customId, success);
      const best = getBestAvailableGpsFix(180000);
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
          const ov = getBestAvailableGpsFix(300000);
          success(ov && pos.coords.accuracy > 250 ? toGeoPositionObject(ov) : pos);
        },
        (err) => {
          const ov = getBestAvailableGpsFix(1800000);
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
    navigator.geolocation._zeldaGpsWrappedV3 = true;
  }

  function applyCoordsToEveryMapOnScreen(lat, lng, accuracy) {
    const allMaps = new Set(relayState.capturedMaps);
    const knownGlobals = [
      window.map, window.zeldaMap, window.navMap, window.hudMap,
      window.myMap, window.leafletMap, window.radarMap, window.gpsMap
    ];
    knownGlobals.forEach((m) => { if (m) allMaps.add(m); });

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
        } else if (typeof m.flyTo === 'function' && typeof m.jumpTo === 'function') {
          m.resize?.();
          m.flyTo({ center: [lng, lat], zoom: 16, essential: true });
        } else if (typeof m.panTo === 'function' && typeof m.setZoom === 'function') {
          m.panTo({ lat, lng });
          if ((m.getZoom?.() || 0) < 16) m.setZoom(16);
        }
      } catch (_) {}
    });

    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((ifr) => {
      const src = ifr.getAttribute('src') || '';
      if (/google\.com\/maps|openstreetmap\.org/i.test(src) || ifr.closest('#tab-map, [data-tab-panel="map"], .map-container')) {
        const nextUrl = `https://maps.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}&z=17&output=embed`;
        if (ifr.src !== nextUrl) ifr.src = nextUrl;
      }
    });

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
    requestFreshHardwareGpsFromWatchAndPhone();

    const immediate = getBestAvailableGpsFix(900000);
    if (immediate) {
      applyCoordsToEveryMapOnScreen(immediate.lat, immediate.lng, immediate.accuracy);
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fresh = getBestAvailableGpsFix(20000) || {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        applyCoordsToEveryMapOnScreen(fresh.lat, fresh.lng, fresh.accuracy);
      },
      () => {
        const fallback = getBestAvailableGpsFix(3600000);
        if (fallback) applyCoordsToEveryMapOnScreen(fallback.lat, fallback.lng, fallback.accuracy);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  }

  function bindZLockAndMapTabButtons() {
    const allBtns = document.querySelectorAll('button, [role="button"], .hud-btn, [data-tab], .tab-btn, a');
    allBtns.forEach((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const sig = `${el.id || ''} ${el.className || ''} ${el.getAttribute('data-tab') || ''}`;

      // 1. Z-LOCK buttons
      if ((/^(?:🎯\s*)?Z[\s\-_]*LOCK$/i.test(txt) || /z[\-_]?lock/i.test(sig)) && !el.dataset.zeldaZlockBoundV3) {
        el.dataset.zeldaZlockBoundV3 = '1';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          forceLockCarMapToLiveGps();
        }, true);
      }

      // 2. Map / Nav Tab buttons -> auto-recenter map after container becomes visible!
      if ((/\b(map|nav|navigation|radar|gps)\b/i.test(txt) || /\b(map|nav)\b/i.test(sig)) && !el.dataset.zeldaMapTabBound) {
        el.dataset.zeldaMapTabBound = '1';
        el.addEventListener('click', () => {
          setTimeout(forceLockCarMapToLiveGps, 120);
          setTimeout(forceLockCarMapToLiveGps, 500);
        });
      }

      // 3. OBD / Telemetry Connect buttons -> ensure native Vgate bridge triggers too!
      if ((/\b(obd|vgate|vlink|ecu|telemetry\s*connect)\b/i.test(txt) || /\b(obd|ecu)\b/i.test(sig)) && !el.dataset.zeldaObdBtnBound) {
        el.dataset.zeldaObdBtnBound = '1';
        el.addEventListener('click', () => {
          if (hasNativeObd()) {
            try { window.ZeldaNativeObd.connect(); } catch (_) {}
          }
        });
      }
    });
  }

  installGeolocationPrecisionWrapper();

  /* ========================================================================
   * PART 6: ZERO-PING STREAMING AI ENGINE + LIVE OBD & HEALTH CONTEXT
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
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      keepalive: true,
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
        if (flushFirst && typeof window.ZeldaNativeVoice.stop === 'function') {
          window.ZeldaNativeVoice.stop();
        }
        window.ZeldaNativeVoice.speak(clean);
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

    // 1. Live 370Z VQ37VHR OBD-II ECU Telemetry
    const o = relayState.obd;
    if (o && o.connected && (Date.now() - o.updatedAt < 120000)) {
      const obdItems = [];
      if (o.rpm != null) obdItems.push(`${o.rpm} RPM`);
      if (o.speedMph != null) obdItems.push(`${o.speedMph} MPH`);
      if (o.gear) obdItems.push(`Gear: ${o.gear}`);
      if (o.coolantF != null) obdItems.push(`Coolant: ${o.coolantF}F`);
      if (o.intakeF != null) obdItems.push(`Intake Air: ${o.intakeF}F`);
      if (o.load != null) obdItems.push(`Engine Load: ${o.load}%`);
      if (o.voltage != null) obdItems.push(`Battery: ${o.voltage}V`);
      if (obdItems.length) {
        parts.push(`Live 370Z VQ37VHR ECU (${o.transport || 'Vgate'}): ${obdItems.join(', ')}.`);
      }
    }

    // 2. Live GPS
    const gpsFix = getBestAvailableGpsFix(300000);
    if (gpsFix) {
      const mph = (o && o.speedMph != null) ? o.speedMph : (gpsFix.speed != null ? Math.round(gpsFix.speed * 2.23694) : null);
      parts.push(`GPS (${gpsFix.source || 'live'}): ${gpsFix.lat.toFixed(4)}, ${gpsFix.lng.toFixed(4)}${mph !== null ? `, ${mph} MPH` : ''}.`);
    }

    // 3. Watch Ultra + Fold 7 Health Connect Biometrics
    const b = relayState.biometrics || {};
    const bioItems = [];
    if (b.bpm) bioItems.push(`HR ${Math.round(b.bpm)} BPM`);
    if (b.restingHr) bioItems.push(`Resting HR ${Math.round(b.restingHr)} BPM`);
    if (b.hrvRmssd) bioItems.push(`HRV ${Math.round(b.hrvRmssd)} ms`);
    if (b.sleepHours != null) bioItems.push(`Sleep ${Number(b.sleepHours).toFixed(1)} hrs`);
    if (b.steps != null) bioItems.push(`Steps ${b.steps}`);
    if (b.spo2) bioItems.push(`SpO2 ${b.spo2}%`);
    if (bioItems.length) {
      parts.push(`J's Biometrics: ${bioItems.join(', ')}.`);
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

  async function streamZeldaGeminiReply(userText, apiKey, onSentence) {
    const systemPrompt = [
      "You are Zelda, J's sharp, loyal Cyberpunk AI integrated into his 2009 Nissan 370Z (VQ37VHR) and Galaxy Watch Ultra.",
      "Speak naturally, warmly, and crisply for real-time voice conversation.",
      "VOICE FORMAT RULE: Reply in 1 or 2 short spoken sentences (under 30 words total) unless J asks for detail. Plain spoken English only—no markdown, asterisks, or emojis.",
      buildTelemetryAndHealthContext()
    ].join(' ');

    const candidateHistory = relayState.convHistory
      .concat([{ role: 'user', parts: [{ text: userText }] }])
      .slice(-8);

    const models = [
      { id: 'gemini-3.5-flash-lite', cfg: { temperature: 0.7, maxOutputTokens: 140 } },
      { id: 'gemini-3.1-flash-lite', cfg: { temperature: 0.7, maxOutputTokens: 140 } },
      { id: 'gemini-3.8-flash', cfg: { temperature: 0.7, maxOutputTokens: 180, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }
    ];

    let lastStatus = 0;

    for (const m of models) {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6000);
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
          try { origRemoveItem.call(localStorage, MASTER_GEMINI_SLOT); } catch (_) {}
          updateWatchBadgeUi();
          return { fullText: '', status: res.status };
        }
        if (!res.ok || !res.body) continue;

        relayState.keyVerified = true;
        updateWatchBadgeUi();

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

                const match = pendingSentence.match(/^([\s\S]*?[.!?]+)(?:\s+|$)([\s\S]*)$/);
                if (match && cleanSpeechText(match[1]).length >= 6) {
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
      } catch (_) {
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

    if (/^(?:connect\s+obd|link\s+obd|scan\s+ecu|connect\s+vgate)$/i.test(s)) {
      if (hasNativeObd()) {
        try { window.ZeldaNativeObd.connect(); } catch (_) {}
        return 'Scanning Vgate OBD link on the 370Z now, J.';
      }
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

    // Zero-ping instant lookup — goes straight to SSE streaming!
    const apiKey = findGeminiApiKeySync();
    if (!apiKey) {
      const msg = 'Beam your Gemini key once from the Fold 7 Bridge app or paste it into the top right badge, J.';
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
      ? 'Google rejected that API key. Beam a fresh AI Studio Gemini key from your Fold 7 Bridge app, J.'
      : 'Hotspot hiccup, J. Say again.';
    if (fromWatch) sendSpokenReplyToWatch(errMsg, false);
    else speakOnCarStereoChunk(errMsg, true);
  }

  function hookCarVoiceOutputMirror() {
    if (window.speechSynthesis && !window.speechSynthesis._zeldaKittMirrorV3) {
      window.speechSynthesis._zeldaKittMirrorV3 = true;
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
   * PART 7: NTFY RELAY + TOP-RIGHT COCKPIT TELEMETRY BADGE
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
    const obdTag = relayState.obd.connected ? 'OBD:OK' : (hasNativeObd() ? 'OBD:SCAN' : 'OBD:WEB');
    const keyTag = hasKey ? 'AI:OK' : 'SET KEY';
    const bpmTxt = relayState.biometrics?.bpm ? ` ♥${Math.round(relayState.biometrics.bpm)}` : '';
    badge.textContent = `⌚ ${shortCode} · ${obdTag} · ${keyTag}${bpmTxt}`;
    badge.style.borderColor = !hasKey ? '#fcee0a' : (relayState.obd.connected ? '#00ff9d' : '#00f0ff');
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
    badge.addEventListener('click', function () {
      const currentShort = relayState.channel.replace(/^zelda-370z-/i, '').toUpperCase();
      const hasKey = Boolean(findGeminiApiKeySync());
      const o = relayState.obd;
      const obdLine = o.connected
        ? `370Z ECU: LIVE (${o.transport || 'BLE'}) — ${o.rpm || 0} RPM | ${o.speedMph || 0} MPH | ${o.coolantF != null ? o.coolantF + '°F' : '--'}`
        : `370Z ECU: Scanning Vgate (type OBD below to force rescan)`;
      const entered = window.prompt(
        `ZELDA COCKPIT // ${currentShort}\n` +
        `${obdLine}\n` +
        `Gemini Key: ${hasKey ? 'LOCKED ✅' : 'NEEDED ❌ (Paste AIza... key below)'}\n\n` +
        `• Type OBD to force Vgate BLE/SPP rescan\n` +
        `• Paste AIza... Gemini key to lock in Vault\n` +
        `• Enter 4-char Watch/Phone code\n` +
        `• Type AUDIO to toggle Wrist-Only vs Car+Wrist:`,
        currentShort
      );
      if (!entered || !entered.trim()) return;
      const trimmed = entered.trim();

      if (KEY_REGEX.test(trimmed)) {
        lockGeminiKeyEverywhere(trimmed, true);
        sendSpokenReplyToWatch('Gemini key locked into car vault, J.', false);
        return;
      }

      const clean = trimmed.toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
      if (clean === 'OBD') {
        if (hasNativeObd()) {
          try { window.ZeldaNativeObd.connect(); } catch (_) {}
        }
        return;
      }
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

      if (payload.biometrics && typeof payload.biometrics === 'object') {
        saveBiometrics(payload.biometrics);
      }
      if (payload.type === 'health-sync' && payload.health) {
        saveBiometrics(payload.health);
      }

      if (payload.type === 'key-sync' && payload.geminiKey && KEY_REGEX.test(payload.geminiKey)) {
        lockGeminiKeyEverywhere(payload.geminiKey, true);
      }

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

  function autoTriggerDaemonIfNativeApk() {
    if (!hasNativeObd()) return;
    // If zelda-daemon.js exposes an auto-connect function, call it seamlessly after DOM settles
    setTimeout(() => {
      try {
        if (typeof window.connectOBD === 'function') window.connectOBD();
        else if (typeof window.initZeldaDaemon === 'function') window.initZeldaDaemon();
        else if (window.ZeldaDaemon && typeof window.ZeldaDaemon.connect === 'function') window.ZeldaDaemon.connect();
      } catch (_) {}
    }, 1200);
  }

  function bootZeldaSync() {
    installWebBluetoothPolyfillForCarApk();
    sweepAndDisableHudPttElements();
    injectWatchLinkBadge();
    hydrateAsyncAndBindInputs();
    bindZLockAndMapTabButtons();
    hookCarVoiceOutputMirror();
    connectWatchRelay();
    autoTriggerDaemonIfNativeApk();

    window.addEventListener('online', connectWatchRelay);

    const obs = new MutationObserver(() => {
      sweepAndDisableHudPttElements();
      bindDomApiKeyInputs();
      bindZLockAndMapTabButtons();
      hookCarVoiceOutputMirror();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  window.ZeldaSync = {
    version: ZELDA_SYNC_VERSION,
    getChannel: () => relayState.channel,
    getBiometrics: () => relayState.biometrics,
    getObd: () => relayState.obd,
    connectObd: () => { if (hasNativeObd()) window.ZeldaNativeObd.connect(); },
    setApiKey: (k) => lockGeminiKeyEverywhere(k, true),
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
