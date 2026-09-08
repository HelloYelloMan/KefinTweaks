// ElegantFin :has() hotfix companion (KefinTweaks custom script)
// Maintains the marker classes that replace the Chromium-hot :has() selectors
// removed from the local ElegantFin build:
//
//   .squareCard:has(.cardFooter)                        -> .ef-has-footer
//   .cardOverlayContainer:has(>button:hover)            -> .ef-btn-hover
//   .cardScalable:has(.cardOverlayButton-hover:hover)   -> .ef-overlaybtn-hover
//   .vertical-list:has(.listItem-largeImage)            -> .ef-has-largeimage
//   .layout-mobile:has(#itemDetailPage:not(.hide))      -> .ef-detail-open (on <html>)
//   .detailImageContainer:has(.card:not(.portraitCard)) -> .ef-has-nonportrait
//
// Why: a :has() selector registered in CSS pays style-invalidation cost on
// EVERY DOM mutation whose nodes match its argument features — in Chromium
// this made each card insertion (buttons, .card, footers) trigger ancestor
// invalidation walks, dominating frames with Recalculate Style as the home
// screen grew. querySelectorAll(':has(...)') from JS is a one-time match with
// no registration, so re-applying markers on DOM settle is nearly free.
//
// Coverage: structural marks are driven by a debounced MutationObserver on
// childList (subtree), NOT a one-shot view hook. The KefinTweaks home screen
// renders progressively over seconds (initial sections, then discovery
// sections, load-more, season switches), so anything applied only at
// view-show+delay misses every card inserted after it — those cards then
// compute the wrong --cardCount / grid layout. Observing childList only (no
// attributes) means our own classList writes and the hover markers cannot
// re-trigger the observer, so there is no feedback loop; the :not(.ef-*)
// filters keep repeat passes cheap. The view hook is kept for the
// .ef-detail-open toggle (a class flip, invisible to a childList observer)
// and as an initial kick.
(function () {
    'use strict';

    // ---- Structural marks, re-applied whenever the DOM settles ----
    function applyStaticMarks() {
        try {
            document.querySelectorAll('.squareCard:has(.cardFooter):not(.ef-has-footer)')
                .forEach(el => el.classList.add('ef-has-footer'));
            document.querySelectorAll('.vertical-list:has(.listItem-largeImage):not(.ef-has-largeimage)')
                .forEach(el => el.classList.add('ef-has-largeimage'));
            document.querySelectorAll('.detailImageContainer:has(.card:not(.portraitCard)):not(.ef-has-nonportrait)')
                .forEach(el => el.classList.add('ef-has-nonportrait'));
            document.documentElement.classList.toggle(
                'ef-detail-open',
                !!document.querySelector('#itemDetailPage:not(.hide)')
            );
        } catch (e) {
            // :has() unsupported in querySelector — leave markers unset.
        }
    }

    // ---- Debounced childList observer: catches progressively rendered cards ----
    // Trailing debounce so a burst of insertions (a section render) costs one
    // pass after it settles rather than one per mutation record.
    let settleTimer = null;
    function scheduleApply() {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            settleTimer = null;
            applyStaticMarks();
        }, 100);
    }

    const domObserver = new MutationObserver(scheduleApply);

    function startObserver() {
        if (!document.body) {
            // Injector scripts can run before <body> exists.
            document.addEventListener('DOMContentLoaded', startObserver, { once: true });
            return;
        }
        domObserver.observe(document.body, { childList: true, subtree: true });
        applyStaticMarks();
    }
    startObserver();

    // ---- Hover markers replacing the :hover-argument :has() selectors ----
    // Delegated listeners: cost is one closest() per mouseover/out, instead of
    // engine-side subject invalidation on every hover flip over card rows.
    document.addEventListener('mouseover', (e) => {
        if (!(e.target instanceof Element)) return;
        const btn = e.target.closest('button');
        if (btn && btn.parentElement && btn.parentElement.classList.contains('cardOverlayContainer')) {
            btn.parentElement.classList.add('ef-btn-hover');
        }
        const overlayBtn = e.target.closest('.cardOverlayButton-hover');
        if (overlayBtn) {
            overlayBtn.closest('.cardScalable')?.classList.add('ef-overlaybtn-hover');
        }
    });

    document.addEventListener('mouseout', (e) => {
        if (!(e.target instanceof Element)) return;
        const btn = e.target.closest('button');
        if (btn && btn.parentElement && btn.parentElement.classList.contains('ef-btn-hover')) {
            const parent = btn.parentElement;
            const rt = e.relatedTarget;
            const stillOnChildButton = rt instanceof Element && rt.closest('button')?.parentElement === parent;
            if (!stillOnChildButton) parent.classList.remove('ef-btn-hover');
        }
        const overlayBtn = e.target.closest('.cardOverlayButton-hover');
        if (overlayBtn) {
            const scalable = overlayBtn.closest('.cardScalable');
            const rt = e.relatedTarget;
            const stillInside = rt instanceof Element && rt.closest('.cardOverlayButton-hover')?.closest('.cardScalable') === scalable;
            if (scalable && !stillInside) scalable.classList.remove('ef-overlaybtn-hover');
        }
    });

    // ---- View hook: drives .ef-detail-open (class flips are invisible to the
    // childList observer) and gives an extra settle pass on navigation. ----
    function install(attempt = 0) {
        if (window.KefinTweaksUtils?.onViewPage) {
            window.KefinTweaksUtils.onViewPage(() => {
                // Small delay so the incoming view's DOM settles first.
                setTimeout(applyStaticMarks, 100);
            }, { pages: [] });
            applyStaticMarks();
            return;
        }
        if (attempt < 40) setTimeout(() => install(attempt + 1), 250);
        else applyStaticMarks(); // best effort without the view hook
    }
    install();
})();
