"""Build the macOS app and a ZIP that preserves its executable permissions."""
from pathlib import Path
import platform
import subprocess
import sys


def main():
    if sys.platform != "darwin":
        raise SystemExit("Build this app on macOS, or use the Build macOS app GitHub workflow.")
    root = Path(__file__).resolve().parents[1]
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--windowed", "--onedir", "--name", "Trello Review",
        "--osx-bundle-identifier", "com.teskh.trelloreview",
        "--specpath", str(root / "build" / "macos-spec"),
        "--distpath", str(root / "dist"),
        "--workpath", str(root / "build" / "macos"),
        "--add-data", f"{root / 'ui'}:ui",
        "--add-data", f"{root / 'defaults'}:defaults",
        "--hidden-import", "pystray._darwin",
        "--hidden-import", "fitz",
        "--collect-submodules", "tiktoken_ext",
        str(root / "trello_ui_server.py"),
    ], cwd=root, check=True)
    app = root / "dist" / "Trello Review.app"
    if not app.is_dir():
        raise RuntimeError("PyInstaller did not produce the macOS app bundle")
    if any(p.name == ".env" or p.name == "review_workspace" for p in app.rglob("*")):
        raise RuntimeError("The app bundle must not contain credentials or review data")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    subprocess.run([sys.executable, str(root / "scripts" / "smoke_macos.py"), str(app)], check=True)
    archive = root / "dist" / f"Trello-Review-macos-{platform.machine()}.zip"
    subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)], check=True)
    print(f"Ready to send: {archive}")


if __name__ == "__main__":
    main()
