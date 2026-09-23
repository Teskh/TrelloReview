#!/bin/zsh
set -e

cd "$(dirname "$0")"

echo "Updating Trello Review..."
echo

if ! command -v git >/dev/null 2>&1; then
  echo "Git is not installed yet."
  echo "Install it with Homebrew first: brew install git"
  echo
  read "reply?Press Return to close this window."
  exit 1
fi

saved_stash=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Saving local tweaks before updating..."
  git stash push -m "local tweaks before TrelloReview update"
  saved_stash="$(git rev-parse refs/stash)"
fi

update_status=0
git pull --ff-only || update_status=$?

if [ -n "$saved_stash" ]; then
  echo "Restoring local tweaks..."
  if git stash apply "$saved_stash"; then
    if [ "$(git rev-parse refs/stash)" = "$saved_stash" ]; then
      git stash drop 'stash@{0}'
    fi
  else
    echo "Local tweaks need manual review. Their backup remains in git stash."
    exit 1
  fi
fi

if [ "$update_status" -ne 0 ]; then
  echo "Update failed; local tweaks have been restored."
  exit "$update_status"
fi

if command -v python3 >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    python3 -m venv .venv
  fi
  source .venv/bin/activate
  python -m pip install --upgrade pip
  python -m pip install -r requirements.txt
fi

echo
echo "Update complete."
echo
read "reply?Press Return to close this window."
