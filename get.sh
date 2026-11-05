#!/usr/bin/env bash
# IVE installer.
#
#   curl -fsSL https://ive.dev/install.sh | bash
#
# On a Mac with Apple silicon and macOS 13.5 or newer this downloads the
# IVE app from the latest GitHub release, checks its SHA-256, lets macOS
# verify the signature and notarization, puts the app into /Applications
# (or ~/Applications when /Applications is not writable) and opens it.
# Running it again updates the app. Python, Node.js and Git are not needed.
#
# Linux and Intel Macs have no app yet. There the installer downloads the
# source into ~/.ive, installs its Python and npm dependencies there, builds
# IVE and links an `ive` command into ~/.local/bin. A fresh source install
# does not start IVE. Running it again updates an existing installation and
# restarts IVE if it was running. The installer changes nothing outside
# those two places.
#
# `bash install.sh` in a clone of the repository runs this installer on
# Apple silicon too, so cloning the repository on a Mac gets you the app.
#
# Options for the Mac app: --plan prints the steps without running them,
# --no-open installs without opening IVE.
#
# Settings: IVE_INSTALL=app or IVE_INSTALL=source forces one of the two
# ways. Mac app: IVE_APP_DIR (folder for IVE.app), IVE_RELEASE_URL (where
# the app is downloaded from). Source: IVE_DIR (install folder), IVE_BIN_DIR
# (where `ive` goes), IVE_REPO (git URL to install from), IVE_PYTHON
# (Python to use).

# Everything runs inside main so a half-downloaded script does nothing.
main() {
  set -euo pipefail

  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "IVE runs on macOS and Linux." ;;
  esac
  # sysctl and spctl live in /usr/sbin, which cron or a bare PATH leaves out.
  if [ "$(uname -s)" = Darwin ]; then PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"; fi

  # install.sh asks whether this machine gets the app.
  if [ "${1:-}" = --mac-app-check ]; then
    use_mac_app
    exit 0
  fi

  if use_mac_app; then
    install_mac_app "$@"
  else
    install_from_source "$@"
  fi
}

# The app is for Apple silicon with macOS 13.5 or newer. IVE_INSTALL=app or
# IVE_INSTALL=source overrides the choice.
use_mac_app() {
  case "${IVE_INSTALL:-}" in
    app) return 0 ;;
    source) return 1 ;;
    "") ;;
    *) fail "IVE_INSTALL must be 'app' or 'source', not '$IVE_INSTALL'." ;;
  esac
  [ "$(uname -s)" = Darwin ] || return 1
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != 1 ]; then
    say "This Mac has an Intel processor. There is no IVE app for it yet, so IVE is built from source."
    return 1
  fi
  local version
  version="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  if ! version_at_least "$version" 13 5; then
    say "The IVE app needs macOS 13.5 or newer, this Mac has $version. IVE is built from source instead."
    return 1
  fi
}

# True if version $1 (like 14.2.1) is at least $2.$3.
version_at_least() {
  local major minor
  IFS=. read -r major minor _ <<<"$1"
  major="${major:-0}"
  minor="${minor:-0}"
  [ "$major" -gt "$2" ] 2>/dev/null || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; } 2>/dev/null
}

