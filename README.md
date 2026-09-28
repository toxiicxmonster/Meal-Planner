# Meal Planner

Plan a week of dinners from your favorite meals and new ideas, then turn it into a shopping list. Share it all with your family: everyone sees the same week, favorites and shopping list, and changes show up on each other's phones within seconds.

There are three apps, and they all share your family's data:

| App | Where | Folder |
|---|---|---|
| **iPhone app** (native) | iPhone (Android also possible) | `mobile/` |
| **Desktop app** | Windows (also Mac and Linux) | `meal_planner.pyw` |
| **Web app** | any phone or computer browser | `docs/` |

Recipes and photos come from [TheMealDB](https://www.themealdb.com), a free recipe database, or from any recipe website you import. Family sharing runs on [Supabase](https://supabase.com), a hosted database with a free tier. Nobody needs an email address or password.

## What it does

- **This Week**: a random Saturday-to-Friday dinner menu, picked from your Favorites, from new ideas, or from both. Nothing you had last week is repeated.
  - **Swap** a single day, **Choose** a favorite for a day, or **Keep** a day so shuffling won't change it.
  - Add a side to any day, picked at random or chosen from your favorites tagged **Side**.
  - See **Last week**, or start planning **Next week** early.
  - **Send** the menu by text, Messenger or email.
- **Explore**: browse TheMealDB's recipes (about 790), loaded live each time you open the app. Filter by meal type and by cuisine or region, leave out seafood, poultry, beef, pork, lamb or vegetarian dishes, and search by dish or ingredient.
- **Favorites**: your own meals in Dinner, Lunch, Breakfast, Appetizers and Sides tabs. A meal can be in more than one.
  - **Import** a recipe from a website by pasting its link: the name, photo, ingredients and steps come in for you to check.
  - **Edit** any meal's ingredient list (add or remove one at a time) and recipe steps.
  - **Add a photo** straight from your phone's camera or photo library, or from a file on the computer.
- **Shopping list**: add ingredients from any recipe or the whole week, grouped by store aisle, with duplicates combined (Onion 2 for Tacos + 1 for Chili = **3**). Change how much to buy with **−** / **+**, remove single items, and put anything in your own aisle (like **A21** or **Outdoors**) — the list remembers it. Check items off as they go in the cart.
- **Family**: the desktop app sets up the family and shows a QR code. The first phone to scan it becomes the **primary household member**, who can invite everyone else with their own QR code. No emails or passwords.

---

## Setup

Do these in order. Part 1 is done once by whoever runs the app for the family.

1. [Set up family sharing (Supabase)](#1-set-up-family-sharing-supabase) (once)
2. [Put the app on your iPhones](#2-put-the-app-on-your-iphones)
3. [Run the desktop app](#3-run-the-desktop-app) (optional)
4. [Set up your family and invite people](#4-set-up-your-family-and-invite-people)

You'll need **Node.js** (LTS, from [nodejs.org](https://nodejs.org)) and **Python 3.10+** (from [python.org](https://www.python.org/downloads/); on Windows tick **"Add python.exe to PATH"**). Download this project with **Code → Download ZIP** on GitHub, or `git clone https://github.com/toxiicxmonster/Meal-Planner.git`.

### 1. Set up family sharing (Supabase)

1. **Create a project.** Sign up at [supabase.com](https://supabase.com) and click **New project**. The free plan is plenty. Pick any name, set a database password (you won't need it again), and choose the region closest to you.
2. **Create the tables and rules.** In your project, open **SQL Editor → New query**. Paste in everything from [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It should say *Success*. Running it again later is safe.
3. **Let devices sign in without email.** Go to **Authentication → Sign In / Providers** and turn on **Allow anonymous sign-ins**. Each phone and computer then gets its own private account automatically. Nobody types an email or password.
4. **Recipe import for the web app** (optional; the iPhone and desktop apps don't need this). Browsers can't read other websites directly, so the web app asks a small Supabase **Edge Function** to fetch the recipe page.
   - In Supabase, open **Edge Functions → Deploy a new function → Via Editor**.
   - Name it exactly `import-recipe`, paste in everything from [`supabase/functions/import-recipe/index.ts`](supabase/functions/import-recipe/index.ts), and click **Deploy**.
   - Or, with the Supabase CLI: `npx supabase functions deploy import-recipe --project-ref YOUR-PROJECT-ID`.
5. **Connect the apps to your project.**
   - In **Project Settings → API Keys**, copy the **Project URL** and the **publishable key** (it starts with `sb_publishable_`).
   - In a terminal in the project folder, run:
     ```
     python supabase/set_config.py https://YOUR-PROJECT.supabase.co sb_publishable_xxxxxxxx
     ```
   - This writes the settings for all three apps: `supabase/config.json`, `mobile/src/lib/config.js` and `docs/config.js`.
   - If you publish the web app (see [Web app](#web-app-optional)), add its address as a third value, so invite QR codes open it:
     ```
     python supabase/set_config.py https://YOUR-PROJECT.supabase.co sb_publishable_xxxxxxxx https://YOURNAME.github.io/Meal-Planner/
     ```

   The publishable key is meant to be inside apps. The security rules from step 2 decide what each person can see: only members of a family can read or change that family's data. Meal photos go in a `meal-photos` storage folder for each family; `schema.sql` creates it.

### 2. Put the app on your iPhones

Apple only allows your own apps onto iPhones through its **Apple Developer Program ($99/year)**, and that now includes testing with Expo. You also need a free **Expo account** ([expo.dev/signup](https://expo.dev/signup)); Expo builds the iPhone app in the cloud, so no Mac is needed.

> **Until you sign up:** use the **web app** on your phones (see [Web app](#web-app-optional)). It has the same features and joins the same family, so nothing is lost when you switch to the iPhone app later.

1. **Join the Apple Developer Program** at [developer.apple.com/programs](https://developer.apple.com/programs/). Approval can take a day or two.
2. **Pick your app's ID.** In `mobile/app.json`, change `ios.bundleIdentifier` (currently `com.mealplanner.family`) to something unique to you, like `com.yourname.mealplanner`.
3. **Install and build.** In a terminal:
   ```
   cd mobile
   npm install
   npx eas-cli@latest login
   npx eas-cli@latest build --platform ios
   ```
   The first build asks a few questions. Let it create the Apple certificates for you (sign in with your Apple Developer account when asked). The build runs in Expo's cloud and takes about 15–30 minutes.
4. **Send it to TestFlight:**
   ```
   npx eas-cli@latest submit --platform ios --latest
   ```
5. **Install on your phones.**
   - Install Apple's **TestFlight** app from the App Store on each iPhone.
   - In [App Store Connect](https://appstoreconnect.apple.com), open your app, go to **TestFlight**, and add yourself and your wife as testers.
   - Each of you gets an email invite. Open it on the iPhone, and TestFlight installs **Meal Planner** on the home screen.

**Updating later:** run the `build` and `submit` commands again. TestFlight offers the new version to both phones.

**Publishing to the App Store** uses the same builds; submit one for review in App Store Connect. This version has no user accounts on purpose. [`PUBLISHING-NOTES.md`](PUBLISHING-NOTES.md) lists what to add first: real accounts with email, account deletion, a privacy policy, and abuse protection.

### 3. Run the desktop app

1. In a terminal in the project folder, install the two Python libraries it uses:
   ```
   python -m pip install -r requirements.txt
   ```
2. Double-click **`meal_planner.pyw`**, or run `python meal_planner.pyw`.

Recipes load live from TheMealDB when the app opens (a second or two). Your data is saved next to the app in `meal_data.json`.

### 4. Set up your family and invite people

The **desktop app** is the family's "brain": it sets up the family. Do this on the computer that has the meals you want to keep.

1. **Set up the family.** Click **⇅ Family** at the top. Enter a family name (e.g. *The McCrearys*) and your family member name, then click **Set up family**. Your current meals, favorites and list become the family's.
2. **Invite the first phone.** Click **Invite someone**. A QR code appears.
   - On the phone, point the **Camera** at the code and tap the link. The app opens with the invite filled in.
   - Enter a **Family member name** (e.g. *Wife*) and tap **Join family**.
   - That phone is now the **primary household member**.
3. **Invite everyone else.** The primary household member can open **Family → Invite someone** on their phone to show a QR code, or tap **Send invite…** to text the link. The desktop can invite people too.
   - Codes like **`XY3T-78JV`** work for 7 days, for as many people as you like. People can also type the code on the **Family** tab.
   - A phone that joins takes the family's week plan. Anything it had already saved (favorites, list items) is added to the family's.

**Who can do what:** the desktop (**Family computer**) and the **Primary** member can invite and remove people. Everyone else can use and change the plan, favorites and list, and can leave. The family computer can't be removed.

**Keep `sync_config.json`.** It's the desktop's key to the family. If it's deleted, the primary member can invite the computer back in, but it rejoins as a regular member.

---

## Everyday use

**Plan the week.**
- On **This Week**, choose where meals come from: *Favorites only*, *Mix of both* or *Explore only*. Then tap **Shuffle week**.
- **Swap** a day you don't like, or **Choose** a specific favorite for it. **Keep** holds a day when you shuffle again.

**Sides.** **Random side** picks a side for the day (favorites tagged **Side** first). **Pick a side** lets you choose from your favorites tagged **Side**.

**Shopping.**
- Tap the **cart** button on This Week to add the whole week's ingredients, or open any recipe and add its ingredients from there. Untick anything you already have.
- On the **List** tab, type extra items ("2 lemons"), tap items to check them off, and **Clear** the ones in the cart when you're done.
- **−** / **+** change how much of an item to buy ("2 cups" → "3 cups"; "200 g" → "2 × 200 g"). **−** never removes an item; **✕** removes just that one item.
- **Choose aisle** (or **Move**) puts an item in another aisle. Pick one of the store sections, or type your own — a store's aisle number like **A21**, or a section like **Outdoors**. The list remembers it for that item, for everyone in the family. Items the app can't place go under **Not sorted**.

**Favorites.**
- Tap **Save** on any recipe, or **+** to add your own meal.
- **Import** a recipe from a website: tap **Import** (desktop: **⤓ Import from a website**) and paste the recipe's link. Check what came in, fix anything, and save.
- **Edit** a meal to add or remove ingredients one at a time (they feed the shopping list; tap or double-click one to change it) and to change the recipe steps.
- **Photos:** in the meal editor, tap **Take photo** or **Choose photo** (desktop: **Choose a photo…**). Photos are shrunk before saving. In a family they're stored online so everyone sees them; otherwise they're kept inside the meal. You can still paste a photo link instead.
- Tap a meal's **Breakfast / Lunch / Dinner / Appetizer / Side** tags to sort it. Only meals tagged **Dinner** are used when shuffling the week.

**New weeks.** Every Saturday, the current plan moves to **Last week** and a fresh menu is made. To plan early, use **Next week**.

## How syncing works

- Changes are saved on the device right away, then shared with the family a moment later.
- The iPhone app gets other people's changes **live** while it's open. It also checks when opened and every 30 seconds.
- The desktop and web apps check when opened, after each change, and every minute.
- **Favorites and shopping items** merge one by one:
  - two people editing different items: both edits are kept;
  - two people editing the same item: the latest edit wins;
  - deleting an item removes it for everyone.
- **The week plan** is treated as one thing: the latest change to it wins.
- **Offline:** each app keeps working on its own copy of your week, favorites and list, and catches up when it's back online. Explore and opening new recipes need internet, since recipes come live from TheMealDB. Your favorites keep their full recipes, so they work offline.
- **Two phones saving at the same moment:** the database accepts one and asks the other to merge and try again, so nothing is overwritten.

## Troubleshooting

| What you see | What to do |
|---|---|
| **"Family sharing needs anonymous sign-ins turned on"** | In Supabase, turn on **Authentication → Sign In / Providers → Allow anonymous sign-ins** (step 1.3). |
| **"Only the family computer or the primary household member can invite people"** | Ask one of them to show you an invite QR code. |
| **"Photo uploads aren't set up yet"** | Run the latest `supabase/schema.sql` again in the SQL Editor (it's safe to re-run). |
| **"Recipe import isn't set up for the web app yet"** | Deploy the `import-recipe` Edge Function (step 1.4), or import on the iPhone or desktop app. |
| **"That site turned the app away"** | Some recipe sites block apps. Try the desktop app, or tap **Add it by hand instead**. |
| **"Family sharing isn't set up yet"** | Run `python supabase/set_config.py …` (step 1.5), then rebuild the iPhone app or restart the desktop app. |
| **"That invite code isn't valid or has expired"** | Codes last 7 days. Tap **Invite someone** for a new one. |
| **"Lost its family connection"** | That device's account is gone. Ask the primary member for a new invite. Your meals stay on the device. |
| **Supabase says the project is paused** | Free projects pause after about a week with no use. Open the project in Supabase and click **Restore**. |
| **Photos show a colored letter instead** | That meal has no photo. Add one with **Edit** on Favorites. |
| **Desktop app won't start: "Missing Pillow"** | Run `python -m pip install -r requirements.txt`. |

## Web app (optional)

The `docs/` folder is the same planner as a web page. It can be installed to a phone's home screen and works offline. It's handy for Android phones, or before the iPhone app is set up.

1. On GitHub, open this repo's **Settings → Pages**, set **Source** to **Deploy from a branch**, pick **`main`** and **`/docs`**, and save.
2. A minute later it's at `https://toxiicxmonster.github.io/Meal-Planner/`.
3. Open it on the phone.
   - **iPhone (Safari):** tap **Share → Add to Home Screen**.
   - **Android (Chrome):** tap **⋮ → Install app**.
4. Tap **Family** at the top and join with an invite code, or just scan an invite QR code with the phone's camera.

## Files

| File | What it is | In git? |
|---|---|---|
| `mobile/` | The iPhone app (Expo / React Native) | Yes |
| `meal_planner.pyw`, `requirements.txt` | The desktop app | Yes |
| `docs/` | The web app, published by GitHub Pages | Yes |
| `supabase/schema.sql` | Tables, security rules, functions and the photo folder for family sharing | Yes |
| `supabase/functions/import-recipe/` | Edge Function the web app uses to read recipe pages | Yes |
| `PUBLISHING-NOTES.md` | What to change to publish this with real user accounts | Yes |
| `supabase/set_config.py`, `supabase/config.json` | Connects the apps to your Supabase project | Yes (the publishable key is public by design) |
| `meal_data.json` | The desktop's copy of your meals, plans and list | **No** (personal) |
| `sync_config.json` | The desktop's key to the family (keep it) | **No** (private) |
| `image_cache/` | Recipe photos the desktop has shown, kept so they load quickly | No |

## For developers

- **Shared rules:** `docs/core.js` holds the planner rules shared by the web and iPhone apps: meal types, proteins, aisles, merging, recipe import, photo sizes, family roles, and the Supabase client. The iPhone app gets a copy in `mobile/src/lib/core.js` through `npm run sync-core`, which also runs automatically on `npm start`. **Edit `docs/core.js`, not the copy.**
- **Desktop in step:** the desktop app implements the same rules in Python (`merge_data`, `meal_types`, `proteins`, `aisle_of`, `add_to_list`, `extract_recipe`, `apply_recipe_edits`, `photo_size`, `Supabase` / `FamilyAccount` / `FamilyStore`). If you change a rule, change both, so every app merges the same way.
- **iPhone app:** it uses Expo Router (`mobile/src/app/`); the planner state is an external store in `mobile/src/lib/planner.js`. Before committing, run `npx expo lint` and `npx expo-doctor` in `mobile/`.
- **Trying the iPhone app's screens on a computer:** run `npm run web` in `mobile/`.
- **Web app updates:** bump `VERSION` in `docs/sw.js` so installed copies pick up the change.
- **QR codes** on the web and iPhone apps use [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). The web app's copy is `docs/vendor/qrcode.js`.
