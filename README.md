# jig-herdr

Herdr layouts, mods and themes for [Jig](https://github.com/ClawdBuilder/jig): Work, Context, Changes, Review and Keep awake.
It is optional; the browser review page is Jig's built-in front-end.

## Install

```sh
node scripts/install.ts [herdr-folder]
```

It copies `layouts/`, `mods/` and `themes/`, merges `keys.json`, and never touches your `config.json`. `--dry-run` shows
what would happen; `--force` replaces files this script did not write.

## What it needs

- Jig `0.5.0` or later for the session status file (`schema: 1`), session requests (`REQUEST_SCHEMA = 1`), `jig:stage-done`
  and the palette file.
- Herdr, for the app. Node 22.19 or later for the installer and the tests.

`jig-herdr` shows and comments. It never approves: approval stays with the passkey page or `y` in Pi.

## Panels

- **Work** — the session's tickets and outputs.
- **Context** — usage, tools and skills; switches write a request file.
- **Changes** — a branch's commits, files and patches; pull/push/fetch are shown, not run.
- **Review** — read-only files and patches.
- **Keep awake** — holds off idle sleep while agents work, with an explicit On switch.

## Licence

MIT. The `tabs` and `files` mods are derived from Herdr's own (Apache-2.0); their headers stay.
