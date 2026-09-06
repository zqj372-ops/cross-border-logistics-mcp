"""Verify that Cloudflare passes ordinary Python API clients to FreightClaw."""
import json
import sys
import urllib.error
import urllib.request

BASE = "https://www.freightclaw.net"
CASES = (
    ("/console/readyz", 200),
    ("/console/openapi.json", 200),
    ("/access/v2/tools/token/exchange", 403),
    ("/api/v2/tools/cargo.calculate", 403),
)


def fetch(path: str) -> tuple[int, str, str]:
    try:
        response = urllib.request.urlopen(BASE + path, timeout=15)
        body = response.read(1_048_577)
        if len(body) > 1_048_576:
            raise ValueError("response_body_too_large")
        return response.status, response.headers.get("content-type", ""), body.decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("content-type", ""), error.read(512).decode("utf-8", "replace")


failed = False
for path, expected_status in CASES:
    status, content_type, body = fetch(path)
    structured = content_type.lower().startswith("application/json")
    valid = status == expected_status and structured
    if structured:
        try:
            json.loads(body)
        except json.JSONDecodeError:
            valid = False
    print(json.dumps({"path": path, "status": status, "content_type": content_type, "passed": valid}))
    failed = failed or not valid
sys.exit(1 if failed else 0)
