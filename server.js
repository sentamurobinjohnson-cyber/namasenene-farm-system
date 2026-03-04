import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_FILE = path.join(__dirname, "schema.sql");
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

const app = express();
app.use(cors({
  origin: "*"
}));
app.use(express.json());
// Serve frontend
app.use(express.static(path.join(__dirname, "public")));
// Add routes here

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});




// -----------------------------
// Helpers
// -----------------------------
async function q(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const r = await q(sql, params);
  return r.rows[0] || null;
}

async function all(sql, params = []) {
  const r = await q(sql, params);
  return r.rows || [];
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// -----------------------------
// Auth middleware
// -----------------------------
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -----------------------------
// DB init
// -----------------------------
async function initDb() {
  // 1) test connection
  await q("SELECT 1");
  console.log("✅ Neon Postgres connected");

  // 2) run schema.sql if present
  if (fs.existsSync(SCHEMA_FILE)) {
    const sql = fs.readFileSync(SCHEMA_FILE, "utf-8");
    // NOTE: schema file must be Postgres-compatible (no PRAGMA, no AUTOINCREMENT)
    if (sql && sql.trim()) {
      await q(sql);
      console.log("✅ schema.sql executed");
    }
  } else {
    console.log("ℹ️ No schema.sql found next to server.js (skipping)");
  }

  // 3) ensure default admin exists
  const adminEmail = "admin@namasenene.local";
  const adminPass = "Admin123!";
  const hash = await bcrypt.hash(adminPass, 10);

  await q(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    ["Admin", adminEmail, hash, "admin"]
  );
  console.log("✅ Default admin ensured: admin@namasenene.local / Admin123!");
}

// -----------------------------
// Health
// -----------------------------
app.get("/", (req, res) => res.send("Namasenene Farm Backend is running 🚜🌾"));
app.get("/api", (req, res) => res.json({ message: "API is working ✅" }));

app.get("/test-neon", async (req, res) => {
  try {
    const result = await q("SELECT NOW() AS now");
    res.json({ success: true, neonTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================
// AUTH
// =====================
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role = "user" } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

    const exists = await one("SELECT id FROM users WHERE email = $1", [email]);
    if (exists) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const r = await q(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role`,
      [name, email, hash, role]
    );

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Register failed", details: String(e) });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const user = await one(
      "SELECT id, name, email, password_hash, role FROM users WHERE email = $1",
      [email]
    );
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
      expiresIn: "8h",
    });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: "Login failed", details: String(e) });
  }
});

// =====================
// CROPS
// =====================
app.get("/api/crops", auth, async (req, res) => {
  try {
    const rows = await all("SELECT * FROM crops ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load crops", details: String(e) });
  }
});

app.post("/api/crops", auth, async (req, res) => {
  try {
    const { crop_name, variety, unit_default } = req.body;
    if (!crop_name) return res.status(400).json({ error: "crop_name is required" });

    const row = await one(
      `INSERT INTO crops (crop_name, variety, unit_default)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [crop_name, variety || null, unit_default || "kg"]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create crop", details: String(e) });
  }
});

app.put("/api/crops/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { crop_name, variety, unit_default } = req.body;
    if (!crop_name) return res.status(400).json({ error: "crop_name is required" });

    const row = await one(
      `UPDATE crops
       SET crop_name=$1, variety=$2, unit_default=$3
       WHERE id=$4
       RETURNING *`,
      [crop_name, variety || null, unit_default || "kg", id]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update crop", details: String(e) });
  }
});

app.delete("/api/crops/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM crops WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete crop", details: String(e) });
  }
});

// =====================
// FIELDS
// =====================
app.get("/api/fields", auth, async (req, res) => {
  try {
    const rows = await all("SELECT * FROM fields ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load fields", details: String(e) });
  }
});

