import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';

const exec=promisify(execFile);

it('treats any refused SMTP recipient as sanitized failure and keeps acceptance fixed',async()=>{
  await expect(exec('/usr/bin/python3',[resolve('tests/access-gateway/fixtures/fcl-smtp-python-fixture.py'),resolve('services/access-gateway/portal/fcl_smtp_send.py')])).resolves.toMatchObject({stdout:'',stderr:''});
});
