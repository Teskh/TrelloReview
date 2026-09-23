#!/bin/zsh
set -e

cd "$(dirname "$0")"

APP_URL="http://127.0.0.1:9266"
if /usr/bin/curl -fsS "$APP_URL/api/status" >/dev/null 2>&1; then
  echo "Trello Review is already running. Opening it in your browser..."
  /usr/bin/open "$APP_URL"
  exit 0
fi

echo "Starting Trello Review..."
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed yet."
  echo "Install it with Homebrew first: brew install python"
  echo
  read "reply?Press Return to close this window."
  exit 1
fi

if [ ! -x ".venv/bin/python3" ]; then
  if [ -d ".venv" ]; then
    backup=".venv.broken.$(date +%Y%m%d%H%M%S)"
    echo "The local Python environment is incomplete. Moving it to $backup..."
    mv .venv "$backup"
  else
    echo "First run: creating the local Python environment..."
  fi
  python3 -m venv .venv
fi

PYTHON="$(pwd)/.venv/bin/python3"

REQ_MARKER=".venv/.requirements-installed"

if [ ! -f "$REQ_MARKER" ] || [ "requirements.txt" -nt "$REQ_MARKER" ]; then
  echo "Checking Python packages..."
  "$PYTHON" -m pip install --disable-pip-version-check -r requirements.txt
  touch "$REQ_MARKER"
else
  echo "Python packages are already installed."
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo
  echo "A .env file was created. Add the Trello and OpenAI keys there, then run this again."
  echo
  read "reply?Press Return to close this window."
  exit 1
fi

echo
echo "Opening Trello Review in your browser..."
echo "Keep this window open while using the app."
echo

"$PYTHON" trello_ui_server.py
