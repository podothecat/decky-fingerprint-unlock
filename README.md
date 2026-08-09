# Fingerprint Unlock

A [Decky](https://decky.xyz) plugin that unlocks Steam's gaming-mode lock screen with the
fingerprint sensor instead of the PIN.

Developed and verified on a **ROG Xbox Ally X** running Bazzite, with an Egis /
LighTuning `1c7a:0588` Match-on-Chip sensor.

**PIN entry is never disabled, patched, or replaced.** The plugin does not read, validate
or reimplement Steam's PIN. If the fingerprint path fails for any reason, the keypad is
still sitting there exactly as it was. That was a hard design constraint throughout — a
fingerprint failure must never lock you out of your own device.

---

## ⚠️ Read this before installing

**This plugin does not work on a stock libfprint.** The sensor needs SDCP, which Fedora's
libfprint does not have; enrollment reports success and then the print is silently lost.
You must build and install a patched libfprint first — see **[`patches/`](patches/)**.

Check whether you are affected:

```bash
strings /usr/lib64/libfprint-2.so.2 | grep -ci sdcp   # 0 means you need the patches
fprintd-enroll && fprintd-verify && fprintd-verify    # 2nd verify fails on stock
```

**This is not a security boundary.** Steam's lock screen validates its PIN with a
plaintext JavaScript string compare against a PIN stored in plaintext in machine storage.
Anything with JS access to `SharedJSContext` can read the PIN or clear the lock outright.
This plugin swaps the auth factor at the same security level; it neither strengthens nor
weakens it. **Do not pair it with TPM2 auto-unlock and call the result secure.**

---

## What works

All three of Steam's lock-screen triggers, verified on real hardware:

| trigger | passes `onSuccess`? | status |
|---|---|---|
| gamepad UI mount (power-on) | no | verified |
| resume from suspend | no | verified, real sleep cycle |
| switch to desktop mode | **yes** | verified — desktop mode actually came up |

The desktop-mode case is the one that needs care: its `onSuccess` performs the switch, so
a match there has to run it *before* clearing the props. Clearing alone would silently
cancel the switch.

## Install

```bash
# 1. the driver (see patches/README.md for the full story)
git clone https://github.com/TenSeventy7/libfprint-egismoc-sdcp ~/libfprint-egismoc-sdcp
cd ~/libfprint-egismoc-sdcp && git apply /path/to/this/patches/000*.patch
cd /path/to/this/patches && ./build.sh && sudo ./install-patched-libfprint.sh

# 2. enroll, as your normal user, NOT root
fprintd-enroll
fprintd-verify   # run twice; the second must still find the print

# 3. the plugin
cd /path/to/this && sudo ./install.sh
```

Then in gaming mode: Decky menu (**…**) → **Fingerprint Unlock**.

The toggle ships **OFF**. Turn it on deliberately, and test with the
**Raise lock screen (escapable)** button first — that test lock screen is cancellable
with B, so a failed test cannot strand you.

Uninstall with `sudo ./uninstall.sh` (and
`sudo patches/uninstall-patched-libfprint.sh` to revert the driver).

## How it behaves at the lock screen

| state | shown as | meaning |
|---|---|---|
| `waiting` | ◉ 지문을 대세요 / Touch the fingerprint sensor | armed |
| `retry` | ✕ 다시 시도하세요 / Not recognised, try again | a scan was rejected; re-arms after 1.2s |
| `success` | ✓ 인증됨 / Verified | matched; unlock is immediate, the message lingers |
| `recovering` | ⋯ 센서 재시도 중 / Sensor hiccup, retrying | transient device error, bounded retry |
| `cooling` | ⧗ 센서 대기 중 N초 / Sensor cooling down, Ns | thermally out of budget, counting down |
| `expired` | ◉ 지문 다시 인식 / Tap to scan again | **a button** — tap to re-arm |
| `unavailable` | — 지문 사용 불가 / Fingerprint unavailable | genuinely unfixable here; use the PIN |

The overlay is rendered into the Deck UI document and localised from the *Steam client's*
language, not the OS locale.

### The sensor cannot stay armed forever

libfprint runs a **software** thermal model — there is no thermometer — and refuses to
operate once its estimate crosses a threshold. Because its thresholds are `1/(e+1)` and
`e/(e+1)`, a cold sensor reaches that point after exactly `temp_hot_seconds` = **180s** of
continuous arming. Measured on this device at 195s.

The plugin therefore *budgets* rather than reacts, because it fundamentally cannot react:
the refusal arrives as a plain `verify-disconnected`, byte-identical to an unplugged
sensor. The "Device disabled to prevent overheating" text exists only in fprintd's journal.

So an untouched lock screen arms for 120s, then stops and offers a **re-arm button**. The
120s cap is not arbitrary — stopping there leaves ~60s of thermal headroom for the
re-arm, and crossing the threshold would latch libfprint HOT until it cooled all the way
back to `0.5`, about 219s of forced idle.

`main.py` mirrors libfprint's model exactly so the countdown is predicted, not guessed.

## Design notes

Longer write-ups live in [`docs/DESIGN.md`](docs/DESIGN.md) (how the lock screen was
reverse engineered, and the approaches that do *not* work) and
[`docs/EVIDENCE.md`](docs/EVIDENCE.md) (measurements).

Three things that look wrong and are not:

**`flags: ["root"]`.** `net.reactivated.fprint.device.verify` is `allow_active=yes` only,
and a systemd service has no logind session, so the backend is refused *whatever uid it
runs as*. This is not fixable by dropping privileges. `install.sh` tests first and only
installs the polkit rule if the test fails — on the development machine it was not needed.

**Detection is a 300ms poll, not an event.** Both nicer approaches are dead ends, verified
live: `SetActiveLockScreenProps` cannot be wrapped (mobx defines it `writable: false,
configurable: false`, so the assignment fails *silently*), and mobx itself is not
reachable for a reaction. Don't "fix" this back into a patch.

**`dist/index.js` is hand written.** There is no node/npm on the development machine. A
built Decky frontend is a single ESM file taking React from `window.SP_REACT`, UI from
`window.DFL`, and the backend bridge from a Decky loader global. Writing it directly skips
the toolchain. If you have node, porting to TSX + `@decky/rollup` is straightforward — the
API surface used is just `callable`, `toaster`, `definePlugin`, and a few `DFL` components.

## Known limitations

1. **Recognition is roughly 4 in 6 on a single touch.** Because the plugin re-arms on
   `no-match`, two touches gets you to ~89%. Usable, not great. Enrollment quality and the
   unvalidated `0588` driver parameters are the suspects; see `patches/README.md`.
2. **The sensor is the power button.** `HandlePowerKey=suspend` means touching it could
   suspend instead. Every verify is wrapped in
   `systemd-inhibit --what=handle-power-key`; eight deliberate presses never suspended
   the machine.
3. **Touch-only re-arm button.** It is deliberately *not* a `DFL.Focusable`: joining
   Steam's gamepad navigation could pull focus off the PIN keypad. A gamepad shortcut via
   `SteamClient.Input.RegisterForControllerInputMessages` is feasible but unverified.
4. **Tested on exactly one device.** Nothing in the plugin is Ally-specific — it shells
   out to `fprintd-verify` — so it should work with any working fprintd setup. Only the
   driver patches are sensor-specific.

## Debugging

```bash
journalctl -u plugin_loader -f
tail -f ~/homebrew/logs/ally-fingerprint/*.log

# CDP into SharedJSContext (Steam runs with --remote-debugging-port=8080)
tools/cdp.py 'window.__allyFP.watcher.lastResult'
tools/cdp.py 'JSON.stringify(window.__allyFP.watcher)'
tools/cdp.py 'window.__allyFP.rearm()'
tools/cdp.py 'window.__allyFP.unlock()'        # force-dismiss if a test ever sticks

tools/measure-verify.sh 6 20 label             # drive the backend, N runs
```

`tools/cdp.py` is stdlib-only. Note it prints **JSON-encoded** output, and that a long
promise returned straight from `Runtime.evaluate` dies with `Promise was collected` —
root it on `window` and poll instead.

## Credits

- [`TenSeventy7/libfprint-egismoc-sdcp`](https://github.com/TenSeventy7/libfprint-egismoc-sdcp)
  for the SDCP implementation this builds on.
- [Bazzite](https://bazzite.gg), which already ships a udev rule for `1c7a:0588`
  (an autosuspend fix). Tracking issue:
  [ublue-os/bazzite#3752](https://github.com/ublue-os/bazzite/issues/3752).

## License

MIT — see [`LICENSE`](LICENSE). **Except `patches/`**, which modifies libfprint and is
therefore LGPL-2.1-or-later.
