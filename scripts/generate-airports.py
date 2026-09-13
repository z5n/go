#!/usr/bin/env python3
"""Generate web/airports-data.js from OurAirports CSV.

Usage:
  curl -sL https://davidmegginson.github.io/ourairports-data/airports.csv -o /tmp/airports.csv
  python3 scripts/generate-airports.py [/tmp/airports.csv]
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "airports-data.js"

COUNTRY_NAMES = {
"AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AS":"American Samoa","AD":"Andorra","AO":"Angola","AI":"Anguilla","AQ":"Antarctica","AG":"Antigua and Barbuda","AR":"Argentina","AM":"Armenia","AW":"Aruba","AU":"Australia","AT":"Austria","AZ":"Azerbaijan","BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize","BJ":"Benin","BM":"Bermuda","BT":"Bhutan","BO":"Bolivia","BQ":"Caribbean Netherlands","BA":"Bosnia and Herzegovina","BW":"Botswana","BR":"Brazil","IO":"British Indian Ocean Territory","VG":"British Virgin Islands","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso","BI":"Burundi","KH":"Cambodia","CM":"Cameroon","CA":"Canada","CV":"Cape Verde","KY":"Cayman Islands","CF":"Central African Republic","TD":"Chad","CL":"Chile","CN":"China","CX":"Christmas Island","CC":"Cocos Islands","CO":"Colombia","KM":"Comoros","CG":"Congo","CD":"Democratic Republic of the Congo","CK":"Cook Islands","CR":"Costa Rica","HR":"Croatia","CU":"Cuba","CW":"Curaçao","CY":"Cyprus","CZ":"Czechia","CI":"Côte d'Ivoire","DK":"Denmark","DJ":"Djibouti","DM":"Dominica","DO":"Dominican Republic","EC":"Ecuador","EG":"Egypt","SV":"El Salvador","GQ":"Equatorial Guinea","ER":"Eritrea","EE":"Estonia","SZ":"Eswatini","ET":"Ethiopia","FK":"Falkland Islands","FO":"Faroe Islands","FJ":"Fiji","FI":"Finland","FR":"France","GF":"French Guiana","PF":"French Polynesia","GA":"Gabon","GM":"Gambia","GE":"Georgia","DE":"Germany","GH":"Ghana","GI":"Gibraltar","GR":"Greece","GL":"Greenland","GD":"Grenada","GP":"Guadeloupe","GU":"Guam","GT":"Guatemala","GG":"Guernsey","GN":"Guinea","GW":"Guinea-Bissau","GY":"Guyana","HT":"Haiti","HN":"Honduras","HK":"Hong Kong","HU":"Hungary","IS":"Iceland","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IE":"Ireland","IM":"Isle of Man","IL":"Israel","IT":"Italy","JM":"Jamaica","JP":"Japan","JE":"Jersey","JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya","KI":"Kiribati","XK":"Kosovo","KW":"Kuwait","KG":"Kyrgyzstan","LA":"Laos","LV":"Latvia","LB":"Lebanon","LS":"Lesotho","LR":"Liberia","LY":"Libya","LI":"Liechtenstein","LT":"Lithuania","LU":"Luxembourg","MO":"Macau","MG":"Madagascar","MW":"Malawi","MY":"Malaysia","MV":"Maldives","ML":"Mali","MT":"Malta","MH":"Marshall Islands","MQ":"Martinique","MR":"Mauritania","MU":"Mauritius","YT":"Mayotte","MX":"Mexico","FM":"Micronesia","MD":"Moldova","MC":"Monaco","MN":"Mongolia","ME":"Montenegro","MS":"Montserrat","MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NR":"Nauru","NP":"Nepal","NL":"Netherlands","NC":"New Caledonia","NZ":"New Zealand","NI":"Nicaragua","NE":"Niger","NG":"Nigeria","NU":"Niue","NF":"Norfolk Island","KP":"North Korea","MK":"North Macedonia","MP":"Northern Mariana Islands","NO":"Norway","OM":"Oman","PK":"Pakistan","PW":"Palau","PS":"Palestine","PA":"Panama","PG":"Papua New Guinea","PY":"Paraguay","PE":"Peru","PH":"Philippines","PL":"Poland","PT":"Portugal","PR":"Puerto Rico","QA":"Qatar","RE":"Réunion","RO":"Romania","RU":"Russia","RW":"Rwanda","WS":"Samoa","SM":"San Marino","ST":"São Tomé and Príncipe","SA":"Saudi Arabia","SN":"Senegal","RS":"Serbia","SC":"Seychelles","SL":"Sierra Leone","SG":"Singapore","SX":"Sint Maarten","SK":"Slovakia","SI":"Slovenia","SB":"Solomon Islands","SO":"Somalia","ZA":"South Africa","KR":"South Korea","SS":"South Sudan","ES":"Spain","LK":"Sri Lanka","BL":"Saint Barthélemy","SH":"Saint Helena","KN":"Saint Kitts and Nevis","LC":"Saint Lucia","MF":"Saint Martin","PM":"Saint Pierre and Miquelon","VC":"Saint Vincent and the Grenadines","SD":"Sudan","SR":"Suriname","SE":"Sweden","CH":"Switzerland","SY":"Syria","TW":"Taiwan","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TL":"Timor-Leste","TG":"Togo","TO":"Tonga","TT":"Trinidad and Tobago","TN":"Tunisia","TR":"Turkey","TM":"Turkmenistan","TC":"Turks and Caicos Islands","TV":"Tuvalu","UG":"Uganda","UA":"Ukraine","AE":"United Arab Emirates","GB":"United Kingdom","US":"United States","UY":"Uruguay","UZ":"Uzbekistan","VU":"Vanuatu","VE":"Venezuela","VN":"Vietnam","VI":"U.S. Virgin Islands","EH":"Western Sahara","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe",
}

COUNTRY_EXTRAS = {
  "CH": ["BSL"],
}

COUNTRY_ALIASES = {
  "switzerland": "CH", "swiss": "CH", "suisse": "CH", "schweiz": "CH", "svizzera": "CH",
  "united states": "US", "usa": "US", "u.s.": "US", "u.s.a.": "US", "america": "US",
  "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB", "britain": "GB",
  "south korea": "KR", "korea": "KR", "republic of korea": "KR",
  "north korea": "KP",
  "czech republic": "CZ", "czechia": "CZ",
  "russia": "RU", "russian federation": "RU",
  "uae": "AE", "united arab emirates": "AE",
  "holland": "NL", "netherlands": "NL",
  "vietnam": "VN", "viet nam": "VN",
  "taiwan": "TW", "hong kong": "HK", "macau": "MO", "macao": "MO",
  "ivory coast": "CI", "cote divoire": "CI",
  "laos": "LA", "syria": "SY", "iran": "IR",
  "bolivia": "BO", "venezuela": "VE", "tanzania": "TZ",
  "brunei": "BN", "moldova": "MD", "macedonia": "MK", "north macedonia": "MK",
  "eswatini": "SZ", "swaziland": "SZ",
  "cape verde": "CV", "cabo verde": "CV",
  "democratic republic of the congo": "CD", "drc": "CD", "congo-kinshasa": "CD",
  "republic of the congo": "CG", "congo-brazzaville": "CG",
  "myanmar": "MM", "burma": "MM",
  "palestine": "PS", "kosovo": "XK",
}

MIL = re.compile(
  r"\b(air base|air force|afb|aaf\b|raaf|raf |naval air|army air|military|heliport|seaplane)\b",
  re.I,
)


def main() -> None:
  src = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/airports.csv")
  if not src.exists():
    raise SystemExit(f"Missing {src}. Download OurAirports airports.csv first.")

  rows = []
  with src.open(newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
      if (r.get("scheduled_service") or "").lower() != "yes":
        continue
      code = (r.get("iata_code") or "").strip().upper()
      if not re.fullmatch(r"[A-Z]{3}", code):
        continue
      typ = r.get("type") or ""
      if typ not in ("large_airport", "medium_airport", "small_airport"):
        continue
      name = (r.get("name") or "").strip()
      if MIL.search(name):
        continue
      rows.append(
        {
          "code": code,
          "name": name,
          "city": (r.get("municipality") or "").strip(),
          "country": (r.get("iso_country") or "").strip().upper(),
          "size": "L" if typ == "large_airport" else "M" if typ == "medium_airport" else "S",
          "rank": 0 if typ == "large_airport" else 1 if typ == "medium_airport" else 2,
        }
      )

  rows.sort(key=lambda x: (x["code"], x["rank"]))
  dedup = []
  seen = set()
  for r in rows:
    if r["code"] in seen:
      continue
    seen.add(r["code"])
    dedup.append(r)

  by_country = {}
  for r in dedup:
    by_country.setdefault(r["country"], []).append(r)

  final = []
  final_codes = set()
  for list_ in by_country.values():
    keep = [x for x in list_ if x["size"] in "LM"]
    if len(keep) < 3:
      keep = list_
    for x in keep:
      if x["code"] in final_codes:
        continue
      final_codes.add(x["code"])
      final.append(x)

  by_code = {x["code"]: x for x in dedup}
  for codes in COUNTRY_EXTRAS.values():
    for code in codes:
      src_row = by_code.get(code)
      if not src_row or code in final_codes:
        continue
      final.append(src_row)
      final_codes.add(code)

  final.sort(key=lambda x: (x["country"], x["rank"], x["city"], x["code"]))
  compact = [
    [r["code"], r["name"][:70], r["city"][:40], r["country"], r["size"]] for r in final
  ]
  used = {r[3] for r in compact}
  names = {k: v for k, v in COUNTRY_NAMES.items() if k in used}

  body = (
    "/** Auto-generated from OurAirports (scheduled IATA). Regenerate via scripts/generate-airports.py */\n"
    f"export const COUNTRY_NAMES = {json.dumps(names, ensure_ascii=False, separators=(',', ':'))};\n"
    f"export const COUNTRY_ALIASES = {json.dumps(COUNTRY_ALIASES, ensure_ascii=False, separators=(',', ':'))};\n"
    f"export const COUNTRY_EXTRAS = {json.dumps(COUNTRY_EXTRAS, ensure_ascii=False, separators=(',', ':'))};\n"
    f"export const AIRPORT_ROWS = {json.dumps(compact, ensure_ascii=False, separators=(',', ':'))};\n"
  )
  OUT.write_text(body, encoding="utf-8")
  print(f"Wrote {OUT} ({len(compact)} airports, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
  main()