install_mac_app() {
  local release="${IVE_RELEASE_URL:-https://github.com/michaelAGI/ive/releases/latest/download}"
  local dmg="IVE-macOS-arm64.dmg"
  local app_dir="${IVE_APP_DIR:-}"
  local plan="" open=1 arg
  for arg in "$@"; do
    case "$arg" in
      --plan) plan=1 ;;
      --no-open) open="" ;;
      *) fail "'$arg' is not an option of the Mac app install. IVE_INSTALL=source selects the source build and its options." ;;
    esac
  done
  [ "$(uname -s)" = Darwin ] || fail "The IVE app is for macOS. Unset IVE_INSTALL to build from source."
  if [ -z "$app_dir" ]; then
    if [ -w /Applications ]; then app_dir=/Applications; else app_dir="$HOME/Applications"; fi
  fi
  local app="$app_dir/IVE.app"

  if [ -n "$plan" ]; then
    say "Plan for the IVE Mac app (nothing runs):"
    say "  1. Download $release/$dmg and its .sha256 into a temporary folder"
    say "  2. Check the SHA-256, open the disk image and let macOS verify the app's signature and notarization"
    say "  3. Put IVE.app into $app_dir, replacing an older IVE there after it was quit"
    if [ -n "$open" ]; then say "  4. Open IVE"; fi
    return 0
  fi

  need curl "Install curl first."
  if [ -e "$app" ] && [ "$(app_bundle_id "$app")" != com.ive.desktop ]; then
    fail "$app exists but is not IVE. Move it away or choose another folder with IVE_APP_DIR=/some/folder."
  fi

  local new_version old_version="" latest
  if [ -d "$app" ]; then
    old_version="$(app_version "$app")"
    # The release link redirects to .../download/v1.0.18/...: that tag says
    # whether there is anything new before 90 MB are downloaded.
    latest="$(latest_release_version "$release/$dmg")"
    if [ -n "$latest" ] && [ "$latest" = "$old_version" ]; then
      say "IVE $old_version is already installed in $app_dir and is the latest release."
      finish_mac_app "$app" "$old_version" "$open"
      return 0
    fi
  fi

  IVE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ive-install.XXXXXX")"
  IVE_MOUNT=""
  trap mac_app_cleanup EXIT

  say "Downloading the IVE app from $release"
  local progress=-sS
  if [ -t 2 ]; then progress=--progress-bar; fi
  curl -fL --retry 3 "$progress" -o "$IVE_TMP/$dmg" "$release/$dmg" </dev/null \
    || fail "The download failed. Check your connection, or get the app at https://github.com/michaelAGI/ive/releases"
  curl -fsSL --retry 3 -o "$IVE_TMP/$dmg.sha256" "$release/$dmg.sha256" </dev/null \
    || fail "The checksum file could not be downloaded. Try again in a moment."
  (cd "$IVE_TMP" && shasum -a 256 --check --status "$dmg.sha256") \
    || fail "The downloaded app does not match its checksum. Nothing was installed; run the installer again."

  IVE_MOUNT="$IVE_TMP/dmg"
  mkdir "$IVE_MOUNT"
  hdiutil attach -nobrowse -readonly -noverify -quiet -mountpoint "$IVE_MOUNT" "$IVE_TMP/$dmg" </dev/null \
    || fail "The disk image could not be opened."
  [ -d "$IVE_MOUNT/IVE.app" ] || fail "The disk image does not contain IVE.app."

  say "Checking the app's signature and notarization"
  spctl --assess --type execute "$IVE_MOUNT/IVE.app" </dev/null \
    || fail "macOS does not accept the downloaded app. Nothing was installed."

  new_version="$(app_version "$IVE_MOUNT/IVE.app")"
  if [ "$old_version" = "$new_version" ]; then
    say "IVE $new_version is already installed in $app_dir."
  else
    quit_running_ive "$app" "$old_version" "$new_version"
    if [ -n "$old_version" ]; then
      say "Replacing IVE $old_version in $app_dir with IVE $new_version"
    else
      say "Installing IVE $new_version into $app_dir"
    fi
    mkdir -p "$app_dir"
    rm -rf "$app_dir/IVE.app.installing"
    ditto "$IVE_MOUNT/IVE.app" "$app_dir/IVE.app.installing" </dev/null
    rm -rf "$app"
    mv "$app_dir/IVE.app.installing" "$app"
  fi
  mac_app_cleanup
  finish_mac_app "$app" "$new_version" "$open"
}

# Opens the installed app (unless $3 is empty) and says what was done.
finish_mac_app() {
  local app="$1" version="$2" open="$3"
  if [ -n "$open" ]; then
    say "Opening IVE"
    open "$app" </dev/null
  fi
  say ""
  say "IVE $version is installed in $(dirname "$app")."
  say "To update, run the installer again. To remove IVE, quit it, run"
  say "  \"$app/Contents/Resources/backend/ive-backend\" --remove-hooks"
  say "and drag IVE to the Trash."
  local source_dir="${IVE_DIR:-$HOME/.ive}"
  if [ -d "$source_dir/.git" ] && [ -f "$source_dir/bin/ive" ]; then
    say ""
    say "Your earlier terminal install in $source_dir is separate from the app and keeps its own projects."
    if [ -f "$source_dir/.ive-team-state/source-build" ] || ! grep -q uses_mac_app "$source_dir/bin/ive"; then
      say "Until you remove it, its 'ive' command starts it in a browser."
    fi
    say "To remove it, run this and then reopen the app, which sets its hooks again:  $(printf %q "$source_dir")/bin/ive uninstall"
  fi
}

