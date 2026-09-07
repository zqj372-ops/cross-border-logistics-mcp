import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'services/customs-native'))
from data_pipeline.cbsa_review import load_chapters, audit_candidate


class ChapterReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)

    def source(self, rate='5%', language='eng', sha=None, date='2026-09-01', header='MFN Tariff'):
        url=f'https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/2026/html/02/ch12-{language}.html'
        lang='en' if language=='eng' else 'fr'
        h=f'<html lang="{lang}"><head><title>Chapter 12: T2026-2</title><link rel="canonical" href="{url}"><meta name="dcterms.issued" content="{date}"></head><body><table><thead><tr><th>Tariff Item</th><th>SS</th><th>Description of Goods</th><th>Unit of Meas.</th><th>{header}</th><th>Applicable Preferential Tariffs</th></tr></thead><tbody><tr><td>1234.56.78</td><td>90</td><td>Synthetic test goods</td><td>KGM</td><td>{rate}</td><td></td></tr></tbody></table></body></html>'
        p=self.root/f'ch12-{language}.html';p.write_text(h)
        receipt={'url':url,'status':0,'sha256':sha or hashlib.sha256(p.read_bytes()).hexdigest(),'retrieved_at':'2026-09-01T01:00:00Z'}
        (self.root/'chapter-fetch-report.json').write_text(json.dumps([receipt]))

    def candidate(self, rate='5%'):
        return {'nomenclature':[{'code':'1234567890','is_declarable':True,'description_original':'Synthetic test goods','source_locator':'fixture://source/row1'}], 'tariff_rules':[{'code':'12345678','code_match_type':'prefix','treatment':'MFN','rate_expression_raw':rate,'source_locator':'fixture://source/row2'}]}

    def test_verified_chapter_matches_explicit_parent_rate_with_evidence(self):
        self.source()
        result=audit_candidate(self.candidate(),load_chapters(self.root),'en')
        self.assertEqual(result['status'],'pass')
        self.assertEqual(result['matched_simple_mfn'],1)
        self.assertEqual(result['scope'],'provided_chapters_only')
        self.assertEqual(result['chapter_count'],1)

    def test_source_conflict_is_preserved_instead_of_overwriting_rate(self):
        self.source('9%');candidate=self.candidate()
        result=audit_candidate(candidate,load_chapters(self.root),'en')
        self.assertEqual(result['status'],'review')
        self.assertEqual(result['issues'][0]['reason'],'official_mfn_mismatch')
        self.assertTrue(result['issues'][0]['html_sha256'])
        self.assertEqual(candidate['tariff_rules'][0]['rate_expression_raw'],'5%')

    def test_hash_metadata_and_changed_headers_are_rejected(self):
        for args in [{'sha':'0'*64},{'date':'2025-01-01'},{'header':'Unrecognized rate'}]:
            self.source(**args)
            with self.assertRaises(ValueError):load_chapters(self.root)

    def test_missing_html_code_is_an_issue_not_a_zero_rate(self):
        self.source();c=self.candidate();c['nomenclature'][0]['code']='1234567891'
        result=audit_candidate(c,load_chapters(self.root),'en')
        self.assertEqual(result['status'],'review')
        self.assertEqual(result['issues'][0]['reason'],'code_absent_from_official_chapter')

    def test_duplicate_codes_with_different_units_require_review(self):
        self.source();path=self.root/'ch12-eng.html';html=path.read_text()
        row=html.split('<tbody>')[1].split('</tbody>')[0]
        path.write_text(html.replace('</tbody>',row.replace('KGM','NMB')+'</tbody>'))
        receipt=json.loads((self.root/'chapter-fetch-report.json').read_text())
        receipt[0]['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        (self.root/'chapter-fetch-report.json').write_text(json.dumps(receipt))
        result=audit_candidate(self.candidate(),load_chapters(self.root),'en')
        self.assertEqual(result['status'],'review')
        self.assertEqual(result['issues'][0]['reason'],'duplicate_official_chapter_code')
        self.assertEqual(result['matched_simple_mfn'],0)


if __name__=='__main__':unittest.main()
