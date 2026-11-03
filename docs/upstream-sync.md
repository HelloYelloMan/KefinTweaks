# Upstream sync: task prompt

The instructions a Claude session follows to bring upstream KefinTweaks into this fork, by hand or from a scheduled task. Everything below this note is the prompt, verbatim.

---

You maintain a personal fork of KefinTweaks, a Jellyfin web-client customisation layer. You are the only editor of the fork. There are no PRs: commit and push directly.

## Repositories and branches

- `origin` = https://github.com/HelloYelloMan/KefinTweaks (the fork, writable)
- `upstream` = https://github.com/ranaldsgift/KefinTweaks (the original, read-only)
- `experimental` and `main` on origin are pure mirrors of upstream's branches of the same name. Nothing of ours is ever committed to them.
- `vault` is the fork's real branch: upstream/experimental plus our changes. It is the only branch with our work, and the one the owner serves and edits locally.
- Ignore upstream's other branches (e.g. `webos-spotlight-fix`).

If `origin` or `upstream` is missing in the clone, add it. Fetch branches only, not tags (tags pull in unneeded history and slow the run).

## Hard rules

- Never force-push `experimental`, `main` or `vault`. Plain pushes only. If a push is rejected, stop and report.
- Never rewrite history on `vault` that is already pushed. The default is a merge commit, not a rebase (see "How to bring upstream in").
- Never touch `experimental`/`main` other than fast-forwarding them to upstream. If a fast-forward is not possible, stop and report.
- Never skip, disable or delete a test to make a run pass.
- Never put secrets, tokens, server URLs or IPs in a commit. If you notice any in the diff you are about to push, stop and report.
- When unsure whether a conflict resolution is correct, do not push. Leave `vault` untouched and report.

## The directives for this fork

1. **Keep the footprint on upstream small.** The fork exists to make updating from upstream cheap. For every change, the question is "what is the least intrusive way to get this behaviour?" In order of preference:
   a. a new file of ours (new script, new CSS under `skins/optional/`, new `docs/` page, new config file) wired in through an existing extension point;
   b. a small addition to an upstream file at a place where upstream is unlikely to edit (the end of a list or block, in a clearly marked "FORK-ONLY" section, as `scripts/kefinTweaks-loader.js` already does);
   c. a surgical edit inside upstream code, only when a. and b. cannot do it, kept to the fewest lines and commented as a fork change.
   Do not reformat, reorder, rename or "tidy" upstream code. Do not mix our edits into lines upstream is likely to touch.
2. **Prefer upstream's implementation when upstream ships the same feature.** If upstream has added something that does what a fork feature does, adopt upstream's version: either unchanged, or with the smallest modification that keeps whatever extra behaviour our version had (an option, a setting, a corner case). Then delete our now-redundant code, and remove its loader/config entries, CSS and docs, unless the extra behaviour needs them. Do not keep both.
3. **When our feature and upstream's merely overlap**, keep ours only if it does something upstream's does not. Say which parts, in the commit message.

## Baseline: what the fork changes today (as of the first run)

Measured against upstream/experimental, `vault` is 83 files, about +9,300/-450 lines: 38 files added, 45 modified. Treat this as a starting point and re-derive it each run with `git diff --stat upstream/experimental origin/vault`.

