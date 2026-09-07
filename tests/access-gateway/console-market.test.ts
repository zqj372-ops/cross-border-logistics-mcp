import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
type MarketService = { id: string; protocol: string };
let marketServices: MarketService[];
let filterMarketServices: (filters: { query?: string; protocol?: string; category?: string }) => MarketService[];
let agentInstallPrompt: (id?: string) => string;
beforeAll(async () => {
  const module = await import(pathToFileURL(resolve('apps/console/market.js')).href) as { marketServices: typeof marketServices; filterMarketServices: typeof filterMarketServices; agentInstallPrompt: typeof agentInstallPrompt };
  ({ marketServices, filterMarketServices, agentInstallPrompt } = module);
});

describe('public capability market', () => {
  it('keeps the actual MCP boundary separate from the five business API capabilities', () => {
    expect(marketServices.filter((item: { protocol: string }) => item.protocol === 'mcp').map((item: { id: string }) => item.id)).toEqual(['cargo.calculate', 'container.plan_summary', 'system.agent_context.get']);
    expect(marketServices.filter((item: { protocol: string }) => item.protocol === 'api')).toHaveLength(5);
    expect(marketServices.filter(item=>item.protocol==='workspace').map(item=>item.id)).toEqual(['quote.documents']);
    expect(new Set(marketServices.map((item: { id: string }) => item.id)).size).toBe(9);
  });
  it('combines Chinese search, protocol and business category filters', () => {
    expect(filterMarketServices({ query: '关税' }).map((item: { id: string }) => item.id)).toContain('customs.query');
    expect(filterMarketServices({ protocol: 'mcp', category: 'customs' })).toEqual([]);
    expect(filterMarketServices({ protocol: 'mcp' }).map(item => item.id)).toEqual(['cargo.calculate', 'container.plan_summary', 'system.agent_context.get']);
    expect(filterMarketServices({ protocol: 'api', category: 'customs' }).map(item => item.id)).toEqual(['customs.query', 'customs.tax.estimate']);
    expect(filterMarketServices({ query: '<script>missing</script>' })).toEqual([]);
    expect(filterMarketServices({ query: 'Cargo.Calculate' }).map((item: { id: string }) => item.id)).toEqual(['cargo.calculate']);
  });
  it('installs through a public guide without embedding a key or claiming all services are MCP tools', () => {
    expect(agentInstallPrompt()).toContain('https://www.freightclaw.net/console/skill.md');
    expect(agentInstallPrompt('customs.query')).toContain('customs.query');
    expect(agentInstallPrompt('unknown-service')).not.toContain('unknown-service');
    expect(agentInstallPrompt()).not.toMatch(/flcbk_|lmcpk_|Bearer /);
  });
});
