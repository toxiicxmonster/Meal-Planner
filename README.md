# Meal Planner

Plan a week of dinners from your favorite meals and new ideas, then turn it into a shopping list. There's a **desktop app** for Windows (it also runs on Mac and Linux) and a **phone app** for iPhone and Android. They stay in sync through a private GitHub repo that only you can see.

Recipes and photos come from [TheMealDB](https://www.themealdb.com), a free recipe database.

## What it does

- **This Week**: a random Saturday-to-Friday dinner menu, picked from your Favorites, from new ideas, or from both. Nothing you had last week is repeated.
  - **↻ Swap** a single day, **Choose** a favorite for a day, or tick **Keep** to hold a day when you shuffle.
  - Add a side to any day, picked at random or chosen from your Favorites.
  - See **Last week**, or use **Start next week** to plan ahead.
  - **Send** the menu by text, Messenger or email.
- **Explore**: browse all ~790 TheMealDB recipes. Filter by meal type (breakfast, lunch, dinner, dessert, sides) and by cuisine or region, leave out seafood, poultry, beef, pork, lamb or vegetarian dishes, and search by dish or ingredient.
- **Favorites**: your own meals, sorted into Dinner, Lunch, Breakfast and Sides tabs. A meal can be in more than one tab.
- **Shopping list**: add ingredients from any recipe or from the whole week. Items are grouped by store aisle and duplicates are combined ("Onion — 2 + 1", for Tacos and Chili). Check items off as they go in the cart.

---

## Setup

Setup has four parts. Only the first is required. The rest add the phone app and syncing.

1. [Run the desktop app](#1-run-the-desktop-app)
2. [Put the phone app online](#2-put-the-phone-app-online) (one time, for whoever owns the GitHub repo)
3. [Connect sync on the desktop](#3-connect-sync-on-the-desktop)
4. [Set up your phone](#4-set-up-your-phone)

### 1. Run the desktop app

You need **Python 3.10 or newer**.

1. **Install Python** from [python.org/downloads](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"** in the installer. The python.org installer includes Tkinter, which the app needs for its windows.
2. **Download this project**: click **Code → Download ZIP** on GitHub and unzip it, or run:
   ```
   git clone https://github.com/toxiicxmonster/Meal-Planner.git
   ```
3. **Install the two libraries it uses** (Pillow for photos, qrcode for QR codes). Open a terminal in the project folder and run:
   ```
   python -m pip install -r requirements.txt
   ```
4. **Start the app**: double-click **`meal_planner.pyw`**. From a terminal, run `python meal_planner.pyw` (on Mac/Linux use `python3`).

The first launch downloads TheMealDB's recipe list. It takes about 40 seconds and a progress message shows at the bottom. After that the app opens instantly, and it quietly refreshes the list once a week.

Your data is saved next to the app in `meal_data.json`.

### 2. Put the phone app online

The phone app is the `docs/` folder of this repo, published for free with GitHub Pages. You only need to do this once. Everyone can use the same published copy.

1. On GitHub, open this repo and go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick branch **`main`** and folder **`/docs`**, then click **Save**.
4. After a minute or two, the app is live at:
   **`https://toxiicxmonster.github.io/Meal-Planner/`**

> If you fork this project, your address will be `https://<your-username>.github.io/<repo-name>/`. Change `PHONE_APP_URL` near the top of `meal_planner.pyw` to match, so the desktop's setup QR code points at your copy.

The phone app works without sync as well. Your meals are then saved only on that phone.

### 3. Connect sync on the desktop

Sync keeps your favorites, week plans, last-week history, filters and shopping list the same on every device. It works through a file called `data.json` in a **private** GitHub repo that only you can see, so you need a free [GitHub account](https://github.com/signup).

In the desktop app, click **⇅ Sync off** at the top left. The window walks you through these three steps.

1. **Create a private repo for your data.**
   - Click **Create repo on GitHub**. The name `meal-planner-data` and **Private** are filled in for you.
   - Click **Create repository**. Leave it empty; the app fills it in.
2. **Create a token that can only use that repo.** A token is like a password just for this app. Click **Create token on GitHub**, then set:
   - **Token name**: `Meal Planner`
   - **Expiration**: **1 year**, or custom and longer. The default is 30 days, and sync stops when the token expires.
   - **Repository access**: **Only select repositories** → pick `meal-planner-data`
   - **Permissions → Repository permissions → Contents**: **Read and write**. Leave everything else as it is.

   Click **Generate token** and copy it. GitHub only shows it once.
3. **Connect.**
   - Enter the repo as `your-username/meal-planner-data`, paste the token, and click **Connect & sync**.
   - The status line should read **"Connected to … — last synced …"**, and the top bar should show **✓ Synced**.

The token is saved only on this computer, in `sync_config.json`, which is never committed to git. For your privacy, the app won't sync with a public repo.

### 4. Set up your phone

Once sync is connected, the desktop's Sync window shows a **QR code**.

1. Point your phone's camera at the QR code and tap the link. The phone app opens already connected.
2. Add it to your home screen, so it opens like a regular app and works offline:
   - **iPhone** (use **Safari**): tap **Share** → **Add to Home Screen**.
   - **Android** (**Chrome**): tap **⋮** → **Install app** (or **Add to Home screen**).
3. **iPhone only:** home-screen apps on iPhone keep their own storage, separate from Safari. If the app says **⇅ Sync off** when you open it from the home screen:
   - tap **⇅ Sync off**;
   - paste into **Setup code**; the code was copied when you scanned the QR code;
   - tap **Connect**.

   If nothing was copied, open the app in Safari again (where you scanned it; it's connected there). Tap **✓ Synced**, then **Copy setup code**, then paste it into the home-screen app.

> Keep the QR code and setup code private. They contain your sync token.

The first time you open **Explore** on the phone, it downloads the recipe list (about 40 seconds). After that, recipes and the photos you've viewed work offline.

---

## Everyday use

**Plan the week.**
- On **This Week**, choose where meals come from: *Favorites only*, *Mix of both* or *Explore only*. Then tap **Shuffle week**.
- **Swap** a day you don't like, or **Choose** a specific favorite for it. **Keep** holds a day when you shuffle again.

**Sides.**
- **+ Random side** picks a side dish for the day. Favorites tagged **Side** are used first.
- **Pick** lets you choose from your favorites tagged **Side**. Tag a meal as a side on the Favorites page.

**Shopping.**
- Tap **Shopping** on This Week to add the whole week's ingredients, or open any recipe and add its ingredients from there. Untick anything you already have.
- On the **List** tab, you can type extra items ("2 lemons"), tap items to check them off, and **Clear checked** when you're done.

**Favorites.**
- Tap **♡ Save** on any recipe to add it.
- Tap **+** on the phone, or **+ Add a meal** on the desktop, to add your own meal. You can include a photo link, recipe link and notes.
- Tap a meal's **Breakfast / Lunch / Dinner / Side** tags to sort it. Only meals tagged **Dinner** are used when shuffling the week.

**Explore filters.** *Leave out* also applies to Explore meals and sides picked for your week, but never to your Favorites.

**New weeks.**
- Every Saturday, the current plan moves to **Last week** and a fresh menu is made.
- To plan early, use **Start next week**.

## How syncing works

- The apps sync when they open, a couple of seconds after each change, and every minute while open.
- **Favorites and shopping items** merge one by one. If you edit different meals on two devices, both edits are kept. If the same item was changed on both, the most recent change wins. Deleting something on one device deletes it on the other.
- **The week plan** is treated as one thing: whichever device changed it last wins.
- With no internet, each app keeps working on its own copy and catches up the next time it can reach GitHub.

## Troubleshooting

| What you see | What to do |
|---|---|
| **⚠ Sync problem: "GitHub didn't accept the token"** | The token expired or was copied incompletely. Create a new one (step 3.2) and connect again on each device. |
| **"Couldn't find the repo … or the token can't access it"** | Check the repo is written as `username/meal-planner-data`, and that the token's *Repository access* includes that repo. |
| **"The token isn't allowed to change this repo"** | Edit the token on GitHub and set **Contents** to **Read and write**. |
| **"That repo is public"** | In the data repo, open **Settings → Danger Zone → Change visibility → Private**. |
| **Phone link shows a 404 page** | GitHub Pages isn't on yet, or is still publishing. See step 2 and wait a couple of minutes. |
| **iPhone home-screen app isn't connected** | Paste the setup code in its Sync settings (step 4.3). |
| **Photos show a colored letter instead** | That meal has no photo link. Add one with **Edit** on Favorites; right-click an image online → *Copy image address*. |
| **Desktop app won't start: "Missing Pillow"** | Run `python -m pip install -r requirements.txt`. |

To stop syncing, open the Sync window (desktop) or tap the sync button (phone) and choose **Turn off**. Your data stays on the device and in the GitHub repo.

## Files

| File | What it is | In git? |
|---|---|---|
| `meal_planner.pyw` | The desktop app | Yes |
| `docs/` | The phone app, published by GitHub Pages | Yes |
| `requirements.txt` | Python libraries the desktop app needs | Yes |
| `meal_data.json` | Your favorites, plans, history, filters and shopping list | **No** (personal) |
| `sync_config.json` | Your sync repo and token | **No** (secret) |
| `recipe_catalog.json`, `image_cache/` | Downloaded recipes and photos, rebuilt automatically | No |

## For developers

- The desktop app is a single Python/Tkinter file. The phone app is plain HTML, CSS and JavaScript with no build step: `docs/core.js` holds the rules and `docs/app.js` holds the screens.
- The meal rules and the sync merge are implemented twice: in `meal_planner.pyw` and in `docs/core.js`. They must produce identical results. If you change meal types, protein detection, aisles, ingredient matching or `merge_data` / `mergeData`, change both.
- To test the phone app locally, serve `docs/` from any web server, for example `python -m http.server -d docs`. Then open it in a browser with the window narrowed to phone width.
- When you change the phone app, bump `VERSION` in `docs/sw.js` so installed copies pick up the update.
