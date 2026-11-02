# Install

How `scripts/install.ts` puts the layout and mods into a Herdr folder, what a second run does, and how to take it out
again. Back to the [Herdr app overview](../README.md).

## Run it

It needs Node.js 22.19 or later, the same as Jig. The folder is the Herdr app's config folder, which the app makes on its
first start.

```bash
node herdr/scripts/install.ts [folder] [--force] [--dry-run]
```

| Folder | When |
|---|---|
| none given | `$HERDR_APP_HOME` if set, else `~/.config/herdr-app` |
| `/mnt/c/Users/<name>/.config/herdr-app` | The Windows app, with the script run in WSL |

Herdr applies files while it runs. Switch to the layout with `Ctrl+Shift+L` or in the settings screen; nothing needs a
restart.

## What it copies

- **`layouts/`:** `jig.json` and `jig.svg`, the picture the settings screen shows.
- **`mods/`:** `jig-work`, `jig-tabs`, `file-view`, `repo-changes`, `repo-review`, `jig-activity` and `jig-theme-sync`.
- **`themes/`:** one theme for each Jig palette.
- **`keys.json`:** merged, not copied: only the section `layout:jig` is added or changed.

`RECIPE.md` and `preview.png` are for sharing the layout and are not copied. Files are copied, never linked, because the
Windows app cannot follow a link made in WSL. For each mod the script writes `mod.json` first: Herdr docks a folder it has
never seen where its `mod.json` says, and without one it would put a stray copy into the layout you are looking at.

## A second run, `--force`, `--dry-run`

The script records a hash of every file it wrote, in `.jig-herdr-install.json` in the Herdr folder. That is how it tells its
own files from yours.

| The file in the folder | Without `--force` | With `--force` |
|---|---|---|
| Missing | Written | Written |
| Same as this version | Nothing to do | Nothing to do |
| Written by the script, not changed since | Updated | Updated |
| Changed by you, or not from the script | Left alone, and reported | Replaced |
| A `config.json` | Written once, then kept | Kept |
| No longer shipped, written by the script, not changed | Removed | Removed |

A report line `LEFT ALONE` makes the script exit with 1: the install is not complete. A key in `keys.json` that you have
bound to something else is kept and listed, and `--force` takes it over. A `keys.json` that is not valid JSON is not touched.
`--dry-run` prints what would happen and writes nothing, not even the record.

## The Triage panels

The layout names the panels `triage-history`, `triage-pr`, `triage-worktrees` and `triage-launch`. They are
not in this plugin: they come from [herdr-triage](https://github.com/sgomez/herdr-triage), which is under the EUPL-1.2. The
script says which of them are missing from the folder.

Herdr shows a block whose mod has no folder as a note, `<mod> did not load`, and lists it under `errors` in `herdr-app
status`. The layout around it keeps working, and `jig-activity` leaves that panel's button out, so the note is only seen by
a person who has switched to that panel. Installing the mods later needs no change here.

## Take it out

Delete the files the script listed: `layouts/jig.json`, `layouts/jig.svg`, the seven `mods/` folders, the six
`themes/jig-*.json`, the `layout:jig` section of `keys.json` and `.jig-herdr-install.json`. Your other layouts and mods are
not affected.
