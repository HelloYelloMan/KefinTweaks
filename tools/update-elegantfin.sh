#!/usr/bin/env bash
# Regenerate skins/ElegantFin-jellyfin-theme-build-latest-minified.css from upstream.
#
# The local copy exists ONLY to remove a handful of Chromium-hot :has() selectors
# from the ElegantFin build — ones whose :has() arguments match per-card inserted
# content, so every card insertion triggered ancestor style invalidation. They are
# rewritten to marker classes maintained by scripts/elegantfin-haspatch.js.
#
# This CANNOT be done as a CSS override: a later rule can win the cascade, but it
# cannot un-register the upstream selector, and registration is what costs. Hence
# a patched local copy rather than an override file.
#
# Usage: tools/update-elegantfin.sh [--check]
#   --check  fetch and report whether the local copy is current; change nothing.

set -euo pipefail

UPSTREAM="https://raw.githubusercontent.com/lscambo13/ElegantFin/main/Theme/ElegantFin-jellyfin-theme-build-latest-minified.css"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/skins/ElegantFin-jellyfin-theme-build-latest-minified.css"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching upstream…"
curl -sSfL -o "$TMP/upstream.css" "$UPSTREAM"

UPSTREAM_VERSION="$(head -c 200 "$TMP/upstream.css" | grep -oP 'ElegantFin Theme v\K[0-9.]+' || echo 'unknown')"
echo "Upstream version: $UPSTREAM_VERSION"

