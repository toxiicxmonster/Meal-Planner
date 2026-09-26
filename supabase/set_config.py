"""Point every app (desktop, iPhone, web) at your Supabase project.

    python supabase/set_config.py https://abcd1234.supabase.co eyJhbGciOi...

Find both values in Supabase: Project Settings -> API ("Project URL" and the "anon" / "publishable" key).
The anon key is meant to be public: row level security in schema.sql decides what each person can see.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) != 3 or not sys.argv[1].startswith("https://"):
        print(__doc__)
        sys.exit(1)
    url, key = sys.argv[1].rstrip("/"), sys.argv[2].strip()

    (ROOT / "supabase" / "config.json").write_text(
        json.dumps({"url": url, "anonKey": key}, indent=2) + "\n", encoding="utf-8")
    (ROOT / "mobile" / "src" / "lib" / "config.js").write_text(
        "// Your Supabase project. Set with: python supabase/set_config.py <project-url> <anon-key>\n"
        f"export const SUPABASE_URL = {json.dumps(url)};\n"
        f"export const SUPABASE_ANON_KEY = {json.dumps(key)};\n", encoding="utf-8")
    (ROOT / "docs" / "config.js").write_text(
        "// Your Supabase project. Set with: python supabase/set_config.py <project-url> <anon-key>\n"
        f"window.MEAL_PLANNER_CONFIG = {{ supabaseUrl: {json.dumps(url)}, supabaseAnonKey: {json.dumps(key)} }};\n",
        encoding="utf-8")
    print("Updated supabase/config.json, mobile/src/lib/config.js and docs/config.js")


if __name__ == "__main__":
    main()
