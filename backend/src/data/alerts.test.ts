import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-alerts-'));

const { getDb } = require('../db');
const { getDataAlerts } = require('./alerts');

// NOW=2026-06-11(周四) → 上一交易日(无日历兜底)=2026-06-10(周三)
const NOW = '2026-06-11';
const PREV = '2026-06-10';

beforeEach(() => {
  getDb().exec('DELETE FROM sync_status; DELETE FROM cron_status; DELETE FROM market_sentiment;');
});

function setMarket(date: string) {
  getDb().prepare("INSERT INTO market_sentiment (date, source) VALUES (?, 'test')").run(date);
}
function setSync(job: string, fields: Record<string, any>) {
  const cols = Object.keys(fields);
  getDb()
    .prepare(`INSERT INTO sync_status (job, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`)
    .run(job, ...cols.map((c) => fields[c]));
}
function setCron(key: string, fields: Record<string, any>) {
  const cols = Object.keys(fields);
  getDb()
    .prepare(`INSERT INTO cron_status (key, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`)
    .run(key, ...cols.map((c) => fields[c]));
}

describe('getDataAlerts', () => {
  it('全部正常时无告警', () => {
    setMarket(PREV);
    setSync('eod', { state: 'done', last_success_at: `${PREV} 02:00:00` });
    setSync('stock_universe', { state: 'done', last_success_at: `${PREV} 02:00:00` });
    setCron('nightly', { last_status: 'ok', last_run_at: `${PREV} 23:00:00` });
    expect(getDataAlerts('ok', NOW)).toEqual([]);
  });

  it('sync_status error → error 告警(含 since=finished_at)', () => {
    setMarket(PREV);
    setSync('eod', { state: 'error', error: '取数失败', finished_at: `${PREV} 01:30:00` });
    const a = getDataAlerts('ok', NOW);
    const eod = a.find((x: any) => x.source === 'eod');
    expect(eod).toMatchObject({ level: 'error', since: `${PREV} 01:30:00` });
    expect(eod.message).toContain('取数失败');
  });

  it('sync_status 成功但陈旧 → warn 告警', () => {
    setMarket(PREV);
    setSync('stock_universe', { state: 'done', last_success_at: '2026-06-05 02:00:00' });
    const a = getDataAlerts('ok', NOW);
    expect(a.find((x: any) => x.source === 'stock_universe')).toMatchObject({ level: 'warn' });
  });

  it('cron nightly 失败 → error 告警', () => {
    setMarket(PREV);
    setCron('nightly', { last_status: 'error', last_error: '夜间任务崩了', last_run_at: `${PREV} 23:05:00` });
    const a = getDataAlerts('ok', NOW);
    expect(a.find((x: any) => x.source === 'cron:nightly')).toMatchObject({ level: 'error', since: `${PREV} 23:05:00` });
  });

  it('大盘数据陈旧 / 缺失 → warn 告警', () => {
    setMarket('2026-06-05');
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'market')).toMatchObject({ level: 'warn', since: '2026-06-05' });
    getDb().exec('DELETE FROM market_sentiment;');
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'market')).toMatchObject({ level: 'warn' });
  });

  it('sidecar 不可达 → error；未配置 → warn', () => {
    setMarket(PREV);
    expect(getDataAlerts('down', NOW).find((x: any) => x.source === 'sidecar')).toMatchObject({ level: 'error' });
    expect(getDataAlerts('unconfigured', NOW).find((x: any) => x.source === 'sidecar')).toMatchObject({ level: 'warn' });
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'sidecar')).toBeUndefined();
  });
});
