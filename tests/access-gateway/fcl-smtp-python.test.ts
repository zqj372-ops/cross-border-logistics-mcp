import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';

const exec=promisify(execFile);

it('treats partial recipient refusal as unknown without leaking message or credentials',async()=>{
  await expect(exec('/usr/bin/python3',[resolve('tests/access-gateway/fixtures/fcl-smtp-python-fixture.py'),resolve('services/access-gateway/portal/fcl_smtp_send.py')])).resolves.toMatchObject({stdout:'',stderr:''});
});
