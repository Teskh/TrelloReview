# Trello Review

Local Trello review workbench. The app reads Trello data and local review files, then runs checklist reviews through the OpenAI API.

## macOS setup

1. Install Python 3.12 or newer.
2. Clone the repo.
3. Create a local environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

4. Create `.env` from `.env.example` and fill in the Trello and OpenAI keys.
5. Run the app:

```bash
python trello_ui_server.py
```

The app serves a local browser UI, normally at `http://127.0.0.1:9266`.

## Local files

The repo intentionally does not track `.env`, `review_workspace/`, virtual environments, build output, or local app data.
