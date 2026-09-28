"""Weekly Meal Planner - a simple desktop app.

Pages:
  This Week  - random 7-day menu drawn from Favorites, Explore, or both
  Explore    - a photo grid of new ideas from TheMealDB (https://www.themealdb.com)
  Favorites  - meals you already know you like; add them by hand or save from Explore

Data is saved to meal_data.json next to this file; photos are cached in image_cache/.
Recipes come live from TheMealDB each time the app opens.

Family sharing: favorites, plans, the shopping list and settings sync with the iPhone app (mobile/),
the web app (docs/) and other family members through Supabase (see supabase/schema.sql).
Your project's address is in supabase/config.json; your sign-in is kept in sync_config.json.
Requires Pillow for photos:  python -m pip install pillow
"""

import base64
import datetime
import hashlib
import io
import json
import queue
import random
import re
import threading
import time
import uuid
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
import os
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

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
PAGE_SIZE = 100
CACHE_DIR = HERE / "image_cache"
API = "https://www.themealdb.com/api/json/v1/1/"
DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]  # weeks run Sat-Fri
SOURCES = [("favorites", "Favorites only"), ("mix", "Mix of both"), ("explore", "Explore only")]
MEAL_TYPES = [("all", "All"), ("breakfast", "Breakfast"), ("lunch", "Lunch"), ("dinner", "Dinner"),
              ("appetizer", "Appetizers"), ("dessert", "Dessert"), ("sides", "Sides")]
FAV_TABS = [("all", "All"), ("dinner", "Dinner"), ("lunch", "Lunch"), ("breakfast", "Breakfast"),
            ("appetizer", "Appetizers"), ("sides", "Sides")]
TYPE_TAGS = [("breakfast", "Breakfast"), ("lunch", "Lunch"), ("dinner", "Dinner"), ("appetizer", "Appetizer"),
             ("sides", "Side")]
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
SYNC_FILE = HERE / "sync_config.json"
SUPABASE_CONFIG = HERE / "supabase" / "config.json"
SYNC_EVERY_MS = 60_000
PLAN_KEYS = ("week_start", "week", "kept", "sides")
SETTINGS_KEYS = ("source", "filters", "aisles")  # aisles: {ingredient key: aisle} the family picked
SLIM_KEYS = ("id", "uid", "name", "thumb", "category", "area", "types", "origin", "url", "youtube", "notes")
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
    data.setdefault("tombstones", {})  # uid -> when a favorite was deleted (so deletes sync)
    data.setdefault("plan_updated", 0)
    data.setdefault("shopping", [])
    data.setdefault("settings_updated", 0)
    data.setdefault("aisles", {})
    return data


# ---------------------------------------------------------------- sync (shared rules with docs/core.js)

def now_ms():
    return int(time.time() * 1000)


def slim_meal(m):
    """Plans only keep what's needed to show a meal; full recipes come from the catalog or favorites."""
    return {k: m[k] for k in SLIM_KEYS if m.get(k)} if m else None


def canonical(data):
    return json.dumps(data, sort_keys=True, ensure_ascii=False)


def merge_data(local, remote):
    """Combine two copies of the planner data. Must match mergeData() in docs/core.js.
    Favorites merge one by one (newest edit wins, deletions stick); the week plan and the
    settings each go to whichever side changed them last; past weeks are combined."""
    if not remote:
        return json.loads(json.dumps(local))
    out = json.loads(json.dumps(local))
    tombs = dict(remote.get("tombstones") or {})
    for uid, ts in (local.get("tombstones") or {}).items():
        tombs[uid] = max(ts, tombs.get(uid, 0))
    def newest(key):
        items = {}
        for f in (remote.get(key) or []) + (local.get(key) or []):
            cur = items.get(f["uid"])
            if cur is None or f.get("updated", 0) >= cur.get("updated", 0):
                items[f["uid"]] = f
        return [f for f in items.values() if tombs.get(f["uid"], -1) < f.get("updated", 0)]

    by_added = lambda f: (f.get("added", 0), f["uid"])
    alive = newest("favorites")
    by_name = {}
    for f in sorted(alive, key=lambda f: (-f.get("updated", 0), f["uid"])):
        key = f["name"].strip().lower()
        if key in by_name:  # the same meal was added on both devices: keep the newest copy
            tombs[f["uid"]] = max(tombs.get(f["uid"], 0), f.get("updated", 0))
        else:
            by_name[key] = f
    out["favorites"] = json.loads(json.dumps(sorted(by_name.values(), key=by_added)))
    out["shopping"] = json.loads(json.dumps(sorted(newest("shopping"), key=by_added)))
    out["tombstones"] = tombs
    for keys, stamp in ((PLAN_KEYS, "plan_updated"), (SETTINGS_KEYS, "settings_updated")):
        if remote.get(stamp, 0) > local.get(stamp, 0):
            for k in keys:
                if k in remote:
                    out[k] = remote[k]
            out[stamp] = remote[stamp]
    history = {h["start"]: h for h in (remote.get("history") or []) + (local.get("history") or [])}
    out["history"] = [history[k] for k in sorted(history)][-12:]
    return out


class SyncError(Exception):
    def __init__(self, message, status=None, signed_out=False):
        super().__init__(message)
        self.status, self.signed_out = status, signed_out


class SyncConflict(SyncError):
    pass


def load_supabase_config():
    try:
        cfg = json.loads(SUPABASE_CONFIG.read_text(encoding="utf-8"))
        return cfg.get("url", ""), cfg.get("anonKey", "")
    except (OSError, ValueError):
        return "", ""


def web_app_url():
    """Where the web app is published (from supabase/config.json); invite QR codes open it on phones."""
    try:
        return json.loads(SUPABASE_CONFIG.read_text(encoding="utf-8")).get("webAppUrl", "")
    except (OSError, ValueError):
        return ""


# Photos added from this computer are shrunk before they're saved: to PHOTO_MAX pixels when they go in the
# family's online folder, or PHOTO_LOCAL_MAX when there's no family and the photo is kept inside the meal.
PHOTO_BUCKET, PHOTO_MAX, PHOTO_LOCAL_MAX, PHOTO_QUALITY = "meal-photos", 800, 480, 0.75
# owner = the computer that started the family; primary = the first phone to join (both can invite)
ROLE_LABELS = {"owner": "Family computer", "primary": "Primary", "member": ""}


def photo_size(w, h, max_side=PHOTO_MAX):
    """Width and height to shrink a w x h photo to, so its longest side is at most max_side (like core.js)."""
    k = min(1, (max_side or PHOTO_MAX) / max(w, h, 1))
    return max(1, round_half_up(w * k)), max(1, round_half_up(h * k))


