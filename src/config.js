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

  /** 下载量区间接口单次最多覆盖 18 个月，这里用 500 天分片规避静默截断 */
  chunkDays: 500,

  /** 并发请求上限，避免被限流 */
  maxConcurrent: 4,

  /** 单个请求的最大重试次数 */
  retries: 3,

  /** 默认时间粒度：day | week | month | year */
  defaultGranularity: 'day',

  /** 默认区间预设：7d | 30d | 90d | 365d | ytd | all */
  defaultRange: '30d',

  /** 主题：auto | light | dark */
  defaultTheme: 'auto',
};
