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
let skipped = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name + (detail ? '  ' + detail : ''));
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  ' + detail : ''));
  }
}

/** 限流（429）不是数据不一致，只能「跳过」；否则会把环境问题误报成数据错误 */
function skip(name, detail) {
  skipped++;
  console.log('  – ' + name + (detail ? '  ' + detail : ''));
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
      { retries: 4 }
    );
  } catch (e) {
    return { error: e.status === 404 ? 'not-indexed' : 'http-' + e.status };
  }
  if (!json || json.error || typeof json.downloads !== 'number') {
    return { error: 'not-indexed' };
  }
  return { total: json.downloads, start: json.start, end: json.end };
}

/** 避免把 npm 下载量接口打到限流（429）——逐分片对账请求量不小 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const notIndexed = res.notIndexed || [];
  console.log('  前端识别为未收录的包: ' + (notIndexed.length ? notIndexed.join(', ') : '(无)'));
  check('未收录名单类型正确', Array.isArray(res.notIndexed), JSON.stringify(notIndexed));

  for (const name of names) {
    const expectedNotIndexed = notIndexed.indexOf(name) >= 0;
    const probe = await pointTotal(name, chunks[0].start, chunks[0].end);
    await sleep(200);

    if (probe.error === 'http-429') {
      skip(name + ' 未收录判定', '首个分片被限流(429)，无法交叉验证');
      continue;
    }

    if (expectedNotIndexed) {
      const localAll = dayKeys.reduce((s, d) => s + (daily[d][name] || 0), 0);
      check(
        name + ' 被正确识别为未收录',
        !!probe.error && localAll === 0,
        'point=' + (probe.error || probe.total) + ' local=' + localAll
      );
      continue;
    }

    check(name + ' 未被误判为未收录', !probe.error, probe.error || 'point=' + probe.total);

    let localAll = 0;
    let pointAll = 0;
    let ok = true;
    let rateLimited = 0;

    for (const c of chunks) {
      const local = dayKeys.reduce((s, d) => {
        return c.start <= d && d <= c.end ? s + (daily[d][name] || 0) : s;
      }, 0);
      localAll += local;

      const pt = await pointTotal(name, c.start, c.end);
      await sleep(200);
      if (pt.error) {
        if (pt.error === 'http-429') rateLimited++;
        else ok = false;
        continue;
      }
      pointAll += pt.total;
      if (pt.total !== local) ok = false;
    }

    if (rateLimited) {
      skip(name + ' 全量合计（逐分片对账）', rateLimited + ' 个分片被限流(429)；本地合计=' + localAll);
    } else {
      check(name + ' 全量合计（逐分片对账）', ok, 'point=' + pointAll + ' local=' + localAll);
    }

    const w30 = Agg.resolvePreset('30d', minDay, maxDay);
    const pt30 = await pointTotal(name, w30.start, w30.end);
    await sleep(200);
    const local30 = Agg.sumWindow(daily, names, w30.start, w30.end).byPackage[name];
    if (pt30.error === 'http-429') {
      skip(name + ' 近 30 天', '被限流(429)；本地值=' + local30);
    } else {
      check(name + ' 近 30 天', pt30.total === local30, 'point=' + pt30.total + ' local=' + local30);
    }
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

  console.log('\n=== 5. 排名口径自洽性（本地计算）===');

  const rankSample = Agg.rankByValue({ a: 5, b: 5, c: 3, d: 0, e: 1 }, ['a', 'b', 'c', 'd', 'e']);
  check(
    '并列同名次 + 0 值不上榜',
    JSON.stringify(rankSample.map((r) => r.rank)) === JSON.stringify([1, 1, 3, 4, null]),
    rankSample.map((r) => r.name + '=' + r.value + (r.rank == null ? '(null)' : '#' + r.rank)).join(' ')
  );

  const positive = rankSample.filter((r) => r.value > 0);
  check(
    '名次为「竞争排名」：有名次的项数 = 正值项数，且名次不越过名次序号',
    rankSample.filter((r) => r.rank != null).length === positive.length &&
      positive.every((r, i) => r.rank >= 1 && r.rank <= i + 1) &&
      positive.every((r, i) => i === 0 || r.rank >= positive[i - 1].rank)
  );
  check(
    '「有下载量 ⇔ 有名次」严格等价',
    rankSample.every((r) => (r.rank != null) === (r.value > 0)) &&
      rankSample.every((r, i) => i === 0 || r.value <= rankSample[i - 1].value)
  );

  const wAll = Agg.sumWindow(daily, names, minDay, maxDay);
  const rankedAll = Agg.rankByValue(wAll.byPackage, names);
  const maxPkg = names.reduce((best, n) => (wAll.byPackage[n] > wAll.byPackage[best] ? n : best), names[0]);
  check(
    '累计排名第 1 名 == 累计下载量最高的包',
    rankedAll[0].value === wAll.byPackage[maxPkg],
    rankedAll[0].name + ' ' + Agg.formatNumber(rankedAll[0].value)
  );
  check(
    '排名合计 = 区间合计（未重复计入也未遗漏）',
    rankedAll.reduce((a, r) => a + r.value, 0) === wAll.total
  );

  const rsAll = Agg.rankSeries(daily, names, 'month', minDay, maxDay);
  let rsOk = rsAll.rows.length === rsAll.buckets.length;
  names.forEach((n) => {
    if ((rsAll.series[n] || []).length !== rsAll.buckets.length) rsOk = false;
  });
  rsAll.rows.forEach((row) => {
    row.rows.forEach((r) => {
      if ((r.rank != null) !== (r.value > 0)) rsOk = false;
    });
  });
  check('名次走势：每个包在每个桶都有槽位，且「有值 ⇔ 有名次」', rsOk, rsAll.rows.length + ' 个桶');

  const rsDay = Agg.rankSeries(daily, names, 'day', minDay, maxDay);
  check(
    '名次走势（日粒度）桶数 = 天数，且合计与 aggregate 一致',
    rsDay.rows.length === daysInclusive(minDay, maxDay) &&
      rsDay.rows.reduce((a, r) => a + r.total, 0) === allTotal
  );

  console.log('\n=== 6. 搜索排名（真实接口）===');

  const s1 = await api.searchRank('maintainer:' + CONFIG.username, names, { force: true });
  check(
    '关键词 maintainer:<user> 命中全部包',
    s1.matched.length === names.length && s1.absent.length === 0 && s1.beyond.length === 0,
    '命中 ' + s1.matched.length + '/' + names.length + '，total=' + s1.total + '，scanned=' + s1.scanned
  );
  const searchRanks = s1.matched.map((m) => m.rank);
  check(
    '搜索名次是 1..N 的不重复序列',
    searchRanks.length === s1.total &&
      new Set(searchRanks).size === searchRanks.length &&
      searchRanks.every((r) => r >= 1) &&
      Math.max.apply(null, searchRanks) === s1.total,
    '名次=' + searchRanks.join(',')
  );
  check('短结果集一次请求扫完（complete 而非 capped）', s1.complete === true && s1.capped === false);

  const s2 = await api.searchRank('maintainer:zzz-nonexistent-user-xyz', names, { force: true });
  check(
    '结果集里查不到时 → 「未出现」而非伪造名次',
    s2.total === 0 && s2.complete === true && s2.matched.length === 0 && s2.absent.length === names.length,
    'total=' + s2.total + '，absent=' + s2.absent.length
  );

  // from 超过 5000 会让 npm 静默回绕到第 1 页，所以这里把窗口压到 1 页来验证「撞顶」分支
  const savedMaxRank = CONFIG.searchMaxRank;
  CONFIG.searchMaxRank = 250;
  const s3 = await api.searchRank('react', names, { force: true });
  check(
    '撞到窗口上限时如实标注「超出上限」而非伪造名次',
    s3.capped === true && s3.complete === false && s3.scanned === 250 &&
      s3.matched.length === 0 && s3.beyond.length === names.length && s3.limit === 250,
    'scanned=' + s3.scanned + '，capped=' + s3.capped + '，beyond=' + s3.beyond.length
  );
  CONFIG.searchMaxRank = savedMaxRank;

  const s4 = await api.searchRank('maintainer:' + CONFIG.username, names);
  check('二次调用命中搜索排名缓存（不再发请求）', s4.fromCache === true && s4.matched.length === names.length);

  console.log('\n=== 7. 数据概览 ===');
  console.log('  区间: ' + minDay + ' ~ ' + maxDay + '（' + daysInclusive(minDay, maxDay) + ' 天）');
  console.log('  累计下载: ' + Agg.formatNumber(allTotal));
  names.forEach((n) => {
    const t = dayKeys.reduce((s, d) => s + (daily[d][n] || 0), 0);
    console.log('    - ' + n + ': ' + Agg.formatNumber(t) + ' (' + ((t / allTotal) * 100).toFixed(1) + '%)');
  });

  if (notIndexed.length) {
    console.log('\n  未收录的包（下载量服务尚未收录，不等于 0 下载）: ' + notIndexed.join(', '));
  }

  console.log(
    '\n结果: ' + passed + ' 项通过, ' + failed + ' 项失败' +
      (skipped ? ', ' + skipped + ' 项跳过（接口限流）' : '') + '\n'
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('✗ 校验脚本异常:', e);
  process.exit(1);
});
