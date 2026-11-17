// Home. A page of recommendations built from your own Qobuz favourites and
// listening, opened from a Home tab at the top of the nav bar. It was called
// For You until November 2026; its stored history is carried over from then.
// In the DOM and CSS it's rosin-home, so it isn't mistaken for Qobuz's own
// markup or the home folder. loader.js loads it (unless the companion's Show Home setting is off) and passes in
// its SELECTORS and Qobuz's store and API; this file queries Qobuz's DOM only
// through those selectors.
//
// The page is an overlay on the main scroll area rather than a real route, so
// Qobuz's router never sees it: it opens over Library, for its sidebar, and
// closes on any other navigation, or a click on another nav tab or the
// search bar. Sections, top to bottom: a top pick (a
// favourite album or a new release from a favourite artist, reshuffled on
// each visit), In your rotation (recently played tracks, and artists and
// playlists you opened), New from artists you love, Because you like {Artist},
// Artists you might like, and Fresh for you (Qobuz's new releases).
//
// All the data comes from Qobuz's own API with the in-app login:
//   favorite/getUserFavorites   artist/getSimilarArtists   artist/get
//   album/getFeatured           track/get                  playlist/get
// Nothing else is contacted. Play buttons open the album or playlist and click
// its own Play, since the page has no play API.
//
// Adapted from the "Picks for you" extension in Qobuzify,
// https://github.com/matthewprince/qobuzify (extensions/recommended). Left
// out: the Last.fm row (it goes through Qobuzify's server), the generated
// mixes (they create and delete playlists in your library), and opening on
// launch and from the Qobuz logo.
//
// MIT License
//
// Copyright (c) 2026 matthewprince
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/* eslint-env browser */

