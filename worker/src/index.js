const LEDGER_PREFIX = "/ledger";
// build test

// 兼容你现有前端的默认值
const DEFAULT_LEDGER_PASSWORD = "020117";
const DEFAULT_FOOD_API_KEY = "finn_secret_2025";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Custom-Auth, x-ledger-key, X-Ledger-Key",
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function getLedgerPassword(env) {
  return (
    env?.LEDGER_API_KEY ||
    env?.LEDGER_PASSWORD ||
    DEFAULT_LEDGER_PASSWORD
  );
}

function getFoodApiKey(env) {
  return (
    env?.FOOD_API_KEY ||
    env?.FOOD_PASSWORD ||
    DEFAULT_FOOD_API_KEY
  );
}

function isHtmlRequest(request, path) {
  const accept = request.headers.get("Accept") || "";
  return (
    accept.includes("text/html") ||
    path.endsWith(".html") ||
    path === "/favicon.ico" ||
    path.startsWith("/assets/") ||
    path.endsWith(".css") ||
    path.endsWith(".js") ||
    path.endsWith(".png") ||
    path.endsWith(".jpg") ||
    path.endsWith(".svg")
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    try {
      // ========= 0) 先放行明显的静态资源请求 =========
      // 这能避免你把整个站点“Worker 化”后页面裂开
      if (isHtmlRequest(request, path) && !path.startsWith(LEDGER_PREFIX)) {
        return fetch(request);
      }

      // ========= 1) 吃饭转盘云端 API（保持兼容：就是根路径 /） =========
      // 只有带 X-Custom-Auth 才认为是 API 调用
      const foodKey =
        request.headers.get("X-Custom-Auth") ||
        request.headers.get("x-custom-auth");

      if (path === "/" && (method === "GET" || method === "PUT")) {
        if (foodKey) {
          const expect = getFoodApiKey(env);
          if (expect && foodKey !== expect) {
            return json({ ok: false, error: "Forbidden" }, 403);
          }
          return await handleFoodApi(request, env);
        }

        // 没带 Key 的 GET / 大概率是访问首页
        // 直接交还给静态站点
        if (method === "GET") {
          return fetch(request);
        }
      }

      // ========= 2) 账本 API：/ledger/... =========
      if (path.startsWith(LEDGER_PREFIX)) {
        const ledgerPwd = getLedgerPassword(env);

        const headerKey =
          request.headers.get("x-ledger-key") ||
          request.headers.get("X-Ledger-Key");

        if (ledgerPwd && headerKey !== ledgerPwd) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        await ensureLedgerSchema(env);

        const subPath = path.slice(LEDGER_PREFIX.length) || "/";

        if (method === "GET" && subPath === "/transactions") {
          return await handleGetTransactions(url, env);
        }

        if (method === "POST" && subPath === "/transactions") {
          return await handlePostTransaction(request, env);
        }

        if (method === "DELETE" && subPath.startsWith("/transactions/")) {
          const parts = subPath.split("/");
          const tx_id = parts[2];
          return await handleDeleteTransaction(tx_id, env);
        }

        if (method === "GET" && subPath === "/logs") {
          return await handleGetLogs(url, env);
        }

        if (method === "GET" && subPath === "/export") {
          return await handleExportCsv(env);
        }

        return new Response("Not found", {
          status: 404,
          headers: corsHeaders(),
        });
      }

      // ========= 3) 其他路径全部放行给静态站点 =========
      return fetch(request);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return json({ ok: false, error: "Server Error: " + msg }, 500);
    }
  },
};

/* ========== 干饭转盘后端：单表 JSON 存储 ========== */

async function handleFoodApi(request, env) {
  const method = request.method.toUpperCase();

  await env.MY_DB.prepare(
    "CREATE TABLE IF NOT EXISTS food_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)"
  ).run();

  if (method === "GET") {
    const row = await env.MY_DB.prepare(
      "SELECT data FROM food_state WHERE id = 1"
    ).first();

    const text = row && row.data ? row.data : "[]";

    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        ...corsHeaders(),
      },
    });
  }

  if (method === "PUT") {
    const bodyText = await request.text();

    if (bodyText.length > 1024 * 1024) {
      return json({ ok: false, error: "Payload too large" }, 413);
    }

    await env.MY_DB.prepare(
      `INSERT INTO food_state (id, data)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`
    )
      .bind(bodyText)
      .run();

    return json({ ok: true });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: corsHeaders(),
  });
}

/* ========== 账本：自动迁移 / 表结构保障 ========== */

async function ensureLedgerSchema(env) {
  await env.MY_DB.prepare(
    `CREATE TABLE IF NOT EXISTS ledger_transactions (
      tx_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      category_level1 TEXT,
      category_level2 TEXT,
      description TEXT,
      account TEXT,
      book TEXT,
      is_xiaoe INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0
    )`
  ).run();

  await env.MY_DB.prepare(
    `CREATE TABLE IF NOT EXISTS ledger_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      action TEXT NOT NULL,
      tx_id TEXT,
      description TEXT,
      amount REAL
    )`
  ).run();

  const infoTx = await env.MY_DB.prepare(
    "PRAGMA table_info(ledger_transactions)"
  ).all();
  const cols = (infoTx.results || infoTx || []).map((c) => c.name || c[1]);

  if (!cols.includes("is_xiaoe")) {
    await env.MY_DB.prepare(
      "ALTER TABLE ledger_transactions ADD COLUMN is_xiaoe INTEGER DEFAULT 0"
    ).run();
  }
  if (!cols.includes("is_deleted")) {
    await env.MY_DB.prepare(
      "ALTER TABLE ledger_transactions ADD COLUMN is_deleted INTEGER DEFAULT 0"
    ).run();
  }
}

