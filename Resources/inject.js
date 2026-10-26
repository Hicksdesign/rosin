// QobuzShell page script. Injected at document start into play.qobuz.com.
//
// Exposes window.QobuzShell with the commands Swift calls, and reports the
// current track back to Swift via webkit.messageHandlers.qobuzShell.
//
// Debug it in Safari ▸ Develop ▸ [your Mac] ▸ QobuzShell. In the console,
// `QobuzShell.state()` shows what the menubar will see,
// `QobuzShell.handlers()` lists the Media Session actions Qobuz registered, and
// `QobuzShell.selectors` lists the selectors in use.

(() => {
  if (window.QobuzShell) return;

  // ---------------------------------------------------------------------------
  // SELECTORS. Qobuz uses readable BEM class names (FullPlayer__close,
  // SearchBar__input) rather than generated hashes, so those are the primary
  // hooks. Its aria-labels are localised, so they're only a secondary match.
  //
  // Qobuz registers Media Session handlers for play, pause, nexttrack and
  // previoustrack, and sets mediaSession.metadata, so the player-bar entries
  // are only a fallback. They're still unverified placeholders.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    // Fallback track metadata (player bar) — unverified
    playerTitle: '[data-testid="player-track-title"]',
    playerArtist: '[data-testid="player-track-artist"]',
    playerAlbum: '[data-testid="player-track-album"]',
    playerArtwork: '[data-testid="player-cover"] img',

    // Fallback playback buttons — unverified
    playPauseButton: 'button[aria-label="Play"], button[aria-label="Pause"]',
    nextButton: 'button[aria-label="Next"]',
    previousButton: 'button[aria-label="Previous"]',

    // Immersive view ("FullPlayer" in Qobuz's markup)
    immersiveRoot: '[class*="FullPlayer"]',
    immersiveClose: 'button.FullPlayer__close, button[aria-label="Close fullscreen"]',

    // Search. The input is always in the nav bar, so searchTrigger and
    // SEARCH_ROUTE should rarely be needed; neither has been verified.
    searchInput: 'input.SearchBar__input',
    searchTrigger: 'button[aria-label*="search" i], a[href*="/search"]',
  };

  // Last-resort route for openSearch() if no search field or button is found.
  const SEARCH_ROUTE = '/search';

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  const post = (msg) => {
    try { window.webkit.messageHandlers.qobuzShell.postMessage(msg); } catch (_) {}
  };
  const log = (...parts) => post({ type: 'log', message: parts.map(String).join(' ') });

  const $ = (sel) => { try { return document.querySelector(sel); } catch (_) { return null; } };
  const text = (sel) => ($(sel)?.textContent || '').trim();
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const click = (sel) => {
    const el = $(sel);
    if (!isVisible(el)) return false;
    el.click();
    return true;
  };

  // ---------------------------------------------------------------------------
  // State reporting (throttled; only posts when something changed)
  // ---------------------------------------------------------------------------
  let lastReported = '';
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const state = readState();
      const key = JSON.stringify(state);
      if (key !== lastReported) {
        lastReported = key;
        post(state);
      }
    }, 150);
  };

  // ---------------------------------------------------------------------------
  // Media Session capture
  //
  // If Qobuz registers play/pause/next handlers with navigator.mediaSession
  // (as most web players do for hardware media keys), we keep a reference to
  // them. Calling those handlers is exactly what a media key does, so Qobuz's
  // own UI stays in sync. This doesn't depend on any DOM selectors.
  // ---------------------------------------------------------------------------
  const ms = navigator.mediaSession;
  const actionHandlers = {};
  if (ms && typeof ms.setActionHandler === 'function') {
    const original = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
      actionHandlers[action] = handler;
      schedule();
      return original(action, handler);
    };
  }

  const invoke = (action) => {
    const handler = actionHandlers[action];
    if (typeof handler !== 'function') return false;
    try { handler({ action }); return true; } catch (e) { log('mediaSession handler failed', action, e); return false; }
  };

  // ---------------------------------------------------------------------------
  // Media element capture
  //
  // The audio element may never be attached to the DOM, so querySelector('audio')
  // can't be relied on. Wrapping play() catches every element that plays.
  // ---------------------------------------------------------------------------
  const mediaElements = new Set();
  const trackElement = (el) => {
    if (mediaElements.has(el)) return;
    mediaElements.add(el);
    ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata'].forEach((ev) =>
      el.addEventListener(ev, schedule)
    );
  };
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    trackElement(this);
    return originalPlay.apply(this, args);
  };

  const activeElement = () => {
    let fallback = null;
    for (const el of mediaElements) {
      if (!el.paused) return el;
      if (el.currentSrc) fallback = el;
    }
    return fallback;
  };

  // ---------------------------------------------------------------------------
  // Reading state
  // ---------------------------------------------------------------------------
  const isPlaying = () => {
    const el = activeElement();
    if (el) return !el.paused;
    if (ms && ms.playbackState && ms.playbackState !== 'none') return ms.playbackState === 'playing';
    return false;
  };

  const readState = () => {
    const meta = ms && ms.metadata;
    const artworkList = meta && meta.artwork ? Array.from(meta.artwork) : [];
    const artwork = artworkList.length
      ? artworkList[artworkList.length - 1].src   // usually the largest
      : ($(SELECTORS.playerArtwork)?.currentSrc || '');
    const fromSession = !!(meta && meta.title);

    return {
      type: 'nowPlaying',
      title: fromSession ? meta.title : text(SELECTORS.playerTitle),
      artist: fromSession ? (meta.artist || '') : text(SELECTORS.playerArtist),
      album: fromSession ? (meta.album || '') : text(SELECTORS.playerAlbum),
      artwork,
      playing: isPlaying(),
      source: fromSession ? 'mediaSession' : 'dom',
    };
  };

  // Polling picks up metadata changes the events above don't cover.
  setInterval(schedule, 1000);

  // ---------------------------------------------------------------------------
  // Commands (called from Swift)
  // ---------------------------------------------------------------------------
  const togglePlay = () => {
    const playing = isPlaying();
    if (invoke(playing ? 'pause' : 'play')) return;
    if (click(SELECTORS.playPauseButton)) return;
    const el = activeElement();
    if (el) playing ? el.pause() : el.play();
    else log('togglePlay: nothing to control');
  };

  const next = () => {
    if (invoke('nexttrack') || click(SELECTORS.nextButton)) return;
    log('next: no handler or button found');
  };

  const previous = () => {
    if (invoke('previoustrack') || click(SELECTORS.previousButton)) return;
    log('previous: no handler or button found');
  };

  const sendEscape = () => {
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
      }));
    }
  };

  // Bound to Escape in the app menu, which means the menu takes every Escape
  // press. If the immersive view isn't open, pass Escape on to the page so
  // menus, dialogs and the search field still close as normal.
  const closeImmersive = () => {
    if (isVisible($(SELECTORS.immersiveRoot)) && click(SELECTORS.immersiveClose)) return;
    sendEscape();
  };

  const focusInput = (input) => {
    input.focus();
    input.select?.();
  };

  const focusSearch = () => {
    const input = $(SELECTORS.searchInput);
    if (!isVisible(input)) return false;
    focusInput(input);
    // On Discover, focusing the field opens a search-history panel that
    // re-renders the search bar and drops focus. Once it settles, refocus
    // whichever input is there now.
    setTimeout(() => {
      const current = $(SELECTORS.searchInput);
      if (isVisible(current) && document.activeElement !== current) focusInput(current);
    }, 100);
    return true;
  };

  const openSearch = () => {
    if (focusSearch()) return;
    if (click(SELECTORS.searchTrigger)) {
      setTimeout(focusSearch, 150);  // give the search UI a moment to appear
      return;
    }
    // Last resort: client-side route change.
    history.pushState({}, '', SEARCH_ROUTE);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    setTimeout(focusSearch, 300);
  };

  // ---------------------------------------------------------------------------
  // Custom CSS and fonts
  //
  // CSS goes into a constructed stylesheet (document.adoptedStyleSheets), which
  // isn't subject to the page's style-src CSP the way an injected <style> can be.
  // Fonts arrive as base64 bytes and are registered with FontFace, so there is
  // no network fetch for font-src to block.
  // ---------------------------------------------------------------------------
  let styleSheet = null;
  let styleElement = null;
  let fontFaces = [];

  const decodeBase64 = (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  const applyFonts = (fonts) => {
    fontFaces.forEach((face) => document.fonts.delete(face));
    fontFaces = [];
    for (const f of fonts || []) {
      try {
        const face = new FontFace(f.family, decodeBase64(f.data), { weight: f.weight, style: f.style });
        document.fonts.add(face);
        fontFaces.push(face);
        face.loaded.catch((e) => log('font failed to load:', f.family, e));
      } catch (e) {
        log('font error:', f.family, e);
      }
    }
  };

  const applyCSS = (css) => {
    if ('adoptedStyleSheets' in Document.prototype && 'replaceSync' in CSSStyleSheet.prototype) {
      if (!styleSheet) {
        styleSheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];
      }
      styleSheet.replaceSync(css || '');
      return;
    }
    // Fallback for older engines.
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'qobuz-shell-styles';
      (document.head || document.documentElement).appendChild(styleElement);
    }
    styleElement.textContent = css || '';
  };

  const applyStyles = (css, fonts) => {
    applyFonts(fonts);
    applyCSS(css);
  };

  // A class to scope your CSS to the app if you also use the same stylesheet elsewhere.
  const markRoot = () => document.documentElement && document.documentElement.classList.add('qobuz-shell');
  markRoot() || document.addEventListener('DOMContentLoaded', markRoot, { once: true });

  window.QobuzShell = {
    togglePlay, next, previous, closeImmersive, openSearch, applyStyles,
    state: readState,
    handlers: () => Object.keys(actionHandlers),
    selectors: SELECTORS,
  };
})();
