#!/usr/bin/env bash
# Remove the plugin and the polkit rule it may have installed.
#
#     sudo ./uninstall.sh
#
# Does not touch libfprint. If you also installed the patched library, revert that with
# patches/uninstall-patched-libfprint.sh.
set -euo pipefail

PLUGIN_DIR_NAME="ally-fingerprint"
POLKIT_RULE="/etc/polkit-1/rules.d/49-ally-fingerprint.rules"

[ "$(id -u)" = 0 ] || { echo "!! run me with sudo"; exit 1; }

TARGET_USER="${TARGET_USER:-${SUDO_USER:-}}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = root ]; then
  echo "!! cannot tell which user to uninstall for."
  echo "   Run via sudo from your normal account, or pass TARGET_USER=yourname."
  exit 1
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
DECKY_HOME="${DECKY_HOME:-$TARGET_HOME/homebrew}"
DEST="${DEST_OVERRIDE:-$DECKY_HOME/plugins/$PLUGIN_DIR_NAME}"

if [ -d "$DEST" ]; then
  rm -rf "$DEST"
  echo "removed $DEST"
else
  echo "nothing installed at $DEST"
fi

if [ -f "$POLKIT_RULE" ]; then
  rm -f "$POLKIT_RULE"
  systemctl restart polkit
  echo "removed $POLKIT_RULE"
fi

systemctl restart plugin_loader
echo "plugin_loader restarted"
