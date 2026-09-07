"""Read-only cross-checks against hash-bound official T2026-2 chapters.

Chapter differences are evidence for review, never instructions to overwrite a
CADEx record. A successful check covers only the supplied chapter files.
"""
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re

HEADERS = {
    'eng': ['Tariff Item','SS','Description of Goods','Unit of Meas.','MFN Tariff','Applicable Preferential Tariffs'],
    'fra': ['Numéro tarifaire','SS','Dénomination des marchandises','Unité de mes.','Tarif de la N.P.F.','Tarif de préférence applicable'],
}
URL = re.compile(r'https://www\.cbsa-asfc\.gc\.ca/trade-commerce/tariff-tarif/2026/html/02/ch(\d{2})-(eng|fra)\.html')


class ChapterParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables=[];self.table=None;self.row=None;self.cell=None
        self.language=None;self.canonical=[];self.issued=[];self.title=[];self.in_title=False

    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='html':self.language=attrs.get('lang')
        if tag=='link' and attrs.get('rel')=='canonical':self.canonical.append(attrs.get('href'))
        if tag=='meta' and attrs.get('name')=='dcterms.issued':self.issued.append(attrs.get('content'))
        if tag=='title':self.in_title=True
        if tag=='table':
            if self.table is not None:raise ValueError('nested_chapter_table')
            self.table=[]
        if tag=='tr' and self.table is not None:self.row=[]
        if tag in {'td','th'} and self.row is not None:self.cell=[]
        if tag=='br' and self.cell is not None:self.cell.append(' ')

    def handle_data(self,value):
        if self.cell is not None:self.cell.append(value)
        if self.in_title:self.title.append(value)

    def handle_endtag(self,tag):
        if tag=='title':self.in_title=False
        if tag in {'td','th'} and self.cell is not None:
            self.row.append(' '.join(''.join(self.cell).split()));self.cell=None
        if tag=='tr' and self.row is not None:
            self.table.append(self.row);self.row=None
        if tag=='table' and self.table is not None:
            self.tables.append(self.table);self.table=None


