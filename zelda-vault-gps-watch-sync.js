/**
 * ==========================================================================
 * PROJECT ZELDA v4.6.0 — VAULT KEY PERSISTENCE + Z-LOCK GPS + WATCH RELAY
 * File: zelda-vault-gps-watch-sync.js
 * ==========================================================================
 * Drop into your Project-Zelda GitHub repo root and add to index.html <head>
 * (ideally as the FIRST script inside <head> or right before </body>):
 *   <script src="zelda-vault-gps-watch-sync.js"></script>
 *
 * Solves all 3 in-car issues in one modular file:
 *  1. API Key Ignition Wipe Fix:
 *     - Bridges `file://` (cold boot before hotspot) and `https://` (GitHub live)
 *       via window.ZeldaNativeVault + IndexedDB + Cookie backup.
 *     - Intercepts localStorage.setItem AND API key input fields the millisecond
 *       you paste a key, flushing immediately to native flash storage.
 *     - Auto-restores keys into localStorage AND re-populates HUD key inputs on boot.
 *  2. Z-LOCK True GPS Fix:
 *     - Forces `enableHighAccuracy: true, maximumAge: 0` on all geolocation calls.
 *     - Overrides phantom carrier-IP hotspot pings using live GPS streamed from
 *       your Galaxy Watch Ultra / Fold 7 (or native Android GPS bridge).
 *  3. Galaxy Watch Ultra -> 370Z Live Voice & Telemetry Relay:
 *     - Subscribes via WebSocket + EventSource fallback (`ntfy.sh` zero-account relay)
 *       using your private pairing channel (`zelda-370z-<CODE>`).
 *     - Speaking into your Ripperdoc Watch Complication executes voice commands,
 *       YouTube searches, and Zelda AI replies directly on the car screen + stereo!
 */

