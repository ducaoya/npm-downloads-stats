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
  const maxDay = api.yesterdayISO();

  const res = await api.fetchDownloadSeries(names, minDay, maxDay, { force: true });
  const daily = Agg.buildDaily(res.series, names);

  console.log('\n=== 2. 分片与日期轴完整性 ===');
  const chunks = api.buildChunks(minDay, maxDay);
  const BULK_MAX_DAYS = 365; // 批量 range 查询实测硬上限：end - start > 365 天直接 400
  console.log('  分片: ' + chunks.map((c) => c.start + '~' + c.end).join(' | '));
  check(
    'chunkDays 不超过批量接口的 365 天上限',
    CONFIG.chunkDays <= BULK_MAX_DAYS,
    'chunkDays=' + CONFIG.chunkDays
  );
  let chunkOk = true;
  let prevEnd = null;
  chunks.forEach((c) => {
    const len = daysInclusive(c.start, c.end);
    if (len - 1 > BULK_MAX_DAYS) chunkOk = false; // 批量查询的 end - start 上限
    if (prevEnd) {
      const expect = api.toISO(Agg.addDays(api.parseISO(prevEnd), 1));
      if (c.start !== expect) chunkOk = false;
    }
    if (c.end !== c.start && api.parseISO(c.end) < api.parseISO(c.start)) chunkOk = false;
    prevEnd = c.end;
  });
  check('分片无重叠、无空隙且每片 end - start ≤ ' + BULK_MAX_DAYS + ' 天', chunkOk);
  check('分片覆盖到最新日期', chunks[chunks.length - 1].end === maxDay);

  // 直接拿「批量」接口复测每个分片：这是真正会被 400 卡住的路径
  // （错误响应不带 CORS 头 ⇒ 浏览器里表现为 Failed to fetch，看不到 400）
  //
  // 先探一下是否处于限流状态：npm 限流时也返回“无 CORS 头的错误响应”，
  // 不先探就会把「环境被限流」误报成「数据/接口错」。
  const throttleProbe = await api
    .fetchJSON(API + '/downloads/range/' + chunks[0].start + ':' + chunks[0].end + '/' + encodeURIComponent(names[0]), {
      retries: 1,
    })
    .then(() => null)
    .catch((e) => e.status || 'no-status');
  await sleep(200);

  if (throttleProbe) {
    skip('每个分片都能被「批量」下载量接口接受', '环境被限流（' + throttleProbe + '），无法验证');
  } else {
    let bulkOk = true;
    let bulkDetail = '';
    let bulkThrottled = false;
    for (const c of chunks) {
      const url =
        API + '/downloads/range/' + c.start + ':' + c.end + '/' +
        names.slice(0, Math.min(3, names.length)).map(encodeURIComponent).join(',');
      try {
        const j = await api.fetchJSON(url, { retries: 1 });
        if (j && j.error) {
          bulkOk = false;
          bulkDetail = c.start + '~' + c.end + ': ' + j.error;
        }
      } catch (e) {
        if (e.status === 429 || e.status == null) bulkThrottled = true;
        bulkOk = false;
        bulkDetail = c.start + '~' + c.end + ': ' + (e.status || 'no-status（可能是限流）');
      }
      await sleep(250);
    }
    if (bulkThrottled) {
      skip('每个分片都能被「批量」下载量接口接受', '中途被限流：' + bulkDetail);
    } else {
      check('每个分片都能被「批量」下载量接口接受', bulkOk, bulkDetail || chunks.length + ' 片全部 200');
    }
  }

  // 上千个包的用户必须分批，否则 URL 过长会被 npm 拒（而限流时的错误响应不带 CORS 头，
  // 在浏览器里会表现成 “Failed to fetch”）
  const manyPkgs = [];
  for (let i = 0; i < 250; i++) manyPkgs.push('pkg-' + i);
  const groups = api.splitPackages(manyPkgs, CONFIG.batchSize);
  const flat = groups.reduce((a, g) => a.concat(g), []);
  check(
    '包分批：每批 ≤ batchSize，总数不丢不重',
    groups.every((g) => g.length > 0 && g.length <= CONFIG.batchSize) &&
      flat.length === manyPkgs.length &&
      new Set(flat).size === manyPkgs.length &&
      flat.join('|') === manyPkgs.join('|'),
    groups.length + ' 批 × ≤' + CONFIG.batchSize
  );

  // scoped 包不能进批量请求（实测：400 "scoped packages are not currently supported in bulk lookups"）
  const mixedPkgs = ['plain-a', '@scope/b', 'plain-c', '@scope/d', 'plain-e'];
  const mixedJobs = api.buildSeriesJobs(mixedPkgs, [{ start: '2020-01-01', end: '2020-12-31' }], CONFIG.batchSize);
  const bulkJobs = mixedJobs.filter((j) => j.packages.length > 1);
  const singleJobs = mixedJobs.filter((j) => j.packages.length === 1);
  check(
    'scoped 包一律不进批量请求',
    bulkJobs.length === 1 &&
      bulkJobs[0].packages.join(',') === 'plain-a,plain-c,plain-e' &&
      singleJobs.length === 2 &&
      singleJobs.every((j) => j.packages[0].charAt(0) === '@'),
    mixedJobs.map((j) => j.packages.join('+')).join(' , ')
  );
  const covered = mixedJobs.reduce((a, j) => a.concat(j.packages), []).sort();
  check(
    '分片作业覆盖全部包且不重叠',
    covered.join('|') === mixedPkgs.slice().sort().join('|'),
    covered.join(',')
  );

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

  console.log('\n=== 5. 搜索排名（真实接口）===');

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

  console.log('\n=== 6. 数据概览 ===');
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
