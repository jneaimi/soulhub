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
  --bump LEVEL       cut a versioned release: bump package.json (patch|minor|
                     major), commit+push it to private main, then publish +
                     tag v<new> + create the GitHub Release. Implies --gh-release.
  --gh-release       after push, create a GitHub Release for v<version> if the
                     tag does not already exist on the remote (needs `gh` auth)
  --dry-run          assemble + show what WOULD be pushed; make no remote changes
  -h, --help         this help

Versioning (ADR-006 semver):
  Plain `npm run release` syncs public main with NO version change (rolling
  main). Cut a versioned release with --bump when it's a milestone:
    patch = bug fixes   minor = new backward-compatible features   major = breaking
  update-check (ADR-010) reads the latest GitHub *Release*, so only --bump
  releases are visible to users' "update available" banner.
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


def next_version(old: str, level: str) -> str:
    """Pure semver increment. patch|minor|major."""
    import re
    if not re.fullmatch(r"\d+\.\d+\.\d+", old):
        die(f"package.json version {old!r} is not semver X.Y.Z — bump manually.")
    major, minor, patch = (int(x) for x in old.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def apply_bump(old: str, new: str) -> str:
    """Rewrite package.json + package-lock.json version, commit + push. Returns new."""
    import re
    pkg = REPO_ROOT / "package.json"
    text = pkg.read_text()
    rewritten, count = re.subn(r'("version":\s*")' + re.escape(old) + r'(")',
                               r"\g<1>" + new + r"\g<2>", text, count=1)
    if count != 1:
        die(f'could not rewrite "version": "{old}" in package.json')
    pkg.write_text(rewritten)
    step(f"Bumped version {old} → {new}")

    # Keep package-lock.json's version in lockstep. SET it directly (not an
    # old→new substitution): historically the lockfile was never bumped, so its
    # committed value has drifted (e.g. stuck at 2.0.0). A stale committed
    # lockfile means every install's `npm install` rewrites the version field →
    # a dirty tree → the one-click updater refuses to pull. Syncing it here stops
    # that drift at the source. (Both the root `version` and packages[""].version.)
    lock = REPO_ROOT / "package-lock.json"
    if lock.exists():
        data = json.loads(lock.read_text())
        data["version"] = new
        if isinstance(data.get("packages"), dict) and "" in data["packages"]:
            data["packages"][""]["version"] = new
        lock.write_text(json.dumps(data, indent=2) + "\n")
        ok(f"synced package-lock.json version → {new}")
    else:
        warn("no package-lock.json to sync")

    run(["git", "add", "package.json", "package-lock.json"], cwd=REPO_ROOT)
    run(["git", "commit", "-m", f"chore(release): v{new}"], cwd=REPO_ROOT)
    run(["git", "push", "origin", "main"], cwd=REPO_ROOT)
    ok("committed + pushed bump to private main")
    cl = REPO_ROOT / "CHANGELOG.md"
    if cl.exists() and new not in cl.read_text():
        warn(f"CHANGELOG.md has no v{new} entry — the GitHub Release notes auto-generate, but CHANGELOG is the in-repo record. Add one.")
    return new


def main() -> None:
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--yes", action="store_true")
    p.add_argument("--bump", choices=["patch", "minor", "major"], default=None)
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

    # Versioned release: bump first (commit+push private), then the publish flow
    # carries the new version into the export + tag + GitHub Release.
    confirmed = False
    if args.bump:
        new = next_version(version, args.bump)
        if args.dry_run:
            warn(f"--dry-run: would bump {version}→{new} ({args.bump}), commit+push private, publish, create GitHub Release v{new}.")
            version = new  # reflect intended version in the preview; no writes
            args.gh_release = True
        else:
            if not args.yes:
                try:
                    ans = input(f"\n{B}RELEASE v{new}{X} (bump {version}→{new}, {args.bump}): "
                                f"commit+push private main, publish to public, create GitHub Release v{new}. Continue? [y/N] ")
                except EOFError:
                    ans = ""
                if ans.strip().lower() not in ("y", "yes"):
                    die("aborted (release not confirmed).")
            version = apply_bump(version, new)
            args.gh_release = True
            confirmed = True
            short_sha = git_out(["rev-parse", "--short", "HEAD"], REPO_ROOT)

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

    # 3. Confirmation gate — this writes to a PUBLIC remote. (Skipped when a
    #    --bump release was already confirmed up front.)
    if not args.yes and not confirmed:
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