app.post("/api/fields", auth, async (req, res) => {
  try {
    const { name, size_acres, soil_type, irrigation_type, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await one(
      `INSERT INTO fields (name, size_acres, soil_type, irrigation_type, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        name.trim(),
        size_acres !== "" && size_acres != null ? Number(size_acres) : null,
        soil_type || null,
        irrigation_type || null,
        notes || null,
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create field", details: String(e) });
  }
});

app.put("/api/fields/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, size_acres, soil_type, irrigation_type, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await one(
      `UPDATE fields
       SET name=$1, size_acres=$2, soil_type=$3, irrigation_type=$4, notes=$5
       WHERE id=$6
       RETURNING *`,
      [
        name.trim(),
        size_acres !== "" && size_acres != null ? Number(size_acres) : null,
        soil_type || null,
        irrigation_type || null,
        notes || null,
        id,
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update field", details: String(e) });
  }
});

app.delete("/api/fields/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM fields WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete field", details: String(e) });
  }
});

// =====================
// PLANTINGS
// =====================
app.get("/api/plantings", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT
        p.*,
        f.name AS field_name,
        c.crop_name, c.variety
      FROM plantings p
      JOIN fields f ON f.id = p.field_id
      JOIN crops c  ON c.id = p.crop_id
      ORDER BY p.id DESC
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load plantings", details: String(e) });
  }
});

app.post("/api/plantings", auth, async (req, res) => {
  try {
    const {
      field_id, crop_id, planting_date,
      seed_source, quantity_planted,
      quantity_unit, expected_harvest_date, status, notes
    } = req.body;

    if (!field_id || !crop_id || !planting_date) {
      return res.status(400).json({ error: "field_id, crop_id, planting_date are required" });
    }

    const row = await one(
      `
      INSERT INTO plantings
      (field_id, crop_id, planting_date, seed_source, quantity_planted, quantity_unit, expected_harvest_date, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        Number(field_id),
        Number(crop_id),
        planting_date,
        seed_source || null,
        quantity_planted != null ? Number(quantity_planted) : 0,
        quantity_unit || "seed",
        expected_harvest_date || null,
        status || "planted",
        notes || null,
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create planting", details: String(e) });
  }
});

app.delete("/api/plantings/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    // If harvests reference planting with RESTRICT, you must delete harvests first (your schema uses RESTRICT)
    await q("DELETE FROM harvests WHERE planting_id=$1", [id]);
    await q("DELETE FROM plantings WHERE id=$1", [id]);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: "Failed to delete planting", details: String(e) });
  }
});

