#!/usr/bin/env python3
"""
Build HTSUS per-chapter data files for the Chrome extension.
- Reuses data/hts_full.json for the 12 already-downloaded chapters.
- Downloads the remaining ~87 chapters from the USITC REST API.
- Produces:
    data/chapters/chNN.json    (one per non-empty chapter)
    data/chapter_index.json
    data/search_index.json
"""

import json
import os
import time
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path("/Users/naokijodan/Desktop/市場分析/HSCodeWorksheet_Extension")
DATA_DIR = BASE_DIR / "data"
CHAPTERS_DIR = DATA_DIR / "chapters"
HTS_FULL_PATH = DATA_DIR / "hts_full.json"
FLOWS_PATH = DATA_DIR / "flows.json"

# Chapters already in hts_full.json
PRELOADED_CHAPTERS = {"39","42","49","61","62","64","69","71","84","85","91","95"}

API_BASE = "https://hts.usitc.gov/reststop/exportList"
MAX_RETRIES = 4
RETRY_SLEEP = 3   # seconds between retries
CHAPTER_SLEEP = 0.4  # polite delay between chapter downloads


def fetch_chapter(chnum_str: str) -> list | None:
    """Fetch a chapter from the USITC API with retries. Returns list or None on failure."""
    from_code = f"{chnum_str}00"
    to_code   = f"{chnum_str}99"
    url = f"{API_BASE}?from={from_code}&to={to_code}&format=JSON&styles=true"
    for attempt in range(1, MAX_RETRIES + 1):
        result = subprocess.run(
            ["curl", "-s", "--max-time", "30", url],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"  [ch{chnum_str}] curl error attempt {attempt}: {result.stderr[:80]}")
            time.sleep(RETRY_SLEEP)
            continue
        raw = result.stdout.strip()
        if not raw:
            print(f"  [ch{chnum_str}] empty response attempt {attempt}")
            time.sleep(RETRY_SLEEP)
            continue
        try:
            data = json.loads(raw)
            return data  # may be empty list []
        except json.JSONDecodeError as e:
            print(f"  [ch{chnum_str}] JSON parse error attempt {attempt}: {e}")
            time.sleep(RETRY_SLEEP)
    return None  # all retries failed


def split_preloaded() -> dict:
    """Split hts_full.json into per-chapter record lists."""
    print("Loading hts_full.json ...")
    with open(HTS_FULL_PATH) as f:
        all_records = json.load(f)
    print(f"  {len(all_records)} total records in hts_full.json")

    chapter_map: dict[str, list] = {}
    unclassified = 0

    for rec in all_records:
        htsno = rec.get("htsno", "")
        # Determine chapter from htsno
        digits = htsno.replace(".", "").replace(" ", "")
        if digits and len(digits) >= 2 and digits[:2].isdigit():
            ch = digits[:2]
        else:
            # Try to find a non-empty htsno hint from description?
            # Just keep in first chapter seen, or skip tracking
            unclassified += 1
            continue
        chapter_map.setdefault(ch, []).append(rec)

    # For records that couldn't be classified by htsno, we need another approach.
    # Actually let's do a second pass: assign header/section records to their
    # chapter context by tracking last known chapter.
    # Redo with context tracking:
    chapter_map2: dict[str, list] = {}
    current_ch = None
    for rec in all_records:
        htsno = rec.get("htsno", "")
        digits = htsno.replace(".", "").replace(" ", "")
        if digits and len(digits) >= 2 and digits[:2].isdigit():
            current_ch = digits[:2]
        if current_ch is not None:
            chapter_map2.setdefault(current_ch, []).append(rec)

    found_chapters = sorted(chapter_map2.keys())
    print(f"  Chapters found in hts_full.json: {found_chapters}")
    return chapter_map2


def derive_chapter_title(records: list, chnum_str: str) -> str:
    """
    Try to extract the official chapter title from records.
    The chapter heading is typically a record with htsno == chnum_str
    or htsno starting with chnum_str and indent 0 or 1.
    """
    # Look for the chapter note/title record
    # USITC data often has "Chapter N" as a section header or the first heading
    for rec in records:
        htsno = rec.get("htsno", "")
        desc = rec.get("description", "").strip()
        indent = rec.get("indent", "")
        # The main chapter heading entry (e.g. htsno="0101" or first indent-0 with description)
        if not htsno and indent == "0" and desc and not desc.startswith("Chapter"):
            # Could be a section title; keep looking
            continue
        # htsno matches chapter number pattern (4 digits starting with chnum)
        digits = htsno.replace(".", "").replace(" ", "")
        if digits.startswith(chnum_str) and indent in ("0", "1") and desc:
            # Take first meaningful description that looks like a chapter title
            # (not "See chapter XX" style)
            if len(desc) > 5 and "see chapter" not in desc.lower():
                return desc[:200]
    # Fallback: use first non-empty description
    for rec in records:
        desc = rec.get("description", "").strip()
        if desc and len(desc) > 5:
            return desc[:200]
    return ""


