// The Jig Work panel: what the Pi session in focus is doing, from the status file the jig-session Pi plugin writes for each
// session (its format: ../../../plugins/jig-session/README.md). Its ticket and the workflow's stages, the ticket's pull requests, the files the
// session created or changed, and its recent tool calls with jig-core's decision on each.
//
// While the panel is on screen it reads the status files every 2 seconds with one `sh` on the machine where Pi runs
// (config.json's `machine`, else the shown space's machine). The session shown is the one whose terminal is focused, else the
// one picked, else the one updated last. Pull requests come from the workflow's readings; with none, from one `gh search prs`
// for the ticket (in config.json's `prOwners`, else involving you), kept 5 minutes. A file opens in a `file-view` tab; one
// with changes in a git repository can open in the `repo-review` tab. Links open in this computer's browser. It approves
// nothing and writes nothing on that machine.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
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
    theme,
    window,
} from "herdr";
import {
    REPO_SCRIPT,
    REVIEW,
    SCRIPT,
    addressOf,
    clock,
    decisionText,
    folderName,
    isShown,
    parseConfig,
    parseRepoInfo,
    parseSessions,
    pickSession,
    prRows,
    reviewTarget,
    searchArgs,
    short,
    splitPath,
    stageLine,
} from "./lib.js";

const EVERY_MS = 2000; // status files, while on screen
const REPO_MS = 30000; // which outputs have changes in a repository
const PR_MS = 5 * 60000; // pull requests, per ticket
const MODS_MS = 30000; // whether file-view and repo-review are installed
const SEARCH = "number,title,url,state,isDraft,repository,updatedAt";
const VIEW = "title,state,isDraft,reviewDecision,statusCheckRollup";
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const readCache = () => {
    try {
        return JSON.parse(localStorage.getItem("prs") ?? "{}");
    } catch {
        return {};
    }
};

