#!/usr/bin/env python3
"""Dev shim — run the bridge straight from a repo checkout, no install needed:

    python3 server/rc_bridge.py [--port …]

The real code lives in the `claude_remote_bridge` package next to this file
(a sibling `../claude-rc-api` checkout is auto-detected). Installed / uvx
usage runs the `claude-remote-bridge` entry point instead.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from claude_remote_bridge.bridge import main

if __name__ == "__main__":
    main()
