"""Ally Fingerprint Unlock -- Decky backend.

Drives fprintd on behalf of the frontend. The frontend owns the policy ("the lock
screen is up, so ask for a finger"); this side only ever answers a single question:
did the finger that was just presented match an enrolled print?

Deliberately does NOT touch Steam's PIN. On any failure we return a result and do
nothing else, so the PIN keypad stays usable. A broken fingerprint path must never
lock the user out.
"""

import asyncio
import math
import os
import re
import shutil
import time

import decky

# fprintd-list indents its entries, e.g. " - #0: right-index-finger". Match the whole
# text rather than anchoring on a line prefix -- that is what got this wrong first time.
PRINT_RE = re.compile(r"#\d+:\s*(\S+)")

# Must stay UNDER the driver's own wait-for-finger ceiling, which is 60s:
#
#   egismoc.h:49   #define EGISMOC_USB_INTERRUPT_TIMEOUT 60000
#
# egismoc_wait_finger_run_state submits one USB interrupt transfer and blocks on it. If
# no finger arrives the transfer errors out with "transfer timed out", fprintd reports
# verify-unknown-error, and we classify that as device-error -- which the frontend treats
# as unrecoverable, so the lock screen goes permanently "Fingerprint unavailable". Every
# untouched lock screen hit this at ~60s; measured twice on 2026-08-09 (08:52 and 09:39),
# both ~60-70s after fprintd started.
#
# So the plugin's own timeout has to fire first. `timeout` is a *retryable* result -- the
# watcher re-arms on it -- so a 45s window turns an untouched lock screen into a quiet
# verify/re-arm cycle instead of a dead end. 15s of headroom under the driver's 60s.
#
# This reverses an earlier 20 -> 300 change, and the reason it is now safe to reverse:
# that change existed because killing fprintd-verify used to corrupt fprintd (the next
# claim died with "NoReply: Remote peer disconnected", and in that broken state a no-touch
# verify was once seen returning an instant match). That was the dangling task_ssm bug,
# fixed by driver patch 0002 and re-confirmed on 2026-08-09: six consecutive killed
# verifies, NRestarts=0, zero core dumps. Do not raise this above 60 again.
VERIFY_TIMEOUT_S = 45

# After a kill, give fprintd a moment to notice and drop the claim before anyone
# re-claims. Without this the next attempt reliably eats the NoReply above.
SETTLE_AFTER_KILL_S = 1.5

# ---- libfprint's thermal model, mirrored -------------------------------------
#
# There is no thermometer in this sensor. libfprint estimates temperature with a pure
# software model (fpi_device_update_temp, fpi-device.c:2196) and refuses to operate once
# its own estimate crosses a threshold. We cannot react to that: the refusal reaches us
# as a plain verify-disconnected, byte-identical to an unplugged sensor -- the
# "Device disabled to prevent overheating" text exists only in fprintd's journal. So the
# only option is to *predict* it and stop arming first.
#
# These are libfprint's constants, read out of the source we build, not tuning knobs:
#   fp-device-private.h:29   TEMP_COLD_THRESH = 1/(e+1)
#   fp-device-private.h:39   DEFAULT_TEMP_HOT_SECONDS  = 3*60
#   fp-device-private.h:40   DEFAULT_TEMP_COLD_SECONDS = 9*60
#   fp-device.c:204          the model starts at TEMP_COLD_THRESH
#   egismoc.c:1985           sets temp_hot_seconds = 0, which fp-device.c:184-188 maps
#                            onto the defaults above (0 means "default", NOT "disabled")
TEMP_COLD_THRESH = 0.26894142136999512075
TEMP_WARM_HOT_THRESH = 1.0 - TEMP_COLD_THRESH  # refuses at or above this ratio
TEMP_HOT_SECONDS = 3 * 60
TEMP_COLD_SECONDS = 9 * 60

