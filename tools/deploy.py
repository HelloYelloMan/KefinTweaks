#!/usr/bin/env python3
"""Deploy this fork to vault's Jellyfin web root, and tell every browser.

    tools/deploy.py [--dry-run]

1. Refuses a dirty tree: what goes live is a commit, and the commit names it.
2. Copies the tracked files that differ, except tools/, into /usr/share/jellyfin/web/KefinTweaks
   on vault (rsync by checksum, in place, so existing files keep root:media;
   new files get group media, mode 664). Nothing there is ever deleted.
3. Sets the version token -- the short commit hash -- in JS Injector's config:
     - KefinTweaks-Config gets "assetVersion": every URL KefinTweaks builds for
       its own files carries ?v=<it> (scripts/kefinTweaks-loader.js,
       assetVersionSuffix);
     - the KefinTweaks bootstrap entry loads kefinTweaks-plugin.js?v=<it>, since
       it runs before the config exists.
   Both arrive in JavaScriptInjector/public.js, which is never cached, so a
   browser picks up the new URLs on its next page load whatever it has cached.

The web root serves these files with an ETag but no Cache-Control, which is why
this exists: without a token, a deploy reached a browser only when its own copy
happened to expire. The previous JS Injector config is saved under
~/.cache/kefintweaks-deploy/ before it is replaced.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOST = "vault"
WEB_DIR = "/usr/share/jellyfin/web/KefinTweaks"
JELLYFIN = "http://vault:8096"
API_KEY_FILE = Path("/opt/scripts/anime_metadata_pipeline/keys/jellyfin_api.key")
BACKUP_DIR = Path.home() / ".cache" / "kefintweaks-deploy"
CONFIG_ENTRY = "KefinTweaks-Config"
BOOTSTRAP_ENTRY = "KefinTweaks"
BOOTSTRAP_FILE = "kefinTweaks-plugin.js"
CONFIG_PREFIX = "window.KefinTweaksConfig = "


def git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], check=True,
                          capture_output=True, text=True).stdout


def api(method, path, body=None):
    req = urllib.request.Request(JELLYFIN + path, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    req.add_header("Authorization", f'MediaBrowser Token="{API_KEY_FILE.read_text().strip()}"')
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read()
    return json.loads(data) if data else None


def sync_files(dry_run):
    """rsync the tracked files; return (changed paths, new paths)."""
    files = git("ls-files", "-z").split("\0")
    # tools/ is local dev tooling (.gitignore), this script included: never shipped.
    files = [f for f in files if f and not f.startswith("tools/")]
    cmd = ["rsync", "-rc", "--inplace", "--itemize-changes", "--no-owner", "--no-group",
           "--no-perms", "--files-from=-", "--from0", f"{REPO}/", f"{HOST}:{WEB_DIR}/"]
    if dry_run:
        cmd.insert(1, "--dry-run")
    out = subprocess.run(cmd, input="\0".join(files), check=True, capture_output=True, text=True).stdout
    changed, new = [], []
    for line in out.splitlines():
        # ">f.st......" updated file, ">f+++++++++" new file; directories are "cd..."
        if not line.startswith(">f"):
            continue
        path = line.split(" ", 1)[1]
        changed.append(path)
        if line.startswith(">f+++"):
            new.append(path)
    if new and not dry_run:
        quoted = " ".join("'" + f"{WEB_DIR}/{p}".replace("'", "'\\''") + "'" for p in new)
        subprocess.run(["ssh", HOST, f"chgrp media {quoted} && chmod 664 {quoted}"], check=True)
    return changed, new


def set_token(token, dry_run):
    plugins = api("GET", "/Plugins")
    pid = next(p["Id"] for p in plugins if p["Name"] == "JavaScript Injector")
    cfg = api("GET", f"/Plugins/{pid}/Configuration")
    entries = {e.get("Name"): e for e in cfg.get("CustomJavaScripts", [])}
    if CONFIG_ENTRY not in entries or BOOTSTRAP_ENTRY not in entries:
        sys.exit(f"JS Injector has no {CONFIG_ENTRY!r} or {BOOTSTRAP_ENTRY!r} entry; nothing to version.")

    conf = entries[CONFIG_ENTRY]
    text = conf["Script"]
    at = text.index(CONFIG_PREFIX)
    head, body = text[:at + len(CONFIG_PREFIX)], text[at + len(CONFIG_PREFIX):].rstrip()
    kt = json.loads(body.rstrip(";"))
    # Written as the configuration UI writes it (JSON.stringify(c, null, 2)), so
    # the next save from the UI produces the same text apart from what it changes.
    if json.dumps(kt, indent=2, ensure_ascii=False) + ";" != body:
        print("  note: KefinTweaks-Config is not in the UI's own layout; it will be re-indented")
    old_token = kt.get("assetVersion")
    kt["assetVersion"] = token
    conf["Script"] = head + json.dumps(kt, indent=2, ensure_ascii=False) + ";"

    boot = entries[BOOTSTRAP_ENTRY]
    src_at = boot["Script"].find(BOOTSTRAP_FILE)
    if src_at < 0:
        sys.exit(f"The {BOOTSTRAP_ENTRY!r} entry does not load {BOOTSTRAP_FILE}; left as it is.")
    end = src_at + len(BOOTSTRAP_FILE)
    rest = boot["Script"][end:]
    if rest.startswith("?v="):
        rest = rest[3:].lstrip("0123456789abcdefABCDEF")
    boot["Script"] = boot["Script"][:end] + "?v=" + token + rest

    print(f"  token: {old_token or '(none)'} -> {token}")
    if dry_run:
        return
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"jsinjector-{time.strftime('%Y%m%d-%H%M%S')}.json"
    backup.write_text(json.dumps(api("GET", f"/Plugins/{pid}/Configuration"), indent=1, ensure_ascii=False))
    print(f"  previous JS Injector config saved to {backup}")
    api("POST", f"/Plugins/{pid}/Configuration", cfg)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="show what would change, write nothing")
    args = ap.parse_args()

    if git("status", "--porcelain", "--untracked-files=no").strip():
        sys.exit("Uncommitted changes: commit first, so the token names what is live.")
    token = git("rev-parse", "--short=12", "HEAD").strip()

    print(("Dry run: " if args.dry_run else "") + f"deploying {token} to {HOST}:{WEB_DIR}")
    changed, new = sync_files(args.dry_run)
    print(f"  files: {len(changed)} changed" + (f", {len(new)} new" if new else ""))
    for p in changed:
        print(("    + " if p in new else "    ~ ") + p)
    set_token(token, args.dry_run)
    print("Dry run only; nothing written." if args.dry_run
          else "Done: browsers load the new files on their next page load.")


if __name__ == "__main__":
    main()
