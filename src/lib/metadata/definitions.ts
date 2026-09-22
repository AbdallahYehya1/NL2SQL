import type { ColumnMeta, DefaultRule, MetricMeta, TableMeta } from "@/lib/types";

/**
 * Application-level metadata for the `shop` schema: semantic descriptions, business meaning, synonyms,
 * sample values and business metrics. This is deliberately richer than information_schema — it is what the
 * router, sub-schema builder and SQL generator "know" about the business.
 *
 * A consistency test (tests/integration/registry-vs-db.test.ts) verifies this file against the live database
 * so the registry cannot silently drift from the migrations.
 */

const col = (name: string, type: string, description: string, opts: Partial<ColumnMeta> = {}): ColumnMeta => ({ name, type, description, ...opts });
const pk = (name: string, description: string): ColumnMeta => col(name, "integer", description, { primaryKey: true });
const fk = (name: string, table: string, column: string, description: string, opts: Partial<ColumnMeta> = {}): ColumnMeta =>
  col(name, "integer", description, { references: { table, column }, ...opts });

export const TABLES: TableMeta[] = [
  // ───────────── sales ─────────────
  {
    name: "orders",
    domain: "sales",
    description: "Online customer purchase transactions (one row per order).",
    businessMeaning:
      "The header of an online purchase. Line-level detail is in order_items. In-store purchases are NOT in this table (see store_sales). A 'completed' order has status shipped or delivered.",
    synonyms: ["order", "purchase", "purchases", "transaction", "transactions", "checkout", "sale", "sales", "bought", "online order"],
    primaryKey: ["order_id"],
    columns: [
      pk("order_id", "Unique identifier of the order"),
      fk("customer_id", "customers", "customer_id", "Customer who placed the order"),
      col("order_date", "timestamptz", "Date and time the order was placed", {
        businessMeaning: "The date used for all time-based revenue and order analysis (month, year, last month, trend).",
        synonyms: ["date", "when", "placed", "created", "month", "year", "period", "time"],
        core: true,
      }),
      col("status", "text", "Fulfilment status of the order", {
        businessMeaning: "shipped and delivered = completed (counted as revenue); pending/processing = not yet fulfilled; cancelled = never fulfilled.",
        sampleValues: ["pending", "processing", "shipped", "delivered", "cancelled"],
        synonyms: ["state", "completed", "cancelled", "canceled", "fulfilled"],
        core: true,
      }),
      fk("promotion_id", "promotions", "promotion_id", "Promotion/discount campaign applied to the order, if any (NULL = no promotion)"),
      fk("shipping_address_id", "customer_addresses", "address_id", "Address the order was shipped to (source of the order's city/country)"),
      col("total_amount", "numeric(12,2)", "Merchandise total of the order after discounts (sum of its line_total values)", {
        businessMeaning: "Excludes shipping cost (see shipping.shipping_cost). Equals SUM(order_items.line_total) for the order.",
        synonyms: ["amount", "value", "total", "order value", "basket"],
        core: true,
      }),
    ],
  },
  {
    name: "order_items",
    domain: "sales",
    description: "Line items of an order: which product, how many, at what price.",
    businessMeaning: "The grain for product/category revenue and units sold. line_total is quantity * unit_price - discount_amount.",
    synonyms: ["line item", "line items", "order lines", "items sold", "basket items", "units", "products sold"],
    primaryKey: ["order_item_id"],
    columns: [
      pk("order_item_id", "Unique identifier of the order line"),
      fk("order_id", "orders", "order_id", "Order this line belongs to"),
      fk("product_id", "products", "product_id", "Product that was purchased"),
      col("quantity", "integer", "Number of units purchased", { synonyms: ["units", "qty", "count sold"], core: true }),
      col("unit_price", "numeric(10,2)", "Price per unit at the time of purchase (before discount)", { core: true }),
      col("discount_amount", "numeric(10,2)", "Total promotion discount applied to this line (currency amount, not percent)"),
      col("line_total", "numeric(12,2)", "Revenue of the line = quantity * unit_price - discount_amount (generated column)", {
        businessMeaning: "Use SUM(line_total) for revenue by product, category, brand or supplier.",
        synonyms: ["revenue", "sales amount", "line revenue"],
        core: true,
      }),
    ],
  },
  {
    name: "payments",
    domain: "sales",
    description: "Payments made against orders, including the payment method and payment outcome.",
    synonyms: ["payment", "paid", "payment method", "card", "paypal", "billing"],
    primaryKey: ["payment_id"],
    columns: [
      pk("payment_id", "Unique identifier of the payment"),
      fk("order_id", "orders", "order_id", "Order this payment belongs to"),
      col("payment_method", "text", "How the customer paid", { sampleValues: ["credit_card", "debit_card", "paypal", "bank_transfer", "gift_card"], synonyms: ["method", "card type"], core: true }),
      col("amount", "numeric(12,2)", "Amount charged", { core: true }),
      col("status", "text", "Outcome of the payment", { sampleValues: ["paid", "failed", "refunded"], businessMeaning: "refunded = the payment was fully refunded.", core: true }),
      col("paid_at", "timestamptz", "When the payment was made"),
    ],
  },
  {
    name: "refunds",
    domain: "sales",
    description: "Refunds issued to customers for orders (full or partial).",
    businessMeaning: "An order is 'refunded' if at least one row exists here for it. Refund rate = refunded orders / completed orders.",
    synonyms: ["refund", "refunded", "returned money", "money back", "chargeback", "return", "returns"],
    primaryKey: ["refund_id"],
    columns: [
      pk("refund_id", "Unique identifier of the refund"),
      fk("order_id", "orders", "order_id", "Order that was refunded"),
      fk("payment_id", "payments", "payment_id", "Payment the refund was issued against"),
      col("refund_amount", "numeric(12,2)", "Amount refunded to the customer", { core: true }),
      col("reason", "text", "Why the refund was issued", {
        sampleValues: ["damaged", "wrong_item", "not_as_described", "changed_mind", "late_delivery"],
        synonyms: ["cause", "why"],
        core: true,
      }),
      col("refunded_at", "timestamptz", "When the refund was issued"),
    ],
  },
  {
    name: "shipping",
    domain: "sales",
    description: "Shipment of an online order from a warehouse: carrier, cost, dispatch and delivery times.",
    synonyms: ["shipment", "shipments", "delivery", "deliveries", "carrier", "courier", "tracking", "freight", "dispatch"],
    primaryKey: ["shipping_id"],
    columns: [
      pk("shipping_id", "Unique identifier of the shipment"),
      fk("order_id", "orders", "order_id", "Order being shipped"),
      fk("warehouse_id", "warehouses", "warehouse_id", "Warehouse the shipment left from"),
      col("carrier", "text", "Shipping carrier", { sampleValues: ["FedEx", "UPS", "DHL", "USPS", "Royal Mail", "Canada Post"], synonyms: ["courier", "shipper"], core: true }),
      col("tracking_number", "text", "Carrier tracking number"),
      col("status", "text", "Shipment status", { sampleValues: ["preparing", "in_transit", "delivered", "returned"], core: true }),
      col("shipping_cost", "numeric(8,2)", "Cost of shipping the order", { synonyms: ["freight cost", "delivery cost", "postage"], core: true }),
      col("shipped_at", "timestamptz", "When the shipment was dispatched (NULL if still preparing)"),
      col("delivered_at", "timestamptz", "When the shipment was delivered (NULL if not yet delivered)", {
        businessMeaning: "Delivery time = delivered_at - shipped_at.",
        synonyms: ["arrival"],
      }),
    ],
  },
  {
    name: "promotions",
    domain: "sales",
    description: "Discount / marketing promotion campaigns that can be applied to orders.",
    businessMeaning:
      "Each campaign occurrence is one row (e.g. BLACKFRIDAY30-2025). Promotion revenue = revenue of orders whose promotion_id references the row.",
    synonyms: ["promotion", "promo", "discount", "discounts", "coupon", "campaign", "voucher", "offer", "sale event"],
    primaryKey: ["promotion_id"],
    columns: [
      pk("promotion_id", "Unique identifier of the promotion"),
      col("code", "text", "Promotion code", { sampleValues: ["WELCOME10", "BLACKFRIDAY30-2025", "SUMMER20-2025"], synonyms: ["coupon code"], core: true }),
      col("name", "text", "Display name of the promotion", { core: true }),
      col("description", "text", "What the promotion offers"),
      col("discount_type", "text", "percentage or fixed-amount discount", { sampleValues: ["percentage", "fixed"] }),
      col("discount_value", "numeric(8,2)", "Percent (for percentage) or currency amount (for fixed)"),
      col("start_date", "date", "First day the promotion is valid"),
      col("end_date", "date", "Last day the promotion is valid"),
      col("min_order_amount", "numeric(10,2)", "Minimum order value required to use the promotion"),
    ],
  },
  {
    name: "store_sales",
    domain: "sales",
    description: "In-store (point-of-sale) sales lines made in physical stores by store employees.",
    businessMeaning: "Separate from online orders. Use for store performance and employee sales. total_amount = quantity * unit_price.",
    synonyms: ["store sales", "in-store", "in store", "retail sales", "pos", "point of sale", "store revenue", "offline sales"],
    primaryKey: ["sale_id"],
    columns: [
      pk("sale_id", "Unique identifier of the in-store sale line"),
      fk("store_id", "stores", "store_id", "Store where the sale happened"),
      fk("employee_id", "employees", "employee_id", "Employee who made the sale"),
      fk("product_id", "products", "product_id", "Product sold"),
      col("sale_date", "date", "Date of the sale", { synonyms: ["date", "when", "month", "year"], core: true }),
      col("quantity", "integer", "Units sold", { core: true }),
      col("unit_price", "numeric(10,2)", "Price per unit"),
      col("total_amount", "numeric(12,2)", "Revenue of the sale line = quantity * unit_price (generated column)", { synonyms: ["store revenue", "in-store revenue", "sale amount"], core: true }),
    ],
  },
  {
    name: "reviews",
    domain: "sales",
    description: "Customer product reviews with a 1-5 star rating.",
    synonyms: ["review", "rating", "ratings", "feedback", "stars", "satisfaction", "opinion", "reviewed"],
    primaryKey: ["review_id"],
    columns: [
      pk("review_id", "Unique identifier of the review"),
      fk("product_id", "products", "product_id", "Product being reviewed"),
      fk("customer_id", "customers", "customer_id", "Customer who wrote the review"),
      col("rating", "integer", "Star rating from 1 (worst) to 5 (best)", { sampleValues: ["1", "2", "3", "4", "5"], synonyms: ["stars", "score"], core: true }),
      col("title", "text", "Review headline"),
      col("body", "text", "Review text (may be NULL)"),
      col("created_at", "timestamptz", "When the review was written", { core: true }),
    ],
  },

  // ───────────── customers ─────────────
  {
    name: "customers",
    domain: "customers",
    description: "Registered customers of the retailer.",
    synonyms: ["customer", "customers", "buyer", "buyers", "client", "clients", "shopper", "user", "users", "people", "signup", "members"],
    primaryKey: ["customer_id"],
    columns: [
      pk("customer_id", "Unique identifier of the customer"),
      col("first_name", "text", "Customer first name", { core: true }),
      col("last_name", "text", "Customer last name", { core: true }),
      col("email", "text", "Customer email address (unique)"),
      col("phone", "text", "Phone number"),
      col("birth_date", "date", "Date of birth", { synonyms: ["age", "birthday"] }),
      col("signup_date", "date", "Date the customer registered", { synonyms: ["registered", "joined", "new customers", "acquired"] }),
      col("segment", "text", "Loyalty tier of the customer", { sampleValues: ["standard", "premium", "vip"], synonyms: ["tier", "loyalty"], core: true }),
      col("acquisition_channel", "text", "Marketing channel through which the customer was acquired", {
        sampleValues: ["organic", "paid_search", "social", "email", "referral"],
        synonyms: ["channel", "source", "marketing"],
      }),
      col("is_active", "boolean", "Whether the customer account is active"),
    ],
  },
  {
    name: "customer_addresses",
    domain: "customers",
    description: "Shipping and billing addresses of customers, including city, region and country.",
    businessMeaning: "The source of geography (city, region, country). For order geography join orders.shipping_address_id = customer_addresses.address_id.",
    synonyms: ["address", "addresses", "location", "city", "cities", "country", "region", "state", "geography", "where", "shipping address", "zip", "postal"],
    primaryKey: ["address_id"],
    columns: [
      pk("address_id", "Unique identifier of the address"),
      fk("customer_id", "customers", "customer_id", "Customer the address belongs to"),
      col("address_type", "text", "shipping or billing address", { sampleValues: ["shipping", "billing"] }),
      col("street", "text", "Street address"),
      col("city", "text", "City", { sampleValues: ["New York", "Los Angeles", "Chicago", "Toronto", "London", "Berlin"], synonyms: ["town"], core: true }),
      col("region", "text", "State / province / region", { sampleValues: ["NY", "CA", "ON", "England"], synonyms: ["state", "province"], core: true }),
      col("postal_code", "text", "Postal / ZIP code"),
      col("country", "text", "Country", { sampleValues: ["United States", "Canada", "United Kingdom", "Germany", "France", "Australia"], core: true }),
      col("is_default", "boolean", "Whether this is the customer's default address of its type"),
    ],
  },

  // ───────────── catalogue ─────────────
  {
    name: "products",
    domain: "catalogue",
    description: "Product catalogue: what the retailer sells, its price, cost, category, brand and supplier.",
    synonyms: ["product", "item", "items", "sku", "goods", "merchandise", "article", "catalog", "catalogue"],
    primaryKey: ["product_id"],
    columns: [
      pk("product_id", "Unique identifier of the product"),
      col("sku", "text", "Stock keeping unit code (unique)"),
      col("name", "text", "Product name", { synonyms: ["product name", "title"], core: true }),
      col("description", "text", "Short product description"),
      fk("category_id", "product_categories", "category_id", "Category the product belongs to"),
      fk("brand_id", "product_brands", "brand_id", "Brand of the product"),
      fk("supplier_id", "suppliers", "supplier_id", "Supplier that provides the product"),
      col("unit_price", "numeric(10,2)", "Current list price per unit", { synonyms: ["price", "list price", "cost to customer"], core: true }),
      col("unit_cost", "numeric(10,2)", "Cost of goods per unit (what the retailer pays)", {
        businessMeaning: "Margin per unit = unit_price - unit_cost.",
        synonyms: ["cost", "cogs", "purchase cost"],
      }),
      col("weight_kg", "numeric(6,2)", "Weight in kilograms"),
      col("is_active", "boolean", "Whether the product is currently on sale"),
      col("created_at", "timestamptz", "When the product was added to the catalogue"),
    ],
  },
  {
    name: "product_categories",
    domain: "catalogue",
    description: "Product categories (e.g. Computers, Audio, Furniture).",
    businessMeaning: "Flat list of categories. Every product belongs to exactly one category via products.category_id.",
    synonyms: ["category", "categories", "product type", "department of goods", "product group", "segment of products"],
    primaryKey: ["category_id"],
    columns: [
      pk("category_id", "Unique identifier of the category"),
      col("name", "text", "Category name", {
        sampleValues: ["Computers", "Smartphones", "Audio", "Home Appliances", "Furniture", "Kitchen & Dining", "Clothing", "Footwear", "Sports & Outdoors", "Beauty & Personal Care", "Toys & Games", "Books"],
        synonyms: ["category name", "category"],
        core: true,
      }),
      col("description", "text", "What the category contains"),
    ],
  },
  {
    name: "product_brands",
    domain: "catalogue",
    description: "Brands under which products are sold.",
    synonyms: ["brand", "brands", "manufacturer", "make", "label", "maker"],
    primaryKey: ["brand_id"],
    columns: [
      pk("brand_id", "Unique identifier of the brand"),
      col("name", "text", "Brand name", { sampleValues: ["Nordvik", "Auralux", "Zentro", "Kestrel"], synonyms: ["brand name"], core: true }),
      col("country_of_origin", "text", "Country where the brand originates"),
    ],
  },
  {
    name: "suppliers",
    domain: "catalogue",
    description: "Suppliers/vendors that provide products to the retailer.",
    synonyms: ["supplier", "suppliers", "vendor", "vendors", "provider", "providers", "sourcing", "procurement", "supplies"],
    primaryKey: ["supplier_id"],
    columns: [
      pk("supplier_id", "Unique identifier of the supplier"),
      col("name", "text", "Supplier company name", { synonyms: ["supplier name", "vendor name"], core: true }),
      col("contact_email", "text", "Supplier contact email"),
      col("country", "text", "Country where the supplier is based", { core: true }),
      col("rating", "numeric(2,1)", "Supplier quality rating from 1.0 to 5.0", { synonyms: ["score", "quality"] }),
      col("lead_time_days", "integer", "Typical days from order to delivery from the supplier", { synonyms: ["lead time", "delivery time"] }),
      col("is_active", "boolean", "Whether the supplier is currently active"),
    ],
  },

  // ───────────── inventory ─────────────
  {
    name: "warehouses",
    domain: "inventory",
    description: "Distribution warehouses that hold stock and ship online orders.",
    synonyms: ["warehouse", "warehouses", "distribution center", "dc", "depot", "fulfilment center"],
    primaryKey: ["warehouse_id"],
    columns: [
      pk("warehouse_id", "Unique identifier of the warehouse"),
      col("name", "text", "Warehouse name", { sampleValues: ["Northeast DC", "West Coast DC", "Central DC", "Canada DC", "UK DC"], core: true }),
      col("city", "text", "City where the warehouse is located", { core: true }),
      col("country", "text", "Country of the warehouse"),
      col("capacity_units", "integer", "Maximum number of units the warehouse can hold"),
    ],
  },
  {
    name: "warehouse_inventory",
    domain: "inventory",
    description: "Current stock level of each product in each warehouse, with its reorder level.",
    businessMeaning:
      "A row is low stock when quantity_on_hand <= reorder_level. Total stock of a product = SUM(quantity_on_hand) across warehouses.",
    synonyms: ["inventory", "stock", "stock level", "on hand", "in stock", "out of stock", "low stock", "low inventory", "reorder", "restock", "availability"],
    primaryKey: ["warehouse_id", "product_id"],
    columns: [
      fk("warehouse_id", "warehouses", "warehouse_id", "Warehouse holding the stock", { primaryKey: true }),
      fk("product_id", "products", "product_id", "Product being stocked", { primaryKey: true }),
      col("quantity_on_hand", "integer", "Units currently in stock in this warehouse", { synonyms: ["stock", "units in stock", "inventory level"], core: true }),
      col("reorder_level", "integer", "Threshold at or below which the product should be restocked", { synonyms: ["reorder point", "minimum stock"], core: true }),
      col("last_restocked_at", "timestamptz", "When the product was last restocked here"),
    ],
  },
  {
    name: "inventory_movements",
    domain: "inventory",
    description: "History of stock changes (restocks, sales, returns, adjustments) per product and warehouse.",
    synonyms: ["stock movement", "stock movements", "inventory movement", "inventory history", "restocks", "adjustments", "stock changes"],
    primaryKey: ["movement_id"],
    columns: [
      pk("movement_id", "Unique identifier of the movement"),
      fk("product_id", "products", "product_id", "Product whose stock changed"),
      fk("warehouse_id", "warehouses", "warehouse_id", "Warehouse where the change happened"),
      col("movement_type", "text", "Kind of stock change", { sampleValues: ["restock", "sale", "return", "adjustment"], core: true }),
      col("quantity_change", "integer", "Signed change in units (negative for sales)", { core: true }),
      col("moved_at", "timestamptz", "When the movement happened", { core: true }),
    ],
  },

  // ───────────── organisation ─────────────
  {
    name: "stores",
    domain: "organisation",
    description: "Physical retail stores.",
    synonyms: ["store", "stores", "shop", "shops", "branch", "branches", "outlet", "outlets", "location", "retail store"],
    primaryKey: ["store_id"],
    columns: [
      pk("store_id", "Unique identifier of the store"),
      col("name", "text", "Store name", { synonyms: ["store name"], core: true }),
      col("city", "text", "City where the store is located", { core: true }),
      col("region", "text", "State/province/region of the store"),
      col("country", "text", "Country of the store"),
      col("store_type", "text", "Store format", { sampleValues: ["flagship", "standard", "outlet"], synonyms: ["type", "format"] }),
      col("opened_date", "date", "Date the store opened"),
      col("floor_area_sqm", "integer", "Sales floor area in square metres", { synonyms: ["size", "area"] }),
    ],
  },
  {
    name: "employees",
    domain: "organisation",
    description: "Employees of the company (head office and stores) with their department and store.",
    synonyms: ["employee", "employees", "staff", "worker", "workers", "salesperson", "salespeople", "associate", "manager", "headcount", "team member", "personnel"],
    primaryKey: ["employee_id"],
    columns: [
      pk("employee_id", "Unique identifier of the employee"),
      col("first_name", "text", "Employee first name", { core: true }),
      col("last_name", "text", "Employee last name", { core: true }),
      col("email", "text", "Work email (unique)"),
      col("job_title", "text", "Job title", { sampleValues: ["Sales Associate", "Store Manager", "Sales Specialist"], synonyms: ["role", "position"], core: true }),
      fk("department_id", "departments", "department_id", "Department the employee works in"),
      fk("store_id", "stores", "store_id", "Store the employee works at (NULL for head-office staff)"),
      fk("manager_id", "employees", "employee_id", "The employee's manager (NULL for department heads)"),
      col("hire_date", "date", "Date the employee was hired", { synonyms: ["joined", "start date", "tenure"] }),
      col("salary", "numeric(10,2)", "Annual salary", { synonyms: ["pay", "wage", "compensation"], core: true }),
      col("is_active", "boolean", "Whether the employee is currently employed"),
    ],
  },
  {
    name: "departments",
    domain: "organisation",
    description: "Company departments (Sales, Marketing, Operations, ...).",
    synonyms: ["department", "departments", "team", "teams", "division", "business unit"],
    primaryKey: ["department_id"],
    columns: [
      pk("department_id", "Unique identifier of the department"),
      col("name", "text", "Department name", { sampleValues: ["Sales", "Marketing", "Operations", "Logistics", "Customer Support", "Finance", "IT", "Human Resources"], core: true }),
      col("description", "text", "What the department does"),
    ],
  },
];

