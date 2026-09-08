# Console Client Gating

**Config key:** `disableOnConsoles`
**Files:** `kefinTweaks-plugin.js`, `injector.js`
**Default:** `true` — KefinTweaks does not load on game consoles
**Applies to:** Xbox, PlayStation 3/4/5 and Vita, Nintendo Switch and Wii U

---

## What it does

On a game console, KefinTweaks loads nothing at all. No scripts, no skin CSS, no
observers, no caches — the user gets the stock Jellyfin web client. Every other client
is unaffected.

The check runs before the payload is requested, so the cost on a console is the
installer script and one regex, not a cancelled download.

## Why it exists

The consoles that reach the Jellyfin web client do so through a locked-down WebView on
hardware with a small fraction of a desktop browser's CPU and memory, and they are
driven by a gamepad rather than a pointer. Two independent problems follow:

- **Weight.** The KefinTweaks payload is dozens of scripts plus a skin. The home screen
  alone is roughly 9,000 DOM nodes and a scrolled library grid around 30,000 (see
  [performance-mode.md](performance-mode.md) for the measurements). That is already the
  dominant cost on desktop Chromium; on console hardware it is not a trade-off worth
  making.
- **Input model.** Several features are built on hover — the trickplay thumbnail
  scrubber and the card hover states among them. There is no hover on a gamepad, so
  that work is spent for nothing.

Neither is fixable by disabling a few scripts, which is why the gate is all-or-nothing
rather than a per-script filter.

## Detection

User agent first, with Jellyfin's own reported device name as a fallback for wrappers
whose UA says nothing useful:

```js
/\bXbox\b|PlayStation|PLAYSTATION|\bNintendo\b|WiiU|NintendoBrowser/i
```

The `PLAYSTATION` alternative is functionally redundant under the `i` flag. It is kept
because that is exactly how the PS3 spells it, and a reader should not have to take the
flag on trust to see that the PS3 is covered.

Tested against real user-agent strings:

| Client | UA token matched | Result |
|---|---|---|
| Xbox Series X (WebView2) | `Xbox` | gated |
| Xbox One (EdgeHTML) | `Xbox` | gated |
| PlayStation 5 | `PlayStation` | gated |
| PlayStation 4 | `PlayStation` | gated |
| PlayStation 3 | `PLAYSTATION` | gated |
| Nintendo Switch | `Nintendo` | gated |
| Wii U | `Nintendo` | gated |
| Chrome / Firefox / Edge desktop | — | loads |
| Jellyfin for Android | — | loads |
| Tizen (Samsung TV) | — | loads |
| webOS (LG TV) | — | loads |

The word boundaries matter. Bare `Xbox` would be safe today, but `\bXbox\b` keeps the
pattern from matching a longer token some future UA embeds it in, and `\bNintendo\b`
does the same.

### Smart TVs are deliberately not gated

Tizen and webOS are also remote-driven and also modest hardware, but they are a
supported target with their own apps, and the KefinTweaks skin is usable there. They
stay on the load side. If you want them out too, add `Tizen|Web0S` to the one pattern —
it is duplicated in both files and both copies must change together.

### The device-name fallback

```js
const device = (window.ApiClient && typeof ApiClient.deviceName === 'function')
    ? ApiClient.deviceName() : '';
if (/xbox|playstation|nintendo/i.test(device || '')) return true;
```

`ApiClient.deviceName()` is what Jellyfin labels the session with on the dashboard —
"Xbox One", "PlayStation 5". This catches a wrapper that presents a generic UA but still
identifies itself to the server correctly. It is a fallback, not the primary check,
because `ApiClient` may not exist yet when the gate runs; the call is wrapped in
`try`/`catch` for exactly that reason.

## Where the gate lives

Two layers, because there are two ways in.

### 1. The installer — `kefinTweaks-plugin.js`

This is the one that fires in a normal install. `checkAndLoadInjector()` bails before
appending `injector.js`, so the payload is never requested:

```js
const config = await getKefinTweaksConfig();
if (consoleGateApplies(config)) { /* log once, return */ }
```

It sits *after* the `await`, which is the point: the config is fully resolved there, so
the `disableOnConsoles` override is read from the authoritative saved config rather than
from whatever happens to be on `window` at parse time.

`checkAndLoadInjector()` is called again on every 100ms login-poll retry, up to 100
times. Hence the `consoleGateLogged` flag — the gate returns on every pass but says so
once.

### 2. The injector — `injector.js`

The same check at the top of the injector's IIFE, before any other work. This covers a
self-hosted setup that loads `injector.js` directly rather than through the installer.
Here `window.KefinTweaksConfig` is reliably populated, because the installer awaited it
before appending the script.

The early `return` leaves `window.KefinTweaks` undefined. Nothing observes it on a gated
client, since no KefinTweaks script loads to look for it.

## Overriding it

Two escape hatches, in precedence order.

**Per device, for testing.** In that device's console:

```js
localStorage.setItem('kefinTweaks.allowConsole', '1')
```

Takes precedence over the config value, changes nothing for anyone else, and is the
right way to check whether something actually works on the hardware before opening it up
server-wide. Every `localStorage` access in the gate is wrapped in `try`/`catch` —
a sandboxed WebView can throw on the property access itself, and a gate that throws is
a gate that fails open.

**Server-wide.** Set `disableOnConsoles` to `false` in the KefinTweaks config.

The key defaults to `true` in `kefinTweaks-default-config.js`, but the gate does not
depend on that default reaching the saved config: the test is `!== false`, so an
existing saved config with no such key gates correctly with no migration and no
re-save.

## Turning it off is not a per-script decision

There is no partial mode. If a console user needs one specific feature, the honest
answer is to override the gate entirely on that device and measure what happens, rather
than to build a console-specific subset that nothing else exercises.
