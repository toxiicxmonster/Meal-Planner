/* Meal Planner - phone app. Shared rules live in core.js (window.MP). */
(function () {
  "use strict";
  const MP = window.MP;
  const PAGE_SIZE = 100;
  const SYNC_EVERY_MS = 60000;
  const PASTELS = ["#F6C9A8", "#F4D58D", "#B8DDB1", "#A9D3E8", "#D5C1EC", "#F2B8C6", "#C9D7A6"];
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // ------------------------------------------------------------ state & storage

  const S = {
    data: null, snapshot: null,
    sync: {}, syncState: "off", syncDetail: "", syncing: false, syncAgain: false, syncTimer: null,
    catalog: [], byId: {}, details: {}, catalogLoading: false, catalogFailed: false, catalogWaiting: [],
    ingredientHits: { term: "", ids: new Set() },
    page: "week", viewingLast: false, favTab: "all", favQuery: "", exploreQuery: "",
    exploreLimit: PAGE_SIZE, exploreOrder: [], pendingInvite: null, session: null, family: null, lastSync: 0, inviteText: "",
  };

  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast("Couldn't save on this phone: storage is full"); } },
  };

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

  function photo(meal, cls, big) {
    const name = (meal && meal.name) || "?";
    const letter = esc(name.trim().charAt(0).toUpperCase() || "?");
    const color = PASTELS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PASTELS.length];
    const ph = `<div class="ph ${cls || ""}" style="background:${color}">${letter}</div>`;
    const url = meal && MP.thumbUrl(meal.thumb, big);
    if (!url) return ph;
    return `<img class="photo ${cls || ""}" src="${esc(url)}" alt="" loading="lazy" data-ph="${esc(ph)}" onerror="this.outerHTML=this.dataset.ph">`;
  }

  // ------------------------------------------------------------ recipes, live from TheMealDB

  function setCatalog(meals) {
    S.catalog = meals;
    S.byId = {};
    for (const m of meals) S.byId[m.id] = m;
    S.exploreOrder = MP.shuffled(meals.map((m) => m.id));
  }

  /** Load the list of recipes (names, photos, categories) live, then call `then`. Takes a second or two. */
  function ensureCatalog(then, quiet) {
    if (S.catalog.length) return then && then();
    if (then) S.catalogWaiting.push(then);
    if (S.catalogLoading) return;
    S.catalogLoading = true;
    S.catalogFailed = false;
    if (!quiet) toast("Loading recipes\u2026", true);
    if (S.page === "explore") render();
    MP.fetchIndex().then((meals) => {
      setCatalog(meals);
      S.catalogLoading = false;
      if (!quiet) $("#toast").classList.remove("show");
      const waiting = S.catalogWaiting; S.catalogWaiting = [];
      renderWhenIdle();
      waiting.forEach((fn) => fn());
    }).catch(() => {
      S.catalogLoading = false;
      S.catalogFailed = true;
      S.catalogWaiting = [];
      if (!quiet) toast("Couldn't reach TheMealDB \u2014 check your connection");
      renderWhenIdle();
    });
  }

  function fullMeal(meal) {
    if (!meal) return meal;
    const fav = meal.uid && favByUid(meal.uid);
    return Object.assign({}, meal.id ? S.byId[meal.id] : null, meal.id ? S.details[meal.id] : null, fav || {}, meal);
  }

  /** Recipes whose ingredients and instructions haven't been fetched yet. */
  const needsDetails = (meal) => { const m = fullMeal(meal); return !!(m && m.id && !m.instructions && !(m.parts && m.parts.length)); };

  /** Fetch full recipes (ingredients, instructions) live for any of these meals that need it, then call `then`. */
  function withDetails(meals, then) {
    const ids = meals.filter(needsDetails).map((m) => m.id);
    if (!ids.length) return then();
    toast("Loading recipe\u2026", true);
    MP.fetchDetails(ids).then((found) => {
      Object.assign(S.details, found);
      $("#toast").classList.remove("show");
      then();
    }).catch(() => toast("Couldn't reach TheMealDB \u2014 check your connection"));
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
    if (needsDetails(meal)) return withDetails([meal], () => addFavorite(meal)); // favorites keep the full recipe
    const m = fullMeal(meal);
    const fav = {};
    for (const k of ["id", "name", "category", "area", "thumb", "ingredients", "parts", "instructions", "url", "youtube"]) if (m[k]) fav[k] = m[k];
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
    if (!standalone && !S.family) {
      html += `<div class="banner">Tip: add this app to your home screen — ${isIOS ? "Share → Add to Home Screen" : "⋮ → Install app"}. Tap <b>Family</b> at the top to share with your family.</div>`;
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
      if (!S.catalogLoading && !S.catalogFailed) setTimeout(() => ensureCatalog(null, true), 0);
      return `<div class="page-head"><div><h1>Explore</h1><p class="sub">Recipes from TheMealDB. Tap a photo for the full recipe.</p></div></div>
        ${S.catalogFailed ? `<p class="empty">Couldn’t reach TheMealDB. Check your connection.</p>
          <div class="more"><button class="btn primary" data-act="refresh-catalog">Try again</button></div>`
          : `<p class="empty">Loading recipes from TheMealDB…</p>`}`;
    }
    return `<div class="page-head"><div><h1>Explore</h1><p class="sub">Recipes from TheMealDB. Tap a photo for the full recipe.</p></div>
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
    // Ingredient matches come live from TheMealDB (see the search box handler).
    const byIngredient = S.ingredientHits.term === S.exploreQuery.trim().toLowerCase() ? S.ingredientHits.ids : new Set();
    const out = [];
    for (const id of S.exploreOrder) {
      const m = S.byId[id];
      if (!m) continue;
      if (areas && !areas.has(m.area)) continue;
      if (f.type !== "all" && !MP.mealTypes(m).has(f.type)) continue;
      if (words.length) {
        const text = [m.name, m.category, m.area].join(" ").toLowerCase();
        if (!words.every((w) => text.includes(w)) && !byIngredient.has(m.id)) continue;
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
      <p class="sub">Tap the category tags to sort a meal — it can be in more than one.</p></div>
      <button class="btn small soft" data-act="import-recipe">⤓ Import from a website</button></div>
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
    const parts = MP.mealParts(fullMeal(meal), S.details);
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
    // Explore meals' ingredients are fetched live.
    withDetails(meals.map(([, m]) => m), go);
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
    if (needsDetails(meal)) return withDetails([meal], () => showDetails(meal));
    const m = fullMeal(meal);
    const sub = [m.category, m.area].filter(Boolean).join(" · ");
    let html = (m.thumb ? `<img class="hero" src="${esc(MP.thumbUrl(m.thumb, true))}" alt="">` : "") + sheetHead(esc(m.name)) +
      (sub ? `<p class="sub">${esc(sub)}</p>` : "") +
      `<div class="actions">${heartButton(m, "save-detail")}` +
      (m.url ? `<a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">Full recipe ↗</a>` : "") +
      (m.youtube ? `<a class="btn" href="${esc(m.youtube)}" target="_blank" rel="noopener">▶ Video</a>` : "") + `</div>`;
    if (MP.mealParts(m, S.details).length) {
      html += `<h3>Ingredients</h3>${ingredientChecklist(m)}
        <button class="btn soft block" data-act="add-ingredients" style="margin-top:10px">Add to shopping list</button>`;
    }
    if (m.instructions) html += `<h3>Instructions</h3><div class="instructions">${esc(m.instructions.replace(/\r\n/g, "\n"))}</div>`;
    if (m.notes) html += `<h3>My notes</h3><div class="instructions">${esc(m.notes)}</div>`;
    if (!MP.mealParts(m, S.details).length && !m.instructions && !m.notes) html += `<p class="muted">No recipe details saved for this meal. Add a recipe link or notes from Favorites.</p>`;
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

  /** Add or edit a favorite. `draft` pre-fills a new one (an imported recipe). */
  /** One ingredient in the meal editor: editable text plus a remove button. */
  const ingredientRow = (line) => `<li class="item"><input type="text" class="ing-text" value="${esc(line)}" aria-label="Ingredient">
    <button type="button" class="x ing-remove" aria-label="Remove ${esc(line)}">✕</button></li>`;

  function editorSheet(uid, draft) {
    const existing = uid ? favByUid(uid) : null;
    const base = existing || draft || {};
    const start = existing ? MP.mealTypes(existing) : new Set(draft && draft.types ? draft.types : [S.favTab !== "all" ? S.favTab : "dinner"]);
    const title = existing ? "Edit meal" : draft ? "Check the recipe" : "Add a meal";
    openSheet(sheetHead(title) + (draft ? `<p class="sub">Imported from ${esc(draft.notes && draft.notes.split("from ").pop() || "the website")}. Fix anything that looks off, then save.</p>` : "") +
      `<form class="form" id="fav-form">
      <label class="field">Meal name<input type="text" name="name" required value="${esc(base.name || "")}"></label>
      <div class="field"><b>Categories</b> <span class="note">tick all that apply</span>
        <div class="checks">${MP.TYPE_TAGS.map(([k, l]) => `<label class="check"><input type="checkbox" name="type" value="${k}" ${start.has(k) ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
      <div class="field"><b>Ingredients</b> <span class="note">used for the shopping list</span>
        <ul class="items ing-list" id="ing-list">${MP.ingredientLines(base).map(ingredientRow).join("")}</ul>
        <div class="ing-add"><input type="text" id="ing-new" placeholder="Add an ingredient, e.g. 2 cloves garlic" enterkeyhint="done">
          <button type="button" class="btn" id="ing-add-btn">Add</button></div></div>
      <label class="field">Recipe steps <span class="note">optional</span>
        <textarea name="instructions" rows="6">${esc(base.instructions || "")}</textarea></label>
      <label class="field">Recipe link <span class="note">optional</span><input type="url" name="url" value="${esc(base.url || "")}" placeholder="https://"></label>
      <div class="field"><b>Photo</b> <span class="note">optional</span>
        <div class="photo-pick"><img id="photo-preview" alt="" hidden>
          <div class="photo-btns"><label class="btn small">\ud83d\udcf7 <span id="photo-pick-text">Add a photo</span><input type="file" id="photo-file" accept="image/*" hidden></label>
            <button type="button" class="btn small" id="photo-remove" hidden>Remove</button></div></div>
        <p class="status" id="photo-status" hidden></p>
        <details class="photo-link"><summary>or paste a photo link</summary><input type="url" id="photo-url" placeholder="https://"></details></div>
      <label class="field">Notes<textarea name="notes" rows="2">${esc(base.notes || "")}</textarea></label>
      <div class="actions">${existing ? `<button type="button" class="btn" data-act="delete-fav" data-uid="${existing.uid}">Remove</button>` : ""}
        <button type="submit" class="btn primary">${draft ? "Save to Favorites" : "Save meal"}</button></div></form>`, (sheet) => {
      const ingList = $("#ing-list", sheet), ingNew = $("#ing-new", sheet);
      const addIngredient = () => {
        const line = ingNew.value.trim();
        if (!line) return;
        ingList.insertAdjacentHTML("beforeend", ingredientRow(line));
        ingNew.value = "";
        ingNew.focus();
      };
      $("#ing-add-btn", sheet).addEventListener("click", addIngredient);
      ingNew.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIngredient(); } });
      ingList.addEventListener("click", (e) => { const x = e.target.closest(".ing-remove"); if (x) x.closest("li").remove(); });
      ingList.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches(".ing-text")) { e.preventDefault(); ingNew.focus(); } });
      let photo = base.thumb || "", uploading = false;
      const preview = $("#photo-preview", sheet), status = $("#photo-status", sheet), link = $("#photo-url", sheet);
      const showPhoto = () => {
        preview.hidden = !photo;
        if (photo) preview.src = MP.thumbUrl(photo, true);
        $("#photo-remove", sheet).hidden = !photo;
        $("#photo-pick-text", sheet).textContent = photo ? "Change photo" : "Add a photo";
        link.value = /^https?:/.test(photo) ? photo : "";
      };
      const photoStatus = (text, error) => { status.hidden = !text; status.textContent = text || ""; status.className = "status" + (error ? " error" : ""); };
      showPhoto();
      $("#photo-remove", sheet).addEventListener("click", () => { photo = ""; showPhoto(); photoStatus(""); });
      link.addEventListener("change", () => { photo = link.value.trim(); showPhoto(); });
      $("#photo-file", sheet).addEventListener("change", async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        uploading = true;
        photoStatus(familyReady() ? "Saving photo\u2026" : "Adding photo\u2026");
        try {
          photo = await savePhoto(file);
          showPhoto();
          photoStatus("");
        } catch (err) {
          photoStatus(err.message || "Couldn\u2019t use that photo.", true);
        } finally {
          uploading = false;
        }
      });
      $("#fav-form", sheet).addEventListener("submit", (e) => {
        e.preventDefault();
        if (uploading) return toast("Wait a moment \u2014 the photo is still saving");
        const form = new FormData(e.target);
        const name = form.get("name").trim();
        if (!name) return;
        if (S.data.favorites.some((f) => f.name.toLowerCase() === name.toLowerCase() && (!existing || f.uid !== existing.uid))) {
          return toast(`\u201c${name}\u201d is already in Favorites`);
        }
        const types = form.getAll("type");
        if (!types.length) return toast("Tick at least one category");
        const fields = Object.assign({}, base, { name, types, url: form.get("url").trim(), thumb: photo,
          notes: form.get("notes").trim() });
        delete fields.origin;
        const lines = [...sheet.querySelectorAll(".ing-list input")].map((i) => i.value);
        const pending = $("#ing-new", sheet).value.trim(); // typed but not added yet: keep it
        if (pending) lines.push(pending);
        const meal = MP.applyRecipeEdits(fields, lines.join("\n"), form.get("instructions"));
        const i = existing ? S.data.favorites.findIndex((f) => f.uid === existing.uid) : -1;
        if (i >= 0) S.data.favorites[i] = meal; else S.data.favorites.push(meal);
        save();
        closeSheet();
        render();
        toast(`\u2665 Saved \u201c${name}\u201d`);
      });
    });
  }

  /** Shrink a photo from this device; in a family it's saved online for everyone, otherwise kept in the meal. */
  async function savePhoto(file) {
    const url = URL.createObjectURL(file);
    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("That file isn\u2019t a photo this browser can open."));
        el.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    const online = familyReady();
    const size = MP.photoSize(img.naturalWidth, img.naturalHeight, online ? MP.PHOTO_MAX : MP.PHOTO_LOCAL_MAX);
    const canvas = Object.assign(document.createElement("canvas"), size);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs get a white background, not black
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img, 0, 0, size.width, size.height);
    if (!online) return canvas.toDataURL("image/jpeg", MP.PHOTO_QUALITY);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", MP.PHOTO_QUALITY));
    return account.uploadPhoto(S.family.family_id, blob);
  }

  /** Import a recipe from a website: paste a link, then check it in the editor. */
  function importSheet(error, link, failedUrl) {
    const err = error ? `<p class="status error">${esc(error)}</p>` : "";
    const manual = failedUrl ? `<div class="actions"><button class="btn" data-act="import-manual" data-url="${esc(failedUrl)}">Add it by hand instead</button></div>` : "";
    const needsSignIn = !S.session;
    openSheet(sheetHead("Import a recipe") + `
      <p class="sub">Paste a link to a recipe page. The app reads the recipe (ingredients, steps, photo) and lets you check it before saving.</p>
      ${needsSignIn ? `<p class="status error">On the web app, importing needs you to be in a family \u2014 tap <b>Family</b> at the top first. (The iPhone and desktop apps can import without it.)</p>` : ""}
      <form class="form" id="import-form"><label class="field">Recipe link<input type="url" name="url" required placeholder="https://www.example.com/recipe/\u2026" value="${esc(link || "")}" autocomplete="off"></label>
        <button class="btn primary" type="submit" ${needsSignIn ? "disabled" : ""}>Get recipe</button></form>${err}${manual}`, (sheet) => {
      $("#import-form", sheet).addEventListener("submit", async (e) => {
        e.preventDefault();
        const raw = new FormData(e.target).get("url");
        const url = MP.normalizeUrl(raw);
        if (!url) return importSheet("That doesn\u2019t look like a web address.", raw);
        const btn = e.target.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Getting recipe\u2026";
        try {
          const page = await account.fetchPage(url);
          const recipe = MP.extractRecipe(page.html, page.url || url);
          if (!recipe) return importSheet("That page doesn\u2019t include recipe details the app can read.", url, url);
          editorSheet(null, recipe);
        } catch (err2) {
          importSheet(err2.message || "Couldn\u2019t get that recipe.", url, url);
        }
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

  // ------------------------------------------------------------ family

  const CFG = window.MEAL_PLANNER_CONFIG || {};
  const sb = new MP.Supabase(CFG.supabaseUrl, CFG.supabaseAnonKey);
  const account = new MP.FamilyAccount(sb, {
    get: () => S.session,
    set: (session) => { S.session = session; store.set("mp.session", session); },
  });
  const familyReady = () => !!(S.session && S.family);

  function setFamily(family) {
    S.family = family;
    if (family) store.set("mp.family", family); else localStorage.removeItem("mp.family");
  }

  /** The Family sheet: join with an invite (QR code or code) -> members and invites. No emails anywhere. */
  function familySheet(error) {
    const err = error ? `<p class="status error">${esc(error)}</p>` : "";
    let body;
    if (!sb.configured) {
      body = `<p class="sub">Family sharing isn\u2019t set up in this copy of the app yet. Everything else works and is saved in this browser.</p>`;
    } else if (!S.family) {
      body = `<p class="sub">${S.pendingInvite ? "You’ve been invited to join a family." : "Families are set up on the Meal Planner desktop app."}
          Everyone in a family shares the same week, favorites and shopping list. No email or password needed.</p>
        <form class="form" id="invite-join-form"><label class="field">Invite code<input type="text" name="code" required placeholder="ABCD-2345" autocapitalize="characters" value="${esc(S.pendingInvite ? MP.formatInviteCode(S.pendingInvite) : "")}"></label>
          <label class="field">Family member name<input type="text" name="name" required placeholder="e.g. Sam" autocomplete="given-name"></label>
          <button class="btn primary" type="submit">Join family</button>
          <p class="note">Scan the QR code on the family computer (or on the primary household member’s phone) to fill in the code. The family’s week plan replaces this one; your favorites and list items are added to the family’s.</p></form>${err}`;
    } else {
      const f = S.family, manager = MP.canManage(f);
      const when = S.lastSync ? new Date(S.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const status = S.syncState === "error" ? `<p class="status error">${esc(S.syncDetail)}</p>`
        : `<p class="status ok">${S.syncState === "syncing" ? "Syncing\u2026" : "Synced" + (when ? " at " + when : "")}</p>`;
      body = `<p class="sub">${esc(f.name)}</p>${status}
        <h3>Members</h3><ul class="items">${f.members.map((m) => `<li class="item"><div class="item-text"><div class="item-name">${esc(m.display_name || "(no name)")}${m.me ? ' <span class="item-qty">(you)</span>' : ""}</div>
          ${MP.ROLE_LABELS[m.role] ? `<div class="item-for">${MP.ROLE_LABELS[m.role]}</div>` : ""}</div>
          ${manager && !m.me && m.role !== "owner" ? `<button class="x" data-act="fam-remove" data-uid="${esc(m.user_id)}" aria-label="Remove ${esc(m.display_name)}">\u2715</button>` : ""}</li>`).join("")}</ul>
        ${f.role === "primary" ? '<p class="note">You’re the primary household member: you can invite people and remove them.</p>' : ""}
        <div class="actions">${manager ? '<button class="btn primary" data-act="fam-invite">Invite someone</button>' : ""}<button class="btn" data-act="sync-now">Sync now</button></div>
        <div id="invite-box"></div>${err}
        <div class="actions"><button class="btn" data-act="fam-leave">Leave family</button></div>`;
    }
    openSheet(sheetHead("Family") + body + `<h3>Recipes</h3><p class="sub">${S.catalog.length ? S.catalog.length + " recipes from TheMealDB, loaded live." : "Recipes load live from TheMealDB."}</p>
      <div class="actions"><button class="btn" data-act="refresh-catalog">Reload recipes</button></div>`, (sheet) => wireFamilyForms(sheet));
  }

  /** Run an action from the Family sheet, then redraw it (with the error message if it failed). */
  async function familyAction(fn) {
    try { await fn(); familySheet(); render(); } catch (e) { familySheet(e.message || "Something went wrong."); }
  }

  function wireFamilyForms(sheet) {
    const on = (id, fn) => { const f = $("#" + id, sheet); if (f) f.addEventListener("submit", (e) => { e.preventDefault(); fn(new FormData(e.target)); }); };
    on("invite-join-form", (f) => familyAction(() => joinWithInvite(f.get("code"), f.get("name"))));
  }

  /** Join a family with an invite code and a family member name. The device signs itself in (no email). */
  async function joinWithInvite(code, name) {
    name = String(name || "").trim();
    if (!name) throw new Error("Enter a family member name.");
    await account.ensureSignedIn();
    await enterFamily(await account.joinFamily(code, name), true);
    S.pendingInvite = null;
    localStorage.removeItem("mp.pendingInvite");
    toast(`Joined “${S.family.name}”`);
  }

  /** After creating or joining: a phone that joins takes the family's week plan and settings. */
  async function enterFamily(family, joining) {
    if (joining) { S.data.plan_updated = 0; S.data.settings_updated = 0; }
    setFamily(family);
    await syncNow();
    rollOverWeek();
  }

  async function refreshFamily() {
    if (!familyReady()) return;
    try {
      const mine = (await account.myFamilies()).find((f) => f.family_id === S.family.family_id);
      if (mine) setFamily(mine); else { setFamily(null); toast("You\u2019re no longer in that family. Your meals are still here."); }
    } catch (e) {
      if (e.signedOut) signOut();
    }
  }

  /** The device's sign-in stopped working (its account is gone): forget it so it can join again. */
  function signOut() {
    S.session = null;
    localStorage.removeItem("mp.session");
    setFamily(null);
    setSyncState("off");
  }

  /** Show an invite: a QR code to scan with another phone, the code, and a message to send. */
  async function showInvite() {
    const inv = await account.createInvite(S.family.family_id);
    const code = MP.formatInviteCode(inv.code);
    const link = location.origin + location.pathname + "#join=" + inv.code;
    S.inviteText = `Join our family on Meal Planner! Tap this link on your phone: ${link}\n\nOr open the app, go to Family and enter the invite code ${code}. It works for 7 days.`;
    const qr = window.qrcode ? MP.qrSvgPath(window.qrcode, link) : null;
    const box = $("#invite-box");
    if (box) box.innerHTML = `<div class="banner invite" style="text-align:center">
      ${qr ? `<div class="small muted">SCAN WITH A PHONE\u2019S CAMERA TO JOIN</div>
        <svg class="qr" viewBox="0 0 ${qr.size} ${qr.size}" role="img" aria-label="Invite QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${qr.path}" fill="#000"/></svg>` : ""}
      <div class="small muted">INVITE CODE</div>
      <div style="font-size:28px;font-weight:800;letter-spacing:3px">${esc(code)}</div><div class="small muted">Works for 7 days, for as many family members as you like.</div>
      <div class="actions"><button class="btn" data-act="fam-send-invite">${navigator.share ? "Send invite\u2026" : "Copy invite message"}</button></div></div>`;
  }

  // ------------------------------------------------------------ sync

  function renderSyncChip() {
    const chip = $("#sync-chip");
    const labels = { off: "\u21c5 Family", syncing: "\u21c5 Syncing\u2026", ok: "\u2713 Synced", error: "\u26a0 Sync problem" };
    chip.textContent = labels[S.syncState];
    chip.className = "sync-chip " + S.syncState;
  }

  function setSyncState(state, detail) {
    S.syncState = state;
    S.syncDetail = detail || "";
    renderSyncChip();
  }

  function scheduleSync(delay) {
    if (!familyReady()) return;
    clearTimeout(S.syncTimer);
    S.syncTimer = setTimeout(syncNow, delay ?? 2000);
  }

  async function syncNow() {
    if (!familyReady()) return;
    if (S.syncing) { S.syncAgain = true; return; }
    S.syncing = true;
    setSyncState("syncing");
    const fs = new MP.FamilyStore(account, S.family.family_id);
    try {
      const { data: remote, sha } = await fs.pull();
      const merged = MP.mergeData(S.data, remote);
      if (MP.canonical(merged) !== MP.canonical(S.data)) {
        S.data = MP.normalizeData(merged);
        S.snapshot = MP.clone(S.data);
        store.set("mp.data", S.data);
        renderWhenIdle();
      }
      if (!(remote && MP.canonical(merged) === MP.canonical(remote))) {
        try { await fs.push(merged, sha); } catch (e) { if (e.conflict) S.syncAgain = true; else throw e; }
      }
      S.lastSync = Date.now();
      store.set("mp.lastSync", S.lastSync);
      setSyncState("ok");
    } catch (e) {
      setSyncState("error", e.message || "Sync failed");
      if (e.signedOut) signOut();
      else if (/not in this family/.test(e.message || "")) { setFamily(null); setSyncState("off"); toast("You\u2019re no longer in that family. Your meals are still here."); }
    } finally {
      S.syncing = false;
      if (S.syncAgain) { S.syncAgain = false; scheduleSync(500); }
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
      case "settings": familySheet(); refreshFamily().then(() => { if ($("#invite-box") || $("#join-form")) familySheet(); }); break;
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
      case "import-recipe": importSheet(); break;
      case "import-manual": editorSheet(null, { url: el.dataset.url, types: [S.favTab !== "all" ? S.favTab : "dinner"] }); break;
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
      case "sync-now": syncNow().then(() => familySheet()); break;
      case "fam-send-invite":
        if (navigator.share) navigator.share({ text: S.inviteText }).catch(() => {});
        else if (navigator.clipboard) navigator.clipboard.writeText(S.inviteText).then(() => toast("Invite copied \u2014 paste it in a message"));
        break;
      case "fam-invite": showInvite().catch((e2) => familySheet(e2.message)); break;
      case "fam-remove":
        if (confirm("Remove this person from the family?")) familyAction(async () => setFamily(await account.removeMember(S.family.family_id, el.dataset.uid)));
        break;
      case "fam-leave":
        if (confirm("Leave this family? Your meals stay here.")) familyAction(async () => { await account.leaveFamily(S.family.family_id); setFamily(null); setSyncState("off"); });
        break;
      case "refresh-catalog": closeSheet(); S.catalog = []; S.catalogFailed = false; ensureCatalog(); break;
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
      searchTimer = setTimeout(() => {
        const query = e.target.value;
        S.exploreQuery = query;
        S.exploreLimit = PAGE_SIZE;
        renderExploreResults();
        // Also ask TheMealDB live which recipes use this ingredient ("garlic", "chicken breast"...).
        const term = query.trim().toLowerCase();
        if (term.length >= 3 && S.ingredientHits.term !== term) {
          MP.searchIngredient(term).then((ids) => {
            if (S.exploreQuery.trim().toLowerCase() !== term) return;
            S.ingredientHits = { term, ids };
            renderExploreResults();
          }).catch(() => {});
        }
      }, 250);
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
    const input = e.target.querySelector("input");  // not .elements.item: every form has a built-in item() function
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
    S.session = store.get("mp.session", null);
    S.family = store.get("mp.family", null);
    S.lastSync = store.get("mp.lastSync", 0);
    localStorage.removeItem("mp.sync"); // old GitHub sync settings
    S.pendingInvite = store.get("mp.pendingInvite", null);
    const invite = location.hash.match(/#join=([A-Za-z0-9-]+)/);
    if (invite) {
      history.replaceState(null, "", location.pathname + location.search);
      S.pendingInvite = invite[1].replace(/-/g, "");
      store.set("mp.pendingInvite", S.pendingInvite);
    }
    render();
    if (S.pendingInvite && !familyReady()) familySheet();
    ensureCatalog(null, true); // recipe names and photos, live
    if (familyReady()) await syncNow();
    rollOverWeek();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  start();
})();
