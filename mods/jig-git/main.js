// Every git checkout under the folder the focused terminal is in (or the space's folder: the header's toggle), with their
// changes and what is waiting on origin: a VS Code-style source control list. A main checkout shows its linked worktrees
// under it as "↳ <folder>" rows. One shell script per refresh reads them all (see lib.js); a click on a file opens it in a
// full-size Review tab (see ../jig-review).
// Git actions, all in lib.js and each refreshing the list at once: a checkbox per file stages or unstages it, hover
// buttons stage or unstage a checkout's files and discard one file (after an inline confirm), a message box commits the
// staged files (Commit & Push too), and the branch chip opens the branch picker (picker.js). Fetch and Pull run at once;
// Push and Publish ask first in a dialog that shows the destination git will really use (push.js). There is no Sync: a
// branch both ahead and behind is diverged, where a fast-forward pull always fails. Every network command runs with no
// prompt, under a timeout, and only one action at a time can hold a checkout.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import {
    appHome,
    exec,
    focused,
    layout,
    props as modProps,
    openOverlay,
    panes,
    readTextFile,
    run,
    setShared,
    shared,
    spaces,
    terminals,
    theme,
    window,
} from "herdr";
import { shown } from "./layout.js";
import {
    badgeText,
    busyAgents,
    canRun,
    checkoutDetail,
    commit,
    commitRowStacked,
    commitsToPush,
    contextKeyOf,
    disambiguators,
    discardFile,
    discardKind,
    FOLD_KEY,
    fetchRemote,
    filterGroups,
    focusedCheckout,
    foldMap,
    groupCheckouts,
    groupRepos,
    holdsLock,
    isDiverged,
    isFolded,
    lockOf,
    networkExec,
    panesOn,
    parseConfig,
    parseRepos,
    pickRoot,
    pullFastForward,
    RUNNING_KEY,
    repoActions,
    rowName,
    SCRIPT,
    splitPath,
    stageAll,
    stageFile,
    unstageFile,
    viewForContext,
    withAllFolds,
    withLock,
    withoutLock,
} from "./lib.js";
import { panelError, panelHeader } from "./panel-header.js";
import {
    busyButton,
    contextCard,
    dangerButton,
    emptyLine,
    footer,
    groupHeader,
    groupOpen,
    moveActive,
    primaryButton,
    row,
    secondaryButton,
    skeleton,
    statusLine,
} from "./panel-kit.js";
import { BranchPicker, DONE } from "./picker.js";
import { PushConfirm } from "./push.js";
import {
    focusRegained,
    friendlyError,
    RefreshScheduler,
    RefreshState,
    refreshSeconds,
    run as runCommand,
    terminalFinished,
} from "./refresh.js";

// Herdr can only watch folders on this computer, so a space on another machine is polled. All repos
// take well under a second, so poll often, and at once when a terminal or agent changes state
// (an agent finishing a turn, a command ending): that's when files change.
const NOTE_MS = 12000; // how long an action's result stays under its checkout
const CONFIG_MS = 60000; // how long config.json is trusted before it is read again
const visible = () => shown(layout(), "jig-git");
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const OWN = (name) => `mods/jig-git/${name}.svg`;
const lastSegment = (path) =>
    String(path ?? "")
        .replace(/\/+$/, "")
        .split("/")
        .pop();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The letter a changed file shows, in a colour of the theme. */
function statusColour(t, status) {
    if (status === "A" || status === "??") return t.ansi2;
    if (status === "D" || status === "U") return t.ansi1;
    if (status === "R") return t.ansi5;
    return t.blocked;
}

// Where to look: the machine, and the folder (the focused terminal's, or the space's when the header says so).
function location(follow) {
    const space = spaces().find((s) => s.active),
        f = focused();
    const on =
        f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const first = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const root = pickRoot({
        follow,
        focusedCwd: pane?.cwd || f?.cwd || null,
        spaceFolder: space?.folder || null,
        first,
    });
    return { root, on, space: space?.id, follow };
}

// Count for the panel's icon on the activity bar; only on change, since setting re-renders every mod.
function badge(count) {
    const value = { count, tone: "accent" };
    if (JSON.stringify(shared("badge.jig-git")) !== JSON.stringify(value)) setShared("badge.jig-git", value);
}

/** A small square icon or glyph button that stops the click from reaching the row under it. */
function iconButton(t, id, content, tip, onClick, disabled = false, busy = false) {
    return div()
        .id(id)
        .flex_none()
        .w(22)
        .h(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(disabled || busy ? t.dim : t.muted)
        .when(disabled || busy, (el) => el.opacity(0.45))
        .when(!disabled, (el) =>
            el
                .cursor_pointer()
                .hover((s) => s.bg(t.raised).text_color(t.foreground))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                    cx.stop_propagation();
                    onClick(cx);
                }),
        )
        .tooltip(tip)
        .child(typeof content === "string" ? svg(content).size(13) : content);
}

function textButton(t, id, label, onClick, danger = false, disabled = false, tip = null) {
    return div()
        .id(id)
        .flex_none()
        .h(22)
        .px(8)
        .flex()
        .items_center()
        .rounded(6)
        .text_size(11.5)
        .cursor_pointer()
        .bg(disabled ? t.raised : danger ? t.blocked : t.raised)
        .text_color(disabled ? t.dim : danger ? t.background : t.foreground)
        .when(disabled, (el) => el.opacity(0.5))
        .when(!disabled, (el) => el.hover((s) => s.opacity(0.85)))
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
            cx.stop_propagation();
            if (!disabled) onClick(cx);
        })
        .child(label);
}

