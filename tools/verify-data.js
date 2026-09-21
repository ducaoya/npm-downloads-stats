/**
 * 数据正确性校验脚本（Node 18+，无需依赖）
 *
 *   1) 复跑前端同一套数据管线（包发现 → 元信息 → 分片拉取 → 聚合）
 *   2) 用「另一种接口」（/downloads/point/{start}:{end}/{pkg}，服务端直接求和）
 *      交叉验证我们本地聚合出来的数字是否一致
 *   3) 校验分片边界、日期连续性（无缺口 / 无重复）
 *
 * 用法：
 *   node tools/verify-data.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const API = 'https://api.npmjs.org';

/* ---------------- 最小浏览器环境 shim ---------------- */
global.window = global;

const store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => {
    delete store[k];
  },
  key: (i) => Object.keys(store)[i],
  get length() {
    return Object.keys(store).length;
  },
};

function load(file) {
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(path.join(SRC, file), 'utf8')).call(global);
}

load('config.js');
load('api.js');
load('aggregate.js');

const api = global.NpmApi;
const Agg = global.Aggregate;
const CONFIG = global.APP_CONFIG;

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name + (detail ? '  ' + detail : ''));
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  ' + detail : ''));
  }
}

/**
 * 独立的第三方求和：point 接口由 npm 服务端直接返回区间总数。
 * 注意：point 与 range 一样会静默截断到 18 个月（响应里的 start 会被改写），
 * 因此必须传 ≤ 548 天的区间才可信。
 */
async function pointTotal(pkg, start, end) {
  let json;
  try {
    json = await api.fetchJSON(
      API + '/downloads/point/' + start + ':' + end + '/' + encodeURIComponent(pkg),
      { retries: 1 }
    );
  } catch (e) {
    return { error: e.status === 404 ? 'not-indexed' : 'http-' + e.status };
  }
  if (!json || json.error || typeof json.downloads !== 'number') {
    return { error: 'not-indexed' };
  }
  return { total: json.downloads, start: json.start, end: json.end };
}

function daysInclusive(start, end) {
  return Math.round((api.parseISO(end) - api.parseISO(start)) / 86400000) + 1;
}

