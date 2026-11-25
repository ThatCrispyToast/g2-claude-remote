"""Read process and checkout configuration for the bridge and its optional services."""

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_file() -> dict[str, str]:
    """KEY=VALUE pairs from `.env.local` (the app's config file), so one file
    can configure both sides. Looked for in the CWD first, then the repo
    checkout this module sits in. Comments/blanks skipped, quotes stripped."""
    out: dict[str, str] = {}
    for candidate in (Path.cwd() / ".env.local", REPO_ROOT / ".env.local"):
        try:
            text = candidate.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            out[key.strip()] = value.split(" #", 1)[0].strip().strip("'\"")
        break
    return out


FILE_VALUES = _env_file()


def config_value(key: str, default: str = "") -> str:
    """A config value: the process env wins, then `.env.local`, then `default`."""
    return os.environ.get(key) or FILE_VALUES.get(key) or default
