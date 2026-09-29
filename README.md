# npm 下载量统计看板

一个**零依赖、零构建的纯静态**页面：读取 npm 官方公开接口，统计某个 npm 用户所有包的下载量，并按 **日 / 周 / 月 / 年** 四种粒度可视化。

默认统计 `@ducaoya` 的包，开箱即用。**任何人打开页面都能在顶部直接换成自己的 npm 用户名**，看到的就是自己的数据。

## 特性

- **纯静态**：原生 HTML/CSS/JS，无 npm 依赖、无构建步骤、无后端，双击 `index.html` 即可运行
- **换用户名即可用**：顶部 `@` 输入框输入任意 npm 用户名并回车，即切到该用户的看板；地址栏会带上 `?user=<名字>`，**链接可直接分享给他人**；优先级 `?user=` > 本地记忆 > `config.js` 里的 `username`
- **图表**：ECharts 本地内置（`vendor/echarts.min.js`），不依赖任何 CDN
- **四种时间粒度**：日 / 周（ISO 周，周一起算）/ 月 / 年，可自由切换时间区间（7 天 / 30 天 / 90 天 / 1 年 / 今年 / 全部）
- **多维视图**：堆叠柱 / 堆叠面积 / 折线三种趋势图、各包占比环形图、星期分布图、包明细表格（所有列可排序）
- **搜索排名（可选）**：读取 npm 搜索接口的返回顺序，展示在每个关键词下排第几；超出接口窗口显示 `> 5000`、结果集里没有则显示「未出现」，不伪造名次
- **汇总指标**：今日 / 昨日 / 近 7 天 / 近 30 天 / 本月 / 本年 / 累计，并带环比涨跌
- **按包筛选**：点击包标签即可从图表中排除某个包，颜色保持不变
- **深色 / 浅色主题**：跟随系统、也可手动切换
- **本地缓存**：结果缓存在 localStorage（默认 30 分钟），避免频繁请求公开接口；支持一键清空
- **自动发现新包**：每次打开都会重新查询 `maintainer:<用户名>`，新发布的包自动出现
- **区分「未收录」与「0 下载」**：npm 下载量服务尚未收录的新包会标记为「未收录」并显示 `—`，不冒充 0
- **SEO / AI 搜索友好**：`robots.txt` / `sitemap.xml` / `llms.txt` + JSON-LD 结构化描述 + 不依赖 JS 的「这是什么 / 怎么用」静态区块（见下文）

## 用法

| 场景 | 方式 |
| --- | --- |
| 看默认用户 | 直接打开首页 |
| 看任意用户 | 顶部 `@` 输入框填用户名 → 回车（或点「切换」） |
| 分享某个用户的看板 | 切换后直接复制地址栏（形如 `/?user=sindresorhus`） |
| 回到默认用户 | 刷新页面并清掉 `?user=` 参数（如点左上角 logo 地址） |
- **按包筛选**：点击包标签即可从图表中排除某个包，颜色保持不变
- **深色 / 浅色主题**：跟随系统、也可手动切换
- **本地缓存**：结果缓存在 localStorage（默认 30 分钟），避免频繁请求公开接口；支持一键清空
- **自动发现新包**：每次打开都会重新查询 `maintainer:<用户名>`，新发布的包自动出现
- **区分「未收录」与「0 下载」**：npm 下载量服务尚未收录的新包会标记为「未收录」并显示 `—`，不冒充 0

## 快速开始

三种方式，任选其一：

```bash
# 1. 最简单：直接双击 index.html
#    npm 公开接口允许跨域（Access-Control-Allow-Origin: *），file:// 下同样可用

# 2. 起个本地服务（Windows）
双击 start.bat

# 3. 手动起服务
python -m http.server 5173        # 然后访问 http://localhost:5173/
npx -y http-server -p 5173 -c-1 . # 或者用 node
```

## 配置

全部配置集中在 `src/config.js`：