// The app may run on Windows with Pi on WSL: a link opens on this computer, so no `on`.
function openUrl(url) {
    if (!url) return;
    const platform = window()?.platform;
    exec(platform === "windows" ? "explorer.exe" : platform === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
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
        cx.timer.every(1000, (cx) => this.tick(cx));
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
    tick(cx) {
        this.claim();
        if (!isShown(layout(), "jig-work")) return;
        const now = Date.now();
        if (now - this.modsAt > MODS_MS) this.checkMods(cx);
        if (!this.loading && now - this.loadedAt >= EVERY_MS) this.load(cx);
        const { session } = this.current();
        if (!session) return;
        this.loadRepos(cx, session.status);
        this.loadPrs(cx, session.status);
    }

    checkMods(cx) {
        this.modsAt = Date.now();
        cx.spawn(async (cx) => {
            let changed = false;
            for (const mod of Object.keys(this.mods)) {
                const there = (await readTextFile(`${appHome()}/mods/${mod}/mod.json`)) !== null;
                if (this.mods[mod] !== there) changed = true;
                this.mods[mod] = there;
            }
            if (changed) cx.notify();
        });
    }

    load(cx) {
        this.loading = true;
        cx.spawn(async (cx) => {
            try {
                const config = parseConfig(await readTextFile(`${appHome()}/mods/jig-work/config.json`));
                for (const p of config.problems) this.warn(p);
                this.config = config;
                const on = this.machine();
                const r = await exec("sh", ["-c", SCRIPT, "sh", config.stateDir ?? ""], { on });
                if (r.stdout === this.raw && this.error === null) return;
                this.raw = r.stdout;
                this.dir = /^@@dir (.*)$/m.exec(r.stdout)?.[1] ?? null;
                this.sessions = parseSessions(r.stdout);
                this.error = null;
                if (this.home === null) {
                    const h = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
                    this.home = h?.stdout ?? "";
                }
                cx.notify();
            } catch (e) {
                const message = String(e?.message ?? e);
                if (message !== this.error) {
                    this.error = message;
                    cx.notify();
                }
            } finally {
                this.loading = false;
                this.loadedAt = Date.now();
            }
        });
    }

    // Which outputs are in a git repository with changes: one script for all of them, when the list changes and every 30 s.
    loadRepos(cx, status) {
        const files = (status.outputs ?? []).map((o) => o.path).filter((p) => typeof p === "string");
        const key = JSON.stringify([this.machine(), files]);
        if (this.repoLoading || files.length === 0) return;
        if (key === this.repoKey && Date.now() - this.repoAt < REPO_MS) return;
        this.repoLoading = true;
        this.repoKey = key;
        cx.spawn(async (cx) => {
            try {
                const r = await exec("sh", ["-c", REPO_SCRIPT, "sh", ...files], { on: this.machine() });
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
        const on = this.machine();
        cx.spawn(async (cx) => {
            const entry = { at: Date.now(), known, search, searched: [], details: {}, error: null };
            try {
                let urls = known;
                if (urls.length === 0) {
                    const r = await exec("gh", search, { on });
                    if (r.code !== 0) throw new Error((r.stderr || "gh search failed").trim().split("\n")[0]);
                    entry.searched = JSON.parse(r.stdout || "[]");
                    urls = entry.searched.map((p) => p.url);
                }
                for (const url of urls.slice(0, 4)) {
                    const r = await exec("gh", ["pr", "view", url, "--json", VIEW], { on });
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

    header(t, s, live, by) {
        const st = s.status;
        const model = st.model?.name ?? st.model?.id ?? "no model";
        const busy = st.state === "busy";
        return v_flex()
            .px(14)
            .py(10)
            .gap(4)
            .border_b(1)
            .border_color(t.border)
            .child(
                h_flex()
                    .gap(8)
                    .items_center()
                    .text_size(13)
                    .child(div().text_color(t.accent).font_semibold().child("π"))
                    .child(
                        div().flex_none().font_semibold().text_color(t.foreground).child(folderName(st.cwd, this.home)),
                    )
                    .child(div().text_color(t.dim).child("·"))
                    .child(div().min_w(0).truncate().text_color(t.muted).child(model))
                    .when(Boolean(st.thinking) && st.thinking !== "off", (el) =>
                        el.child(div().flex_none().text_color(t.dim).child(st.thinking)),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
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
            .child(
                h_flex()
                    .gap(10)
                    .items_center()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .when(st.context?.percent != null, (el) =>
                        el.child(
                            div().child(`context ${Math.round(st.context.percent)}% of ${short(st.context.window)}`),
                        ),
                    )
                    .when(st.usage?.cost != null, (el) => el.child(div().child(`$${st.usage.cost.toFixed(2)}`)))
                    .when(Boolean(st.terminal), (el) => el.child(div().child(st.terminal)))
                    .when(by !== "focus", (el) =>
                        el.child(
                            div()
                                .text_color(t.muted)
                                .child(by === "picked" ? "picked" : "last active"),
                        ),
                    )
                    .child(div().flex_1())
                    .when(live.length > 1, (el) =>
                        el.child(
                            div()
                                .id("jw-picker")
                                .px(6)
                                .rounded(4)
                                .cursor_pointer()
                                .text_color(t.muted)
                                .hover((x) => x.bg(t.hover).text_color(t.foreground))
                                .on_click((_e, cx) => {
                                    this.pickerOpen = !this.pickerOpen;
                                    cx.notify();
                                })
                                .child(`${live.length} sessions ▾`),
                        ),
                    ),
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
            .when(line.length > 0, (el) => el.child(this.stages(t, line)))
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
                        div()
                            .id("jw-pr-refresh")
                            .cursor_pointer()
                            .text_color(t.dim)
                            .hover((s) => s.text_color(t.foreground))
                            .on_click((_e, cx) => this.loadPrs(cx, st, true))
                            .child(this.prLoading ? "…" : "Refresh"),
                    ),
            )
            .child(body);
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

    outputs(t, st) {
        const list = st.outputs ?? [];
        return v_flex()
            .child(this.heading(t, "OUTPUTS", list.length || null))
            .when(list.length === 0, (el) =>
                el.child(div().px(14).text_size(12).text_color(t.dim).child("No files created or changed yet.")),
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
                        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))
                        .child(div().flex_1())
                        .when(Boolean(target), (el) =>
                            el.child(
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
            );
    }

    recent(t, st) {
        const list = st.recent ?? [];
        const tone = { ok: t.ansi2, error: t.ansi1, blocked: t.blocked, running: t.working };
        return v_flex()
            .child(this.heading(t, "RECENT", list.length || null))
            .when(list.length === 0, (el) =>
                el.child(div().px(14).text_size(12).text_color(t.dim).child("No tool calls yet.")),
            )
            .children(
                list.map((r) => {
                    const decision = decisionText(r);
                    return h_flex()
                        .h(22)
                        .px(14)
                        .gap(8)
                        .items_center()
                        .text_size(12)
                        .child(div().w(54).flex_none().text_size(11).text_color(t.dim).child(clock(r.at)))
                        .child(
                            div()
                                .min_w(0)
                                .truncate()
                                .text_color(t.foreground)
                                .child(r.action ? `${r.tool} ${r.action}` : r.tool),
                        )
                        .child(div().flex_1())
                        .when(decision !== "", (el) =>
                            el.child(
                                div()
                                    .flex_none()
                                    .text_size(11)
                                    .text_color(
                                        r.decision === "deny" || r.answer === "decline"
                                            ? t.blocked
                                            : r.decision === "ask"
                                              ? t.accent
                                              : t.dim,
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
            );
    }

    empty(t) {
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

    render(_cx) {
        const t = theme();
        const live = this.sessions.filter((s) => s.alive);
        const { session, by } = this.current();
        const root = v_flex().id("jig-work").size_full().min_h(0).bg(t.chrome).text_color(t.foreground);
        if (!session) return root.child(this.empty(t));
        const st = session.status;
        return root
            .child(this.header(t, session, live, by))
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
