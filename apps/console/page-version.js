export async function assertCurrentPortalPage(assetUrl) {
  const loaded = new URL(assetUrl).searchParams.get('v');
  if (!loaded) return; // Source modules in local development are not a published bundle.
  let current;
  try {
    const response = await fetch('/console/', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('page_unavailable');
    current = (await response.text()).match(/<script\b[^>]*\bsrc="\/console\/app\.js\?v=([a-f0-9]{16})"/u)?.[1];
    if (!current) throw new Error('page_version_missing');
  } catch {
    throw Object.assign(new Error('portal_page_version_unavailable'), { code: 'portal_page_version_unavailable' });
  }
  if (current !== loaded) throw Object.assign(new Error('portal_page_updated'), { code: 'portal_page_updated' });
}
