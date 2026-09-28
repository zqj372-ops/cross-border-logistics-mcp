import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/customs-native'))
from data_pipeline.compliance_reference import parse_ca_index, parse_ca_detail, parse_us_detail


class ComplianceReferenceTest(unittest.TestCase):
    def test_china_is_not_taipei_and_code_list_is_only_a_hint(self):
        def row(country, kind='Dumping'):
            return f'<tr><td>TEST</td><td><a href="/sima-lmsi/mif-mev/test-eng.html">Synthetic goods</a></td><td>{kind}</td><td>{country}</td><td>1234.56.78.90</td></tr>'
        data = parse_ca_index('<table>' + row('China') + row('Chinese&nbsp;Taipei') + row('China', 'Subsidy') + '</table>')
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0]['codes'], ['1234567890'])
        self.assertEqual(data[1]['kind'], 'countervailing')
        with self.assertRaises(AssertionError):
            parse_ca_index('<table>' + row('China', 'Unrecognized') + '</table>')

    def test_definition_exclusions_and_rescission_are_preserved(self):
        source = '<h1>Synthetic goods: Measures in force</h1><h2>Product information</h2><h3>Product definition</h3><p>Synthetic steel goods.</p><h3>Exclusions</h3><p>Except toy goods.</p><h2>Investigation information</h2>'
        self.assertIn('Except toy goods', parse_ca_detail(source)['scope'])
        self.assertIsNone(parse_ca_detail(source.replace('Synthetic goods:', 'Rescinded—Synthetic goods:')))
        self.assertEqual(parse_ca_detail(source.replace('Investigation information', 'Original investigation')), parse_ca_detail(source))
        with self.assertRaises(AssertionError):
            parse_ca_detail(source.replace('Product information', 'Changed heading'))

    def test_us_case_identity_scope_and_code_validation(self):
        source = '<h3>Case #A-570-000</h3><h5>China</h5><h5>Synthetic goods</h5><div class="hts-item">1234.56.78.90</div><div class="scope-text">Synthetic goods, excluding toys.</div>'
        result = parse_us_detail(source, 'A-570-000')
        self.assertEqual(result['source_kind'], 'active_proceeding')
        self.assertIn('excluding toys', result['scope'])
        pending = parse_us_detail('<h3>Case #A-570-001</h3><h5>China</h5><h5>New synthetic proceeding</h5>', 'A-570-001')
        self.assertEqual(pending['scope'], '')
        self.assertEqual(pending['codes'], [])
        with self.assertRaises(AssertionError):
            parse_us_detail(source, 'C-570-000')
        with self.assertRaises(AssertionError):
            parse_us_detail(source.replace('1234.56.78.90', 'garbage'), 'A-570-000')


if __name__ == '__main__':
    unittest.main()
