/**
 * npm 公开接口封装（全部支持 CORS，可直接前端调用）
 *
 *  - 包发现：https://registry.npmjs.org/-/v1/search?text=maintainer:<user>
 *  - 包元信息：https://registry.npmjs.org/<pkg>            （取 time.created 作为起始日）
 *  - 下载量：https://api.npmjs.org/downloads/range/<start>:<end>/<pkg,pkg>
 *
 * 两个必须知道的上限（均已实测）：
 *   1. 批量（多包）range 查询：end - start 超过 365 天直接 400
 *      "exceeded max days of 365 for bulk query"；
 *   2. 单包 range 查询：窗口最多约 547 天，超过会静默丢弃最早的数据。
 * 而且错误响应（400 等）**不带 CORS 头**，浏览器里只能看到 “Failed to fetch”，
 * 读不到状态码 —— 所以请求层把「读不到状态」当作可重试，并在批量失败后退化为逐包请求。
 */
(function (global) {
  'use strict';

  var CONFIG = global.APP_CONFIG;
  var CACHE_PREFIX = 'npmdl:cache:';

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function toISO(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function parseISO(str) {
    var p = String(str).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function todayISO() {
    return toISO(new Date());
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** 稳定的短哈希，用于生成缓存 key */
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /* ------------------------------------------------------------------ *
   * localStorage 缓存
   * ------------------------------------------------------------------ */

  function cacheGet(key, ttl) {
    try {
      var raw = global.localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var item = JSON.parse(raw);
      if (!item || typeof item.t !== 'number') return null;
      if (ttl && Date.now() - item.t > ttl) return null;
      return item.v;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value) {
    try {
      global.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      /* 配额不足等场景直接忽略 */
    }
  }

  function cacheClearAll() {
    try {
      var keys = [];
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) {
        global.localStorage.removeItem(k);
      });
      return keys.length;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 带重试的 JSON 请求
   * ------------------------------------------------------------------ */

  function fetchJSON(url, options) {
    options = options || {};
    var maxAttempts = options.retries == null ? CONFIG.retries : options.retries;
    var attempt = 0;

    function once() {
      attempt++;
      return fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'default',
        mode: 'cors',
      })
        .then(function (res) {
          if (!res.ok) {
            var err = new Error('HTTP ' + res.status + ' ' + res.statusText + ' — ' + url);
            err.status = res.status;
            err.url = url;
            var retryAfter = res.headers && res.headers.get ? Number(res.headers.get('retry-after')) : 0;
            if (retryAfter > 0) err.retryAfter = retryAfter;
            throw err;
          }
          return res.json();
        })
        .catch(function (err) {
          // 浏览器只能对「网络层失败」抛出 TypeError（读不到状态码与响应体）。
          // 实测 npm 下载量接口被限流时返回的响应**不带 CORS 头**，
          // 于是 429 在控制台里看起来也像 CORS / Failed to fetch。
          // 这里标注一下，便于上层给出「限流而非网络故障」的提示。
          if (err && err.status == null && err.name === 'TypeError') {
            err.likelyRateLimited = true;
            err.message = '请求被中断：浏览器读不到响应（常见原因是 npm 接口限流——限流响应不带 CORS 头）— ' + url;
          }
          var retriable = err.status == null || err.status === 429 || err.status >= 500;
          if (attempt < maxAttempts && retriable) {
            var wait = 400 * Math.pow(2, attempt - 1);
            // 限流退避更久一些，并优先尊重服务端的 Retry-After
            if (err.status === 429 || err.likelyRateLimited) wait = Math.max(wait, 1500 * attempt);
            if (err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
            return sleep(wait).then(once);
          }
          throw err;
        });
    }

    return once();
  }

  /** 并发受限的 map */
  function mapLimit(items, limit, worker) {
    var list = items.slice();
    var results = new Array(list.length);
    var index = 0;
    var active = 0;

    return new Promise(function (resolve, reject) {
      if (!list.length) return resolve(results);
      var failed = false;

      function next() {
        if (failed) return;
        if (index >= list.length && active === 0) return resolve(results);
        while (active < limit && index < list.length) {
          (function (i) {
            active++;
            worker(list[i], i)
              .then(function (value) {
                results[i] = value;
                active--;
                next();
              })
              .catch(function (err) {
                failed = true;
                reject(err);
              });
          })(index++);
        }
      }

      next();
    });
  }

  /* ------------------------------------------------------------------ *
   * 1. 发现包
   * ------------------------------------------------------------------ */

  function discoverPackages(username, options) {
    options = options || {};
    var cacheKey = 'discover:' + username;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.metaCacheTTL);
      if (cached) return Promise.resolve(cached);
    }

    var size = 250;
    var from = 0;
    var collected = [];

    function page() {
      var url =
        'https://registry.npmjs.org/-/v1/search?text=' +
        encodeURIComponent('maintainer:' + username) +
        '&size=' + size + '&from=' + from;

      return fetchJSON(url).then(function (json) {
        var objects = json.objects || [];
        objects.forEach(function (o) {
          var p = o.package || {};
          if (!p.name) return;
          collected.push({
            name: p.name,
            version: p.version || '',
            description: p.description || '',
            latestPublish: p.date || '',
            homepage: (p.links && (p.links.homepage || p.links.npm)) || '',
            repository: (p.links && p.links.repository) || '',
            weekly: (o.downloads && o.downloads.weekly) || 0,
            monthly: (o.downloads && o.downloads.monthly) || 0,
          });
        });

        var total = typeof json.total === 'number' ? json.total : collected.length;
        if (objects.length === size && collected.length < total) {
          from += size;
          return page();
        }
        return collected;
      });
    }

    return page().then(function (list) {
      list.sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      cacheSet(cacheKey, list);
      return list;
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. 包元信息（首次发布日期）
   * ------------------------------------------------------------------ */

  function fetchPackageMeta(name, options) {
    options = options || {};
    var cacheKey = 'meta:' + name;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.metaCacheTTL);
      if (cached) return Promise.resolve(cached);
    }

    return fetchJSON('https://registry.npmjs.org/' + encodeURIComponent(name).replace(/%2F/g, '/')).then(function (json) {
      var time = json.time || {};
      var versions = Object.keys(time).filter(function (k) {
        return k !== 'created' && k !== 'modified';
      });
      var meta = {
        name: json.name || name,
        createdAt: time.created || '',
        modifiedAt: time.modified || '',
        versionCount: versions.length,
        latestVersion: (json['dist-tags'] && json['dist-tags'].latest) || '',
        license: json.license || '',
        description: json.description || '',
        homepage: json.homepage || '',
        repository: (json.repository && json.repository.url) || '',
      };
      cacheSet(cacheKey, meta);
      return meta;
    });
  }

  function fetchPackagesMeta(names, options) {
    options = options || {};
    var cacheKey = 'metas:' + hash(names.join('|'));
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.metaCacheTTL);
      if (cached) return Promise.resolve(cached);
    }

    return mapLimit(names, CONFIG.maxConcurrent, function (name) {
      return fetchPackageMeta(name, options).catch(function () {
        return { name: name, createdAt: '', failed: true };
      });
    }).then(function (metas) {
      var map = {};
      metas.forEach(function (m) {
        map[m.name] = m;
      });
      cacheSet(cacheKey, map);
      return map;
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. 下载量区间数据
   * ------------------------------------------------------------------ */

  /** 把 [start, end] 按 chunkDays 切成若干片 */
  function buildChunks(startISO, endISO) {
    var chunks = [];
    var start = parseISO(startISO);
    var end = parseISO(endISO);
    var cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      var chunkEnd = addDays(cursor, CONFIG.chunkDays - 1);
      if (chunkEnd.getTime() > end.getTime()) chunkEnd = new Date(end.getTime());
      chunks.push({ start: toISO(cursor), end: toISO(chunkEnd) });
      cursor = addDays(chunkEnd, 1);
    }
    return chunks;
  }

  function encodePackages(packages) {
    return packages
      .map(function (n) {
        return encodeURIComponent(n);
      })
      .join(',');
  }

  /**
   * 把包列表切成若干批。
   *
   * npm 的批量下载量接口一次最多接受 128 个包名，而且包名是全拼在 URL 里的；
   * 那种上千个包的用户如果不分批，请求会因 URL 过长直接被拒。
   */
  function splitPackages(packages, size) {
    var n = size && size > 0 ? size : 100;
    var out = [];
    for (var i = 0; i < packages.length; i += n) {
      out.push(packages.slice(i, i + n));
    }
    return out;
  }

  /**
   * 构造「时间分片 × 包分组」的下载量作业列表。
   *
   * npm 的批量 range 接口有两条硬限制，均已实测，且报错时都是
   * 400 + **不带 CORS 头**（浏览器只能看到 “Failed to fetch”，拿不到状态码）：
   *
   *   - 超过 365 天：`exceeded max days of 365 for bulk query`
   *   - 包含 scoped 包：`scoped packages are not currently supported in bulk lookups`
   *
   * 所以 scoped 包（@scope/name）一律走单包请求 —— 单包接口既支持 scoped，
   * 也允许更长的窗口。为了口径统一，这里仍然让它们复用同一套时间分片。
   */
  function buildSeriesJobs(packages, chunks, batchSize) {
    var plain = [];
    var scoped = [];
    packages.forEach(function (name) {
      if (name.charAt(0) === '@') scoped.push(name);
      else plain.push(name);
    });

    var groups = splitPackages(plain, batchSize);
    scoped.forEach(function (name) {
      groups.push([name]);
    });

    var jobs = [];
    chunks.forEach(function (chunk) {
      groups.forEach(function (group) {
        jobs.push({ chunk: chunk, packages: group });
      });
    });
    return jobs;
  }

  /**
   * 请求一个分片（多包批量）。
   *
   * 返回 { data: { pkg: { 'YYYY-MM-DD': n } }, notIndexed: [pkg] }。
   *
   * npm 对「下载量服务尚未收录的包」有两种表现，都必须识别出来：
   *   - 批量请求：HTTP 200，该包对应值为 null（不是错误对象）
   *   - 单包请求：HTTP 404 + { "error": "package xxx not found" }
   * 这种情况和「已收录但下载量为 0」不同（后者会正常返回一串 0）。
   */
  function fetchChunk(packages, chunk, options) {
    options = options || {};
    var cacheKey = 'chunk:v3:' + hash(packages.join('|')) + ':' + chunk.start + ':' + chunk.end;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.cacheTTL);
      if (cached) return Promise.resolve(cached);
    }

    function emptyResult(names) {
      var result = { data: {}, notIndexed: [] };
      names.forEach(function (name) {
        result.data[name] = {};
      });
      return result;
    }

    function fillFromSeries(target, name, rows) {
      (rows || []).forEach(function (row) {
        target[name][row.day] = row.downloads || 0;
      });
    }

    var url =
      'https://api.npmjs.org/downloads/range/' +
      chunk.start + ':' + chunk.end + '/' +
      encodePackages(packages);

    return fetchJSON(url).then(
      function (json) {
        var result = emptyResult(packages);

        // 形态一：单包（指定单个包名时）→ { start, end, package, downloads: [...] }
        if (json && json.downloads && typeof json.downloads.length === 'number' && json.package) {
          fillFromSeries(result.data, json.package, json.downloads);
          cacheSet(cacheKey, result);
          return result;
        }

        // 形态二：多包批量 → { pkg1: {...}|null, pkg2: {...}|null }
        if (json && typeof json === 'object') {
          packages.forEach(function (name) {
            var entry = json[name];
            if (!entry) {
              // null（或字段缺失）= 下载量服务未收录
              result.notIndexed.push(name);
              return;
            }
            if (entry.error) {
              result.notIndexed.push(name);
              return;
            }
            if (!entry.downloads) return;
            fillFromSeries(result.data, name, entry.downloads);
          });
        }

        cacheSet(cacheKey, result);
        return result;
      },
      function (err) {
        // 单包 404 就是「未收录」，属于正常情况，不应当让整个页面加载失败
        if (packages.length <= 1) {
          if (err.status === 404) {
            var alone = emptyResult(packages);
            alone.notIndexed.push(packages[0]);
            cacheSet(cacheKey, alone);
            return alone;
          }
          throw err;
        }

        // 批量失败（限流 / 5xx 等）：退化为逐包请求。
        //
        // 关键：单个包的请求再失败时**必须抛出**，不能退化成「全是 0」——
        // 否则页面会把「没取到」冒充成「真的 0 下载」，正是本项目要避免的误导。
        // 抛弃部分失败后，成功的分片已经写入缓存，重试只会重拉失败的那一片。
        return mapLimit(packages, Math.min(CONFIG.maxConcurrent, 2), function (name) {
          return fetchChunk([name], chunk, options).then(
            function (part) {
              return part;
            },
            function (err) {
              err.pkg = name;
              throw err;
            }
          );
        }).then(function (parts) {
          var merged = emptyResult(packages);
          parts.forEach(function (part) {
            Object.keys(part.data).forEach(function (name) {
              merged.data[name] = Object.assign(merged.data[name] || {}, part.data[name]);
            });
            part.notIndexed.forEach(function (name) {
              if (merged.notIndexed.indexOf(name) < 0) merged.notIndexed.push(name);
            });
          });
          cacheSet(cacheKey, merged);
          return merged;
        });
      }
    );
  }

  /**
   * 拉取 [startISO, endISO] 区间内所有包的逐日下载量。
   * @returns Promise<{ series: {pkg:{day:n}}, notIndexed: string[], start, end, fetchedAt, fromCache }>
   */
  function fetchDownloadSeries(packages, startISO, endISO, options) {
    options = options || {};
    if (!packages.length) {
      return Promise.resolve({ series: {}, notIndexed: [], start: startISO, end: endISO, fetchedAt: Date.now() });
    }

    var cacheKey = 'series:v3:' + hash(packages.join('|')) + ':' + startISO + ':' + endISO;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.cacheTTL);
      if (cached) {
        cached.fromCache = true;
        return Promise.resolve(cached);
      }
    }

    var chunks = buildChunks(startISO, endISO);
    var jobs = buildSeriesJobs(packages, chunks, CONFIG.batchSize);

    // 下载量请求最容易碰到限流，并发比其它接口更低（大用户的作业数可能上百个）
    return mapLimit(jobs, Math.min(CONFIG.maxConcurrent, 2), function (job) {
      return fetchChunk(job.packages, job.chunk, options).then(function (part) {
        return { chunk: job.chunk, part: part };
      });
    }).then(function (parts) {
      var series = {};
      var notIndexed = [];
      packages.forEach(function (name) {
        series[name] = {};
      });

      parts.forEach(function (item) {
        Object.keys(item.part.data).forEach(function (name) {
          if (!series[name]) series[name] = {};
          var dayMap = item.part.data[name];
          Object.keys(dayMap).forEach(function (day) {
            // 分片互不重叠，正常不会重复；万一重复，先到先得
            if (series[name][day] == null) series[name][day] = dayMap[day];
          });
        });
        item.part.notIndexed.forEach(function (name) {
          if (notIndexed.indexOf(name) < 0) notIndexed.push(name);
        });
      });

      var result = {
        series: series,
        notIndexed: notIndexed,
        start: startISO,
        end: endISO,
        fetchedAt: Date.now(),
        fromCache: false,
      };
      cacheSet(cacheKey, result);
      return result;
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. 搜索排名
   *
   * npm 搜索接口（registry.npmjs.org/-/v1/search）支持 CORS，可以前端直连，
   * 但有两个必须知道的事实（均已实测）：
   *
   *   1. 排序由 score.final 决定（相关度 × 热度混合分），**不是下载量排序**，
   *      也不是一个绝对值 —— 同一个包在不同关键词下名次完全不同。
   *   2. size 上限 250；from 超过 5000 时服务端会「静默回绕到第 1 页」
   *      （实测 from=5000 正常，from=5050 返回的又是第 1 页），且不会报错。
   *
   * 所以本模块把扫描窗口夹在 from + size ≤ searchMaxRank 内，扫不到就如实标注
   * 「超出上限 / 未出现」，绝不伪造名次。
   * ------------------------------------------------------------------ */

  function searchPageSize() {
    var size = CONFIG.searchPageSize || 250;
    if (size > 250) size = 250; // npm 上限
    if (size < 10) size = 10;
    return size;
  }

  function searchWindow() {
    var max = CONFIG.searchMaxRank || 5000;
    if (max > 5000) max = 5000; // 回绕边界
    if (max < 250) max = 250;
    return max;
  }

  /** 把搜索接口返回的一条结果压成扁平结构 */
  function normalizeHit(obj, rank) {
    var p = (obj && obj.package) || {};
    var score = (obj && obj.score) || {};
    var detail = score.detail || {};
    var dl = (obj && obj.downloads) || {};
    function num(v) {
      return typeof v === 'number' ? v : null;
    }
    return {
      name: p.name || '',
      version: p.version || '',
      rank: rank,
      final: num(score.final),
      popularity: num(detail.popularity),
      quality: num(detail.quality),
      maintenance: num(detail.maintenance),
      // 仅作参考：项目文档已说明搜索接口的 downloads 字段与 point 接口可能不一致，
      // 页面上展示的下载量一律取自 point / range 接口。
      weekly: num(dl.weekly),
      monthly: num(dl.monthly),
    };
  }

  /** 缓存是否还能用：扫到末尾 / 撞到窗口上限的结论是稳定的 */
  function searchCacheReusable(payload, targets) {
    if (!payload || !payload.found || typeof payload.scanned !== 'number') return false;
    if (payload.complete || payload.capped) return true;
    // 提前收工时，只有「当前目标全部都在缓存里」才可复用（否则可能新增了包）
    return targets.every(function (name) {
      return !!payload.found[name];
    });
  }

  /** 把扫描结果整理成「命中 / 未出现 / 超出上限」三类 */
  function finalizeSearch(payload, targets, fromCache) {
    var matched = [];
    var absent = [];
    var beyond = [];

    targets.forEach(function (name) {
      var hit = payload.found[name];
      if (hit) {
        matched.push(hit);
      } else if (payload.complete) {
        // 已经扫完该关键词的全部结果，说明确实不在里面
        absent.push(name);
      } else {
        // 扫描窗口已到顶（npm 只允许前 5000 名）
        beyond.push(name);
      }
    });

    matched.sort(function (a, b) {
      return a.rank - b.rank;
    });

    return {
      keyword: payload.keyword,
      total: payload.total,
      scanned: payload.scanned,
      limit: payload.limit,
      complete: !!payload.complete,
      capped: !!payload.capped,
      matched: matched,
      absent: absent,
      beyond: beyond,
      fetchedAt: payload.fetchedAt || Date.now(),
      fromCache: !!fromCache,
    };
  }

  /**
   * 在单个关键词下定位目标包的搜索名次。
   *
   * @param {string} keyword 搜索词（如 maintinaer:xxx / sse-viewer / keywords:cli）
   * @param {string[]} targets 目标包名
   * @param {{force?:boolean,onProgress?:function(string,number,number)}} [options]
   * @returns Promise<{keyword,total,scanned,limit,complete,capped,matched,absent,beyond,fetchedAt,fromCache}>
   */
  function searchRank(keyword, targets, options) {
    options = options || {};
    var list = (targets || []).filter(Boolean);
    if (!keyword || !list.length) {
      return Promise.resolve({
        keyword: keyword, total: null, scanned: 0, limit: searchWindow(),
        complete: true, capped: false, matched: [], absent: list.slice(), beyond: [],
        fetchedAt: Date.now(), fromCache: false,
      });
    }

    var size = searchPageSize();
    var maxRank = searchWindow();
    var maxFrom = maxRank - size > 0 ? maxRank - size : 0;
    var cacheKey = 'search:v1:' + hash(String(keyword).toLowerCase());

    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.searchCacheTTL);
      if (cached && searchCacheReusable(cached, list)) {
        return Promise.resolve(finalizeSearch(cached, list, true));
      }
    }

    var found = {};
    var scanned = 0;
    var total = null;
    var complete = false;
    var capped = false;
    var from = 0;

    function page() {
      var url =
        'https://registry.npmjs.org/-/v1/search?text=' +
        encodeURIComponent(keyword) + '&size=' + size + '&from=' + from;

      return fetchJSON(url).then(function (json) {
        var objects = (json && json.objects) || [];
        if (total == null) {
          total = typeof json.total === 'number' ? json.total : null;
        }

        objects.forEach(function (obj, i) {
          var hit = normalizeHit(obj, from + i + 1);
          if (!hit.name) return;
          scanned++;
          if (found[hit.name]) return;
          if (list.indexOf(hit.name) >= 0) found[hit.name] = hit;
        });

        var missing = list.filter(function (name) {
          return !found[name];
        });

        if (objects.length < size) {
          // 短页 = 结果集到底了
          complete = true;
          return;
        }
        if (!missing.length) {
          // 目标全部找到，提前收工，省掉后面的翻页
          return;
        }
        if (from >= maxFrom) {
          // 已到 npm 允许的最大窗口（from 再大就会静默回绕到第 1 页）
          capped = true;
          return;
        }

        from += size;
        if (typeof options.onProgress === 'function') {
          options.onProgress(keyword, scanned, total);
        }
        return page();
      });
    }

    return page().then(function () {
      var payload = {
        keyword: keyword,
        total: total,
        scanned: scanned,
        limit: maxRank,
        complete: complete,
        capped: capped,
        found: found,
        fetchedAt: Date.now(),
      };
      cacheSet(cacheKey, payload);
      return finalizeSearch(payload, list, false);
    });
  }

  /** 批量关键词（并发 2，单个关键词失败不影响其它） */
  function searchRanks(keywords, targets, options) {
    options = options || {};
    var list = (keywords || []).filter(Boolean);
    return mapLimit(list, Math.min(CONFIG.maxConcurrent, 2), function (keyword) {
      return searchRank(keyword, targets, options).catch(function (err) {
        return {
          keyword: keyword,
          total: null,
          scanned: 0,
          limit: searchWindow(),
          complete: false,
          capped: false,
          matched: [],
          absent: [],
          beyond: [],
          fetchedAt: Date.now(),
          fromCache: false,
          error: (err && err.message) || String(err),
        };
      });
    });
  }

  global.NpmApi = {
    toISO: toISO,
    parseISO: parseISO,
    addDays: addDays,
    todayISO: todayISO,
    hash: hash,
    fetchJSON: fetchJSON,
    mapLimit: mapLimit,
    discoverPackages: discoverPackages,
    fetchPackageMeta: fetchPackageMeta,
    fetchPackagesMeta: fetchPackagesMeta,
    fetchDownloadSeries: fetchDownloadSeries,
    buildChunks: buildChunks,
    splitPackages: splitPackages,
    buildSeriesJobs: buildSeriesJobs,
    searchRank: searchRank,
    searchRanks: searchRanks,
    searchPageSize: searchPageSize,
    searchWindow: searchWindow,
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    cacheClearAll: cacheClearAll,
  };
})(window);
