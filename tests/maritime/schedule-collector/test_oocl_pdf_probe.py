"""Disposable synthetic tables; no carrier request or production access."""
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[3] / 'services/maritime/schedule-collector/tools/probe_oocl_pdf.py'
spec = importlib.util.spec_from_file_location('oocl_pdf', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def block():
    return [
        ['Vessel Name', 'SYNTHETIC VESSEL'] * 4,
        ['Vessel/Voyage', 'FIX/001'] * 4,
        ['Port', 'Arr--Dep'] * 4,
        ['Shanghai', '30--31 Dec'] * 4,
    ]


class PdfProbeTest(unittest.TestCase):
    def test_cross_page_year_boundary_and_no_reverse_or_out_of_window_routes(self):
        voyages = module.parse_tables([block(), [['Vancouver', '14--15 Jan'] * 4]], '2026-12-27')
        rows = module.match_routes(voyages, 'Shanghai', 'Vancouver', '2026-12-28', '2027-01-05')
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]['departure_date'], '2026-12-31')
        self.assertEqual(rows[0]['arrival_date'], '2027-01-14')
        self.assertEqual(rows[0]['departure_source_text'], '30--31 Dec')
        self.assertEqual(module.match_routes(voyages, 'Vancouver', 'Shanghai', '2026-12-28', '2027-01-31'), [])
        self.assertEqual(module.match_routes(voyages, 'Shanghai', 'Vancouver', '2027-01-01', '2027-01-31'), [])
        self.assertEqual(module.date_range('30--01 Jan', '2026-12-27'), ('2026-12-30', '2027-01-01'))

    def test_changed_layout_invalid_date_or_orphan_continuation_is_rejected(self):
        unnamed = block()
        unnamed[0][1] = ''
        for tables in [
            [unnamed],
            [[['Shanghai', '30--31 Dec'] * 4]],
            [block(), [['Vancouver', '30--31 Feb'] * 4]],
            [block(), [['Vancouver', 'unexpected'] * 4]],
            [block(), [['Vancouver', '14--15 Jan'] * 3]],
        ]:
            with self.assertRaises(ValueError):
                module.parse_tables(tables, '2026-12-27')
        with self.assertRaises(ValueError):
            module.check_freshness('2025-12-27', '2026-12-27')
        with self.assertRaises(ValueError):
            module.check_freshness('2026-12-29', '2026-12-27')
        with self.assertRaises(ValueError):
            module.read_pdf(b'%PDF-1.7\ncorrupt document', 'PNW2')


if __name__ == '__main__':
    unittest.main()
