// FlameStream custom Cast receiver — bundled from TypeScript over the shared PlayerCore.
//
// WHY THIS EXISTS (see also the /api/castlog relay on the backend):
// This TV's CAF PlayerManager fails EVERY load (LOAD_FAILED 905, ~25ms, zero network) while
// raw <video> + MSE + hls.js on this same page plays flawlessly. So the Cast SDK does session
// management ONLY; playback is ours, driven by the SAME PlayerCore engine as the web app:
//
//   sender  --urn:x-cast:flamestream-->  this page  --PlayerCore/hls.js-->  <video>
//
// This file is the receiver-specific adapter: the custom message channel, the CAF media-command
// bridge, the D-pad scrub-to-confirm overlay, and the /api/castlog relay. The media engine
// (hls.js lifecycle, X-Hls-Start-Offset, ?shift= subtitles, buffered-check seek) lives in
// PlayerCore and is shared with the web player. Built to wwwroot/receiver.js by `build:receiver`.
//
// Message protocol (JSON over the custom namespace):
//   sender → receiver:
//     {type:'load', url, title?, duration?, startTime?, tracks?, activeTrackId?, thumbUrl?}
//     {type:'play'} {type:'pause'} {type:'seek', time}          (time = original-file seconds)
//     {type:'setVolume', level} {type:'setMuted', muted} {type:'setTrack', id}
//   receiver → sender (broadcast ~1s + on change):
//     {type:'status', t, dur, paused, trackId}

import { PlayerCore, SubtitleSpec } from '../app/player-core/player-core';

declare const cast: any;

type Track = { id: number; url: string; name?: string; lang?: string; source?: string };

