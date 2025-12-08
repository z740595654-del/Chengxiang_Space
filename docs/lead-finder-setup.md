# Lead Finder 使用与部署说明

本文档指导如何创建 Google 搜索凭据、部署 Cloudflare Worker，并在前端页面使用「Lead Finder (South America)」获取每日约 20 个潜在客户官网。

## 创建 Google API Key
1. 访问 [Google Cloud Console](https://console.cloud.google.com/)。
2. 创建或选择现有项目，进入 **APIs & Services → Credentials**。
3. 点击 **Create credentials → API key**，复制生成的 Key（后续作为 `GOOGLE_API_KEY`）。
4. 在 **Library** 中启用 **Custom Search API**。

## 创建 Programmable Search Engine 并获取 cx
1. 打开 [Programmable Search Engine](https://programmablesearchengine.google.com/) 控制台。
2. 选择 **Add** 新建搜索引擎，允许搜索整个网络（或按需限制域名）。
3. 创建后在 **Basic → Search engine ID** 处复制 `cx`，后续作为 `GOOGLE_CSE_ID`。

> 免费额度：Custom Search JSON API 默认每天 100 次请求免费，超出会按 Google 标准计费。

## 部署 Cloudflare Worker
1. 在 Cloudflare 控制台创建一个新的 Worker（任意名称），保持默认入口文件。
2. 在 Worker 设置中添加 Secrets：
   - `GOOGLE_API_KEY`：上文生成的 Google API Key。
   - `GOOGLE_CSE_ID`：Programmable Search Engine 的 cx。
3. 将仓库中的 `worker/lead-finder-worker.js` 全部内容复制到 Worker 编辑器中，或使用 wrangler 部署：
   ```bash
   wrangler secret put GOOGLE_API_KEY
   wrangler secret put GOOGLE_CSE_ID
   wrangler deploy worker/lead-finder-worker.js --name <your-worker-name>
   ```
4. 发布后记录 Worker 的访问地址，例如 `https://your-worker-name.workers.dev`。

### Worker 提供的接口
- `GET /leads?country=Chile&keyword=forklift%20dealer&num=10&start=1`
  - 返回 6 列字段（Country, Company, Website, Address, Phone, Email），按域名去重，最多 10 条。
  - `start` 可选，用于第二页抓取（例如传 11 配合前端生成 20 条）。
- `GET /enrich?website=https://example.com`（可选）
  - 抓取官网及常见联系页面，使用正则尝试补全 Email/Phone。

## 前端替换 Worker 地址
1. 打开 `Chenxiang_Space/tools/lead-finder.html`。
2. 将顶部的 `const WORKER_BASE = "https://REPLACE_ME.workers.dev";` 替换为实际 Worker 地址。
3. 无需其他改动，保存后即可调用后端。

## 每日获取约 20 个候选官网
1. 打开新增页面：`/tools/lead-finder.html`（主页“Lead Finder”入口）。
2. 选择目标 **Country** 与 **Keyword**。
3. 点击 **Generate 10** 获取单页候选；或点击 **Generate 20 (2 queries)**，自动以 `start=1` 与 `start=11` 拉取两批并去重，凑到约 20 条官网。
4. 如需补全电话/邮箱，可点击 **Enrich missing contacts**（调用 Worker `/enrich`）。
5. 确认表格后，点击 **Download CSV**，文件包含固定 6 列表头：`Country,Company,Website,Address,Phone,Email`。
