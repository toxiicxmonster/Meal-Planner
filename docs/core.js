/* Meal Planner - shared logic for the phone app (no page code, so it can be tested with Node).
   The meal rules and mergeData() match the desktop app (meal_planner.pyw) so the two stay in sync. */
(function (root) {
  "use strict";

  const API = "https://www.themealdb.com/api/json/v1/1/";
  const GITHUB_API = "https://api.github.com";
  const SYNC_PATH = "data.json";
  const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]; // weeks run Sat-Fri
  const SOURCES = [["favorites", "Favorites only"], ["mix", "Mix of both"], ["explore", "Explore only"]];
  const MEAL_TYPES = [["all", "All"], ["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"],
    ["dessert", "Dessert"], ["sides", "Sides"]];
  const FAV_TABS = [["all", "All"], ["dinner", "Dinner"], ["lunch", "Lunch"], ["breakfast", "Breakfast"],
    ["sides", "Sides"]];
  const TYPE_TAGS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["sides", "Side"]];
  const PROTEINS = [["seafood", "Seafood"], ["poultry", "Poultry"], ["beef", "Beef"], ["pork", "Pork"],
    ["lamb", "Lamb"], ["vegetarian", "Vegetarian"]];
  const ALL_CUISINES = "All cuisines";
  const AREA_FIX = { "United States": "American", "France": "French", "Norway": "Norwegian", "India": "Indian",
    "Netherlands": "Dutch", "Argentina": "Argentinian", "Venezuela": "Venezuelan", "Slovakia": "Slovak",
    "Unknown": "" };
  const REGIONS = {
    "Asian": ["Chinese", "Filipino", "Indian", "Japanese", "Malaysian", "Thai", "Vietnamese"],
    "European": ["British", "Croatian", "Dutch", "French", "Greek", "Irish", "Italian", "Norwegian",
      "Polish", "Portuguese", "Russian", "Slovak", "Spanish", "Ukrainian"],
    "North American": ["American", "Canadian"],
    "Latin American & Caribbean": ["Argentinian", "Jamaican", "Mexican", "Uruguayan", "Venezuelan"],
    "Middle Eastern & North African": ["Algerian", "Egyptian", "Moroccan", "Saudi Arabian", "Syrian",
      "Tunisian", "Turkish"],
    "African": ["Kenyan"],
    "Oceanian": ["Australian"],
  };
  const PLAN_KEYS = ["week_start", "week", "kept", "sides"];
  const SETTINGS_KEYS = ["source", "filters"];
  const SLIM_KEYS = ["id", "uid", "name", "thumb", "category", "area", "types", "origin", "url", "youtube", "notes"];

  // ------------------------------------------------------------ meal types & proteins

  // Whole-word match that treats accented letters as letters (like Python's \b), e.g. "jam" doesn't match "jamón".
  const wordRe = (words) => new RegExp("(?:^|[^\\p{L}\\p{N}\\p{M}_])(?:" + words.join("|") + ")(?:s|es)?(?![\\p{L}\\p{N}\\p{M}_])", "iu");
  const PROTEIN_WORDS = {
    seafood: wordRe(["fish", "salmon", "tuna", "cod", "haddock", "prawn", "shrimp", "crab", "lobster",
      "mussel", "clam", "squid", "octopus", "anchovy", "anchovies", "sardine", "mackerel", "scallop", "oyster",
      "seafood", "kedgeree", "tilapia", "trout", "halibut", "monkfish", "calamari", "sea bass", "saltfish",
      "codfish", "shellfish", "catfish", "swordfish", "whitefish", "fishcake", "herring", "eel", "caviar",
      "ackee and saltfish"]),
    poultry: wordRe(["chicken", "turkey", "duck", "goose", "poussin", "quail"]),
    beef: wordRe(["beef", "steak", "veal", "brisket", "oxtail", "burger", "slider", "meatloaf",
      "cheesesteak", "sloppy joe", "meatball", "french dip"]),
    pork: wordRe(["pork", "porkchop", "bacon", "ham", "sausage", "chorizo", "prosciutto", "pancetta",
      "salami", "pepperoni", "kielbasa", "lardon", "gammon", "stromboli"]),
    lamb: wordRe(["lamb", "goat", "mutton", "hogget", "kleftiko", "moussaka"]),
  };
  const OTHER_MEAT = wordRe(["venison", "rabbit", "boar"]);
  const CATEGORY_PROTEIN = { Seafood: "seafood", Chicken: "poultry", Beef: "beef", Pork: "pork",
    Lamb: "lamb", Goat: "lamb" };
  const LUNCH_WORDS = wordRe(["soup", "salad", "sandwich", "wrap", "burger", "slider", "quesadilla", "taco",
    "burrito", "toastie", "panini", "bagel", "pizza", "grilled cheese", "cheesesteak", "dip", "sub",
    "stromboli", "chowder"]);
  const TYPE_WORDS = { breakfast: "breakfast", lunch: "lunch", dinner: "dinner", side: "sides", sides: "sides",
    dessert: "dessert" };

  function mealTypes(m) {
    if (m.types && m.types.length) return new Set(m.types);
    const cat = m.category || "";
    const named = new Set(cat.split(",").map((w) => TYPE_WORDS[w.trim().toLowerCase()]).filter(Boolean));
    if (named.size) return named;
    if (cat === "Dessert") return new Set(["dessert"]);
    if (cat === "Breakfast") return new Set(["breakfast"]);
    if (cat === "Side") return new Set(["sides"]);
    if (cat === "Starter") return new Set(["lunch"]);
    if (cat === "Soup" || cat === "Salad") return new Set(["lunch", "dinner"]);
    const types = new Set(["dinner"]);
    if (["Pasta", "Miscellaneous", "Vegetarian", "Vegan"].includes(cat) || LUNCH_WORDS.test(m.name)) types.add("lunch");
    return types;
  }

  function proteins(m) {
    const cat = m.category || "";
    if (cat === "Vegetarian" || cat === "Vegan") return new Set(["vegetarian"]);
    const text = [m.name].concat(m.ingredients || []).join(" ");
    const found = new Set(Object.keys(PROTEIN_WORDS).filter((p) => PROTEIN_WORDS[p].test(text)));
    if (CATEGORY_PROTEIN[cat]) found.add(CATEGORY_PROTEIN[cat]);
    if (!found.size && cat !== "Dessert" && !OTHER_MEAT.test(text)) found.add("vegetarian");
    return found;
  }

  function parseMeal(m) {
    const ingredients = [], parts = [];
    for (let i = 1; i <= 20; i++) {
      const ing = (m["strIngredient" + i] || "").trim();
      const meas = (m["strMeasure" + i] || "").trim();
      if (ing) { ingredients.push((meas + " " + ing).trim()); parts.push({ q: meas, n: ing }); }
    }
    const area = m.strArea || "";
    return {
      id: m.idMeal, name: m.strMeal, category: m.strCategory || "",
      area: area in AREA_FIX ? AREA_FIX[area] : area, thumb: m.strMealThumb || "", ingredients, parts,
      instructions: m.strInstructions || "", url: m.strSource || "https://www.themealdb.com/meal/" + m.idMeal,
      youtube: m.strYoutube || "",
    };
  }

  async function fetchCatalog(progress, fetchFn) {
    const get = fetchFn || fetch;
    const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
    const meals = {};
    for (let i = 0; i < letters.length; i++) {
      let list = null;
      for (let attempt = 0; attempt < 4 && list === null; attempt++) {
        const resp = await get(API + "search.php?f=" + letters[i]);
        if (resp.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
        if (!resp.ok) throw new Error("TheMealDB error " + resp.status);
        list = (await resp.json()).meals || [];
      }
      for (const m of list || []) meals[m.idMeal] = parseMeal(m);
      if (progress) progress(i + 1, letters.length);
      await sleep(250);
    }
    return Object.values(meals).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function thumbUrl(url, big) {
    if (url && url.includes("themealdb.com/images/")) return url + (big ? "/medium" : "/small");
    return url || "";
  }

  // ------------------------------------------------------------ shopping list

  // Checked in order: the first aisle with a matching word wins ("chicken stock" is Pantry, not Meat).
  const AISLE_RULES = [
    ["Frozen", ["frozen", "ice cream"]],
    ["Spices & Seasonings", ["salt", "black pepper", "white pepper", "peppercorn", "cumin", "paprika", "turmeric",
      "cinnamon", "oregano", "dried thyme", "dried basil", "bay leaf", "bay leaves", "chilli powder", "chili powder",
      "cayenne", "nutmeg", "ground cloves", "whole cloves", "cardamom", "ground coriander", "coriander seed", "garam masala", "curry powder",
      "spice", "seasoning", "stock cube", "bouillon", "vanilla", "allspice", "saffron", "fenugreek", "mustard seed",
      "chilli flakes", "red pepper flakes", "five spice", "star anise"]],
    ["Bakery", ["bread", "bun", "roll", "tortilla", "pita", "pitta", "baguette", "naan", "wrap", "croissant",
      "bagel", "brioche", "ciabatta", "puff pastry", "pastry", "filo"]],
    ["Pantry", ["flour", "sugar", "oil", "vinegar", "rice", "pasta", "spaghetti", "noodle", "stock", "broth",
      "tomato puree", "tomato paste", "passata", "chopped tomatoes", "tinned", "canned", "lentil", "chickpea",
      "kidney bean", "black bean", "baked bean", "soy sauce", "fish sauce", "worcestershire", "honey", "syrup",
      "ketchup", "mustard", "mayonnaise", "baking powder", "baking soda", "bicarbonate", "yeast", "oats",
      "breadcrumb", "cornstarch", "cornflour", "almond", "peanut", "walnut", "cashew", "pine nut", "sesame",
      "coconut milk", "coconut cream", "chocolate", "cocoa", "wine", "raisin", "sultana", "jam", "gelatine",
      "tahini", "couscous", "quinoa", "polenta", "macaroni", "lasagne", "hot sauce", "sriracha", "custard"]],
    ["Meat & Seafood", ["chicken", "beef", "pork", "lamb", "bacon", "sausage", "mince", "minced", "steak", "ham",
      "turkey", "duck", "fish", "salmon", "prawn", "shrimp", "cod", "haddock", "tuna", "mussel", "clam", "squid",
      "crab", "lobster", "chorizo", "veal", "goat", "mutton", "anchovy", "anchovies", "sardine", "mackerel",
      "scallop", "oxtail", "brisket", "pancetta", "prosciutto", "salami", "kielbasa", "saltfish"]],
    ["Dairy & Eggs", ["milk", "buttermilk", "cream", "butter", "cheese", "yogurt", "yoghurt", "egg", "parmesan",
      "mozzarella", "cheddar", "creme fraiche", "cr\u00e8me fra\u00eeche", "sour cream", "ricotta", "feta", "mascarpone",
      "ghee", "paneer", "gruyere", "halloumi"]],
    ["Produce", ["onion", "garlic", "tomato", "tomatoes", "potato", "potatoes", "carrot", "pepper", "lettuce",
      "spinach", "cabbage", "celery", "cucumber", "zucchini", "courgette", "mushroom", "lemon", "lime", "orange",
      "apple", "banana", "ginger", "parsley", "cilantro", "coriander", "basil", "mint", "thyme", "rosemary", "dill",
      "sage", "chive", "avocado", "chilli", "chillies", "chili", "jalapeno", "leek", "shallot", "scallion",
      "spring onion", "broccoli", "cauliflower", "pea", "green bean", "corn", "squash", "pumpkin", "aubergine",
      "eggplant", "kale", "berry", "berries", "strawberries", "blueberries", "raspberries", "cherries", "grape",
      "mango", "pineapple", "beetroot", "radish", "fennel", "asparagus", "sweet potato", "yam", "plantain", "okra",
      "bean sprout", "pak choi", "bok choy", "lemongrass", "herb", "pear", "peach", "plum", "cherry", "rhubarb",
      "coconut", "watercress", "rocket", "arugula", "sweetcorn"]],
  ].map(([aisle, words]) => [aisle, wordRe(words)]);
  // Shown in the order you walk a store (the rules above are checked in a different order).
  const AISLES = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Pantry", "Spices & Seasonings", "Frozen", "Other"];
  const SKIP_INGREDIENTS = new Set(["water", "cold water", "hot water", "boiling water", "warm water", "ice"]);

  function aisleOf(name) {
    for (const [aisle, rx] of AISLE_RULES) if (rx.test(name)) return aisle;
    return "Other";
  }

  /** "Onions " and "onion" are the same item on the list. */
  function ingredientKey(name) {
    let k = name.trim().toLowerCase().replace(/\s+/g, " ");
    if (k.endsWith("es") && /(tomatoes|potatoes|chillies)$/.test(k)) k = k.slice(0, -2);
    else if (k.length > 3 && k.endsWith("s") && !k.endsWith("ss")) k = k.slice(0, -1);
    return k;
  }

  /** A meal's ingredients as [{q, n}] - from the meal, the recipe catalog, or plain ingredient lines. */
  function mealParts(meal, byId) {
    if (!meal) return [];
    if (meal.parts && meal.parts.length) return meal.parts;
    const fromCatalog = meal.id && byId && byId[meal.id];
    if (fromCatalog && fromCatalog.parts && fromCatalog.parts.length) return fromCatalog.parts;
    return (meal.ingredients || []).map((line) => ({ q: "", n: line }));
  }

  /** Add ingredients to the list, combining with items still to buy. adds = [{name, qty, meal}]. */
  function addToList(list, adds) {
    let added = 0, combined = 0;
    for (const a of adds) {
      const name = a.name.trim();
      if (!name || SKIP_INGREDIENTS.has(name.toLowerCase())) continue;
      const key = ingredientKey(name);
      const hit = list.find((it) => !it.checked && ingredientKey(it.name) === key);
      if (hit) {
        if (a.qty) hit.qty = hit.qty ? hit.qty + " + " + a.qty : a.qty;
        if (a.meal && !hit.meals.includes(a.meal)) hit.meals = hit.meals.concat(a.meal);
        combined++;
      } else {
        const item = { name: name.charAt(0).toUpperCase() + name.slice(1), qty: a.qty || "", aisle: aisleOf(name),
          checked: false, meals: a.meal ? [a.meal] : [] };
        list.push(item);
        added++;
      }
    }
    return { added, combined };
  }

  /** "2 lemons" -> {qty: "2", name: "lemons"}; "milk" -> {qty: "", name: "milk"}. */
  function parseQuickItem(text) {
    const m = text.trim().match(/^([\d\u00bc-\u00be\u2150-\u215e][\d\s\/.,\u00bc-\u00be\u2150-\u215e]*(?:\s*(?:g|kg|ml|l|oz|lbs?|cups?|tbsp|tsp|tins?|cans?|packs?|bags?|bunch(?:es)?|cloves?|dozen)\b\.?)?)\s+(.+)$/i);
    return m ? { qty: m[1].trim(), name: m[2].trim() } : { qty: "", name: text.trim() };
  }

  // ------------------------------------------------------------ dates (weeks run Saturday -> Friday)

  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function weekStartOf(d) { return addDays(d, -((d.getDay() - 6 + 7) % 7)); } // the Saturday on or before d
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  function dateRange(startIso) {
    const start = parseIso(startIso);
    return `${shortDate(start)} – ${shortDate(addDays(start, 6))}`;
  }

  // ------------------------------------------------------------ data, stamping & merging

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const nowMs = () => Date.now();

  function normalizeData(d) {
    d = d || {};
    d.favorites = d.favorites || [];
    d.source = d.source || "mix";
    const fill = (list, v) => (list || []).concat(Array(7).fill(v)).slice(0, 7);
    d.week = fill(d.week, null);
    d.kept = fill(d.kept, false);
    d.sides = fill(d.sides, null);
    d.filters = Object.assign({ type: "all", leave_out: [], cuisine: ALL_CUISINES }, d.filters || {});
    d.history = d.history || [];
    d.week_layout = "sat-fri";
    d.week_start = d.week_start || isoDate(weekStartOf(new Date()));
    d.tombstones = d.tombstones || {};
    d.plan_updated = d.plan_updated || 0;
    d.shopping = d.shopping || [];
    d.settings_updated = d.settings_updated || 0;
    return d;
  }

  function slimMeal(m) {
    if (!m) return null;
    const out = {};
    for (const k of SLIM_KEYS) if (m[k] && !(Array.isArray(m[k]) && !m[k].length)) out[k] = m[k];
    return out;
  }

  // JSON with sorted keys, for comparing two copies of the data.
  function canonical(x) {
    if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
    if (x && typeof x === "object") {
      return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}";
    }
    return JSON.stringify(x === undefined ? null : x);
  }

  const newUid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
    : "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, () => (Math.random() * 16 | 0).toString(16))).replace(/-/g, "");

  /** Record what changed since `prev` (uids, edit times, deletions). Returns the new snapshot. */
  function stamp(d, prev) {
    const now = nowMs();
    const withoutUpdated = (f) => { const c = Object.assign({}, f); delete c.updated; return canonical(c); };
    for (const key of ["favorites", "shopping"]) {
      const before = {};
      for (const f of prev[key] || []) before[f.uid] = f;
      const seen = new Set();
      (d[key] || []).forEach((f, i) => {
        if (!f.uid) { f.uid = newUid(); f.added = now + i; }
        seen.add(f.uid);
        const old = before[f.uid];
        if (!old || withoutUpdated(old) !== withoutUpdated(f)) f.updated = now;
      });
      for (const uid of Object.keys(before)) if (uid && uid !== "undefined" && !seen.has(uid)) d.tombstones[uid] = now;
    }
    d.week = d.week.map(slimMeal);
    d.sides = d.sides.map(slimMeal);
    for (const h of d.history) { h.week = h.week.map(slimMeal); h.sides = h.sides.map(slimMeal); }
    if (PLAN_KEYS.some((k) => canonical(prev[k]) !== canonical(d[k]))) d.plan_updated = now;
    if (SETTINGS_KEYS.some((k) => canonical(prev[k]) !== canonical(d[k]))) d.settings_updated = now;
    return clone(d);
  }

  /** Combine two copies of the planner data. Must match merge_data() in meal_planner.pyw. */
  function mergeData(local, remote) {
    if (!remote) return clone(local);
    const out = clone(local);
    const tombs = Object.assign({}, remote.tombstones || {});
    for (const [uid, ts] of Object.entries(local.tombstones || {})) tombs[uid] = Math.max(ts, tombs[uid] || 0);
    const byAdded = (a, b) => (a.added || 0) - (b.added || 0) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
    const newest = (key) => {
      const items = {};
      for (const f of (remote[key] || []).concat(local[key] || [])) {
        const cur = items[f.uid];
        if (!cur || (f.updated || 0) >= (cur.updated || 0)) items[f.uid] = f;
      }
      return Object.values(items).filter((f) => (f.uid in tombs ? tombs[f.uid] : -1) < (f.updated || 0));
    };
    const alive = newest("favorites");
    alive.sort((a, b) => (b.updated || 0) - (a.updated || 0) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    const byName = {};
    for (const f of alive) {
      const key = f.name.trim().toLowerCase();
      if (key in byName) tombs[f.uid] = Math.max(tombs[f.uid] || 0, f.updated || 0); // added on both devices
      else byName[key] = f;
    }
    out.favorites = clone(Object.values(byName)).sort(byAdded);
    out.shopping = clone(newest("shopping")).sort(byAdded);
    out.tombstones = tombs;
    for (const [keys, stampKey] of [[PLAN_KEYS, "plan_updated"], [SETTINGS_KEYS, "settings_updated"]]) {
      if ((remote[stampKey] || 0) > (local[stampKey] || 0)) {
        for (const k of keys) if (k in remote) out[k] = clone(remote[k]);
        out[stampKey] = remote[stampKey];
      }
    }
    const history = {};
    for (const h of (remote.history || []).concat(local.history || [])) history[h.start] = h;
    out.history = Object.keys(history).sort().map((k) => clone(history[k])).slice(-12);
    return out;
  }

  // ------------------------------------------------------------ picking meals

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /** Pick `count` meals, using ones not in `avoid` (lower-case names) first. */
  function pickAvoiding(choices, count, avoid) {
    const fresh = shuffled(choices.filter((m) => !avoid.has(m.name.toLowerCase())));
    const stale = shuffled(choices.filter((m) => avoid.has(m.name.toLowerCase())));
    const picks = fresh.concat(stale).slice(0, count);
    while (picks.length < count && choices.length) picks.push(choices[Math.floor(Math.random() * choices.length)]);
    const reused = picks.filter((m) => avoid.has(m.name.toLowerCase())).length;
    return { picks, reused };
  }

  function weekText(src, start) {
    const lines = ["Dinner menu " + dateRange(start)];
    DAYS.forEach((d, i) => {
      const m = src.week[i], s = src.sides[i];
      lines.push(`${d.slice(0, 3)}: ${m ? m.name : "-"}` + (m && s ? ` + ${s.name}` : ""));
    });
    return lines.join("\n");
  }

  // ------------------------------------------------------------ GitHub sync store

  function b64encodeUtf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function decodeSetup(code) {
    const cleaned = code.trim().replace(/^.*#setup=/, "").replace(/-/g, "+").replace(/_/g, "/");
    const cfg = JSON.parse(b64decodeUtf8(cleaned + "===".slice((cleaned.length + 3) % 4)));
    if (!cfg.repo || !cfg.token) throw new Error("That setup code is incomplete.");
    return { repo: cfg.repo, token: cfg.token };
  }
  function encodeSetup(cfg) {
    return b64encodeUtf8(JSON.stringify({ repo: cfg.repo, token: cfg.token }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  class SyncError extends Error {}

  class GitHubStore {
    constructor(repo, token, api, fetchFn) {
      this.repo = repo.trim().replace(/^\/+|\/+$/g, "");
      this.token = token.trim();
      this.api = api || GITHUB_API;
      this.fetch = fetchFn || fetch.bind(root);
    }
    async request(method, path, body) {
      let resp;
      try {
        resp = await this.fetch(`${this.api}/repos/${this.repo}${path}`, {
          method, cache: "no-store", body: body ? JSON.stringify(body) : undefined,
          headers: { Authorization: "Bearer " + this.token, Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        });
      } catch (e) {
        throw new SyncError("Couldn't reach GitHub — check your internet connection.");
      }
      if (resp.ok) return resp.json();
      if (resp.status === 401) throw new SyncError("GitHub didn't accept the token. Check it was copied fully and hasn't expired.");
      if ((resp.status === 409 || resp.status === 422) && method === "PUT") {
        const e = new SyncError("Saved at the same moment on another device — trying again.");
        e.conflict = true;
        throw e;
      }
      if (resp.status === 404) { const e = new SyncError(`Couldn't find the repo “${this.repo}”, or the token can't access it.`); e.notFound = true; throw e; }
      if (resp.status === 403) throw new SyncError("The token isn't allowed to change this repo. Give it Contents: Read and write.");
      throw new SyncError("GitHub error " + resp.status);
    }
    async check() {
      const info = await this.request("GET", "");
      if (!info.private) throw new SyncError("That repo is public, so anyone could see your meals. Make it private first.");
      return info;
    }
    async pull() {
      try {
        const got = await this.request("GET", "/contents/" + SYNC_PATH);
        return { data: JSON.parse(b64decodeUtf8(got.content)), sha: got.sha };
      } catch (e) {
        if (e.notFound) return { data: null, sha: null };
        throw e;
      }
    }
    async push(data, sha) {
      const body = { message: "Sync from phone", content: b64encodeUtf8(canonical(data)) };
      if (sha) body.sha = sha;
      return (await this.request("PUT", "/contents/" + SYNC_PATH, body)).content.sha;
    }
  }

  const MP = {
    API, DAYS, SOURCES, MEAL_TYPES, FAV_TABS, TYPE_TAGS, PROTEINS, ALL_CUISINES, AREA_FIX, REGIONS,
    PLAN_KEYS, SETTINGS_KEYS, mealTypes, proteins, parseMeal, fetchCatalog, thumbUrl, isoDate, parseIso,
    addDays, weekStartOf, shortDate, dateRange, clone, normalizeData, slimMeal, canonical, stamp, mergeData,
    shuffled, pickAvoiding, weekText, AISLES, aisleOf, ingredientKey, mealParts, addToList, parseQuickItem, b64encodeUtf8, b64decodeUtf8, decodeSetup, encodeSetup, SyncError,
    GitHubStore, sleep,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = MP;
  else root.MP = MP;
})(typeof globalThis !== "undefined" ? globalThis : this);
