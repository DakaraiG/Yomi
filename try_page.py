#!/usr/bin/env python3
"""Poke the Yomi sidecar with a real page.

    ./try_page.py path/to/page.jpg [--port 8001] [--no-open]

Prints the reading order + OCR text, then writes the annotated debug render
next to the input as <name>.debug.png and opens it.
"""

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("image", type=pathlib.Path)
parser.add_argument("--port", default="8001")
parser.add_argument("--no-open", action="store_true")
args = parser.parse_args()

if not args.image.is_file():
    sys.exit(f"no such file: {args.image}")

body = json.dumps(
    {"imageB64": base64.b64encode(args.image.read_bytes()).decode()}
).encode()
base = f"http://127.0.0.1:{args.port}"


def post(path):
    req = urllib.request.Request(
        base + path, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} -> {e.code}\n{e.read().decode()[:2000]}")
    except urllib.error.URLError as e:
        sys.exit(f"can't reach {base} ({e.reason}) -- is ./run.sh running?")


result = json.loads(post("/detect"))
print(f"{result['naturalWidth']}x{result['naturalHeight']}, "
      f"{len(result['regions'])} regions\n")
for region in sorted(result["regions"], key=lambda r: r["order"]):
    conf = region["detConfidence"]
    print(f"  {region['order']:>2}. {'vert' if region['vertical'] else 'horz'} "
          f"conf={conf:.2f}  {region['japanese']}" if conf is not None else
          f"  {region['order']:>2}. {'vert' if region['vertical'] else 'horz'} "
          f"           {region['japanese']}")

out = args.image.with_suffix(".debug.png")
out.write_bytes(post("/detect/debug"))
print(f"\nannotated render -> {out}")
if not args.no_open:
    subprocess.run(["open", str(out)], check=False)
