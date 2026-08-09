#!/usr/bin/env bash
# Build an SDCP-capable libfprint with the patches in this directory applied.
#
#     ./build.sh
#
# Resumable on purpose: it uses a *named, persistent* podman container, so an
# interrupted dnf download picks up where it left off instead of re-fetching ~133 MiB.
#
# Output lands in $SRC/build/libfprint/libfprint-2.so.2.0.0. Nothing on the system is
# touched -- install-patched-libfprint.sh is a separate, reversible step.
set -euo pipefail

HERE="$(dirname "$(realpath "$0")")"
# Where the libfprint-egismoc-sdcp checkout lives. Override if you keep it elsewhere.
SRC="${SRC:-$HOME/libfprint-egismoc-sdcp}"
CTR="${CTR:-fpbuild}"
FORK_URL="https://github.com/TenSeventy7/libfprint-egismoc-sdcp"

DEPS="meson ninja-build gcc gcc-c++ pkgconf-pkg-config glib2-devel
      libgusb-devel openssl-devel cairo-devel pixman-devel libgudev-devel
      systemd-devel"

if [ ! -d "$SRC" ]; then
  cat <<EOF
!! No source tree at $SRC

   Clone the SDCP fork first, then re-run:
       git clone $FORK_URL "$SRC"
       cd "$SRC" && git apply $HERE/0001-*.patch $HERE/0002-*.patch

   Or set SRC=/path/to/your/checkout.
EOF
  exit 1
fi

if ! command -v podman >/dev/null; then
  echo "!! podman not found. It is used so the build deps never touch the host,"
  echo "   which matters on an ostree system like Bazzite."
  exit 1
fi

echo ">>> checking the patches are applied"
missing=0
for p in "$HERE"/0001-*.patch "$HERE"/0002-*.patch; do
  # --reverse --check succeeds only when the patch is ALREADY applied.
  if git -C "$SRC" apply --reverse --check "$p" 2>/dev/null; then
    echo "    applied: $(basename "$p")"
  else
    echo "    MISSING: $(basename "$p")"
    missing=1
  fi
done
if [ "$missing" = 1 ]; then
  echo
  echo "!! apply them first:  cd $SRC && git apply $HERE/000*.patch"
  exit 1
fi

if ! podman container exists "$CTR"; then
  echo ">>> creating persistent build container '$CTR'"
  podman create --name "$CTR" -v "$SRC":/src:Z -w /src fedora:43 sleep infinity
fi
podman start "$CTR" >/dev/null

# keepcache=True means a re-run after a dropped connection reuses the RPMs already on
# disk instead of downloading everything again.
echo ">>> installing build deps (resumable)"
podman exec "$CTR" bash -c "echo keepcache=True >> /etc/dnf/dnf.conf 2>/dev/null; true"
# shellcheck disable=SC2086
podman exec "$CTR" dnf -y install $DEPS

echo ">>> configuring (no network needed from here on)"
podman exec "$CTR" bash -c '
  rm -rf /src/build
  meson setup /src/build /src \
    -Ddrivers=egismoc -Dintrospection=false -Ddoc=false \
    -Dgtk-examples=false -Dudev_rules=disabled -Dudev_hwdb=disabled'

echo ">>> compiling"
podman exec "$CTR" ninja -C /src/build

echo ">>> artifacts"
ls -la "$SRC/build/libfprint/libfprint-2.so."* "$SRC/build/examples/enroll" "$SRC/build/examples/verify"

cat <<EOF

Done. Sanity-check the build before installing it:

  strings $SRC/build/libfprint/libfprint-2.so.2.0.0 | grep -ci sdcp   # expect >0
  $SRC/build/fprint-list-supported-devices | grep 1c7a                # expect your pid

Then test it WITHOUT touching the system (examples carry an rpath, so no
LD_LIBRARY_PATH is needed):

  cd $SRC/build
  sudo systemctl stop fprintd                                  # release the USB device
  printf '6\\nn\\n' | sudo systemd-inhibit --what=handle-power-key ./examples/enroll
  echo 6 | sudo ./examples/verify                              # run this TWICE

'6' is right-index in the finger menu. systemd-inhibit stops the sensor -- which is also
the power button -- from suspending the machine mid-enroll.

Success = the SECOND verify still finds the print. That is the whole point: without
SDCP the print never persists, and the second run dies with NoEnrolledPrints.

To make the system fprintd use it:  sudo ./install-patched-libfprint.sh
EOF
