#!/usr/bin/env bash
set -euo pipefail
IVE_PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# On a Mac with Apple silicon the signed app from the latest release is the
# way to run IVE, and get.sh installs it. IVE_INSTALL=source builds this
# checkout instead.
if [ "${IVE_INSTALL:-}" != source ] && bash "$IVE_PACKAGE_ROOT/get.sh" --mac-app-check; then
  exec env IVE_INSTALL=app bash "$IVE_PACKAGE_ROOT/get.sh" "$@"
fi
source "$IVE_PACKAGE_ROOT/tools/python.sh"
IVE_PY="$(ive_python)"
exec "$IVE_PY" -I "$IVE_PACKAGE_ROOT/tools/ive_team.py" --root "$IVE_PACKAGE_ROOT" install "$@"
