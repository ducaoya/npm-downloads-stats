/**
 * 数据整形与聚合：逐日序列 → 日 / 周 / 月 / 年 四个粒度，以及星期分布。
 */
(function (global) {
  'use strict';

  var api = global.NpmApi;

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /** 该日期所在周的周一 */
  function mondayOf(date) {
    var weekday = (date.getDay() + 6) % 7; // 周一 = 0
    return addDays(date, -weekday);
  }

  /** ISO 周序号 */
  function isoWeekNumber(date) {
    var t = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var dayNum = (t.getDay() + 6) % 7;
    t.setDate(t.getDate() - dayNum + 3);
    var firstThursday = new Date(t.getFullYear(), 0, 4);
    var firstDayNum = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
    return 1 + Math.round((t.getTime() - firstThursday.getTime()) / 604800000);
  }

  /**
   * 把 { pkg: { day: n } } 转成 { day: { pkg: n } }，并丢弃全 0 的尾部（今日尚未统计完成时会出现 0）
   */
  function buildDaily(series, packages) {
    var daily = {};
    var allDays = {};

    packages.forEach(function (name) {
      var dayMap = series[name] || {};
      Object.keys(dayMap).forEach(function (day) {
        allDays[day] = true;
        if (!daily[day]) daily[day] = {};
        daily[day][name] = dayMap[day] || 0;
      });
    });

    // 补齐缺失的包为 0，保证每天都有完整的包维度
    Object.keys(daily).forEach(function (day) {
      packages.forEach(function (name) {
        if (daily[day][name] == null) daily[day][name] = 0;
      });
    });

    return daily;
  }

  /** 连续日期轴（含中间没有数据的日期，补 0） */
  function continuousDays(daily, startISO, endISO) {
    var out = {};
    var cursor = api.parseISO(startISO);
    var end = api.parseISO(endISO);
    while (cursor.getTime() <= end.getTime()) {
      var key = api.toISO(cursor);
      out[key] = daily[key] || null;
      cursor = addDays(cursor, 1);
    }
    return out;
  }

  /** 区间求和 */
  function sumWindow(daily, packages, startISO, endISO) {
    var byPackage = {};
    var total = 0;
    packages.forEach(function (name) {
      byPackage[name] = 0;
    });

    var cursor = api.parseISO(startISO);
    var end = api.parseISO(endISO);
    while (cursor.getTime() <= end.getTime()) {
      var row = daily[api.toISO(cursor)];
      if (row) {
        packages.forEach(function (name) {
          var v = row[name] || 0;
          byPackage[name] += v;
          total += v;
        });
      }
      cursor = addDays(cursor, 1);
    }

    return { total: total, byPackage: byPackage, start: startISO, end: endISO };
  }

  /** 桶的 metadata（key / label / fullLabel / sortKey） */
  function bucketMeta(dayStr, granularity, withYear) {
    var date = api.parseISO(dayStr);
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();

    if (granularity === 'week') {
      var monday = mondayOf(date);
      var sunday = addDays(monday, 6);
      var wk = isoWeekNumber(date);
      return {
        key: api.toISO(monday),
        sortKey: api.toISO(monday),
        label: pad2(monday.getMonth() + 1) + '-' + pad2(monday.getDate()),
        fullLabel:
          api.toISO(monday) + ' ~ ' + api.toISO(sunday) + '　第 ' + wk + ' 周',
      };
    }

    if (granularity === 'month') {
      return {
        key: y + '-' + pad2(m),
        sortKey: y + '-' + pad2(m),
        label: withYear ? String(y).slice(2) + '-' + pad2(m) : m + '月',
        fullLabel: y + ' 年 ' + m + ' 月',
      };
    }

    if (granularity === 'year') {
      return {
        key: String(y),
        sortKey: String(y),
        label: String(y),
        fullLabel: y + ' 年',
      };
    }

    return {
      key: dayStr,
      sortKey: dayStr,
      label: withYear ? String(y).slice(2) + '-' + pad2(m) + '-' + pad2(d) : pad2(m) + '-' + pad2(d),
      fullLabel: dayStr + '（周' + '一二三四五六日'.charAt(((date.getDay() + 6) % 7)) + '）',
    };
  }

  /**
   * 主聚合：按粒度把逐日数据合成时间轴。
   * @returns Array<{key,label,fullLabel,total,values:{pkg:n}}>
   */
  function aggregate(daily, packages, granularity, startISO, endISO) {
    var days = continuousDays(daily, startISO, endISO);
    var dayKeys = Object.keys(days).sort();
    var years = {};
    dayKeys.forEach(function (d) {
      years[d.slice(0, 4)] = true;
    });
    var withYear = Object.keys(years).length > 1;

    var buckets = {};
    var order = [];

    dayKeys.forEach(function (day) {
      var meta = bucketMeta(day, granularity, withYear);
      var bucket = buckets[meta.key];
      if (!bucket) {
        bucket = {
          key: meta.key,
          sortKey: meta.sortKey,
          label: meta.label,
          fullLabel: meta.fullLabel,
          total: 0,
          values: {},
        };
        packages.forEach(function (name) {
          bucket.values[name] = 0;
        });
        buckets[meta.key] = bucket;
        order.push(meta.key);
      }
      var row = days[day];
      if (!row) return;
      packages.forEach(function (name) {
        var v = row[name] || 0;
        if (v) {
          bucket.values[name] += v;
          bucket.total += v;
        }
      });
    });

    order.sort(function (a, b) {
      var ka = buckets[a].sortKey;
      var kb = buckets[b].sortKey;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    return order.map(function (k) {
      return buckets[k];
    });
  }

  /** 星期分布（周一 → 周日） */
  function dowDistribution(daily, packages, startISO, endISO) {
    var labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    var totals = [0, 0, 0, 0, 0, 0, 0];
    var occurrences = [0, 0, 0, 0, 0, 0, 0];
    var byPackage = labels.map(function () {
      return {};
    });

    packages.forEach(function (name) {
      byPackage.forEach(function (o) {
        o[name] = 0;
      });
    });

    var cursor = api.parseISO(startISO);
    var end = api.parseISO(endISO);
    while (cursor.getTime() <= end.getTime()) {
      var idx = (cursor.getDay() + 6) % 7;
      occurrences[idx]++;
      var row = daily[api.toISO(cursor)];
      if (row) {
        packages.forEach(function (name) {
          var v = row[name] || 0;
          totals[idx] += v;
          byPackage[idx][name] += v;
        });
      }
      cursor = addDays(cursor, 1);
    }

    return labels.map(function (label, i) {
      return {
        label: label,
        total: totals[i],
        days: occurrences[i],
        average: occurrences[i] ? totals[i] / occurrences[i] : 0,
        values: byPackage[i],
      };
    });
  }

  /** 区间预设 */
  function resolvePreset(preset, minDay, maxDay) {
    var end = maxDay;
    switch (preset) {
      case '7d':
        return { start: api.toISO(addDays(api.parseISO(end), -6)), end: end };
      case '30d':
        return { start: api.toISO(addDays(api.parseISO(end), -29)), end: end };
      case '90d':
        return { start: api.toISO(addDays(api.parseISO(end), -89)), end: end };
      case '365d':
        return { start: api.toISO(addDays(api.parseISO(end), -364)), end: end };
      case 'ytd':
        return { start: end.slice(0, 4) + '-01-01', end: end };
      case 'all':
      default:
        return { start: minDay, end: end };
    }
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function formatCompact(n) {
    if (n == null || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
    return formatNumber(n);
  }

  global.Aggregate = {
    buildDaily: buildDaily,
    continuousDays: continuousDays,
    sumWindow: sumWindow,
    aggregate: aggregate,
    dowDistribution: dowDistribution,
    resolvePreset: resolvePreset,
    formatNumber: formatNumber,
    formatCompact: formatCompact,
    mondayOf: mondayOf,
    addDays: addDays,
  };
})(window);
