#!/usr/bin/env bash
# Install the Fingerprint Unlock Decky plugin.
#
#     sudo ./install.sh
#
# Needs root: the Decky plugin directory is root-owned and plugin_loader.service has to
# be restarted to pick up a new plugin. Idempotent. Undo with ./uninstall.sh.
#
# This does NOT install the patched libfprint the sensor needs. See patches/README.md --
# on a stock libfprint the plugin loads fine and then never gets a usable print.
set -euo pipefail

SRC="$(dirname "$(realpath "$0")")"
PLUGIN_DIR_NAME="ally-fingerprint"
POLKIT_RULE="/etc/polkit-1/rules.d/49-ally-fingerprint.rules"

[ "$(id -u)" = 0 ] || { echo "!! run me with sudo"; exit 1; }

# Whose prints do we verify against, and whose Decky install do we write to? Derived
# rather than hardcoded: prints are stored per-identity on the chip, so guessing wrong
# means the plugin looks broken. SUDO_USER is the person who typed sudo.
TARGET_USER="${TARGET_USER:-${SUDO_USER:-}}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = root ]; then
  echo "!! cannot tell which user to install for."
  echo "   Run via sudo from your normal account, or pass TARGET_USER=yourname."
  exit 1
fi

TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$TARGET_HOME" ] || { echo "!! no home directory for user '$TARGET_USER'"; exit 1; }

DECKY_HOME="${DECKY_HOME:-$TARGET_HOME/homebrew}"
DEST="${DEST_OVERRIDE:-$DECKY_HOME/plugins/$PLUGIN_DIR_NAME}"

if [ ! -d "$DECKY_HOME/plugins" ]; then
  echo "!! no Decky plugins directory at $DECKY_HOME/plugins"
  echo "   Is Decky Loader installed? Override with DECKY_HOME=/path/to/homebrew."
  exit 1
fi

echo "== user   : $TARGET_USER"
echo "== decky  : $DECKY_HOME"
echo "== installing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/plugin.json" "$SRC/package.json" "$SRC/main.py" "$SRC/dist" "$DEST/"
chown -R root:root "$DEST"
find "$DEST" -type d -exec chmod 755 {} +
find "$DEST" -type f -exec chmod 644 {} +

# fprintd access. Test before changing policy, so we never loosen anything we did not
# have to -- see the comment block in the rules file for why root can still be refused.
echo
echo "== checking whether root may talk to fprintd"
if fprintd-list "$TARGET_USER" 2>&1 | grep -q "PermissionDenied\|Not Authorized"; then
  echo "   refused by polkit -> installing $POLKIT_RULE"
  install -m 644 -o root -g root "$SRC/49-ally-fingerprint.rules" "$POLKIT_RULE"
  systemctl restart polkit
  sleep 1
  if fprintd-list "$TARGET_USER" 2>&1 | grep -q "PermissionDenied\|Not Authorized"; then
    echo "   !! STILL refused. The plugin will report result=denied and fall back to PIN."
    echo "      Investigate before blaming the sensor."
  else
    echo "   ok, root can now verify"
  fi
else
  echo "   already permitted, no polkit change made"
fi

echo
echo "== enrolled prints for $TARGET_USER"
fprintd-list "$TARGET_USER" 2>&1 | sed 's/^/   /'

echo
echo "== restarting plugin_loader"
systemctl restart plugin_loader
sleep 2
systemctl is-active plugin_loader | sed 's/^/   plugin_loader: /'

cat <<'EOF'

Done. Next, in this order -- each step de-risks the one after it:
  1. Gaming mode -> Decky menu (...) -> "Fingerprint Unlock".
     Status panel: "Enrolled prints" must be >= 1. If it says denied, the polkit rule
     did not take.
  2. Turn the "Fingerprint unlock" toggle ON. It ships OFF deliberately.
  3. Press "Raise lock screen (escapable)" and touch the sensor. That test lock screen
     is cancellable with B, so a failure cannot strand you.
  4. Only then the real path: suspend, wake, touch the sensor.

Note that restarting plugin_loader reloads the Steam UI, which re-fires the lock-screen
trigger -- so you will probably be looking at a lock screen right now. That is expected.

Logs:
  journalctl -u plugin_loader -f
  ~/homebrew/logs/ally-fingerprint/
EOF
