"""Local source probe, not a production adapter. Requires pdfplumber and curl.

Downloads only OOCL's two observed PNW PDF feeds. It deliberately emits partial
reference results; no transshipment, terminal, cutoff, booking or API authority.
"""
import argparse
import calendar
from datetime import date, timedelta
import hashlib
import io
import json
import re
import subprocess
import sys

SERVICES = ('PNW2', 'PNW3')
SOURCE_ROOT = 'https://www.oocl.com/SiteCollectionDocuments/OOCL/eServices/Sailing%20Schedule%20by%20Service/'
MONTHS = {name: index for index, name in enumerate(calendar.month_abbr) if name}
LIMIT = 2 * 1024 * 1024


def check_freshness(updated, observed):
    age = (date.fromisoformat(observed) - date.fromisoformat(updated)).days
    if not 0 <= age <= 7:
        raise ValueError('source_date_stale_or_future')


def date_range(raw, updated, previous=None):
    match = re.fullmatch(r'(\d{1,2})--(\d{1,2}) ([A-Z][a-z]{2})', raw)
    if not match or match[3] not in MONTHS:
        raise ValueError('date_layout_changed')
    arrival_day, departure_day, month = int(match[1]), int(match[2]), MONTHS[match[3]]
    anchor = date.fromisoformat(updated)
    candidates = []
    for year in range(anchor.year - 1, anchor.year + 2):
        try:
            departure = date(year, month, departure_day)
            arrival_month = month - 1 if arrival_day > departure_day else month
            arrival = date(year - (arrival_month == 0), arrival_month or 12, arrival_day)
        except ValueError:
            continue
        # ponytail: the observed files span less than one year. Reject longer
        # or ambiguous calendars until the source provides explicit years.
        if not anchor - timedelta(days=90) <= arrival <= departure <= anchor + timedelta(days=210):
            continue
        if previous and not date.fromisoformat(previous) <= arrival <= date.fromisoformat(previous) + timedelta(days=90):
            continue
        candidates.append((arrival.isoformat(), departure.isoformat()))
    if len(candidates) != 1:
        raise ValueError('date_year_or_chronology_ambiguous')
    return candidates[0]


def clean(value):
    return ' '.join((value or '').split())


def parse_tables(tables, updated):
    voyages, active = [], []
    for table in tables:
        for raw in table:
            row = [clean(cell) for cell in raw]
            if len(row) == 2 and 'Last Update Date:' in row[1]:
                continue
            if not any(row):
                continue
            if len(row) != 8:
                raise ValueError('table_layout_changed')
            if row[::2] == ['Vessel Name'] * 4:
                if not all(row[1::2]):
                    raise ValueError('vessel_name_missing')
                active = [{'vessel': name, 'voyage': None, 'calls': []} for name in row[1::2]]
                voyages.extend(active)
                continue
            if len(active) != 4:
                raise ValueError('orphan_table_continuation')
            if row[::2] == ['Vessel/Voyage'] * 4:
                for voyage, value in zip(active, row[1::2]):
                    if not re.fullmatch(r'[A-Z0-9]+/[A-Z0-9]+', value):
                        raise ValueError('voyage_layout_changed')
                    voyage['voyage'] = value
                continue
            if row == ['Port', 'Arr--Dep'] * 4:
                continue
            for index, voyage in enumerate(active):
                port, raw_date = row[index * 2:index * 2 + 2]
                if not port and not raw_date:
                    continue
                if not port or not raw_date or not voyage['voyage']:
                    raise ValueError('incomplete_port_call')
                previous = voyage['calls'][-1]['departure'] if voyage['calls'] else None
                arrival, departure = date_range(raw_date, updated, previous)
                voyage['calls'].append({'port': port, 'arrival': arrival, 'departure': departure, 'raw': raw_date})
    if not voyages or any(not item['voyage'] or not item['calls'] for item in voyages):
        raise ValueError('no_complete_voyages')
    return voyages


def match_routes(voyages, origin, destination, first, last):
    records = []
    for voyage in voyages:
        calls = voyage['calls']
        for index, start in enumerate(calls):
            if start['port'].casefold() != origin.casefold() or not first <= start['departure'] <= last:
                continue
            for end in calls[index + 1:]:
                if end['port'].casefold() == origin.casefold():
                    break
                if end['port'].casefold() == destination.casefold():
                    records.append({
                        'vessel_name': voyage['vessel'], 'source_vessel_voyage': voyage['voyage'],
                        'origin_name': start['port'], 'destination_name': end['port'],
                        'departure_date': start['departure'], 'arrival_date': end['arrival'],
                        'departure_source_text': start['raw'], 'arrival_source_text': end['raw'],
                        'date_precision': 'date', 'routing': 'same_vessel_port_calls',
                    })
                    break
    return records