def round_half_up(x):
    """Math.round from JavaScript (Python's round() rounds halves to even)."""
    return int((x + 0.5) // 1)


def photo_path(family_id):
    """A new file name in the family's photo folder: "<family id>/<time>-<random>.jpg"."""
    return f"{family_id}/{base36(now_ms())}-{uuid.uuid4().hex[:8]}.jpg"


def base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if not n:
            return out


def shrink_photo(path, max_side):
    """Open a photo file, turn it upright, shrink it and return JPEG bytes."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):  # transparent PNGs get a white background, not black
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.split()[3])
            im = bg
        im = im.convert("RGB")
        size = photo_size(im.width, im.height, max_side)
        if size != im.size:
            im = im.resize(size, Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=int(PHOTO_QUALITY * 100), optimize=True)
        return out.getvalue()


class Supabase:
    """Device sign-in (no email) and calls to the functions in supabase/schema.sql (same as docs/core.js)."""

    def __init__(self, url, key):
        self.url, self.key = (url or "").rstrip("/"), key or ""

    @property
    def configured(self):
        return bool(self.url and self.key and "YOUR-PROJECT" not in self.url)

    def request(self, path, body, token=None, content_type=None):
        """POST JSON (or, with content_type, raw bytes such as a photo) and return the JSON reply."""
        if not self.configured:
            raise SyncError("Family sharing isn't set up in this copy of the app yet.")
        # Publishable keys go only in `apikey`; Authorization carries a signed-in person's token.
        headers = {"apikey": self.key, "Content-Type": content_type or "application/json", "User-Agent": "MealPlanner"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = body if content_type else json.dumps(body or {}).encode()
        req = urllib.request.Request(self.url + path, method="POST", data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            try:
                info = json.loads(e.read().decode("utf-8") or "{}")
            except ValueError:
                info = {}
            raise SyncError(info.get("message") or info.get("msg") or f"Server error {e.code}", status=e.code)
        except urllib.error.URLError:
            raise SyncError("Couldn't connect \u2014 check your internet connection.")

    def sign_in_anonymously(self):
        """Sign this device in with no email or password (Supabase anonymous sign-in)."""
        try:
            return self.to_session(self.request("/auth/v1/signup", {"data": {}}))
        except SyncError as e:
            if e.status in (400, 422) or "anonymous" in str(e).lower():
                raise SyncError("Family sharing needs anonymous sign-ins turned on in Supabase (Authentication "
                                "\u2192 Sign In / Providers \u2192 Allow anonymous sign-ins).")
            if e.status == 429:
                raise SyncError("Too many devices signed in from here recently \u2014 try again in a while.")
            raise

    def refresh(self, session):
        try:
            r = self.request("/auth/v1/token?grant_type=refresh_token", {"refresh_token": session["refresh_token"]})
        except SyncError as e:
            if e.status and e.status < 500:
                raise SyncError("You've been signed out. Please sign in again.", signed_out=True)
            raise
        return self.to_session(r)

    def photo_url(self, path):
        """The web address anyone can view a stored photo at."""
        return f"{self.url}/storage/v1/object/public/{PHOTO_BUCKET}/{path}"

    @staticmethod
    def to_session(r):
        user = r.get("user") or {}
        return {"access_token": r["access_token"], "refresh_token": r["refresh_token"],
                "expires_at": now_ms() + int(r.get("expires_in") or 3600) * 1000,
                "email": user.get("email", ""), "user_id": user.get("id", "")}


class FamilyAccount:
    """One signed-in person's connection. get/set store the session wherever the app keeps it."""

    def __init__(self, sb, get_session, set_session):
        self.sb, self.get, self.set = sb, get_session, set_session

    def ensure_signed_in(self):
        """Sign this device in if it isn't yet (there are no emails or passwords)."""
        if not (self.get() or {}).get("refresh_token"):
            self.set(self.sb.sign_in_anonymously())
        return self.get()

    def token(self):
        session = self.get()
        if not session:
            raise SyncError("Please sign in first.", signed_out=True)
        if session["expires_at"] - now_ms() < 60000:
            fresh = self.sb.refresh(session)
            fresh["email"] = fresh["email"] or session.get("email", "")
            self.set(fresh)
            session = fresh
        return session["access_token"]

    def call(self, name, args=None):
        try:
            return self.sb.request("/rest/v1/rpc/" + name, args or {}, self.token())
        except SyncError as e:
            if e.status == 401 and self.get():  # token expired early: refresh once and retry
                self.set(dict(self.get(), expires_at=0))
                return self.sb.request("/rest/v1/rpc/" + name, args or {}, self.token())
            raise

    def my_families(self):
        return self.call("my_families")

    def upload_photo(self, family_id, jpeg_bytes):
        """Save a JPEG in the family's photo folder; returns its web address."""
        path = photo_path(family_id)
        try:
            self.sb.request(f"/storage/v1/object/{PHOTO_BUCKET}/{path}", jpeg_bytes, self.token(), "image/jpeg")
        except SyncError as e:
            if e.status == 404 or "bucket not found" in str(e).lower():
                raise SyncError("Photo uploads aren't set up yet \u2014 run the latest supabase/schema.sql.")
            if e.status == 403 or "row-level security" in str(e).lower() or "violates" in str(e).lower():
                raise SyncError("Couldn't save the photo \u2014 you're not in this family any more.")
            raise
        return self.sb.photo_url(path)

    def create_family(self, name, display_name):
        return self.call("create_family", {"p_name": name, "p_display_name": display_name})

    def create_invite(self, family_id):
        return self.call("create_invite", {"p_family": family_id})

    def join_family(self, code, display_name):
        return self.call("join_family", {"p_code": code, "p_display_name": display_name})

    def leave_family(self, family_id):
        return self.call("leave_family", {"p_family": family_id})

    def remove_member(self, family_id, user_id):
        return self.call("remove_member", {"p_family": family_id, "p_user": user_id})


class FamilyStore:
    """The family's shared planner, read and saved with a version check (like docs/core.js)."""

    def __init__(self, account, family_id):
        self.account, self.family_id = account, family_id

    def pull(self):
        r = self.account.call("get_family_data", {"p_family": self.family_id})
        return (r["doc"] or None), r["version"]

    def push(self, data, version):
        r = self.account.call("put_family_data", {"p_family": self.family_id, "p_doc": data,
                                                  "p_expected_version": version or 0})
        if not r["ok"]:
            raise SyncConflict("Saved at the same moment on another phone \u2014 trying again.")
        return r["version"]


def format_invite_code(code):
    c = "".join(ch for ch in (code or "").upper() if ch.isalnum())
    return c[:4] + "-" + c[4:] if len(c) == 8 else c


def load_sync_config():
    try:
        cfg = json.loads(SYNC_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return cfg if "session" in cfg or "family" in cfg else {}  # drop old GitHub sync settings


def save_sync_config(cfg):
    SYNC_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def qr_photo(text, target=250):
    """A crisp QR code image for Tk, or None if the qrcode library isn't installed."""
    if not qrcode:
        return None
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, box_size=1, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").get_image().convert("RGB")
    scale = max(3, target // img.width)  # whole-pixel scaling keeps the code crisp for phone cameras
    return ImageTk.PhotoImage(img.resize((img.width * scale, img.height * scale), Image.NEAREST))


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
    ingredients, parts = [], []
    for i in range(1, 21):
        ing = (m.get(f"strIngredient{i}") or "").strip()
        meas = (m.get(f"strMeasure{i}") or "").strip()
        if ing:
            ingredients.append(f"{meas} {ing}".strip())
            parts.append({"q": meas, "n": ing})
    return {
        "id": m["idMeal"],
        "name": m["strMeal"],
        "category": m.get("strCategory") or "",
        "area": AREA_FIX.get(m.get("strArea") or "", m.get("strArea") or ""),
        "thumb": m.get("strMealThumb") or "",
        "ingredients": ingredients,
        "parts": parts,
        "instructions": m.get("strInstructions") or "",
        "url": m.get("strSource") or f"https://www.themealdb.com/meal/{m['idMeal']}",
        "youtube": m.get("strYoutube") or "",
    }


CATEGORIES = ["Beef", "Breakfast", "Chicken", "Dessert", "Goat", "Lamb", "Miscellaneous", "Pasta", "Pork",
              "Seafood", "Side", "Starter", "Vegan", "Vegetarian"]


def fetch_index():
    """Every TheMealDB recipe's name, photo, category and cuisine, fetched live (a second or two).
    Ingredients and instructions come per recipe from fetch_by_ids(). Same as fetchIndex() in docs/core.js."""
    with ThreadPoolExecutor(max_workers=4) as pool:
        lists = list(pool.map(lambda c: api_get("filter.php", c=c), CATEGORIES))
    by_id = {}
    for category, items in zip(CATEGORIES, lists):
        for m in items:
            area = m.get("strArea") or ""
            by_id[m["idMeal"]] = {"id": m["idMeal"], "name": m["strMeal"], "thumb": m.get("strMealThumb") or "",
                                  "category": category, "area": AREA_FIX.get(area, area)}
    return sorted(by_id.values(), key=lambda m: m["name"].lower())


def search_ingredient(term):
    """Ids of recipes that use an ingredient, from TheMealDB's ingredient search ("garlic", "chicken breast")."""
    key = "_".join(term.strip().lower().split())
    if len(key) < 3:
        return set()
    tries = [key, key[:-1]] if key.endswith("s") and len(key) > 3 else [key]
    ids = set()
    for k in tries:
        try:
            ids.update(m["idMeal"] for m in api_get("filter.php", i=k))
        except (urllib.error.URLError, ValueError):
            pass
    return ids


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
              "dessert": "dessert", "appetizer": "appetizer", "appetizers": "appetizer", "starter": "appetizer",
              "starters": "appetizer"}


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
    if cat in ("Soup", "Salad"):
        return {"lunch", "dinner"}
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


# ---------------------------------------------------------------- shopping list (same rules as docs/core.js)

# Checked in order: the first aisle with a matching word wins ("chicken stock" is Pantry, not Meat).
AISLE_RULES = [(aisle, word_re(words)) for aisle, words in [
    ("Frozen", ["frozen", "ice cream"]),
    ("Spices & Seasonings", ["salt", "black pepper", "white pepper", "peppercorn", "cumin", "paprika", "turmeric",
                             "cinnamon", "oregano", "dried thyme", "dried basil", "bay leaf", "bay leaves",
                             "chilli powder", "chili powder", "cayenne", "nutmeg", "ground cloves", "whole cloves",
                             "cardamom", "ground coriander", "coriander seed", "garam masala", "curry powder", "spice",
                             "seasoning", "stock cube", "bouillon", "vanilla", "allspice", "saffron", "fenugreek",
                             "mustard seed", "chilli flakes", "red pepper flakes", "five spice", "star anise"]),
    ("Bakery", ["bread", "bun", "roll", "tortilla", "pita", "pitta", "baguette", "naan", "wrap", "croissant",
                "bagel", "brioche", "ciabatta", "puff pastry", "pastry", "filo"]),
    ("Pantry", ["flour", "sugar", "oil", "vinegar", "rice", "pasta", "spaghetti", "noodle", "stock", "broth",
                "tomato puree", "tomato paste", "passata", "chopped tomatoes", "tinned", "canned", "lentil",
                "chickpea", "kidney bean", "black bean", "baked bean", "soy sauce", "fish sauce", "worcestershire",
                "honey", "syrup", "ketchup", "mustard", "mayonnaise", "baking powder", "baking soda", "bicarbonate",
                "yeast", "oats", "breadcrumb", "cornstarch", "cornflour", "almond", "peanut", "walnut", "cashew",
                "pine nut", "sesame", "coconut milk", "coconut cream", "chocolate", "cocoa", "wine", "raisin",
                "sultana", "jam", "gelatine", "tahini", "couscous", "quinoa", "polenta", "macaroni", "lasagne",
                "hot sauce", "sriracha", "custard"]),
    ("Meat & Seafood", ["chicken", "beef", "pork", "lamb", "bacon", "sausage", "mince", "minced", "steak", "ham",
                        "turkey", "duck", "fish", "salmon", "prawn", "shrimp", "cod", "haddock", "tuna", "mussel",
                        "clam", "squid", "crab", "lobster", "chorizo", "veal", "goat", "mutton", "anchovy",
                        "anchovies", "sardine", "mackerel", "scallop", "oxtail", "brisket", "pancetta", "prosciutto",
                        "salami", "kielbasa", "saltfish"]),
    ("Dairy & Eggs", ["milk", "buttermilk", "cream", "butter", "cheese", "yogurt", "yoghurt", "egg", "parmesan",
                      "mozzarella", "cheddar", "creme fraiche", "cr\u00e8me fra\u00eeche", "sour cream", "ricotta",
                      "feta", "mascarpone", "ghee", "paneer", "gruyere", "halloumi"]),
    ("Produce", ["onion", "garlic", "tomato", "tomatoes", "potato", "potatoes", "carrot", "pepper", "lettuce",
                 "spinach", "cabbage", "celery", "cucumber", "zucchini", "courgette", "mushroom", "lemon", "lime",
                 "orange", "apple", "banana", "ginger", "parsley", "cilantro", "coriander", "basil", "mint", "thyme",
                 "rosemary", "dill", "sage", "chive", "avocado", "chilli", "chillies", "chili", "jalapeno", "leek",
                 "shallot", "scallion", "spring onion", "broccoli", "cauliflower", "pea", "green bean", "corn",
                 "squash", "pumpkin", "aubergine", "eggplant", "kale", "berry", "berries", "strawberries",
                 "blueberries", "raspberries", "cherries", "grape", "mango", "pineapple", "beetroot", "radish",
                 "fennel", "asparagus", "sweet potato", "yam", "plantain", "okra", "bean sprout", "pak choi",
                 "bok choy", "lemongrass", "herb", "pear", "peach", "plum", "cherry", "rhubarb", "coconut",
                 "watercress", "rocket", "arugula", "sweetcorn"]),
]]
# Shown in the order you walk a store (the rules above are checked in a different order).
AISLES = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Pantry", "Spices & Seasonings", "Frozen", "Household",
          "Other"]
SKIP_INGREDIENTS = {"water", "cold water", "hot water", "boiling water", "warm water", "ice"}


def aisle_of(name, custom=None):
    """Which aisle an item is in: the family's own choice for it (custom), else the built-in rules."""
    mine = (custom or {}).get(ingredient_key(name))
    if isinstance(mine, str) and mine.strip():
        return mine.strip()
    return next((aisle for aisle, rx in AISLE_RULES if rx.search(name)), "Other")


def clean_aisle(text, data=None):
    """An aisle name the family typed, tidied (same as cleanAisle in core.js): "produce" -> "Produce", "A21" stays."""
    t = " ".join(str(text or "").split())[:30]
    if not t:
        return ""
    known = AISLES + list(((data or {}).get("aisles") or {}).values())
    return next((a for a in known if a.lower() == t.lower()), t)


def set_aisle(data, uid, aisle):
    """Put a list item in an aisle (built-in or typed), and remember it so that item sorts there from now on."""
    item = next((it for it in data["shopping"] if it.get("uid") == uid), None)
    name = clean_aisle(aisle, data)
    if not item or not name:
        return
    key = ingredient_key(item["name"])
    data["aisles"] = dict(data.get("aisles") or {}, **{key: name})
    for it in data["shopping"]:
        if ingredient_key(it["name"]) == key:
            it["aisle"] = name


def natural_key(s):
    """Sort key that puts "A2" before "A10" (same order as naturalCompare in core.js)."""
    parts = [p for i, p in enumerate(re.split(r"([0-9]+)", str(s).lower())) if p != "" or i == 0]
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in parts]


def list_aisles(items):
    """The list's sections in order: built-in aisles, then the family's own (A2 before A10), then "Other"."""
    own = sorted({it.get("aisle") or "Other" for it in items} - set(AISLES), key=natural_key)
    return [a for a in AISLES if a != "Other"] + own + ["Other"]


def aisle_choices(data):
    """Aisles to offer in the picker: the built-in ones (not "Other"), then the ones the family has typed before."""
    own = sorted(set(((data or {}).get("aisles") or {}).values()) - set(AISLES), key=natural_key)
    return [a for a in AISLES if a != "Other"] + own


def aisle_label(a):
    """How an aisle is shown: "Other" is shown as "Not sorted"."""
    return "Not sorted" if not a or a == "Other" else a


def ingredient_key(name):
    """"Onions " and "onion" are the same item on the list."""
    k = " ".join(name.strip().lower().split())
    if re.search(r"(tomatoes|potatoes|chillies)$", k):
        k = k[:-2]
    elif len(k) > 3 and k.endswith("s") and not k.endswith("ss"):
        k = k[:-1]
    return k


QUICK_ITEM = re.compile(r"^([\d\u00bc-\u00be\u2150-\u215e][\d\s/.,\u00bc-\u00be\u2150-\u215e]*"
                        r"(?:\s*(?:g|kg|ml|l|oz|lbs?|cups?|tbsp|tsp|tins?|cans?|packs?|bags?|bunch(?:es)?|cloves?"
                        r"|dozen)\b\.?)?)\s+(.+)$", re.I)


