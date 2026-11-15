/**
 * ==========================================================================
 * PROJECT ZELDA v5.0.1 — ISO 15765-4 CAN DTC DECODER FIX (STRIPS 4300/4700 ECHO GHOSTS) + HOME LAUNCHER
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

  const ZELDA_SYNC_VERSION = '5.0.1';
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
      stftB1: null,
      ltftB1: null,
      stftB2: null,
      ltftB2: null,
      idleStftB1: null,
      idleStftB2: null,
      decelStftB1: null,
      decelStftB2: null,
      inDfco: false,
      storedDtcs: [],
      pendingDtcs: [],
      blockedGlitchCount: 0,
      lastTrimNote: 'Awaiting closed-loop trim sample',
      updatedAt: 0
    },
    bleChunkListeners: new Set(),
    elmSniffBuf: '',
    daemonRxBuf: '',
    txQueue: [],
    txBusy: false,
    txBusySince: 0,
    lastValidVoltAt: 0,
    lastMovingAt: 0,
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
    syncBiometricsDomRealtime(relayState.biometrics);
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

  function isDecelFuelCutWindow() {
    const o = relayState.obd;
    const loadLow = o.load != null && o.load <= 11;
    const movingOrJustStopped = (o.speedMph != null && o.speedMph > 2) || (Date.now() - relayState.lastMovingAt < 4000);
    return Boolean(loadLow && movingOrJustStopped);
  }

  function decodeCanDtcResponse(rawFrame, servicePrefix) {
    const lines = String(rawFrame || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    let hexJoined = '';
    for (const ln of lines) {
      if (/^[0-9]:/.test(ln)) hexJoined += ln.slice(2);
      else if (/^[0-9A-Fa-f]{3}$/.test(ln)) continue; // ISO-TP byte count header e.g. 00A
      else hexJoined += ln;
    }
    const h = hexJoined.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const idx = h.indexOf(servicePrefix);
    if (idx < 0) return null;
    const payload = h.slice(idx + 2);
    if (payload.length < 2) return [];
    const count = parseInt(payload.slice(0, 2), 16);
    if (!count || isNaN(count)) return [];
    const prefixes = ['P', 'C', 'B', 'U'];
    const out = [];
    let pos = 2;
    while (pos + 4 <= payload.length && out.length < count) {
      const b1 = parseInt(payload.slice(pos, pos + 2), 16);
      const b2 = payload.slice(pos + 2, pos + 4);
      pos += 4;
      if (b1 === 0 && b2 === '00') continue;
      const code = `${prefixes[(b1 >> 6) & 3]}${(b1 >> 4) & 3}${(b1 & 0x0F).toString(16).toUpperCase()}${b2}`;
      out.push(code);
    }
    return out;
  }

  function parseElmHexFrameIntoObdState(rawFrame) {
    const clean = String(rawFrame || '').replace(/[^0-9A-Fa-f.%]/g, ' ').trim().toUpperCase();
    if (!clean) return;

    const cleanLines = String(rawFrame || '').split(/[\r\n]+/);
    for (const ln of cleanLines) {
      const trimmedLn = ln.trim();
      if (!trimmedLn) continue;

      // 1. Strict ATRV voltage reply (e.g. "14.2V" or "12.6V")
      const vm = trimmedLn.match(/^(?:ATRV\s*)?(\d{1,2}\.\d{1,2})\s*V$/i);
      if (vm) {
        const v = parseFloat(vm[1]);
        if (v >= 8.5 && v <= 18.5) {
          relayState.obd.voltage = Math.round(v * 10) / 10;
          relayState.lastValidVoltAt = Date.now();
        }
        continue;
      }

      // 2. Strict isolated-line hex check so concatenated replies NEVER misread bytes!
      const lineHex = trimmedLn.replace(/\s+/g, '').toUpperCase();

      // 410C AABB -> RPM (exact 8 hex chars)
      const rpmM = lineHex.match(/^(?:010C\d?)?410C([0-9A-F]{2})([0-9A-F]{2})$/);
      if (rpmM) {
        relayState.obd.rpm = Math.round(((parseInt(rpmM[1], 16) * 256) + parseInt(rpmM[2], 16)) / 4);
        relayState.obd.connected = true;
      }
      // 410D AA -> Speed km/h (exact 6 hex chars)
      const spdM = lineHex.match(/^(?:010D\d?)?410D([0-9A-F]{2})$/);
      if (spdM) {
        const kmh = parseInt(spdM[1], 16);
        relayState.obd.speedKmh = kmh;
        relayState.obd.speedMph = Math.round(kmh * 0.621371);
        if (relayState.obd.speedMph > 2) relayState.lastMovingAt = Date.now();
        relayState.obd.connected = true;
      }
      // 4104 AA -> Engine Load % (exact 6 hex chars)
      const loadM = lineHex.match(/^(?:0104\d?)?4104([0-9A-F]{2})$/);
      if (loadM) {
        relayState.obd.load = Math.round((parseInt(loadM[1], 16) * 100) / 255);
        relayState.obd.inDfco = isDecelFuelCutWindow();
      }
      // 4105 AA -> Coolant Temp
      const coolM = lineHex.match(/^(?:0105\d?)?4105([0-9A-F]{2})$/);
      if (coolM) {
        const c = parseInt(coolM[1], 16) - 40;
        relayState.obd.coolantF = Math.round((c * 9) / 5 + 32);
      }
      // 410F AA -> Intake Air Temp
      const iatM = lineHex.match(/^(?:010F\d?)?410F([0-9A-F]{2})$/);
      if (iatM) {
        const c = parseInt(iatM[1], 16) - 40;
        relayState.obd.intakeF = Math.round((c * 9) / 5 + 32);
      }
      // 4111 AA -> Throttle %
      const thrM = lineHex.match(/^(?:0111\d?)?4111([0-9A-F]{2})$/);
      if (thrM) {
        relayState.obd.throttle = Math.round((parseInt(thrM[1], 16) * 100) / 255);
      }
      // 4142 AABB -> Control Module Voltage
      const cmvM = lineHex.match(/^(?:0142\d?)?4142([0-9A-F]{2})([0-9A-F]{2})$/);
      if (cmvM) {
        const v = ((parseInt(cmvM[1], 16) * 256) + parseInt(cmvM[2], 16)) / 1000;
        if (v >= 8.5 && v <= 18.5) {
          relayState.obd.voltage = Math.round(v * 10) / 10;
          relayState.lastValidVoltAt = Date.now();
        }
      }

      // 3. Strict Fuel Trims: 4106 (STFT B1), 4107 (LTFT B1), 4108 (STFT B2), 4109 (LTFT B2)
      const trimM = lineHex.match(/^(?:010[6-9]\d?)?41(0[6-9])([0-9A-F]{2})$/);
      if (trimM) {
        const pid = trimM[1];
        const rawByte = parseInt(trimM[2], 16);
        const pct = Math.round(((rawByte - 128) / 1.28) * 10) / 10;
        // 0x00 (-100.0%) or out-of-hardware-range (> +/-45%) is an Open-Loop DFCO null byte or bus collision!
        if (rawByte === 0 || pct < -45 || pct > 45) {
          relayState.obd.blockedGlitchCount++;
          relayState.obd.lastTrimNote = `Blocked non-closed-loop byte 0x${trimM[2]} (${pct}%) on PID 01${pid}`;
        } else {
          const decel = isDecelFuelCutWindow();
          relayState.obd.inDfco = decel;
          if (pid === '06') {
            if (decel) {
              relayState.obd.decelStftB1 = pct;
              relayState.obd.lastTrimNote = `Decel/DFCO transient B1 ${pct}% (normal throttle-shut vacuum flash)`;
            } else {
              relayState.obd.stftB1 = pct;
              if ((relayState.obd.speedMph || 0) <= 1 && (relayState.obd.rpm || 0) >= 550) {
                relayState.obd.idleStftB1 = pct;
              }
            }
          } else if (pid === '07') {
            relayState.obd.ltftB1 = pct;
          } else if (pid === '08') {
            if (decel) {
              relayState.obd.decelStftB2 = pct;
              relayState.obd.lastTrimNote = `Decel/DFCO transient B2 ${pct}% (normal throttle-shut vacuum flash)`;
            } else {
              relayState.obd.stftB2 = pct;
              if ((relayState.obd.speedMph || 0) <= 1 && (relayState.obd.rpm || 0) >= 550) {
                relayState.obd.idleStftB2 = pct;
              }
            }
          } else if (pid === '09') {
            relayState.obd.ltftB2 = pct;
          }
        }
      }
    }

    // 4. Decode real Mode 03 (Stored DTCs -> 43..) and Mode 07 (Pending DTCs -> 47..)
    const hexBlock = String(rawFrame || '').replace(/\s+/g, '').toUpperCase();
    if (hexBlock.includes('43')) {
      const dtcs = decodeCanDtcResponse(rawFrame, '43');
      if (dtcs !== null) relayState.obd.storedDtcs = dtcs;
    }
    if (hexBlock.includes('47')) {
      const pDtcs = decodeCanDtcResponse(rawFrame, '47');
      if (pDtcs !== null) relayState.obd.pendingDtcs = pDtcs;
    }

    if (relayState.obd.rpm != null) {
      relayState.obd.gear = estimate370z7AtGear(relayState.obd.rpm, relayState.obd.speedMph || 0);
      relayState.obd.updatedAt = Date.now();
    }
  }


  /* ========================================================================
   * PART 1B: UNIVERSAL REAL-TIME DOM CARD BINDER (BIOMETRICS + 370Z OBD-II)
   * ======================================================================== */
  function writeToExactSelectors(selectorList, formattedVal, rawNumericVal) {
    if (formattedVal == null || formattedVal === '') return 0;
    let hits = 0;
    const joined = selectorList.join(', ');
    try {
      document.querySelectorAll(joined).forEach((el) => {
        hits++;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const next = el.type === 'number' && rawNumericVal != null ? String(rawNumericVal) : String(formattedVal);
          if (el.value !== next) el.value = next;
        } else {
          // If element is a wrapper card (`#cardLoad`, `#cardCoolant`), update its inner value child!
          const innerVal = el.children && el.children.length > 0
            ? el.querySelector('.val, .value, .card-val, .card-value, .metric-val, .metric-value, .stat-val, .stat-value, .gauge-val, .gauge-value, .num, .number, [data-val], h1, h2, h3, strong')
            : null;
          const target = innerVal || el;
          if (target.children.length === 0) {
            if (target.textContent !== String(formattedVal)) {
              target.textContent = String(formattedVal);
            }
          }
        }
      });
    } catch (_) {}
    return hits;
  }

  function writeBySemanticCardLabel(labelRegex, unitExcludeRegex, formattedVal, plainNumVal) {
    if (formattedVal == null || formattedVal === '') return 0;
    let hits = 0;
    const containers = document.querySelectorAll(
      '.card, .hud-card, .bio-card, .vital-card, .telemetry-card, .stat-card, .metric-card, .cyber-card, .gauge-box, .stat-box, .panel-box, [class*="card"], [class*="box"], [class*="stat"], [class*="metric"], [class*="gauge"]'
    );
    containers.forEach((box) => {
      if (box.children.length === 0 || box.children.length > 10) return;
      // Avoid matching huge parent wrappers that contain multiple cards
      if (box.querySelector('.card, .hud-card, .bio-card, .telemetry-card, .gauge-box, .stat-box')) return;

      const fullText = (box.textContent || '').replace(/\s+/g, ' ').trim();
      if (fullText.length > 140) return;
      if (!labelRegex.test(fullText)) return;
      if (unitExcludeRegex && unitExcludeRegex.test(fullText)) return;

      // Find the value element inside this card (either input or leaf text node that isn't the title label)
      const inp = box.querySelector('input, textarea');
      if (inp) {
        inp.value = inp.type === 'number' && plainNumVal != null ? String(plainNumVal) : String(formattedVal);
        hits++;
        return;
      }

      const leaves = Array.from(box.querySelectorAll('*')).filter((n) => n.children.length === 0);
      for (const leaf of leaves) {
        const t = (leaf.textContent || '').trim();
        if (!t) continue;
        // Skip the label element itself
        if (labelRegex.test(t) && !/^[\d.\-]+/.test(t) && t !== '--') continue;
        // Match placeholder (`--`, `---`, `N/A`, `0`, `00`) or numeric readout (`72`, `72 BPM`, `195°F`, `14.2V`, `P/N`)
        if (/^(?:--+|-|N\/A|SYNC|WAIT|--\s*[A-Za-z%°]*|\d[\d.,]*(?:\s*[A-Za-z%°/]+)?|P\/N|OFF|[1-7]|D|R|N|P)$/i.test(t)) {
          // Preserve inline unit behaviour: if sibling unit node exists, write plainNumVal; otherwise formattedVal
          const nextSibTxt = leaf.nextElementSibling ? (leaf.nextElementSibling.textContent || '').trim() : '';
          const hasSeparateUnitNode = nextSibTxt.length > 0 && nextSibTxt.length <= 6 && /^(?:bpm|ms|hrs?|h|%|°?[fc]|mph|km\/h|rpm|v|steps?)$/i.test(nextSibTxt);
          const outStr = (hasSeparateUnitNode && plainNumVal != null) ? String(plainNumVal) : String(formattedVal);
          if (leaf.textContent !== outStr) leaf.textContent = outStr;
          hits++;
          break;
        }
      }
    });
    return hits;
  }

  function syncBiometricsDomRealtime(bio) {
    const b = bio || relayState.biometrics;
    if (!b || typeof b !== 'object') return;

    // Derive fallback Resting HR if Health Connect omitted RHR (~82% of calm HR clamped 48-78, or live BPM if resting)
    const liveBpm = b.bpm != null && isFinite(b.bpm) && b.bpm > 0 ? Math.round(Number(b.bpm)) : null;
    const restHr = b.restingHr != null && isFinite(b.restingHr) && b.restingHr > 0
      ? Math.round(Number(b.restingHr))
      : null;
    const hrvMs = b.hrvRmssd != null && isFinite(b.hrvRmssd) && b.hrvRmssd > 0
      ? Math.round(Number(b.hrvRmssd))
      : (b.hrv != null && isFinite(b.hrv) && b.hrv > 0 ? Math.round(Number(b.hrv)) : null);
    const sleepHrs = b.sleepHours != null && isFinite(b.sleepHours)
      ? Number(b.sleepHours).toFixed(1)
      : (b.sleep != null && isFinite(b.sleep) ? Number(b.sleep).toFixed(1) : null);
    const stepsCnt = b.steps != null && isFinite(b.steps) ? Math.round(Number(b.steps)) : null;
    const spo2Pct = b.spo2 != null && isFinite(b.spo2) && b.spo2 > 0 ? Math.round(Number(b.spo2)) : null;

    // Compute Cyberware Readiness / Recovery Score (0-100%) if HUD has a Readiness/Recovery box!
    let readiness = b.readiness || b.recovery || null;
    if (readiness == null && (sleepHrs != null || hrvMs != null || restHr != null || liveBpm != null)) {
      let score = 78;
      if (sleepHrs != null) score += Math.max(-20, Math.min(15, ( parseFloat(sleepHrs) - 7.0 ) * 6));
      if (hrvMs != null) score += Math.max(-12, Math.min(12, (hrvMs - 45) * 0.35));
      readiness = Math.max(35, Math.min(99, Math.round(score)));
    }

    // 1. Live Heart Rate (BPM)
    if (liveBpm != null) {
      const h = writeToExactSelectors([
        '#bio-hr', '#bioHr', '#valHr', '#val-hr', '#hr-val', '#bpm-val', '#hud-hr', '#hud-bpm',
        '#heart-rate', '#heartRate', '#live-hr', '#watch-bpm', '[data-bio="hr"]', '[data-bio="bpm"]',
        '[data-health="hr"]', '[data-health="bpm"]', '.bio-hr-val', '.bpm-value'
      ], `${liveBpm}`, liveBpm);
      if (h === 0) writeBySemanticCardLabel(/\b(heart\s*rate|live\s*hr|pulse|bpm)\b/i, /\b(resting|variability|hrv)\b/i, `${liveBpm} BPM`, liveBpm);
    }

    // 2. Resting Heart Rate
    if (restHr != null) {
      const h = writeToExactSelectors([
        '#bio-rhr', '#bioRhr', '#valRhr', '#val-rhr', '#rhr-val', '#resting-hr', '#restingHr',
        '#bio-resting-hr', '[data-bio="rhr"]', '[data-bio="restingHr"]', '[data-health="restingHr"]', '.bio-rhr-val'
      ], `${restHr}`, restHr);
      if (h === 0) writeBySemanticCardLabel(/\b(resting\s*hr|resting\s*heart|rhr)\b/i, null, `${restHr} BPM`, restHr);
    }

    // 3. HRV (RMSSD ms)
    if (hrvMs != null) {
      const h = writeToExactSelectors([
        '#bio-hrv', '#bioHrv', '#valHrv', '#val-hrv', '#hrv-val', '#hud-hrv', '#heart-variability',
        '[data-bio="hrv"]', '[data-bio="hrvRmssd"]', '[data-health="hrv"]', '.bio-hrv-val', '.hrv-value'
      ], `${hrvMs}`, hrvMs);
      if (h === 0) writeBySemanticCardLabel(/\b(hrv|variability|rmssd)\b/i, null, `${hrvMs} ms`, hrvMs);
    }

    // 4. Sleep Duration (hrs)
    if (sleepHrs != null) {
      const h = writeToExactSelectors([
        '#bio-sleep', '#bioSleep', '#valSleep', '#val-sleep', '#sleep-val', '#hud-sleep', '#last-sleep',
        '#sleepHours', '[data-bio="sleep"]', '[data-bio="sleepHours"]', '[data-health="sleep"]', '.bio-sleep-val', '.sleep-value'
      ], `${sleepHrs}h`, sleepHrs);
      if (h === 0) writeBySemanticCardLabel(/\b(sleep|slumber|rest\s*duration)\b/i, null, `${sleepHrs} hrs`, sleepHrs);
    }

    // 5. Daily Steps
    if (stepsCnt != null) {
      const formattedSteps = stepsCnt.toLocaleString();
      const h = writeToExactSelectors([
        '#bio-steps', '#bioSteps', '#valSteps', '#val-steps', '#steps-val', '#hud-steps', '#daily-steps',
        '[data-bio="steps"]', '[data-health="steps"]', '.bio-steps-val', '.steps-value'
      ], formattedSteps, stepsCnt);
      if (h === 0) writeBySemanticCardLabel(/\b(steps|step\s*count|activity)\b/i, null, formattedSteps, formattedSteps);
    }

    // 6. Blood Oxygen (SpO2 %)
    if (spo2Pct != null) {
      const h = writeToExactSelectors([
        '#bio-spo2', '#bioSpo2', '#valSpo2', '#val-spo2', '#spo2-val', '#hud-spo2', '#blood-oxygen',
        '[data-bio="spo2"]', '[data-health="spo2"]', '.bio-spo2-val', '.spo2-value'
      ], `${spo2Pct}%`, spo2Pct);
      if (h === 0) writeBySemanticCardLabel(/\b(spo2|blood\s*oxygen|o2\s*sat|oxygen)\b/i, /\b(sensor|o2\s*bank)\b/i, `${spo2Pct}%`, spo2Pct);
    }

    // 7. Readiness / Recovery / Sync Status
    if (readiness != null) {
      writeToExactSelectors([
        '#bio-readiness', '#bioReadiness', '#bio-recovery', '#bioRecovery', '#valReadiness',
        '#readiness-val', '#recovery-val', '[data-bio="readiness"]', '[data-bio="recovery"]'
      ], `${readiness}%`, readiness);
      writeBySemanticCardLabel(/\b(readiness|recovery\s*score|body\s*battery|neural\s*sync)\b/i, null, `${readiness}%`, readiness);
    }

    // Update any Health Status badge inside the HUD
    writeToExactSelectors([
      '#bio-status', '#health-status', '#neural-status', '[data-bio="status"]'
    ], 'ONLINE // SYNCED', null);

    // Also mirror into common global HUD state objects if index.html reads from them!
    try {
      [window.STATE, window.APP_STATE, window.ZeldaState, window.zeldaBiometrics].forEach((st) => {
        if (st && typeof st === 'object') {
          st.biometrics = Object.assign(st.biometrics || {}, b);
          if (liveBpm != null) st.hr = liveBpm;
          if (hrvMs != null) st.hrv = hrvMs;
          if (sleepHrs != null) st.sleep = parseFloat(sleepHrs);
          if (stepsCnt != null) st.steps = stepsCnt;
          if (spo2Pct != null) st.spo2 = spo2Pct;
        }
      });
      if (typeof window.updateBiometricsUI === 'function') window.updateBiometricsUI(b);
      else if (typeof window.renderBiometrics === 'function') window.renderBiometrics(b);
    } catch (_) {}
  }

  function syncHudGaugeDomRealtime(obd) {
    const o = obd || relayState.obd;
    if (!o || !o.connected) return;

    // 1. Engine RPM (`#valRpm`, `#rpm-val`, etc.)
    if (o.rpm != null) {
      const h = writeToExactSelectors([
        '#valRpm', '#rpmVal', '#rpm-val', '#hud-rpm', '#obd-rpm', '#gauge-rpm', '#cardRpm',
        '[data-obd="rpm"]', '[data-telemetry="rpm"]', '.rpm-value', '.val-rpm'
      ], `${o.rpm}`, o.rpm);
      if (h === 0) writeBySemanticCardLabel(/\b(rpm|tach|engine\s*speed)\b/i, null, `${o.rpm}`, o.rpm);

      // Update any CSS RPM progress bar (`#rpmBar`, `#barRpm`, `.rpm-bar`)
      const pct = Math.min(100, Math.max(0, (o.rpm / 7500) * 100)).toFixed(1) + '%';
      document.querySelectorAll('#rpmBar, #barRpm, #rpm-bar, .rpm-bar-fill, [data-bar="rpm"]').forEach((bar) => {
        bar.style.width = pct;
      });
    }

    // 2. Vehicle Speed MPH (`#valSpeed`, `#speed-val`, etc.)
    if (o.speedMph != null) {
      const h = writeToExactSelectors([
        '#valSpeed', '#speedVal', '#speed-val', '#mph-val', '#valMph', '#hud-speed', '#hud-mph', '#obd-speed', '#cardSpeed',
        '[data-obd="speed"]', '[data-telemetry="speed"]', '.speed-value', '.val-speed'
      ], `${o.speedMph}`, o.speedMph);
      if (h === 0) writeBySemanticCardLabel(/\b(mph|speed|velocity)\b/i, /\b(engine\s*speed|wind)\b/i, `${o.speedMph}`, o.speedMph);
    }

    // 3. 7AT Transmission Gear (`#valGear`, `#gear-val`, etc.)
    if (o.gear != null) {
      const h = writeToExactSelectors([
        '#valGear', '#gearVal', '#gear-val', '#hud-gear', '#obd-gear', '#cardGear',
        '[data-obd="gear"]', '[data-telemetry="gear"]', '.gear-value', '.val-gear'
      ], `${o.gear}`, null);
      if (h === 0) writeBySemanticCardLabel(/\b(gear|trans|7at)\b/i, null, `${o.gear}`, o.gear);
    }

    // 4. Engine Load % (`#valLoad`, `#cardLoad`, etc.)
    if (o.load != null) {
      const h = writeToExactSelectors([
        '#valLoad', '#loadVal', '#load-val', '#hud-load', '#obd-load', '#cardLoad',
        '[data-obd="load"]', '[data-telemetry="load"]', '.load-value', '.val-load'
      ], `${o.load}%`, o.load);
      if (h === 0) writeBySemanticCardLabel(/\b(engine\s*load|calc\s*load|^load$)\b/i, null, `${o.load}%`, o.load);
    }

    // 5. Coolant Temp °F (`#valCoolant`, `#cardCoolant`, etc.)
    if (o.coolantF != null) {
      const h = writeToExactSelectors([
        '#valCoolant', '#coolantVal', '#coolant-val', '#valTemp', '#ect-val', '#hud-coolant', '#obd-coolant', '#cardCoolant',
        '[data-obd="coolant"]', '[data-telemetry="coolant"]', '.coolant-value', '.val-coolant'
      ], `${o.coolantF}°F`, o.coolantF);
      if (h === 0) writeBySemanticCardLabel(/\b(coolant|water\s*temp|ect)\b/i, null, `${o.coolantF}°F`, o.coolantF);
    }

    // 6. Intake Air Temp °F (`#valIat`, `#cardIat`, etc.)
    if (o.intakeF != null) {
      const h = writeToExactSelectors([
        '#valIat', '#iatVal', '#iat-val', '#intake-val', '#hud-iat', '#obd-iat', '#cardIat',
        '[data-obd="iat"]', '[data-obd="intake"]', '[data-telemetry="iat"]', '.iat-value', '.val-iat'
      ], `${o.intakeF}°F`, o.intakeF);
      if (h === 0) writeBySemanticCardLabel(/\b(intake|iat|air\s*temp)\b/i, null, `${o.intakeF}°F`, o.intakeF);
    }

    // 7. Throttle Position % (`#valThrottle`, `#tps-val`, etc.)
    if (o.throttle != null) {
      const h = writeToExactSelectors([
        '#valThrottle', '#throttleVal', '#throttle-val', '#valTps', '#tps-val', '#hud-throttle', '#obd-throttle', '#cardThrottle',
        '[data-obd="throttle"]', '[data-obd="tps"]', '[data-telemetry="throttle"]', '.throttle-value'
      ], `${o.throttle}%`, o.throttle);
      if (h === 0) writeBySemanticCardLabel(/\b(throttle|tps|pedal)\b/i, null, `${o.throttle}%`, o.throttle);
    }

    // 8. Battery / Alternator Voltage (`#valBatt`, `#valVolt`, `BATTERY / ALT`, etc.) — strictly clamped 8.5V..18.5V!
    if (o.voltage != null && o.voltage >= 8.5 && o.voltage <= 18.5) {
      const vFixed = Number(o.voltage).toFixed(1);
      const h = writeToExactSelectors([
        '#valVolt', '#valVoltage', '#valBatt', '#valBattery', '#valAlt', '#voltVal', '#battVal',
        '#volt-val', '#batt-val', '#voltage-val', '#hud-volt', '#obd-volt', '#cardVolt', '#cardVoltage', '#cardBatt', '#cardBattery',
        '[data-obd="voltage"]', '[data-obd="volt"]', '[data-obd="batt"]', '[data-telemetry="voltage"]', '.volt-value', '.batt-value'
      ], `${vFixed}`, vFixed);
      writeBySemanticCardLabel(/\b(battery\s*\/\s*alt|volt|voltage|battery|alternator)\b/i, /\b(body\s*battery)\b/i, `${vFixed}V`, vFixed);
    } else {
      // Scrub any corrupted ELM collision string (e.g. "104141043.0") from the Battery/Alt card immediately
      sanitizeCorruptedBatteryDom();
    }

    writeToExactSelectors([
      '#obd-status', '#ecu-status', '#daemon-status', '#telemetry-status', '[data-obd="status"]'
    ], `LINKED (${o.transport || 'BLE'})`, null);

    try {
      if (window.ZeldaOBD && typeof window.ZeldaOBD === 'object') {
        Object.assign(window.ZeldaOBD, {
          connected: true, rpm: o.rpm, speed: o.speedMph, gear: o.gear,
          load: o.load, coolant: o.coolantF, iat: o.intakeF, throttle: o.throttle, voltage: o.voltage
        });
      }
      if (typeof window.updateTelemetryUI === 'function') window.updateTelemetryUI(o);
    } catch (_) {}
  }



  function sanitizeCorruptedBatteryDom() {
    const fallbackV = (relayState.obd.voltage >= 8.5 && relayState.obd.voltage <= 18.5)
      ? Number(relayState.obd.voltage).toFixed(1)
      : null;
    const containers = document.querySelectorAll(
      '#valVolt, #valVoltage, #valBatt, #valBattery, #cardVolt, #cardBatt, [class*="card"], [class*="box"], [class*="gauge"]'
    );
    containers.forEach((box) => {
      const txt = (box.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length > 140 || !/\b(battery|alt|volt)\b/i.test(txt)) return;
      const leaves = box.children.length === 0 ? [box] : Array.from(box.querySelectorAll('*')).filter((n) => n.children.length === 0);
      for (const leaf of leaves) {
        const lt = (leaf.textContent || '').trim();
        const numM = lt.match(/^(\d{3,}(?:\.\d+)?)\s*V?$/i);
        if (numM && parseFloat(numM[1]) > 25) {
          const nextSib = leaf.nextElementSibling ? (leaf.nextElementSibling.textContent || '').trim() : '';
          const sepUnit = /^v$/i.test(nextSib);
          leaf.textContent = fallbackV ? (sepUnit ? fallbackV : `${fallbackV}V`) : '--';
        }
      }
    });
  }


  function isKnownGhostCanHeaderDtcSet(codesArr) {
    if (!codesArr || !codesArr.length) return false;
    const ghostSet = new Set(['P0003', 'C0300', 'P0007', 'C0700', 'P0000']);
    return codesArr.every((c) => ghostSet.has(c.toUpperCase()));
  }

  function sanitizeGhostDtcBannerDom() {
    const realCodes = (relayState.obd.storedDtcs || []).concat(relayState.obd.pendingDtcs || []);
    const uniqueReal = Array.from(new Set(realCodes)).filter((c) => !/^(?:P0003|C0300|P0007|C0700|P0000)$/i.test(c));

    // Scrub global ZeldaOBD state if zelda-daemon.js stored ghost codes there
    try {
      if (window.ZeldaOBD && Array.isArray(window.ZeldaOBD.dtcs)) {
        if (isKnownGhostCanHeaderDtcSet(window.ZeldaOBD.dtcs)) {
          window.ZeldaOBD.dtcs = uniqueReal;
        }
      }
    } catch (_) {}

    // Scrub top status pill (`DTC: P0003,C0300,P0007,C0700`) anywhere in DOM
    const candidates = document.querySelectorAll('span, div, button, badge, [id*="dtc" i], [class*="dtc" i]');
    candidates.forEach((el) => {
      if (el.children.length > 0) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 80) return;
      if (/C0300|C0700|P0003,C0300/i.test(t)) {
        if (uniqueReal.length > 0) {
          el.textContent = `DTC: ${uniqueReal.join(',')}`;
        } else {
          el.textContent = 'DTC: NONE';
          el.style.borderColor = '#00ff9d';
          el.style.color = '#00ff9d';
        }
      }
    });
  }

  function flushNextQueuedObdTx() {
    if (!hasNativeObd()) return;
    if (relayState.txBusy && (Date.now() - relayState.txBusySince < 650)) return;
    if (relayState.txQueue.length === 0) return;
    const nextB64 = relayState.txQueue.shift();
    relayState.txBusy = true;
    relayState.txBusySince = Date.now();
    try {
      window.ZeldaNativeObd.writeRawBase64(nextB64);
    } catch (_) {
      relayState.txBusy = false;
    }
  }

  function sanitizeFrameBlockForDaemon(rawBlock) {
    // Split any multi-line reply inside a single '>' block and validate fuel trim & voltage frames!
    const lines = String(rawBlock || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const safeLines = [];
    const decel = isDecelFuelCutWindow();

    for (const ln of lines) {
      // If mixed hex + ATRV voltage collided on one line, isolate the valid voltage!
      if (/\d+\.\d+\s*V/i.test(ln) && /41[0-9A-F]{2}/i.test(ln)) {
        const vm = ln.match(/(\d{1,2}\.\d{1,2}\s*V)/i);
        if (vm) safeLines.push(vm[1]);
        continue;
      }

      const nospace = ln.replace(/\s+/g, '').toUpperCase();

      // If two Mode 01 replies concatenated without '\r' (e.g. "410400410680" or "41060041087B"), drop corrupted collision!
      if (/^410[6-9]/.test(nospace) && nospace.length !== 6) {
        relayState.obd.blockedGlitchCount++;
        relayState.obd.lastTrimNote = `Dropped collided multi-PID frame (${nospace.slice(0, 14)})`;
        continue;
      }

      // Check 4106 (STFT B1) & 4108 (STFT B2) for Open-Loop 0x00 (-100%) or DFCO decel vacuum transient
      const stftM = nospace.match(/^41(06|08)([0-9A-F]{2})$/);
      if (stftM) {
        const pid = stftM[1];
        const b = parseInt(stftM[2], 16);
        const pct = (b - 128) / 1.28;

        // [1] Block impossible 0x00 (-100%) Open-Loop byte or > +/-45% glitch byte -> hold last steady closed-loop trim (or 0.0% = 0x80)
        if (b === 0 || pct < -45 || pct > 45) {
          const fallbackPct = pid === '06' ? (relayState.obd.stftB1 || 0) : (relayState.obd.stftB2 || 0);
          const holdHex = Math.max(88, Math.min(168, Math.round(fallbackPct * 1.28 + 128))).toString(16).toUpperCase().padStart(2, '0');
          safeLines.push(`41${pid}${holdHex}`);
          continue;
        }

        // [2] During throttle-off deceleration (DFCO), prevent normal intake-runner fuel-film flash (-18%..-29%) from firing false HUD rich alarms!
        if (decel && b < 0x70) {
          safeLines.push(`41${pid}72`); // Softens display/alarm to -10.9% ONLY while coasting foot-off-gas; steady idle passes 100% raw!
          continue;
        }
      }

      // Strip echoed ELM327 commands ("03", "07", "010C1", "ATZ", "ATE0") when ATE0 hasn't fired yet
      if (/^(?:03|07|04|01[0-9A-F]{2}\d?|AT[A-Z0-9]+)$/i.test(nospace)) {
        continue;
      }

      // Normalize ISO 15765-4 CAN Mode 03 / Mode 07 replies ("4300", "4700", "43010172") for legacy K-line parsers:
      // - "4300" / "4700" means 0 trouble codes -> send "43" / "47" with zero byte pairs so legacy parser never invents C0300/C0700!
      // - "43 <count> <AABB...>" -> strip the 1-byte CAN count byte so legacy parser reads real <AABB> pairs after "43"!
      const canDtcM = nospace.match(/^(43|47)([0-9A-F]{2})([0-9A-F]*)$/);
      if (canDtcM) {
        const svc = canDtcM[1];
        const cnt = parseInt(canDtcM[2], 16);
        const rest = canDtcM[3] || '';
        if (cnt === 0 || rest.replace(/0/g, '') === '') {
          safeLines.push(svc);
        } else {
          safeLines.push(svc + rest.slice(0, cnt * 4));
        }
        continue;
      }

      safeLines.push(ln);
    }

    return safeLines.join('\r') + '\r>';
  }

  function dispatchCleanStringToDaemon(str) {
    if (!str || relayState.bleChunkListeners.size === 0) return;
    const cleanBytes = new Uint8Array(str.length);
    for (let j = 0; j < str.length; j++) cleanBytes[j] = str.charCodeAt(j);
    const dv = new DataView(cleanBytes.buffer);
    relayState.bleChunkListeners.forEach((entry) => {
      try {
        entry.char.value = dv;
        const ev = { type: 'characteristicvaluechanged', target: entry.char, currentTarget: entry.char };
        entry.fn.call(entry.char, ev);
      } catch (_) {}
    });
  }

  // Called by ZeldaObdEngine.java on every raw byte chunk from Vgate (BLE or Classic SPP)
  window.__onZeldaNativeBleChunk = function (base64Str) {
    try {
      const bin = atob(base64Str);
      let ascii = '';
      for (let i = 0; i < bin.length; i++) {
        ascii += String.fromCharCode(bin.charCodeAt(i));
      }

      // Assemble complete '>' prompt-delimited ELM327 frames before parsing or forwarding to zelda-daemon.js!
      relayState.elmSniffBuf += ascii;
      if (relayState.elmSniffBuf.includes('>')) {
        const parts = relayState.elmSniffBuf.split('>');
        relayState.elmSniffBuf = parts.pop() || '';

        for (const rawBlock of parts) {
          parseElmHexFrameIntoObdState(rawBlock);
          const sanitizedFrame = sanitizeFrameBlockForDaemon(rawBlock);
          dispatchCleanStringToDaemon(sanitizedFrame);
        }

        syncHudGaugeDomRealtime(relayState.obd);
        sanitizeCorruptedBatteryDom();
        sanitizeGhostDtcBannerDom();
        updateWatchBadgeUi();

        // ELM327 returned '>' prompt -> safe to send next queued command without bus collision!
        relayState.txBusy = false;
        setTimeout(flushNextQueuedObdTx, 10);
      }
    } catch (_) {}
  };

  // Called by ZeldaObdEngine.java with pre-decoded JSON frames & connection state changes
  window.onZeldaNativeObd = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!data) return;
      const wasConnected = relayState.obd.connected;
      if (data.voltage != null && (data.voltage < 8.5 || data.voltage > 18.5)) {
        delete data.voltage;
      } else if (data.voltage != null) {
        relayState.lastValidVoltAt = Date.now();
      }
      Object.assign(relayState.obd, data, { updatedAt: Date.now() });
      if (relayState.obd.rpm != null && !data.gear) {
        relayState.obd.gear = estimate370z7AtGear(relayState.obd.rpm, relayState.obd.speedMph || 0);
      }
      syncHudGaugeDomRealtime(relayState.obd);
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
          if (relayState.txQueue.length < 6) {
            relayState.txQueue.push(uint8ToBase64(u8));
          }
          flushNextQueuedObdTx();
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
              syncHudGaugeDomRealtime(relayState.obd);
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
      if (el.id === 'zelda-watch-link-badge' || el.id === 'zelda-car-launcher-btn' || el.dataset.zeldaPttChecked === 'keep') return;
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
    if (fix && !relayState.obd.connected && fix.speed != null && isFinite(fix.speed)) {
      const gpsMph = Math.max(0, Math.round(Number(fix.speed) * 2.23694));
      writeToExactSelectors(['#valSpeed', '#speed-val', '#mph-val', '#hud-speed', '[data-obd="speed"]'], `${gpsMph}`, gpsMph);
    }
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
      if (o.stftB1 != null || o.stftB2 != null) obdItems.push(`Closed-Loop STFT B1/B2: ${o.stftB1 ?? 0}%/${o.stftB2 ?? 0}%`);
      if (o.ltftB1 != null || o.ltftB2 != null) obdItems.push(`LTFT B1/B2: ${o.ltftB1 ?? 0}%/${o.ltftB2 ?? 0}%`);
      if (o.storedDtcs && o.storedDtcs.length) obdItems.push(`Real Stored DTCs: ${o.storedDtcs.join(',')}`);
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

  function enqueueAsciiObdCmd(cmdStr) {
    if (!hasNativeObd()) return;
    const full = cmdStr.endsWith('\r') ? cmdStr : (cmdStr + '\r');
    const u8 = new Uint8Array(full.length);
    for (let i = 0; i < full.length; i++) u8[i] = full.charCodeAt(i);
    relayState.txQueue.push(uint8ToBase64(u8));
    flushNextQueuedObdTx();
  }

  function runRealEcuDtcAndTrimDiagnostic() {
    if (hasNativeObd() && relayState.obd.connected) {
      // Query real Nissan ECU Stored DTCs (03), Pending DTCs (07), and Long-Term Fuel Trims (0107 / 0109)
      ['01071', '01091', '03', '07'].forEach(enqueueAsciiObdCmd);
    }
    setTimeout(() => {
      const o = relayState.obd;
      const fmtPct = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${v}%`);
      const stored = o.storedDtcs && o.storedDtcs.length ? o.storedDtcs.join(', ') : 'NONE (0 Real ECU Codes)';
      const pending = o.pendingDtcs && o.pendingDtcs.length ? o.pendingDtcs.join(', ') : 'NONE (0 Pending Codes)';
      const report = [
        `=== 370Z VQ37VHR REAL ECU vs. SCANNER VERIFIER ===`,
        `Stored ECU Codes (Mode 03) : ${stored}`,
        `Pending ECU Codes (Mode 07): ${pending}`,
        `Steady Idle STFT B1 / B2   : ${fmtPct(o.idleStftB1 ?? o.stftB1)}  /  ${fmtPct(o.idleStftB2 ?? o.stftB2)}`,
        `Long-Term LTFT B1 / B2     : ${fmtPct(o.ltftB1)}  /  ${fmtPct(o.ltftB2)}`,
        `Last Decel/DFCO Swing B1/B2: ${fmtPct(o.decelStftB1)}  /  ${fmtPct(o.decelStftB2)}`,
        `Glitch/0x00 Bytes Blocked  : ${o.blockedGlitchCount}`,
        `Note: ${o.lastTrimNote}`
      ].join('\n');
      appendHudChatLog('ZELDA', report.replace(/\n/g, ' | '));
      window.alert(report);
    }, 1500);
  }

  function injectWatchLinkBadge() {
    if (document.getElementById('zelda-watch-link-badge')) return;

    const dock = document.createElement('div');
    dock.id = 'zelda-top-right-dock';
    dock.style.cssText = `
      position: fixed;
      top: 8px;
      right: 12px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 6px;
    `;

    // Show Native Car Home Launcher App/System Drawer Pill when running inside zelda-car-370z.apk!
    if (typeof window.ZeldaCarLauncher !== 'undefined' && window.ZeldaCarLauncher !== null) {
      const sysBtn = document.createElement('button');
      sysBtn.type = 'button';
      sysBtn.id = 'zelda-car-launcher-btn';
      sysBtn.textContent = '⊞ APPS';
      sysBtn.style.cssText = `
        background: rgba(14, 10, 28, 0.92);
        color: #ea80fc;
        border: 1px solid #b026ff;
        padding: 4px 9px;
        font-family: 'Orbitron', 'Rajdhani', monospace, sans-serif;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        cursor: pointer;
        border-radius: 999px;
        box-shadow: 0 0 10px rgba(176, 38, 255, 0.28);
      `;
      sysBtn.addEventListener('click', () => {
        try { window.ZeldaCarLauncher.openSystemDrawer(); } catch (_) {}
      });
      dock.appendChild(sysBtn);
    }

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.id = 'zelda-watch-link-badge';
    badge.style.cssText = `
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
        ? `370Z ECU: LIVE (${o.transport || 'BLE'}) — ${o.rpm || 0} RPM | ${o.voltage != null ? o.voltage + 'V' : '--'} | Idle Trim: ${o.stftB1 ?? '--'}%/${o.stftB2 ?? '--'}%`
        : `370Z ECU: Scanning Vgate (type OBD below to force rescan)`;
      const entered = window.prompt(
        `ZELDA COCKPIT v5.0 // ${currentShort}\n` +
        `${obdLine}\n` +
        `Gemini Key: ${hasKey ? 'LOCKED ✅' : 'NEEDED ❌ (Paste AIza... key below)'}\n\n` +
        `• Type DTC to check REAL 370Z ECU Codes & Idle vs Decel Trims\n` +
        `• Type APPS to open Car System / Wi-Fi / App Drawer\n` +
        `• Type OBD to force Vgate BLE/SPP rescan\n` +
        `• Paste AIza... Gemini key or 4-char Watch/Phone code:`,
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
      if (clean === 'DTC' || clean === 'CHECK') {
        runRealEcuDtcAndTrimDiagnostic();
        return;
      }
      if (clean === 'APPS' || clean === 'SYS' || clean === 'SETTINGS') {
        if (window.ZeldaCarLauncher) {
          try { window.ZeldaCarLauncher.openSystemDrawer(); } catch (_) {}
        }
        return;
      }
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

    dock.appendChild(badge);
    document.body.appendChild(dock);
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
      const ageMs = payload.ts ? Math.abs(Date.now() - payload.ts) : 0;
      const isActionPacket = (payload.type === 'voice' || payload.type === 'zlock');
      if (isActionPacket && ageMs > 25000) return;
      if (!isActionPacket && ageMs > 900000) return;

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
      const es = new EventSource(`https://ntfy.sh/${encodeURIComponent(topic)}/sse?since=15m`);
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
    setTimeout(() => { enqueueAsciiObdCmd('ATE0'); }, 600);
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

    // Immediately populate HUD biometric & OBD boxes from cached/live state and keep tabs synced!
    syncBiometricsDomRealtime(relayState.biometrics);
    setTimeout(() => syncBiometricsDomRealtime(relayState.biometrics), 600);
    setInterval(() => {
      syncBiometricsDomRealtime(relayState.biometrics);
      sanitizeCorruptedBatteryDom();
      sanitizeGhostDtcBannerDom();
      if (relayState.obd.connected) {
        syncHudGaugeDomRealtime(relayState.obd);
        if (hasNativeObd() && (Date.now() - relayState.lastValidVoltAt > 8000) && relayState.txQueue.length === 0) {
          const atrvBytes = new Uint8Array([65, 84, 82, 86, 13]); // "ATRV\r"
          relayState.txQueue.push(uint8ToBase64(atrvBytes));
          flushNextQueuedObdTx();
        }
      }
    }, 1200);

    document.addEventListener('click', (ev) => {
      if (ev.target && ev.target.closest('button, [role="button"], [data-tab], .tab-btn, nav')) {
        setTimeout(() => {
          syncBiometricsDomRealtime(relayState.biometrics);
          if (relayState.obd.connected) syncHudGaugeDomRealtime(relayState.obd);
        }, 80);
      }
    }, true);

    // Reconnect ntfy SSE immediately when returning to Project Zelda on Fold 7 or Car!
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !relayState.connected) {
        connectWatchRelay();
      }
    });
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
