# Known Issues

Bugs found and confirmed by reading the code, but deliberately left unfixed for now.
Each entry says what is wrong, what it costs, and what a fix would involve.

Found while investigating "marking a card watched refreshes every card image on the
page". That one is fixed — see [Card user-data buttons](#card-user-data-buttons-fixed)
at the bottom for what changed and what is still outstanding from it.

---

## 1. Next Up and Continue Watching caches are never invalidated

**File:** `scripts/homeScreen3.js`
**Lines:** 336, 473

`handleUserDataChanged` exists to drop the cached query results for the Next Up,
Continue Watching, and combined sections whenever an item's played state changes, so the
next home render sees the change. It does not do that, for either of two reasons, and
the two are mutually exclusive.

The listener is registered behind a capability check:

```js
if (window.ApiClient && window.ApiClient.addEventListener) {
    window.ApiClient.addEventListener('userdatachanged', ...);
}
```

Jellyfin's own code never listens this way. Its event helper (`src/utils/events.ts`)
exposes `on`, `off` and `trigger`, and every internal subscriber to this feed goes
through `Events.on(apiClient, 'message', ...)` in `serverNotifications`. If the
apiclient package does not also define an `addEventListener` method, the guard is false
and the handler is never registered at all.

If it *is* registered, the handler throws on its third line:

```js
const parentItemUserData = event.Data?.UserDataList?.[1];

if (parentItemUserData.Key.includes('MusicAlbum')) {
```

The optional chaining stops at the lookup; the dereference that follows is unguarded.
A user-data list has one entry per affected item, so marking a movie played produces a
list of one and `parentItemUserData` is undefined. The handler throws before it reaches
any of the invalidation, and the caches are left stale.

Either way the sections keep serving cached data until the entry's own TTL expires.

**To fix:** guard the parent lookup, then confirm at runtime which feed actually
delivers. `scripts/cardBuilder.js` now subscribes by appending to
`ApiClient._callbacks.message`, the same list `serverNotifications` uses; that is a
known-good route to the same messages if `addEventListener` turns out not to exist.

## 2. The user-data listener accumulates across navigations

**File:** `scripts/homeScreen3.js`
**Line:** 473

`enhanceHomeScreen` registers the listener above every time it runs, and nothing ever
removes it. The re-entrancy guard that protects the rest of the function is stored on
the sections container (`container.dataset.kefinHomeScreen`), and Jellyfin replaces that
container when you navigate away from home and back. So the guard resets, the function
runs again, and another listener is added.

A long session that returns to the home screen repeatedly ends up with one duplicate
handler per visit, each doing the full cache-invalidation walk.

**To fix:** hold the handler in module scope and register it once, or remove the
previous one before adding a new one.

## 3. The watchlist button is never hidden on watched cards

**Files:** `scripts/watchlist.js` (line 7440), `scripts/watchlist.css` (line 1877)

The rule meant to hide the watchlist button once an item is watched is:

```css
button[data-played="true"] ~ .watchlist-button { display: none; }
```

`~` matches following siblings only. `addWatchlistButton` inserts the watchlist button
*before* the playstate button:

```js
buttonContainer.insertBefore(watchlistButton, playStateButton);
```

so the watchlist button is always a *preceding* sibling and the rule can never match.
The button stays visible on watched cards.

The comment above the rule in `watchlist.css` describes the opposite arrangement
("appended to the same `.cardOverlayButton-br` container ... immediately after it"),
which is presumably the layout the rule was written against.

**To fix:** either append the watchlist button after the playstate button and accept the
change in button order, or invert the CSS to `.watchlist-button:has(~ button[data-played="true"])`.
The second keeps the order but reintroduces a `:has()` on a per-card subject, which is
exactly the pattern `scripts/elegantfin-haspatch.js` exists to remove — so the reorder is
the better option if the visual change is acceptable.

Note that the selector used to find the playstate button was updated when the card
buttons stopped being Jellyfin custom elements, specifically so this ordering did *not*
change as a side effect of that work.

## 4. Mark-played and favourite button config is dead

**File:** `scripts/homeScreen3.js`
**Lines:** 1315-1326

`loadSectionForRendering` sets eight flags to suppress overlay buttons on the My Media
section:

```js
sectionConfig.showMarkPlayedButton = false;
sectionConfig.enableMarkPlayedButton = false;
sectionConfig.showFavoriteButton = false;
...
```

`scripts/cardBuilder.js` reads none of them. The overlay buttons are built for every
card that is neither a library card (`CollectionFolder`, `UserView`) nor a custom card,
and that condition alone decides it.

In practice My Media cards *are* library cards, so they get no overlay buttons anyway
and nothing looks wrong. The flags are still dead: any other section that set them would
be ignored.

**To fix:** either read the flags in the card build path, or delete them and rely on the
card-type check.

---

## Card user-data buttons (fixed)

**File:** `scripts/cardBuilder.js`

Every card used to carry two Jellyfin custom elements, `is="emby-playstatebutton"` and
`is="emby-ratingbutton"`. Each instance subscribes to the global `UserDataChanged`
notification when it attaches to the document, and Jellyfin's `serverNotifications`
fires that notification once *per entry* in the message's user-data list — one entry per
affected item, so marking a series played sends one for the series and one for every
season and episode beneath it.

One click therefore ran `(2 x cards) x entries` handlers before the browser could paint.
On a home screen of a few hundred cards that is tens of thousands of calls on the same
thread that delivers the lazy-image IntersectionObserver callbacks, which are what
assign card artwork. Artwork stopped appearing mid-click and popped back in afterwards,
which read as the whole page reloading its images. Performance Mode makes it more
visible, for the reason its own file documents.

The buttons are now plain buttons carrying `.kefin-userdata-button` plus
`.kefin-playstate-button` or `.kefin-favorite-button`. Behaviour comes from one
delegated click listener and one message listener installed for the whole document, and
because the raw message carries the entire user-data list at once, a change of any size
costs a single pass over the buttons on the page. Markup, state attributes and titles
are unchanged, so the CSS, the skins and Jellyfin's own card-indicator update all still
match.

### Still outstanding

Each KefinTweaks row is built as `is="emby-itemscontainer"`, and that custom element
subscribes to the same notification. Its handler dynamic-imports Jellyfin's cardBuilder
and runs a scoped `querySelectorAll` on every event, so a home screen of thirty rows
still costs `30 x entries` of that work per click.

This is a much smaller term than the per-card one, and the subscription cannot simply be
dropped: card click handling, the context menu, multi-select and focus containment all
come from the same element. Replacing it means reimplementing `itemShortcuts` wiring for
KefinTweaks rows, which is a larger change than this one was.