def parse_quick_item(text):
    """"2 lemons" -> ("2", "lemons"); "milk" -> ("", "milk")."""
    m = QUICK_ITEM.match(text.strip())
    return (m.group(1).strip(), m.group(2).strip()) if m else ("", text.strip())


def meal_parts(meal, by_id):
    """A meal's ingredients as [{q, n}] - from the meal, the recipe catalog, or plain ingredient lines."""
    if not meal:
        return []
    if meal.get("parts"):
        return meal["parts"]
    known = by_id.get(meal.get("id"))
    if known and known.get("parts"):
        return known["parts"]
    return [{"q": "", "n": line} for line in meal.get("ingredients", [])]


# ---- quantities on the list: "2 cups" + "1 cup" = "3 cups", and the list's - / + buttons (same as core.js).
FRACTION_CHARS = {"\u00bc": 1 / 4, "\u00bd": 1 / 2, "\u00be": 3 / 4, "\u2153": 1 / 3, "\u2154": 2 / 3,
                  "\u215b": 1 / 8, "\u215c": 3 / 8, "\u215d": 5 / 8, "\u215e": 7 / 8}
FRAC = "[\u00bc\u00bd\u00be\u2153\u2154\u215b\u215c\u215d\u215e]"
QTY_RE = re.compile(r"^\s*([0-9]+/[0-9]+|[0-9]+(?:\.[0-9]+)?(?:\s*" + FRAC + r"|\s+[0-9]+/[0-9]+)?|" + FRAC + r")\s*(.*)$",
                    re.S)
UNIT_PLURALS = {"cup": "cups", "clove": "cloves", "can": "cans", "tin": "tins", "pack": "packs", "package": "packages",
                "packet": "packets", "bag": "bags", "bunch": "bunches", "slice": "slices", "piece": "pieces",
                "stick": "sticks", "head": "heads", "sprig": "sprigs", "pound": "pounds", "ounce": "ounces", "lb": "lbs",
                "jar": "jars", "bottle": "bottles", "box": "boxes", "tablespoon": "tablespoons", "teaspoon": "teaspoons",
                "pinch": "pinches", "dash": "dashes", "handful": "handfuls", "stalk": "stalks", "fillet": "fillets",
                "loaf": "loaves", "carton": "cartons", "dozen": "dozen", "gram": "grams", "liter": "liters"}
UNIT_SINGULARS = {p: s for s, p in UNIT_PLURALS.items()}


def parse_qty(text):
    """"1 1/2 cups" -> (1.5, "cups"); None when it doesn't start with a plain amount (e.g. "2-3", "a pinch")."""
    m = QTY_RE.match(str(text or ""))
    if not m or re.match(r"(-|\u2013|to )", m.group(2), re.I):
        return None
    n = 0
    for bit in re.sub("(" + FRAC + ")", r" \1", m.group(1)).split():
        if bit in FRACTION_CHARS:
            n += FRACTION_CHARS[bit]
        elif "/" in bit:
            a, b = bit.split("/")
            if not int(b):
                return None
            n += int(a) / int(b)
        else:
            n += float(bit)
    return n, m.group(2).strip()


def js_number(x):
    """How JavaScript's String() shows a number: 3 -> "3", 2.5 -> "2.5"."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def format_amount(n):
    """1.5 -> "1\u00bd", 0.25 -> "\u00bc", 3 -> "3", 0.3 -> "0.3"."""
    whole = int((n + 1e-9) // 1)
    rest = n - whole
    if rest < 0.01:
        return str(whole)
    for ch, v in FRACTION_CHARS.items():
        if abs(rest - v) < 0.01:
            return (str(whole) if whole else "") + ch
    return js_number(round_half_up(n * 100) / 100)


def fit_unit(unit, n):
    """The unit with its first word made singular or plural to suit the amount."""
    m = re.match(r"^([A-Za-z]+)(.*)$", unit, re.S)
    if not m:
        return unit
    word = m.group(1).lower()
    single = UNIT_SINGULARS.get(word) or (word if word in UNIT_PLURALS else None)
    if not single:
        return unit
    return (UNIT_PLURALS[single] if n > 1 else single) + m.group(2)


def unit_key(unit):
    return re.sub(r"\s+", " ", fit_unit(unit, 1).lower())


def show_qty(n, unit):
    return format_amount(n) + (" " + fit_unit(unit, n) if unit else "")


def tidy_qty(qty):
    """Add up the parts of a quantity that share a unit: "2 + 1" -> "3", "2 cups + 1 tbsp + 1 cup" -> "3 cups + 1 tbsp"."""
    out = []
    for part in [p.strip() for p in str(qty or "").split(" + ") if p.strip()]:
        q = parse_qty(part)
        same = next((o for o in out if o[0] and q and unit_key(o[0][1]) == unit_key(q[1])), None) if q else None
        if same:
            same[0] = (same[0][0] + q[0], same[0][1])
        else:
            out.append([q, part])
    return " + ".join(show_qty(*o[0]) if o[0] else o[1] for o in out)


def combine_qty(a, b):
    """Two quantities of the same item together."""
    return tidy_qty(a + " + " + b if a and b else a or b or "")


def step_qty(qty, delta):
    """The list's - / + buttons: change the amount by delta, keeping the unit; never down to zero (same as core.js)."""
    parts = [p for p in tidy_qty(qty).split(" + ") if p]
    if not parts:
        return str(1 + delta) if delta > 0 else ""
    q = parse_qty(parts[0])
    if q and re.fullmatch(r"g|grams?|ml|milliliters?", q[1], re.I):  # "200 g" steps as packs: 2 \u00d7 200 g
        q = None
    q = q or (1, "\u00d7 " + parts[0])
    n = q[0] + delta
    if n <= 0:
        return " + ".join(parts)
    parts[0] = q[1][2:] if n == 1 and q[1].startswith("\u00d7 ") else show_qty(n, q[1])
    return " + ".join(parts)


def add_to_list(items, adds, custom_aisles=None):
    """Add ingredients to the list, combining with items still to buy. adds = [{name, qty, meal}]."""
    added = combined = 0
    for a in adds:
        name = a["name"].strip()
        if not name or name.lower() in SKIP_INGREDIENTS:
            continue
        key = ingredient_key(name)
        hit = next((it for it in items if not it["checked"] and ingredient_key(it["name"]) == key), None)
        if hit:
            if a.get("qty"):
                hit["qty"] = combine_qty(hit["qty"], a["qty"])
            if a.get("meal") and a["meal"] not in hit["meals"]:
                hit["meals"] = hit["meals"] + [a["meal"]]
            combined += 1
        else:
            items.append({"name": name[:1].upper() + name[1:], "qty": a.get("qty") or "", "aisle": aisle_of(name, custom_aisles),
                          "checked": False, "meals": [a["meal"]] if a.get("meal") else []})
            added += 1
    return added, combined


# ---------------------------------------------------------------- importing recipes from websites
# Recipe sites publish a machine-readable copy of each recipe (schema.org Recipe in JSON-LD).
# Same rules as extractRecipe() etc. in docs/core.js.

ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "ndash": "\u2013", "mdash": "\u2014",
            "lsquo": "\u2018", "rsquo": "\u2019", "ldquo": "\u201c", "rdquo": "\u201d", "hellip": "\u2026", "deg": "\u00b0",
            "frac12": "\u00bd", "frac14": "\u00bc", "frac34": "\u00be", "frac13": "\u2153", "frac23": "\u2154",
            "eacute": "\u00e9", "egrave": "\u00e8", "ecirc": "\u00ea", "agrave": "\u00e0", "ccedil": "\u00e7",
            "ntilde": "\u00f1", "uuml": "\u00fc", "ouml": "\u00f6", "auml": "\u00e4", "times": "\u00d7", "reg": "\u00ae",
            "copy": "\u00a9", "trade": "\u2122"}
ENTITY_RE = re.compile(r"&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);", re.I)


def clean_text(value):
    """Text from a recipe page: entities decoded, tags removed, spaces tidied."""
    t = "" if value is None else str(value)

    def entity(m):
        e = m.group(1)
        if e[0] == "#":
            code = int(e[2:], 16) if e[1] in "xX" else int(e[1:])
            return chr(code) if 0 < code < 0x110000 else m.group(0)
        return ENTITIES.get(e.lower(), m.group(0))
    for _ in range(2):  # some sites double-encode (&amp;amp;)
        t = ENTITY_RE.sub(entity, t)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", t)).strip()


UNITS = ("fluid ounces?|fl\\.? ?oz|tablespoons?|teaspoons?|kilograms?|milliliters?|millilitres?|ounces?|pounds?|"
         "grams?|liters?|litres?|quarts?|pints?|cups?|tbsps?|tbs|tsps?|lbs?|oz|kg|ml|qts?|pts?|g|l|cans?|jars?|packages?|"
         "pkgs?|packets?|bottles?|boxes?|bags?|cloves?|heads?|bunch(?:es)?|sprigs?|stalks?|sticks?|slices?|pieces?|"
         "pinch(?:es)?|dash(?:es)?|handfuls?|large|medium|small")
NUM = "[0-9\u00bc-\u00be\u2150-\u215e]+(?:[.,/][0-9]+)?(?:\\s+[0-9\u00bc-\u00be\u2150-\u215e]+(?:/[0-9]+)?)?"
AMOUNT_RE = re.compile("^((?:" + NUM + ")(?:\\s*(?:-|\u2013|to)\\s*(?:" + NUM + "))?(?:\\s*\\([^)]*\\))?"
                       "(?:\\s*(?:" + UNITS + ")(?![A-Za-z0-9_])\\.?)?(?:\\s*\\([^)]*\\))?)\\s*(.+)$", re.I)


def parse_ingredient_line(line):
    """"2 (14 oz) cans diced tomatoes, drained" -> {"q": "2 (14 oz) cans", "n": "diced tomatoes"}."""
    text = re.sub("^[\u2022\u25a2\u25a1\u2610\\-*\u00b7]+\\s*", "", clean_text(line))
    m = AMOUNT_RE.match(text)
    q = m.group(1).strip() if m else ""
    n = re.sub(r"\([^)]*\)", " ", m.group(2) if m else text).split(",")[0]
    n = re.sub(r"\s+", " ", re.sub(r"^of\s+", "", n, flags=re.I)).strip()
    return {"q": q, "n": n or text}


def format_duration(iso):
    """"PT1H30M" -> "1 hr 30 min"."""
    m = re.match(r"^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:[0-9.]+S)?)?$", str(iso or ""), re.I)
    if not m:
        return ""
    h, minutes = divmod(int(m.group(1) or 0) * 1440 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0), 60)
    return " ".join(x for x in (f"{h} hr" if h else "", f"{minutes} min" if minutes else "") if x)


def as_list(v):
    return [] if v is None else v if isinstance(v, list) else [v]