# --- The patch set: hot :has() selectors -> marker classes ---------------------
# Each entry is an exact literal substring replacement. Keep in sync with the
# selector list documented at the top of scripts/elegantfin-haspatch.js.
#
# Deliberately NOT patched: the ~40 other :has() selectors in the build. Their
# arguments (.person, .album, .subtitle, .listItemIcon, …) only appear on detail
# pages and action sheets, not in per-card insertion churn, so they are cheap.
patch_css() {
    python3 - "$1" "$2" <<'PY'
import re
import sys

REPLACEMENTS = [
    ('.cardScalable:has(.cardOverlayButton-hover:hover)', '.cardScalable.ef-overlaybtn-hover',            1),
    ('.cardOverlayContainer:has(>button:hover)',          '.cardOverlayContainer.ef-btn-hover',           1),
    ('.vertical-list:has(.listItem-largeImage)',           '.vertical-list.ef-has-largeimage',            1),
    ('.squareCard:has(.cardFooter)',                       '.squareCard.ef-has-footer',                  14),
    ('.layout-mobile:has(#itemDetailPage:not(.hide))',     '.layout-mobile.ef-detail-open',               1),
    ('.detailImageContainer:has(.card:not(.portraitCard))','.detailImageContainer.ef-has-nonportrait',    1),
    # Action-sheet rows (pick-one menus). Upstream marks the unchosen rows by a :has()
    # test on the hidden tick's INLINE STYLE, and Chromium re-checks that on every
    # inline-style change anywhere: ~150 ms of whole-page restyles on each season and
    # episode page (measured 2026-10-14). The chosen-row fill is painted by the tick
    # span's own ::after instead -- no :has() looks at an attribute. Pure CSS, no
    # marker script. Pixel-identical in the 12.1 sandbox across every menu and state
    # but one: a row held down rasterises a little sharper.
    ('.actionSheetMenuItem:has(.listItemIcon.check){background-color:var(--accentColor)}',
     '@supports selector(:has(a)){.actionSheetMenuItem:has(.listItemIcon.check){background-color:transparent;position:relative}.actionSheetMenuItem>.listItemIcon.check{position:absolute;top:0;right:0;bottom:0;left:0;width:auto!important;height:auto!important;margin:0!important;padding:0;border-radius:inherit;visibility:hidden;pointer-events:none}.actionSheetMenuItem>.listItemIcon.check~*{position:relative}.actionSheetMenuItem>.listItemIcon.check:after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;visibility:visible;background:var(--accentColor)}.actionSheetMenuItem>.listItemIcon.check[style*=hidden]:after{background:transparent}.actionSheetMenuItem>.listItemIcon.check[style*=hidden]+.listItemBody .listItemBodyText{background-color:transparent;color:var(--fullContrastColor)}.actionSheetMenuItem:active>.listItemIcon.check[style*=hidden]:after{background:var(--semiTransparentAccentColor)}}', 1),
    ('.actionSheetMenuItem:has(.listItemIcon.check) .listItemIcon.check{display:none}',
     '', 1),
    ('.actionSheetMenuItem:has(.listItemIcon.check[style*=hidden]){background-color:transparent}',
     '', 1),
    ('.actionSheetMenuItem:has(.listItemIcon.check[style*=hidden]) .listItemBodyText{background-color:transparent;color:var(--fullContrastColor)}',
     '', 1),
    ('.actionSheetMenuItem:has(.listItemIcon.check[style*=hidden]):active{background-color:var(--semiTransparentAccentColor)}',
     '', 1),
    ('.actionSheetMenuItem:has(.listItemIcon.check[style*=hidden]):hover{background:var(--activeBackgroundColor)!important;color:var(--hoverTextColor)!important}',
     '.actionSheetMenuItem:hover>.listItemIcon.check[style*=hidden]:after{background:var(--activeBackgroundColor)}.actionSheetMenuItem:hover>.listItemIcon.check[style*=hidden]~*{color:var(--hoverTextColor)!important}', 1),
]

HEADER = (
    "/* ElegantFin (local copy) — Chromium :has() invalidation hotfix: selectors whose\n"
    "   :has() arguments match per-card inserted content (button, .card, .cardFooter,\n"
    "   .listItem-largeImage) rewritten to marker classes maintained by\n"
    "   elegantfin-haspatch.js. Visually identical when that script is loaded.\n"
    "   Rebased on upstream v26.09.05 (2026-09-24): the same six substitutions, which\n"
    "   the Jellyfin 12 Modern companion sheet (optional include) needs.\n"
    "   Action-sheet rows: the chosen-row fill is painted by the tick span, so no\n"
    "   :has() tests an inline style (2026-10-14). */\n"
)

src = open(sys.argv[1], encoding='utf-8').read()

failed = False
for old, new, expected in REPLACEMENTS:
    found = src.count(old)
    if found != expected:
        print(f"  !! expected {expected}x  {old}  but found {found}", file=sys.stderr)
        failed = True
    src = src.replace(old, new)

# Nothing that tests an inline style may survive inside :has(): that is the pattern
# that costs, and a new upstream rule of the same shape must stop the update.
survivors = re.findall(r':has\([^)]*\[style[^)]*\)', src)
if survivors:
    print(f"  !! :has() testing an inline style survives: {survivors[:3]}", file=sys.stderr)
    failed = True

if failed:
    print("\nUpstream selectors have drifted. Re-check the hot :has() rules against\n"
          "scripts/elegantfin-haspatch.js before shipping.", file=sys.stderr)
    sys.exit(2)

open(sys.argv[2], 'w', encoding='utf-8').write(HEADER + src)
PY
}

echo "Applying :has() hotfix patch set…"
patch_css "$TMP/upstream.css" "$TMP/patched.css"

if cmp -s "$TMP/patched.css" "$TARGET"; then
    echo "Local copy is already current with upstream v$UPSTREAM_VERSION. Nothing to do."
    exit 0
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
    echo "Local copy is OUT OF DATE with upstream v$UPSTREAM_VERSION."
    echo "Run without --check to update."
    exit 1
fi

cp "$TMP/patched.css" "$TARGET"
echo "Updated $TARGET to upstream v$UPSTREAM_VERSION."
echo "Re-check scripts/elegantfin-haspatch.js if upstream changed card markup."
