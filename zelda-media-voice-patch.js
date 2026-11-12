/**
 * ==========================================================================
 * PROJECT ZELDA v4.5.3 — YOUTUBE IFRAME API + PLAYLIST ENGINE + NATIVE VOICE
 * File: zelda-media-voice-patch.js
 * ==========================================================================
 * Drop <script src="zelda-media-voice-patch.js"></script> right before </body>
 * in index.html (after your main HUD scripts).
 *
 * Features:
 *  1. Converts static YouTube <iframe> into controlled YouTube IFrame Player API
 *  2. Expands YouTube stage to full vertical space + adds [FIT / ZOOM] toggle
 *  3. Auto-advances playlists (&list=PL...) AND custom Zelda video queues on ENDED
 *  4. Injects [⏮ PREV], [⏯ PLAY], [NEXT ⏭], [AUTO-NEXT], and [SCALE FILL] HUD controls
 *  5. Routes [LIVE CALL] and [HOLD PTT] directly to Android's window.ZeldaNativeVoice
 *     (bypassing broken Android WebView SpeechRecognition) with browser fallback on PC.
 *  6. Exposes window.onZeldaMediaMetadata(payload) ready for Bluetooth AVRCP metadata.
 */

(function () {
  'use strict';

  const ZELDA_PATCH_VERSION = '4.5.3';
  const VAULT_QUEUE_KEY = 'zelda_yt_queue_v1';

  // Default Cyberpunk queue so [PREV] / [NEXT] and auto-advance work out of the box
  const DEFAULT_CYBERPUNK_QUEUE = [
    { id: 'KvMY1uzSC1E', title: 'CYBERPUNK: EDGERUNNERS // I REALLY WANT TO STAY AT YOUR HOUSE' },
    { id: 'P4bKZT_Eg4A', title: 'CYBERPUNK 2077 // NIGHT CITY RADIO MIX' },
    { id: 'gzbLODUb1sA', title: 'EDGERUNNERS // WHO IS READY FOR TOMORROW' },
    { id: 'b9u35P8X42I', title: 'KAVINSKY // NIGHTCALL (DRIVE SYNTH)' }
  ];

  const state = {
    ytApiReady: false,
    player: null,
    playlistId: null,
    queue: loadSavedQueue(),
    queueIndex: 0,
    autoNext: true,
    zoomFill: false,
    liveCallActive: false,
    pttActive: false,
    webRecognition: null
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
   * 1. URL & PLAYLIST PARSER
   * Accepts full YouTube watch URLs, youtu.be shortlinks, embed URLs,
   * playlist URLs (?list=PL...), or raw 11-char video IDs.
   * ======================================================================== */
  function parseYouTubeInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return null;
    const trimmed = rawInput.trim();

    // Raw 11-char Video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return { videoId: trimmed, listId: null };
    }

    try {
      const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
      const url = new URL(normalized);
      let videoId = url.searchParams.get('v');
      const listId = url.searchParams.get('list');

      if (!videoId) {
        if (url.hostname.includes('youtu.be')) {
          videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
        } else if (url.pathname.includes('/embed/')) {
          videoId = url.pathname.split('/embed/')[1].split(/[/?&]/)[0];
        } else if (url.pathname.includes('/shorts/')) {
          videoId = url.pathname.split('/shorts/')[1].split(/[/?&]/)[0];
        }
      }

      if (videoId === 'videoseries') videoId = null;
      return {
        videoId: videoId && videoId.length === 11 ? videoId : null,
        listId: listId || null
      };
    } catch (_) {
      return null;
    }
  }

  /* ========================================================================
   * 2. LOCATE & UPGRADE YOUTUBE STAGE IN EXISTING DOM
   * ======================================================================== */
  function findYouTubeStage() {
    // Check known Zelda containers or find any existing YouTube iframe
    const existingIframe = document.querySelector(
      'iframe[src*="youtube.com"], iframe[src*="youtube-nocookie.com"]'
    );
    if (existingIframe && existingIframe.parentElement) {
      const wrapper = existingIframe.parentElement;
      wrapper.classList.add('yt-stage-wrapper');
      if (wrapper.parentElement) {
        wrapper.parentElement.classList.add('audio-tab-panel');
      }
      return { wrapper, existingIframe };
    }

    const explicitWrapper = document.querySelector(
      '#yt-stage-wrapper, .yt-stage-wrapper, .yt-player-container, .youtube-embed-box, #youtube-player'
    );
    if (explicitWrapper) {
      explicitWrapper.classList.add('yt-stage-wrapper');
      if (explicitWrapper.parentElement) {
        explicitWrapper.parentElement.classList.add('audio-tab-panel');
      }
      return { wrapper: explicitWrapper, existingIframe: explicitWrapper.querySelector('iframe') };
    }

    return null;
  }

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

    // Place transport bar right below the expanded video stage
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

  /* ========================================================================
   * 3. YOUTUBE IFRAME API INITIALIZATION & AUTO-ADVANCE
   * ======================================================================== */
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

    // Seed initial video or playlist from existing iframe src if present
    let initialParsed = null;
    if (existingIframe && existingIframe.src) {
      initialParsed = parseYouTubeInput(existingIframe.src);
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

    // Replace static iframe with clean API mount div
    let mountDiv = document.getElementById('zelda-yt-api-mount');
    if (!mountDiv) {
      mountDiv = document.createElement('div');
      mountDiv.id = 'zelda-yt-api-mount';
      wrapper.innerHTML = '';
      wrapper.appendChild(mountDiv);
    }

    const playerVars = {
      autoplay: 0,
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
        onReady: function () {
          updateStatusLabel();
        },
        onStateChange: handlePlayerStateChange,
        onError: function (e) {
          console.warn('[ZeldaPatch] YT Player error code:', e.data, '-> skipping to next');
          if (state.autoNext) {
            setTimeout(playNextVideo, 1200);
          }
        }
      }
    });

    interceptUrlButtons();
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
      // When native YT playlist isn't active, auto-advance Zelda's queue
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

    // Native YouTube playlist mode
    if (state.playlistId && typeof state.player.nextVideo === 'function') {
      state.player.nextVideo();
      return;
    }

    // Custom Zelda queue mode
    if (state.queue.length === 0) return;
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    const nextItem = state.queue[state.queueIndex];
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
    state.player.loadVideoById(prevItem.id);
    updateStatusLabel();
  }

  /**
   * Public API: Load any YouTube video URL, playlist URL, or video ID into Zelda
   * Usage: window.ZeldaYouTube.load('https://www.youtube.com/watch?v=...&list=PL...')
   */
  function loadUrlOrPlaylist(rawUrl, queueMode = false) {
    const parsed = parseYouTubeInput(rawUrl);
    if (!parsed || (!parsed.videoId && !parsed.listId)) {
      updateStatusLabel('INVALID YT LINK');
      return false;
    }

    if (parsed.listId) {
      state.playlistId = parsed.listId;
      if (state.player && typeof state.player.loadPlaylist === 'function') {
        state.player.loadPlaylist({
          list: parsed.listId,
          listType: 'playlist',
          index: 0
        });
      }
      updateStatusLabel('PLAYLIST // LOADED');
      return true;
    }

    // Single video: either append to queue or play immediately
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
      state.queue.push({ id: parsed.videoId, title: 'CUSTOM STREAM' });
      state.queueIndex = state.queue.length - 1;
      saveQueue();
    }

    if (state.player && typeof state.player.loadVideoById === 'function') {
      state.player.loadVideoById(parsed.videoId);
    }
    updateStatusLabel();
    return true;
  }

  // Hook existing "+ YT URL" button if present so pasting playlist URLs works seamlessly
  function interceptUrlButtons() {
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"], .hud-btn'));
    const ytUrlBtn = allButtons.find((el) =>
      /YT\s*URL/i.test((el.textContent || '').trim())
    );
    if (ytUrlBtn && !ytUrlBtn.dataset.zeldaYtHooked) {
      ytUrlBtn.dataset.zeldaYtHooked = '1';
      ytUrlBtn.addEventListener(
        'click',
        function (e) {
          const input = window.prompt(
            'PASTE YOUTUBE VIDEO OR PLAYLIST URL (supports &list=PL...):'
          );
          if (input && input.trim()) {
            e.stopImmediatePropagation();
            e.preventDefault();
            loadUrlOrPlaylist(input.trim(), false);
          }
        },
        true
      );
    }
  }

  /* ========================================================================
   * 4. NATIVE VOICE BRIDGE ROUTER (LIVE CALL + HOLD PTT)
   * Routes directly to Kotlin's window.ZeldaNativeVoice on the car APK,
   * bypassing Android WebView's unsupported webkitSpeechRecognition.
   * ======================================================================== */
  function hasNativeVoiceBridge() {
    return (
      typeof window.ZeldaNativeVoice !== 'undefined' &&
      window.ZeldaNativeVoice !== null
    );
  }

  function dispatchTranscriptToZelda(transcript, isFinal) {
    if (!transcript) return;
    console.log('[ZeldaVoice] Transcript:', transcript, 'final:', isFinal);

    // 1. Populate chat/command text input if present in the HUD
    const textInput = document.querySelector(
      'input[placeholder*="Zelda" i], input[placeholder*="Say" i], input[placeholder*="Ask" i], #zelda-chat-input, #voice-input, textarea'
    );
    if (textInput) {
      textInput.value = transcript;
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 2. Fire custom DOM event so any Zelda daemon module can subscribe
    window.dispatchEvent(
      new CustomEvent('zelda:voice-transcript', {
        detail: { transcript, isFinal: Boolean(isFinal) }
      })
    );

    // 3. Auto-submit on final transcript if SEND button or global handler exists
    if (isFinal) {
      if (typeof window.handleZeldaVoiceCommand === 'function') {
        window.handleZeldaVoiceCommand(transcript);
        return;
      }
      const sendBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^SEND$/i.test((b.textContent || '').trim())
      );
      if (sendBtn && textInput) {
        sendBtn.click();
      }
    }
  }

  // Global callbacks invoked by Kotlin's ZeldaVoiceBridge.kt
  window.onZeldaVoiceResult = function (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const text = data?.transcript || data?.text || (typeof payload === 'string' ? payload : '');
      const isFinal = data?.isFinal !== undefined ? data.isFinal : true;
      dispatchTranscriptToZelda(text, isFinal);

      // In Continuous LIVE CALL mode, automatically re-arm listening after final phrase
      if (isFinal && state.liveCallActive) {
        setTimeout(() => {
          if (state.liveCallActive) startNativeOrWebMic(true);
        }, 350);
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
      }, 900);
    }
  };

  function startNativeOrWebMic(continuousMode) {
    if (hasNativeVoiceBridge()) {
      const nv = window.ZeldaNativeVoice;
      try {
        // Support all method signatures used across ZeldaVoiceBridge versions
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

    // Desktop / Fold Chrome fallback (only when NOT inside Android WebView without bridge)
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      console.warn('[ZeldaVoice] SpeechRecognition unavailable in this WebView; requires ZeldaNativeVoice.');
      return;
    }

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
    } catch (e) {
      console.warn('[ZeldaVoice] Web Speech fallback busy:', e);
    }
  }

  function stopNativeOrWebMic() {
    if (hasNativeVoiceBridge()) {
      const nv = window.ZeldaNativeVoice;
      try {
        if (typeof nv.stopListening === 'function') nv.stopListening();
        else if (typeof nv.stopRecognition === 'function') nv.stopRecognition();
        else if (typeof nv.stopPtt === 'function') nv.stopPtt();
      } catch (err) {
        console.error('[ZeldaVoice] Native stop error:', err);
      }
    }
    if (state.webRecognition) {
      try {
        state.webRecognition.stop();
      } catch (_) {}
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
          if (state.liveCallActive) {
            startNativeOrWebMic(true);
          } else {
            stopNativeOrWebMic();
          }
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
   * 5. BLUETOOTH AVRCP METADATA RECEIVER HOOK (READY FOR KOTLIN BRIDGE)
   * Automatically updates CAR BT / Audio Deck DOM elements when Kotlin sends:
   * window.onZeldaMediaMetadata({ title, artist, album, artworkBase64, playing })
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
   * 6. BOOTSTRAP & PUBLIC HANDLE
   * ======================================================================== */
  function initPatch() {
    bindVoiceButtons();
    loadYouTubeIframeApi();

    // Re-check buttons/stage if tabs render dynamically
    const observer = new MutationObserver(() => {
      bindVoiceButtons();
      if (!state.player && state.ytApiReady && findYouTubeStage()) {
        mountControlledPlayer();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.ZeldaYouTube = {
    version: ZELDA_PATCH_VERSION,
    load: loadUrlOrPlaylist,
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
