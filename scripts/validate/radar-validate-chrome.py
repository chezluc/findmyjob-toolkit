#!/usr/bin/env python3
"""
RADAR Validate via Chrome bridge + llama3.
Loads each URL in Chrome, extracts text, sends to llama3 for:
- active / not-active / unknown
- city/location
Saves after every URL. Uploads to Google Sheets when done.
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


def bridge_command(cmd_type, payload, tab_id, timeout=20):
    cmd_id = f"val_{int(time.time() * 1000)}"
    body = {"id": cmd_id, "type": cmd_type, "payload": payload, "targetTabId": tab_id}
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BRIDGE_URL}/commands", data=data,
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1)
        try:
            poll = urllib.request.urlopen(
                f"{BRIDGE_URL}/commands/{urllib.parse.quote(cmd_id)}"
            )
            result = json.loads(poll.read())
            if result.get("status") == "completed":
                return result.get("response", {})
        except Exception:
            pass
    return None


def create_tabs(count=5):
    """Create multiple background tabs and return their IDs."""
    tabs = []
    urls = [
        "https://example.com",
        "https://example.org",
        "https://example.net",
        "https://httpbin.org/html",
        "https://www.w3.org",
    ]
    for i in range(count):
        cmd_id = f"tab_{int(time.time() * 1000)}_{i}"
        # Don't pass targetTabId so the bridge creates a NEW tab each time
        body = {"id": cmd_id, "type": "OPEN_URL", "payload": {"url": urls[i % len(urls)], "active": False}}
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{BRIDGE_URL}/commands", data=data,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req)
        time.sleep(3)
        try:
            poll = urllib.request.urlopen(f"{BRIDGE_URL}/commands/{urllib.parse.quote(cmd_id)}")
            result = json.loads(poll.read())
            tab_id = result.get("response", {}).get("run", {}).get("tabId")
            if tab_id and tab_id not in tabs:
                tabs.append(tab_id)
                print(f"  Tab {i+1}: {tab_id}")
            else:
                print(f"  Tab {i+1}: duplicate {tab_id}, skipping")
        except Exception:
            pass
    return tabs


def navigate_tab(url, tab_id):
    """Navigate an existing tab to a new URL."""
    bridge_command("OPEN_URL", {"url": url, "active": False}, tab_id)


def extract_tab(tab_id):
    """Extract text from a tab."""
    code = 'return { text: document.body?.innerText?.substring(0, 3000) || "", title: document.title || "", url: location.href || "" };'
    r = bridge_command("RUN_SNIPPET", {"code": code, "world": "MAIN", "snippetName": "validate"}, tab_id)
    if r and r.get("ok") and r.get("run", {}).get("result"):
        return r["run"]["result"]
    return {"text": "", "title": "", "url": ""}


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
    if re.search(r"/(jobs|careers|openings|positions)/?$", path):
        return True
    if re.match(r"https?://jobs\.lever\.co/[^/]+$", path):
        return True
    if re.match(r"https?://.*greenhouse\.io/[^/]+$", path):
        return True
    if re.match(r"https?://jobs\.ashbyhq\.com/[^/]+$", path):
        return True
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
    print(f"Loaded {total} URLs — revalidating all")

    # Create 5 reusable background tabs
    print("Creating 5 background tabs...")
    tabs = create_tabs(5)
    if not tabs:
        print("ERROR: Could not create tabs")
        return
    print(f"Created {len(tabs)} tabs")

    # Collect rows that need validation
    pending = []
    for i, row in enumerate(rows):
        url = row.get("url", "")
        if not url:
            row["validation_status"] = "not-active"
            row["validation_reason"] = "no URL"
            row["city"] = ""
            continue
        if is_index_page(url):
            row["validation_status"] = "not-active"
            row["validation_reason"] = "index page"
            row["city"] = ""
            continue
        pending.append((i, row))

    print(f"{len(pending)} URLs to validate")

    # Process in batches of 5
    batch_size = len(tabs)
    for batch_start in range(0, len(pending), batch_size):
        batch = pending[batch_start:batch_start + batch_size]

        # Step 1: Navigate all tabs in the batch
        for j, (idx, row) in enumerate(batch):
            tab = tabs[j]
            url = row["url"]
            navigate_tab(url, tab)

        # Step 2: Wait for page to load (longer for JS-heavy sites)
        time.sleep(10)

        # Step 3: Extract text from each and analyze
        for j, (idx, row) in enumerate(batch):
            tab = tabs[j]
            url = row["url"]
            print(f"[{batch_start + j + 1}/{len(pending)}] {url[:70]}")

            data = extract_tab(tab)
            text = data.get("text", "")

            if len(text) < 30:
                row["validation_status"] = "unknown"
                row["validation_reason"] = "empty page"
                row["city"] = ""
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
                    print(f"  {icon} {result.get('job_title','')} @ {result.get('company','')} — {result.get('city','')}")
                else:
                    row["validation_status"] = "unknown"
                    row["validation_reason"] = "llama3 failed"
                    row["city"] = ""
                    print(f"  ? llama3 failed")

        # Save after every batch
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
