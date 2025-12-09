const LEDGER_PREFIX = "/ledger";
const FOOD_BASE_PATH = "/food";
const DEFAULT_LEDGER_PASSWORD = "020117";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Custom-Auth, x-ledger-key, X-Ledger-Key",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path.startsWith(LEDGER_PREFIX)) {
      return handleLedgerRequest({ path, method, url, env, request });
    }

    if (isFoodPath(path)) {
      return handleFoodApi(request, env, method);
    }

    return fetch(request);
  },
};

function getLedgerPassword(env) {
  return env?.LEDGER_API_KEY || DEFAULT_LEDGER_PASSWORD;
}

function isFoodPath(path) {
  return path === FOOD_BASE_PATH || path === `${FOOD_BASE_PATH}/` || path === `${FOOD_BASE_PATH}/data`;
}

async function handleLedgerRequest({ path, method, url, env, request }) {
  const ledgerPwd = getLedgerPassword(env);
  const headerKey = request.headers.get("x-ledger-key") || request.headers.get("X-Ledger-Key");

  if (ledgerPwd && headerKey !== ledgerPwd) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  await ensureLedgerSchema(env);

  const subPath = path.slice(LEDGER_PREFIX.length) || "/";

  if (method === "GET" && subPath === "/transactions") {
    return handleGetTransactions(url, env);
  }

  if (method === "POST" && subPath === "/transactions") {
    return handlePostTransaction(request, env);
  }

  if (method === "DELETE" && subPath.startsWith("/transactions/")) {
    const parts = subPath.split("/");
    const tx_id = parts[2];
    return handleDeleteTransaction(tx_id, env);
  }

  if (method === "GET" && subPath === "/logs") {
    return handleGetLogs(url, env);
  }

  if (method === "GET" && subPath === "/export") {
    return handleExportCsv(env);
  }

  return new Response("Not found", { status: 404, headers: CORS_HEADERS });
}

/* ========== 干饭转盘后端：单表 JSON 存储 ========== */

async function handleFoodApi(request, env, method) {
  await env.LEDGER_DB.prepare(
    "CREATE TABLE IF NOT EXISTS food_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)"
  ).run();

  if (method === "GET") {
    const row = await env.LEDGER_DB.prepare(
      "SELECT data FROM food_state WHERE id = 1"
    ).first();

    const text = normalizeFoodState(row && row.data);

    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  if (method === "PUT") {
    const bodyText = await request.text();

    if (bodyText.length > 1024 * 1024) {
      return json({ ok: false, error: "Payload too large" }, 413);
    }

    await env.LEDGER_DB.prepare(
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
    headers: CORS_HEADERS,
  });
}

function normalizeFoodState(rawText) {
  // 兼容历史空值、[] 数组格式与标准对象格式
  if (!rawText) {
    return JSON.stringify({ items: [], logs: [] });
  }

  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      // 早期空数组写入，转为对象
      return JSON.stringify({ items: parsed, logs: [] });
    }
    if (parsed && typeof parsed === "object") {
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const logs = Array.isArray(parsed.logs) ? parsed.logs : [];
      return JSON.stringify({ items, logs });
    }
  } catch (err) {
    // 解析失败则返回空对象，避免前端崩溃
  }

  return JSON.stringify({ items: [], logs: [] });
}

/* ========== 账本：自动迁移 / 表结构保障 ========== */

let ledgerSchemaReady = false;

async function ensureLedgerSchema(env) {
  if (ledgerSchemaReady) return;

  await env.LEDGER_DB.prepare(
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

  await env.LEDGER_DB.prepare(
    `CREATE TABLE IF NOT EXISTS ledger_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      action TEXT NOT NULL,
      tx_id TEXT,
      description TEXT,
      amount REAL
    )`
  ).run();

  const infoTx = await env.LEDGER_DB.prepare(
    "PRAGMA table_info(ledger_transactions)"
  ).all();
  const cols = (infoTx.results || infoTx || []).map((c) => c.name || c[1]);

  if (!cols.includes("is_xiaoe")) {
    await env.LEDGER_DB.prepare(
      "ALTER TABLE ledger_transactions ADD COLUMN is_xiaoe INTEGER DEFAULT 0"
    ).run();
  }
  if (!cols.includes("is_deleted")) {
    await env.LEDGER_DB.prepare(
      "ALTER TABLE ledger_transactions ADD COLUMN is_deleted INTEGER DEFAULT 0"
    ).run();
  }

  ledgerSchemaReady = true;
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

  const seqExpr = "CAST(substr(tx_id, instr(tx_id, '-') + 1) AS INTEGER)";
  sql += ` ORDER BY date DESC, ${seqExpr} DESC, tx_id DESC`;

  const res = await env.LEDGER_DB.prepare(sql).bind(...params).all();
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
    const countRes = await env.LEDGER_DB.prepare(
      "SELECT COUNT(*) AS c FROM ledger_transactions WHERE date = ?"
    )
      .bind(date)
      .first();
    const nextNum = String((countRes?.c || 0) + 1).padStart(4, "0");
    tx_id = `${today}-${nextNum}`;
  }

  await env.LEDGER_DB.prepare(
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

  const res = await env.LEDGER_DB.prepare(
    "SELECT * FROM ledger_transactions WHERE tx_id = ? AND (is_deleted IS NULL OR is_deleted = 0)"
  )
    .bind(tx_id)
    .first();

  if (!res) return json({ ok: false, error: "Not found" }, 404);

  await env.LEDGER_DB.prepare(
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
  await env.LEDGER_DB.prepare(
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

  const res = await env.LEDGER_DB.prepare(sql).bind(...params).all();
  return json(res.results || []);
}

// GET /ledger/export
async function handleExportCsv(env) {
  const res = await env.LEDGER_DB.prepare(
    `SELECT tx_id,date,amount,category_level1,category_level2,
            description,account,book,is_xiaoe
     FROM ledger_transactions
     WHERE (is_deleted IS NULL OR is_deleted = 0)
     ORDER BY date DESC, tx_id DESC`
  ).all();

  const rows = res.results || [];
  let csv =
    "tx_id,date,amount,category_level1,category_level2,description,account,book,is_xiaoe\n";

  for (const r of rows) {
    csv +=
      [
        r.tx_id,
        r.date,
        r.amount,
        r.category_level1,
        r.category_level2,
        r.description,
        r.account,
        r.book,
        r.is_xiaoe ? "是" : "否",
      ]
        .map(escapeCsvValue)
        .join(",") + "\n";
  }

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": "attachment; filename=ledger_export.csv",
      ...CORS_HEADERS,
    },
  });
}

function escapeCsvValue(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
