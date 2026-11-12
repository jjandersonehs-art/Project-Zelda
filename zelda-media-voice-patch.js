/**
 * ==========================================================================
 * PROJECT ZELDA v4.5.4 — YOUTUBE IFRAME API + AI COMMAND SYNC + FAST VOICE
 * File: zelda-media-voice-patch.js (v2)
 * ==========================================================================
 * Fixes in v2:
 *  1. Syncs Zelda AI / YT Search commands with the controlled YouTube IFrame API:
 *     - Intercepts legacy iframe .src assignments, stray <iframe> injections,
 *       header title changes ("YOUTUBE // ..."), and global playYouTube functions
 *       so voice-requested songs/videos load and autoplay inside the main stage.
 *     - Auto-searches YouTube when Zelda updates the track title/query without an ID.
 *  2. Cuts Voice-to-Action Latency:
 *     - Instant local fast-path for "play <song/artist>", "next", "previous",
 *       "pause", and "resume" right on voice capture (no waiting on AI roundtrip).
 *     - Immediate speech silence finalizer (750ms debounce on partial transcripts)
 *       so Android's slow endpointing doesn't stall for 2-3 seconds after you stop talking.
 */

(function () {
  'use strict';

  const ZELDA_PATCH_VERSION = '4.5.4';
  const VAULT_QUEUE_KEY = 'zelda_yt_queue_v1';

  const DEFAULT_CYBERPUNK_QUEUE = [
    { id: 'KvMY1uzSC1E', title: 'CYBERPUNK: EDGERUNNERS // I REALLY WANT TO STAY AT YOUR HOUSE' },
    { id: 'P4bKZT_Eg4A', title: 'CYBERPUNK 2077 // NIGHT CITY RADIO MIX' },
    { id: 'gzbLODUb1sA', title: 'EDGERUNNERS // WHO IS READY FOR TOMORROW' },
    { id: 'b9u35P8X42I', title: 'KAVINSKY // NIGHTCALL (DRIVE SYNTH)' }
  ];

  const state = {
    ytApiReady: false,
    player: null,
    playerReady: false,
    pendingAction: null,
    playlistId: null,
    lastLoadedKey: null,
    lastHeaderQuery: '',
    queue: loadSavedQueue(),
    queueIndex: 0,
    autoNext: true,
    zoomFill: false,
    liveCallActive: false,
    pttActive: false,
    webRecognition: null,
    partialFinalizeTimer: null,
    lastDispatchedTranscript: '',
    lastDispatchedAt: 0
  };

  function loadSavedQueue() {
    try {
      if (window.ZeldaNativeVault && typeof window.ZeldaNativeVault.getItem === 'function') {
        const raw = window.ZeldaNativeVault.getItem(VAULT_QUEUE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      }
      const local = localStorage.getItem(VAULT_QUEUE_KEY);
      if (local) {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (err) {
      console.warn('[ZeldaPatch] Queue load fallback:', err);
    }
    return DEFAULT_CYBERPUNK_QUEUE.slice();
  }

  function saveQueue() {
    try {
      const serialized = JSON.stringify(state.queue);
      localStorage.setItem(VAULT_QUEUE_KEY, serialized);
      if (window.ZeldaNativeVault && typeof window.ZeldaNativeVault.setItem === 'function') {
        window.ZeldaNativeVault.setItem(VAULT_QUEUE_KEY, serialized);
      }
    } catch (err) {
      console.warn('[ZeldaPatch] Queue save warning:', err);
    }
  }

  /* ========================================================================
   * 1. URL, PLAYLIST & SEARCH QUERY PARSER
   * ======================================================================== */
  function parseYouTubeInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return null;
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    // Raw 11-char Video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return { videoId: trimmed, listId: null, searchQuery: null };
    }

    // Check if it looks like a URL or embed path
    if (/youtu\.?be|youtube\.com|youtube-nocookie\.com|\bembed\/|\bwatch\?/i.test(trimmed)) {
      try {
        const normalized = /^https?:\/\//i.test(trimmed)
          ? trimmed
          : trimmed.startsWith('//')
          ? 'https:' + trimmed
          : 'https://' + trimmed;
        const url = new URL(normalized);
        let videoId = url.searchParams.get('v');
        const listId = url.searchParams.get('list');
        const listType = url.searchParams.get('listType');

        // Handle embed?listType=search&list=QUERY
        if (listType === 'search' && listId) {
          return { videoId: null, listId: null, searchQuery: decodeURIComponent(listId) };
        }

        if (!videoId) {
          if (url.hostname.includes('youtu.be')) {
            videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
          } else if (url.pathname.includes('/embed/')) {
            videoId = url.pathname.split('/embed/')[1].split(/[/?&]/)[0];
          } else if (url.pathname.includes('/shorts/')) {
            videoId = url.pathname.split('/shorts/')[1].split(/[/?&]/)[0];
          }
        }

        if (videoId === 'videoseries' || videoId === 'embed') videoId = null;
        return {
          videoId: videoId && videoId.length === 11 ? videoId : null,
          listId: listId || null,
          searchQuery: null
        };
      } catch (_) {
        // Fall through to plain search query
      }
    }

    // Treat anything else (e.g. "Thundercat Them Changes") as a search query
    return { videoId: null, listId: null, searchQuery: trimmed };
  }

  /* ========================================================================
   * 2. FAST YOUTUBE VIDEO ID RESOLVER FOR SEARCH QUERIES
   * Uses YouTube's embed listType=search PLUS parallel Piped/Invidious JSON
   * lookup so voice searches resolve an exact playable 11-char videoId reliably.
   * ======================================================================== */
  const SEARCH_ENDPOINTS = [
    (q) => `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(q)}&filter=videos`,
    (q) => `https://inv.nadeko.net/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
    (q) => `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(q)}&type=video`
  ];

  async function resolveSearchToVideoItems(query) {
    const cleanQuery = query.replace(/^youtube\s*\/\/\s*/i, '').trim();
    if (!cleanQuery) return null;

    const fetchWithTimeout = (url, ms) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    };

    for (const buildUrl of SEARCH_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(buildUrl(cleanQuery), 2600);
        if (!res.ok) continue;
        const data = await res.json();

        // Piped format: { items: [{ url: "/watch?v=...", title: "..." }] }
        if (data && Array.isArray(data.items) && data.items.length > 0) {
          const mapped = data.items
            .map((it) => {
              const parsed = parseYouTubeInput(it.url || '');
              return parsed && parsed.videoId
                ? { id: parsed.videoId, title: (it.title || cleanQuery).toUpperCase() }
                : null;
            })
            .filter(Boolean);
          if (mapped.length > 0) return mapped.slice(0, 10);
        }

        // Invidious format: [{ videoId: "...", title: "..." }]
        if (Array.isArray(data) && data.length > 0) {
          const mapped = data
            .filter((it) => it && typeof it.videoId === 'string' && it.videoId.length === 11)
            .map((it) => ({
              id: it.videoId,
              title: (it.title || cleanQuery).toUpperCase()
            }));
          if (mapped.length > 0) return mapped.slice(0, 10);
        }
      } catch (_) {
        // Try next mirror
      }
    }
    return null;
  }

  async function playSearchQueryInStage(query) {
    const clean = query
      .replace(/^(?:youtube|yt|playing|now playing)\s*[:/\-]*\s*/i, '')
      .trim();
    if (!clean || clean.length < 2) return;

    const dedupeKey = 'search:' + clean.toLowerCase();
    if (state.lastLoadedKey === dedupeKey) return;
    state.lastLoadedKey = dedupeKey;

    // Switch HUD to 03 // AUDIO tab automatically if user asked from another tab
    ensureAudioTabVisible();
    updateStatusLabel(`SEARCHING // ${clean.toUpperCase()}`);

    // 1. Try fast API videoId resolution first (most reliable for embed playback + queue)
    const results = await resolveSearchToVideoItems(clean);
    if (results && results.length > 0) {
      state.playlistId = null;
      state.queue = results;
      state.queueIndex = 0;
      saveQueue();
      runWhenPlayerReady(() => {
        state.player.loadVideoById({ videoId: results[0].id, startSeconds: 0 });
        setTimeout(() => {
          try { state.player.playVideo(); } catch (_) {}
        }, 250);
      });
      updateStatusLabel(`[1/${results.length}] ${results[0].title}`);
      return;
    }

    // 2. Fallback: native YouTube IFrame search playlist
    runWhenPlayerReady(() => {
      state.playlistId = null;
      if (typeof state.player.loadPlaylist === 'function') {
        state.player.loadPlaylist({
          listType: 'search',
          list: clean,
          index: 0
        });
        setTimeout(() => {
          try { state.player.playVideo(); } catch (_) {}
        }, 350);
      }
      updateStatusLabel(`STREAM // ${clean.toUpperCase()}`);
    });
  }

  function runWhenPlayerReady(fn) {
    if (state.player && state.playerReady) {
      fn();
    } else {
      state.pendingAction = fn;
      if (!state.player && state.ytApiReady) {
        mountControlledPlayer();
      }
    }
  }

  function ensureAudioTabVisible() {
    try {
      const tabs = Array.from(document.querySelectorAll('button, [role="tab"], .tab-btn, nav *'));
      const audioTabBtn = tabs.find((el) =>
        /03\s*\/\/\s*AUDIO/i.test((el.textContent || '').trim())
      );
      if (audioTabBtn && !audioTabBtn.classList.contains('active')) {
        audioTabBtn.click();
      }
    } catch (_) {}
  }

  /* ========================================================================
   * 3. STAGE DISCOVERY & LEGACY IFRAME BRIDGE (FIXES "SMALL BOX UPDATES ONLY")
   * Why it happened:
   *  - Zelda's original index.html kept a JS reference to the old <iframe> element
   *    (which mountControlledPlayer() detached) OR wrote a new URL/title to its own
   *    small preview/header element while our YT.Player sat on the initial video.
   * Solution:
   *  - Keep a hidden proxy <iframe> with the exact original id/class AND trap `.src`
   *    assignments via Object.defineProperty so ANY legacy `ytIframe.src = ...`
   *    immediately routes to `state.player.loadVideoById(...)`!
   * ======================================================================== */
  function findYouTubeStage() {
    const existingIframe = document.querySelector(
      'iframe[src*="youtube.com"]:not([data-zelda-api-iframe]), iframe[src*="youtube-nocookie.com"]:not([data-zelda-api-iframe])'
    );
    if (existingIframe && existingIframe.parentElement) {
      const wrapper = existingIframe.parentElement;
      wrapper.classList.add('yt-stage-wrapper');
      if (wrapper.parentElement) wrapper.parentElement.classList.add('audio-tab-panel');
      return { wrapper, existingIframe };
    }

    const explicitWrapper = document.querySelector(
      '#yt-stage-wrapper, .yt-stage-wrapper, .yt-player-container, .youtube-embed-box, #youtube-player'
    );
    if (explicitWrapper) {
      explicitWrapper.classList.add('yt-stage-wrapper');
      if (explicitWrapper.parentElement) explicitWrapper.parentElement.classList.add('audio-tab-panel');
      return {
        wrapper: explicitWrapper,
        existingIframe: explicitWrapper.querySelector('iframe:not([data-zelda-api-iframe])')
      };
    }
    return null;
  }

  function installLegacyIframeSrcTrap(oldIframe) {
    if (!oldIframe || oldIframe.dataset.zeldaTrapped) return;
    oldIframe.dataset.zeldaTrapped = '1';

    const nativeSrcDesc =
      Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src') ||
      Object.getOwnPropertyDescriptor(Element.prototype, 'src');

    let lastTrappedSrc = oldIframe.getAttribute('src') || '';

    // Intercept direct property assignment: `ytFrame.src = "https://www.youtube.com/embed/..."`
    try {
      Object.defineProperty(oldIframe, 'src', {
        configurable: true,
        enumerable: true,
        get: function () {
          return lastTrappedSrc;
        },
        set: function (newUrl) {
          lastTrappedSrc = String(newUrl || '');
          console.log('[ZeldaPatch] Intercepted legacy iframe .src assignment:', lastTrappedSrc);
          routeExternalMediaRequest(lastTrappedSrc);
          if (nativeSrcDesc && nativeSrcDesc.set) {
            // Do NOT load audio twice in hidden iframe; keep blank
            nativeSrcDesc.set.call(oldIframe, 'about:blank');
          }
        }
      });
    } catch (e) {
      console.warn('[ZeldaPatch] defineProperty trap fallback:', e);
    }

    // Intercept `ytFrame.setAttribute('src', ...)`
    const origSetAttr = oldIframe.setAttribute.bind(oldIframe);
    oldIframe.setAttribute = function (name, val) {
      if (String(name).toLowerCase() === 'src' && val && val !== 'about:blank') {
        lastTrappedSrc = String(val);
        console.log('[ZeldaPatch] Intercepted legacy iframe setAttribute(src):', lastTrappedSrc);
        routeExternalMediaRequest(lastTrappedSrc);
        return origSetAttr('src', 'about:blank');
      }
      return origSetAttr(name, val);
    };

    // Hide the trapped legacy element instead of deleting it from memory so existing
    // closures in index.html (`const playerFrame = document.getElementById(...)`) stay alive!
    oldIframe.style.cssText =
      'display:none !important; width:0 !important; height:0 !important; pointer-events:none !important; position:absolute !important;';
    try {
      origSetAttr('src', 'about:blank');
    } catch (_) {}
  }

  function routeExternalMediaRequest(rawValue) {
    if (!rawValue || rawValue === 'about:blank') return;
    const parsed = parseYouTubeInput(rawValue);
    if (!parsed) return;

    if (parsed.listId) {
      loadUrlOrPlaylist(rawValue, false, true);
    } else if (parsed.videoId) {
      loadUrlOrPlaylist(parsed.videoId, false, true);
    } else if (parsed.searchQuery) {
      playSearchQueryInStage(parsed.searchQuery);
    }
  }

  /* ========================================================================
   * 4. WATCH SMALL RESULT CARDS / HEADER BAR & GLOBAL YOUTUBE HELPERS
   * Handles the exact case where Zelda shows the requested video in a small
   * search/result box or updates the "YOUTUBE // ..." title without firing
   * the main stage player.
   * ======================================================================== */
  function hookGlobalZeldaMediaFunctions() {
    // Wrap common function names used in Zelda HUD scripts if they exist
    const candidateFnNames = [
      'playYouTube',
      'loadYouTube',
      'playVideo',
      'loadYouTubeVideo',
      'setYouTubeVideo',
      'openYouTube',
      'searchYouTube',
      'zeldaPlayYouTube'
    ];

    candidateFnNames.forEach((fnName) => {
      if (typeof window[fnName] === 'function' && !window[fnName]._zeldaWrapped) {
        const orig = window[fnName];
        const wrapped = function (...args) {
          const res = orig.apply(this, args);
          if (args[0]) {
            const arg = args[0];
            if (typeof arg === 'string') {
              routeExternalMediaRequest(arg);
            } else if (typeof arg === 'object' && (arg.videoId || arg.id || arg.url || arg.query)) {
              routeExternalMediaRequest(arg.videoId || arg.id || arg.url || arg.query);
            }
          }
          return res;
        };
        wrapped._zeldaWrapped = true;
        window[fnName] = wrapped;
      }
    });
  }

  function scanDomForNewVideoTriggers(mutations) {
    for (const m of mutations) {
      // A. Did Zelda inject a new <iframe> or thumbnail card with a YouTube video ID?
      if (m.addedNodes && m.addedNodes.length > 0) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;

          // Stray YouTube iframe injected outside our API mount
          const iframes = node.tagName === 'IFRAME' ? [node] : Array.from(node.querySelectorAll?.('iframe') || []);
          iframes.forEach((ifr) => {
            if (ifr.id === 'zelda-yt-api-mount' || ifr.dataset.zeldaApiIframe || ifr.dataset.zeldaTrapped) return;
            const src = ifr.getAttribute('src') || '';
            if (/youtube\.com|youtube-nocookie\.com/i.test(src)) {
              console.log('[ZeldaPatch] Captured newly injected YouTube iframe:', src);
              installLegacyIframeSrcTrap(ifr);
              routeExternalMediaRequest(src);
            }
          });

          // Small video preview box / thumbnail (`i.ytimg.com/vi/<VIDEO_ID>/...` or `data-video-id`)
          const vidAttrEl = node.matches?.('[data-video-id], [data-yt-id]')
            ? node
            : node.querySelector?.('[data-video-id], [data-yt-id]');
          if (vidAttrEl) {
            const vid = vidAttrEl.getAttribute('data-video-id') || vidAttrEl.getAttribute('data-yt-id');
            if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
              console.log('[ZeldaPatch] Auto-playing newly rendered video card ID:', vid);
              loadUrlOrPlaylist(vid, false, true);
              return;
            }
          }

          const ytThumb = node.tagName === 'IMG' ? node : node.querySelector?.('img[src*="ytimg.com/vi/"], img[src*="img.youtube.com/vi/"]');
          if (ytThumb && ytThumb.src) {
            const match = ytThumb.src.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
            if (match && match[1]) {
              console.log('[ZeldaPatch] Auto-playing newly rendered YouTube thumbnail ID:', match[1]);
              loadUrlOrPlaylist(match[1], false, true);
            }
          }

          // Anchor link to youtube watch?v=... inside small preview box
          const ytLink = node.tagName === 'A' ? node : node.querySelector?.('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
          if (ytLink && ytLink.href) {
            const parsed = parseYouTubeInput(ytLink.href);
            if (parsed && (parsed.videoId || parsed.listId)) {
              console.log('[ZeldaPatch] Auto-playing newly rendered YouTube link:', ytLink.href);
              loadUrlOrPlaylist(ytLink.href, false, true);
            }
          }
        });
      }

      // B. Did an existing thumbnail img or data-video-id change its attribute?
      if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
        const el = m.target;
        if (el.tagName === 'IMG' && el.src && /ytimg\.com\/vi\/|img\.youtube\.com\/vi\//.test(el.src)) {
          const match = el.src.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
          if (match && match[1]) {
            loadUrlOrPlaylist(match[1], false, true);
          }
        } else if (el.hasAttribute('data-video-id')) {
          const vid = el.getAttribute('data-video-id');
          if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
            loadUrlOrPlaylist(vid, false, true);
          }
        }
      }
    }

    // C. Check if the "YOUTUBE // <TITLE>" header text changed from an AI response
    const headerCandidates = document.querySelectorAll(
      '#yt-title, #youtube-title, .yt-header-title, [data-yt-title]'
    );
    headerCandidates.forEach((hdr) => {
      const txt = (hdr.textContent || '').trim();
      if (txt && txt !== state.lastHeaderQuery && !/CYBERPUNK:\s*EDGERUNNERS/i.test(txt)) {
        state.lastHeaderQuery = txt;
        playSearchQueryInStage(txt);
      }
    });
  }

  /* ========================================================================
   * 5. TRANSPORT BAR & CONTROLLED YOUTUBE IFRAME API
   * ======================================================================== */
  function injectTransportBar(stageWrapper) {
    if (document.getElementById('zelda-yt-transport-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'zelda-yt-transport-bar';
    bar.className = 'zelda-yt-transport-bar';
    bar.innerHTML = `
      <div class="zelda-yt-transport-group">
        <button type="button" class="zelda-yt-btn" id="zelda-btn-yt-prev" title="Previous Video">&#9198; PREV</button>
        <button type="button" class="zelda-yt-btn zelda-yt-btn--cyan" id="zelda-btn-yt-play" title="Play / Pause">&#9199; PLAY</button>
        <button type="button" class="zelda-yt-btn" id="zelda-btn-yt-next" title="Next Video">NEXT &#9197;</button>
      </div>
      <div class="zelda-yt-queue-status" id="zelda-yt-queue-label">QUEUE // READY</div>
      <div class="zelda-yt-transport-group">
        <button type="button" class="zelda-yt-btn zelda-yt-btn--cyan is-active" id="zelda-btn-yt-autonext" title="Auto-Advance Playlist / Queue">AUTO-NEXT</button>
        <button type="button" class="zelda-yt-btn" id="zelda-btn-yt-fill" title="Toggle Portrait Zoom Fill">SCALE: FIT</button>
      </div>
    `;

    stageWrapper.insertAdjacentElement('afterend', bar);

    document.getElementById('zelda-btn-yt-prev').addEventListener('click', playPreviousVideo);
    document.getElementById('zelda-btn-yt-next').addEventListener('click', playNextVideo);
    document.getElementById('zelda-btn-yt-play').addEventListener('click', togglePlayPause);

    const autoBtn = document.getElementById('zelda-btn-yt-autonext');
    autoBtn.addEventListener('click', function () {
      state.autoNext = !state.autoNext;
      autoBtn.classList.toggle('is-active', state.autoNext);
      updateStatusLabel(state.autoNext ? 'AUTO-NEXT // ON' : 'AUTO-NEXT // OFF');
    });

    const fillBtn = document.getElementById('zelda-btn-yt-fill');
    fillBtn.addEventListener('click', function () {
      state.zoomFill = !state.zoomFill;
      stageWrapper.classList.toggle('zelda-yt-zoom-fill', state.zoomFill);
      fillBtn.classList.toggle('is-active', state.zoomFill);
      fillBtn.textContent = state.zoomFill ? 'SCALE: FILL' : 'SCALE: FIT';
    });
  }

  function updateStatusLabel(customText) {
    const label = document.getElementById('zelda-yt-queue-label');
    if (!label) return;
    if (customText) {
      label.textContent = customText;
      return;
    }
    if (state.playlistId) {
      label.textContent = 'YT PLAYLIST // AUTO';
    } else if (state.queue.length > 0) {
      const current = state.queue[state.queueIndex] || state.queue[0];
      label.textContent = `[${state.queueIndex + 1}/${state.queue.length}] ${current.title || current.id}`;
    }
  }

  function loadYouTubeIframeApi() {
    if (window.YT && window.YT.Player) {
      state.ytApiReady = true;
      mountControlledPlayer();
      return;
    }

    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      state.ytApiReady = true;
      if (typeof prevCallback === 'function') prevCallback();
      mountControlledPlayer();
    };

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  }

  function mountControlledPlayer() {
    const found = findYouTubeStage();
    if (!found) return;

    const { wrapper, existingIframe } = found;
    injectTransportBar(wrapper);

    let initialParsed = null;
    if (existingIframe) {
      const rawSrc = existingIframe.getAttribute('src') || existingIframe.src || '';
      initialParsed = parseYouTubeInput(rawSrc);
      // Trap instead of destroying so index.html's reference stays hooked!
      installLegacyIframeSrcTrap(existingIframe);
    }

    if (initialParsed && initialParsed.listId) {
      state.playlistId = initialParsed.listId;
    } else if (initialParsed && initialParsed.videoId) {
      const idx = state.queue.findIndex((item) => item.id === initialParsed.videoId);
      if (idx >= 0) {
        state.queueIndex = idx;
      } else {
        state.queue.unshift({ id: initialParsed.videoId, title: 'ACTIVE STREAM' });
        state.queueIndex = 0;
      }
    }

    let mountDiv = document.getElementById('zelda-yt-api-mount');
    if (!mountDiv) {
      mountDiv = document.createElement('div');
      mountDiv.id = 'zelda-yt-api-mount';
      wrapper.appendChild(mountDiv);
    }

    const playerVars = {
      autoplay: 1,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin.startsWith('http')
        ? window.location.origin
        : 'https://jjandersonehs-art.github.io'
    };

    if (state.playlistId) {
      playerVars.listType = 'playlist';
      playerVars.list = state.playlistId;
      playerVars.loop = 1;
    }

    const startVideoId =
      (initialParsed && initialParsed.videoId) ||
      (state.queue[state.queueIndex] && state.queue[state.queueIndex].id) ||
      DEFAULT_CYBERPUNK_QUEUE[0].id;

    state.player = new window.YT.Player('zelda-yt-api-mount', {
      width: '100%',
      height: '100%',
      videoId: state.playlistId && !initialParsed?.videoId ? undefined : startVideoId,
      playerVars,
      events: {
        onReady: function (ev) {
          state.playerReady = true;
          const apiFrame = ev.target && typeof ev.target.getIframe === 'function' ? ev.target.getIframe() : null;
          if (apiFrame) {
            apiFrame.dataset.zeldaApiIframe = '1';
            apiFrame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
          }
          updateStatusLabel();
          if (typeof state.pendingAction === 'function') {
            const act = state.pendingAction;
            state.pendingAction = null;
            act();
          }
        },
        onStateChange: handlePlayerStateChange,
        onError: function (e) {
          console.warn('[ZeldaPatch] YT Player error code:', e.data, '-> skipping to next');
          if (state.autoNext) {
            setTimeout(playNextVideo, 900);
          }
        }
      }
    });

    interceptUrlAndSearchButtons();
  }

  function handlePlayerStateChange(event) {
    const YTState = window.YT.PlayerState;
    const playBtn = document.getElementById('zelda-btn-yt-play');

    if (event.data === YTState.PLAYING) {
      if (playBtn) playBtn.innerHTML = '&#9208; PAUSE';
      syncHeaderTitleFromPlayer();
    } else if (event.data === YTState.PAUSED) {
      if (playBtn) playBtn.innerHTML = '&#9654; PLAY';
    } else if (event.data === YTState.ENDED) {
      if (playBtn) playBtn.innerHTML = '&#9654; PLAY';
      if (state.autoNext && !state.playlistId) {
        playNextVideo();
      }
    }
  }

  function syncHeaderTitleFromPlayer() {
    if (!state.player || typeof state.player.getVideoData !== 'function') return;
    const data = state.player.getVideoData();
    if (data && data.title) {
      if (!state.playlistId && state.queue[state.queueIndex]) {
        state.queue[state.queueIndex].title = data.title.toUpperCase();
        saveQueue();
      }
      updateStatusLabel(
        state.playlistId ? `PLAYLIST // ${data.title.toUpperCase()}` : undefined
      );
    }
  }

  function togglePlayPause() {
    if (!state.player || typeof state.player.getPlayerState !== 'function') return;
    const current = state.player.getPlayerState();
    if (current === window.YT.PlayerState.PLAYING) {
      state.player.pauseVideo();
    } else {
      state.player.playVideo();
    }
  }

  function playNextVideo() {
    if (!state.player) return;
    if (state.playlistId && typeof state.player.nextVideo === 'function') {
      state.player.nextVideo();
      return;
    }
    if (state.queue.length === 0) return;
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    const nextItem = state.queue[state.queueIndex];
    state.lastLoadedKey = 'vid:' + nextItem.id;
    state.player.loadVideoById(nextItem.id);
    updateStatusLabel();
  }

  function playPreviousVideo() {
    if (!state.player) return;
    if (state.playlistId && typeof state.player.previousVideo === 'function') {
      state.player.previousVideo();
      return;
    }
    if (state.queue.length === 0) return;
    state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    const prevItem = state.queue[state.queueIndex];
    state.lastLoadedKey = 'vid:' + prevItem.id;
    state.player.loadVideoById(prevItem.id);
    updateStatusLabel();
  }

  function loadUrlOrPlaylist(rawUrlOrQuery, queueMode = false, forceAutoplay = true) {
    const parsed = parseYouTubeInput(rawUrlOrQuery);
    if (!parsed) return false;

    if (parsed.searchQuery) {
      playSearchQueryInStage(parsed.searchQuery);
      return true;
    }

    if (parsed.listId) {
      const key = 'list:' + parsed.listId;
      if (state.lastLoadedKey === key) return true;
      state.lastLoadedKey = key;
      state.playlistId = parsed.listId;
      ensureAudioTabVisible();
      runWhenPlayerReady(() => {
        if (typeof state.player.loadPlaylist === 'function') {
          state.player.loadPlaylist({
            list: parsed.listId,
            listType: 'playlist',
            index: 0
          });
          if (forceAutoplay) {
            setTimeout(() => {
              try { state.player.playVideo(); } catch (_) {}
            }, 250);
          }
        }
      });
      updateStatusLabel('PLAYLIST // LOADED');
      return true;
    }

    if (!parsed.videoId) return false;

    const key = 'vid:' + parsed.videoId;
    if (state.lastLoadedKey === key && !queueMode) return true;
    state.lastLoadedKey = key;

    state.playlistId = null;
    const existingIdx = state.queue.findIndex((x) => x.id === parsed.videoId);
    if (existingIdx >= 0) {
      state.queueIndex = existingIdx;
    } else if (queueMode) {
      state.queue.push({ id: parsed.videoId, title: 'QUEUED TRACK' });
      updateStatusLabel(`QUEUED [${state.queue.length}]`);
      saveQueue();
      return true;
    } else {
      state.queue.unshift({ id: parsed.videoId, title: 'ACTIVE STREAM' });
      state.queueIndex = 0;
      saveQueue();
    }

    ensureAudioTabVisible();
    runWhenPlayerReady(() => {
      state.player.loadVideoById({ videoId: parsed.videoId, startSeconds: 0 });
      if (forceAutoplay) {
        setTimeout(() => {
          try { state.player.playVideo(); } catch (_) {}
        }, 200);
      }
    });
    updateStatusLabel();
    return true;
  }

  function interceptUrlAndSearchButtons() {
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"], .hud-btn'));

    const ytUrlBtn = allButtons.find((el) => /YT\s*URL/i.test((el.textContent || '').trim()));
    if (ytUrlBtn && !ytUrlBtn.dataset.zeldaYtHooked) {
      ytUrlBtn.dataset.zeldaYtHooked = '1';
      ytUrlBtn.addEventListener(
        'click',
        function (e) {
          const input = window.prompt('PASTE YOUTUBE VIDEO OR PLAYLIST URL:');
          if (input && input.trim()) {
            e.stopImmediatePropagation();
            e.preventDefault();
            loadUrlOrPlaylist(input.trim(), false, true);
          }
        },
        true
      );
    }

    const ytSearchBtn = allButtons.find((el) => /YT\s*SEARCH/i.test((el.textContent || '').trim()));
    if (ytSearchBtn && !ytSearchBtn.dataset.zeldaSearchHooked) {
      ytSearchBtn.dataset.zeldaSearchHooked = '1';
      ytSearchBtn.addEventListener(
        'click',
        function (e) {
          const query = window.prompt('SEARCH YOUTUBE & PLAY DIRECTLY:');
          if (query && query.trim()) {
            e.stopImmediatePropagation();
            e.preventDefault();
            playSearchQueryInStage(query.trim());
          }
        },
        true
      );
    }

    // Also allow clicking any small preview card inside 03 // AUDIO to force-play in main stage
    document.addEventListener(
      'click',
      function (e) {
        const card = e.target.closest?.('[data-video-id], [data-yt-id], a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
        if (!card) return;
        const vid =
          card.getAttribute('data-video-id') ||
          card.getAttribute('data-yt-id') ||
          card.getAttribute('href');
        if (vid) {
          e.preventDefault();
          loadUrlOrPlaylist(vid, false, true);
        }
      },
      true
    );
  }

  /* ========================================================================
   * 6. LOW-LATENCY VOICE ROUTER + INSTANT MEDIA INTENT FAST-PATH
   * Why there was a delay:
   *  1) Android SpeechRecognizer waits ~1.5s–2.5s of dead silence before marking
   *     a result `isFinal = true`.
   *  2) Then Zelda sends the text to Gemini AI, waits for the JSON/chat reply,
   *     and runs TTS before acting.
   * How we make it snappy:
   *  - 750ms silence auto-finalizer on partial speech transcripts so commands
   *    fire less than a second after you stop speaking.
   *  - Instant local Voice Media Fast-Path: if you say "Play <X> on YouTube",
   *    "Next song/video", "Previous video", or "Pause/Resume", we start loading
   *    the YouTube video IMMEDIATELY in parallel while Zelda generates her witty reply!
   * ======================================================================== */
  function tryInstantVoiceMediaFastPath(transcript) {
    const clean = transcript.trim();
    if (!clean) return false;

    // Transport fast-path
    if (/^(?:zelda[,\s]+)?(?:next|skip)(?:\s+(?:video|song|track))?$/i.test(clean)) {
      playNextVideo();
      return true;
    }
    if (/^(?:zelda[,\s]+)?(?:previous|prev|go back|last)(?:\s+(?:video|song|track))?$/i.test(clean)) {
      playPreviousVideo();
      return true;
    }
    if (/^(?:zelda[,\s]+)?(?:pause|stop)(?:\s+(?:video|music|playback|youtube))?$/i.test(clean)) {
      if (state.player && typeof state.player.pauseVideo === 'function') state.player.pauseVideo();
      return true;
    }
    if (/^(?:zelda[,\s]+)?(?:resume|unpause|continue playing)$/i.test(clean)) {
      if (state.player && typeof state.player.playVideo === 'function') state.player.playVideo();
      return true;
    }

    // "Play <query> [on YouTube]" fast-path — fires immediately in parallel with Zelda's AI chat!
    const playMatch = clean.match(
      /^(?:hey\s+zelda[,\s]+|yo\s+zelda[,\s]+|zelda[,\s]+)?(?:can you\s+|please\s+)?(?:play|put on|throw on|queue up)\s+(.+?)(?:\s+on\s+youtube|\s+on\s+yt|\s+music video|\s+video)?$/i
    );
    if (playMatch && playMatch[1]) {
      const requestedQuery = playMatch[1].trim();
      if (requestedQuery.length >= 2) {
        console.log('[ZeldaFastPath] Starting instant YouTube load for:', requestedQuery);
        playSearchQueryInStage(requestedQuery);
        return true;
      }
    }
    return false;
  }

  function hasNativeVoiceBridge() {
    return typeof window.ZeldaNativeVoice !== 'undefined' && window.ZeldaNativeVoice !== null;
  }

  function dispatchTranscriptToZelda(transcript, isFinal) {
    if (!transcript) return;
    const trimmed = transcript.trim();
    if (!trimmed) return;

    // Clear pending partial timer whenever any update arrives
    if (state.partialFinalizeTimer) {
      clearTimeout(state.partialFinalizeTimer);
      state.partialFinalizeTimer = null;
    }

    // Deduplicate double-fires (when our 750ms fast-finalizer fires right before Kotlin's late final)
    const now = Date.now();
    if (
      isFinal &&
      trimmed.toLowerCase() === state.lastDispatchedTranscript.toLowerCase() &&
      now - state.lastDispatchedAt < 3200
    ) {
      return;
    }

    const textInput = document.querySelector(
      'input[placeholder*="Zelda" i], input[placeholder*="Say" i], input[placeholder*="Ask" i], #zelda-chat-input, #voice-input, textarea'
    );
    if (textInput) {
      textInput.value = trimmed;
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    window.dispatchEvent(
      new CustomEvent('zelda:voice-transcript', {
        detail: { transcript: trimmed, isFinal: Boolean(isFinal) }
      })
    );

    if (!isFinal) {
      // Fast silence detector: if speaker pauses for 750ms, finalize immediately instead of waiting 2.5s
      if (trimmed.split(/\s+/).length >= 2) {
        state.partialFinalizeTimer = setTimeout(() => {
          dispatchTranscriptToZelda(trimmed, true);
        }, 750);
      }
      return;
    }

    state.lastDispatchedTranscript = trimmed;
    state.lastDispatchedAt = now;

    // 1. Trigger instant media action immediately (zero AI wait!)
    tryInstantVoiceMediaFastPath(trimmed);

    // 2. Submit to Zelda AI so she still speaks/responds in character
    if (typeof window.handleZeldaVoiceCommand === 'function') {
      window.handleZeldaVoiceCommand(trimmed);
      return;
    }
    const sendBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      /^SEND$/i.test((b.textContent || '').trim())
    );
    if (sendBtn && textInput) {
      sendBtn.click();
    }
  }

  window.onZeldaVoiceResult = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const text = data?.transcript || data?.text || (typeof payload === 'string' ? payload : '');
      const isFinal = data?.isFinal !== undefined ? data.isFinal : true;
      dispatchTranscriptToZelda(text, isFinal);

      if (isFinal && state.liveCallActive) {
        setTimeout(() => {
          if (state.liveCallActive) startNativeOrWebMic(true);
        }, 250);
      }
    } catch (_) {
      dispatchTranscriptToZelda(String(payload), true);
    }
  };

  window.onZeldaVoicePartial = function (partialText) {
    dispatchTranscriptToZelda(partialText, false);
  };

  window.onZeldaVoiceError = function (errPayload) {
    console.warn('[ZeldaVoice] Native error:', errPayload);
    if (state.liveCallActive) {
      setTimeout(() => {
        if (state.liveCallActive) startNativeOrWebMic(true);
      }, 650);
    }
  };

  function startNativeOrWebMic(continuousMode) {
    if (hasNativeVoiceBridge()) {
      const nv = window.ZeldaNativeVoice;
      try {
        if (continuousMode && typeof nv.startContinuousListening === 'function') {
          nv.startContinuousListening();
          return;
        }
        if (typeof nv.startListening === 'function') {
          nv.startListening();
          return;
        }
        if (typeof nv.startRecognition === 'function') {
          nv.startRecognition();
          return;
        }
        if (typeof nv.startPtt === 'function') {
          nv.startPtt();
          return;
        }
      } catch (err) {
        console.error('[ZeldaVoice] Native start error:', err);
      }
    }

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    try {
      if (!state.webRecognition) {
        const rec = new SpeechRec();
        rec.lang = 'en-US';
        rec.interimResults = true;
        rec.continuous = Boolean(continuousMode);
        rec.onresult = function (ev) {
          let latest = '';
          let isFinal = false;
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            latest += ev.results[i][0].transcript;
            if (ev.results[i].isFinal) isFinal = true;
          }
          dispatchTranscriptToZelda(latest.trim(), isFinal);
        };
        state.webRecognition = rec;
      }
      state.webRecognition.continuous = Boolean(continuousMode);
      state.webRecognition.start();
    } catch (_) {}
  }

  function stopNativeOrWebMic() {
    if (hasNativeVoiceBridge()) {
      const nv = window.ZeldaNativeVoice;
      try {
        if (typeof nv.stopListening === 'function') nv.stopListening();
        else if (typeof nv.stopRecognition === 'function') nv.stopRecognition();
        else if (typeof nv.stopPtt === 'function') nv.stopPtt();
      } catch (_) {}
    }
    if (state.webRecognition) {
      try { state.webRecognition.stop(); } catch (_) {}
    }
  }

  function bindVoiceButtons() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], .hud-btn'));
    const liveCallBtn = buttons.find((el) => /LIVE\s*CALL/i.test((el.textContent || '').trim()));
    const holdPttBtn = buttons.find((el) => /HOLD\s*PTT/i.test((el.textContent || '').trim()));

    if (liveCallBtn && !liveCallBtn.dataset.zeldaNativeVoiceBound) {
      liveCallBtn.dataset.zeldaNativeVoiceBound = '1';
      liveCallBtn.addEventListener(
        'click',
        function (e) {
          e.stopImmediatePropagation();
          e.preventDefault();
          state.liveCallActive = !state.liveCallActive;
          liveCallBtn.classList.toggle('zelda-mic-listening', state.liveCallActive);
          if (state.liveCallActive) startNativeOrWebMic(true);
          else stopNativeOrWebMic();
        },
        true
      );
    }

    if (holdPttBtn && !holdPttBtn.dataset.zeldaNativeVoiceBound) {
      holdPttBtn.dataset.zeldaNativeVoiceBound = '1';

      const engagePtt = function (e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (state.pttActive) return;
        state.pttActive = true;
        holdPttBtn.classList.add('zelda-mic-listening');
        startNativeOrWebMic(false);
      };

      const releasePtt = function (e) {
        if (!state.pttActive) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        state.pttActive = false;
        holdPttBtn.classList.remove('zelda-mic-listening');
        stopNativeOrWebMic();
      };

      holdPttBtn.addEventListener('pointerdown', engagePtt, true);
      holdPttBtn.addEventListener('pointerup', releasePtt, true);
      holdPttBtn.addEventListener('pointercancel', releasePtt, true);
      holdPttBtn.addEventListener('touchstart', engagePtt, { capture: true, passive: false });
      holdPttBtn.addEventListener('touchend', releasePtt, { capture: true, passive: false });
    }
  }

  /* ========================================================================
   * 7. BLUETOOTH AVRCP METADATA RECEIVER HOOK
   * ======================================================================== */
  window.onZeldaMediaMetadata = function (rawMeta) {
    try {
      const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
      if (!meta) return;

      const setText = (selector, val) => {
        const el = document.querySelector(selector);
        if (el && val) el.textContent = val;
      };

      setText('#bt-track-title, [data-bt-title], .bt-song-title', meta.title || 'UNKNOWN TRACK');
      setText('#bt-track-artist, [data-bt-artist], .bt-artist-name', meta.artist || 'UNKNOWN ARTIST');
      setText('#bt-track-album, [data-bt-album], .bt-album-name', meta.album || '');

      const artImg = document.querySelector('#bt-album-art, [data-bt-art], .bt-album-cover img');
      if (artImg && meta.artworkBase64) {
        artImg.src = meta.artworkBase64.startsWith('data:')
          ? meta.artworkBase64
          : 'data:image/jpeg;base64,' + meta.artworkBase64;
      }

      window.dispatchEvent(new CustomEvent('zelda:bt-metadata', { detail: meta }));
    } catch (err) {
      console.warn('[ZeldaBT] Metadata parse warning:', err);
    }
  };

  /* ========================================================================
   * 8. BOOTSTRAP
   * ======================================================================== */
  function initPatch() {
    bindVoiceButtons();
    hookGlobalZeldaMediaFunctions();
    loadYouTubeIframeApi();

    const observer = new MutationObserver((mutations) => {
      bindVoiceButtons();
      hookGlobalZeldaMediaFunctions();
      if (!state.player && state.ytApiReady && findYouTubeStage()) {
        mountControlledPlayer();
      }
      scanDomForNewVideoTriggers(mutations);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-video-id', 'data-yt-id']
    });
  }

  window.ZeldaYouTube = {
    version: ZELDA_PATCH_VERSION,
    load: loadUrlOrPlaylist,
    searchAndPlay: playSearchQueryInStage,
    next: playNextVideo,
    prev: playPreviousVideo,
    togglePlay: togglePlayPause,
    getQueue: () => state.queue.slice()
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPatch);
  } else {
    initPatch();
  }
})();