def js_str(v):
    """String(v) the way JavaScript would write it, so both apps read recipes the same."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return "null" if v is None else str(v)


def find_recipe(node, depth=0):
    if not isinstance(node, (dict, list)) or depth > 6:
        return None
    if isinstance(node, list):
        return next((r for r in (find_recipe(x, depth + 1) for x in node) if r), None)
    if any(re.search(r"(^|[:/])recipe$", js_str(t), re.I) for t in as_list(node.get("@type"))):
        return node
    for key in ("@graph", "mainEntity", "mainEntityOfPage", "itemListElement"):
        r = find_recipe(node.get(key), depth + 1)
        if r:
            return r
    return None


def image_url(img, base):
    u = ""
    for x in as_list(img):
        u = x if isinstance(x, str) else (x.get("url") or x.get("contentUrl") or "") if isinstance(x, dict) else ""
        if u:
            break
    if not u or not isinstance(u, str):
        return ""
    joined = urllib.parse.urljoin(base, clean_text(u))
    return joined if joined.startswith(("http://", "https://")) else ""


def instruction_lines(node, out, depth=0):
    if depth > 5 or node is None:
        return out
    if isinstance(node, str):
        for part in re.split(r"\r?\n|<br\s*/?>|</p>|</li>", node, flags=re.I):
            t = clean_text(part)
            if t:
                out.append(t)
    elif isinstance(node, list):
        for x in node:
            instruction_lines(x, out, depth + 1)
    elif isinstance(node, dict):
        if any(re.search(r"HowToSection$", js_str(t), re.I) for t in as_list(node.get("@type"))):
            title = clean_text(node.get("name"))
            if title:
                out.append(title + ":")
            instruction_lines(node.get("itemListElement"), out, depth + 1)
        else:
            instruction_lines(node.get("text") or node.get("name") or "", out, depth + 1)
    return out


GUESS = [("breakfast", re.compile(r"(^|[^a-z0-9_])(breakfast|brunch)(?![a-z0-9_])", re.I)),
         ("sides", re.compile(r"(^|[^a-z0-9_])(sides?|side dish)(?![a-z0-9_])", re.I)),
         ("appetizer", re.compile(r"(^|[^a-z0-9_])(appetizers?|starters?|hors d'oeuvres?|finger foods?)(?![a-z0-9_])", re.I)),
         ("lunch", re.compile(r"(^|[^a-z0-9_])(lunch|sandwich|salad|soup)(?![a-z0-9_])", re.I))]


def guess_types(recipe):
    """Categories for an imported recipe, from what the site calls it. Dinner unless it says otherwise."""
    text = " ".join(clean_text(x) for x in as_list(recipe.get("recipeCategory")) + as_list(recipe.get("name")))
    return [t for t, rx in GUESS if rx.search(text)] or ["dinner"]


LD_JSON_RE = re.compile(r"<script\b[^>]*type\s*=\s*[\"']?application/ld\+json[\"']?[^>]*>([\s\S]*?)</script>", re.I)


def extract_recipe(html, page_url):
    """Read the recipe from a web page's HTML, or None if the page has no recipe data we can read."""
    recipe = None
    for m in LD_JSON_RE.finditer(html or ""):
        raw = re.sub(r"^\s*<!--|-->\s*$", "", m.group(1))
        raw = re.sub(r"^\s*//<!\[CDATA\[|//\]\]>\s*$", "", raw).strip()
        try:
            data = json.loads(raw)
        except ValueError:
            try:
                data = json.loads(re.sub("[\u0000-\u001f]+", " ", raw))
            except ValueError:
                data = None
        recipe = find_recipe(data)
        if recipe:
            break
    if not recipe:
        return None
    names = as_list(recipe.get("name"))
    name = clean_text(names[0]) if names else ""
    if not name:
        return None
    lines = []
    for x in as_list(recipe.get("recipeIngredient") or recipe.get("ingredients")):
        for part in (re.split(r"\r?\n", x) if isinstance(x, str) else []):
            t = clean_text(part)
            if t and (not lines or lines[-1] != t):
                lines.append(t)
    ingredients = lines[:80]
    yields = [js_str(y) for y in as_list(recipe.get("recipeYield"))]
    servings = clean_text(next((y for y in yields if re.search("[0-9]", y)), yields[0] if yields else ""))
    time_text = format_duration(recipe.get("totalTime")) or format_duration(recipe.get("cookTime")) or ""
    site = re.sub(r"^www\.", "", urllib.parse.urlparse(page_url).hostname or "")
    notes = " \u00b7 ".join(x for x in (("Serves " + servings if re.match(r"^[0-9]+$", servings) else servings),
                                         time_text, "from " + site if site else "") if x)
    return {"name": name, "thumb": image_url(recipe.get("image"), page_url), "ingredients": ingredients,
            "parts": [parse_ingredient_line(x) for x in ingredients],
            "instructions": "\n".join(instruction_lines(recipe.get("recipeInstructions"), [])),
            "url": page_url, "notes": notes, "types": guess_types(recipe)}


def normalize_url(text):
    """A web address the user pasted, tidied up, or "" if it isn't one."""
    t = re.sub(r"^<|>$", "", (text or "").strip())
    found = re.search(r"https?://[^\s\"'<>]+", t, re.I)
    candidate = found.group(0) if found else ("https://" + t if re.match(r"^[\w-]+(\.[\w-]+)+(/\S*)?$", t) else "")
    parts = urllib.parse.urlsplit(candidate)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return ""
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", parts.query, parts.fragment))


def ingredient_lines(meal):
    """A meal's ingredients as editable lines ("2 cloves garlic")."""
    if meal and meal.get("ingredients"):
        return list(meal["ingredients"])
    return [f"{p['q']} {p['n']}".strip() for p in (meal or {}).get("parts") or []]


def apply_recipe_edits(meal, ingredients_text, instructions):
    """Save edited ingredient lines and steps onto a meal. Unchanged lines keep their split into amount and
    name; edited lines are split again. Same as applyRecipeEdits() in docs/core.js."""
    lines = [t for t in (clean_text(x) for x in re.split(r"\r?\n", ingredients_text or "")) if t]
    before = ingredient_lines(meal)
    old_parts = meal["parts"] if meal.get("parts") and len(meal["parts"]) == len(before) else [parse_ingredient_line(x) for x in before]
    out = dict(meal, ingredients=lines,
               parts=[old_parts[before.index(x)] if x in before else parse_ingredient_line(x) for x in lines],
               instructions=(instructions or "").replace("\r\n", "\n").strip())
    if not lines:
        out.pop("ingredients")
        out.pop("parts")
    if not out["instructions"]:
        out.pop("instructions")
    return out


# Recipe sites turn away requests that don't look like a normal browser visit.
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "gzip, deflate", "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1", "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"'}


