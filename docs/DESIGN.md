# Design notes

Why this plugin has the shape it does, and — more usefully — which better-looking
approaches were tried against the live system and turned out to be dead ends.

## Steam's lock screen, reverse engineered

Everything lives in the Steam UI JS bundle, webpack module `56970` inside
`~/.steam/steam/steamui/chunk~*.js`, exposed as globals in **`SharedJSContext` only**.
They are `undefined` in the `Steam Big Picture 모드`, `MainMenu_uid2` and
`QuickAccess_uid2` targets. That is exactly the context Decky plugins run in.

| what | how |
|---|---|
| settings store | `window.securitystore` — `GetSettings()` / `SetSettings()`, persisted under machine-storage key `LockScreenSettings` |
| settings shape | `{version, bLockOnWake, bLockDesktopMode, strPIN, strOwnerAccountName, bUserForgotPin, bShowResetPinModal}` |
| **detect** | `securitystore.IsLockScreenActive()` / `GetActiveLockScreenProps()`, plus `SteamUIStore.GetShowingLockScreen()` |
| **dismiss** | `securitystore.SetActiveLockScreenProps(null)` |
| raise | `securitystore.SetActiveLockScreenProps({preventCancel, preventSteamButtons, onSuccess, ...})` |

Verified live:

```js
securitystore.SetActiveLockScreenProps({preventCancel:true, preventSteamButtons:true})
// -> active:true, showing:true   (lock screen renders)
securitystore.SetActiveLockScreenProps(null)
// -> active:false, showing:false (lock screen gone)
```

Dismissal works even against `preventCancel:true`, because the guard is
`e && IsLockScreenActive() && props.preventCancel || (assign)` — a `null` argument
short-circuits it and always assigns.

### The three trigger sites, and why this simplifies everything

| trigger | call |
|---|---|
| gamepad UI mount (power-on) | `bLockOnWake && Di({preventCancel:true, preventSteamButtons:true})` |
| `OnSystemResumedFromSuspend` | `bLockOnWake && Di({preventCancel:true, preventSteamButtons:true})` |
| switch to desktop mode | `bLockDesktopMode ? Di({preventCancel:false, onSuccess:()=>U(t)}) : U(t)` |

`Di` is `securitystore.SetActiveLockScreenProps`.

**The two triggers that matter most — power-on and wake — pass no `onSuccess`.** Unlocking
there is nothing more than clearing the props. So a fingerprint match never touches, reads
or reimplements PIN validation.

Desktop-mode switch is the exception: its `onSuccess` performs the switch, so a match must
call `GetActiveLockScreenProps()?.onSuccess?.()` *before* clearing. Clearing alone would
merely cancel the switch.

**Corollary that shaped the whole scope:** Steam already decides *when* to lock — wake,
boot, login, desktop switch. So this plugin never implements lock triggering. No VT-switch
lock, no resume hook, no standalone overlay.

## Dead ends — do not retry these

**Wrapping `securitystore.SetActiveLockScreenProps` is impossible.** mobx's
`makeAutoObservable` defines it as an own property with `writable: false,
configurable: false`, so the assignment fails **silently** in non-strict mode. Verified
empirically: the wrapper installed without error and was then never invoked once across a
raise + dismiss cycle. The prototype does carry a configurable getter, but the own
property shadows it, so patching there has no effect on the instance either.

**A mobx reaction is not available.** mobx is not a window global, and `DFL.findModule` /
`DFL.findModuleExport` cannot locate `autorun` / `reaction`.

Hence the 300ms poll. The latency is irrelevant next to the ~1s fprintd needs to claim the
device, and polling also handles the normal power-on ordering, where the lock screen is
already up before the plugin finishes loading.

**`SteamClient.Auth.ValidateCachedSignInPin` is not the lock screen.** It belongs to the
*login* PIN prompt — 4 digits, `#Login_PinPrompt_IncorrectPin`. Proof: with the lock-screen
PIN set and enabled, `CurrentUserHasCachedSignInPin()` and `UserHasCachedSignInPin(steamid)`
both still return **false**. Do not go looking in `SteamClient.Auth`.

## The overlay

Rendered into the Deck UI popup document, **not** SharedJSContext. `DFL.findSP()` hands us
that window.

Appended to `<body>` and positioned absolutely off the `.Indicators` rect, rather than
inserted into React's child list — React reconciles its own children by position, so a
stray node inside `.Details` could be moved or dropped. `body` is not reconciled.

