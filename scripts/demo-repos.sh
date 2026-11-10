#!/bin/sh
# Deterministic demo repositories for the herdr.dev screenshots. Writes only under /tmp/jig-herdr-demo.
# Ages are relative to the run, so the panels always show 2h, 5h, 2d; the history's shape is fixed.
set -eu

ROOT=${JIG_DEMO_ROOT:-/tmp/jig-herdr-demo}
NOW=$(date +%s)
export GIT_TERMINAL_PROMPT=0
export GIT_COMMITTER_NAME='Maya Chen'
export GIT_COMMITTER_EMAIL='maya.chen@example.com'

# A UTC date for a commit N seconds old. GNU date first, then macOS date.
date_at() {
    if date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
        date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
    else
        date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
    fi
}

commit_as() {
    age=$1 who=$2 addr=$3 message=$4
    when=$(date_at $((NOW - age)))
    git add -A
    GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL=$addr \
    GIT_COMMITTER_NAME=$who GIT_COMMITTER_EMAIL=$addr \
    GIT_AUTHOR_DATE=$when GIT_COMMITTER_DATE=$when \
        git commit -q -m "$message"
}

commit() {
    if git diff --cached --quiet; then
        printf '%s\n' "$1" >> history.log
        git add history.log
    fi
    who=${AUTHOR_NAME:-Maya Chen}
    case "$who" in
        Leo*) addr=leo.park@example.com ;;
        Sam*) addr=sam.rivera@example.com ;;
        Priya*) addr=priya.nair@example.com ;;
        *) addr=maya.chen@example.com ;;
    esac
    commit_as "${AGE:-86400}" "$who" "$addr" "$1"
}

repo() {
    repo_name=$1
    git init -q -b main "$repo_name"
    cd "$repo_name"
    printf '# %s\n\nDemo content.\n' "$repo_name" > README.md
    mkdir -p src
    printf 'export const value = 1;\n' > src/index.js
    AGE=1036800 AUTHOR_NAME='Maya Chen' AUTHOR_EMAIL='maya.chen@example.com' commit 'Create the demo repository'
    git remote add origin "$ROOT/origins/$repo_name.git"
    git push -q -u origin main
    cd "$ROOT"
}

rm -rf "$ROOT"
mkdir -p "$ROOT/origins"
cd "$ROOT"
for origin in orders-api billing-web docs-site notifications-svc; do
    git init -q --bare "$ROOT/origins/$origin.git"
    git -C "$ROOT/origins/$origin.git" symbolic-ref HEAD refs/heads/main
done
repo orders-api
repo billing-web
repo docs-site
repo notifications-svc

# orders-api: fifteen commits, two merged features, a tag, a behind-main origin and two worktrees.
cd "$ROOT/orders-api"
AGE=864000 AUTHOR_NAME='Leo Park' AUTHOR_EMAIL='leo.park@example.com' commit 'Add the orders endpoint'
AGE=777600 AUTHOR_NAME='Maya Chen' commit 'Validate line items'
AGE=691200 AUTHOR_NAME='Sam Rivera' AUTHOR_EMAIL='sam.rivera@example.com' commit 'Test the order total'
AGE=604800 AUTHOR_NAME='Priya Nair' AUTHOR_EMAIL='priya.nair@example.com' commit 'Document the API'
AGE=518400 AUTHOR_NAME='Leo Park' commit 'Move the client to fetch'
AGE=432000 AUTHOR_NAME='Sam Rivera' AUTHOR_EMAIL='sam.rivera@example.com' commit 'Cache the order summary'
git switch -q -c feature/checkout
AGE=259200 AUTHOR_NAME='Sam Rivera' commit 'Start the checkout flow'
AGE=172800 AUTHOR_NAME='Sam Rivera' commit 'Handle an empty cart'
git switch -q main
GIT_AUTHOR_DATE=$(date_at $((NOW - 86400))) GIT_COMMITTER_DATE=$(date_at $((NOW - 86400))) \
GIT_AUTHOR_NAME='Maya Chen' GIT_AUTHOR_EMAIL='maya.chen@example.com' \
GIT_COMMITTER_NAME='Maya Chen' GIT_COMMITTER_EMAIL='maya.chen@example.com' \
    git merge -q --no-ff feature/checkout -m 'Merge checkout flow'
