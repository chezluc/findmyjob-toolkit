#!/usr/bin/env python3
"""Search EURES (European Employment Services) for job listings via Chrome bridge."""

import csv
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime

BRIDGE_URL = "http://127.0.0.1:4471"
OUTPUT_DIR = os.path.expanduser("~/Dropbox/liz.school.1/runs/radar")

SEARCH_TERMS = [
    # Core role terms
    "production designer",
    "production artist",
    "design systems",
    "figma designer",
    "creative technologist",
    "design technologist",
    "design operations",
    "brand production designer",
    "post production specialist",
    # AI/automation terms
    "AI automation specialist",
    "ai consultant",
    "vibe coder",
    "workflow automation",
    # Broader tool/skill terms
    "figma",
    "photoshop",
    "automation",
    "UI kit",
    "design QA",
    "component library",
    "Adobe Creative Suite",
    "visual designer",
    "graphic designer",
    "localization design",
]


def bridge_command(cmd_type, payload, target_tab_id=None, timeout=20):
    cmd_id = f"eures_{int(time.time() * 1000)}"
    body = {"id": cmd_id, "type": cmd_type, "payload": payload}
    if target_tab_id:
        body["targetTabId"] = target_tab_id
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


def extract_jobs(tab_id):
    code = r"""
    const cards = document.querySelectorAll('search-page-jv-result-summary');
    const jobs = [];
    cards.forEach((card, idx) => {
        const metas = card.querySelectorAll('.ecl-content-block__primary-meta-item');
        let company = '', location = '', date = '';
        metas.forEach(m => {
            const text = m.textContent?.trim() || '';
            if (m.id?.startsWith('jv-employer-name')) company = text;
            else if (m.id?.startsWith('location')) location = text;
            else if (m.id?.startsWith('date')) date = text.replace('Publication date: ', '');
        });
        const titleEl = card.querySelector('h3 a[ecllink]') || card.querySelector('h3 a') || card.querySelector('a[href*="jv-details"]');
        const title = titleEl?.textContent?.trim() || '';
        let url = titleEl?.href || '';
        if (!url && titleEl) {
            const rawHref = titleEl.getAttribute('href') || '';
            if (rawHref) url = rawHref.startsWith('http') ? rawHref : 'https://europa.eu' + rawHref;
        }
        const descEl = card.querySelector('.ecl-content-block__description');
        const description = descEl?.textContent?.trim()?.substring(0, 300) || '';
        const tagEls = card.querySelectorAll('.ecl-label');
        const tags = [...tagEls].map(t => t.textContent?.trim()).join(', ');
        if (title) {
            jobs.push({ title, company, location, date, description, tags, url });
        }
    });
    return { jobs, total: jobs.length };
    """
    r = bridge_command(
        "RUN_SNIPPET",
        {"code": code, "world": "MAIN", "snippetName": "eures extract"},
        target_tab_id=tab_id,
    )
    if r and r.get("ok") and r.get("run", {}).get("result"):
        return r["run"]["result"]
    return None


def notify(msg):
    try:
        data = json.dumps({"to": "luke@chezluc.com", "message": msg}).encode()
        req = urllib.request.Request(
            "http://127.0.0.1:8423/send", data=data,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    csv_path = os.path.join(OUTPUT_DIR, f"{timestamp}-eures-all.csv")

    # Create tab
    r = bridge_command("OPEN_URL", {"url": "https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=50&orderBy=BEST_MATCH&keywordsEverywhere=figma&lang=en", "active": False})
    if not r or not r.get("run", {}).get("tabId"):
        print("ERROR: Could not create tab")
        return
    tab_id = r["run"]["tabId"]
    print(f"Tab: {tab_id}")
    time.sleep(8)

    all_jobs = []
    seen_titles = set()

    for idx, term in enumerate(SEARCH_TERMS):
        print(f"\n{'='*60}")
        print(f"[{idx+1}/{len(SEARCH_TERMS)}] Searching: {term} (20 pages)")
        print(f"{'='*60}")

        for page in range(1, 21):
            url = f"https://europa.eu/eures/portal/jv-se/search?page={page}&resultsPerPage=50&orderBy=BEST_MATCH&keywordsEverywhere={urllib.parse.quote(term)}&lang=en"
            print(f"  Page {page}/20...", end=" ")

            bridge_command("OPEN_URL", {"url": url, "active": False}, target_tab_id=tab_id)
            time.sleep(8)

            result = extract_jobs(tab_id)
            if result:
                jobs = result.get("jobs", [])
                new_count = 0
                for j in jobs:
                    key = (j.get("title", ""), j.get("company", ""))
                    if key not in seen_titles and j.get("title"):
                        seen_titles.add(key)
                        j["search_term"] = term
                        j["page"] = page
                        all_jobs.append(j)
                        new_count += 1
                print(f"{len(jobs)} jobs, {new_count} new (total: {len(all_jobs)})")
                # If no jobs on this page, no more pages for this term
                if len(jobs) == 0:
                    print(f"  No more results for \"{term}\"")
                    break
            else:
                print(f"extraction failed")
                break

            time.sleep(2)

        # Save CSV after each term
        headers = ["title", "company", "location", "date", "description", "tags", "search_term", "page", "url", "url_english"]
        with open(csv_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=headers)
            w.writeheader()
            for j in all_jobs:
                row = {h: j.get(h, "") for h in headers}
                if row["url"]:
                    row["url_english"] = f"https://translate.google.com/translate?sl=auto&tl=en&u={urllib.parse.quote(row['url'], safe='')}"
                w.writerow(row)

        # Upload to Google Sheets after each term
        print(f"  Uploading {len(all_jobs)} jobs to Google Sheets...")
        sheet_result = subprocess.run(
            ["bash", "-c",
             f'source ~/Dropbox/claudeprojects/gsheets_venv/bin/activate && '
             f'python3 ~/Dropbox/claudeprojects/upload_csv_to_google_sheets.py '
             f'"{csv_path}" "EURES — Job Search {timestamp}"'],
            capture_output=True, text=True, timeout=60,
        )
        sheet_url = ""
        for line in (sheet_result.stdout or "").split("\n"):
            if "spreadsheets/d/" in line:
                import re as _re
                m = _re.search(r'https://docs\.google\.com/spreadsheets/d/[^\s]+', line)
                if m:
                    sheet_url = m.group()
        if sheet_url:
            print(f"  Sheet: {sheet_url}")

        notify(f"EURES [{idx+1}/{len(SEARCH_TERMS)}]: \"{term}\" done — {len(all_jobs)} total jobs. {sheet_url}")
        time.sleep(3)

    print(f"\n=== Done: {len(all_jobs)} unique jobs across {len(SEARCH_TERMS)} terms ===")
    print(f"CSV: {csv_path}")

    notify(f"EURES search complete — {len(all_jobs)} unique jobs across {len(SEARCH_TERMS)} search terms. {sheet_url}")


if __name__ == "__main__":
    main()
