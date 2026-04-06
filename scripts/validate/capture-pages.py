#!/usr/bin/env python3
"""
Capture page text from URLs via Firefox using AppleScript.
Opens each URL, Cmd+A, Cmd+C, saves clipboard to txt, closes tab.
"""

import csv
import os
import subprocess
import sys
import time

OUT_DIR = os.path.expanduser("~/Dropbox/liz.school.1/runs/radar/page-captures")
CSV_PATH = os.path.expanduser("~/Dropbox/liz.school.1/runs/radar/20260403-203615-product-designer-discovery.csv")


def capture_url(url, out_path):
    """Navigate same Firefox tab to URL, select all, copy, save."""
    script = f'''
set delayOne to 0.4
set pageDelay to 7

set the clipboard to "{url}"

tell application "Firefox" to activate
delay delayOne

tell application "System Events"
    -- focus address bar
    keystroke "l" using command down
    delay delayOne

    -- select all in address bar
    keystroke "a" using command down
    delay delayOne

    -- paste URL
    keystroke "v" using command down
    delay delayOne

    -- go
    key code 36
    delay pageDelay

    -- select all page content
    keystroke "a" using command down
    delay 0.5

    -- copy
    keystroke "c" using command down
    delay 0.5

end tell
'''
    subprocess.run(["osascript", "-e", script], timeout=20)
    time.sleep(0.5)

    # Read clipboard
    result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=5)
    text = result.stdout.strip()

    # Save
    with open(out_path, "w") as f:
        f.write(f"URL: {url}\n\n{text}")

    return len(text)


def main():
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 50

    os.makedirs(OUT_DIR, exist_ok=True)

    # Load URLs
    seen = set()
    urls = []
    with open(CSV_PATH) as f:
        for row in csv.DictReader(f):
            base = row["url"].split("#")[0]
            if base not in seen:
                seen.add(base)
                urls.append(base)

    end = min(start + count, len(urls))
    print(f"Capturing URLs {start+1} to {end} of {len(urls)}")

    for i in range(start, end):
        url = urls[i]
        out_path = os.path.join(OUT_DIR, f"page-{i+1:04d}.txt")

        # Skip if already captured
        if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
            print(f"[{i+1}] SKIP (already captured)")
            continue

        print(f"[{i+1}/{end}] {url[:70]}", flush=True)
        chars = capture_url(url, out_path)
        print(f"  {chars} chars")

    print(f"\nDone — captured {end - start} pages")


if __name__ == "__main__":
    main()
