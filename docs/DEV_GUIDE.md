# 开发与部署手册

## 1. 架构总览
- **前端**：纯静态页面，包含门户首页、干饭大转盘和家庭账本，直接由静态托管服务或 Cloudflare 静态站点提供。
- **后端**：单个 Cloudflare Worker，负责：
  - 干饭大转盘的 JSON 状态存取（根路径 GET/PUT）。
  - 家庭账本 API (`/ledger` 前缀)，读写 Cloudflare D1 数据库，包含交易、日志和 CSV 导出。

## 2. 代码结构
- `Chenxiang_Space/`：三页静态 HTML。
  - `index.html`：门户导航。
  - `food.html`：大转盘应用。
  - `ledger.html`：账本仪表盘与表单。
- `worker/`：Cloudflare Worker 项目。
  - `src/index.js`：请求路由、鉴权、D1 表结构保障与 CRUD 逻辑。
  - `wrangler.toml`：Worker 配置（名称、入口、兼容日期）。

## 3. 开发环境准备
1. 安装 Node.js 与 pnpm/yarn/npm（按团队习惯）。
2. 全局安装 Cloudflare Wrangler CLI：`npm install -g wrangler`。
3. 在 Cloudflare 控制台创建 D1 数据库并记录绑定名称（示例：`MY_DB`）。
4. 为 Worker 设置环境变量（`wrangler secret put` 或仪表盘配置）：
   - `LEDGER_API_KEY`（或 `LEDGER_PASSWORD`）：账本访问密码。
   - `FOOD_API_KEY`（或 `FOOD_PASSWORD`）：干饭大转盘云同步密码。
   - 默认值存在于代码中，生产环境务必覆盖。

## 4. 本地开发
1. 在 `worker/wrangler.toml` 中确认入口 `src/index.js` 与数据库绑定名称。
2. 运行 `wrangler d1 execute <DB_NAME> --file schema.sql`（可选）提前建表；若不执行，Worker 首次请求会自动创建/迁移表结构。
3. 启动本地调试：
   ```bash
   cd worker
   wrangler dev --remote
   ```
   `--remote` 选项会使用远程 D1，避免本地 SQLite 差异。
4. 在浏览器访问静态页面（本地或已部署版本），将 API Base 指向本地 Worker 端口（如需）：
   - 干饭大转盘：根路径，需 `X-Custom-Auth` 头。
   - 家庭账本：`/ledger` 前缀，需 `x-ledger-key` 头。

## 5. 部署
1. 确认 Cloudflare 账户已绑定 wrangler：`wrangler login`。
2. 在 `worker` 目录执行：
   ```bash
   wrangler publish
   ```
3. 将静态页面部署到同域静态托管（如 Cloudflare Pages 或对象存储）；若 Worker 绑定到同域，需确保 HTML 请求直接落到静态托管，API 请求由 Worker 处理（代码已对 HTML/静态资源直接透传）。

## 6. 关键实现要点
- **鉴权**：
  - 干饭大转盘 API 通过 `X-Custom-Auth` 与 `FOOD_API_KEY/FOOD_PASSWORD` 校验。
  - 账本 API 通过 `x-ledger-key` 与 `LEDGER_API_KEY/LEDGER_PASSWORD` 校验。
- **数据结构**：
  - `ledger_transactions` 表包含交易号、日期、金额、分类、账户、账本、小荷包标记和软删除字段。
  - `ledger_logs` 表记录操作时间、类型、交易号与金额。
- **接口**：
  - `GET /ledger/transactions`：可按 `from/to` 过滤，返回未删除的交易列表。
  - `POST /ledger/transactions`：接受 JSON，必要字段：`date`、`amount`，若无 `tx_id` 自动生成。
  - `DELETE /ledger/transactions/{tx_id}`：软删除并写入日志。
  - `GET /ledger/logs`：按时间与操作类型查询日志，默认 10 条。
  - `GET /ledger/export`：导出 CSV，自动排除软删除数据。
  - 根路径 `GET/PUT /`：读取或写入大转盘 JSON 状态，主体大小上限约 1MB。

## 7. 测试建议
- **单元/集成**：
  - 使用 Wrangler 提供的 Miniflare 或 Cloudflare Test harness，针对鉴权、交易 CRUD、导出和同步接口编写请求用例。
- **手动回归**：
  - 浏览器中验证大转盘旋转、添加、删除、云同步。
  - 在账本页验证单笔记账、批量导入、账期切换、导出 CSV、主题切换。

## 8. 运维与监控
- 监控 Worker 日志（`wrangler tail`）以排查请求错误。
- 定期导出 CSV 备份账本数据。
- 关注 D1 数据库大小与性能，必要时归档历史数据。
