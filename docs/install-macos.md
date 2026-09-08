# Install Trello Review on a Mac

## Get the app

1. Open the repository's **Actions** tab and select the successful **Build macOS app** run.
2. Download the artifact for her Mac. In **Apple menu > About This Mac**, an Apple M-series chip needs `arm64`; an Intel processor needs `x86_64`.
3. Extract the GitHub artifact download. Inside is `Trello-Review-macos-arm64.zip` or `Trello-Review-macos-x86_64.zip`.
4. Send that inner ZIP through your usual file-sharing service. Keep it zipped until it reaches her Mac, so executable permissions and app links survive the transfer.
5. On her Mac, unzip it and drag **Trello Review.app** into **Applications**.

The app includes Python and its dependencies. She does not need to install them.
The runner builds on macOS 15. Older macOS versions have not been verified.

## Move her existing configuration once

1. Quit the old running copy.
2. In Finder, choose **Go > Go to Folder** and enter `~/Library/Application Support/Trello Review Workbench/`.
3. Copy the `.env` file from her existing repository folder into that folder. Press **Command-Shift-.** to show hidden files. If the destination folder does not exist yet, create it.
4. Keep the original review data folder in place. The app reuses the saved `settings.json` data location. Without a saved location, it uses `~/Documents/Trello App/`.

Credentials are not included in the downloadable app. Do not upload her `.env` to GitHub.

## Open it

Open **Trello Review** from Applications or Spotlight. It opens the browser and adds a menu bar icon. Use **Salir** from that icon to quit; closing the browser alone leaves the app running.

This build is ad-hoc signed, not Apple-notarized. If macOS blocks the first launch, follow [Apple's instructions](https://support.apple.com/en-gb/102445): attempt to open it, then use **System Settings > Privacy & Security > Open Anyway** for this app.

For the next manual update, quit Trello Review and replace the app in Applications with the new copy. Leave the credentials and data folders in place.

## Build another copy

Push the packaging branch to run the GitHub build. Once the workflow is on the default branch, it can also be started from **Actions > Build macOS app > Run workflow**.

To build directly on a Mac with Python 3.12 or newer:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/build_macos.py
```

The ZIP is written to `dist/`. The build verifies the bundle signature and checks server startup in foreground and menu bar modes using placeholder credentials. It does not call Trello or OpenAI.