Every entry point is wrapped in try/catch. If `findSP`, the class lookup or the DOM work
fails, unlocking still works exactly as before. This is decoration, never a dependency.

**Localisation gotcha.** `location.search` in SharedJSContext is **empty** — the URL is
`steamloopback.host/routes/library/home`. The `LANGUAGE=koreana` parameter lives on the
*SP window's* URL. Reading our own `location` silently yields English on a Korean client.
Use `DFL.findSP().location.search`. Generally: **anything read off `location` in
SharedJSContext is not the Deck UI's `location`.**

## Why the backend runs as root

`net.reactivated.fprint.device.verify` ships `allow_any=no`, `allow_inactive=no`,
`allow_active=yes`. A systemd service has **no logind session at all**, so the Decky
backend is refused whatever uid it runs as — not fixable by dropping privileges.
`device.setusername` is `auth_admin_keep`, which needs an interactive agent that by
definition cannot exist behind a lock screen.

The bundled polkit rule grants **only uid 0**, and only the two actions. That is not a
meaningful escalation: root already owns this boundary, and Steam's PIN is plaintext.

Related: `fprintd-list` failing from SSH with `PermissionDenied` is not a bug — SSH is not
the active session.

## Why the sensor cannot be held armed

libfprint estimates temperature in software (`fpi_device_update_temp`, `fpi-device.c`) and
refuses to operate past a threshold. Constants, read out of the source:

```
fp-device-private.h   TEMP_COLD_THRESH = 1/(e+1) = 0.26894
                      TEMP_WARM_HOT_THRESH = 1 - that = 0.73106   <- refuses here
                      TEMP_HOT_WARM_THRESH = 0.5                  <- must cool to here
                      DEFAULT_TEMP_HOT_SECONDS  = 180
                      DEFAULT_TEMP_COLD_SECONDS = 540
fp-device.c:204       model starts AT TEMP_COLD_THRESH
fp-device.c:184-188   egismoc's temp_hot_seconds = 0 maps to the DEFAULTS
                      (0 means "default", NOT "disabled")
fpi-device.c          active: r = αr + 1 - α, α = e^(-Δt/180)
                      idle:   r = αr,         α = e^(-Δt/540)
```

Because the thresholds are `1/(e+1)` and `e/(e+1)`, the crossing time from cold is exactly
`temp_hot_seconds`. **180 seconds of continuous arming → refusal, every time.**

`main.py` mirrors this and inverts it:

- `arm_s  = 180 · ln((1-r) / 0.26894)` — arming left before refusal
- `cool_s = 540 · ln(r / r_target)` — idle needed to buy back a given arm window

Two properties worth preserving if you touch this:

**Never trip the threshold.** Crossing it latches HOT until the ratio falls back to `0.5`,
about 219s of forced idle. Stopping just short costs seconds. `ARM_BUDGET_MS = 120000`
exists for this.

**Drift is one-directional in the safe way.** We count the whole `fprintd-verify`
subprocess as active while libfprint counts from device open, so we over-estimate heat and
stop early. The one under-estimate is fprintd exiting on its idle timeout, which resets
its model to cold while ours stays warm — that only costs an unnecessary wait.

## Testing gotchas

- **Restarting `plugin_loader` raises the lock screen**, because it reloads the Steam UI
  and re-fires the gamepad-UI-mount trigger. Expect to unlock after every install.
- **Switching to desktop mode restarts the Steam client**, rebuilding `SharedJSContext`
  from scratch. `localStorage` survives but recent writes may not be flushed. Do not put
  evidence for anything crossing a mode switch in frontend state — put it in the backend
  journal.
- **To force a lock-screen state by hand**, either let the 300ms poll see the lock screen
  first, or set `watcher.lastKnown = true` to suppress arming. Calling `abort()` in the
  same tick as raising the lock screen does *not* work: the poll has not run yet, so
  `onStateChange` fires 300ms later and re-arms, silently undoing what you set up.
- **`plugin_loader` is a PyInstaller bundle**, so it exports its extraction directory on
  `LD_LIBRARY_PATH` and every spawned system binary picks up a stale libcrypto
  (`OPENSSL_3.4.0 not found`). `main.py:_child_env()` strips it. Route any new subprocess
  through `_run()`.