// =====================
// HARVESTS + INVENTORY MOVEMENT IN
// =====================
app.post("/api/harvests", auth, async (req, res) => {
  try {
    const { planting_id, harvest_date, quantity, unit, notes } = req.body;
    if (!planting_id || !harvest_date || quantity == null) {
      return res.status(400).json({ error: "planting_id, harvest_date, quantity are required" });
    }

    const planting = await one("SELECT * FROM plantings WHERE id=$1", [Number(planting_id)]);
    if (!planting) return res.status(400).json({ error: "Planting not found" });

    const result = await withTx(async (client) => {
      const rHarvest = await client.query(
        `INSERT INTO harvests (planting_id, harvest_date, quantity, unit, notes)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [Number(planting_id), harvest_date, Number(quantity), unit || "kg", notes || null]
      );
      const harvestId = rHarvest.rows[0].id;

      await client.query(
        `INSERT INTO inventory_movements
         (movement_time, item_type, item_id, storage_location_id, direction, quantity, unit, reason, reference_type, reference_id)
         VALUES (NOW(), 'crop', $1, NULL, 'in', $2, $3, 'harvest', 'harvest', $4)`,
        [planting.crop_id, Number(quantity), unit || "kg", harvestId]
      );

      return harvestId;
    });

    res.json({ ok: true, harvest_id: result });
  } catch (e) {
    res.status(500).json({ error: "Failed to save harvest", details: String(e) });
  }
});

// =====================
// DASHBOARD SUMMARY
// =====================
app.get("/api/dashboard/summary", auth, async (req, res) => {
  try {
    const revenueRow = await one(
      `
      SELECT COALESCE(SUM(total_amount), 0) AS revenue,
             COALESCE(SUM(tax_amount), 0) AS sales_tax
      FROM sales
      WHERE status='completed'
      `
    );

    const expenseRow = await one(
      `
      SELECT COALESCE(SUM(total_cost), 0) AS expenses,
             COALESCE(SUM(tax_amount), 0) AS expense_tax
      FROM expenses
      `
    );

    const revenue = Number(revenueRow?.revenue || 0);
    const expenses = Number(expenseRow?.expenses || 0);

    res.json({
      revenue,
      expenses,
      profit: revenue - expenses,
      sales_tax: Number(revenueRow?.sales_tax || 0),
      expense_tax: Number(expenseRow?.expense_tax || 0),
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to load dashboard summary", details: String(e) });
  }
});

// =====================
// REPORTS
// =====================
app.get("/api/reports/sales-by-channel", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT
        channel,
        COUNT(*) AS sales_count,
        COALESCE(SUM(total_amount), 0) AS revenue,
        COALESCE(SUM(tax_amount), 0) AS tax
      FROM sales
      WHERE status='completed'
      GROUP BY channel
      ORDER BY revenue DESC
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load sales-by-channel", details: String(e) });
  }
});

app.get("/api/reports/pnl-by-month", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT month, revenue, expenses, profit
      FROM v_pnl_by_month
      ORDER BY month DESC
      LIMIT 36
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load P&L by month", details: String(e) });
  }
});

app.get("/api/reports/stock", auth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM v_stock_on_hand ORDER BY item_type, item_id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load stock", details: String(e) });
  }
});

app.get("/api/reports/stock-enriched", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT
        s.item_type,
        s.item_id,
        s.unit,
        s.qty_on_hand,
        CASE
          WHEN s.item_type = 'supply' THEN sp.name
          WHEN s.item_type = 'crop' THEN c.crop_name
          WHEN s.item_type = 'livestock' THEN a.tag_number
          ELSE NULL
        END AS item_name
      FROM v_stock_on_hand s
      LEFT JOIN supplies sp ON (s.item_type='supply' AND sp.id = s.item_id)
      LEFT JOIN crops c     ON (s.item_type='crop' AND c.id = s.item_id)
      LEFT JOIN animals a   ON (s.item_type='livestock' AND a.id = s.item_id)
      ORDER BY s.item_type, item_name NULLS LAST, s.item_id
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load enriched stock", details: String(e) });
  }
});

// =====================
// EXPENSES
// =====================
app.get("/api/expenses", async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM expenses ORDER BY expense_date DESC, id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load expenses", details: String(e) });
  }
});

app.post("/api/expenses", async (req, res) => {
  try {
    const {
      expense_date,
      category,
      sub_category,
      vendor,
      description,
      quantity,
      unit_cost,
      tax_amount,
      total_cost,
      payment_method,
      payment_status,
      receipt_path,
      linked_type,
      linked_id,
      notes
    } = req.body;

    if (!expense_date || !category) {
      return res.status(400).json({ error: "expense_date and category are required" });
    }

    const subCat = (sub_category && String(sub_category).trim()) ? String(sub_category).trim() : "general";
    const qty = quantity != null ? Number(quantity) : 1;
    const unit = unit_cost != null ? Number(unit_cost) : 0;
    const tax = tax_amount != null ? Number(tax_amount) : 0;

    const total =
      total_cost != null && total_cost !== ""
        ? Number(total_cost)
        : (qty * unit) + tax;

    const payStatus = payment_status || "paid";

    const row = await one(
      `
      INSERT INTO expenses
      (expense_date, category, sub_category, vendor, description, quantity, unit_cost, tax_amount, total_cost,
       payment_method, payment_status, receipt_path, linked_type, linked_id, notes)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
      `,
      [
        expense_date,
        category,
        subCat,
        vendor || null,
        description || null,
        isNaN(qty) ? 1 : qty,
        isNaN(unit) ? 0 : unit,
        isNaN(tax) ? 0 : tax,
        isNaN(total) ? 0 : total,
        payment_method || null,
        payStatus,
        receipt_path || null,
        linked_type || null,
        linked_id != null && linked_id !== "" ? Number(linked_id) : null,
        notes || null
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create expense", details: String(e) });
  }
});

app.put("/api/expenses/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const {
      expense_date,
      category,
      sub_category,
      vendor,
      description,
      quantity,
      unit_cost,
      tax_amount,
      total_cost,
      payment_method,
      payment_status,
      receipt_path,
      linked_type,
      linked_id,
      notes
    } = req.body;

    if (!expense_date || !category) {
      return res.status(400).json({ error: "expense_date and category are required" });
    }

    const subCat = (sub_category && String(sub_category).trim()) ? String(sub_category).trim() : "general";
    const qty = quantity != null ? Number(quantity) : 1;
    const unit = unit_cost != null ? Number(unit_cost) : 0;
    const tax = tax_amount != null ? Number(tax_amount) : 0;

    const total =
      total_cost != null && total_cost !== ""
        ? Number(total_cost)
        : (qty * unit) + tax;

    const payStatus = payment_status || "paid";

    const row = await one(
      `
      UPDATE expenses
      SET expense_date=$1, category=$2, sub_category=$3, vendor=$4, description=$5,
          quantity=$6, unit_cost=$7, tax_amount=$8, total_cost=$9,
          payment_method=$10, payment_status=$11, receipt_path=$12,
          linked_type=$13, linked_id=$14, notes=$15
      WHERE id=$16
      RETURNING *
      `,
      [
        expense_date,
        category,
        subCat,
        vendor || null,
        description || null,
        isNaN(qty) ? 1 : qty,
        isNaN(unit) ? 0 : unit,
        isNaN(tax) ? 0 : tax,
        isNaN(total) ? 0 : total,
        payment_method || null,
        payStatus,
        receipt_path || null,
        linked_type || null,
        linked_id != null && linked_id !== "" ? Number(linked_id) : null,
        notes || null,
        id
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update expense", details: String(e) });
  }
});

// =====================
// CUSTOMERS
// =====================
app.get("/api/customers", auth, async (req, res) => {
  try {
    const rows = await all("SELECT * FROM customers ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load customers", details: String(e) });
  }
});

app.post("/api/customers", auth, async (req, res) => {
  try {
    const { name, phone, email, address, type } = req.body;
    if (!name || !type) return res.status(400).json({ error: "name and type are required" });

    const row = await one(
      `
      INSERT INTO customers (name, phone, email, address, type)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [name.trim(), phone || null, email || null, address || null, type]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create customer", details: String(e) });
  }
});

// =====================
// SALES
// =====================
app.get("/api/sales", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT s.*, c.name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.id DESC
      LIMIT 200
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load sales", details: String(e) });
  }
});

app.get("/api/sales/:id", auth, async (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const sale = await one(
      `
      SELECT s.*, c.name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1
      `,
      [saleId]
    );
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const items = await all(
      `SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id ASC`,
      [saleId]
    );

    res.json({ sale, items });
  } catch (e) {
    res.status(500).json({ error: "Failed to load sale details", details: String(e) });
  }
});

