import { extractJsonObject } from './json-extract';

describe('extractJsonObject', () => {
  it('从前后噪声里取出 JSON', () => {
    expect(extractJsonObject('思考...{"a":1}尾巴')).toEqual({ a: 1 });
  });
  it('忽略 <think> 块里的花括号', () => {
    expect(extractJsonObject('<think>草稿 {不算}</think>\n{"a":1}')).toEqual({ a: 1 });
  });
  it('去掉 markdown ```json 围栏', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('正文里夹带花括号时仍取出真正的 JSON 对象（取最长可解析者）', () => {
    // 模型先写了一段含 { } 的说明，再给真正的补丁 JSON
    const raw = '我会改这些 {如下} 项：\n{"note":"调ROE","gate_updates":[{"gate_key":"roe","threshold":12}]}';
    expect(extractJsonObject(raw)).toEqual({ note: '调ROE', gate_updates: [{ gate_key: 'roe', threshold: 12 }] });
  });
  it('容忍尾逗号', () => {
    expect(extractJsonObject('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });
  it('字符串内的花括号不破坏平衡', () => {
    expect(extractJsonObject('{"t":"含{花}括号的文本"}')).toEqual({ t: '含{花}括号的文本' });
  });
  it('没有 JSON 时返回 null', () => {
    expect(extractJsonObject('就是一段话，没有结构')).toBeNull();
  });
});
