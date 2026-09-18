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
async function render(response: unknown, detail = true) {
  vi.stubGlobal('FormData', class { constructor(readonly form: { values: Record<string, string> }) {} get(key: string) { return this.form.values[key] ?? ''; } });
  const api = vi.fn((path: string) => Promise.resolve(path.endsWith('/carriers') ? { data: { carriers: [{ id: 'ONE', capability_status: 'live_verified' }] } } : path.endsWith('/locations') ? { status: 'success', data: { resolved: { carrier_location_id: 'internal-location' } } } : response));
  const ui = createMaritimeWorkspace({ api, mutate: vi.fn(), esc: (v: string | number | null | undefined) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), head: () => '', note: (v: string) => `<p>${v}</p>`, icon: () => '', canConfigure: () => false, rerender: () => {}, model: () => ({ session: { authenticated: true, organization_id: 'org', identity: { user_id: 'user' } }, directory: { organizations: [{ organization_id: 'org', status: 'active' }], memberships: [{ organization_id: 'org', user_id: 'user', role: 'owner', status: 'active' }] } }) });
  await ui.submit({ dataset: { form: 'maritime-live-query' }, values });
  if(detail) await ui.action({dataset:{action:'maritime-open-voyages',serviceIndex:'0'}});
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
  it('selects services by actual departure weekdays and opens a full monthly detail page', async () => {
    const nextMonth = { ...record, legs: [{ ...record.legs[0], vessel_name: 'NOVEMBER VESSEL', events: [{ ...dateEvent('departure'), local_datetime: '2026-11-02T08:00:00' }] }] };
    const unknown = { ...record, service_name:'Unknown Service',legs: [{ ...record.legs[0], vessel_name: 'UNDATED VESSEL', events: [] }] };
    const { ui, html } = await render(result([record, nextMonth, unknown]),false);
    expect(html).toContain('航线周览');expect(html).toContain('直达服务详情');expect(html).toContain('计划开航日');
    expect(html).not.toContain('NOVEMBER VESSEL');expect(html).not.toContain('表定开航');
    vi.stubGlobal('document', { querySelector: () => null });
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '1' } });
    expect(ui.page('schedules')).not.toContain('Unknown Service');
    await ui.action({ dataset: { action: 'maritime-open-voyages', serviceIndex: '0' } });
    const detail=ui.page('schedules');
    expect(detail).toContain('2026 年 10 月船期公告');expect(detail).toContain('2026 年 11 月船期公告');
    expect(detail).toContain('NOVEMBER VESSEL');expect(detail).toContain('TEST VESSEL');expect(detail).not.toContain('UNDATED VESSEL');
    expect(detail).toContain('返回航线选择');expect(detail).toContain('操作时间');
    await ui.action({ dataset: { action: 'maritime-back-services' } });
    expect(ui.page('schedules')).toContain('直达服务详情');expect(ui.page('schedules')).not.toContain('NOVEMBER VESSEL');
  });
  it('keeps planned and actual departure distinct and includes the final inland leg destination', async () => {
    const oceanLeg = { ...record.legs[0], events: [dateEvent('departure'), { ...dateEvent('departure'), event_kind: 'actual', local_datetime: '2026-10-02T09:00:00' }, { ...dateEvent('arrival'), local_datetime: '2026-10-11T10:00:00' }] };
    const inlandLeg = { mode: 'rail', sequence: 2, from: { name: 'Vancouver' }, to: { name: 'Toronto' }, events: [{ ...dateEvent('arrival'), local_datetime: '2026-10-18T10:00:00' }] };
    const { html } = await render(result([{ ...record, routing: 'transshipment', legs: [oceanLeg, inlandLeg], transit: { source_total_hours: '241.5' } }]));
    expect(html).toContain('2026-10-01 08:00');
    expect(html).toContain('2026-10-02 09:00');
    expect(html).toContain('2026-10-18 10:00');
    expect(html).not.toContain('2026-10-11 10:00');
    expect(html).toContain('Toronto');
    expect(html).toContain('经 Vancouver');
    expect(html).toContain('10 天 1.5 小时');
    expect(html).not.toContain('internal-');
  });
  it('uses the ocean departure weekday rather than preceding road pickup or browser timezone', async () => {
    const roadLeg = { mode: 'truck', sequence: 1, from: { name: 'Depot' }, to: { name: 'Shanghai' }, events: [{ ...dateEvent('departure'), local_datetime: '2026-09-30T23:00:00' }] };
    const { ui } = await render(result([{ ...record, legs: [roadLeg, { ...record.legs[0], sequence: 2 }] }]),false);
    vi.stubGlobal('document', { querySelector: () => null });
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '4' } });
    expect(ui.page('schedules')).toContain('service-row');
    await ui.action({ dataset: { action: 'maritime-live-weekday', weekday: '3' } });
    expect(ui.page('schedules')).not.toContain('service-row');
  });
  it('classifies an ocean-direct sailing with onward rail as a destination transfer', async () => {
    const inlandLeg = { mode: 'rail', sequence: 2, from: { name: 'Vancouver' }, to: { name: 'Toronto' }, events: [dateEvent('arrival')] };
    const { html } = await render(result([{ ...record, routing: 'direct', legs: [...record.legs, inlandLeg] }]), false);
    expect(html).toContain('中转服务详情');
    expect(html).not.toContain('直达服务详情');
    expect(html).toContain('铁路');
  });
  it('withholds conflicting source identities even when the adapter supplied records', async () => {
    const response = result();
    const { html } = await render({ ...response, status: 'manual_review', data: { ...response.data,
      quality: { conflicts: ['internal-destination-mismatch'] } } });
    expect(html).toContain('船公司返回的地点与本次查询不一致');
    expect(html).not.toContain('TEST VESSEL');
    expect(html).not.toContain('2026-10-01 08:00');
    expect(html).not.toContain('internal-');
  });
  it('leaves final arrival blank when only the ocean ETA and cargo availability are known', async () => {
    const oceanLeg = { ...record.legs[0], events: [dateEvent('departure'),
      { ...dateEvent('arrival'), local_datetime: '2026-10-11T10:00:00' }] };
    const inlandLeg = { mode: 'unknown', sequence: 2, from: { name: 'Vancouver' }, to: { name: 'Toronto' }, events: [] };
    const { html } = await render(result([{ ...record, routing: 'unknown',
      cargo_available_at: '2026-10-19T12:00:00', legs: [oceanLeg, inlandLeg] }]));
    expect(html).toContain('到达时间未提供');
    expect(html).not.toContain('2026-10-11 10:00');
    expect(html).not.toContain('2026-10-19 12:00');
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