def fetch_page(url):
    """Download a web page like a browser would. Returns (final_url, html)."""
    import gzip
    import zlib
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=BROWSER_HEADERS), timeout=20) as resp:
            raw = resp.read(8_000_000)
            enc = resp.headers.get("Content-Encoding", "")
            charset = resp.headers.get_content_charset() or "utf-8"
            final = resp.geturl()
    except urllib.error.HTTPError as e:
        raise SyncError("That site turned the app away." if e.code in (401, 403, 429)
                        else "That page couldn't be found." if e.code == 404 else f"The site answered with error {e.code}.")
    except (urllib.error.URLError, OSError):
        raise SyncError("Couldn't open that page \u2014 check the link and your internet connection.")
    if enc == "gzip":
        raw = gzip.decompress(raw)
    elif enc == "deflate":
        raw = zlib.decompress(raw)
    return final, raw.decode(charset, "replace")


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
            if url.startswith("data:"):  # a photo kept inside the meal
                raw = base64.b64decode(url.split(",", 1)[1])
            elif cache.exists():
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
        self.snapshot = json.loads(json.dumps(self.data))
        self.stamp()
        save_data(self.data)
        self.sync_cfg = load_sync_config()
        self.sb = Supabase(*load_supabase_config())
        self.account = FamilyAccount(self.sb, lambda: self.sync_cfg.get("session"), self.set_session)
        self.sync_job = None
        self.sync_running = False
        self.sync_again = False
        self.sync_waiting = []
        self.ui_queue = queue.Queue()
        self.images = ImageLoader(self)
        self.save_buttons = []  # (button, meal name) pairs to update when Favorites change
        self.catalog, self.catalog_by_id = [], {}  # recipe names/photos/categories, loaded live
        self.details = {}  # full recipes fetched live, by id
        self.catalog_waiting = None  # callbacks to run once the recipe list has loaded
        self.catalog_failed = False
        self.ingredient_hits = ("", set())
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
            "shopping": self.build_shopping_page(),
        }
        for page in self.pages.values():
            page.place(relx=0, rely=0, relwidth=1, relheight=1)

        self.toast = tk.Label(self, bg=TEXT, fg="white", font=(F, 10), padx=16, pady=8)
        self.toast_job = None

        self.bind_all("<MouseWheel>", self.on_mousewheel)
        self.viewing_last = False
        if self.sync_ready():
            self.sync_now(then=self.roll_over_week)  # get the phone's changes before starting a new week
        else:
            self.roll_over_week()
        self.after(SYNC_EVERY_MS, self.periodic_sync)
        self.refresh_week()
        self.refresh_explore()
        self.refresh_favs()
        self.refresh_shopping()
        self.show_page("week")

        self.ensure_catalog(quiet=True)  # recipe names and photos, live
        self.backfill_photos()

    # ------------------------------------------------------------ plumbing

    def save(self):
        self.stamp()
        save_data(self.data)
        self.schedule_sync()

    def stamp(self):
        """Record what changed since the last save, so syncing can merge edits from both devices."""
        now, d, prev = now_ms(), self.data, self.snapshot
        strip = lambda m: {k: v for k, v in m.items() if k != "updated"}
        for key in ("favorites", "shopping"):
            before = {f.get("uid"): f for f in prev.get(key, [])}
            seen = set()
            for i, f in enumerate(d.get(key, [])):
                if not f.get("uid"):
                    f["uid"], f["added"] = uuid.uuid4().hex, now + i
                seen.add(f["uid"])
                old = before.get(f["uid"])
                if old is None or strip(old) != strip(f):
                    f["updated"] = now
            for uid in before:
                if uid and uid not in seen:
                    d["tombstones"][uid] = now
        d["week"] = [slim_meal(m) for m in d["week"]]
        d["sides"] = [slim_meal(m) for m in d["sides"]]
        for h in d["history"]:
            h["week"] = [slim_meal(m) for m in h["week"]]
            h["sides"] = [slim_meal(m) for m in h["sides"]]
        if any(prev.get(k) != d.get(k) for k in PLAN_KEYS):
            d["plan_updated"] = now
        if any(prev.get(k) != d.get(k) for k in SETTINGS_KEYS):
            d["settings_updated"] = now
        self.snapshot = json.loads(json.dumps(d))

    # ------------------------------------------------------------ sync

    def set_session(self, session):
        self.sync_cfg["session"] = session
        save_sync_config(self.sync_cfg)

    def sync_ready(self):
        return bool(self.sync_cfg.get("session") and self.sync_cfg.get("family"))

    def schedule_sync(self, delay=2000):
        if not self.sync_ready():
            return
        if self.sync_job:
            self.after_cancel(self.sync_job)
        self.sync_job = self.after(delay, self.sync_now)

    def periodic_sync(self):
        if self.sync_ready() and not self.sync_running:
            self.sync_now()
        self.after(SYNC_EVERY_MS, self.periodic_sync)

    def sync_now(self, then=None):
        """Pull the phone's changes, merge, and push the result back."""
        if then:
            self.sync_waiting.append(then)
        if not self.sync_ready():
            return self._sync_finished(None)
        if self.sync_running:
            self.sync_again = True
            return
        self.sync_job = None
        self.sync_running = True
        self.set_sync_status("syncing")
        store = FamilyStore(self.account, self.sync_cfg["family"]["family_id"])

        def pulled(result, error):
            if error:
                return self._sync_finished(error)
            remote, sha = result
            merged = merge_data(self.data, remote)
            if canonical(merged) != canonical(self.data):
                self.apply_synced(merged)
            if remote is not None and canonical(merged) == canonical(remote):
                return self._sync_finished(None)
            self.background(lambda: store.push(merged, sha), pushed)

        def pushed(_, error):
            if isinstance(error, SyncConflict):
                self.sync_again, error = True, None
            self._sync_finished(error)

        self.background(store.pull, pulled)

    def _sync_finished(self, error):
        self.sync_running = False
        if error and getattr(error, "signed_out", False):
            self.sign_out()
            self.notify("This computer lost its family connection — ask the primary household member for an invite")
        elif error and "not in this family" in str(error):
            self.sync_cfg.pop("family", None)
            save_sync_config(self.sync_cfg)
            self.notify("You're no longer in that family. Your meals are still on this computer.")
        if self.sync_ready():
            if error:
                self.set_sync_status("error", str(error))
            else:
                self.sync_cfg["last_sync"] = now_ms()
                save_sync_config(self.sync_cfg)
                self.set_sync_status("ok")
        else:
            self.set_sync_status("off")
        waiting, self.sync_waiting = self.sync_waiting, []
        for fn in waiting:
            fn()
        if self.sync_again:
            self.sync_again = False
            self.schedule_sync(500)

    def apply_synced(self, merged):
        """Use data merged with the phone's copy, and redraw what changed."""
        old = self.data
        self.data = merged
        self.snapshot = json.loads(json.dumps(merged))
        save_data(merged)
        self.set_source(merged["source"], save=False)
        if canonical(old["filters"]) != canonical(merged["filters"]):
            self.style_filter_chips()
            self.refresh_cuisine_menu()
            self.refresh_explore()
        self.refresh_week()
        self.refresh_favs()
        self.refresh_hearts()
        self.refresh_shopping()

    def set_sync_status(self, state, detail=""):
        self.sync_state, self.sync_detail = state, detail
        text, color = {
            "off": ("\u21c5  Family", MUTED),
            "syncing": ("\u21c5  Syncing\u2026", MUTED),
            "ok": ("\u2713  Synced", GREEN),
            "error": ("\u26a0  Sync problem", ACCENT_DARK),
        }[state]
        self.sync_chip.config(text=text, fg=color)
        tip = detail or {"off": "Share your plan, favorites and list with your family",
                         "syncing": "Syncing with your family\u2026",
                         "ok": "Your plan, favorites and list are synced with your family"}.get(state, "")
        self.sync_tooltip.text = tip
        if getattr(self, "sync_status_label", None) and self.sync_status_label.winfo_exists():
            self.sync_status_label.config(text=self.sync_status_text(), fg=color)

    def sync_status_text(self):
        if self.sync_state == "error":
            return self.sync_detail
        if self.sync_state == "syncing":
            return "Syncing\u2026"
        if self.sync_state == "ok":
            when = datetime.datetime.fromtimestamp(self.sync_cfg.get("last_sync", now_ms()) / 1000)
            return f"Synced at {when:%I:%M %p}".replace(" 0", " ")
        return "Not synced yet."

    def sign_out(self):
        self.sync_cfg = {}
        save_sync_config({})
        self.set_sync_status("off")

    def sync_dialog(self):
        """The Family window: set up (or join) a family -> members and QR invites. No emails anywhere."""
        win = tk.Toplevel(self, bg=CARD)
        win.title("Family")
        win.transient(self)
        win.resizable(False, False)
        win.geometry(f"+{self.winfo_rootx() + 300}+{self.winfo_rooty() + 60}")
        win.bind("<Escape>", lambda e: win.destroy())
        frm = tk.Frame(win, bg=CARD, padx=24, pady=20, width=460)
        frm.pack(fill="both", expand=True)
        state = {"email": None, "invite": None, "error": None}

        def entry(parent, label, width=34, big=False):
            tk.Label(parent, text=label, bg=CARD, fg=TEXT, font=(F, 10, "bold")).pack(anchor="w", pady=(10, 4))
            var = tk.StringVar()
            e = tk.Entry(parent, textvariable=var, width=width, relief="flat", bg=GHOST,
                         font=(F, 16, "bold") if big else (F, 11), highlightthickness=1,
                         highlightbackground=BORDER, highlightcolor=ACCENT)
            e.pack(anchor="w", ipady=5, fill="x")
            return var, e

        def run(work, done=None):
            """Do a network step in the background, then redraw the window (showing any error)."""
            def finished(result, error):
                state["error"] = str(error) if error else None
                if not error and done:
                    done(result)
                if win.winfo_exists():
                    draw()
            self.background(work, finished)

        def enter_family(family, joining):
            if joining:  # a newly joined computer takes the family's week plan and settings
                self.data["plan_updated"] = 0
                self.data["settings_updated"] = 0
            self.sync_cfg["family"] = family
            save_sync_config(self.sync_cfg)
            self.sync_now(then=lambda: (self.roll_over_week(), win.winfo_exists() and draw()))

        def draw():
            for w in frm.winfo_children():
                w.destroy()
            tk.Label(frm, text="Family", bg=CARD, fg=TEXT, font=(F, 16, "bold")).pack(anchor="w")
            tk.Label(frm, text="Share one week plan, favorites and shopping list with your family.",
                     bg=CARD, fg=MUTED, font=(F, 9)).pack(anchor="w", pady=(0, 6))
            family = self.sync_cfg.get("family")
            if not self.sb.configured:
                tk.Label(frm, bg=CARD, fg=TEXT, font=(F, 10), justify="left", wraplength=420, text=(
                    "Family sharing isn't set up in this copy of the app yet.\n\n"
                    "Set it up by following \u201cSet up family sharing\u201d in README.md, then restart the app.")).pack(anchor="w")
            elif not family:
                tk.Label(frm, text="Set up your family", bg=CARD, fg=ACCENT_DARK, font=(F, 11, "bold")).pack(anchor="w", pady=(6, 0))
                tk.Label(frm, bg=CARD, fg=MUTED, font=(F, 9), justify="left", wraplength=420, text=(
                    "This computer runs the family. Next, invite a phone with a QR code \u2014 the first phone "
                    "to join becomes the primary household member and can invite everyone else. No emails or "
                    "passwords.")).pack(anchor="w")
                fam_name, fam_entry = entry(frm, "Family name")
                fam_entry.focus_set()
                name2, _ = entry(frm, "Family member name (you)")

                def start():
                    if not fam_name.get().strip() or not name2.get().strip():
                        state["error"] = "Enter a family name and your family member name."
                        return draw()

                    def work():
                        self.account.ensure_signed_in()
                        return self.account.create_family(fam_name.get().strip(), name2.get().strip())
                    run(work, lambda fam: enter_family(fam, False))
                button(frm, "Set up family", start).pack(anchor="w", pady=(10, 0))
                tk.Label(frm, text="Already have a family on another computer?", bg=CARD, fg=ACCENT_DARK,
                         font=(F, 10, "bold")).pack(anchor="w", pady=(20, 0))
                code, _ = entry(frm, "Invite code", width=14, big=True)
                name, _ = entry(frm, "Family member name")

                def join():
                    if not name.get().strip():
                        state["error"] = "Enter a family member name."
                        return draw()

                    def work():
                        self.account.ensure_signed_in()
                        return self.account.join_family(code.get(), name.get().strip())
                    run(work, lambda fam: enter_family(fam, True))
                button(frm, "Join family", join, "soft").pack(anchor="w", pady=(10, 0))
            else:
                manager = family.get("role") in ("owner", "primary")
                tk.Label(frm, text=family["name"], bg=CARD, fg=TEXT, font=(F, 13, "bold")).pack(anchor="w", pady=(4, 0))
                self.sync_status_label = tk.Label(frm, text=self.sync_status_text(), bg=CARD, font=(F, 9, "bold"),
                                                  fg=ACCENT_DARK if self.sync_state == "error" else GREEN,
                                                  wraplength=420, justify="left")
                self.sync_status_label.pack(anchor="w")
                tk.Label(frm, text="MEMBERS", bg=CARD, fg=MUTED, font=(F, 9, "bold")).pack(anchor="w", pady=(12, 4))

                def remove(uid, who):
                    if messagebox.askyesno("Remove", f"Remove {who} from the family?", parent=win):
                        run(lambda: self.account.remove_member(family["family_id"], uid),
                            lambda fam: (self.sync_cfg.update(family=fam), save_sync_config(self.sync_cfg)))

                for m in family.get("members", []):
                    row = tk.Frame(frm, bg=CARD)
                    row.pack(fill="x", pady=2)
                    label = (m.get("display_name") or "(no name)") + ("  (you)" if m.get("me") else "")
                    tk.Label(row, text=label, bg=CARD, fg=TEXT, font=(F, 10)).pack(side="left")
                    role = ROLE_LABELS.get(m.get("role"), "")
                    if role:
                        tk.Label(row, text=role, bg=CARD, fg=ACCENT_DARK, font=(F, 9, "bold")).pack(side="left", padx=8)
                    if manager and not m.get("me") and m.get("role") != "owner":
                        x = tk.Label(row, text="Remove", bg=CARD, fg=MUTED, font=(F, 9, "underline"), cursor="hand2")
                        x.pack(side="right")
                        x.bind("<Button-1>", lambda e, uid=m["user_id"], who=m.get("display_name") or "this person":
                               remove(uid, who))
                if state["invite"]:
                    box = tk.Frame(frm, bg=ACCENT_SOFT, padx=14, pady=10)
                    box.pack(fill="x", pady=(12, 0))
                    link = web_app_url() + "#join=" + state["invite"] if web_app_url() else ""
                    photo = qr_photo(link, 200) if link else None
                    if photo:
                        tk.Label(box, text="SCAN WITH A PHONE TO JOIN", bg=ACCENT_SOFT, fg=ACCENT_DARK,
                                 font=(F, 8, "bold")).pack()
                        img = tk.Label(box, image=photo, bg="white", bd=0)
                        img.image = photo
                        img.pack(pady=6)
                        tk.Label(box, text="Point the phone's camera at the code and tap the link. The app opens "
                                           "and asks for their family member name, then they're in.",
                                 bg=ACCENT_SOFT, fg=MUTED, font=(F, 8), wraplength=380, justify="center").pack()
                    tk.Label(box, text="INVITE CODE", bg=ACCENT_SOFT, fg=ACCENT_DARK, font=(F, 8, "bold")).pack(pady=(8, 0))
                    tk.Label(box, text=format_invite_code(state["invite"]), bg=ACCENT_SOFT, fg=TEXT,
                             font=(F, 22, "bold")).pack()
                    tk.Label(box, text="Works for 7 days, for as many family members as you like.",
                             bg=ACCENT_SOFT, fg=MUTED, font=(F, 8)).pack()

                    def copy_invite():
                        code_text = format_invite_code(state["invite"])
                        self.clipboard_clear()
                        self.clipboard_append(
                            "Join our family on Meal Planner! "
                            + (f"Tap this link on your phone: {link}\n\nOr open" if link else "Open")
                            + f" the app, go to Family and enter the invite code {code_text}. It works for 7 days.")
                        self.notify("Invite copied \u2014 paste it in a text or message")
                    button(box, "Copy invite message", copy_invite, "primary", small=True).pack(pady=(6, 0))
                if not any(m.get("role") == "primary" for m in family.get("members", [])):
                    tk.Label(frm, bg=CARD, fg=MUTED, font=(F, 9), justify="left", wraplength=420, text=(
                        "Next: tap Invite someone and scan the QR code with a phone. The first phone to join "
                        "becomes the primary household member, who can invite everyone else.")).pack(anchor="w", pady=(10, 0))
                row = tk.Frame(frm, bg=CARD)
                row.pack(anchor="w", pady=(12, 0))
                if manager:
                    button(row, "Invite someone", lambda: run(lambda: self.account.create_invite(family["family_id"]),
                                                              lambda inv: state.update(invite=inv["code"]))).pack(side="left", padx=(0, 8))
                button(row, "Sync now", lambda: self.sync_now(then=lambda: win.winfo_exists() and draw()), "ghost").pack(side="left")
                row2 = tk.Frame(frm, bg=CARD)
                row2.pack(anchor="w", pady=(14, 0))

                def leave():
                    warn = ("\n\nThis computer runs the family: the primary household member takes over, and this "
                            "computer can only come back with a new invite." if family.get("role") == "owner" else "")
                    if messagebox.askyesno("Leave family", "Leave this family? Your meals stay on this computer." + warn, parent=win):
                        run(lambda: self.account.leave_family(family["family_id"]),
                            lambda _: (self.sync_cfg.pop("family", None), save_sync_config(self.sync_cfg), self.set_sync_status("off")))
                button(row2, "Leave family", leave, "ghost", small=True).pack(side="left")
            if state["error"]:
                tk.Label(frm, text=state["error"], bg=CARD, fg=ACCENT_DARK, font=(F, 9, "bold"), wraplength=420,
                         justify="left").pack(anchor="w", pady=(10, 0))

        draw()
        if self.sync_ready():  # refresh the member list
            def got(families, error):
                fam_id = self.sync_cfg.get("family", {}).get("family_id")
                mine = next((f for f in families or [] if f["family_id"] == fam_id), None) if not error else None
                if mine:
                    self.sync_cfg["family"] = mine
                    save_sync_config(self.sync_cfg)
                if win.winfo_exists():
                    draw()
            self.background(self.account.my_families, got)
        win.grab_set()

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

    def background(self, work, on_done):
        """Run work() on a worker thread, then on_done(result, error) on the UI thread (no message)."""
        def worker():
            try:
                result, error = work(), None
            except Exception as e:
                result, error = None, e
            self.call_on_ui(lambda: on_done(result, error))

        threading.Thread(target=worker, daemon=True).start()

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
        """Load the list of recipes live from TheMealDB (a second or two), then call `then`."""
        if self.catalog:
            return then and then()
        if self.catalog_waiting is not None:  # already loading
            if then:
                self.catalog_waiting.append(then)
            return
        self.catalog_waiting = [then] if then else []
        self.catalog_failed = False
        if not quiet:
            self.notify("Loading recipes from TheMealDB\u2026", sticky=True)

        def finished(meals, error):
            waiting, self.catalog_waiting = self.catalog_waiting, None
            if error or not meals:
                self.catalog_failed = True
                self.refresh_explore()
                if not quiet:
                    self.notify("Couldn't reach TheMealDB \u2014 check your internet connection")
                return
            self.catalog = meals
            self.catalog_by_id = {m["id"]: m for m in meals}
            self.explore_order = self.shuffled_ids()
            self.refresh_cuisine_menu()
            self.refresh_explore()
            if not quiet:
                self.toast.place_forget()
            for fn in waiting:
                fn()

        self.background(fetch_index, finished)

    def reload_catalog(self):
        self.catalog, self.catalog_by_id = [], {}
        self.refresh_explore()
        self.ensure_catalog()

    def full_meal(self, meal):
        """A meal with whatever we know about it: its list entry, its fetched recipe, and its own fields."""
        return {**self.catalog_by_id.get(meal.get("id"), {}), **self.details.get(meal.get("id"), {}), **meal}

    def needs_details(self, meal):
        m = self.full_meal(meal)
        return bool(m.get("id") and not m.get("instructions") and not m.get("parts"))

    def with_details(self, meals, then):
        """Fetch full recipes (ingredients, instructions) live for any of these meals that need it, then call `then`."""
        ids = sorted({m["id"] for m in meals if self.needs_details(m)})
        if not ids:
            return then()

        def done(found, error):
            if error:
                return self.notify("Couldn't reach TheMealDB \u2014 check your internet connection")
            self.details.update(found)
            self.toast.place_forget()
            then()
        self.run_in_background(lambda: fetch_by_ids(ids), done, "Loading recipe\u2026")

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
        self.sync_chip = tk.Label(bar, bg=CARD, font=(F, 10, "bold"), cursor="hand2", padx=10)
        self.sync_chip.pack(side="left")
        self.sync_chip.bind("<Button-1>", lambda e: self.sync_dialog())
        self.sync_tooltip = Tooltip(self.sync_chip, "")
        self.set_sync_status("off")
        self.nav = {}
        for key, label in [("shopping", "\u2611  Shopping"), ("favorites", "♥  Favorites"), ("explore", "✨  Explore"),
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
        shop = button(actions, "\u2611  Shopping", self.week_ingredients, "ghost")
        shop.pack(side="right", padx=(0, 8))
        Tooltip(shop, "Add this week's ingredients to your shopping list")
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
        """Show a recipe, fetching its ingredients and instructions live first if needed."""
        self.with_details([meal], lambda: self.show_details(self.full_meal(meal)))

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
                img.bind("<Button-1>", lambda e, m=meal: self.open_meal(m))
                name = tk.Label(body, text=meal["name"], bg=CARD, fg=TEXT, font=(F, 10, "bold"),
                                wraplength=146, justify="left", anchor="w", cursor="hand2")
                name.pack(fill="x")
                name.bind("<Button-1>", lambda e, m=meal: self.open_meal(m))
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
        if side and not any("sides" in meal_types(m) for m in self.data["favorites"]):
            return messagebox.showinfo("No sides yet", "None of your favorites are tagged Side yet.\n\n"
                                       "On the Favorites page, click a meal's Side tag (or tick Side when "
                                       "adding a meal) and it will show up here.")
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
        hint = ("Click a side to serve it this day. Only favorites tagged Side are shown." if side else
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
            favs = sorted((m for m in self.data["favorites"] if not side or "sides" in meal_types(m)),
                          key=lambda m: m["name"].lower())
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
            photo = qr_photo("SMSTO::" + message())
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
                                      "Recipes from TheMealDB. Click a photo for the full recipe.")
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
        self.search_job = self.after(250, self.search_changed)

    def search_changed(self):
        self.filters_changed()
        # Also ask TheMealDB live which recipes use this ingredient ("garlic", "chicken breast").
        term = self.search_entry.get().strip().lower()
        if len(term) < 3 or self.ingredient_hits[0] == term:
            return

        def done(ids, error):
            if error or self.search_entry.get().strip().lower() != term:
                return
            self.ingredient_hits = (term, ids)
            self.refresh_explore()
        self.background(lambda: search_ingredient(term), done)

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
        query = self.search_entry.get().strip().lower()
        words = query.split()
        # Ingredient matches come live from TheMealDB (see on_search_key).
        by_ingredient = self.ingredient_hits[1] if self.ingredient_hits[0] == query else set()
        result = []
        for mid in self.explore_order:
            m = self.catalog_by_id[mid]
            if areas is not None and m["area"] not in areas:
                continue
            if t != "all" and t not in meal_types(m):
                continue
            if words:
                text = " ".join([m["name"], m["category"], m["area"]]).lower()
                if not all(w in text for w in words) and m["id"] not in by_ingredient:
                    continue
            if self.passes_leave_out(m):
                result.append(m)
        return result

    def refresh_explore(self):
        grid = self.pages["explore"].cards
        if not self.catalog:
            self.filter_count.config(text="")
            if self.catalog_failed:
                retry = tk.Frame(grid.inner, bg=BG)
                tk.Label(retry, text="Couldn't reach TheMealDB. Check your internet connection.", bg=BG, fg=MUTED,
                         font=(F, 12)).pack(pady=(60, 12))
                button(retry, "Try again", self.reload_catalog).pack()
                return grid.set_cards([retry])
            return grid.set_cards([], "Loading recipes from TheMealDB\u2026")
        visible = self.explore_visible()
        shown = visible[:self.explore_limit]
        self.filter_count.config(text=f"Showing {len(shown)} of {len(visible)} matching recipes"
                                 + (f" ({len(self.catalog)} total)" if len(visible) != len(self.catalog) else ""))
        cards = []
        for meal in shown:
            card, body = meal_card(grid.inner, self.images, meal, (220, 160),
                                   on_open=lambda m=meal: self.open_meal(m))
            row = tk.Frame(body, bg=CARD)
            row.pack(fill="x", side="bottom", pady=(8, 0))
            self.heart_button(row, meal).pack(side="left")
            button(row, "View recipe", lambda m=meal: self.open_meal(m), "ghost", small=True).pack(side="right")
            cards.append(card)
        if len(visible) > len(shown):
            more = tk.Frame(grid.inner, bg=BG)
            left = len(visible) - len(shown)
            button(more, f"Show {min(PAGE_SIZE, left)} more", self.show_more_explore).pack(expand=True, pady=60)
            tk.Label(more, text=f"{left} more recipes", bg=BG, fg=MUTED, font=(F, 9)).pack()
            cards.append(more)
        grid.set_cards(cards, "No recipes match these filters.\nTry another cuisine or meal type, "
                              "or turn off a Leave out option.")

    # ------------------------------------------------------------ Shopping list

    def build_shopping_page(self):
        page = tk.Frame(self.pages_frame, bg=BG)
        self.shop_title, actions = self.page_header(
            page, "Shopping list", "Sorted by aisle. Tick items as they go in the cart.")
        self.clear_btn = button(actions, "Clear checked", self.clear_checked, "ghost")
        self.clear_btn.pack(side="right")
        button(actions, "\u2611  Add this week's ingredients", self.week_ingredients, "soft").pack(side="right", padx=8)
        add = button(actions, "Add", self.quick_add_item)
        add.pack(side="right")
        self.item_entry = PlaceholderEntry(actions, "Add an item, e.g. 2 lemons", width=28)
        self.item_entry.pack(side="right", padx=8, ipady=5)
        self.item_entry.bind("<Return>", lambda e: self.quick_add_item())
        page.cards = ScrollGrid(page, card_width=330)
        page.cards.pack(fill="both", expand=True, padx=8)
        return page

    def quick_add_item(self):
        qty, name = parse_quick_item(self.item_entry.get())
        if not name:
            return self.item_entry.focus_set()
        add_to_list(self.data["shopping"], [{"name": name, "qty": qty}], self.data.get("aisles"))
        self.item_entry.delete(0, "end")
        self.shopping_changed()

    def shopping_changed(self):
        self.save()
        self.refresh_shopping()

    def toggle_item(self, uid):
        for it in self.data["shopping"]:
            if it["uid"] == uid:
                it["checked"] = not it["checked"]
        self.shopping_changed()

    def step_item(self, uid, delta):
        """The list's - / + buttons: change how much of an item to buy (never down to zero)."""
        it = next((x for x in self.data["shopping"] if x["uid"] == uid), None)
        new = it and step_qty(it.get("qty") or "", delta)
        if it and new != (it.get("qty") or ""):
            it["qty"] = new
            self.shopping_changed()

    def aisle_menu(self, uid, widget):
        """Pick the aisle for a list item; the list remembers it for that item from then on."""
        it = next((x for x in self.data["shopping"] if x["uid"] == uid), None)
        if not it:
            return
        menu = tk.Menu(self, tearoff=False, font=(F, 10))
        menu.add_command(label=f"Which aisle is “{it['name']}” in?", state="disabled")
        menu.add_separator()
        for aisle in aisle_choices(self.data):
            now = (it.get("aisle") or "Other") == aisle
            menu.add_command(label=("✓  " if now else "     ") + aisle,
                             command=lambda a=aisle: self.set_item_aisle(uid, a))
        menu.add_separator()
        menu.add_command(label="     Type an aisle…  (e.g. A21 or Outdoors)", command=lambda: self.type_aisle(uid))
        menu.tk_popup(widget.winfo_rootx(), widget.winfo_rooty() + widget.winfo_height())

    def type_aisle(self, uid):
        """Name the aisle yourself: a store's aisle number ("A21") or a section ("Outdoors")."""
        it = next((x for x in self.data["shopping"] if x["uid"] == uid), None)
        if not it:
            return
        now = it.get("aisle") or "Other"
        typed = simpledialog.askstring("Aisle", f"Which aisle is “{it['name']}” in?\n"
                                       "Type a store aisle like A21, or a section like Outdoors.",
                                       initialvalue="" if now in AISLES else now, parent=self)
        name = clean_aisle(typed, self.data)
        if name:
            self.set_item_aisle(uid, name)

    def set_item_aisle(self, uid, aisle):
        set_aisle(self.data, uid, aisle)
        self.shopping_changed()
        self.notify(f"Moved to {aisle} — it’ll go there from now on")

    def remove_item(self, uid):
        self.data["shopping"] = [it for it in self.data["shopping"] if it["uid"] != uid]
        self.shopping_changed()

    def clear_checked(self):
        self.data["shopping"] = [it for it in self.data["shopping"] if not it["checked"]]
        self.shopping_changed()

    def refresh_shopping(self):
        items = self.data["shopping"]
        to_buy = [it for it in items if not it["checked"]]
        done = [it for it in items if it["checked"]]
        self.nav["shopping"].config(text=f"\u2611  Shopping ({len(to_buy)})" if to_buy else "\u2611  Shopping")
        self.shop_title.config(text=f"Shopping list \u00b7 {len(to_buy)} to buy" if items else "Shopping list")
        self.clear_btn.config(text=f"Clear {len(done)} checked" if done else "Clear checked",
                              state="normal" if done else "disabled")
        grid = self.pages["shopping"].cards
        cards = []
        groups = [(aisle, sorted((it for it in to_buy if (it.get("aisle") or "Other") == aisle),
                                 key=lambda it: it["name"].lower())) for aisle in list_aisles(to_buy)]
        groups = [(a, g) for a, g in groups if g] + ([("In cart", done)] if done else [])
        for aisle, group in groups:
            card = tk.Frame(grid.inner, bg=CARD, highlightthickness=1, highlightbackground=BORDER, padx=12, pady=10)
            tk.Label(card, text=aisle_label(aisle).upper(), bg=CARD, fg=ACCENT_DARK if aisle != "In cart" else MUTED,
                     font=(F, 9, "bold"), anchor="w").pack(fill="x", pady=(0, 4))
            for it in group:
                row = tk.Frame(card, bg=CARD)
                row.pack(fill="x", pady=2)
                var = tk.BooleanVar(value=it["checked"])
                tk.Checkbutton(row, variable=var, bg=CARD, activebackground=CARD, cursor="hand2",
                               command=lambda u=it["uid"]: self.toggle_item(u)).pack(side="left", anchor="n")
                text = tk.Frame(row, bg=CARD)
                text.pack(side="left", fill="x", expand=True)
                label = it["name"] + (f"  \u2014 {it['qty']}" if it.get("qty") and it["checked"] else "")
                name = tk.Label(text, text=label, bg=CARD, fg=MUTED if it["checked"] else TEXT, anchor="w",
                                justify="left", wraplength=150 if not it["checked"] else 250, cursor="hand2",
                                font=(F, 10, "overstrike") if it["checked"] else (F, 10, "bold"))
                name.pack(fill="x")
                name.bind("<Button-1>", lambda e, u=it["uid"]: self.toggle_item(u))
                if it.get("meals"):
                    tk.Label(text, text="for " + ", ".join(it["meals"]), bg=CARD, fg=MUTED, font=(F, 8),
                             anchor="w", justify="left", wraplength=250).pack(fill="x")
                x = tk.Label(row, text="\u2715", bg=CARD, fg=MUTED, cursor="hand2", font=(F, 10), padx=5)
                x.pack(side="right", anchor="n", padx=(6, 0))
                x.bind("<Button-1>", lambda e, u=it["uid"]: self.remove_item(u))
                x.bind("<Enter>", lambda e, w=x: w.config(bg=ACCENT_SOFT, fg=ACCENT_DARK))
                x.bind("<Leave>", lambda e, w=x: w.config(bg=CARD, fg=MUTED))
                Tooltip(x, f"Remove {it['name']} from the list")
                if not it["checked"]:
                    # how much to buy, as one pill: [ - amount + ]
                    pill = tk.Frame(row, bg=GHOST, padx=2, pady=1)
                    pill.pack(side="right", anchor="n")
                    for text_, delta in (("\u2212", -1), ("QTY", 0), ("+", 1)):
                        if delta:
                            b = tk.Label(pill, text=text_, bg=GHOST, fg=TEXT, cursor="hand2", font=(F, 11, "bold"), width=2)
                            b.bind("<Button-1>", lambda e, u=it["uid"], d=delta: self.step_item(u, d))
                            b.bind("<Enter>", lambda e, w=b: w.config(bg=CARD))
                            b.bind("<Leave>", lambda e, w=b: w.config(bg=GHOST))
                            Tooltip(b, ("More " if delta > 0 else "Less ") + it["name"])
                        else:
                            b = tk.Label(pill, text=it.get("qty") or "1", bg=GHOST, fg=TEXT if it.get("qty") else MUTED,
                                         font=(F, 10, "bold" if it.get("qty") else "normal"), wraplength=90, justify="center")
                        b.pack(side="left")
                    # the aisle: pick one when it didn't sort itself, or move it
                    other = (it.get("aisle") or "Other") == "Other"
                    move = tk.Label(text, text="Choose aisle \u25be" if other else "Move \u25be", cursor="hand2",
                                    bg=ACCENT_SOFT if other else CARD, fg=ACCENT_DARK if other else MUTED,
                                    font=(F, 8, "bold"), padx=6 if other else 0)
                    move.pack(anchor="w", pady=(2, 0))
                    move.bind("<Button-1>", lambda e, u=it["uid"], w=move: self.aisle_menu(u, w))
            cards.append(card)
        grid.set_cards(cards, "Your shopping list is empty.\nClick \u201cAdd this week's ingredients\u201d, "
                              "or open any recipe and add its ingredients.")

    def week_ingredients(self):
        d = self.data
        meals = []
        for day, meal, side in zip(DAYS, d["week"], d["sides"]):
            if meal:
                meals.append((day, meal))
            if side:
                meals.append((day + " side", side))
        if not meals:
            return self.notify("Plan some meals first")
        self.with_details([m for _, m in meals], lambda: self.ingredients_dialog(meals))

    def ingredients_dialog(self, meals):
        """Tick the ingredients you need for one or more meals, then add them to the shopping list."""
        win = tk.Toplevel(self, bg=BG)
        win.title("Add to shopping list")
        win.transient(self)
        win.geometry(f"620x640+{self.winfo_rootx() + 260}+{self.winfo_rooty() + 40}")
        win.bind("<Escape>", lambda e: win.destroy())
        head = tk.Frame(win, bg=BG, padx=20, pady=14)
        head.pack(fill="x")
        tk.Label(head, text="Add to shopping list", bg=BG, fg=TEXT, font=(F, 15, "bold")).pack(anchor="w")
        tk.Label(head, text="Untick anything you already have. Matching items already on your list are combined.",
                 bg=BG, fg=MUTED, font=(F, 9)).pack(anchor="w")
        foot = tk.Frame(win, bg=BG, padx=20, pady=12)
        foot.pack(side="bottom", fill="x")
        win.scroll_grid = grid = ScrollGrid(win, card_width=560, gap=12)
        grid.pack(fill="both", expand=True)

        checks = []
        cards = []
        for label, meal in meals:
            full = self.full_meal(meal)
            card = tk.Frame(grid.inner, bg=CARD, highlightthickness=1, highlightbackground=BORDER, padx=12, pady=10)
            title = f"{label}: {meal['name']}" if label else meal["name"]
            tk.Label(card, text=title, bg=CARD, fg=TEXT, font=(F, 11, "bold"), anchor="w", wraplength=520,
                     justify="left").pack(fill="x", pady=(0, 4))
            parts = meal_parts(full, self.details)
            if not parts:
                tk.Label(card, text="No ingredients saved for this meal.", bg=CARD, fg=MUTED, font=(F, 9),
                         anchor="w").pack(fill="x")
            for part in parts:
                var = tk.BooleanVar(value=part["n"].strip().lower() not in SKIP_INGREDIENTS)
                text = part["n"] + (f"  \u2014 {part['q']}" if part["q"] else "")
                tk.Checkbutton(card, text=text, variable=var, bg=CARD, activebackground=CARD, anchor="w",
                               font=(F, 10), cursor="hand2", command=lambda: update()).pack(fill="x")
                checks.append((var, {"name": part["n"], "qty": part["q"], "meal": meal["name"]}))
            cards.append(card)
        grid.set_cards(cards)

        def update():
            n = sum(v.get() for v, _ in checks)
            add_btn.config(text=f"Add {n} to shopping list" if n else "Add to shopping list")

        def add():
            adds = [a for v, a in checks if v.get()]
            if not adds:
                return self.notify("Tick the ingredients you need")
            added, combined = add_to_list(self.data["shopping"], adds, self.data.get("aisles"))
            self.shopping_changed()
            win.destroy()
            self.notify(f"Added {added} item{'s' if added != 1 else ''} to your shopping list"
                        + (f", {combined} combined with items already on it" if combined else ""))

        button(foot, "Cancel", win.destroy, "ghost").pack(side="right")
        add_btn = button(foot, "Add to shopping list", add)
        add_btn.pack(side="right", padx=8)
        update()
        win.grab_set()

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
        if meal_parts(meal, self.details):
            button(info, "\u2611  Add ingredients to shopping list", lambda: self.ingredients_dialog([("", meal)]),
                   "soft").pack(anchor="w", pady=(8, 0))

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
        button(actions, "\u2913  Import from a website", self.import_recipe_dialog, "soft").pack(side="right", padx=(0, 8))
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
        if self.needs_details(meal):  # favorites keep the full recipe
            return self.with_details([meal], lambda: self.add_favorite(meal))
        meal = self.full_meal(meal)
        fav = {k: meal[k] for k in ("id", "name", "category", "area", "thumb", "ingredients", "parts",
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

    def import_recipe_dialog(self):
        """Paste a recipe link; the recipe is read from the page and opened in the editor to check."""
        win = tk.Toplevel(self, bg=CARD)
        win.title("Import a recipe")
        win.transient(self)
        win.resizable(False, False)
        win.geometry(f"+{self.winfo_rootx() + 320}+{self.winfo_rooty() + 140}")
        win.bind("<Escape>", lambda e: win.destroy())
        frm = tk.Frame(win, bg=CARD, padx=24, pady=20)
        frm.pack(fill="both", expand=True)
        tk.Label(frm, text="Import a recipe", bg=CARD, fg=TEXT, font=(F, 15, "bold")).pack(anchor="w")
        tk.Label(frm, text="Paste a link to a recipe page. The app reads the ingredients, steps and photo,\n"
                           "and you can check everything before it's saved to Favorites.",
                 bg=CARD, fg=MUTED, font=(F, 9), justify="left").pack(anchor="w", pady=(2, 10))
        var = tk.StringVar()
        entry = tk.Entry(frm, textvariable=var, width=60, relief="flat", font=(F, 10), bg=GHOST,
                         highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
        entry.pack(fill="x", ipady=5)
        try:
            clip = self.clipboard_get()
            if normalize_url(clip) and len(clip) < 500:
                var.set(clip.strip())  # a recipe link already copied? fill it in
        except tk.TclError:
            pass
        status = tk.Label(frm, text="", bg=CARD, fg=ACCENT_DARK, font=(F, 9, "bold"), wraplength=460, justify="left")
        row = tk.Frame(frm, bg=CARD)

        def get():
            url = normalize_url(var.get())
            if not url:
                return status.config(text="That doesn't look like a web address.")
            status.config(text="Getting recipe\u2026", fg=MUTED)
            for w in row.winfo_children():
                w.destroy()

            def work():
                final, html = fetch_page(url)
                return extract_recipe(html, final)

            def done(recipe, error):
                if not win.winfo_exists():
                    return
                if error or not recipe:
                    status.config(fg=ACCENT_DARK, text=str(error) if error else
                                  "That page doesn't include recipe details the app can read.")
                    button(row, "Add it by hand instead", lambda: (
                        win.destroy(), self.edit_favorite_dialog(draft={"url": url, "types": ["dinner"]})), "ghost",
                        small=True).pack(side="left")
                    return
                win.destroy()
                self.edit_favorite_dialog(draft=recipe)
            self.background(work, done)

        btns = tk.Frame(frm, bg=CARD)
        btns.pack(anchor="w", pady=(10, 0))
        button(btns, "Get recipe", get).pack(side="left")
        button(btns, "Cancel", win.destroy, "ghost").pack(side="left", padx=8)
        status.pack(anchor="w", pady=(10, 0))
        row.pack(anchor="w", pady=(6, 0))
        entry.bind("<Return>", lambda e: get())
        entry.focus_set()
        win.grab_set()

    def edit_favorite_dialog(self, idx=None, draft=None):
        """Add or edit a favorite, including its ingredients and steps. `draft` pre-fills an imported recipe."""
        existing = self.data["favorites"][idx] if idx is not None else {}
        if existing and self.needs_details(existing):  # saved before recipes were kept: fetch it to edit
            return self.with_details([existing], lambda: self.edit_favorite_dialog(idx))
        base = self.full_meal(existing) if existing else (draft or {})
        win = tk.Toplevel(self, bg=CARD)
        win.title("Edit meal" if existing else "Check the recipe" if draft else "Add a meal")
        win.transient(self)
        win.resizable(False, False)
        win.geometry(f"+{self.winfo_rootx() + 280}+{self.winfo_rooty() + 30}")
        frm = tk.Frame(win, bg=CARD, padx=24, pady=16)
        frm.pack(fill="both", expand=True)
        tk.Label(frm, text=win.title(), bg=CARD, fg=TEXT, font=(F, 15, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))

        def label(row, text):
            tk.Label(frm, text=text, bg=CARD, fg=TEXT, font=(F, 10, "bold")).grid(
                row=row, column=0, sticky="nw", pady=5, padx=(0, 12))

        def entry(row, text, value):
            label(row, text)
            var = tk.StringVar(value=value)
            e = tk.Entry(frm, textvariable=var, width=56, relief="flat", font=(F, 10), bg=GHOST,
                         highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
            e.grid(row=row, column=1, pady=5, ipady=4, sticky="we")
            return var, e

        def text_box(row, text, value, height, hint=""):
            label(row, text)
            box = tk.Frame(frm, bg=CARD)
            box.grid(row=row, column=1, pady=5, sticky="we")
            t = tk.Text(box, width=56, height=height, font=(F, 10), wrap="word", relief="flat", bg=GHOST,
                        highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT, undo=True)
            sb = ttk.Scrollbar(box, command=t.yview)
            t.configure(yscrollcommand=sb.set)
            t.pack(side="left", fill="both", expand=True)
            sb.pack(side="right", fill="y")
            t.insert("1.0", value)
            if hint:
                tk.Label(frm, text=hint, bg=CARD, fg=MUTED, font=(F, 8)).grid(row=row + 1, column=1, sticky="w")
            return t

        name_var, name_entry = entry(1, "Meal name", base.get("name", ""))
        label(2, "Categories")
        start = meal_types(existing) if existing else set((draft or {}).get("types") or
                                                           [self.fav_tab if self.fav_tab != "all" else "dinner"])
        type_vars = {}
        checks = tk.Frame(frm, bg=CARD)
        checks.grid(row=2, column=1, sticky="w", pady=5)
        for key, text in TYPE_TAGS:
            type_vars[key] = tk.BooleanVar(value=key in start)
            tk.Checkbutton(checks, text=text, variable=type_vars[key], bg=CARD, activebackground=CARD,
                           font=(F, 10), cursor="hand2").pack(side="left", padx=(0, 10))
        # Ingredients: a list with Add / Remove (double-click one to change it); used for the shopping list.
        label(3, "Ingredients")
        ing_box = tk.Frame(frm, bg=CARD)
        ing_box.grid(row=3, column=1, pady=5, sticky="we")
        ing_list = tk.Listbox(ing_box, height=8, font=(F, 10), relief="flat", bg=GHOST, activestyle="none",
                              highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT,
                              selectbackground=ACCENT_SOFT, selectforeground=TEXT)
        ing_scroll = ttk.Scrollbar(ing_box, command=ing_list.yview)
        ing_list.configure(yscrollcommand=ing_scroll.set)
        ing_list.pack(side="left", fill="both", expand=True)
        ing_scroll.pack(side="right", fill="y")
        for line in ingredient_lines(base):
            ing_list.insert("end", line)
        ing_bottom = tk.Frame(frm, bg=CARD)
        ing_bottom.grid(row=4, column=1, sticky="we")
        ing_row = tk.Frame(ing_bottom, bg=CARD)
        ing_row.pack(fill="x")
        ing_var = tk.StringVar()
        ing_entry = tk.Entry(ing_row, textvariable=ing_var, relief="flat", font=(F, 10), bg=GHOST,
                             highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
        ing_entry.pack(side="left", fill="x", expand=True, ipady=3)
        ing_editing = {"index": None}  # the row being changed, after a double-click

        def add_ingredient(_=None):
            line = ing_var.get().strip()
            if not line:
                return "break"
            if ing_editing["index"] is None:
                ing_list.insert("end", line)
                ing_list.see("end")
            else:
                i = ing_editing["index"]
                ing_list.delete(i)
                ing_list.insert(i, line)
                ing_editing["index"] = None
                add_btn.config(text="Add")
            ing_var.set("")
            ing_entry.focus_set()
            return "break"

        def remove_ingredient(_=None):
            for i in reversed(ing_list.curselection()):
                ing_list.delete(i)
            if ing_editing["index"] is not None:
                ing_editing["index"] = None
                add_btn.config(text="Add")
                ing_var.set("")

        def edit_ingredient(_=None):
            sel = ing_list.curselection()
            if sel:
                ing_editing["index"] = sel[0]
                ing_var.set(ing_list.get(sel[0]))
                add_btn.config(text="Update")
                ing_entry.focus_set()
                ing_entry.icursor("end")

        add_btn = button(ing_row, "Add", add_ingredient, "soft", small=True)
        add_btn.pack(side="left", padx=(6, 0))
        button(ing_row, "Remove", remove_ingredient, "ghost", small=True).pack(side="left", padx=(6, 0))
        ing_entry.bind("<Return>", add_ingredient)
        ing_list.bind("<Double-Button-1>", edit_ingredient)
        ing_list.bind("<Delete>", remove_ingredient)
        ing_list.bind("<BackSpace>", remove_ingredient)
        tk.Label(frm, text="Type one and click Add (e.g. \u201c2 cloves garlic\u201d). Double-click one to change it. "
                 "Used for the shopping list.", bg=CARD, fg=MUTED, font=(F, 8)).pack(in_=ing_bottom, anchor="w")
        steps = text_box(5, "Recipe steps", base.get("instructions", ""), 7)
        url_var, _ = entry(6, "Recipe link", base.get("url", ""))
        photo = {"thumb": base.get("thumb", ""), "busy": False}
        label(7, "Photo")
        photo_row = tk.Frame(frm, bg=CARD)
        photo_row.grid(row=7, column=1, sticky="w", pady=5)
        preview = tk.Label(photo_row, bg=CARD)
        preview.pack(side="left")
        photo_btns = tk.Frame(photo_row, bg=CARD)
        photo_btns.pack(side="left", padx=12)
        photo_msg = tk.Label(photo_btns, text="", bg=CARD, fg=MUTED, font=(F, 8), wraplength=260, justify="left")
        thumb_var = tk.StringVar()

        def show_photo():
            thumb = photo["thumb"]
            set_photo(self.images, preview, thumb, (120, 90), name_var.get() or "?")
            remove_btn.pack_forget() if not thumb else remove_btn.pack(anchor="w", pady=(4, 0), after=choose_btn)
            choose_btn.config(text="Change photo\u2026" if thumb else "Choose a photo\u2026")
            thumb_var.set(thumb if thumb.startswith("http") else "")

        def choose_photo():
            path = filedialog.askopenfilename(parent=win, title="Choose a photo of the meal", filetypes=[
                ("Photos", "*.jpg *.jpeg *.png *.webp *.gif *.bmp *.heic"), ("All files", "*.*")])
            if not path:
                return
            online = self.sync_ready()
            photo["busy"] = True
            photo_msg.config(text="Saving photo\u2026" if online else "Adding photo\u2026", fg=MUTED)

            def work():
                jpeg = shrink_photo(path, PHOTO_MAX if online else PHOTO_LOCAL_MAX)
                if not online:
                    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
                return self.account.upload_photo(self.sync_cfg["family"]["family_id"], jpeg)

            def done(result, error):
                photo["busy"] = False
                if not win.winfo_exists():
                    return
                if error:
                    msg = str(error) if isinstance(error, SyncError) else "Couldn\u2019t open that file as a photo."
                    return photo_msg.config(text=msg, fg=ACCENT_DARK)
                photo["thumb"] = result
                photo_msg.config(text="")
                show_photo()
            self.background(work, done)

        def remove_photo():
            photo["thumb"] = ""
            photo_msg.config(text="")
            show_photo()

        choose_btn = button(photo_btns, "", choose_photo, "ghost", small=True)
        choose_btn.pack(anchor="w")
        remove_btn = button(photo_btns, "Remove photo", remove_photo, "ghost", small=True)
        photo_msg.pack(anchor="w", pady=(4, 0))
        link_row = tk.Frame(photo_btns, bg=CARD)
        link_row.pack(anchor="w", pady=(6, 0))
        tk.Label(link_row, text="or paste a photo link:", bg=CARD, fg=MUTED, font=(F, 8)).pack(side="left")
        link_entry = tk.Entry(link_row, textvariable=thumb_var, width=28, relief="flat", font=(F, 9), bg=GHOST,
                              highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
        link_entry.pack(side="left", padx=(6, 0), ipady=2)

        def link_typed(*_):
            typed = thumb_var.get().strip()
            if typed != (photo["thumb"] if photo["thumb"].startswith("http") else ""):
                photo["thumb"] = typed
                set_photo(self.images, preview, typed, (120, 90), name_var.get() or "?")
        link_entry.bind("<FocusOut>", link_typed)
        link_entry.bind("<Return>", link_typed)
        show_photo()
        notes = text_box(9, "Notes", base.get("notes", ""), 2)

        def submit():
            if photo["busy"]:
                return messagebox.showinfo("Saving photo", "Wait a moment \u2014 the photo is still saving.", parent=win)
            link_typed()
            name = name_var.get().strip()
            if not name:
                messagebox.showwarning("Missing name", "Please give the meal a name.", parent=win)
                return name_entry.focus_set()
            clash = any(f["name"].lower() == name.lower()
                        for i, f in enumerate(self.data["favorites"]) if i != idx)
            if clash:
                return messagebox.showwarning("Already saved", f"\u201c{name}\u201d is already in Favorites.",
                                              parent=win)
            types = [k for k, v in type_vars.items() if v.get()]
            if not types:
                return messagebox.showwarning("Pick a category", "Tick at least one of Breakfast, Lunch, "
                                              "Dinner or Side.", parent=win)
            fields = dict(base, name=name, url=url_var.get().strip(), thumb=photo["thumb"],
                          notes=notes.get("1.0", "end").strip(), types=types)
            fields.pop("origin", None)
            lines = list(ing_list.get(0, "end"))
            if ing_var.get().strip() and ing_editing["index"] is None:  # typed but not added yet: keep it
                lines.append(ing_var.get().strip())
            meal = apply_recipe_edits(fields, "\n".join(lines), steps.get("1.0", "end"))
            spot = next((i for i, f in enumerate(self.data["favorites"])
                         if existing and f.get("uid") == existing.get("uid")), None)
            if spot is None:
                self.data["favorites"].append(meal)
            else:
                self.data["favorites"][spot] = meal
            self.favorites_changed()
            self.notify(f"\u2665 Saved \u201c{name}\u201d")
            win.destroy()

        btns = tk.Frame(frm, bg=CARD)
        btns.grid(row=11, column=0, columnspan=2, sticky="e", pady=(12, 0))
        button(btns, "Cancel", win.destroy, "ghost").pack(side="right")
        button(btns, "Save to Favorites" if draft and not existing else "Save meal", submit).pack(side="right", padx=8)
        win.bind("<Return>", lambda e: None if isinstance(e.widget, tk.Text) else submit())
        win.bind("<Escape>", lambda e: win.destroy())
        win.grab_set()
        name_entry.focus_set()


if __name__ == "__main__":
    MealPlanner().mainloop()
