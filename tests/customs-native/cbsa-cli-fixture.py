"""Exercise offline candidate preparation with a wholly synthetic mdb export."""
from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import tempfile
from unittest.mock import patch
import zipfile

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('prepare_cbsa',ROOT/'deploy/scripts/prepare-cbsa-release.py')
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
with tempfile.TemporaryDirectory() as work:
    root=Path(work);archive=root/'synthetic.zip'
    with zipfile.ZipFile(archive,'w') as z:z.writestr('synthetic.accdb',b'synthetic test data, never a real Access database')
    checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
    config=root/'services/customs-native/data_pipeline/config';config.mkdir(parents=True)
    (config/'cbsa-2026-t2026-2-en.json').write_text(json.dumps({'archiveSha256':checksum,'businessTables':[{'file':'tariff.csv','columns':{'code':'code','description':'name'},'treatments':[{'name':'MFN','column':'rate','priority':10}]}]}))
    def fake_export(args,**kwargs):
        return 'TARIFF\n' if args[0]=='mdb-tables' else b'code,name,rate\n12345678,Synthetic goods,5%\n'
    def prepare(output,expected_hash=checksum,time='2026-09-01T00:00:00Z'):
        return cli.prepare(archive,expected_hash,'en',output,time)
    with patch.object(cli,'ROOT',root),patch.object(cli.subprocess,'check_output',side_effect=fake_export):
        output=root/'candidate';result=prepare(output)
        assert result['approvalGranted'] is False and result['publicationStatus']=='candidate'
        for action in [lambda:prepare(output),lambda:prepare(root/'wrong-hash','0'*64),lambda:prepare(root/'future',time='9999-01-01T00:00:00Z')]:
            try:action()
            except ValueError:pass
            else:raise AssertionError('unsafe preparation was accepted')
        assert not (root/'wrong-hash').exists() and not (root/'future').exists()
        print(json.dumps({'release':json.loads((output/'release.json').read_text()),'quality':json.loads((output/'quality-report.json').read_text()),'nomenclature':[json.loads(x) for x in (output/'nomenclature.jsonl').read_text().splitlines()],'tariffs':[json.loads(x) for x in (output/'tariff_rules.jsonl').read_text().splitlines()]}))
