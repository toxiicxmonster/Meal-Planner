"""Weekly Meal Planner - a simple desktop app.

Pages:
  This Week  - random 7-day menu drawn from Favorites, Explore, or both
  Explore    - a photo grid of new ideas from TheMealDB (https://www.themealdb.com)
  Favorites  - meals you already know you like; add them by hand or save from Explore

Data is saved to meal_data.json next to this file; photos are cached in image_cache/ and
TheMealDB's full recipe list is kept in recipe_catalog.json (refreshed weekly).
Requires Pillow for photos:  python -m pip install pillow
"""

import datetime
import hashlib
import io
import json
import queue
import random
import re
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
import os
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import messagebox, ttk

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageTk
except ImportError:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror("Missing Pillow",
                         "This app needs the Pillow library to show photos.\n\n"
                         "Open a terminal and run:\n    python -m pip install pillow")
    raise SystemExit(1)

try:
    import qrcode  # optional: shows a QR code for texting the menu from a phone
except ImportError:
    qrcode = None

HERE = Path(__file__).parent
DATA_FILE = HERE / "meal_data.json"
CATALOG_FILE = HERE / "recipe_catalog.json"
CATALOG_MAX_AGE_DAYS = 7
PAGE_SIZE = 100
CACHE_DIR = HERE / "image_cache"
API = "https://www.themealdb.com/api/json/v1/1/"
DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]  # weeks run Sat-Fri
SOURCES = [("favorites", "Favorites only"), ("mix", "Mix of both"), ("explore", "Explore only")]
MEAL_TYPES = [("all", "All"), ("breakfast", "Breakfast"), ("lunch", "Lunch"), ("dinner", "Dinner"),
              ("dessert", "Dessert"), ("sides", "Sides")]
FAV_TABS = [("all", "All"), ("dinner", "Dinner"), ("lunch", "Lunch"), ("breakfast", "Breakfast"),
            ("sides", "Sides")]
TYPE_TAGS = [("breakfast", "Breakfast"), ("lunch", "Lunch"), ("dinner", "Dinner"), ("sides", "Side")]
PROTEINS = [("seafood", "Seafood"), ("poultry", "Poultry"), ("beef", "Beef"), ("pork", "Pork"),
            ("lamb", "Lamb"), ("vegetarian", "Vegetarian")]

# TheMealDB mixes country and cuisine names; show them all as cuisines.
AREA_FIX = {"United States": "American", "France": "French", "Norway": "Norwegian", "India": "Indian",
            "Netherlands": "Dutch", "Argentina": "Argentinian", "Venezuela": "Venezuelan",
            "Slovakia": "Slovak", "Unknown": ""}
REGIONS = {
    "Asian": ["Chinese", "Filipino", "Indian", "Japanese", "Malaysian", "Thai", "Vietnamese"],
    "European": ["British", "Croatian", "Dutch", "French", "Greek", "Irish", "Italian", "Norwegian",
                 "Polish", "Portuguese", "Russian", "Slovak", "Spanish", "Ukrainian"],
    "North American": ["American", "Canadian"],
    "Latin American & Caribbean": ["Argentinian", "Jamaican", "Mexican", "Uruguayan", "Venezuelan"],
    "Middle Eastern & North African": ["Algerian", "Egyptian", "Moroccan", "Saudi Arabian", "Syrian",
                                       "Tunisian", "Turkish"],
    "African": ["Kenyan"],
    "Oceanian": ["Australian"],
}
ALL_CUISINES = "All cuisines"
PHONE_LINK_APP = r"shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App"
USER_AGENT = {"User-Agent": "Mozilla/5.0 (MealPlanner)"}

# Colors & fonts
BG = "#FFF8F1"
CARD = "#FFFFFF"
BORDER = "#EFE3D6"
TEXT = "#2F2A26"
MUTED = "#8C8279"
ACCENT = "#E4572E"
ACCENT_DARK = "#C0441F"
ACCENT_SOFT = "#FDE7DF"
GREEN = "#3D9A5B"
GHOST = "#F3ECE4"
GHOST_DARK = "#E6DCD1"
PASTELS = ["#F6C9A8", "#F4D58D", "#B8DDB1", "#A9D3E8", "#D5C1EC", "#F2B8C6", "#C9D7A6"]
F = "Segoe UI"


# ---------------------------------------------------------------- data / web

def week_start_of(day):
    """The Saturday on or before `day` (weeks run Saturday to Friday)."""
    return day - datetime.timedelta(days=(day.weekday() - 5) % 7)


def date_range(start_iso):
    start = datetime.date.fromisoformat(start_iso)
    end = start + datetime.timedelta(days=6)
    return f"{start:%b} {start.day} \u2013 {end:%b} {end.day}"


def load_data():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.setdefault("favorites", [])
    data.pop("explore", None)
    data.pop("side_catalog", None)
    data.setdefault("source", "mix")
    week = data.get("week") or []
    data["week"] = (week + [None] * 7)[:7]
    kept = data.get("kept") or []
    data["kept"] = (kept + [False] * 7)[:7]
    sides = data.get("sides") or []
    data["sides"] = (sides + [None] * 7)[:7]
    data.setdefault("filters", {})
    data["filters"].setdefault("type", "all")
    data["filters"].setdefault("leave_out", [])
    data["filters"].setdefault("cuisine", ALL_CUISINES)
    data.setdefault("history", [])  # past weeks, oldest first: {"start", "week", "sides"}
    if "week_start" in data and data.get("week_layout") != "sat-fri":
        # Older versions ran weeks Monday-Sunday: keep each meal on the same weekday, in a Sat-Fri week.
        reorder = lambda days: [days[(i + 5) % 7] for i in range(7)]
        for w in [data] + data["history"]:
            for key in ("week", "sides", "kept"):
                if key in w:
                    w[key] = reorder(w[key])
            key = "week_start" if w is data else "start"
            w[key] = (datetime.date.fromisoformat(w[key]) + datetime.timedelta(days=5)).isoformat()
    data["week_layout"] = "sat-fri"
    data.setdefault("week_start", week_start_of(datetime.date.today()).isoformat())
    return data


def load_catalog():
    """Returns (meals, is_fresh). Meals is [] if the catalog has never been downloaded."""
    try:
        cat = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
        age = datetime.date.today() - datetime.date.fromisoformat(cat["date"])
        return cat["meals"], age.days < CATALOG_MAX_AGE_DAYS
    except (OSError, ValueError, KeyError):
        return [], False


def save_catalog(meals):
    CATALOG_FILE.write_text(json.dumps({"date": datetime.date.today().isoformat(), "meals": meals}),
                            encoding="utf-8")


def save_data(data):
    DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def api_get(endpoint, **params):
    url = API + endpoint
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                return json.load(resp).get("meals") or []
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:  # 429 = TheMealDB asking us to slow down
                raise
            time.sleep(2 * (attempt + 1))


def parse_meal(m):
    ingredients = []
    for i in range(1, 21):
        ing = (m.get(f"strIngredient{i}") or "").strip()
        meas = (m.get(f"strMeasure{i}") or "").strip()
        if ing:
            ingredients.append(f"{meas} {ing}".strip())
    return {
        "id": m["idMeal"],
        "name": m["strMeal"],
        "category": m.get("strCategory") or "",
        "area": AREA_FIX.get(m.get("strArea") or "", m.get("strArea") or ""),
        "thumb": m.get("strMealThumb") or "",
        "ingredients": ingredients,
        "instructions": m.get("strInstructions") or "",
        "url": m.get("strSource") or f"https://www.themealdb.com/meal/{m['idMeal']}",
        "youtube": m.get("strYoutube") or "",
    }


def fetch_catalog(progress):
    """Download every TheMealDB recipe, one first letter at a time (their search caps other queries at 25).
    Calls progress(done, total) from the worker thread."""
    letters = "abcdefghijklmnopqrstuvwxyz0123456789"
    meals = {}
    for i, ch in enumerate(letters):
        for m in api_get("search.php", f=ch):
            meals[m["idMeal"]] = parse_meal(m)
        progress(i + 1, len(letters))
        time.sleep(0.25)
    return sorted(meals.values(), key=lambda m: m["name"].lower())


# ---------------------------------------------------------------- meal types & proteins
# TheMealDB only has categories (Beef, Dessert, Side...), so meal type and protein are
# worked out from the category plus keywords in the name and ingredients.

def word_re(words):
    return re.compile(r"\b(?:" + "|".join(words) + r")(?:s|es)?\b", re.I)


PROTEIN_WORDS = {
    "seafood": word_re(["fish", "salmon", "tuna", "cod", "haddock", "prawn", "shrimp", "crab", "lobster",
                        "mussel", "clam", "squid", "octopus", "anchovy", "anchovies", "sardine", "mackerel",
                        "scallop", "oyster", "seafood", "kedgeree", "tilapia", "trout", "halibut",
                        "monkfish", "calamari", "sea bass", "saltfish", "codfish", "shellfish", "catfish",
                        "swordfish", "whitefish", "fishcake", "herring", "eel", "caviar", "ackee and saltfish"]),
    "poultry": word_re(["chicken", "turkey", "duck", "goose", "poussin", "quail"]),
    "beef": word_re(["beef", "steak", "veal", "brisket", "oxtail", "burger", "slider", "meatloaf",
                     "cheesesteak", "sloppy joe", "meatball", "french dip"]),
    "pork": word_re(["pork", "porkchop", "bacon", "ham", "sausage", "chorizo", "prosciutto", "pancetta",
                     "salami", "pepperoni", "kielbasa", "lardon", "gammon", "stromboli"]),
    "lamb": word_re(["lamb", "goat", "mutton", "hogget", "kleftiko", "moussaka"]),
}
OTHER_MEAT = word_re(["venison", "rabbit", "boar"])
CATEGORY_PROTEIN = {"Seafood": "seafood", "Chicken": "poultry", "Beef": "beef", "Pork": "pork",
                    "Lamb": "lamb", "Goat": "lamb"}
