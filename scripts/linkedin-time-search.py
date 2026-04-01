#!/usr/bin/env python3
"""
LinkedIn Time-Based Job Search (SONAR)

Searches LinkedIn for exact title matches at decreasing time intervals
to approximate when jobs were posted. Uses the Chrome Console Bridge
for browser automation.

Usage:
    python3 linkedin-time-search.py --title "production designer"
    python3 linkedin-time-search.py --title "UX designer" --geo-id 103644278
    python3 linkedin-time-search.py --title "design systems" --remote

LinkedIn f_TPR parameter uses seconds:
    r86400  = last 24 hours
    r43200  = last 12 hours
    r3600   = last 1 hour
    r1800   = last 30 minutes
    r600    = last 10 minutes

Common geoId values:
    103644278  United States
    102299470  England
    100752109  Scotland
    104738515  Ireland
"""

import argparse
import csv
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://127.0.0.1:4471")
OUTPUT_DIR = os.environ.get("SONAR_OUTPUT_DIR", os.path.join(os.getcwd(), "runs", "linkedin-searches"))

# Time intervals to search (seconds), from widest to narrowest
TIME_INTERVALS = [
    86400,   # 24 hours
    43200,   # 12 hours
    21600,   # 6 hours
    10800,   # 3 hours
    3600,    # 1 hour
    2400,    # 40 minutes
    1800,    # 30 minutes
    1200,    # 20 minutes
    600,     # 10 minutes
]


def linkedin_search_url(title, seconds, geo_id=None, remote=False):
    """Build LinkedIn job search URL with time filter."""
    params = {
        "keywords": title,
        "f_TPR": f"r{seconds}",
        "origin": "JOB_SEARCH_PAGE_JOB_FILTER",
    }
    if geo_id:
        params["geoId"] = geo_id
    if remote:
        params["f_WT"] = "2"
    return f"https://www.linkedin.com/jobs/search/?{urllib.parse.urlencode(params)}"


def bridge_command(cmd_type, payload, target_tab_id=None, timeout=15):
    """Send a command to the Chrome bridge and poll for result."""
    cmd_id = f"li_{int(time.time() * 1000)}"
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
    """Create a background tab via bridge."""
    r = bridge_command(
        "OPEN_URL", {"url": "https://www.linkedin.com", "active": False}
    )
    if r and r.get("run", {}).get("tabId"):
        return r["run"]["tabId"]
    return None


def extract_jobs_from_page(tab_id):
    """Extract job listings from the current LinkedIn search page."""
    code = """
    const cards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item, [data-job-id]');
    const results = [];
    cards.forEach(card => {
        const text = card.textContent?.trim() || '';
        const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
        const title = lines[0] || '';
        const company = lines.find((l, i) => i > 0 && !l.includes('with verification') && l.length > 1 && l.length < 60) || '';
        const linkEl = card.querySelector('a[href*="/jobs/view/"]');
        const href = linkEl?.href || '';
        const jobId = card.getAttribute('data-job-id') || href.match(/\\/jobs\\/view\\/(\\d+)/)?.[1] || '';
        const locEl = card.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper');
        const location = locEl?.textContent?.trim()?.split('\\n')?.[0]?.trim() || '';

        if (title && title.length > 2) {
            results.push({ title, company, location, href, jobId });
        }
    });
    return results;
    """
    r = bridge_command(
        "RUN_SNIPPET",
        {"code": code, "world": "MAIN", "snippetName": "extract jobs"},
        target_tab_id=tab_id,
    )
    if r and r.get("ok") and r.get("run", {}).get("result"):
        return r["run"]["result"]
    return []


def classify_match(job_title, search_title):
    """Classify how well a job title matches the search title."""
    job_lower = job_title.lower().strip()
    search_lower = search_title.lower().strip()
    search_words = search_lower.split()

    if search_lower in job_lower:
        return "exact"
    if all(w in job_lower for w in search_words):
        return "partial"
    matches = sum(1 for w in search_words if w in job_lower)
    if matches >= len(search_words) * 0.5:
        return "partial"
    return "none"


def format_seconds(seconds):
    """Human-readable time interval."""
    if seconds >= 3600:
        return f"{seconds // 3600}h"
    elif seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