export const METRICS: MetricMeta[] = [
  {
    name: "revenue",
    description: "Online merchandise revenue from completed orders.",
    synonyms: ["revenue", "sales amount", "turnover", "income", "earnings", "sales value", "gross revenue", "generated", "top selling", "best selling"],
    definition:
      "revenue = SUM(order_items.line_total) over order_items joined to orders, counting ONLY orders with orders.status IN ('shipped','delivered'). Time is attributed by orders.order_date. Excludes shipping cost and taxes; refunds are not deducted. In-store sales (store_sales) are NOT included unless the question is about stores.",
    tables: ["orders", "order_items"],
    columns: [
      { table: "order_items", column: "line_total" },
      { table: "orders", column: "status" },
      { table: "orders", column: "order_date" },
    ],
  },
  {
    name: "net_revenue",
    description: "Revenue after subtracting refunds.",
    synonyms: ["net revenue", "net sales", "revenue after refunds"],
    definition:
      "net_revenue = revenue - SUM(refunds.refund_amount). Aggregate refunds separately (e.g. in a CTE grouped by order_id or by period) before joining, to avoid multiplying rows across order_items.",
    tables: ["orders", "order_items", "refunds"],
    columns: [
      { table: "order_items", column: "line_total" },
      { table: "refunds", column: "refund_amount" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "order_count",
    description: "Number of completed online orders.",
    synonyms: ["number of orders", "order count", "how many orders", "orders placed", "purchases", "transactions"],
    definition:
      "order_count = COUNT(DISTINCT orders.order_id) with orders.status IN ('shipped','delivered'), unless the question names a different status (e.g. cancelled, pending) or asks for all orders.",
    tables: ["orders"],
    columns: [
      { table: "orders", column: "order_id" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "average_order_value",
    description: "Average value of a completed order (AOV).",
    synonyms: ["average order value", "aov", "average basket", "average order", "mean order value", "avg order", "average order size"],
    definition:
      "average_order_value = AVG(orders.total_amount) over orders with status IN ('shipped','delivered'). Round to 2 decimals.",
    tables: ["orders"],
    columns: [
      { table: "orders", column: "total_amount" },
      { table: "orders", column: "status" },
      { table: "orders", column: "order_date" },
    ],
  },
  {
    name: "units_sold",
    description: "Number of product units sold online.",
    synonyms: ["units sold", "quantity sold", "items sold", "volume", "number of units", "how many sold", "sold"],
    definition: "units_sold = SUM(order_items.quantity) over completed orders (orders.status IN ('shipped','delivered')).",
    tables: ["orders", "order_items"],
    columns: [
      { table: "order_items", column: "quantity" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "gross_profit",
    description: "Revenue minus cost of goods sold.",
    synonyms: ["profit", "gross profit", "margin", "profitability", "gross margin", "profit margin", "markup"],
    definition:
      "gross_profit = SUM(order_items.line_total - order_items.quantity * products.unit_cost) over completed orders. margin % = gross_profit / SUM(order_items.line_total) * 100.",
    tables: ["orders", "order_items", "products"],
    columns: [
      { table: "order_items", column: "line_total" },
      { table: "order_items", column: "quantity" },
      { table: "products", column: "unit_cost" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "store_revenue",
    description: "In-store revenue from physical store sales.",
    synonyms: ["store revenue", "in-store revenue", "store sales", "store performance", "best store", "top store"],
    definition: "store_revenue = SUM(store_sales.total_amount), attributed by store_sales.sale_date. Use only when the question is about stores / in-store sales / store employees.",
    tables: ["store_sales", "stores"],
    columns: [
      { table: "store_sales", column: "total_amount" },
      { table: "store_sales", column: "sale_date" },
    ],
  },
  {
    name: "refund_rate",
    description: "Share of orders that were refunded.",
    synonyms: ["refund rate", "percentage refunded", "percent refunded", "refunded orders", "return rate", "share of refunds"],
    definition:
      "refund_rate (%) = 100.0 * COUNT(DISTINCT refunds.order_id) / COUNT(DISTINCT orders.order_id) over completed orders (status IN ('shipped','delivered')). An order counts as refunded if any refunds row exists for it. Use a LEFT JOIN from orders to refunds.",
    tables: ["orders", "refunds"],
    columns: [
      { table: "refunds", column: "order_id" },
      { table: "orders", column: "order_id" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "low_stock",
    description: "Products whose stock is at or below their reorder level.",
    synonyms: ["low stock", "low inventory", "running low", "need restocking", "reorder", "almost out of stock", "out of stock", "understocked"],
    definition:
      "A product is low on stock in a warehouse when warehouse_inventory.quantity_on_hand <= warehouse_inventory.reorder_level. Join warehouse_inventory to products (and warehouses if the location matters) and order by quantity_on_hand ascending.",
    tables: ["warehouse_inventory", "products"],
    columns: [
      { table: "warehouse_inventory", column: "quantity_on_hand" },
      { table: "warehouse_inventory", column: "reorder_level" },
    ],
  },
  {
    name: "growth",
    description: "Period-over-period change in a measure.",
    synonyms: ["growth", "growing", "declining", "decline", "decrease", "increase", "trend", "change", "grew", "fell", "up", "down", "versus previous", "year over year", "month over month", "compared to"],
    definition:
      "growth % = (current_period - previous_period) / NULLIF(previous_period, 0) * 100. Compute both periods per group with conditional aggregation, e.g. SUM(x) FILTER (WHERE order_date >= ... AND order_date < ...). Define the periods explicitly (default: the last full calendar month vs the month before it).",
    tables: ["orders", "order_items"],
    columns: [
      { table: "orders", column: "order_date" },
      { table: "order_items", column: "line_total" },
    ],
  },
  {
    name: "repeat_customers",
    description: "Customers who purchased multiple times.",
    synonyms: ["repeat customers", "returning customers", "loyal customers", "more than orders", "multiple purchases", "frequent buyers", "made more than"],
    definition:
      "Purchases per customer = COUNT(DISTINCT orders.order_id) grouped by customer_id over completed orders (status IN ('shipped','delivered')); filter with HAVING. 'More than 3 purchases' means > 3.",
    tables: ["customers", "orders"],
    columns: [
      { table: "orders", column: "customer_id" },
      { table: "orders", column: "order_id" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "customer_lifetime_value",
    description: "Total revenue generated by a customer.",
    synonyms: ["lifetime value", "clv", "ltv", "customer value", "top customers", "best customers", "biggest spenders", "spend"],
    definition: "customer lifetime value = SUM(orders.total_amount) per customer over completed orders (status IN ('shipped','delivered')).",
    tables: ["customers", "orders"],
    columns: [
      { table: "orders", column: "total_amount" },
      { table: "orders", column: "customer_id" },
    ],
  },
  {
    name: "average_rating",
    description: "Average product review rating.",
    synonyms: ["average rating", "best rated", "highest rated", "worst rated", "lowest rated", "top rated", "star rating", "customer satisfaction"],
    definition: "average_rating = AVG(reviews.rating) per product (or category). Require a minimum number of reviews (e.g. HAVING COUNT(*) >= 5) when ranking, and show the review count.",
    tables: ["reviews", "products"],
    columns: [
      { table: "reviews", column: "rating" },
      { table: "reviews", column: "product_id" },
    ],
  },
  {
    name: "promotion_revenue",
    description: "Revenue of orders that used a promotion.",
    synonyms: ["promotion revenue", "promotion performance", "best promotion", "top promotion", "campaign revenue", "discount performance", "which promotion"],
    definition:
      "promotion revenue = SUM(order_items.line_total) (or SUM(orders.total_amount)) over completed orders with orders.promotion_id IS NOT NULL, grouped by promotions.promotion_id / code / name.",
    tables: ["promotions", "orders", "order_items"],
    columns: [
      { table: "orders", column: "promotion_id" },
      { table: "order_items", column: "line_total" },
      { table: "orders", column: "status" },
    ],
  },
  {
    name: "delivery_time",
    description: "How long shipments take to be delivered.",
    synonyms: ["delivery time", "shipping time", "days to deliver", "transit time", "how long delivery", "fastest carrier", "slowest carrier"],
    definition:
      "delivery time (days) = EXTRACT(EPOCH FROM (shipping.delivered_at - shipping.shipped_at)) / 86400 over shipments with delivered_at IS NOT NULL.",
    tables: ["shipping"],
    columns: [
      { table: "shipping", column: "delivered_at" },
      { table: "shipping", column: "shipped_at" },
    ],
  },
  {
    name: "supplier_product_count",
    description: "How many products each supplier provides.",
    synonyms: ["supplier provides most products", "products per supplier", "supplier product count", "biggest supplier", "top supplier"],
    definition: "products per supplier = COUNT(products.product_id) grouped by suppliers.supplier_id / name (count all products unless the question says active only).",
    tables: ["suppliers", "products"],
    columns: [
      { table: "products", column: "supplier_id" },
      { table: "products", column: "product_id" },
    ],
  },
];

/** Documented defaults applied when a question is under-specified. Shown to the SQL generator and in docs. */
export const DEFAULTS: DefaultRule[] = [
  {
    name: "revenue_scope",
    whenTables: ["order_items"],
    whenMetrics: ["revenue", "net_revenue", "average_order_value", "units_sold", "gross_profit", "promotion_revenue", "customer_lifetime_value", "growth", "order_count", "refund_rate", "repeat_customers"],
    description:
      "'Revenue' and 'sales' mean online revenue: SUM(order_items.line_total) for orders with status IN ('shipped','delivered'). In-store sales (store_sales) are only used when the question mentions stores, in-store or POS.",
  },
  {
    name: "relative_dates",
    always: true,
    description:
      "Relative periods are computed from CURRENT_DATE in UTC. 'Last month' = the previous full calendar month: order_date >= date_trunc('month', CURRENT_DATE) - interval '1 month' AND order_date < date_trunc('month', CURRENT_DATE). 'Last N months' = the N full calendar months before the current month (the current partial month is excluded). 'This year' = from date_trunc('year', CURRENT_DATE). 'Last year' = the previous full calendar year.",
  },
  {
    name: "category",
    whenTables: ["product_categories"],
    description: "'Category' means product_categories.name reached via products.category_id.",
  },
  {
    name: "geography",
    whenTables: ["customer_addresses"],
    description:
      "City / country of online revenue or customers comes from customer_addresses: join orders.shipping_address_id = customer_addresses.address_id (for orders) or customer_addresses.customer_id = customers.customer_id (for customers).",
  },
  {
    name: "ranking",
    always: true,
    description: "'Top' / 'best' rankings without an explicit N return the top 10, ordered descending by the measure.",
  },
  {
    name: "rounding",
    always: true,
    description: "Currency amounts are rounded to 2 decimals with ROUND(x::numeric, 2); percentages to 1 or 2 decimals.",
  },
];
