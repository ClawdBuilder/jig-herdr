// Every git checkout under the folder the focused terminal is in (or the space's folder: the header's toggle), with their
// changes and what is waiting on origin: a VS Code-style source control list. A main checkout shows its linked worktrees
// under it as "↳ <folder>" rows. One shell script per refresh reads them all (see lib.js); a click on a file opens it in a
// full-size Review tab (see ../repo-review).
// Git actions, all in lib.js and each refreshing the list at once: a checkbox per file stages or unstages it, hover
// buttons stage or unstage a checkout's files and discard one file (after an inline confirm), a message box commits the
// staged files (Commit & Push too), and the branch chip opens the branch picker (picker.js). Fetch and Pull run at once;
// Push and Publish ask first in a dialog that shows the destination git will really use (push.js). There is no Sync: a
// branch both ahead and behind is diverged, where a fast-forward pull always fails. Every network command runs with no
// prompt, under a timeout, and only one action at a time can hold a checkout.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
    spaces,
    panes,
    focused,
    terminals,
    exec,
    run,
    theme,
    layout,
    shared,
    setShared,
    openOverlay,
    appHome,
    readTextFile,
    props as modProps,
} from "herdr";
import {
    SCRIPT,
    CAP,
    parseRepos,
    groupRepos,
    filterGroups,
    isClean,
    aheadChip,
    splitPath,
    pickRoot,
    panesOn,
    ago,
    busyAgents,
    parseConfig,
    commitsToPush,
    pushTarget,
    FOLD_KEY,
    rowName,
    disambiguators,
    branchLabel,
    branchMatchesName,
    foldMap,
    isFolded,
    withFold,
    withAllFolds,
    focusedCheckout,
    showsCommit,
    badgeText,
    isDiverged,
    worktreeSignal,
    divergedText,
    rowActions,
    holdsLock,
    fetchRemote,
    canRun,
    commitRowStacked,
    lockOf,
    withLock,
    withoutLock,
    RUNNING_KEY,
    wrapperScript,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardFile,
    discardKind,
    commit,
    pullFastForward,
} from "./lib.js";
import { shown } from "./layout.js";
import { BranchPicker, DONE } from "./picker.js";
import { PushConfirm } from "./push.js";

// Herdr can only watch folders on this computer, so a space on another machine is polled. All repos
// take well under a second, so poll often, and at once when a terminal or agent changes state
// (an agent finishing a turn, a command ending): that's when files change.
const EVERY = 5000; // refresh period while the panel is in view
const NOTE_MS = 12000; // how long an action's result stays under its checkout
const CONFIG_MS = 60000; // how long config.json is trusted before it is read again
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const visible = () => shown(layout(), "repo-changes");
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const OWN = (name) => `mods/repo-changes/${name}.svg`;
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
    if (JSON.stringify(shared("badge.repo-changes")) !== JSON.stringify(value)) setShared("badge.repo-changes", value);
}

