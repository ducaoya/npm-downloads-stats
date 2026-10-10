/**
 * 应用主逻辑：加载数据 → 聚合 → 渲染卡片 / 图表 / 表格。
 */
(function () {
  'use strict';

  var CONFIG = window.APP_CONFIG;
  var api = window.NpmApi;
  var Agg = window.Aggregate;
  var Charts = window.Charts;

  var PREFS_KEY = 'npmdl:prefs';
  var USER_KEY = 'npmdl:user';
  var FALLBACK_START = '2015-01-01'; // npm 下载量数据起点
  var NOT_INDEXED_TIP =
    'npm 下载量服务尚未收录该包（新发布的包通常需要 24~48 小时），' +
    '这不等于「真的 0 下载」——包在 registry 上是正常的。';

  /* ------------------------------------------------------------------ *
   * 当前用户：?user= > localStorage > config.js 里的 username
   * ------------------------------------------------------------------ */

  /** npm 用户名：小写字母 / 数字 / - _ . ~（不含 scope，scope 不是账号） */
  var USER_RE = /^[a-z0-9][a-z0-9._~-]{0,213}$/;

  function sanitizeUser(raw) {
    return String(raw == null ? '' : raw)
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
  }

  function isValidUser(name) {
    return !!name && USER_RE.test(name) && name.charAt(0) !== '.' && name.charAt(0) !== '_';
  }

  function ownerUser() {
    return sanitizeUser(CONFIG.username);
  }

  /** 手动补充/排除的包与显式搜索关键词只属于 config.js 里的默认用户 */
  function isOwner() {
    return state.user === ownerUser();
  }

  function urlUser() {
    try {
      var raw = new URLSearchParams(window.location.search || '').get('user');
      return raw ? sanitizeUser(raw) : '';
    } catch (e) {
      return '';
    }
  }

  function storedUser() {
    try {
      return sanitizeUser(window.localStorage.getItem(USER_KEY));
    } catch (e) {
      return '';
    }
  }

  function resolveUser() {
    var fromUrl = urlUser();
    if (fromUrl) return fromUrl;
    var fromStore = storedUser();
    if (fromStore) return fromStore;
    return ownerUser();
  }

  var state = {
    user: resolveUser(),
    packages: [],
    metas: {},
    daily: {},
    notIndexed: {},
    minDay: '',
    maxDay: '',
    granularity: CONFIG.defaultGranularity || 'day',
    rangePreset: CONFIG.defaultRange || '30d',
    chartType: 'bar',
    showTotal: true,
    hidden: {},
    sortKey: 'total',
    sortDir: 'desc',
    theme: CONFIG.defaultTheme || 'auto',
    fetchedAt: 0,
    loaded: false,
    log: [],
    search: {
      status: 'idle', // idle | loading | ok | error
      keywords: [], // 由 load() 按当前用户计算
      results: [],
      progress: '',
      error: '',
      fetchedAt: 0,
    },
  };

  var el = {};
  ['userForm', 'userInput', 'pkgCount', 'dataRange', 'updatedAt', 'banner', 'cards', 'trendChart', 'trendHint',
   'shareChart', 'shareHint', 'dowChart', 'chips', 'pkgTableBody', 'pkgTableFoot', 'tableHint',
   'searchTable', 'searchHead', 'searchBody', 'searchHint', 'searchNote',
   'loading', 'loadingText', 'btnRefresh', 'btnTheme', 'btnCopy', 'btnClearCache', 'btnToggleDebug',
   'debugBox', 'chkTotal', 'segGranularity', 'segRange', 'segType'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /** HTML 转义（包名/关键词都来自 npm，仍做一次保险） */
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 搜索关键词。
   * 默认用户可沿用 config.js 里写死的关键词；其他用户一律用 maintainer:<user>，
   * 否则会在别人的页面上显示只对作者有意义的搜索词。
   */
  function searchKeywords(user) {
    var who = user || state.user || ownerUser();
    if (who === ownerUser()) {
      var list = (CONFIG.searchKeywords || []).filter(function (kw) {
        return !!kw;
      });
      if (list.length) return list.slice();
    }
    return who ? ['maintainer:' + who] : [];
  }

  /* ------------------------------------------------------------------ *
   * 偏好持久化
   * ------------------------------------------------------------------ */

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      if (p.granularity) state.granularity = p.granularity;
      if (p.rangePreset) state.rangePreset = p.rangePreset;
      if (p.chartType) state.chartType = p.chartType;
      if (typeof p.showTotal === 'boolean') state.showTotal = p.showTotal;
      if (p.theme) state.theme = p.theme;
      if (p.hidden && typeof p.hidden === 'object') state.hidden = p.hidden;
    } catch (e) {
      /* ignore */
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          granularity: state.granularity,
          rangePreset: state.rangePreset,
          chartType: state.chartType,
          showTotal: state.showTotal,
          theme: state.theme,
          hidden: state.hidden,
        })
      );
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 通用 UI 工具
   * ------------------------------------------------------------------ */

  function log(message) {
    state.log.push('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + message);
  }

  function showLoading(text) {
    el.loading.classList.remove('hidden');
    el.loadingText.textContent = text || '加载中…';
  }

  function hideLoading() {
    el.loading.classList.add('hidden');
  }

  function showBanner(html, type) {
    el.banner.className = 'banner' + (type ? ' banner-' + type : '');
    el.banner.innerHTML = html;
  }

  function hideBanner() {
    el.banner.className = 'banner hidden';
    el.banner.innerHTML = '';
  }

  function colorFor(name) {
    var idx = state.packages.indexOf(name);
    if (idx < 0) idx = 0;
    return Charts.PALETTE[idx % Charts.PALETTE.length];
  }

  function setSegmentActive(container, value) {
    Array.prototype.forEach.call(container.querySelectorAll('button'), function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });
  }

  /* ------------------------------------------------------------------ *
   * 数据加载
   * ------------------------------------------------------------------ */

  function mergePackages(discovered) {
    var names = [];
    var seen = {};

    function push(name) {
      if (!name || seen[name]) return;
      seen[name] = true;
      names.push(name);
    }

    // extraPackages / excludePackages / autoDiscover 是「站点主人自己的口径」，
    // 只对 config.js 里的默认用户生效；别人切换进来时一律按其真实包列表统计。
    var owner = isOwner();
    var auto = owner ? CONFIG.autoDiscover !== false : true;
    (auto ? discovered : []).forEach(function (item) {
      push(item.name);
    });
    if (owner) (CONFIG.extraPackages || []).forEach(push);

    var excluded = {};
    if (owner) {
      (CONFIG.excludePackages || []).forEach(function (n) {
        excluded[n] = true;
      });
    }

    names = names.filter(function (n) {
      return !excluded[n];
    });
    names.sort();
    return names;
  }

  /**
   * 单次加载（失败直接向上抛，由 load() 决定「自动重试」还是「报错」）。
   */
  function loadOnce(force) {
    var started = Date.now();
    state.loaded = false;
    state.search = {
      status: 'idle',
      keywords: searchKeywords(state.user),
      results: [],
      progress: '',
      error: '',
      fetchedAt: 0,
    };
    hideBanner();

    // ?user= 可能带来一个非法名字，先拦一道，给出可读提示（不抛错、不阻塞）
    if (!isValidUser(state.user)) {
      state.packages = [];
      state.daily = {};
      state.search.keywords = [];
      hideLoading();
      render();
      userError(userFormatError(state.user));
      return Promise.resolve();
    }

    showLoading('正在发现 @' + state.user + ' 的包…');

    return api
      .discoverPackages(state.user, { force: force })
      .then(function (discovered) {
        log('发现 ' + discovered.length + ' 个包（maintainer:' + state.user + '）');
        state.packages = mergePackages(discovered);
        if (!state.packages.length) {
          var emptyErr = new Error(
            'npm 用户 @' + state.user + ' 没有可统计的包：maintainer:' + state.user + ' 没有返回任何结果。' +
            (isOwner() ? '若确实有包，可在 config.js 的 extraPackages 里手动补充。' : '')
          );
          emptyErr.hint = '请检查用户名拼写；也可以直接在顶部输入框里换一个用户名。';
          throw emptyErr;
        }
        showLoading('正在读取包信息…（' + state.packages.length + ' 个）');
        return api.fetchPackagesMeta(state.packages, { force: force });
      })
      .then(function (metas) {
        state.metas = metas;

        var minDay = '';
        state.packages.forEach(function (name) {
          var created = metas[name] && metas[name].createdAt ? metas[name].createdAt.slice(0, 10) : '';
          if (!created) return;
          if (!minDay || created < minDay) minDay = created;
        });
        if (!minDay || minDay < FALLBACK_START) minDay = FALLBACK_START;

        state.minDay = minDay;
        // 数据上限 = 昨天：npm 不提供当天数据（range 会为今天补 0），详见 api.yesterdayISO()
        state.maxDay = api.yesterdayISO();
        if (state.maxDay < state.minDay) state.maxDay = state.minDay;

        showLoading('正在拉取下载量数据…');
        return api.fetchDownloadSeries(state.packages, state.minDay, state.maxDay, { force: force });
      })
      .then(function (result) {
        state.daily = Agg.buildDaily(result.series, state.packages);
        state.notIndexed = {};
        (result.notIndexed || []).forEach(function (name) {
          state.notIndexed[name] = true;
        });
        state.fetchedAt = result.fetchedAt;
        state.loaded = true;
        var nIdx = Object.keys(state.notIndexed);
        if (nIdx.length) log('未被下载量服务收录：' + nIdx.join(', '));
        log('拉取完成：' + state.minDay + ' ~ ' + state.maxDay + '，耗时 ' + (Date.now() - started) + 'ms' + (result.fromCache ? '（来自缓存）' : ''));
        hideLoading();
        render();
        warnIfHugeUser();
      })
      .catch(function (err) {
        hideLoading();
        render();
        throw err; // 由 load() 决定自动重试还是报错
      });
  }

  function showLoadError(err) {
    var detail = err && err.message ? err.message : String(err);
    if (err && err.pkg) detail += '（失败的包：' + err.pkg + '）';
    var hintText;
    if (err && err.hint) {
      hintText = err.hint;
    } else if (err && (err.status === 429 || err.likelyRateLimited)) {
      hintText =
        '这是 npm 接口限流：限流响应不带 CORS 头，浏览器只能报 “Failed to fetch”，所以看起来不像 429。' +
        '已拉到的分片都在本地缓存里，等 30~60 秒后点「重试」只会重拉失败的部分；包特别多的用户首次加载请求量大，更容易触发。';
    } else if (err && err.status == null) {
      hintText =
        '若为网络问题，请检查能否直接访问 registry.npmjs.org；也可先本地起服务：<code>python -m http.server</code>';
    } else {
      hintText = 'npm 接口返回了错误响应，可稍后点「重试」。';
    }
    showBanner(
      '<strong>数据加载失败：</strong>' + detail +
      '<div class="banner-actions"><button type="button" class="btn btn-sm" id="bannerRetry">重试</button>' +
      '<span class="hint">' + hintText + '</span></div>',
      'error'
    );
    var retry = document.getElementById('bannerRetry');
    if (retry) retry.addEventListener('click', function () { refresh(true); });
  }

  function sleepMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 带「一次自动重试」的加载。
   *
   * 为什么要自动重试：npm 的限流响应不带 CORS 头，浏览器无法区分它和网络故障；
   * 而每个时间分片（以及每个 scoped 包）都是独立缓存的，重试只会重拉失败的那部分，
   * 所以「等两秒再来一次」几乎总能补齐，比丢个报错让用户自己点更强。
   */
  function load(force) {
    var retried = false;

    function attempt() {
      return loadOnce(force).catch(function (err) {
        var transient =
          err && (err.likelyRateLimited || err.status === 429 || err.status == null || err.status >= 500);
        if (transient && !retried) {
          retried = true;
          log('首次加载失败（' + (err.message || err) + '），2.5 秒后自动重试一次');
          showLoading('部分请求被 npm 限流，正在自动重试…（已成功的分片不会重拉）');
          return sleepMs(2500).then(attempt);
        }
        throw err;
      });
    }

    return attempt().catch(showLoadError);
  }
  /** 包特别多的大用户：首次加载请求量大，提前说明可能被限流 */
  var LARGE_USER_WARN = 300;

  function warnIfHugeUser() {
    if (state.packages.length <= LARGE_USER_WARN) return;
    var jobs = api.buildSeriesJobs(
      state.packages,
      api.buildChunks(state.minDay, state.maxDay),
      CONFIG.batchSize
    );
    showBanner(
      '<strong>@' + esc(state.user) + ' 有 ' + state.packages.length + ' 个包</strong>，' +
      '本次约需 ' + (jobs.length + state.packages.length) + ' 个请求，可能被 npm 限流。' +
      '已经拉到的分片会缓存下来：若中途失败，等一会儿点「刷新」就能继续补齐（不会重头再拉）。<br />' +
      '<span class="hint">提示：npm 的批量接口不支持 scoped 包，每个 <code>@scope/</code> 包都得单独请求，' +
      '所以包多且以 scoped 为主时请求数会明显偏大。</span>',
      'warn'
    );
  }

  /* ------------------------------------------------------------------ *
   * 搜索排名加载（非阻塞：不阻断主看板渲染）
   * ------------------------------------------------------------------ */

  function loadSearchRanks(force) {
    var keywords = searchKeywords(state.user);
    state.search.keywords = keywords;
    state.search.results = [];
    state.search.error = '';

    if (!keywords.length) {
      state.search.status = 'idle';
      renderSearchPanel();
      return Promise.resolve([]);
    }

    state.search.status = 'loading';
    state.search.progress = '';
    renderSearchPanel();
    log('开始查询搜索排名：' + keywords.join('、'));

    return api
      .searchRanks(keywords, state.packages, {
        force: force,
        // 翻页很重，进度只体现在搜索面板里，不遮挡整个看板
        onProgress: function (keyword, scanned) {
          state.search.progress = '正在查询「' + keyword + '」：已扫描 ' + scanned + ' 条…';
          renderSearchPanel();
        },
      })
      .then(function (results) {
        state.search.results = results;
        state.search.status = 'ok';
        state.search.fetchedAt = Date.now();
        results.forEach(function (r) {
          if (r.error) {
            log('搜索排名 [' + r.keyword + '] 失败：' + r.error);
            return;
          }
          log(
            '搜索排名 [' + r.keyword + '] 共 ' + (r.total == null ? '?' : r.total) + ' 条结果，' +
            '扫描 ' + r.scanned + ' 条' +
            (r.complete ? '（已扫完）' : r.capped ? '（已达窗口上限 ' + r.limit + '）' : '（提前命中）') +
            (r.fromCache ? '，来自缓存' : '')
          );
        });
        renderSearchPanel();
        renderDebug();
        return results;
      })
      .catch(function (err) {
        state.search.status = 'error';
        state.search.error = (err && err.message) || String(err);
        log('搜索排名查询失败：' + state.search.error);
        renderSearchPanel();
        renderDebug();
        return [];
      });
  }

  /** 刷新一切：下载量主看板 + 搜索排名 */
  function refresh(force) {
    return load(force).then(function () {
      if (!state.loaded || !state.packages.length) return null;
      return loadSearchRanks(force);
    });
  }

  /* ------------------------------------------------------------------ *
   * 切换用户
   * ------------------------------------------------------------------ */

  /** 把当前用户写回地址栏（file:// 下 replaceState 可能不可用，失败忽略） */
  function syncUrl(user) {
    try {
      var url = new URL(window.location.href);
      if (user === ownerUser()) url.searchParams.delete('user');
      else url.searchParams.set('user', user);
      window.history.replaceState(null, '', url.toString());
    } catch (e) {
      /* ignore */
    }
  }

  function userError(html) {
    el.userInput.classList.add('invalid');
    showBanner(html, 'error');
    setTimeout(hideBanner, 6000);
  }

  function userFormatError(name) {
    return (
      '<strong>用户名格式不合法：</strong><code>' + esc(name) + '</code>　' +
      'npm 用户名只能包含小写字母、数字与 <code>-</code> <code>_</code> <code>.</code> <code>~</code>，' +
      '且不能以 <code>.</code> 或 <code>_</code> 开头（<code>@scope/name</code> 是包名、不是账号）。'
    );
  }

  /**
   * 切换统计对象。
   * @returns {false|Promise} 校验失败返回 false，否则返回重新加载的 Promise
   */
  function switchUser(raw) {
    var name = sanitizeUser(raw);

    if (!name) {
      userError('请输入一个 npm 用户名，例如 <code>sindresorhus</code>。');
      return false;
    }
    if (!isValidUser(name)) {
      userError(userFormatError(name));
      return false;
    }
    if (name === state.user) {
      el.userInput.classList.remove('invalid');
      showBanner('已经在查看 @' + esc(name) + ' 的数据了。', 'ok');
      setTimeout(hideBanner, 2000);
      return false;
    }

    state.user = name;
    state.hidden = {}; // 换个人之后，旧的「排除包」列表没有意义
    savePrefs();
    try {
      window.localStorage.setItem(USER_KEY, name);
    } catch (e) {
      /* ignore */
    }
    syncUrl(name);
    renderHeader();
    log('切换用户 → @' + name);

    return refresh(true).then(function () {
      if (state.loaded) log('已加载 @' + name + ' 的 ' + state.packages.length + ' 个包');
    });
  }

  /* ------------------------------------------------------------------ *
   * 窗口计算
   * ------------------------------------------------------------------ */

  function daysBetween(startISO, endISO) {
    return Math.round((api.parseISO(endISO).getTime() - api.parseISO(startISO).getTime()) / 86400000);
  }

  function clampWindow(w) {
    var start = w.start < state.minDay ? state.minDay : w.start;
    var end = w.end > state.maxDay ? state.maxDay : w.end;
    if (start > end) start = end;
    return { start: start, end: end };
  }

  function currentWindow() {
    return clampWindow(Agg.resolvePreset(state.rangePreset, state.minDay, state.maxDay));
  }

  function previousPeriod(startISO, endISO) {
    var len = daysBetween(startISO, endISO) + 1;
    var prevEnd = api.toISO(Agg.addDays(api.parseISO(startISO), -1));
    var prevStart = api.toISO(Agg.addDays(api.parseISO(startISO), -len));
    return { start: prevStart, end: prevEnd, available: prevStart >= state.minDay };
  }

  function previousYear(startISO, endISO) {
    var prevStart = String(Number(startISO.slice(0, 4)) - 1) + startISO.slice(4);
    var prevEnd = String(Number(endISO.slice(0, 4)) - 1) + endISO.slice(4);
    return { start: prevStart, end: prevEnd, available: prevStart >= state.minDay };
  }

  /**
   * 基于「当前选中区间」构造上下文。render() 与表头排序都走这里，保证口径一致。
   */
  function withCurrentWindow() {
    var ctx = buildWindows();
    var cur = clampWindow(currentWindow());
    ctx.window = currentWindow();
    ctx.sums.cur = Agg.sumWindow(state.daily, state.packages, cur.start, cur.end);
    ctx.sums.cur.start = cur.start;
    ctx.sums.cur.end = cur.end;
    return ctx;
  }

  function sumOf(w) {
    if (!w) return { total: 0, byPackage: {} };
    var c = clampWindow(w);
    return Agg.sumWindow(state.daily, state.packages, c.start, c.end);
  }

  /** 所有汇总窗口（锚点 = 最新可用的一天，也就是昨天） */
  function buildWindows() {
    var end = state.maxDay;
    var endDate = api.parseISO(end);
    var year = end.slice(0, 4);
    var month = end.slice(5, 7);

    function back(n) {
      return api.toISO(Agg.addDays(endDate, -n));
    }

    var wins = {
      // 不再有「今日」：npm 当天数据不提供，最新一天就是昨天
      yesterday: { start: end, end: end },
      d7: { start: back(6), end: end },
      d30: { start: back(29), end: end },
      month: { start: year + '-' + month + '-01', end: end },
      ytd: { start: year + '-01-01', end: end },
      all: { start: state.minDay, end: end },
    };

    var sums = {};
    Object.keys(wins).forEach(function (k) {
      sums[k] = sumOf(wins[k]);
    });

    sums.yesterday.prev = sumOf({ start: back(1), end: back(1) });
    var p7 = previousPeriod(wins.d7.start, wins.d7.end);
    var p30 = previousPeriod(wins.d30.start, wins.d30.end);
    var pm = previousPeriod(wins.month.start, wins.month.end);
    var py = previousYear(wins.ytd.start, wins.ytd.end);

    wins.d7.prev = p7;
    wins.d30.prev = p30;
    wins.month.prev = pm;
    wins.ytd.prev = py;

    sums.d7.prev = p7.available ? sumOf({ start: p7.start, end: p7.end }) : null;
    sums.d30.prev = p30.available ? sumOf({ start: p30.start, end: p30.end }) : null;
    sums.month.prev = pm.available ? sumOf({ start: pm.start, end: pm.end }) : null;
    sums.ytd.prev = py.available ? sumOf({ start: py.start, end: py.end }) : null;

    return { wins: wins, sums: sums };
  }

  /* ------------------------------------------------------------------ *
   * 渲染：汇总卡片
   * ------------------------------------------------------------------ */

  function deltaHtml(current, prev) {
    if (!prev) return '<span class="delta muted">—</span>';
    if (prev.total === 0) {
      return current > 0 ? '<span class="delta up">新增</span>' : '<span class="delta muted">—</span>';
    }
    var pct = ((current - prev.total) / prev.total) * 100;
    var cls = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
    var arrow = pct > 0.05 ? '↑' : pct < -0.05 ? '↓' : '→';
    return '<span class="delta ' + cls + '" title="对比上一周期 ' + Agg.formatNumber(prev.total) + '">' +
      arrow + ' ' + Math.abs(pct).toFixed(1) + '%</span>';
  }

  function renderCards(ctx) {
    var s = ctx.sums;
    var defs = [
      // 最新一天就是昨天：npm 不提供当天数据；昨天也可能到今天的某个时刻才刷出来，读到 0 就显示 0
      { key: 'yesterday', label: '昨日', value: s.yesterday.total, prev: s.yesterday.prev },
      { key: 'd7', label: '近 7 天', value: s.d7.total, prev: s.d7.prev },
      { key: 'd30', label: '近 30 天', value: s.d30.total, prev: s.d30.prev },
      { key: 'month', label: '本月', value: s.month.total, prev: s.month.prev },
      { key: 'ytd', label: '本年', value: s.ytd.total, prev: s.ytd.prev },
      { key: 'all', label: '累计', value: s.all.total, prev: null },
    ];

    el.cards.innerHTML = defs
      .map(function (d) {
        var compact = d.value >= 10000 ? '<span class="card-compact">≈ ' + Agg.formatCompact(d.value) + '</span>' : '';
        return (
          '<div class="card">' +
          '<div class="card-top"><span class="card-label">' + d.label + '</span>' + deltaHtml(d.value, d.prev) + '</div>' +
          '<div class="card-value" title="' + Agg.formatNumber(d.value) + '">' + Agg.formatNumber(d.value) + '</div>' +
          '<div class="card-foot">' + (d.note ? '<span class="card-note">' + d.note + '</span>' : '') + compact + '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * 渲染：包筛选 chips
   * ------------------------------------------------------------------ */

  function renderChips() {
    if (!state.packages.length) {
      el.chips.innerHTML = '';
      return;
    }
    var html = state.packages
      .map(function (name) {
        var off = !!state.hidden[name];
        var nIdx = !!state.notIndexed[name];
        return (
          '<button type="button" class="chip' + (off ? ' off' : '') + (nIdx ? ' not-indexed' : '') +
          '" data-pkg="' + name + '"' + (nIdx ? ' title="' + NOT_INDEXED_TIP + '"' : '') + '>' +
          '<span class="dot" style="background:' + colorFor(name) + '"></span>' +
          '<span class="chip-name">' + name + '</span>' +
          '</button>'
        );
      })
      .join('');
    html +=
      '<button type="button" class="chip chip-action" id="chipAll">全选</button>' +
      '<button type="button" class="chip chip-action" id="chipNone">全不选</button>';
    el.chips.innerHTML = html;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：趋势图
   * ------------------------------------------------------------------ */

  function visiblePackages() {
    return state.packages.filter(function (n) {
      return !state.hidden[n];
    });
  }

  function renderTrend(ctx) {
    var packages = visiblePackages();
    var w = ctx.window;
    var hint = w.start + ' ~ ' + w.end + ' · 共 ' + (daysBetween(w.start, w.end) + 1) + ' 天';

    if (!packages.length) {
      Charts.renderTrend(el.trendChart, { buckets: [], packages: [], type: state.chartType, showTotal: false });
      el.trendHint.textContent = '未选择任何包，请点击上方标签启用';
      return;
    }

    var buckets = Agg.aggregate(state.daily, packages, state.granularity, w.start, w.end);
    var total = buckets.reduce(function (a, b) {
      return a + b.total;
    }, 0);
    var unit = { day: '日', week: '周', month: '月', year: '年' }[state.granularity] || '日';

    el.trendHint.textContent =
      hint + ' · 按' + unit + '聚合共 ' + buckets.length + ' 个点 · 区间内共 ' +
      Agg.formatNumber(total) + ' 次下载';

    Charts.renderTrend(el.trendChart, {
      buckets: buckets,
      packages: packages,
      colors: packages.map(colorFor),
      type: state.chartType,
      showTotal: state.showTotal,
    });
  }

  /* ------------------------------------------------------------------ *
   * 渲染：占比 + 星期分布
   * ------------------------------------------------------------------ */

  function renderShare(ctx) {
    var packages = visiblePackages();
    var c = clampWindow(ctx.window);
    var sums = Agg.sumWindow(state.daily, packages, c.start, c.end);
    var items = packages
      .map(function (name) {
        return { name: name, value: sums.byPackage[name] || 0 };
      })
      .sort(function (a, b) {
        return b.value - a.value;
      });

    el.shareHint.textContent = c.start + ' ~ ' + c.end;
    Charts.renderShare(el.shareChart, {
      items: items,
      colors: items.map(function (i) {
        return colorFor(i.name);
      }),
    });
  }

  function renderDow(ctx) {
    var packages = visiblePackages();
    var c = clampWindow(ctx.window);
    var rows = Agg.dowDistribution(state.daily, packages, c.start, c.end);
    var accent = Charts.themeColors().accent;
    var weekend = '#f5a524';
    var colors = rows.map(function (r, i) {
      return i >= 5 ? weekend : accent;
    });
    Charts.renderDow(el.dowChart, { rows: rows, packages: packages, colors: colors });
  }

  /* ------------------------------------------------------------------ *
   * 渲染：搜索排名（npm 搜索接口的返回顺序）
   * ------------------------------------------------------------------ */

  function searchRankCell(result, name) {
    if (!result) return '<td class="num rank-cell"><span class="rank-none">—</span></td>';

    if (result.error) {
      return (
        '<td class="num rank-cell" title="' + esc(result.error) + '">' +
        '<span class="rank-none">失败</span></td>'
      );
    }

    var hit = null;
    (result.matched || []).some(function (m) {
      if (m.name === name) {
        hit = m;
        return true;
      }
      return false;
    });

    if (hit) {
      var tip =
        name + ' 在「' + result.keyword + '」中排第 ' + hit.rank + ' 名' +
        (result.total == null ? '' : '（共 ' + result.total + ' 条结果）') +
        (hit.final == null ? '' : '\nscore.final = ' + hit.final) +
        '\n该名次由 npm 搜索的相关度排序得出，与下载量排名不是一回事';
      return (
        '<td class="num rank-cell" title="' + esc(tip) + '">' +
        '<span class="rank-num' + (hit.rank <= 3 ? ' rank-top' : '') + '">' + hit.rank + '</span>' +
        (hit.final == null ? '' : '<span class="rank-score">' + hit.final.toFixed(1) + '</span>') +
        '</td>'
      );
    }

    if ((result.beyond || []).indexOf(name) >= 0) {
      return (
        '<td class="num rank-cell" title="npm 搜索接口只允许翻页到前 ' + result.limit +
        ' 名（from 再大就会静默回绕到第 1 页），所以无法得知具体名次">' +
        '<span class="rank-unknown">&gt; ' + result.limit + '</span></td>'
      );
    }

    return (
      '<td class="num rank-cell" title="扫描了「' + esc(result.keyword) + '」的全部结果，里面没有这个包">' +
      '<span class="rank-none">未出现</span></td>'
    );
  }

  function renderSearchPanel() {
    var s = state.search;
    var keywords = s.keywords || [];
    var badge =
      '<span class="badge-warn" title="' + NOT_INDEXED_TIP + '">未收录</span>';

    if (!keywords.length) {
      el.searchHead.innerHTML = '';
      el.searchBody.innerHTML =
        '<tr><td class="empty">' +
        (state.loaded && state.packages.length ? '未配置搜索关键词（config.js → searchKeywords）' : '暂无数据') +
        '</td></tr>';
      el.searchHint.textContent = '';
      el.searchNote.textContent = '';
      return;
    }

    el.searchHead.innerHTML =
      '<tr><th>包名</th>' +
      keywords
        .map(function (kw, i) {
          var r = s.results[i];
          var sub =
            r && !r.error && r.total != null
              ? '<span class="th-sub">共 ' + Agg.formatNumber(r.total) + ' 条</span>'
              : '';
          return '<th class="num">' + esc(kw) + sub + '</th>';
        })
        .join('') +
      '</tr>';

    var colspan = keywords.length + 1;

    if (s.status === 'loading' || (s.status === 'idle' && !state.loaded)) {
      el.searchBody.innerHTML =
        '<tr><td colspan="' + colspan + '" class="empty">' +
        (s.progress || (state.loaded ? '正在查询搜索排名…' : '等待下载量数据…')) +
        '<br /><span class="hint">每个关键词最多翻页到前 ' + api.searchWindow() + ' 名，结果缓存 ' +
        Math.round((CONFIG.searchCacheTTL || 0) / 3600000) + ' 小时</span></td></tr>';
    } else if (s.status === 'error' && !s.results.length) {
      el.searchBody.innerHTML =
        '<tr><td colspan="' + colspan + '" class="empty">搜索排名查询失败：' + esc(s.error) + '</td></tr>';
    } else if (!state.packages.length) {
      el.searchBody.innerHTML = '<tr><td colspan="' + colspan + '" class="empty">暂无数据</td></tr>';
    } else {
      el.searchBody.innerHTML = state.packages
        .map(function (name) {
          var off = state.hidden[name] ? ' class="row-off"' : '';
          var nIdx = !!state.notIndexed[name];
          return (
            '<tr' + off + '>' +
            '<td class="cell-name">' +
            '<span class="dot" style="background:' + colorFor(name) + '"></span>' +
            '<span class="name-text">' + esc(name) + '</span>' +
            (nIdx ? badge : '') +
            '</td>' +
            keywords
              .map(function (kw, i) {
                return searchRankCell(s.results[i], name);
              })
              .join('') +
            '</tr>'
          );
        })
        .join('');
    }

    var parts = [];
    var fetchedAt = 0;
    s.results.forEach(function (r) {
      if (!r || r.error) return;
      fetchedAt = Math.max(fetchedAt, r.fetchedAt || 0);
      var detail = r.complete
        ? '已扫完结果集'
        : r.capped
          ? '已到窗口上限（未命中的显示 > ' + r.limit + '）'
          : '已提前命中全部目标';
      parts.push(
        '「' + r.keyword + '」命中 ' + (r.matched || []).length + '/' + state.packages.length +
        '，扫描 ' + r.scanned + ' 条，' + detail + (r.fromCache ? '（缓存）' : '')
      );
    });
    el.searchHint.textContent =
      parts.join('　·　') +
      (fetchedAt ? '　·　更新于 ' + new Date(fetchedAt).toLocaleTimeString('zh-CN') : '');

    el.searchNote.innerHTML =
      '名次 = npm registry 搜索接口(' + '<code>/-/v1/search</code>)的返回顺序，按 <code>score.final</code> 排序，' +
      '<strong>不是</strong>下载量排序 —— 同一个包在不同关键词下名次完全不同；' +
      '该接口只允许翻页到前 ' + api.searchWindow() + ' 名，超出显示「&gt; 上限」，结果集中不存在的包显示「未出现」。';
  }

  /* ------------------------------------------------------------------ *
   * 渲染：明细表
   * ------------------------------------------------------------------ */

  /** 数值单元格：未收录的包不显示 0，而显示「—」并附提示 */
  function numCell(value, extraClass, notIndexed) {
    if (notIndexed) {
      return '<td class="num not-indexed" title="' + NOT_INDEXED_TIP + '">—</td>';
    }
    return (
      '<td class="num' + (extraClass ? ' ' + extraClass : '') + '">' +
      Agg.formatNumber(value) +
      '</td>'
    );
  }

  function renderTable(ctx) {
    var s = ctx.sums;

    var rows = state.packages.map(function (name) {
      var meta = state.metas[name] || {};
      return {
        name: name,
        version: meta.latestVersion || '',
        window: s.cur.byPackage[name] || 0,
        yesterday: s.yesterday.byPackage[name] || 0,
        week: s.d7.byPackage[name] || 0,
        month: s.d30.byPackage[name] || 0,
        ytd: s.ytd.byPackage[name] || 0,
        total: s.all.byPackage[name] || 0,
        share: s.cur.total ? ((s.cur.byPackage[name] || 0) / s.cur.total) * 100 : 0,
      };
    });

    var key = state.sortKey;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });

    el.pkgTableBody.innerHTML = rows
      .map(function (r) {
        var off = state.hidden[r.name] ? ' class="row-off"' : '';
        var nIdx = !!state.notIndexed[r.name];
        var badge = nIdx
          ? '<span class="badge-warn" title="' + NOT_INDEXED_TIP + '">未收录</span>'
          : '';
        return (
          '<tr' + off + '>' +
          '<td class="cell-name">' +
          '<span class="dot" style="background:' + colorFor(r.name) + '"></span>' +
          '<span class="name-text">' + r.name + '</span>' +
          (r.version ? '<span class="ver">v' + r.version + '</span>' : '') +
          badge +
          '</td>' +
          numCell(r.window, 'strong', nIdx) +
          '<td class="num' + (nIdx ? ' not-indexed' : '') + '"' + (nIdx ? ' title="' + NOT_INDEXED_TIP + '"' : '') + '>' +
          (nIdx || !r.share ? '—' : r.share.toFixed(1) + '%') +
          '</td>' +
          numCell(r.yesterday, '', nIdx) +
          numCell(r.week, '', nIdx) +
          numCell(r.month, '', nIdx) +
          numCell(r.ytd, '', nIdx) +
          numCell(r.total, 'strong', nIdx) +
          '<td><a class="link" href="https://www.npmjs.com/package/' + encodeURIComponent(r.name) + '" target="_blank" rel="noopener">npm ↗</a></td>' +
          '</tr>'
        );
      })
      .join('');

    var totals = {
      window: s.cur.total, yesterday: s.yesterday.total,
      week: s.d7.total, month: s.d30.total, ytd: s.ytd.total, total: s.all.total,
    };
    var totalLabel = '合计（' + rows.length + ' 个包';
    var nIdxNames = state.packages.filter(function (n) {
      return state.notIndexed[n];
    });
    if (nIdxNames.length) totalLabel += '，其中 ' + nIdxNames.length + ' 个未收录';
    totalLabel += '）';

    el.pkgTableFoot.innerHTML =
      '<tr>' +
      '<td>' + totalLabel + '</td>' +
      '<td class="num strong">' + Agg.formatNumber(totals.window) + '</td>' +
      '<td class="num">100%</td>' +
      '<td class="num">' + Agg.formatNumber(totals.yesterday) + '</td>' +
      '<td class="num">' + Agg.formatNumber(totals.week) + '</td>' +
      '<td class="num">' + Agg.formatNumber(totals.month) + '</td>' +
      '<td class="num">' + Agg.formatNumber(totals.ytd) + '</td>' +
      '<td class="num strong">' + Agg.formatNumber(totals.total) + '</td>' +
      '<td></td>' +
      '</tr>';

    el.tableHint.textContent =
      '「区间内」= 当前所选区间（' + s.cur.start + ' ~ ' + s.cur.end + '），点击表头可排序' +
      (nIdxNames.length
        ? '　·　' + nIdxNames.join('、') + '：npm 下载量服务尚未收录，显示「—」而非 0（新包一般需 24~48 小时）'
        : '');

    var ths = document.querySelectorAll('#pkgTable th.sortable');
    Array.prototype.forEach.call(ths, function (th) {
      th.classList.toggle('sort-asc', th.getAttribute('data-sort') === key && state.sortDir === 'asc');
      th.classList.toggle('sort-desc', th.getAttribute('data-sort') === key && state.sortDir === 'desc');
    });
  }

  /* ------------------------------------------------------------------ *
   * 渲染：顶部信息 / 调试
   * ------------------------------------------------------------------ */

  function renderHeader() {
    el.userInput.value = state.user;
    el.userInput.title = '当前用户 @' + state.user + '　·　输入别的 npm 用户名并回车（或点「切换」）即可查看他的包';
    el.userInput.classList.toggle('invalid', !!state.user && !isValidUser(state.user));
    el.userInput.setAttribute('aria-busy', state.loaded ? 'false' : 'true');
    el.pkgCount.textContent = state.packages.length + ' 个包';
    el.dataRange.textContent = state.minDay + ' ~ ' + state.maxDay;
    el.updatedAt.textContent = state.fetchedAt ? new Date(state.fetchedAt).toLocaleString('zh-CN') : '—';

    var s = buildWindows().sums;
    document.title = state.loaded
      ? 'npm 下载量统计 · @' + state.user + ' · ' + Agg.formatNumber(s.all.total) + ' 次下载'
      : 'npm 下载量统计 · @' + state.user;

    el.chkTotal.checked = state.showTotal;
    setSegmentActive(el.segGranularity, state.granularity);
    setSegmentActive(el.segRange, state.rangePreset);
    setSegmentActive(el.segType, state.chartType);
  }

  function renderDebug() {
    if (el.debugBox.classList.contains('hidden')) return;
    var lines = [];
    lines.push('用户: @' + state.user + (isOwner() ? '（默认用户）' : '（由 ?user= 或本地记忆切换，默认用户为 @' + ownerUser() + '）'));
    lines.push('包 (' + state.packages.length + '): ' + state.packages.join(', '));
    lines.push('数据范围: ' + state.minDay + ' ~ ' + state.maxDay);
    lines.push('更新于: ' + new Date(state.fetchedAt).toLocaleString('zh-CN'));
    lines.push('缓存 TTL: ' + CONFIG.cacheTTL / 60000 + ' 分钟');
    lines.push('');
    lines.push('—— 包元信息 ——');
    state.packages.forEach(function (n) {
      var m = state.metas[n] || {};
      lines.push(
        n + '  created=' + (m.createdAt || '?').slice(0, 10) +
        '  latest=v' + (m.latestVersion || '?') +
        '  versions=' + (m.versionCount == null ? '?' : m.versionCount)
      );
    });
    lines.push('');
    lines.push('—— 搜索排名 ——');
    lines.push('关键词 (' + state.search.keywords.length + '): ' + (state.search.keywords.join(' | ') || '(无)'));
    lines.push('状态: ' + state.search.status +
      '  窗口上限: 前 ' + api.searchWindow() + ' 名' +
      '  单页: ' + api.searchPageSize() + ' 条' +
      '  缓存: ' + Math.round((CONFIG.searchCacheTTL || 0) / 3600000) + ' 小时' +
      (state.search.error ? '  错误: ' + state.search.error : ''));
    (state.search.results || []).forEach(function (r) {
      if (r.error) {
        lines.push('  [' + r.keyword + '] 请求失败: ' + r.error);
        return;
      }
      lines.push(
        '  [' + r.keyword + '] total=' + (r.total == null ? '?' : r.total) +
        ' scanned=' + r.scanned +
        (r.complete ? ' (已扫完)' : r.capped ? ' (达窗口上限)' : ' (提前命中)') +
        (r.fromCache ? ' [缓存]' : '') +
        ' 命中=' + (r.matched || []).length + '/' + state.packages.length
      );
      (r.matched || []).forEach(function (m) {
        lines.push('      #' + m.rank + '  ' + m.name + '  score.final=' + (m.final == null ? '?' : m.final));
      });
      (r.beyond || []).forEach(function (n) {
        lines.push('      >' + r.limit + '  ' + n);
      });
      (r.absent || []).forEach(function (n) {
        lines.push('      未出现  ' + n);
      });
    });
    lines.push('');
    lines.push('—— 加载日志 ——');
    lines.push.apply(lines, state.log);
    el.debugBox.textContent = lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 主渲染
   * ------------------------------------------------------------------ */

  /** 空表格里的提示文案 */
  function emptyMessage() {
    if (state.loaded && !state.packages.length) return '没有找到 @' + esc(state.user) + ' 的 npm 包';
    return '暂无数据';
  }

  function render() {
    applyTheme();
    renderHeader();
    renderChips();

    if (!state.loaded) {
      Charts.disposeAll();
      state.notIndexed = {};
      el.cards.innerHTML = '';
      el.trendHint.textContent = '';
      el.shareHint.textContent = '';
      el.tableHint.textContent = '';
      el.pkgTableBody.innerHTML = '<tr><td colspan="9" class="empty">' + emptyMessage() + '</td></tr>';
      el.pkgTableFoot.innerHTML = '';
      renderSearchPanel();
      renderDebug();
      return;
    }

    var ctx = withCurrentWindow();

    renderCards(ctx);
    renderTrend(ctx);
    renderShare(ctx);
    renderDow(ctx);
    renderTable(ctx);
    renderSearchPanel();
    renderDebug();
    Charts.resize();
  }

  /* ------------------------------------------------------------------ *
   * 主题
   * ------------------------------------------------------------------ */

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolvedTheme() {
    if (state.theme === 'auto') return media && media.matches ? 'dark' : 'light';
    return state.theme;
  }

  function applyTheme() {
    var resolved = resolvedTheme();
    document.documentElement.setAttribute('data-theme', resolved);
    var isAuto = state.theme === 'auto';
    el.btnTheme.textContent = isAuto ? '◐' : resolved === 'dark' ? '☾' : '☀';
    el.btnTheme.title =
      '当前主题：' + (isAuto ? '跟随系统' : resolved === 'dark' ? '深色' : '浅色') +
      '（' + resolved + '）· 点击循环切换 跟随系统 / 浅色 / 深色';
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  function bindEvents() {
    el.userForm.addEventListener('submit', function (e) {
      e.preventDefault();
      switchUser(el.userInput.value);
    });

    el.userInput.addEventListener('input', function () {
      el.userInput.classList.remove('invalid');
    });

    el.userInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        el.userInput.value = state.user;
        el.userInput.classList.remove('invalid');
        el.userInput.blur();
      }
    });

    el.btnRefresh.addEventListener('click', function () {
      refresh(true);
    });

    el.btnTheme.addEventListener('click', function () {
      state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
      savePrefs();
      if (state.loaded) render();
      else applyTheme();
    });

    if (media && media.addEventListener) {
      media.addEventListener('change', function () {
        if (state.theme === 'auto' && state.loaded) render();
        else applyTheme();
      });
    }

    el.chkTotal.addEventListener('change', function () {
      state.showTotal = el.chkTotal.checked;
      savePrefs();
      if (state.loaded) render();
    });

    function bindSegment(container, key, cast) {
      container.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-value]');
        if (!btn) return;
        var value = btn.getAttribute('data-value');
        state[key] = cast ? cast(value) : value;
        savePrefs();
        setSegmentActive(container, value);
        if (state.loaded) render();
      });
    }

    bindSegment(el.segGranularity, 'granularity');
    bindSegment(el.segRange, 'rangePreset');
    bindSegment(el.segType, 'chartType');

    el.chips.addEventListener('click', function (e) {
      var action = e.target.closest('.chip-action');
      if (action) {
        var none = action.id === 'chipNone';
        state.hidden = {};
        state.packages.forEach(function (n) {
          if (none) state.hidden[n] = true;
        });
        savePrefs();
        if (state.loaded) render();
        return;
      }
      var chip = e.target.closest('.chip[data-pkg]');
      if (!chip) return;
      var name = chip.getAttribute('data-pkg');
      if (state.hidden[name]) delete state.hidden[name];
      else state.hidden[name] = true;
      savePrefs();
      if (state.loaded) render();
    });

    document.querySelectorAll('#pkgTable th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sortKey === key) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        else {
          state.sortKey = key;
          state.sortDir = key === 'name' ? 'asc' : 'desc';
        }
        if (state.loaded) renderTable(buildWindowsWithCur());
      });
    });

    el.btnCopy.addEventListener('click', function () {
      var text = tableToTSV();
      if (!text) return;
      var done = function () {
        var old = el.btnCopy.textContent;
        el.btnCopy.textContent = '已复制 ✓';
        setTimeout(function () {
          el.btnCopy.textContent = old;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    });

    el.btnClearCache.addEventListener('click', function () {
      var n = api.cacheClearAll();
      showBanner('已清空 ' + n + ' 项本地缓存，点击左上角「刷新」可重新拉取数据。', 'ok');
      setTimeout(hideBanner, 3000);
    });

    el.btnToggleDebug.addEventListener('click', function () {
      el.debugBox.classList.toggle('hidden');
      renderDebug();
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(Charts.resize, 120);
    });
  }

  function buildWindowsWithCur() {
    return withCurrentWindow();
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      showBanner('复制失败，请手动选择表格内容。', 'error');
      setTimeout(hideBanner, 3000);
    }
    document.body.removeChild(ta);
  }

  function tableToTSV() {
    var table = document.getElementById('pkgTable');
    if (!table) return '';
    var lines = [];
    Array.prototype.forEach.call(table.querySelectorAll('tr'), function (tr) {
      var cells = Array.prototype.map.call(tr.children, function (cell) {
        var text = cell.innerText != null ? cell.innerText : cell.textContent;
        return text.replace(/\s+/g, ' ').trim();
      });
      lines.push(cells.join('\t'));
    });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  loadPrefs();
  bindEvents();
  applyTheme();
  render();
  refresh(false);
})();
