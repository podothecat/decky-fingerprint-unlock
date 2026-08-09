#!/usr/bin/env bash
# Revert install-patched-libfprint.sh: system fprintd goes back to the stock
# Fedora libfprint in /usr/lib64. Note that prints enrolled while the patched
# library was active will no longer verify -- run `fprintd-delete "$SUDO_USER"`
# and re-enroll if you are staying on stock.
set -euo pipefail

DEST_DIR="/usr/local/lib"
DROPIN="/etc/systemd/system/fprintd.service.d/10-patched-libfprint.conf"

[ "$EUID" -eq 0 ] || { echo "!! run with sudo"; exit 1; }

echo ">>> removing drop-in"
rm -f "$DROPIN"
rmdir --ignore-fail-on-non-empty "$(dirname "$DROPIN")" 2>/dev/null || true

echo ">>> removing patched library"
rm -f "$DEST_DIR/libfprint-2.so.2" "$DEST_DIR/libfprint-2.so.2.0.0"

systemctl daemon-reload
systemctl restart fprintd || true

echo "Reverted to stock libfprint."
