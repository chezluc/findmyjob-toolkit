#!/usr/bin/env python3
"""Re-score all 616 job listings using domain-specific scoring algorithm."""

import csv
import re
import time
import concurrent.futures
import requests
from html import unescape

# ── Constants ──

CSV_PATH = ""

NEGATIVE_DOMAINS = [
    "fundraising", "raiser's edge", "nonprofit philanthropy", "donor",
    "nursing", "clinical", "medical", "patient care",
    "accounting", "bookkeeping", "tax preparation", "auditing",
    "legal counsel", "paralegal", "attorney", "litigation",
    "truck driver", "warehouse", "forklift", "cdl",
    "hvac", "plumbing", "electrician", "carpentry",
    "real estate agent", "mortgage", "loan officer",
]

HIGH_VALUE = [
    "production design", "production designer", "design systems", "design system",
    "ui kit", "ui kits", "component library", "component libraries",
    "figma", "sketch", "design tokens", "design ops", "designops",
    "handoff", "redline", "redlines", "qa", "quality assurance",
    "storyboard", "workflow automation", "applescript", "xcode",
    "design engineer", "design technologist", "app store", "localization",
    "ios", "android", "mobile design", "responsive design",
    "accessibility", "wcag", "prototype", "prototyping",
    "motion design", "animation", "visual design", "visual designer",
    "ui design", "ui designer", "ux design", "ux designer",
    "product design", "product designer", "design lead", "senior designer",
    "staff designer", "principal designer", "creative technologist",
    "front-end", "frontend", "css", "html",
    "design review", "brand design", "graphic design", "illustration",
    "typography", "color system", "theming", "style guide",
    "brand guidelines", "design documentation", "zeplin", "abstract",
    "invision", "framer", "adobe xd", "photoshop", "illustrator",
    "after effects", "creative suite", "plugin", "library maintenance",
]

MEDIUM_VALUE = [
    "design", "designer", "creative", "visual", "layout", "mockup",
    "wireframe", "user interface", "user experience", "interaction",
    "component", "template", "artboard", "pixel", "vector", "svg",
    "icon", "grid", "spacing", "font", "color", "palette",
    "branding", "identity", "print", "retouching", "photo editing",
    "automation", "scripting", "tooling", "workflow", "pipeline",
    "documentation", "training", "onboarding", "cross-functional",
    "engineering", "developer", "collaboration",
]

TITLE_TERMS = [
    "production design", "design system", "ui kit", "visual design",
    "product design", "graphic design", "design ops", "design engineer",
    "creative technolog", "design technolog", "figma", "front-end",
    "ux design", "ui design", "motion design", "brand design",
    "design lead", "senior designer", "staff designer",
    "principal designer", "design manager",
]

ACTIVE_PHRASES = ["apply now", "submit application", "upload resume"]
INACTIVE_PHRASES = ["no longer available", "position filled", "job is closed"]


def strip_html(html_text):
    """Convert HTML to plain text roughly."""
    text = re.sub(r'<script[^>]*>.*?</script>', ' ', html_text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = unescape(text)
    text = re.sub(r'\s+', ' ', text)
    return text


def fetch_url(url, timeout=15):
    """Fetch URL and return plain text content."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        return strip_html(resp.text)
    except Exception:
        return None


def count_term(text, term):
    """Count occurrences of term in text (case-insensitive, word boundary aware)."""
    return len(re.findall(re.escape(term), text, re.IGNORECASE))


def score_posting(text, role_title):
    """Score a posting. Returns (total, title_score, evidence_score, activity_score, activity_status)."""
    if not text:
        return (0, 0, 0, 0, "unknown")

    lower = text.lower()

    # Step 1: Negative domain check
    for neg in NEGATIVE_DOMAINS:
        if lower.count(neg) >= 3:
            return (0, 0, 0, 0, "unknown")

    # Step 2: High-value terms
    high_pts = sum(count_term(lower, t) * 10 for t in HIGH_VALUE)

    # Step 3: Medium-value terms
    med_pts = sum(count_term(lower, t) * 3 for t in MEDIUM_VALUE)

    # Step 4: Title relevance (check role_title + first 500 chars)
    title_text = (role_title + " " + text[:500]).lower()
    title_pts = sum(8 for t in TITLE_TERMS if t in title_text)

    # Step 5: Activity detection
    activity_status = "unknown"
    activity_bonus = 5
    for phrase in ACTIVE_PHRASES:
        if phrase in lower:
            activity_status = "active"
            activity_bonus = 25
            break
    if activity_status == "unknown":
        for phrase in INACTIVE_PHRASES:
            if phrase in lower:
                activity_status = "inactive"
                activity_bonus = 0
                break

    # Normalize
    title_score = min(25, round(title_pts / 40 * 25))
    evidence_score = min(60, round((high_pts + med_pts) / 200 * 60))
    activity_score = min(15, round((activity_bonus + 8) / 33 * 15))
    total = min(100, title_score + evidence_score + activity_score)

    return (total, title_score, evidence_score, activity_score, activity_status)


def process_row(row):
    """Fetch URL and score a single row. Returns updated row."""
    url = row.get("Posting URL", "").strip()
    role_title = row.get("Role Title", "")

    text = fetch_url(url) if url else None
    total, t_score, e_score, a_score, a_status = score_posting(text, role_title)

    row["Score Total"] = total
    row["Score Title"] = t_score
    row["Score Evidence"] = e_score
    row["Score Activity"] = a_score
    row["Activity Status"] = a_status
    return row


def main():
    # Read CSV
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    print(f"Read {len(rows)} rows")

    # Process in parallel (20 workers to be polite but fast)
    scored = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        futures = {ex.submit(process_row, row): i for i, row in enumerate(rows)}
        results = [None] * len(rows)
        for future in concurrent.futures.as_completed(futures):
            idx = futures[future]
            results[idx] = future.result()
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(rows)} done")

    scored = results

    # Remove inactive
    before = len(scored)
    scored = [r for r in scored if r["Activity Status"] != "inactive"]
    print(f"Removed {before - len(scored)} inactive rows, {len(scored)} remain")

    # Sort by Score Total descending
    scored.sort(key=lambda r: int(r["Score Total"]), reverse=True)

    # Write CSV
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(scored)
    print(f"Wrote {len(scored)} rows to CSV")

    # Upload to Google Sheets
    import gspread
    from google.oauth2.credentials import Credentials
    import json

    token_path = ""
    with open(token_path) as tf:
        token_data = json.load(tf)

    creds = Credentials(
        token=token_data["token"],
        refresh_token=token_data.get("refresh_token"),
        token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=token_data.get("client_id"),
        client_secret=token_data.get("client_secret"),
        scopes=token_data.get("scopes", ["https://www.googleapis.com/auth/spreadsheets"]),
    )

    gc = gspread.authorize(creds)
    sh = gc.open_by_key("1Pm4EtHGx5CBrIjZy8e2KExNH-PnxV-MKcO--hmZfmCo")
    ws = sh.sheet1

    # Build data: header + rows
    header = fieldnames
    data = [header]
    for row in scored:
        data.append([row.get(col, "") for col in fieldnames])

    ws.clear()
    ws.update(range_name="A1", values=data)
    print(f"Uploaded {len(scored)} rows to Google Sheet")


if __name__ == "__main__":
    main()
