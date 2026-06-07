import path from 'path'; import os from 'os'; import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-newslog-'));
const nl = require('./news-log');

it('recordCollected 写内容(去重)+标题事件(追加)；listTitleLog/getContent', () => {
  const a = nl.recordCollected([{ title: 'A股大涨', content: '正文AAA', source: 'em', published_at: '2026-06-07 09:00' }]);
  expect(a).toHaveLength(1);
  const id = a[0].content_id;
  nl.recordCollected([{ title: 'A股大涨', content: '正文AAA', source: 'em', published_at: '2026-06-07 09:00' }]);
  const db = require('../db').getDb();
  expect((db.prepare('SELECT COUNT(*) c FROM news_content_log').get() as any).c).toBe(1);
  expect((db.prepare('SELECT COUNT(*) c FROM news_title_log').get() as any).c).toBe(2);
  expect(nl.getContent(id).content).toBe('正文AAA');
  const log = nl.listTitleLog(10);
  expect(log[0].title).toBe('A股大涨'); expect(log[0].adopted).toBe(0);
});
it('markAdopted 标记采用', () => {
  const [{ content_id }] = nl.recordCollected([{ title: '龙头表现', content: 'x', source: 'em', published_at: '2026-06-07 10:00' }]);
  nl.markAdopted([content_id]);
  expect(nl.getContent(content_id).adopted).toBe(1);
});
it('purgeOldLogs 按规则清理', () => {
  const db = require('../db').getDb();
  db.prepare("INSERT INTO news_title_log (id,content_id,title,collected_at) VALUES ('old1',null,'旧标题', datetime('now','-400 days'))").run();
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_old_un','未采用','x',0, datetime('now','-10 days'))").run();
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_old_ad','采用过','x',1, datetime('now','-100 days'))").run();
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_fresh','新鲜','x',0, datetime('now','-2 days'))").run();
  nl.purgeOldLogs();
  expect(db.prepare("SELECT 1 FROM news_title_log WHERE id='old1'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_old_un'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_old_ad'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_fresh'").get()).toBeTruthy();
});