app.post("/api/sales", auth, async (req, res) => {
  try {
    const {
      sale_date,
      customer_id,
      channel,
      payment_method,
      delivery_method,
      status,
      total_amount,
      tax_amount,
      notes,
      items
    } = req.body;

    if (!sale_date || !channel || !payment_method || !delivery_method) {
      return res.status(400).json({ error: "sale_date, channel, payment_method, delivery_method are required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items[] is required (at least 1 item)" });
    }

    const computedSubtotal = items.reduce((sum, it) => {
      const q = Number(it.quantity || 0);
      const p = Number(it.price_per_unit || 0);
      return sum + (q * p);
    }, 0);

    const computedTax = Number(tax_amount ?? 0);
    const computedTotal = (Number(total_amount ?? 0) > 0)
      ? Number(total_amount)
      : (computedSubtotal + computedTax);

    const { saleRow, itemRows } = await withTx(async (client) => {
      const rSale = await client.query(
        `
        INSERT INTO sales
        (sale_date, customer_id, channel, total_amount, tax_amount, payment_method, delivery_method, status, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
        `,
        [
          sale_date,
          customer_id ? Number(customer_id) : null,
          channel,
          computedTotal,
          computedTax,
          payment_method,
          delivery_method,
          status || "completed",
          notes || null
        ]
      );

      const sale = rSale.rows[0];

      const insertedItems = [];
      for (const it of items) {
        const qty = Number(it.quantity || 0);
        const price = Number(it.price_per_unit || 0);
        const subtotal = qty * price;

        const rItem = await client.query(
          `
          INSERT INTO sale_items
          (sale_id, product_type, product_id, description, quantity, unit, price_per_unit, subtotal)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING *
          `,
          [
            sale.id,
            it.product_type || "other",
            it.product_id ? Number(it.product_id) : null,
            it.description || null,
            qty,
            it.unit || "unit",
            price,
            subtotal
          ]
        );
        insertedItems.push(rItem.rows[0]);
      }

      return { saleRow: sale, itemRows: insertedItems };
    });

    res.json({ sale: saleRow, items: itemRows });
  } catch (e) {
    res.status(500).json({ error: "Failed to create sale", details: String(e) });
  }
});

app.delete("/api/sales/:id", auth, async (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const exists = await one("SELECT id FROM sales WHERE id=$1", [saleId]);
    if (!exists) return res.status(404).json({ error: "Sale not found" });

    await withTx(async (client) => {
      // sale_items has ON DELETE CASCADE, but explicit delete is OK too
      await client.query("DELETE FROM sale_items WHERE sale_id=$1", [saleId]);
      await client.query("DELETE FROM sales WHERE id=$1", [saleId]);
    });

    res.json({ deleted: true, id: saleId });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete sale", details: String(e) });
  }
});

// =====================
// LIVESTOCK - GROUPS
// =====================
app.get("/api/livestock/groups", auth, async (req, res) => {
  try {
    const rows = await all("SELECT * FROM animal_groups ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load groups", details: String(e) });
  }
});

