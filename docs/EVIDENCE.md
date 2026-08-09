# Measurements

Everything here was measured on the development machine — a ROG Xbox Ally X running
Bazzite 43.20260420 (`bazzite-deck`, Kinoite), sensor `1c7a:0588`, firmware `9050.6.6.15`.

Recorded because several of these results contradict a plausible-sounding explanation that
was believed at the time. The wrong turns are kept deliberately.

## Driver: daemon abort on a cancelled verify

Six consecutive deliberately-aborted verifies (no finger, short timeout):

| | before patch 0002 | after |
|---|---|---|
| results | perfect alternation: `timeout`, then `NoReply` claim failure | **6/6 `timeout`** |
| core dumps | one per abort (10 collected) | **0** |
| fprintd | repeatedly `failed (core-dump)` | `active`, `Result=success`, `NRestarts=0` |

Re-confirmed on a later day with six more killed verifies: `NRestarts=0`, no core dumps,
one fprintd instance surviving all six.

## The no-touch spurious match — investigated, not reproduced

A `verify-match` was once returned with **no finger on the sensor**, in 1187ms. Seen twice,
both times after fprintd had been hammered by killed verifies — i.e. in the corrupted state
that patch 0002 removed.

Running total since: **11 clean no-touch runs** (4 before the fix, 7 after), every one
correctly waiting the full window and refusing to invent a result. Never reproduced.

This is why the toggle still ships **OFF** by default. The evidence strongly favours "it
was a symptom of the crash", but a lock screen that opens with no finger present is worse
than no feature at all, so enabling stays a deliberate act.

## Recognition rate

Eight armed runs with real touches, after the driver fix:

| run | result | elapsed |
|---|---|---|
| 0 | `timeout` | 61.6s — armed before anyone was told to touch |
| 1 | `unknown` | 0.44s — claim failure from killing run 0 |
| 2 | **match** | 1.83s |
| 3 | **match** | 1.73s |
| 4 | `no-match` | 0.85s |
| 5 | `no-match` | 0.86s |
| 6 | **match** | 1.28s |
| 7 | **match** | 3.08s |

Runs 2-7 are six consecutive completed verifies, zero crashes, zero claim failures.
**4/6 ≈ 67%** on a single touch; the re-arm-on-no-match loop takes that to ~89% over two.

Weak signal, recorded but not acted on: both `no-match` results returned at ~0.85s while
every `match` took 1.3-3.1s, and the spurious match was also fast. The overlap is too tight
for a latency threshold to be a safe guard, so no heuristic was added.

## The 60s interrupt ceiling

Two failures at the lock screen, both reported as "지문 사용 불가":

| | fprintd start | failed | elapsed | verify window |
|---|---|---|---|---|
| first | 08:51:42 | 08:52:43 | ~60s | 300s |
| second | 09:38:02 | 09:39:12 | ~70s | 300s |
| control | 08:59:07 | all fine | 21s each | 20s |

`EGISMOC_USB_INTERRUPT_TIMEOUT` is 60000. Every probe using a 20-30s window never reached
it; only the watcher asked for 300s. So `VERIFY_TIMEOUT_S = 300` was unreachable by
construction — **any lock screen left untouched for 60s was guaranteed to end in a
permanent failure.**

**Wrong turn worth keeping:** this was first blamed on a 9-hour s2idle, because the first
failure followed a long sleep and later runs on the same boot were clean. The recovery was
not the device healing — it was switching to a 25s window that cannot reach the ceiling.
Easy to misread a change in *measurement* as a change in the *system*. A proposed
"warm-up verify" mitigation would have appeared to work while leaving the real bug in place.

## The thermal ceiling

After fixing the above, a 130s untouched soak was clean — three re-arm cycles 47s apart,
indicator never fell to unavailable, `generation` stayed at 1 (so it was the in-loop
re-arm, not a teardown).

Left longer, it failed anyway, for a different reason:

```
09:55:56  verify -> timeout      ┐
09:56:43  verify -> timeout      │ four clean 47s cycles
09:57:30  verify -> timeout      │
09:58:17  verify -> timeout      ┘
09:58:24  fprintd: Device disabled to prevent overheating.
```

Armed ~09:55:09, refused 09:58:24 — **195s**, against a model predicting 180s. Model
confirmed. See `DESIGN.md` for the constants.

Note the device-error retry logic worked exactly as written and was still useless here: it
burned both retries in 1.4s against a condition that needed minutes. That is what motivated
budgeting instead of retrying.

## Arm budget and re-arm, on real hardware

Backend log across one untouched lock screen:

```
14:50:11 ... 12:25:45  verify -> timeout
                       12:26:32  verify -> timeout    (47s later)
                       12:27:01  verify -> timeout    (29s later)  <- clamped final slice
```

Two full 45s windows then the remainder, which is the 120s cap working. Then `too-hot`
returned without spawning a process, a `⧗ 센서 대기 중 6초` countdown, and the
`◉ 지문 다시 인식` button. A real finger tap on the button re-armed successfully.

## Success message lifecycle

Recorded at 100ms granularity across a genuine match:

```
  t(ms)  locked  inDom  hold   op   top  text
    101    True   True False    1   376  ◉  지문을 대세요
   8900    True   True False    1   376  ✕  다시 시도하세요     <- no-match
  10100    True   True False    1   376  ◉  지문을 대세요       <- exactly 1200ms later
  12442   False   True  True    1   376  ✓  인증됨             <- UNLOCKED
  13800   False   True  True    0   376  ✓  인증됨             <- fade begins
  14100   False  False False None  None  (removed)
```

- unlock is instant — `locked` flips `False` in the same sample the message appears
- the message outlives the lock screen by ~1.6s (`inDom: True` while `locked: False`)
- `top` is 376 throughout, including after the `.Indicators` anchor was gone; without the
  position freeze the last rows would read 270
- `14100 - 13800 = 300ms`, exactly the configured fade

First touch was a no-match and the second matched — consistent with the 67% figure above.

## The power-key question

The sensor **is** the power button, and `/etc/systemd/logind.conf.d/deck.conf` sets
`HandlePowerKey=suspend`. Eight deliberate presses with each verify wrapped in
`systemd-inhibit --what=handle-power-key`: the machine **never suspended**. No
`Suspending system`, no sleep target in the journal.

## Overlay placement

Measured off the live lock screen:

```
text        "◉  지문을 대세요"
color       rgb(184, 188, 191)          <- Steam's muted body text
font        "Motiva Sans", 16px         <- inherited from <body>
rect        top 376, centre 414
viewport    828 x 466, centre 414
```

`top` of 376 rather than the 270 a 58% fallback would give proves `DFL.findModule` really
found the lock screen's class module and measured the PIN-dot rect.

Re-arm button, same method: 168 × 48 px, topmost `elementFromPoint` across its whole rect
including corners, dispatched click reaches the handler.
