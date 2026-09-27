# Notes: turning this into a publishable app with user accounts

This open-source version deliberately has **no email and no user accounts**. Supabase's built-in email only
reaches your own project team (2 emails an hour), and sending to anyone else needs a custom SMTP service. So:

- Each device signs itself in with **Supabase anonymous sign-in**. The device *is* the account.
- The **desktop app is the "brain"**. It sets up the family and is its `owner` ("Family computer").
- The **first phone to join** with the desktop's QR code becomes the `primary` household member.
- The owner and the primary member can make invite QR codes and remove people. Everyone else is a `member`.
- The rules live in `supabase/schema.sql`: `can_manage`, `fill_roles`, `join_family`, `create_invite`, `remove_member`.

These notes list what to change if this becomes a published app where people create real accounts.

## 1. Accounts and sign-in

- **Email sending.** Set up custom SMTP under Supabase **Authentication → SMTP Settings**, for example Resend,
  Postmark, Amazon SES or Brevo. Then raise the email rate limit under **Authentication → Rate Limits**.
- **Code emails instead of links.** Edit the **Magic Link** email template to show `{{ .Token }}`, so people type a
  6-digit code instead of tapping a link. Links are awkward inside a native app.
- **Bring back the sign-in code.** It was removed after commit `eea79a4`, and `git show eea79a4:<file>` has it all:
  - `Supabase.sendCode()` and `verifyCode()` in `docs/core.js`: `POST /auth/v1/otp` with `{email, create_user: true}`, then
    `POST /auth/v1/verify` with `{type: "email", email, token}`;
  - `send_code()` and `verify_code()` in `meal_planner.pyw`;
  - the email forms in `docs/app.js` (`email-form` / `code-form`), `mobile/src/app/(tabs)/family.js` (`EmailSignIn`),
    and the desktop `sync_dialog`.
- **Keep devices that already joined.** Don't sign them out. Upgrade them instead: Supabase can turn an anonymous
  user into a permanent one with the **same user id**, so family membership carries over.
  1. Call `PUT /auth/v1/user` with `{email}` using the device's access token. Supabase emails a code.
  2. Call `POST /auth/v1/verify` with `{type: "email_change", email, token}`.
  3. Add an "Add your email to keep your account" prompt on the Family screen.
- **Sign in with Apple** is only *required* by App Store guideline 4.8 if you add Google or Facebook sign-in.
  People would still expect it on iPhone, though. Supabase supports it (`expo-apple-authentication` plus the Apple provider).
- **Sign-in on several devices.** With real accounts, one person can use a phone and the desktop. Right now each device is
  separate, so the same person shows up twice in the member list. Once there are accounts, show each account once.

## 2. Family roles and ownership

- **Losing the desktop.** Today, if the desktop's `sync_config.json` is deleted, that computer loses its account and its
  owner role. The primary member can invite it back, but it rejoins as a member. With accounts, signing in again restores it.
- **Transferring ownership.** Add a `transfer_ownership(p_family, p_user)` RPC so the owner can hand over, for example
  when replacing the computer.
- **Starting a family on a phone.** Let phones start a family again: bring back the "Start a family" form from `eea79a4`.
  Many people won't have a desktop. The phone that starts the family would be the owner.
- **Roles on the server.** `ROLE_LABELS` and `canManage` in `docs/core.js`, and `ROLE_LABELS` in `meal_planner.pyw`, only
  decide what the apps *show*. The database enforces the rules itself.

## 3. App Store requirements

- **Account deletion (guideline 5.1.1(v)).** Apps with sign-up must let people delete their account inside the app.
  Add a `delete_my_account()` RPC that leaves every family (reuse `leave_family`), then delete the auth user. That last
  step needs an Edge Function that uses the service-role key on the server; never put that key in an app.
- **Privacy policy URL.** The app stores display names, the family's meals and uploaded photos (plus email addresses,
  once accounts exist). App Store Connect also asks for the **privacy "nutrition label"**.
- **Bundle id.** Change `ios.bundleIdentifier` in `mobile/app.json` to your own reverse-DNS id.
- **Apple Developer Program** ($99/year), then `eas build` and `eas submit` (see README step 2).

## 4. Abuse and cost protection

- **CAPTCHA.** Turn on Supabase CAPTCHA (hCaptcha or Cloudflare Turnstile) for sign-ups, including anonymous ones.
  Today anyone with the publishable key can create anonymous users. Supabase limits this to 30 per hour per IP by default.
- **Clean up anonymous users** who never joined a family: a scheduled job that deletes `auth.users` where
  `is_anonymous` and there's no `family_members` row, after about 30 days.
- **Clean up photos.** Photos in the `meal-photos` bucket are never deleted when a meal's photo is changed or removed.
  Add a cleanup that lists each family's folder and removes files no meal in `family_data.doc` points to.
  Also delete a family's folder when the family is deleted.
- **Photo visibility.** Photos are public to anyone who has the exact link; the file names are random. For stricter
  privacy, make the bucket private, add a `select` policy for family members, and show photos through signed URLs.
- **Recipe import helper.** The `import-recipe` Edge Function refuses private network addresses and requires a signed-in
  user. Add per-user rate limiting before publishing.

## 5. Data

- **One document per family.** Each family's planner is one JSON document (`family_data.doc`, 2 MB limit). That's fine for
  a household, but move favorites and the shopping list into their own tables if families get large.
- **Photos stored inside meals.** Photos added **without** a family are stored inside the meal as `data:` URLs (480 px,
  about 30–60 KB each). When that device joins a family they sync inside the document. Upload them to storage on join and
  replace the `data:` URL with the storage link.

## 6. Opening the native app from a QR code

- **What happens today.** Invite QR codes open the **web app** link (`<webAppUrl>#join=CODE`), because a phone's camera
  can't open a custom `mealplanner://` link directly.
- **Opening the iPhone app instead.** Set up **Universal Links**:
  1. Host `/.well-known/apple-app-site-association` at the **root of a domain**. GitHub Pages project sites
     (`user.github.io/Meal-Planner`) can't do that, so use a custom domain.
  2. Add `ios.associatedDomains` in `app.json`.
  3. Handle `/join/CODE` with Expo Router (`src/app/join/[code].js` already exists).