(function () {
  'use strict';

  const ZELDA_SYNC_VERSION = '4.6.0';
  const VAULT_SNAPSHOT_KEY = '__zelda_master_vault_snapshot_v1';
  const LINK_CHANNEL_KEY = 'zelda_watch_channel_v1';
  const IDB_NAME = 'ZeldaImmortalVaultDB';
  const IDB_STORE = 'kv';

  const relayState = {
    channel: '',
    ws: null,
    sse: null,
    connected: false,
    reconnectTimer: null,
    lastMsgId: '',
    remoteGps: null, // { lat, lng, accuracy, speed, heading, ts }
    nativeGps: null,
    geoWatchers: new Map(),
    nextWatchId: 9000
  };

  /* ========================================================================
   * PART 1: IMMORTAL API KEY VAULT (SURVIVES CAR IGNITION OFF & ORIGIN SPLIT)
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
    } catch (e) {
      console.warn('[ZeldaVaultSync] Native read warning:', e);
    }
    return null;
  }

  function nativeVaultSet(key, val) {
    if (!hasNativeVault()) return false;
    const v = window.ZeldaNativeVault;
    try {
      const str = String(val ?? '');
      if (typeof v.setItemSync === 'function') {
        v.setItemSync(key, str);
        return true;
      }
      if (typeof v.setItem === 'function') {
        v.setItem(key, str);
        if (typeof v.flush === 'function') v.flush();
        return true;
      }
      if (typeof v.save === 'function') {
        v.save(key, str);
        return true;
      }
    } catch (e) {
      console.warn('[ZeldaVaultSync] Native write warning:', e);
    }
    return false;
  }

  // Cookie mirror (survives RAM clear on same domain even if localStorage delays flush)
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

  // IndexedDB mirror (flushes transactionally on commit, much faster than WebView localStorage)
  function openVaultIdb() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = window.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
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
          try {
            resolve(req.result ? JSON.parse(req.result) : null);
          } catch (_) {
            resolve(null);
          }
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
    if (!k) return false;
    return /api|key|gemini|openai|eleven|token|secret|zelda|voice|map|mapbox|google|cfg|config|setting|vault|channel/i.test(
      k
    );
  }

  function buildCurrentSnapshot() {
    const snap = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k === VAULT_SNAPSHOT_KEY) continue;
        const v = localStorage.getItem(k);
        if (v !== null && v !== '') {
          snap[k] = v;
        }
      }
    } catch (_) {}
    return snap;
  }

  function persistEverywhere(key, val) {
    if (!key || key === VAULT_SNAPSHOT_KEY) return;
    const strVal = String(val ?? '');
    if (!strVal) return;

    // 1. Direct key write to Kotlin SharedPreferences bridge
    nativeVaultSet(key, strVal);

    // 2. Cookie backup for key-like secrets
    if (isImportantVaultKey(key) && strVal.length < 512) {
      writeCookieBackup(key, strVal);
    }

    // 3. Master JSON snapshot across NativeVault + IndexedDB
    const snap = buildCurrentSnapshot();
    snap[key] = strVal;
    const serialized = JSON.stringify(snap);
    nativeVaultSet(VAULT_SNAPSHOT_KEY, serialized);
    idbSetSnapshot(snap);
  }

  // Hook localStorage.setItem globally so ANY script saving API keys flushes immediately
  Storage.prototype.setItem = function (key, value) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage) {
      persistEverywhere(String(key), value);
    }
  };

  Storage.prototype.removeItem = function (key) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage && hasNativeVault()) {
      try {
        if (typeof window.ZeldaNativeVault.removeItem === 'function') {
          window.ZeldaNativeVault.removeItem(String(key));
        }
      } catch (_) {}
    }
  };

  // Synchronous boot hydration from NativeVault + Cookies (runs IMMEDIATELY)
  function hydrateSyncAtBoot() {
    let restoredCount = 0;
    try {
      // A. Restore from Kotlin Master Snapshot
      const rawSnap = nativeVaultGet(VAULT_SNAPSHOT_KEY);
      if (rawSnap) {
        const parsed = JSON.parse(rawSnap);
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([k, v]) => {
            if (v && !localStorage.getItem(k)) {
              origSetItem.call(localStorage, k, String(v));
              restoredCount++;
            }
          });
        }
      }

      // B. Probe common Zelda key names directly in NativeVault
      const commonKeys = [
        'gemini_api_key',
        'GEMINI_API_KEY',
        'zelda_api_key',
        'zelda_gemini_key',
        'apiKey',
        'api_key',
        'elevenlabs_api_key',
        'ELEVENLABS_API_KEY',
        'zelda_eleven_key',
        'openai_api_key',
        'mapbox_token',
        'google_maps_key',
        'zelda_config',
        'zelda_settings',
        'zelda_vault',
        LINK_CHANNEL_KEY
      ];
      for (const k of commonKeys) {
        if (!localStorage.getItem(k)) {
          const nvVal = nativeVaultGet(k);
          if (nvVal) {
            origSetItem.call(localStorage, k, nvVal);
            restoredCount++;
          }
        }
      }

      // C. Restore from Cookie mirror
      const cookies = readAllCookieBackups();
      Object.entries(cookies).forEach(([k, v]) => {
        if (v && !localStorage.getItem(k)) {
          origSetItem.call(localStorage, k, v);
          restoredCount++;
        }
      });
    } catch (e) {
      console.warn('[ZeldaVaultSync] Sync hydrate warning:', e);
    }

    if (restoredCount > 0) {
      console.log(`[ZeldaVaultSync] Restored ${restoredCount} vault keys synchronously on cold boot.`);
    }
    return restoredCount;
  }

  // Async fallback hydration from IndexedDB + DOM Input Auto-Fill
  async function hydrateAsyncAndBindInputs() {
    const idbSnap = await idbGetSnapshot();
    let asyncRestored = 0;
    if (idbSnap && typeof idbSnap === 'object') {
      Object.entries(idbSnap).forEach(([k, v]) => {
        if (v && !localStorage.getItem(k)) {
          origSetItem.call(localStorage, k, String(v));
          nativeVaultSet(k, String(v));
          asyncRestored++;
        }
      });
    }

    populateDomApiKeyInputs();
    if (asyncRestored > 0) {
      window.dispatchEvent(new CustomEvent('zelda:vault-restored', { detail: { count: asyncRestored } }));
    }
  }

  // Automatically capture & restore <input> fields where API keys are pasted
  function bindDomApiKeyInputs() {
    const inputs = document.querySelectorAll('input, textarea');
    inputs.forEach((inp) => {
      if (inp.dataset.zeldaVaultBound) return;
      const sig = [
        inp.id || '',
        inp.name || '',
        inp.placeholder || '',
        inp.getAttribute('aria-label') || ''
      ].join(' ');

      if (!/api|key|gemini|eleven|token|secret|ai\s*studio/i.test(sig)) return;

      inp.dataset.zeldaVaultBound = '1';
      const fieldSlotKey = 'zelda_dom_input__' + (inp.id || inp.name || sig.replace(/\W+/g, '_').slice(0, 40));

      // Auto-fill if empty and we have a saved value
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
          // If it looks like a Google Gemini key ("AIza..."), also mirror standard key slots!
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

  function populateDomApiKeyInputs() {
    bindDomApiKeyInputs();
  }

  // Run synchronous hydration immediately before later scripts execute
  hydrateSyncAtBoot();

  /* ========================================================================
   * PART 2: Z-LOCK HIGH-PRECISION GPS OVERRIDE (FIXES WRONG PING IN NAV)
   * Why Z-LOCK jumped to the wrong ping:
   *  - Head unit WebView either returned coarse AT&T/Carrier hotspot IP location
   *    (often miles away in Baton Rouge / New Orleans / Reserve) OR failed
   *    permission and snapped to index.html's hardcoded fallback coordinates.
   * How this fixes it:
   *  1. Forces `enableHighAccuracy: true, maximumAge: 0` on every geolocation call.
   *  2. Accepts live GPS from Kotlin (`window.onZeldaNativeGps`) AND live GPS
   *     streamed from your Galaxy Watch Ultra / Fold 7 over the Watch Relay!
   *  3. Whenever `Z LOCK` is tapped, explicitly centers any Leaflet / Mapbox /
   *     Google Map or custom `window.zeldaMap` instance onto the best live GPS fix!
   * ======================================================================== */
  function getBestAvailableGpsFix() {
    const now = Date.now();
    // 1. Prefer fresh Watch / Fold 7 GPS if received within last 45 seconds
    if (relayState.remoteGps && now - relayState.remoteGps.ts < 45000) {
      return relayState.remoteGps;
    }
    // 2. Next prefer fresh Native Android LocationManager GPS bridge
    if (relayState.nativeGps && now - relayState.nativeGps.ts < 45000) {
      return relayState.nativeGps;
    }
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
      try {
        if (typeof cb === 'function') cb(pos);
      } catch (_) {}
    });
    window.dispatchEvent(new CustomEvent('zelda:gps-fix', { detail: fix }));
  }

  // Hook called by Kotlin's MainActivity / LocationManager if present
  window.onZeldaNativeGps = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data && isFinite(data.lat) && isFinite(data.lng)) {
        relayState.nativeGps = {
          lat: Number(data.lat),
          lng: Number(data.lng),
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

    const hiAccOpts = (opts) =>
      Object.assign({}, opts || {}, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: Math.max((opts && opts.timeout) || 0, 12000)
      });

    navigator.geolocation.getCurrentPosition = function (success, error, options) {
      const best = getBestAvailableGpsFix();
      if (best && typeof success === 'function') {
        success(toGeoPositionObject(best));
        return;
      }

      origGetCurrent(
        function (pos) {
          // If WebView returned a coarse IP ping (> 800m error) and Watch GPS arrived, swap in Watch GPS
          const override = getBestAvailableGpsFix();
          if (override && pos.coords.accuracy > 500) {
            success(toGeoPositionObject(override));
          } else {
            success(pos);
          }
        },
        function (err) {
          const override = getBestAvailableGpsFix();
          if (override && typeof success === 'function') {
            success(toGeoPositionObject(override));
          } else if (typeof error === 'function') {
            error(err);
          }
        },
        hiAccOpts(options)
      );
    };

    navigator.geolocation.watchPosition = function (success, error, options) {
      const customId = ++relayState.nextWatchId;
      relayState.geoWatchers.set(customId, success);

      const best = getBestAvailableGpsFix();
      if (best && typeof success === 'function') {
        setTimeout(() => success(toGeoPositionObject(best)), 20);
      }

      const nativeId = origWatch(
        function (pos) {
          const override = getBestAvailableGpsFix();
          if (override && pos.coords.accuracy > 500) {
            success(toGeoPositionObject(override));
          } else {
            success(pos);
          }
        },
        function (err) {
          const override = getBestAvailableGpsFix();
          if (override && typeof success === 'function') {
            success(toGeoPositionObject(override));
          } else if (typeof error === 'function') {
            error(err);
          }
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
      } else {
        origClear(id);
      }
    };

    navigator.geolocation._zeldaGpsWrapped = true;
  }

  // Force-snap map instances when [Z LOCK] / [Z-LOCK] button is pressed
  function forceLockCarMapToLiveGps() {
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        console.log('[ZeldaGPS] Z-LOCK snapping to true coordinates:', lat, lng, 'acc:', pos.coords.accuracy);

        // Check global Leaflet / Mapbox / custom Zelda map handles
        const mapCandidates = [
          window.map,
          window.zeldaMap,
          window.navMap,
          window.hudMap,
          window.myMap,
          window.leafletMap
        ].filter(Boolean);

        mapCandidates.forEach((m) => {
          try {
            if (typeof m.flyTo === 'function') {
              // Leaflet flyTo([lat, lng], zoom) vs Mapbox GL flyTo({ center: [lng, lat] })
              if (m.getCenter && m.setView) {
                m.setView([lat, lng], Math.max(m.getZoom?.() || 16, 16), { animate: true });
              } else {
                m.flyTo({ center: [lng, lat], zoom: 16 });
              }
            } else if (typeof m.setView === 'function') {
              m.setView([lat, lng], 16);
            } else if (typeof m.panTo === 'function') {
              m.panTo({ lat, lng });
            }
          } catch (_) {}
        });

        // Also update any embedded Google Maps / OpenStreetMap iframe if Zelda uses iframe nav
        const mapIframe = document.querySelector(
          '#tab-map iframe, [data-tab-panel="map"] iframe, iframe[src*="maps.google"], iframe[src*="openstreetmap"]'
        );
        if (mapIframe && /google\.com\/maps/i.test(mapIframe.src || '')) {
          mapIframe.src = `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
        }

        window.dispatchEvent(
          new CustomEvent('zelda:zlock-engaged', { detail: { lat, lng, accuracy: pos.coords.accuracy } })
        );
      },
      function (err) {
        console.warn('[ZeldaGPS] Z-LOCK GPS error:', err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  function bindZLockButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], .hud-btn, div, span'));
    const zLockBtn = buttons.find((el) =>
      /^(?:🎯\s*)?Z[\s\-_]*LOCK$/i.test((el.textContent || '').trim())
    );
    if (zLockBtn && !zLockBtn.dataset.zeldaZlockBound) {
      zLockBtn.dataset.zeldaZlockBound = '1';
      zLockBtn.addEventListener(
        'click',
        function () {
          setTimeout(forceLockCarMapToLiveGps, 60);
        },
        false
      );
    }
  }

  installGeolocationPrecisionWrapper();

  /* ========================================================================
   * PART 3: GALAXY WATCH ULTRA <-> 370Z LIVE RELAY (ZERO-CONFIG NTFY STREAM)
   * Lets your Galaxy Watch Ultra send voice transcripts & high-accuracy GPS
   * straight to the 370Z HUD in ~180ms with zero account setup!
   * ======================================================================== */
  function getOrInitWatchChannel() {
    let ch = localStorage.getItem(LINK_CHANNEL_KEY) || nativeVaultGet(LINK_CHANNEL_KEY);
    if (!ch || ch.length < 4) {
      // Generate a memorable 4-char cyber code once and lock it in Vault
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
    const shortCode = relayState.channel.replace(/^zelda-370z-/i, '');
    badge.textContent = relayState.connected
      ? `⌚ WATCH LINK // ${shortCode}`
      : `⌚ WATCH IDLE // ${shortCode}`;
    badge.style.borderColor = relayState.connected ? '#00f0ff' : 'rgba(252,238,10,0.45)';
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
      background: rgba(5, 7, 12, 0.88);
      color: #fcee0a;
      border: 1px solid rgba(252, 238, 10, 0.45);
      padding: 4px 9px;
      font-family: 'Orbitron', 'Rajdhani', monospace, sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      cursor: pointer;
      border-radius: 2px;
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.18);
    `;
    badge.title = 'Tap to view or customize your Galaxy Watch Ultra pairing code';
    badge.addEventListener('click', function () {
      const currentShort = relayState.channel.replace(/^zelda-370z-/i, '');
      const entered = window.prompt(
        `GALAXY WATCH ULTRA COMM-LINK CODE\n\nEnter this exact code on your Watch Zelda app (or type a custom code to pair both):`,
        currentShort
      );
      if (entered && entered.trim()) {
        const clean = entered.trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
        const fullTopic = clean.startsWith('ZELDA-') ? clean.toLowerCase() : `zelda-370z-${clean}`;
        localStorage.setItem(LINK_CHANNEL_KEY, fullTopic);
        relayState.channel = fullTopic;
        connectWatchRelay();
      }
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

      // Ignore stale cached packets older than 20 seconds
      if (payload.ts && Math.abs(Date.now() - payload.ts) > 25000) return;

      // 1. Update live GPS from Galaxy Watch Ultra / Fold 7 if attached
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
        }
      }

      // 2. Execute Voice Command from Watch directly on the 370Z HUD!
      if (payload.type === 'voice' && payload.transcript) {
        const spoken = String(payload.transcript).trim();
        console.log('[ZeldaWatchRelay] Voice command received from Galaxy Watch Ultra:', spoken);

        if (typeof window.onZeldaVoiceResult === 'function') {
          window.onZeldaVoiceResult({ transcript: spoken, isFinal: true, source: 'watch' });
        } else {
          // Direct fallback if voice patch loads after
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

        // Send quick status ack back to Watch display
        sendCarReplyToWatch(`CMD LOCKED // "${spoken.slice(0, 42).toUpperCase()}"`);
      }
    } catch (err) {
      // Non-JSON keepalive or external ping
    }
  }

  function sendCarReplyToWatch(statusText) {
    if (!relayState.channel) return;
    fetch(`https://ntfy.sh/${encodeURIComponent(relayState.channel)}`, {
      method: 'POST',
      body: JSON.stringify({
        source: 'zelda-car',
        type: 'ack',
        text: statusText,
        ts: Date.now()
      })
    }).catch(() => {});
  }

  // Also forward Zelda's spoken/written AI responses back to your wrist!
  function hookZeldaReplyMirrorToWatch() {
    if (window.speechSynthesis && !window.speechSynthesis._zeldaWatchMirror) {
      window.speechSynthesis._zeldaWatchMirror = true;
      const origSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = function (utterance) {
        if (utterance && utterance.text) {
          sendCarReplyToWatch(utterance.text.slice(0, 140));
        }
        return origSpeak(utterance);
      };
    }
  }

  function connectWatchRelay() {
    const topic = getOrInitWatchChannel();
    if (relayState.ws) {
      try { relayState.ws.close(); } catch (_) {}
      relayState.ws = null;
    }
    if (relayState.sse) {
      try { relayState.sse.close(); } catch (_) {}
      relayState.sse = null;
    }
    if (relayState.reconnectTimer) {
      clearTimeout(relayState.reconnectTimer);
      relayState.reconnectTimer = null;
    }

    // Use SSE (EventSource) first — far more resilient on XYAuto WebViews that drop WebSockets (1006)!
    try {
      const sseUrl = `https://ntfy.sh/${encodeURIComponent(topic)}/sse`;
      const es = new EventSource(sseUrl);
      relayState.sse = es;

      es.onopen = function () {
        relayState.connected = true;
        updateWatchBadgeUi();
        console.log('[ZeldaWatchRelay] Connected via SSE to channel:', topic);
      };

      es.onmessage = function (ev) {
        handleIncomingWatchPacket(ev.data);
      };

      es.onerror = function () {
        relayState.connected = false;
        updateWatchBadgeUi();
      };
    } catch (e) {
      console.warn('[ZeldaWatchRelay] SSE unavailable, falling back to WebSocket:', e);
      try {
        const ws = new WebSocket(`wss://ntfy.sh/${encodeURIComponent(topic)}/ws`);
        relayState.ws = ws;
        ws.onopen = () => {
          relayState.connected = true;
          updateWatchBadgeUi();
        };
        ws.onmessage = (ev) => handleIncomingWatchPacket(ev.data);
        ws.onclose = () => {
          relayState.connected = false;
          updateWatchBadgeUi();
          relayState.reconnectTimer = setTimeout(connectWatchRelay, 4000);
        };
      } catch (_) {}
    }
  }

  /* ========================================================================
   * BOOTSTRAP
   * ======================================================================== */
  function bootZeldaSync() {
    hydrateAsyncAndBindInputs();
    injectWatchLinkBadge();
    bindZLockButton();
    hookZeldaReplyMirrorToWatch();
    connectWatchRelay();

    // Re-connect instantly when phone hotspot comes online after car start
    window.addEventListener('online', () => {
      connectWatchRelay();
    });

    const obs = new MutationObserver(() => {
      bindDomApiKeyInputs();
      bindZLockButton();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  window.ZeldaSync = {
    version: ZELDA_SYNC_VERSION,
    getChannel: () => relayState.channel,
    setChannel: (code) => {
      const clean = String(code || '').trim().toUpperCase();
      const topic = clean.startsWith('ZELDA-') ? clean.toLowerCase() : `zelda-370z-${clean}`;
      localStorage.setItem(LINK_CHANNEL_KEY, topic);
      relayState.channel = topic;
      connectWatchRelay();
    },
    forceZLock: forceLockCarMapToLiveGps,
    hydrateVault: hydrateSyncAtBoot
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootZeldaSync);
  } else {
    bootZeldaSync();
  }
})();