/** A small square icon or glyph button that stops the click from reaching the row under it. */
function iconButton(t, id, content, tip, onClick, disabled = false) {
    return div()
        .id(id)
        .flex_none()
        .w(22)
        .h(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(disabled ? t.dim : t.muted)
        .when(disabled, (el) => el.opacity(0.45))
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
        const p = modProps() ?? {};
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
        this.filter = "";
        this.opened = new Set(); // checkouts whose files are shown; files start folded, so every row is one line
        this.folds = foldMap(shared(FOLD_KEY));
        this.cleanOpen = false;
        this.hover = null; // the checkout row under the pointer
        this.hoverFile = null; // the file row under the pointer
        this.confirm = null; // { key, repo, file, kind }: a discard waiting for its second click
        this.fetching = false; // the header's Fetch every checkout
        this.fetchNote = null; // { text, at }: the last Fetch every checkout
        this.notes = {}; // path -> { ok, message, at }: the last action's result there
        this.commits = new Map(); // path -> InputState of its commit message
        this.config = parseConfig(null);
        this.configAt = 0;
        this.follow = true;
        this.spaceId = undefined;
        this.targets = new Map(); // path -> pushTarget, for the row's Push/Publish label
        this.claimed = new Map(); // path -> { on, token }: what this copy holds, to release on close
        this.targetsAt = 0;
        this.targetsLoading = false;
        this.width = 0;
        this.keys = cx.focus_handle();
        this.done = Number(shared(DONE)?.at ?? 0);
        this.input = InputState.new({ placeholder: "Filter repos and files" });
        this.input.on("change", (_e, cx) => {
            this.filter = this.input.value();
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
        cx.timer.every(1000, (cx) => this.tick(cx));
    }

    /** The mode and folder to show. A space keeps its own choice in the mod's localStorage. */
    locate() {
        const space = spaces().find((s) => s.active)?.id ?? null;
        if (space !== this.spaceId) {
            this.spaceId = space;
            this.follow = localStorage.getItem(`follow.${space ?? "none"}`) !== "space";
        }
        const loc = location(this.follow),
            context = JSON.stringify([loc.root, loc.on, loc.follow]);
        if (context !== this.context) {
            // Another terminal, a `cd`, another space or the other mode. The rows on screen stay until the new ones
            // arrive, so nothing blinks; everything that belongs to the old folder is forgotten now.
            this.context = context;
            this.loaded = false;
            this.error = null;
            this.opened = new Set();
            this.confirm = null;
            this.notes = {};
            this.fetchNote = null;
            this.targets = new Map();
            this.targetsAt = 0;
            this.last = 0;
            this.again = false;
            this.switching = true;
        }
        this.loc = loc;
        return context;
    }

    setFollow(follow, cx) {
        this.follow = follow;
        localStorage.setItem(`follow.${this.spaceId ?? "none"}`, follow ? "terminal" : "space");
        this.last = 0;
        cx.notify();
    }

    loadConfig(cx) {
        if (this.configAt && Date.now() - this.configAt < CONFIG_MS) return;
        this.configAt = Date.now();
        cx.spawn(async (cx) => {
            const text = await readTextFile(`${appHome()}/mods/repo-changes/config.json`).catch(() => null);
            this.config = parseConfig(text);
            cx.notify();
        });
    }

    // Cheap check every second; the git work only runs while the panel is in view.
    // Not from render: refresh notifies, and render may not.
    tick(cx) {
        const done = shared(DONE);
        if (done && done.at > this.done) {
            // The branch picker or a push finished: say so under it, and read again now.
            this.done = done.at;
            this.notes[done.path] = { ok: true, message: done.message, at: Date.now() };
            this.last = 0;
            cx.notify();
        }
        const now = Date.now(),
            stale = Object.entries(this.notes).filter(([, n]) => now - n.at > NOTE_MS);
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
        if (this.context !== previous) cx.notify();
        this.loadConfig(cx);
        const seen = Boolean(this.loc?.root) && visible(),
            appeared = seen && !this.seen;
        this.seen = seen;
        if (!seen) return;
        const states = terminals()
            .map((t) => `${t.address}:${t.status}`)
            .join(" ");
        const changed = this.states !== undefined && states !== this.states;
        this.states = states;
        if (!this.loaded || appeared || changed || now - this.last >= EVERY) this.refresh(cx);
        if (this.loaded) this.loadTargets(cx);
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

    refresh(cx) {
        if (this.loading) {
            this.again = true;
            return;
        }
        const { root, on } = this.loc,
            context = this.context;
        if (!root) {
            this.error = "No folder";
            return;
        }
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const r = await exec("sh", ["-c", SCRIPT, "sh", root], { on });
                if (context !== this.context) return;
                if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n")[0]);
                this.repos = parseRepos(r.stdout, root);
                this.error = null;
                this.loaded = true;
                this.switching = false;
                badge(this.repos.filter((x) => x.files.length).length);
            } catch (e) {
                if (context === this.context) this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                this.last = this.again ? 0 : Date.now();
                this.again = false;
                cx.notify();
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
        return (cmd, args, options = {}) => {
            if (!options.env && !options.timeout) return exec(cmd, args, { cwd: options.cwd, on });
            return exec("sh", ["-c", wrapperScript(options.env, options.timeout), "sh", cmd, ...args], {
                cwd: options.cwd,
                on,
            });
        };
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
        const said = String(e?.message ?? e).split("\n")[0];
        return /timed? ?out|timeout|took too long|abort|cancel/i.test(said)
            ? `${what} took too long and was stopped. Check the connection, or use a terminal.`
            : said;
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
                if (!r.ok || !quiet) this.notes[repo.path] = { ...r, at: Date.now() };
                else delete this.notes[repo.path];
                if (r.ok && ["Fetching", "Pulling", "Pushing", "Publishing"].includes(what)) {
                    this.targets.delete(repo.path);
                    this.targetsAt = 0;
                }
                this.last = 0;
                this.refresh(cx);
                if (r.ok && after) after(cx);
            }
            cx.notify();
        });
        cx.notify();
    }

    /** The push target of every checkout, cached for half a minute: the row's button follows git's own settings, like
     * the dialog does. Read locally, never on the network. */
    loadTargets(cx) {
        if (this.targetsLoading || Date.now() - this.targetsAt < 30000) return;
        const repos = (this.repos ?? []).filter((r) => r.remote);
        if (!repos.length) return;
        this.targetsLoading = true;
        this.targetsAt = Date.now();
        const git = this.git(),
            context = this.context,
            remote = this.config.remote;
        cx.spawn(async (cx) => {
            const found = new Map(this.targets);
            for (const repo of repos) {
                try {
                    found.set(repo.path, await pushTarget(git, { checkout: repo.path, remote }));
                } catch {
                    // a checkout that cannot be read keeps its last answer
                }
            }
            this.targetsLoading = false;
            if (context === this.context) {
                this.targets = found;
                cx.notify();
            }
        });
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
                mod: "repo-changes",
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
                mod: "repo-review",
                props: { on, repo: repo.path, name: repo.name, file: file?.path, mode },
            });
        setShared("repo-review.open", { repo: repo.path, file: file?.path ?? null, mode, at: Date.now() });
        run("tab.select", { id: tab.id });
    }

    /** The branch picker, as a popup at the pointer. */
    openPicker(repo) {
        if (this.switching) return;
        openOverlay({
            mod: "repo-changes",
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
    toggleFiles(path, cx) {
        if (!this.opened.delete(path)) this.opened.add(path);
        cx.notify();
    }

    /** Whether this group's worktrees are folded away now: the person's stored choice, else the default. */
    foldedGroup(group) {
        return isFolded(this.folds, group, this.loc?.root ?? "");
    }

    /** The chevron on a main checkout: fold or unfold its worktrees, and remember it for this repo path. */
    foldGroup(group, cx) {
        this.folds = withFold(this.folds, group, !this.foldedGroup(group));
        setShared(FOLD_KEY, this.folds);
        cx.notify();
    }

    /** The header button: fold every group, or unfold every group when any is folded. */
    foldAll(cx) {
        const groups = groupRepos(this.repos);
        this.folds = withAllFolds(
            groups,
            groups.some((g) => !this.foldedGroup(g)),
        );
        setShared(FOLD_KEY, this.folds);
        cx.notify();
    }

    hovering(path) {
        return (on, cx) => {
            this.hover = on ? path : this.hover === path ? null : this.hover;
            cx.notify();
        };
    }

    // The name: the folder's own (shortened for a worktree), the collision tag, then the folded-worktree count or the
    // file fold (chevron + count) where they belong, beside the name.
    nameCell(t, repo, nested, dir, group, tip, folded, signal, files, maxName) {
        const { name } = rowName(repo, { main: nested ? group.main : null, dir }),
            clean = !repo.files.length && !repo.base,
            trees = nested ? 0 : group.worktrees.length;
        return h_flex()
            .flex_none()
            .min_w(0)
            .gap(4)
            .items_center()
            .overflow_hidden()
            .child(
                div()
                    .min_w(24)
                    .max_w(maxName)
                    .truncate()
                    .when(!nested, (el) => el.font_semibold())
                    .when(nested, (el) => el.text_color(t.muted))
                    .when(clean && !nested, (el) => el.text_color(t.muted))
                    .tooltip(tip)
                    .child(name),
            )
            .when(Boolean(dir), (el) =>
                el.child(div().flex_none().max_w(46).truncate().text_size(9.5).text_color(t.dim).child(dir)),
            )
            .when(folded && trees > 0, (el) =>
                el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(String(trees))),
            )
            .when(signal, (el) => el.child(div().flex_none().text_size(8).text_color(t.blocked).child("●")))
            .when(Boolean(files), (el) =>
                el.child(
                    h_flex()
                        .flex_none()
                        .gap(1)
                        .items_center()
                        .cursor_pointer()
                        .rounded(4)
                        .px(2)
                        .hover((sp) => sp.bg(t.raised))
                        .tooltip(files.open ? "Hide files" : "Show files")
                        .on_mouse_down("left", (_e, cx) => cx.stopPropagation())
                        .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.toggleFiles(repo.path, cx);
                        })
                        .child(svg(ICON(files.open ? "chevron-down" : "chevron-right")).size(9))
                        .child(div().text_size(9.5).text_color(t.dim).child(String(files.total))),
                ),
            );
    }

    // The branch chip (a click opens the picker): the conventional prefix as one dim word on wide panels, and the rest
    // cut from the left so its end (the ticket number) always survives.
    branchChip(t, repo, repeatsName = false) {
        const label = branchLabel(repo.branch, { lead: this.width >= 480 }),
            iconOnly = repeatsName || this.width === 0 || this.width < 240;
        if (iconOnly)
            return h_flex()
                .id(`branch-${repo.path}`)
                .flex_none()
                .w(22)
                .h(18)
                .items_center()
                .justify_center()
                .rounded(5)
                .cursor_pointer()
                .text_color(repo.detached ? t.dim : t.muted)
                .hover((s) => s.bg(t.raised).text_color(t.foreground))
                .tooltip(repo.upstream ? `${repo.branch} · tracks ${repo.upstream}` : repo.branch)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.openPicker(repo);
                })
                .child(svg(ICON("branch")).size(10));
        return h_flex()
            .id(`branch-${repo.path}`)
            .flex_1()
            .min_w(0)
            .h(18)
            .px(4)
            .gap(2)
            .items_center()
            .rounded(5)
            .text_size(10.5)
            .text_color(repo.detached ? t.dim : t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip(repo.upstream ? `${repo.branch} · tracks ${repo.upstream}` : repo.branch)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                this.openPicker(repo);
            })
            .child(svg(ICON("branch")).size(10).flex_none())
            .child(
                h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(0)
                    .items_center()
                    .when(Boolean(label.lead), (el) =>
                        el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(label.lead)),
                    )
                    .child(div().flex_1().min_w(0).text_ellipsis_start().child(label.text)),
            );
    }

    // Ahead, behind and the diverged mark: text, never a line of their own.
    badges(t, repo) {
        const diverged = isDiverged(repo);
        if (!repo.ahead && !repo.behind) return null;
        return h_flex()
            .flex_none()
            .gap(3)
            .items_center()
            .text_size(10.5)
            .when(Boolean(repo.ahead), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_color(diverged ? t.blocked : t.muted)
                        .child(`↑${repo.ahead}`),
                ),
            )
            .when(Boolean(repo.behind), (el) =>
                el.child(div().flex_none().text_color(t.blocked).child(`↓${repo.behind}`)),
            )
            .when(diverged, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_color(t.blocked)
                        .tooltip("diverged: rebase or merge in a terminal")
                        .child("⇅"),
                ),
            );
    }

    // "3 commits vs develop" ("3 vs develop" when the panel is narrow): the checkout is ahead of its base branch.
    // A click reviews the branch.
    commitsChip(t, repo) {
        const compact = this.width > 0 && this.width < 700,
            label = aheadChip(repo, compact);
        if (!label || (this.width > 0 && this.width < 480)) return null;
        return div()
            .id(`commits-${repo.path}`)
            .flex_none()
            .max_w(compact ? 110 : 170)
            .h(18)
            .px(6)
            .flex()
            .items_center()
            .rounded(9)
            .border_1()
            .border_color(t.accent)
            .truncate()
            .text_size(10.5)
            .text_color(t.accent)
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .tooltip(`Review this branch's ${repo.base.count} commits against ${repo.base.name}`)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                this.review(repo, null, "branch");
            })
            .child(label);
    }

    // The buttons on a checkout's row, in the always-reserved right-hand slot: pull, push/publish, fetch, unstage all,
    // terminal. They replace the row's badges on hover, so nothing is ever drawn over the text. Stage all stays on the
    // left of the name (when there are unstaged files). A narrow row shows the first few only.
    syncButtons(t, repo) {
        if (this.switching) return [];
        const lock = this.lock(repo),
            running = Boolean(lock) || Boolean(this.switching),
            target = this.targets.get(repo.path),
            publish = target ? target.mode === "publish" : null, // unknown: a neutral Push/Publish until the target is read
            buttons = [];
        if (this.hover === repo.path && repo.files.some((f) => f.unstaged))
            buttons.push(
                iconButton(t, `stage-all-${repo.path}`, ICON("plus"), "Stage all changes", (cx) =>
                    this.act(cx, repo, (git) => stageAll(git, { checkout: repo.path }), true, "Staging"),
                ),
            );
        if (repo.behind || this.hover === repo.path)
            buttons.push(
                iconButton(
                    t,
                    `pull-${repo.path}`,
                    OWN("pull"),
                    `Pull ${repo.upstream ?? ""} (fast-forward only)`,
                    (cx) => this.syncNow(cx, repo, "pull"),
                    running,
                ),
            );
        if (repo.ahead || publish || this.hover === repo.path) {
            const to = target?.target ?? (publish ? `${this.config.remote}/${repo.branch}` : repo.upstream);
            buttons.push(
                publish
                    ? iconButton(
                          t,
                          `publish-${repo.path}`,
                          OWN("push"),
                          `Publish to ${to}`,
                          (cx) => this.syncNow(cx, repo, "publish"),
                          running || repo.detached || repo.unborn,
                      )
                    : iconButton(
                          t,
                          `push-${repo.path}`,
                          OWN("push"),
                          publish === null
                              ? "Push or publish (reading git's push target…)"
                              : `Push ${plural(repo.ahead, "commit")} to ${to}`,
                          (cx) => this.syncNow(cx, repo, "push"),
                          running || (publish === false && !repo.ahead) || repo.detached,
                      ),
            );
        }
        if (this.hover === repo.path) {
            buttons.push(
                iconButton(
                    t,
                    `fetch-${repo.path}`,
                    OWN("fetch"),
                    `Fetch from ${this.config.remote}`,
                    (cx) => this.syncNow(cx, repo, "fetch"),
                    running,
                ),
            );
            if (repo.staged)
                buttons.push(
                    iconButton(t, `unstage-all-${repo.path}`, ICON("minus"), "Unstage all", (cx) =>
                        this.act(cx, repo, (git) => unstageAll(git, { checkout: repo.path }), true, "Unstaging"),
                    ),
                );
            if (this.width >= 400)
                buttons.push(
                    iconButton(t, `term-${repo.path}`, ICON("terminal"), "Open a terminal here", () =>
                        run("tab.new", { space: this.loc.space, folder: repo.path }),
                    ),
                );
        }
        return buttons;
    }

    /** How many action buttons the right-hand slot holds at this width; it is reserved even when they are hidden. */
    slotButtons() {
        return this.width > 0 && this.width < 400
            ? 2
            : this.width > 0 && this.width < 520
              ? 3
              : this.width > 0 && this.width < 700
                ? 4
                : 5;
    }

    /** A small chevron that folds something: 14 px, so rows line up whether or not they have one. */
    chevronButton(t, id, open, tip, onClick) {
        return div()
            .id(id)
            .w(14)
            .h(20)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(4)
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip(tip)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                onClick(cx);
            })
            .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12));
    }

    // The last commit as a second line: short hash, subject, age. Only the focused row (or every row in the full look).
    lastCommit(t, repo, indent) {
        if (!repo.head) return null;
        return h_flex()
            .flex_none()
            .pl(20 + indent)
            .pr(8)
            .pb(2)
            .gap(5)
            .items_center()
            .text_size(10.5)
            .text_color(t.dim)
            .child(div().flex_none().child(repo.head.hash))
            .child(div().flex_none().child("·"))
            .child(div().min_w(0).truncate().tooltip(repo.head.subject).child(repo.head.subject))
            .when(Boolean(repo.head.at), (el) =>
                el.child(
                    div()
                        .flex_none()
                        .child(`· ${ago(repo.head.at)}`),
                ),
            );
    }

    // One checkout, one line: [accent] [chevron] name branch badges [slot]. The last commit is a second line only for
    // the focused checkout (or every row in the full look); files, the commit box and the last result follow when open.
    checkout(t, repo, q, nested, group, dir, focus, folded) {
        const has = repo.files.length > 0,
            open = has && (q || this.opened.has(repo.path)),
            indent = nested ? 16 : 0,
            lock = this.lock(repo),
            detail = this.config.rowDetail === "full" ? "full" : "compact",
            focused = repo.path === focus,
            trees = nested ? 0 : group.worktrees.length,
            foldedRepo = !nested && folded,
            signal = foldedRepo && group.worktrees.some(worktreeSignal),
            commitLine = showsCommit(repo, focus, detail) ? this.lastCommit(t, repo, indent) : null,
            diverged = isDiverged(repo),
            tip = [repo.path, repo.head ? `${repo.head.hash} ${repo.head.subject}` : null].filter(Boolean).join("\n"),
            slot = this.slotButtons(),
            name = rowName(repo, { main: nested ? group.main : null, dir }).name,
            maxName = Math.max(64, Math.round((this.width || 380) * 0.6)),
            buttons = this.hover === repo.path ? this.syncButtons(t, repo).slice(0, slot) : [];
        const header = h_flex()
            .id(`repo-${repo.path}`)
            .h(26)
            .flex_none()
            .pl(4 + indent)
            .pr(4)
            .gap(4)
            .items_center()
            .overflow_hidden()
            .rounded(7)
            .when(focused, (el) => el.bg(t.raised))
            .hover((s) => s.bg(t.hover))
            .on_hover(this.hovering(repo.path))
            .when(has || repo.base, (el) =>
                el
                    .cursor_pointer()
                    .on_click((_e, cx) => (has ? this.toggleFiles(repo.path, cx) : this.review(repo, null, "branch"))),
            )
            .child(
                div()
                    .w(2)
                    .h(14)
                    .flex_none()
                    .rounded(1)
                    .when(focused, (el) => el.bg(t.accent)),
            )
            .when(!nested && trees > 0, (el) =>
                el.child(
                    this.chevronButton(
                        t,
                        `fold-${repo.path}`,
                        !foldedRepo,
                        foldedRepo ? `Show ${plural(trees, "worktree")}` : "Hide worktrees",
                        (cx) => this.foldGroup(group, cx),
                    ),
                ),
            )
            .when(!nested && trees === 0, (el) => el.child(div().w(14).flex_none()))
            .child(
                this.nameCell(
                    t,
                    repo,
                    nested,
                    dir,
                    group,
                    tip,
                    foldedRepo,
                    signal,
                    has && this.width >= 340 ? { open, total: repo.total } : null,
                    maxName,
                ),
            )
            .child(this.branchChip(t, repo, branchMatchesName(name, repo.branch)))
            .when(Boolean(badgeText(repo)), (el) => el.child(this.badges(t, repo)))
            .when(Boolean(lock), (el) =>
                el.child(
                    h_flex()
                        .flex_none()
                        .gap(4)
                        .items_center()
                        .child(div().flex_none().text_size(9.5).text_color(t.dim).child(`${lock.what}…`))
                        .child(div().flex_none().text_size(10).text_color(t.accent).frames(SPINNER, 90)),
                ),
            )
            .when(!lock && this.hover === repo.path, (el) =>
                el.child(h_flex().flex_none().gap(4).items_center().children(buttons)),
            );
        const more = repo.total - repo.files.length,
            note = this.notes[repo.path];
        return v_flex()
            .flex_none()
            .child(header)
            .when(Boolean(commitLine), (el) => el.child(commitLine))
            .when(detail === "full" && diverged, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .pl(24 + indent)
                        .pr(8)
                        .pb(2)
                        .text_size(10.5)
                        .text_color(t.blocked)
                        .child(divergedText(repo)),
                ),
            )
            .when(Boolean(repo.error), (el) =>
                el.child(
                    div()
                        .pl(24 + indent)
                        .py(2)
                        .text_size(11)
                        .text_color(t.blocked)
                        .truncate()
                        .tooltip(repo.error)
                        .child(repo.error),
                ),
            )
            .when(open, (el) =>
                el
                    .children(repo.files.flatMap((f) => this.fileRows(t, repo, f, indent)))
                    .when(more > 0, (e) =>
                        e.child(
                            div()
                                .pl(48 + indent)
                                .py(3)
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`+${more} more (first ${CAP} shown)`),
                        ),
                    )
                    .when(repo.staged > 0 && this.commits.has(repo.path), (e) =>
                        e.child(this.commitBox(t, repo, indent)),
                    ),
            )
            .when(Boolean(note), (el) =>
                el.child(
                    div()
                        .pl(24 + indent)
                        .pr(8)
                        .py(2)
                        .text_size(11)
                        .text_color(note.ok ? t.done : t.blocked)
                        .tooltip(note.message)
                        .child(note.message),
                ),
            );
    }

    // The staged state as a box: ticked when staged, a dash when only part of it is.
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

    // The list: groups with changes first (a main checkout, then its worktrees), then the clean group, folded.
    list(t) {
        const q = this.filter.trim() !== "",
            groups = filterGroups(groupRepos(this.repos), this.filter),
            focus = focusedCheckout(this.repos, this.loc?.root ?? ""),
            foldedOf = (g) => this.foldedGroup(g),
            // Tags are computed over the rows that are actually visible: folding a repo removes its worktrees' names.
            visible = groups.flatMap((g) =>
                foldedOf(g)
                    ? [{ repo: g.main, main: null }]
                    : [{ repo: g.main, main: null }, ...g.worktrees.map((w) => ({ repo: w, main: g.main }))],
            ),
            tags = disambiguators(
                visible.map((v) => ({ path: v.repo.path, name: rowName(v.repo, { main: v.main }).name })),
            ),
            rows = (g) => {
                const folded = foldedOf(g),
                    one = (repo, main) =>
                        this.checkout(
                            t,
                            repo,
                            q,
                            Boolean(main),
                            g,
                            main ? null : (tags.get(repo.path) ?? null),
                            focus,
                            folded,
                        );
                return folded ? [one(g.main, null)] : [one(g.main, null), ...g.worktrees.map((w) => one(w, g.main))];
            },
            changed = groups.filter((g) => !isClean(g)),
            clean = groups.filter((g) => isClean(g)),
            open = q || this.cleanOpen,
            items = changed.flatMap(rows);
        if (clean.length) {
            items.push(
                h_flex()
                    .id("clean-group")
                    .h(26)
                    .flex_none()
                    .mt(6)
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                        this.cleanOpen = !this.cleanOpen;
                        cx.notify();
                    })
                    .child(
                        div()
                            .flex_none()
                            .text_color(t.dim)
                            .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12)),
                    )
                    .child(div().font_semibold().child(`Clean (${clean.length})`)),
            );
            if (open) items.push(...clean.flatMap(rows));
        }
        return items;
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
    followToggle(t) {
        const follow = this.follow,
            narrow = this.width > 0 && this.width < 480;
        return h_flex()
            .id("repos-follow")
            .flex_none()
            .h(22)
            .px(6)
            .gap(5)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .when(follow, (el) => el.bg(t.raised))
            .text_size(10.5)
            .text_color(follow ? t.foreground : t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(
                follow
                    ? "Following the focused terminal — click to list the space's folder instead"
                    : "Listing the space's folder — click to follow the focused terminal",
            )
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
                cx.stop_propagation();
                this.setFollow(!follow, cx);
            })
            .child(
                svg(ICON(follow ? "terminal" : "folder"))
                    .size(12)
                    .flex_none()
                    .text_color(follow ? t.accent : t.muted),
            )
            .when(!narrow, (el) => el.child(div().child(follow ? "Terminal" : "Space")));
    }

    /** The panel goes away (a reload, the layout changing): let go of every claim this copy still holds. */
    close() {
        this.releaseAll();
    }

    /** Where the list looks, and the empty states that say what to do about it. `there` is the folder Space mode
     * would list: another place to look when this one holds nothing. */
    emptyState(there) {
        if (!this.loc?.root) return "No folder here: open a terminal, or pick a space with one.";
        if (!this.loaded) return this.error ? null : "Reading checkouts…";
        if (this.filter.trim()) return "No checkout or file matches.";
        if (this.repos.length) return null;
        const other = there && there !== this.loc.root;
        if (this.follow)
            return other
                ? "Not a git repository here — cd into one, or list the space's folder."
                : "Not a git repository here — cd into one.";
        return "No git repository under this folder — open a terminal inside one, or follow the terminal.";
    }

    render(cx) {
        if (this.picker) return this.picker.render(cx);
        if (this.dialog) return this.dialog.render(cx);
        const t = theme();
        this.locate();
        const loc = this.loc,
            groups = groupRepos(this.repos),
            trees = this.repos.length - groups.length;
        const changed = this.repos.filter((r) => r.files.length).length;
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
        const items = this.list(t);
        // Space mode's folder: the other place to look when following a terminal lands nowhere.
        const there = location(false).root;
        const empty = items.length ? null : this.emptyState(there);
        const narrow = this.width > 0 && this.width < 380;
        return v_flex()
            .id("repo-changes")
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
                h_flex()
                    .h(42)
                    .flex_none()
                    .px(12)
                    .gap(7)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .child(
                        div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .font_semibold()
                            .tooltip(loc.root || "No folder")
                            .child(loc.root ? lastSegment(loc.root) || "/" : "Repos"),
                    )
                    .child(this.followToggle(t))
                    .when(groups.length > 1, (el) => el.child(this.foldAllButton(t, groups)))
                    .when(Boolean(this.switching) && !narrow, (el) =>
                        el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("Reading…")),
                    )
                    .when(!this.switching && !narrow && this.width >= 560, (el) =>
                        el.child(div().flex_none().text_size(11).text_color(t.muted).child(summary)),
                    )
                    .when(
                        Boolean(this.fetching) || (this.fetchNote && Date.now() - this.fetchNote.at < NOTE_MS),
                        (el) =>
                            el
                                .when(Boolean(this.fetching), (e) =>
                                    e
                                        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Fetching…"))
                                        .child(
                                            div().flex_none().text_size(10.5).text_color(t.accent).frames(SPINNER, 90),
                                        ),
                                )
                                .when(Boolean(this.fetchNote) && !this.fetching, (e) =>
                                    e.child(
                                        div().flex_none().text_size(10.5).text_color(t.done).child(this.fetchNote.text),
                                    ),
                                ),
                    )
                    .when(
                        this.repos.some((r) => r.remote),
                        (el) =>
                            el.child(
                                iconButton(
                                    t,
                                    "repos-fetch-all",
                                    OWN("fetch"),
                                    "Fetch every checkout from its remote",
                                    (cx) => this.fetchAll(cx),
                                    this.fetching || this.switching || this.repos.some((r) => this.lock(r)),
                                ),
                            ),
                    )
                    .when(Boolean(this.error), (el) =>
                        el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(this.error)),
                    )
                    .child(
                        iconButton(
                            t,
                            "repos-refresh",
                            OWN("refresh"),
                            this.loading ? "Reading the checkouts…" : "Read the checkouts again",
                            (cx) => {
                                this.last = 0;
                                this.refresh(cx);
                            },
                            this.loading,
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
            .when(Boolean(this.error), (el) =>
                el.child(
                    div().flex_none().px(12).py(3).truncate().text_size(11).text_color(t.blocked).child(this.error),
                ),
            )
            .child(
                v_flex()
                    .id("repos-list")
                    .flex_1()
                    .min_h(0)
                    .p(6)
                    .overflow_y_scrollbar()
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
            );
    }

    /** Fetch every checkout that has the remote, one after another, and say how many moved. */
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
                this.targets.delete(repo.path);
                this.targetsAt = 0;
            }
            this.fetching = false;
            if (context === this.context) {
                this.fetchNote = {
                    text: failed ? `Fetched ${ok}, ${failed} failed` : `Fetched ${plural(ok, "checkout")}`,
                    at: Date.now(),
                };
                this.last = 0;
                this.refresh(cx);
            }
            cx.notify();
        });
        cx.notify();
    }
}
