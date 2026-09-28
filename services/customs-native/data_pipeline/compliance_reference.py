"""Collect public reference evidence; this does not publish customs rules or determine liability."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request


class Node:
    def __init__(self, tag="", attrs=(), parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    def text(self):
        return re.sub(r"\s+", " ", " ".join(c if isinstance(c, str) else c.text() for c in self.children)).strip()

    def find(self, predicate):
        return ([self] if predicate(self) else []) + [n for c in self.children if isinstance(c, Node) for n in c.find(predicate)]


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.current = node

    def handle_endtag(self, tag):
        node = self.current
        while node.parent is not None:
            if node.tag == tag:
                self.current = node.parent
                break
            node = node.parent

    def handle_data(self, data):
        if self.current.tag not in {"script", "style"}:
            self.current.children.append(data)


def parse_ca_index(source):
    result = []
    for row in Document(source).root.find(lambda n: n.tag == "tr"):
        cells = row.find(lambda n: n.tag == "td")
        if len(cells) != 5 or cells[3].text() != "China":
            continue
        kind = {"Dumping": "anti_dumping", "Subsidy": "countervailing"}.get(cells[2].text())
        links = cells[1].find(lambda n: n.tag == "a")
        codes = sorted(set(re.sub(r"\D", "", c) for c in re.findall(r"\b\d{4}\.\d{2}\.\d{2}(?:\.\d{2})?\b", cells[4].text())))
        assert kind and len(links) == 1 and codes, "Unexpected CBSA China row"
        url = urllib.parse.urljoin("https://www.cbsa-asfc.gc.ca", links[0].attrs["href"])
        assert url.startswith("https://www.cbsa-asfc.gc.ca/sima-lmsi/mif-mev/")
        result.append({"id": "CA-" + cells[0].text() + "-" + kind, "case_id": cells[0].text(), "country": "CA", "origin_country": "CN", "kind": kind, "title": cells[1].text(), "codes": codes, "url": url, "source_kind": "measure_in_force"})
    assert result and len({r["id"] for r in result}) == len(result)
    return result


def section(source, start):
    # Boundaries are official headings, not arbitrary keyword occurrences in a legal paragraph.
    headings = list(re.finditer(r"<h([1-4])\b[^>]*>(.*?)</h\1>", source, re.S | re.I))
    heading = next((m for m in headings if Document(m.group(2)).root.text() == start), None)
    assert heading is not None, f"Missing section: {start}"
    end = next((m.start() for m in headings if m.start() >= heading.end() and int(m.group(1)) <= int(heading.group(1))), None)
    assert end is not None, f"Missing section boundary: {start}"
    return Document(source[heading.end():end]).root.text()


def parse_ca_detail(source):
    root = Document(source).root
    title = root.find(lambda n: n.tag == "h1")[0].text()
    if "rescinded" in title.lower():
        return None
    scope = section(source, "Product information")
    assert scope and len(scope) <= 100000
    return {"scope": scope}


def parse_us_detail(source, case_id):
    root = Document(source).root
    h3 = root.find(lambda n: n.tag == "h3")
    h5 = root.find(lambda n: n.tag == "h5")
    assert any(case_id in n.text() for n in h3) and len(h5) >= 2 and h5[0].text() == "China", "US case identity mismatch"
    scopes = root.find(lambda n: "scope-text" in n.attrs.get("class", "").split())
    codes = sorted(set(re.sub(r"\D", "", n.text()) for n in root.find(lambda n: "hts-item" in n.attrs.get("class", "").split())))
    assert len(scopes) <= 1 and all(re.fullmatch(r"\d{6,10}", c) for c in codes)
    scope = scopes[0].text() if scopes else ""
    determinations = root.find(lambda n: n.attrs.get("id") == "completed")
    if scope and determinations:
        scope += "\nFinal scope rulings and circumvention findings: " + determinations[0].text()
    assert len(scope) <= 100000
    # Active proceedings include investigations. Do not label the whole public directory as final orders.
    return {"id": "US-" + case_id, "case_id": case_id, "country": "US", "origin_country": "CN", "kind": "anti_dumping" if case_id.startswith("A-") else "countervailing", "title": h5[1].text(), "codes": codes, "scope": scope, "url": "https://beta.trade.gov/adcvd?adcvdcase=" + case_id, "source_kind": "active_proceeding"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True, help="Saved, verified public China case directory")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--guidance", type=Path, default=Path(__file__).with_name("import-guidance.json"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    raw = args.output / "raw"
    raw.mkdir(exist_ok=True)
    directory = json.loads(args.directory.read_text())
    assert directory["url"] == "https://access.trade.gov/adcvd" and directory["query"] == "China"
    cases = directory["cases"]
    assert len(cases) == directory["count"] == len(set(cases)) and all(re.fullmatch(r"[AC]-570-\d{3}", c) for c in cases)

    def fetch(url):
        parsed = urllib.parse.urlsplit(url)
        assert parsed.scheme == "https" and parsed.hostname in {"www.cbsa-asfc.gc.ca", "beta.trade.gov", "inspection.canada.ca", "ised-isde.canada.ca", "www.canada.ca", "www.cpsc.gov", "www.fda.gov", "www.aphis.usda.gov", "www.ecfr.gov", "apps.fcc.gov"} and not parsed.username
        path = raw / (hashlib.sha256(url.encode()).hexdigest() + ".html")
        metadata = path.with_suffix(".json")
        if not path.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "FreightClaw reference verification/1.0"})
            with urllib.request.urlopen(request, timeout=45) as response:
                assert response.url == url, "Unexpected source redirect: " + url + " -> " + response.url
                data = response.read(4_000_001)
            assert len(data) <= 4_000_000
            path.write_bytes(data)
            metadata.write_text(json.dumps({"url": url, "retrieved_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}) + "\n")
        data = path.read_bytes()
        meta = json.loads(metadata.read_text())
        assert meta["url"] == url
        return data.decode("utf-8-sig"), {"retrieved_at": meta["retrieved_at"], "source_sha256": hashlib.sha256(data).hexdigest()}

    index_url = "https://www.cbsa-asfc.gc.ca/sima-lmsi/mif-mev/menu-eng.html"
    html, index_meta = fetch(index_url)
    ca = parse_ca_index(html)
    ca_urls = sorted(set(row["url"] for row in ca))
    details, failures = {}, []

    def collect(item):
        country, value = item
        url = value if country == "CA" else "https://beta.trade.gov/adcvd?adcvdcase=" + value
        try:
            source, meta = fetch(url)
            parsed = parse_ca_detail(source) if country == "CA" else parse_us_detail(source, value)
            return item, ({**parsed, **meta} if parsed is not None else None), None
        except Exception as error:
            return item, None, {"url": url, "error": type(error).__name__, "reason": str(error)[:200]}

    items = [("CA", url) for url in ca_urls] + [("US", case) for case in cases]
    # ponytail: two workers suffice for this public snapshot; no background crawler or retries.
    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, (key, value, error) in enumerate(pool.map(collect, items), 1):
            details[key] = value
            if error:
                failures.append(error)
            if i % 20 == 0:
                print(json.dumps({"complete": i, "total": len(items), "failures": len(failures)}), flush=True)
    records = [{**row, **details[("CA", row["url"])]} for row in ca if details[("CA", row["url"])]]
    records += [details[("US", case)] for case in cases if details[("US", case)]]
    guidance = []
    for row in json.loads(args.guidance.read_text()):
        source, meta = fetch(row["url"])
        expected = row.pop("source_text_check")
        assert expected.lower() in Document(source).root.text().lower(), "Guidance source content changed: " + row["id"]
        guidance.append({**row, **meta})
    result = {"schema_version": "customs-compliance-reference@2026-09-28.v1", "collected_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "catalogues": [{"country": "CA", "url": index_url, **index_meta, "expected": len(ca), "collected": sum(r["country"] == "CA" for r in records), "excluded_rescinded": sum(details[("CA", row["url"])] is None and row["url"] not in {f["url"] for f in failures} for row in ca)}, {"country": "US", "url": directory["url"], "retrieved_at": directory["observed_at"], "source_sha256": hashlib.sha256(args.directory.read_bytes()).hexdigest(), "expected": len(cases), "collected": sum(r["country"] == "US" for r in records)}], "remedies": records, "guidance": guidance, "failures": failures}
    (args.output / "remedies.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"records": len(records), "failures": failures}), flush=True)


if __name__ == "__main__":
    main()
