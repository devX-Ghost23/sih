#!/usr/bin/env python3
"""ThermalWatch task runner. Works on Windows, macOS and Linux with no extra tools.

    python tw.py up          start database, API and dashboard (Docker)
    python tw.py demo        load the synthetic scenario and classify it
    python tw.py ingest      pull recent detections from NASA FIRMS
    python tw.py classify    classify anything not yet classified
    python tw.py train       train the XGBoost model on weak labels
    python tw.py evaluate    score predictions against stored labels
    python tw.py test        run the unit tests (no Docker needed)
    python tw.py logs        follow API and dashboard logs
    python tw.py down        stop everything
    python tw.py db-only     start only the database (for local dev)
    python tw.py setup-local install the pipeline into the current Python environment

Anything after the command is passed through, e.g.
    python tw.py ingest --days 3 --bbox 69,21,73,24
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIPELINE = ROOT / "pipeline"


def fail(msg: str) -> None:
    print(f"\n{msg}\n", file=sys.stderr)
    raise SystemExit(1)


def compose_cmd() -> list[str]:
    """Docker Compose v2 ('docker compose') with a fallback to the old v1 binary."""
    if shutil.which("docker"):
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True)
        if probe.returncode == 0:
            return ["docker", "compose"]
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    fail("Docker was not found. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux),\n"
         "or run without Docker: python tw.py db-only is not available either, see README.")


def run(cmd: list[str], cwd: Path = ROOT, env: dict | None = None) -> int:
    print("->", " ".join(cmd))
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, cwd=str(cwd), env=full_env).returncode


def pipeline_task(args: list[str]) -> int:
    """Run a pipeline command, in Docker if it is running, otherwise locally."""
    dc = compose_cmd()
    return run([*dc, "run", "--rm", "pipeline", *args])


def cmd_up(rest):
    return run([*compose_cmd(), "up", "-d", "--build", *rest])


def cmd_down(rest):
    return run([*compose_cmd(), "down", *rest])


def cmd_logs(rest):
    return run([*compose_cmd(), "logs", "-f", *(rest or ["api", "web"])])


def cmd_db_only(rest):
    return run([*compose_cmd(), "up", "-d", "db", *rest])


def cmd_test(rest):
    """Runs locally, no Docker. Sets PYTHONPATH through the environment rather than
    shell syntax, which differs between bash, PowerShell and cmd."""
    try:
        subprocess.run([sys.executable, "-c", "import pytest"], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        fail("pytest is not installed. Run: python tw.py setup-local dev")
    return run([sys.executable, "-m", "pytest", "-q", *rest], cwd=PIPELINE,
               env={"PYTHONPATH": str(PIPELINE)})


def cmd_setup_local(rest):
    extras = rest[0] if rest else "all"
    if sys.prefix == sys.base_prefix:
        print("Note: you are not in a virtual environment. If pip refuses to install, create one first:\n"
              "  python -m venv .venv\n"
              "  Windows:  .venv\\Scripts\\activate\n"
              "  macOS/Linux:  source .venv/bin/activate\n")
    print(f"Installing the pipeline package with extras: [{extras}]")
    code = run([sys.executable, "-m", "pip", "install", "-e", f".[{extras}]"], cwd=PIPELINE)
    if code == 0:
        print("\nDone. You can now run:  thermalwatch demo   (or: python -m thermalwatch.cli demo)")
    return code


TASKS = {
    "up": cmd_up,
    "down": cmd_down,
    "logs": cmd_logs,
    "db-only": cmd_db_only,
    "test": cmd_test,
    "setup-local": cmd_setup_local,
    "demo": lambda rest: pipeline_task(["demo", *rest]),
    "ingest": lambda rest: pipeline_task(["ingest-firms", *(rest or ["--days", "2"])]),
    "classify": lambda rest: pipeline_task(["classify", *rest]),
    "train": lambda rest: pipeline_task(["train", *rest]),
    "evaluate": lambda rest: pipeline_task(["evaluate", *(rest or ["--warmup-days", "180"])]),
    "init-db": lambda rest: pipeline_task(["init-db", *rest]),
}


def main() -> int:
    if sys.version_info < (3, 10):
        fail(f"Python 3.10 or newer is required (found {sys.version.split()[0]}).")
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    task, rest = sys.argv[1], sys.argv[2:]
    if task not in TASKS:
        fail(f"Unknown command '{task}'. Run 'python tw.py --help' for the list.")
    return TASKS[task](rest)


if __name__ == "__main__":
    raise SystemExit(main())