| 字段 | 说明 |
| --- | --- |
| `username` | **默认** npm 用户名（页面上可随时换成别人）；用于 `maintainer:<username>` 自动发现包 |
| `extraPackages` | 手动补充的包（搜索索引查不到、或不是本人 maintainer 的包）。**只对 `username` 本人生效** |
| `excludePackages` | 排除的包。**只对 `username` 本人生效** |
| `autoDiscover` | 关闭后只统计 `extraPackages`。**只对 `username` 本人生效** |
| `cacheTTL` | 下载量缓存时长，默认 30 分钟 |
| `metaCacheTTL` | 包列表 / 元信息缓存时长，默认 6 小时 |
| `chunkDays` | 区间请求分片天数，默认 365（**批量接口硬上限就是 365 天**，超过会 400，见下文） |
| `batchSize` | 单次批量下载量请求里最多放多少个包，默认 100（npm 上限 128；上千个包的用户必须分批） |
| `maxConcurrent` | 并发请求上限 |
| `searchKeywords` | 搜索排名关键词（仅默认用户生效；其他人自动用 `maintainer:<自己>`）。只适合窄查询（包名片段 / `maintainer:` / `keywords:`） |
| `searchMaxRank` | 搜索排名最多扫描到第几名，默认 5000（npm 硬上限，见下文） |
| `searchPageSize` | 搜索排名每页条数，默认 250（npm 上限，代码内会夹紧） |
| `searchCacheTTL` | 搜索排名缓存时长，默认 12 小时（排名变化慢，且翻页请求较重） |
| `defaultGranularity` / `defaultRange` / `defaultTheme` | 默认粒度 / 区间 / 主题 |

> 为什么 `extraPackages` / `excludePackages` / `autoDiscover` / `searchKeywords` 只对默认用户生效：
> 它们是「站点主人自己的口径」。否则别人切进来时会看到你的手动补充包，或者在你配置的关键词下找他的包，结果必然是错的。

## 数据来源（全部为公开接口）

| 用途 | 接口 |
| --- | --- |
| 发现包 | `https://registry.npmjs.org/-/v1/search?text=maintainer:<user>&size=250&from=0` |
| 包元信息 | `https://registry.npmjs.org/<pkg>`（取 `time.created` 作为起始日期） |
| 下载量 | `https://api.npmjs.org/downloads/range/{start}:{end}/{pkg1,pkg2,...}` |
| 交叉校验 | `https://api.npmjs.org/downloads/point/{start}:{end}/{pkg}` |
| 搜索排名（可选） | `https://registry.npmjs.org/-/v1/search?text=<关键词>&size=250&from=N` |

必须知道的坑（均已实测）：

1. **`range` 有两条上限，行为完全不同**：
   - **批量（多包）查询**：`end - start` 最多 **365 天**，超过直接返回
     `400 {"error":"exceeded max days of 365 for bulk query"}`；
   - **单包查询**：窗口最多约 **547 天**，超过则**静默丢弃最早的数据**
     （实测请求 548 天时，返回的 `start` 被自动前移到次日），不报错。

   所以本项目的 `chunkDays` 取 **365**（对两种情形都安全）。这件事直接影响性能与成功率：
   分片一旦超过 365 天，批量请求会全部 400，只能靠「逐包回退」拿数据——数字仍然是对的，
   但请求量会翻好几倍、更容易被限流。
2. **当日数据次日才统计完整**。当天访问通常得到 0，页面已标注「统计中」。
3. **刚发布的包**未被下载量服务收录时，接口有两种表现：单包请求返回 `404`，批量请求返回 `null`。
   这和「已收录但下载量为 0」是两回事——判别方法：查询一个已收录包在它**发布之前**的区间，会正常返回
   `{"downloads":0}` 而不是报错。页面把前一种情况标记为「未收录」并显示 `—`，不冒充 0。
   npm 的下载量是**每天 UTC 午夜后跑一次批处理**汇总的，新包一般需要 **24~48 小时**才会出现。
4. **搜索接口的 `downloads` 字段不可信**：实测某包在搜索索引里 `weekly=0`，而 `point` 接口同一周是 `546`。
   本项目所有数字都取自 `point` / `range` 接口，**没有**使用搜索接口的下载量字段。
5. **搜索接口的翻页有硬上限**：`from` 超过 `5000` 时服务端会**静默回绕到第 1 页**（实测 `from=5000` 正常、`from=5050` 返回的又是第 1 页），同样不报错。
   所以「搜索排名」最多只能解析出前 5000 名，超出的一律显示 `> 5000`，不会伪造名次；搜索名次由 `score.final`（相关度 × 热度）排序决定，
   **不等于下载量排名**，同一个包换个关键词名次就完全不同。
6. **失败不能退化成「0 下载」**：批量 `range` 请求失败（限流 / 5xx）时会退化为逐包请求，早期版本在单包也失败时静默记 0，
   把「没取到」冒充成「真的 0 下载」。现在单包再失败会直接抛出并在页面上报错提示重试；
   已成功的分片保留在缓存里，重试只会重拉失败的那部分。
