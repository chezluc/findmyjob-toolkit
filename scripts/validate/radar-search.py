#!/usr/bin/env python3
"""
RADAR — Discovery + Inspection for job listings.

1. Takes queries from discover-jobs.mjs output
2. Googles each query via the Chrome bridge (reusing 1 tab)
3. Collects candidate job URLs
4. Opens each in Firefox via AppleScript, copies page text
5. Sends page text to DeepSeek to analyze if it's a real, active listing
6. Uploads validated results to Google Sheets incrementally

Usage:
    python3 radar-search.py --queries path/to/queries.json [--tab TAB_ID] [--title "product designer"]
"""

import argparse
import csv
import json
import os
import random
import re
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime

BRIDGE_URL = "http://127.0.0.1:4471"
OUTPUT_DIR = os.path.expanduser("~/Dropbox/liz.school.1/runs/radar")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"


def get_deepseek_key():
    result = subprocess.run(
        ["security", "find-generic-password", "-a", "deepseek", "-s", "deepseek-api-key", "-w"],
        capture_output=True, text=True, timeout=5,
    )
    return result.stdout.strip()


def bridge_command(cmd_type, payload, target_tab_id=None, timeout=20):
    cmd_id = f"radar_{int(time.time() * 1000)}"
    body = {"id": cmd_id, "type": cmd_type, "payload": payload}
    if target_tab_id:
        body["targetTabId"] = target_tab_id
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BRIDGE_URL}/commands",
        data=data,
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


def create_background_tab():
    r = bridge_command("OPEN_URL", {"url": "https://www.google.com", "active": False})
    if r and r.get("run", {}).get("tabId"):
        return r["run"]["tabId"]
    return None


def google_search_url(query):
    return f"https://www.google.com/search?q={urllib.parse.quote(query)}&num=20"


def extract_google_results(tab_id):
    code = """
    const links = document.querySelectorAll('a[href]');
    const results = [];
    const seen = new Set();
    links.forEach(a => {
        const href = a.href;
        if (!href) return;
        if (href.includes('google.com')) return;
        if (href.includes('youtube.com')) return;
        if (href.includes('webcache')) return;
        if (href.startsWith('javascript:')) return;
        if (href.includes('#:~:text=')) return;
        let url = href;
        const match = href.match(/[?&]q=([^&]+)/);
        if (match) url = decodeURIComponent(match[1]);
        if (url.includes('#:~:text=')) return;
        // Strip fragment to dedupe
        const base = url.split('#')[0];
        if (seen.has(base)) return;
        seen.add(base);
        url = base;
        const text = a.textContent?.trim()?.substring(0, 200) || '';
        results.push({ url, text });
    });
    return results;
    """
    r = bridge_command(
        "RUN_SNIPPET",
        {"code": code, "world": "MAIN", "snippetName": "google extract"},
        target_tab_id=tab_id,
    )
    if r and r.get("ok") and r.get("run", {}).get("result"):
        return r["run"]["result"]
    return []


def is_job_url(url):
    job_patterns = [
        "greenhouse.io", "lever.co", "workable.com", "myworkdayjobs.com",
        "icims.com", "ashbyhq.com", "bamboohr.com", "breezy.hr",
        "jobvite.com", "smartrecruiters.com", "careers", "jobs",
        "/job/", "/position/", "/opening/", "paylocity.com",
        "myworkdaysite.com", "gem.com", "dover.io", "rippling-ats.com",
        "wellfound.com", "builtin.com", "pinpointhq.com",
        "recruitee.com", "jazzhr.com", "oraclecloud.com",
        "successfactors.com", "adp.com", "ultipro.com",
        "talentnet.community", "willhire.com",
    ]
    url_lower = url.lower()
    return any(p in url_lower for p in job_patterns)


