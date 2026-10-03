# Potential issues

Found by the 2026-09-23 audit of the fork's changes, confirmed by reading the code,
and deliberately **not fixed**: none of them has been seen on the live server.
If a complaint matches one of these, start here. Line numbers are as of commit
9145cab and will drift.

## Infinite scroll

### Dead after clearing a short filter
`scripts/infiniteScroll.js` — the reset that notices the library query changed
(sort, filter, letter) lives inside `loadMore()`, *after* the `if (!hasMore) return`
guard, and `checkScrollPosition` also gates on `hasMore`.

- Filter a library to something short (Favorites). One scroll reaches the end and
  sets `hasMore = false`.
- Clear the filter. Jellyfin repaints page 1 of the full library, but nothing
  re-evaluates the query signature, because every path to that check returns early.
- Infinite scroll stays off until you navigate away and back.

**Fix sketch:** move the signature computation into a helper and call it before
both `hasMore` gates, resetting paging state when it changes. Needs a browser test.

### Does not start on a TV library's Shows tab
Activation used to come from a body-wide observer, which saw tab switches. It now
runs on navigation plus a 10s poll. On TV libraries:

- The fallback page selector `#tvshowsPage` does not exist in 10.11 (the page is
  `#tvRecommendedPage`).
- Switching tabs changes neither the hash nor the view, so no navigation fires.

A TV library that opens on Suggestions, where Shows is clicked more than 10s later,
never starts infinite scroll for that visit. Movies is unaffected (`#moviesPage`
exists).

**Fix sketch:** listen for jellyfin-web's `tabchange` event (or clicks on
`.emby-tab-button`) and re-run activation.

## Poster Aspect: the A-Z picker reservation flips on phones

`scripts/posterAspect.js` `applyPickerSlack` (~line 594). The CSS applies the slack as
`padding-right: var(--par-slack)`, **replacing** the base padding, but the function
computes it as if it were **added**: `current` is read from computed padding, which
already includes the slack written last time.

- First measure, base padding P: slack = overlap - P.
- The next full re-measure (skin switch, rotating the phone twice) computes the
  slack back to P. When P = 0 (below 600px, or above 1300px) that deletes it.
- The grid then alternates between clear of the letters and running under them.
- Between 600 and 1300px it also reserves 48px too little.

Not seen by Robert: on mobile the skin switcher is not reachable outside settings.

**Fix** (behaviour change at 600-1300px, so verify at phone width first): clear
`data-par-slack` and `--par-slack` before reading, then use
`needed = round(rect.right - pr.left) + PICKER_GAP` as the total padding, removing
the slack when `needed <= base`.

Related: the picker lookup is scoped to the page, but jellyfin-web puts one picker
in each tab (Movies has two), so on the Collections tab it finds the hidden Movies
picker (width 0). Scope it to `container.closest('.pageTabContent, [data-role="page"]')`.

## Updoot: misses in-app navigation

`scripts/updoot.js` now listens for `hashchange`/`popstate`, but 10.11 navigates with
`history.pushState` (`appRouter.show`), which fires neither. The Recommend button
never appears after clicking through to a detail page. The feature is off by
default and Robert has never used it. **Fix:** hook `KefinTweaksUtils.onViewPage`
or the document `viewshow` event.

## Pause Screen

- **Closing a player dialog cancels a pending pause screen.** Every
  `popstate`/`hashchange` during playback calls `clearState()`, and Jellyfin's
  dialogs close with `history.back()`. Pausing, then picking a subtitle track, means
  no pause screen for that pause until the mouse moves. Accepted: the pause screen is
  an idle feature and rarely matters while navigating menus.
- **Remaining-time mode breaks external-player progress.** With the OSD toggled to
  show `-12:34`, `_parseTimeText` returns a negative duration: 0%, no "Ends at".
- **User id and token are captured once**, so signing in as another user without a
  reload makes `fetchItemInfo` fail for the rest of the session.

## Cast Session Watchdog: re-subscribes where no feed exists

`scripts/castSessionWatchdog.js` treats "bar visible, nothing playing locally, no
Sessions frame for 6s" as a stall. That is also true of:

- Chromecast (`beginPlayerUpdates()` is empty)
- paused local audio

In both cases it sends `SessionsStart` up to 3 times per quiet spell and never
`SessionsStop`, and it warns "reload the page". Whether the server stacks those
subscriptions is unverified.

**Fix sketch:** only arm after at least one Sessions frame has been seen for the
current bar.

## Theme Media

- **Direct-play retry race** (`tryPlay`). An undecodable direct source fires both
  `error` and a rejected `play()`. If the rejection is handled after `onerror` has
  switched to the transcode, it sees `_tmTried` and destroys the retrying element.
  The likeliest case is an .ogg/.opus theme song in Safari. Traced against the spec,
  not run.
- **Mobile, same-owner navigation.** Series to season keeps the old `<video>`
  inside the hidden series page's `.itemBackdrop`.
- **Settings initialised once per page load, not per user**: a second user without
  a reload inherits volume/mute and skips the native-settings copy.
- **Disabling the feature leaves native theme media switched off**: it writes
  `enableThemeSongs/Videos=false` and nothing restores them.

## Smaller

- **Optional includes load in completion order** (`skinManager.js` ~914/928): each
  include is inserted when its cache-token HEAD returns. A quick on/off toggle can
  insert a sheet after it was disabled.
- **KefinTweaks CSS depends on elegantfinHaspatch**: `kefin-borderless-spotlight`
  is only maintained by elegantfin-haspatch.js. Disable that feature and the
  Borderless spotlight silently stops. (Seasonal backgrounds used to depend on its
  `body.kefin-home-active` too; since the 2026-10-03 merge they key on upstream's
  `html[data-active-page="home"]`, which utils.js sets on every navigation.)
- **Poster Aspect, Resume/Next Up with series images**: with "use episode images"
  off, the card shows the series thumb but gets the episode still's ratio class.
- **Grid filler cards** copy the first card's `par-NN` and can wrap onto an
  invisible extra row under a home grid.
- **Refresh paths skip the smart filter**: the section refresh button returns
  watched items at double the count.
- **Liked (Shows) is nearly always empty**: its pool is favourite *Episodes*.
- **specialEpisodePrefix**: the learned wording is never re-validated. A wrong one
  derived from a card whose series name ends with the special's name would strip
  that series name everywhere.
- **Watchlist media-bar observer** gives up after 60s. Staying on the login page
  longer than that means the media-bar slides get no watchlist button.
- **Abyss count pill on old TV webviews**: the relative-colour `color:` falls back
  to inherited white, not the `#121212` line above it, on Chromium below 119.