git tag v1.2.0
git push -q origin main
git push -q origin v1.2.0
# A merged, clean, pushed branch in a linked worktree: Ready to remove.
git switch -q -c feature/orders-ready
AGE=72000 AUTHOR_NAME='Priya Nair' commit 'Add the order status route'
git switch -q main
GIT_AUTHOR_DATE=$(date_at $((NOW - 64800))) GIT_COMMITTER_DATE=$(date_at $((NOW - 64800))) \
GIT_AUTHOR_NAME='Maya Chen' GIT_AUTHOR_EMAIL='maya.chen@example.com' \
GIT_COMMITTER_NAME='Maya Chen' GIT_COMMITTER_EMAIL='maya.chen@example.com' \
    git merge -q --no-ff feature/orders-ready -m 'Merge order status'
git push -q origin main
git push -q -u origin feature/orders-ready
git worktree add -q ../orders-api-ready feature/orders-ready
# Local main one commit ahead of origin/main.
AGE=28800 AUTHOR_NAME='Priya Nair' commit 'Document the retry budget'
# The feature one commit ahead, then one local commit and the working states.
git switch -q -c feature/PROJ-123
AGE=21600 AUTHOR_NAME='Leo Park' commit 'Add tax handling'
git push -q -u origin feature/PROJ-123
AGE=14400 AUTHOR_NAME='Maya Chen' commit 'Keep tax handling behind a flag'
git worktree add -q --detach ../orders-api-worktree feature/PROJ-123
printf 'staged\n' > staged.txt
git add staged.txt
printf '\nmore\n' >> src/index.js
printf 'untracked\n' > scratch.txt

# billing-web: history behind one remote commit, with working changes.
cd "$ROOT/billing-web"
AGE=864000 AUTHOR_NAME='Sam Rivera' commit 'Add invoice totals'
AGE=604800 AUTHOR_NAME='Maya Chen' commit 'Render the invoice table'
AGE=345600 AUTHOR_NAME='Leo Park' commit 'Add the billing settings page'
git switch -q -c feature/PROJ-124
AGE=259200 AUTHOR_NAME='Priya Nair' commit 'Start invoices'
git push -q -u origin feature/PROJ-124
cd "$ROOT"
git clone -q "$ROOT/origins/billing-web.git" billing-web-other
cd billing-web-other
git switch -q feature/PROJ-124
AGE=86400 AUTHOR_NAME='Sam Rivera' commit 'Hide invoices until rollout'
git push -q origin feature/PROJ-124
cd "$ROOT/billing-web"
git fetch -q origin
printf 'staged change\n' > staged.txt
git add staged.txt
printf 'working change\n' >> README.md

# docs-site: recent main commits, then an unstaged and an untracked file.
cd "$ROOT/docs-site"
AGE=691200 AUTHOR_NAME='Priya Nair' commit 'Outline the quick start'
AGE=345600 AUTHOR_NAME='Maya Chen' commit 'Add the configuration page'
AGE=86400 AUTHOR_NAME='Leo Park' commit 'Fix the install command'
printf '\nA line in progress.\n' >> README.md
printf 'draft\n' > draft.md

# notifications-svc: one local commit ahead of its origin branch.
cd "$ROOT/notifications-svc"
AGE=777600 AUTHOR_NAME='Leo Park' commit 'Add the notification model'
AGE=432000 AUTHOR_NAME='Sam Rivera' commit 'Wire the mailer'
git switch -q -c feature/PROJ-125
AGE=259200 AUTHOR_NAME='Priya Nair' commit 'Start notifications'
git push -q -u origin feature/PROJ-125
AGE=86400 AUTHOR_NAME='Maya Chen' commit 'Keep notifications opt-in'

rm -rf "$ROOT/billing-web-other"

# A child is never older than its parent: History would otherwise show an impossible order.
check_dates() {
    for repo in orders-api billing-web docs-site notifications-svc; do
        git -C "$ROOT/$repo" rev-list --all --timestamp --parents > "$ROOT/.dates"
        if ! awk 'NR==FNR { when[$2] = $1; next } { for (i = 3; i <= NF; i++) if (when[$i] > $1) exit 1 }' "$ROOT/.dates" "$ROOT/.dates"; then
            echo "$repo has a commit older than its parent" >&2
            rm -f "$ROOT/.dates"
            exit 1
        fi
    done
    rm -f "$ROOT/.dates"
}
check_dates
printf 'demo repositories in %s\n' "$ROOT"