export default class RepoChanges extends View {
    init(_props, cx) {
        const p = { ...(modProps() ?? {}), ...(_props ?? {}) };
        if (p.picker) {
            // This copy is the branch picker popup, not the panel.
            this.picker = new BranchPicker(p, cx);
            return;
        }
        if (p.push) {
            // This copy is the push confirm dialog, not the panel.
            this.dialog = new PushConfirm(p, cx);
            return;
        }
        this.repos = [];
        this.error = null;
        this.loaded = false;
        this.last = 0;
        this.filter = typeof p.filter === "string" ? p.filter : "";
        this.previewOpen = Array.isArray(p.open) ? p.open : [];
        this.opened = new Set(); // checkouts whose files are shown; files start folded, so every row is one line
        this.folds = foldMap(shared(FOLD_KEY));
        this.cleanOpen = false;
        this.hover = null; // the checkout row under the pointer
        this.activeRepo = null; // the keyboard-active checkout
        this.hoverFile = null; // the file row under the pointer
        this.confirm = null; // { key, repo, file, kind }: a discard waiting for its second click
        this.fetching = false; // the header's Fetch every repo
        this.fetchNote = null; // { text, at }: the last Fetch every repo
        this.notes = {}; // path -> { ok, message, at }: the last action's result there
        this.commits = new Map(); // path -> InputState of its commit message
        this.config = parseConfig(null);
        this.configAt = 0;
        this.follow = true;
        this.spaceId = undefined;
        this.claimed = new Map(); // path -> { on, token }: what this copy holds, to release on close
        this.refreshState = new RefreshState();
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.readGeneration = 0;
        this.lastTerminals = terminals();
        this.windowActive = window()?.active === true;
        this.width = 0;
        this.keys = cx.focus_handle();
        this.done = Number(shared(DONE)?.at ?? 0);
        this.view = null;
        this.input = InputState.new({ placeholder: "Filter repos and files" });
        if (this.filter) this.input.set_value(this.filter);
        this.input.on("change", (_e, cx) => {
            this.filter = this.input.value();
            this.rebuildView();
            cx.notify();
        });
        this.input.on("focus", (_e, cx) => {
            this.typing = true;
            cx.notify();
        });
        this.input.on("blur", (_e, cx) => {
            this.typing = false;
            cx.notify();
        });
        this.loadConfig(cx);
        this.initialRead(cx);
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** A first read that does not wait for the one-second timer; the timer only handles later triggers. */
    initialRead(cx) {
        this.locate();
        if (!this.loc?.root) return;
        this.seen = true;
        cx.spawn(async (cx) => {
            if (this.loc?.root) this.refresh(cx);
        });
    }

    /** The mode and folder to show. A space keeps its own choice in the mod's localStorage. */
    locate() {
        const space = spaces().find((s) => s.active)?.id ?? null;
        if (space !== this.spaceId) {
            this.spaceId = space;
            this.follow = localStorage.getItem(`follow.${space ?? "none"}`) !== "space";
        }
        const loc = location(this.follow),
            context = contextKeyOf(loc);
        if (context !== this.context) {
            // Another terminal, a `cd`, another space or the other mode. The old rows are dropped at once and the panel
            // shows its skeleton until the read for this context lands; everything belonging to the old folder is forgotten.
            this.context = context;
            this.readGeneration++;
            this.refreshState.cancel();
            this.loading = false;
            this.loadedContext = null;
            this.view = null;
            this.loaded = false;
            this.switching = true;
            badge(0);
            this.error = null;
            this.opened = new Set();
            this.confirm = null;
            this.notes = {};
            this.fetchNote = null;
            this.last = 0;
            this.contextChanged = true;
        }
        this.loc = loc;
        return context;
    }

    setFollow(follow, cx) {
        this.follow = follow;
        localStorage.setItem(`follow.${this.spaceId ?? "none"}`, follow ? "terminal" : "space");
        this.last = 0;
        this.refreshScheduler.trigger();
        cx.notify();
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < CONFIG_MS) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/jig-git/config.json`).catch(() => null);
            this.config = parseConfig(text);
            this.refreshScheduler.setSeconds(refreshSeconds(this.config));
            cx.notify();
        });
    }

    // Cheap check every second; the git work only runs while the panel is in view.
    // Not from render: refresh notifies, and render may not.
    tick(cx) {
        this.refreshState.tick(Date.now(), () => cx.notify());
        const done = shared(DONE);
        if (done && done.at > this.done) {
            // The branch picker or a push finished: say so under it, and read again now.
            this.done = done.at;
            this.notes[done.path] = { ok: true, message: done.message, at: Date.now() };
            this.last = 0;
            cx.notify();
        }
        const now = Date.now(),
            stale = Object.entries(this.notes).filter(([, n]) => n.ok && now - n.at > NOTE_MS);
        if (stale.length) {
            for (const [path] of stale) delete this.notes[path];
            cx.notify();
        }
        if (this.fetchNote && now - this.fetchNote.at > NOTE_MS) {
            this.fetchNote = null;
            cx.notify();
        }
        this.makeCommitBoxes(cx);
        const previous = this.context;
        this.locate();
        if (this.context !== previous || this.contextChanged) {
            this.contextChanged = false;
            this.refreshScheduler.trigger();
            this.refresh(cx);
            cx.notify();
        }
        this.loadConfig(cx);
        const seen = Boolean(this.loc?.root) && visible(),
            appeared = seen && !this.seen;
        this.seen = seen;
        if (!seen) return;
        if (appeared) this.refreshScheduler.trigger();
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        const currentTerminals = terminals();
        if (terminalFinished(this.lastTerminals, currentTerminals, this.loc?.root)) this.refreshScheduler.trigger();
        this.lastTerminals = currentTerminals;
        if (!this.loading && this.refreshScheduler.due()) this.refresh(cx, false, this.refreshScheduler.isBackstop());
    }

    // A commit message box for each checkout with staged files. Input states are made here, never in render.
    makeCommitBoxes(cx) {
        let made = false;
        for (const repo of this.repos ?? []) {
            if (!repo.staged || this.commits.has(repo.path)) continue;
            const state = InputState.new({ placeholder: "Commit message" }),
                hasMessage = { value: false };
            state.on("change", (_e, cx) => {
                const has = Boolean(state.value().trim());
                if (has !== hasMessage.value) {
                    hasMessage.value = has;
                    cx.notify();
                }
            });
            state.on("submit", (_e, cx) => {
                const now = this.repos.find((r) => r.path === repo.path);
                if (now) this.commitNow(cx, now);
            });
            this.commits.set(repo.path, state);
            made = true;
        }
        if (made) cx.notify();
    }

    /** The main checkouts on screen and the worktrees that are unfolded; folded worktrees wait for the backstop. */
    visibleTargets() {
        if (!this.loaded || !this.repos) return "";
        return groupRepos(this.repos)
            .flatMap((group) => [group.main, ...(this.foldedGroup(group) ? [] : group.worktrees)])
            .map((repo) => repo.path)
            .join("\n");
    }

    refresh(cx, user = false, full = false) {
        const { root, on } = this.loc,
            context = this.context;
        if (!root) {
            this.error = "No folder";
            this.switching = false;
            this.loading = false;
            return;
        }
        if (!this.refreshState.start({ user, first: !this.repos, notify: () => cx.notify() })) return;
        this.refreshScheduler.sweep();
        this.loading = true;
        const run = ++this.readGeneration;
        const targets = full ? "" : this.visibleTargets();
        cx.spawn(async (cx) => {
            try {
                const r = await runCommand(exec, "sh", ["-c", SCRIPT, "sh", root, targets], { on });
                if (run !== this.readGeneration || context !== this.context) return;
                if (r.code !== 0) throw Object.assign(new Error(r.stderr || `exit ${r.code}`), r);
                this.repos = parseRepos(r.stdout, root);
                if (this.previewOpen?.length) {
                    const wanted = new Set(this.previewOpen);
                    for (const repo of this.repos)
                        if (wanted.has(repo.name) || wanted.has(repo.path)) this.opened.add(repo.path);
                    this.previewOpen = null;
                }
                this.loadedRoot = root;
                this.loadedContext = context;
                this.rebuildView();
                this.error = null;
                this.loaded = true;
                this.switching = false;
                badge(this.repos.filter((x) => x.files.length).length);
            } catch (e) {
                if (run === this.readGeneration && context === this.context) {
                    this.error = friendlyError(e, { what: "Reading", follow: true });
                    this.switching = false;
                }
            } finally {
                if (run === this.readGeneration) {
                    this.loading = false;
                    const again = this.refreshState.finish();
                    this.last = again ? 0 : Date.now();
                    if (again) this.refreshScheduler.trigger();
                    cx.notify();
                }
            }
        });
        cx.notify();
    }

    /**
     * Herdr's exec on the space's machine, as the actions in lib.js take it. `env` and `timeout` go through one `sh`:
     * Herdr's own exec takes neither, and a network command must never wait on a prompt.
     */
    git() {
        const on = this.loc?.on ?? null;
        return networkExec(exec, on);
    }

    /** An agent working or blocked in a checkout, for the refusals of the actions that change its branch. */
    busy(repo) {
        return busyAgents(
            repo.path,
            panesOn(panes(), spaces(), this.loc?.on ?? null),
            this.repos.map((r) => r.path),
        );
    }

    /** Herdr's exec failure as one line: a stopped command says it was stopped. */
    failure(e, what) {
        return friendlyError(e, { what, follow: true });
    }

    /** What runs in this checkout now, from any copy of this mod (the panel and the push dialog share the lock), or null. */
    lock(repo) {
        return lockOf(shared(RUNNING_KEY) ?? {}, this.loc?.on ?? null, repo.path);
    }

    /** Takes this checkout's lock for one action: a token is written, then checked again after a short wait, so two
     * copies claiming at once cannot both act. Resolves with the token, or null when another action holds it. */
    async hold(repo, what) {
        const on = this.loc?.on ?? null,
            locks = shared(RUNNING_KEY) ?? {};
        if (lockOf(locks, on, repo.path)) return null;
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setShared(RUNNING_KEY, withLock(locks, on, repo.path, what, Date.now(), token));
        const wait = { cmd: "sh", args: ["-c", "sleep 0.15"] };
        await exec(wait.cmd, wait.args, { on }).catch(() => null);
        if (!holdsLock(shared(RUNNING_KEY) ?? {}, on, repo.path, token)) return null;
        this.claimed.set(repo.path, { on, path: repo.path, token });
        return token;
    }

    /** Releases only this copy's claim, on the machine it claimed on (the panel may have switched folders since). */
    release(repo, token) {
        const claim = this.claimed.get(repo.path);
        this.claimed.delete(repo.path);
        const on = claim?.on ?? this.loc?.on ?? null,
            path = claim?.path ?? repo.path,
            held = claim?.token ?? token;
        setShared(RUNNING_KEY, withoutLock(shared(RUNNING_KEY) ?? {}, on, path, Date.now(), held ?? null));
    }

    /** A claim whose liveness could not be checked stays: after a folder switch its machine is in the claim. */
    releaseAll() {
        for (const claim of this.claimed.values())
            setShared(
                RUNNING_KEY,
                withoutLock(shared(RUNNING_KEY) ?? {}, claim.on, claim.path, Date.now(), claim.token),
            );
        this.claimed.clear();
    }

    /** Runs one action in a checkout, notes a failure (or, unless quiet, the result) under it, and reads again at once.
     * `after` runs when it succeeded, still in this action's task. One action per checkout, never on a row that still
     * shows another folder. */
    act(cx, repo, fn, quiet = false, what = "Working", after = null) {
        if (!canRun(this.switching, this.lock(repo))) return;
        const git = this.git(),
            context = this.context;
        cx.spawn(async (cx) => {
            const token = await this.hold(repo, what);
            if (!token) return;
            let r;
            try {
                r = await fn(git);
            } catch (e) {
                r = { ok: false, message: this.failure(e, what) };
            }
            this.release(repo, token);
            if (context === this.context) {
                if (!r.ok || !quiet) {
                    this.notes[repo.path] = { ...r, at: Date.now() };
                    if (r.ok) {
                        const at = this.notes[repo.path].at;
                        cx.timer.after(4000, (cx) => {
                            if (this.notes[repo.path]?.at === at) {
                                delete this.notes[repo.path];
                                cx.notify();
                            }
                        });
                    }
                } else delete this.notes[repo.path];
                this.last = 0;
                this.refresh(cx, false, true);
                if (r.ok && after) after(cx);
            }
            cx.notify();
        });
        cx.notify();
    }

    configNetwork() {
        return {
            remote: this.config.remote,
            timeout: Math.max(5, this.config.networkTimeoutSeconds) * 1000,
        };
    }

    /** The push confirm: the branch, where it really goes, and the commits that will go, computed before anything runs. */
    openPush(cx, repo, what = "push") {
        if (!canRun(this.switching, this.lock(repo))) return;
        const git = this.git(),
            context = this.context,
            network = this.configNetwork();
        cx.spawn(async (cx) => {
            let r;
            try {
                r = await commitsToPush(git, { checkout: repo.path, remote: network.remote });
            } catch (e) {
                r = { ok: false, message: this.failure(e, "Reading the commits") };
            }
            if (context !== this.context) return;
            if (!r.ok) {
                this.notes[repo.path] = { ok: false, message: r.message, at: Date.now() };
                cx.notify();
                return;
            }
            openOverlay({
                mod: "jig-git",
                kind: "dialog",
                width: 440,
                props: {
                    push: {
                        on: this.loc?.on ?? null,
                        path: repo.path,
                        name: repo.name,
                        branch: r.branch,
                        remote: r.remote,
                        target: r.target,
                        targetBranch: r.targetBranch,
                        mode: r.mode,
                        reason: r.reason,
                        base: r.base,
                        commits: r.commits,
                        count: r.count,
                        more: r.more,
                        others: this.repos.map((x) => x.path),
                        timeout: network.timeout,
                        what,
                        // git is read again before the command: a `git switch` here must not be pushed silently.
                        expect: { branch: r.branch, remote: r.remote, target: r.target, mode: r.mode },
                    },
                },
            });
        });
        cx.notify();
    }

    commitNow(cx, repo, alsoPush = false) {
        const state = this.commits.get(repo.path),
            message = state?.value() ?? "";
        if (!message.trim() || !repo.staged || !canRun(this.switching, this.lock(repo))) return;
        this.act(
            cx,
            repo,
            async (git) => {
                const r = await commit(git, { checkout: repo.path, message });
                if (r.ok) state?.set_value("");
                return r;
            },
            false,
            "Committing",
            // The confirm reads the commits when it opens, after the commit.
            alsoPush ? (cx) => this.openPush(cx, repo, "commit-push") : null,
        );
    }

    /** One button-triggered action that touches the network. Fetch and pull run at once; push and publish ask first,
     * since they write to the remote. */
    syncNow(cx, repo, what) {
        if (this.switching) return;
        const network = this.configNetwork(),
            remote = network.remote,
            busy = this.busy(repo);
        if (what === "fetch")
            return this.act(
                cx,
                repo,
                (git) => fetchRemote(git, { checkout: repo.path, remote, busy, ...network }),
                false,
                "Fetching",
            );
        if (what === "pull")
            return this.act(
                cx,
                repo,
                (git) => pullFastForward(git, { checkout: repo.path, busy, ...network }),
                false,
                "Pulling",
            );
        // The dialog reads the real push target and shows it; `what` only names a commit-and-push.
        return this.openPush(cx, repo, what);
    }

    // A click on a file (working mode) or on a commits chip (branch mode, no file): show it in the repo's Review tab,
    // which is made on the first click and retargeted (shared state, then selected) on the next ones.
    review(repo, file, mode = "working") {
        if (this.switching) return;
        const { space, on } = this.loc,
            name = `Review · ${repo.name}`;
        const tab = spaces()
            .find((s) => s.id === space)
            ?.tabs.find((t) => t.name === name);
        if (!tab)
            return run("tab.new", {
                space,
                name,
                mod: "jig-review",
                props: { on, repo: repo.path, name: repo.name, file: file?.path, mode },
            });
        setShared("jig-review.open", { repo: repo.path, file: file?.path ?? null, mode, at: Date.now() });
        run("tab.select", { id: tab.id });
    }

    /** The branch picker, as a popup at the pointer. */
    openPicker(repo) {
        if (this.switching) return;
        openOverlay({
            mod: "jig-git",
            kind: "popup",
            width: 360,
            height: 440,
            props: {
                picker: {
                    on: this.loc.on,
                    path: repo.path,
                    name: repo.name,
                    others: this.repos.map((r) => r.path),
                },
            },
        });
    }

    /** Show or hide one checkout's files; they start hidden, so a list of ten repos is ten lines. */
    foldedGroup(group) {
        return isFolded(this.folds, group, this.loc?.root ?? "");
    }

    /** The chevron on a main checkout: fold or unfold its worktrees, and remember it for this repo path. */
    foldAll(cx) {
        const groups = groupRepos(this.repos);
        this.folds = withAllFolds(
            groups,
            groups.some((g) => !this.foldedGroup(g)),
        );
        setShared(FOLD_KEY, this.folds);
        cx.notify();
    }

    checkbox(t, repo, f) {
        const state = f.staged ? (f.unstaged ? "some" : "all") : "none";
        const disabled = this.switching || Boolean(this.lock(repo));
        const tip =
            state === "all"
                ? "Staged · click to unstage"
                : state === "some"
                  ? "Partly staged · click to stage the rest"
                  : "Click to stage";
        return div()
            .id(`stage-${repo.path}/${f.path}`)
            .flex_none()
            .w(14)
            .h(14)
            .flex()
            .items_center()
            .justify_center()
            .rounded(3)
            .border_1()
            .border_color(state === "none" ? t.border : t.accent)
            .when(state === "all", (el) => el.bg(t.accent))
            .text_color(state === "all" ? t.accent_foreground : t.accent)
            .text_size(10)
            .when(disabled, (el) => el.opacity(0.5))
            .when(!disabled, (el) =>
                el
                    .cursor_pointer()
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .on_click((_e, cx) => {
                        cx.stop_propagation();
                        const args = { checkout: repo.path, file: f.path };
                        this.act(
                            cx,
                            repo,
                            (git) => (state === "all" ? unstageFile(git, args) : stageFile(git, args)),
                            true,
                            state === "all" ? "Unstaging" : "Staging",
                        );
                    }),
            )
            .tooltip(tip)
            .child(state === "all" ? svg(ICON("check")).size(10) : state === "some" ? "–" : "");
    }

    // A file row, and under it the discard confirm when one is waiting.
    fileRows(t, repo, f, indent) {
        const { dir, name } = splitPath(f.path);
        const key = `${repo.path}/${f.path}`;
        const color = statusColour(t, f.status);
        const kind = discardKind(f.xy);
        const row = h_flex()
            .id(`file-${key}`)
            .h(24)
            .flex_none()
            .pl(24 + indent)
            .pr(6)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_hover((on, cx) => {
                this.hoverFile = on ? key : this.hoverFile === key ? null : this.hoverFile;
                cx.notify();
            })
            .on_click(() => this.review(repo, f))
            .child(this.checkbox(t, repo, f))
            .child(div().w(14).flex_none().text_size(11).text_color(color).child(f.status))
            .child(
                h_flex()
                    .flex_1()
                    .min_w(0)
                    .text_size(12.5)
                    .child(div().min_w(0).text_ellipsis_middle().text_color(t.dim).child(dir))
                    .child(div().flex_none().max_w(260).text_ellipsis_middle().tooltip(f.path).child(name)),
            )
            .when(!f.path.endsWith("/"), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .when(this.hoverFile === key, (e) =>
                            e.child(
                                iconButton(
                                    t,
                                    `discard-${key}`,
                                    div().text_size(13).child("↺"),
                                    kind === "delete" ? "Delete this new file…" : "Discard changes…",
                                    (cx) => {
                                        this.confirm = { key, kind };
                                        cx.notify();
                                    },
                                    Boolean(this.lock(repo)) || this.switching,
                                ),
                            ),
                        )
                        .when(this.hoverFile !== key, (e) => e.w(22)),
                ),
            );
        if (this.confirm?.key !== key) return [row];
        const text =
            kind === "delete"
                ? `${f.path} is not in the last commit: it will be DELETED from disk.`
                : `Discard every change to ${f.path}? It goes back to the last commit.`;
        const confirm = v_flex()
            .flex_none()
            .pl(48 + indent)
            .pr(8)
            .py(4)
            .gap(6)
            .text_size(11.5)
            .child(
                div()
                    .text_color(kind === "delete" ? t.blocked : t.muted)
                    .child(text),
            )
            .child(
                h_flex()
                    .gap(6)
                    .justify_end()
                    .child(
                        textButton(t, `discard-no-${key}`, "Cancel", (cx) => {
                            this.confirm = null;
                            cx.notify();
                        }),
                    )
                    .child(
                        textButton(
                            t,
                            `discard-yes-${key}`,
                            kind === "delete" ? "Delete file" : "Discard",
                            (cx) => {
                                this.confirm = null;
                                this.act(
                                    cx,
                                    repo,
                                    (git) => discardFile(git, { checkout: repo.path, file: f.path, expect: kind }),
                                    false,
                                    "Discarding",
                                );
                            },
                            true,
                        ),
                    ),
            );
        return [row, confirm];
    }

    commitBox(t, repo, indent) {
        const state = this.commits.get(repo.path);
        const enabled = Boolean(state?.value().trim()) && repo.staged > 0 && !this.lock(repo) && !this.switching;
        const wide = !commitRowStacked(this.width);
        const tip = `Commit the ${plural(repo.staged, "staged file")} (git commit -m)`;
        const field = () =>
            div()
                .id(`message-${repo.path}`)
                .h(26)
                .px(8)
                .flex()
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .cursor_text()
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
        const buttons = () => [
            textButton(
                t,
                `commit-${repo.path}`,
                `Commit ${repo.staged}`,
                (cx) => this.commitNow(cx, repo),
                false,
                !enabled,
                `${tip} · Ctrl+Enter`,
            ),
            textButton(
                t,
                `commit-push-${repo.path}`,
                wide ? "Commit & Push" : "Push",
                (cx) => this.commitNow(cx, repo, true),
                false,
                !enabled,
                "Commit, then confirm the push",
            ),
        ];
        const row = (payload) =>
            payload
                .flex_none()
                .pl(24 + indent)
                .pr(6)
                .py(4)
                .track_focus(this.keys)
                .on_key_down((e, cx) => {
                    if (e.key === "enter" && (e.modifiers.control || e.modifiers.platform)) {
                        cx.stop_propagation();
                        this.commitNow(cx, repo);
                    }
                });
        // At 300 px the message gets its own full-width line and the buttons go under it; above that one row.
        return wide
            ? row(h_flex()).gap(6).items_center().child(field().flex_1().min_w(0)).children(buttons())
            : row(v_flex()).gap(6).child(field()).child(h_flex().gap(6).justify_end().children(buttons()));
    }

    /** A repo as the kit's 48 px row; opening it shows files, commit box and actions. */
    kitCheckout(t, repo, color, nested, group, dir) {
        const open = this.opened.has(repo.path),
            detail = checkoutDetail(repo);
        const locked = this.lock(repo);
        const actions = repoActions(repo);
        const details = () =>
            v_flex()
                .p(8)
                .gap(6)
                .when(isDiverged(repo), (el) =>
                    el.child(div().text_size(11).text_color(t.blocked).child("Diverged · pull fast-forwards only")),
                )
                .children(repo.files.flatMap((file) => this.fileRows(t, repo, file, nested ? 16 : 0)))
                .when(repo.total > repo.files.length, (el) =>
                    el.child(
                        div()
                            .pl(12)
                            .text_size(11)
                            .text_color(t.dim)
                            .child(`+${repo.total - repo.files.length} more`),
                    ),
                )
                .when(repo.staged > 0 && this.commits.has(repo.path), (el) => el.child(this.commitBox(t, repo, 0)))
                .when(this.confirm?.key === `all:${repo.path}`, (el) =>
                    el
                        .child(
                            div()
                                .text_size(12)
                                .text_color(t.blocked)
                                .child(
                                    `Discard all ${repo.files.length} changed files in ${repo.name}? Untracked files are deleted.`,
                                ),
                        )
                        .child(
                            h_flex()
                                .gap(6)
                                .justify_end()
                                .child(
                                    secondaryButton(
                                        t,
                                        `discard-all-no-${repo.path}`,
                                        "Cancel",
                                        (cx) => {
                                            this.confirm = null;
                                            cx.notify();
                                        },
                                        { h: 26 },
                                    ),
                                )
                                .child(
                                    dangerButton(
                                        t,
                                        `discard-all-yes-${repo.path}`,
                                        "Discard all",
                                        (cx) => this.discardAll(repo, cx),
                                        { h: 26 },
                                    ),
                                ),
                        ),
                )
                .child(
                    h_flex()
                        .gap(6)
                        .justify_end()
                        .flex_wrap()
                        .when(Boolean(locked), (el) => el.child(busyButton(t, `busy-${repo.path}`, `${locked.what}…`)))
                        .child(
                            primaryButton(t, `commit-${repo.path}`, "Commit", (cx) => this.commitNow(cx, repo), {
                                h: 26,
                                disabled: Boolean(locked),
                            }),
                        )
                        .when(actions.includes("pull"), (el) =>
                            el.child(
                                secondaryButton(
                                    t,
                                    `pull-${repo.path}`,
                                    "Pull",
                                    (cx) => this.syncNow(cx, repo, "pull"),
                                    {
                                        h: 26,
                                        disabled: Boolean(locked),
                                    },
                                ),
                            ),
                        )
                        .when(actions.includes("push") || actions.includes("publish"), (el) =>
                            el.child(
                                secondaryButton(
                                    t,
                                    `push-${repo.path}`,
                                    actions.includes("push") ? "Push" : "Publish",
                                    (cx) => this.syncNow(cx, repo, "push"),
                                    { h: 26, disabled: Boolean(locked) },
                                ),
                            ),
                        )
                        .when(actions.includes("fetch"), (el) =>
                            el.child(
                                secondaryButton(
                                    t,
                                    `fetch-${repo.path}`,
                                    "Fetch",
                                    (cx) => this.syncNow(cx, repo, "fetch"),
                                    {
                                        h: 26,
                                        disabled: Boolean(locked),
                                    },
                                ),
                            ),
                        )
                        .child(
                            secondaryButton(t, `branch-${repo.path}`, "Branch", (cx) => this.openPicker(repo, cx), {
                                h: 26,
                                disabled: Boolean(locked),
                            }),
                        )
                        .child(
                            dangerButton(t, `discard-${repo.path}`, "Discard all…", (cx) => this.confirmAll(repo, cx), {
                                h: 26,
                                disabled: Boolean(locked),
                            }),
                        ),
                );
        return row(t, {
            id: repo.path,
            color: locked ? t.working : color,
            active: this.activeRepo === repo.path,
            title: `${"  ".repeat(nested ? 1 : 0)}${
                dir
                    ? `${dir}/${rowName(repo, { main: nested ? group.main : null }).name}`
                    : rowName(repo, { main: nested ? group.main : null }).name
            }`,
            detail,
            open,
            onToggle: (cx) => {
                if (open) this.opened.delete(repo.path);
                else this.opened.add(repo.path);
                cx.notify();
            },
            details: open ? details() : null,
        });
    }

    /** Inline confirm for the bulk discard. Each file still goes through discardFile's own check. */
    confirmAll(repo, cx) {
        if (!repo.files.length) return;
        this.confirm = { key: `all:${repo.path}`, kind: "all" };
        cx.notify();
    }

    discardAll(repo, cx) {
        this.confirm = null;
        this.act(
            cx,
            repo,
            async (git) => {
                for (const file of repo.files)
                    await discardFile(git, { checkout: repo.path, file: file.path, expect: discardKind(file.xy) });
                return { ok: true, message: `Discarded ${repo.files.length} files.` };
            },
            false,
            "Discarding",
        );
    }

    /** Grouping and the main lookup change only when the data or filter changes. */
    rebuildView() {
        const all = this.repos.length ? groupRepos(this.repos) : [];
        const groups = filterGroups(all, this.filter);
        const repos = groups.flatMap((g) => [g.main, ...g.worktrees]);
        this.view = {
            groups,
            states: groupCheckouts(repos),
            mains: new Map(groups.map((g) => [g.main.path, g.main])),
            changed: repos.filter((r) => r.files.length).length,
        };
    }

    // The list: checkout groups, with a worktree indented under its main row.
    list(t) {
        const context = viewForContext(this.context, this.loadedContext, this.repos, {
            error: this.error,
            noFolder: !this.loc?.root,
        });
        if (context.pending) return [skeleton(t)];
        if (!this.view) this.rebuildView();
        const groups = this.view.groups,
            states = this.view.states,
            tags = disambiguators(
                this.repos.map((repo) => ({ path: repo.path, name: rowName(repo, { main: null }).name })),
            ),
            items = [];
        const specs = [
            ["needs", "Needs you", t.ansi1],
            ["changed", "Changed", t.accent],
            ["ahead", "Ahead or behind", t.ansi3],
            ["clean", "Clean", t.muted],
        ];
        for (const [key, label, color] of specs) {
            const rows = states[key];
            if (!rows.length) continue;
            const visibleGroups = specs.filter(([id]) => states[id].length).length;
            const folded = key === "clean" && !this.filter.trim() && !groupOpen(this.cleanOpen, visibleGroups - 1);
            const one = key === "changed" && groups.length === 1;
            const action =
                key === "changed" && one
                    ? secondaryButton(
                          t,
                          "stage-all-group",
                          "Stage all",
                          (cx) => {
                              const repo = rows[0];
                              this.act(cx, repo, (git) => stageAll(git, { checkout: repo.path }), true, "Staging");
                          },
                          { h: 26 },
                      )
                    : key === "ahead"
                      ? secondaryButton(t, "fetch-group", "Fetch", (cx) => this.fetchAll(cx), { h: 26 })
                      : key === "clean" && visibleGroups > 1
                        ? secondaryButton(
                              t,
                              "toggle-clean",
                              folded ? "Show" : "Hide",
                              (cx) => {
                                  this.cleanOpen = !this.cleanOpen;
                                  cx.notify();
                              },
                              { h: 26 },
                          )
                        : null;
            items.push(groupHeader(t, key, label, rows.length, color, action));
            if (folded) continue;
            for (const repo of rows) {
                const main = this.view.mains.get(repo.main);
                const parent = repo.linked ? (main ?? null) : null;
                items.push(
                    this.kitCheckout(
                        t,
                        repo,
                        color,
                        Boolean(parent),
                        parent ?? { main: repo, worktrees: [] },
                        tags.get(repo.path) ?? null,
                    ),
                );
            }
        }
        return items.length ? items : [emptyLine(this.emptyState(null) ?? "No repos here.", t)];
    }

    /** The header's fold-all button: fold every repo, or unfold every repo when any is folded. */
    foldAllButton(t, groups) {
        const anyOpen = groups.some((g) => !this.foldedGroup(g));
        return iconButton(
            t,
            "fold-all",
            ICON(anyOpen ? "chevron-down" : "chevron-right"),
            anyOpen ? "Fold all repos" : "Unfold all repos",
            (cx) => this.foldAll(cx),
        );
    }

    /** The header's follow toggle: what the panel follows, and a click to swap it for this space. */
    close() {
        this.releaseAll();
    }

    /** Where the list looks, and the empty states that say what to do about it. `there` is the folder Space mode
     * would list: another place to look when this one holds nothing. */
    emptyState(there) {
        if (!this.loc?.root) return "No folder here: open a terminal, or pick a space with one.";
        if (!this.loaded) return this.error ? null : "Reading repos…";
        if (this.filter.trim()) return "No repo or file matches.";
        if (this.repos.length) return null;
        const other = there && there !== this.loc.root;
        if (this.follow)
            return other
                ? "Not a git repository here — cd into one, or list the space's folder."
                : "No git repo in this folder. Open a terminal in one, or switch to Space.";
        return "No git repo in this folder. Open a terminal in one, or switch to Space.";
    }

    render(cx) {
        if (this.picker) return this.picker.render(cx);
        if (this.dialog) return this.dialog.render(cx);
        const t = theme();
        this.locate();
        if (!this.view) this.rebuildView();
        const loc = this.loc,
            groups = this.view.groups,
            trees = this.repos.length - groups.length;
        const changed = this.view.changed;
        // A narrow header keeps the folder's name: the worktree count goes first.
        const compact = this.width > 0 && this.width < 520;
        const summary = this.loaded
            ? [
                  plural(groups.length, "repo"),
                  trees && !compact ? plural(trees, "worktree") : null,
                  `${changed} changed`,
              ]
                  .filter(Boolean)
                  .join(" · ")
            : "";
        const pending = viewForContext(this.context, this.loadedContext, this.repos, {
            error: this.error,
            noFolder: !loc.root,
        }).pending;
        const items = this.list(t);
        // Space mode's folder: the other place to look when following a terminal lands nowhere.
        const there = location(false).root;
        const empty = items.length ? null : this.emptyState(there);
        const latest = Object.entries(this.notes).sort((a, b) => b[1].at - a[1].at)[0];
        const note = latest
            ? {
                  text: `${this.repos.find((r) => r.path === latest[0])?.name ?? latest[0]}: ${latest[1].message}`,
                  tone: latest[1].ok ? "done" : "error",
                  onDismiss: latest[1].ok
                      ? undefined
                      : (cx) => {
                            delete this.notes[latest[0]];
                            cx.notify();
                        },
              }
            : null;
        const status =
            note ??
            (this.fetchNote
                ? { text: this.fetchNote.text, tone: "done" }
                : this.error
                  ? { text: this.error, tone: "error" }
                  : null);
        return v_flex()
            .id("jig-git")
            .size_full()
            .min_h(0)
            .rounded(10)
            .overflow_hidden()
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .text_size(13)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            })
            .child(
                panelHeader(t, {
                    title: "Git",
                    titleTooltip: loc.root || "No folder",
                    readAt: this.last,
                    busy: this.refreshState.busy,
                    onRefresh: (cx) => {
                        this.last = 0;
                        this.refresh(cx, true, true);
                    },
                    refreshIcon: OWN("refresh"),
                    extra: [
                        groups.length > 1 ? this.foldAllButton(t, groups) : null,
                        this.repos.some((r) => r.remote)
                            ? iconButton(
                                  t,
                                  "repos-fetch-all",
                                  OWN("fetch"),
                                  "Fetch every repo from its remote",
                                  (cx) => this.fetchAll(cx),
                                  this.fetching || this.switching || this.repos.some((r) => this.lock(r)),
                              )
                            : null,
                    ].filter(Boolean),
                }),
            )
            .child(
                contextCard(t, {
                    name: loc.root ? lastSegment(loc.root) || "/" : "No folder",
                    follow: this.follow,
                    onFollow: (cx) => this.setFollow(!this.follow, cx),
                    machine: loc.on ?? null,
                }),
            )
            .when(Boolean(this.error), (el) => el.child(panelError(t, this.error)))
            .when(Boolean(summary) || this.switching || this.fetching || Boolean(this.fetchNote), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .px(12)
                        .py(2)
                        .text_size(10.5)
                        .text_color(t.muted)
                        .truncate()
                        .child(
                            this.switching
                                ? "Reading…"
                                : this.fetching
                                  ? "Fetching…"
                                  : this.fetchNote
                                    ? this.fetchNote.text
                                    : summary,
                        ),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .p(8)
                    .pb(4)
                    .child(
                        div()
                            .id("repos-filter")
                            .h(30)
                            .px(10)
                            .flex()
                            .items_center()
                            .rounded(8)
                            .border_1()
                            .border_color(this.typing ? t.accent : t.border)
                            .cursor_text()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground)),
                    ),
            )
            .child(
                v_flex()
                    .id("repos-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
                    .track_focus(this.keys)
                    .on_key_down((e, cx) => {
                        const ids = Object.values(this.view.states)
                            .flat()
                            .map((r) => r.path);
                        if (e.key === "up" || e.key === "down") {
                            this.activeRepo = moveActive(ids, this.activeRepo, e.key === "up" ? -1 : 1);
                            cx.stop_propagation();
                            cx.notify();
                        } else if ((e.key === "enter" || e.key === "space") && this.activeRepo) {
                            if (this.opened.has(this.activeRepo)) this.opened.delete(this.activeRepo);
                            else this.opened.add(this.activeRepo);
                            cx.stop_propagation();
                            cx.notify();
                        } else if (e.key === "escape") {
                            this.opened.clear();
                            this.activeRepo = null;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    })
                    .when(Boolean(empty), (el) =>
                        el.child(
                            v_flex()
                                .p(8)
                                .gap(8)
                                .text_color(t.dim)
                                .child(empty)
                                .when(this.follow && Boolean(there) && there !== loc.root, (e) =>
                                    e.child(
                                        textButton(t, "use-space-folder", "Use Space folder", (cx) =>
                                            this.setFollow(false, cx),
                                        ),
                                    ),
                                ),
                        ),
                    )
                    .children(items),
            )
            .when(Boolean(status), (el) => el.child(statusLine(t, status)))
            .child(
                footer(t, {
                    summary: (() => {
                        if (pending) return loc.root ? lastSegment(loc.root) || "/" : "";
                        const focused = focusedCheckout(this.repos, loc?.root ?? "");
                        const repo = this.repos.find((r) => r.path === focused) ?? this.repos[0];
                        if (!repo) return "No repositories here";
                        return [
                            repo.name,
                            repo.branch,
                            badgeText(repo),
                            repo.total ? `${repo.total} uncommitted` : null,
                        ]
                            .filter(Boolean)
                            .join(" · ");
                    })(),
                    action: null,
                }),
            );
    }

    /** Fetch every repo that has the remote, one after another, and say how many moved. */
    fetchAll(cx) {
        if (this.fetching || this.switching) return;
        const repos = this.repos.filter((r) => r.remote);
        if (!repos.length) return;
        this.fetching = true;
        const git = this.git(),
            context = this.context,
            network = this.configNetwork();
        cx.spawn(async (cx) => {
            let ok = 0,
                failed = 0;
            for (const repo of repos) {
                // One checkout at a time, and never one a panel action or a dialog already holds. hold() is async: awaiting
                // it is what makes the skip real, and the release carries its token so it cannot drop another's claim.
                const token = await this.hold(repo, "Fetching");
                if (!token) continue;
                try {
                    const r = await fetchRemote(git, { checkout: repo.path, remote: network.remote, ...network });
                    if (r.ok) ok++;
                    else failed++;
                } catch {
                    failed++;
                } finally {
                    this.release(repo, token);
                }
            }
            this.fetching = false;
            if (context === this.context) {
                this.fetchNote = {
                    text: failed ? `Fetched ${ok}, ${failed} failed` : `Fetched ${plural(ok, "repo")}`,
                    at: Date.now(),
                };
                this.last = 0;
                this.refresh(cx, false, true);
            }
            cx.notify();
        });
        cx.notify();
    }
}
