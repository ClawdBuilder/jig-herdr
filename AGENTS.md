# jig-herdr

Herdr mods are plain JavaScript copied into the app's folder. Panels show and comment; approval stays in Pi or the passkey
page. Keep the Apache-2.0 headers on mods derived from Herdr (`jig-files`, `jig-file-view`).

## Read before changing

- **A panel's header, list or keys:** read its `gallery/<id>/RECIPE.md`, then `docs/how-it-works.md`.
- **The full layout:** read `RECIPE.md`; `docs/mods.md` explains each mod's role and shared keys.
- **Sharing or publishing:** read the gallery recipe; `share/` is generated from `gallery/`, `mods/` and `layouts/`.
- **Installing or renaming:** read `scripts/install.ts`; `RENAMED` is the migration order, newest old name first.
- **A test or CI failure:** run `npm run test:ci` (one suite on the machine at a time); CI runs `.github/workflows/ci.yml`.

## Gotchas

- **Herdr runtime:** use `cx.timer`, never `setTimeout`/`setInterval`; module scope is shared by every copy, so per-copy
  state goes in the class or `init`, and no `cx` is kept beyond its callback (Herdr's AGENTS.md). `exec` defaults to 30 s; `{ timeout }` accepts
  up to 600000 ms. It rejects on timeout or when the program cannot start.
- **Render:** it re-runs on every live-data change (spaces, agents, terminals, focus, theme or shared), so compute
  grouping, sorting, summaries and closed-row details when the data arrives, not in render.
- **Shared files:** `refresh.js`, `follow.js`, `follow-state.js` and `panel-header.js` are byte-identical copies in every
  mod that imports them. Edit one, copy it to all; the guard test names an odd copy. Mods cannot import another mod's files.
- **Editor files:** `herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` into the checked folder. Check a `/tmp`
  copy, or remove those files before committing.
- **Layout ids:** the saved layout stores `panel-body` children `changes`, `history`, `pr`, `worktrees`, `review`, `files`;
  keep those ids and block ids stable.
- **Git actions:** `git worktree remove` runs without `--force`; branch deletion uses `-d` so git keeps unmerged work.
  The target is a safe removal whose refusals name the reason.
- **Commits:** `Jig Contributors <noreply@example.com>`; `npm run check` enforces it.
- **Tests:** run one suite at a time through `npm run test:ci`; stopping a run means killing its process group.
- **Changelog:** add user-visible changes under `[Unreleased]`.
