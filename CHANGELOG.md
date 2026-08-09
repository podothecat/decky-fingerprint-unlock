# Changelog

## 1.0.0 — 2026-08-09

First public release. Verified end to end on a ROG Xbox Ally X (`1c7a:0588`) running
Bazzite.

### Unlocking

- Unlock Steam's gaming-mode lock screen with the fingerprint sensor. All three of
  Steam's lock triggers work: power-on, resume from suspend, and switch to desktop mode.
- PIN entry is never disabled, patched or replaced. Every failure path falls back to the
  keypad untouched.
- The desktop-mode trigger's `onSuccess` is run before the props are cleared, so the
  switch actually happens rather than being silently cancelled.

### Lock-screen feedback

- On-screen indicator localised from the *Steam client's* language rather than the OS
  locale, positioned off the PIN-dot rect.
- States: waiting, retry, recovering, cooling, expired, unavailable, success.
- **Re-arm button.** When the arm window ends, the lock screen offers a tappable
  `지문 다시 인식` button instead of a dead "Fingerprint unavailable" message. Touch-only
  by design — it never joins Steam's gamepad focus tree, so it cannot take focus from the
  PIN keypad.
- `unavailable` is now shown only when a re-arm genuinely cannot help (`no-prints`,
  `denied`, `no-device`).
- Success message survives the unlock. The unlock is immediate; the confirmation is
  frozen in place, given its own backdrop, held, and faded out.

### Thermal budgeting

- Mirrors libfprint's software thermal model exactly, so the plugin stops arming *before*
  the driver refuses. Necessary because the refusal is indistinguishable from an
  unplugged sensor at the fprintd interface.
- 120s arm budget per lock screen, leaving headroom for a re-arm and never latching the
  driver into its ~219s HOT hysteresis.
- Predicted cooldown shown as a live countdown rather than a button that would fail
  instantly.

### Driver patches (`patches/`, LGPL-2.1-or-later)

- Add `1c7a:0588` to the egismoc SDCP fork, and link OpenSSL unconditionally so a
  restricted driver build (`-Ddrivers=egismoc`) links.
- **Fix an upstream libfprint bug**: an aborted or timed-out verify left `task_ssm`
  parked, so the next `egismoc_open()` aborted the entire fprintd daemon on a `g_assert`.
  Affects any egismoc device, not just this fork. Six consecutive aborted verifies now
  produce zero core dumps where every other one previously killed the daemon.

### Known limitations

- Single-touch recognition is roughly 67%; the re-arm loop makes two touches ~89%.
- The 60s USB interrupt ceiling in the driver is worked around, not fixed.
- Not a security boundary — Steam's PIN is a plaintext JS string compare.
