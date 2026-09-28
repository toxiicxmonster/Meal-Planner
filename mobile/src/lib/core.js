// GENERATED from docs/core.js by scripts/sync-core.js — edit docs/core.js instead.
/* Meal Planner - shared logic for the phone app (no page code, so it can be tested with Node).
   The meal rules and mergeData() match the desktop app (meal_planner.pyw) so the two stay in sync. */
(function (root) {
  "use strict";

  const API = "https://www.themealdb.com/api/json/v1/1/";
  const DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]; // weeks run Sat-Fri
  const SOURCES = [["favorites", "Favorites only"], ["mix", "Mix of both"], ["explore", "Explore only"]];
  const MEAL_TYPES = [["all", "All"], ["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"],
    ["appetizer", "Appetizers"], ["dessert", "Dessert"], ["sides", "Sides"]];
  const FAV_TABS = [["all", "All"], ["dinner", "Dinner"], ["lunch", "Lunch"], ["breakfast", "Breakfast"],
    ["appetizer", "Appetizers"], ["sides", "Sides"]];
  const TYPE_TAGS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["appetizer", "Appetizer"],
    ["sides", "Side"]];
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
    dessert: "dessert", appetizer: "appetizer", appetizers: "appetizer", starter: "appetizer", starters: "appetizer" };

  function mealTypes(m) {
    if (m.types && m.types.length) return new Set(m.types);
    const cat = m.category || "";
    const named = new Set(cat.split(",").map((w) => TYPE_WORDS[w.trim().toLowerCase()]).filter(Boolean));
    if (named.size) return named;
    if (cat === "Dessert") return new Set(["dessert"]);
    if (cat === "Breakfast") return new Set(["breakfast"]);
    if (cat === "Side") return new Set(["sides"]);
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

  // ------------------------------------------------------------ TheMealDB, live

  const CATEGORIES = ["Beef", "Breakfast", "Chicken", "Dessert", "Goat", "Lamb", "Miscellaneous", "Pasta", "Pork",
    "Seafood", "Side", "Starter", "Vegan", "Vegetarian"];

  async function getMeals(path, fetchFn) {
    const get = fetchFn || fetch;
    for (let attempt = 0; attempt < 4; attempt++) {
      const resp = await get(API + path);
      if (resp.status === 429) { await sleep(1500 * (attempt + 1)); continue; } // TheMealDB asking us to slow down
      if (!resp.ok) throw new Error("TheMealDB error " + resp.status);
      return (await resp.json()).meals || [];
    }
    throw new Error("TheMealDB is busy \u2014 try again in a minute.");
  }

  /** Run fn over items, a few at a time (TheMealDB limits how many requests arrive at once). */
  async function eachLimited(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  /**
   * Every TheMealDB recipe's name, photo, category and cuisine, fetched live (about 2 seconds).
   * Ingredients and instructions aren't included; fetch those per recipe with fetchDetails().
   */
  async function fetchIndex(fetchFn) {
    const lists = await eachLimited(CATEGORIES, 4, (c) => getMeals("filter.php?c=" + encodeURIComponent(c), fetchFn));
    const byId = {};
    lists.forEach((list, i) => {
      for (const m of list) {
        const area = m.strArea || "";
        byId[m.idMeal] = { id: m.idMeal, name: m.strMeal, thumb: m.strMealThumb || "", category: CATEGORIES[i],
          area: area in AREA_FIX ? AREA_FIX[area] : area };
      }
    });
    return Object.values(byId).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  /** Full recipes (ingredients, instructions, links) for the given ids, fetched live: {id: meal}. */
  async function fetchDetails(ids, fetchFn) {
    const found = await eachLimited([...new Set(ids)], 3, (id) => getMeals("lookup.php?i=" + encodeURIComponent(id), fetchFn));
    const out = {};
    for (const list of found) for (const m of list) out[m.idMeal] = parseMeal(m);
    return out;
  }

  /** Ids of recipes that use an ingredient (TheMealDB's ingredient search, e.g. "garlic" or "chicken breast"). */
  async function searchIngredient(term, fetchFn) {
    const key = term.trim().toLowerCase().replace(/\s+/g, "_");
    if (key.length < 3) return new Set();
    const tries = key.endsWith("s") && key.length > 3 ? [key, key.slice(0, -1)] : [key];
    const lists = await eachLimited(tries, 2, (k) => getMeals("filter.php?i=" + encodeURIComponent(k), fetchFn).catch(() => []));
    return new Set(lists.flat().map((m) => m.idMeal));
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

  // ------------------------------------------------------------ importing recipes from websites
  // Recipe sites publish a machine-readable copy of each recipe for search engines (schema.org Recipe in
  // JSON-LD). We read that. Must match extract_recipe() etc. in meal_planner.pyw.

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014",
    lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", deg: "\u00b0",
    frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", frac13: "\u2153", frac23: "\u2154", eacute: "\u00e9",
    egrave: "\u00e8", ecirc: "\u00ea", agrave: "\u00e0", ccedil: "\u00e7", ntilde: "\u00f1", uuml: "\u00fc",
    ouml: "\u00f6", auml: "\u00e4", times: "\u00d7", reg: "\u00ae", copy: "\u00a9", trade: "\u2122" };

  /** Text from a recipe page: entities decoded, tags removed, spaces tidied. */
  function cleanText(value) {
    let t = String(value == null ? "" : value);
    for (let i = 0; i < 2; i++) { // some sites double-encode (&amp;amp;)
      t = t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);/gi, (m, e) => {
        if (e[0] === "#") {
          const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        const k = e.toLowerCase();
        return k in ENTITIES ? ENTITIES[k] : m;
      });
    }
    return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  const UNITS = "fluid ounces?|fl\\.? ?oz|tablespoons?|teaspoons?|kilograms?|milliliters?|millilitres?|ounces?|pounds?|" +
    "grams?|liters?|litres?|quarts?|pints?|cups?|tbsps?|tbs|tsps?|lbs?|oz|kg|ml|qts?|pts?|g|l|cans?|jars?|packages?|" +
    "pkgs?|packets?|bottles?|boxes?|bags?|cloves?|heads?|bunch(?:es)?|sprigs?|stalks?|sticks?|slices?|pieces?|" +
    "pinch(?:es)?|dash(?:es)?|handfuls?|large|medium|small";
  const NUM = "[0-9\u00bc-\u00be\u2150-\u215e]+(?:[.,/][0-9]+)?(?:\\s+[0-9\u00bc-\u00be\u2150-\u215e]+(?:/[0-9]+)?)?";
  const AMOUNT_RE = new RegExp("^((?:" + NUM + ")(?:\\s*(?:-|\u2013|to)\\s*(?:" + NUM + "))?(?:\\s*\\([^)]*\\))?" +
    "(?:\\s*(?:" + UNITS + ")(?![A-Za-z0-9_])\\.?)?(?:\\s*\\([^)]*\\))?)\\s*(.+)$", "i");

  /** "2 (14 oz) cans diced tomatoes, drained" -> {q: "2 (14 oz) cans", n: "diced tomatoes"}. */
  function parseIngredientLine(line) {
    const text = cleanText(line).replace(/^[\u2022\u25a2\u25a1\u2610\-*\u00b7]+\s*/, "");
    const m = text.match(AMOUNT_RE);
    const q = m ? m[1].trim() : "";
    let n = (m ? m[2] : text).replace(/\([^)]*\)/g, " ").split(",")[0].replace(/^of\s+/i, "").replace(/\s+/g, " ").trim();
    if (!n) n = text;
    return { q, n };
  }

  /** "PT1H30M" -> "1 hr 30 min". */
  function formatDuration(iso) {
    const m = String(iso || "").match(/^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:[0-9.]+S)?)?$/i);
    if (!m) return "";
    const total = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    const h = Math.floor(total / 60), min = total % 60;
    return [h ? h + " hr" : "", min ? min + " min" : ""].filter(Boolean).join(" ");
  }

  function asList(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

  function isRecipeType(t) { return asList(t).some((x) => /(^|[:/])recipe$/i.test(String(x))); }

  function findRecipe(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const x of node) { const r = findRecipe(x, depth + 1); if (r) return r; }
      return null;
    }
    if (isRecipeType(node["@type"])) return node;
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
      const r = findRecipe(node[key], depth + 1);
      if (r) return r;
    }
    return null;
  }

  function imageUrl(img, base) {
    let u = "";
    for (const x of asList(img)) {
      u = typeof x === "string" ? x : x && typeof x === "object" ? (x.url || x.contentUrl || "") : "";
      if (u) break;
    }
    if (!u) return "";
    try { return new URL(cleanText(u), base).href; } catch { return ""; }
  }

  function instructionLines(node, out, depth) {
    if (depth > 5 || node == null) return out;
    if (typeof node === "string") {
      for (const part of node.split(/\r?\n|<br\s*\/?>|<\/p>|<\/li>/i)) { const t = cleanText(part); if (t) out.push(t); }
    } else if (Array.isArray(node)) {
      for (const x of node) instructionLines(x, out, depth + 1);
    } else if (typeof node === "object") {
      if (asList(node["@type"]).some((t) => /HowToSection$/i.test(String(t)))) {
        const title = cleanText(node.name);
        if (title) out.push(title + ":");
        instructionLines(node.itemListElement, out, depth + 1);
      } else {
        instructionLines(node.text || node.name || "", out, depth + 1);
      }
    }
    return out;
  }

  const GUESS = [["breakfast", /(^|[^a-z0-9_])(breakfast|brunch)(?![a-z0-9_])/i], ["sides", /(^|[^a-z0-9_])(sides?|side dish)(?![a-z0-9_])/i],
    ["appetizer", /(^|[^a-z0-9_])(appetizers?|starters?|hors d'oeuvres?|finger foods?)(?![a-z0-9_])/i],
    ["lunch", /(^|[^a-z0-9_])(lunch|sandwich|salad|soup)(?![a-z0-9_])/i]];

  /** Categories for an imported recipe, from what the site calls it. Dinner unless it says otherwise. */
  function guessTypes(recipe) {
    const text = asList(recipe.recipeCategory).concat(asList(recipe.name)).map(cleanText).join(" ");
    const types = GUESS.filter(([, rx]) => rx.test(text)).map(([t]) => t);
    return types.length ? types : ["dinner"];
  }

  /**
   * Read the recipe from a web page's HTML. Returns {name, thumb, ingredients: [lines], parts: [{q, n}],
   * instructions, url, notes, types}, or null when the page has no recipe data we can read.
   */
  function extractRecipe(html, pageUrl) {
    const rx = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
    let recipe = null, m;
    while (!recipe && (m = rx.exec(html || ""))) {
      const raw = m[1].replace(/^\s*<!--|-->\s*$/g, "").replace(/^\s*\/\/<!\[CDATA\[|\/\/\]\]>\s*$/g, "").trim();
      let data = null;
      try { data = JSON.parse(raw); } catch {
        try { data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")); } catch { data = null; }
      }
      recipe = findRecipe(data, 0);
    }
    if (!recipe) return null;
    const name = cleanText(asList(recipe.name)[0]);
    if (!name) return null;
    const lines = [];
    for (const x of asList(recipe.recipeIngredient || recipe.ingredients)) {
      for (const part of (typeof x === "string" ? x.split(/\r?\n/) : [])) {
        const t = cleanText(part);
        if (t && lines[lines.length - 1] !== t) lines.push(t);
      }
    }
    const ingredients = lines.slice(0, 80);
    const servings = cleanText(asList(recipe.recipeYield).map(String).find((y) => /[0-9]/.test(y)) || asList(recipe.recipeYield)[0] || "");
    const time = formatDuration(recipe.totalTime) || formatDuration(recipe.cookTime) || "";
    let site = "";
    try { site = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { site = ""; }
    const notes = [servings ? (/^[0-9]+$/.test(servings) ? "Serves " + servings : servings) : "", time, site ? "from " + site : ""]
      .filter(Boolean).join(" \u00b7 ");
    return {
      name, thumb: imageUrl(recipe.image, pageUrl), ingredients, parts: ingredients.map(parseIngredientLine),
      instructions: instructionLines(recipe.recipeInstructions, [], 0).join("\n"), url: pageUrl, notes,
      types: guessTypes(recipe),
    };
  }

  /** A meal's ingredients as editable lines ("2 cloves garlic"). */
  function ingredientLines(meal) {
    if (meal && meal.ingredients && meal.ingredients.length) return meal.ingredients.slice();
    return ((meal && meal.parts) || []).map((p) => (p.q + " " + p.n).trim());
  }

  /**
   * Save edited ingredient lines and steps onto a meal. Unchanged lines keep their original split into
   * amount and name; edited lines are split again. Must match apply_recipe_edits() in meal_planner.pyw.
   */
  function applyRecipeEdits(meal, ingredientsText, instructions) {
    const lines = String(ingredientsText || "").split(/\r?\n/).map((l) => cleanText(l)).filter(Boolean);
    const before = ingredientLines(meal);
    const oldParts = meal.parts && meal.parts.length === before.length ? meal.parts : before.map(parseIngredientLine);
    const out = Object.assign({}, meal, {
      ingredients: lines,
      parts: lines.map((l) => { const i = before.indexOf(l); return i >= 0 ? oldParts[i] : parseIngredientLine(l); }),
      instructions: String(instructions || "").replace(/\r\n/g, "\n").trim(),
    });
    if (!lines.length) { delete out.ingredients; delete out.parts; }
    if (!out.instructions) delete out.instructions;
    return out;
  }

  /** A web address the user pasted, tidied up, or "" if it isn't one. */
  function normalizeUrl(text) {
    const t = String(text || "").trim().replace(/^<|>$/g, "");
    const found = t.match(/https?:\/\/[^\s"'<>]+/i);
    const candidate = found ? found[0] : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t) ? "https://" + t : "";
    try { const u = new URL(candidate); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; }
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

  // ------------------------------------------------------------ family sync (Supabase)

  class SyncError extends Error {}

  /** Tiny Supabase client: sign-in with an emailed code, and calls to the functions in supabase/schema.sql. */
  class Supabase {
    constructor(url, anonKey, fetchFn) {
      this.url = (url || "").replace(/\/+$/, "");
      this.key = anonKey || "";
      this.fetch = fetchFn || fetch.bind(root);
    }
    get configured() { return !!(this.url && this.key && !this.url.includes("YOUR-PROJECT")); }

    /** POST JSON (or, with `type`, raw bytes such as a photo) and return the JSON reply. */
    async request(path, body, token, type) {
      if (!this.configured) throw new SyncError("Family sharing isn't set up in this copy of the app yet.");
      let resp;
      try {
        resp = await this.fetch(this.url + path, {
          method: "POST", cache: "no-store", body: type ? body : JSON.stringify(body || {}),
          // Publishable keys go only in `apikey`; Authorization carries a signed-in person's token.
          headers: Object.assign({ apikey: this.key, "Content-Type": type || "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
        });
      } catch {
        throw new SyncError("Couldn't connect \u2014 check your internet connection.");
      }
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (resp.ok) return json;
      const msg = (json && (json.message || json.msg || json.error_description)) || "";
      const err = new SyncError(msg || "Server error " + resp.status);
      err.status = resp.status;
      err.code = json && (json.code || json.error_code);
      throw err;
    }

    /**
     * Sign this device in (Supabase "anonymous sign-in"): it gets its own private account with no email or
     * password. The session is the device's key to its family, so the apps keep it until the device leaves.
     */
    async signInAnonymously() {
      try {
        return this.toSession(await this.request("/auth/v1/signup", { data: {} }));
      } catch (e) {
        if (e.status === 422 || e.status === 400 || /anonymous/i.test(e.message)) {
          const err = new SyncError("Family sharing needs anonymous sign-ins turned on in Supabase " +
            "(Authentication \u2192 Sign In / Providers \u2192 Allow anonymous sign-ins).");
          err.anonymousOff = true;
          throw err;
        }
        if (e.status === 429) throw new SyncError("Too many devices signed in from here recently \u2014 try again in a while.");
        throw e;
      }
    }

    async refresh(session) {
      try {
        return this.toSession(await this.request("/auth/v1/token?grant_type=refresh_token",
          { refresh_token: session.refresh_token }));
      } catch (e) {
        if (e.status && e.status < 500) {
          const err = new SyncError("You've been signed out. Please sign in again.");
          err.signedOut = true;
          throw err;
        }
        throw e;
      }
    }

    toSession(r) {
      return { access_token: r.access_token, refresh_token: r.refresh_token,
        expires_at: Date.now() + (r.expires_in || 3600) * 1000, email: (r.user && r.user.email) || "",
        user_id: (r.user && r.user.id) || "" };
    }

    rpc(name, args, token) { return this.request("/rest/v1/rpc/" + name, args, token); }

    /** The web address anyone can view a stored photo at. */
    photoUrl(path) { return this.url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + path; }
  }

  // Photos added from a phone or computer are shrunk before they're saved: to PHOTO_MAX pixels when they go
  // in the family's online folder, or PHOTO_LOCAL_MAX when there's no family and the photo is kept inside the meal.
  const PHOTO_BUCKET = "meal-photos", PHOTO_MAX = 800, PHOTO_LOCAL_MAX = 480, PHOTO_QUALITY = 0.75;
  /** Width and height to shrink a w x h photo to, so its longest side is at most `max`. */
  function photoSize(w, h, max) {
    const k = Math.min(1, (max || PHOTO_MAX) / Math.max(w, h, 1));
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
  }
  /** A new file name in the family's photo folder: "<family id>/<time>-<random>.jpg". */
  const photoPath = (familyId) => familyId + "/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + ".jpg";
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  /** Base64 text (or a data: URL) to bytes, for uploading a photo the phone gave us as base64. */
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/^data:[^,]*,/, "").replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, acc = 0, j = 0;
    for (let i = 0; i < clean.length; i++) {
      acc = (acc << 6) | B64.indexOf(clean[i]);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[j++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, j);
  }

  /**
   * One signed-in person's connection to Supabase. `auth` = { get(): session, set(session) } so the
   * app decides where the session is stored. Refreshes the session when it's about to expire.
   */
  class FamilyAccount {
    constructor(sb, auth) { this.sb = sb; this.auth = auth; }
    get signedIn() { return !!(this.auth.get() && this.auth.get().refresh_token); }

    /** Sign this device in if it isn't yet (there are no emails or passwords). */
    async ensureSignedIn() {
      if (!this.signedIn) this.auth.set(await this.sb.signInAnonymously());
      return this.auth.get();
    }

    async token() {
      let session = this.auth.get();
      if (!session) { const e = new SyncError("Please sign in first."); e.signedOut = true; throw e; }
      if (session.expires_at - Date.now() < 60000) {
        session = Object.assign(await this.sb.refresh(session), { email: session.email || "" });
        this.auth.set(session);
      }
      return session.access_token;
    }

    async call(name, args) {
      try {
        return await this.sb.rpc(name, args || {}, await this.token());
      } catch (e) {
        if (e.status === 401) { // token expired early: refresh once and retry
          const s = this.auth.get();
          if (s) { this.auth.set(Object.assign(s, { expires_at: 0 })); return this.sb.rpc(name, args || {}, await this.token()); }
        }
        throw e;
      }
    }

    myFamilies() { return this.call("my_families"); }
    /** Fetch a recipe web page through the family's "import-recipe" Edge Function (for the web app). */
    async fetchPage(url) {
      try {
        return await this.sb.request("/functions/v1/import-recipe", { url }, await this.token());
      } catch (e) {
        if (e.status === 404) throw new SyncError("Recipe import isn't set up for the web app yet (the import-recipe function).");
        throw e;
      }
    }
    /** Save a JPEG photo (bytes or Blob) in the family's folder; returns its web address. */
    async uploadPhoto(familyId, bytes) {
      const path = photoPath(familyId);
      try {
        await this.sb.request("/storage/v1/object/" + PHOTO_BUCKET + "/" + path, bytes, await this.token(), "image/jpeg");
      } catch (e) {
        if (e.status === 404 || /bucket not found/i.test(e.message))
          throw new SyncError("Photo uploads aren't set up yet — run the latest supabase/schema.sql.");
        if (e.status === 403 || /row-level security|violates/i.test(e.message))
          throw new SyncError("Couldn't save the photo — you're not in this family any more.");
        throw e;
      }
      return this.sb.photoUrl(path);
    }
    createFamily(name, displayName) { return this.call("create_family", { p_name: name, p_display_name: displayName || "" }); }
    createInvite(familyId) { return this.call("create_invite", { p_family: familyId }); }
    joinFamily(code, displayName) { return this.call("join_family", { p_code: code, p_display_name: displayName || "" }); }
    leaveFamily(familyId) { return this.call("leave_family", { p_family: familyId }); }
    removeMember(familyId, userId) { return this.call("remove_member", { p_family: familyId, p_user: userId }); }
    setDisplayName(familyId, name) { return this.call("set_display_name", { p_family: familyId, p_display_name: name }); }
  }

  /** The family's shared planner. pull()/push() work like a versioned file: push fails with .conflict if someone saved first. */
  class FamilyStore {
    constructor(account, familyId) { this.account = account; this.familyId = familyId; }
    async pull() {
      const r = await this.account.call("get_family_data", { p_family: this.familyId });
      const empty = !r.doc || !Object.keys(r.doc).length;
      return { data: empty ? null : r.doc, sha: r.version };
    }
    async push(data, version) {
      const r = await this.account.call("put_family_data",
        { p_family: this.familyId, p_doc: data, p_expected_version: version || 0 });
      if (!r.ok) {
        const e = new SyncError("Saved at the same moment on another phone \u2014 trying again.");
        e.conflict = true;
        throw e;
      }
      return r.version;
    }
  }

  // Family roles: the computer that started the family is the owner; the first phone to join is the primary
  // household member. Both can invite and remove people.
  const ROLE_LABELS = { owner: "Family computer", primary: "Primary", member: "" };
  const canManage = (family) => !!family && (family.role === "owner" || family.role === "primary");

  /**
   * An invite QR code as an SVG path. `qrcode` is the qrcode-generator library (docs/vendor/qrcode.js).
   * Returns {size, path}: draw `path` in a size x size viewBox (it includes the 2-module quiet zone).
   */
  function qrSvgPath(qrcode, text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), parts = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) parts.push(`M${c + 2} ${r + 2}h1v1h-1z`);
    return { size: n + 4, path: parts.join("") };
  }

  /** "ABCD-EFGH" style for display; accepts codes typed any way. */
  const formatInviteCode = (code) => { const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c; };

  const MP = {
    API, DAYS, SOURCES, MEAL_TYPES, FAV_TABS, TYPE_TAGS, PROTEINS, ALL_CUISINES, AREA_FIX, REGIONS,
    PLAN_KEYS, SETTINGS_KEYS, mealTypes, proteins, parseMeal, CATEGORIES, fetchIndex, fetchDetails, searchIngredient, thumbUrl, isoDate, parseIso,
    addDays, weekStartOf, shortDate, dateRange, clone, normalizeData, slimMeal, canonical, stamp, mergeData,
    shuffled, pickAvoiding, weekText, AISLES, aisleOf, ingredientKey, mealParts, addToList, parseQuickItem, cleanText, parseIngredientLine, formatDuration, extractRecipe, normalizeUrl, ingredientLines, applyRecipeEdits, SyncError, Supabase, FamilyAccount, FamilyStore, formatInviteCode, ROLE_LABELS, canManage, qrSvgPath, sleep,
    PHOTO_MAX, PHOTO_LOCAL_MAX, PHOTO_QUALITY, photoSize, photoPath, base64ToBytes,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = MP;
  else root.MP = MP;
})(typeof globalThis !== "undefined" ? globalThis : this);
