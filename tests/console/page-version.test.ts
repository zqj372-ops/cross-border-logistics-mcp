/* eslint-disable @typescript-eslint/no-unsafe-call -- Exercises a browser-only ESM helper. */
import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM helper.
import {assertCurrentPortalPage} from '../../apps/console/page-version.js';

afterEach(()=>vi.unstubAllGlobals());
const loaded='https://portal.example/console/app.js?v=1111111111111111';
const html=(version:string)=>`<script type="module" src="/console/app.js?v=${version}"></script>`;

it('checks the deployed page without cache and rejects an older loaded bundle before a query',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(html('2222222222222222')));vi.stubGlobal('fetch',fetch);
 await expect(assertCurrentPortalPage(loaded)).rejects.toMatchObject({code:'portal_page_updated'});
 expect(fetch).toHaveBeenCalledWith('/console/',expect.objectContaining({cache:'no-store',credentials:'same-origin'}));
 fetch.mockResolvedValue(new Response(html('1111111111111111')));
 await expect(assertCurrentPortalPage(loaded)).resolves.toBeUndefined();
});

it.each([new Response('upstream error',{status:502}),new Response('<html>login required</html>'),new Error('offline')])('does not submit through an unverified page version',async response=>{
 vi.stubGlobal('fetch',response instanceof Error?vi.fn().mockRejectedValue(response):vi.fn().mockResolvedValue(response));
 await expect(assertCurrentPortalPage(loaded)).rejects.toMatchObject({code:'portal_page_version_unavailable'});
});

it('keeps unversioned local development usable without a deployment check',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await assertCurrentPortalPage('http://127.0.0.1:8895/console/app.js');expect(fetch).not.toHaveBeenCalled();
});
