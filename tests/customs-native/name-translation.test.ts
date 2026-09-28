import { expect, it, vi } from 'vitest';
import { createCustomsNameTranslator } from '../../services/customs-native/name-translation';

const names = [{language:'en',text:'Synthetic containers — Other'},{language:'zh-CN',text:'合成容器'}];
const response = (translations:unknown) => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations})}}]}));
it('pairs translations with exact source text, deduplicates names and caches repeated queries',async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(response([{id:0,text:'合成容器 — 其他'},{id:1,text:'Synthetic containers'}]));
  const translate=createCustomsNameTranslator({apiKey:'fixture-secret',model:'fixture-model'},fetchImpl);
  const [result]=await Promise.all([translate([...names,names[0]!]),translate(names)]);
  expect(result).toEqual([{language:'zh',text:'合成容器 — 其他',status:'machine',model:'fixture-model'},{language:'en',text:'Synthetic containers',status:'machine',model:'fixture-model'},{language:'zh',text:'合成容器 — 其他',status:'machine',model:'fixture-model'}]);
  await translate(names);expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url,options]=fetchImpl.mock.calls[0]!;
  expect(url).toBe('https://api.deepseek.com/chat/completions');expect(options?.redirect).toBe('error');expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options?.body as string)).toMatchObject({max_tokens:4096,response_format:{type:'json_object'},messages:[{role:'system'},{role:'user',content:JSON.stringify({items:[{id:0,text:names[0]!.text,target_language:'zh'},{id:1,text:names[1]!.text,target_language:'en'}]})}]});
});
it('rejects malformed, duplicated or unsolicited translations and never retries a failed batch automatically',async()=>{
  for(const rows of [[{id:0,text:'Not translated'}],[{id:0,text:'合成品'},{id:0,text:'重复品'}],[{id:9,text:'未知品'}],[{id:0,text:'合成品',rate:'0%'}]]){
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(response(rows));
    const translate=createCustomsNameTranslator({apiKey:'fixture-secret',model:'fixture-model'},fetchImpl);
    expect(await translate([names[0]!])).toEqual([null]);expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
  const fetchImpl=vi.fn<typeof fetch>().mockRejectedValue(new Error('private upstream error'));
  expect(await createCustomsNameTranslator({apiKey:'fixture-secret',model:'fixture-model'},fetchImpl)(names)).toEqual([null,null]);
});
