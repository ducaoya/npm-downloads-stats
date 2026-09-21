/**
 * 图表渲染（ECharts）。所有配色都从 CSS 变量读取，随主题自动切换。
 */
(function (global) {
  'use strict';

  var PALETTE = [
    '#4f7cff', '#22c1a4', '#f5a524', '#ef5da8', '#8b5cf6',
    '#0ea5e9', '#84cc16', '#f97316', '#14b8a6', '#64748b',
    '#e11d48', '#a16207',
  ];

  var ACCENT = '#4f7cff';
  var instances = {};

  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) {
      var value = cs.getPropertyValue(name);
      return value && value.trim() ? value.trim() : fallback;
    }
    return {
      text: v('--chart-text', '#334155'),
      axis: v('--chart-axis', '#94a3b8'),
      split: v('--chart-split', 'rgba(148,163,184,.22)'),
      accent: v('--accent', ACCENT),
      tooltipBg: v('--chart-tooltip-bg', 'rgba(255,255,255,.96)'),
      tooltipBorder: v('--chart-tooltip-border', 'rgba(15,23,42,.08)'),
      tooltipText: v('--chart-tooltip-text', '#0f172a'),
    };
  }

  function getChart(el) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return null;
    var id = el.id || 'anon';
    if (!instances[id] || instances[id].isDisposed()) {
      instances[id] = echarts.init(el, null, { renderer: 'canvas' });
    }
    return instances[id];
  }

  function paletteFor(count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(PALETTE[i % PALETTE.length]);
    return out;
  }

  function baseTooltip(c) {
    return {
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: c.tooltipText, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 28px rgba(15,23,42,.14);backdrop-filter:blur(6px);',
    };
  }

  /* ------------------------------------------------------------------ *
   * 1. 趋势图
   * ------------------------------------------------------------------ */

  function buildTrendSeries(buckets, packages, type, colors, showTotal, c) {
    var series = packages.map(function (name, i) {
      var color = colors[i % colors.length];
      var s = {
        name: name,
        type: 'bar',
        data: buckets.map(function (b) {
          return b.values[name] || 0;
        }),
        barMaxWidth: 34,
        itemStyle: { color: color, borderRadius: type === 'bar' ? [3, 3, 0, 0] : 0 },
        emphasis: { focus: 'series' },
      };

      if (type === 'area') {
        s.type = 'line';
        s.stack = 'total';
        s.smooth = false;
        s.showSymbol = false;
        s.lineStyle = { width: 0 };
        s.areaStyle = { color: color, opacity: 0.75 };
        s.emphasis = { focus: 'series' };
      } else if (type === 'line') {
        s.type = 'line';
        s.smooth = true;
        s.symbol = 'circle';
        s.symbolSize = 5;
        s.showSymbol = buckets.length <= 45;
        s.lineStyle = { width: 2 };
        s.itemStyle = { color: color };
      } else {
        s.stack = 'total';
      }
      return s;
    });

    if (showTotal) {
      series.push({
        name: '合计',
        type: 'line',
        smooth: true,
        z: 20,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: buckets.length <= 60,
        data: buckets.map(function (b) {
          return b.total;
        }),
        lineStyle: { width: 2.4, type: 'dashed', color: c.accent },
        itemStyle: { color: c.accent },
        tooltip: { show: false },
      });
    }

    return series;
  }

  function trendTooltipFormatter(packages, buckets) {
    return function (params) {
      if (!params || !params.length) return '';
      var idx = params[0].dataIndex;
      var bucket = buckets[idx];
      if (!bucket) return '';
      var rows = params
        .filter(function (p) {
          return p.seriesName !== '合计';
        })
        .map(function (p) {
          return { name: p.seriesName, value: p.value || 0, color: p.color };
        })
        .sort(function (a, b) {
          return b.value - a.value;
        });

      var html =
        '<div style="font-weight:600;margin-bottom:6px">' + bucket.fullLabel +
        '</div>';
      var visible = rows.filter(function (r) {
        return r.value > 0;
      });
      if (!visible.length) {
        html += '<div style="opacity:.6">该周期无下载量</div>';
        return html;
      }
      html += visible
        .map(function (r) {
          return (
            '<div style="display:flex;align-items:center;gap:8px;line-height:1.8">' +
            '<span style="width:8px;height:8px;border-radius:2px;background:' + r.color + '"></span>' +
            '<span style="flex:1;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + r.name + '</span>' +
            '<span style="font-variant-numeric:tabular-nums;font-weight:600">' + r.value.toLocaleString('en-US') + '</span>' +
            '</div>'
          );
        })
        .join('');
      html +=
        '<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,.35);display:flex;gap:8px">' +
        '<span style="flex:1;font-weight:600">合计</span>' +
        '<span style="font-variant-numeric:tabular-nums;font-weight:700">' + bucket.total.toLocaleString('en-US') + '</span>' +
        '</div>';
      return html;
    };
  }

  function renderTrend(el, options) {
    var chart = getChart(el);
    if (!chart) return;
    var c = themeColors();
    var buckets = options.buckets || [];
    var packages = options.packages || [];
    var colors = options.colors || paletteFor(packages.length);
    var type = options.type || 'bar';

    // 尽量保留用户当前的缩放状态
    var prevZoom = null;
    try {
      var prevOption = chart.getOption();
      if (prevOption && prevOption.dataZoom && prevOption.dataZoom.length && prevOption.xAxis &&
          prevOption.xAxis[0] && prevOption.xAxis[0].data && prevOption.xAxis[0].data.length === buckets.length) {
        prevZoom = { start: prevOption.dataZoom[0].start, end: prevOption.dataZoom[0].end };
      }
    } catch (e) {
      prevZoom = null;
    }

    var showZoom = buckets.length > 60;
    var defaultCount = 120;
    var startPercent = buckets.length > defaultCount ? ((buckets.length - defaultCount) / buckets.length) * 100 : 0;
    if (prevZoom) {
      startPercent = prevZoom.start;
    }

    var option = {
      backgroundColor: 'transparent',
      animationDuration: 420,
      animationEasing: 'cubicOut',
      color: colors,
      grid: {
        left: 4,
        right: 12,
        top: packages.length > 1 ? 46 : 22,
        bottom: showZoom ? 62 : 6,
        containLabel: true,
      },
      tooltip: Object.assign(baseTooltip(c), {
        trigger: 'axis',
        axisPointer: { type: type === 'bar' ? 'shadow' : 'line', lineStyle: { color: c.axis, type: 'dashed' } },
        formatter: trendTooltipFormatter(packages, buckets),
        confine: true,
      }),
      legend: {
        type: 'scroll',
        top: 2,
        left: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 14,
        textStyle: { color: c.text, fontSize: 12 },
        pageTextStyle: { color: c.axis },
        pageIconColor: c.axis,
        pageIconInactiveColor: c.split,
      },
      xAxis: {
        type: 'category',
        data: buckets.map(function (b) {
          return b.label;
        }),
        boundaryGap: type !== 'line',
        axisLine: { lineStyle: { color: c.split } },
        axisTick: { show: false },
        axisLabel: { color: c.axis, fontSize: 11, hideOverlap: true },
        axisPointer: { label: { show: false } },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: c.axis,
          fontSize: 11,
          formatter: function (v) {
            return global.Aggregate.formatCompact(v);
          },
        },
        splitLine: { lineStyle: { color: c.split, type: 'dashed' } },
      },
      dataZoom: showZoom
        ? [
            { type: 'inside', start: startPercent, end: prevZoom ? prevZoom.end : 100 },
            {
              type: 'slider',
              start: startPercent,
              end: prevZoom ? prevZoom.end : 100,
              height: 18,
              bottom: 8,
              borderColor: 'transparent',
              backgroundColor: 'rgba(148,163,184,.12)',
              fillerColor: 'rgba(79,124,255,.18)',
              handleStyle: { color: c.accent, borderColor: c.accent },
              moveHandleStyle: { color: c.accent },
              dataBackground: { lineStyle: { color: c.split }, areaStyle: { color: c.split } },
              selectedDataBackground: { lineStyle: { color: c.accent }, areaStyle: { color: 'rgba(79,124,255,.25)' } },
              textStyle: { color: c.axis, fontSize: 10 },
            },
          ]
        : [],
      series: buildTrendSeries(buckets, packages, type, colors, !!options.showTotal, c),
    };

    chart.setOption(option, true);
  }

  /* ------------------------------------------------------------------ *
   * 2. 占比环形图
   * ------------------------------------------------------------------ */

  function renderShare(el, options) {
    var chart = getChart(el);
    if (!chart) return;
    var c = themeColors();
    var items = (options.items || []).filter(function (i) {
      return i.value > 0;
    });
    var colors = options.colors || paletteFor(items.length);

    if (!items.length) {
      chart.setOption(
        {
          backgroundColor: 'transparent',
          title: {
            text: '暂无下载量',
            left: 'center',
            top: 'middle',
            textStyle: { color: c.axis, fontSize: 13, fontWeight: 'normal' },
          },
          series: [],
        },
        true
      );
      return;
    }

    var total = items.reduce(function (a, b) {
      return a + b.value;
    }, 0);

    var option = {
      backgroundColor: 'transparent',
      color: colors,
      tooltip: Object.assign(baseTooltip(c), {
        trigger: 'item',
        confine: true,
        formatter: function (p) {
          return (
            '<div style="font-weight:600;margin-bottom:4px">' + p.name + '</div>' +
            '<div>' + p.value.toLocaleString('en-US') + '　<span style="opacity:.65">(' + p.percent + '%)</span></div>'
          );
        },
      }),
      legend: {
        orient: 'vertical',
        right: 4,
        top: 'middle',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 10,
        textStyle: { color: c.text, fontSize: 11 },
        formatter: function (name) {
          return name.length > 22 ? name.slice(0, 21) + '…' : name;
        },
      },
      title: {
        text: global.Aggregate.formatCompact(total),
        subtext: '合计下载',
        left: '34%',
        top: '43%',
        textAlign: 'center',
        textStyle: { color: c.text, fontSize: 20, fontWeight: 700 },
        subtextStyle: { color: c.axis, fontSize: 11 },
      },
      series: [
        {
          type: 'pie',
          radius: ['50%', '74%'],
          center: ['34%', '54%'],
          avoidLabelOverlap: true,
          padAngle: 2,
          itemStyle: { borderRadius: 5, borderColor: 'transparent', borderWidth: 2 },
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            scale: true,
            scaleSize: 6,
            label: { show: false },
          },
          data: items.map(function (i) {
            return { name: i.name, value: i.value };
          }),
        },
      ],
    };

    chart.setOption(option, true);
  }

  /* ------------------------------------------------------------------ *
   * 3. 星期分布
   * ------------------------------------------------------------------ */

  function renderDow(el, options) {
    var chart = getChart(el);
    if (!chart) return;
    var c = themeColors();
    var rows = options.rows || [];
    var colors = options.colors || [];
    var max = rows.reduce(function (a, b) {
      return Math.max(a, b.total);
    }, 0);

    var option = {
      backgroundColor: 'transparent',
      grid: { left: 4, right: 10, top: 16, bottom: 4, containLabel: true },
      tooltip: Object.assign(baseTooltip(c), {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        confine: true,
        formatter: function (params) {
          var p = params[0];
          var row = rows[p.dataIndex];
          if (!row) return '';
          var list = (options.packages || [])
            .map(function (name) {
              return { name: name, value: row.values[name] || 0 };
            })
            .filter(function (i) {
              return i.value > 0;
            })
            .sort(function (a, b) {
              return b.value - a.value;
            });
          var html = '<div style="font-weight:600;margin-bottom:6px">' + row.label + '</div>';
          html +=
            '<div style="line-height:1.8"><span style="opacity:.7">合计</span>　<b>' +
            row.total.toLocaleString('en-US') +
            '</b></div>' +
            '<div style="line-height:1.8"><span style="opacity:.7">' + row.days + ' 天平均</span>　<b>' +
            Math.round(row.average).toLocaleString('en-US') +
            '</b></div>';
          if (list.length) {
            html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,.35)">';
            html += list
              .map(function (i) {
                return '<div style="line-height:1.7;display:flex;gap:10px"><span style="flex:1">' + i.name + '</span><span style="font-variant-numeric:tabular-nums">' + i.value.toLocaleString('en-US') + '</span></div>';
              })
              .join('');
            html += '</div>';
          }
          return html;
        },
      }),
      xAxis: {
        type: 'category',
        data: rows.map(function (r) {
          return r.label;
        }),
        axisLine: { lineStyle: { color: c.split } },
        axisTick: { show: false },
        axisLabel: { color: c.axis, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: c.axis,
          fontSize: 11,
          formatter: function (v) {
            return global.Aggregate.formatCompact(v);
          },
        },
        splitLine: { lineStyle: { color: c.split, type: 'dashed' } },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 46,
          data: rows.map(function (r, i) {
            return {
              value: r.total,
              itemStyle: {
                borderRadius: [5, 5, 0, 0],
                color: colors[i] || PALETTE[i % PALETTE.length],
              },
            };
          }),
          label: {
            show: true,
            position: 'top',
            color: c.axis,
            fontSize: 10,
            formatter: function (p) {
              return p.value ? global.Aggregate.formatCompact(p.value) : '';
            },
          },
          markLine: max
            ? {
                silent: true,
                symbol: 'none',
                data: [{ type: 'average', name: '平均' }],
                lineStyle: { color: c.accent, type: 'dashed', width: 1.4 },
                label: { color: c.accent, fontSize: 10, formatter: '平均 {c}' },
              }
            : undefined,
        },
      ],
    };

    chart.setOption(option, true);
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  function resize() {
    Object.keys(instances).forEach(function (id) {
      var inst = instances[id];
      if (inst && !inst.isDisposed()) inst.resize();
    });
  }

  function disposeAll() {
    Object.keys(instances).forEach(function (id) {
      var inst = instances[id];
      if (inst && !inst.isDisposed()) inst.dispose();
    });
    instances = {};
  }

  global.Charts = {
    PALETTE: PALETTE,
    paletteFor: paletteFor,
    themeColors: themeColors,
    renderTrend: renderTrend,
    renderShare: renderShare,
    renderDow: renderDow,
    resize: resize,
    disposeAll: disposeAll,
  };
})(window);
