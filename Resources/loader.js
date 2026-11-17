// Rosin loader. Runs inside the Qobuz desktop app (Electron).
//
// The companion app patches Qobuz's app.html with one <script> that require()s
// this file from ~/Library/Application Support/Rosin/. The page has Node
// integration (nodeIntegration: true, contextIsolation: false), so this runs
// with full Node access: keep it to our own files.
//
// It:
//  - injects custom.css and the fonts in fonts.json, re-applying CSS on save,
//    and turns Qobuz's hard-coded accent colours into variables (see ACCENTS),
//    unless the companion's Use Custom Theme setting is off;
//  - reports the current track to the companion over a Unix socket and takes
//    commands back (newline-delimited JSON both ways);
//  - adds keyboard shortcuts (see SHORTCUTS);
//  - loads Home (homepage.js), a recommendations page, unless the
//    companion's Show Home setting is off.
//
// window.Rosin exposes state(), selectors and the commands for debugging.

/* eslint-env node, browser */
(() => {
  if (window.Rosin) return;

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const net = require('net');

  const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Rosin');

  // ---------------------------------------------------------------------------
  // SELECTORS. Taken from the desktop app's bundle.js (8.3.0). Qobuz uses
  // readable BEM classes; aria-labels are localised, so they're avoided.
  //
  // The play/pause control is a <span> whose class follows the player state:
  // player__action-pause while playing, player__action-play while paused,
  // player__action-loader while buffering. It reflects playback on every
  // output, Qobuz Connect included, because the audio engine is native.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    playerTitle: '.player__track-name',
    playerArtist: '.player__track-album a[href*="/artist/"]',
    playerAlbum: '.player__track-album a[href*="/album/"]',
    playerArtwork: '.player__track-cover img',

    playButton: '.player__action-play',
    pauseButton: '.player__action-pause',
    loadingButton: '.player__action-loader',
    nextButton: '.player__action-next',
    previousButton: '.player__action-previous',

    // Immersive view ("FullPlayer" in Qobuz's markup). The player-bar cover
    // opens it.
    immersiveRoot: '[class*="FullPlayer"]',
    immersiveOpen: '.player__track-cover',
    immersiveClose: '.FullPlayer__close',
    // A div with the cover as an inline background-image.
    immersiveCover: '.FullPlayer__cover .Cover__item',

    searchInput: 'input.SearchBar__input',

    // The nav bar's own arrows. Qobuz navigates with its own in-app history
    // (Redux handlePrevious/handleNext), not window.history, so history.back()
    // does nothing; clicking these is the only reliable route.
    backButton: '.NavBar button.icon-arrow-navigation-back:not(.ButtonRoundSecondary--isDisabled)',
    forwardButton: '.NavBar button.icon-arrow-navigation-forward:not(.ButtonRoundSecondary--isDisabled)',

    // The older stylesheet, which hard-codes the accent colours (see ACCENTS).
    legacyStylesheet: 'link[href*="legacy.css"]',

    // Home (homepage.js). Its tab goes first in the nav bar's list; its page
    // covers the main scroll area, placed in the layout root.
    navItems: '.NavBar__items',
    navItem: '.NavBar__items .ui-block-nav-item',
    navBrand: '.NavBar__brand',
    searchBar: '.SearchBar',
    layoutRoot: '.ui-layout--root',
    mainScroll: '.ui-layout--root--scroll-main',
    // The big Play in an album or playlist header ("play-arrow" turns to
    // "pause" while it plays), and a track row's play control in its number cell.
    headerPlayButton: '.PageHeader__actions .ButtonRoundPrimary--large.icon-play-arrow',
    trackRow: '.ListItem',
    trackRowTitle: '.ListItem__title',
    trackRowNumber: '.ListItem__numberText',
    trackRowPlay: '.ListItem__player.icon-play-arrow',
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (sel) => { try { return document.querySelector(sel); } catch (_) { return null; } };
  const text = (sel) => ($(sel)?.textContent || '').trim();
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const click = (sel) => {
    const el = $(sel);
    if (!isVisible(el) || el.classList.contains('disable')) return false;
    el.click();
    return true;
  };

  const clients = new Set();
  const send = (msg) => {
    const line = JSON.stringify(msg) + '\n';
    for (const socket of clients) socket.write(line);
  };
  const log = (...parts) => {
    const message = parts.map(String).join(' ');
    console.log('[Rosin]', message);
    send({ type: 'log', message });
  };

  // The companion writes config.json with the paths to use (the project's
  // Resources folder in Debug builds, the app bundle or overrides otherwise),
  // `theme`, its Use Custom Theme setting, and `accent`, its accent colour.
  const readConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(SUPPORT_DIR, 'config.json'), 'utf8'));
    } catch (e) {
      log('config.json unreadable:', e.message);
      return {};
    }
  };
  let config = readConfig();
  // Missing from configs written before the setting existed: on, as by default.
  const themeEnabled = () => config.theme !== false;

  // ---------------------------------------------------------------------------
  // Custom CSS and fonts
  //
  // The page's CSP is wide open, so a plain <style> works. Fonts are read as
  // bytes and registered with FontFace, which avoids file:// URL quirks.
  // ---------------------------------------------------------------------------
  let styleElement = null;
  let fontFaces = [];

  const applyCSS = () => {
    let css = '';
    if (themeEnabled() && config.css) {
      try { css = fs.readFileSync(config.css, 'utf8'); } catch (e) { log('custom.css unreadable:', e.message); }
    }
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'rosin-styles';
    }
    styleElement.textContent = css;
    // Last in <head> so it wins over main.css at equal specificity.
    (document.head || document.documentElement).appendChild(styleElement);
  };

  const applyFonts = () => {
    fontFaces.forEach((face) => document.fonts.delete(face));
    fontFaces = [];
    if (!themeEnabled() || !config.fonts) return;
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(path.join(config.fonts, 'fonts.json'), 'utf8')); } catch (e) { log('fonts.json unreadable:', e.message); }
    for (const f of entries) {
      try {
        const buf = fs.readFileSync(path.join(config.fonts, f.file));
        const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const face = new FontFace(f.family, bytes, { weight: f.weight || 'normal', style: f.style || 'normal' });
        document.fonts.add(face);
        fontFaces.push(face);
        face.loaded.catch((e) => log('font failed to load:', f.family, e));
      } catch (e) {
        log('font error:', f.family, e.message);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // ACCENTS. legacy.css hard-codes Qobuz's accent colours in ~300 places
  // instead of using variables, so each use is swapped for a variable in the loaded sheet
  // itself (through the CSSOM: no copy of the sheet, nothing to keep in sync
  // with Qobuz updates). custom.css can then recolour them all at once:
  //
  //   :root { --rosin-accent: #e05a00; --rosin-accent-hover: #ff7a1a; }
  //
  // The dark theme's accent, #ffcb74, is also --color-brand-60 in main.css,
  // which the newer components use; set both to recolour it everywhere.
  // #f5a623 is the player's accent while a hi-res track plays (.hires
  // progress bar, volume, queue count, shuffle/repeat), and awards.
  //
  // Each variable falls back to Qobuz's own colour, so an unset one changes
  // nothing. The CSSOM serialises colours as rgb(0, 112, 239), whatever the
  // source said, and shorthands as longhands, so that's what's matched.
  // Translucent uses (rgba(0,112,239,.3)) keep their alpha.
  // ---------------------------------------------------------------------------
  const ACCENTS = [
    { rgb: '0, 112, 239', hex: '#0070ef', variable: '--rosin-accent' },
    { rgb: '0, 172, 255', hex: '#00acff', variable: '--rosin-accent-hover' },
    { rgb: '255, 203, 116', hex: '#ffcb74', variable: '--rosin-accent-dark' },
    { rgb: '245, 166, 35', hex: '#f5a623', variable: '--rosin-accent-hires' },
  ];
  const accentPattern = new RegExp(`rgba?\\((${ACCENTS.map((a) => a.rgb).join('|')})(?:, ([\\d.]+))?\\)`, 'g');
  const accentValue = (rgb, alpha) => {
    const accent = ACCENTS.find((a) => a.rgb === rgb);
    const colour = `var(${accent.variable}, ${accent.hex})`;
    return alpha === undefined ? colour : `rgb(from ${colour} r g b / ${alpha})`;
  };

  // [style, property, original value, priority] per change, to undo them.
  let accentChanges = [];
  const eachStyle = (rules, visit) => {
    for (const rule of rules) {
      if (rule.style) visit(rule.style);
      if (rule.cssRules) eachStyle(rule.cssRules, visit);
    }
  };
  const applyAccents = () => {
    if (accentChanges.length) return;
    const sheet = $(SELECTORS.legacyStylesheet)?.sheet;
    if (!sheet) { log('applyAccents: legacy.css not loaded'); return; }
    eachStyle(sheet.cssRules, (style) => {
      for (let i = 0; i < style.length; i++) {
        const property = style[i];
        const value = style.getPropertyValue(property);
        const changed = value.replace(accentPattern, (_, rgb, alpha) => accentValue(rgb, alpha));
        if (changed === value) continue;
        const priority = style.getPropertyPriority(property);
        style.setProperty(property, changed, priority);
        accentChanges.push([style, property, value, priority]);
      }
    });
  };
  const removeAccents = () => {
    accentChanges.forEach(([style, property, value, priority]) => style.setProperty(property, value, priority));
    accentChanges = [];
  };

  // The accent picked in the companion's menu: config.accent, a hex colour, or
  // unset for custom.css's own. Set inline on <html>, which beats custom.css's
  // :root rule, so the pick wins and custom.css is the fallback. Hover is a
  // lighter mix of it; the dark theme uses it as is. Only with the theme on.
  const USER_ACCENT_VARIABLES = ['--rosin-accent', '--rosin-accent-hover', '--rosin-accent-dark', '--rosin-accent-hires', '--color-brand-60'];
  const applyUserAccent = () => {
    const root = document.documentElement.style;
    const accent = themeEnabled() && /^#[0-9a-f]{6}$/i.test(config.accent || '') ? config.accent : null;
    if (!accent) { USER_ACCENT_VARIABLES.forEach((v) => root.removeProperty(v)); return; }
    root.setProperty('--rosin-accent', accent);
    root.setProperty('--rosin-accent-hover', `color-mix(in srgb, ${accent}, white 15%)`);
    root.setProperty('--rosin-accent-dark', accent);
    root.setProperty('--rosin-accent-hires', accent);
    root.setProperty('--color-brand-60', accent);
  };
  // Sent as the colour changes, so just the variables, not a full reload.
  const setAccent = (accent) => {
    config.accent = accent || undefined;
    applyUserAccent();
  };

  const reloadStyles = () => {
    config = readConfig();
    applyFonts();
    applyCSS();
    if (themeEnabled()) applyAccents(); else removeAccents();
    applyUserAccent();
  };

  // Re-apply custom.css whenever it's saved. Editors usually save by writing a
  // new file and renaming it over the old one, which ends a watch on the file
  // itself, so the folder is watched instead.
  let cssWatcher = null;
  const watchCSS = () => {
    cssWatcher?.close();
    if (!config.css) return;
    let timer = null;
    try {
      cssWatcher = fs.watch(path.dirname(config.css), (_, filename) => {
        if (filename && filename !== path.basename(config.css)) return;
        clearTimeout(timer);
        timer = setTimeout(applyCSS, 100);
      });
    } catch (e) {
      log('watching custom.css failed:', e.message);
    }
  };

  // A class to scope CSS to Rosin.
  document.documentElement.classList.add('rosin');
  reloadStyles();
  watchCSS();

  // ---------------------------------------------------------------------------
  // Qobuz's Redux store and API, for Home, which needs your favourites and
  // its own navigation. Everything else here reads the DOM.
  //
  // The store is found by walking React's fiber tree from #root to the
  // Provider that holds it. Qobuz uses the legacy ReactDOM.render, so the
  // root fiber is _reactRootContainer._internalRoot.current. Only once React
  // has mounted; until then this returns null and is tried again.
  //
  // API calls use the app's own login token, from the store, with the desktop
  // app's ID: a token only works with the app ID it was issued for.
  // ---------------------------------------------------------------------------
  let store = null;
  const qobuzStore = () => {
    if (store) return store;
    const stack = [document.getElementById('root')?._reactRootContainer?._internalRoot?.current];
    const seen = new Set();
    while (stack.length && seen.size < 80000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const candidate = fiber.memoizedProps?.store;
      if (typeof candidate?.getState === 'function' && typeof candidate.subscribe === 'function') return (store = candidate);
      stack.push(fiber.child, fiber.sibling);
    }
    return null;
  };

  const QOBUZ_APP_ID = '304027809';
  const API_TIMEOUT = 15000;
  const qobuzAPI = async (method) => {
    const token = qobuzStore()?.getState().user?.token;
    if (!token) throw new Error('not signed in');
    const response = await fetch(`https://www.qobuz.com/api.json/0.2/${method}`, {
      headers: { 'X-App-Id': QOBUZ_APP_ID, 'X-User-Auth-Token': token },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!response.ok) throw new Error(`${method.split('?')[0]}: ${response.status}`);
    return response.json();
  };

  // Qobuz's router is connected-react-router, so this is the same push its
  // own links do.
  const navigate = (pathname) => {
    qobuzStore()?.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: [pathname] } });
  };

  // ---------------------------------------------------------------------------
  // Home (homepage.js): the companion's Show Home setting, `homePage` in
  // config.json. Copied next to this file by the companion, like loader.js.
  // ---------------------------------------------------------------------------
  let removeHomePage = null;
  const applyHomePage = () => {
    const on = config.homePage !== false;
    if (on === !!removeHomePage) return;
    if (!on) { removeHomePage(); removeHomePage = null; return; }
    try {
      removeHomePage = require(path.join(SUPPORT_DIR, 'homepage.js'))({
        selectors: SELECTORS, store: qobuzStore, api: qobuzAPI, navigate, log,
      });
    } catch (e) {
      log('homepage.js failed to load:', e.message);
    }
  };
  const reloadHomePage = () => {
    config = readConfig();
    applyHomePage();
  };
  applyHomePage();

  // ---------------------------------------------------------------------------
  // Reading state
  // ---------------------------------------------------------------------------
  const isPlaying = () => !!($(SELECTORS.pauseButton) || $(SELECTORS.loadingButton));

  const readState = () => ({
    type: 'nowPlaying',
    title: text(SELECTORS.playerTitle),
    artist: text(SELECTORS.playerArtist),
    album: text(SELECTORS.playerAlbum),
    artwork: $(SELECTORS.playerArtwork)?.currentSrc || '',
    playing: isPlaying(),
    source: 'dom',
  });

  // ---------------------------------------------------------------------------
  // Open Immersive View on Play. Fires when playback goes from stopped or
  // paused to playing. A track change doesn't count: the control stays on
  // pause (or the loader) across it, so closing the immersive view sticks
  // until playback stops.
  // ---------------------------------------------------------------------------
  let openImmersiveOnPlay = false;
  let wasPlaying = false;
  const noteState = (state) => {
    if (state.playing && !wasPlaying && openImmersiveOnPlay && !isVisible($(SELECTORS.immersiveRoot))) {
      click(SELECTORS.immersiveOpen) || log('openImmersiveOnPlay: open button not found');
    }
    wasPlaying = state.playing;
  };

  // ---------------------------------------------------------------------------
  // Full-size cover in the immersive view. Qobuz gives it release.image.large,
  // the 600px "_600.jpg", even though it's drawn far bigger. The CDN also has
  // "_max.jpg", the full-size master (3000px on the albums tried); there's no
  // size in between. Layering it over the 600px one keeps that showing while
  // the big one loads. React only rewrites the style when the track changes,
  // so the upgrade sticks until then and the next poll redoes it.
  // ---------------------------------------------------------------------------
  const upgradeImmersiveCover = () => {
    const el = $(SELECTORS.immersiveCover);
    const bg = el?.style.backgroundImage || '';
    const match = bg.match(/^url\("([^"]+_)600\.jpg"\)$/);
    if (match) el.style.backgroundImage = `url("${match[1]}max.jpg"), ${bg}`;
  };

  // Polling is cheap here (a handful of querySelector calls) and catches every
  // change, however Qobuz re-renders the player bar.
  let lastReported = '';
  const poll = () => {
    upgradeImmersiveCover();
    const state = readState();
    noteState(state);
    const key = JSON.stringify(state);
    if (key === lastReported) return;
    lastReported = key;
    send(state);
  };
  setInterval(poll, 500);

  // ---------------------------------------------------------------------------
  // Commands (from the companion, shortcuts, or the DevTools console)
  // ---------------------------------------------------------------------------
  const togglePlay = () => {
    if (click(SELECTORS.pauseButton) || click(SELECTORS.playButton)) return;
    log('togglePlay: no play/pause button found');
  };
  const next = () => { click(SELECTORS.nextButton) || log('next: button not found or disabled'); };
  const previous = () => { click(SELECTORS.previousButton) || log('previous: button not found or disabled'); };
  // Disabled at either end of the history, so a miss is normal: no log.
  const goBack = () => { click(SELECTORS.backButton); };
  const goForward = () => { click(SELECTORS.forwardButton); };

  // Returns false if the immersive view wasn't open, so Escape can carry on to
  // Qobuz's own handlers.
  const closeImmersive = () => isVisible($(SELECTORS.immersiveRoot)) && click(SELECTORS.immersiveClose);

  const focusInput = (input) => {
    input.focus();
    input.select?.();
  };
  const openSearch = () => {
    const input = $(SELECTORS.searchInput);
    if (!isVisible(input)) { log('openSearch: search field not found'); return; }
    focusInput(input);
    // On Discover, focusing the field opens a search-history panel that
    // re-renders the search bar and drops focus. Once it settles, refocus
    // whichever input is there now.
    setTimeout(() => {
      const current = $(SELECTORS.searchInput);
      if (isVisible(current) && document.activeElement !== current) focusInput(current);
    }, 100);
  };

  const commands = {
    togglePlay, next, previous, goBack, goForward, closeImmersive, openSearch, reloadStyles, reloadHomePage,
    reload: () => location.reload(),
    setOpenImmersiveOnPlay: (on) => { openImmersiveOnPlay = !!on; },
    setAccent,
  };

  // ---------------------------------------------------------------------------
  // SHORTCUTS. Qobuz's own menu only covers editing, ⌘W, ⌘Q and full screen
  // (⌃⌘F), so these don't collide. Shortcuts that would also edit text are
  // skipped while a text field has focus.
  // ---------------------------------------------------------------------------
  const isEditing = () => {
    const el = document.activeElement;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  };
  const SHORTCUTS = [
    { key: 'f', cmd: true, run: openSearch },
    { key: 'ArrowRight', cmd: true, editing: false, run: next },
    { key: 'ArrowLeft', cmd: true, editing: false, run: previous },
    { key: '[', cmd: true, editing: false, run: goBack },
    { key: ']', cmd: true, editing: false, run: goForward },
    { key: 'Escape', run: closeImmersive },
  ];
  window.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.shiftKey) return;
    const shortcut = SHORTCUTS.find((s) => s.key === event.key && !!s.cmd === event.metaKey);
    if (!shortcut || (shortcut.editing === false && isEditing())) return;
    // A run() that returns false didn't handle the key; let it through.
    if (shortcut.run() === false) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // ---------------------------------------------------------------------------
  // Socket for the companion app: one per Qobuz app (Qobuz, Qobuz Beta), named
  // after the .app so both can run at once.
  // ---------------------------------------------------------------------------
  const appName = (decodeURIComponent(location.pathname).match(/([^/]+)\.app\/Contents\//) || [])[1] || 'Qobuz';
  const socketDir = path.join(SUPPORT_DIR, 'sockets');
  const socketPath = path.join(socketDir, `${appName}.sock`);

  const handleLine = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    const command = commands[msg.command];
    if (typeof command !== 'function') { log('unknown command:', msg.command); return; }
    command(msg.argument);
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    // Greet with the current state, after a moment. A client that sends one
    // command and hangs up (a script, nc -U) has gone by then; writing to it
    // straight away fails with EPIPE, and Node discards the unread command.
    setTimeout(() => {
      if (!socket.destroyed) socket.write(JSON.stringify(readState()) + '\n');
    }, 100);
  });
  server.on('error', (e) => console.error('[Rosin] socket error:', e));
  try {
    fs.mkdirSync(socketDir, { recursive: true });
    // Left behind if Qobuz quit without closing it; listen() fails otherwise.
    fs.rmSync(socketPath, { force: true });
    server.listen(socketPath);
  } catch (e) {
    console.error('[Rosin] socket setup failed:', e);
  }
  window.addEventListener('beforeunload', () => {
    server.close();
    cssWatcher?.close();
  });

  window.Rosin = { ...commands, state: readState, selectors: SELECTORS, socketPath };
})();