def download(service, proxy_port):
    url = SOURCE_ROOT + service + '_LT.pdf'
    args = ['curl', '--disable', '--silent', '--show-error', '--fail', '--proto', '=https',
            '--connect-timeout', '10', '--max-time', '25', '--max-filesize', str(LIMIT), '--max-redirs', '0']
    if proxy_port:
        args += ['--proxy', f'http://127.0.0.1:{proxy_port}', '--noproxy', '']
    else:
        args += ['--noproxy', '*']
    result = subprocess.run(args + ['--write-out', '\n%{http_code}', url], capture_output=True, timeout=30, check=False)
    blob, _, status = result.stdout.rpartition(b'\n')
    if re.fullmatch(rb'[1-5]\d{2}', status) and status != b'200':
        raise ValueError('pdf_http_' + status.decode('ascii'))
    if result.returncode:
        raise ValueError('pdf_transport_' + str(result.returncode))
    if status != b'200' or len(blob) > LIMIT or not blob.startswith(b'%PDF-'):
        raise ValueError('pdf_response_invalid')
    return url, blob


def read_pdf(blob, service):
    import pdfplumber
    if len(blob) > LIMIT or not blob.startswith(b'%PDF-'):
        raise ValueError('pdf_response_invalid')
    try:
        with pdfplumber.open(io.BytesIO(blob)) as pdf:
            if not 1 <= len(pdf.pages) <= 8:
                raise ValueError('pdf_page_limit')
            header = pdf.pages[0].extract_text() or ''
            match = re.search(r'Last Update Date:\s*(\d{2})-([A-Z][a-z]{2})-(\d{4})', header)
            if not match or match[2] not in MONTHS or not re.search(r'\b' + re.escape(service) + r'\b', header):
                raise ValueError('pdf_identity_missing')
            updated = date(int(match[3]), MONTHS[match[2]], int(match[1])).isoformat()
            tables = [table for page in pdf.pages for table in page.extract_tables()]
            return updated, parse_tables(tables, updated)
    except ValueError:
        raise
    except Exception as error:
        raise ValueError('pdf_parse_failed') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='Shanghai')
    parser.add_argument('--destination', default='Vancouver')
    parser.add_argument('--from', dest='first', required=True, type=date.fromisoformat)
    parser.add_argument('--until', dest='last', required=True, type=date.fromisoformat)
    parser.add_argument('--service', action='append', choices=SERVICES)
    parser.add_argument('--proxy-port', type=int)
    args = parser.parse_args()
    if not 0 <= (args.last - args.first).days <= 89 or args.origin.strip().casefold() == args.destination.strip().casefold():
        parser.error('Choose different ports and a departure window of at most 90 days.')
    if args.proxy_port is not None and not 1 <= args.proxy_port <= 65535:
        parser.error('Invalid loopback proxy port.')
    if any(not value.strip() or len(value) > 100 for value in (args.origin, args.destination)):
        parser.error('Invalid port name.')
    result = {'status': 'manual_review', 'production_ready': False,
              'source_scope': 'OOCL PNW2/PNW3 published same-vessel port calls only',
              'observed_date': date.today().isoformat(),
              'query': {'origin': args.origin, 'destination': args.destination, 'from': str(args.first), 'until': str(args.last)},
              'warnings': ['partial_service_coverage', 'year_inferred_from_source_update_and_port_chronology',
                           'no_transshipment_terminal_cutoff_or_booking_validation', 'production_egress_not_verified'],
              'sources': [], 'records': [], 'failures': []}
    for service in dict.fromkeys(args.service or SERVICES):
        try:
            url, blob = download(service, args.proxy_port)
            updated, voyages = read_pdf(blob, service)
            check_freshness(updated, result['observed_date'])
            digest = hashlib.sha256(blob).hexdigest()
            result['sources'].append({'service': service, 'url': url, 'updated_date': updated, 'sha256': digest, 'bytes': len(blob)})
            records = match_routes(voyages, args.origin.strip(), args.destination.strip(), str(args.first), str(args.last))
            result['records'].extend({**record, 'service': service, 'source_sha256': digest} for record in records)
        except (ValueError, OSError, subprocess.SubprocessError, ImportError) as error:
            result['failures'].append({'service': service, 'reason': str(error) if isinstance(error, ValueError) else type(error).__name__})
    if not result['sources']:
        result['status'] = 'unavailable'
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 4 if result['sources'] else 6


if __name__ == '__main__':
    sys.exit(main())
