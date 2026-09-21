/**
 * npm 公开接口封装（全部支持 CORS，可直接前端调用）
 *
 *  - 包发现：https://registry.npmjs.org/-/v1/search?text=maintainer:<user>
 *  - 包元信息：https://registry.npmjs.org/<pkg>            （取 time.created 作为起始日）
 *  - 下载量：https://api.npmjs.org/downloads/range/<start>:<end>/<pkg,pkg>
 *
 * 注意：range 接口单次请求超过 18 个月会被「静默截断」，必须分片请求后合并。
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
            throw err;
          }
          return res.json();
        })
        .catch(function (err) {
          var retriable = err.status == null || err.status === 429 || err.status >= 500;
          if (attempt < maxAttempts && retriable) {
            return sleep(400 * Math.pow(2, attempt - 1)).then(once);
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

  /** 请求一个分片（多包批量），返回 { pkg: { 'YYYY-MM-DD': n } } */
  function fetchChunk(packages, chunk, options) {
    options = options || {};
    var cacheKey = 'chunk:' + hash(packages.join('|')) + ':' + chunk.start + ':' + chunk.end;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.cacheTTL);
      if (cached) return Promise.resolve(cached);
    }

    var url =
      'https://api.npmjs.org/downloads/range/' +
      chunk.start + ':' + chunk.end + '/' +
      encodePackages(packages);

    return fetchJSON(url).then(
      function (json) {
        var out = {};
        packages.forEach(function (name) {
          out[name] = {};
        });

        // 多包批量：{ pkg: { downloads: [...], ... } }
        if (json && json.downloads && typeof json.downloads.length === 'number' && json.package) {
          (json.downloads || []).forEach(function (row) {
            out[json.package][row.day] = row.downloads || 0;
          });
        } else if (json && typeof json === 'object') {
          // 单包：{ start, end, package, downloads: [...] }
          packages.forEach(function (name) {
            var entry = json[name];
            if (!entry || !entry.downloads) return;
            entry.downloads.forEach(function (row) {
              out[name][row.day] = row.downloads || 0;
            });
          });
        }

        cacheSet(cacheKey, out);
        return out;
      },
      function (err) {
        // 批量请求失败（例如其中某个包不存在），退化为逐包请求
        if (packages.length <= 1) throw err;
        return mapLimit(packages, CONFIG.maxConcurrent, function (name) {
          return fetchChunk([name], chunk, options).catch(function () {
            var empty = {};
            empty[name] = {};
            return empty;
          });
        }).then(function (parts) {
          var merged = {};
          parts.forEach(function (part) {
            Object.keys(part).forEach(function (k) {
              merged[k] = Object.assign(merged[k] || {}, part[k]);
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
   * @returns Promise<{ series: {pkg:{day:n}}, start, end, fetchedAt, fromCache }>
   */
  function fetchDownloadSeries(packages, startISO, endISO, options) {
    options = options || {};
    if (!packages.length) {
      return Promise.resolve({ series: {}, start: startISO, end: endISO, fetchedAt: Date.now() });
    }

    var cacheKey = 'series:' + hash(packages.join('|')) + ':' + startISO + ':' + endISO;
    if (!options.force) {
      var cached = cacheGet(cacheKey, CONFIG.cacheTTL);
      if (cached) {
        cached.fromCache = true;
        return Promise.resolve(cached);
      }
    }

    var chunks = buildChunks(startISO, endISO);

    return mapLimit(chunks, Math.min(CONFIG.maxConcurrent, 3), function (chunk) {
      return fetchChunk(packages, chunk, options).then(function (part) {
        return { chunk: chunk, part: part };
      });
    }).then(function (parts) {
      var series = {};
      packages.forEach(function (name) {
        series[name] = {};
      });

      parts.forEach(function (item) {
        Object.keys(item.part).forEach(function (name) {
          if (!series[name]) series[name] = {};
          var dayMap = item.part[name];
          Object.keys(dayMap).forEach(function (day) {
            // 同一天可能被相邻分片重复覆盖，取较大值即可（分片不重叠，正常不会发生）
            if (series[name][day] == null) series[name][day] = dayMap[day];
          });
        });
      });

      var result = {
        series: series,
        start: startISO,
        end: endISO,
        fetchedAt: Date.now(),
        fromCache: false,
      };
      cacheSet(cacheKey, result);
      return result;
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
    cacheGet: cacheGet,
    cacheSet: cacheSet,
    cacheClearAll: cacheClearAll,
  };
})(window);
