#!/usr/bin/env python3
"""
RADAR Validate v2 — open each URL in Chrome via AppleScript (so it actually renders),
then use the bridge to extract text, then send to llama3.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request

BRIDGE_URL = "http://127.0.0.1:4471"
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"


def bridge_extract(tab_id, timeout=15):
    """Extract text from a tab via bridge."""
    cmd_id = f"ext_{int(time.time() * 1000)}"
    code = 'return { text: document.body?.innerText?.substring(0, 3000) || "", title: document.title || "", url: location.href || "" };'
    body = {"id": cmd_id, "type": "RUN_SNIPPET", "payload": {"code": code, "world": "MAIN", "snippetName": "extract"}, "targetTabId": tab_id}
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BRIDGE_URL}/commands", data=data, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1)
        try:
            poll = urllib.request.urlopen(f"{BRIDGE_URL}/commands/{urllib.parse.quote(cmd_id)}")
            result = json.loads(poll.read())
            if result.get("status") == "completed":
                return result.get("response", {}).get("run", {}).get("result", {})
        except Exception:
            pass
    return {"text": "", "title": "", "url": ""}


def open_url_in_chrome(url):
    """Open URL in Chrome via AppleScript — forces Chrome to render it."""
    subprocess.run(["osascript", "-e", f'tell application "Google Chrome" to open location "{url}"'], timeout=5)


def get_active_tab_id():
    """Get the tab ID of Chrome's active tab via bridge."""
    cmd_id = f"tabid_{int(time.time() * 1000)}"
    code = 'return { tabId: null };'  # We'll get it from the response
    body = {"id": cmd_id, "type": "RUN_SNIPPET", "payload": {"code": "return {url: location.href}", "world": "MAIN", "snippetName": "gettab"}}
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BRIDGE_URL}/commands", data=data, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req)
    time.sleep(3)
    try:
        poll = urllib.request.urlopen(f"{BRIDGE_URL}/commands/{urllib.parse.quote(cmd_id)}")
        result = json.loads(poll.read())
        return result.get("response", {}).get("run", {}).get("tabId")
    except Exception:
        return None


def analyze_with_llama(page_text):
    body = json.dumps({
        "model": "llama3:latest",
        "messages": [
            {"role": "user", "content": f'Analyze this webpage text. If it is a SINGLE job description (one specific role at one company), return a JSON object. If it is a job board index, search results, list of multiple jobs, help article, or anything other than a single job posting, return {{"is_active": false}}.\n\nReturn ONLY a JSON object with: "is_active" (true only if single job listing), "job_title" (string), "company" (string), "city" (string - city where job is located, or "Remote", or ""), "date_posted" (string - posting date if found, or ""). No other text.\n\n{page_text[:2000]}'}
        ],
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 150}
    }).encode()

    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read())
        content = data.get("message", {}).get("content", "")
        json_match = re.search(r'\{.*\}', content, re.DOTALL)
        if json_match:
            return json.loads(json_match.group())
        return None
    except Exception as e:
        print(f"    llama3 error: {e}")
        return None


def is_index_page(url):
    path = url.rstrip("/").split("?")[0]
    if re.search(r"/(jobs|careers|openings|positions)/?$", path): return True
    if re.match(r"https?://jobs\.lever\.co/[^/]+$", path): return True
    if re.match(r"https?://.*greenhouse\.io/[^/]+$", path): return True
    if re.match(r"https?://jobs\.ashbyhq\.com/[^/]+$", path): return True
    if re.match(r"https?://[^/]+\.breezy\.hr/?$", path): return True
    if re.match(r"https?://[^/]+\.recruitee\.com/?$", path): return True
    if re.match(r"https?://wellfound\.com/role/", path): return True
    if "/help/" in url or "/hc/" in url or "/blog/" in url: return True
    if "/articles/" in url: return True
    if "api.lever.co" in url: return True
    if "/job-category/" in url: return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    args = parser.parse_args()

    with open(args.csv) as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames
        rows = list(reader)

    for col in ["validation_status", "validation_reason", "job_title_detected", "company_detected", "city", "date_posted"]:
        if col not in headers:
            headers.append(col)

    total = len(rows)
    print(f"Loaded {total} URLs")

    for i, row in enumerate(rows):
        url = row.get("url", "")
        if not url:
            row["validation_status"] = "not-active"
            row["validation_reason"] = "no URL"
            continue

        if is_index_page(url):
            row["validation_status"] = "not-active"
            row["validation_reason"] = "index page"
            print(f"[{i+1}/{total}] SKIP index: {url[:50]}")
            continue

        print(f"[{i+1}/{total}] {url[:70]}")

        # Open in Chrome (actually renders the page)
        open_url_in_chrome(url)
        time.sleep(8)

        # Get the tab ID that just opened
        tab_id = get_active_tab_id()
        if not tab_id:
            row["validation_status"] = "unknown"
            row["validation_reason"] = "no tab"
            print(f"  ? no tab")
            continue

        # Extract text
        data = bridge_extract(tab_id)
        text = data.get("text", "")

        if len(text) < 30:
            row["validation_status"] = "unknown"
            row["validation_reason"] = "empty page"
            row["city"] = ""
            row["date_posted"] = ""
            print(f"  ? empty page")
        else:
            result = analyze_with_llama(text)
            if result:
                is_active = result.get("is_active", False)
                row["validation_status"] = "active" if is_active else "not-active"
                row["validation_reason"] = "llama3"
                row["job_title_detected"] = result.get("job_title", "")
                row["company_detected"] = result.get("company", "")
                row["city"] = result.get("city", "")
                row["date_posted"] = result.get("date_posted", "")
                icon = "✓" if is_active else "✗"
                print(f"  {icon} {result.get('job_title','')} @ {result.get('company','')} — {result.get('city','')} ({result.get('date_posted','')})")
            else:
                row["validation_status"] = "unknown"
                row["validation_reason"] = "llama3 failed"
                row["city"] = ""
                row["date_posted"] = ""
                print(f"  ? llama3 failed")

        # Close the tab (Cmd+W via AppleScript)
        subprocess.run(["osascript", "-e", '''
            tell application "System Events"
                tell process "Google Chrome"
                    keystroke "w" using command down
                end tell
            end tell
        '''], timeout=5)
        time.sleep(0.5)

        # Save after every 5
        if (i + 1) % 5 == 0:
            with open(args.csv, "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=headers)
                w.writeheader()
                w.writerows(rows)

    # Final save
    with open(args.csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerows(rows)

    active = sum(1 for r in rows if r.get("validation_status") == "active")
    inactive = sum(1 for r in rows if r.get("validation_status") == "not-active")
    unknown = sum(1 for r in rows if r.get("validation_status") == "unknown")
    print(f"\nDone. Active: {active} | Not-active: {inactive} | Unknown: {unknown}")

    # Upload
    print("Uploading to Google Sheets...")
    subprocess.run(
        ["bash", "-c",
         f'source ~/Dropbox/claudeprojects/gsheets_venv/bin/activate && '
         f'python3 ~/Dropbox/claudeprojects/upload_csv_to_google_sheets.py '
         f'"{args.csv}" "RADAR — product designer"'],
        capture_output=True, text=True, timeout=60,
    )
    print("Uploaded.")


if __name__ == "__main__":
    main()
