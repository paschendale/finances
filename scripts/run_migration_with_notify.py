#!/usr/bin/env python3
"""
Run database migrations after a release. On failure, post to Discord and exit
with a non-zero code so the release job fails loudly.
"""
import json
import os
import subprocess
import sys
import urllib.request


def notify_discord(webhook_url: str, version: str, run_url: str, error_summary: str) -> None:
    """Post a markdown message to the Discord webhook on migration failure."""
    message = (
        "## Production migration failed\n\n"
        f"**Release:** `{version}`\n\n"
        f"**Workflow run:** [View logs]({run_url})\n\n"
        "**Possible causes:**\n"
        "- Database unreachable (e.g. Tailscale not connected)\n"
        "- Migration SQL error or conflict\n"
        "- **`TAILSCALE_AUTH_KEY` may have expired** (keys expire after 90 days)\n\n"
        "Regenerate an auth key in the Tailscale admin console and update the "
        "`TAILSCALE_AUTH_KEY` repository secret."
    )
    if error_summary:
        message += f"\n\n**Error:**\n```\n{error_summary[:500]}\n```"

    body = json.dumps({"content": message}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                print(f"Discord webhook returned {resp.status}", file=sys.stderr)
    except Exception as e:
        print(f"Failed to send Discord notification: {e}", file=sys.stderr)


def main() -> int:
    repo = os.environ.get("GITHUB_REPOSITORY", "unknown")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_url = f"https://github.com/{repo}/actions/runs/{run_id}" if run_id else ""
    version = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get(
        "SEMANTIC_RELEASE_NEXT_RELEASE_VERSION", "unknown"
    )

    result = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(__file__), "migrate.py")],
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )

    if result.returncode != 0:
        webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
        if webhook_url:
            error_summary = (result.stderr or result.stdout or "").strip()
            notify_discord(webhook_url, version, run_url, error_summary)
        else:
            print("DISCORD_WEBHOOK_URL not set; skipping failure notification", file=sys.stderr)
        if result.stdout:
            print(result.stdout, file=sys.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        return result.returncode

    return 0


if __name__ == "__main__":
    sys.exit(main())