LUNCH_WORDS = word_re(["soup", "salad", "sandwich", "wrap", "burger", "slider", "quesadilla", "taco",
                       "burrito", "toastie", "panini", "bagel", "pizza", "grilled cheese",
                       "cheesesteak", "dip", "sub", "stromboli", "chowder"])


TYPE_WORDS = {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner", "side": "sides", "sides": "sides",
              "dessert": "dessert"}


def meal_types(m):
    if m.get("types"):  # set by the user on the Favorites page
        return set(m["types"])
    cat, name = m.get("category") or "", m["name"]
    named = {TYPE_WORDS[w.strip().lower()] for w in cat.split(",") if w.strip().lower() in TYPE_WORDS}
    if named:  # typed by hand, e.g. "Pasta, Dinner"
        return named
    if cat == "Dessert":
        return {"dessert"}
    if cat == "Breakfast":
        return {"breakfast"}
    if cat == "Side":
        return {"sides"}
    if cat in ("Starter", "Soup", "Salad"):
        return {"lunch", "dinner"} if cat != "Starter" else {"lunch"}
    types = {"dinner"}
    if cat in ("Pasta", "Miscellaneous", "Vegetarian", "Vegan") or LUNCH_WORDS.search(name):
        types.add("lunch")
    return types


def proteins(m):
    cat = m.get("category") or ""
    if cat in ("Vegetarian", "Vegan"):
        return {"vegetarian"}
    text = " ".join([m["name"]] + m.get("ingredients", []))
    found = {p for p, rx in PROTEIN_WORDS.items() if rx.search(text)}
    if cat in CATEGORY_PROTEIN:
        found.add(CATEGORY_PROTEIN[cat])
    if not found and cat != "Dessert" and not OTHER_MEAT.search(text):
        found.add("vegetarian")
    return found


def fetch_by_ids(ids):
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = pool.map(lambda i: api_get("lookup.php", i=i), ids)
    return {m["idMeal"]: parse_meal(m) for batch in results for m in batch}


def thumb_url(url, size):
    """TheMealDB serves smaller versions of its photos at <url>/small and <url>/medium."""
    if url and "themealdb.com/images/" in url:
        return url + ("/small" if size[0] <= 250 else "/medium")
    return url


# ---------------------------------------------------------------- images

