# npm 下载量统计看板

一个**零依赖、零构建的纯静态**页面：读取 npm 官方公开接口，统计某个 npm 用户所有包的下载量，并按 **日 / 周 / 月 / 年** 四种粒度可视化。

默认统计 `@ducaoya` 的包，开箱即用。

## 特性

- **纯静态**：原生 HTML/CSS/JS，无 npm 依赖、无构建步骤、无后端，双击 `index.html` 即可运行
- **图表**：ECharts 本地内置（`vendor/echarts.min.js`），不依赖任何 CDN
- **四种时间粒度**：日 / 周（ISO 周，周一起算）/ 月 / 年，可自由切换时间区间（7 天 / 30 天 / 90 天 / 1 年 / 今年 / 全部）
- **多维视图**：堆叠柱 / 堆叠面积 / 折线三种趋势图、各包占比环形图、星期分布图、包明细表格（所有列可排序）
- **汇总指标**：今日 / 昨日 / 近 7 天 / 近 30 天 / 本月 / 本年 / 累计，并带环比涨跌
- **按包筛选**：点击包标签即可从图表中排除某个包，颜色保持不变
- **深色 / 浅色主题**：跟随系统、也可手动切换
- **本地缓存**：结果缓存在 localStorage（默认 30 分钟），避免频繁请求公开接口；支持一键清空
- **自动发现新包**：每次打开都会重新查询 `maintainer:<用户名>`，新发布的包自动出现

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
| `username` | npm 用户名，用于 `maintainer:<username>` 自动发现包 |
| `extraPackages` | 手动补充的包（搜索索引查不到、或不是本人 maintainer 的包） |
| `excludePackages` | 排除的包 |
| `autoDiscover` | 关闭后只统计 `extraPackages` |
| `cacheTTL` | 下载量缓存时长，默认 30 分钟 |
| `metaCacheTTL` | 包列表 / 元信息缓存时长，默认 6 小时 |
| `chunkDays` | 区间请求分片天数，默认 500（**不要超过 548**，见下文） |
| `maxConcurrent` | 并发请求上限 |
| `defaultGranularity` / `defaultRange` / `defaultTheme` | 默认粒度 / 区间 / 主题 |

## 数据来源（全部为公开接口）

| 用途 | 接口 |
| --- | --- |
| 发现包 | `https://registry.npmjs.org/-/v1/search?text=maintainer:<user>&size=250&from=0` |
| 包元信息 | `https://registry.npmjs.org/<pkg>`（取 `time.created` 作为起始日期） |
| 下载量 | `https://api.npmjs.org/downloads/range/{start}:{end}/{pkg1,pkg2,...}` |
| 交叉校验 | `https://api.npmjs.org/downloads/point/{start}:{end}/{pkg}` |

三个必须知道的坑：

1. **`range` 与 `point` 接口都会把超过 18 个月的区间静默截断**。
   例如请求 `2022-12-27:2026-09-21`，服务端只返回 `2025-03-21` 之后的数据，**不会报错**。
   本项目的做法是把区间切成 ≤ 500 天的分片请求后合并（`chunkDays`），这是数字准确的关键。
2. **当日数据次日才统计完整**。当天访问通常得到 0，页面已标注「统计中」。
3. **刚发布的包**下载量服务可能尚未收录（`point` 接口返回 404），此时按 0 处理。

## 数据校验

内置校验脚本（Node 18+，无依赖），会复跑前端同一套数据管线，并用 `point` 接口**逐分片**交叉验证本地聚合结果：

```bash
node tools/verify-data.js
```

覆盖内容：分片无重叠/无空隙且 ≤ 548 天、日期轴连续无缺口、每个包的本地聚合值 == 服务端求和值、四种粒度总数守恒、星期分布守恒。

最近一次运行结果：**27 项通过 / 0 项失败**。

## 部署到 Cloudflare Pages

### 方式 A：Git 集成（推荐，push 自动部署）

1. 把代码推到 GitHub（见下方 Git 说明）。
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左侧 **Workers & Pages** → **Create** → **Pages** 标签 → **Connect to Git**。
3. 授权并选择本仓库。
4. **Set up builds and deployments** 一栏按下面填写（本项目没有构建步骤）：

   | 字段 | 值 |
   | --- | --- |
   | Production branch | `main` |
   | Framework preset | `None` |
   | Build command | 留空（重要，留空即可） |
   | Build output directory | `/` |

5. 点 **Save and Deploy**，几十秒后即可访问 `https://<项目名>.pages.dev`。
6. 之后每次 `git push` 都会自动重新部署。
7. 绑定自有域名：项目 → **Custom domains** → **Set up a custom domain**。

### 方式 B：wrangler 直接上传（无需 Git）

```bash
cd npm-downloads-stats
npx wrangler login
npx wrangler pages deploy . --project-name npm-downloads-stats
```

首次执行会提示创建项目，随后返回 `https://<项目名>.pages.dev`。之后重复执行该命令即可更新。

> 说明：`tools/`、`README.md` 会被一并上传，它们是公开内容且不含任何敏感信息；
> 若不想暴露，可把它们移到仓库外或改用「方式 A + 只部署子目录」。
> 仓库内的 `_headers` 已为 Cloudflare Pages 配好静态资源缓存策略。

## 隐私说明

- 页面运行时**只**访问 `registry.npmjs.org` 与 `api.npmjs.org` 两个公开接口，无任何第三方 CDN、字体、埋点或统计脚本；ECharts 已本地内置。
- **不设置任何 Cookie**，不采集访客信息；仅在浏览器 localStorage 写入缓存与界面偏好（`npmdl:cache:*`、`npmdl:prefs`）。
- 仓库内唯一身份信息是 npm 用户名 `ducaoya`（本就是 npmjs.com 上的公开信息）。代码不读取、不存储 npm 接口返回的维护者邮箱字段。
- 部署后，访客浏览器会直接向 npm 官方域名发起请求（npm 可见访客 IP），这与直接访问 npmjs.com 无异。
- 「诊断信息」面板展示的包名/版本/发布日期均为 npm 上的公开数据。

## 目录结构

```
.
├── index.html            # 页面骨架
├── _headers              # Cloudflare Pages 缓存策略
├── start.bat             # Windows 一键起本地服务
├── src/
│   ├── config.js         # 配置（用户名、手动补充包、缓存时长等）
│   ├── api.js            # npm 接口封装：包发现、18 个月分片、并发控制、缓存
│   ├── aggregate.js      # 日 → 周 / 月 / 年 聚合、星期分布、区间求和
│   ├── charts.js         # ECharts 渲染（随主题自动换色）
│   ├── main.js           # 状态管理与交互
│   └── style.css         # 样式（深色 / 浅色）
├── tools/
│   └── verify-data.js    # 数据正确性校验脚本
└── vendor/
    └── echarts.min.js    # 本地内置的 ECharts 5.5.1
```

## License

MIT