app.post("/api/livestock/groups", auth, async (req, res) => {
  try {
    const { name, species, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await one(
      `INSERT INTO animal_groups (name, species, notes)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [name.trim(), species || null, notes || null]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create group", details: String(e) });
  }
});

app.put("/api/livestock/groups/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, species, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const row = await one(
      `UPDATE animal_groups SET name=$1, species=$2, notes=$3 WHERE id=$4 RETURNING *`,
      [name.trim(), species || null, notes || null, id]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update group", details: String(e) });
  }
});

app.delete("/api/livestock/groups/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM animal_groups WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete group", details: String(e) });
  }
});

// =====================
// LIVESTOCK - ANIMALS
// =====================
app.get("/api/livestock/animals", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT a.*, g.name AS group_name
      FROM animals a
      LEFT JOIN animal_groups g ON g.id = a.group_id
      ORDER BY a.id DESC
      LIMIT 800
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load animals", details: String(e) });
  }
});

app.get("/api/livestock/animals/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const animal = await one(
      `
      SELECT a.*, g.name AS group_name
      FROM animals a
      LEFT JOIN animal_groups g ON g.id = a.group_id
      WHERE a.id=$1
      `,
      [id]
    );
    if (!animal) return res.status(404).json({ error: "Animal not found" });

    const health = await all(
      "SELECT * FROM animal_health WHERE animal_id=$1 ORDER BY entry_date DESC, id DESC",
      [id]
    );
    const breeding = await all(
      "SELECT * FROM breeding_records WHERE animal_id=$1 ORDER BY mating_date DESC, id DESC",
      [id]
    );
    const mortality = await all(
      "SELECT * FROM mortality WHERE animal_id=$1 ORDER BY death_date DESC, id DESC",
      [id]
    );
    const sales = await all(
      `
      SELECT ls.*, c.name AS customer_name
      FROM livestock_sales ls
      LEFT JOIN customers c ON c.id = ls.customer_id
      WHERE ls.animal_id=$1
      ORDER BY ls.sale_date DESC, ls.id DESC
      `,
      [id]
    );

    res.json({ animal, health, breeding, mortality, sales });
  } catch (e) {
    res.status(500).json({ error: "Failed to load animal details", details: String(e) });
  }
});

app.post("/api/livestock/animals", auth, async (req, res) => {
  try {
    const {
      tag_number, group_id, species, breed,
      birth_date, purchase_date, purchase_source,
      status, notes
    } = req.body;

    if (!tag_number || !species) {
      return res.status(400).json({ error: "tag_number and species are required" });
    }

    const row = await one(
      `
      INSERT INTO animals
      (tag_number, group_id, species, breed, birth_date, purchase_date, purchase_source, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        tag_number.trim(),
        group_id != null && group_id !== "" ? Number(group_id) : null,
        species.trim(),
        breed || null,
        birth_date || null,
        purchase_date || null,
        purchase_source || null,
        status || "active",
        notes || null
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create animal", details: String(e) });
  }
});

app.put("/api/livestock/animals/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      tag_number, group_id, species, breed,
      birth_date, purchase_date, purchase_source,
      status, notes
    } = req.body;

    if (!tag_number || !species) {
      return res.status(400).json({ error: "tag_number and species are required" });
    }

    const row = await one(
      `
      UPDATE animals
      SET tag_number=$1, group_id=$2, species=$3, breed=$4,
          birth_date=$5, purchase_date=$6, purchase_source=$7,
          status=$8, notes=$9
      WHERE id=$10
      RETURNING *
      `,
      [
        tag_number.trim(),
        group_id != null && group_id !== "" ? Number(group_id) : null,
        species.trim(),
        breed || null,
        birth_date || null,
        purchase_date || null,
        purchase_source || null,
        status || "active",
        notes || null,
        id
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update animal", details: String(e) });
  }
});

app.delete("/api/livestock/animals/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM animals WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete animal", details: String(e) });
  }
});

app.post("/api/livestock/animals/:id/sell", auth, async (req, res) => {
  try {
    const animalId = Number(req.params.id);
    const { sale_date, price, customer_id, payment_method, notes } = req.body;

    if (!sale_date || price == null) {
      return res.status(400).json({ error: "sale_date and price are required" });
    }

    const animal = await one("SELECT * FROM animals WHERE id=$1", [animalId]);
    if (!animal) return res.status(404).json({ error: "Animal not found" });

    const sale = await withTx(async (client) => {
      const r = await client.query(
        `
        INSERT INTO livestock_sales (animal_id, sale_date, price, customer_id, payment_method, notes)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
        `,
        [
          animalId,
          sale_date,
          Number(price),
          customer_id != null && customer_id !== "" ? Number(customer_id) : null,
          payment_method || null,
          notes || null
        ]
      );

      await client.query("UPDATE animals SET status='sold' WHERE id=$1", [animalId]);
      return r.rows[0];
    });

    res.json({ ok: true, sale });
  } catch (e) {
    res.status(500).json({ error: "Failed to record sale", details: String(e) });
  }
});

