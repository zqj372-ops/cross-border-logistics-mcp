import { expect,it,vi } from 'vitest';
import { createCustomsSearchTerms } from '../../services/customs-native/search-terms';

const config={apiKey:'fixture-secret',model:'fixture-model'};
const response=(content:unknown,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(content)}}]}));
it('only suggests bounded search words, never tariff data, and leaves numeric HS queries local',async()=>{
 const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(response({terms:[{language:'zh',text:'便携式 自动数据处理设备'},{language:'en',text:'portable automatic data processing machines'}]}));
 const suggest=createCustomsSearchTerms(config,fetchImpl);
 expect(await suggest('847130')).toBeNull();expect(fetchImpl).not.toHaveBeenCalled();
 expect((await suggest('笔记本电脑'))?.terms).toHaveLength(2);
 const [url,options]=fetchImpl.mock.calls[0]!;
 expect(url).toBe('https://api.deepseek.com/chat/completions');expect(options?.redirect).toBe('error');
 const body=JSON.parse(options?.body as string) as {messages:{content:string}[]};
 expect(JSON.parse(body.messages[1]!.content)).toEqual({commodity:'笔记本电脑'});
});
it('fails closed on malformed, incomplete, coded, oversized, or instruction-shaped suggestions',async()=>{
 for(const body of [response({terms:[{language:'zh',text:'847130 笔记本'}]}),response({terms:[{language:'zh',text:'商品',code:'847130'}]}),response({terms:[{language:'en',text:'<script>alert(1)</script>'}]}),response({terms:[]},'length'),response({terms:Array.from({length:7},()=>({language:'en',text:'goods'}))}),new Response('upstream error',{status:503})]){
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(body),suggest=createCustomsSearchTerms(config,fetchImpl);
  expect(await suggest('商品')).toBeNull();expect(await suggest('其他商品')).toBeNull();expect(fetchImpl).toHaveBeenCalledTimes(1);
 }
});
