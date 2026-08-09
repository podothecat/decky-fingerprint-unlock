#!/usr/bin/env bash
# Point the system fprintd at the SDCP-patched libfprint without touching /usr.
#
#     sudo ./install-patched-libfprint.sh
#
# Why it is done this way rather than just setting LD_LIBRARY_PATH to the build tree:
#   - fprintd.service runs with ProtectHome=true, so it cannot see /home or /var/home
#     at all, whatever the environment says.
#   - SELinux is enforcing on Bazzite, and podman labels build output container_file_t,
#     which fprintd may not load. It needs lib_t.
# So the library is copied to /usr/local/lib -- which is /var/usrlocal on ostree, i.e.
# writable and persistent -- relabelled, and wired up with a systemd drop-in. /usr is
# never modified, so the rpm-ostree deployment stays clean.
#
# Fully reversible: ./uninstall-patched-libfprint.sh
set -euo pipefail

# Where build.sh put the library. Override SRC if you built elsewhere.
BUILD_ROOT="${SRC:-$HOME/libfprint-egismoc-sdcp}"
LIB="$BUILD_ROOT/build/libfprint/libfprint-2.so.2.0.0"
DEST_DIR="/usr/local/lib"
DROPIN_DIR="/etc/systemd/system/fprintd.service.d"
DROPIN="$DROPIN_DIR/10-patched-libfprint.conf"

[ "$EUID" -eq 0 ] || { echo "!! run with sudo"; exit 1; }

# Under sudo, $HOME is usually still the invoking user's, but not always -- be explicit
# if the default guess missed.
if [ ! -f "$LIB" ] && [ -n "${SUDO_USER:-}" ]; then
  ALT_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  ALT="$ALT_HOME/libfprint-egismoc-sdcp/build/libfprint/libfprint-2.so.2.0.0"
  [ -f "$ALT" ] && LIB="$ALT"
fi
[ -f "$LIB" ] || {
  echo "!! patched library not found at $LIB"
  echo "   Run build.sh first, or pass SRC=/path/to/libfprint-egismoc-sdcp."
  exit 1
}

echo ">>> using $LIB"
echo ">>> installing patched libfprint to $DEST_DIR"
install -d -m 0755 "$DEST_DIR"
install -m 0755 "$LIB" "$DEST_DIR/libfprint-2.so.2.0.0"
ln -sf libfprint-2.so.2.0.0 "$DEST_DIR/libfprint-2.so.2"

echo ">>> fixing SELinux label"
restorecon -Rv "$DEST_DIR" || true
# restorecon may leave usr_t depending on the local file_contexts; fprintd needs lib_t.
if command -v ls >/dev/null && ! ls -Z "$DEST_DIR/libfprint-2.so.2.0.0" | grep -q ':lib_t:'; then
  echo "    restorecon did not yield lib_t, forcing it"
  chcon -t lib_t "$DEST_DIR/libfprint-2.so.2.0.0" || true
fi
ls -Z "$DEST_DIR/libfprint-2.so.2.0.0" || true

echo ">>> writing systemd drop-in $DROPIN"
install -d -m 0755 "$DROPIN_DIR"
cat > "$DROPIN" <<'EOF'
[Service]
Environment=LD_LIBRARY_PATH=/usr/local/lib
EOF

systemctl daemon-reload
systemctl restart fprintd

echo ">>> verifying which library fprintd actually loaded"
sleep 1
FPID="$(systemctl show -p MainPID --value fprintd)"
if [ "$FPID" != "0" ] && [ -n "$FPID" ]; then
  grep -o '/[^ ]*libfprint-2\.so[^ ]*' "/proc/$FPID/maps" | sort -u || true
else
  echo "    fprintd is idle (D-Bus activated); it will pick up the drop-in on next use."
fi

cat <<'EOF'

Done. Now test as your NORMAL user, not root:

  fprintd-delete "$USER"   # only if you enrolled against a different libfprint build
  fprintd-enroll
  fprintd-verify           # run this TWICE

Success = the second verify still finds the print.

Changing libfprint versions invalidates prints already stored on the chip, so if verify
starts failing after an update, delete and re-enroll before debugging anything else.

To undo: sudo ./uninstall-patched-libfprint.sh
EOF
