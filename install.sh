#!/usr/bin/env bash
set -euo pipefail
IVE_PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
IVE_STATE="$IVE_PACKAGE_ROOT/.ive-team-state"
IVE_SOURCE_MARKER="$IVE_STATE/source-build"
IVE_HERE="$(printf %q "$IVE_PACKAGE_ROOT")"

case "${IVE_INSTALL:-}" in
  ""|app|source) ;;
  *) echo "IVE install: IVE_INSTALL must be 'app' or 'source', not '$IVE_INSTALL'." >&2; exit 1 ;;
esac

# True on a Mac that gets the app, whatever IVE_INSTALL says right now.
ive_app_mac() { env -u IVE_INSTALL bash "$IVE_PACKAGE_ROOT/get.sh" --mac-app-check >/dev/null 2>&1; }

# True if this script was called by this folder's bin/ive during `ive update`.
ive_update_is_calling() {
  local command script
  command="$(ps -o command= -p "$PPID" 2>/dev/null || true)"
  case "$command" in
    *" update") ;;
    *) return 1 ;;
  esac
  script="${command% update}"
  script="${script#* }"
  [ "$script" -ef "$IVE_PACKAGE_ROOT/bin/ive" ]
}

# On a Mac with Apple silicon the signed app from the latest release is the
# way to run IVE, and get.sh installs it. A folder only builds from source
# after IVE_INSTALL=source, and stays that way until IVE_INSTALL=app.
IVE_APP_POINTER=""
if [ -z "${IVE_INSTALL:-}" ]; then
  if [ -f "$IVE_SOURCE_MARKER" ]; then
    IVE_INSTALL=source
  elif [ -f "$IVE_STATE/instance.json" ] && ive_update_is_calling; then
    # bin/ive from before the app installer runs this script without
    # IVE_INSTALL during `ive update` and restarts its server afterwards.
    # That update has to rebuild, not hand over to the app, also if it fails.
    IVE_INSTALL=source
    if ive_app_mac; then
      IVE_APP_POINTER=1
      : >"$IVE_SOURCE_MARKER"
    fi
  fi
fi

if [ "${IVE_INSTALL:-}" != source ] && bash "$IVE_PACKAGE_ROOT/get.sh" --mac-app-check; then
  ive_status=0
  env IVE_INSTALL=app bash "$IVE_PACKAGE_ROOT/get.sh" "$@" || ive_status=$?
  if [ "$ive_status" -ne 0 ]; then exit "$ive_status"; fi
  case " $* " in
    *" --plan "*) exit 0 ;;
  esac
  rm -f "$IVE_SOURCE_MARKER"
  if [ -f "$IVE_STATE/data.db" ]; then
    echo ""
    echo "This folder also has a source build with its own projects and history. The Mac app keeps separate data, and the build stays as it is."
    echo "If it still runs, stop it with: $IVE_HERE/bin/ive stop"
  fi
  exit 0
fi

# tools/ive_team.py leaves the marker after a successful build, so that
# bin/ive and later runs of this script keep this folder on source.
if [ "${IVE_INSTALL:-}" = source ] && ive_app_mac; then
  export IVE_MARK_SOURCE_BUILD=1
fi
source "$IVE_PACKAGE_ROOT/tools/python.sh"
IVE_PY="$(ive_python)"
if [ -z "$IVE_APP_POINTER" ]; then
  exec "$IVE_PY" -I "$IVE_PACKAGE_ROOT/tools/ive_team.py" --root "$IVE_PACKAGE_ROOT" install "$@"
fi
"$IVE_PY" -I "$IVE_PACKAGE_ROOT/tools/ive_team.py" --root "$IVE_PACKAGE_ROOT" install "$@"
echo ""
echo "This folder stays a source build, because it was updated with 'ive update'."
echo "There is a signed Mac app now. To switch to it: IVE_INSTALL=app bash $IVE_HERE/install.sh"