app.post("/api/livestock/animals/:id/unsell", auth, async (req, res) => {
  try {
    const animalId = Number(req.params.id);
    await q("UPDATE animals SET status='active' WHERE id=$1", [animalId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to unsell", details: String(e) });
  }
});

// =====================
// LIVESTOCK - HEALTH
// =====================
app.get("/api/livestock/health", auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 300);
    const rows = await all(
      `
      SELECT h.*, a.tag_number
      FROM animal_health h
      JOIN animals a ON a.id = h.animal_id
      ORDER BY h.entry_date DESC, h.id DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load health records", details: String(e) });
  }
});

app.post("/api/livestock/health", auth, async (req, res) => {
  try {
    const { animal_id, entry_date, type, item, dose, next_due_date, vet_name, notes } = req.body;

    if (!animal_id || !entry_date || !type || !item) {
      return res.status(400).json({ error: "animal_id, entry_date, type, item are required" });
    }

    const row = await one(
      `
      INSERT INTO animal_health
      (animal_id, entry_date, type, item, dose, next_due_date, vet_name, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        Number(animal_id),
        entry_date,
        type,
        item,
        dose || null,
        next_due_date || null,
        vet_name || null,
        notes || null
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create health record", details: String(e) });
  }
});

app.delete("/api/livestock/health/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM animal_health WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete health record", details: String(e) });
  }
});

// =====================
// LIVESTOCK - BREEDING
// =====================
app.get("/api/livestock/breeding", auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 300);
    const rows = await all(
      `
      SELECT b.*, a.tag_number
      FROM breeding_records b
      JOIN animals a ON a.id = b.animal_id
      ORDER BY b.mating_date DESC, b.id DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load breeding records", details: String(e) });
  }
});

app.post("/api/livestock/breeding", auth, async (req, res) => {
  try {
    const { animal_id, mating_date, expected_birth_date, actual_birth_date, outcome, notes } = req.body;
    if (!animal_id || !mating_date) {
      return res.status(400).json({ error: "animal_id and mating_date are required" });
    }

    const row = await one(
      `
      INSERT INTO breeding_records
      (animal_id, mating_date, expected_birth_date, actual_birth_date, outcome, notes)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        Number(animal_id),
        mating_date,
        expected_birth_date || null,
        actual_birth_date || null,
        outcome || null,
        notes || null
      ]
    );

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create breeding record", details: String(e) });
  }
});

app.delete("/api/livestock/breeding/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM breeding_records WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete breeding record", details: String(e) });
  }
});

// =====================
// LIVESTOCK - MORTALITY
// =====================
app.get("/api/livestock/mortality", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT m.*, a.tag_number
      FROM mortality m
      JOIN animals a ON a.id = m.animal_id
      ORDER BY m.death_date DESC, m.id DESC
      LIMIT 200
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load mortality", details: String(e) });
  }
});

app.post("/api/livestock/mortality", auth, async (req, res) => {
  try {
    const { animal_id, death_date, cause, notes } = req.body;
    if (!animal_id || !death_date) {
      return res.status(400).json({ error: "animal_id and death_date are required" });
    }

    const row = await withTx(async (client) => {
      const r = await client.query(
        `
        INSERT INTO mortality (animal_id, death_date, cause, notes)
        VALUES ($1,$2,$3,$4)
        RETURNING *
        `,
        [Number(animal_id), death_date, cause || null, notes || null]
      );

      await client.query("UPDATE animals SET status='deceased' WHERE id=$1", [Number(animal_id)]);
      return r.rows[0];
    });

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to record mortality", details: String(e) });
  }
});

app.delete("/api/livestock/mortality/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const rec = await one("SELECT animal_id FROM mortality WHERE id=$1", [id]);
    if (!rec) return res.status(404).json({ error: "Mortality record not found" });

    await withTx(async (client) => {
      await client.query("DELETE FROM mortality WHERE id=$1", [id]);
      await client.query("UPDATE animals SET status='active' WHERE id=$1", [rec.animal_id]);
    });

    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to undo mortality", details: String(e) });
  }
});