class ImageLoader:
    """Downloads photos in the background, caches them on disk, and hands back PhotoImages."""

    def __init__(self, app):
        self.app = app
        self.photos = {}
        self.waiting = {}
        self.pool = ThreadPoolExecutor(max_workers=4)
        CACHE_DIR.mkdir(exist_ok=True)

    def get(self, url, size, name, on_ready):
        """Return a photo now (the real one if cached, else a placeholder); call on_ready(photo) once loaded."""
        url = thumb_url(url, size)
        if not url:
            return self.placeholder(name, size)
        key = (url, size)
        if key in self.photos:
            return self.photos[key] or self.placeholder(name, size)
        self.waiting.setdefault(key, []).append(on_ready)
        if len(self.waiting[key]) == 1:
            self.pool.submit(self._load, url, size, key)
        return self.placeholder(name, size)

    def _load(self, url, size, key):
        try:
            cache = CACHE_DIR / (hashlib.sha1(url.encode()).hexdigest() + ".img")
            if cache.exists():
                raw = cache.read_bytes()
            else:
                req = urllib.request.Request(url, headers=USER_AGENT)
                for attempt in range(4):
                    try:
                        with urllib.request.urlopen(req, timeout=15) as resp:
                            raw = resp.read()
                        break
                    except urllib.error.HTTPError as e:
                        if e.code != 429 or attempt == 3:
                            raise
                        time.sleep(2 * (attempt + 1))
                cache.write_bytes(raw)
            img = ImageOps.fit(Image.open(io.BytesIO(raw)).convert("RGB"), size, Image.LANCZOS)
        except Exception:
            img = None
        self.app.call_on_ui(lambda: self._deliver(key, img))

    def _deliver(self, key, img):
        photo = ImageTk.PhotoImage(img) if img else None
        if photo:  # failures aren't remembered, so the photo is retried next time it's shown
            self.photos[key] = photo
        for cb in self.waiting.pop(key, []):
            if photo:
                cb(photo)

    def placeholder(self, name, size):
        letter = (name or "?").strip()[:1].upper() or "?"
        color = PASTELS[sum(map(ord, name or "?")) % len(PASTELS)]
        key = ("placeholder", letter, color, size)
        if key not in self.photos:
            img = Image.new("RGB", size, color)
            draw = ImageDraw.Draw(img)
            try:
                font = ImageFont.truetype("segoeuib.ttf", size[1] // 2)
            except OSError:
                font = ImageFont.load_default()
            box = draw.textbbox((0, 0), letter, font=font)
            xy = ((size[0] - box[2] - box[0]) / 2, (size[1] - box[3] - box[1]) / 2)
            draw.text(xy, letter, fill="white", font=font)
            self.photos[key] = ImageTk.PhotoImage(img)
        return self.photos[key]


def set_photo(loader, label, url, size, name):
    """Show a photo in a label, swapping in the real image when it finishes downloading."""
    def ready(photo):
        if label.winfo_exists():
            label.config(image=photo)
            label.image = photo
    photo = loader.get(url, size, name, ready)
    label.config(image=photo)
    label.image = photo


# ---------------------------------------------------------------- widgets

def button(parent, text, command, kind="primary", small=False, **kw):
    b = tk.Button(parent, text=text, command=command, relief="flat", bd=0, cursor="hand2",
                  font=(F, 9 if small else 10, "bold"), padx=8 if small else 14, pady=3 if small else 6, **kw)
    style_button(b, kind)
    b.bind("<Enter>", lambda e: b["state"] != "disabled" and b.config(bg=b.hover_bg))
    b.bind("<Leave>", lambda e: b.config(bg=b.base_bg))
    return b


def style_button(b, kind):
    bg, fg, hover = {
        "primary": (ACCENT, "white", ACCENT_DARK),
        "soft": (ACCENT_SOFT, ACCENT_DARK, "#F9D3C5"),
        "ghost": (GHOST, TEXT, GHOST_DARK),
        "done": (ACCENT, "white", ACCENT),
    }[kind]
    b.base_bg, b.hover_bg = bg, hover
    b.config(bg=bg, fg=fg, activebackground=hover, activeforeground=fg, disabledforeground=fg)


class Tooltip:
    def __init__(self, widget, text):
        self.widget, self.text, self.tip, self.job = widget, text, None, None
        widget.bind("<Enter>", self.schedule, add="+")
        widget.bind("<Leave>", self.hide, add="+")
        widget.bind("<ButtonPress>", self.hide, add="+")

    def schedule(self, _):
        self.job = self.widget.after(450, self.show)

    def show(self):
        if not self.widget.winfo_exists():
            return
        x = self.widget.winfo_rootx() + 10
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 4
        self.tip = tk.Toplevel(self.widget)
        self.tip.wm_overrideredirect(True)
        self.tip.wm_geometry(f"+{x}+{y}")
        tk.Label(self.tip, text=self.text, bg=TEXT, fg="white", font=(F, 9), padx=8, pady=4).pack()

    def hide(self, _=None):
        if self.job:
            self.widget.after_cancel(self.job)
            self.job = None
        if self.tip:
            self.tip.destroy()
            self.tip = None


class PlaceholderEntry(tk.Entry):
    def __init__(self, parent, placeholder, **kw):
        super().__init__(parent, relief="flat", font=(F, 10), bg=CARD, fg=MUTED,
                         highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT, **kw)
        self.placeholder = placeholder
        self.showing = True
        self.insert(0, placeholder)
        self.bind("<FocusIn>", self._focus_in)
        self.bind("<FocusOut>", self._focus_out)

    def _focus_in(self, _):
        if self.showing:
            self.delete(0, "end")
            self.config(fg=TEXT)
            self.showing = False

    def _focus_out(self, _):
        if not super().get():
            self.insert(0, self.placeholder)
            self.config(fg=MUTED)
            self.showing = True

    def get(self):
        return "" if self.showing else super().get()


class ScrollGrid(tk.Frame):
    """A scrollable area that lays cards out in as many columns as fit the window."""

    def __init__(self, parent, card_width, gap=16):
        super().__init__(parent, bg=BG)
        self.card_width, self.gap = card_width, gap
        self.canvas = tk.Canvas(self, bg=BG, highlightthickness=0)
        sb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.inner = tk.Frame(self.canvas, bg=BG)
        self.window = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.layout())
        self.cards, self.cols = [], 0

    def set_cards(self, cards, empty_message=""):
        for child in self.inner.winfo_children():
            if child not in cards:
                child.destroy()
        self.cards, self.cols = cards, 0
        if not cards and empty_message:
            tk.Label(self.inner, text=empty_message, bg=BG, fg=MUTED, font=(F, 12),
                     justify="center", pady=60).grid(row=0, column=0)
        self.layout()

    def layout(self):
        if self.cards:  # use the real card size, in case content made cards wider than planned
            self.card_width = max(self.card_width, max(c.winfo_reqwidth() for c in self.cards))
        width = max(self.canvas.winfo_width(), self.card_width + 2 * self.gap)
        cols = max(1, (width - self.gap) // (self.card_width + self.gap))
        if cols != self.cols:
            self.cols = cols
            for c in range(cols):
                self.inner.grid_columnconfigure(c, minsize=self.card_width + self.gap, uniform="card")
            for i, card in enumerate(self.cards):
                card.grid(row=i // cols, column=i % cols, padx=(self.gap, 0), pady=(0, self.gap), sticky="nsew")
        used = min(cols, max(len(self.cards), 1)) * (self.card_width + self.gap) + self.gap
        self.canvas.coords(self.window, max(0, (width - used) // 2), 0)

    def scroll(self, delta):
        if self.inner.winfo_reqheight() > self.canvas.winfo_height():
            self.canvas.yview_scroll(-delta // 120, "units")

    def to_top(self):
        self.canvas.yview_moveto(0)


def meal_card(parent, loader, meal, img_size, on_open=None, show_category=True):
    """A white card with the meal photo, name, and subtitle. Returns (card, body) — add buttons to body."""
    card = tk.Frame(parent, bg=CARD, highlightthickness=1, highlightbackground=BORDER)
    img = tk.Label(card, bg=CARD, bd=0, cursor="hand2" if on_open else "")
    img.pack()
    set_photo(loader, img, meal.get("thumb"), img_size, meal["name"])
    body = tk.Frame(card, bg=CARD, padx=10, pady=8)
    body.pack(fill="both", expand=True)
    name = tk.Label(body, text=meal["name"], bg=CARD, fg=TEXT, font=(F, 11, "bold"),
                    wraplength=img_size[0] - 20, justify="left", anchor="w", cursor="hand2" if on_open else "")
    name.pack(fill="x")
    sub = " · ".join(x for x in (show_category and meal.get("category"), meal.get("area")) if x)
    if sub:
        tk.Label(body, text=sub, bg=CARD, fg=MUTED, font=(F, 9), anchor="w").pack(fill="x")
    if on_open:
        img.bind("<Button-1>", lambda e: on_open())
        name.bind("<Button-1>", lambda e: on_open())
    return card, body


# ---------------------------------------------------------------- app

class MealPlanner(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Weekly Meal Planner")
        self.geometry("1400x840")
        self.minsize(720, 520)
        self.configure(bg=BG)
        self.data = load_data()
        self.ui_queue = queue.Queue()
        self.images = ImageLoader(self)
        self.save_buttons = []  # (button, meal name) pairs to update when Favorites change
        self.catalog, catalog_fresh = load_catalog()
        self.catalog_by_id = {m["id"]: m for m in self.catalog}
        self.catalog_waiting = None  # callbacks to run once a catalog download finishes
        self.explore_order = self.shuffled_ids()
        self.explore_limit = PAGE_SIZE
        self.search_job = None
        self.poll_ui_queue()

        ttk.Style(self).theme_use("clam")
        ttk.Style(self).configure("Vertical.TScrollbar", background=GHOST, troughcolor=BG,
                                  bordercolor=BG, arrowcolor=MUTED, lightcolor=GHOST, darkcolor=GHOST)
        ttk.Style(self).configure("TCombobox", fieldbackground=CARD, background=CARD)

        self.build_header()
        self.pages_frame = tk.Frame(self, bg=BG)
        self.pages_frame.pack(fill="both", expand=True)
        self.pages = {
            "week": self.build_week_page(),
            "explore": self.build_explore_page(),
            "favorites": self.build_fav_page(),
        }
        for page in self.pages.values():
            page.place(relx=0, rely=0, relwidth=1, relheight=1)

        self.toast = tk.Label(self, bg=TEXT, fg="white", font=(F, 10), padx=16, pady=8)
        self.toast_job = None

        self.bind_all("<MouseWheel>", self.on_mousewheel)
        self.viewing_last = False
        self.roll_over_week()
        self.refresh_week()
        self.refresh_explore()
        self.refresh_favs()
        self.show_page("week")

        if not self.catalog:
            self.ensure_catalog()
        elif not catalog_fresh:
            self.ensure_catalog(quiet=True)  # refresh last week's list in the background
        self.backfill_photos()

    # ------------------------------------------------------------ plumbing

    def save(self):
        save_data(self.data)

    def call_on_ui(self, fn):
        """Thread-safe: schedule fn to run on the Tk main thread."""
        self.ui_queue.put(fn)

    def poll_ui_queue(self):
        try:
            while True:
                self.ui_queue.get_nowait()()
        except queue.Empty:
            pass
        self.after(50, self.poll_ui_queue)

    def run_in_background(self, work, on_done, busy_msg):
        self.notify(busy_msg, sticky=True)

        def worker():
            try:
                result, error = work(), None
            except Exception as e:  # network errors, bad JSON, etc.
                result, error = None, e
            self.call_on_ui(lambda: on_done(result, error))

        threading.Thread(target=worker, daemon=True).start()

    def notify(self, message, sticky=False):
        self.toast.config(text=message)
        self.toast.place(relx=0.5, rely=1.0, y=-20, anchor="s")
        self.toast.lift()
        if self.toast_job:
            self.after_cancel(self.toast_job)
            self.toast_job = None
        if not sticky:
            self.toast_job = self.after(2800, self.toast.place_forget)

    def on_mousewheel(self, e):
        try:
            top = e.widget.winfo_toplevel()
            if isinstance(e.widget, tk.Text):
                return
        except (AttributeError, KeyError, tk.TclError):
            return
        if top is self:
            self.pages[self.current_page].cards.scroll(e.delta)
        elif getattr(top, "scroll_grid", None):  # e.g. the favorite picker
            top.scroll_grid.scroll(e.delta)

    def all_meals(self):
        return self.data["favorites"] + [m for m in self.data["week"] + self.data["sides"] if m]

    def backfill_photos(self):
        """Meals saved by older versions of the app have no photo link - look them up once."""
        ids = {m["id"] for m in self.all_meals() if m.get("id") and "thumb" not in m}
        if not ids:
            return

        def done(found, error):
            if error:
                return
            for m in self.all_meals():
                if m.get("id") in found and "thumb" not in m:
                    m["thumb"] = found[m["id"]]["thumb"]
            self.save()
            self.refresh_week()
            self.refresh_favs()
            self.toast.place_forget()
        self.run_in_background(lambda: fetch_by_ids(sorted(ids)), done, "Loading photos…")

    # ------------------------------------------------------------ recipe catalog

    def shuffled_ids(self):
        ids = [m["id"] for m in self.catalog]
        random.shuffle(ids)
        return ids

    def ensure_catalog(self, then=None, quiet=False):
        """Make sure the full recipe list is downloaded, then call `then`."""
        if self.catalog and not quiet:
            return then and then()
        if self.catalog_waiting is not None:  # already downloading
            if then:
                self.catalog_waiting.append(then)
            return
        self.catalog_waiting = [then] if then else []

        def progress(done, total):
            if not quiet:
                self.call_on_ui(lambda: self.notify(
                    f"Downloading recipes from TheMealDB\u2026 {round(100 * done / total)}%", sticky=True))

        def finished(meals, error):
            waiting, self.catalog_waiting = self.catalog_waiting, None
            if error or not meals:
                if not quiet:
                    self.notify("Couldn't reach TheMealDB \u2014 check your internet connection")
                return
            save_catalog(meals)
            self.catalog = meals
            self.catalog_by_id = {m["id"]: m for m in meals}
            self.explore_order = self.shuffled_ids()
            self.refresh_cuisine_menu()
            self.refresh_explore()
            if not quiet:
                self.notify(f"{len(meals)} recipes ready to explore")
            for fn in waiting:
                fn()

        if not quiet:
            self.notify("Downloading recipes from TheMealDB\u2026", sticky=True)
        threading.Thread(target=lambda: self._download_catalog(progress, finished), daemon=True).start()

    def _download_catalog(self, progress, finished):
        try:
            meals, error = fetch_catalog(progress), None
        except Exception as e:
            meals, error = None, e
        self.call_on_ui(lambda: finished(meals, error))

    def is_favorite(self, name):
        return any(f["name"].lower() == name.lower() for f in self.data["favorites"])

    def heart_button(self, parent, meal, small=True, on_saved=None):
        """A ♥ Save button that turns into ♥ Saved once the meal is in Favorites."""
        b = button(parent, "", lambda: (self.add_favorite(meal), on_saved and on_saved()), "soft", small=small)
        self.save_buttons.append((b, meal["name"]))
        self.update_heart(b, meal["name"])
        return b

    def update_heart(self, b, name):
        if self.is_favorite(name):
            b.config(text="♥ Saved", state="disabled", cursor="")
            style_button(b, "done")
        else:
            b.config(text="♡ Save", state="normal", cursor="hand2")
            style_button(b, "soft")

    def refresh_hearts(self):
        self.save_buttons = [(b, n) for b, n in self.save_buttons if b.winfo_exists()]
        for b, name in self.save_buttons:
            self.update_heart(b, name)

    # ------------------------------------------------------------ header / nav

    def build_header(self):
        bar = tk.Frame(self, bg=CARD, highlightthickness=1, highlightbackground=BORDER)
        bar.pack(fill="x")
        tk.Label(bar, text="☕  Meal Planner", bg=CARD, fg=ACCENT, font=(F, 16, "bold"),
                 padx=20, pady=12).pack(side="left")
        self.nav = {}
        for key, label in [("favorites", "♥  Favorites"), ("explore", "✨  Explore"),
                           ("week", "▦  This Week")]:
            lbl = tk.Label(bar, text=label, bg=CARD, fg=MUTED, font=(F, 11, "bold"),
                           padx=18, pady=8, cursor="hand2")
            lbl.pack(side="right", padx=(0, 6), pady=8)
            lbl.bind("<Button-1>", lambda e, k=key: self.show_page(k))
            self.nav[key] = lbl

    def show_page(self, key):
        self.current_page = key
        self.pages[key].tkraise()
        for k, lbl in self.nav.items():
            lbl.config(bg=ACCENT_SOFT if k == key else CARD, fg=ACCENT_DARK if k == key else MUTED)

    def page_header(self, page, title, subtitle):
        head = tk.Frame(page, bg=BG, padx=24, pady=16)
        head.pack(fill="x")
        left = tk.Frame(head, bg=BG)
        left.pack(side="left")
        title_lbl = tk.Label(left, text=title, bg=BG, fg=TEXT, font=(F, 18, "bold"), anchor="w")
        title_lbl.pack(anchor="w")
        tk.Label(left, text=subtitle, bg=BG, fg=MUTED, font=(F, 10), anchor="w").pack(anchor="w")
        right = tk.Frame(head, bg=BG)
        right.pack(side="right")
        return title_lbl, right

    # ------------------------------------------------------------ This Week

    def build_week_page(self):
        page = tk.Frame(self.pages_frame, bg=BG)
        self.week_title, actions = self.page_header(
            page, "This week",
            "Nothing from last week is repeated. \u21bb Swap changes one day; Keep holds a day.")
        button(actions, "Copy list", self.copy_week, "ghost").pack(side="right")
        button(actions, "\u27a4  Send", self.share_dialog, "ghost").pack(side="right", padx=(0, 8))
        self.plan_actions = tk.Frame(actions, bg=BG)
        self.plan_actions.pack(side="right")
        button(self.plan_actions, "\u21bb  Shuffle Week", self.shuffle_week).pack(side="right", padx=8)
        nxt = button(self.plan_actions, "Start next week \u2192", self.start_next_week, "soft")
        nxt.pack(side="right")
        Tooltip(nxt, "Move this plan to Last week and make a fresh menu for the week after")
        view = tk.Frame(actions, bg=GHOST, padx=3, pady=3)
        view.pack(side="right", padx=(0, 16))
        self.view_chips = {}
        for key, label in [(True, "\u25c0  Last week"), (False, "This week")]:
            chip = tk.Label(view, text=label, font=(F, 10), padx=12, pady=4, cursor="hand2")
            chip.pack(side="left")
            chip.bind("<Button-1>", lambda e, k=key: self.set_week_view(k))
            self.view_chips[key] = chip

        self.src_row = src_row = tk.Frame(page, bg=BG, padx=24)
        src_row.pack(fill="x", pady=(0, 12))
        tk.Label(src_row, text="Pick meals from:", bg=BG, fg=TEXT, font=(F, 10, "bold")).pack(side="left")
        seg = tk.Frame(src_row, bg=GHOST, padx=3, pady=3)
        seg.pack(side="left", padx=10)
        self.source_buttons = {}
        for key, label in SOURCES:
            lbl = tk.Label(seg, text=label, font=(F, 10), padx=14, pady=4, cursor="hand2")
            lbl.pack(side="left")
            lbl.bind("<Button-1>", lambda e, k=key: self.set_source(k))
            self.source_buttons[key] = lbl
        self.set_source(self.data["source"], save=False)

        page.cards = ScrollGrid(page, card_width=164, gap=12)
        page.cards.pack(fill="both", expand=True, padx=8)
        return page

    def set_source(self, key, save=True):
        self.data["source"] = key
        for k, lbl in self.source_buttons.items():
            lbl.config(bg=CARD if k == key else GHOST, fg=ACCENT_DARK if k == key else MUTED,
                       font=(F, 10, "bold" if k == key else "normal"))
        if save:
            self.save()

    def passes_leave_out(self, meal):
        return not (proteins(meal) & set(self.data["filters"]["leave_out"]))

    def explore_dinners(self):
        fav_names = {f["name"].lower() for f in self.data["favorites"]}
        return [m for m in self.catalog if "dinner" in meal_types(m) and self.passes_leave_out(m)
                and m["name"].lower() not in fav_names]

    def meal_pool(self):
        """Meals the week can be built from: dinners only (sides are added separately)."""
        src = self.data["source"]
        pool = []
        if src in ("favorites", "mix"):
            pool += [dict(m, origin="Favorite") for m in self.data["favorites"] if "dinner" in meal_types(m)]
        if src in ("explore", "mix"):
            pool += [dict(m, origin="Explore") for m in self.explore_dinners()]
        return pool

    # ---- weeks & history

    def last_week(self):
        return self.data["history"][-1] if self.data["history"] else None

    def last_week_names(self):
        last = self.last_week()
        if not last:
            return set()
        return {m["name"].lower() for m in last["week"] + last["sides"] if m}

    def archive_current_week(self):
        """Move the current plan into history (if anything was planned) and clear it."""
        if any(self.data["week"]):
            self.data["history"].append({"start": self.data["week_start"], "week": self.data["week"],
                                         "sides": self.data["sides"]})
            self.data["history"] = self.data["history"][-12:]
        self.data["week"] = [None] * 7
        self.data["kept"] = [False] * 7
        self.data["sides"] = [None] * 7
        return bool(self.data["history"])

    def roll_over_week(self):
        """When a new calendar week starts, last week's plan becomes 'Last week' and a fresh one is made."""
        this_start = week_start_of(datetime.date.today())
        if datetime.date.fromisoformat(self.data["week_start"]) >= this_start:
            return
        had_plan = any(self.data["week"])
        self.archive_current_week()
        self.data["week_start"] = this_start.isoformat()
        self.save()
        if had_plan:
            self.after(300, lambda: self.shuffle_week(message="It's a new week \u2014 here's a fresh menu "
                                                             "with nothing from last week."))

    def start_next_week(self):
        if any(self.data["week"]) and not messagebox.askyesno(
                "Start next week", "Move this week's plan to \u201cLast week\u201d and make a fresh menu "
                                   "for next week?\n\nNothing from this week will be repeated."):
            return
        start = datetime.date.fromisoformat(self.data["week_start"]) + datetime.timedelta(days=7)
        self.archive_current_week()
        self.data["week_start"] = start.isoformat()
        self.save()
        self.shuffle_week(message=f"Planning {date_range(self.data['week_start'])} \u2014 "
                                  "nothing from last week.")

    def set_week_view(self, last):
        self.viewing_last = last
        self.refresh_week()
        self.pages["week"].cards.to_top()

    @staticmethod
    def pick_avoiding(choices, count, avoid):
        """Randomly pick `count` meals, using ones not in `avoid` first and only topping up from them if needed."""
        fresh = [m for m in choices if m["name"].lower() not in avoid]
        stale = [m for m in choices if m["name"].lower() in avoid]
        random.shuffle(fresh)
        random.shuffle(stale)
        picks = (fresh + stale)[:count]
        while len(picks) < count and choices:  # fewer meals than days: repeats are unavoidable
            picks.append(random.choice(choices))
        reused = sum(1 for m in picks if m["name"].lower() in avoid)
        return picks, reused

    def explore_is_short(self):
        return self.data["source"] != "favorites" and not self.catalog

    def pool_or_warn(self):
        pool = self.meal_pool()
        if not pool:
            messagebox.showinfo("No meals yet", "Your Favorites list is empty.\n\nAdd some meals on the "
                                "Favorites page, or choose \"Mix of both\" / \"Explore only\".")
        return pool

    def shuffle_week(self, message=None):
        if self.viewing_last:
            self.viewing_last = False
        if self.explore_is_short():
            return self.ensure_catalog(then=lambda: self.shuffle_week(message))
        pool = self.pool_or_warn()
        if not pool:
            return self.refresh_week()
        kept = {m["name"] for m, k in zip(self.data["week"], self.data["kept"]) if m and k}
        open_days = [i for i in range(7) if not (self.data["week"][i] and self.data["kept"][i])]
        choices = [m for m in pool if m["name"] not in kept] or pool
        picks, reused = self.pick_avoiding(choices, len(open_days), self.last_week_names())
        for day, meal in zip(open_days, picks):
            self.data["week"][day] = meal
        self.save()
        self.refresh_week()
        if reused:
            self.notify(f"New menu! Only {len(pool)} meals to pick from, so {reused} "
                        f"{'is' if reused == 1 else 'are'} repeated from last week.")
        else:
            self.notify(message or f"New menu! Picked from {len(pool)} meals \u2014 nothing from last week.")

    def swap_day(self, day):
        if self.explore_is_short():
            return self.ensure_catalog(then=lambda: self.swap_day(day))
        pool = self.pool_or_warn()
        if not pool:
            return
        planned = {m["name"] for m in self.data["week"] if m}
        choices = [m for m in pool if m["name"] not in planned] or pool
        self.data["week"][day] = self.pick_avoiding(choices, 1, self.last_week_names())[0][0]
        self.data["kept"][day] = False
        self.save()
        self.refresh_week()

    def side_pool(self):
        fav_sides = [dict(m, origin="Favorite") for m in self.data["favorites"] if "sides" in meal_types(m)]
        if self.data["source"] == "favorites" and fav_sides:
            return fav_sides
        names = {m["name"].lower() for m in fav_sides}
        others = [m for m in self.catalog
                  if "sides" in meal_types(m) and self.passes_leave_out(m)
                  and m["name"].lower() not in names and not names.add(m["name"].lower())]
        return fav_sides + [dict(m, origin="Explore") for m in others]

    def randomize_side(self, day):
        pool = self.side_pool()
        if not self.catalog and not (self.data["source"] == "favorites" and pool):
            return self.ensure_catalog(then=lambda: self.randomize_side(day))
        if not pool:
            return self.notify("No side dishes match your filters")
        used = {s["name"] for s in self.data["sides"] if s}
        choices = [m for m in pool if m["name"] not in used] or pool
        self.data["sides"][day] = self.pick_avoiding(choices, 1, self.last_week_names())[0][0]
        self.save()
        self.refresh_week()

    def remove_side(self, day):
        self.data["sides"][day] = None
        self.save()
        self.refresh_week()

    def open_meal(self, meal):
        """Show a recipe, first fetching full details if we only have the name and photo."""
        if meal.get("id") in self.catalog_by_id and "instructions" not in meal:
            meal = dict(self.catalog_by_id[meal["id"]], origin=meal.get("origin"))
        if meal.get("id") and "instructions" not in meal:
            def done(found, error):
                if error or meal["id"] not in found:
                    return self.notify("Couldn't load that recipe")
                self.toast.place_forget()
                self.show_details(dict(found[meal["id"]], origin=meal.get("origin")))
            return self.run_in_background(lambda: fetch_by_ids([meal["id"]]), done, "Loading recipe…")
        self.show_details(meal)

    def toggle_keep(self, day):
        self.data["kept"][day] = not self.data["kept"][day]
        self.save()
        self.refresh_week()

    def refresh_week(self):
        for key, chip in self.view_chips.items():
            on = key == self.viewing_last
            chip.config(bg=CARD if on else GHOST, fg=ACCENT_DARK if on else MUTED,
                        font=(F, 10, "bold" if on else "normal"))
        if self.viewing_last:
            self.plan_actions.pack_forget()
            self.src_row.pack_forget()
            return self.refresh_last_week()
        if not self.plan_actions.winfo_ismapped():
            self.plan_actions.pack(side="right")
            self.src_row.pack(fill="x", pady=(0, 12), before=self.pages["week"].cards)
        ahead = (datetime.date.fromisoformat(self.data["week_start"]) - week_start_of(datetime.date.today())).days
        label = "This week" if ahead <= 0 else "Next week" if ahead == 7 else "Upcoming week"
        self.week_title.config(text=f"{label}  \u00b7  {date_range(self.data['week_start'])}")
        grid = self.pages["week"].cards
        start = datetime.date.fromisoformat(self.data["week_start"])
        cards = []
        for i, day in enumerate(DAYS):
            meal, kept = self.data["week"][i], self.data["kept"][i]
            date = start + datetime.timedelta(days=i)
            is_today = date == datetime.date.today()
            outline = GREEN if kept else (ACCENT if is_today else BORDER)
            card = tk.Frame(grid.inner, bg=CARD, highlightthickness=2, highlightbackground=outline)
            head = tk.Frame(card, bg=GREEN if kept else (ACCENT if is_today else GHOST))
            head.pack(fill="x")
            fg = "white" if kept or is_today else TEXT
            tk.Label(head, text=day, bg=head["bg"], fg=fg,
                     font=(F, 10, "bold"), pady=5, padx=8, anchor="w").pack(side="left")
            tk.Label(head, text="today" if is_today else f"{date:%b} {date.day}", bg=head["bg"], fg=fg,
                     font=(F, 8), padx=8).pack(side="right")

            img = tk.Label(card, bg=CARD, bd=0)
            img.pack()
            body = tk.Frame(card, bg=CARD, padx=8, pady=6)
            body.pack(fill="both", expand=True)
            if meal:
                set_photo(self.images, img, meal.get("thumb"), (160, 120), meal["name"])
                img.config(cursor="hand2")
                img.bind("<Button-1>", lambda e, m=meal: self.show_details(m))
                name = tk.Label(body, text=meal["name"], bg=CARD, fg=TEXT, font=(F, 10, "bold"),
                                wraplength=146, justify="left", anchor="w", cursor="hand2")
                name.pack(fill="x")
                name.bind("<Button-1>", lambda e, m=meal: self.show_details(m))
                origin = "♥ Favorite" if meal.get("origin") == "Favorite" else "✨ New idea"
                tk.Label(body, text=origin, bg=CARD, fg=MUTED, font=(F, 8), anchor="w").pack(fill="x")
            else:
                set_photo(self.images, img, "", (160, 120), "?")
                tk.Label(body, text="Nothing planned yet", bg=CARD, fg=MUTED, font=(F, 10),
                         anchor="w").pack(fill="x")

            tk.Frame(body, bg=CARD).pack(fill="both", expand=True)  # pushes buttons to the bottom
            row = tk.Frame(body, bg=CARD)
            row.pack(fill="x", pady=(6, 0))
            swap = button(row, "↻ Swap", lambda d=i: self.swap_day(d), "primary", small=True)
            swap.pack(side="left")
            Tooltip(swap, "Pick a different meal for this day")
            button(body, "☰ Choose a favorite", lambda d=i: self.choose_favorite_dialog(d), "ghost",
                   small=True).pack(fill="x", pady=(6, 0))
            if meal:
                self.heart_button(row, meal, on_saved=lambda d=i: self.mark_week_favorite(d)).pack(side="right")
                keep = tk.Checkbutton(body, text="Keep this day", bg=CARD, fg=TEXT, font=(F, 9),
                                      activebackground=CARD, selectcolor=CARD, cursor="hand2",
                                      command=lambda d=i: self.toggle_keep(d))
                if kept:
                    keep.select()
                keep.pack(anchor="w", pady=(4, 0))
                Tooltip(keep, "Kept days stay put when you Shuffle Week")
                self.side_section(body, i)
            cards.append(card)
        grid.set_cards(cards)

    def refresh_last_week(self):
        grid = self.pages["week"].cards
        last = self.last_week()
        if not last:
            self.week_title.config(text="Last week")
            return grid.set_cards([], "No previous week yet.\nWhen a new week starts (or you click "
                                      "\u201cStart next week\u201d), this week's plan moves here.")
        self.week_title.config(text=f"Last week  \u00b7  {date_range(last['start'])}")
        start = datetime.date.fromisoformat(last["start"])
        cards = []
        for i, day in enumerate(DAYS):
            meal, side = last["week"][i], last["sides"][i]
            date = start + datetime.timedelta(days=i)
            card = tk.Frame(grid.inner, bg=CARD, highlightthickness=2, highlightbackground=BORDER)
            head = tk.Frame(card, bg=GHOST)
            head.pack(fill="x")
            tk.Label(head, text=day, bg=GHOST, fg=TEXT, font=(F, 10, "bold"), pady=5, padx=8).pack(side="left")
            tk.Label(head, text=f"{date:%b} {date.day}", bg=GHOST, fg=MUTED, font=(F, 8), padx=8).pack(side="right")
            img = tk.Label(card, bg=CARD, bd=0)
            img.pack()
            body = tk.Frame(card, bg=CARD, padx=8, pady=6)
            body.pack(fill="both", expand=True)
            if meal:
                set_photo(self.images, img, meal.get("thumb"), (160, 120), meal["name"])
                img.config(cursor="hand2")
                img.bind("<Button-1>", lambda e, m=meal: self.open_meal(m))
                tk.Label(body, text=meal["name"], bg=CARD, fg=TEXT, font=(F, 10, "bold"), wraplength=146,
                         justify="left", anchor="w").pack(fill="x")
                if side:
                    tk.Label(body, text=f"+ {side['name']}", bg=CARD, fg=MUTED, font=(F, 9), wraplength=146,
                             justify="left", anchor="w").pack(fill="x", pady=(2, 0))
            else:
                set_photo(self.images, img, "", (160, 120), "-")
                tk.Label(body, text="Nothing planned", bg=CARD, fg=MUTED, font=(F, 10), anchor="w").pack(fill="x")
            cards.append(card)
        grid.set_cards(cards)

    def side_section(self, body, day):
        side = self.data["sides"][day]
        box = tk.Frame(body, bg=GHOST, padx=6, pady=6)
        box.pack(fill="x", pady=(8, 0))
        if side:
            top = tk.Frame(box, bg=GHOST)
            top.pack(fill="x")
            pic = tk.Label(top, bg=GHOST, bd=0, cursor="hand2")
            pic.pack(side="left")
            set_photo(self.images, pic, side.get("thumb"), (40, 40), side["name"])
            text = tk.Frame(top, bg=GHOST)
            text.pack(side="left", fill="x", padx=(6, 0))
            tk.Label(text, text="SIDE", bg=GHOST, fg=MUTED, font=(F, 7, "bold"), anchor="w").pack(fill="x")
            name = tk.Label(text, text=side["name"], bg=GHOST, fg=TEXT, font=(F, 9), wraplength=94,
                            justify="left", anchor="w", cursor="hand2")
            name.pack(fill="x")
            for w in (pic, name):
                w.bind("<Button-1>", lambda e, m=side: self.open_meal(m))
            row = tk.Frame(box, bg=GHOST)
            row.pack(fill="x", pady=(6, 0))
            rnd = button(row, "↻ Random", lambda: self.randomize_side(day), "soft", small=True)
            rnd.pack(side="left", fill="x", expand=True)
            Tooltip(rnd, "Pick a different side at random")
            pick = button(row, "☰ Pick", lambda: self.choose_favorite_dialog(day, side=True), "ghost", small=True)
            pick.pack(side="left", fill="x", expand=True, padx=(4, 0))
            Tooltip(pick, "Choose a side from your favorites")
            x = tk.Label(box, text="✕  Remove side", bg=GHOST, fg=MUTED, font=(F, 9, "underline"),
                         cursor="hand2", pady=2)
            x.pack(pady=(6, 0))
            x.bind("<Button-1>", lambda e: self.remove_side(day))
            x.bind("<Enter>", lambda e: x.config(fg=ACCENT_DARK))
            x.bind("<Leave>", lambda e: x.config(fg=MUTED))
        else:
            button(box, "+ Randomize side", lambda: self.randomize_side(day), "soft",
                   small=True).pack(fill="x")
            button(box, "☰ Pick a side", lambda: self.choose_favorite_dialog(day, side=True), "ghost",
                   small=True).pack(fill="x", pady=(4, 0))

    def choose_favorite_dialog(self, day, side=False):
        """Let the user hand-pick a favorite as the meal (or side) for one day of the week."""
        if not self.data["favorites"]:
            return messagebox.showinfo("No favorites yet", "Add some meals on the Favorites page first.")
        what = "side" if side else "meal"
        slot = self.data["sides"] if side else self.data["week"]
        win = tk.Toplevel(self, bg=BG)
        win.title(f"Choose a {what} for {DAYS[day]}")
        win.transient(self)
        win.geometry(f"820x600+{self.winfo_rootx() + 200}+{self.winfo_rooty() + 60}")
        win.bind("<Escape>", lambda e: win.destroy())

        head = tk.Frame(win, bg=BG, padx=20, pady=14)
        head.pack(fill="x")
        tk.Label(head, text=win.title(), bg=BG, fg=TEXT,
                 font=(F, 15, "bold")).pack(side="left")
        search = PlaceholderEntry(head, "Filter favorites…", width=24)
        search.pack(side="right", ipady=5)
        hint = ("Click a favorite to serve it as this day's side. Favorites with the category Side are "
                "listed first." if side else
                "Click a meal to put it on this day. It will be marked Keep so shuffling won't replace it.")
        tk.Label(win, text=hint,
                 bg=BG, fg=MUTED, font=(F, 9), padx=20, anchor="w").pack(fill="x", pady=(0, 8))
        win.scroll_grid = grid = ScrollGrid(win, card_width=152, gap=12)
        grid.pack(fill="both", expand=True, padx=4, pady=(0, 8))
        current = (slot[day] or {}).get("name", "").lower()
        last_week = self.last_week_names()

        def pick(meal):
            slot[day] = dict(meal, origin="Favorite")
            if not side:
                self.data["kept"][day] = True
            self.save()
            self.refresh_week()
            win.destroy()
            self.notify(f"{DAYS[day]} {what}: {meal['name']}")

        def fill():
            query = search.get().lower().strip()
            favs = sorted(self.data["favorites"],
                          key=lambda m: (side and "sides" not in meal_types(m), m["name"].lower()))
            cards = []
            for meal in favs:
                if query and query not in f"{meal['name']} {meal.get('category', '')}".lower():
                    continue
                chosen = meal["name"].lower() == current
                card = tk.Frame(grid.inner, bg=CARD, cursor="hand2", highlightthickness=2,
                                highlightbackground=ACCENT if chosen else BORDER)
                img = tk.Label(card, bg=CARD, bd=0)
                img.pack()
                set_photo(self.images, img, meal.get("thumb"), (148, 104), meal["name"])
                name = tk.Label(card, text=meal["name"] + ("  ✓" if chosen else ""), bg=CARD, fg=TEXT,
                                font=(F, 10, "bold"), wraplength=136, justify="left", anchor="w", padx=6, pady=6)
                name.pack(fill="x")
                if meal["name"].lower() in last_week:
                    tk.Label(card, text="Had it last week", bg=CARD, fg=MUTED, font=(F, 8, "italic"),
                             anchor="w", padx=6).pack(fill="x", pady=(0, 6))
                for w in (card, img, name):
                    w.bind("<Button-1>", lambda e, m=meal: pick(m))
                    w.bind("<Enter>", lambda e, c=card: c.config(highlightbackground=ACCENT))
                    w.bind("<Leave>", lambda e, c=card, ch=chosen: c.config(
                        highlightbackground=ACCENT if ch else BORDER))
                cards.append(card)
            grid.set_cards(cards, "No favorites match.")

        search.bind("<KeyRelease>", lambda e: fill())
        fill()
        win.grab_set()

    def mark_week_favorite(self, day):
        meal = self.data["week"][day]
        if meal:
            self.data["week"][day] = dict(meal, origin="Favorite")
            self.save()
            self.refresh_week()

    def week_text(self):
        """The menu on screen (this week or last week) as plain text for copying and sending."""
        if self.viewing_last and self.last_week():
            src, start = self.last_week(), self.last_week()["start"]
        else:
            src, start = self.data, self.data["week_start"]
        lines = [f"Dinner menu {date_range(start)}"]
        lines += [f"{d[:3]}: {m['name'] if m else '-'}" + (f" + {s['name']}" if m and s else "")
                  for d, m, s in zip(DAYS, src["week"], src["sides"])]
        return "\n".join(lines)

    def copy_week(self, text=None):
        self.clipboard_clear()
        self.clipboard_append(text or self.week_text())
        self.notify("Menu copied — paste it anywhere")

    def share_dialog(self):
        win = tk.Toplevel(self, bg=CARD)
        win.title("Send the menu")
        win.transient(self)
        win.resizable(False, False)
        win.geometry(f"+{self.winfo_rootx() + 260}+{self.winfo_rooty() + 70}")
        win.bind("<Escape>", lambda e: win.destroy())
        frm = tk.Frame(win, bg=CARD, padx=24, pady=20)
        frm.pack(fill="both", expand=True)
        tk.Label(frm, text="Send the menu", bg=CARD, fg=TEXT, font=(F, 15, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w")
        tk.Label(frm, text="You can edit the message before sending.", bg=CARD, fg=MUTED,
                 font=(F, 9)).grid(row=1, column=0, sticky="w", pady=(0, 8))

        text = tk.Text(frm, width=46, height=10, font=(F, 10), wrap="word", relief="flat", bg=GHOST,
                       padx=10, pady=8, highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
        text.insert("1.0", self.week_text())
        text.grid(row=2, column=0, sticky="nsew")
        message = lambda: text.get("1.0", "end").strip()

        # QR code: scanning it with a phone camera opens a new text message with the menu filled in
        qr_box = tk.Frame(frm, bg=CARD)
        qr_box.grid(row=0, column=1, rowspan=4, sticky="n", padx=(24, 0))
        qr_img = tk.Label(qr_box, bg=CARD)
        qr_img.pack()
        qr_note = tk.Label(qr_box, bg=CARD, fg=MUTED, font=(F, 9), justify="center", wraplength=220)
        qr_note.pack(pady=(6, 0))

        def update_qr(_=None):
            if not qrcode:
                qr_note.config(text="Install the qrcode library to text from your phone:\n"
                                    "python -m pip install qrcode")
                return
            qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1, border=2)
            qr.add_data("SMSTO::" + message())
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white").get_image().convert("RGB")
            scale = max(3, 250 // img.width)  # whole-pixel scaling keeps the code crisp for phone cameras
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
            photo = ImageTk.PhotoImage(img)
            qr_img.config(image=photo)
            qr_img.image = photo
            qr_note.config(text="Text it from your phone:\npoint your phone's camera at this code, tap the "
                                "link, then pick who to send it to.")

        job = [None]

        def edited(_=None):
            if job[0]:
                win.after_cancel(job[0])
            job[0] = win.after(400, update_qr)
        text.bind("<KeyRelease>", edited)
        update_qr()

        def copy_then(opener, where):
            def go():
                self.copy_week(message())
                try:
                    opener()
                except OSError:
                    return self.notify(f"Couldn't open {where} \u2014 the menu is copied, paste it anywhere")
                self.notify(f"Menu copied \u2014 start a message in {where} and press Ctrl+V to paste")
            return go

        def email():
            subject = message().splitlines()[0] if message() else "Dinner menu"
            webbrowser.open("mailto:?subject=" + urllib.parse.quote(subject) +
                            "&body=" + urllib.parse.quote(message()))
            self.notify("Opening your email app with the menu filled in…")

        btns = tk.Frame(frm, bg=CARD)
        btns.grid(row=3, column=0, sticky="we", pady=(12, 0))
        options = [
            ("Text with Phone Link", copy_then(lambda: os.startfile(PHONE_LINK_APP), "Phone Link"),
             "Opens Phone Link on this PC; the menu is copied so you can paste it into a text"),
            ("Facebook Messenger", copy_then(lambda: webbrowser.open("https://www.messenger.com/"), "Messenger"),
             "Opens Messenger in your browser; the menu is copied so you can paste it into a chat"),
            ("Email", email, "Opens your email app with the menu already filled in"),
            ("Copy", lambda: self.copy_week(message()), "Copy the menu to paste anywhere"),
        ]
        for i, (label, cmd, tip) in enumerate(options):
            b = button(btns, label, cmd, "primary" if i < 2 else "ghost")
            b.grid(row=i // 2, column=i % 2, sticky="we", padx=(0 if i % 2 == 0 else 8, 0), pady=(0, 8))
            Tooltip(b, tip)
        btns.columnconfigure(0, weight=1)
        btns.columnconfigure(1, weight=1)
        win.grab_set()

    # ------------------------------------------------------------ Explore

    def build_explore_page(self):
        page = tk.Frame(self.pages_frame, bg=BG)
        _, actions = self.page_header(page, "Explore new ideas",
                                      "Every recipe on TheMealDB. Click a photo for the full recipe.")
        shuffle = button(actions, "\u21bb  Shuffle", self.shuffle_explore, "soft")
        shuffle.pack(side="right")
        Tooltip(shuffle, "Show the recipes in a new random order")
        self.search_entry = PlaceholderEntry(actions, "Search dishes or ingredients, e.g. chicken", width=36)
        self.search_entry.pack(side="right", padx=8, ipady=5)
        self.search_entry.bind("<KeyRelease>", self.on_search_key)

        row1 = tk.Frame(page, bg=BG, padx=24)
        row1.pack(fill="x", pady=(0, 8))
        tk.Label(row1, text="Meal type:", bg=BG, fg=TEXT, font=(F, 10, "bold"), width=9,
                 anchor="w").pack(side="left")
        seg = tk.Frame(row1, bg=GHOST, padx=3, pady=3)
        seg.pack(side="left", padx=(4, 24))
        self.type_chips = {}
        for key, label in MEAL_TYPES:
            chip = tk.Label(seg, text=label, font=(F, 10), padx=11, pady=3, cursor="hand2")
            chip.pack(side="left")
            chip.bind("<Button-1>", lambda e, k=key: self.set_type_filter(k))
            self.type_chips[key] = chip
        tk.Label(row1, text="Cuisine:", bg=BG, fg=TEXT, font=(F, 10, "bold")).pack(side="left")
        self.cuisine_var = tk.StringVar()
        self.cuisine_box = ttk.Combobox(row1, textvariable=self.cuisine_var, state="readonly", width=34,
                                        font=(F, 10), height=24)
        self.cuisine_box.pack(side="left", padx=8, ipady=3)
        self.cuisine_box.bind("<<ComboboxSelected>>", lambda e: self.set_cuisine_filter())

        row2 = tk.Frame(page, bg=BG, padx=24)
        row2.pack(fill="x", pady=(0, 12))
        tk.Label(row2, text="Leave out:", bg=BG, fg=TEXT, font=(F, 10, "bold"), width=9,
                 anchor="w").pack(side="left")
        self.protein_chips = {}
        for key, label in PROTEINS:
            chip = tk.Label(row2, text=label, font=(F, 10), padx=10, pady=3, cursor="hand2",
                            highlightthickness=1)
            chip.pack(side="left", padx=(4, 2))
            chip.bind("<Button-1>", lambda e, k=key: self.toggle_leave_out(k))
            Tooltip(chip, f"Hide {label.lower()} dishes (also skipped when building your week)")
            self.protein_chips[key] = chip
        self.filter_count = tk.Label(row2, bg=BG, fg=MUTED, font=(F, 9))
        self.filter_count.pack(side="right")
        self.style_filter_chips()

        page.cards = ScrollGrid(page, card_width=222)
        page.cards.pack(fill="both", expand=True, padx=8)
        self.refresh_cuisine_menu()
        return page

    def refresh_cuisine_menu(self):
        """Dropdown entries: all, then regions, then each cuisine - with recipe counts."""
        counts = {}
        for m in self.catalog:
            counts[m["area"]] = counts.get(m["area"], 0) + 1
        self.cuisine_options = [(ALL_CUISINES, ALL_CUISINES)]
        for region, members in REGIONS.items():
            n = sum(counts.get(c, 0) for c in members)
            if n:
                self.cuisine_options.append((f"{region} \u2014 all ({n})", "region:" + region))
        self.cuisine_options.append(("\u2500" * 24, None))
        for area in sorted(a for a in counts if a):
            self.cuisine_options.append((f"{area} ({counts[area]})", area))
        self.cuisine_box.config(values=[label for label, _ in self.cuisine_options])
        current = self.data["filters"]["cuisine"]
        label = next((lbl for lbl, key in self.cuisine_options if key == current), ALL_CUISINES)
        self.cuisine_var.set(label)

    def set_cuisine_filter(self):
        label = self.cuisine_var.get()
        key = next((k for lbl, k in self.cuisine_options if lbl == label), None) or ALL_CUISINES
        self.data["filters"]["cuisine"] = key
        if key == ALL_CUISINES:
            self.cuisine_var.set(ALL_CUISINES)
        self.cuisine_box.selection_clear()
        self.filters_changed()

    def on_search_key(self, e):
        if e.keysym == "Escape":
            self.search_entry.delete(0, "end")
        if self.search_job:
            self.after_cancel(self.search_job)
        self.search_job = self.after(250, self.filters_changed)

    def shuffle_explore(self):
        self.explore_order = self.shuffled_ids()
        self.explore_limit = PAGE_SIZE
        self.refresh_explore()
        self.pages["explore"].cards.to_top()

    def show_more_explore(self):
        self.explore_limit += PAGE_SIZE
        self.refresh_explore()

    def style_filter_chips(self):
        f = self.data["filters"]
        for k, chip in self.type_chips.items():
            on = k == f["type"]
            chip.config(bg=CARD if on else GHOST, fg=ACCENT_DARK if on else MUTED,
                        font=(F, 10, "bold" if on else "normal"))
        for k, chip in self.protein_chips.items():
            off = k in f["leave_out"]
            label = dict(PROTEINS)[k]
            chip.config(text=("\u2715 " + label) if off else label, bg=ACCENT_SOFT if off else CARD,
                        fg=ACCENT_DARK if off else TEXT, highlightbackground=ACCENT if off else BORDER,
                        font=(F, 10, "overstrike") if off else (F, 10))

    def set_type_filter(self, key):
        self.data["filters"]["type"] = key
        self.filters_changed()

    def toggle_leave_out(self, key):
        lo = self.data["filters"]["leave_out"]
        lo.remove(key) if key in lo else lo.append(key)
        self.filters_changed()

    def filters_changed(self):
        self.save()
        self.style_filter_chips()
        self.explore_limit = PAGE_SIZE
        self.refresh_explore()
        self.pages["explore"].cards.to_top()

    def explore_visible(self):
        f = self.data["filters"]
        t, cuisine = f["type"], f["cuisine"]
        if cuisine.startswith("region:"):
            areas = set(REGIONS.get(cuisine[7:], []))
        elif cuisine != ALL_CUISINES:
            areas = {cuisine}
        else:
            areas = None
        words = self.search_entry.get().lower().split()
        result = []
        for mid in self.explore_order:
            m = self.catalog_by_id[mid]
            if areas is not None and m["area"] not in areas:
                continue
            if t != "all" and t not in meal_types(m):
                continue
            if words:
                text = " ".join([m["name"], m["category"], m["area"]] + m["ingredients"]).lower()
                if not all(w in text for w in words):
                    continue
            if self.passes_leave_out(m):
                result.append(m)
        return result

    def refresh_explore(self):
        grid = self.pages["explore"].cards
        if not self.catalog:
            self.filter_count.config(text="")
            return grid.set_cards([], "Downloading the recipe list\u2026\nThis only takes a moment the first time.")
        visible = self.explore_visible()
        shown = visible[:self.explore_limit]
        self.filter_count.config(text=f"Showing {len(shown)} of {len(visible)} matching recipes"
                                 + (f" ({len(self.catalog)} total)" if len(visible) != len(self.catalog) else ""))
        cards = []
        for meal in shown:
            card, body = meal_card(grid.inner, self.images, meal, (220, 160),
                                   on_open=lambda m=meal: self.show_details(m))
            row = tk.Frame(body, bg=CARD)
            row.pack(fill="x", side="bottom", pady=(8, 0))
            self.heart_button(row, meal).pack(side="left")
            button(row, "View recipe", lambda m=meal: self.show_details(m), "ghost", small=True).pack(side="right")
            cards.append(card)
        if len(visible) > len(shown):
            more = tk.Frame(grid.inner, bg=BG)
            left = len(visible) - len(shown)
            button(more, f"Show {min(PAGE_SIZE, left)} more", self.show_more_explore).pack(expand=True, pady=60)
            tk.Label(more, text=f"{left} more recipes", bg=BG, fg=MUTED, font=(F, 9)).pack()
            cards.append(more)
        grid.set_cards(cards, "No recipes match these filters.\nTry another cuisine or meal type, "
                              "or turn off a Leave out option.")

    # ------------------------------------------------------------ recipe details popup

    def show_details(self, meal):
        win = tk.Toplevel(self, bg=CARD)
        win.title(meal["name"])
        win.transient(self)
        win.geometry(f"560x720+{self.winfo_rootx() + 120}+{self.winfo_rooty() + 30}")
        win.bind("<Escape>", lambda e: win.destroy())

        img = tk.Label(win, bg=CARD, bd=0)
        img.pack()
        set_photo(self.images, img, meal.get("thumb"), (560, 260), meal["name"])

        info = tk.Frame(win, bg=CARD, padx=20, pady=12)
        info.pack(fill="x")
        tk.Label(info, text=meal["name"], bg=CARD, fg=TEXT, font=(F, 16, "bold"), wraplength=520,
                 justify="left", anchor="w").pack(fill="x")
        sub = " · ".join(x for x in (meal.get("category"), meal.get("area")) if x)
        if sub:
            tk.Label(info, text=sub, bg=CARD, fg=MUTED, font=(F, 10), anchor="w").pack(fill="x")
        row = tk.Frame(info, bg=CARD)
        row.pack(fill="x", pady=(10, 0))
        self.heart_button(row, meal, small=False).pack(side="left")
        if meal.get("url"):
            button(row, "Open full recipe ↗", lambda: webbrowser.open(meal["url"]), "ghost").pack(
                side="left", padx=8)
        if meal.get("youtube"):
            button(row, "▶ Watch video", lambda: webbrowser.open(meal["youtube"]), "ghost").pack(side="left")

        text = tk.Text(win, wrap="word", font=(F, 10), relief="flat", bg=CARD, fg=TEXT,
                       padx=20, pady=4, spacing1=2, spacing3=2)
        text.pack(fill="both", expand=True)
        text.tag_configure("h", font=(F, 12, "bold"), spacing1=10, spacing3=4, foreground=ACCENT_DARK)
        if meal.get("ingredients"):
            text.insert("end", "Ingredients\n", "h")
            text.insert("end", "".join(f"  •  {i}\n" for i in meal["ingredients"]))
        if meal.get("instructions"):
            text.insert("end", "Instructions\n", "h")
            text.insert("end", meal["instructions"].replace("\r\n", "\n"))
        if meal.get("notes"):
            text.insert("end", "\nMy notes\n", "h")
            text.insert("end", meal["notes"])
        if text.get("1.0", "end").strip() == "":
            text.insert("end", "No recipe details saved for this meal.\n\n"
                        "Tip: add a recipe link or notes on the Favorites page.")
        text.config(state="disabled")

    # ------------------------------------------------------------ Favorites

    def build_fav_page(self):
        page = tk.Frame(self.pages_frame, bg=BG)
        self.fav_title, actions = self.page_header(page, "Your favorites",
                                                   "Meals you know you love. These go into your weekly menu.")
        button(actions, "+  Add a meal", lambda: self.edit_favorite_dialog()).pack(side="right")
        self.fav_filter = tk.StringVar()
        entry = PlaceholderEntry(actions, "Filter favorites…", width=22)
        entry.pack(side="right", padx=8, ipady=5)
        entry.bind("<KeyRelease>", lambda e: (self.fav_filter.set(entry.get()), self.refresh_favs()))

        bar = tk.Frame(page, bg=BG, padx=24)
        bar.pack(fill="x", pady=(0, 12))
        seg = tk.Frame(bar, bg=GHOST, padx=3, pady=3)
        seg.pack(side="left")
        self.fav_tab = "all"
        self.fav_tab_chips = {}
        for key, label in FAV_TABS:
            chip = tk.Label(seg, font=(F, 11), padx=16, pady=5, cursor="hand2")
            chip.pack(side="left")
            chip.bind("<Button-1>", lambda e, k=key: self.set_fav_tab(k))
            self.fav_tab_chips[key] = chip
        tk.Label(bar, text="Click the category tags on a card to sort it — a meal can be in more than one.",
                 bg=BG, fg=MUTED,
                 font=(F, 9)).pack(side="left", padx=14)

        page.cards = ScrollGrid(page, card_width=222)
        page.cards.pack(fill="both", expand=True, padx=8)
        return page

    def set_fav_tab(self, key):
        self.fav_tab = key
        self.refresh_favs()
        self.pages["favorites"].cards.to_top()

    def toggle_fav_type(self, idx, key):
        meal = self.data["favorites"][idx]
        types = meal_types(meal)
        types ^= {key}
        if not types:
            return self.notify("A meal needs at least one category")
        meal["types"] = [k for k, _ in TYPE_TAGS if k in types] + (["dessert"] if "dessert" in types else [])
        self.save()
        self.refresh_favs()

    def refresh_favs(self):
        grid = self.pages["favorites"].cards
        query = self.fav_filter.get().lower().strip()
        favs = sorted(enumerate(self.data["favorites"]), key=lambda p: p[1]["name"].lower())
        for key, label in FAV_TABS:
            n = sum(1 for _, m in favs if key == "all" or key in meal_types(m))
            on = key == self.fav_tab
            self.fav_tab_chips[key].config(text=f"{label}  {n}", bg=CARD if on else GHOST,
                                           fg=ACCENT_DARK if on else MUTED, font=(F, 11, "bold" if on else "normal"))
        if self.fav_tab != "all":
            favs = [(i, m) for i, m in favs if self.fav_tab in meal_types(m)]
        if query:
            favs = [(i, m) for i, m in favs
                    if query in " ".join((m["name"], m.get("category", ""), m.get("notes", ""))).lower()]
        cards = []
        for idx, meal in favs:
            card, body = meal_card(grid.inner, self.images, meal, (220, 160),
                                   on_open=lambda m=meal: self.show_details(m), show_category=False)
            if meal.get("notes"):
                tk.Label(body, text=meal["notes"], bg=CARD, fg=MUTED, font=(F, 9, "italic"), wraplength=200,
                         justify="left", anchor="w").pack(fill="x", pady=(4, 0))
            tags = tk.Frame(body, bg=CARD)
            tags.pack(fill="x", pady=(6, 0))
            types = meal_types(meal)
            for key, label in TYPE_TAGS:
                on = key in types
                tag = tk.Label(tags, text=label, font=(F, 8, "bold" if on else "normal"), padx=5, pady=1,
                               bg=ACCENT_SOFT if on else CARD, fg=ACCENT_DARK if on else "#B5ABA2",
                               highlightthickness=1, highlightbackground=ACCENT_SOFT if on else BORDER,
                               cursor="hand2")
                tag.pack(side="left", padx=(0, 3))
                tag.bind("<Button-1>", lambda e, i=idx, k=key: self.toggle_fav_type(i, k))
            row = tk.Frame(body, bg=CARD)
            row.pack(fill="x", side="bottom", pady=(8, 0))
            button(row, "Edit", lambda i=idx: self.edit_favorite_dialog(i), "ghost", small=True).pack(side="left")
            button(row, "Remove", lambda i=idx: self.remove_fav(i), "ghost", small=True).pack(side="left", padx=6)
            button(row, "View", lambda m=meal: self.show_details(m), "soft", small=True).pack(side="right")
            cards.append(card)
        n = len(self.data["favorites"])
        self.fav_title.config(text=f"Your favorites ({n})" if n else "Your favorites")
        tab_name = dict(FAV_TABS)[self.fav_tab].lower()
        if query:
            empty = "No matches."
        elif self.fav_tab != "all" and self.data["favorites"]:
            empty = (f"No {tab_name} favorites yet.\nClick “+ Add a meal”, or click the "
                     f"{dict(TYPE_TAGS)[self.fav_tab]} tag on a meal in the All tab.")
        else:
            empty = "No favorites yet.\nClick “+ Add a meal”, or tap ♡ Save on anything in Explore."
        grid.set_cards(cards, empty)

    def favorites_changed(self):
        self.save()
        self.refresh_favs()
        self.refresh_hearts()

    def add_favorite(self, meal):
        if self.is_favorite(meal["name"]):
            return
        fav = {k: meal[k] for k in ("id", "name", "category", "area", "thumb", "ingredients",
                                    "instructions", "url", "youtube") if k in meal}
        fav.setdefault("notes", "")
        self.data["favorites"].append(fav)
        self.favorites_changed()
        self.notify(f"♥ Saved “{meal['name']}” to Favorites")

    def remove_fav(self, idx):
        name = self.data["favorites"][idx]["name"]
        if messagebox.askyesno("Remove", f"Remove “{name}” from Favorites?"):
            del self.data["favorites"][idx]
            self.favorites_changed()

    def edit_favorite_dialog(self, idx=None):
        existing = self.data["favorites"][idx] if idx is not None else {}
        win = tk.Toplevel(self, bg=CARD)
        win.title("Edit meal" if idx is not None else "Add a meal")
        win.transient(self)
        win.resizable(False, False)
        win.geometry(f"+{self.winfo_rootx() + 300}+{self.winfo_rooty() + 120}")
        frm = tk.Frame(win, bg=CARD, padx=24, pady=20)
        frm.pack(fill="both", expand=True)
        tk.Label(frm, text=win.title(), bg=CARD, fg=TEXT, font=(F, 15, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 12))

        def label(row, text):
            tk.Label(frm, text=text, bg=CARD, fg=TEXT, font=(F, 10, "bold")).grid(
                row=row, column=0, sticky="nw", pady=6, padx=(0, 12))

        def entry(row, text, value):
            label(row, text)
            var = tk.StringVar(value=value)
            e = tk.Entry(frm, textvariable=var, width=40, relief="flat", font=(F, 10), bg=GHOST,
                         highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
            e.grid(row=row, column=1, pady=6, ipady=4, sticky="we")
            return var, e

        name_var, name_entry = entry(1, "Meal name", existing.get("name", ""))
        label(2, "Categories")
        if existing:
            start = meal_types(existing)
        else:
            start = {self.fav_tab if self.fav_tab != "all" else "dinner"}
        type_vars = {}
        checks = tk.Frame(frm, bg=CARD)
        checks.grid(row=2, column=1, sticky="w", pady=6)
        for key, text in TYPE_TAGS:
            type_vars[key] = tk.BooleanVar(value=key in start)
            tk.Checkbutton(checks, text=text, variable=type_vars[key], bg=CARD, activebackground=CARD,
                           font=(F, 10), cursor="hand2").pack(side="left", padx=(0, 10))
        tk.Label(frm, text="Tick all that apply — the meal shows up under each tab", bg=CARD, fg=MUTED,
                 font=(F, 8)).grid(row=3, column=1, sticky="w")
        url_var, _ = entry(4, "Recipe link", existing.get("url", ""))
        thumb_var, _ = entry(5, "Photo link", existing.get("thumb", ""))
        tk.Label(frm, text="Optional — paste an image address to show a photo", bg=CARD, fg=MUTED,
                 font=(F, 8)).grid(row=6, column=1, sticky="w")
        label(7, "Notes")
        notes = tk.Text(frm, width=40, height=4, font=(F, 10), wrap="word", relief="flat", bg=GHOST,
                        highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
        notes.insert("1.0", existing.get("notes", ""))
        notes.grid(row=7, column=1, pady=6, sticky="we")

        def submit():
            name = name_var.get().strip()
            if not name:
                messagebox.showwarning("Missing name", "Please give the meal a name.", parent=win)
                return name_entry.focus_set()
            clash = any(f["name"].lower() == name.lower()
                        for i, f in enumerate(self.data["favorites"]) if i != idx)
            if clash:
                return messagebox.showwarning("Already saved", f"“{name}” is already in Favorites.",
                                              parent=win)
            types = [k for k, v in type_vars.items() if v.get()]
            if not types:
                return messagebox.showwarning("Pick a category", "Tick at least one of Breakfast, Lunch, "
                                              "Dinner or Side.", parent=win)
            meal = dict(existing, name=name, url=url_var.get().strip(),
                        thumb=thumb_var.get().strip(), notes=notes.get("1.0", "end").strip(), types=types)
            if idx is None:
                self.data["favorites"].append(meal)
            else:
                self.data["favorites"][idx] = meal
            self.favorites_changed()
            self.notify(f"♥ Saved “{name}”")
            win.destroy()

        btns = tk.Frame(frm, bg=CARD)
        btns.grid(row=8, column=0, columnspan=2, sticky="e", pady=(14, 0))
        button(btns, "Cancel", win.destroy, "ghost").pack(side="right")
        button(btns, "Save meal", submit).pack(side="right", padx=8)
        win.bind("<Return>", lambda e: None if e.widget is notes else submit())
        win.bind("<Escape>", lambda e: win.destroy())
        win.grab_set()
        name_entry.focus_set()


if __name__ == "__main__":
    MealPlanner().mainloop()
