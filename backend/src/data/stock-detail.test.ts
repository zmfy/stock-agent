import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sd-'));
const svc = require('./service');

describe('涨停跌停限制', () => {
  it('主板 10%、ST 5%、创业/科创 20%、北交所 30%', () => {
    expect(svc.limitPctFor('600519', '贵州茅台')).toBeCloseTo(0.10);
    expect(svc.limitPctFor('000001', '平安银行')).toBeCloseTo(0.10);
    expect(svc.limitPctFor('600519', 'ST茅台')).toBeCloseTo(0.05);
    expect(svc.limitPctFor('300750', '宁德时代')).toBeCloseTo(0.20);
    expect(svc.limitPctFor('688981', '中芯国际')).toBeCloseTo(0.20);
    expect(svc.limitPctFor('830799', '某北交所')).toBeCloseTo(0.30);
  });
  it('computeLimitPrices 四舍五入到分；prevClose 为空→null', () => {
    expect(svc.computeLimitPrices(100, '600000', '浦发银行')).toEqual({ up: 110, down: 90 });
    expect(svc.computeLimitPrices(null, '600000', 'x')).toEqual({ up: null, down: null });
  });
});

describe('量比 / 已开盘分钟', () => {
  it('elapsedTradingMinutes：10:00→30、12:00→120、收盘后→240', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 5, 12, h - 8, m); // 北京 h:m → UTC
    expect(svc.elapsedTradingMinutes(at(10, 0))).toBe(30);
    expect(svc.elapsedTradingMinutes(at(12, 0))).toBe(120);
    expect(svc.elapsedTradingMinutes(at(15, 30))).toBe(240);
    expect(svc.elapsedTradingMinutes(at(9, 0))).toBe(0);
  });
  it('computeVolumeRatio：正常算、缺失→null', () => {
    expect(svc.computeVolumeRatio(1000, 30, 8000)).toBeCloseTo(1.0, 1);
    expect(svc.computeVolumeRatio(null, 30, 8000)).toBeNull();
    expect(svc.computeVolumeRatio(1000, 0, 8000)).toBeNull();
    expect(svc.computeVolumeRatio(1000, 30, 0)).toBeNull();
  });
});

describe('relatedNews', () => {
  const { recordCollected } = require('./news-log');
  it('只返回直接相关(命中股名/行业)的新闻，关系不大的不显示', () => {
    recordCollected([
      { title: '贵州茅台发布年度分红方案', source: 't' },
      { title: '某科技公司财报', source: 't' },
      { title: '白酒板块今日走强', source: 't' },
      { title: '大盘震荡收跌', source: 't' },
    ]);
    const out = svc.relatedNews('600519', '贵州茅台', '白酒', 8);
    // 仅 2 条命中(贵州茅台 / 白酒)；某科技、大盘 等不相关的被排除
    expect(out.length).toBe(2);
    expect(out.every((n: any) => n.related === true)).toBe(true);
    expect(out.every((n: any) => typeof n.contentId === 'string' && n.title)).toBe(true);
    const moutai = out.find((n: any) => n.title.includes('贵州茅台'));
    expect(moutai && moutai.reason).toContain('提及');
    const baijiu = out.find((n: any) => n.title.includes('白酒板块'));
    expect(baijiu && baijiu.reason).toContain('同行业');
    expect(out.some((n: any) => n.title.includes('大盘震荡') || n.title.includes('某科技'))).toBe(false);
  });
  it('行业为 F10 层级串(食品饮料-白酒Ⅱ-白酒Ⅲ)时也能按「白酒」命中', () => {
    recordCollected([{ title: '白酒消费回暖', source: 't' }]);
    const out = svc.relatedNews('600519', '贵州茅台', '食品饮料-白酒Ⅱ-白酒Ⅲ', 8);
    const hit = out.find((n: any) => n.title.includes('白酒消费'));
    expect(hit && hit.related).toBe(true);
    expect(hit && hit.reason).toContain('白酒');
  });
});
