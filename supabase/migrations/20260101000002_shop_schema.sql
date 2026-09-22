-- Demo domain: an omnichannel retailer (online orders + physical stores). 20 tables.
-- Integer identity keys are used (instead of UUIDs) so results are readable and seeding is deterministic.

-- SET LOCAL: scoped to this migration's transaction. (A plain SET leaked into later migrations on the same connection and hid the
-- `extensions` schema where managed platforms such as Supabase install pgvector.)
SET LOCAL search_path = shop, public, extensions;

-- ───────────────────────── Organisation ─────────────────────────
CREATE TABLE departments (
  department_id  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  description    text
);

CREATE TABLE stores (
  store_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  city           text NOT NULL,
  region         text,
  country        text NOT NULL,
  store_type     text NOT NULL CHECK (store_type IN ('flagship','standard','outlet')),
  opened_date    date NOT NULL,
  floor_area_sqm integer
);

CREATE TABLE employees (
  employee_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  email          text NOT NULL UNIQUE,
  job_title      text NOT NULL,
  department_id  integer NOT NULL REFERENCES departments(department_id),
  store_id       integer REFERENCES stores(store_id),
  manager_id     integer REFERENCES employees(employee_id),
  hire_date      date NOT NULL,
  salary         numeric(10,2) NOT NULL CHECK (salary > 0),
  is_active      boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_store      ON employees(store_id);

-- ───────────────────────── Catalogue ─────────────────────────
CREATE TABLE product_categories (
  category_id  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  description  text
);

CREATE TABLE product_brands (
  brand_id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  country_of_origin  text
);

CREATE TABLE suppliers (
  supplier_id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  contact_email   text,
  country         text NOT NULL,
  rating          numeric(2,1) CHECK (rating BETWEEN 1 AND 5),
  lead_time_days  integer NOT NULL CHECK (lead_time_days >= 0),
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE products (
  product_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  category_id  integer NOT NULL REFERENCES product_categories(category_id),
  brand_id     integer NOT NULL REFERENCES product_brands(brand_id),
  supplier_id  integer NOT NULL REFERENCES suppliers(supplier_id),
  unit_price   numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost    numeric(10,2) NOT NULL CHECK (unit_cost >= 0),
  weight_kg    numeric(6,2),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL
);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand    ON products(brand_id);
CREATE INDEX idx_products_supplier ON products(supplier_id);

-- ───────────────────────── Inventory ─────────────────────────
CREATE TABLE warehouses (
  warehouse_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  city            text NOT NULL,
  country         text NOT NULL,
  capacity_units  integer NOT NULL
);

CREATE TABLE warehouse_inventory (
  warehouse_id       integer NOT NULL REFERENCES warehouses(warehouse_id),
  product_id         integer NOT NULL REFERENCES products(product_id),
  quantity_on_hand   integer NOT NULL CHECK (quantity_on_hand >= 0),
  reorder_level      integer NOT NULL CHECK (reorder_level >= 0),
  last_restocked_at  timestamptz,
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE INDEX idx_wh_inventory_product ON warehouse_inventory(product_id);

CREATE TABLE inventory_movements (
  movement_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       integer NOT NULL REFERENCES products(product_id),
  warehouse_id     integer NOT NULL REFERENCES warehouses(warehouse_id),
  movement_type    text NOT NULL CHECK (movement_type IN ('restock','sale','return','adjustment')),
  quantity_change  integer NOT NULL,
  moved_at         timestamptz NOT NULL
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id, moved_at);
CREATE INDEX idx_movements_wh      ON inventory_movements(warehouse_id);

-- ───────────────────────── Customers ─────────────────────────
CREATE TABLE customers (
  customer_id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text NOT NULL UNIQUE,
  phone                text,
  birth_date           date,
  signup_date          date NOT NULL,
  segment              text NOT NULL CHECK (segment IN ('standard','premium','vip')),
  acquisition_channel  text NOT NULL CHECK (acquisition_channel IN ('organic','paid_search','social','email','referral')),
  is_active            boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_customers_signup ON customers(signup_date);

CREATE TABLE customer_addresses (
  address_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   integer NOT NULL REFERENCES customers(customer_id),
  address_type  text NOT NULL CHECK (address_type IN ('shipping','billing')),
  street        text NOT NULL,
  city          text NOT NULL,
  region        text,
  postal_code   text,
  country       text NOT NULL,
  is_default    boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX idx_addresses_city     ON customer_addresses(city);

-- ───────────────────────── Sales ─────────────────────────
CREATE TABLE promotions (
  promotion_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text,
  discount_type     text NOT NULL CHECK (discount_type IN ('percentage','fixed')),
  discount_value    numeric(8,2) NOT NULL CHECK (discount_value > 0),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  min_order_amount  numeric(10,2) NOT NULL DEFAULT 0,
  CHECK (end_date >= start_date)
);

CREATE TABLE orders (
  order_id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id          integer NOT NULL REFERENCES customers(customer_id),
  order_date           timestamptz NOT NULL,
  status               text NOT NULL CHECK (status IN ('pending','processing','shipped','delivered','cancelled')),
  promotion_id         integer REFERENCES promotions(promotion_id),
  shipping_address_id  integer REFERENCES customer_addresses(address_id),
  total_amount         numeric(12,2) NOT NULL CHECK (total_amount >= 0)
);
CREATE INDEX idx_orders_customer  ON orders(customer_id);
CREATE INDEX idx_orders_date      ON orders(order_date);
CREATE INDEX idx_orders_status    ON orders(status);
CREATE INDEX idx_orders_promotion ON orders(promotion_id);

CREATE TABLE order_items (
  order_item_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         integer NOT NULL REFERENCES orders(order_id),
  product_id       integer NOT NULL REFERENCES products(product_id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price       numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount  numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total       numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price - discount_amount) STORED
);
CREATE INDEX idx_order_items_order   ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

CREATE TABLE payments (
  payment_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         integer NOT NULL REFERENCES orders(order_id),
  payment_method   text NOT NULL CHECK (payment_method IN ('credit_card','debit_card','paypal','bank_transfer','gift_card')),
  amount           numeric(12,2) NOT NULL CHECK (amount >= 0),
  status           text NOT NULL CHECK (status IN ('paid','failed','refunded')),
  paid_at          timestamptz NOT NULL
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE refunds (
  refund_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id       integer NOT NULL REFERENCES orders(order_id),
  payment_id     integer NOT NULL REFERENCES payments(payment_id),
  refund_amount  numeric(12,2) NOT NULL CHECK (refund_amount > 0),
  reason         text NOT NULL CHECK (reason IN ('damaged','wrong_item','not_as_described','changed_mind','late_delivery')),
  refunded_at    timestamptz NOT NULL
);
CREATE INDEX idx_refunds_order ON refunds(order_id);

CREATE TABLE shipping (
  shipping_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         integer NOT NULL REFERENCES orders(order_id),
  warehouse_id     integer NOT NULL REFERENCES warehouses(warehouse_id),
  carrier          text NOT NULL,
  tracking_number  text NOT NULL,
  status           text NOT NULL CHECK (status IN ('preparing','in_transit','delivered','returned')),
  shipping_cost    numeric(8,2) NOT NULL CHECK (shipping_cost >= 0),
  shipped_at       timestamptz,
  delivered_at     timestamptz
);
CREATE INDEX idx_shipping_order     ON shipping(order_id);
CREATE INDEX idx_shipping_warehouse ON shipping(warehouse_id);

CREATE TABLE store_sales (
  sale_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(store_id),
  employee_id   integer NOT NULL REFERENCES employees(employee_id),
  product_id    integer NOT NULL REFERENCES products(product_id),
  sale_date     date NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  unit_price    numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  total_amount  numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);
CREATE INDEX idx_store_sales_store    ON store_sales(store_id, sale_date);
CREATE INDEX idx_store_sales_product  ON store_sales(product_id);
CREATE INDEX idx_store_sales_employee ON store_sales(employee_id);

CREATE TABLE reviews (
  review_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   integer NOT NULL REFERENCES products(product_id),
  customer_id  integer NOT NULL REFERENCES customers(customer_id),
  rating       integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        text,
  body         text,
  created_at   timestamptz NOT NULL
);
CREATE INDEX idx_reviews_product  ON reviews(product_id);
CREATE INDEX idx_reviews_customer ON reviews(customer_id);
