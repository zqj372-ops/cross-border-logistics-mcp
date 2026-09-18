import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type Workspace = { page(kind: string): string; submit(form: unknown): Promise<boolean>; input(event: unknown): boolean; action(button: unknown): Promise<boolean> };
const { createMaritimeWorkspace } = await import(pathToFileURL(resolve('apps/console/maritime.js')).href) as {
  createMaritimeWorkspace: (options: Record<string, unknown>) => Workspace;
};
const dateEvent = (type: string) => ({ event_type: type, event_kind: 'estimated', local_datetime: '2026-10-01T08:00:00', timezone: null, precision: 'local_datetime', raw_text: 'internal-raw-time' });
const record = {
  record_id: 'internal-record', evidence_ref: 'internal-evidence', parser_version: 'internal-parser',
  operating_carrier: null, service_name: 'Pacific Express', routing: 'direct',
  pol: { name: 'Shanghai' }, pod: { name: 'Vancouver' }, query_origin: 'internal-origin', query_destination: 'internal-destination',
  transit: { source_total_hours: '240', basis: 'internal-basis' }, cutoffs: { si: { at: '2026-09-30T16:00:00+08:00' } }, missing_fields: [{ field: 'internal-field' }],
  legs: [{ mode: 'ocean', sequence: 1, vessel_name: 'TEST VESSEL', voyage: '101E', from: { name: 'Shanghai' }, to: { name: 'Vancouver' }, events: [dateEvent('departure'), dateEvent('arrival')] }],
};
const result = (records: unknown[] = [record], complete = true) => ({
  status: complete ? 'success' : 'manual_review',
  blockers: [], warnings: [{ code: 'internal-warning', message: 'internal-message' }],
  data: { records, carrier: { id: 'ONE', sales_carrier: 'Ocean Network Express', capability_status: 'live_verified' },
    coverage: { complete, requested_from: '2026-10-01', requested_until: '2026-10-28', uncovered_windows: complete ? [] : [{ from: '2026-10-15', until: '2026-10-28' }] },
    provenance: { parser_version: 'internal-parser', source_refs: ['internal-evidence'], kind: 'internal-source' } },
});
const values = { carrier: 'ONE', origin: 'Shanghai', origin_country: 'CN', destination: 'Vancouver', destination_country: 'CA', from: '2026-10-01', until: '2026-10-28', routing: 'any' };
async function render(response: unknown) {
  vi.stubGlobal('FormData', class { constructor(readonly form: { values: Record<string, string> }) {} get(key: string) { return this.form.values[key] ?? ''; } });
  const api = vi.fn((path: string) => Promise.resolve(path.endsWith('/carriers') ? { data: { carriers: [{ id: 'ONE', capability_status: 'live_verified' }] } } : path.endsWith('/locations') ? { status: 'success', data: { resolved: { carrier_location_id: 'internal-location' } } } : response));
  const ui = createMaritimeWorkspace({ api, mutate: vi.fn(), esc: (v: string | number | null | undefined) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), head: () => '', note: (v: string) => `<p>${v}</p>`, icon: () => '', canConfigure: () => false, rerender: () => {}, model: () => ({ session: { authenticated: true, organization_id: 'org', identity: { user_id: 'user' } }, directory: { organizations: [{ organization_id: 'org', status: 'active' }], memberships: [{ organization_id: 'org', user_id: 'user', role: 'owner', status: 'active' }] } }) });
  await ui.submit({ dataset: { form: 'maritime-live-query' }, values });
  return { ui, html: ui.page('schedules') };
}
afterEach(() => vi.unstubAllGlobals());
describe('customer schedule presentation', () => {
  it('shows voyage business fields without rendering internal metadata or raw warnings', async () => {
    const { html } = await render(result());
    expect(html).toContain('TEST VESSEL');
    expect(html).toContain('航次 101E');
    expect(html).toContain('Shanghai');
    expect(html).toContain('2026-10-01 08:00');
    expect(html).toContain('来源未提供时区');
    expect(html).toContain('10 天');
    expect(html).toContain('2026-09-30 16:00 UTC+08:00');
    expect(html).toContain('voyage-header');
    expect(html).not.toMatch(/internal-|live_verified|parser|证据引用|local_datetime|原文|实际承运船司：ONE/u);
  });
  it('keeps partial coverage distinct from a confirmed empty result', async () => {
    const partial = await render(result([], false));
    expect(partial.html).toContain('暂未取得完整船期');
    expect(partial.html).toContain('2026-10-15—2026-10-28');
    expect(partial.html).not.toContain('未找到匹配航次');
    const complete = await render(result([]));
    expect(complete.html).toContain('未找到匹配航次');
  });
  it('does not present an arrival event as departure when departure is absent', async () => {
    const missing = { ...record, legs: [{ ...record.legs[0], events: [dateEvent('arrival')] }] };
    const { html } = await render(result([missing]));
    expect(html).toContain('离港时间未提供');
  });
  it('hides adapter diagnostics on an unavailable result', async () => {
    const { html } = await render({ status: 'unavailable', data: null, blockers: [{ code: 'internal-provider', message: 'internal-error' }] });
    expect(html).toContain('稍后重试');
    expect(html).not.toContain('internal-');
  });
  it('groups actual returned sailings by month and weekday without assuming a recurring weekly service', async () => {
    const nextMonth = { ...record, legs: [{ ...record.legs[0], vessel_name: 'NOVEMBER VESSEL', events: [{ ...dateEvent('departure'), local_datetime: '2026-11-02T08:00:00' }] }] };
    const unknown = { ...record, legs: [{ ...record.legs[0], vessel_name: 'UNDATED VESSEL', events: [] }] };
    const { ui, html } = await render(result([record, nextMonth, unknown]));
    expect(html).toContain('2026 年 10 月');
    expect(html).toContain('2026 年 11 月');
    expect(html).toContain('开航日期待确认');
    expect(html).toContain('data-weekday="4"');
    vi.stubGlobal('document', { querySelector: () => null });
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '1' } });
    const filtered = ui.page('schedules');
    expect(filtered).toContain('NOVEMBER VESSEL');
    expect(filtered).not.toContain('TEST VESSEL');
    expect(filtered).not.toContain('UNDATED VESSEL');
    expect(filtered).toContain('共 3 条航次');
  });
  it('keeps planned and actual departure distinct and includes the final inland leg destination', async () => {
    const oceanLeg = { ...record.legs[0], events: [dateEvent('departure'), { ...dateEvent('departure'), event_kind: 'actual', local_datetime: '2026-10-02T09:00:00' }, dateEvent('arrival')] };
    const inlandLeg = { mode: 'rail', sequence: 2, from: { name: 'Vancouver' }, to: { name: 'Toronto' }, events: [{ ...dateEvent('arrival'), local_datetime: '2026-10-18T10:00:00' }] };
    const { html } = await render(result([{ ...record, routing: 'transshipment', legs: [oceanLeg, inlandLeg], transit: { source_total_hours: '241.5' } }]));
    expect(html).toContain('2026-10-01 08:00');
    expect(html).toContain('2026-10-02 09:00');
    expect(html).toContain('2026-10-18 10:00');
    expect(html).toContain('Toronto');
    expect(html).toContain('经 Vancouver');
    expect(html).toContain('10 天 1.5 小时');
    expect(html).not.toContain('internal-');
  });
  it('uses the ocean departure weekday rather than preceding road pickup or browser timezone', async () => {
    const roadLeg = { mode: 'truck', sequence: 1, from: { name: 'Depot' }, to: { name: 'Shanghai' }, events: [{ ...dateEvent('departure'), local_datetime: '2026-09-30T23:00:00' }] };
    const { ui } = await render(result([{ ...record, legs: [roadLeg, { ...record.legs[0], sequence: 2 }] }]));
    vi.stubGlobal('document', { querySelector: () => null });
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '4' } });
    expect(ui.page('schedules')).toContain('TEST VESSEL');
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '3' } });
    expect(ui.page('schedules')).not.toContain('TEST VESSEL');
  });
  it('removes stale rendered results and selected candidate controls when the carrier changes', async () => {
    const { ui } = await render(result());
    const region = { innerHTML: 'TEST VESSEL' };
    const origin = { remove: vi.fn() }, destination = { remove: vi.fn() }, submit = { innerHTML: '查询中' };
    const form = { values: { ...values, carrier: 'COSCO' }, querySelector: (s: string) => s.includes('origin') ? origin : s.includes('destination') ? destination : submit };
    vi.stubGlobal('document', { querySelector: () => region });
    ui.input({ target: { name: 'carrier', closest: () => form } });
    expect(region.innerHTML).not.toContain('TEST VESSEL');
    expect(region.innerHTML).toContain('重新查询');
    expect(origin.remove).toHaveBeenCalledOnce();
    expect(destination.remove).toHaveBeenCalledOnce();
    expect(submit.innerHTML).toContain('查询船期');
  });
});