// =====================
// LIVESTOCK - EGGS
// =====================
app.get("/api/livestock/eggs", auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 600);
    const rows = await all(
      `
      SELECT ep.*, g.name AS group_name
      FROM egg_production ep
      LEFT JOIN animal_groups g ON g.id = ep.group_id
      ORDER BY ep.prod_date DESC, ep.id DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load egg production", details: String(e) });
  }
});

app.get("/api/livestock/eggs/summary", auth, async (req, res) => {
  try {
    const row = await one(
      `
      SELECT
        COALESCE(SUM(eggs_collected),0) AS eggs_collected,
        COALESCE(SUM(eggs_broken),0) AS eggs_broken,
        COALESCE(SUM(trays),0) AS trays
      FROM egg_production
      `
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to load egg summary", details: String(e) });
  }
});

app.post("/api/livestock/eggs", auth, async (req, res) => {
  try {
    const { prod_date, group_id, eggs_collected, eggs_broken, trays, notes } = req.body;
    if (!prod_date) return res.status(400).json({ error: "prod_date is required" });

    const row = await one(
      `
      INSERT INTO egg_production
      (prod_date, group_id, eggs_collected, eggs_broken, trays, notes)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        prod_date,
        group_id != null && group_id !== "" ? Number(group_id) : null,
        Number(eggs_collected || 0),
        Number(eggs_broken || 0),
        Number(trays || 0),
        notes || null
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to save egg production", details: String(e) });
  }
});

app.delete("/api/livestock/eggs/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM egg_production WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete egg record", details: String(e) });
  }
});

// =====================
// STORAGE LOCATIONS
// =====================
app.get("/api/storage-locations", auth, async (req, res) => {
  try {
    const rows = await all("SELECT * FROM storage_locations ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load storage locations", details: String(e) });
  }
});

// =====================
// SUPPLIES CRUD
// =====================
app.get("/api/supplies", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT s.*, sl.name AS storage_name
      FROM supplies s
      LEFT JOIN storage_locations sl ON sl.id = s.storage_location_id
      ORDER BY s.id DESC
      LIMIT 800
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load supplies", details: String(e) });
  }
});