// Installs the Home page and returns a function that removes it again. All state is
// inside, so it can be installed again after a cleanup.
module.exports = ({ selectors: S, store, api: qobuzAPI, navigate, log }) => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const STYLE_ID = 'rosin-home-styles';
  const PAGE_ID = 'rosin-home';
  const TAB_ATTRIBUTE = 'data-rosin-home';

  // A heart, so it doesn't look like Qobuz's own sparkle icons.
  const TAB_ICON = '<svg class="ui-base-icon shrink-0" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.3S3.6 14.9 3.6 8.9C3.6 6.3 5.7 4.3 8.2 4.3C9.9 4.3 11.3 5.2 12 6.6C12.7 5.2 14.1 4.3 15.8 4.3C18.3 4.3 20.4 6.3 20.4 8.9C20.4 14.9 12 20.3 12 20.3Z"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const SHUFFLE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';

  let page = null;
  let active = false;
  let built = false;
  let heroPool = [];
  let heroLastId = null;

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  // Reads are cached for the session, so reopening the page is instant. A
  // failure is dropped from the cache so the next visit tries again.
  const cache = new Map();
  const api = (method) => {
    if (!cache.has(method)) cache.set(method, qobuzAPI(method).catch((e) => { cache.delete(method); throw e; }));
    return cache.get(method);
  };

  // fn over items with at most `limit` running at once. Resolves with the
  // results in order, null for any that failed.
  const pool = (items, limit, fn) => new Promise((resolve) => {
    const out = new Array(items.length);
    let next = 0, done = 0;
    if (!items.length) { resolve(out); return; }
    const start = () => {
      const i = next++;
      Promise.resolve().then(() => fn(items[i])).then((r) => { out[i] = r; }, () => { out[i] = null; }).then(() => {
        if (++done === items.length) resolve(out);
        else if (next < items.length) start();
      });
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) start();
  });

  const favouriteArtists = () => api('favorite/getUserFavorites?type=artists&limit=50').then((j) => j.artists?.items || []);
  const favouriteAlbums = () => api('favorite/getUserFavorites?type=albums&limit=60').then((j) => j.albums?.items || []).catch(() => []);
  const similarArtists = (id) => api(`artist/getSimilarArtists?artist_id=${id}&limit=12`).then((j) => j.artists?.items || []);
  const artistAlbums = (id) => api(`artist/get?artist_id=${id}&extra=albums&limit=6`).then((j) => j.albums?.items || []);
  const newReleases = () => api('album/getFeatured?type=new-releases-full&limit=30').then((j) => j.albums?.items || []);
  const artist = (id) => api(`artist/get?artist_id=${id}&limit=0`).then((j) => ({ id, name: j.name, image: j.image, picture: j.picture })).catch(() => null);
  const playlist = (id) => api(`playlist/get?playlist_id=${id}&limit=0`).then((j) => ({ id, name: j.name, images300: j.images300, image: j.image })).catch(() => null);

  const coverURL = (o) => {
    if (!o) return '';
    const image = o.image || o.cover || o.picture;
    if (!image) return o.album ? coverURL(o.album) : '';
    if (typeof image === 'string') return image;
    return image.large || image.medium || image.small || image.thumbnail || image.extralarge || image.mega || '';
  };
  const albumArtist = (album) => album.artist?.name || album.performer?.name || '';
  const streamable = (album) => album && album.streamable !== false;
  const released = (album) => album?.released_at || (album?.release_date_original && Date.parse(album.release_date_original) / 1000) || 0;
  const newestFirst = (a, b) => released(b) - released(a);
  const year = (album) => (released(album) ? ` · ${new Date(released(album) * 1000).getFullYear()}` : '');
  const dedupe = (list, keyOf) => {
    const seen = new Set();
    return list.filter((x) => {
      if (!x) return false;
      const key = keyOf(x);
      if (key == null || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const isHiRes = (o) => {
    const source = o && (o.maximum_bit_depth || o.hires != null) ? o : o?.album || o || {};
    return !!(source.hires || (source.maximum_bit_depth || 0) >= 24);
  };
  const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------------------------------------------------------------------------
  // Recent activity, for In your rotation: tracks played, and artists and
  // playlists opened. Kept in localStorage, newest first.
  // ---------------------------------------------------------------------------
  const STORAGE_PREFIX = 'rosin.home.';
  const storageGet = (key, fallback) => {
    try { return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback; } catch (_) { return fallback; }
  };
  const storageSet = (key, value) => {
    try { localStorage.setItem(STORAGE_PREFIX + key, value); } catch (_) {}
  };
  const readLog = (kind) => {
    try { return JSON.parse(storageGet(`recent.${kind}`, '[]')) || []; } catch (_) { return []; }
  };
  const writeLog = (kind, entries) => storageSet(`recent.${kind}`, JSON.stringify(entries));

  // History saved while the page was called For You moves to the new keys.
  const LEGACY_STORAGE_PREFIX = 'rosin.forYou.';
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LEGACY_STORAGE_PREFIX)) continue;
      const renamed = STORAGE_PREFIX + key.slice(LEGACY_STORAGE_PREFIX.length);
      if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch (_) {}

  const bump = (kind, id) => {
    writeLog(kind, [{ id, t: Date.now() }, ...readLog(kind).filter((x) => x.id !== id)].slice(0, 20));
  };

  // track/get rather than the player bar: its performer is the track's main
  // artist, where the bar's first artist link can be a featured one.
  const trackEntry = (track, t) => ({
    id: track.id,
    title: track.title,
    artist: track.performer?.name || '',
    artistId: track.performer?.id != null ? String(track.performer.id) : null,
    albumId: track.album?.id,
    cover: coverURL(track.album),
    trackNumber: track.track_number,
    t,
  });
  const logTrack = (id) => {
    api(`track/get?track_id=${id}`).then((track) => {
      writeLog('tracks', [trackEntry(track, Date.now()), ...readLog('tracks').filter((x) => x.id !== track.id)].slice(0, 40));
      if (active) refreshRotation();
    }, () => {});
  };
  const logRoute = (pathname) => {
    let m;
    if ((m = pathname.match(/\/artist\/(\d+)/))) bump('artists', m[1]);
    else if ((m = pathname.match(/\/playlist\/([^/?#]+)/))) bump('playlists', m[1]);
  };
  // A first run has no log yet, so start it from Qobuz's own play history.
  const seedRecentTracks = () => {
    if (readLog('tracks').length >= 5) return;
    const history = store()?.getState().playqueue?.history || [];
    const ids = [...new Set([...history].reverse())].filter(Boolean).slice(0, 10);
    pool(ids, 4, (id) => api(`track/get?track_id=${id}`)).then((tracks) => {
      const log = readLog('tracks');
      const known = new Set(log.map((x) => x.id));
      tracks.filter((t) => t && !known.has(t.id)).forEach((t) => log.push(trackEntry(t, 0)));
      writeLog('tracks', log.slice(0, 40));
      if (active) refreshRotation();
    });
  };

  // ---------------------------------------------------------------------------
  // Playing. Opens the album or playlist, then clicks its header's Play once
  // it's showing. Only the destination's header button counts: the previous
  // page can still be in the DOM mid-transition.
  // ---------------------------------------------------------------------------
  const pathname = () => store()?.getState().router?.location?.pathname || '';
  const visibleHeaderPlay = () => $$(S.headerPlayButton).find((b) => b.getClientRects().length > 0);

  let playTimer = null;
  const whenOn = (path, attempt) => {
    clearInterval(playTimer);
    let tries = 0;
    playTimer = setInterval(() => {
      tries++;
      if ((pathname().includes(path) && attempt(tries)) || tries > 40) clearInterval(playTimer);
    }, 150);
  };
  const go = (path) => { close(); navigate(path); };
  const play = (path) => {
    go(path);
    whenOn(path, () => {
      const button = visibleHeaderPlay();
      button?.click();
      return !!button;
    });
  };

  // One track, not the album's first: open the album and click the matching
  // row's play control. Matched on title, ties broken by track number; after
  // ~2s with no match, plays the album instead.
  const normalise = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[‘’'`]/g, '').replace(/\s+/g, ' ').trim();
  const matchingRow = (title, number) => {
    const want = normalise(title);
    let best = null, bestScore = -1;
    for (const row of $$(S.trackRow)) {
      if (!row.querySelector(S.trackRowPlay)) continue;
      const have = normalise(row.querySelector(S.trackRowTitle)?.textContent);
      let score = 0;
      if (have && have === want) score = 100;
      else if (have && want && (have.startsWith(want) || want.startsWith(have))) score = 70;
      else if (have && want && (have.includes(want) || want.includes(have))) score = 40;
      if (number && parseInt(row.querySelector(S.trackRowNumber)?.textContent, 10) === number) score += 15;
      if (score > bestScore) { bestScore = score; best = row; }
    }
    return bestScore >= 40 ? best : null;
  };
  const playTrack = (albumId, title, number) => {
    const path = `/album/${albumId}`;
    go(path);
    whenOn(path, (tries) => {
      const control = matchingRow(title, number)?.querySelector(S.trackRowPlay);
      if (control) { control.click(); return true; }
      if (tries > 12) {
        const button = visibleHeaderPlay();
        button?.click();
        return !!button;
      }
      return false;
    });
  };

  // ---------------------------------------------------------------------------
  // Cards and rows
  // ---------------------------------------------------------------------------
  const element = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  };
  const playButton = `<button class="rosin-home-play" title="Play" aria-label="Play">${PLAY_ICON}</button>`;
  const badge = (o) => (isHiRes(o) ? '<span class="rosin-home-badge">Hi-Res</span>' : '');

  // A card opens `path` when clicked; its play button, if any, runs onPlay.
  const card = ({ path, image, title, subtitle, round = false, extra = '', onPlay }) => {
    const c = element(
      `<a class="rosin-home-card${round ? ' rosin-home-card--round' : ''}" href="${escape(path)}">` +
        `<div class="rosin-home-art"><img loading="lazy" src="${escape(image)}" alt="">${extra}${onPlay ? playButton : ''}</div>` +
        `<div class="rosin-home-title">${escape(title)}</div><div class="rosin-home-subtitle">${escape(subtitle)}</div>` +
      '</a>'
    );
    c.addEventListener('click', (e) => { e.preventDefault(); go(path); });
    c.querySelector('.rosin-home-play')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPlay(); });
    return c;
  };
  const albumCard = (album) => card({
    path: `/album/${album.id}`, image: coverURL(album), title: album.title,
    subtitle: albumArtist(album) + year(album), extra: badge(album), onPlay: () => play(`/album/${album.id}`),
  });
  const artistCard = (a) => card({ path: `/artist/${a.id}`, image: coverURL(a), title: a.name, subtitle: 'Artist', round: true });
  const trackCard = (t) => card({
    path: `/album/${t.albumId}`, image: t.cover, title: t.title, subtitle: t.artist,
    onPlay: () => playTrack(t.albumId, t.title, t.trackNumber),
  });
  const playlistCard = (p) => card({
    path: `/playlist/${p.id}`, image: p.images300?.[0] || coverURL(p), title: p.name, subtitle: 'Playlist',
    onPlay: () => play(`/playlist/${p.id}`),
  });

  // A titled row with placeholders until fill() gives it cards. A row left
  // with no cards removes itself.
  const row = (title, subtitle) => {
    const section = element(
      '<section class="rosin-home-row">' +
        `<div class="rosin-home-rowhead"><h2>${escape(title)}</h2>${subtitle ? `<span>${escape(subtitle)}</span>` : ''}</div>` +
        `<div class="rosin-home-shelf">${'<div class="rosin-home-placeholder"></div>'.repeat(6)}</div>` +
      '</section>'
    );
    section.fill = (cards) => {
      if (!cards?.length) { section.remove(); return; }
      section.querySelector('.rosin-home-shelf').replaceChildren(...cards);
    };
    return section;
  };

  // ---------------------------------------------------------------------------
  // Top pick: a random favourite album or new release from a favourite
  // artist, never the one shown last, so it changes on every visit.
  // ---------------------------------------------------------------------------
  const topPick = (album, kind) => {
    const path = `/album/${album.id}`;
    const section = element(
      '<section class="rosin-home-pick">' +
        `<a class="rosin-home-pick-art" href="${path}"><img loading="lazy" src="${escape(coverURL(album))}" alt="">${badge(album)}</a>` +
        '<div class="rosin-home-pick-info">' +
          `<div class="rosin-home-pick-kind">${escape(kind)}</div>` +
          `<a class="rosin-home-pick-title" href="${path}">${escape(album.title)}</a>` +
          `<div class="rosin-home-pick-subtitle">${escape(albumArtist(album) + year(album))}</div>` +
          `<button class="rosin-home-pick-play">${PLAY_ICON}Play</button>` +
          `<button class="rosin-home-pick-shuffle" title="Show another">${SHUFFLE_ICON}Shuffle pick</button>` +
        '</div>' +
      '</section>'
    );
    section.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(path); }));
    section.querySelector('.rosin-home-pick-play').addEventListener('click', () => play(path));
    section.querySelector('.rosin-home-pick-shuffle').addEventListener('click', () => shufflePick());
    return section;
  };
  const shufflePick = () => {
    const host = page?.querySelector('.rosin-home-pick-host');
    if (!host || !heroPool.length) return;
    const last = heroLastId ?? storageGet('pick.last', null);
    let choices = heroPool.filter((x) => String(x.album.id) !== String(last));
    if (!choices.length) choices = heroPool;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    heroLastId = pick.album.id;
    storageSet('pick.last', String(pick.album.id));
    host.replaceChildren(topPick(pick.album, pick.kind));
  };

  // ---------------------------------------------------------------------------
  // The recommendation rows. Each fills in as its data arrives.
  // ---------------------------------------------------------------------------
  const buildRows = () => {
    const host = page.querySelector('.rosin-home-rows-host');
    const newFromFavourites = row('New from artists you love', 'Latest releases from your favourites');
    const becauseHost = document.createElement('div');
    const mightLike = row('Artists you might like', 'Similar to the artists you love');
    const fresh = row('Fresh for you', 'New on Qobuz');
    host.append(newFromFavourites, becauseHost, mightLike, fresh);

    favouriteArtists().then((favourites) => {
      const seeds = favourites.slice(0, 4);

      // Each favourite's newest album, which also fills the top pick with
      // your favourite albums.
      pool(favourites.slice(0, 16), 5, (a) => artistAlbums(a.id)).then((lists) => {
        const albums = dedupe(
          lists.filter((l) => l?.length).map((l) => [...l].sort(newestFirst)[0]).filter(streamable),
          (a) => a.id
        ).sort(newestFirst).slice(0, 18);
        newFromFavourites.fill(albums.map(albumCard));
        const newPicks = albums.slice(0, 12).map((album) => ({ album, kind: 'New for you' }));
        favouriteAlbums().then((favs) => {
          const favPicks = favs.filter((a) => streamable(a) && coverURL(a)).map((album) => ({ album, kind: 'From your favourites' }));
          heroPool = dedupe([...favPicks, ...newPicks], (x) => x.album.id);
          shufflePick();
        });
      });

      // Because you like {seed}: the newest album of each similar artist.
      seeds.slice(0, 3).forEach((seed) => {
        const section = row(`Because you like ${seed.name || ''}`, 'Artists in the same orbit');
        becauseHost.append(section);
        similarArtists(seed.id)
          .then((similar) => pool(similar.slice(0, 8), 5, (a) => artistAlbums(a.id).then((l) => [...l].sort(newestFirst)[0])))
          .then((albums) => section.fill(dedupe(albums.filter(streamable), (a) => a.id).slice(0, 14).map(albumCard)), () => section.remove());
      });

      // Artists similar to several of your favourites come first.
      const favouriteIds = new Set(favourites.map((a) => a.id));
      pool(seeds, 4, (s) => similarArtists(s.id)).then((lists) => {
        const score = new Map(), byId = new Map();
        lists.flat().filter((a) => a && !favouriteIds.has(a.id)).forEach((a) => {
          score.set(a.id, (score.get(a.id) || 0) + 1);
          byId.set(a.id, a);
        });
        const ranked = [...score.keys()].sort((x, y) => score.get(y) - score.get(x)).slice(0, 16);
        mightLike.fill(ranked.map((id) => artistCard(byId.get(id))));
      });
    }, (e) => {
      log('Home: favourites failed to load:', e.message);
      newFromFavourites.remove();
      mightLike.remove();
    });

    newReleases().then(
      (albums) => fresh.fill(dedupe(albums.filter(streamable), (a) => a.id).slice(0, 18).map(albumCard)),
      () => fresh.remove()
    );
  };

  // In your rotation: recent tracks (one per album, at most two per artist),
  // then recently played or opened artists and opened playlists, newest first.
  const refreshRotation = () => {
    const host = page?.querySelector('.rosin-home-rotation-host');
    if (!host) return;
    const tracks = readLog('tracks');
    const albumsSeen = new Set(), perArtist = new Map(), trackArtists = new Set();
    const trackItems = [];
    for (const t of tracks) {
      if (!t.albumId || albumsSeen.has(t.albumId)) continue;
      const artistKey = t.artistId || `name:${t.artist}`;
      if ((perArtist.get(artistKey) || 0) >= 2) continue;
      albumsSeen.add(t.albumId);
      perArtist.set(artistKey, (perArtist.get(artistKey) || 0) + 1);
      if (t.artistId) trackArtists.add(t.artistId);
      trackItems.push({ t: t.t || 0, card: () => trackCard(t) });
      if (trackItems.length === 8) break;
    }
    const artistsSeen = new Set(trackArtists);
    const artistEntries = [];
    for (const x of [...tracks.map((t) => ({ id: t.artistId, t: t.t })), ...readLog('artists')]) {
      if (!x.id || artistsSeen.has(x.id)) continue;
      artistsSeen.add(x.id);
      artistEntries.push(x);
    }
    artistEntries.sort((a, b) => (b.t || 0) - (a.t || 0));

    Promise.all([
      pool(artistEntries.slice(0, 6), 4, (x) => artist(x.id).then((a) => a && { t: x.t || 0, card: () => artistCard(a) })),
      pool(readLog('playlists').slice(0, 6), 4, (x) => playlist(x.id).then((p) => p && { t: x.t || 0, card: () => playlistCard(p) })),
    ]).then(([artists, playlists]) => {
      if (!active) return;
      const items = [...trackItems, ...artists.filter(Boolean), ...playlists.filter(Boolean)]
        .sort((a, b) => b.t - a.t).slice(0, 16);
      if (!items.length) { host.replaceChildren(); return; }
      const section = row('In your rotation', 'Pick up where you left off');
      section.fill(items.map((x) => x.card()));
      host.replaceChildren(section);
    });
  };

  // ---------------------------------------------------------------------------
  // The page: an overlay sized to the main scroll area, and placed in the
  // layout root, under the z-index of the nav bar and player panels, so
  // Qobuz's own menus still open over it.
  // ---------------------------------------------------------------------------
  // Qobuz renders a new layout root when the page template changes (Discover
  // to Library, say), and the old one takes the page with it, so it's put
  // back whenever it's been left behind.
  const placePage = () => {
    const host = $(S.layoutRoot);
    if (!page || !host) return;
    if (page.parentElement !== host) host.append(page);
    const area = $(S.mainScroll)?.getBoundingClientRect();
    if (!area || area.width < 200 || area.height < 200) return;
    Object.assign(page.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
  };
  // It opens over Library, whichever page was showing, so Qobuz's library
  // sidebar is beside it. The sidebar belongs to the Library page's template
  // (UiTemplateLibrary), not the app's frame, so no other page has one. The
  // route watcher lets this one navigation through instead of closing.
  const LIBRARY_PATH = '/user-library';
  let openingOver = null;
  const open = () => {
    const host = $(S.layoutRoot);
    if (!host) return;
    if (!pathname().startsWith(LIBRARY_PATH)) {
      openingOver = LIBRARY_PATH;
      navigate(LIBRARY_PATH);
    }
    if (!page) {
      page = element(
        `<div id="${PAGE_ID}"><div class="rosin-home-content">` +
          '<h1>Home</h1>' +
          '<p class="rosin-home-intro">From your favourites and listening</p>' +
          '<div class="rosin-home-pick-host"></div><div class="rosin-home-rotation-host"></div><div class="rosin-home-rows-host"></div>' +
        '</div></div>'
      );
    }
    active = true;
    placePage();
    page.hidden = false;
    page.scrollTop = 0;
    if (!built) { built = true; buildRows(); } else shufflePick();
    refreshRotation();
    markTab();
  };
  const close = () => {
    openingOver = null;
    if (!active) return;
    active = false;
    if (page) page.hidden = true;
    markTab();
  };

  // ---------------------------------------------------------------------------
  // The tab, first in the nav bar's list, styled like Qobuz's own. While the
  // page is open it's the highlighted one; Qobuz's own highlight is hidden.
  // ---------------------------------------------------------------------------
  // Qobuz renders a new nav bar on every navigation, so the one tab element
  // is moved into each new list.
  let tab = null;
  const ensureTab = () => {
    const list = $(S.navItems);
    if (!list) return;
    if (!tab) {
      tab = element(
        `<div ${TAB_ATTRIBUTE} class="ui-block-nav-item flex w-full relative rounded-md cursor-pointer select-none transition-colors duration-200 outline-1 -outline-offset-1 outline-transparent hover:bg-surface-default-secondary">` +
          `<a class="ui-link flex w-full items-center gap-8 px-12 py-8 rounded-md transition-colors duration-200" href="/home">${TAB_ICON}<span>Home</span></a>` +
        '</div>'
      );
      tab.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
    }
    if (list.firstElementChild === tab) return;
    list.prepend(tab);
    markTab();
  };
  // Qobuz's own highlight is hidden with inline !important styles rather
  // than a class, because inline beats every stylesheet: a theme's rule for
  // the current tab (custom.css's .ui-block-nav-item.cursor-default, say)
  // would otherwise outrank it and keep Library highlighted under Home.
  const HIDDEN_HIGHLIGHT = ['background-color', 'outline-color'];
  const markTab = () => {
    tab?.classList.toggle('rosin-home-tab-active', active);
    $$(S.navItem).forEach((item) => {
      if (item === tab) return;
      for (const property of HIDDEN_HIGHLIGHT) {
        if (active) item.style.setProperty(property, 'transparent', 'important');
        else item.style.removeProperty(property);
      }
    });
  };

  // Clicking another tab, the logo or the search bar leaves Home. The page
  // sits over whatever route was showing, so going to that same route changes
  // nothing in the router, and the route watcher below wouldn't close it.
  const onClick = (e) => {
    if (!active || !e.target.closest) return;
    if (e.target.closest(`[${TAB_ATTRIBUTE}]`)) return;
    if (e.target.closest(`${S.navItems}, ${S.navBrand}, ${S.searchBar}`)) close();
  };

  // ---------------------------------------------------------------------------
  // Styles. Colours come from Qobuz's tokens, which follow its light and dark
  // themes and Rosin's accent. Headings are real h1/h2, so custom.css's
  // heading styles apply here too.
  // ---------------------------------------------------------------------------
  const CSS = `
    #${PAGE_ID} {
      --rosin-home-text: var(--token-text-primary, #fff);
      --rosin-home-text-secondary: var(--token-text-secondary, #bdbdbd);
      --rosin-home-accent: var(--token-text-accent, #ffcb74);
      --rosin-home-on-accent: var(--token-text-invert, #242424);
      --rosin-home-fill: color-mix(in srgb, currentColor 5%, transparent);
      --rosin-home-fill-hover: color-mix(in srgb, currentColor 10%, transparent);
      --rosin-home-line: color-mix(in srgb, currentColor 13%, transparent);
      position: fixed; z-index: 220; overflow: auto;
      color: var(--rosin-home-text);
      background: var(--token-color-surface-default-primary, #121212);
      scrollbar-width: thin;
    }
    #${PAGE_ID}[hidden] { display: none; }
    .rosin-home-content { max-width: 1500px; margin: 0 auto; padding: 34px 40px 60px; }
    .rosin-home-content h1 { margin: 0; font-size: 36px; font-weight: 800; }
    .rosin-home-intro { margin: 7px 0 0; font-size: 14px; color: var(--rosin-home-text-secondary); }

    .rosin-home-pick { display: flex; align-items: center; gap: 26px; margin: 20px 0 6px; padding: 22px; border-radius: 18px; background: var(--rosin-home-fill); border: 1px solid var(--rosin-home-line); }
    .rosin-home-pick-art { position: relative; flex: none; width: 168px; height: 168px; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 28px -14px rgba(0, 0, 0, .6); }
    .rosin-home-pick-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .rosin-home-pick-info { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
    .rosin-home-pick-kind { font-size: 13px; font-weight: 600; color: var(--rosin-home-text-secondary); }
    .rosin-home-pick-title { font-size: 34px; font-weight: 800; line-height: 1.08; color: var(--rosin-home-text); text-decoration: none; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rosin-home-pick-title:hover { text-decoration: underline; }
    .rosin-home-pick-subtitle { font-size: 14px; color: var(--rosin-home-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-home-pick-play { margin-top: 8px; align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 26px; background: var(--rosin-home-accent); color: var(--rosin-home-on-accent); font: inherit; font-size: 14px; font-weight: 700; padding: 11px 24px; cursor: pointer; }
    .rosin-home-pick-play:hover { filter: brightness(1.06); }
    .rosin-home-pick-play svg { width: 17px; height: 17px; }
    .rosin-home-pick-shuffle { margin-top: 10px; align-self: flex-start; display: inline-flex; align-items: center; gap: 7px; border: 0; padding: 2px 0; background: none; color: var(--rosin-home-text-secondary); font: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer; }
    .rosin-home-pick-shuffle:hover { color: var(--rosin-home-accent); }
    .rosin-home-pick-shuffle svg { width: 14px; height: 14px; }

    .rosin-home-row { margin: 28px 0 6px; }
    .rosin-home-rowhead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .rosin-home-rowhead h2 { margin: 0; font-size: 20px; font-weight: 700; }
    .rosin-home-rowhead span { font-size: 12.5px; color: var(--rosin-home-text-secondary); }
    /* Capped widths, so a row with only a card or two doesn't stretch them. */
    .rosin-home-shelf { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(158px, 190px); gap: 20px; overflow-x: auto; overflow-y: hidden; padding-bottom: 12px; scroll-snap-type: x proximity; scrollbar-width: thin; }
    .rosin-home-card { display: block; min-width: 0; text-decoration: none; scroll-snap-align: start; cursor: pointer; }
    .rosin-home-art { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--rosin-home-fill-hover); transition: transform .16s; }
    .rosin-home-card:hover .rosin-home-art { transform: translateY(-4px); }
    .rosin-home-card--round .rosin-home-art { border-radius: 50%; }
    .rosin-home-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .rosin-home-title { margin-top: 10px; font-size: 13.5px; font-weight: 700; color: var(--rosin-home-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-home-subtitle { margin-top: 2px; font-size: 12px; color: var(--rosin-home-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-home-card--round .rosin-home-title, .rosin-home-card--round .rosin-home-subtitle { text-align: center; }
    .rosin-home-badge { position: absolute; top: 8px; left: 8px; padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 700; color: var(--rosin-home-on-accent); background: var(--rosin-home-accent); }
    .rosin-home-play { position: absolute; right: 9px; bottom: 9px; width: 44px; height: 44px; border: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--rosin-home-accent); color: var(--rosin-home-on-accent); cursor: pointer; opacity: 0; transform: translateY(8px) scale(.85); transition: opacity .15s, transform .15s; box-shadow: 0 4px 12px rgba(0, 0, 0, .4); }
    .rosin-home-play svg { width: 21px; height: 21px; margin-left: 2px; }
    .rosin-home-card:hover .rosin-home-play { opacity: 1; transform: none; }
    .rosin-home-placeholder { aspect-ratio: 1; border-radius: 12px; background: linear-gradient(100deg, var(--rosin-home-fill) 30%, var(--rosin-home-fill-hover) 50%, var(--rosin-home-fill) 70%); background-size: 200% 100%; animation: rosin-home-shimmer 1.3s linear infinite; }
    @keyframes rosin-home-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

    .rosin-home-tab-active { background: color-mix(in srgb, currentColor 9%, transparent) !important; outline-color: color-mix(in srgb, currentColor 14%, transparent) !important; }
    .rosin-home-tab-active a, .rosin-home-tab-active span { white-space: nowrap; }  `;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);

  // ---------------------------------------------------------------------------
  // Start. This runs before Qobuz's bundle, so wait for its store and nav bar.
  // After that, a MutationObserver puts the tab and the open page back as
  // soon as a re-render drops them: its callback runs before the next paint,
  // so the tab is never seen missing and the nav bar doesn't shift. A poll
  // keeps the page sized to the scroll area and backs the observer up.
  // ---------------------------------------------------------------------------
  let unsubscribe = null;
  const watchStore = (s) => {
    let lastPath = pathname();
    let lastTrack = s.getState().player?.currentTrack?.id;
    seedRecentTracks();
    if (lastTrack) logTrack(lastTrack);
    logRoute(lastPath);
    unsubscribe = s.subscribe(() => {
      const state = s.getState();
      const path = state.router?.location?.pathname || '';
      if (path !== lastPath) {
        lastPath = path;
        if (path === openingOver) openingOver = null;
        else close();
        logRoute(path);
      }
      const track = state.player?.currentTrack?.id;
      if (track && track !== lastTrack) { lastTrack = track; logTrack(track); }
    });
  };
  const restore = new MutationObserver(() => {
    ensureTab();
    if (active && page.parentElement !== $(S.layoutRoot)) placePage();
  });
  const tick = setInterval(() => {
    if (!unsubscribe) {
      const s = store();
      if (!s || !$(S.navItems)) return;
      watchStore(s);
      restore.observe(document.body, { childList: true, subtree: true });
    }
    ensureTab();
    if (active) placePage();
  }, 500);
  document.addEventListener('click', onClick, true);

  return () => {
    restore.disconnect();
    clearInterval(tick);
    clearInterval(playTimer);
    unsubscribe?.();
    document.removeEventListener('click', onClick, true);
    active = false;
    markTab();
    tab?.remove();
    page?.remove();
    style.remove();
  };
};