def load_chapters(directory):
    root=Path(directory)
    receipts=json.loads((root/'chapter-fetch-report.json').read_text())
    if not isinstance(receipts,list) or not receipts:raise ValueError('missing_chapter_receipts')
    result={}
    for receipt in receipts:
        match=URL.fullmatch(receipt.get('url',''))
        if not match or receipt.get('status')!=0:raise ValueError('unverified_chapter_receipt')
        chapter,language=match.groups();key=(chapter,language)
        if key in result:raise ValueError('duplicate_chapter_receipt')
        fetched=datetime.fromisoformat(receipt['retrieved_at'].replace('Z','+00:00'))
        if fetched.tzinfo is None or fetched>datetime.now(timezone.utc):raise ValueError('invalid_chapter_retrieval_time')
        filename=f'ch{chapter}-{language}.html';path=root/filename
        if path.is_symlink() or not path.is_file() or path.stat().st_size>16*1024*1024:raise ValueError('invalid_chapter_file')
        raw=path.read_bytes()
        if sha256(raw).hexdigest()!=receipt.get('sha256'):raise ValueError('chapter_hash_mismatch')
        parsed=ChapterParser();parsed.feed(raw.decode('utf-8-sig'));parsed.close()
        if parsed.canonical!=[receipt['url']] or parsed.issued!=['2026-09-01'] or parsed.language!=('en' if language=='eng' else 'fr') or 'T2026-2' not in ''.join(parsed.title):
            raise ValueError('chapter_edition_or_language_mismatch')
        tables=[table for table in parsed.tables if table and table[0]==HEADERS[language]]
        if len(tables)!=1:raise ValueError('chapter_header_changed')
        rows={};duplicates=[]
        for index,cells in enumerate(tables[0][1:],1):
            if cells==HEADERS[language]:continue
            if len(cells)!=6:raise ValueError('chapter_row_shape_changed')
            tariff,suffix=cells[:2]
            if not re.fullmatch(r'\d{2}(?:\d{2})?(?:\.\d{1,2})*',tariff) or (suffix and not re.fullmatch(r'\d{2}',suffix)):
                raise ValueError('chapter_code_format_changed')
            code=tariff.replace('.','')+suffix
            if not code.startswith(chapter):raise ValueError('chapter_code_out_of_scope')
            record={'cells':cells,'source_locator':receipt['url']+f'#tariff-row[{index}]','raw_row_hash':sha256(json.dumps(cells,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}
            if code in rows:
                duplicates.append({'code':code,'rows':[rows[code],record]})
            else:rows[code]=record
        if not rows:raise ValueError('empty_chapter_schedule')
        result[key]={'receipt':receipt,'filename':filename,'rows':rows,'duplicates':duplicates}
    return result


def simple_rate(raw):
    value=' '.join(raw.split()).casefold()
    if value in {'free','en fr.','en fr','enfr.','enfr'}:return Decimal('0')
    if re.fullmatch(r'\d+(?:[.,]\d+)?\s*%',value):return Decimal(value.rstrip('%').strip().replace(',','.'))
    return None


def audit_candidate(candidate,chapters,language):
    lang='eng' if language=='en' else 'fra'
    selected={chapter:entry for (chapter,l),entry in chapters.items() if l==lang}
    rates={}
    for rule in candidate['tariff_rules']:
        if rule['treatment']=='MFN':rates.setdefault(rule['code'],[]).append(rule)
    issues=[];matched=0;checked=0;ambiguous=set()
    for chapter in selected.values():
        for duplicate in chapter['duplicates']:
            ambiguous.add(duplicate['code'])
            issues.append({'reason':'duplicate_official_chapter_code',**duplicate,'html_url':chapter['receipt']['url'],'html_sha256':chapter['receipt']['sha256']})
    missing={e['source_locator'] for e in candidate.get('exclusions',[]) if e['reason']=='missing_legal_description'}
    for item in candidate['nomenclature']:
        if not item['is_declarable'] and item['source_locator'] not in missing:continue
        code=item['code'];chapter=selected.get(code[:2])
        if chapter is None:continue
        checked+=1;html=chapter['rows'].get(code)
        if code in ambiguous:continue
        evidence={'code':code,'cadex_locator':item['source_locator'],'html_url':chapter['receipt']['url'],'html_sha256':chapter['receipt']['sha256']}
        if html is None:
            issues.append({**evidence,'reason':'code_absent_from_official_chapter'});continue
        if item['source_locator'] in missing:
            issues.append({**evidence,'reason':'missing_cadex_name_has_chapter_evidence','chapter_name':html['cells'][2],'chapter_row_hash':html['raw_row_hash']})
        if language!='en':continue  # French package contains legal names only.
        applicable=rates.get(code,[]) or [r for r in rates.get(code[:8],[]) if r['code_match_type']=='prefix']
        current={r['rate_expression_raw'] for r in applicable}
        official=html['cells'][4];expected=simple_rate(official)
        if not current:
            issues.append({**evidence,'reason':'mfn_missing_with_chapter_evidence','chapter_rate':official});continue
        if len(current)==1 and expected is not None and simple_rate(next(iter(current)))==expected:
            matched+=1;continue
        if len(current)==1 and next(iter(current)).strip()==official.strip():continue
        # Complex-language differences stay explicit; no numeric guess or
        # automatic choice between two current official formats is permitted.
        reason='official_mfn_mismatch' if expected is not None and all(simple_rate(x) is not None for x in current) else 'complex_mfn_difference_requires_review'
        issues.append({**evidence,'reason':reason,'cadex_rates':sorted(current),'chapter_rate':official,'chapter_row_hash':html['raw_row_hash']})
    return {'schema_version':'1.0.0','status':'review' if issues else 'pass','scope':'provided_chapters_only','language':language,'chapter_count':len(selected),'chapters':sorted(selected),'checked_codes':checked,'matched_simple_mfn':matched,'issues':issues,'approval_granted':False}
