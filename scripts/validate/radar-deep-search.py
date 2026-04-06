#!/usr/bin/env python3
"""
RADAR Deep Search — paginate through specific ATS sites on Google
to find more product designer listings.

Saves after every page so progress is never lost.
Randomizes site order and uses 30-45s delays to avoid captcha.
"""

import csv
import json
import os
import random
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime

BRIDGE_URL = "http://127.0.0.1:4471"
CSV_PATH = "/Users/garnetuniverse/Dropbox/liz.school.1/runs/radar/20260403-203615-product-designer-discovery.csv"
TITLE = "product designer"

SITES = [
    "greenhouse.io",
    "lever.co",
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "ashbyhq.com",
    "talentnet.community",
    "willhire.com",
    "paylocity.com",
    "bamboohr.com",
    "workable.com",
    "icims.com",
    "breezy.hr",
    "gem.com",
    "oraclecloud.com",
    "pinpointhq.com",
    "jobvite.com",
    "dover.io",
    "notion.site",
    "builtin.com/job",
    "rippling-ats.com",
    "wellfound.com",
    "workatastartup.com",
    "keka.com",
    "jobs.smartrecruiters.com",
    "adp.com",
    "successfactors.com",
    "ultipro.com",
    "jazzhr.com",
    "recruitee.com",
    "peoplehr.net",
    "hirehive.com",
    "clearcompany.com",
    "jobs.sequoiacap.com",
    "jobs.a16z.com",
    "jobs.kpcb.com",
    "jobs.indexventures.com",
    "jobs.accel.com",
    "jobs.lightspeedvp.com",
    "jobs.foundersfund.com",
    "ycombinator.com/companies",
    "jobs.techstars.com",
    "dribbble.com/jobs",
    "coroflot.com/jobs",
    "angel.co",
    "careerhound.io",
    "remotehub.com",
    "virtualvocations.com",
    "skipthedrive.com",
    "powertofly.com",
    "authenticjobs.com",
    "avajobboard.niceboard.co",
]
MAX_PAGES = 20  # 20 pages x 10 results = up to 200 per site


def bridge_command(cmd_type, payload, tab_id, timeout=20):
    cmd_id = f"deep_{int(time.time() * 1000)}"
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


def extract_links(tab_id, site):
    code = f"""
    const links = document.querySelectorAll('a[href]');
    const results = [];
    const seen = new Set();
    links.forEach(a => {{
        const href = a.href;
        if (!href || href.includes('google.com') || href.includes('webcache') || href.startsWith('javascript:') || href.includes('#:~:text=')) return;
        let url = href;
        const match = href.match(/[?&]q=([^&]+)/);
        if (match) url = decodeURIComponent(match[1]);
        if (url.includes('#:~:text=')) return;
        const base = url.split('#')[0];
        if (seen.has(base)) return;
        seen.add(base);
        if (base.includes('{site}')) {{
            results.push({{ url: base, text: a.textContent?.trim()?.substring(0, 200) || '' }});
        }}
    }});
    return results;
    """
    r = bridge_command(
        "RUN_SNIPPET",
        {"code": code, "world": "MAIN", "snippetName": f"extract {site}"},
        tab_id,
    )
    if r and r.get("ok") and r.get("run", {}).get("result"):
        return r["run"]["result"]
    return []


def save_csv(rows):
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["url", "text", "source_query", "discovered_at", "status"])
        w.writeheader()
        w.writerows(rows)


def upload_to_sheets():
    try:
        result = subprocess.run(
            ["bash", "-c",
             f'source ~/Dropbox/claudeprojects/gsheets_venv/bin/activate && '
             f'python3 ~/Dropbox/claudeprojects/upload_csv_to_google_sheets.py '
             f'"{CSV_PATH}" "RADAR — product designer"'],
            capture_output=True, text=True, timeout=60,
        )
        print(f"  Sheets: {result.stdout[-200:] if result.stdout else result.stderr[-100:]}")
    except Exception as e:
        print(f"  Sheets error: {e}")


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", type=int, required=True)
    args = parser.parse_args()
    tab_id = args.tab

    # Load existing
    existing = set()
    rows = []
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH) as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
                existing.add(row.get("url", ""))
    print(f"Loaded {len(existing)} existing URLs")

    # Check which sites+pages are already done
    done_queries = set()
    for row in rows:
        q = row.get("source_query", "")
        if q:
            done_queries.add(q)

    # Randomize site order
    sites = SITES[:]
    random.shuffle(sites)
    print(f"Site order: {sites}")

    for site in sites:
        print(f"\n{'='*60}")
        print(f"Deep search: site:{site} \"{TITLE}\"")
        print(f"{'='*60}")

        for page in range(MAX_PAGES):
            start = page * 10
            query_tag = f"site:{site} \"{TITLE}\" page {page+1}"

            if query_tag in done_queries:
                print(f"  Page {page+1}/{MAX_PAGES} — SKIP (already done)")
                continue

            url = f"https://www.google.com/search?q=site:{site}+%22{urllib.parse.quote(TITLE)}%22&num=10&start={start}"

            delay = random.randint(60, 120)
            print(f"  Page {page+1}/{MAX_PAGES} (start={start}, waiting {delay}s)... ", end="", flush=True)

            bridge_command("OPEN_URL", {"url": url, "active": False}, tab_id)
            time.sleep(delay)

            results = extract_links(tab_id, site)
            new_count = 0
            for r in results:
                if r["url"] not in existing:
                    existing.add(r["url"])
                    rows.append({
                        "url": r["url"],
                        "text": r["text"],
                        "source_query": query_tag,
                        "discovered_at": datetime.now().isoformat(),
                        "status": "discovered",
                    })
                    new_count += 1
            print(f"{len(results)} links, {new_count} new (total: {len(rows)})")

            # Save after every page
            save_csv(rows)

            if len(results) == 0:
                print(f"  No more results for {site}")
                break

    print(f"\n=== Done: {len(rows)} total URLs ===")
    print("Uploading to Google Sheets...")
    upload_to_sheets()


if __name__ == "__main__":
    main()
