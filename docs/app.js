/* Meal Planner - phone app. Shared rules live in core.js (window.MP). */
(function () {
  "use strict";
  const MP = window.MP;
  const PAGE_SIZE = 100;
  const SYNC_EVERY_MS = 60000;
  const CATALOG_MAX_AGE_DAYS = 7;
  const PASTELS = ["#F6C9A8", "#F4D58D", "#B8DDB1", "#A9D3E8", "#D5C1EC", "#F2B8C6", "#C9D7A6"];
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // ------------------------------------------------------------ state & storage

  const S = {
    data: null, snapshot: null,
    sync: {}, syncState: "off", syncDetail: "", syncing: false, syncAgain: false, syncTimer: null,
    catalog: [], byId: {}, catalogLoading: false, catalogProgress: 0, catalogWaiting: [],
    page: "week", viewingLast: false, favTab: "all", favQuery: "", exploreQuery: "",
    exploreLimit: PAGE_SIZE, exploreOrder: [], setupBanner: false,
  };

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { toast("Couldn't save on this phone: storage is full"); } },
  };

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("meal-planner", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", mode);
        const req = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const idbGet = (key) => idb("readonly", (s) => s.get(key)).catch(() => null);
  const idbSet = (key, value) => idb("readwrite", (s) => s.put(value, key)).catch(() => null);

  function save() {
    S.snapshot = MP.stamp(S.data, S.snapshot);
    store.set("mp.data", S.data);
    scheduleSync();
  }

  // ------------------------------------------------------------ helpers

  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isFavorite = (name) => S.data.favorites.some((f) => f.name.toLowerCase() === name.toLowerCase());
  const favByUid = (uid) => S.data.favorites.find((f) => f.uid === uid);

  let toastTimer = null;
  function toast(msg, sticky) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }
  const hideToast = () => $("#toast").classList.remove("show");

  function photo(meal, cls, big) {
    const name = (meal && meal.name) || "?";
    const letter = esc(name.trim().charAt(0).toUpperCase() || "?");
    const color = PASTELS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PASTELS.length];
    const ph = `<div class="ph ${cls || ""}" style="background:${color}">${letter}</div>`;
    const url = meal && MP.thumbUrl(meal.thumb, big);
    if (!url) return ph;
    return `<img class="photo ${cls || ""}" src="${esc(url)}" alt="" loading="lazy" data-ph="${esc(ph)}" onerror="this.outerHTML=this.dataset.ph">`;
  }

  // ------------------------------------------------------------ recipe catalog (all of TheMealDB, kept offline)

  async function loadCatalog() {
    const cached = await idbGet("catalog");
    if (cached && cached.meals && cached.meals.length) {
      setCatalog(cached.meals);
      const age = (Date.now() - cached.date) / 86400000;
      if (age > CATALOG_MAX_AGE_DAYS && navigator.onLine) ensureCatalog(null, true);
    }
  }

  function setCatalog(meals) {
    S.catalog = meals;
    S.byId = {};
    for (const m of meals) S.byId[m.id] = m;
    S.exploreOrder = MP.shuffled(meals.map((m) => m.id));
  }

  /** Make sure the recipe list is downloaded, then call `then`. */
  function ensureCatalog(then, quiet) {
    if (S.catalog.length && !quiet) return then && then();
    if (then) S.catalogWaiting.push(then);
    if (S.catalogLoading) return;
    S.catalogLoading = true;
    S.catalogProgress = 0;
    if (!quiet) { toast("Downloading recipes…", true); render(); }
    MP.fetchCatalog((done, total) => {
      S.catalogProgress = done / total;
      if (!quiet) {
        toast(`Downloading recipes… ${Math.round(100 * S.catalogProgress)}%`, true);
        const bar = $("#catalog-bar");
        if (bar) bar.style.width = Math.round(100 * S.catalogProgress) + "%";
      }
    }).then((meals) => {
      setCatalog(meals);
      idbSet("catalog", { date: Date.now(), meals });
      if (!quiet) toast(`${meals.length} recipes ready`);
      const waiting = S.catalogWaiting; S.catalogWaiting = [];
      S.catalogLoading = false;
      render();
      waiting.forEach((fn) => fn());
    }).catch(() => {
      S.catalogLoading = false;
      S.catalogWaiting = [];
      if (!quiet) toast("Couldn't reach TheMealDB — check your connection");
      render();
    });
  }

  function fullMeal(meal) {
    if (!meal) return meal;
    const fav = meal.uid && favByUid(meal.uid);
    return Object.assign({}, meal.id ? S.byId[meal.id] : null, fav || {}, meal);
  }

  // ------------------------------------------------------------ week logic

  const passesLeaveOut = (m) => !S.data.filters.leave_out.some((p) => MP.proteins(m).has(p));

  function lastWeek() { const h = S.data.history; return h.length ? h[h.length - 1] : null; }
  function lastWeekNames() {
    const lw = lastWeek();
    return new Set(lw ? lw.week.concat(lw.sides).filter(Boolean).map((m) => m.name.toLowerCase()) : []);
  }

  function mealPool() {
    const src = S.data.source, pool = [];
    if (src !== "explore") {
      for (const f of S.data.favorites) if (MP.mealTypes(f).has("dinner")) pool.push(Object.assign({}, f, { origin: "Favorite" }));
    }
    if (src !== "favorites") {
      const favNames = new Set(S.data.favorites.map((f) => f.name.toLowerCase()));
      for (const m of S.catalog) {
        if (MP.mealTypes(m).has("dinner") && passesLeaveOut(m) && !favNames.has(m.name.toLowerCase())) {
          pool.push(Object.assign({}, m, { origin: "Explore" }));
        }
      }
    }
    return pool;
  }
  const needsCatalog = () => S.data.source !== "favorites" && !S.catalog.length;

  function shuffleWeek(message) {
    S.viewingLast = false;
    if (needsCatalog()) return ensureCatalog(() => shuffleWeek(message));
    const pool = mealPool();
    if (!pool.length) {
      render();
      return toast("No dinners to pick from yet — add Favorites or choose Mix / Explore");
    }
    const d = S.data;
    const kept = new Set(d.week.filter((m, i) => m && d.kept[i]).map((m) => m.name));
    const openDays = [0, 1, 2, 3, 4, 5, 6].filter((i) => !(d.week[i] && d.kept[i]));
    const choices = pool.filter((m) => !kept.has(m.name));
    const { picks, reused } = MP.pickAvoiding(choices.length ? choices : pool, openDays.length, lastWeekNames());
    openDays.forEach((day, i) => { d.week[day] = picks[i]; });
    save();
    render();
    toast(reused ? `New menu! ${reused} repeated from last week (not enough meals to avoid it).`
      : message || `New menu from ${pool.length} meals — nothing from last week.`);
  }

  function swapDay(day) {
    if (needsCatalog()) return ensureCatalog(() => swapDay(day));
    const pool = mealPool();
    if (!pool.length) return toast("No dinners to pick from yet — add Favorites or choose Mix / Explore");
    const planned = new Set(S.data.week.filter(Boolean).map((m) => m.name));
    const choices = pool.filter((m) => !planned.has(m.name));
    S.data.week[day] = MP.pickAvoiding(choices.length ? choices : pool, 1, lastWeekNames()).picks[0];
    S.data.kept[day] = false;
    save();
    render();
  }

  function sidePool() {
    const favSides = S.data.favorites.filter((m) => MP.mealTypes(m).has("sides")).map((m) => Object.assign({}, m, { origin: "Favorite" }));
    if (S.data.source === "favorites" && favSides.length) return favSides;
    const names = new Set(favSides.map((m) => m.name.toLowerCase()));
    const others = S.catalog.filter((m) => MP.mealTypes(m).has("sides") && passesLeaveOut(m) && !names.has(m.name.toLowerCase()));
    return favSides.concat(others.map((m) => Object.assign({}, m, { origin: "Explore" })));
  }

  function randomSide(day) {
    const pool = sidePool();
    if (!S.catalog.length && !(S.data.source === "favorites" && pool.length)) return ensureCatalog(() => randomSide(day));
    if (!pool.length) return toast("No side dishes match your filters");
    const used = new Set(S.data.sides.filter(Boolean).map((s) => s.name));
    const choices = pool.filter((m) => !used.has(m.name));
    S.data.sides[day] = MP.pickAvoiding(choices.length ? choices : pool, 1, lastWeekNames()).picks[0];
    save();
    render();
  }

  function archiveCurrentWeek() {
    const d = S.data;
    if (d.week.some(Boolean)) {
      d.history.push({ start: d.week_start, week: d.week, sides: d.sides });
      d.history = d.history.slice(-12);
    }
    d.week = Array(7).fill(null); d.kept = Array(7).fill(false); d.sides = Array(7).fill(null);
  }

  function rollOverWeek() {
    const thisStart = MP.weekStartOf(new Date());
    if (MP.parseIso(S.data.week_start) >= thisStart) return;
    const hadPlan = S.data.week.some(Boolean);
    archiveCurrentWeek();
    S.data.week_start = MP.isoDate(thisStart);
    save();
    if (hadPlan) shuffleWeek("It's a new week — here's a fresh menu with nothing from last week.");
    else render();
  }

  function startNextWeek() {
    if (S.data.week.some(Boolean) && !confirm("Move this week's plan to “Last week” and make a fresh menu for next week?")) return;
    const start = MP.addDays(MP.parseIso(S.data.week_start), 7);
    archiveCurrentWeek();
    S.data.week_start = MP.isoDate(start);
    save();
    shuffleWeek(`Planning ${MP.dateRange(S.data.week_start)} — nothing from last week.`);
  }

  function addFavorite(meal) {
    if (isFavorite(meal.name)) return;
    const m = fullMeal(meal);
    const fav = {};
    for (const k of ["id", "name", "category", "area", "thumb", "ingredients", "instructions", "url", "youtube"]) if (m[k]) fav[k] = m[k];
    fav.notes = "";
    S.data.favorites.push(fav);
    S.data.week.forEach((w, i) => { if (w && w.name === meal.name) S.data.week[i] = Object.assign({}, w, { origin: "Favorite" }); });
    save();
    render();
    toast(`♥ Saved “${meal.name}”`);
  }

  // ------------------------------------------------------------ rendering

  function render() {
    S.pendingRender = false;
    for (const p of ["week", "explore", "favorites", "shopping"]) $("#tab-" + p).classList.toggle("on", S.page === p);
    const view = $("#view");
    if (S.page === "week") view.innerHTML = renderWeek();
    else if (S.page === "explore") { view.innerHTML = renderExploreShell(); renderExploreResults(); }
    else if (S.page === "shopping") view.innerHTML = renderShopping();
    else { view.innerHTML = renderFavShell(); renderFavResults(); }
    const toBuy = S.data.shopping.filter((it) => !it.checked).length;
    $("#list-badge").textContent = toBuy ? String(toBuy) : "";
    renderSyncChip();
  }

  function heartButton(meal, act, extra) {
    const saved = isFavorite(meal.name);
    return `<button class="btn small ${saved ? "done" : "soft"}" data-act="${act}" ${extra || ""} ${saved ? "disabled" : ""}>${saved ? "♥ Saved" : "♡ Save"}</button>`;
  }

  function renderWeek() {
    const d = S.data;
    const lw = lastWeek();
    let html = "";
    if (S.setupBanner) {
      html += `<div class="banner"><b>Sync is set up in this browser.</b> ` +
        (isIOS && !standalone ? `Now tap <b>Share → Add to Home Screen</b>. If the home-screen app then says “Sync off”, tap it, paste into <b>Setup code</b> (it's already copied) and tap <b>Connect</b>.`
          : `Add it to your home screen from the browser menu (⋮ → Install app).`) + `</div>`;
    } else if (!standalone && !S.sync.repo) {
      html += `<div class="banner">Tip: add this app to your home screen — ${isIOS ? "Share → Add to Home Screen" : "⋮ → Install app"}. Tap <b>Sync off</b> at the top to connect it to the desktop app.</div>`;
    }
    const ahead = (MP.parseIso(d.week_start) - MP.weekStartOf(new Date())) / 86400000;
    const label = S.viewingLast ? "Last week" : ahead <= 0 ? "This week" : ahead === 7 ? "Next week" : "Upcoming week";
    const range = S.viewingLast ? (lw ? MP.dateRange(lw.start) : "") : MP.dateRange(d.week_start);
    html += `<div class="page-head"><div><h1>${label}</h1><p class="sub">${esc(range)}</p></div>
      <div class="seg"><button data-act="view" data-last="1" class="${S.viewingLast ? "on" : ""}">◀ Last week</button><button data-act="view" data-last="0" class="${S.viewingLast ? "" : "on"}">This week</button></div></div>`;
    if (S.viewingLast) return html + renderLastWeek(lw);

    html += `<div class="toolbar">
      <button class="btn primary" data-act="shuffle">↻ Shuffle week</button>
      <button class="btn soft" data-act="share">➤ Send</button>
      <button class="btn soft" data-act="list-week">🛒 Shopping</button>
      <button class="btn" data-act="next-week">Next week →</button></div>
      <div class="row"><select data-act="source" aria-label="Pick meals from">${MP.SOURCES.map(([k, l]) =>
        `<option value="${k}" ${d.source === k ? "selected" : ""}>Pick from: ${l}</option>`).join("")}</select></div>
      <p class="hint">Nothing from last week is repeated. ↻ Swap changes one day; Keep holds a day when you shuffle.</p>`;
    if (S.catalogLoading && d.source !== "favorites") html += `<div class="progress"><div id="catalog-bar" style="width:${Math.round(100 * S.catalogProgress)}%"></div></div>`;
    const start = MP.parseIso(d.week_start), today = MP.isoDate(new Date());
    html += `<ol class="days">`;
    MP.DAYS.forEach((day, i) => {
      const meal = d.week[i], kept = d.kept[i], date = MP.addDays(start, i), isToday = MP.isoDate(date) === today;
      html += `<li class="day ${isToday ? "today" : ""} ${kept ? "kept" : ""}">
        <div class="day-head"><b>${day}</b><span>${isToday ? "today" : MP.shortDate(date)}</span></div>`;
      if (meal) {
        html += `<div class="day-main"><div class="clickable" data-act="open-day" data-day="${i}">${photo(meal)}</div>
          <div><div class="meal-name clickable" data-act="open-day" data-day="${i}">${esc(meal.name)}</div>
          <div class="muted small">${meal.origin === "Favorite" ? "♥ Favorite" : "✨ New idea"}</div></div></div>
          <div class="day-actions"><button class="btn small primary" data-act="swap" data-day="${i}">↻ Swap</button>
          <button class="btn small" data-act="choose" data-day="${i}">☰ Choose</button>
          ${heartButton(meal, "save-day", `data-day="${i}"`)}
          <label class="check"><input type="checkbox" data-act="keep" data-day="${i}" ${kept ? "checked" : ""}> Keep</label></div>
          ${renderSide(i)}`;
      } else {
        html += `<div class="day-main">${photo({ name: "?" })}<div class="muted">Nothing planned yet</div></div>
          <div class="day-actions"><button class="btn small primary" data-act="swap" data-day="${i}">↻ Pick random</button>
          <button class="btn small" data-act="choose" data-day="${i}">☰ Choose a favorite</button></div>`;
      }
      html += `</li>`;
    });
    return html + `</ol>`;
  }

  function renderSide(i) {
    const side = S.data.sides[i];
    if (!side) {
      return `<div class="side"><div class="side-actions" style="margin:0">
        <button class="btn small soft" data-act="side-random" data-day="${i}">+ Random side</button>
        <button class="btn small" data-act="side-pick" data-day="${i}">☰ Pick a side</button></div></div>`;
    }
    return `<div class="side"><div class="side-top clickable" data-act="open-side" data-day="${i}">${photo(side)}
      <div><div class="side-label">SIDE</div><div>${esc(side.name)}</div></div></div>
      <div class="side-actions"><button class="btn small soft" data-act="side-random" data-day="${i}">↻ Random</button>
      <button class="btn small" data-act="side-pick" data-day="${i}">☰ Pick</button>
      <button class="link" data-act="side-remove" data-day="${i}">✕ Remove side</button></div></div>`;
  }

  function renderLastWeek(lw) {
    if (!lw) return `<p class="empty">No previous week yet.\nWhen a new week starts (or you tap “Next week”), this week's plan moves here.</p>`;
    const start = MP.parseIso(lw.start);
    let html = `<div class="toolbar"><button class="btn soft" data-act="share">➤ Send</button></div><ol class="days">`;
    MP.DAYS.forEach((day, i) => {
      const meal = lw.week[i], side = lw.sides[i];
      html += `<li class="day"><div class="day-head"><b>${day}</b><span>${MP.shortDate(MP.addDays(start, i))}</span></div>
        <div class="day-main">${meal ? `<div class="clickable" data-act="open-last" data-day="${i}">${photo(meal)}</div>` : photo({ name: "-" })}
        <div><div class="meal-name">${meal ? esc(meal.name) : '<span class="muted">Nothing planned</span>'}</div>
        ${side ? `<div class="muted small">+ ${esc(side.name)}</div>` : ""}</div></div></li>`;
    });
    return html + `</ol>`;
  }

  // ---- explore

  function cuisineOptions() {
    const counts = {};
    for (const m of S.catalog) counts[m.area] = (counts[m.area] || 0) + 1;
    const opts = [[MP.ALL_CUISINES, MP.ALL_CUISINES]];
    for (const [region, members] of Object.entries(MP.REGIONS)) {
      const n = members.reduce((a, c) => a + (counts[c] || 0), 0);
      if (n) opts.push([`${region} — all (${n})`, "region:" + region]);
    }
    for (const area of Object.keys(counts).filter(Boolean).sort()) opts.push([`${area} (${counts[area]})`, area]);
    return opts;
  }

  function renderExploreShell() {
    const f = S.data.filters;
    if (!S.catalog.length) {
      if (!S.catalogLoading) setTimeout(() => ensureCatalog(), 0);
      return `<div class="page-head"><div><h1>Explore</h1><p class="sub">Every recipe on TheMealDB</p></div></div>
        <p class="empty">Downloading the recipe list…\nThis only happens the first time (about 40 seconds).</p>
        <div class="progress"><div id="catalog-bar" style="width:${Math.round(100 * S.catalogProgress)}%"></div></div>`;
    }
    return `<div class="page-head"><div><h1>Explore</h1><p class="sub">Every recipe on TheMealDB. Tap a photo for the recipe.</p></div>
      <button class="btn small soft" data-act="explore-shuffle">↻ Shuffle</button></div>
      <input type="search" id="explore-search" placeholder="Search dishes or ingredients, e.g. chicken" value="${esc(S.exploreQuery)}" autocomplete="off">
      <div class="chips" style="margin-top:10px">${MP.MEAL_TYPES.map(([k, l]) =>
        `<button class="chip ${f.type === k ? "on" : ""}" data-act="type" data-key="${k}">${l}</button>`).join("")}</div>
      <select data-act="cuisine" aria-label="Cuisine">${cuisineOptions().map(([l, k]) =>
        `<option value="${esc(k)}" ${f.cuisine === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <div class="chips" style="margin-top:10px"><span class="chip-label">Leave out:</span>${MP.PROTEINS.map(([k, l]) =>
        `<button class="chip ${f.leave_out.includes(k) ? "off" : ""}" data-act="leave-out" data-key="${k}">${l}</button>`).join("")}</div>
      <div id="explore-results"></div>`;
  }

  function exploreVisible() {
    const f = S.data.filters;
    let areas = null;
    if (f.cuisine.startsWith("region:")) areas = new Set(MP.REGIONS[f.cuisine.slice(7)] || []);
    else if (f.cuisine !== MP.ALL_CUISINES) areas = new Set([f.cuisine]);
    const words = S.exploreQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const id of S.exploreOrder) {
      const m = S.byId[id];
      if (!m) continue;
      if (areas && !areas.has(m.area)) continue;
      if (f.type !== "all" && !MP.mealTypes(m).has(f.type)) continue;
      if (words.length) {
        const text = [m.name, m.category, m.area].concat(m.ingredients).join(" ").toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
      }
      if (passesLeaveOut(m)) out.push(m);
    }
    return out;
  }

  function renderExploreResults() {
    const box = $("#explore-results");
    if (!box) return;
    const visible = exploreVisible(), shown = visible.slice(0, S.exploreLimit);
    let html = `<p class="count">Showing ${shown.length} of ${visible.length} recipes${visible.length !== S.catalog.length ? ` (${S.catalog.length} total)` : ""}</p>`;
    if (!visible.length) return (box.innerHTML = html + `<p class="empty">No recipes match these filters.\nTry another cuisine or meal type, or turn off a Leave out option.</p>`);
    html += `<div class="grid">` + shown.map((m) => `<div class="card">
      <div class="clickable" data-act="open-meal" data-id="${esc(m.id)}">${photo(m)}</div>
      <div class="card-body"><div class="card-name clickable" data-act="open-meal" data-id="${esc(m.id)}">${esc(m.name)}</div>
      <div class="card-sub">${esc([m.category, m.area].filter(Boolean).join(" · "))}</div>
      <div class="card-actions">${heartButton(m, "save-meal", `data-id="${esc(m.id)}"`)}</div></div></div>`).join("") + `</div>`;
    if (visible.length > shown.length) {
      html += `<div class="more"><button class="btn primary" data-act="explore-more">Show ${Math.min(PAGE_SIZE, visible.length - shown.length)} more</button>
        <span class="muted small">${visible.length - shown.length} more recipes</span></div>`;
    }
    box.innerHTML = html;
  }

  // ---- favorites

  function renderFavShell() {
    const favs = S.data.favorites;
    const count = (k) => favs.filter((m) => k === "all" || MP.mealTypes(m).has(k)).length;
    return `<div class="page-head"><div><h1>Favorites${favs.length ? ` (${favs.length})` : ""}</h1>
      <p class="sub">Tap the category tags to sort a meal — it can be in more than one.</p></div></div>
      <div class="chips">${MP.FAV_TABS.map(([k, l]) => `<button class="chip ${S.favTab === k ? "on" : ""}" data-act="fav-tab" data-key="${k}">${l} ${count(k)}</button>`).join("")}</div>
      <input type="search" id="fav-search" placeholder="Filter favorites…" value="${esc(S.favQuery)}" autocomplete="off">
      <div id="fav-results" style="margin-top:12px"></div>
      <button class="fab" data-act="add-fav" aria-label="Add a meal">+</button>`;
  }

  function renderFavResults() {
    const box = $("#fav-results");
    if (!box) return;
    const q = S.favQuery.toLowerCase().trim();
    const favs = S.data.favorites.slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .filter((m) => S.favTab === "all" || MP.mealTypes(m).has(S.favTab))
      .filter((m) => !q || [m.name, m.category, m.notes].join(" ").toLowerCase().includes(q));
    if (!favs.length) {
      const tab = MP.FAV_TABS.find(([k]) => k === S.favTab)[1].toLowerCase();
      box.innerHTML = `<p class="empty">${q ? "No matches." : S.favTab !== "all" && S.data.favorites.length
        ? `No ${tab} favorites yet.\nTap + to add one, or tap a meal's ${tab} tag in the All tab.`
        : "No favorites yet.\nTap + to add a meal, or ♡ Save anything in Explore."}</p>`;
      return;
    }
    box.innerHTML = `<div class="grid">` + favs.map((m) => {
      const types = MP.mealTypes(m);
      return `<div class="card"><div class="clickable" data-act="open-fav" data-uid="${m.uid}">${photo(m)}</div>
        <div class="card-body"><div class="card-name clickable" data-act="open-fav" data-uid="${m.uid}">${esc(m.name)}</div>
        ${m.notes ? `<div class="card-sub"><i>${esc(m.notes)}</i></div>` : ""}
        <div class="tags">${MP.TYPE_TAGS.map(([k, l]) => `<button class="tag ${types.has(k) ? "on" : ""}" data-act="fav-type" data-uid="${m.uid}" data-key="${k}">${l}</button>`).join("")}</div>
        <div class="card-actions"><button class="btn small" data-act="edit-fav" data-uid="${m.uid}">Edit</button></div></div></div>`;
    }).join("") + `</div>`;
  }

  // ---- shopping list

  function renderShopping() {
    const list = S.data.shopping;
    const toBuy = list.filter((it) => !it.checked), done = list.filter((it) => it.checked);
    let html = `<div class="page-head"><div><h1>Shopping list</h1><p class="sub">${toBuy.length} to buy${done.length ? ` \u00b7 ${done.length} in cart` : ""}</p></div>
      <button class="btn small soft" data-act="list-week">\ud83d\uded2 Add this week</button></div>
      <form class="add-item" id="add-item"><input type="text" name="item" placeholder="Add an item, e.g. 2 lemons" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" type="submit">Add</button></form>`;
    if (!list.length) {
      return html + `<p class="empty">Your list is empty.\nTap \u201cAdd this week\u201d to add ingredients for your planned meals,\nor open any recipe and add its ingredients.</p>`;
    }
    const row = (it) => `<li class="item ${it.checked ? "done" : ""}">
      <button class="tick" data-act="tick" data-uid="${it.uid}" aria-label="${it.checked ? "Uncheck" : "Check off"} ${esc(it.name)}">${it.checked ? "\u2713" : ""}</button>
      <div class="item-text" data-act="tick" data-uid="${it.uid}"><div class="item-name">${esc(it.name)}${it.qty ? ` <span class="item-qty">\u2014 ${esc(it.qty)}</span>` : ""}</div>
      ${it.meals && it.meals.length ? `<div class="item-for">for ${esc(it.meals.join(", "))}</div>` : ""}</div>
      <button class="x" data-act="remove-item" data-uid="${it.uid}" aria-label="Remove ${esc(it.name)}">\u2715</button></li>`;
    for (const aisle of MP.AISLES) {
      const items = toBuy.filter((it) => (it.aisle || "Other") === aisle).sort((a, b) => a.name.localeCompare(b.name));
      if (items.length) html += `<div class="aisle">${esc(aisle)}</div><ul class="items">${items.map(row).join("")}</ul>`;
    }
    if (done.length) {
      html += `<div class="aisle row" style="justify-content:space-between"><span>In cart</span>
        <button class="btn small" data-act="clear-checked">Clear ${done.length} checked</button></div>
        <ul class="items">${done.map(row).join("")}</ul>`;
    }
    return html;
  }

  /** A checklist of ingredients; each checkbox carries its name, amount and meal. */
  function ingredientChecklist(meal) {
    const parts = MP.mealParts(fullMeal(meal), S.byId);
    if (!parts.length) return `<p class="muted small">No ingredients saved for this meal.</p>`;
    return `<ul class="ing-list">${parts.map((p) => {
      const skip = ["water", "cold water", "hot water", "boiling water", "warm water", "ice"].includes(p.n.trim().toLowerCase());
      return `<li><label><input type="checkbox" class="ing" data-name="${esc(p.n)}" data-qty="${esc(p.q)}" data-meal="${esc(meal.name)}" ${skip ? "" : "checked"}>
        <span>${esc(p.n)}${p.q ? ` <span class="muted">\u2014 ${esc(p.q)}</span>` : ""}</span></label></li>`;
    }).join("")}</ul>`;
  }

  function addCheckedIngredients(container) {
    const adds = [...container.querySelectorAll("input.ing:checked")].map((c) =>
      ({ name: c.dataset.name, qty: c.dataset.qty, meal: c.dataset.meal }));
    if (!adds.length) return toast("Tick the ingredients you need");
    const { added, combined } = MP.addToList(S.data.shopping, adds);
    save();
    closeSheet();
    render();
    toast(`Added ${added} item${added === 1 ? "" : "s"} to your list` + (combined ? `, ${combined} combined with items already on it` : ""));
  }

  function updateAddButton(sheet) {
    const n = sheet.querySelectorAll("input.ing:checked").length;
    const btn = $("[data-act=add-ingredients]", sheet);
    if (btn) btn.textContent = n ? `Add ${n} to shopping list` : "Add to shopping list";
  }

  function weekIngredientsSheet() {
    const d = S.data;
    const meals = [];
    MP.DAYS.forEach((day, i) => {
      if (d.week[i]) meals.push([day, d.week[i]]);
      if (d.sides[i]) meals.push([day + " side", d.sides[i]]);
    });
    if (!meals.length) return toast("Plan some meals first");
    const go = () => openSheet(sheetHead("Add this week to your list") +
      `<p class="sub">Untick anything you already have.</p>` +
      meals.map(([label, m]) => `<div class="meal-group">${esc(label)}: ${esc(m.name)}</div>${ingredientChecklist(m)}`).join("") +
      `<div class="sticky-actions"><button class="btn primary block" data-act="add-ingredients">Add to shopping list</button></div>`,
      (sheet) => { updateAddButton(sheet); sheet.addEventListener("change", () => updateAddButton(sheet)); });
    // Explore meals need the recipe list for their ingredients.
    if (meals.some(([, m]) => m.id) && !S.catalog.length) ensureCatalog(go); else go();
  }

  // ------------------------------------------------------------ bottom sheets

  function openSheet(html, onMount) {
    const root = $("#sheet-root");
    root.innerHTML = `<div class="sheet-backdrop" data-act="close-sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div></div>`;
    document.body.style.overflow = "hidden";
    if (onMount) onMount($(".sheet", root));
  }
  function closeSheet() {
    $("#sheet-root").innerHTML = "";
    document.body.style.overflow = "";
    if (S.pendingRender) render();
  }

  /** Redraw after synced changes arrive, but not while someone is typing in a search box on the page. */
  function renderWhenIdle() {
    const typing = document.activeElement && document.activeElement.matches("#view input, #view textarea");
    if (typing) { S.pendingRender = true; return; }
    render();
  }
  const sheetHead = (title) => `<div class="sheet-head"><h2>${title}</h2><button class="close" data-act="close-sheet" aria-label="Close">✕</button></div>`;

  function showDetails(meal) {
    const m = fullMeal(meal);
    const sub = [m.category, m.area].filter(Boolean).join(" · ");
    let html = (m.thumb ? `<img class="hero" src="${esc(MP.thumbUrl(m.thumb, true))}" alt="">` : "") + sheetHead(esc(m.name)) +
      (sub ? `<p class="sub">${esc(sub)}</p>` : "") +
      `<div class="actions">${heartButton(m, "save-detail")}` +
      (m.url ? `<a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">Full recipe ↗</a>` : "") +
      (m.youtube ? `<a class="btn" href="${esc(m.youtube)}" target="_blank" rel="noopener">▶ Video</a>` : "") + `</div>`;
    if (MP.mealParts(m, S.byId).length) {
      html += `<h3>Ingredients</h3>${ingredientChecklist(m)}
        <button class="btn soft block" data-act="add-ingredients" style="margin-top:10px">Add to shopping list</button>`;
    }
    if (m.instructions) html += `<h3>Instructions</h3><div class="instructions">${esc(m.instructions.replace(/\r\n/g, "\n"))}</div>`;
    if (m.notes) html += `<h3>My notes</h3><div class="instructions">${esc(m.notes)}</div>`;
    if (!MP.mealParts(m, S.byId).length && !m.instructions && !m.notes) html += `<p class="muted">No recipe details saved for this meal. Add a recipe link or notes from Favorites.</p>`;
    S.detailMeal = m;
    openSheet(html, (sheet) => { updateAddButton(sheet); sheet.addEventListener("change", () => updateAddButton(sheet)); });
  }

  function pickerSheet(day, side) {
    if (!S.data.favorites.length) return toast("Add some Favorites first");
    const favs = S.data.favorites.filter((m) => !side || MP.mealTypes(m).has("sides"))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    if (!favs.length) return toast("None of your favorites are tagged Side yet — tap a meal's Side tag on Favorites");
    const what = side ? "side" : "meal";
    const slot = side ? S.data.sides : S.data.week;
    const current = (slot[day] && slot[day].name.toLowerCase()) || "";
    const lw = lastWeekNames();
    const cards = favs.map((m) => `<div class="card pick ${m.name.toLowerCase() === current ? "on" : ""} clickable" data-act="pick" data-uid="${m.uid}" data-day="${day}" data-side="${side ? 1 : 0}" data-name="${esc(m.name.toLowerCase())}">
      ${photo(m)}<div class="card-body"><div class="card-name">${esc(m.name)}${m.name.toLowerCase() === current ? " ✓" : ""}</div>
      ${lw.has(m.name.toLowerCase()) ? `<div class="card-sub"><i>Had it last week</i></div>` : ""}</div></div>`).join("");
    openSheet(sheetHead(`Choose a ${what} for ${MP.DAYS[day]}`) +
      `<p class="sub">${side ? "Only favorites tagged Side are shown." : "It will be marked Keep so shuffling won't replace it."}</p>
      <input type="search" id="picker-search" placeholder="Filter favorites…" style="margin:10px 0">
      <div class="grid" id="picker-grid">${cards}</div>`, (sheet) => {
      $("#picker-search", sheet).addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        sheet.querySelectorAll(".card.pick").forEach((c) => { c.style.display = c.dataset.name.includes(q) ? "" : "none"; });
      });
    });
  }

  function editorSheet(uid) {
    const existing = uid ? favByUid(uid) : null;
    const start = existing ? MP.mealTypes(existing) : new Set([S.favTab !== "all" ? S.favTab : "dinner"]);
    openSheet(sheetHead(existing ? "Edit meal" : "Add a meal") + `<form class="form" id="fav-form">
      <label class="field">Meal name<input type="text" name="name" required value="${esc(existing ? existing.name : "")}"></label>
      <div class="field"><b>Categories</b> <span class="note">tick all that apply</span>
        <div class="checks">${MP.TYPE_TAGS.map(([k, l]) => `<label class="check"><input type="checkbox" name="type" value="${k}" ${start.has(k) ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
      <label class="field">Recipe link <span class="note">optional</span><input type="url" name="url" value="${esc(existing ? existing.url || "" : "")}" placeholder="https://"></label>
      <label class="field">Photo link <span class="note">optional — paste an image address</span><input type="url" name="thumb" value="${esc(existing ? existing.thumb || "" : "")}" placeholder="https://"></label>
      <label class="field">Notes<textarea name="notes" rows="3">${esc(existing ? existing.notes || "" : "")}</textarea></label>
      <div class="actions">${existing ? `<button type="button" class="btn" data-act="delete-fav" data-uid="${existing.uid}">Remove</button>` : ""}
        <button type="submit" class="btn primary">Save meal</button></div></form>`, (sheet) => {
      $("#fav-form", sheet).addEventListener("submit", (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const name = form.get("name").trim();
        if (!name) return;
        if (S.data.favorites.some((f) => f.name.toLowerCase() === name.toLowerCase() && (!existing || f.uid !== existing.uid))) {
          return toast(`“${name}” is already in Favorites`);
        }
        const types = form.getAll("type");
        if (!types.length) return toast("Tick at least one category");
        const meal = Object.assign({}, existing || {}, { name, types, url: form.get("url").trim(),
          thumb: form.get("thumb").trim(), notes: form.get("notes").trim() });
        const i = existing ? S.data.favorites.findIndex((f) => f.uid === existing.uid) : -1;
        if (i >= 0) S.data.favorites[i] = meal; else S.data.favorites.push(meal);
        save();
        closeSheet();
        render();
        toast(`♥ Saved “${name}”`);
      });
    });
  }

  function shareSheet() {
    const src = S.viewingLast && lastWeek() ? lastWeek() : S.data;
    const start = S.viewingLast && lastWeek() ? lastWeek().start : S.data.week_start;
    openSheet(sheetHead("Send the menu") + `<p class="sub">You can edit the message first.</p>
      <textarea id="share-text" rows="9" style="margin-top:10px">${esc(MP.weekText(src, start))}</textarea>
      <div class="actions">${navigator.share ? `<button class="btn primary" data-act="share-native">Share… (Messenger, etc.)</button>` : ""}
        <button class="btn primary" data-act="share-sms">Text message</button></div>
      <div class="actions" style="margin-top:8px"><button class="btn" data-act="share-email">Email</button>
        <button class="btn" data-act="share-copy">Copy</button></div>`);
  }

  function settingsSheet() {
    const cfg = S.sync;
    const status = S.syncState === "ok" ? `Connected to ${esc(cfg.repo)} — last synced ${cfg.lastSync ? new Date(cfg.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"}`
      : S.syncState === "error" ? esc(S.syncDetail) : S.syncState === "syncing" ? "Syncing…" : "Not connected.";
    openSheet(sheetHead("Sync with the desktop app") + `
      <p class="sub">Your favorites, weekly plans and filters sync through a private GitHub repo that only you can see.</p>
      <p class="status ${S.syncState}" id="sync-status">${status}</p>
      ${cfg.repo ? `<div class="actions"><button class="btn primary" data-act="sync-now">Sync now</button>
        <button class="btn" data-act="copy-setup">Copy setup code</button><button class="btn" data-act="sync-off">Turn off</button></div>` : ""}
      <h3>Connect</h3>
      <ol class="steps"><li>In the desktop app, click <b>Sync</b> at the top and follow the steps.</li>
        <li>Scan the QR code it shows with your phone's camera — or copy the setup code and paste it here.</li></ol>
      <form class="form" id="setup-form"><label class="field">Setup code<input type="text" name="code" placeholder="Paste setup code" autocomplete="off"></label>
        <button class="btn primary" type="submit">Connect</button></form>
      <details style="margin-top:14px"><summary class="muted">Enter repo and token instead</summary>
        <form class="form" id="manual-form"><label class="field">Repo<input type="text" name="repo" placeholder="yourname/meal-planner-data" value="${esc(cfg.repo || "")}"></label>
          <label class="field">Token<input type="password" name="token" autocomplete="off"></label>
          <button class="btn" type="submit">Connect</button></form></details>
      <h3>Recipes</h3><p class="sub">${S.catalog.length} recipes saved on this phone for offline use.</p>
      <div class="actions"><button class="btn" data-act="refresh-catalog">Refresh recipe list</button></div>`, (sheet) => {
      $("#setup-form", sheet).addEventListener("submit", (e) => {
        e.preventDefault();
        try { connect(MP.decodeSetup(new FormData(e.target).get("code"))); }
        catch (err) { setStatus("That setup code doesn't look right. Copy it again from the desktop app.", "error"); }
      });
      $("#manual-form", sheet).addEventListener("submit", (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const repo = f.get("repo").trim(), token = f.get("token").trim() || S.sync.token || "";
        if (!repo.includes("/") || !token) return setStatus("Enter the repo (yourname/meal-planner-data) and token.", "error");
        connect({ repo, token });
      });
    });
  }

  function setStatus(text, cls) {
    const el = $("#sync-status");
    if (el) { el.textContent = text; el.className = "status " + (cls || ""); }
  }

  // ------------------------------------------------------------ sync

  const syncReady = () => !!(S.sync.repo && S.sync.token);

  function renderSyncChip() {
    const chip = $("#sync-chip");
    const labels = { off: "⇅ Sync off", syncing: "⇅ Syncing…", ok: "✓ Synced", error: "⚠ Sync problem" };
    chip.textContent = labels[S.syncState];
    chip.className = "sync-chip " + S.syncState;
  }

  function setSyncState(state, detail) {
    S.syncState = state;
    S.syncDetail = detail || "";
    renderSyncChip();
    if ($("#sync-status")) settingsSheetRefresh();
  }
  function settingsSheetRefresh() {
    const cls = S.syncState;
    const text = cls === "ok" ? `Connected to ${S.sync.repo} — last synced ${new Date(S.sync.lastSync || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : cls === "error" ? S.syncDetail : cls === "syncing" ? "Syncing…" : "Not connected.";
    setStatus(text, cls);
  }

  function scheduleSync(delay) {
    if (!syncReady()) return;
    clearTimeout(S.syncTimer);
    S.syncTimer = setTimeout(syncNow, delay ?? 2000);
  }

  async function syncNow() {
    if (!syncReady()) return;
    if (S.syncing) { S.syncAgain = true; return; }
    S.syncing = true;
    setSyncState("syncing");
    const gh = new MP.GitHubStore(S.sync.repo, S.sync.token, S.sync.api);  // api: only set by tests
    try {
      const { data: remote, sha } = await gh.pull();
      const merged = MP.mergeData(S.data, remote);
      if (MP.canonical(merged) !== MP.canonical(S.data)) {
        S.data = MP.normalizeData(merged);
        S.snapshot = MP.clone(S.data);
        store.set("mp.data", S.data);
        renderWhenIdle();
      }
      if (!(remote && MP.canonical(merged) === MP.canonical(remote))) {
        try { await gh.push(merged, sha); }
        catch (e) { if (e.conflict) S.syncAgain = true; else throw e; }
      }
      S.sync.lastSync = Date.now();
      store.set("mp.sync", S.sync);
      setSyncState("ok");
    } catch (e) {
      setSyncState("error", e.message || "Sync failed");
    } finally {
      S.syncing = false;
      if (S.syncAgain) { S.syncAgain = false; scheduleSync(500); }
    }
  }

  async function connect(cfg) {
    setStatus("Checking…");
    try {
      await new MP.GitHubStore(cfg.repo, cfg.token, S.sync.api).check();
    } catch (e) {
      return setStatus(e.message, "error");
    }
    S.sync = { repo: cfg.repo, token: cfg.token, api: S.sync.api };
    store.set("mp.sync", S.sync);
    await syncNow();
    if (S.syncState === "ok") toast("Connected — your meals are synced");
  }

  function readSetupFromUrl() {
    const m = location.hash.match(/#setup=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const cfg = MP.decodeSetup(m[1]);
      S.sync = { repo: cfg.repo, token: cfg.token };
      store.set("mp.sync", S.sync);
      S.setupBanner = true;
      if (navigator.clipboard) navigator.clipboard.writeText(m[1]).catch(() => {});
    } catch (e) {
      toast("That setup link didn't work — try scanning it again");
    }
  }

  // ------------------------------------------------------------ events

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, day = el.dataset.day !== undefined ? Number(el.dataset.day) : null;
    const d = S.data;
    switch (act) {
      case "page": S.page = el.dataset.page; closeSheet(); render(); window.scrollTo(0, 0); break;
      case "settings": settingsSheet(); break;
      case "close-sheet": closeSheet(); break;
      case "close-sheet-bg": if (e.target === el) closeSheet(); break;
      case "view": S.viewingLast = el.dataset.last === "1"; render(); break;
      case "shuffle": shuffleWeek(); break;
      case "next-week": startNextWeek(); break;
      case "swap": swapDay(day); break;
      case "choose": pickerSheet(day, false); break;
      case "save-day": addFavorite(d.week[day]); break;
      case "open-day": showDetails(d.week[day]); break;
      case "open-side": showDetails(d.sides[day]); break;
      case "open-last": showDetails(lastWeek().week[day]); break;
      case "side-random": randomSide(day); break;
      case "side-pick": pickerSheet(day, true); break;
      case "side-remove": d.sides[day] = null; save(); render(); break;
      case "pick": {
        const fav = favByUid(el.dataset.uid), side = el.dataset.side === "1";
        (side ? d.sides : d.week)[day] = Object.assign({}, fav, { origin: "Favorite" });
        if (!side) d.kept[day] = true;
        save(); closeSheet(); render();
        toast(`${MP.DAYS[day]} ${side ? "side" : "meal"}: ${fav.name}`);
        break;
      }
      case "share": shareSheet(); break;
      case "share-native": navigator.share({ title: "Dinner menu", text: $("#share-text").value }).catch(() => {}); break;
      case "share-sms": location.href = (isIOS ? "sms:&body=" : "sms:?body=") + encodeURIComponent($("#share-text").value); break;
      case "share-email": {
        const text = $("#share-text").value;
        location.href = "mailto:?subject=" + encodeURIComponent(text.split("\n")[0]) + "&body=" + encodeURIComponent(text);
        break;
      }
      case "share-copy": navigator.clipboard.writeText($("#share-text").value).then(() => toast("Menu copied")); break;
      case "explore-shuffle": S.exploreOrder = MP.shuffled(S.catalog.map((m) => m.id)); S.exploreLimit = PAGE_SIZE; renderExploreResults(); break;
      case "explore-more": S.exploreLimit += PAGE_SIZE; renderExploreResults(); break;
      case "type": d.filters.type = el.dataset.key; filtersChanged(); break;
      case "leave-out": {
        const lo = d.filters.leave_out, k = el.dataset.key;
        d.filters.leave_out = lo.includes(k) ? lo.filter((x) => x !== k) : lo.concat(k);
        filtersChanged();
        break;
      }
      case "open-meal": showDetails(S.byId[el.dataset.id]); break;
      case "save-meal": addFavorite(S.byId[el.dataset.id]); break;
      case "save-detail": addFavorite(S.detailMeal); closeSheet(); break;
      case "fav-tab": S.favTab = el.dataset.key; render(); break;
      case "fav-type": {
        const fav = favByUid(el.dataset.uid);
        const types = MP.mealTypes(fav), k = el.dataset.key;
        if (types.has(k)) types.delete(k); else types.add(k);
        if (!types.size) return toast("A meal needs at least one category");
        fav.types = MP.TYPE_TAGS.map(([t]) => t).filter((t) => types.has(t)).concat(types.has("dessert") ? ["dessert"] : []);
        save(); render();
        break;
      }
      case "open-fav": showDetails(favByUid(el.dataset.uid)); break;
      case "edit-fav": editorSheet(el.dataset.uid); break;
      case "add-fav": editorSheet(null); break;
      case "delete-fav": {
        const fav = favByUid(el.dataset.uid);
        if (fav && confirm(`Remove “${fav.name}” from Favorites?`)) {
          d.favorites = d.favorites.filter((f) => f.uid !== fav.uid);
          save(); closeSheet(); render();
        }
        break;
      }
      case "list-week": weekIngredientsSheet(); break;
      case "add-ingredients": addCheckedIngredients(el.closest(".sheet")); break;
      case "tick": {
        const it = d.shopping.find((x) => x.uid === el.dataset.uid);
        if (it) { it.checked = !it.checked; save(); render(); }
        break;
      }
      case "remove-item": d.shopping = d.shopping.filter((x) => x.uid !== el.dataset.uid); save(); render(); break;
      case "clear-checked": d.shopping = d.shopping.filter((x) => !x.checked); save(); render(); break;
      case "sync-now": syncNow(); break;
      case "copy-setup": navigator.clipboard.writeText(MP.encodeSetup(S.sync)).then(() => toast("Setup code copied — keep it private")); break;
      case "sync-off":
        if (confirm("Stop syncing on this phone? Your meals stay on this phone and in GitHub.")) {
          S.sync = {}; store.set("mp.sync", {}); setSyncState("off"); closeSheet();
        }
        break;
      case "refresh-catalog": closeSheet(); S.catalog = []; ensureCatalog(); break;
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.act === "source") { S.data.source = el.value; save(); }
    else if (el.dataset.act === "cuisine") { S.data.filters.cuisine = el.value; filtersChanged(); }
    else if (el.dataset.act === "keep") { S.data.kept[Number(el.dataset.day)] = el.checked; save(); render(); }
  });

  let searchTimer = null;
  document.addEventListener("input", (e) => {
    if (e.target.id === "explore-search") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { S.exploreQuery = e.target.value; S.exploreLimit = PAGE_SIZE; renderExploreResults(); }, 200);
    } else if (e.target.id === "fav-search") {
      S.favQuery = e.target.value;
      renderFavResults();
    }
  });

  function filtersChanged() {
    S.exploreLimit = PAGE_SIZE;
    save();
    render();
  }

  document.addEventListener("submit", (e) => {
    if (e.target.id !== "add-item") return;
    e.preventDefault();
    const input = e.target.elements.item;
    const { name, qty } = MP.parseQuickItem(input.value);
    if (!name) return;
    MP.addToList(S.data.shopping, [{ name, qty }]);
    save();
    render();
    const again = $("#add-item input");
    if (again) again.focus();
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { syncNow(); if (S.data) rollOverWeek(); } });
  setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, SYNC_EVERY_MS);

  // ------------------------------------------------------------ start

  async function start() {
    S.data = MP.normalizeData(store.get("mp.data", null));
    S.snapshot = MP.clone(S.data);
    S.snapshot = MP.stamp(S.data, S.snapshot);
    store.set("mp.data", S.data);
    S.sync = store.get("mp.sync", {});
    readSetupFromUrl();
    render();
    await loadCatalog();
    render();
    if (syncReady()) await syncNow();
    rollOverWeek();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  start();
})();
