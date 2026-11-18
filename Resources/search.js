// Better Search. Results as you type in Qobuz's own search bar: a page over
// the main scroll area with a top result, songs, albums, artists and
// playlists, ranked here (fuzzy and accent-insensitive, covers and karaoke
// versions demoted), with tabs, Hi-Res / CD / Heard filters, a year filter
// and a sort. loader.js loads it (unless the companion's Use Better Search
// setting is off) and passes in its SELECTORS and Qobuz's store and API; this
// file queries Qobuz's DOM only through those selectors.
//
// Qobuz's own search still runs underneath (it navigates to /search as you
// type), so the page stays open through /search and closes on any other
// navigation, a click on a nav tab or the logo, the search bar's clear
// button, or Escape (in loader.js's SHORTCUTS). Closing from /search goes
// back to the page you were on.
//
// All the data comes from Qobuz's own API with the in-app login:
//   catalog/search   favorite/getUserFavorites (for Heard)
// Nothing else is contacted. Play buttons open the album or playlist and click
// its own Play, since the page has no play API.
//
// Adapted from the "Better Search" extension in Qobuzify,
// https://github.com/matthewprince/qobuzify (extensions/better-search). Left
// out: "Did you mean" spelling correction, which sends every search to
// Qobuzify's server (and from there to LanguageTool, MusicBrainz and Last.fm).
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