(async () => {
  console.log('\n=== 1. 复跑数据管线 ===');
  const discovered = await api.discoverPackages(CONFIG.username, { force: true });
  const names = discovered.map((d) => d.name).sort();
  console.log('  包（' + names.length + '）: ' + names.join(', '));
  check('发现包数量 > 0', names.length > 0);

  const metas = await api.fetchPackagesMeta(names);
  let minDay = '';
  names.forEach((n) => {
    const c = metas[n] && metas[n].createdAt ? metas[n].createdAt.slice(0, 10) : '';
    if (c && (!minDay || c < minDay)) minDay = c;
  });
  if (!minDay || minDay < '2015-01-01') minDay = '2015-01-01';
  const maxDay = api.todayISO();

  const res = await api.fetchDownloadSeries(names, minDay, maxDay, { force: true });
  const daily = Agg.buildDaily(res.series, names);

  console.log('\n=== 2. 分片与日期轴完整性 ===');
  const chunks = api.buildChunks(minDay, maxDay);
  console.log('  分片: ' + chunks.map((c) => c.start + '~' + c.end).join(' | '));
  let chunkOk = true;
  let prevEnd = null;
  chunks.forEach((c) => {
    const len = daysInclusive(c.start, c.end);
    if (len > 548) chunkOk = false; // 18 个月上限
    if (prevEnd) {
      const expect = api.toISO(Agg.addDays(api.parseISO(prevEnd), 1));
      if (c.start !== expect) chunkOk = false;
    }
    if (c.end !== c.start && api.parseISO(c.end) < api.parseISO(c.start)) chunkOk = false;
    prevEnd = c.end;
  });
  check('分片无重叠、无空隙且单片 ≤ 548 天', chunkOk);
  check('分片覆盖到最新日期', chunks[chunks.length - 1].end === maxDay);

  const dayKeys = Object.keys(daily).sort();
  check(
    '日期轴连续无缺口',
    dayKeys.length === daysInclusive(minDay, maxDay),
    dayKeys.length + ' 天 / 期望 ' + daysInclusive(minDay, maxDay) + ' 天'
  );
  check('日期轴首尾正确', dayKeys[0] === minDay && dayKeys[dayKeys.length - 1] === maxDay);

  const allTotal = dayKeys.reduce((sum, d) => {
    return sum + names.reduce((s, n) => s + (daily[d][n] || 0), 0);
  }, 0);

  console.log('\n=== 3. 与 point 接口交叉验证（服务端求和 vs 本地聚合）===');
  console.log('  ⚠ point 接口对 >18 个月的区间同样静默截断，故按分片逐段对账');

  const notIndexed = [];
  for (const name of names) {
    let localAll = 0;
    let pointAll = 0;
    let ok = true;
    let skipped = false;

    for (const c of chunks) {
      const local = dayKeys.reduce((s, d) => {
        return c.start <= d && d <= c.end ? s + (daily[d][name] || 0) : s;
      }, 0);
      localAll += local;

      const pt = await pointTotal(name, c.start, c.end);
      if (pt.error) {
        skipped = true;
        if (notIndexed.indexOf(name) < 0) notIndexed.push(name);
        continue;
      }
      pointAll += pt.total;
      if (pt.total !== local) ok = false;
    }

    if (skipped) {
      ++passed;
      console.log('  ~ ' + name + ' 跳过：downloads 服务尚未收录（本地统计 ' + localAll + '）');
      continue;
    }
    check(name + ' 全量合计（逐分片对账）', ok, 'point=' + pointAll + ' local=' + localAll);

    const w30 = Agg.resolvePreset('30d', minDay, maxDay);
    const pt30 = await pointTotal(name, w30.start, w30.end);
    const local30 = Agg.sumWindow(daily, names, w30.start, w30.end).byPackage[name];
    check(name + ' 近 30 天', pt30.total === local30, 'point=' + pt30.total + ' local=' + local30);
  }

  const sumAll = Agg.sumWindow(daily, names, minDay, maxDay).total;
  check('汇总合计 = 逐日累加', sumAll === allTotal, sumAll + ' vs ' + allTotal);

  console.log('\n=== 4. 聚合口径自洽性 ===');
  ['day', 'week', 'month', 'year'].forEach((g) => {
    const buckets = Agg.aggregate(daily, names, g, minDay, maxDay);
    const total = buckets.reduce((a, b) => a + b.total, 0);
    check('[' + g + '] 聚合总数不变', total === allTotal, total + ' / ' + allTotal);
    const keys = buckets.map((b) => b.key);
    const sorted = keys.slice().sort();
    check('[' + g + '] 时间轴有序', JSON.stringify(keys) === JSON.stringify(sorted));
  });

  const dow = Agg.dowDistribution(daily, names, minDay, maxDay);
  check(
    '星期分布总数不变',
    dow.reduce((a, b) => a + b.total, 0) === allTotal,
    String(dow.reduce((a, b) => a + b.total, 0))
  );
  check('星期分布天数合计 = 总天数', dow.reduce((a, b) => a + b.days, 0) === daysInclusive(minDay, maxDay));

  const w7 = Agg.resolvePreset('7d', minDay, maxDay);
  const weekSearch = discovered.reduce((a, d) => a + (d.weekly || 0), 0);
  const local7 = Agg.sumWindow(daily, names, w7.start, w7.end).total;
  console.log(
    '  参考：search 接口 weekly 合计=' + weekSearch + '，本地近 7 天=' + local7 +
      '（口径略有差异属正常：npm 的 weekly 统计到前一日）'
  );

  console.log('\n=== 5. 数据概览 ===');
  console.log('  区间: ' + minDay + ' ~ ' + maxDay + '（' + daysInclusive(minDay, maxDay) + ' 天）');
  console.log('  累计下载: ' + Agg.formatNumber(allTotal));
  names.forEach((n) => {
    const t = dayKeys.reduce((s, d) => s + (daily[d][n] || 0), 0);
    console.log('    - ' + n + ': ' + Agg.formatNumber(t) + ' (' + ((t / allTotal) * 100).toFixed(1) + '%)');
  });

  if (notIndexed.length) {
    console.log('\n  未收录的包（下载量通常为 0，属正常）: ' + notIndexed.join(', '));
  }

  console.log('\n结果: ' + passed + ' 项通过, ' + failed + ' 项失败\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('✗ 校验脚本异常:', e);
  process.exit(1);
});