7. **npm 的错误响应不带 CORS 头**：批量超限（400）、限流等情况下，响应缺少 `Access-Control-Allow-Origin`，
   浏览器只能抛出 `TypeError: Failed to fetch`，**根本拿不到状态码**（`Access-Control-Allow-Origin` 本身也不在 JS 可读的响应头白名单里）。
   因此代码把「读不到状态」当作可重试的瞬时失败，并在批量失败后自动退化为逐包请求；页面提示也会写清楚「可能是限流」，而不是丢一句莫名的 Failed to fetch。
8. **批量接口不支持 scoped 包**：包名带 `@scope/` 时，批量 `range` 查询会返回
   `400 {"error":"scoped packages are not currently supported in bulk lookups"}`；单包查询则完全正常（`@scope%2Fname`）。
   本项目会自动把 scoped 包拆成单包请求（单包窗口更大，但为了口径统一仍复用同一套分片）。
9. **请求量大的用户会被限流**：一次性统计上千个包的用户需要上千个请求，可能撞上 npm 的限流
（实测返回 `429 error code: 1015`，同样不带 CORS 头）。因此：
   - 超过 300 个包的用户会在页面上收到「请求量较大」的预提醒（含请求数估算）；
   - 下载量请求的并发降到 2，限流时**自动重试一次**——分片各自独立缓存，所以重试只会重拉失败的部分；
   - 仍失败时不会假装成功，而是报错 + 提供重试。已成功的分片留在缓存里，多刷几次可逐步补齐。

## 数据校验

内置校验脚本（Node 18+，无依赖），会复跑前端同一套数据管线，并用 `point` 接口**逐分片**交叉验证本地聚合结果：

```bash
node tools/verify-data.js
```

覆盖内容：分片无重叠/无空隙且 `end - start ≤ 365` 天（**并逐个分片用真实「批量」接口复测，防止再踩 400 那个坑**）、
包分批不丢不重、**scoped 包不进批量请求**、日期轴连续无缺口、每个包的本地聚合值 == 服务端求和值、
「未收录」包的识别正确且不会误判正常包、四种粒度总数守恒、星期分布守恒，
以及搜索排名口径：命中全部包且名次是 `1..N` 不重复序列、查不到时归入「未出现」、
撞到窗口上限时如实标注而非伪造名次、二次调用命中缓存。
（接口限流 429 会被单独计为「跳过」，不会污染数据正确性的结论。）

最近一次运行结果：**52 项通过 / 0 项失败**。

## 部署到 Cloudflare

仓库里已经放好了 `wrangler.jsonc`，**不需要任何构建步骤**。两条路任选其一。

### 方式 A：Workers + Git 集成（推荐，push 自动部署）

在控制台 **Workers & Pages → Create → Workers 标签 → Connect to Git** 中这样填：

| 字段 | 值 |
| --- | --- |
| 仓库 | `ducaoya/npm-downloads-stats` |
| 项目名称 | `npm-downloads-stats`（**必须与 `wrangler.jsonc` 里的 `name` 完全一致**） |
| 构建命令 | 留空 |
| 部署命令 | `npx wrangler deploy` |
| 非生产分支构建 | 按需（勾选后 PR 也会生成预览） |

点「部署」，成功后地址形如 `https://npm-downloads-stats.<你的账号子域>.workers.dev`。
之后每次 push 到 `main` 都会自动重新部署。

