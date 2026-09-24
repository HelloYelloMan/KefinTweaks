# Jellyfin 12 upgrade: what breaks, what is superseded

Researched 2026-09-23 from source, before upgrading vault from **10.11.11** to **12.1**.
Upstream sources used: `~/dev/jellyfin` and `~/dev/jellyfin-web` at tags `v10.11.11` and
`v12.1`, the 12.0 and 12.1 release notes, and each plugin's releases and manifests. Nothing
here has been tested on a 12 server yet. Items that need a live test are marked **(live)**.

Jellyfin changed its version scheme: after 10.11.x comes **12.0** (2026-09-07), then
**12.1** (2026-09-14). `/System/Info` reports `"12.1.0"`.

## 0. Status on branch `jellyfin12`

Every change is written to keep 10.11 behaving as before: each 12 path is chosen by
feature detection or by server version. None of it has run in a browser yet.

**Fixed on the branch** (numbers refer to §2):

| § | Fix | Commit |
|---|---|---|
| 1.2, #1 | Legacy auth: osdLogo, pauseScreen fallback, theme-media streams, updoot use `Authorization`/`ApiKey` | 481e176 |
| 1.3, #2 | websocketHelper, watchlist and homeScreen3 use `ApiClient.subscribe` on 12 (socket hook kept for 10.11). cardBuilder/homeScreen now depend on websocketHelper. | 481e176 |
| 1.4, #3 | Every auth-header builder decodes before encoding; session lookups by deviceId too | 481e176 |
| #11, 1.4 | `.split('.')[1]` version checks; URI-encoded `_appName` in version detection (baked stamp → `g3`) | 67cabb7 |
| #7 | `isModernUI()` follows the saved layout on 12 (exported from utils; used by breadcrumbs, watchlist); hamburgerMenu skips legacy | 67cabb7 |
| #6, #9 | virtualSpecials BoxSet Studios row on 12's React rows; mediaTags insert against wrapped rows | 8be93b5 |
| #10, #16, 2.3 | elegant-kefin.css: secondary-section gap/padding, metadata separators and values, padder colour | 8be93b5 |
| 2.3 | virtualSpecials reads the newest backdrop, not the lingering one | 8be93b5 |
| #5 | posterAspect: 12.1 File Transformation rules, taken from the official `jellyfin-web_12.1+ubu2404` package, verified to match once and parse | 0d5a0da |
| 2.4 | infiniteScroll and headerTabs legacy-only; removeContinue hides React cards instead of removing them; `pages:['home']` no longer matches `#/homevideos`; osdLogo uses the modern OSD bar; theme-video controls anchor to the MUI app bar | e53e2f2 |
| #12 | removeContinue also resets alternate versions that carry progress (12 resumes from the last-played version) | e53e2f2 |
| #14 | Conflicting `Filters` pairs are reduced to the last one, as 10.11 did, instead of a 400 | 01e3275 |

**Deliberately not done** (needs a browser, or is a later clean-up):
- Things 12 now does natively (§3) are all left in place, per Robert: castSessionWatchdog (inert on 12), backdropLeakFix, and the rest.
- #8 versionPreferences' full-page reload on 12. Other details injectors watch the page for a bounded time, which should cover it. Live test.
- Modern only:
  - posterAspect's alpha-picker slack (`.alphaPicker-fixed-right`). This is card sizing, so it needs checking in Robert's browser before any change.
  - themeMediaCastFix toggles on the React display page.
  - skinManager custom themes in the MUI theme select.
  - multiUserSession entry points.
  - `viewshow` not firing on same-route React navigation.
