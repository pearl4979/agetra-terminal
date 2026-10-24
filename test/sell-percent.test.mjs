import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 运行页面实际使用的纯金额函数，测试高精度余额，避免浮点数误卖。
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const helpers = app.slice(app.indexOf('  function formatUnitsExact('), app.indexOf('  function tokenAvatar('));
const { positionPercent } = vm.runInNewContext(`${helpers}; ({ positionPercent });`);
const balance = '12345678901234567890123';

test('四个卖出快捷比例精确换算，不丢失18位持仓精度', () => {
  for (const [percent, amount] of [
    ['10', '1234.567890123456789012'], ['25', '3086.41972530864197253'],
    ['50', '6172.839450617283945061'], ['100', '12345.678901234567890123'],
  ]) assert.equal(positionPercent(balance, 18, percent), amount);
});

test('自定义小数百分比向下取整，100%不超余额', () => {
  assert.equal(positionPercent(balance, 18, '12.34'), '1523.456776412345677641');
  assert.equal(positionPercent('999999999999999999999999999', 0, '100'), '999999999999999999999999999');
  assert.equal(positionPercent('1', 18, '10'), '0');
  assert.equal(positionPercent('101', 0, '50'), '50');
});

test('拒绝零/负数/超过100%/科学计数法和超过两位小数的比例', () => {
  for (const percent of ['0', '-10', '100.01', '101', '1e2', '10%', '0.001', '', 'NaN']) {
    assert.throws(() => positionPercent(balance, 18, percent));
  }
});
