# TEgo iPhone app

Backlog item 3. Stage 1 built 18 Oct 2026: a Capacitor wrap of the live TEops site, with native Apple push. The name **TEgo** can change any time (one line in `tego-app/capacitor.config.json` and `CFBundleDisplayName` in `Info.plist`). The bundle ID **`au.com.thomsonenergy.app`** can never change once registered with Apple.

## How it works

- The app opens `https://projects.thomsonenergy.com.au` inside the app. Every Netlify deploy updates the app straight away, no App Store update needed. Only changes in `tego-app/` (icon, permissions, native code) need a new build.
- No internet: the app shows `tego-app/native-shell/offline.html` and retries by itself.
- Push: `public/js/native.js` (loaded by `notifications.js` only inside the app) asks permission, gets an Apple device token and saves it with `register_ios_push_device` (migration `20261018000000`) as a `push_subscriptions` row with `platform = 'ios'`. `_shared/push.js` sends those rows through `_shared/apns.js`; browsers still get web push.
- Photos, camera and the meeting recorder use the normal web file and mic pickers, which the app allows (permission wording in `Info.plist`).
- Black icon and launch screen from `public/icons/logo-mark.png`. iPhone only, portrait only.
- Builds run on GitHub's Mac machines (`.github/workflows/tego-ios.yml`), so no Mac is needed. `tego-app/` has its own `package.json` (Capacitor needs Node 22; Netlify stays on Node 20 and never sees this folder).

## Known gaps (stage 1)

- **Print buttons** (HR letters and similar) do nothing inside the app: use the in-app document view or open TEops in Safari to print.
- **Badge count** on the icon only updates when a notification arrives, not when you read them in the app.
- Links that open a new window (PDFs, Google Calendar) open in Safari.
- No offline mode yet: stage 2 (local queue, temp IDs, photo retry).

## Setup once Apple approves the Developer account

Do these in order. None of the keys go in chat or the repo.

1. **Register the app ID.** developer.apple.com > Account > Certificates, IDs & Profiles > Identifiers > **+** > App IDs > App. Description `TEgo`, Bundle ID **Explicit** `au.com.thomsonenergy.app`. Under Capabilities tick **Push Notifications**. Continue > Register.
2. **Push key.** Same area > Keys > **+**. Name `TEgo push`, tick **Apple Push Notifications service (APNs)**, Configure > **Sandbox & Production** > Save > Continue > Register > **Download** (you only get one download). Note the **Key ID**. Your **Team ID** is under Account > Membership details.
3. **Paste into TEops.** Settings > API Keys: Apple push Key ID, Apple Team ID, and the whole .p8 file text (open it in Notepad). Save keys.
4. **Create the app listing.** appstoreconnect.apple.com > Apps > **+** > New App. Platform iOS, name `TEgo` (if taken, `TEgo Thomson Energy`), language English (Australia), bundle ID `au.com.thomsonenergy.app`, SKU `tego`, User Access Full.
5. **Build key for GitHub.** App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys > **+**. Name `GitHub builds`, Access **Admin** > Generate > **Download** the .p8. Note the **Key ID** and the **Issuer ID** (top of that page).
6. **GitHub secrets.** github.com/ThomsonEnergy/thomson-projects > Settings > Secrets and variables > Actions > New repository secret, four times: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (whole .p8 text from step 5).
7. **First build.** GitHub > Actions > **TEgo iOS** > Run workflow > tick **Upload to TestFlight** > Run. About 15 minutes. Then App Store Connect > TEgo > TestFlight: the build appears after Apple processes it (up to an hour). Answer the export compliance question if asked (no encryption beyond HTTPS).
8. **Test.** TestFlight > Internal Testing > add yourself, install the TestFlight app on the iPhone, install TEgo, log in, tap the bell > Turn on phone notifications > Send a test.
9. **Team rollout.** Distribute as a private **Custom App** to the Apple Business organisation (Organisation ID from Apple Business > Preferences > Organisation information): App Store Connect > TEgo > Pricing and Availability > App Distribution Methods > Private, enter the Organisation ID, then submit for review. Staff then install it from the App Store app's Purchased or the Apple Business app link. TestFlight builds expire after 90 days, so do not rely on TestFlight for the team.

## Changing the app

- Web changes: deploy TEops as normal. Nothing to do here.
- App changes (`tego-app/`): edit, run `npm install` then `npx cap sync ios` inside `tego-app/` (Node 22), commit. The PR build checks it compiles. Ship with step 7 again.
- Rename: change `appName` in `capacitor.config.json` and `CFBundleDisplayName` in `ios/App/App/Info.plist`, then step 7.