def main():
    CHAPTERS_DIR.mkdir(parents=True, exist_ok=True)

    # ---- Step 1: Split preloaded chapters ----
    preloaded_map = split_preloaded()

    chapter_data: dict[str, list] = {}  # chnum_str -> records
    download_results: dict[str, str] = {}  # chnum_str -> "ok"|"empty"|"fail"

    # Save preloaded chapters
    for ch in PRELOADED_CHAPTERS:
        records = preloaded_map.get(ch, [])
        if records:
            chapter_data[ch] = records
            out_path = CHAPTERS_DIR / f"ch{ch}.json"
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, separators=(",", ":"))
            print(f"  [ch{ch}] preloaded: {len(records)} records -> {out_path.name}")
            download_results[ch] = "ok"
        else:
            print(f"  [ch{ch}] WARNING: not found in hts_full.json")
            download_results[ch] = "empty"

    # ---- Step 2: Download remaining chapters ----
    all_chapters = [f"{n:02d}" for n in range(1, 100)]
    to_download = [ch for ch in all_chapters if ch not in PRELOADED_CHAPTERS]

    print(f"\nDownloading {len(to_download)} chapters from USITC API ...")
    failed_chapters = []
    empty_chapters = []

    for i, ch in enumerate(to_download, 1):
        print(f"  [{i:2d}/{len(to_download)}] Fetching ch{ch} ...", end=" ", flush=True)
        records = fetch_chapter(ch)
        if records is None:
            print("FAILED")
            failed_chapters.append(ch)
            download_results[ch] = "fail"
        elif len(records) == 0:
            print("empty (reserved/no data)")
            empty_chapters.append(ch)
            download_results[ch] = "empty"
        else:
            print(f"{len(records)} records")
            chapter_data[ch] = records
            out_path = CHAPTERS_DIR / f"ch{ch}.json"
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, separators=(",", ":"))
            download_results[ch] = "ok"
        time.sleep(CHAPTER_SLEEP)

    # ---- Step 3: Build chapter_index.json ----
    print("\nBuilding chapter_index.json ...")
    chapter_index = []
    for ch in sorted(chapter_data.keys()):
        records = chapter_data[ch]
        title = derive_chapter_title(records, ch)
        chapter_index.append({
            "chapter": ch,
            "title": title,
            "count": len(records)
        })
    chapter_index_path = DATA_DIR / "chapter_index.json"
    with open(chapter_index_path, "w", encoding="utf-8") as f:
        json.dump(chapter_index, f, ensure_ascii=False, indent=2)
    print(f"  {len(chapter_index)} chapters -> {chapter_index_path.name}")

    # ---- Step 4: Build search_index.json ----
    print("\nBuilding search_index.json ...")
    search_index = []
    for ch in sorted(chapter_data.keys()):
        records = chapter_data[ch]
        for rec in records:
            htsno = rec.get("htsno", "").strip()
            if not htsno:
                continue
            desc = rec.get("description", "").strip()
            general = rec.get("general", "").strip()
            search_index.append({
                "h": htsno,
                "d": desc,
                "c": ch,
                "g": general
            })
    search_index_path = DATA_DIR / "search_index.json"
    with open(search_index_path, "w", encoding="utf-8") as f:
        json.dump(search_index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(search_index)} entries -> {search_index_path.name}")

    # ---- Step 5: Validate flows.json leaf resolution ----
    print("\nValidating flows.json leaf codes ...")
    with open(FLOWS_PATH) as f:
        flows = json.load(f)
    leaves = flows.get("leaves", {})

    # Build lookup: set of all htsno values (digits only, no dots/spaces)
    all_htsno_digits = set()
    for ch in chapter_data.values():
        for rec in ch:
            htsno = rec.get("htsno", "")
            digits = htsno.replace(".", "").replace(" ", "")
            if digits:
                all_htsno_digits.add(digits)

    found_count = 0
    missing_leaves = []
    for leaf_key, leaf_val in leaves.items():
        # leaf_key is digits-only 10-digit code
        # Also check the htsus field formatted version
        htsus = leaf_val.get("htsus", "")
        htsus_digits = htsus.replace(".", "").replace(" ", "")
        # Try exact match, or 8-digit prefix match
        if leaf_key in all_htsno_digits or htsus_digits in all_htsno_digits:
            found_count += 1
        elif leaf_key[:8] in all_htsno_digits or htsus_digits[:8] in all_htsno_digits:
            found_count += 1
        else:
            missing_leaves.append((leaf_key, htsus))

    # ---- Step 6: Size report ----
    print("\nCalculating file sizes ...")
    chapters_total = sum(
        os.path.getsize(CHAPTERS_DIR / f"ch{ch}.json")
        for ch in chapter_data.keys()
        if (CHAPTERS_DIR / f"ch{ch}.json").exists()
    )
    ci_size = os.path.getsize(chapter_index_path)
    si_size = os.path.getsize(search_index_path)

    # ---- Final Report ----
    ok_count = sum(1 for v in download_results.values() if v == "ok")
    empty_count = sum(1 for v in download_results.values() if v == "empty")
    fail_count = sum(1 for v in download_results.values() if v == "fail")
    total_records = sum(len(r) for r in chapter_data.values())

    print("\n" + "="*60)
    print("VALIDATION REPORT")
    print("="*60)
    print(f"\n1. CHAPTER FETCH RESULTS:")
    print(f"   Successfully loaded: {ok_count} chapters")
    print(f"   Empty/reserved:      {empty_count} chapters: {empty_chapters}")
    print(f"   Failed after retries:{fail_count} chapters: {failed_chapters}")
    print(f"   (Preloaded from hts_full.json: {len(PRELOADED_CHAPTERS)} chapters)")

    print(f"\n2. RECORD COUNTS:")
    print(f"   Total records across all chNN.json: {total_records}")
    print(f"   Total entries in search_index.json: {len(search_index)}")

    print(f"\n3. FLOWS.JSON LEAF RESOLUTION:")
    print(f"   Total leaves: {len(leaves)}")
    print(f"   Found: {found_count}")
    print(f"   Missing: {len(missing_leaves)}")
    if missing_leaves:
        for lk, lv in missing_leaves:
            print(f"     MISSING: key={lk}, htsus={lv}")

    print(f"\n4. FILE SIZES:")
    print(f"   data/chapters/ total:  {chapters_total:,} bytes ({chapters_total/1024/1024:.2f} MB)")
    print(f"   chapter_index.json:    {ci_size:,} bytes")
    print(f"   search_index.json:     {si_size:,} bytes ({si_size/1024:.1f} KB)")

    print(f"\n5. JSON VALIDATION:")
    errors = []
    # Validate all chapter files
    for ch in chapter_data.keys():
        fpath = CHAPTERS_DIR / f"ch{ch}.json"
        try:
            with open(fpath) as f:
                json.load(f)
        except Exception as e:
            errors.append(f"ch{ch}.json: {e}")
    # Validate chapter_index
    try:
        with open(chapter_index_path) as f:
            json.load(f)
    except Exception as e:
        errors.append(f"chapter_index.json: {e}")
    # Validate search_index
    try:
        with open(search_index_path) as f:
            json.load(f)
    except Exception as e:
        errors.append(f"search_index.json: {e}")

    if errors:
        print(f"   ERRORS: {len(errors)}")
        for e in errors:
            print(f"     {e}")
    else:
        print(f"   All JSON files parse successfully (0 errors)")

    print(f"\n6. FILE TREE (data/):")
    for item in sorted(DATA_DIR.iterdir()):
        if item.is_dir():
            files = sorted(item.iterdir())
            print(f"   {item.name}/  ({len(files)} files)")
            # Show first 10 and last 5
            for f in files[:5]:
                print(f"     {f.name}")
            if len(files) > 10:
                print(f"     ... ({len(files)-10} more) ...")
                for f in files[-5:]:
                    print(f"     {f.name}")
            elif len(files) > 5:
                for f in files[5:]:
                    print(f"     {f.name}")
        else:
            size = os.path.getsize(item)
            print(f"   {item.name}  ({size:,} bytes)")

    print("\nDone.")
    return fail_count == 0


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
