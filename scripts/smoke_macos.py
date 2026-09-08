"""Check the packaged HTTP server without contacting Trello or OpenAI."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


def main():
    app = Path(sys.argv[1]).resolve()
    executable = app / "Contents" / "MacOS" / "Trello Review"
    with tempfile.TemporaryDirectory(prefix="trello-smoke-") as temp:
        env = dict(os.environ, TRELLO_REVIEW_APP_HOME=temp, API_KEY="packaging-test", TOKEN="packaging-test")
        for mode in ("foreground", "tray"):
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            args = [str(executable), "--no-browser", "--port", str(port)]
            if mode == "foreground":
                args.append("--no-tray")
            with open(Path(temp) / f"{mode}.log", "w+") as log:
                process = subprocess.Popen(args, cwd=temp, env=env, stdout=log, stderr=log)
                try:
                    base = f"http://127.0.0.1:{port}"
                    deadline = time.monotonic() + 45
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise RuntimeError(f"{mode} app exited with {process.returncode}")
                        try:
                            with urlopen(base + "/api/status", timeout=1) as response:
                                assert json.load(response)["ok"] is True
                            break
                        except (URLError, TimeoutError):
                            time.sleep(0.25)
                    else:
                        raise RuntimeError(f"{mode} server did not become ready")
                    with urlopen(base + "/", timeout=5) as response:
                        assert b"gpt-6-astra" in response.read()
                    with urlopen(base + "/api/checklist", timeout=5) as response:
                        assert "parsed" in json.load(response)
                    time.sleep(2)
                    assert process.poll() is None, f"{mode} app exited after startup"
                    print(f"PASS: packaged {mode} startup, UI assets, and checklist")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    log.seek(0)
                    print(log.read())


if __name__ == "__main__":
    main()
