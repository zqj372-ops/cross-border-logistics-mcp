import { describe, expect, it } from 'vitest';
import { buildInquiry, createDraft, escapeHtml, reconcileErrors, validateStep } from '../../apps/inquiry/model.js';

function shipment() {
  return Object.assign(createDraft(), {
    services: ['ocean', 'customs', 'delivery'], transportMode: 'fcl', origin: '上海', destination: '多伦多 M1V 0A1',
    product: '演示家具', containerType: '40HQ', containerCount: '2',
    contactName: '演示客户', email: 'demo@example.invalid', consent: true,
  });
}

describe('shipper inquiry: collect a request without inventing a quote or sending it', () => {
  it('requires an explicit service choice and rejects services from another flow', () => {
    expect(validateStep(createDraft(), 1).services).toBeTruthy();
    const draft = shipment();
    draft.services = ['company'];
    expect(validateStep(draft, 1).services).toBeTruthy();
  });
  it('accepts an FCL request without irrelevant LCL, SKU or pallet fields', () => {
    const draft = shipment();
    expect(validateStep(draft, 2)).toEqual({});
    const inquiry = buildInquiry(draft);
    expect(inquiry.body).toContain('40HQ × 2 柜');
    expect(inquiry.body).toContain('运费及服务费：待正式报价');
    expect(inquiry.body).not.toMatch(/0\.00|参考吨|SKU|CBM|已提交|已发送/);
    expect(inquiry.recipient).toBe('ops@freightclaw.net');
  });
  it('requires positive, plain decimal LCL evidence or an explicit pending marker', () => {
    const draft = shipment();
    draft.transportMode = 'lcl';
    expect(Object.keys(validateStep(draft, 2))).toEqual(['volume', 'weight']);
    for (const value of ['0', '-2', '1e3', 'Infinity', '1,000']) {
      draft.volume = value;
      expect(validateStep(draft, 2).volume).toBeTruthy();
    }
    draft.volume = '12.340'; draft.weight = '980.25';
    expect(validateStep(draft, 2)).toEqual({});
    expect(buildInquiry(draft).body).toContain('12.340 m³');
    draft.volumeUnknown = true; draft.weightUnknown = true;
    expect(validateStep(draft, 2)).toEqual({});
    expect(buildInquiry(draft).body).toContain('总体积：待确认');
    expect(buildInquiry(draft).body).not.toContain('980.25');
  });
  it('omits stale fields when the transport or selected services change', () => {
    const draft = shipment();
    draft.services = ['ocean']; draft.transportMode = 'lcl';
    draft.volume = '3'; draft.weight = '400'; draft.skuCount = '8'; draft.palletCount = '4';
    const body = buildInquiry(draft).body;
    expect(body).not.toMatch(/40HQ|SKU|托盘|自行订舱/);
    expect(body).toContain('未选择的环节');
  });
  it('does not require or include a China origin for Canada-only services', () => {
    const draft = shipment();
    draft.services = ['customs']; draft.origin = '';
    expect(validateStep(draft, 2)).toEqual({});
    draft.origin = '旧的中国地址';
    expect(buildInquiry(draft).body).not.toContain('旧的中国地址');
  });
  it('keeps company and compliance requests independent of cargo fields', () => {
    const draft = Object.assign(createDraft('business'), {
      services: ['company', 'compliance'], businessRegion: '安大略省', notes: '演示：咨询进口资质和产品备案',
      contactName: '演示客户', email: 'demo@example.invalid', consent: true,
      product: '不应带入的旧货物', containerCount: '2',
    });
    expect(validateStep(draft, 2)).toEqual({});
    expect(buildInquiry(draft).body).toContain('安大略省');
    expect(buildInquiry(draft).body).not.toMatch(/旧货物|柜数|运输方式/);
  });
  it('requires valid contact details and review before producing an export', () => {
    const draft = shipment(); draft.consent = false;
    expect(() => buildInquiry(draft)).toThrow();
    draft.consent = true; draft.email = 'person@example.invalid\r\nBcc: other@example.invalid';
    expect(validateStep(draft, 3).email).toBeTruthy();
    draft.email = 'demo@example.invalid'; draft.contactName = '张三\nSubject: injected';
    expect(validateStep(draft, 3).contactName).toBeTruthy();
  });
  it('encodes mail content without allowing recipient or header injection', () => {
    const draft = shipment(); draft.notes = '特殊说明 &bcc=other@example.invalid\n第二行 <script>alert(1)</script>';
    const inquiry = buildInquiry(draft); const url = new URL(inquiry.mailto!);
    expect(url.pathname).toBe('ops@freightclaw.net');
    expect([...url.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(url.searchParams.get('body')).toBe(inquiry.body);
    expect(escapeHtml('<img src=x onerror="alert(1)">&\'')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  });
  it('keeps the complete request for copying instead of truncating a long mail URI', () => {
    const draft = shipment(); draft.notes = '需要确认的资料'.repeat(500);
    const inquiry = buildInquiry(draft);
    expect(inquiry.body).toContain(draft.notes);
    expect(inquiry.mailto).toBeNull();
    expect(inquiry.copyText).toContain(inquiry.body);
  });
  it('allows unknown container data only when the customer explicitly marks it', () => {
    const draft = shipment(); draft.containerType = ''; draft.containerCount = '';
    expect(validateStep(draft, 2).containerType).toBeTruthy();
    expect(validateStep(draft, 2).containerCount).toBeTruthy();
    draft.containerType = 'unknown'; draft.containerCountUnknown = true;
    expect(validateStep(draft, 2)).toEqual({});
    expect(buildInquiry(draft).body).toContain('柜数：待确认');
  });
  it('clears obsolete errors after conditional changes without adding untouched field errors', () => {
    const draft = shipment(); draft.containerCount = '0'; draft.containerType = ''; draft.origin = '';
    const previous = validateStep(draft, 2);
    expect(Object.keys(previous)).toEqual(['origin', 'containerType', 'containerCount']);
    draft.containerCountUnknown = true;
    const pending = reconcileErrors(draft, 2, previous);
    expect(Object.keys(pending)).toEqual(['origin', 'containerType']);
    draft.transportMode = 'lcl';
    expect(reconcileErrors(draft, 2, pending)).toEqual({ origin: previous.origin });
    expect(reconcileErrors(draft, 2, {})).toEqual({});
  });
});
