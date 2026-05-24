#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
release-publish.py — ADR-008 / ADR-013 two-repo publish.

The missing half of `scripts/release-export.sh`. release-export ASSEMBLES the
clean public surface into a target dir and runs the export gate; this script
then PUBLISHES it — pushing the delta to the public `soulhub` repo
(history-preserving, never force-push) and optionally cutting a GitHub Release.

Outward-facing: it writes to a PUBLIC remote, so it refuses to push without an
explicit --yes (or an interactive y/N confirm). It never touches the private
repo's git or the live :2400 instance.

Usage:
  uv run scripts/release-publish.py [options]
  npm run release -- [options]

Options:
  --yes              skip the interactive confirmation (for non-interactive use)
  --remote URL       public remote (default: https://github.com/jneaimi/soulhub.git)
  --target DIR       export staging dir (default: /tmp/soulhub-release)
  --message MSG      public commit message (default: derived from version + sha)
  --gh-release       after push, create a GitHub Release for v<version> if the
                     tag does not already exist on the remote (needs `gh` auth)
  --dry-run          assemble + show what WOULD be pushed; make no remote changes
  -h, --help         this help
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REMOTE = "https://github.com/jneaimi/soulhub.git"
DEFAULT_TARGET = "/tmp/soulhub-release"

B, G, Y, R, X = ("\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[0m") if sys.stdout.isatty() else ("",) * 5


def step(m: str) -> None: print(f"{B}==>{X} {m}")
def ok(m: str) -> None: print(f"  {G}✓{X} {m}")
def warn(m: str) -> None: print(f"  {Y}!{X} {m}", file=sys.stderr)
def die(m: str) -> None: print(f"{R}✗ {m}{X}", file=sys.stderr); sys.exit(1)


def run(cmd: list[str], cwd: Path | None = None, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, check=check, text=True,
                          capture_output=capture)


def git_out(args: list[str], cwd: Path) -> str:
    return run(["git", *args], cwd=cwd, capture=True).stdout.strip()


def main() -> None:
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--yes", action="store_true")
    p.add_argument("--remote", default=DEFAULT_REMOTE)
    p.add_argument("--target", default=DEFAULT_TARGET)
    p.add_argument("--message", default=None)
    p.add_argument("--gh-release", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("-h", "--help", action="store_true")
    args = p.parse_args()
    if args.help:
        print(__doc__); return

    target = Path(args.target)
    version = json.loads((REPO_ROOT / "package.json").read_text())["version"]
    short_sha = git_out(["rev-parse", "--short", "HEAD"], REPO_ROOT)

    # Guard: release-export copies tracked files from the WORKING TREE (not the
    # committed HEAD), so a dirty tree changes what ships. Be precise about it.
    dirty = git_out(["status", "--porcelain"], REPO_ROOT)
    if dirty:
        warn("canonical working tree is dirty. release-export copies tracked files from the WORKING TREE, so:")
        warn("  • uncommitted edits to TRACKED files WILL be published")
        warn("  • brand-new UNTRACKED files will NOT ship until `git add`")
        warn("  commit first for a reproducible release. Pending:")
        print(dirty, file=sys.stderr)
    try:
        unpushed = git_out(["log", "--oneline", "@{u}..HEAD"], REPO_ROOT)
        if unpushed:
            warn("canonical has commits not pushed to its own origin — `git push origin main` first if you want them public:")
            print(unpushed, file=sys.stderr)
    except subprocess.CalledProcessError:
        pass  # no upstream configured; ignore

    step(f"Publishing Soul Hub v{version} (canonical {short_sha}) → {args.remote}")

    # 1. Assemble the public surface (release-export runs the fail-closed gate).
    step("Assembling public surface via release-export.sh")
    run(["rm", "-rf", str(target)])
    run(["bash", str(REPO_ROOT / "scripts" / "release-export.sh"), str(target)])

    # 2. History-preserving stage: init a throwaway repo over the export, point
    #    it at the public remote, and reset --soft to its HEAD so only the delta
    #    vs the public tree is staged. (Never force-push; never lose history.)
    step("Staging delta against public main")
    run(["git", "init", "-b", "main", "-q"], cwd=target)
    run(["git", "remote", "add", "origin", args.remote], cwd=target)
    run(["git", "fetch", "origin", "main", "-q"], cwd=target)
    run(["git", "reset", "--soft", "origin/main"], cwd=target)
    run(["git", "add", "-A"], cwd=target)

    # Nothing staged => public is already in sync. Stop cleanly.
    if run(["git", "diff", "--cached", "--quiet"], cwd=target, check=False).returncode == 0:
        ok("public surface already up to date — nothing to publish.")
        return

    staged = git_out(["diff", "--cached", "--name-only"], target)
    print(f"  files changing in public:\n" + "\n".join("    " + l for l in staged.splitlines()))

    msg = args.message or f"release: sync public surface @ v{version} ({short_sha})"

    if args.dry_run:
        warn(f"--dry-run: would commit ({msg!r}) and push to {args.remote}; stopping.")
        return

    # 3. Confirmation gate — this writes to a PUBLIC remote.
    if not args.yes:
        try:
            ans = input(f"\n{B}Push the above to the PUBLIC repo {args.remote}? [y/N] {X}")
        except EOFError:
            ans = ""
        if ans.strip().lower() not in ("y", "yes"):
            die("aborted (no --yes and not confirmed).")

    # 4. Commit + push.
    step("Committing + pushing to public main")
    run(["git", "-c", "user.name=Jasem Al neaimi", "-c", "user.email=jneaimi@gmail.com",
         "commit", "-m", msg], cwd=target)
    run(["git", "push", "origin", "main"], cwd=target)
    ok(f"pushed to {args.remote} (main)")

    # 5. Optional GitHub Release (ADR-010 update-check reads /releases/latest, so
    #    a tag alone is not enough — it needs a published Release).
    if args.gh_release:
        publish_gh_release(target, version, args.remote)


def publish_gh_release(target: Path, version: str, remote: str) -> None:
    tag = f"v{version}"
    if run(["bash", "-c", "command -v gh"], check=False, capture=True).returncode != 0:
        warn(f"--gh-release: `gh` CLI not found — skipping. Create the Release manually: gh release create {tag}")
        return
    # Already released? (tag present on remote)
    existing = git_out(["ls-remote", "--tags", "origin", tag], target)
    if existing:
        ok(f"GitHub tag {tag} already exists on the remote — skipping release creation.")
        return
    slug = remote.split("github.com/")[-1].removesuffix(".git")
    step(f"Tagging {tag} + creating GitHub Release on {slug}")
    run(["git", "tag", "-a", tag, "-m", f"Soul Hub {tag}"], cwd=target)
    run(["git", "push", "origin", tag], cwd=target)
    rc = run(["gh", "release", "create", tag, "--repo", slug, "--title", tag, "--generate-notes"],
             cwd=target, check=False).returncode
    if rc == 0:
        ok(f"GitHub Release {tag} created.")
    else:
        warn(f"`gh release create {tag}` failed — create it manually so /releases/latest reflects {tag}.")


if __name__ == "__main__":
    main()
