-- =========================
-- Namasenene Farm - Postgres schema (Neon)
-- =========================

-- Optional but helpful (Neon supports extensions):
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===================
-- FARM PROFILE (single)
-- ===================
CREATE TABLE IF NOT EXISTS farm_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  farm_name TEXT NOT NULL,
  location TEXT,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO farm_profile (id, farm_name)
VALUES (1, 'Namasenene Farm')
ON CONFLICT (id) DO NOTHING;

-- =====
-- USERS
-- =====
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
);

-- ==========
-- FARM SETUP
-- ==========
CREATE TABLE IF NOT EXISTS fields (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  size_acres DOUBLE PRECISION,
  soil_type TEXT,
  irrigation_type TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crops (
  id BIGSERIAL PRIMARY KEY,
  crop_name TEXT NOT NULL,
  variety TEXT,
  unit_default TEXT NOT NULL DEFAULT 'kg',
  UNIQUE(crop_name, variety)
);

-- ============
-- CROP TRACKING
-- ============
CREATE TABLE IF NOT EXISTS plantings (
  id BIGSERIAL PRIMARY KEY,
  field_id BIGINT NOT NULL,
  crop_id BIGINT NOT NULL,
  planting_date DATE NOT NULL,
  seed_source TEXT,
  quantity_planted DOUBLE PRECISION NOT NULL DEFAULT 0,
  quantity_unit TEXT NOT NULL DEFAULT 'seed',
  expected_harvest_date DATE,
  status TEXT NOT NULL DEFAULT 'planted'
    CHECK(status IN ('planned','planted','germination','flowering','fruiting','harvest_ready','completed','failed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_plantings_field FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE RESTRICT,
  CONSTRAINT fk_plantings_crop  FOREIGN KEY (crop_id)  REFERENCES crops(id)  ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS harvests (
  id BIGSERIAL PRIMARY KEY,
  planting_id BIGINT NOT NULL,
  harvest_date DATE NOT NULL,
  quantity DOUBLE PRECISION NOT NULL CHECK(quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'kg',
  quality_grade TEXT,
  storage_location_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_harvests_planting FOREIGN KEY (planting_id) REFERENCES plantings(id) ON DELETE RESTRICT
);

-- ==================
-- STORAGE & ENV LOGS
-- ==================
CREATE TABLE IF NOT EXISTS storage_locations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('bin','shed','cooler','freezer','warehouse','other')),
  target_temp_c DOUBLE PRECISION,
  target_humidity DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage_logs (
  id BIGSERIAL PRIMARY KEY,
  storage_location_id BIGINT NOT NULL,
  log_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  temperature_c DOUBLE PRECISION,
  humidity DOUBLE PRECISION,
  notes TEXT,
  CONSTRAINT fk_storage_logs_location FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crop_waste (
  id BIGSERIAL PRIMARY KEY,
  waste_date DATE NOT NULL,
  crop_id BIGINT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL CHECK(quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'kg',
  reason TEXT NOT NULL,
  storage_location_id BIGINT,
  notes TEXT,
  CONSTRAINT fk_crop_waste_crop FOREIGN KEY (crop_id) REFERENCES crops(id) ON DELETE RESTRICT,
  CONSTRAINT fk_crop_waste_storage FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id) ON DELETE SET NULL
);

-- ==========
-- LIVESTOCK
-- ==========
CREATE TABLE IF NOT EXISTS animal_groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  species TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS animals (
  id BIGSERIAL PRIMARY KEY,
  tag_number TEXT NOT NULL UNIQUE,
  group_id BIGINT,
  species TEXT NOT NULL,
  breed TEXT,
  birth_date DATE,
  purchase_date DATE,
  purchase_source TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','deceased')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_animals_group FOREIGN KEY (group_id) REFERENCES animal_groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS animal_health (
  id BIGSERIAL PRIMARY KEY,
  animal_id BIGINT NOT NULL,
  entry_date DATE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('vaccination','medication','treatment','checkup')),
  item TEXT NOT NULL,
  dose TEXT,
  next_due_date DATE,
  vet_name TEXT,
  notes TEXT,
  CONSTRAINT fk_animal_health_animal FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS breeding_records (
  id BIGSERIAL PRIMARY KEY,
  animal_id BIGINT NOT NULL,
  mating_date DATE NOT NULL,
  expected_birth_date DATE,
  actual_birth_date DATE,
  outcome TEXT,
  notes TEXT,
  CONSTRAINT fk_breeding_animal FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mortality (
  id BIGSERIAL PRIMARY KEY,
  animal_id BIGINT NOT NULL,
  death_date DATE NOT NULL,
  cause TEXT,
  notes TEXT,
  CONSTRAINT fk_mortality_animal FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE
);

-- ==========
-- SUPPLIES
-- ==========
CREATE TABLE IF NOT EXISTS supplies (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('seed','seedling','feed','fertilizer','chemical','equipment_part','packaging','other')),
  name TEXT NOT NULL,
  quantity_on_hand DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'unit',
  reorder_point DOUBLE PRECISION DEFAULT 0,
  purchase_date DATE,
  expiration_date DATE,
  storage_location_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(category, name),
  CONSTRAINT fk_supplies_storage FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS supply_usage (
  id BIGSERIAL PRIMARY KEY,
  supply_id BIGINT NOT NULL,
  use_date DATE NOT NULL,
  quantity_used DOUBLE PRECISION NOT NULL CHECK(quantity_used >= 0),
  unit TEXT NOT NULL,
  linked_field_id BIGINT,
  linked_group_id BIGINT,
  notes TEXT,
  CONSTRAINT fk_supply_usage_supply FOREIGN KEY (supply_id) REFERENCES supplies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supply_usage_field FOREIGN KEY (linked_field_id) REFERENCES fields(id) ON DELETE SET NULL,
  CONSTRAINT fk_supply_usage_group FOREIGN KEY (linked_group_id) REFERENCES animal_groups(id) ON DELETE SET NULL
);

-- ==========
-- FINANCE (KEEP THIS ONE - detailed)
-- ==========
CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  expense_date DATE NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('fixed','variable','capital')),
  sub_category TEXT NOT NULL,
  vendor TEXT,
  description TEXT,
  quantity DOUBLE PRECISION DEFAULT 1,
  unit_cost DOUBLE PRECISION DEFAULT 0,
  tax_amount DOUBLE PRECISION DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL,
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('paid','pending','overdue')),
  receipt_path TEXT,
  linked_type TEXT,
  linked_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- =====
-- SALES
-- =====
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT,
  address TEXT,
  type TEXT NOT NULL CHECK(type IN ('retail','wholesale','csa')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  sale_date DATE NOT NULL,
  customer_id BIGINT,
  channel TEXT NOT NULL CHECK(channel IN ('farmers_market','csa','wholesale','online','farm_stand','u_pick','other')),
  total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  delivery_method TEXT NOT NULL DEFAULT 'pickup' CHECK(delivery_method IN ('pickup','delivery','shipped')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('draft','completed','refunded','void')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

CREATE TABLE IF NOT EXISTS sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL,
  product_type TEXT NOT NULL CHECK(product_type IN ('crop','livestock','supply','other')),
  product_id BIGINT,
  description TEXT,
  quantity DOUBLE PRECISION NOT NULL CHECK(quantity >= 0),
  unit TEXT NOT NULL,
  price_per_unit DOUBLE PRECISION NOT NULL DEFAULT 0,
  subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pricing_history (
  id BIGSERIAL PRIMARY KEY,
  product_type TEXT NOT NULL CHECK(product_type IN ('crop','livestock','supply','other')),
  product_id BIGINT,
  product_name TEXT,
  price DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  notes TEXT
);

-- =========================
-- INVENTORY ENGINE (MOVES)
-- =========================
CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  movement_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  item_type TEXT NOT NULL CHECK(item_type IN ('crop','livestock','supply','product')),
  item_id BIGINT NOT NULL,
  storage_location_id BIGINT,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  quantity DOUBLE PRECISION NOT NULL CHECK(quantity >= 0),
  unit TEXT NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id BIGINT,
  notes TEXT,
  CONSTRAINT fk_moves_storage FOREIGN KEY (storage_location_id) REFERENCES storage_locations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_moves_time ON inventory_movements(movement_time);
CREATE INDEX IF NOT EXISTS idx_moves_item ON inventory_movements(item_type, item_id);

-- =========================
-- LIVESTOCK SALES + EGGS
-- =========================
CREATE TABLE IF NOT EXISTS livestock_sales (
  id BIGSERIAL PRIMARY KEY,
  animal_id BIGINT NOT NULL,
  sale_date DATE NOT NULL,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  customer_id BIGINT,
  payment_method TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_livestock_sales_animal FOREIGN KEY (animal_id) REFERENCES animals(id) ON DELETE CASCADE,
  CONSTRAINT fk_livestock_sales_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_livestock_sales_date ON livestock_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_livestock_sales_animal ON livestock_sales(animal_id);

CREATE TABLE IF NOT EXISTS egg_production (
  id BIGSERIAL PRIMARY KEY,
  prod_date DATE NOT NULL,
  group_id BIGINT,
  eggs_collected INTEGER NOT NULL DEFAULT 0 CHECK(eggs_collected >= 0),
  eggs_broken INTEGER NOT NULL DEFAULT 0 CHECK(eggs_broken >= 0),
  trays INTEGER NOT NULL DEFAULT 0 CHECK(trays >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_egg_group FOREIGN KEY (group_id) REFERENCES animal_groups(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_egg_prod_date ON egg_production(prod_date);
CREATE INDEX IF NOT EXISTS idx_egg_prod_group ON egg_production(group_id);

-- =========
-- REPORTS (VIEWS)
-- =========

CREATE OR REPLACE VIEW v_stock_on_hand AS
SELECT
  item_type,
  item_id,
  unit,
  SUM(CASE WHEN direction='in' THEN quantity ELSE -quantity END) AS qty_on_hand
FROM inventory_movements
GROUP BY item_type, item_id, unit;

CREATE OR REPLACE VIEW v_revenue_by_month AS
SELECT
  to_char(sale_date, 'YYYY-MM') AS month,
  SUM(total_amount) AS revenue,
  SUM(tax_amount) AS sales_tax
FROM sales
WHERE status='completed'
GROUP BY to_char(sale_date, 'YYYY-MM');

CREATE OR REPLACE VIEW v_expenses_by_month AS
SELECT
  to_char(expense_date, 'YYYY-MM') AS month,
  SUM(total_cost) AS expenses,
  SUM(tax_amount) AS expense_tax
FROM expenses
GROUP BY to_char(expense_date, 'YYYY-MM');

CREATE OR REPLACE VIEW v_pnl_by_month AS
SELECT
  r.month,
  r.revenue,
  COALESCE(e.expenses, 0) AS expenses,
  (r.revenue - COALESCE(e.expenses, 0)) AS profit
FROM v_revenue_by_month r
LEFT JOIN v_expenses_by_month e
  ON e.month = r.month;