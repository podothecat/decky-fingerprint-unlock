# libfprint patches

The plugin in the parent directory is useless without these. On a stock libfprint the
sensor enrolls, reports success, and then loses the print — the second `fprintd-verify`
dies with `NoEnrolledPrints: Failed to discover prints`.

## License

**These patches are LGPL-2.1-or-later**, not MIT. They are modifications to
[libfprint](https://gitlab.freedesktop.org/libfprint/libfprint) and so are derivative
works of it, whatever the rest of this repository is licensed as. See `../LICENSE`.

## Why a patched libfprint is needed at all

The sensor is an Egis / LighTuning **ETU905A86-E** (`1c7a:0588`), Match-on-Chip. Its
firmware requires **SDCP** (Secure Device Connection Protocol). Two code bases each have
exactly half of what is needed:

| | supports `0588` | supports SDCP |
|---|---|---|
| upstream libfprint 1.94.10 | yes | **no** |
| [`TenSeventy7/libfprint-egismoc-sdcp`](https://github.com/TenSeventy7/libfprint-egismoc-sdcp) | **no** | yes |

Confirm your system lacks SDCP with:

```bash
strings /usr/lib64/libfprint-2.so.2 | grep -ci sdcp    # 0 on stock Fedora
```

So the fix is to add `0588` to the SDCP fork. That is patch 0001.

## The patches

### `0001-egismoc-add-0588-and-fix-openssl-link.patch`

Two changes, both against the SDCP fork:

1. **Adds `1c7a:0588` to `egismoc_id_table`.** Upstream's parameters for `0588` are
   identical to `0587`, which the fork already has, so this is a one-line entry.

   Caveat worth knowing: **upstream's `0588` entry was never validated.** Upstream has no
   SDCP, so enrollment on this sensor could never have completed there — its
   `TYPE1 | STAGES_20` values are themselves probably copied from `0587`. They work, but
   if you are chasing recognition quality, they are a legitimate suspect. The knobs are
   `MAX_ENROLL_STAGES_15`, the default 10, and `CHECK_PREFIX_TYPE2`.

2. **`meson.build`: link OpenSSL unconditionally.** A fork bug. `openssl_dep` is only
   added through the per-driver helper mapping, so building a restricted driver set
   (`-Ddrivers=egismoc`) fails to link with undefined `EVP_MAC_*` in `fpi-sdcp-device.c`
   — which is SDCP *core* and always needs it.

### `0002-egismoc-fix-daemon-abort-on-cancelled-verify.patch`

**An upstream libfprint bug, not a fork regression.** `egismoc_open`, `egismoc_cancel`,
`egismoc_close` and `egismoc_suspend` are byte-identical between libfprint 1.94.10 and
the fork, so any egismoc device is affected.

Aborting a verify kills the whole fprintd daemon:

```
libfprint-egismoc:ERROR:../libfprint/drivers/egismoc/egismoc.c:1908:egismoc_open:
assertion failed: (self->task_ssm == NULL)
fprintd.service: Main process exited, code=dumped, status=6/ABRT
```

In `*_WAIT_FINGER` the parent `task_ssm` is *parked*, waiting for the wait-finger SSM to
call `fpi_ssm_next_state()` on it. If that SSM fails instead,
`egismoc_wait_finger_ssm_done()` reports the action error directly and never touches the
parent — so `self->task_ssm` stays set and the next `egismoc_open()` trips the assertion.
`egismoc_close()` does not clear it either, so nothing recovers in-process.

The symptom is deceptive: the *next* claim gets a freshly D-Bus-activated fprintd and
succeeds, so failures alternate perfectly and read as flaky hardware rather than a crash.

Measured before and after, six consecutive deliberately-aborted verifies:

| | before | after |
|---|---|---|
| results | alternating `timeout` / `NoReply` claim failure | **6/6 clean** |
| core dumps | one per abort | **0** |
| fprintd | repeatedly `failed (core-dump)` | `active`, `NRestarts=0` |

## Applying them

```bash
git clone https://github.com/TenSeventy7/libfprint-egismoc-sdcp ~/libfprint-egismoc-sdcp
cd ~/libfprint-egismoc-sdcp
git apply /path/to/patches/0001-*.patch /path/to/patches/0002-*.patch
```

Then, from this directory:

```bash
./build.sh                          # podman, resumable, does not touch the host
sudo ./install-patched-libfprint.sh # copies to /usr/local/lib, /usr untouched
```

`build.sh` refuses to run unless both patches are already applied, and prints how to
apply them if not. Both scripts take `SRC=/path/to/checkout` if you cloned elsewhere.

To revert completely: `sudo ./uninstall-patched-libfprint.sh`.

## Known remaining driver bug (not patched here)

`EGISMOC_USB_INTERRUPT_TIMEOUT` is 60000 (`egismoc.h:49`), and
`egismoc_wait_finger_run_state` submits **one** USB interrupt transfer and blocks on it.
This sensor stays silent rather than returning a non-finger response, so the transfer
simply times out at 60s and the SSM fails — surfacing as `verify-unknown-error`. Any
wait-for-finger longer than 60s is therefore guaranteed to fail.

The proper fix is for `egismoc_finger_on_sensor_cb` to treat an interrupt timeout as
"resubmit" rather than "fail". This repo works around it instead, by keeping every verify
window under 60s (`VERIFY_TIMEOUT_S = 45` in `../main.py`) and re-arming.