- **New, self-contained (low merge risk):** `scripts/virtualSpecials.js`, `scripts/elegantfin-haspatch.js`, `configuration/seriesSpecials-configuration.js`, `pages/thumbRound.*`, `skins/default-kefin.css`, `skins/ElegantFin-jellyfin-theme-build-latest-minified.css`, the Abyss colour schemes, and about 18 files under `skins/optional/**`. `docs/*.md`, `tests/*.test.cjs` and `tools/` are fork-only.
- **Modified upstream files, biggest edits first (highest merge risk):** `skins/abyss-kefin.css` (+640), `scripts/cardBuilder.js` (+460/-73), `scripts/skinConfig.js`, `scripts/skinManager.js`, `scripts/seriesEpisodes.js`, `skins/elegant-kefin.css`, `scripts/sectionHelper.js`, `skins/jellyfish-kefin.css`, `injector.js`, `scripts/utils.js`, `scripts/kefinTweaks-loader.js`, `scripts/apiHelper.js`, `scripts/homeScreen3.js`, `kefinTweaks-plugin.js`, `scripts/breadcrumbs.js`, `configuration/homeScreen-configuration.js`. About 30 more files get a handful of lines each.
- **Feature areas in the fork's history:** Jellyfish and Abyss/ElegantFin skin work, Poster Aspect, "Help page" / "Help & Tips", CRT shader, custom pages, virtual specials / Item Page Tweaks, performance work (Chromium `content-visibility`, batched observers, console gating), Jellyfin 12 compatibility.
- **Where we register fork-only things:** `scripts/kefinTweaks-loader.js` has two marked "FORK-ONLY FEATURES" blocks (the defaults map and the script definitions list), grouped at the end so upstream additions land above them. Keep new registrations there. If upstream restructures the registry again, re-home our entries into the new place and check that nothing silently stopped loading (a missing registry entry ships the script but never runs it, with no error).
- **Docs:** `docs/*.md` describe each fork feature and its files. When you change, move or remove a fork feature, update its doc in the same commit. `docs/jellyfin-12-upgrade.md` and `docs/potential-issues.md` record known issues; read them before a merge touching those areas.

When a run changes the footprint materially, say so in the report (files now modified vs. upstream, before and after).

## How to bring upstream in

1. `git fetch upstream experimental main --no-tags` and `git fetch origin vault experimental main --no-tags`.
2. If `upstream/experimental` and `upstream/main` are already contained in the right branches, there is nothing to do: report "already up to date" and stop. Do not create empty commits.
3. Mirror branches:
   - `git push origin upstream/experimental:refs/heads/experimental`
   - `git push origin upstream/main:refs/heads/main`
   Plain pushes only; if either is rejected as non-fast-forward, stop and report.
4. Update `vault`. **Merge `upstream/experimental` into `vault`; do not rebase.** `vault` has a long history of already-pushed commits and prior upstream merges, which a rebase would replay and re-conflict commit by commit, and rewriting it would break the owner's local copy. Commit message: `Merge upstream experimental (<short sha>) into the fork`, matching the existing history.
5. Before resolving anything, look at what upstream changed: `git log --oneline vault..upstream/experimental` and `git diff --stat vault...upstream/experimental`. Compare each upstream change against the fork's feature list above. For each, decide: unrelated (merge as-is), overlaps a fork feature (directives 2 and 3), or touches a file we modify (resolve carefully, directive 1).
6. Resolve conflicts, keeping our edits as small as possible. Prefer taking upstream's side of a hunk and re-applying our change on top in the least intrusive way, rather than hand-merging both.
7. Verify before pushing:
   - `node --check` on every `.js` file changed by the merge, and run the tests: `for t in tests/*.test.cjs; do node "$t"; done`.
   - Make sure no conflict markers remain (`git grep -nE '^(<<<<<<<|=======|>>>>>>>)'`).
   - Check that `scripts/kefinTweaks-loader.js` still contains every fork-only entry, and that every script referenced there exists.
   - No secrets or private URLs in the diff.
8. If everything passes: `git push origin vault` (a plain fast-forward push). If it is rejected, fetch, and if `vault` moved on origin, merge that in and retry once; otherwise stop and report.
9. If any step is ambiguous or fails verification, do not push `vault`. Abort the merge (`git merge --abort`), leave `vault` as it was, and report exactly what blocks it.

## Report at the end

Always finish with a short report:
- upstream commits brought in (count, short list of notable ones);
- `experimental`, `main`, `vault`: old sha -> new sha, or "unchanged";
- fork features that upstream now covers, what you adopted, and what you removed;
- conflicts and how each was resolved (file, one line);
- footprint change (files/lines modified vs. upstream, before and after);
- anything left undone or needing the owner's decision.

If a run fails or you stop early, say so first, then why.
