#!/usr/bin/env python3
import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path('process.env.CLAUDEPROJECTS/upload_csv_to_google_sheets.py')

spec = importlib.util.spec_from_file_location('upload_csv_to_google_sheets', MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    if len(sys.argv) < 3:
      print("Usage: upload_csv_to_existing_google_sheet.py <csv_path> <spreadsheet_url>")
      sys.exit(1)

    csv_path = sys.argv[1]
    spreadsheet_url = sys.argv[2]

    print("=" * 60)
    print("Google Sheets Existing Sheet Upload Script")
    print("=" * 60)

    credentials = module.get_credentials_from_keychain()
    if not credentials:
        print("Failed to retrieve credentials from keychain")
        sys.exit(1)

    creds_file = module.create_oauth_flow(credentials)
    if not creds_file:
        print("Failed to create OAuth flow")
        sys.exit(1)

    creds = module.authenticate_google_sheets(creds_file)
    if not creds:
        print("Authentication failed")
        sys.exit(1)

    csv_data = module.read_csv_file(csv_path)
    if not csv_data:
        print("Failed to read CSV file")
        sys.exit(1)

    try:
        gc = module.gspread.authorize(creds)
        print("  ✓ Authenticated with gspread")
        spreadsheet = gc.open_by_url(spreadsheet_url)
        print(f"  ✓ Opened existing spreadsheet: {spreadsheet.title}")
        worksheet = spreadsheet.get_worksheet(0)
        worksheet.clear()
        worksheet.update('A1', csv_data)
        print(f"  ✓ Uploaded {len(csv_data)} rows to Google Sheets")
        print(f"  📊 Spreadsheet URL: {spreadsheet.url}")
        print("\n" + "=" * 60)
        print("✅ Upload successful!")
        print(f"📊 Access your spreadsheet at: {spreadsheet.url}")
        print("=" * 60)
    finally:
        try:
            Path(creds_file).unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == '__main__':
    main()