# Because the two thresholds are 1/(e+1) and e/(e+1), the ratio crosses from a cold start
# in exactly TEMP_HOT_SECONDS. So a cold sensor affords 180s of continuous arming, and
# that is the entire budget the re-arm button is spending.
#
# Staying under the threshold matters more than it looks. Once libfprint actually goes
# HOT it applies hysteresis and stays HOT until it has cooled all the way back to 0.5
# (fpi-device.c:2223), which costs ~219s of forced idle. Stopping just short costs
# seconds instead. Never trip it.
THERMAL_MARGIN_S = 5.0

# Do not bother claiming the device for a window too short to land a touch in.
MIN_ARM_S = 10.0

# How much arm time to wait for before offering an immediate re-arm. Enough for a couple
# of attempts, not so much that the user waits out a long countdown for no reason.
REARM_ARM_S = 20.0

# The sensor IS the power button, and /etc/systemd/logind.conf.d/deck.conf sets
# HandlePowerKey=suspend. Without an inhibitor, touching the sensor to unlock can
# suspend the machine instead. Same trick that made enrollment survive.
INHIBIT_ARGS = [
    "systemd-inhibit",
    "--what=handle-power-key",
    "--who=ally-fingerprint",
    "--why=fingerprint unlock in progress",
    "--mode=block",
]


def _child_env() -> dict:
    """Undo PyInstaller's loader pollution before spawning system binaries.

    plugin_loader is a PyInstaller bundle, so it puts its own extraction directory on
    LD_LIBRARY_PATH. Children inherit it and pick up the bundled libcrypto, which is
    older than the system one -- observed as:

        systemd-inhibit: /tmp/_MEIxxxxx/libcrypto.so.3: version `OPENSSL_3.4.0'
        not found (required by /usr/lib64/systemd/libsystemd-shared-...so)

    PyInstaller stashes the real value in *_ORIG, so restore that when present and
    otherwise drop the variable entirely.
    """
    env = dict(os.environ)
    for var in ("LD_LIBRARY_PATH", "LD_PRELOAD"):
        original = env.pop(var + "_ORIG", None)
        if original:
            env[var] = original
        else:
            env.pop(var, None)
    return env


def _target_user() -> str:
    """The user whose prints we verify against. Prints are per-identity on the chip."""
    user = os.environ.get("DECKY_USER")
    if user:
        return user
    home = os.environ.get("DECKY_USER_HOME", "").rstrip("/")
    return os.path.basename(home) or "deck"


def _classify(text: str) -> str:
    """Map fprintd-verify chatter onto a small closed set the frontend can switch on."""
    if "verify-match" in text:
        return "match"
    if "verify-no-match" in text:
        return "no-match"
    if "NoEnrolledPrints" in text or "Failed to discover prints" in text:
        return "no-prints"
    if "PermissionDenied" in text or "Not Authorized" in text:
        return "denied"
    if "verify-unknown-error" in text or "verify-disconnected" in text:
        return "device-error"
    if "No devices available" in text:
        return "no-device"
    return "unknown"