> **为什么必须要 `wrangler.jsonc`**：`wrangler deploy` 得知道「部署什么」。纯静态仓库没有 Worker 脚本，
> 就必须用 `assets.directory` 指明静态资源目录，否则直接报
> `Missing entry-point to Worker script or to assets directory`。
> Cloudflare 目前**不会**自动推断资源目录（[workers-sdk#10563](https://github.com/cloudflare/workers-sdk/issues/10563) 仍是 open）。

### 方式 B：本地 wrangler 直传（无需 Git）

```bash
npx wrangler login
npx wrangler deploy          # 读取 wrangler.jsonc，上传当前目录下的静态资源
npx wrangler deploy --dry-run # 只校验配置、不上传
```

### 方式 C：Cloudflare Pages（备选）

Pages 同样可用（功能已冻结但未废弃）。在 **Workers & Pages → Create → Pages 标签 → Connect to Git** 中填：

| 字段 | 值 |
| --- | --- |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `/` |

这种路径下 `wrangler.jsonc` 不会被用到，可忽略。

### 哪些文件会被上传

仓库内的 `.assetsignore`（语法同 `.gitignore`）已排除 `.git`、`LICENSE`、`README.md`、`start.bat`、`tools/` 等非站点文件，
实际对外只有约 10 个文件（页面 + `src/*` + `vendor/echarts.min.js`）。

`_headers` **不会**被当作静态文件提供，而是由平台解析后用于设置响应头（官方行为）；仓库内的 `_headers`
已配好缓存策略（`vendor/*` 强缓存 1 年、`src/*` 5 分钟）。本地以 `file://` 打开时该文件不生效，无副作用。

## 隐私说明

- 页面运行时**只**访问 `registry.npmjs.org` 与 `api.npmjs.org` 两个公开接口，无任何第三方 CDN、字体、埋点或统计脚本；ECharts 已本地内置。
- **不设置任何 Cookie**，不采集访客信息；仅在浏览器 localStorage 写入缓存与界面偏好（`npmdl:cache:*`、`npmdl:prefs`）以及你切换过的用户名（`npmdl:user`）。
- 切换用户时用户名会写进地址栏（`?user=`），这是为了方便你把链接分享给别人；它只存在你的浏览器里，不会发送到本站以外的任何地方（请求 npm 接口时才会用到它）。
- 仓库内唯一身份信息是 npm 用户名 `ducaoya`（本就是 npmjs.com 上的公开信息）。代码不读取、不存储 npm 接口返回的维护者邮箱字段。
- 部署后，访客浏览器会直接向 npm 官方域名发起请求（npm 可见访客 IP），这与直接访问 npmjs.com 无异。
- 「诊断信息」面板展示的包名/版本/发布日期均为 npm 上的公开数据。

## 目录结构

```
.
├── index.html            # 页面骨架（含 SEO 元信息、JSON-LD、静态说明区块）
├── robots.txt            # 爬虫规则（含 AI 抓取器显式允许）+ Sitemap 指向
├── sitemap.xml           # 站点地图（⚠️ 内含写死的域名，换域名要改）
├── llms.txt              # 给 AI / LLM 检索用的站点说明（llmstxt.org 约定）
├── wrangler.jsonc        # Cloudflare Workers 静态资源部署配置
├── .assetsignore         # 部署时排除的非站点文件
├── _headers              # 响应头 / 缓存策略（由 Cloudflare 解析，不作为文件提供）
├── start.bat             # Windows 一键起本地服务
├── src/
│   ├── config.js         # 配置（默认用户名、手动补充包、缓存时长、搜索关键词等）
│   ├── api.js            # npm 接口封装：包发现、18 个月分片、包分批、并发控制、缓存、搜索排名
│   ├── aggregate.js      # 日 → 周 / 月 / 年 聚合、星期分布、区间求和
│   ├── charts.js         # ECharts 渲染（随主题自动换色）
│   ├── main.js           # 状态管理、用户切换与交互
│   └── style.css         # 样式（深色 / 浅色）
├── tools/
│   └── verify-data.js    # 数据正确性校验脚本
└── vendor/
    └── echarts.min.js    # 本地内置的 ECharts 5.5.1
```

## SEO 与 AI 搜索

面向搜索引擎与 LLM 抓取器准备了四份东西：

| 文件 / 位置 | 作用 |
| --- | --- |
| `robots.txt` | 允许全部爬虫，并显式列出 GPTBot / ClaudeBot / PerplexityBot / Google-Extended 等；末尾指向 Sitemap |
| `sitemap.xml` | 站点地图（单页应用只需首页 + `llms.txt` 两条） |
| `llms.txt` | [llmstxt.org](https://llmstxt.org/) 约定的站点摘要：能回答什么、怎么调用、数据来源、**已知限制**（尤其是「不要把未收录误读成 0 下载」「搜索名次不是下载量排名」） |
| `index.html` | `canonical` / `og:*` / `twitter:*` / `theme-color` / `WebApplication` JSON-LD，并在页面底部保留一个**不依赖 JS** 的「这是什么 / 怎么用」区块（含 FAQ），让不执行 JS 的抓取器也能读到实质内容 |

> ⚠️ **换域名必改**：`sitemap.xml`、`index.html` 的 `canonical` / `og:url` / JSON-LD `url`、`llms.txt` / `robots.txt` 里的链接都写死了
> `https://npm-downloads-stats.ducaoya.workers.dev/`。如果你 fork 后部署到自己的域名，全局搜这个字符串替换即可。
>
> 页面是 JS 渲染的，LLM 抓取器多数不执行 JS，因此**优先抓 `llms.txt`** 比抓页面更划算。

## License

MIT