def main():
    parser = argparse.ArgumentParser(description="LinkedIn time-based job search (SONAR)")
    parser.add_argument("--title", required=True, help='Job title to search, e.g. "production designer"')
    parser.add_argument("--geo-id", default="", help="LinkedIn geoId for location filtering")
    parser.add_argument("--remote", action="store_true", help="Filter for remote jobs only (f_WT=2)")
    parser.add_argument("--intervals", default="", help="Comma-separated seconds, e.g. 86400,3600,600")
    parser.add_argument("--delay", type=int, default=10, help="Seconds between searches (default 10)")
    parser.add_argument("--output", default="", help="Output CSV path")
    args = parser.parse_args()

    title = args.title
    geo_id = args.geo_id or None
    remote = args.remote
    delay = args.delay
    intervals = (
        [int(x) for x in args.intervals.split(",") if x.strip()]
        if args.intervals
        else TIME_INTERVALS
    )

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    output_csv = args.output or os.path.join(OUTPUT_DIR, f"{timestamp}-{slug}.csv")

    region_label = "Remote" if remote else (f"geoId={geo_id}" if geo_id else "Global")
    print(f'LinkedIn Time Search: "{title}" ({region_label})')
    print(f"Intervals: {[format_seconds(s) for s in intervals]}")
    print(f"Output: {output_csv}")
    print()

    # Create background tab
    tab_id = create_background_tab()
    if not tab_id:
        print("ERROR: Could not create background tab. Is the bridge running?")
        return
    print(f"Background tab: {tab_id}")

    all_jobs = {}

    for interval in sorted(intervals, reverse=True):
        url = linkedin_search_url(title, interval, geo_id=geo_id, remote=remote)
        print(f"\n--- Searching: last {format_seconds(interval)} ({interval}s) ---")

        bridge_command(
            "OPEN_URL", {"url": url, "active": False}, target_tab_id=tab_id
        )
        time.sleep(8)

        jobs = extract_jobs_from_page(tab_id)

        exact = []
        partial = []
        none_match = []
        for job in jobs:
            match_type = classify_match(job.get("title", ""), title)
            job["match"] = match_type
            if match_type == "exact":
                exact.append(job)
            elif match_type == "partial":
                partial.append(job)
            else:
                none_match.append(job)

        print(f"  Found {len(jobs)} total: {len(exact)} exact, {len(partial)} partial, {len(none_match)} none")

        for job in jobs:
            job_id = job.get("jobId") or job.get("href", "") or job.get("title", "")
            if job_id and job_id not in all_jobs:
                all_jobs[job_id] = {
                    "title": job["title"],
                    "company": job.get("company", ""),
                    "location": job.get("location", ""),
                    "href": job.get("href", ""),
                    "match": job.get("match", "none"),
                    "first_seen_interval": format_seconds(interval),
                    "first_seen_seconds": interval,
                    "first_seen_time": datetime.now().isoformat(),
                }
                if job["match"] in ("exact", "partial"):
                    print(f"  {'✓' if job['match'] == 'exact' else '~'} {job['title'][:50]} @ {job.get('company', '?')}")

        time.sleep(delay)

    # Write CSV
    sorted_jobs = sorted(
        all_jobs.values(),
        key=lambda x: (
            0 if x.get("match") == "exact" else 1 if x.get("match") == "partial" else 2,
            x.get("first_seen_seconds", 99999),
        ),
    )

    with open(output_csv, "w", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "title", "company", "location", "href", "match",
                "first_seen_interval", "first_seen_seconds", "first_seen_time",
            ],
        )
        writer.writeheader()
        for job in sorted_jobs:
            writer.writerow(job)

    # Also write JSON
    json_path = output_csv.replace(".csv", ".json")
    with open(json_path, "w") as f:
        json.dump(sorted_jobs, f, indent=2)

    exact_count = sum(1 for j in all_jobs.values() if j.get("match") == "exact")
    partial_count = sum(1 for j in all_jobs.values() if j.get("match") == "partial")

    print(f"\n=== Done ===")
    print(f"Total: {len(all_jobs)} | Exact: {exact_count} | Partial: {partial_count}")
    print(f"CSV: {output_csv}")
    print(f"JSON: {json_path}")


if __name__ == "__main__":
    main()