- The native TanStack cache can still show a removed Continue Watching card for up to 60 s (#12).
- Episode Show Title and Card Focus After Back live in the JS Injector config, not the repo (§3).

**Deploying:**
- The files changed against `experimental` are `helpers/websocketHelper.js`, `injector.js`, `kefinTweaks-plugin.js`, `skins/elegant-kefin.css` and, under `scripts/`: `apiHelper`, `breadcrumbs`, `dashboardButtonFix`, `hamburgerMenu`, `headerTabs`, `homeScreen`, `homeScreen3`, `infiniteScroll`, `kefinTweaks-loader`, `mediaTags`, `osdLogo`, `pauseScreen`, `posterAspect`, `removeContinue`, `search`, `subtitleSearch`, `themeMediaCastFix`, `updoot`, `utils`, `virtualSpecials`, `watchlist` (all `.js`).
- The first admin page load after deploying or upgrading rewrites the baked `KefinTweaks-injector` entry and posterAspect's File Transformation rules. Reload once after that.
- posterAspect's rules then need one more reload before jellyfin-web is served patched.

**Test checklist on 12.1**, in both Desktop (Legacy) and the default modern layout where it applies:
1. **Console check.** Run `KefinTweaks._jellyfinMajorVersion` (expect 12), `KefinTweaksUtils.isModernUI()`, `typeof ApiClient.subscribe`. There should be a `[KefinTweaks WebSocketHelper] Subscribed through ApiClient.subscribe` line.
2. **Live updates.** Mark an item played from a card. The watchlist drops it, and progress on other cards updates. Dashboard → Devices shows no second "Jellyfin Web" device or session for this browser.
3. **Player.** Play something. The OSD logo appears (both layouts). The pause screen shows its logo and details.
4. **BoxSet page.** It has a Studios row. Metadata rows have ElegantFin separators. A Tags row appears on an item with tags.
5. **Poster ratios.** Cards and the item-page cover carry `par-NN` classes (after the reload that follows rule registration).
6. **Breadcrumbs** render on a legacy details page.
7. **Remove from Continue Watching** on an item with merged versions; the card should stay gone after a refresh.
8. **Versions.** On an item with several versions, check that the preferred one is picked without flicker or loop, and that the Tags row survives.
9. **Theme video** on a details page (modern): the mute/volume controls sit under the app bar.

---

## 1. The four changes behind almost everything else

### 1.1 Every browser lands in the new Modern layout

- `apphost.getDefaultLayout()` now returns `modern` (`src/components/apphost.js:185`).
- Only `desktop-legacy`, `mobile-legacy` and `tv` count as legacy (`src/constants/layoutMode.ts`).
- A 10.11-saved `desktop` or `mobile` is still a *valid* value, and it now means **modern**.
- A saved `experimental` is invalid, so it falls back to auto, which is also modern.
- There is **no migration** of the saved value.

| saved `localStorage.layout` in 10.11 | 12.1 result |
|---|---|
| unset / `''` (Auto) | modern |
| `desktop`, `mobile` | modern |
| `experimental` | modern |
| `tv` | legacy |

**How the pages split in Modern:**
- **React:** home shell, library pages (movies/shows/music/boxsets/playlists…), `mypreferencesdisplay`, and the video page header.
- **Still legacy controllers:** details, list, queue, lyrics, mypreferences{controls,home,playback,subtitles}, and the video OSD body.
- Modern home is a React `Page` wrapping the legacy `hometab`, so `#indexPage.homePage #homeTab .sections` and `.homeSectionsContainer` still exist.

**The hidden legacy header.** In Modern the legacy `AppHeader` (`.skinHeader`, `.headerRight`, `.headerTabs`, `.mainDrawer`, `.customMenuOptions`) is still rendered, but inside a `display:none` wrapper (`RootAppRouter.tsx`, `AppHeader.tsx:20-26`).
- `querySelector` finds it, so code that checks for an element's existence "succeeds".
- Anything injected there is invisible.

**Other Modern-layout facts:**
- At widths of 900px and above there is **no drawer at all**.
- Modern sets `layout-desktop` / `layout-mobile` on `<html>` exactly as legacy does, so **no CSS selector can tell Modern from legacy**.

**Pinning legacy:**
- It is set per browser: Settings → Display → Display mode → **"Desktop (Legacy)"**, then reload.
- Or from the console: `localStorage.setItem('layout','desktop-legacy'); location.reload()`.
- There is no server-wide default.
- ElegantFin issue #309 says the Android app cannot switch to legacy **(live — verify on the phone)**.

### 1.2 Legacy authorization is forced off

Migration `20260531160000_DisableLegacyAuthorization` sets `EnableLegacyAuthorization=false` on upgrade. Vault's `system.xml` currently has it `true`.

**Rejected afterwards:**
- the `X-Emby-Token` and `X-MediaBrowser-Token` headers
- the `api_key=` query parameter
- the `X-Emby-Authorization` header
- the `Emby` scheme name

**Still accepted:**
- `Authorization: MediaBrowser Token="…"`
- `?ApiKey=` (case-insensitive)

**Turning it back on is possible but not recommended.** The flag can be set back to true in `system.xml` or through `POST /System/Configuration`; it is not in the dashboard UI. The migration will not re-run, because it is recorded in `__EFMigrationsHistory`. But upstream has shipped this migration twice already. Fix the callers instead.

**Endpoint auth in 12.1:**
- **Anonymous** (a legacy token is simply ignored): `/Items/{id}/Images/*`, `/Audio|Videos/{id}/stream`.
- **Return 401 with a legacy token:** `/Items/{id}`, `/Users/{u}/Items/{id}`, `/Items/{id}/ThemeMedia`.

### 1.3 The legacy ApiClient websocket is never opened

jellyfin-web 12 moved websockets to the TS SDK and removed every `ensureWebSocket()` call (`1cd4e7b848`).
- `ApiClient._webSocket` / `.webSocket` stay `null`.
- `ApiClient.sendMessage` is a no-op.
- `serverNotifications` no longer re-emits `UserDataChanged`.

**The replacement** is `ApiClient.subscribe([messageType], cb)` (`ServerConnections.js:57`).
- It returns an unsubscribe function.
- `cb` receives `{MessageType, Data}`, the same shape our listeners already take.

### 1.4 ApiClient's auth parameters are now pre-encoded

`createApiClient` URI-encodes the app name, version, device name and device id (`3d633d82a8`). So `ApiClient._appName === 'Jellyfin%20Web'`, and `ApiClient.deviceId()` comes back encoded.

**Why it matters:**
- Our `getAuthHeader` encodes again, and the server decodes once.
- The server then sees a different `DeviceId` and a `%20` device name.
- Endpoints that resolve a session (`UserPlayedItems`, `Sessions/Playing`, `Sessions/{id}/Command`, …) can create a **phantom "Jellyfin Web" session**.
- A device name containing spaces makes the token's device record flip between the two spellings on each request (`AuthorizationContext.cs:153-164`).
- It also makes the `_appName === 'Jellyfin Web'` fast path fail. Version detection then falls back to polling `_serverVersion` (still correct, but up to 10 s slower).

---

## 2. KefinTweaks fork: findings

Severity: **BREAKS**, **DEGRADES**, **COSMETIC**. "Both" = both layouts.
If every browser is pinned to Desktop (Legacy), everything marked *modern* can wait.

### 2.1 Breaks in both layouts (fix before, or right at, the upgrade)

| # | What | Where | Detail | Fix |
|---|---|---|---|---|
| 1 | **osdLogo shows no logo** | `scripts/osdLogo.js:393` | `GET /Items/{id}` with `X-Emby-Token` returns 401, so no logo. | `apiHelper.getAuthHeader()` or `ApiClient.getItem`. |
| 2 | **Websocket consumers are dead** | `helpers/websocketHelper.js:20-22`; `scripts/watchlist.js:4851-4905`; `cardBuilder.js:1877-1891`; `homeScreen3.js:589`; `jeSpoilerGuardScope.js:283`; `multiUserSession.js:618` | Watchlist no longer auto-removes watched items. Card resume-attribute sync stops. Spoiler guard loses its season/series refresh ids. `ApiClient.addEventListener('userdatachanged')` never fires. | `ApiClient.subscribe([type], cb)` when present; keep the socket hook as the 10.11 fallback. |
| 3 | **Double-encoded auth header** | `scripts/apiHelper.js:243-266`, `scripts/utils.js:100-113`, `kefinTweaks-plugin.js:42-55`, `scripts/kefinTweaks-loader.js:1222-1232` | See 1.4: phantom sessions and device-record churn. | `encodeURIComponent(safeDecode(x))`, with `decodeURIComponent` in a try/catch. |
| 4 | **Baked load plan keeps 10.11's script set** | `kefinTweaks-loader.js:873-891,1076-1175` | The stored `KefinTweaks-injector` entry was built with major=11. It keeps loading `backdropLeakFix`, `dashboardButtonFix` and `itemDetailsCollections` (`versions:[10,11]`) and omits `hamburgerMenu` (`[12]`). | Re-save the config from a 12 client after the upgrade. Better: filter `SCRIPT_DEFINITIONS_BAKED` by `versions` at runtime, then bump the stamp generator (see memory: baked-registry). |
| 5 | **posterAspect's File Transformation rules stop matching** | `scripts/posterAspect.js:120-133` | They are keyed to chunk `24468` and to 10.11's minified identifiers, so cards silently fall back to 0.7013. The detail cover is now built in `components/cardbuilder/cardImage.ts`, possibly in a different chunk. | After deploying 12, grep the served chunks for new search strings. Modern React grids come from `Card/useCard.ts` and need their own rule, or accept the default. |
| 6 | **virtualSpecials: no Studios row on BoxSets** | `scripts/virtualSpecials.js:461-525` | `.studiosGroup/.studiosLabel/.studios/.content` are gone. Metadata rows are now React (`ItemDetailsMetadataList.tsx`): `.itemDetailsGroup > div > .detailsGroupItem > p.label + .focuscontainer-x > span > a`. For a BoxSet no Studios row exists at all, and `injectStudios` returns silently. | Clone any `.detailsGroupItem`, relabel it, and append it in its own wrapper div (as mediaTags does). |
| 7 | **`isModernUI()` gives false positives on 12 legacy** | `scripts/utils.js:1155-1157`, `scripts/breadcrumbs.js:474-481`, `scripts/watchlist.js:7470` | "`.MuiBox-root` exists" is now true on the *legacy* details page (`itemDetails/index.js:1018` mounts the React metadata list). Breadcrumbs can mount into a missing `.MuiToolbar-root` and never render. Top-nav and watchlist links take the V12 path. Timing-dependent. Upstream's `main.MuiBox-root` variant also misfires on the dashboard. | For major ≥ 12: modern unless `localStorage.layout` is `desktop-legacy`/`mobile-legacy`/`tv`. Use `main.MuiBox-root` outside `#/dashboard` only as confirmation. |

### 2.2 Degrades in both layouts

| # | What | Where | Detail / fix |
|---|---|---|---|
| 8 | versionPreferences triggers a full page re-render | `scripts/versionPreferences.js:175-230` | In 12, a `.selectSource` `change` runs `refreshSelectedVersion` → `reloadFromItem` (`itemDetails/index.js:2111-2198`): an extra fetch plus a re-render of the name, details group, image and backdrop. Rows injected by mediaTags, episodeSeasonTitle and virtualSpecials can be wiped with no new `viewshow`. **(live)** for flicker or loops. Fix: re-run the injectors on `change`, or skip dispatch when the choice is already primary. |
| 9 | mediaTags throws on items with Studios but no Genres | `scripts/mediaTags.js:~110` | `insertBefore(row, studiosRow)` fails because `studiosRow` is now wrapped in a div. Use `studiosRow.parentElement`. |
| 10 | `.detailPageContent` wrapper removed | `scripts/defaultSkin.css:15-25`, `skins/chromic-kefin.css:6`, ElegantFin | Secondary sections sit directly in `.detailPageSecondaryContainer.padded-left`. Our `order:` hacks and ElegantFin's gap/side padding stop applying. Retarget and add `display:flex;flex-direction:column`. `seriesEpisodes.js` only uses it as a fallback and is OK. |
| 11 | Version checks read 12.1 as "1" | `breadcrumbs.js:79`, `search.js:247`, `homeScreen.js:2177`, `dashboardButtonFix.js:37` | `version.split('.')[1] > 10` gives `.html` URLs again. These still work through `FallbackRoute`'s redirect, with a deprecation warning and an extra hop. Use `KefinTweaks.parseMajorVersion(v) >= 11`. (The loader and injector parsers already handle `12.x` correctly.) |
| 12 | Native Continue Watching can resurrect removed cards | `scripts/removeContinue.js` | Home Resume/NextUp/Latest are TanStack `fetchQuery` with a 60 s `staleTime`, persisted to IndexedDB. Also, Resume is version-aware: zeroing the *primary's* UserData leaves the played version's progress, so merged items stay. **(live)** Fix: reset the played version's id; invalidate on `UserDataChanged`. |
| 13 | castSessionWatchdog does nothing | `scripts/castSessionWatchdog.js` | It finds no socket, so it is inert. The SDK now ref-counts `SessionsStart`/`Stop` per consumer, which is the bug it worked around. **Retire it** after one live check of the stale now-playing bar while casting. |
| 14 | `/Items` filter conflicts are now 400s | user-built home sections | `Filters` combining `IsPlayed`+`IsUnplayed`, `IsFolder`+`IsNotFolder` or `Likes`+`Dislikes` throw "Conflicting filters". 10.11 silently used the last one. Check stored sections; reject these in `homeScreenAdvancedEditor.js`. |
| 15 | `/Items` semantics changes | sections with `SearchTerm`, and BoxSet/Playlist queries | `SearchTerm` results come from search providers, ordered by score, so `SortBy` is ignored. `IncludeItemTypes=BoxSet\|Playlist` with a library `ParentId` is now limited to that library. A library `ParentId` with `IncludeItemTypes` defaults to recursive. |
| 16 | ElegantFin metadata table | ElegantFin CSS, `skins/optional/global/hideMediaTags.css:10-15` | Each row is now the only child of its wrapper, so `.detailsGroupItem:not(:last-child)` separators never fire. The `.content` rules miss; the label picks up MUI body1 styles. Add `.itemDetailsGroup > div:not(:last-child) > .detailsGroupItem` and `.detailsGroupItem > .focuscontainer-x`. |

### 2.3 Cosmetic, both layouts

- **Stock `theme.css` now wins over ElegantFin card rules.** It is a `<link>` in `<body>`, after our `<head>` skin links. `.cardBox:not(.visualCardBox) .cardPadder{background:#202020}` beats ElegantFin at equal specificity. Card elements get `border-radius: var(--jf-card-borderRadius, .2em)`. Fix: set `--jf-card-borderRadius` in `elegant-kefin.css` and raise the padder rule's specificity.
- **Card text padding.** `.cardText` horizontal padding drops from 0.5em to 2px (`card.scss:302`).
- **Backdrop images linger.** Old `.backdropImage.displayingBackdropImage` nodes stay 1.6 s after a change, so `querySelector` returns the *old* one. Use the last match (`virtualSpecials.js:275`).
- **Deprecated `.html` routes.** `#/list.html` appears 105 times in the fork. It still redirects, with a warning.

### 2.4 Modern layout only (skip if pinning legacy)

**Features that stop working:**
- **infiniteScroll**
  - Modern library grids are React (`ItemsView.tsx`), paged with MUI prev/next, and there is no `.listPaging`/`#moviesTab`.
  - Cards we append vanish on refetch or tab change, and the sort/filter storage key differs.
  - Gate the feature to legacy. In Modern, "Library page size = 0" loads everything.
- **removeContinue, and watchlist buttons on React cards**
  - `card.remove()` on a React-owned node makes React throw `NotFoundError` on the next reconcile.
  - Hide the card instead of removing it.
- **headerTabs:** it only works on the hidden `.headerTabs`; Modern library tabs are URL-driven. Gate it to legacy.
- **Custom Tabs plugin tabs, and so the Watchlist tab:** invisible in Modern, because Modern home hard-codes `[Home, Favorites]`. Watchlist already has a `#/watchlist` custom-page path. `watchlist.js:7467-7475` decides once, after an await, and can pick the tab URL on a cold load.

**Features that inject into the hidden legacy header:**
- **osdLogo (logo mode):** it goes into the hidden `.skinHeader .headerRight`. Target `.videoOsd-appBar`.
- **themeMediaCastFix controls:** they measure the hidden header at 0 and end up in the corner. Anchor to `header.MuiAppBar-root`.
- **multiUserSession indicator:** it sits on the hidden header, and Modern hides `.userSection` (`AppOverrides.scss:9-15`).
- **Custom menu links on desktop:** these need `topNavigation`/`userMenu`, because there is no drawer at 900px and above.

**Display preferences page:**
- **themeMediaCastFix:** its `.fldThemeSong/.fldThemeVideo` replacement finds nothing. The native MUI checkboxes (`enableLibraryThemeSongs/Videos`) re-enable native theme media, so native and ours can both play until the next viewshow.
- **skinManager:** the skin dropdown still injects (after `#display-settings-layout-description`), but custom themes can't be added to the MUI theme select.

**Lifecycle and matching:**
- **viewshow timing:** React routes fire `viewshow` only on mount. Library A → B on the same route, and `?tab=` switches, fire no viewshow, and React pages never emit `viewhide`. Add a `hashchange` re-run in `utils.onViewPage`.
- **Home remount:** Modern home is not DOM-cached, so the whole KefinTweaks home re-renders on every return from a details page (a performance cost).
- **Page matching:** `pages:['home']` matches `#/homevideos` through `hash.includes`.

**Other:**
- **posterAspect:** Modern's alpha picker is `.alphaPicker-fixed-right`, not `.alphaPicker`, so no slack is reserved.
- **hamburgerMenu** turns on for any `_appVersion >= 12`. On legacy it runs a body-wide MutationObserver for nothing. Gate it on Modern.
- **Hard-coded MUI style classes** in `hamburgerMenu.js:17-33` and `configuration.js:5741-5766` may not match MUI 6.5 **(live)**.

### 2.5 Verified OK (the load-bearing parts)

- **Globals:** `window.ApiClient` is still jellyfin-apiclient 1.11.0, and every method the fork calls exists. `Emby.Page` (appRouter, including the `onViewShow` hook), `Dashboard.navigate` and `Events` are still there.
- **Legacy layout markup:** effectively 10.11 "stable". Cards, alphaPicker, tabs, home sections, detail-page anchors, `#moviesPage`/`#tvRecommendedPage`, and `viewshow` with `detail.params/isRestored` are all unchanged.
- **Backdrop mechanism** (`.backdropContainer > .backdropImage[data-url]` + `withBackdrop`) and `.detailLogo`: unchanged.
- **Endpoints:** every one the fork uses still exists, including the legacy `/Users/{u}/Items…` routes. The enums (`ItemFields`, `ItemFilter`, `ItemSortBy`, `BaseItemKind`) are unchanged.
- **Context menus:** still the legacy action sheet in both layouts, so removeContinue and homeScreenPin menu items are fine.
- **Dashboard:** the plugins drawer section (`ul[aria-labelledby="plugins-subheader"]`), `.dashboardDocument` and `configurationpage?name=` are unchanged.
- **pauseScreen:** all OSD selectors are present in both layouts. `_parseTimeText` is unaffected, and it already uses `e.code`.
- **Skin version mapping:** the fork's parser gives 12 for `12.1.0`. ElegantFin maps to the `[11,12]` set; Abyss to `[10,11,12]`. Upstream's `6f2617f` is not needed.
- **Web root:** `/usr/share/jellyfin/web/KefinTweaks` survives the package upgrade. `jellyfin-web` has no maintainer scripts and dpkg does not remove unowned files. `/web` static serving is unchanged. Back it up anyway.

---

## 3. What 12 now does natively (superseded or overlapping)

| Ours | 12 natively | Verdict |
|---|---|---|
| **castSessionWatchdog** | SDK ref-counts Sessions subscriptions; duplicate `/socket` fixed (`5389bbad37`). | **Superseded.** Retire after one live check. |
| **backdropLeakFix** | `09e5c43f04` removes stale backdrops after each rotation. | **Superseded** (already gated `[10,11]`). |
| **itemDetailsCollections** (off) | Native "Collections" row on details (`d18019a77b`), both layouts. | **Superseded.** Keep it off. The native row appears on every item in a TMDb box set *and* every special in a generated per-work collection. |
| **SmartSimilar** plugin | Native similarity providers. The built-in local provider is weighted: genre 10, tag 5, studio 5, director 50, actor 15 (`MovieSimilarItemsProvider.cs:29-33`). Configurable per library. | **Partial.** Ours still adds writer/library/rating bonuses, the watched filter, weighted shuffle and the explain UI. Consider porting to `ILocalSimilarItemsProvider`: it works on every client, needs no File Transformation shim, and appears in the per-library picker. |
| **Merge Versions** plugin | Episode versions (same folder, confident parse); manual "Group versions" for episodes; relational version links. | **Partial.** Cross-folder provider-id merging is still only the plugin's. Its 10.11 build throws `MissingMethodException` on 12; the 12.0.1.0 build has open bugs (#113, #106). |
| **Episode Show Title** (JS Injector script) | Any metadata-editor save on a Series now rewrites every season's and episode's `SeriesName` to the series name (`6238448716`, `ItemUpdateController.cs:314-336`). | **Conflict.** After one series edit, raw equals displayed and the script silently stops, until the episodes are refreshed from NFO. |
| **versionPreferences** | Better version labels; the same-named version is kept for the next episode. No edition priority. | **Partial + conflict** (item 8). |
| **removeContinue** | Still no native equivalent. | **Conflict** with TanStack caching and version-aware resume (item 12). |
| **customMenuLinks** (off) | `config.json` `menuLinks` in the Modern top nav: external links only, always a new tab. | **Partial.** Ours still does in-app links and placement. |
| **infiniteScroll** | Modern hides pagination at page size 0 (one big request). | **Partial.** Only relevant in Modern, where ours does not work anyway. |
| **Library Collections tab** (Modern) | New tab on every library, keeping BoxSets whose children are in that library. | **Clutter:** the Anime library will list all ~300 generated per-work collections. |
| **osdLogo** | The Modern video header shows the title as text; there is no logo. | **Weak overlap.** Still ours. |
| **pauseScreen** | New "Still watching?" prompt between episodes, **on by default**. | **No overlap.** Note that it can appear while our overlay is up **(live)**. |
| **Watch State Sync** plugin | Played state shared across *alternate versions* (`fd016cfb13`). | **No overlap:** a movie duplicated as a special is not an alternate version. |
| **Card Focus After Back** (JS Injector script) | viewManager focus restore and `.card-hoverable:focus-within` unchanged. | Still needed. |
| **themeMediaCastFix** | Theme media still `enableRemotePlayers:false`. | Still needed. |

**Nothing native replaces** watchlist, the custom home screen, breadcrumbs, playlist, flatten/seriesEpisodes, mediaTags, specialEpisodePrefix, episodeSeasonTitle or hamburgerMenu.

Also: `collectionStudios` and `collectionSpecialNames` are orphan flags in the live config. `5f889df` folded them into virtualSpecials.

---

## 4. Server plugins

Plugin ABI: 12 targets **.NET 10** and Jellyfin.Controller 12.x.
- A 10.11 DLL still *loads*, because only a too-new `targetAbi` is rejected.
- It then either fails type-load (the server marks it **NotSupported**), or loads Active and throws `MissingMethodException` when used. The second case is the dangerous one.
- **Updates are only offered to a strictly higher version**, so builds that keep the same number must be uninstalled and reinstalled.
- Disabled plugins now stay disabled across updates.

| Plugin | Installed | 12.x | On 12.1 as installed | Action |
|---|---|---|---|---|
| AniDB / AniList / Fanart / TheTVDB / Kodi Sync Queue | 11 / 13 / 14 / 22 / 15 | 13 / 15 (ABI 12.1) / 15 / 24 / 16 | binary-compatible | auto-update |
| **Intro Skipper** | 1.10.11.24 | 12.0.4.0 | NotSupported | update; keeps the 10.11 analysis |
| **SmartLists** | 12.0.1.0 (a 10.11 build) | 12.0.3.0 | NotSupported | update; confirm it moves |
| **File Transformation** | 3.0.1.0 | 3.0.1.0 (12 build, same number) | compatible | **uninstall and reinstall**; mechanism unchanged |
| **JavaScript Injector** | 4.0.0.0 | 4.0.0.0 (same number) | compatible | **reinstall** |
| **Jellyfin Enhanced** | 12.8.0.0 | 12.8.0.0 (same number) | compatible | **reinstall**; supports Modern; on 12 recommends its own Native Tab over Custom Tabs |
| **Media Bar Enhanced** | 3.8.0.0 | none with ABI 12 | compatible | open #136: home sections overlap the bar on 12 desktop |
| **Custom Tabs** | 0.2.10.0 | **none** (a `v12` branch 0.3.0.0 is untested) | DLL compatible; tabs invisible in Modern | **blocker** for the Watchlist tab in Modern; legacy on 12 **(live)** |
| **Collection Sections** | 2.3.10.0 | **none** (being folded into Home Screen Sections 3.0.2.0) | `MissingMethodException` | **blocker**, or switch plugins |
| **Shoko** | 6.0.5.11 | dev only: 6.0.5.3512 (`metadata/dev/manifest.json`) | `MissingMethodException` during scans | **blocker** unless moving to dev; settings don't migrate back |
| **Merge Versions** | 10.11.0.1 | 12.0.1.0 | `MissingMethodException` | update, or drop (see §3) |
| **SmartSimilar** (own) | 1.0.0.0 | — | `MissingMethodException` (`SmartSimilarController.cs:161`, `GetBaseItemDtos`) | **rebuild** net10/12.1; compiles with no source changes |
| **Anime Pipeline** (own) | 1.0.0.0 | — | binary-compatible | rebuild; under the .NET 10 SDK, fix CA1873 (`TreatWarningsAsErrors`, ~47 sites). Retest collection membership after the migration and scan. |
| **Artwork Multi Source** (own) | 1.0.0.0 | — | binary-compatible | rebuild; CA1873 (11 sites). CA2025 at `MultiSourceImageProvider.cs:82-89` is a real latent bug: a `using var request` disposed while `SendAsync` is still pending. |
| **Watch State Sync** (own) | 2.0.0.0 | — | binary-compatible | rebuild off-vault (vault has no dotnet). Its `GetItemList` queries now silently exclude alternate versions and owned items unless `IncludeAlternateVersions` / `IncludeOwnedItems` is set (`WatchedMediaLinkScanTask.cs:161-180`). |
| JellyTag | leftover dir only | — | — | ignore |

Themes:
- **ElegantFin:** legacy only on 12. Its README says to use "Desktop (Legacy)". Our local copy predates 12.
- **Abyss:** v1.2.3 is tested on 12.1 in Modern and Legacy. Our local clone is 4 commits behind, but we pull `@main` from jsDelivr.
- **KefinTweaks upstream releases:** support 12 only in Desktop (Legacy). Modern work is on upstream `experimental`.

Your pipeline tooling is fine: it already sends `Authorization: MediaBrowser Token=`. Ad-hoc `curl -H "X-Emby-Token: …"` will 401. Use `-H 'Authorization: MediaBrowser Token="…"'` or `?ApiKey=`.

---

## 5. Upgrade notes from upstream

- **One-way database migration.** The only way back is a full restore of `/var/lib/jellyfin` + `/etc/jellyfin`.
- **Remove or disable third-party plugins first.** That is upstream's advice. At minimum, disable Shoko, Merge Versions, Collection Sections and SmartSimilar, the ones that load and then throw.
- **A full library scan is required afterwards.** Auto-grouped alternate versions are dropped until it runs. The first scan is much slower, and some items can reappear as newly added.
- Name sorting now uses `SortName`/`CleanName`, so library order may change.
- Image endpoints no longer upscale beyond the source resolution.
- `/emby/*` and `/mediabrowser/*` prefixes are gone.
- All built-in themes are rebuilt on a shared CSS-variable base, so custom CSS (branding CustomCss included) may need adjusting **(live)**.