# Prints the version tag the release link $1 redirects to, or nothing.
latest_release_version() {
  local target
  target="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "$1" </dev/null 2>/dev/null || true)"
  case "$target" in
    */releases/download/v[0-9]*/*)
      target="${target##*/releases/download/v}"
      printf '%s\n' "${target%%/*}"
      ;;
  esac
}

# Asks a running IVE to quit (it stops its local service itself), after the
# user agreed, and waits until it is gone.
quit_running_ive() {
  local app="$1" old="$2" new="$3" pids answer="" i
  pids="$(pgrep -f "^$app/Contents/MacOS/ive\$" || true)"
  [ -n "$pids" ] || return 0
  if [ -r /dev/tty ]; then
    printf 'IVE %s is running. Quit it and install IVE %s? Running agent sessions end. [y/N] ' "$old" "$new" >&2
    read -r answer </dev/tty || true
  fi
  case "$answer" in
    y|Y|yes|Yes|YES) ;;
    *) fail "IVE is running. Quit it (Cmd+Q) and run the installer again." ;;
  esac
  say "Quitting IVE"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for i in $(seq 1 40); do
    pgrep -f "^$app/Contents/MacOS/ive\$" >/dev/null || return 0
    sleep 0.5
  done
  fail "IVE did not quit. Quit it (Cmd+Q) and run the installer again."
}

mac_app_cleanup() {
  if [ -n "${IVE_MOUNT:-}" ]; then
    hdiutil detach -quiet "$IVE_MOUNT" </dev/null 2>/dev/null \
      || hdiutil detach -quiet -force "$IVE_MOUNT" </dev/null 2>/dev/null || true
    IVE_MOUNT=""
  fi
  if [ -n "${IVE_TMP:-}" ]; then
    rm -rf "$IVE_TMP" 2>/dev/null || true
    IVE_TMP=""
  fi
}

app_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo unknown
}

app_bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

install_from_source() {
  [ $# -eq 0 ] || fail "'$1' is not an option of the source install. In a clone of the repository, 'bash install.sh --plan' prints the steps."
  local repo="${IVE_REPO:-https://github.com/michaelAGI/ive.git}"
  local dir="${IVE_DIR:-$HOME/.ive}"
  local bin_dir="${IVE_BIN_DIR:-$HOME/.local/bin}"
  local updated=""

  need git "Install Git first. On macOS: xcode-select --install"
  need node "Install Node.js 22.12 or newer first: https://nodejs.org (on macOS: brew install node)"
  need npm "Install npm (it comes with Node.js)."
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
    || fail "IVE needs Node.js 22.12 or newer, you have $(node -v). On macOS: brew upgrade node"

  if [ -d "$dir/.git" ] && [ -f "$dir/bin/ive" ]; then
    # Stops a running IVE, updates, rebuilds and starts it again.
    say "Updating IVE in $dir"
    bash "$dir/bin/ive" update
    updated=1
  elif [ -d "$dir/.git" ]; then
    say "Updating IVE in $dir"
    git -C "$dir" pull --ff-only --quiet
  elif [ -e "$dir" ]; then
    fail "$dir already exists and is not an IVE folder. Choose another one with IVE_DIR=/some/path."
  else
    say "Downloading IVE into $dir"
    git clone --quiet --depth 1 "$repo" "$dir"
  fi

  # The Python check lives in the repo so it can't drift from install.sh.
  source "$dir/tools/python.sh"
  ive_python >/dev/null || exit 1

  if [ -z "${updated:-}" ]; then
    say "Installing dependencies and building the app. This takes a few minutes."
    IVE_INSTALL=source bash "$dir/install.sh"
  fi

  mkdir -p "$bin_dir"
  ln -sfn "$dir/bin/ive" "$bin_dir/ive"

  say ""
  if [ -n "$updated" ]; then
    say "IVE is updated."
  else
    say "IVE is installed."
  fi
  case ":$PATH:" in
    *":$bin_dir:"*)
      say "Start it with:  ive"
      say "IVE then runs in the background and opens in your browser."
      ;;
    *)
      say "Start it with:  $bin_dir/ive"
      say "To type just 'ive', add this line to your shell profile (~/.zshrc or ~/.bashrc):"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  say "Stop it with 'ive stop', update with 'ive update', remove it with 'ive uninstall'."
}

say() { printf '%s\n' "$*"; }
fail() { printf 'IVE install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$2"; }

main "$@"
