#!/usr/bin/env python3
"""Rebuild a CBSA T2026-2 candidate from a hash-verified official archive.
This offline CLI never publishes, approves, or changes an existing database.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'services/customs-native'))
from data_pipeline.cbsa import normalize_cbsa_directory
from data_pipeline.cbsa_review import load_chapters, audit_candidate


def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while chunk:=f.read(1024*1024): h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def prepare(archive, sha256, language, output, retrieved_at, chapters_directory=None):
    archive, output=Path(archive).resolve(), Path(output).absolute()
    if output.exists(): raise ValueError('output_must_be_new')
    fetched=datetime.fromisoformat(retrieved_at.replace('Z','+00:00'))
    if fetched.tzinfo is None or fetched>datetime.now(timezone.utc):raise ValueError('invalid_retrieval_time')
    config=ROOT/f'services/customs-native/data_pipeline/config/cbsa-2026-t2026-2-{language}.json'
    if sha256!=json.loads(config.read_text())['archiveSha256']:raise ValueError('archive_not_bound_to_supported_edition')
    if digest(archive)!=sha256: raise ValueError('archive_hash_mismatch')
    chapters=load_chapters(chapters_directory) if chapters_directory else None
    language_file='eng' if language=='en' else 'fra'
    release_id=f'ca-cbsa-customs-tariff-2026-t2026-2-{language}'
    url=f'https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/2026/01-99/01-99-2026-2-{language_file}.zip'
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cbsa-',dir=output.parent) as work:
        d=Path(work)/'release';d.mkdir(mode=0o700)
        sources=d/'sources';sources.mkdir()
        original=sources/'source.zip';shutil.copyfile(archive,original)
        if digest(original)!=sha256: raise ValueError('archive_changed_during_copy')
        with zipfile.ZipFile(original) as z:
            entries=[x for x in z.infolist() if not x.is_dir()]
            if len(entries)!=1 or not entries[0].filename.lower().endswith('.accdb') or entries[0].file_size>128*1024*1024:
                raise ValueError('unexpected_cadex_archive')
            database=sources/'source.accdb'
            with z.open(entries[0]) as f,database.open('wb') as target:shutil.copyfileobj(f,target)
        exports=d/'exports';exports.mkdir()
        tables=subprocess.check_output(['mdb-tables','-1',str(database)],text=True,timeout=30).splitlines()
        if not tables or len(tables)!=len(set(tables)):raise ValueError('invalid_cadex_table_inventory')
        records=[]
        for table in tables:
            # Only safe, unique basenames are ever written; no shell is involved.
            name=table.lower()
            if not name.isascii() or not name.replace('_','').isalnum():raise ValueError('unsafe_cadex_table_name')
            raw=subprocess.check_output(['mdb-export',str(database),table],timeout=60)
            path=exports/(name+'.csv')
            if path.exists():raise ValueError('duplicate_cadex_filename')
            path.write_bytes(raw)
            reader=csv.reader(io.StringIO(raw.decode('utf-8-sig')));columns=next(reader);count=sum(1 for _ in reader)
            records.append({'table':table,'file':path.name,'columns':columns,'rowCount':count,'csvSha256':digest(path)})
        write_json(exports/'export-report.json',{'archiveSha256':sha256,'databaseSha256':digest(database),'tables':records})
        result=normalize_cbsa_directory(exports,output_dir=d,config_path=config,release_id=release_id,artifact_id='cadex-zip',effective_from='2026-09-01',source_locator_prefix=url,language=language,include_tariff_rules=language=='en')
        manifest={'schemaVersion':'1.0.0','releaseId':release_id,'country':'CA','authority':'CBSA','dataset':'customs_tariff','edition':'2026','revision':'T2026-2','language':[language],'officialUrl':url,'publishedAt':'2026-09-01T00:00:00Z','effectiveFrom':'2026-09-01','effectiveTo':None,'retrievedAt':fetched.isoformat().replace('+00:00','Z'),'supersedesReleaseId':None,'artifacts':[{'artifactId':'cadex-zip','path':'sources/source.zip','bytes':original.stat().st_size,'sha256':sha256,'mediaType':'application/zip','etag':None,'lastModified':None}],'parser':{'name':'freightclaw-cbsa-cadex','version':'1.2.0'},'status':'candidate'}
        source_audit=None
        if chapters is not None:
            for entry in chapters.values():
                target=sources/entry['filename'];shutil.copyfile(Path(chapters_directory)/entry['filename'],target)
                if digest(target)!=entry['receipt']['sha256']:raise ValueError('chapter_changed_during_copy')
                manifest['artifacts'].append({'artifactId':target.stem,'path':'sources/'+target.name,'bytes':target.stat().st_size,'sha256':entry['receipt']['sha256'],'mediaType':'text/html','etag':None,'lastModified':None})
            write_json(sources/'chapter-fetch-report.json',[entry['receipt'] for entry in chapters.values()])
            source_audit=audit_candidate(result,chapters,language)
            write_json(d/'source-audit.json',source_audit)
            quality=json.loads((d/'quality-report.json').read_text())
            quality['checks'].append({'name':'official_chapter_cross_check','value':source_audit['status'],'scope':source_audit['scope'],'count':source_audit['checked_codes']})
            if source_audit['status']!='pass':
                result['status']='review';quality['status']='review'
                quality['reasons'].append({'reason':'official_chapter_review_required','report':'source-audit.json','count':len(source_audit['issues'])})
            write_json(d/'quality-report.json',quality)
        write_json(d/'release.json',manifest)
        summary={'releaseId':release_id,'status':result['status'],'sourceRows':result['source_row_count'],'nomenclatureRows':len(result['nomenclature']),'tariffRuleRows':len(result['tariff_rules']),'auditedOmissions':len(result['omissions']),'blockers':result['exclusions'],'sourceSha256':sha256,'normalizedSha256':{p.name:digest(p) for p in d.glob('*.jsonl')},'publicationStatus':'candidate','approvalGranted':False}
        if source_audit is not None:summary['chapterReview']={k:source_audit[k] for k in ['scope','chapter_count','checked_codes','matched_simple_mfn','status']}
        write_json(d/'normalization-report.json',summary)
        # Refuse overwrite at publication of the local candidate directory.
        if output.exists():raise ValueError('output_must_be_new')
        output.mkdir(mode=0o700)
        try:
            # Source manifest is moved last, so interrupted preparation is never a complete candidate.
            for item in sorted(d.iterdir(),key=lambda p:p.name=='release.json'):shutil.move(str(item),output/item.name)
        except BaseException:
            shutil.rmtree(output)
            raise
    return summary


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--archive',required=True)
    p.add_argument('--sha256',required=True)
    p.add_argument('--language',choices=['en','fr'],required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--retrieved-at',required=True,help='Actual official archive retrieval time in ISO 8601 with timezone')
    p.add_argument('--chapters-directory',help='Optional official T2026-2 HTML files with chapter-fetch-report.json; differences remain review items')
    a=p.parse_args()
    try:
        result=prepare(a.archive,a.sha256,a.language,a.output,a.retrieved_at,a.chapters_directory)
        print(json.dumps(result,ensure_ascii=False))
        sys.exit(0 if result['status']=='pass' else 2)
    except (ValueError,OSError,subprocess.SubprocessError,zipfile.BadZipFile) as e:
        print(json.dumps({'status':'blocked','reason':str(e)},ensure_ascii=False));sys.exit(2)