/* ========== 账本 API：D1 操作 ========== */

// GET /ledger/transactions?from=&to=
async function handleGetTransactions(url, env) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let sql = `
    SELECT tx_id, date, amount, category_level1, category_level2,
           description, account, book, is_xiaoe
    FROM ledger_transactions
    WHERE (is_deleted IS NULL OR is_deleted = 0)
  `;
  const params = [];

  if (from && to) {
    sql += " AND date BETWEEN ? AND ?";
    params.push(from, to);
  } else if (from) {
    sql += " AND date >= ?";
    params.push(from);
  } else if (to) {
    sql += " AND date <= ?";
    params.push(to);
  }

  sql += " ORDER BY date ASC, tx_id ASC";

  const res = await env.MY_DB.prepare(sql).bind(...params).all();
  return json(res.results || []);
}

// POST /ledger/transactions
async function handlePostTransaction(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);

  let {
    tx_id,
    date,
    amount,
    category_level1,
    category_level2,
    description,
    account,
    book,
    is_xiaoe,
  } = body;

  if (!date || typeof amount !== "number" || isNaN(amount)) {
    return json(
      { ok: false, error: "Missing or invalid date/amount" },
      400
    );
  }

  if (!tx_id) {
    const today = date.replaceAll("-", "");
    const countRes = await env.MY_DB.prepare(
      "SELECT COUNT(*) AS c FROM ledger_transactions WHERE date = ?"
    )
      .bind(date)
      .first();
    const nextNum = String((countRes?.c || 0) + 1).padStart(4, "0");
    tx_id = `${today}-${nextNum}`;
  }

  await env.MY_DB.prepare(
    `INSERT INTO ledger_transactions
      (tx_id, date, amount, category_level1, category_level2,
       description, account, book, is_xiaoe, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      tx_id,
      date,
      amount,
      category_level1 || "",
      category_level2 || "",
      description || "",
      account || "",
      book || "",
      is_xiaoe === "是" || is_xiaoe === 1 ? 1 : 0
    )
    .run();

  await logAction(env, "ADD", tx_id, description, amount);

  return json({ ok: true, tx_id });
}

// DELETE /ledger/transactions/{tx_id}
async function handleDeleteTransaction(tx_id, env) {
  if (!tx_id) return json({ ok: false, error: "Missing tx_id" }, 400);

  const res = await env.MY_DB.prepare(
    "SELECT * FROM ledger_transactions WHERE tx_id = ? AND (is_deleted IS NULL OR is_deleted = 0)"
  )
    .bind(tx_id)
    .first();

  if (!res) return json({ ok: false, error: "Not found" }, 404);

  await env.MY_DB.prepare(
    "UPDATE ledger_transactions SET is_deleted = 1 WHERE tx_id = ?"
  )
    .bind(tx_id)
    .run();

  await logAction(env, "DELETE", tx_id, res.description, res.amount);

  const msg = `✅ 已删除 1 条记录：${tx_id}（¥${res.amount} ${res.category_level1}-${res.category_level2} ${res.description}）`;
  return json({ ok: true, message: msg });
}

// 写日志
async function logAction(env, action, tx_id, description, amount) {
  await env.MY_DB.prepare(
    `INSERT INTO ledger_logs (time, action, tx_id, description, amount)
     VALUES (datetime('now', 'localtime'), ?, ?, ?, ?)`
  )
    .bind(action, tx_id, description || "", amount || 0)
    .run();
}

// GET /ledger/logs
async function handleGetLogs(url, env) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const action = url.searchParams.get("action");
  const limit = parseInt(url.searchParams.get("limit") || "10", 10);

  let sql = "SELECT * FROM ledger_logs WHERE 1=1";
  const params = [];

  if (from && to) {
    sql += " AND date(time) BETWEEN ? AND ?";
    params.push(from, to);
  }
  if (action) {
    sql += " AND action = ?";
    params.push(action.toUpperCase());
  }

  sql += " ORDER BY time DESC LIMIT ?";
  params.push(limit);

  const res = await env.MY_DB.prepare(sql).bind(...params).all();
  return json(res.results || []);
}

// GET /ledger/export
async function handleExportCsv(env) {
  const res = await env.MY_DB.prepare(
    `SELECT tx_id,date,amount,category_level1,category_level2,
            description,account,book,is_xiaoe
     FROM ledger_transactions
     WHERE (is_deleted IS NULL OR is_deleted = 0)
     ORDER BY date ASC, tx_id ASC`
  ).all();

  const rows = res.results || [];
  let csv =
    "tx_id,date,amount,category_level1,category_level2,description,account,book,is_xiaoe\n";

  for (const r of rows) {
    csv += [
      r.tx_id,
      r.date,
      r.amount,
      r.category_level1,
      r.category_level2,
      r.description,
      r.account,
      r.book,
      r.is_xiaoe ? "是" : "否",
    ].join(",") + "\n";
  }

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": "attachment; filename=ledger_export.csv",
      ...corsHeaders(),
    },
  });
}