def grab_firefox_page(url):
    """Navigate current Firefox tab to URL, Cmd+A, Cmd+C, return clipboard text."""
    try:
        # Use Cmd+L to focus address bar, type URL, press Enter (reuses same tab)
        subprocess.run(
            ["osascript", "-e", '''
                tell application "Firefox" to activate
                delay 0.5
                tell application "System Events"
                    tell process "Firefox"
                        keystroke "l" using command down
                        delay 0.3
                        keystroke "a" using command down
                        delay 0.1
                    end tell
                end tell
            '''],
            timeout=5,
        )
        time.sleep(0.3)
        # Type URL separately to avoid AppleScript escaping issues
        subprocess.run(
            ["osascript", "-e", f'tell application "System Events" to keystroke "{url}"'],
            timeout=5,
        )
        time.sleep(0.3)
        subprocess.run(
            ["osascript", "-e", 'tell application "System Events" to key code 36'],
            timeout=5,
        )
        time.sleep(6)

        subprocess.run(
            ["osascript", "-e", '''
                tell application "System Events"
                    tell process "Firefox"
                        keystroke "a" using command down
                        delay 0.5
                        keystroke "c" using command down
                        delay 0.5
                    end tell
                end tell
            '''],
            timeout=10,
        )
        time.sleep(0.5)

        result = subprocess.run(
            ["pbpaste"], capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception as e:
        return f"ERROR: {e}"


def analyze_with_deepseek(page_text, title, api_key):
    """Send page text to DeepSeek to determine if it's a real, active job listing."""
    # Truncate to avoid token limits
    truncated = page_text[:4000]

    prompt = f"""Analyze this webpage text and determine if it is an active, real job listing for "{title}" or a closely related role.

Return ONLY a JSON object with these fields:
- "is_active_listing": true/false
- "job_title": the exact job title if found, or ""
- "company": the company name if found, or ""
- "location": the location if found, or ""
- "remote": true/false/null if unclear
- "reason": brief explanation of your determination
- "salary": salary range if mentioned, or ""

Page text:
{truncated}"""

    body = json.dumps({
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": 300,
    }).encode()

    req = urllib.request.Request(
        DEEPSEEK_API_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read())
        content = data["choices"][0]["message"]["content"].strip()
        # Try to parse JSON from the response
        json_match = re.search(r'\{.*\}', content, re.DOTALL)
        if json_match:
            return json.loads(json_match.group())
        return {"is_active_listing": False, "reason": f"Could not parse: {content[:200]}"}
    except Exception as e:
        return {"is_active_listing": False, "reason": f"API error: {e}"}


def notify(msg):
    try:
        data = json.dumps({"to": "luke@chezluc.com", "message": msg}).encode()
        req = urllib.request.Request(
            "http://127.0.0.1:8423/send",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def save_discovery_csv(candidates, output_csv):
    """Save discovery candidates to CSV."""
    if not candidates:
        return
    headers = ["url", "text", "source_query", "discovered_at", "status"]
    with open(output_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for c in candidates:
            w.writerow({
                "url": c.get("url", ""),
                "text": c.get("text", ""),
                "source_query": c.get("source_query", ""),
                "discovered_at": c.get("discovered_at", ""),
                "status": c.get("status", "discovered"),
            })


def save_csv(validated, output_csv):
    """Save validated listings to CSV."""
    if not validated:
        return
    headers = ["job_title", "company", "location", "remote", "salary", "url", "source_query", "reason"]
    with open(output_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for v in validated:
            analysis = v.get("analysis", {})
            w.writerow({
                "job_title": analysis.get("job_title", ""),
                "company": analysis.get("company", ""),
                "location": analysis.get("location", ""),
                "remote": analysis.get("remote", ""),
                "salary": analysis.get("salary", ""),
                "url": v.get("url", ""),
                "source_query": v.get("source_query", ""),
                "reason": analysis.get("reason", ""),
            })


def upload_to_sheets(csv_path, title):
    """Upload CSV to Google Sheets."""
    try:
        result = subprocess.run(
            ["bash", "-c", f'''
                source ~/Dropbox/claudeprojects/gsheets_venv/bin/activate && \
                python3 ~/Dropbox/claudeprojects/upload_csv_to_google_sheets.py \
                "{csv_path}" "RADAR — {title}"
            '''],
            capture_output=True, text=True, timeout=60,
        )
        print(f"  Sheets upload: {result.stdout[-200:] if result.stdout else result.stderr[-200:]}")
        # Extract URL
        for line in result.stdout.split("\n"):
            if "spreadsheets/d/" in line:
                url_match = re.search(r'https://docs\.google\.com/spreadsheets/d/[^\s]+', line)
                if url_match:
                    return url_match.group()
        return None
    except Exception as e:
        print(f"  Sheets upload error: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="RADAR job discovery + validation")
    parser.add_argument("--queries", required=True, help="Path to queries.json from discover-jobs.mjs")
    parser.add_argument("--tab", type=int, default=0, help="Reuse existing Chrome tab ID")
    parser.add_argument("--title", default="product designer", help="Job title for validation")
    parser.add_argument("--skip-validation", action="store_true", help="Skip Firefox validation step")
    parser.add_argument("--delay", type=int, default=8, help="Seconds between Google searches")
    parser.add_argument("--resume", default="", help="Path to existing discovery CSV to resume from")
    parser.add_argument("--sheet-name", default="", help="Google Sheets name to upload to")
    args = parser.parse_args()

    with open(args.queries) as f:
        queries_data = json.load(f)

    queries = [q["query"] for q in queries_data.get("queries", [])]
    title = args.title
    api_key = get_deepseek_key()

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    output_csv = os.path.join(OUTPUT_DIR, f"{timestamp}-{slug}-validated.csv")
    output_json = os.path.join(OUTPUT_DIR, f"{timestamp}-{slug}-validated.json")

    # Resume: load existing discovery data and skip completed queries
    completed_queries = set()
    if args.resume and os.path.exists(args.resume):
        with open(args.resume) as f:
            reader = csv.DictReader(f)
            for row in reader:
                q = row.get("source_query", "")
                if q:
                    completed_queries.add(q)
        print(f"Resuming: {len(completed_queries)} queries already done, skipping them")
        # Use the resume file as output too
        output_csv = args.resume

    print(f"RADAR Search: \"{title}\"")
    print(f"Queries: {len(queries)}")
    print()

    # Get or create tab
    if args.tab:
        tab_id = args.tab
        print(f"Reusing tab: {tab_id}")
    else:
        tab_id = create_background_tab()
        if not tab_id:
            print("ERROR: Could not create tab. Is the bridge running?")
            return
        print(f"Search tab: {tab_id}")

    discovery_csv = args.resume if args.resume else os.path.join(OUTPUT_DIR, f"{timestamp}-{slug}-discovery.csv")
    notify(f"RADAR starting for \"{title}\" — {len(queries)} ATS queries ({len(completed_queries)} already done).")

    all_candidates = {}  # url -> info
    sheet_url = None

    # Load existing candidates if resuming
    if args.resume and os.path.exists(args.resume):
        with open(args.resume) as f:
            reader = csv.DictReader(f)
            for row in reader:
                url = row.get("url", "")
                if url:
                    all_candidates[url] = row
        print(f"Loaded {len(all_candidates)} existing URLs")

    # ── PHASE 1: Chrome discovery — search Google, collect URLs, upload to Sheets after each query ──
    print("=" * 60)
    print("PHASE 1: Discovery (Chrome → Google Sheets)")
    print("=" * 60)

    for i, query in enumerate(queries):
        print(f"\n[{i+1}/{len(queries)}] {query}")

        if query in completed_queries:
            print(f"  SKIP (already done)")
            continue

        url = google_search_url(query)
        bridge_command("OPEN_URL", {"url": url, "active": False}, target_tab_id=tab_id)
        delay = random.randint(15, 30)
        print(f"  (waiting {delay}s)")
        time.sleep(delay)

        results = extract_google_results(tab_id)
        new_count = 0
        for r in results:
            if is_job_url(r["url"]) and r["url"] not in all_candidates:
                all_candidates[r["url"]] = {
                    "url": r["url"],
                    "text": r["text"],
                    "source_query": query,
                    "discovered_at": datetime.now().isoformat(),
                    "status": "discovered",
                }
                new_count += 1

        print(f"  {len(results)} links, {new_count} new job URLs (total: {len(all_candidates)})")

        # Save CSV and upload to Google Sheets after each query that finds new URLs
        if new_count > 0:
            save_discovery_csv(list(all_candidates.values()), discovery_csv)
            print(f"  Uploading {len(all_candidates)} URLs to Google Sheets...")
            sheet_url = upload_to_sheets(discovery_csv, title)
            if sheet_url:
                print(f"  Sheet: {sheet_url}")

        if (i + 1) % 10 == 0:
            notify(f"RADAR [{i+1}/{len(queries)}]: {len(all_candidates)} URLs discovered so far. {sheet_url or ''}")

    print(f"\n{'='*60}")
    print(f"Discovery complete: {len(all_candidates)} candidate URLs")
    print(f"{'='*60}")
    notify(f"RADAR discovery done — {len(all_candidates)} URLs in Google Sheets. {sheet_url or ''} Starting Firefox validation...")

    if args.skip_validation:
        print("\nSkipping validation (--skip-validation)")
        notify(f"RADAR done (discovery only) — {len(all_candidates)} URLs. {sheet_url or ''}")
        return

    # ── PHASE 2: Firefox validation — open each URL, grab text, analyze with DeepSeek ──
    print(f"\n{'='*60}")
    print("PHASE 2: Validation (Firefox + DeepSeek)")
    print("=" * 60)

    validated = []
    invalid = []

    for i, (url, info) in enumerate(all_candidates.items()):
        print(f"\n[{i+1}/{len(all_candidates)}] {url[:80]}")

        page_text = grab_firefox_page(url)
        if page_text.startswith("ERROR:") or len(page_text) < 50:
            info["analysis"] = {"is_active_listing": False, "reason": "failed to load page"}
            info["status"] = "invalid"
            invalid.append(info)
            print(f"  ✗ Failed to load")
            continue

        analysis = analyze_with_deepseek(page_text, title, api_key)
        info["analysis"] = analysis

        if analysis.get("is_active_listing"):
            info["status"] = "valid"
            validated.append(info)
            company = analysis.get("company", "?")
            job_title = analysis.get("job_title", "?")
            location = analysis.get("location", "?")
            print(f"  ✓ {job_title} @ {company} — {location}")
        else:
            info["status"] = "invalid"
            invalid.append(info)
            print(f"  ✗ {analysis.get('reason', 'unknown')}")

        # Update discovery CSV with status and re-upload every 10
        if (i + 1) % 10 == 0:
            save_discovery_csv(list(all_candidates.values()), discovery_csv)
            upload_to_sheets(discovery_csv, title)
            notify(f"RADAR validation: {i+1}/{len(all_candidates)} checked — {len(validated)} valid. {sheet_url or ''}")

    # Final save
    save_discovery_csv(list(all_candidates.values()), discovery_csv)
    save_csv(validated, output_csv)
    with open(output_json, "w") as f:
        json.dump({"valid": validated, "invalid": invalid}, f, indent=2)

    # Final upload
    upload_to_sheets(discovery_csv, title)

    print(f"\n{'='*60}")
    print(f"RADAR Complete")
    print(f"Valid: {len(validated)} | Invalid: {len(invalid)} | Total: {len(all_candidates)}")
    print(f"Discovery CSV: {discovery_csv}")
    print(f"Validated CSV: {output_csv}")
    if sheet_url:
        print(f"Sheet: {sheet_url}")

    notify(f"RADAR complete for \"{title}\" — {len(validated)} valid out of {len(all_candidates)} discovered. {sheet_url or ''}")


if __name__ == "__main__":
    main()