class Plugin:
    async def _main(self):
        self._proc = None
        self._user = _target_user()
        self._lock = asyncio.Lock()
        self._cancelled = False
        # Mirror of libfprint's temperature estimate. Starts cold, like fp-device.c:204.
        # This is our own copy of a value that really lives inside fprintd, so it can
        # drift -- see _temp_settle for which way it drifts and why that is survivable.
        self._temp_ratio = TEMP_COLD_THRESH
        self._temp_t = time.monotonic()
        self._temp_active = False
        decky.logger.info("ally-fingerprint: backend up, verifying as %r", self._user)
        if os.environ.get("LD_LIBRARY_PATH"):
            decky.logger.info(
                "ally-fingerprint: stripping inherited LD_LIBRARY_PATH=%r from children",
                os.environ["LD_LIBRARY_PATH"],
            )

    async def _unload(self):
        await self.cancel()
        decky.logger.info("ally-fingerprint: backend down")

    async def _uninstall(self):
        pass

    # ---- the thermal budget ------------------------------------------------------

    def _temp_at(self, now: float) -> float:
        """The estimated ratio at `now`, without committing it. Same maths as libfprint:
        exponential approach to 1 while active, exponential decay to 0 while idle."""
        dt = max(0.0, now - self._temp_t)
        if self._temp_active:
            alpha = math.exp(-dt / TEMP_HOT_SECONDS)
            return alpha * self._temp_ratio + 1.0 - alpha
        alpha = math.exp(-dt / TEMP_COLD_SECONDS)
        return alpha * self._temp_ratio

    def _temp_settle(self, now_active: bool) -> None:
        """Account for the elapsed period under the *old* active flag, then switch.

        Drift against fprintd's real model is bounded and one-directional in the way that
        matters. We count the whole subprocess lifetime as active, while libfprint only
        counts from device open, so we over-estimate heat and stop early -- the safe
        direction. The one way we under-estimate is fprintd exiting on its idle timeout,
        which destroys the FpDevice and resets its model to cold while ours stays warm;
        that only costs the user an unnecessary wait, never an overheat.
        """
        now = time.monotonic()
        self._temp_ratio = self._temp_at(now)
        self._temp_t = now
        self._temp_active = now_active

    def _arm_seconds(self) -> float:
        """Seconds of continuous arming left before libfprint would refuse.

        Inverts the active branch: solving 1-(1-r)e^(-t/H) = HOT for t gives
        t = H * ln((1-r)/(1-HOT)), and 1-HOT is exactly TEMP_COLD_THRESH.
        """
        ratio = self._temp_at(time.monotonic())
        if ratio >= TEMP_WARM_HOT_THRESH:
            return 0.0
        return TEMP_HOT_SECONDS * math.log((1.0 - ratio) / TEMP_COLD_THRESH)

    def _cool_seconds(self, want_s: float) -> float:
        """Idle seconds until `want_s` of arming becomes available. Inverts the idle
        branch the same way: t = C * ln(r / r_target)."""
        target = 1.0 - TEMP_COLD_THRESH * math.exp(want_s / TEMP_HOT_SECONDS)
        ratio = self._temp_at(time.monotonic())
        if target <= 0.0:
            # Asking for more than a cold sensor could ever give (>~236s).
            return float("inf")
        if ratio <= target:
            return 0.0
        return TEMP_COLD_SECONDS * math.log(ratio / target)

    def _budget(self) -> dict:
        """What the frontend needs to decide between arming, waiting, and offering a
        re-arm button."""
        arm = self._arm_seconds()
        return {
            "arm_s": round(max(0.0, arm - THERMAL_MARGIN_S), 1),
            "cool_s": math.ceil(self._cool_seconds(REARM_ARM_S)),
            "ratio": round(self._temp_at(time.monotonic()), 4),
        }

    async def budget(self) -> dict:
        """Exposed so the lock screen can show a countdown instead of a dead end."""
        return self._budget()

    # ---- exposed to the frontend -------------------------------------------------

    async def status(self) -> dict:
        """Enough to render a diagnostic panel without guessing."""
        out = {
            "user": self._user,
            "has_fprintd_verify": shutil.which("fprintd-verify") is not None,
            "has_inhibit": shutil.which("systemd-inhibit") is not None,
            "busy": self._proc is not None,
        }
        listed = await self._run(["fprintd-list", self._user], timeout_s=10)
        out["list_text"] = listed["text"]
        out["prints"] = PRINT_RE.findall(listed["text"])
        out["enrolled"] = len(out["prints"])
        if not out["prints"]:
            out["list_problem"] = _classify(listed["text"])
        out["budget"] = self._budget()
        return out

    async def verify(self, timeout_s: int = VERIFY_TIMEOUT_S) -> dict:
        """One bounded verify attempt. Never raises; always returns a result dict."""
        if self._lock.locked():
            return {"result": "busy", "detail": "another verify is in flight"}
        async with self._lock:
            self._cancelled = False

            # Three ceilings apply, and the smallest wins: what the caller asked for,
            # our own limit under the driver's 60s USB interrupt ceiling, and whatever
            # the thermal model still affords. Clamping here rather than in the frontend
            # keeps VERIFY_TIMEOUT_S the single source of truth for the driver limit.
            budget = self._budget()
            window = min(float(timeout_s), float(VERIFY_TIMEOUT_S), budget["arm_s"])
            if window < MIN_ARM_S:
                # Refusing to arm is the whole point: a claim now would be cancelled
                # mid-scan as FP_DEVICE_ERROR_TOO_HOT, which reaches us indistinguishable
                # from a dead sensor. Report the wait instead so the lock screen can
                # count it down.
                decky.logger.info(
                    "ally-fingerprint: not arming, thermal budget %.1fs, cool %ss",
                    budget["arm_s"], budget["cool_s"],
                )
                return {"result": "too-hot", "budget": budget, "detail": "thermal budget exhausted"}

            verify_argv = ["fprintd-verify", self._user]
            use_inhibit = shutil.which("systemd-inhibit") is not None
            argv = (INHIBIT_ARGS + verify_argv) if use_inhibit else verify_argv
            self._temp_settle(True)
            try:
                run = await self._run(argv, timeout_s=window, track=True)

                # If the inhibitor itself failed to start, that is our problem, not the
                # sensor's. Retry bare rather than reporting a fingerprint failure --
                # worst case the power key is live for one attempt, which beats no
                # unlock at all.
                if use_inhibit and not run["timed_out"] and run["text"].startswith("systemd-inhibit:"):
                    decky.logger.warning(
                        "ally-fingerprint: systemd-inhibit unusable, retrying without it: %s",
                        run["text"].strip(),
                    )
                    run = await self._run(verify_argv, timeout_s=window, track=True)
            finally:
                self._temp_settle(False)

            # A killed process leaves partial output ("Using device ...") that classifies
            # as "unknown", which would look like a device fault. It is not: we killed it
            # because the lock screen went away. Say so, or every PIN unlock leaves a
            # bogus failure behind.
            if self._cancelled:
                result = "cancelled"
            elif run["timed_out"]:
                result = "timeout"
            else:
                result = _classify(run["text"])
            if result == "match":
                # A fingerprint opening the device is the one event here that matters
                # after the fact. Leave a trace: without this a successful unlock is
                # invisible in the journal, which makes "did it really unlock by
                # fingerprint?" unanswerable later.
                decky.logger.info("ally-fingerprint: verify -> MATCH for %r", self._user)
            elif result not in ("no-match", "cancelled"):
                decky.logger.info("ally-fingerprint: verify -> %s: %s", result, run["text"].strip())
            return {
                "result": result,
                "detail": run["text"].strip()[-600:],
                "code": run["code"],
                "budget": self._budget(),
            }

    async def cancel(self) -> dict:
        """Kill an in-flight verify -- called when the lock screen goes away."""
        proc = self._proc
        if proc is None:
            return {"cancelled": False}
        self._cancelled = True
        try:
            # SIGTERM first: fprintd-verify handles it and releases the claim properly.
            # SIGKILL is what leaves fprintd wedged, so it is only ever the last resort.
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        except ProcessLookupError:
            pass
        await asyncio.sleep(SETTLE_AFTER_KILL_S)
        return {"cancelled": True}

    # ---- plumbing ---------------------------------------------------------------

    async def _run(self, argv: list, timeout_s: int, track: bool = False) -> dict:
        """Run argv, merge stderr into stdout, never let an exception escape."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=_child_env(),
            )
        except (FileNotFoundError, PermissionError) as exc:
            return {"text": f"{argv[0]}: {exc}", "code": None, "timed_out": False}

        if track:
            self._proc = proc
        timed_out = False
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            timed_out = True
            out = b""
            try:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            except ProcessLookupError:
                pass
            await asyncio.sleep(SETTLE_AFTER_KILL_S)
        finally:
            if track:
                self._proc = None
        return {
            "text": out.decode("utf-8", errors="replace"),
            "code": proc.returncode,
            "timed_out": timed_out,
        }