(function () {
  const NS = 'urn:x-cast:flamestream';
  const context = cast.framework.CastReceiverContext.getInstance();

  const video      = document.getElementById('player') as HTMLVideoElement;
  const splash     = document.getElementById('splash')!;
  const titleBar   = document.getElementById('title-bar')!;
  const titleText  = document.getElementById('title-text')!;
  const stateBadge = document.getElementById('state-badge')!;
  const scrub        = document.getElementById('scrub')!;
  const scrubArea    = document.getElementById('scrub-area') as HTMLElement;
  const scrubThumb   = document.getElementById('scrub-thumb') as HTMLImageElement;
  const scrubFill    = document.getElementById('scrub-bar-fill') as HTMLElement;
  const scrubKnob    = document.getElementById('scrub-knob') as HTMLElement;
  const scrubPreview = document.getElementById('scrub-preview') as HTMLElement;
  const scrubCur     = document.getElementById('scrub-cur')!;
  const scrubTotal   = document.getElementById('scrub-total')!;
  const scrubThumbTime = document.getElementById('scrub-thumb-time')!;
  const subsPanel  = document.getElementById('subs')!;
  const subsList   = document.getElementById('subs-list')!;
  scrubThumb.addEventListener('load',  () => { scrubThumb.style.opacity = '1'; });
  scrubThumb.addEventListener('error', () => { scrubThumb.style.opacity = '0'; });

  // ── Debug overlay + backend log relay ───────────────────────────────────────
  const DEBUG = false;
  let logEl: HTMLElement | null = null;
  const logLines: string[] = [];
  function renderLog() {
    if (!DEBUG) return;
    if (!logEl && document.body) {
      logEl = document.createElement('div');
      logEl.style.cssText =
        'position:fixed;left:8px;bottom:8px;max-width:94vw;max-height:40vh;overflow:hidden;' +
        'font:13px/1.4 monospace;color:#8f8;background:rgba(0,0,0,.6);padding:6px 9px;' +
        'border-radius:4px;white-space:pre-wrap;word-break:break-all;z-index:99999;pointer-events:none;';
      document.body.appendChild(logEl);
    }
    if (logEl) logEl.textContent = logLines.join('\n');
  }
  function dlog(msg: string) {
    console.log('[FlameStream receiver] ' + msg);
    try { fetch('/api/castlog', { method: 'POST', body: msg }); } catch (e) {}
    if (!DEBUG) return;
    logLines.push(msg);
    while (logLines.length > 14) logLines.shift();
    renderLog();
  }
  window.addEventListener('error', (e) => {
    let extra = '';
    if (e.error && e.error.stack) extra = ' :: ' + String(e.error.stack).split('\n').slice(0, 3).join(' | ');
    dlog('JS ERROR: ' + (e.message || '?') + ' @' + (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?') + extra);
  });
  window.addEventListener('unhandledrejection', (e) => {
    let r = ''; try { r = JSON.stringify(e.reason); } catch (err) { r = String(e.reason); }
    dlog('UNHANDLED REJECTION: ' + r);
  });

  // ── Playback state ──────────────────────────────────────────────────────────
  let currentUrl: string | null = null;   // base stream URL (no ?start)
  let totalDuration = 0;                   // original-file duration, from the sender's metadata
  let tracks: Track[] = [];                // subtitle tracks offered by the sender
  let activeTrackId: number | null = null;
  let statusTimer: any = null;
  let playerManager: any = null;           // CAF PlayerManager, used only as the remote surface

  // The shared engine. TV config: tighter MSE buffer limits (their SourceBuffer quotas are far
  // smaller than desktop Chrome's — appends fail ~35MB with ~7MB segments), keep the target
  // 2s off the end, and no seek-retry UI (the D-pad overlay is the receiver's seek affordance).
  const core = new PlayerCore(video, {
    hls: { maxBufferLength: 20, maxMaxBufferLength: 30, maxBufferSize: 30 * 1000 * 1000, backBufferLength: 30 },
    clampTarget: (t) => Math.max(0, totalDuration > 0 ? Math.min(t, totalDuration - 2) : t),
    seekRetry: null,
    log: dlog,
  }, {
    onOffset: (o) => dlog('start offset → ' + o.toFixed(2) + 's'),
  });

  // ── D-pad scrub-to-confirm state (#130) ─────────────────────────────────────
  let seeking = false;
  let seekTarget = 0;                  // absolute (original-file) seconds being previewed
  let wasPlayingBeforeSeek = false;
  let thumbBaseUrl: string | null = null;
  let thumbDebounce: any = null;
  const SEEK_STEP = 10;
  const THUMB_INTERVAL = 10;

  function stripQuery(url: string) {
    const i = url.indexOf('?');
    return i === -1 ? url : url.substring(0, i);
  }

  function specFor(id: number | null): SubtitleSpec | undefined {
    const t = tracks.find((x) => x.id === id);
    if (!t) return undefined;
    return { url: t.url, label: t.name || 'Legendas', lang: t.lang || 'pt', mode: 'showing' };
  }

  function attachTrackById(id: number | null) {
    const s = specFor(id);
    if (s) core.attachSubtitle(s);
  }

  // Current absolute (original-file) playback position.
  function absTime() { return core.absTime(); }

  // Seek to an absolute (original-file) time (buffered-check + reload handled by PlayerCore).
  // resumePlaying: true → play after, false → pause after, omitted → leave play state.
  function doSeek(target: number, resumePlaying?: boolean) {
    core.seek(target, resumePlaying === undefined ? {} : { resumePlaying });
    sendStatus();
  }

  function togglePlay() {
    if (video.paused) { video.play().catch(() => {}); showBadge('▶'); }
    else { video.pause(); showBadge('⏸ Pausado'); }
  }

  function seekBy(delta: number) {
    doSeek(absTime() + delta);
    showBadge(delta >= 0 ? '⏩ +' + delta + 's' : '⏪ ' + delta + 's');
  }

  function changeVolume(delta: number) {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, video.volume + delta));
    showBadge('🔊 ' + Math.round(video.volume * 100) + '%');
  }

  function formatTime(s: number) {
    if (!s || isNaN(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const mm = (m < 10 && h > 0 ? '0' : '') + m, ss = (sec < 10 ? '0' : '') + sec;
    return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
  }

  // ── Scrub-to-confirm (#130) ─────────────────────────────────────────────────
  function enterSeek() {
    seeking = true;
    wasPlayingBeforeSeek = !video.paused;
    video.pause();
    seekTarget = absTime();
    stateBadge.classList.remove('visible');
    scrub.classList.remove('hidden');
  }

  function adjustSeek(delta: number) {
    if (!seeking) enterSeek();
    const max = totalDuration > 0 ? totalDuration : seekTarget + delta;
    seekTarget = Math.max(0, Math.min(seekTarget + delta, max));
    renderScrub();
  }

  function renderScrub() {
    const frac = totalDuration > 0 ? Math.min(1, seekTarget / totalDuration) : 0;
    scrubCur.textContent   = formatTime(seekTarget);
    scrubTotal.textContent = totalDuration > 0 ? formatTime(totalDuration) : '';
    scrubThumbTime.textContent = formatTime(seekTarget);
    scrubFill.style.width = (frac * 100) + '%';
    scrubKnob.style.left  = (frac * 100) + '%';
    // Float the preview over the bar at the target fraction, clamped (in px, like the web
    // player's scene-preview) so the thumbnail never runs off either screen edge.
    const areaW = scrubArea.clientWidth || 0;
    const halfW = 180;
    scrubPreview.style.left = (areaW
      ? Math.min(Math.max(frac * areaW, halfW), Math.max(halfW, areaW - halfW))
      : frac * 100) + 'px';
    if (!thumbBaseUrl) return;
    const bucket = Math.max(0, Math.floor(seekTarget / THUMB_INTERVAL) * THUMB_INTERVAL);
    const url = thumbBaseUrl + (thumbBaseUrl.indexOf('?') !== -1 ? '&' : '?') + 't=' + bucket;
    clearTimeout(thumbDebounce);
    thumbDebounce = setTimeout(() => { if (scrubThumb.src !== url) scrubThumb.src = url; }, 140);
  }

  function commitSeek() {
    if (!seeking) return;
    const target = seekTarget, resume = wasPlayingBeforeSeek;
    exitSeekUI();
    doSeek(target, resume);
    showBadge('⏩ ' + formatTime(target));
  }

  function cancelSeek() {
    if (!seeking) return;
    const resume = wasPlayingBeforeSeek;
    exitSeekUI();
    if (resume) video.play().catch(() => {}); else video.pause();
  }

  function exitSeekUI() {
    seeking = false;
    scrub.classList.add('hidden');
    clearTimeout(thumbDebounce);
    scrubThumb.removeAttribute('src');
    scrubThumb.style.opacity = '0';
  }

  let badgeTimer: any = null;
  function showBadge(text: string) {
    stateBadge.textContent = text;
    stateBadge.classList.add('visible');
    clearTimeout(badgeTimer);
    if (text.indexOf('Pausado') === -1) badgeTimer = setTimeout(() => stateBadge.classList.remove('visible'), 1200);
  }

  // ── On-screen subtitle menu (#130) ──────────────────────────────────────────
  // Driven by the D-pad (▲▼ navigate · OK select · Voltar close) and also reflects
  // phone-driven track changes. Entry 0 is always "Sem legendas" (off); the rest mirror
  // the tracks the sender offered. The active track shows an ember dot.
  type SubEntry = { id: number | null; label: string };
  let subsOpen = false;
  let subsIndex = 0;

  function subsEntries(): SubEntry[] {
    return [{ id: null, label: 'Sem legendas' }, ...tracks.map((t) => ({ id: t.id, label: t.name || 'Legendas' }))];
  }

  function esc(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }

  function renderSubs() {
    const entries = subsEntries();
    subsList.innerHTML = entries.map((e, i) => {
      const t = e.id != null ? tracks.find((x) => x.id === e.id) : undefined;
      const focus  = i === subsIndex ? ' focus' : '';
      const active = e.id === activeTrackId ? ' active' : '';
      if (!t) return `<div class="subs-item${focus}${active}"><span class="lang">${esc(e.label)}</span></div>`;
      const src  = t.source ? `<span class="src ${t.source === 'EMB' ? 'emb' : ''}">${esc(t.source)}</span>` : '';
      const lang = `<span class="lang">${esc((t.lang || 'cc').toUpperCase())}</span>`;
      const name = `<span class="name">${esc(t.name || '')}</span>`;
      return `<div class="subs-item${focus}${active}">${src}${lang}${name}</div>`;
    }).join('');
  }

  function openSubs() {
    if (seeking) return;                 // don't stack over the scrub overlay
    subsOpen = true;
    const entries = subsEntries();
    const cur = entries.findIndex((e) => e.id === activeTrackId);
    subsIndex = cur >= 0 ? cur : 0;
    renderSubs();
    subsPanel.classList.remove('hidden');
  }

  function closeSubs() {
    subsOpen = false;
    subsPanel.classList.add('hidden');
  }

  function moveSubs(delta: number) {
    const n = subsEntries().length;
    subsIndex = (subsIndex + delta + n) % n;
    renderSubs();
  }

  function applySubs() {
    const entry = subsEntries()[subsIndex];
    if (!entry) return;
    setActiveTrack(entry.id);
    closeSubs();
    showBadge('💬 ' + entry.label);
  }

  // Shared by the menu and the phone's setTrack: switch (or clear) the subtitle track.
  function setActiveTrack(id: number | null) {
    activeTrackId = id;
    if (id == null) core.setSubtitleMode('hidden');
    else attachTrackById(id);
    if (subsOpen) renderSubs();
    sendStatus();
  }

  // ── TV remote via DOM key events ────────────────────────────────────────────
  function handleRemoteKey(e: KeyboardEvent) {
    const k = e.key, c = e.keyCode;
    let action: string | null = null;

    // ── Subtitle menu is modal while open: it owns the D-pad ──
    if (subsOpen) {
      if (k === 'ArrowUp' || c === 38)                       { moveSubs(-1); action = 'subs↑'; }
      else if (k === 'ArrowDown' || c === 40)                { moveSubs(1);  action = 'subs↓'; }
      else if (k === ' ' || k === 'Enter' || k === 'MediaPlayPause' || c === 13 || c === 32 || c === 179 || c === 415 || c === 85) {
        applySubs(); action = 'subs-apply';
      } else if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack' || c === 27 || c === 461 || c === 10009) {
        closeSubs(); action = 'subs-close';
      }
      dlog('remote keydown (subs): key="' + e.key + '" keyCode=' + c + (action ? ' → ' + action : ' (unmapped)'));
      if (action) { try { e.preventDefault(); } catch (err) {} }
      return;
    }

    // Caption / subtitle key opens the menu. Codes vary wildly by TV, so match a broad set
    // (and the castlog above logs every unmapped key so we can add this TV's code later).
    if (k === 'Subtitle' || k === 'Captions' || k === 'ClosedCaptionToggle' || k === 'c' || k === 'C' ||
        c === 67 || c === 460 || c === 10252) {
      openSubs(); action = 'open-subs';
      dlog('remote keydown: key="' + e.key + '" keyCode=' + c + ' → ' + action);
      try { e.preventDefault(); } catch (err) {}
      return;
    }

    if (k === 'ArrowRight' || k === 'MediaFastForward' || k === 'MediaTrackNext' || c === 39 || c === 417 || c === 228) {
      adjustSeek(SEEK_STEP);  action = 'scrub→' + formatTime(seekTarget);
    } else if (k === 'ArrowLeft' || k === 'MediaRewind' || k === 'MediaTrackPrevious' || c === 37 || c === 412 || c === 227) {
      adjustSeek(-SEEK_STEP); action = 'scrub→' + formatTime(seekTarget);
    } else if (k === ' ' || k === 'Enter' || k === 'MediaPlayPause' || c === 13 || c === 32 || c === 179 || c === 85) {
      if (seeking) { commitSeek(); action = 'commit-seek'; }
      else { togglePlay(); action = video.paused ? 'pause' : 'play'; }
    } else if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack' || c === 27 || c === 461 || c === 10009) {
      if (seeking) { cancelSeek(); action = 'cancel-seek'; }
    } else if (k === 'MediaPlay' || c === 415) {
      if (seeking) { commitSeek(); action = 'commit-seek'; }
      else { video.play().catch(() => {}); showBadge('▶'); action = 'play'; }
    } else if (k === 'MediaPause' || c === 19) {
      video.pause(); showBadge('⏸ Pausado'); action = 'pause';
    } else if (k === 'MediaStop' || c === 413) {
      if (seeking) { cancelSeek(); action = 'cancel-seek'; }
      else { video.pause(); showBadge('⏸ Pausado'); action = 'stop'; }
    } else if (k === 'ArrowUp' || c === 38) {
      changeVolume(0.1);  action = 'vol+';
    } else if (k === 'ArrowDown' || c === 40) {
      changeVolume(-0.1); action = 'vol-';
    }
    dlog('remote keydown: key="' + e.key + '" code="' + e.code + '" keyCode=' + c +
         (action ? ' → ' + action : ' (unmapped)'));
    if (action) { try { e.preventDefault(); } catch (err) {} }
  }
  window.addEventListener('keydown', handleRemoteKey, true);
  window.addEventListener('keyup', (e) =>
    dlog('remote keyup: key="' + e.key + '" code="' + e.code + '" keyCode=' + e.keyCode + ' which=' + (e as any).which), true);

  // ── TV remote via CAF media session ─────────────────────────────────────────
  function setupRemoteBridge() {
    try {
      playerManager = context.getPlayerManager();
      const messages = cast.framework.messages;
      const MT  = messages.MessageType;
      const CMD = messages.Command;
      const PS  = messages.PlayerState;

      playerManager.setSupportedMediaCommands(
        CMD.PAUSE | CMD.SEEK | CMD.STREAM_VOLUME | CMD.STREAM_MUTE, true
      );

      const handlers: Record<string, (req: any) => void> = {
        [MT.PLAY]:  () => { video.play().catch(() => {}); showBadge('▶'); },
        [MT.PAUSE]: () => { video.pause(); showBadge('⏸ Pausado'); },
        [MT.STOP]:  () => { video.pause(); showBadge('⏸ Pausado'); },
        [MT.SEEK]:  (req) => {
          if (typeof req.currentTime === 'number') { doSeek(req.currentTime); showBadge('⏩'); }
          else if (typeof req.relativeTime === 'number') { seekBy(req.relativeTime); }
        },
        [MT.SET_VOLUME]: (req) => {
          const v = req.volume || {};
          if (typeof v.level === 'number') { video.muted = false; video.volume = Math.max(0, Math.min(1, v.level)); }
          if (typeof v.muted === 'boolean') video.muted = v.muted;
          showBadge(video.muted ? '🔇 Mudo' : '🔊 ' + Math.round(video.volume * 100) + '%');
        },
      };

      const NOISY: Record<string, number> = {};
      NOISY[MT.MEDIA_STATUS] = 1;
      NOISY[MT.GET_STATUS]   = 1;

      let logged = 0;
      const unsupported: string[] = [];
      Object.keys(MT).forEach((k) => {
        const type = MT[k];
        if (type === MT.MEDIA_STATUS) return;
        try {
          playerManager.setMessageInterceptor(type, (req: any) => {
            if (!NOISY[type]) dlog('CAF msg: ' + type + summarizeReq(req));
            const h = handlers[type];
            if (h) {
              try { h(req || {}); } catch (e) { dlog('CAF handler err: ' + e); }
              pushCafStatus();
              return null;
            }
            return req;
          });
          logged++;
        } catch (e) { unsupported.push(k); }
      });
      if (unsupported.length) dlog('interceptors skipped (unsupported by runtime): ' + unsupported.join(', '));

      playerManager.setMessageInterceptor(MT.MEDIA_STATUS, (status: any) => {
        try {
          if (status) {
            status.currentTime = absTime();
            status.playerState = video.paused ? PS.PAUSED : PS.PLAYING;
          }
        } catch (e) {}
        return status;
      });

      dlog('CAF remote bridge ready (logging ' + logged + ' message types)');
    } catch (e) {
      playerManager = null;
      dlog('CAF remote bridge unavailable: ' + e);
    }
  }

  function summarizeReq(req: any) {
    if (!req) return '';
    const bits: string[] = [];
    try {
      if (typeof req.currentTime  === 'number') bits.push('t=' + req.currentTime);
      if (typeof req.relativeTime === 'number') bits.push('rel=' + req.relativeTime);
      if (typeof req.playbackRate === 'number') bits.push('rate=' + req.playbackRate);
      if (req.volume) bits.push('vol=' + JSON.stringify(req.volume));
      if (typeof req.userAction !== 'undefined')     bits.push('action=' + req.userAction);
      if (typeof req.customData !== 'undefined')      bits.push('custom=' + JSON.stringify(req.customData));
    } catch (e) {}
    return bits.length ? ' {' + bits.join(', ') + '}' : '';
  }

  function publishCafSession(title: string, dur: number) {
    if (!playerManager) return;
    try {
      const info = new cast.framework.messages.MediaInformation();
      info.contentId    = currentUrl || 'flamestream';
      info.contentType  = 'application/x-mpegurl';
      info.streamType   = cast.framework.messages.StreamType.BUFFERED;
      info.duration     = dur || 0;
      const meta = new cast.framework.messages.GenericMediaMetadata();
      meta.title = title || 'CozyFlame Stream';
      info.metadata = meta;
      playerManager.setMediaInformation(info, false);
      dlog('CAF media session published');
    } catch (e) { dlog('publishCafSession failed: ' + e); }
  }

  function pushCafStatus() {
    if (!playerManager) return;
    try { playerManager.broadcastStatus(true); } catch (e) {}
  }

  // ── Message handling ────────────────────────────────────────────────────────
  function sendStatus() {
    try {
      context.sendCustomMessage(NS, undefined, {
        type: 'status',
        t: absTime(),
        dur: totalDuration,
        paused: video.paused,
        trackId: activeTrackId,
      });
    } catch (e) {}
    pushCafStatus();
  }

  function handleMessage(m: any) {
    switch (m.type) {
      case 'load':
        exitSeekUI();
        currentUrl = stripQuery(m.url);
        totalDuration = m.duration || 0;
        tracks = m.tracks || [];
        activeTrackId = m.activeTrackId != null ? m.activeTrackId : null;
        thumbBaseUrl = m.thumbUrl || null;
        closeSubs();
        titleText.textContent = m.title || '';
        splash.classList.add('hidden');
        titleBar.classList.add('visible');
        setTimeout(() => titleBar.classList.remove('visible'), 5000);
        core.load(currentUrl, m.startTime || 0, { play: true, subtitle: specFor(activeTrackId) });
        publishCafSession(m.title, totalDuration);
        clearInterval(statusTimer);
        statusTimer = setInterval(sendStatus, 1000);
        break;

      case 'play':
        video.play().catch(() => {});
        break;

      case 'pause':
        video.pause();
        break;

      case 'seek':
        doSeek(m.time);
        break;

      case 'setVolume':
        video.muted = false;
        video.volume = Math.max(0, Math.min(1, m.level));
        showBadge('🔊 ' + Math.round(video.volume * 100) + '%');
        break;

      case 'setMuted':
        video.muted = !!m.muted;
        showBadge(video.muted ? '🔇 Mudo' : '🔊 ' + Math.round(video.volume * 100) + '%');
        break;

      case 'setTrack':
        setActiveTrack(m.id != null ? m.id : null);
        break;

      default:
        dlog('unknown message type: ' + m.type);
    }
  }

  context.addCustomMessageListener(NS, (event: any) => {
    try { handleMessage(event.data || {}); }
    catch (e) { dlog('message handling failed: ' + e); }
  });

  // ── Video element UX ────────────────────────────────────────────────────────
  video.addEventListener('pause',   () => { if (!seeking) { stateBadge.textContent = '⏸ Pausado'; stateBadge.classList.add('visible'); } sendStatus(); });
  video.addEventListener('playing', () => { stateBadge.classList.remove('visible'); sendStatus(); });
  video.addEventListener('waiting', () => { stateBadge.textContent = 'Carregando…'; stateBadge.classList.add('visible'); });
  video.addEventListener('canplay', () => { if (!video.paused) stateBadge.classList.remove('visible'); });
  video.addEventListener('ended',   () => { splash.classList.remove('hidden'); sendStatus(); });

  // ── Start ───────────────────────────────────────────────────────────────────
  // Bump this on every receiver change — it's how the castlog proves which build the TV
  // actually loaded (Chromecast caches the receiver aggressively).
  const RECEIVER_VERSION = '2026-07-09c (CozyFlame skin — bottom-bar seek preview like web, subtitle menu, volume badges)';
  setupRemoteBridge();
  context.addEventListener(cast.framework.system.EventType.READY, () => {
    dlog('=== receiver build ' + RECEIVER_VERSION + ' ready ===');
  });
  context.start({ disableIdleTimeout: true });
})();
