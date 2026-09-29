/**
 * 全局配置 —— 需要调整统计口径时只改这个文件。
 */
window.APP_CONFIG = {
  /** npm 用户名（用于自动发现包：maintainer:<username>） */
  username: 'ducaoya',

  /** 搜索接口查不到、或非本人 maintainer 但想统计的包，手动补充在此 */
  extraPackages: [
    // 'some-package-name',
  ],

  /** 不想统计的包（优先级高于自动发现） */
  excludePackages: [
    // 'unwanted-package',
  ],

  /** 是否只统计本人为 maintainer 的包（关闭后 extraPackages 仍生效） */
  autoDiscover: true,

  /** 本地缓存有效期（毫秒），默认 30 分钟 */
  cacheTTL: 30 * 60 * 1000,

  /** 包列表 + 发布时间的缓存有效期（毫秒），默认 6 小时 */
  metaCacheTTL: 6 * 60 * 60 * 1000,

  /**
   * 下载量区间接口的分片天数。
   *
   * 取 365 是因为**批量**（多包）range 查询有硬上限：实测 `end - start` 超过 365 天会直接返回
   * `400 {"error":"exceeded max days of 365 for bulk query"}`，而且错误响应不带 CORS 头，
   * 浏览器里只能看到 “Failed to fetch”、拿不到状态码。
   *
   * 单包 range 的窗口更大（约 547 天，超过则静默丢弃最早的数据），所以 365 对两种情形都安全。
   */
  chunkDays: 365,

  /**
   * 单次批量下载量请求里最多放多少个包（npm 上限 128，这里留余量）。
   * 包多的大用户（如上干个包）必须分批，否则 URL 过长被拒。
   *
   * 无需配置：scoped 包（@scope/name）会被自动拆成单包请求，因为 npm 的批量接口不支持它们
   * （实测 `400 scoped packages are not currently supported in bulk lookups`）。
   */
  batchSize: 100,

  /** 并发请求上限，避免被限流 */
  maxConcurrent: 4,

  /** 单个请求的最大重试次数 */
  retries: 3,

  /**
   * 搜索排名关键词。每个关键词会用 registry 搜索接口翻页扫描，定位自己包的名次。
   *
   * 留空（[]）时自动退化为 ['maintainer:<username>']，即「在自己所有包里的搜索名次」。
   * 建议只放「窄查询」：包名片段、maintainer:xxx、keywords:xxx。
   * 泛关键词（如 figma）基本查不到自己的包，名次会显示为「> 上限」或「未出现」。
   */
  searchKeywords: [
    // 'maintainer:ducaoya',
    // 'sse-viewer',
  ],

  /**
   * 搜索排名最多扫描到第几名。
   *
   * npm 搜索接口的硬限制：from 超过 5000 会「静默回绕到第 1 页」而不是报错，
   * 因此这里上限 5000，超出的包如实显示「> 5000」，不伪造名次。
   */
  searchMaxRank: 5000,

  /** 搜索排名每页条数（npm 上限 250，代码内会自行夹紧） */
  searchPageSize: 250,

  /** 搜索排名缓存有效期（毫秒），默认 12 小时（排名变化慢，且翻页请求较重） */
  searchCacheTTL: 12 * 60 * 60 * 1000,

  /**
   * Cloudflare Web Analytics 站点 token（可选）。
   *
   * 留空（默认）= 不加载任何第三方脚本，页面完全自包含。
   * 填上 token 后，页面底部会注入 Cloudflare 官方探针统计访问量。
   *
   * 获取：Cloudflare 控制台 → Web Analytics → Add a site →
   *   hostname 填 `npm-downloads-stats.ducaoya.workers.dev` →
   *   复制 JS 片段里 data-cf-beacon 的 "token" 值粘到这里。
   * 详见 README「访问统计」一节。
   */
  webAnalyticsToken: '',

  /** 默认时间粒度：day | week | month | year */
  defaultGranularity: 'day',

  /** 默认区间预设：7d | 30d | 90d | 365d | ytd | all */
  defaultRange: '30d',

  /** 主题：auto | light | dark */
  defaultTheme: 'auto',
};