// Installs Better Search and returns { remove } to take it out again, and
// close() for Escape, which returns false if the results weren't showing. All
// state is inside, so it can be installed again after a cleanup.
module.exports = ({ selectors: S, store, api, navigate, playAt, playTrackAt, log }) => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const STYLE_ID = 'rosin-search-styles';
  const PANEL_ID = 'rosin-search';
  // Shorter queries don't open the page; typing pauses this long (ms) before
  // a search is sent.
  const MIN_LENGTH = 2;
  const DEBOUNCE = 190;

  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  // Placeholders for when there's no image (artists often have image: null).
  const ARTIST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5z"/></svg>';
  const MUSIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 16.5V6l9-1.8v10.3"/><circle cx="7.5" cy="16.5" r="2.6"/><circle cx="16.5" cy="14.5" r="2.6"/></svg>';

  let input = null;
  let panel = null;
  let debounceTimer = null;
  // The query as typed (raw), as searched (query), the response for it
  // (data, or { failed: true }), and the filters. `request` drops responses
  // that a newer search has overtaken.
  const state = {
    raw: '', query: '', data: null, request: 0,
    tab: 'top', hires: false, lossless: false, heard: false, sort: 'relevance', year: 0,
  };
  // Where to go back to on closing, if Qobuz's own search had moved to /search.
  let lastPath = null;

  // ---------------------------------------------------------------------------
  // Matching. Accent- and case-insensitive; a word that starts the name beats
  // one inside it, and a fuzzy subsequence match still counts for a little.
  // ---------------------------------------------------------------------------
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’']/g, '').trim();
  const wordScore = (name, word) => {
    if (name === word) return 1000;
    if (name.startsWith(word)) return 860;
    if (name.split(/\s+/).some((w) => w.startsWith(word))) return 730;
    if (name.includes(word)) return 560;
    let matched = 0;
    for (let i = 0; i < name.length && matched < word.length; i++) if (name[i] === word[matched]) matched++;
    if (matched === word.length) return Math.max(120, 320 - (name.length - word.length));
    return 0;
  };
  // Several words: every one has to match, scored by their average, with a
  // bonus if the whole phrase appears in order.
  const score = (name, query) => {
    const n = norm(name);
    if (!n || !query) return 0;
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return wordScore(n, query);
    let total = 0;
    for (const word of words) {
      const s = wordScore(n, word);
      if (!s) return 0;
      total += s;
    }
    let base = total / words.length;
    if (n.startsWith(query)) base += 220;
    else if (n.includes(query)) base += 110;
    return base;
  };

  // ---------------------------------------------------------------------------
  // Qobuz items
  // ---------------------------------------------------------------------------
  const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // A track's quality is on the track, or else on its album.
  const qualitySource = (o) => (o && (o.maximum_bit_depth || o.hires != null) ? o : o?.album || o);
  const tier = (o) => {
    const source = qualitySource(o) || {};
    const depth = source.maximum_bit_depth || (source.hires ? 24 : 16);
    const rate = source.maximum_sampling_rate || 0;
    const detail = depth && rate ? `${depth}/${rate}` : '';
    if (source.hires || depth >= 24) return { kind: 'hires', label: 'Hi-Res', detail };
    if (depth >= 16) return { kind: 'lossless', label: 'CD', detail };
    return { kind: 'lossy', label: 'MP3', detail: '' };
  };
  const badge = (o) => {
    const t = tier(o);
    return `<span class="rosin-search-badge rosin-search-badge--${t.kind}">${t.label}${t.detail ? ` <i>${t.detail}</i>` : ''}</span>`;
  };
  const released = (o) => (o && (o.released_at || (o.release_date_original && Date.parse(o.release_date_original) / 1000) || (o.album && released(o.album)))) || 0;
  const year = (o) => (released(o) ? ` · ${new Date(released(o) * 1000).getFullYear()}` : '');
  const coverURL = (o) => {
    if (!o) return '';
    const image = o.image || o.picture || o.cover;
    if (!image) return o.album ? coverURL(o.album) : '';
    if (typeof image === 'string') return image;
    return image.small || image.thumbnail || image.medium || image.large || '';
  };
  const performer = (t) => t.performer || t.artist;

  const thumb = (url, round, kind) => {
    const classes = `rosin-search-thumb${round ? ' rosin-search-thumb--round' : ''}`;
    if (url) return `<span class="${classes}"><img loading="lazy" src="${escape(url)}"></span>`;
    return `<span class="${classes} rosin-search-thumb--placeholder">${kind === 'artist' ? ARTIST_ICON : MUSIC_ICON}</span>`;
  };
  const art = (url, kind, round) => {
    const classes = `rosin-search-art${round ? ' rosin-search-art--round' : ''}`;
    if (url) return `<img class="${classes}" loading="lazy" src="${escape(url)}">`;
    return `<span class="${classes} rosin-search-art--placeholder">${kind === 'artist' ? ARTIST_ICON : MUSIC_ICON}</span>`;
  };

  // ---------------------------------------------------------------------------
  // Heard: tracks in your favourites, or in Qobuz's play history (the higher
  // the rank, the more recent). They're lifted in Relevance, sorted first by
  // Familiar, and the only ones the Heard filter keeps.
  // ---------------------------------------------------------------------------
  const known = { favourites: new Set(), recent: new Map() };
  const refreshRecent = () => {
    const history = store()?.getState().playqueue?.history || [];
    for (let i = Math.max(0, history.length - 200); i < history.length; i++) known.recent.set(history[i], i);
  };
  let favouritesLoaded = false;
  const loadFavourites = () => {
    if (favouritesLoaded) return;
    favouritesLoaded = true;
    api('favorite/getUserFavorites?type=tracks&limit=500').then((j) => {
      for (const t of j.tracks?.items || []) known.favourites.add(t.id);
    }, (e) => { favouritesLoaded = false; log('Better Search: favourites failed to load:', e.message); });
  };
  const knownOf = (track) => {
    if (!track) return null;
    const rank = known.recent.get(track.id);
    const favourite = known.favourites.has(track.id);
    if (rank == null && !favourite) return null;
    return { recent: rank != null, rank: rank ?? -1, favourite };
  };

  // ---------------------------------------------------------------------------
  // Searching
  // ---------------------------------------------------------------------------
  const search = (query) => {
    refreshRecent();
    loadFavourites();
    const request = ++state.request;
    state.query = query;
    api(`catalog/search?query=${encodeURIComponent(query)}&limit=30`).then((data) => {
      if (request !== state.request) return;
      state.data = data;
      render();
    }, () => {
      if (request !== state.request) return;
      state.data = { failed: true };
      render();
    });
  };

  // Covers, karaoke, instrumentals and tributes are demoted so the real
  // recording wins. Live, acoustic and unplugged versions aren't: they're real
  // alternate takes.
  const COVER_PATTERN = /karaoke|instrumental|originally performed|in the style of|made famous|tribute|backing track|cover version|bossa nova version|lullaby|piano cover|8 ?bit|ringtone|remake/;
  const rank = (group, query, { quality = false, dated = false, track = false } = {}) => {
    const nq = norm(query);
    let scored = (group?.items || []).map((item, index) => {
      const name = item.title || item.name || '';
      const by = item.artist?.name || item.performer?.name || '';
      // The title, the artist, and both together: a query that mixes song and
      // artist ("Blank Space Taylor Swift") matches neither alone, while a
      // cover that puts the artist in its own title would match fully.
      let s = Math.max(score(name, query), score(by, query) * 0.6, score(`${name} ${by}`, query) * 0.9);
      const nBy = norm(by), nName = norm(name);
      // A query that names this item's artist, or the item itself, owns it.
      if (nBy.length > 2 && nq.includes(nBy)) s += 500;
      if (nName.length > 2 && nq.includes(nName)) s += 350;
      if (s && COVER_PATTERN.test(nName)) s *= 0.4;
      const heard = track ? knownOf(item) : null;
      if (heard) s += heard.recent ? 150 : 90;
      return { item, s, index, heard };
    });
    if (quality) scored = scored.filter((x) => { const kind = tier(x.item).kind; return state.hires ? kind === 'hires' : state.lossless ? kind === 'lossless' : true; });
    if (dated && state.year) scored = scored.filter((x) => new Date(released(x.item) * 1000).getFullYear() >= state.year);
    if (track && state.heard) scored = scored.filter((x) => x.heard);
    const familiarity = (x) => (x.heard ? (x.heard.recent ? 2 : 1) : 0);
    const comparisons = {
      // Qobuz returns roughly popularity order.
      popularity: (a, b) => a.index - b.index,
      familiar: (a, b) => familiarity(b) - familiarity(a) || (b.heard?.rank ?? -1) - (a.heard?.rank ?? -1) || b.s - a.s || a.index - b.index,
      newest: (a, b) => released(b.item) - released(a.item) || a.index - b.index,
      oldest: (a, b) => (released(a.item) || 9e9) - (released(b.item) || 9e9) || a.index - b.index,
      relevance: (a, b) => b.s - a.s || a.index - b.index,
    };
    scored.sort(comparisons[state.sort] || comparisons.relevance);
    if (state.sort === 'relevance') scored = scored.filter((x) => x.s > 0);
    return scored.map((x) => x.item);
  };

  // The top result: the best-matching artist or album, if it matches well.
  //
  // An artist has to be backed up by the songs underneath. Qobuz's catalogue
  // has junk artist entries whose "name" is really a sentence starting with a
  // song's title, which would otherwise beat the song itself. A real artist
  // performs some of the top tracks; if the top "artist" performs none of
  // them while one performer has most, the query was a song title, and that
  // performer is the top result instead.
  const topResult = (albums, tracks, artists, query) => {
    const nq = norm(query);
    const named = (name) => norm(name).length > 2 && nq.includes(norm(name));
    let bestArtist = artists[0] ? { item: artists[0], kind: 'artist', s: score(artists[0].name, query) } : null;
    if (bestArtist && named(artists[0].name)) bestArtist.s += 1200;
    const counts = new Map(), performers = new Map(), covers = new Map();
    for (const t of tracks.slice(0, 6)) {
      const p = performer(t);
      if (!p?.id) continue;
      counts.set(p.id, (counts.get(p.id) || 0) + 1);
      performers.set(p.id, p);
      if (!covers.has(p.id)) covers.set(p.id, coverURL(t));
    }
    let leaderId = null, leaderCount = 0;
    for (const [id, n] of counts) if (n > leaderCount) { leaderCount = n; leaderId = id; }
    if (bestArtist && leaderId && !counts.has(artists[0].id) && leaderCount >= 2) {
      const p = performers.get(leaderId);
      bestArtist = { item: { id: p.id, name: p.name, image: covers.get(leaderId) || coverURL(tracks[0]) }, kind: 'artist', s: bestArtist.s };
    }
    const bestAlbum = albums[0]
      ? { item: albums[0], kind: 'album', s: score(albums[0].title, query) * (COVER_PATTERN.test(norm(albums[0].title)) ? 0.4 : 1) }
      : null;
    let hero = bestArtist && (!bestAlbum || bestArtist.s >= bestAlbum.s) ? bestArtist : bestAlbum;
    if (hero && hero.s < 300) hero = null;
    // "Song artist" queries find no artist and only cover albums: if the top
    // track's performer is named in the query, they're the top result.
    if (!hero && tracks[0]) {
      const p = performer(tracks[0]);
      if (p?.id && named(p.name)) hero = { item: { id: p.id, name: p.name, image: coverURL(tracks[0]) }, kind: 'artist' };
    }
    return hero;
  };

  // ---------------------------------------------------------------------------
  // Opening and playing. loader.js's playAt and playTrackAt open the album or
  // playlist and click its own Play.
  // ---------------------------------------------------------------------------
  const go = (path) => { hide(); navigate(path); };
  const play = (path) => { hide(); playAt(path); };
  const playTrack = (albumId, title, number) => { hide(); playTrackAt(albumId, title, number); };

  // ---------------------------------------------------------------------------
  // Rows and cards
  // ---------------------------------------------------------------------------
  const element = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  };
  const playButton = (onPlay) => {
    const button = element(`<button class="rosin-search-play" title="Play" aria-label="Play">${PLAY_ICON}</button>`);
    button.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPlay(); });
    return button;
  };
  const linkTo = (el, path) => el.addEventListener('click', (e) => { e.preventDefault(); go(path); });

  const trackRow = (t) => {
    const albumId = t.album?.id;
    const heard = knownOf(t);
    const mark = heard
      ? `<span class="rosin-search-heard${heard.recent ? ' rosin-search-heard--recent' : ''}">${heard.recent ? 'Recently played' : 'In favourites'}</span>`
      : '';
    const r = element(
      `<a class="rosin-search-row${heard ? ' rosin-search-row--heard' : ''}" href="${albumId ? `/album/${albumId}` : '#'}">${thumb(coverURL(t), false, 'track')}` +
        `<span class="rosin-search-meta"><span class="rosin-search-name">${escape(t.title)} ${badge(t)}${mark}</span>` +
        `<span class="rosin-search-sub">${escape(performer(t)?.name)}${t.album ? ` · ${escape(t.album.title)}` : ''}</span></span></a>`
    );
    if (albumId) {
      r.querySelector('.rosin-search-thumb').append(playButton(() => playTrack(albumId, t.title, t.track_number)));
      linkTo(r, `/album/${albumId}`);
    } else {
      r.addEventListener('click', (e) => e.preventDefault());
    }
    return r;
  };
  const card = ({ path, image, kind, round = false, title, subtitle, extra = '', onPlay }) => {
    const c = element(
      `<a class="rosin-search-card${round ? ' rosin-search-card--round' : ''}" href="${path}">` +
        `<span class="rosin-search-cardart">${art(image, kind, round)}${extra}</span>` +
        `<span class="rosin-search-cardname">${escape(title)}</span>` +
        `<span class="rosin-search-cardsub">${subtitle}</span></a>`
    );
    if (onPlay) c.querySelector('.rosin-search-cardart').append(playButton(onPlay));
    linkTo(c, path);
    return c;
  };
  const albumCard = (album) => card({
    path: `/album/${album.id}`, image: coverURL(album), kind: 'album', title: album.title,
    subtitle: escape(album.artist?.name) + year(album),
    extra: `<span class="rosin-search-cardbadge">${badge(album)}</span>`,
    onPlay: () => play(`/album/${album.id}`),
  });
  const artistCard = (a) => card({
    path: `/artist/${a.id}`, image: coverURL(a), kind: 'artist', round: true, title: a.name,
    subtitle: `Artist${a.albums_count ? ` · ${a.albums_count} releases` : ''}`,
  });
  const playlistCard = (p) => card({
    path: `/playlist/${p.id}`, image: coverURL(p.images300 ? { image: p.images300[0] } : p), kind: 'playlist', title: p.name,
    subtitle: `Playlist${p.tracks_count ? ` · ${p.tracks_count} tracks` : ''}${p.owner?.name ? ` · ${escape(p.owner.name)}` : ''}`,
    onPlay: () => play(`/playlist/${p.id}`),
  });
  const heroCard = ({ item, kind }) => {
    const path = `/${kind}/${item.id}`;
    const subtitle = kind === 'artist' ? 'Artist' : `Album${item.artist?.name ? ` · ${escape(item.artist.name)}` : ''}${year(item)}`;
    const c = element(
      '<div class="rosin-search-hero">' +
        `<a class="rosin-search-heroart${kind === 'artist' ? ' rosin-search-heroart--round' : ''}" href="${path}">${art(coverURL(item), kind, kind === 'artist')}</a>` +
        '<div class="rosin-search-heroinfo">' +
          `<a class="rosin-search-heroname" href="${path}">${escape(item.name || item.title)}</a>` +
          `<div class="rosin-search-herosub">${subtitle}</div>` +
          `<button class="rosin-search-herobutton">${PLAY_ICON}Play</button>` +
        '</div></div>'
    );
    c.querySelectorAll('a').forEach((a) => linkTo(a, path));
    c.querySelector('.rosin-search-herobutton').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); play(path); });
    return c;
  };
  // A titled section of cards (grid) or rows (list); null if it's empty.
  const section = (title, children, layout) => {
    if (!children.length) return null;
    const s = element(`<section class="rosin-search-section">${title ? `<h2>${escape(title)}</h2>` : ''}<div class="rosin-search-${layout}"></div></section>`);
    s.lastElementChild.append(...children);
    return s;
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const message = (text, detail = '') => `<div class="rosin-search-message">${text}${detail ? `<span>${detail}</span>` : ''}</div>`;
  const render = () => {
    if (!panel) return;
    const body = panel.querySelector('.rosin-search-body');
    panel.querySelector('.rosin-search-query').textContent = state.raw.trim();
    $$('[data-tab]', panel).forEach((b) => b.classList.toggle('rosin-search-on', b.dataset.tab === state.tab));
    for (const filter of ['hires', 'lossless', 'heard']) panel.querySelector(`[data-filter="${filter}"]`).classList.toggle('rosin-search-on', state[filter]);
    // Quality filters don't apply to artists or playlists.
    panel.querySelector('.rosin-search-quality').classList.toggle('rosin-search-disabled', state.tab === 'artists' || state.tab === 'playlists');

    const d = state.data;
    if (norm(state.raw).length < MIN_LENGTH) { body.innerHTML = message('Search Qobuz', 'Albums, tracks, artists and playlists, ranked as you type.'); return; }
    if (!d) { body.innerHTML = message('Searching…'); return; }
    if (d.failed) { body.innerHTML = message('Search failed', 'Try again.'); return; }

    const query = norm(state.query);
    const albums = rank(d.albums, query, { quality: true, dated: true });
    const tracks = rank(d.tracks, query, { quality: true, dated: true, track: true });
    const artists = rank(d.artists, query);
    const playlists = rank(d.playlists, query);
    const content = element('<div class="rosin-search-content"></div>');
    const add = (s) => s && content.append(s);

    if (state.tab === 'top') {
      const hero = topResult(albums, tracks, artists, query);
      if (hero || tracks.length) {
        const top = element('<div class="rosin-search-top"></div>');
        if (hero) top.append(section('Top result', [heroCard(hero)], 'single'));
        const songs = section('Songs', tracks.slice(0, 6).map(trackRow), 'list');
        if (songs) { songs.classList.add('rosin-search-songs'); top.append(songs); }
        content.append(top);
      }
      // The hero isn't repeated in its own row.
      const skip = (kind) => (hero?.kind === kind ? 1 : 0);
      add(section('Albums', albums.slice(skip('album'), skip('album') + 7).map(albumCard), 'grid'));
      add(section('Artists', artists.slice(skip('artist'), skip('artist') + 7).map(artistCard), 'grid'));
      add(section('Playlists', playlists.slice(0, 7).map(playlistCard), 'grid'));
      if (!content.childElementCount) { body.innerHTML = message('No matches'); return; }
    } else if (state.tab === 'tracks') {
      if (!tracks.length) { body.innerHTML = message('No tracks match your filters'); return; }
      add(section('', tracks.slice(0, 60).map(trackRow), 'columns'));
    } else {
      const [list, make] = { albums: [albums, albumCard], artists: [artists, artistCard], playlists: [playlists, playlistCard] }[state.tab];
      if (!list.length) { body.innerHTML = message(`No ${state.tab} match your filters`); return; }
      add(section('', list.slice(0, 60).map(make), 'grid'));
    }
    body.replaceChildren(content);
  };

  // ---------------------------------------------------------------------------
  // The page: an overlay sized to the main scroll area, placed in the layout
  // root like Home's, under the nav bar and player panels so Qobuz's own
  // menus still open over it. Qobuz renders a new layout root when the page
  // template changes, so it's put back whenever it's been left behind.
  // ---------------------------------------------------------------------------
  const TABS = [['top', 'Top'], ['albums', 'Albums'], ['tracks', 'Tracks'], ['artists', 'Artists'], ['playlists', 'Playlists']];
  const SORTS = [['relevance', 'Relevance'], ['popularity', 'Popularity'], ['familiar', 'Familiar'], ['newest', 'Newest'], ['oldest', 'Oldest']];
  const years = () => {
    const now = new Date().getFullYear();
    const recent = Array.from({ length: 7 }, (_, i) => now - i);
    return [...recent, ...[2020, 2015, 2010, 2000, 1990, 1980, 1970, 1960].filter((y) => y < now - 6)];
  };
  const option = ([value, label]) => `<option value="${value}">${label}</option>`;
  const buildPanel = () => {
    panel = element(
      `<div id="${PANEL_ID}" hidden>` +
        '<div class="rosin-search-head">' +
          '<div class="rosin-search-headtop">' +
            '<div class="rosin-search-title"><span>Results for</span><h1 class="rosin-search-query"></h1></div>' +
            `<button class="rosin-search-close" title="Close (Esc)" aria-label="Close">${CLOSE_ICON}</button>` +
          '</div>' +
          '<div class="rosin-search-filters">' +
            `<div class="rosin-search-tabs">${TABS.map(([tab, label]) => `<button class="rosin-search-tab" data-tab="${tab}">${label}</button>`).join('')}</div>` +
            '<div class="rosin-search-controls">' +
              '<div class="rosin-search-quality">' +
                '<button class="rosin-search-chip" data-filter="hires" title="24-bit Hi-Res only">Hi-Res</button>' +
                '<button class="rosin-search-chip" data-filter="lossless" title="16-bit CD quality only">CD</button>' +
                '<button class="rosin-search-chip" data-filter="heard" title="Only songs you\'ve played or favourited">Heard</button>' +
              '</div>' +
              `<select class="rosin-search-select rosin-search-year">${option([0, 'Any year'])}${years().map((y) => option([y, `From ${y}`])).join('')}</select>` +
              `<select class="rosin-search-select rosin-search-sort">${SORTS.map(option).join('')}</select>` +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="rosin-search-body"></div>' +
      '</div>'
    );
    const scrollToTop = () => { panel.querySelector('.rosin-search-body').scrollTop = 0; };
    $$('[data-tab]', panel).forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); scrollToTop(); }));
    panel.querySelector('[data-filter="hires"]').addEventListener('click', () => { state.hires = !state.hires; if (state.hires) state.lossless = false; render(); });
    panel.querySelector('[data-filter="lossless"]').addEventListener('click', () => { state.lossless = !state.lossless; if (state.lossless) state.hires = false; render(); });
    // Heard is about songs, so it switches Top to the Tracks tab.
    panel.querySelector('[data-filter="heard"]').addEventListener('click', () => { state.heard = !state.heard; if (state.tab === 'top') state.tab = 'tracks'; render(); });
    panel.querySelector('.rosin-search-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
    panel.querySelector('.rosin-search-year').addEventListener('change', (e) => { state.year = parseInt(e.target.value, 10) || 0; render(); });
    panel.querySelector('.rosin-search-close').addEventListener('click', () => close());
  };

  const isOpen = () => !!panel && !panel.hidden;
  const placePanel = () => {
    const host = $(S.layoutRoot);
    if (!panel || !host) return;
    if (panel.parentElement !== host) host.append(panel);
    const area = $(S.mainScroll)?.getBoundingClientRect();
    if (!area || area.width < 200 || area.height < 200) return;
    Object.assign(panel.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
  };
  const show = () => {
    if (!panel) buildPanel();
    placePanel();
    if (panel.hidden) panel.querySelector('.rosin-search-body').scrollTop = 0;
    panel.hidden = false;
  };
  const hide = () => { if (panel) panel.hidden = true; };
  // Closing on Qobuz's own /search page goes back to where you were, or to
  // Discover if Qobuz opened straight onto search, so it doesn't show through.
  const close = () => {
    if (!isOpen()) return false;
    hide();
    if (pathname().startsWith('/search')) navigate(lastPath || '/discover');
    return true;
  };

  // ---------------------------------------------------------------------------
  // The search bar. Qobuz re-renders it (on every navigation, and on Discover
  // when focusing it opens the history panel), so the listeners follow
  // whichever input is current.
  // ---------------------------------------------------------------------------
  const onInput = () => {
    state.raw = input.value;
    clearTimeout(debounceTimer);
    state.data = null;
    if (norm(state.raw).length < MIN_LENGTH) { if (isOpen()) render(); return; }
    show();
    render();
    const query = state.raw.trim();
    debounceTimer = setTimeout(() => search(query), DEBOUNCE);
  };
  const onFocus = () => {
    if (norm(input.value).length < MIN_LENGTH) return;
    show();
    if (state.query !== input.value.trim() || state.raw !== input.value) onInput();
  };
  // Enter searches straight away, and doesn't reach Qobuz's own search.
  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(debounceTimer);
    if (norm(input.value).length < MIN_LENGTH) return;
    state.raw = input.value;
    show();
    search(input.value.trim());
  };
  const unhookInput = () => {
    if (!input) return;
    input.removeEventListener('input', onInput);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('keydown', onKeyDown);
    input = null;
  };
  const hookInput = () => {
    const current = $(S.searchInput);
    if (!current || current === input) return;
    unhookInput();
    input = current;
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('keydown', onKeyDown);
  };

  // A nav tab or the logo leaves search, even for the page already showing
  // (which changes nothing in the router), and so does the clear button.
  const onClick = (e) => {
    if (!isOpen() || !e.target.closest) return;
    if (e.target.closest(S.searchReset)) { state.raw = ''; close(); return; }
    if (e.target.closest(`${S.navItems}, ${S.navBrand}`)) hide();
  };

  // ---------------------------------------------------------------------------
  // Styles. Colours come from Qobuz's tokens, which follow its light and dark
  // themes and Rosin's accent, as on Home. Headings are real h1/h2, so
  // custom.css's heading styles apply here too.
  // ---------------------------------------------------------------------------
  const CSS = `
    #${PANEL_ID} {
      --rosin-search-text: var(--token-text-primary, #fff);
      --rosin-search-text-secondary: var(--token-text-secondary, #bdbdbd);
      --rosin-search-accent: var(--token-text-accent, #ffcb74);
      --rosin-search-on-accent: var(--token-text-invert, #242424);
      --rosin-search-background: var(--token-color-surface-default-primary, #121212);
      --rosin-search-fill: color-mix(in srgb, currentColor 5%, transparent);
      --rosin-search-fill-hover: color-mix(in srgb, currentColor 10%, transparent);
      --rosin-search-line: color-mix(in srgb, currentColor 13%, transparent);
      position: fixed; z-index: 220; display: flex; flex-direction: column; overflow: hidden;
      color: var(--rosin-search-text);
      background: var(--rosin-search-background);
    }
    #${PANEL_ID}[hidden] { display: none; }

    .rosin-search-head { flex: none; padding: 22px 40px 14px; border-bottom: 1px solid var(--rosin-search-line); }
    .rosin-search-headtop { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
    .rosin-search-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; }
    .rosin-search-title span { flex: none; font-size: 14px; font-weight: 600; color: var(--rosin-search-text-secondary); }
    .rosin-search-title h1 { margin: 0; font-size: 26px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-search-close { flex: none; width: 38px; height: 38px; border: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--rosin-search-fill); color: var(--rosin-search-text-secondary); cursor: pointer; }
    .rosin-search-close:hover { background: var(--rosin-search-fill-hover); color: var(--rosin-search-text); }
    .rosin-search-close svg { width: 19px; height: 19px; }
    .rosin-search-filters { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .rosin-search-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .rosin-search-tab { border: 0; border-radius: 9px; padding: 7px 15px; background: transparent; color: var(--rosin-search-text-secondary); font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
    .rosin-search-tab:hover { background: var(--rosin-search-fill); color: var(--rosin-search-text); }
    .rosin-search-tab.rosin-search-on { background: var(--rosin-search-accent); color: var(--rosin-search-on-accent); }
    .rosin-search-controls { margin-left: auto; display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
    .rosin-search-quality { display: flex; gap: 6px; transition: opacity .14s; }
    .rosin-search-quality.rosin-search-disabled { opacity: .35; pointer-events: none; }
    .rosin-search-chip { border: 1px solid var(--rosin-search-line); border-radius: 20px; padding: 6px 12px; background: transparent; color: var(--rosin-search-text-secondary); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
    .rosin-search-chip:hover { border-color: var(--rosin-search-accent); color: var(--rosin-search-text); }
    .rosin-search-chip.rosin-search-on { border-color: var(--rosin-search-accent); background: var(--rosin-search-accent); color: var(--rosin-search-on-accent); }
    .rosin-search-select { appearance: none; border: 1px solid var(--rosin-search-line); border-radius: 8px; padding: 7px 11px; background: var(--rosin-search-fill); color: var(--rosin-search-text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .rosin-search-select option { background: var(--rosin-search-background); color: var(--rosin-search-text); }

    .rosin-search-body { flex: 1; overflow: auto; padding: 22px 40px 40px; scrollbar-width: thin; }
    .rosin-search-content { max-width: 1500px; margin: 0 auto; }
    .rosin-search-message { padding: 80px 18px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; font-size: 16px; font-weight: 600; color: var(--rosin-search-text-secondary); }
    .rosin-search-message span { font-size: 13px; font-weight: 500; }
    .rosin-search-section { margin: 0 0 30px; }
    .rosin-search-section h2 { margin: 0 0 14px; font-size: 20px; font-weight: 700; }

    /* Top: the top result and Songs side by side. */
    .rosin-search-top { display: grid; grid-template-columns: minmax(320px, 1fr) 1.35fr; gap: 26px; align-items: start; margin-bottom: 30px; }
    .rosin-search-top .rosin-search-section { margin: 0; }
    @media (max-width: 980px) { .rosin-search-top { grid-template-columns: 1fr; } }
    .rosin-search-hero { display: flex; flex-direction: column; gap: 16px; padding: 22px; border-radius: 16px; background: var(--rosin-search-fill); border: 1px solid var(--rosin-search-line); }
    .rosin-search-heroart { display: block; width: 128px; height: 128px; border-radius: 12px; overflow: hidden; box-shadow: 0 12px 34px rgba(0, 0, 0, .5); }
    .rosin-search-heroart--round { border-radius: 50%; }
    .rosin-search-heroinfo { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .rosin-search-heroname { font-size: 30px; font-weight: 800; line-height: 1.05; color: var(--rosin-search-text); text-decoration: none; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rosin-search-heroname:hover { text-decoration: underline; }
    .rosin-search-herosub { font-size: 13px; color: var(--rosin-search-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-search-herobutton { margin-top: 8px; align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 24px; padding: 10px 20px; background: var(--rosin-search-accent); color: var(--rosin-search-on-accent); font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
    .rosin-search-herobutton:hover { filter: brightness(1.06); }
    .rosin-search-herobutton svg { width: 16px; height: 16px; }

    .rosin-search-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 8px; }
    .rosin-search-card { min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 12px; color: inherit; text-decoration: none; cursor: pointer; }
    .rosin-search-card:hover { background: var(--rosin-search-fill); }
    .rosin-search-card--round { align-items: center; text-align: center; }
    .rosin-search-cardart { position: relative; width: 100%; aspect-ratio: 1; margin-bottom: 6px; border-radius: 9px; overflow: hidden; background: var(--rosin-search-fill); box-shadow: 0 8px 22px -12px rgba(0, 0, 0, .7); }
    .rosin-search-card--round .rosin-search-cardart { border-radius: 50%; }
    .rosin-search-art { width: 100%; height: 100%; display: block; object-fit: cover; }
    .rosin-search-art--round { border-radius: 50%; }
    .rosin-search-art--placeholder { display: flex; align-items: center; justify-content: center; color: color-mix(in srgb, currentColor 28%, transparent); }
    .rosin-search-art--placeholder svg { width: 46%; height: 46%; }
    .rosin-search-cardbadge { position: absolute; top: 7px; left: 7px; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .6)); }
    .rosin-search-cardname { max-width: 100%; font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-search-cardsub { max-width: 100%; font-size: 12px; color: var(--rosin-search-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .rosin-search-play { position: absolute; border: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--rosin-search-accent); color: var(--rosin-search-on-accent); cursor: pointer; opacity: 0; transform: translateY(6px) scale(.85); transition: opacity .14s, transform .14s; box-shadow: 0 6px 18px rgba(0, 0, 0, .5); }
    .rosin-search-play svg { width: 20px; height: 20px; margin-left: 2px; }
    .rosin-search-cardart .rosin-search-play { right: 8px; bottom: 8px; width: 42px; height: 42px; }
    .rosin-search-thumb .rosin-search-play { inset: 0; margin: auto; width: 30px; height: 30px; }
    .rosin-search-thumb .rosin-search-play svg { width: 16px; height: 16px; }
    .rosin-search-card:hover .rosin-search-play, .rosin-search-row:hover .rosin-search-play { opacity: 1; transform: none; }
    .rosin-search-play:hover { filter: brightness(1.08); }

    .rosin-search-list { display: flex; flex-direction: column; gap: 1px; }
    .rosin-search-songs .rosin-search-list { padding: 6px; border-radius: 14px; background: var(--rosin-search-fill); border: 1px solid var(--rosin-search-line); }
    .rosin-search-columns { display: grid; grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); gap: 1px 24px; }
    .rosin-search-row { display: flex; align-items: center; gap: 14px; padding: 9px 12px; border-radius: 10px; color: inherit; text-decoration: none; cursor: pointer; }
    .rosin-search-row:hover { background: var(--rosin-search-fill); }
    .rosin-search-thumb { position: relative; flex: none; width: 48px; height: 48px; border-radius: 8px; overflow: hidden; background: var(--rosin-search-fill); }
    .rosin-search-thumb--round { border-radius: 50%; }
    .rosin-search-thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .rosin-search-thumb--placeholder { display: flex; align-items: center; justify-content: center; color: color-mix(in srgb, currentColor 30%, transparent); }
    .rosin-search-thumb--placeholder svg { width: 56%; height: 56%; }
    .rosin-search-row--heard .rosin-search-thumb { box-shadow: 0 0 0 2px var(--rosin-search-accent); }
    .rosin-search-meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .rosin-search-name { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rosin-search-sub { font-size: 12.5px; color: var(--rosin-search-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .rosin-search-badge, .rosin-search-heard { flex: none; padding: 1px 6px; border-radius: 5px; font-size: 9.5px; font-weight: 800; line-height: 1.6; }
    .rosin-search-badge i { font-style: normal; font-weight: 600; opacity: .85; }
    .rosin-search-badge--hires { background: var(--rosin-search-accent); color: var(--rosin-search-on-accent); }
    .rosin-search-badge--lossless { color: var(--rosin-search-accent); box-shadow: inset 0 0 0 1px var(--rosin-search-accent); }
    .rosin-search-badge--lossy { display: none; }
    .rosin-search-heard { color: var(--rosin-search-text-secondary); box-shadow: inset 0 0 0 1px var(--rosin-search-line); }
    .rosin-search-heard--recent { color: var(--rosin-search-accent); box-shadow: inset 0 0 0 1px var(--rosin-search-accent); }
  `;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);

  // ---------------------------------------------------------------------------
  // Start. This runs before Qobuz's bundle, so wait for its store. After
  // that, a MutationObserver re-hooks the search bar and puts the open page
  // back as soon as a re-render replaces them, before the next paint; a poll
  // keeps the page sized to the scroll area and backs the observer up.
  // ---------------------------------------------------------------------------
  const pathname = () => store()?.getState().router?.location?.pathname || '';
  let unsubscribe = null;
  // Stays open through Qobuz's own /search navigation, and closes on any other.
  const watchStore = (s) => {
    let previous = pathname();
    if (!previous.startsWith('/search')) lastPath = previous;
    unsubscribe = s.subscribe(() => {
      const path = pathname();
      if (path === previous) return;
      previous = path;
      if (path.startsWith('/search')) return;
      lastPath = path;
      hide();
    });
  };
  const restore = new MutationObserver(() => {
    hookInput();
    if (isOpen() && panel.parentElement !== $(S.layoutRoot)) placePanel();
  });
  const tick = setInterval(() => {
    if (!unsubscribe) {
      const s = store();
      if (!s) return;
      watchStore(s);
      loadFavourites();
      restore.observe(document.body, { childList: true, subtree: true });
    }
    hookInput();
    if (isOpen()) placePanel();
  }, 500);
  window.addEventListener('resize', placePanel);
  document.addEventListener('click', onClick, true);

  const remove = () => {
    restore.disconnect();
    clearInterval(tick);
    clearTimeout(debounceTimer);
    unsubscribe?.();
    window.removeEventListener('resize', placePanel);
    document.removeEventListener('click', onClick, true);
    unhookInput();
    panel?.remove();
    style.remove();
  };
  return { remove, close };
};
