import { describe, expect, it } from 'vitest';
import { fclLabel, fclValue, fclEventMessage, displayMargin, fclIssue } from '../../apps/inquiry/fcl-presentation';

describe('FCL business-facing presentation', () => {
  it('labels known states without inventing success for an unknown state', () => {
    expect(fclLabel('handed_off')).toBe('已交接');
    expect(fclLabel('needs_input')).toBe('待补充');
    expect(fclLabel('unexpected_state')).toBe('待核对');
  });
  it('formats the saved decimal ratio without calculating or defaulting missing profit', () => {
    expect(displayMargin('0.085714')).toBe('8.57%');
    expect(displayMargin('-0.125')).toBe('-12.50%');
    expect(displayMargin('0')).toBe('0.00%');
    expect(displayMargin(null)).toBe('—');
  });
  it('keeps unknown and zero quantities distinct in supplement comparisons', () => {
    expect(fclValue('containers', [{ type: '40HQ', quantity: null }])).toBe('40HQ × 待确认');
    expect(fclValue('containers', [{ type: '40HQ', quantity: 0 }])).toBe('40HQ × 0');
    expect(fclValue('selected_services', ['ocean_freight', 'delivery'])).toBe('海运干线、加拿大派送');
  });
  it('translates only known system messages and preserves authored notes', () => {
    expect(fclEventMessage('FCL inquiry submitted by anonymous customer.')).toBe('客户已提交整柜询价。');
    expect(fclEventMessage('客户要求 10 月 8 日提货')).toBe('客户要求 10 月 8 日提货');
  });
  it('identifies incomplete quote fields and retains unknown diagnostics', () => {
    expect(fclIssue('/cost_rows/0/sell_price')).toBe('第 1 项费用：请填写客户单价');
    expect(fclIssue('/exchange_rates/CAD')).toBe('请填写 CAD 对人民币的汇率');
    expect(fclIssue('fcl_rate_selection_required')).toContain('多个运价');
    expect(fclIssue('unrecognized_diagnostic')).toBe('unrecognized_diagnostic');
  });
});
