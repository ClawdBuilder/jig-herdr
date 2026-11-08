#!/bin/sh
# Deterministic demo repositories for the herdr.dev screenshots. Writes only under /tmp/jig-herdr-demo.
set -eu

ROOT=${JIG_DEMO_ROOT:-/tmp/jig-herdr-demo}
DATE='2026-01-15T12:00:00Z'
export GIT_AUTHOR_NAME='Demo Dev'
export GIT_AUTHOR_EMAIL='demo@example.com'
export GIT_COMMITTER_NAME='Demo Dev'
export GIT_COMMITTER_EMAIL='demo@example.com'
export GIT_AUTHOR_DATE=$DATE
export GIT_COMMITTER_DATE=$DATE
export GIT_TERMINAL_PROMPT=0

rm -rf "$ROOT"
mkdir -p "$ROOT/origins"
cd "$ROOT"

commit() {
    git add -A
    git commit -q -m "$1"
}

repo() {
    name=$1
    git init -q -b main "$name"
    cd "$name"
    printf '# %s\n\nDemo content.\n' "$name" > README.md
    mkdir -p src
    printf 'export const value = 1;\n' > src/index.js
    commit 'Create the demo repository'
    git remote add origin "$ROOT/origins/$name.git"
    git push -q -u origin main
    cd "$ROOT"
}

git init -q --bare "$ROOT/origins/orders-api.git"
git init -q --bare "$ROOT/origins/billing-web.git"
git init -q --bare "$ROOT/origins/docs-site.git"
git init -q --bare "$ROOT/origins/notifications-svc.git"
repo orders-api
repo billing-web
repo docs-site
repo notifications-svc

# orders-api: a feature branch one commit ahead, a worktree, and all three file states.
cd "$ROOT/orders-api"
git switch -q -c feature/PROJ-123
printf 'export const taxes = true;\n' >> src/index.js
commit 'Add tax handling'
git push -q -u origin feature/PROJ-123
printf 'export const taxes = false;\n' >> src/index.js
commit 'Keep tax handling behind a flag'
git worktree add -q --detach ../orders-api-worktree feature/PROJ-123
printf 'staged\n' > staged.txt
git add staged.txt
printf '\nmore\n' >> src/index.js
printf 'untracked\n' > scratch.txt

# billing-web: a feature branch one commit behind after someone else pushes.
cd "$ROOT/billing-web"
git switch -q -c feature/PROJ-124
printf 'export const invoice = true;\n' > src/invoice.js
commit 'Start invoices'
git push -q -u origin feature/PROJ-124
cd "$ROOT"
git clone -q "$ROOT/origins/billing-web.git" billing-web-other
cd billing-web-other
git switch -q feature/PROJ-124
printf 'export const invoice = false;\n' >> src/invoice.js
commit 'Hide invoices until rollout'
git push -q origin feature/PROJ-124
cd "$ROOT/billing-web"
git fetch -q origin
printf 'staged change\n' > staged.txt
git add staged.txt
printf 'working change\n' >> README.md

# docs-site: clean main except an unstaged and an untracked file.
cd "$ROOT/docs-site"
printf '\nA line in progress.\n' >> README.md
printf 'draft\n' > draft.md

# notifications-svc: feature branch one commit ahead.
cd "$ROOT/notifications-svc"
git switch -q -c feature/PROJ-125
printf 'export const notify = true;\n' > src/notify.js
commit 'Start notifications'
git push -q -u origin feature/PROJ-125
printf 'export const notify = false;\n' >> src/notify.js
commit 'Keep notifications opt-in'

rm -rf "$ROOT/billing-web-other"
printf 'demo repositories in %s\n' "$ROOT"
