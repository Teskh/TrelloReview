"""Install a Dock launcher for the source checkout, with the wombat icon."""
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse


def main():
    if sys.platform != "darwin":
        raise SystemExit("Run this installer on macOS.")
    root = Path(__file__).resolve().parents[1]
    launcher = root / "Start Trello Review.command"
    source = root / "assets" / "wombat-icon.png"
    if not launcher.is_file() or not source.is_file():
        raise SystemExit("The start command and assets/wombat-icon.png are required.")
    app = Path.home() / "Applications" / "Trello Review Launcher.app"
    contents = app / "Contents"
    if app.exists():
        info_file = contents / "Info.plist"
        if not info_file.exists() or plistlib.loads(info_file.read_bytes()).get("CFBundleIdentifier") != "com.teskh.trelloreview.launcher":
            raise SystemExit(f"Another app already exists at {app}; it was not changed.")
    resources = contents / "Resources"
    resources.mkdir(parents=True, exist_ok=True)
    (contents / "MacOS").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        iconset = Path(temp) / "wombat.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                suffix = "@2x" if scale == 2 else ""
                output = iconset / f"icon_{size}x{size}{suffix}.png"
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale), str(source), "--out", str(output)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "wombat.icns")], check=True)
    executable = contents / "MacOS" / "launch"
    executable.write_text("#!/bin/zsh\nexec /usr/bin/open " + shlex.quote(str(launcher)) + "\n")
    executable.chmod(0o755)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": "com.teskh.trelloreview.launcher",
        "CFBundleName": "Trello Review", "CFBundleDisplayName": "Trello Review",
        "CFBundleExecutable": "launch", "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "wombat.icns", "CFBundleVersion": "1",
        "LSUIElement": True,
    }))
    raw = subprocess.check_output(["defaults", "export", "com.apple.dock", "-"])
    backup = root / ".appdata" / "dock-before-wombat-launcher.plist"
    backup.parent.mkdir(exist_ok=True)
    if not backup.exists():
        backup.write_bytes(raw)
    prefs = plistlib.loads(raw)
    def ours(tile):
        url = tile.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")
        return unquote(urlparse(url).path).rstrip("/") in {str(launcher), str(app)}
    for section in ("persistent-apps", "persistent-others"):
        tiles = [t for t in prefs.get(section, []) if not ours(t)]
        if section == "persistent-apps":
            tiles.append({"tile-type": "file-tile", "tile-data": {
                "file-data": {"_CFURLString": app.as_uri() + "/", "_CFURLStringType": 15},
                "file-label": "Trello Review", "file-type": 41,
            }})
        subprocess.run(["defaults", "write", "com.apple.dock", section, "-array", *[plistlib.dumps(t).decode() for t in tiles]], check=True)
    subprocess.run(["killall", "Dock"], check=True)
    print(f"Installed {app}. The wombat Dock icon opens the existing Terminal launcher.")


if __name__ == "__main__":
    main()
