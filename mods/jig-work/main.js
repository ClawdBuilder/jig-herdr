// The Jig Work panel: what the Pi session in focus is doing, from the status file the jig-session Pi plugin writes for each
// session (its format: https://github.com/ClawdBuilder/jig/blob/main/plugins/jig-session/README.md). Its ticket and the workflow's stages, the ticket's pull requests, the files the
// session created or changed outside any git repository (the Changes panel has the rest), and its recent tool calls with jig-core's decision on each.
//
// While the panel is on screen it reads the status files every 2 seconds with one `sh` on the machine where Pi runs
// (config.json's `machine`, else the shown space's machine). The session shown is the one whose terminal is focused, else the
// one picked, else the one updated last. Pull requests come from the workflow's readings; with none, from one `gh search prs`
// for the ticket (in config.json's `prOwners`, else involving you), kept 5 minutes. A file opens in a `file-view` tab; one
// with changes in a git repository can open in the `repo-review` tab. Links open in this computer's browser. It approves
// nothing and writes nothing on that machine.

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import {
    appHome,
    exec,
    focused,
    layout,
    notify,
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
import { withDeadline } from "./deadline.js";
import {
    addressOf,
    changedSince,
    clock,
    decisionText,
    detailsNote,
    folderName,
    MTIMES,
    mergeSessions,
    missingDetails,
    parseConfig,
    parseMtimes,
    parseRepoInfo,
    parseSessions,
    pickSession,
    prRows,
    READ,
    REPO_SCRIPT,
    REVIEW,
    recentDecision,
    recentTarget,
    recentTooltip,
    reposLine,
    reviewTarget,
    SCRIPT,
    searchArgs,
    short,
    shortFolder,
    splitOutputs,
    splitPath,
    stageLine,
    stageSummary,
    terminalStateChanged,
} from "./lib.js";
import { focusRegained, RefreshScheduler, RefreshState, refreshSeconds } from "./refresh.js";

const MTIME_MS = 3000; // while the followed session works: a cheap mtime check
const REPO_MS = 30000; // which outputs have changes in a repository
const PR_MS = 5 * 60000; // pull requests, per ticket
const MODS_MS = 30000; // whether file-view and repo-review are installed
const SEARCH = "number,title,url,state,isDraft,repository,updatedAt";
const VIEW = "title,state,isDraft,reviewDecision,statusCheckRollup";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const OWN = (name) => `mods/jig-work/${name}.svg`;

// A 22x20 icon button for the header, like the Changes panel's.
function iconButton(t, id, icon, tip, onClick, disabled = false, busy = false) {
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
        .when(disabled, (el) => el.opacity(0.45))
        .when(busy, (el) => el.opacity(0.6))
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
        .child(svg(icon).size(13));
}

function saveFolds(folds) {
    try {
        localStorage.setItem("folds", JSON.stringify(folds));
    } catch {}
}

function readFolds() {
    try {
        return { outputs: true, recent: true, ...JSON.parse(localStorage.getItem("folds") ?? "{}") };
    } catch {
        return { outputs: true, recent: true };
    }
}

// Every command gets the same deadline, so a hung sh/git/gh cannot hold the panel's loading state and scheduler.
const execD = (cmd, args, opts) => withDeadline(exec(cmd, args, opts));

const readCache = () => {
    try {
        return JSON.parse(localStorage.getItem("prs") ?? "{}");
    } catch {
        return {};
    }
};

// The app may run on Windows with Pi in a Linux subsystem: a link opens on this computer, so no `on`.
function openUrl(url) {
    if (!url) return;
    const platform = window()?.platform;
    execD(platform === "windows" ? "explorer.exe" : platform === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
}

export default class JigWork extends View {
    init(_props, cx) {
        this.config = parseConfig(null);
        this.sessions = [];
        this.dir = null;
        this.error = null;
        this.raw = null;
        this.loadedAt = 0;
        this.loading = false;
        this.picked = null; // a session chosen in the picker
        this.pickedFocus = null; // the focused terminal when it was chosen: the pick holds until focus moves
        this.pickerOpen = false;
        this.repoInfo = {};
        this.repoKey = "";
        this.repoAt = 0;
        this.prs = readCache(); // ticket key -> { at, searched, details, error }
        this.prLoading = false;
        this.mods = { "file-view": true, "repo-review": true };
        this.modsAt = 0;
        this.opening = [];
        this.warned = new Set();
        this.home = null;
        this.loaded = false;
        this.mtimes = {};
        this.mtimeAt = 0;
        this.checking = false;
        this.refreshState = new RefreshState();
        this.refreshScheduler = new RefreshScheduler({ seconds: refreshSeconds(this.config) });
        this.lastTerminals = terminals();
        this.windowActive = window()?.active === true;
        this.selectedId = undefined;
        this.width = 0;
        this.folds = readFolds();
        this.recentAll = false;
        this.started = false;
        this.wasSeen = false;
        this.prUser = false;
        this.lastRenderAt = Date.now();
        cx.timer.every(1000, (cx) => this.tick(cx));
        this.readAll(cx, false);
    }

    warn(message) {
        if (this.warned.has(message)) return;
        this.warned.add(message);
        notify({ title: "jig-work", body: message, level: "warning" });
    }

    machine() {
        return this.config.machine ?? spaces().find((s) => s.active)?.machine ?? null;
    }

    // The session on screen, as render shows it.
    current() {
        const f = focused();
        const focus = f?.terminal ?? null;
        return pickSession(this.sessions, {
            machine: this.machine(),
            focused: this.picked && focus === this.pickedFocus ? null : focus,
            agent: this.picked && focus === this.pickedFocus ? null : (f?.agent ?? null),
            picked: this.picked,
        });
    }

    // Once a second, never from render: claim opened tabs, and load only while the panel is on screen.
    // Once a second: the events that make the panel read (focus/session change, window focus, the followed terminal's
    // Herdr status), the backstop, and a cheap mtime check while the session works. No 2 s body polling.
    tick(cx) {
        this.claim();
        const now = Date.now(),
            seen = Boolean(this.lastRenderAt) && now - this.lastRenderAt <= 2500;
        if (!seen) {
            // A hidden view does not render, so it stays quiet; a visible one renders and the next tick reads.
            this.wasSeen = false;
            if (this.current().session?.status.state === "busy" || this.refreshScheduler.due()) cx.notify();
            return;
        }
        if (shownAgain(this.wasSeen, seen)) this.refreshScheduler.trigger();
        this.wasSeen = true;
        if (now - this.modsAt > MODS_MS) this.checkMods(cx);
        const current = this.current(),
            id = current.session?.status.session ?? null;
        if (id !== this.selectedId) {
            this.selectedId = id;
            if (id) this.refreshScheduler.trigger();
            cx.notify();
        }
        if (!this.started && !this.loading) this.refreshScheduler.trigger();
        const active = window()?.active === true;
        if (focusRegained(this.windowActive, active)) this.refreshScheduler.trigger();
        this.windowActive = active;
        const currentTerminals = terminals(),
            address = current.session ? addressOf(current.session.status, this.machine()) : null;
        if (terminalStateChanged(this.lastTerminals, currentTerminals, address)) this.refreshScheduler.trigger();
        this.lastTerminals = currentTerminals;
        if (!this.loading && this.refreshScheduler.due()) this.readAll(cx, false, this.refreshScheduler.isBackstop());
        if (current.session) {
            this.loadRepos(cx, current.session.status);
            this.loadPrs(cx, current.session.status);
            this.checkMtimes(cx, current.session);
        }
    }

    /** A full read of every status file: an event, the backstop, or a click. Background runs are silent. */
    readAll(cx, user = false) {
        if (!this.refreshState.start({ user, first: !this.started, notify: () => cx.notify() })) return;
        this.started = true;
        this.refreshScheduler.sweep();
        this.loading = true;
        const on = this.machine();
        cx.spawn(async (cx) => {
            try {
                const config = parseConfig(await readTextFile(`${appHome()}/mods/jig-work/config.json`));
                for (const problem of config.problems) this.warn(problem);
                this.config = config;
                this.refreshScheduler.setSeconds(refreshSeconds(config));
                const before = await this.readMtimes();
                const r = await execD("sh", ["-c", SCRIPT, "sh", config.stateDir ?? ""], { on });
                if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n")[0]);
                this.raw = r.stdout;
                this.dir = /^@@dir (.*)$/m.exec(r.stdout)?.[1] ?? null;
                this.sessions = parseSessions(r.stdout);
                this.error = null;
                this.loaded = true;
                this.mtimes = before; // the mtimes from the pass whose bodies were just read
                if (this.home === null) {
                    const h = await execD("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
                    this.home = h?.stdout ?? "";
                }
            } catch (e) {
                this.error = String(e?.message ?? e).split("\n")[0];
            } finally {
                this.loading = false;
                const again = this.refreshState.finish();
                if (again) this.refreshScheduler.trigger();
                cx.notify();
            }
        });
    }

    async readMtimes() {
        const r = await execD("sh", ["-c", MTIMES, "sh", this.config.stateDir ?? ""], { on: this.machine() }).catch(
            () => null,
        );
        return r?.code === 0 ? parseMtimes(r.stdout) : {};
    }

    /** While the followed session works, every 3 s: only the status files whose mtime moved are read. */
    checkMtimes(cx, session) {
        if (this.loading || this.checking || session?.status.state !== "busy") return;
        const now = Date.now();
        if (now - this.mtimeAt < MTIME_MS) return;
        this.mtimeAt = now;
        this.checking = true;
        const on = this.machine();
        cx.spawn(async (cx) => {
            try {
                const r = await execD("sh", ["-c", MTIMES, "sh", this.config.stateDir ?? ""], { on }).catch(() => null);
                if (r?.code !== 0) return;
                const next = parseMtimes(r.stdout),
                    files = changedSince(this.mtimes, next);
                if (files.length === 0) return;
                const read = await execD("sh", ["-c", READ, "sh", ...files], { on }).catch(() => null);
                if (read?.code !== 0) return;
                this.mtimes = next; // only the pass whose bodies were read
                this.sessions = mergeSessions(this.sessions, parseSessions(read.stdout), Object.keys(next));
                this.error = null;
                cx.notify();
            } finally {
                this.checking = false;
            }
        });
    }

    // Which listed outputs are in a git repository with changes: one script for all of them, when the list changes and every 30 s.
    // Only outputs of an older status file (no `repo` field) can be both listed and in a repository.
    loadRepos(cx, status) {
        const files = splitOutputs(status.outputs).files.map((o) => o.path);
        const key = JSON.stringify([this.machine(), files]);
        if (this.repoLoading || files.length === 0) return;
        if (key === this.repoKey && Date.now() - this.repoAt < REPO_MS) return;
        this.repoLoading = true;
        this.repoKey = key;
        cx.spawn(async (cx) => {
            try {
                const r = await execD("sh", ["-c", REPO_SCRIPT, "sh", ...files], { on: this.machine() });
                this.repoInfo = { ...this.repoInfo, ...parseRepoInfo(r.stdout) };
                cx.notify();
            } catch {
                // no git there: no diff buttons
            } finally {
                this.repoAt = Date.now();
                this.repoLoading = false;
            }
        });
    }

    // The ticket's pull requests: details of the ones the workflow read, else a search for the key. Cached 5 minutes.
    loadPrs(cx, status, force = false) {
        const key = status.ticket?.key;
        if (!key || this.prLoading) return;
        const known = (status.workflow?.prs ?? []).map((p) => p.url).filter(Boolean);
        const search = searchArgs(key, this.config.prOwners, SEARCH);
        const cached = this.prs[key];
        const same = JSON.stringify([cached?.known ?? [], cached?.search]) === JSON.stringify([known, search]);
        if (!force && cached && same && Date.now() - cached.at < PR_MS) return;
        this.prLoading = true;
        this.prUser = force;
        const on = this.machine();
        cx.spawn(async (cx) => {
            const entry = { at: Date.now(), known, search, searched: [], details: {}, error: null };
            try {
                let urls = known;
                if (urls.length === 0) {
                    const r = await execD("gh", search, { on });
                    if (r.code !== 0) throw new Error((r.stderr || "gh search failed").trim().split("\n")[0]);
                    entry.searched = JSON.parse(r.stdout || "[]");
                    urls = entry.searched.map((p) => p.url);
                }
                for (const url of urls.slice(0, 4)) {
                    const r = await execD("gh", ["pr", "view", url, "--json", VIEW], { on });
                    if (r.code === 0) entry.details[url] = JSON.parse(r.stdout || "{}");
                }
            } catch (e) {
                entry.error = String(e?.message ?? e);
            } finally {
                this.prs[key] = entry;
                try {
                    const keep = Object.entries(this.prs)
                        .sort((a, b) => b[1].at - a[1].at)
                        .slice(0, 12);
                    localStorage.setItem("prs", JSON.stringify(Object.fromEntries(keep)));
                } catch {}
                this.prLoading = false;
                cx.notify();
            }
        });
    }

    // ---- opening things --------------------------------------------------------------------------------------------

    // tab.new does not give a mod the new tab's id: it is found as the tab that was not there before (as Files does).
    claim() {
        if (!this.opening.length) return;
        const map = shared("file-view.tabs") ?? {};
        const taken = new Set(Object.values(map));
        const found = {};
        this.opening = this.opening.filter((o) => {
            if (Date.now() - o.at > 8000) return false;
            const fresh =
                spaces()
                    .find((s) => s.id === o.space)
                    ?.tabs.filter((t) => !o.before.has(t.id) && !taken.has(t.id)) ?? [];
            const tab = fresh.find((t) => t.name === o.name) ?? fresh[0];
            if (!tab) return true;
            found[o.key] = tab.id;
            taken.add(tab.id);
            return false;
        });
        if (!Object.keys(found).length) return;
        const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
        setShared(
            "file-view.tabs",
            Object.fromEntries(Object.entries({ ...map, ...found }).filter(([, id]) => live.has(id))),
        );
    }

    openFile(path) {
        const space = spaces().find((s) => s.active);
        if (!space) return;
        if (!this.mods["file-view"]) return this.warn("Install the file-view mod to open files from the Work panel.");
        const on = this.machine();
        const key = `${on ?? ""}|${path}`;
        const name = splitPath(path).name;
        const id = shared("file-view.tabs")?.[key];
        if (id && space.tabs.some((t) => t.id === id) && panes().some((p) => p.tab === id && p.mod === "file-view"))
            return run("tab.select", { id });
        if (this.opening.some((o) => o.key === key)) return;
        this.opening.push({ key, space: space.id, name, before: new Set(space.tabs.map((t) => t.id)), at: Date.now() });
        run("tab.new", { space: space.id, name, mod: "file-view", props: { on, path } });
    }

    openReview(target) {
        const space = spaces().find((s) => s.active);
        if (!space || !target) return;
        const name = `Review · ${target.name}`;
        const tab = space.tabs.find((t) => t.name === name);
        if (!tab)
            return run("tab.new", {
                space: space.id,
                name,
                mod: "repo-review",
                props: { on: this.machine(), repo: target.repo, name: target.name, file: target.file },
            });
        setShared("repo-review.open", { repo: target.repo, file: target.file, at: Date.now() });
        run("tab.select", { id: tab.id });
    }

    // ---- drawing ---------------------------------------------------------------------------------------------------

    heading(t, label, extra) {
        return h_flex()
            .h(26)
            .px(14)
            .mt(6)
            .gap(8)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .text_color(t.dim)
            .child(label)
            .when(extra != null, (el) => el.child(div().text_color(t.dim).font_normal().child(String(extra))));
    }

    // The pinned 42 px header: title left; state, session picker and the refresh button right.
    topBar(t, cx, s, live, by) {
        const st = s?.status ?? null,
            busy = st?.state === "busy",
            narrow = this.width > 0 && this.width < 380;
        return h_flex()
            .h(42)
            .flex_none()
            .px(12)
            .gap(7)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .child(div().flex_none().text_color(t.accent).font_semibold().child("π"))
            .child(
                div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .font_semibold()
                    .tooltip(st?.cwd ?? "The Pi session in focus")
                    .child(st ? folderName(st.cwd, this.home) : "Work"),
            )
            .when(Boolean(st), (el) =>
                el
                    .child(
                        div()
                            .flex_none()
                            .size(7)
                            .rounded(4)
                            .bg(busy ? t.working : t.idle),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(12)
                            .text_color(busy ? t.working : t.dim)
                            .child(busy ? "working" : "idle"),
                    ),
            )
            .when(live.length > 1, (el) =>
                el.child(
                    div()
                        .id("jw-picker")
                        .flex_none()
                        .h(22)
                        .px(7)
                        .flex()
                        .items_center()
                        .gap(4)
                        .rounded(5)
                        .border(1)
                        .border_color(t.border)
                        .text_size(11)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover((x) => x.bg(t.hover).text_color(t.foreground))
                        .tooltip("Choose the session shown")
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.pickerOpen = !this.pickerOpen;
                            cx.notify();
                        })
                        .child(narrow ? String(live.length) : `${live.length} sessions`)
                        .child(svg(ICON("chevron-down")).size(10)),
                ),
            )
            .child(
                iconButton(
                    t,
                    "jw-refresh",
                    OWN("refresh"),
                    this.refreshState.busy ? "Reading the session…" : "Read the session again",
                    (cx) => this.readAll(cx, true),
                    false,
                    this.refreshState.busy,
                ),
            );
    }

    // The pinned second line: model, thinking, context, cost, terminal and whether this is the focused session.
    infoBar(t, s, by) {
        const st = s.status,
            model = st.model?.name ?? st.model?.id ?? "no model",
            narrow = this.width > 0 && this.width < 380;
        return h_flex()
            .h(26)
            .flex_none()
            .px(14)
            .gap(10)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().min_w(0).truncate().child(model))
            .when(Boolean(st.thinking) && st.thinking !== "off" && !narrow, (el) =>
                el.child(div().flex_none().child(st.thinking)),
            )
            .when(st.context?.percent != null, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .child(`context ${Math.round(st.context.percent)}% of ${short(st.context.window)}`),
                ),
            )
            .when(st.usage?.cost != null && !narrow, (el) =>
                el.child(
                    div()
                        .flex_none()
                        .child(`$${st.usage.cost.toFixed(2)}`),
                ),
            )
            .when(Boolean(st.terminal) && this.width >= 360, (el) => el.child(div().flex_none().child(st.terminal)))
            .when(by !== "focus", (el) =>
                el.child(
                    div()
                        .flex_none()
                        .text_color(t.muted)
                        .child(by === "picked" ? "picked" : "last active"),
                ),
            );
    }

    /** A section header that folds its list, like Context's. */
    section(t, key, label, count) {
        const open = this.folds[key] !== false;
        return h_flex()
            .id(`jw-sec-${key}`)
            .h(28)
            .px(14)
            .mt(6)
            .gap(6)
            .items_center()
            .text_size(10.5)
            .font_semibold()
            .text_color(t.dim)
            .cursor_pointer()
            .hover((x) => x.text_color(t.foreground))
            .on_click((_e, cx) => {
                this.folds[key] = !open;
                saveFolds(this.folds);
                cx.notify();
            })
            .child(
                div()
                    .w(10)
                    .child(open ? "▾" : "▸"),
            )
            .child(label)
            .when(count != null, (el) => el.child(div().font_normal().child(String(count))));
    }

    /** The stage line as one chip at narrow widths, with every stage in its tooltip. */
    stageChip(t, workflow) {
        const summary = stageSummary(workflow);
        if (!summary) return div();
        return h_flex()
            .px(14)
            .pt(8)
            .pb(2)
            .child(
                div()
                    .h(20)
                    .px(7)
                    .rounded(10)
                    .flex()
                    .items_center()
                    .text_size(11)
                    .border(1)
                    .border_color(t.accent)
                    .bg(t.accent)
                    .text_color(t.accent_foreground)
                    .font_semibold()
                    .tooltip(summary.title)
                    .child(summary.text),
            );
    }

    picker(t, live, current) {
        return v_flex()
            .mx(10)
            .my(6)
            .p(4)
            .rounded(6)
            .border(1)
            .border_color(t.border)
            .bg(t.surface)
            .children(
                live.map((x) =>
                    h_flex()
                        .id(`jw-pick-${x.status.session}`)
                        .h(26)
                        .px(8)
                        .gap(8)
                        .items_center()
                        .rounded(4)
                        .text_size(12)
                        .cursor_pointer()
                        .bg(x === current ? t.selected : t.surface)
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => {
                            this.picked = x.status.session;
                            this.pickedFocus = focused()?.terminal ?? null;
                            this.pickerOpen = false;
                            cx.notify();
                        })
                        .child(div().text_color(t.foreground).child(folderName(x.status.cwd, this.home)))
                        .child(
                            div()
                                .text_color(t.accent)
                                .child(x.status.ticket?.key ?? ""),
                        )
                        .child(div().flex_1())
                        .child(
                            div()
                                .text_color(t.dim)
                                .child(addressOf(x.status, this.machine()) ?? ""),
                        ),
                ),
            );
    }

    ticket(t, st) {
        const k = st.ticket;
        if (!k)
            return v_flex()
                .child(this.heading(t, "TICKET"))
                .child(
                    div().px(14).text_size(12).text_color(t.dim).child("No ticket. /ticket PROJ-123 in Pi sets one."),
                );
        const line = stageLine(st.workflow);
        return v_flex()
            .child(this.heading(t, "TICKET", st.workflow ? st.workflow.name : null))
            .child(
                h_flex()
                    .px(14)
                    .gap(8)
                    .items_center()
                    .text_size(13)
                    .child(
                        div()
                            .id("jw-ticket")
                            .flex_none()
                            .font_semibold()
                            .text_color(t.accent)
                            .when(Boolean(k.url), (el) =>
                                el
                                    .cursor_pointer()
                                    .tooltip("Open in the browser")
                                    .hover((s) => s.underline())
                                    .on_click(() => openUrl(k.url)),
                            )
                            .child(k.key),
                    )
                    .child(
                        div()
                            .min_w(0)
                            .truncate()
                            .text_color(t.foreground)
                            .child(k.title ?? ""),
                    ),
            )
            .when(line.length > 0, (el) =>
                el.child(this.width > 0 && this.width < 420 ? this.stageChip(t, st.workflow) : this.stages(t, line)),
            )
            .when(Boolean(st.workflow?.problem), (el) =>
                el.child(div().px(14).pt(4).text_size(11.5).text_color(t.blocked).child(st.workflow.problem)),
            );
    }

    stages(t, line) {
        const items = [];
        line.forEach((s, i) => {
            if (i > 0)
                items.push(
                    div()
                        .flex_1()
                        .min_w(6)
                        .h(1)
                        .bg(s.state === "todo" ? t.border : t.accent),
                );
            const on = s.state === "current";
            items.push(
                div()
                    .id(`jw-stage-${i}`)
                    .flex_none()
                    .h(20)
                    .px(7)
                    .rounded(10)
                    .flex()
                    .items_center()
                    .text_size(11)
                    .border(1)
                    .border_color(on || s.state === "done" ? t.accent : t.border)
                    .bg(on ? t.accent : t.background)
                    .text_color(on ? t.accent_foreground : s.state === "done" ? t.foreground : t.dim)
                    .when(on, (el) => el.font_semibold())
                    .when(Boolean(s.goal), (el) => el.tooltip(s.goal))
                    .child(s.state === "done" ? `✓ ${s.id}` : s.id),
            );
        });
        return h_flex().px(14).pt(8).pb(2).items_center().flex_wrap().gap(2).children(items);
    }

    pulls(t, st) {
        const key = st.ticket?.key;
        if (!key) return null;
        const cached = this.prs[key];
        const rows = prRows(st.workflow?.prs, cached?.searched, cached?.details);
        const body =
            rows.length === 0
                ? div()
                      .px(14)
                      .text_size(12)
                      .text_color(cached?.error ? t.blocked : t.dim)
                      .child(cached?.error ?? (cached ? "No pull requests for this ticket." : "Looking…"))
                : v_flex().children(rows.map((r, i) => this.pull(t, r, i)));
        return v_flex()
            .child(
                this.heading(t, "PULL REQUESTS", rows.length || null)
                    .child(div().flex_1())
                    .child(
                        iconButton(
                            t,
                            "jw-pr-refresh",
                            OWN("refresh"),
                            this.prUser && this.prLoading ? "Reading the pull requests…" : "Refresh the pull requests",
                            (cx) => this.loadPrs(cx, st, true),
                            false,
                            this.prUser && this.prLoading,
                        ),
                    ),
            )
            .child(body)
            .when(missingDetails(st.workflow?.prs, cached) > 0, (el) =>
                el.child(
                    div()
                        .px(14)
                        .pt(2)
                        .text_size(11.5)
                        .text_color(t.dim)
                        .child(detailsNote(missingDetails(st.workflow?.prs, cached))),
                ),
            );
    }

    pull(t, r, i) {
        const c = r.checks;
        const merged = String(r.state).toUpperCase() === "MERGED";
        const closed = String(r.state).toUpperCase() === "CLOSED";
        const state = merged ? "merged" : closed ? "closed" : r.draft ? "draft" : "open";
        return v_flex()
            .child(
                h_flex()
                    .id(`jw-pr-${i}`)
                    .h(26)
                    .px(14)
                    .gap(8)
                    .items_center()
                    .text_size(12.5)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip(r.url)
                    .on_click(() => openUrl(r.url))
                    .child(
                        svg(ICON("git-branch"))
                            .size(13)
                            .flex_none()
                            .text_color(merged ? t.ansi5 : t.muted),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(t.foreground)
                            .child(`#${r.number ?? "?"}`),
                    )
                    .child(
                        div()
                            .min_w(0)
                            .truncate()
                            .text_color(t.muted)
                            .child(r.title ?? r.repo ?? ""),
                    )
                    .child(div().flex_1())
                    .child(div().flex_none().text_size(11).text_color(t.dim).child(state))
                    .when(Boolean(r.review), (el) =>
                        el.child(
                            div()
                                .flex_none()
                                .text_size(11)
                                .text_color(
                                    r.review === "APPROVED"
                                        ? t.done
                                        : r.review === "CHANGES_REQUESTED"
                                          ? t.blocked
                                          : t.dim,
                                )
                                .child(REVIEW[r.review] ?? r.review.toLowerCase()),
                        ),
                    )
                    .when(Boolean(c), (el) =>
                        el.child(
                            h_flex()
                                .flex_none()
                                .gap(5)
                                .text_size(11.5)
                                .when(c.fail > 0, (x) => x.child(div().text_color(t.ansi1).child(`✗${c.fail}`)))
                                .when(c.pending > 0, (x) => x.child(div().text_color(t.working).child(`●${c.pending}`)))
                                .child(
                                    div()
                                        .text_color(c.pass ? t.ansi2 : t.dim)
                                        .child(`✓${c.pass}`),
                                ),
                        ),
                    ),
            )
            .children(
                (c?.failing ?? []).slice(0, 3).map((f, j) =>
                    h_flex()
                        .id(`jw-fail-${i}-${j}`)
                        .h(20)
                        .pl(35)
                        .pr(14)
                        .items_center()
                        .text_size(11.5)
                        .text_color(t.ansi1)
                        .when(Boolean(f.url), (el) =>
                            el
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .on_click(() => openUrl(f.url)),
                        )
                        .child(div().truncate().child(`✗ ${f.name}`)),
                ),
            );
    }

    // The same two calls as the activity bar's Changes button: select the section, then show the side panel.
    showChanges() {
        run("layout.select", { stack: "panel-body", child: "changes" });
        run("layout.show", { id: "panel" });
    }

    outputs(t, st) {
        const { files: list, inRepos } = splitOutputs(st.outputs),
            line = reposLine(inRepos),
            open = this.folds.outputs !== false;
        return v_flex()
            .child(this.section(t, "outputs", "OUTPUTS", list.length))
            .when(open, (el) =>
                el
                    .when(list.length === 0, (x) =>
                        x.child(div().px(14).text_size(12).text_color(t.dim).child("No ticket files yet")),
                    )
                    .children(
                        list.map((o, i) => {
                            const { dir, name } = splitPath(o.path);
                            const info = this.repoInfo[o.path];
                            const target = info?.status && this.mods["repo-review"] ? reviewTarget(o.path, info) : null;
                            const created = o.action === "created";
                            return h_flex()
                                .id(`jw-out-${i}`)
                                .h(26)
                                .px(14)
                                .gap(8)
                                .items_center()
                                .text_size(12.5)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .tooltip(o.path)
                                .on_click(() => this.openFile(o.path))
                                .child(
                                    div()
                                        .w(12)
                                        .flex_none()
                                        .font_semibold()
                                        .text_color(created ? t.ansi2 : t.blocked)
                                        .child(created ? "A" : "M"),
                                )
                                .child(div().flex_none().text_color(t.foreground).child(name))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w(0)
                                        .truncate()
                                        .text_size(11.5)
                                        .text_color(t.dim)
                                        .child(shortFolder(dir)),
                                )
                                .when(Boolean(target), (x) =>
                                    x.child(
                                        div()
                                            .id(`jw-diff-${i}`)
                                            .flex_none()
                                            .size(22)
                                            .rounded(4)
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .text_color(t.muted)
                                            .hover((s) => s.bg(t.raised).text_color(t.accent))
                                            .tooltip(`Diff in Review · ${target.name}`)
                                            .on_click((_e, cx) => {
                                                cx.stop_propagation();
                                                this.openReview(target);
                                            })
                                            .child(svg(ICON("git-compare")).size(14)),
                                    ),
                                )
                                .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(o.at)));
                        }),
                    )
                    .when(line !== "", (x) =>
                        x.child(
                            div()
                                .id("jw-out-repos")
                                .h(26)
                                .px(14)
                                .flex()
                                .items_center()
                                .text_size(11.5)
                                .text_color(t.dim)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).text_color(t.accent))
                                .tooltip("Show the Changes panel")
                                .on_click(() => this.showChanges())
                                .child(line),
                        ),
                    ),
            );
    }

    recent(t, st) {
        const list = st.recent ?? [],
            open = this.folds.recent !== false,
            shown = this.recentAll ? list : list.slice(0, 5),
            tone = { ok: t.ansi2, error: t.ansi1, blocked: t.blocked, running: t.working };
        return v_flex()
            .child(this.section(t, "recent", "RECENT", list.length))
            .when(open, (el) =>
                el
                    .when(list.length === 0, (x) =>
                        x.child(div().px(14).text_size(12).text_color(t.dim).child("No tool calls yet.")),
                    )
                    .children(
                        shown.map((r) => {
                            const decision = recentDecision(r);
                            return h_flex()
                                .h(22)
                                .px(14)
                                .gap(8)
                                .items_center()
                                .text_size(12)
                                .tooltip(recentTooltip(r))
                                .child(div().w(50).flex_none().text_size(11).text_color(t.dim).child(clock(r.at)))
                                .child(
                                    div()
                                        .min_w(0)
                                        .truncate()
                                        .text_color(t.foreground)
                                        .child(r.tool + (recentTarget(r) ? ` ${recentTarget(r)}` : "")),
                                )
                                .child(div().flex_1())
                                .when(decision !== "", (x) =>
                                    x.child(
                                        div()
                                            .flex_none()
                                            .text_size(11)
                                            .text_color(
                                                r.answer === "decline" || r.decision === "deny" ? t.blocked : t.accent,
                                            )
                                            .child(decision),
                                    ),
                                )
                                .child(
                                    div()
                                        .w(52)
                                        .flex_none()
                                        .text_size(11)
                                        .text_color(tone[r.outcome] ?? t.dim)
                                        .child(r.outcome),
                                );
                        }),
                    )
                    .when(list.length > 5, (x) =>
                        x.child(
                            div()
                                .id("jw-recent-all")
                                .h(24)
                                .px(14)
                                .flex()
                                .items_center()
                                .text_size(11.5)
                                .text_color(t.muted)
                                .cursor_pointer()
                                .hover((s) => s.text_color(t.foreground))
                                .on_click((_e, cx) => {
                                    this.recentAll = !this.recentAll;
                                    cx.notify();
                                })
                                .child(this.recentAll ? "Show fewer" : `Show all ${list.length}`),
                        ),
                    ),
            );
    }

    empty(t) {
        if (!this.loaded && !this.error)
            return v_flex()
                .p(14)
                .gap(6)
                .text_size(12.5)
                .text_color(t.dim)
                .child(div().text_color(t.muted).child("Reading Pi sessions…"));
        const where = this.machine() ?? "this computer";
        return v_flex()
            .p(14)
            .gap(6)
            .text_size(12.5)
            .text_color(t.dim)
            .child(
                div()
                    .text_color(t.muted)
                    .child(this.error ? "Cannot read the Pi sessions" : "No Pi session with Jig running"),
            )
            .child(div().child(this.error ?? `Looked in ${this.dir ?? "the Jig state folder"} on ${where}.`))
            .child(div().child("Start Pi with the Jig plugins (jig-session among them) in a terminal here."));
    }

    render(cx) {
        this.lastRenderAt = Date.now();
        const t = theme();
        const live = this.sessions.filter((s) => s.alive);
        const { session, by } = this.current();
        const root = v_flex()
            .id("jig-work")
            .size_full()
            .min_h(0)
            .bg(t.chrome)
            .text_color(t.foreground)
            .on_size_change((size, cx) => {
                if (Math.round(size.width) === Math.round(this.width)) return;
                this.width = size.width;
                cx.notify();
            });
        if (!session) return root.child(this.topBar(t, cx, null, live, by)).child(this.empty(t));
        const st = session.status;
        return root
            .child(this.topBar(t, cx, session, live, by))
            .child(this.infoBar(t, session, by))
            .when(this.pickerOpen && live.length > 1, (el) => el.child(this.picker(t, live, session)))
            .child(
                v_flex()
                    .id("jw-body")
                    .flex_1()
                    .min_h(0)
                    .pb(12)
                    .overflow_y_scrollbar()
                    .child(this.ticket(t, st))
                    .when(Boolean(st.ticket), (el) => el.child(this.pulls(t, st)))
                    .child(this.outputs(t, st))
                    .child(this.recent(t, st)),
            );
    }
}
