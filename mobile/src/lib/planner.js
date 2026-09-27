// App state and every action: the week plan, sides, favorites, Explore filters, the shopping list,
// family sign-in/invites, and syncing. The rules themselves live in core.js (shared with the web app).
//
// The planner is one store that lives outside React. Screens call usePlanner() to read it and
// re-render when it changes; the root layout calls usePlannerLifecycle() once to start syncing.
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { storage } from "./storage";
import { SUPABASE_ANON_KEY, SUPABASE_URL, WEB_APP_URL } from "./config";
import { startRealtime, stopRealtime, updateRealtimeToken } from "./realtime";

const MP = require("./core");

const PAGE_SIZE = 100;
const POLL_MS = 30000;
export { MP, PAGE_SIZE };

function createPlanner() {
  const data = MP.normalizeData(storage.get("mp.data", null));
  const snapshot = MP.stamp(data, MP.clone(data));
  storage.set("mp.data", data);
  const S = {
    data, snapshot,
    catalog: [], byId: {}, details: {}, exploreOrder: [], catalogLoading: false, catalogFailed: false, catalogWaiting: [],
    detailsLoading: new Set(), ingredientHits: { term: "", ids: new Set() },
    session: storage.get("mp.session", null),
    family: storage.get("mp.family", null),
    lastSync: storage.get("mp.lastSync", 0),
    syncState: "off", syncDetail: "", syncing: false, syncAgain: false, syncTimer: null,
    toast: null, pendingInvite: storage.get("mp.pendingInvite", null), pendingImport: null,
  };

  // Screens re-render when `version` changes.
  const listeners = new Set();
  let version = 0;
  const redraw = () => { version++; listeners.forEach((fn) => fn()); };
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const getVersion = () => version;
  const toastTimer = { current: null };

  // ------------------------------------------------------------ helpers

  function notify(message) {
    S.toast = message;
    redraw();
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => { S.toast = null; redraw(); }, 2800);
  }

  function save() {
    S.snapshot = MP.stamp(S.data, S.snapshot);
    storage.set("mp.data", S.data);
    scheduleSync();
    redraw();
  }

  const isFavorite = (name) => S.data.favorites.some((f) => f.name.toLowerCase() === (name || "").toLowerCase());
  const favByUid = (uid) => S.data.favorites.find((f) => f.uid === uid);
  const passesLeaveOut = (m) => !S.data.filters.leave_out.some((p) => MP.proteins(m).has(p));
  const lastWeek = () => (S.data.history.length ? S.data.history[S.data.history.length - 1] : null);
  function lastWeekNames() {
    const lw = lastWeek();
    return new Set(lw ? lw.week.concat(lw.sides).filter(Boolean).map((m) => m.name.toLowerCase()) : []);
  }
  function fullMeal(meal) {
    if (!meal) return meal;
    const fav = meal.uid && favByUid(meal.uid);
    return Object.assign({}, meal.id ? S.byId[meal.id] : null, meal.id ? S.details[meal.id] : null, fav || {}, meal);
  }

  /** Recipes whose ingredients and instructions haven't been fetched yet. */
  function needsDetails(meal) {
    const m = fullMeal(meal);
    return !!(m && m.id && !m.instructions && !(m.parts && m.parts.length));
  }

  /** Fetch full recipes live (ingredients, instructions) for meals that need it. */
  async function loadDetails(meals) {
    const ids = meals.filter(needsDetails).map((m) => m.id).filter((id) => !S.detailsLoading.has(id));
    if (!ids.length) return;
    ids.forEach((id) => S.detailsLoading.add(id));
    try {
      Object.assign(S.details, await MP.fetchDetails(ids));
    } catch {
      notify("Couldn't reach TheMealDB — check your connection");
    } finally {
      ids.forEach((id) => S.detailsLoading.delete(id));
      redraw();
    }
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
    redraw();
    MP.fetchIndex()
      .then((meals) => {
        setCatalog(meals);
        const waiting = S.catalogWaiting;
        S.catalogWaiting = [];
        S.catalogLoading = false;
        redraw();
        waiting.forEach((fn) => fn());
      })
      .catch(() => {
        S.catalogLoading = false;
        S.catalogFailed = true;
        S.catalogWaiting = [];
        if (!quiet) notify("Couldn't reach TheMealDB — check your connection");
        redraw();
      });
  }

  function reloadCatalog() {
    S.catalog = [];
    S.catalogFailed = false;
    ensureCatalog();
  }

  /** Ask TheMealDB live which recipes use an ingredient, for the Explore search box. */
  async function searchIngredient(query) {
    const term = query.trim().toLowerCase();
    if (term.length < 3 || S.ingredientHits.term === term) return;
    try {
      const ids = await MP.searchIngredient(term);
      S.ingredientHits = { term, ids };
      redraw();
    } catch {
      // name matches still show
    }
  }

  // ------------------------------------------------------------ the week

  function mealPool() {
    const src = S.data.source, pool = [];
    if (src !== "explore") {
      for (const f of S.data.favorites) if (MP.mealTypes(f).has("dinner")) pool.push({ ...f, origin: "Favorite" });
    }
    if (src !== "favorites") {
      const favNames = new Set(S.data.favorites.map((f) => f.name.toLowerCase()));
      for (const m of S.catalog) {
        if (MP.mealTypes(m).has("dinner") && passesLeaveOut(m) && !favNames.has(m.name.toLowerCase())) pool.push({ ...m, origin: "Explore" });
      }
    }
    return pool;
  }
  const needsCatalog = () => S.data.source !== "favorites" && !S.catalog.length;

  function shuffleWeek(message) {
    if (needsCatalog()) return ensureCatalog(() => shuffleWeek(message));
    const pool = mealPool();
    if (!pool.length) return notify("No dinners to pick from yet — add Favorites or pick from Mix / Explore");
    const d = S.data;
    const kept = new Set(d.week.filter((m, i) => m && d.kept[i]).map((m) => m.name));
    const openDays = [0, 1, 2, 3, 4, 5, 6].filter((i) => !(d.week[i] && d.kept[i]));
    const choices = pool.filter((m) => !kept.has(m.name));
    const { picks, reused } = MP.pickAvoiding(choices.length ? choices : pool, openDays.length, lastWeekNames());
    openDays.forEach((day, i) => { d.week[day] = picks[i]; });
    save();
    notify(reused ? `New menu! ${reused} repeated from last week (not enough meals to avoid it).`
      : message || `New menu from ${pool.length} meals — nothing from last week.`);
  }

  function swapDay(day) {
    if (needsCatalog()) return ensureCatalog(() => swapDay(day));
    const pool = mealPool();
    if (!pool.length) return notify("No dinners to pick from yet — add Favorites or pick from Mix / Explore");
    const planned = new Set(S.data.week.filter(Boolean).map((m) => m.name));
    const choices = pool.filter((m) => !planned.has(m.name));
    S.data.week[day] = MP.pickAvoiding(choices.length ? choices : pool, 1, lastWeekNames()).picks[0];
    S.data.kept[day] = false;
    save();
  }

  function sidePool() {
    const favSides = S.data.favorites.filter((m) => MP.mealTypes(m).has("sides")).map((m) => ({ ...m, origin: "Favorite" }));
    if (S.data.source === "favorites" && favSides.length) return favSides;
    const names = new Set(favSides.map((m) => m.name.toLowerCase()));
    const others = S.catalog.filter((m) => MP.mealTypes(m).has("sides") && passesLeaveOut(m) && !names.has(m.name.toLowerCase()));
    return favSides.concat(others.map((m) => ({ ...m, origin: "Explore" })));
  }

  function randomSide(day) {
    const pool = sidePool();
    if (!S.catalog.length && !(S.data.source === "favorites" && pool.length)) return ensureCatalog(() => randomSide(day));
    if (!pool.length) return notify("No side dishes match your filters");
    const used = new Set(S.data.sides.filter(Boolean).map((s) => s.name));
    const choices = pool.filter((m) => !used.has(m.name));
    S.data.sides[day] = MP.pickAvoiding(choices.length ? choices : pool, 1, lastWeekNames()).picks[0];
    save();
  }

  function removeSide(day) { S.data.sides[day] = null; save(); }
  function toggleKeep(day) { S.data.kept[day] = !S.data.kept[day]; save(); }
  function setSource(source) { S.data.source = source; save(); }

  function pickFavorite(day, uid, side) {
    const fav = favByUid(uid);
    if (!fav) return;
    (side ? S.data.sides : S.data.week)[day] = { ...fav, origin: "Favorite" };
    if (!side) S.data.kept[day] = true;
    save();
    notify(`${MP.DAYS[day]} ${side ? "side" : "dinner"}: ${fav.name}`);
  }

  function archiveCurrentWeek() {
    const d = S.data;
    if (d.week.some(Boolean)) {
      d.history.push({ start: d.week_start, week: d.week, sides: d.sides });
      d.history = d.history.slice(-12);
    }
    d.week = Array(7).fill(null);
    d.kept = Array(7).fill(false);
    d.sides = Array(7).fill(null);
  }

  function rollOverWeek() {
    const thisStart = MP.weekStartOf(new Date());
    if (MP.parseIso(S.data.week_start) >= thisStart) return;
    const hadPlan = S.data.week.some(Boolean);
    archiveCurrentWeek();
    S.data.week_start = MP.isoDate(thisStart);
    save();
    if (hadPlan) shuffleWeek("It's a new week — here's a fresh menu with nothing from last week.");
  }

  function startNextWeek() {
    const start = MP.addDays(MP.parseIso(S.data.week_start), 7);
    archiveCurrentWeek();
    S.data.week_start = MP.isoDate(start);
    save();
    shuffleWeek(`Planning ${MP.dateRange(S.data.week_start)} — nothing from last week.`);
  }

  function weekTitle(viewingLast) {
    if (viewingLast) return "Last week";
    const ahead = (MP.parseIso(S.data.week_start) - MP.weekStartOf(new Date())) / 86400000;
    return ahead <= 0 ? "This week" : ahead === 7 ? "Next week" : "Upcoming week";
  }

  // ------------------------------------------------------------ favorites

  async function addFavorite(meal) {
    if (!meal || isFavorite(meal.name)) return;
    if (needsDetails(meal)) await loadDetails([meal]); // favorites keep the full recipe
    if (isFavorite(meal.name)) return;
    const m = fullMeal(meal);
    const fav = { notes: "" };
    for (const k of ["id", "name", "category", "area", "thumb", "ingredients", "parts", "instructions", "url", "youtube"]) if (m[k]) fav[k] = m[k];
    S.data.favorites.push(fav);
    S.data.week.forEach((w, i) => { if (w && w.name === meal.name) S.data.week[i] = { ...w, origin: "Favorite" }; });
    save();
    notify(`♥ Saved “${meal.name}”`);
  }

  /**
   * Add or update a favorite from the editor (also the review step of an imported recipe, `draft`).
   * Returns an error message, or null when saved.
   */
  function saveFavorite(fields, uid, draft) {
    const name = fields.name.trim();
    if (!name) return "Give the meal a name.";
    if (S.data.favorites.some((f) => f.name.toLowerCase() === name.toLowerCase() && f.uid !== uid)) return `“${name}” is already in Favorites.`;
    if (!fields.types.length) return "Pick at least one category.";
    const existing = uid ? favByUid(uid) : null;
    const base = { ...(existing || draft || {}), name, types: fields.types, url: fields.url.trim(), thumb: fields.thumb.trim(), notes: fields.notes.trim() };
    delete base.origin;
    const meal = MP.applyRecipeEdits(base, fields.ingredients, fields.instructions);
    const i = existing ? S.data.favorites.findIndex((f) => f.uid === uid) : -1;
    if (i >= 0) S.data.favorites[i] = meal; else S.data.favorites.push(meal);
    save();
    notify(`♥ Saved “${name}”`);
    return null;
  }

  function removeFavorite(uid) {
    S.data.favorites = S.data.favorites.filter((f) => f.uid !== uid);
    save();
  }

  function toggleFavType(uid, key) {
    const fav = favByUid(uid);
    if (!fav) return;
    const types = MP.mealTypes(fav);
    if (types.has(key)) types.delete(key); else types.add(key);
    if (!types.size) return notify("A meal needs at least one category");
    fav.types = MP.TYPE_TAGS.map(([t]) => t).filter((t) => types.has(t)).concat(types.has("dessert") ? ["dessert"] : []);
    save();
  }

  // ------------------------------------------------------------ explore

  function setType(type) { S.data.filters.type = type; save(); }
  function setCuisine(cuisine) { S.data.filters.cuisine = cuisine; save(); }
  function toggleLeaveOut(key) {
    const lo = S.data.filters.leave_out;
    S.data.filters.leave_out = lo.includes(key) ? lo.filter((x) => x !== key) : lo.concat(key);
    save();
  }
  function reshuffleExplore() { S.exploreOrder = MP.shuffled(S.catalog.map((m) => m.id)); redraw(); }

  function exploreVisible(query) {
    const f = S.data.filters;
    let areas = null;
    if (f.cuisine.startsWith("region:")) areas = new Set(MP.REGIONS[f.cuisine.slice(7)] || []);
    else if (f.cuisine !== MP.ALL_CUISINES) areas = new Set([f.cuisine]);
    const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    // Ingredient matches come live from TheMealDB (searchIngredient).
    const byIngredient = S.ingredientHits.term === (query || "").trim().toLowerCase() ? S.ingredientHits.ids : new Set();
    const out = [];
    for (const id of S.exploreOrder) {
      const m = S.byId[id];
      if (!m || (areas && !areas.has(m.area))) continue;
      if (f.type !== "all" && !MP.mealTypes(m).has(f.type)) continue;
      if (words.length) {
        const text = [m.name, m.category, m.area].join(" ").toLowerCase();
        if (!words.every((w) => text.includes(w)) && !byIngredient.has(m.id)) continue;
      }
      if (passesLeaveOut(m)) out.push(m);
    }
    return out;
  }

  function cuisineOptions() {
    const counts = {};
    for (const m of S.catalog) counts[m.area] = (counts[m.area] || 0) + 1;
    const regions = Object.entries(MP.REGIONS)
      .map(([region, members]) => [`${region} — all`, "region:" + region, members.reduce((a, c) => a + (counts[c] || 0), 0)])
      .filter(([, , n]) => n);
    const cuisines = Object.keys(counts).filter(Boolean).sort().map((a) => [a, a, counts[a]]);
    return { regions, cuisines };
  }

  function cuisineLabel() {
    const c = S.data.filters.cuisine;
    return c === MP.ALL_CUISINES ? "All cuisines" : c.startsWith("region:") ? c.slice(7) : c;
  }

  // ------------------------------------------------------------ shopping list

  function addIngredients(adds) {
    const r = MP.addToList(S.data.shopping, adds);
    save();
    notify(`Added ${r.added} item${r.added === 1 ? "" : "s"} to your list` + (r.combined ? `, ${r.combined} combined with items already on it` : ""));
    return r;
  }
  function quickAdd(text) {
    const { name, qty } = MP.parseQuickItem(text);
    if (!name) return;
    MP.addToList(S.data.shopping, [{ name, qty }]);
    save();
  }
  function toggleItem(uid) {
    const it = S.data.shopping.find((x) => x.uid === uid);
    if (it) { it.checked = !it.checked; save(); }
  }
  function removeItem(uid) { S.data.shopping = S.data.shopping.filter((x) => x.uid !== uid); save(); }
  function clearChecked() { S.data.shopping = S.data.shopping.filter((x) => !x.checked); save(); }

  function plannedMeals() {
    const out = [];
    MP.DAYS.forEach((day, i) => {
      if (S.data.week[i]) out.push([day, S.data.week[i]]);
      if (S.data.sides[i]) out.push([day + " side", S.data.sides[i]]);
    });
    return out;
  }

  // ------------------------------------------------------------ family & sync

  const sb = new MP.Supabase(SUPABASE_URL, SUPABASE_ANON_KEY);
  const account = new MP.FamilyAccount(sb, {
    get: () => S.session,
    set: (session) => { S.session = session; storage.set("mp.session", session); updateRealtimeToken(session.access_token); },
  });
  const familyReady = () => !!(S.session && S.family);

  function setFamily(family) {
    S.family = family;
    if (family) storage.set("mp.family", family); else storage.remove("mp.family");
    redraw();
  }

  function scheduleSync(delay) {
    if (!familyReady()) return;
    clearTimeout(S.syncTimer);
    S.syncTimer = setTimeout(syncNow, delay ?? 1500);
  }

  async function syncNow() {
    if (!familyReady()) return;
    if (S.syncing) { S.syncAgain = true; return; }
    S.syncing = true;
    S.syncState = "syncing";
    redraw();
    const store = new MP.FamilyStore(account, S.family.family_id);
    try {
      const { data: remote, sha } = await store.pull();
      const merged = MP.mergeData(S.data, remote);
      if (MP.canonical(merged) !== MP.canonical(S.data)) {
        S.data = MP.normalizeData(merged);
        S.snapshot = MP.clone(S.data);
        storage.set("mp.data", S.data);
      }
      if (!(remote && MP.canonical(merged) === MP.canonical(remote))) {
        try { await store.push(merged, sha); } catch (e) { if (e.conflict) S.syncAgain = true; else throw e; }
      }
      S.lastSync = Date.now();
      storage.set("mp.lastSync", S.lastSync);
      S.syncState = "ok";
      S.syncDetail = "";
    } catch (e) {
      S.syncState = "error";
      S.syncDetail = e.message || "Sync failed";
      if (e.signedOut) signOut(true);
      else if (/not in this family/.test(e.message || "")) { stopRealtime(); setFamily(null); notify("You're no longer in that family. Your meals are still on this phone."); }
    } finally {
      S.syncing = false;
      redraw();
      if (S.syncAgain) { S.syncAgain = false; scheduleSync(300); }
    }
  }

  async function connectRealtime() {
    if (!familyReady()) return stopRealtime();
    try {
      const token = await account.token();
      startRealtime(SUPABASE_URL, SUPABASE_ANON_KEY, token, S.family.family_id, () => scheduleSync(200));
    } catch {
      // polling covers it
    }
  }

  /** After joining: newly joined phones take the family's week plan and settings. */
  async function enterFamily(family, joining) {
    if (joining) { S.data.plan_updated = 0; S.data.settings_updated = 0; }
    setFamily(family);
    await syncNow();
    connectRealtime();
    rollOverWeek();
  }

  /**
   * Join a family with an invite code and a family member name. The phone signs itself in (Supabase
   * "anonymous sign-in" — no email or password). Families are started on the desktop app.
   */
  async function joinWithInvite(code, name) {
    if (!String(name || "").trim()) throw new Error("Enter a family member name.");
    await account.ensureSignedIn();
    const fam = await account.joinFamily(code, name.trim());
    await enterFamily(fam, true);
    clearPendingInvite();
    notify(`Joined “${fam.name}”`);
  }

  /** A link to join the family, for invite QR codes and messages: the web app (opens on any phone's camera). */
  const inviteLink = (code) => (WEB_APP_URL ? WEB_APP_URL + "#join=" + code : "");

  // ---- importing recipes from websites

  const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  /**
   * Shrink a photo from the camera or photo library ({uri, width, height}). In a family it's saved online so
   * everyone sees it; otherwise it's kept inside the meal. Returns the meal's new photo address.
   */
  async function savePhoto(asset) {
    const online = familyReady();
    const size = MP.photoSize(asset.width || MP.PHOTO_MAX, asset.height || MP.PHOTO_MAX, online ? MP.PHOTO_MAX : MP.PHOTO_LOCAL_MAX);
    const context = ImageManipulator.manipulate(asset.uri);
    if (asset.width && size.width < asset.width) context.resize(size);
    const image = await context.renderAsync();
    const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: MP.PHOTO_QUALITY, base64: true });
    if (!online) return "data:image/jpeg;base64," + out.base64;
    return account.uploadPhoto(S.family.family_id, MP.base64ToBytes(out.base64));
  }

  /** Read the recipe on a web page. Returns a draft favorite, or throws with a message to show. */
  async function importRecipe(link) {
    const url = MP.normalizeUrl(link);
    if (!url) throw new Error("That doesn't look like a web address.");
    let html, finalUrl = url;
    if (Platform.OS === "web") {
      if (!S.session) throw new Error("In a browser, importing needs you to be in a family first (Family tab).");
      const page = await account.fetchPage(url);
      html = page.html;
      finalUrl = page.url || url;
    } else {
      let resp;
      try {
        resp = await fetch(url, { headers: BROWSER_HEADERS });
      } catch {
        throw new Error("Couldn't open that page — check the link and your connection.");
      }
      if (!resp.ok) {
        // Some sites turn phones away; the family's import helper (if set up) may still get it.
        if (S.session && [401, 403, 429].includes(resp.status)) {
          try {
            const page = await account.fetchPage(url);
            const viaHelper = MP.extractRecipe(page.html, page.url || url);
            if (viaHelper) return viaHelper;
          } catch {
            // fall through to the message below
          }
        }
        throw new Error([401, 403, 429].includes(resp.status) ? "That site turned the app away."
          : resp.status === 404 ? "That page couldn't be found." : `The site answered with error ${resp.status}.`);
      }
      html = await resp.text();
      finalUrl = resp.url || url;
    }
    const recipe = MP.extractRecipe(html, finalUrl);
    if (!recipe) throw Object.assign(new Error("That page doesn't include recipe details the app can read."), { manualUrl: url });
    return recipe;
  }

  const setPendingImport = (url) => { S.pendingImport = url; redraw(); };
  const takePendingImport = () => { const url = S.pendingImport; S.pendingImport = null; return url; };

  async function refreshFamily() {
    if (!familyReady()) return;
    try {
      const families = await account.myFamilies();
      const mine = families.find((f) => f.family_id === S.family.family_id);
      if (mine) setFamily(mine);
      else { stopRealtime(); setFamily(null); notify("You're no longer in that family. Your meals are still on this phone."); }
    } catch (e) {
      if (e.signedOut) signOut(true);
    }
  }

  const createInvite = () => account.createInvite(S.family.family_id);
  async function removeMember(userId) { setFamily(await account.removeMember(S.family.family_id, userId)); }
  async function setDisplayName(name) { setFamily(await account.setDisplayName(S.family.family_id, name)); }

  async function leaveFamily() {
    await account.leaveFamily(S.family.family_id);
    stopRealtime();
    setFamily(null);
    S.syncState = "off";
    notify("You left the family. Your meals are still on this phone.");
  }

  function signOut(expired) {
    stopRealtime();
    S.session = null;
    storage.remove("mp.session");
    setFamily(null);
    S.syncState = "off";
    if (expired) notify("This phone lost its family connection. Ask for a new invite on the Family tab.");
    redraw();
  }

  // ------------------------------------------------------------ start-up & staying fresh

  const setPendingInvite = (code) => { S.pendingInvite = code; storage.set("mp.pendingInvite", code); redraw(); };
  function clearPendingInvite() { S.pendingInvite = null; storage.remove("mp.pendingInvite"); }

  /** Load the recipe list, sync, and keep syncing while the app is open. Returns a cleanup function. */
  function start() {
    let alive = true;
    (async () => {
      ensureCatalog(null, true); // recipe names and photos, live
      if (!alive) return;
      if (familyReady()) { await syncNow(); connectRealtime(); }
      rollOverWeek();
    })();
    const poll = setInterval(() => { if (AppState.currentState === "active") syncNow(); }, POLL_MS);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") { syncNow(); rollOverWeek(); connectRealtime(); }
    });
    return () => { alive = false; clearInterval(poll); sub.remove(); stopRealtime(); };
  }

  return {
    S, MP, notify, redraw, subscribe, getVersion, start, setPendingInvite, clearPendingInvite,
    isFavorite, favByUid, fullMeal, needsDetails, loadDetails, lastWeek, lastWeekNames, weekTitle,
    ensureCatalog, reloadCatalog, searchIngredient, shuffleWeek, swapDay, randomSide, removeSide, toggleKeep, setSource, pickFavorite, startNextWeek,
    addFavorite, saveFavorite, removeFavorite, toggleFavType,
    setType, setCuisine, toggleLeaveOut, reshuffleExplore, exploreVisible, cuisineOptions, cuisineLabel,
    addIngredients, quickAdd, toggleItem, removeItem, clearChecked, plannedMeals,
    familyConfigured: sb.configured, joinWithInvite, inviteLink, refreshFamily, createInvite,
    importRecipe, setPendingImport, takePendingImport, savePhoto,
    removeMember, setDisplayName, leaveFamily, signOut, syncNow,
  };
}

const planner = createPlanner();

/** The planner, re-rendering this component whenever anything in it changes. */
export function usePlanner() {
  useSyncExternalStore(planner.subscribe, planner.getVersion, planner.getVersion);
  return planner;
}

/** Call once in the root layout: loads recipes, syncs, and keeps syncing while the app is open. */
export function usePlannerLifecycle() {
  useEffect(() => planner.start(), []);
}