app.post("/api/supplies", auth, async (req, res) => {
  try {
    const {
      category, name, quantity_on_hand, unit, reorder_point,
      purchase_date, expiration_date, storage_location_id, notes
    } = req.body;

    if (!category || !name) return res.status(400).json({ error: "category and name are required" });

    const row = await one(
      `
      INSERT INTO supplies
      (category, name, quantity_on_hand, unit, reorder_point, purchase_date, expiration_date, storage_location_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        category,
        name.trim(),
        Number(quantity_on_hand || 0),
        unit || "unit",
        Number(reorder_point || 0),
        purchase_date || null,
        expiration_date || null,
        storage_location_id != null && storage_location_id !== "" ? Number(storage_location_id) : null,
        notes || null
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to create supply", details: String(e) });
  }
});

app.put("/api/supplies/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      category, name, quantity_on_hand, unit, reorder_point,
      purchase_date, expiration_date, storage_location_id, notes
    } = req.body;

    if (!category || !name) return res.status(400).json({ error: "category and name are required" });

    const row = await one(
      `
      UPDATE supplies
      SET category=$1, name=$2, quantity_on_hand=$3, unit=$4, reorder_point=$5,
          purchase_date=$6, expiration_date=$7, storage_location_id=$8, notes=$9
      WHERE id=$10
      RETURNING *
      `,
      [
        category,
        name.trim(),
        Number(quantity_on_hand || 0),
        unit || "unit",
        Number(reorder_point || 0),
        purchase_date || null,
        expiration_date || null,
        storage_location_id != null && storage_location_id !== "" ? Number(storage_location_id) : null,
        notes || null,
        id
      ]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "Failed to update supply", details: String(e) });
  }
});

app.delete("/api/supplies/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await q("DELETE FROM supplies WHERE id=$1", [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete supply", details: String(e) });
  }
});

// =====================
// SUPPLY USAGE (consumption)
// =====================
app.get("/api/supply-usage", auth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 600);
    const rows = await all(
      `
      SELECT u.*, s.name AS supply_name
      FROM supply_usage u
      JOIN supplies s ON s.id = u.supply_id
      ORDER BY u.use_date DESC, u.id DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load supply usage", details: String(e) });
  }
});

app.post("/api/supply-usage", auth, async (req, res) => {
  try {
    const { supply_id, use_date, quantity_used, unit, linked_field_id, linked_group_id, notes } = req.body;

    if (!supply_id || !use_date || quantity_used == null) {
      return res.status(400).json({ error: "supply_id, use_date, quantity_used are required" });
    }

    const qty = Number(quantity_used);
    if (Number.isNaN(qty) || qty <= 0) return res.status(400).json({ error: "quantity_used must be > 0" });

    const created = await withTx(async (client) => {
      const supply = await client.query("SELECT * FROM supplies WHERE id=$1 FOR UPDATE", [Number(supply_id)]);
      if (!supply.rows[0]) throw new Error("Supply not found");

      const sup = supply.rows[0];
      const newQty = Number(sup.quantity_on_hand || 0) - qty;

      const rUsage = await client.query(
        `
        INSERT INTO supply_usage
        (supply_id, use_date, quantity_used, unit, linked_field_id, linked_group_id, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *
        `,
        [
          Number(supply_id),
          use_date,
          qty,
          unit || sup.unit || "unit",
          linked_field_id != null && linked_field_id !== "" ? Number(linked_field_id) : null,
          linked_group_id != null && linked_group_id !== "" ? Number(linked_group_id) : null,
          notes || null
        ]
      );

      await client.query("UPDATE supplies SET quantity_on_hand=$1 WHERE id=$2", [newQty, Number(supply_id)]);
      return rUsage.rows[0];
    });

    res.json(created);
  } catch (e) {
    res.status(500).json({ error: "Failed to record supply usage", details: String(e) });
  }
});

app.delete("/api/supply-usage/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    await withTx(async (client) => {
      const rec = await client.query("SELECT * FROM supply_usage WHERE id=$1", [id]);
      if (!rec.rows[0]) throw new Error("Usage record not found");

      const usage = rec.rows[0];

      const supply = await client.query("SELECT * FROM supplies WHERE id=$1 FOR UPDATE", [usage.supply_id]);
      if (!supply.rows[0]) throw new Error("Supply not found");

      const sup = supply.rows[0];
      const restored = Number(sup.quantity_on_hand || 0) + Number(usage.quantity_used || 0);

      await client.query("DELETE FROM supply_usage WHERE id=$1", [id]);
      await client.query("UPDATE supplies SET quantity_on_hand=$1 WHERE id=$2", [restored, usage.supply_id]);
    });

    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete usage", details: String(e) });
  }
});

// =====================
// INVENTORY MOVEMENTS (manual)
// =====================
app.get("/api/inventory/movements", auth, async (req, res) => {
  try {
    const rows = await all(
      `
      SELECT
        m.*,
        CASE
          WHEN m.item_type = 'supply' THEN sp.name
          WHEN m.item_type = 'crop' THEN c.crop_name
          WHEN m.item_type = 'livestock' THEN a.tag_number
          ELSE NULL
        END AS item_name
      FROM inventory_movements m
      LEFT JOIN supplies sp ON (m.item_type='supply' AND sp.id = m.item_id)
      LEFT JOIN crops c     ON (m.item_type='crop' AND c.id = m.item_id)
      LEFT JOIN animals a   ON (m.item_type='livestock' AND a.id = m.item_id)
      ORDER BY m.id DESC
      LIMIT 200
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to load movements", details: String(e) });
  }
});

app.post("/api/inventory/movements", auth, async (req, res) => {
  try {
    const { item_type, item_id, direction, quantity, unit, reason, storage_location_id, notes } = req.body;

    if (!item_type || !item_id || !direction || quantity == null || !unit || !reason) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const qn = Number(quantity);
    if (Number.isNaN(qn) || qn < 0) return res.status(400).json({ error: "Quantity must be a valid number >= 0" });

    if (!["in", "out"].includes(direction)) {
      return res.status(400).json({ error: "Direction must be 'in' or 'out'" });
    }

    const row = await one(
      `
      INSERT INTO inventory_movements
      (movement_time, item_type, item_id, storage_location_id, direction, quantity, unit, reason, notes)
      VALUES (NOW(), $1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        item_type,
        Number(item_id),
        storage_location_id != null && storage_location_id !== "" ? Number(storage_location_id) : null,
        direction,
        qn,
        unit,
        reason,
        notes || null
      ]
    );

    res.json({ ok: true, movement: row });
  } catch (e) {
    res.status(500).json({ error: "Failed to create movement", details: String(e) });
  }
});

// -----------------------------
// Start
// -----------------------------
initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("❌ Failed to init DB:", e);
    process.exit(1);
  });








