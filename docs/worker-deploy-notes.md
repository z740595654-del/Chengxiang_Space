# Worker 与 Cloudflare Pages 解耦说明

## 背景与根因
Cloudflare Pages 的构建命令被设置为 `npx wrangler deploy`，而 `worker/wrangler.toml` 中存在 `[assets]` 配置指向整个静态站点目录（`../Chenxiang_Space`）。Pages 在构建时会尝试为 `food-sync` Worker 触发资产上传（`assets-upload-session`），导致构建阶段直接调用 Cloudflare API 并报错。为确保主页构建独立且不影响运行中的 `food-sync` Worker，需要将静态站点与 Worker 部署流程解耦。

## 修复策略（方案 A）
- Pages 仅发布静态页面，不再在构建中执行 `wrangler deploy`。
- `food-sync` Worker 单独通过 Wrangler/仪表盘部署，保留 D1 绑定，但取消资产绑定，避免再次触发 Pages 资产上传。
- Lead Finder 如需后台，使用独立 Worker（示例文件：`worker/lead-finder-worker.js`），不要与 `food-sync` 共用部署命令。

## Cloudflare Pages 控制台操作指引
1. 打开 Cloudflare Pages 项目，进入 **Settings → Build & deployments**。
2. 在 **Build settings** 中修改：
   - **Build command**：改为 `echo "no build"`（或留空），避免触发 `wrangler deploy`。
   - **Build output directory**：填写 `Chenxiang_Space`（静态 HTML 所在目录）。
3. 保存设置后重新触发部署，Pages 将只上传静态文件，不会再尝试部署 Worker。

## 后续部署建议
- 发布 `food-sync` Worker：在本地进入 `worker/` 目录，使用 `wrangler publish` 或在仪表盘手动部署，确保 D1 绑定与密钥在 Worker 环境中配置完整。
- 发布 Lead Finder Worker：按 `docs/lead-finder-setup.md` 的步骤创建独立 Worker，部署地址替换到前端 `tools/lead-finder.html` 的 `WORKER_BASE` 常量，不要与 `food-sync` 共享部署命令。

## 如果你仍想自动部署 Worker（可选）
- 推荐做法：保持 Pages 仅构建静态站点，在需要时单独执行部署命令，例如：
  - 本地或 CI：`npx wrangler deploy --config worker/wrangler.toml`
  - 若需要同时发布 Lead Finder，使用独立配置或进入 `worker/` 目录后运行对应命令。
- 如要在 Pages 构建阶段顺便发布 Worker：
  1. 在 **Settings → Build & deployments** 中将 **Build command** 设置为 `npx wrangler deploy --config worker/wrangler.toml`（显式指向 API Worker 的配置，避免误用其他文件）。
  2. 保持 **Build output directory** 为 `Chenxiang_Space`，确保静态页面仍被上传。
  3. 确认 Pages 绑定的账户拥有 D1 数据库与 `food-sync` Worker 的部署权限，否则构建会因权限失败。
- 无论哪种方式，`worker/wrangler.toml` 取消了 `[assets]`，不会再尝试上传静态文件，部署只会更新 API Worker 本身。

## 兼容性说明
- 取消 `[assets]` 后，`food-sync` Worker 专注处理 API，不再尝试托管静态文件；主页由 Pages 提供，功能互不干扰。
- 如需在 Worker 侧托管静态文件，请另建独立配置文件并手动执行部署，避免 Pages 默认流程误用。
