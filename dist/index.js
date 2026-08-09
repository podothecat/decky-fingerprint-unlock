const manifest$1 = {"name":"Ally Fingerprint Unlock"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest$1.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest$1.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const callable = api.callable;
const toaster = api.toaster;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

/* Ally Fingerprint Unlock -- Decky frontend.
 *
 * What it does: watch Steam's lock-screen store, and when the lock screen appears,
 * ask the backend for a fingerprint. On a match, clear the lock screen.
 *
 * What it never does: read, validate or replace the PIN. On any failure we simply
 * stop, leaving the PIN keypad exactly as it was.
 *
 * Ported from the hand-written dist/index.js that was verified on-device. The port is
 * deliberately a header swap only: `SP` and `DFL` are now namespace imports of the same
 * globals the bundler maps them to (react -> SP_REACT, @decky/ui -> DFL), so every line
 * below the imports is unchanged from the build that was confirmed working. Do not
 * "modernise" the body in the same commit as a behaviour change.
 */

const manifest = {
    name: "Ally Fingerprint Unlock"};
const backend = {
    verify: callable("verify"),
    cancel: callable("cancel"),
    status: callable("status"),
};
const log = (...a) => console.log("[ally-fp]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---- settings -----------------------------------------------------------------
// One flag, kept in localStorage so it survives a Steam restart without needing a
// backend round-trip on every read.
const ENABLED_KEY = "ally-fp.enabled";
/* Defaults to OFF, deliberately. A no-touch `verify-match` has been observed on this
 * sensor (see docs/EVIDENCE.md) -- with auto-unlock on, that would open the device with no
 * finger present. Until that is understood and eliminated, unlocking is opt-in and the
 * user has to turn it on knowing what it means. Do not flip this default back without
 * a clean measurement showing no-touch matches are gone. */
function isEnabled() {
    try {
        return localStorage.getItem(ENABLED_KEY) === "1";
    }
    catch {
        return false;
    }
}
function setEnabled(on) {
    try {
        localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    }
    catch {
        /* non-fatal */
    }
    if (!on)
        watcher.abort();
}
// ---- the lock screen -----------------------------------------------------------
// Both stores are globals in SharedJSContext (verified: they do not exist in the
// Big Picture / MainMenu / QuickAccess targets). See docs/DESIGN.md for how they were found.
function stores() {
    const sec = window.securitystore;
    if (!sec || typeof sec.SetActiveLockScreenProps !== "function")
        return null;
    return sec;
}
function isLocked() {
    const sec = stores();
    try {
        return !!sec && sec.IsLockScreenActive();
    }
    catch {
        return false;
    }
}
// ---- on-screen feedback --------------------------------------------------------
/* Without this the lock screen gives no sign that a fingerprint is even being waited
 * for, so a failed scan is indistinguishable from a plugin that is not running. That
 * confusion is worse here than usual, because recognition only lands ~4 times in 6.
 *
 * Three things make this safe:
 *  - The lock screen renders in the Deck UI popup document, NOT in SharedJSContext.
 *    DFL.findSP() hands us that window; verified by finding .Container in it.
 *  - We append to <body> and position absolutely off the .Indicators rect rather than
 *    inserting into React's child list. React reconciles its own children by position,
 *    so a stray node in the middle of .Details could be moved or dropped. body is not
 *    reconciled, so our node is untouchable.
 *  - Every entry point is wrapped. If findSP, the class lookup or the DOM work fails,
 *    unlocking still works exactly as before -- this is decoration, never a dependency.
 *
 * Deliberately absent: a "scanning" state. fprintd-verify's output is only collected
 * when the process exits, so the moment a finger touches the sensor is not observable.
 * Showing a guessed "reading..." would be a lie. */
/* Steam's UI language, which is not this context's. SharedJSContext is loaded from
 * `steamloopback.host/routes/library/home` with an EMPTY query string -- the LANGUAGE
 * param lives on the SP window's URL (`...&LANGUAGE=koreana&COUNTRY=KR&...`). Reading
 * our own location.search here silently yields English on a Korean client; that is
 * exactly what the first on-device test showed.
 *
 * Resolved lazily rather than at module load, because findSP() is not guaranteed ready
 * that early, and cached only once the real answer is in hand -- the navigator fallback
 * is the OS locale, which can disagree with the Steam client's own setting, so we keep
 * retrying findSP() until it answers. */
let _koCached = null;
function isKorean() {
    if (_koCached !== null)
        return _koCached;
    try {
        const search = DFL.findSP().location.search;
        if (search) {
            _koCached = /LANGUAGE=koreana/.test(search);
            return _koCached;
        }
    }
    catch (e) {
        /* fall through to the OS locale */
    }
    return /^ko\b/i.test(navigator.language || "");
}
/* Colours and metrics are measured off the real lock screen rather than invented, so
 * this reads as part of Steam rather than bolted on:
 *   .Prompt       22px  rgb(255,255,255)
 *   .IncorrectPIN 16px  rgb(255,200,44)   <- Steam's own failure amber, reused below
 *   .Directions   12px  rgb(184,188,191)  <- Steam's muted body text, reused below
 * all in Motiva Sans, which we inherit from <body> by simply not setting a family. */
const STATES = {
    waiting: { glyph: "◉", color: "rgb(184,188,191)", ko: "지문을 대세요", en: "Touch the fingerprint sensor" },
    retry: { glyph: "✕", color: "rgb(255,200,44)", ko: "다시 시도하세요", en: "Not recognised, try again" },
    // `pill` because this one alone is shown after the lock screen has gone, so it has no
    // panel behind it and has to supply its own contrast.
    success: { glyph: "✓", color: "rgb(255,255,255)", ko: "인증됨", en: "Verified", pill: true },
    recovering: { glyph: "⋯", color: "rgb(255,200,44)", ko: "센서 재시도 중", en: "Sensor hiccup, retrying" },
    cooling: { glyph: "⧗", color: "rgba(184,188,191,0.8)", ko: "센서 대기 중 %s초", en: "Sensor cooling down, %ss" },
    /* The two ends of an arm window. `expired` is a button; `unavailable` is not, and that
     * difference is the point. Only states a re-arm could actually fix get a button --
     * offering one for a missing enrolment or a denied polkit call would just be a lie. */
    expired: { glyph: "◉", color: "rgb(255,255,255)", ko: "지문 다시 인식", en: "Tap to scan again", button: true },
    unavailable: { glyph: "—", color: "rgba(184,188,191,0.6)", ko: "지문 사용 불가", en: "Fingerprint unavailable" },
};
/* Chrome for a message that has to stand on its own over arbitrary UI. Once the lock
 * screen is gone there is no panel behind the text any more, and bare 16px light-grey
 * over a game library is exactly what read as a glitch. */
const PILL_STYLE = {
    padding: "11px 24px",
    borderRadius: "3px",
    background: "rgba(0,0,0,0.75)",
    border: "1px solid rgba(255,255,255,0.15)",
};
const lockUI = {
    el: null,
    doc: null,
    timer: null,
    _classes: null,
    _holding: false,
    _holdTimer: null,
    classes() {
        if (this._classes)
            return this._classes;
        try {
            this._classes = DFL.findModule((m) => m && typeof m === "object" &&
                typeof m.Container === "string" &&
                typeof m.Indicators === "string" &&
                typeof m.IncorrectPIN === "string");
        }
        catch (e) {
            log("lock class module lookup failed", e);
        }
        return this._classes;
    },
    spDoc() {
        try {
            const sp = DFL.findSP();
            return sp && sp.document ? sp.document : null;
        }
        catch (e) {
            return null;
        }
    },
    setState(name, opts = {}) {
        const s = STATES[name];
        if (!s)
            return;
        try {
            // Any new state supersedes a hold in progress, so a lingering success message can
            // never sit on top of a fresh lock screen.
            this.clearHold();
            if (!this.mount())
                return;
            const o = opts || {};
            let label = isKorean() ? s.ko : s.en;
            if (o.arg != null)
                label = label.replace("%s", o.arg);
            this.el.textContent = s.glyph + "  " + label;
            this.el.style.color = s.color;
            this.el.style.opacity = "1";
            this.setAction(s.button ? o.onPress : null);
            if (s.pill)
                Object.assign(this.el.style, PILL_STYLE);
        }
        catch (e) {
            log("setState failed", e);
        }
    },
    clearHold() {
        if (this._holdTimer)
            clearTimeout(this._holdTimer);
        this._holdTimer = null;
        this._holding = false;
    },
    /* Show a state and keep it up for `ms`, deliberately outliving the lock screen.
     *
     * The success message is the one thing here that has to survive an unlock, because the
     * unlock is instant by request -- by the time "인증됨" is worth reading, the panel it
     * belongs to is already gone. Two things would otherwise destroy it:
     *
     *  - the watcher's next poll sees the lock screen gone and calls abort(), which
     *    unmounts this overlay. `_holding` makes that unmount a no-op, so the message is
     *    not torn down ~300ms in -- which was the original bug.
     *  - the .Indicators anchor disappears with the lock screen, so the next reposition()
     *    would fall back to 58% and the message would visibly jump. Freeze it instead.
     */
    flash(name, ms) {
        try {
            this.setState(name);
            if (!this.el)
                return;
            // Freeze first: the anchor is about to vanish, and a jump is worse than a stale
            // position.
            if (this.timer)
                clearInterval(this.timer);
            this.timer = null;
            this._holding = true;
            const el = this.el;
            this._holdTimer = setTimeout(() => {
                try {
                    el.style.opacity = "0";
                }
                catch (e) {
                    /* non-fatal */
                }
                this._holdTimer = setTimeout(() => {
                    this._holding = false;
                    this.unmount(true);
                }, SUCCESS_FADE_MS);
            }, ms);
        }
        catch (e) {
            log("flash failed", e);
            this._holding = false;
        }
    },
    /* Making the node tappable is the one place this overlay stops being decoration, so it
     * is also the one place it could do harm. It stays outside Steam's gamepad focus tree
     * on purpose: a DFL.Focusable here would join the lock screen's navigation and could
     * pull focus off the PIN keypad, and "PIN entry must never stop working" is the
     * constraint this whole feature is built under. Touch cannot steal focus, so it cannot
     * break that.
     *
     * Touch is also the native input here rather than a fallback -- the Ally X has a
     * touchscreen and the PIN pad itself is tapped the same way. Verified against the live
     * lock screen: at z-index 7000 this node is the topmost elementFromPoint hit over its
     * whole rect, corners included, so a tap lands on us and not on the panel behind. */
    setAction(fn) {
        this._onPress = typeof fn === "function" ? fn : null;
        const styles = this._onPress
            ? {
                pointerEvents: "auto",
                cursor: "pointer",
                // Padding is not cosmetic: it is what makes this a finger-sized target.
                padding: "11px 24px",
                borderRadius: "3px",
                background: "rgba(255,255,255,0.10)",
                border: "1px solid rgba(255,255,255,0.30)",
            }
            : {
                pointerEvents: "none",
                cursor: "default",
                padding: "0",
                borderRadius: "0",
                background: "transparent",
                border: "0",
            };
        Object.assign(this.el.style, styles);
    },
    mount() {
        try {
            const doc = this.spDoc();
            if (!doc || !doc.body)
                return false;
            // Re-mount if the Deck UI document was replaced (mode switch rebuilds it).
            if (this.el && this.doc === doc && doc.body.contains(this.el))
                return true;
            this.unmount();
            this.doc = doc;
            this.el = doc.createElement("div");
            Object.assign(this.el.style, {
                position: "fixed",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: "7000",
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                fontSize: "16px",
                fontWeight: "400",
                opacity: "1",
                transition: "color 150ms ease, opacity " + SUCCESS_FADE_MS + "ms ease",
            });
            /* Bound once per mount, and gated on this._onPress rather than added and removed,
             * so there is never a window where a stale handler is still wired up. */
            this.el.addEventListener("click", (ev) => {
                const fn = this._onPress;
                if (!fn)
                    return;
                ev.preventDefault();
                ev.stopPropagation();
                // One press per offer. Whatever runs next decides what the label becomes, and
                // until it does, a second tap must not queue a second arm.
                this.setAction(null);
                try {
                    fn();
                }
                catch (e) {
                    log("re-arm handler threw", e);
                }
            });
            // Press feedback. Without it, tapping what still looks like a label gives no sign
            // the tap registered, and the user taps again.
            const shade = (v) => {
                if (this._onPress)
                    this.el.style.background = "rgba(255,255,255," + v + ")";
            };
            this.el.addEventListener("pointerdown", () => shade("0.20"));
            this.el.addEventListener("pointerup", () => shade("0.10"));
            this.el.addEventListener("pointercancel", () => shade("0.10"));
            doc.body.appendChild(this.el);
            this.reposition();
            // Cheap: two rect reads per second, only while the lock screen is up.
            this.timer = setInterval(() => this.reposition(), 500);
            return true;
        }
        catch (e) {
            log("mount failed", e);
            return false;
        }
    },
    reposition() {
        try {
            if (!this.el || !this.doc)
                return;
            const cls = this.classes();
            const anchor = cls && this.doc.querySelector("." + cls.Indicators);
            if (anchor) {
                const r = anchor.getBoundingClientRect();
                this.el.style.top = Math.round(r.bottom + 14) + "px";
            }
            else {
                // No PIN dots found -- centre it rather than leaving it at 0,0.
                this.el.style.top = "58%";
            }
        }
        catch (e) {
            /* non-fatal */
        }
    },
    // `force` is what the hold timer and plugin teardown use. Everything else -- notably
    // the abort() that follows an unlock -- must not cut a success message short.
    unmount(force = false) {
        if (this._holding && !force)
            return;
        try {
            if (this.timer)
                clearInterval(this.timer);
            this.timer = null;
            if (this._holdTimer)
                clearTimeout(this._holdTimer);
            this._holdTimer = null;
            this._holding = false;
            if (this.el && this.el.parentNode)
                this.el.parentNode.removeChild(this.el);
        }
        catch (e) {
            /* non-fatal */
        }
        this.el = null;
        this.doc = null;
        this._onPress = null;
    },
};
/* Clear the lock screen the same way a correct PIN would.
 *
 * The power-on and wake triggers pass no onSuccess -- unlocking there is nothing but
 * clearing the props. The desktop-mode-switch trigger DOES pass one, and it performs
 * the actual switch, so it has to run first or the switch would silently be cancelled. */
function unlock() {
    const sec = stores();
    if (!sec)
        return false;
    try {
        const props = sec.GetActiveLockScreenProps();
        if (props && typeof props.onSuccess === "function") {
            log("running lock screen onSuccess (desktop-mode switch path)");
            props.onSuccess();
        }
    }
    catch (e) {
        log("onSuccess threw, clearing anyway", e);
    }
    try {
        sec.SetActiveLockScreenProps(null);
        return true;
    }
    catch (e) {
        log("failed to clear lock screen", e);
        return false;
    }
}
// ---- watcher -------------------------------------------------------------------
/* Detection is a poll, deliberately.
 *
 * Two nicer-looking approaches were tried against the live store and both are dead:
 *
 *  1. Wrapping securitystore.SetActiveLockScreenProps. mobx's makeAutoObservable
 *     defines its actions as own properties with writable:false, configurable:false,
 *     so the assignment fails *silently* in non-strict mode -- verified: the wrapper
 *     was installed and then never called once. The prototype has a configurable
 *     getter, but the own property shadows it, so patching there does nothing either.
 *  2. A mobx reaction on the observable. mobx is not reachable: no window global, and
 *     DFL.findModule / findModuleExport cannot locate autorun/reaction.
 *
 * So: poll a boolean. 300ms is irrelevant next to the ~1s fprintd takes to claim the
 * device, and polling also handles the normal power-on ordering, where the lock screen
 * is already up before this plugin finishes loading. */
const POLL_MS = 300;
const RETRY_MS = 400;
/* How long "인증됨" stays on screen. It is NOT charged to unlock latency: the lock screen
 * is cleared immediately on a match and the message is allowed to outlive it, which is
 * how the user asked for it -- an instant unlock beats a tidy one.
 *
 * Before this the confirmation was effectively invisible. unlock() clears the lock screen
 * synchronously, so the panel behind the message vanished in the same frame, and the
 * overlay itself was torn down by the very next POLL_MS tick -- under 300ms of bare text
 * over whatever the lock screen had been covering. Reported as too fast to register.
 *
 * Because nothing waits on it, this can be generous. The cost of a larger number is only
 * that the message sits over the revealed UI a little longer. */
const SUCCESS_HOLD_MS = 1500;
const SUCCESS_FADE_MS = 300;
/* How many *consecutive* device-errors to absorb before falling back to the PIN. Two is
 * enough to ride out the driver's 60s interrupt ceiling and a stray USB hiccup, while
 * still giving up promptly if the sensor is actually gone. */
const MAX_DEVICE_ERRORS = 2;
/* How long the sensor may stay armed unattended before it stops and waits to be asked
 * again. This is a policy cap sitting underneath a hard physical one.
 *
 * libfprint runs a software thermal model with no thermometer behind it and refuses to
 * operate once its estimate crosses a threshold. Because its thresholds are 1/(e+1) and
 * e/(e+1), a cold sensor reaches that point after exactly temp_hot_seconds = 180s of
 * continuous arming -- measured on this device at 195s, matching. So there is no version
 * of this feature where an untouched lock screen stays armed forever. The only real
 * choice is whether the arm window ends in a dead end or in a button.
 *
 * 120s rather than 180s so that stopping still leaves something to spend: the backend's
 * model puts a re-arm straight after this cap at ~60s of headroom, a full verify window.
 * Running to the wall would leave nothing, and worse -- crossing the threshold latches
 * libfprint HOT until it cools all the way back to 0.5, roughly 219s of forced idle.
 * Stopping just short costs seconds instead. */
const ARM_BUDGET_MS = 120000;
/* Mirrors MIN_ARM_S in main.py: a window shorter than this cannot land a touch. */
const MIN_ARM_MS = 10000;
/* Results a re-arm could plausibly fix, so they get a button. no-prints / denied /
 * no-device are deliberately excluded: nothing the user can do at a lock screen resolves
 * those, and a button that cannot help is worse than an honest message. */
const REARMABLE = ["device-error", "unknown"];
const watcher = {
    generation: 0,
    running: false,
    timer: null,
    countdown: null,
    lastKnown: false,
    lastResult: null,
    start() {
        if (!stores()) {
            log("securitystore not present yet, retrying");
            this.timer = setTimeout(() => this.start(), 2000);
            return;
        }
        this.timer = setInterval(() => this.tick(), POLL_MS);
        this.tick();
        log("watcher started");
    },
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.abort();
        // Teardown must win over a hold in progress, or a dead plugin leaves a node behind.
        lockUI.unmount(true);
        log("watcher stopped");
    },
    tick() {
        this.onStateChange(isLocked());
    },
    onStateChange(locked) {
        if (locked === this.lastKnown)
            return;
        this.lastKnown = locked;
        log(locked ? "lock screen up" : "lock screen gone");
        if (locked)
            this.beginVerify();
        else
            this.abort();
    },
    clearCountdown() {
        if (this.countdown)
            clearInterval(this.countdown);
        this.countdown = null;
    },
    abort() {
        this.generation++;
        this.clearCountdown();
        lockUI.unmount();
        if (this.running) {
            this.running = false;
            backend.cancel().catch((e) => log("cancel failed", e));
        }
    },
    /* The end of an arm window is not the end of the story, and it used to be presented as
     * one. Arming cannot be held open indefinitely (see ARM_BUDGET_MS), so instead of
     * leaving a dead "Fingerprint unavailable" label the lock screen now hands back a way
     * to spend the next slice of budget -- at the moment the user is actually there and
     * ready to touch the sensor, which is exactly when arming is worth anything.
     *
     * If the sensor needs to cool first, count that down rather than offering a button
     * that would fail instantly: the backend can predict the wait to the second, and a
     * button that does nothing reads as a broken plugin. */
    offerRearm(gen, coolS) {
        const show = () => {
            if (gen !== this.generation || !isLocked())
                return;
            lockUI.setState("expired", { onPress: () => this.rearm() });
        };
        this.clearCountdown();
        let left = Math.ceil(coolS || 0);
        if (left <= 0)
            return show();
        log(`arm window over, sensor needs ${left}s to cool`);
        lockUI.setState("cooling", { arg: left });
        this.countdown = setInterval(() => {
            if (gen !== this.generation || !isLocked())
                return this.clearCountdown();
            left -= 1;
            if (left > 0)
                return lockUI.setState("cooling", { arg: left });
            this.clearCountdown();
            show();
        }, 1000);
    },
    rearm() {
        this.clearCountdown();
        if (this.running)
            return;
        log("re-arm requested from the lock screen");
        this.beginVerify();
    },
    async beginVerify() {
        if (!isEnabled()) {
            log("disabled by setting, leaving the PIN keypad alone");
            return;
        }
        if (this.running)
            return;
        const gen = ++this.generation;
        this.running = true;
        this.clearCountdown();
        let deviceErrors = 0;
        let armedMs = 0;
        lockUI.setState("waiting");
        try {
            while (gen === this.generation && isEnabled() && isLocked()) {
                /* Spend the arm budget down rather than looping forever. Whatever is left is
                 * handed to the backend as the window for this attempt, so the last slice is a
                 * short verify rather than an over-long one that gets cut off mid-scan. */
                const leftMs = ARM_BUDGET_MS - armedMs;
                if (leftMs < MIN_ARM_MS) {
                    log(`arm budget spent after ${Math.round(armedMs / 1000)}s, offering re-arm`);
                    this.offerRearm(gen, 0);
                    break;
                }
                let res;
                const t0 = Date.now();
                try {
                    res = await backend.verify(Math.ceil(leftMs / 1000));
                }
                catch (e) {
                    log("backend verify threw, offering re-arm", e);
                    this.offerRearm(gen, 0);
                    break;
                }
                armedMs += Date.now() - t0;
                this.lastResult = res && res.result;
                if (gen !== this.generation || !isLocked())
                    break;
                /* The backend declined to arm at all because libfprint would refuse mid-scan.
                 * It can predict the wait exactly, so count it down and then offer the button. */
                if (res && res.result === "too-hot") {
                    this.offerRearm(gen, res.budget && res.budget.cool_s);
                    break;
                }
                if (res && res.result === "match") {
                    log("match -> unlocking");
                    /* Message first, then unlock -- both in this same tick, so the unlock is still
                     * instant. The order only exists so the overlay is frozen in place before the
                     * .Indicators anchor disappears with the lock screen; reversing it would let
                     * one reposition() slip through and make the message jump.
                     *
                     * The message then outlives the lock screen on purpose. That is why `success`
                     * carries its own pill background: from here on it is floating over the
                     * revealed UI with nothing behind it. */
                    lockUI.flash("success", SUCCESS_HOLD_MS);
                    unlock();
                    break;
                }
                // "cancelled" is us killing the verify because the lock screen went away -- not
                // a failure, and nothing to report.
                if (res && res.result === "cancelled")
                    break;
                /* device-error used to break out here as unrecoverable. It is not always: the
                 * driver's 60s USB interrupt ceiling surfaces as one (see VERIFY_TIMEOUT_S in
                 * main.py), and that is transient -- the very next claim works. Keeping it
                 * terminal meant one blip disabled the fingerprint for the whole lock screen,
                 * with no way back short of re-raising it.
                 *
                 * Bounded rather than infinite, because a genuinely broken or unplugged sensor
                 * must still fall through to the PIN instead of spinning forever. The counter is
                 * per-lock-screen: any completed verify below resets it, so only *consecutive*
                 * failures count. */
                if (res && res.result === "device-error" && deviceErrors < MAX_DEVICE_ERRORS) {
                    deviceErrors++;
                    log(`device-error ${deviceErrors}/${MAX_DEVICE_ERRORS}, re-arming`, res);
                    // Not "unavailable": this recovers by itself most of the time, and saying
                    // otherwise for a few hundred ms is both alarming and usually a lie.
                    lockUI.setState("recovering");
                    await sleep(RETRY_MS);
                    if (gen !== this.generation || !isLocked())
                        break;
                    lockUI.setState("waiting");
                    continue;
                }
                /* Anything else ends this arm window. Two very different endings, though: some of
                 * these are worth another try and some genuinely are not, and collapsing both
                 * into one "Fingerprint unavailable" label was the dead end this replaces. */
                if (res && res.result !== "no-match" && res.result !== "timeout" && res.result !== "busy") {
                    if (REARMABLE.indexOf(res.result) !== -1) {
                        log("verify stopped on a recoverable result, offering re-arm:", res);
                        this.offerRearm(gen, res.budget && res.budget.cool_s);
                    }
                    else {
                        // Nothing a re-arm can do -- no enrolled print, polkit refusal, no device.
                        // Say so plainly and leave the PIN keypad to it.
                        log("unrecoverable verify result, falling back to PIN:", res);
                        lockUI.setState("unavailable");
                        toaster.toast({
                            title: "Fingerprint unavailable",
                            body: `${res.result} -- enter your PIN`,
                        });
                    }
                    break;
                }
                deviceErrors = 0;
                // Show the miss, then go back to inviting a touch. Without the pause the state
                // flips back so fast the user never sees that the scan was rejected.
                if (res && res.result === "no-match") {
                    lockUI.setState("retry");
                    await sleep(1200);
                    if (gen !== this.generation || !isLocked())
                        break;
                    lockUI.setState("waiting");
                }
                await sleep(res && res.result === "busy" ? 1000 : RETRY_MS);
            }
        }
        finally {
            if (gen === this.generation)
                this.running = false;
        }
    },
};
// ---- UI ------------------------------------------------------------------------
function Content() {
    const [enabled, setEnabledState] = SP_REACT.useState(isEnabled());
    const [status, setStatus] = SP_REACT.useState(null);
    const [busy, setBusy] = SP_REACT.useState(false);
    const refresh = SP_REACT.useCallback(async () => {
        setBusy(true);
        try {
            setStatus(await backend.status());
        }
        catch (e) {
            setStatus({ error: String(e) });
        }
        finally {
            setBusy(false);
        }
    }, []);
    SP_REACT.useEffect(() => {
        refresh();
    }, [refresh]);
    // Keyed: these are rendered from an array, and React warns otherwise.
    const row = (label, value) => SP_REACT.createElement(DFL.PanelSectionRow, { key: label }, SP_REACT.createElement(DFL.Field, { label: label, focusable: false, bottomSeparator: "none" }, String(value)));
    return SP_REACT.createElement("div", null, SP_REACT.createElement(DFL.PanelSection, { title: "Unlock" }, SP_REACT.createElement(DFL.PanelSectionRow, null, SP_REACT.createElement(DFL.ToggleField, {
        label: "Fingerprint unlock",
        description: "OFF by default: this sensor has returned a match with no finger present. " +
            "Do not enable until that is fixed. PIN entry always stays available.",
        checked: enabled,
        onChange: (on) => {
            setEnabled(on);
            setEnabledState(on);
        },
    }))), SP_REACT.createElement(DFL.PanelSection, { title: "Status" }, status
        ? [
            row("User", status.user),
            row("Enrolled prints", status.enrolled != null ? status.enrolled : "?"),
            row("fprintd-verify", status.has_fprintd_verify ? "found" : "MISSING"),
            status.list_problem ? row("Problem", status.list_problem) : null,
            // Surfaced because the thermal model is otherwise completely invisible:
            // libfprint keeps it internally and only ever reports the refusal.
            status.budget ? row("Arm budget", Math.round(status.budget.arm_s) + "s") : null,
            status.budget && status.budget.cool_s > 0
                ? row("Cooldown", status.budget.cool_s + "s")
                : null,
            watcher.lastResult ? row("Last result", watcher.lastResult) : null,
        ]
        : row("Status", busy ? "checking..." : "unknown"), SP_REACT.createElement(DFL.PanelSectionRow, null, SP_REACT.createElement(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: refresh }, "Refresh"))), SP_REACT.createElement(DFL.PanelSection, { title: "Test" }, SP_REACT.createElement(DFL.PanelSectionRow, null, SP_REACT.createElement(DFL.ButtonItem, {
        layout: "below",
        // preventCancel:false on purpose -- this test lock screen stays escapable
        // with B, so a failed test can never strand anyone.
        onClick: () => {
            const sec = stores();
            if (sec)
                sec.SetActiveLockScreenProps({ preventCancel: false });
        },
    }, "Raise lock screen (escapable)"))));
}
// ---- entry ---------------------------------------------------------------------
var index = definePlugin(() => {
    watcher.start();
    // Handle for poking at this over CDP from an SSH session (see cdp.py).
    window.__allyFP = {
        watcher: watcher,
        unlock: unlock,
        isLocked: isLocked,
        backend: backend,
        lockUI: lockUI,
        // Lets an SSH session drive the re-arm path without a touchscreen.
        rearm: () => watcher.rearm(),
    };
    return {
        name: manifest.name,
        titleView: SP_REACT.createElement("div", { className: DFL.staticClasses.Title }, "Fingerprint Unlock"),
        content: SP_REACT.createElement(Content, null),
        icon: SP_REACT.createElement("div", null, "◉"),
        onDismount() {
            watcher.stop();
            try {
                delete window.__allyFP;
            }
            catch {
                window.__allyFP = undefined;
            }
        },
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
