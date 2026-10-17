#!/usr/bin/env bash
# Release Overlord: tag the tip of origin/master with a version and push the tag.
#
# Pushing a v* tag is the whole release. CI reruns every check on the tag, then
# packages the .vsix with the tag's version and publishes it as the tag's GitHub
# release (.github/workflows/ci.yml). This script only makes sure the tag lands on
# a commit CI has already passed, so a release never waits on a check that fails.
#
# Usage: scripts/create-release.sh [-n] [-y] <major|minor|patch|X.Y.Z>
#   major, minor, patch   bump the newest v* tag (or package.json before the first one)
#   X.Y.Z                 release exactly this version (v prefix optional)
#   -n                    dry run: check everything, then say what would happen
#   -y                    do not ask for confirmation

set -euo pipefail

usage() {
  sed -n 's/^# \{0,1\}//; 9,13p' "$0" >&2
  exit 2
}

die() {
  echo "create-release: $*" >&2
  exit 1
}

dry_run=0
assume_yes=0
while getopts "nyh" opt; do
  case "$opt" in
    n) dry_run=1 ;;
    y) assume_yes=1 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
requested="$1"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git checkout"
cd "$root"
[ -f scripts/install-local.mjs ] || die "not the Overlord repository: $root"
command -v gh >/dev/null || die "gh is not on PATH; it checks CI before tagging"

# Marketplace versions are plain X.Y.Z, so prereleases are not supported here.
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

newest() {
  sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# The release is whatever origin/master points at, so this works from any branch
# or worktree and never ships local commits nobody else has seen.
echo "Fetching origin..." >&2
git fetch --quiet --tags origin master
sha="$(git rev-parse origin/master)"

latest="$(git tag --list 'v*' | sed 's/^v//' | grep -E "$SEMVER" | newest || true)"
base="$latest"
if [ -z "$base" ]; then
  base="$(git show origin/master:package.json | sed -n 's/^  "version": "\(.*\)",$/\1/p')"
  echo "$base" | grep -Eq "$SEMVER" || die "could not read the version from package.json"
fi

case "$requested" in
  major | minor | patch)
    IFS=. read -r major minor patch <<<"$base"
    case "$requested" in
      major) version="$((major + 1)).0.0" ;;
      minor) version="$major.$((minor + 1)).0" ;;
      patch) version="$major.$minor.$((patch + 1))" ;;
    esac
    ;;
  *)
    version="${requested#v}"
    echo "$version" | grep -Eq "$SEMVER" || die "$requested is not a version such as 1.2.0"
    ;;
esac
tag="v$version"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  die "$tag already exists"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  die "$tag already exists on origin"
fi
if [ -n "$latest" ] && [ "$(printf '%s\n%s\n' "$version" "$latest" | newest)" != "$version" ]; then
  die "$version is not newer than the latest release, $latest"
fi

# The newest CI run for a push of this commit to master.
ci_run() {
  gh run list --workflow ci.yml --branch master --event push --commit "$sha" --limit 1 \
    --json databaseId,status,conclusion,url \
    --jq '.[0] | select(.) | "\(.databaseId) \(.status) \(if .conclusion == "" then "none" else .conclusion end) \(.url)"'
}

run="$(ci_run)"
[ -n "$run" ] || die "CI has not run on origin/master ($sha) yet; push it and try again"
read -r run_id status conclusion url <<<"$run"
if [ "$status" != "completed" ]; then
  echo "CI is still running on $(git log -1 --format=%h "$sha"); waiting for it ($url)..." >&2
  gh run watch "$run_id" --exit-status >/dev/null 2>&1 || true
  read -r run_id status conclusion url <<<"$(ci_run)"
fi
[ "$conclusion" = "success" ] || die "CI did not pass on origin/master ($conclusion): $url"

cat >&2 <<EOF

  Release    $tag
  Commit     $(git log -1 --format='%h %s' "$sha")
  Previous   ${latest:+v}${latest:-none}
  CI         passed ($url)

Pushing $tag makes CI rerun the checks, package the .vsix and publish the GitHub release.
EOF

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run: nothing was tagged or pushed." >&2
  exit 0
fi

if [ "$assume_yes" -ne 1 ]; then
  printf 'Release %s? [y/N] ' "$tag" >&2
  read -r answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *) die "not released" ;;
  esac
fi

git tag -a "$tag" -m "Overlord $version" "$sha"
# --no-verify: the pre-push hook checks this checkout's working tree, which has
# nothing to do with a tag on a commit CI already passed.
git push --quiet --no-verify origin "refs/tags/$tag"

# github.com/owner/repo from either an https or an ssh remote.
slug="$(git remote get-url origin | sed -E 's#^(https://|git@)github\.com[:/]##; s#\.git$##')"
echo "Tagged and pushed $tag." >&2
echo "Build:   https://github.com/$slug/actions" >&2
echo "Release: https://github.com/$slug/releases/tag/$tag (appears when the build passes)" >&2
