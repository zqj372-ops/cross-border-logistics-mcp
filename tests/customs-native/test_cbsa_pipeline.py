import csv
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/customs-native'))
from data_pipeline.cbsa import normalize_cbsa_directory


class CbsaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root/'mapping.json'
        self.config.write_text(json.dumps({'businessTables':[{'file':'tariff.csv','columns':{'code':'code','description':'description'},'treatments':[{'name':'MFN','column':'rate','priority':10}],'technicalColumns':['row_id']}], 'nonBusinessTables':{'pbcatfmt.csv':{'columns':['pbf_name','pbf_frmt','pbf_type','pbf_cntr'],'reason':'powerbuilder_presentation_metadata','evidence':'https://docs.appeon.com/pb2019/pbug/apas01.html'}}}))

    def csv(self, file, columns, rows):
        with (self.root/file).open('w',newline='') as f:
            w=csv.writer(f);w.writerow(columns);w.writerows(rows)

    def run_adapter(self):
        return normalize_cbsa_directory(self.root,config_path=self.config)

    def test_metadata_and_exact_duplicate_are_audited_without_blocking(self):
        self.csv('tariff.csv',['code','description','rate','row_id'],[['1234567890','Synthetic item','5%','1'],['1234567890','Synthetic item','5%','2']])
        self.csv('pbcatfmt.csv',['pbf_name','pbf_frmt','pbf_type','pbf_cntr'],[['General','General','81','0']])
        r=self.run_adapter()
        self.assertEqual(r['status'],'pass')
        self.assertEqual(len(r['nomenclature']),1)
        self.assertEqual(len(r['tariff_rules']),1)
        self.assertEqual(len(r['omissions']),2)
        self.assertTrue(all(x['raw_row_hash'] and x['source_locator'] for x in r['omissions']))

    def test_unknown_table_even_when_empty_is_not_silently_ignored(self):
        self.csv('tariff.csv',['code','description','rate','row_id'],[['1234567890','Synthetic','5%','1']])
        self.csv('unknown.csv',['unexpected'],[])
        self.assertEqual(self.run_adapter()['status'],'review')

    def test_changed_metadata_header_is_blocked(self):
        self.csv('tariff.csv',['code','description','rate','row_id'],[['1234567890','Synthetic','5%','1']])
        self.csv('pbcatfmt.csv',['pbf_name','tariff'],[['General','5%']])
        self.assertEqual(self.run_adapter()['status'],'review')

    def test_different_effective_dates_are_not_deduplicated(self):
        self.csv('tariff.csv',['code','description','rate','date','row_id'],[['1234567890','Synthetic','5%','2026-01-01','1'],['1234567890','Synthetic','5%','2026-02-01','2']])
        r=self.run_adapter()
        self.assertEqual(r['status'],'review')
        self.assertEqual(len(r['nomenclature']),2)
        self.assertEqual(r['omissions'],[])

    def test_missing_business_table_and_missing_rate_column_block(self):
        self.assertEqual(self.run_adapter()['status'],'review')
        self.csv('tariff.csv',['code','description','row_id'],[['1234567890','Synthetic','1']])
        self.assertEqual(self.run_adapter()['status'],'review')

    def test_canadian_tariff_items_explicitly_cover_statistical_suffixes(self):
        self.csv('tariff.csv',['code','description','rate','row_id'],[['12345678','Synthetic tariff item','5%','1'],['1234567890','Synthetic statistical suffix','','2']])
        result=self.run_adapter()
        self.assertEqual(result['tariff_rules'][0]['code_match_type'],'prefix')

    def test_empty_legal_names_cannot_be_promoted_to_declarable_codes(self):
        self.csv('tariff.csv',['code','description','rate','row_id'],[['1234567890','','5%','1']])
        result=self.run_adapter()
        self.assertEqual(result['status'],'review')
        self.assertFalse(result['nomenclature'][0]['is_declarable'])
        self.assertIn('missing_legal_description',[r['reason'] for r in result['exclusions']])

if __name__=='__main__':unittest.main()
