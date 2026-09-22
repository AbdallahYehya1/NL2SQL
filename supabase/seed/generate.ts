/**
 * Deterministic seed-data generator for the `shop` demo schema.
 *
 * Pure function: same (anchorDate, seed) → identical data. No database access here; scripts/db.ts loads it.
 * Data spans 24 months ending at `anchorDate` (default: today, UTC) so "last month" questions always have data.
 */

export type Row = Record<string, string | number | boolean | null>;
export type Dataset = Record<string, Row[]>;

// ───────────────────────── deterministic PRNG helpers ─────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float() {
    return this.next();
  }
  int(min: number, max: number) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  normal(mean = 0, sd = 1) {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const isoTs = (d: Date) => d.toISOString();
const addMonths = (d: Date, m: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1));

/** Binary search over a cumulative-weight array. */
function sampleCum(cum: number[], r: number, lo = 0, hi = cum.length - 1) {
  const target = r * cum[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ───────────────────────── reference data ─────────────────────────
interface City {
  city: string;
  region: string;
  country: string;
  weight: number;
}
const CITIES: City[] = [
  { city: "New York", region: "NY", country: "United States", weight: 14 },
  { city: "Los Angeles", region: "CA", country: "United States", weight: 11 },
  { city: "Chicago", region: "IL", country: "United States", weight: 8 },
  { city: "Houston", region: "TX", country: "United States", weight: 6 },
  { city: "Seattle", region: "WA", country: "United States", weight: 5 },
  { city: "Boston", region: "MA", country: "United States", weight: 5 },
  { city: "Miami", region: "FL", country: "United States", weight: 4 },
  { city: "Denver", region: "CO", country: "United States", weight: 4 },
  { city: "Atlanta", region: "GA", country: "United States", weight: 4 },
  { city: "Toronto", region: "ON", country: "Canada", weight: 6 },
  { city: "Vancouver", region: "BC", country: "Canada", weight: 3 },
  { city: "London", region: "England", country: "United Kingdom", weight: 9 },
  { city: "Manchester", region: "England", country: "United Kingdom", weight: 3 },
  { city: "Berlin", region: "Berlin", country: "Germany", weight: 4 },
  { city: "Paris", region: "Île-de-France", country: "France", weight: 4 },
  { city: "Sydney", region: "NSW", country: "Australia", weight: 3 },
];

const FIRST_NAMES = [
  "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth",
  "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Daniel", "Karen",
  "Matthew", "Nancy", "Anthony", "Lisa", "Mark", "Betty", "Steven", "Sandra", "Andrew", "Ashley",
  "Joshua", "Emily", "Kevin", "Donna", "Brian", "Michelle", "George", "Carol", "Ryan", "Amanda",
  "Omar", "Fatima", "Wei", "Mei", "Raj", "Priya", "Carlos", "Sofia", "Luca", "Chiara",
  "Hans", "Greta", "Yuki", "Haruto", "Amara", "Kwame", "Ivan", "Olga", "Noah", "Zoe",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
  "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
  "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Patel", "Khan", "Chen", "Wang", "Kim", "Singh", "Rossi", "Muller", "Schmidt", "Dubois",
  "Ivanov", "Okafor", "Tanaka", "Silva", "Costa", "Novak", "Kowalski", "Haddad", "Larsen", "Murphy",
];
const STREETS = ["Maple", "Oak", "Cedar", "Pine", "Elm", "Washington", "Lake", "Hill", "Sunset", "Park", "Church", "Willow", "Highland", "River", "Meadow"];
const STREET_TYPES = ["St", "Ave", "Blvd", "Rd", "Ln", "Dr"];

const DEPARTMENTS = [
  ["Sales", "Store and online sales teams"],
  ["Marketing", "Brand, campaigns and promotions"],
  ["Operations", "Store and supply-chain operations"],
  ["Logistics", "Warehousing and shipping"],
  ["Customer Support", "Customer service and returns handling"],
  ["Finance", "Accounting, pricing and reporting"],
  ["IT", "Internal systems and e-commerce platform"],
  ["Human Resources", "Recruiting and people operations"],
] as const;

const CATEGORIES: {
  name: string;
  description: string;
  /** base popularity multiplier, annual growth rate (log), price range, product nouns */
  pop: number;
  growth: number;
  price: [number, number];
  nouns: string[];
}[] = [
  { name: "Computers", description: "Laptops, desktops and computer accessories", pop: 1.0, growth: 0.15, price: [349, 2199], nouns: ["Laptop", "Ultrabook", "Desktop PC", "Monitor", "Keyboard", "Mouse", "Docking Station", "Webcam", "External SSD", "Tablet PC"] },
  { name: "Smartphones", description: "Smartphones, cases and mobile accessories", pop: 1.5, growth: 0.3, price: [199, 1299], nouns: ["Smartphone", "Phone Case", "Fast Charger", "Power Bank", "Screen Protector", "Wireless Charger", "Smartwatch", "Phone Stand"] },
  { name: "Audio", description: "Headphones, speakers and audio equipment", pop: 1.4, growth: 0.1, price: [29, 449], nouns: ["Wireless Headphones", "Earbuds", "Bluetooth Speaker", "Soundbar", "Studio Microphone", "Turntable", "Noise-Cancelling Headset"] },
  { name: "Home Appliances", description: "Small and large household appliances", pop: 1.1, growth: 0.02, price: [39, 899], nouns: ["Air Fryer", "Vacuum Cleaner", "Espresso Machine", "Blender", "Robot Vacuum", "Air Purifier", "Electric Kettle", "Toaster Oven"] },
  { name: "Furniture", description: "Home and office furniture", pop: 0.7, growth: -0.12, price: [79, 1499], nouns: ["Office Chair", "Standing Desk", "Bookshelf", "Sofa", "Coffee Table", "Bed Frame", "Dining Chair", "TV Stand"] },
  { name: "Kitchen & Dining", description: "Cookware, tableware and kitchen tools", pop: 0.9, growth: 0.05, price: [12, 249], nouns: ["Cookware Set", "Chef Knife", "Cutting Board", "Dinner Set", "Coffee Grinder", "Food Storage Set", "Cast Iron Skillet"] },
  { name: "Clothing", description: "Men's, women's and unisex apparel", pop: 1.6, growth: -0.05, price: [15, 199], nouns: ["Jacket", "Hoodie", "Jeans", "T-Shirt", "Running Shorts", "Winter Coat", "Sweater", "Dress"] },
  { name: "Footwear", description: "Casual, athletic and formal shoes", pop: 1.2, growth: 0.08, price: [35, 219], nouns: ["Running Shoes", "Sneakers", "Leather Boots", "Sandals", "Trail Shoes", "Loafers"] },
  { name: "Sports & Outdoors", description: "Fitness equipment and outdoor gear", pop: 0.9, growth: 0.18, price: [19, 599], nouns: ["Yoga Mat", "Dumbbell Set", "Camping Tent", "Hiking Backpack", "Bicycle Helmet", "Resistance Bands", "Treadmill", "Sleeping Bag"] },
  { name: "Beauty & Personal Care", description: "Skincare, haircare and grooming", pop: 1.0, growth: 0.22, price: [8, 149], nouns: ["Face Serum", "Moisturizer", "Hair Dryer", "Electric Shaver", "Perfume", "Sunscreen", "Beard Trimmer"] },
  { name: "Toys & Games", description: "Toys, board games and video games", pop: 0.8, growth: -0.2, price: [9, 189], nouns: ["Building Blocks", "Board Game", "Puzzle 1000pc", "RC Car", "Plush Toy", "Game Console Controller", "Art Set"] },
  { name: "Books", description: "Print books and stationery", pop: 0.6, growth: -0.28, price: [6, 59], nouns: ["Hardcover Novel", "Cookbook", "Business Book", "Kids Picture Book", "Notebook Set", "Planner"] },
];

const BRANDS: [string, string][] = [
  ["Nordvik", "Sweden"], ["Auralux", "Germany"], ["Zentro", "Japan"], ["Kestrel", "United States"],
  ["Lumina", "United States"], ["Oakridge", "United Kingdom"], ["Pixelforge", "South Korea"], ["Verdant", "Canada"],
  ["Halcyon", "France"], ["Brightwave", "United States"], ["Tundra", "Norway"], ["Solstice", "Italy"],
  ["Ironpeak", "United States"], ["Mirai", "Japan"], ["Casa Nova", "Spain"], ["Stratus", "United States"],
  ["Ember & Oak", "United Kingdom"], ["Helix", "Taiwan"], ["Northstar", "Canada"], ["Vela", "Italy"],
  ["Copperleaf", "United States"], ["Quanta", "China"], ["Aster", "Denmark"], ["Bolt Athletics", "United States"],
];

const SUPPLIERS: [string, string][] = [
  ["Pacific Rim Trading", "China"], ["Atlas Wholesale Group", "United States"], ["EuroSource GmbH", "Germany"],
  ["Nippon Components Co.", "Japan"], ["Maple Leaf Distribution", "Canada"], ["Bosphorus Imports", "Turkey"],
  ["Lone Star Supply", "United States"], ["Nordic Logistics AB", "Sweden"], ["Seoul Tech Partners", "South Korea"],
  ["Milano Design Supply", "Italy"], ["Great Lakes Goods", "United States"], ["Shenzhen Direct Ltd", "China"],
  ["Iberia Trade S.L.", "Spain"], ["Thames Wholesale", "United Kingdom"], ["Outback Sourcing", "Australia"],
];

const STORE_DEFS: { city: string; type: "flagship" | "standard" | "outlet"; weight: number }[] = [
  { city: "New York", type: "flagship", weight: 2.6 },
  { city: "Los Angeles", type: "flagship", weight: 2.3 },
  { city: "Chicago", type: "standard", weight: 1.5 },
  { city: "Houston", type: "standard", weight: 1.2 },
  { city: "Seattle", type: "standard", weight: 1.3 },
  { city: "Boston", type: "standard", weight: 1.1 },
  { city: "Toronto", type: "standard", weight: 1.4 },
  { city: "London", type: "flagship", weight: 2.0 },
  { city: "Miami", type: "outlet", weight: 0.9 },
  { city: "Denver", type: "outlet", weight: 0.8 },
];

const WAREHOUSES: [string, string, string, number][] = [
  ["Northeast DC", "Newark", "United States", 60000],
  ["West Coast DC", "Ontario", "United States", 75000],
  ["Central DC", "Dallas", "United States", 55000],
  ["Canada DC", "Mississauga", "Canada", 30000],
  ["UK DC", "Coventry", "United Kingdom", 35000],
];

const CARRIERS = ["FedEx", "UPS", "DHL", "USPS", "Royal Mail", "Canada Post"];
const PAYMENT_METHODS = ["credit_card", "debit_card", "paypal", "bank_transfer", "gift_card"] as const;
const PAYMENT_WEIGHTS = [52, 18, 20, 6, 4];

interface PromoDef {
  code: string;
  name: string;
  description: string;
  type: "percentage" | "fixed";
  value: number;
  min: number;
  /** Recurring yearly campaigns as [month 1-12, day, length in days]. Each occurrence becomes its own promotion row. */
  windows?: [number, number, number][];
  /** Always-on promotion (single row spanning the whole data window). */
  always?: boolean;
  /** Probability that an eligible order placed in the window uses the promotion. */
  takeRate: number;
}
const PROMO_DEFS: PromoDef[] = [
  { code: "WELCOME10", name: "Welcome 10% Off", description: "10% off for new customers", type: "percentage", value: 10, min: 0, always: true, takeRate: 0.07 },
  { code: "LOYALTY15", name: "Loyalty Reward $15", description: "$15 off for loyalty members on orders over $60", type: "fixed", value: 15, min: 60, always: true, takeRate: 0.05 },
  { code: "SPRING15", name: "Spring Sale", description: "15% off spring collection", type: "percentage", value: 15, min: 50, windows: [[3, 10, 21]], takeRate: 0.4 },
  { code: "SUMMER20", name: "Summer Splash", description: "20% off summer essentials", type: "percentage", value: 20, min: 75, windows: [[6, 15, 28]], takeRate: 0.4 },
  { code: "BACK2SCHOOL", name: "Back to School", description: "$25 off orders over $200", type: "fixed", value: 25, min: 200, windows: [[8, 10, 24]], takeRate: 0.4 },
  { code: "BLACKFRIDAY30", name: "Black Friday 30", description: "30% off sitewide", type: "percentage", value: 30, min: 100, windows: [[11, 24, 4]], takeRate: 0.75 },
  { code: "CYBERWEEK", name: "Cyber Week", description: "$40 off orders over $300", type: "fixed", value: 40, min: 300, windows: [[11, 28, 8]], takeRate: 0.5 },
  { code: "HOLIDAY25", name: "Holiday Gifting", description: "25% off gifts", type: "percentage", value: 25, min: 80, windows: [[12, 8, 16]], takeRate: 0.45 },
  { code: "FLASH50", name: "Flash Sale 50", description: "Limited flash sale, 50% off selected items", type: "percentage", value: 50, min: 40, windows: [[5, 5, 2], [9, 20, 2]], takeRate: 0.8 },
  { code: "NEWYEAR12", name: "New Year Reset", description: "12% off to start the year", type: "percentage", value: 12, min: 0, windows: [[1, 1, 14]], takeRate: 0.35 },
];

const REVIEW_TITLES: Record<number, string[]> = {
  5: ["Absolutely love it", "Exceeded expectations", "Best purchase this year", "Five stars, no notes"],
  4: ["Very good overall", "Solid quality", "Happy with it", "Great value"],
  3: ["It's okay", "Average", "Decent but not amazing", "Does the job"],
  2: ["Disappointed", "Not what I expected", "Below average quality"],
  1: ["Terrible", "Do not recommend", "Broke quickly"],
};
const REVIEW_BODIES: Record<number, string[]> = {
  5: ["Works perfectly and arrived quickly.", "Great build quality and excellent value for money.", "Would buy again without hesitation."],
  4: ["Good product, minor issues with packaging.", "Does what it promises, would recommend.", "Very satisfied, slightly pricey."],
  3: ["Fine for the price, nothing special.", "Some features are great, others lacking.", "Average quality, delivery was slow."],
  2: ["Quality is lower than the photos suggest.", "Stopped working correctly after a few weeks.", "Customer support was slow to respond."],
  1: ["Arrived damaged and did not work.", "Complete waste of money.", "Nothing like the description."],
};

// ───────────────────────── generator ─────────────────────────
export interface GenerateOptions {
  /** Last day of data (UTC). Defaults to today. */
  anchorDate?: Date;
  seed?: number;
  /** Multiplier for row volumes; 1 = default (~11k orders). Tests may use a smaller value. */
  scale?: number;
}

export function generateDataset(options: GenerateOptions = {}): Dataset {
  const seed = options.seed ?? 20260101;
  const scale = options.scale ?? 1;
  const now = options.anchorDate ?? new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const windowStart = addMonths(anchor, -24); // first day of the month 24 months before the anchor month
  const rng = new Rng(seed);

  const ds: Dataset = {};

  // ── departments / stores / warehouses ──
  ds.departments = DEPARTMENTS.map(([name, description], i) => ({ department_id: i + 1, name, description }));
  const deptId = (name: string) => DEPARTMENTS.findIndex((d) => d[0] === name) + 1;

  ds.stores = STORE_DEFS.map((s, i) => {
    const c = CITIES.find((x) => x.city === s.city)!;
    return {
      store_id: i + 1,
      name: `${s.city} ${s.type === "flagship" ? "Flagship" : s.type === "outlet" ? "Outlet" : "Central"}`,
      city: c.city,
      region: c.region,
      country: c.country,
      store_type: s.type,
      opened_date: isoDate(new Date(Date.UTC(2014 + (i % 8), (i * 3) % 12, 1 + i))),
      floor_area_sqm: s.type === "flagship" ? rng.int(1800, 3000) : s.type === "outlet" ? rng.int(600, 1000) : rng.int(900, 1600),
    };
  });

  ds.warehouses = WAREHOUSES.map(([name, city, country, cap], i) => ({ warehouse_id: i + 1, name, city, country, capacity_units: cap }));

  // ── employees ──
  const employees: Row[] = [];
  const usedEmails = new Set<string>();
  const newEmployee = (job: string, dept: number, storeId: number | null, managerId: number | null, salaryRange: [number, number]) => {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let email = `${first}.${last}@retailco.example`.toLowerCase();
    let n = 1;
    while (usedEmails.has(email)) email = `${first}.${last}${++n}@retailco.example`.toLowerCase();
    usedEmails.add(email);
    const id = employees.length + 1;
    employees.push({
      employee_id: id,
      first_name: first,
      last_name: last,
      email,
      job_title: job,
      department_id: dept,
      store_id: storeId,
      manager_id: managerId,
      hire_date: isoDate(new Date(anchor.getTime() - rng.int(60, 3300) * DAY)),
      salary: round2(rng.int(salaryRange[0], salaryRange[1])),
      is_active: rng.chance(0.93),
    });
    return id;
  };
  const hqHeads = new Map<number, number>();
  for (const [name] of DEPARTMENTS) {
    const d = deptId(name);
    const head = newEmployee(`Head of ${name}`, d, null, null, [95000, 150000]);
    hqHeads.set(d, head);
    const staff = name === "Sales" ? 4 : rng.int(4, 9);
    for (let k = 0; k < staff; k++) newEmployee(`${name} Specialist`, d, null, head, [48000, 88000]);
  }
  const storeStaff = new Map<number, number[]>();
  for (const s of ds.stores) {
    const storeId = s.store_id as number;
    const mgr = newEmployee("Store Manager", deptId("Operations"), storeId, hqHeads.get(deptId("Operations"))!, [62000, 90000]);
    const staff: number[] = [mgr];
    const count = s.store_type === "flagship" ? 9 : s.store_type === "standard" ? 6 : 4;
    for (let k = 0; k < count; k++) staff.push(newEmployee("Sales Associate", deptId("Sales"), storeId, mgr, [31000, 46000]));
    storeStaff.set(storeId, staff);
  }
  ds.employees = employees;

  // ── catalogue ──
  ds.product_categories = CATEGORIES.map((c, i) => ({ category_id: i + 1, name: c.name, description: c.description }));
  ds.product_brands = BRANDS.map(([name, country], i) => ({ brand_id: i + 1, name, country_of_origin: country }));
  ds.suppliers = SUPPLIERS.map(([name, country], i) => ({
    supplier_id: i + 1,
    name,
    contact_email: `sales@${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
    country,
    rating: Math.min(5, Math.max(2.5, rng.normal(4.0, 0.6))).toFixed(1),
    lead_time_days: rng.int(4, 45),
    is_active: rng.chance(0.93),
  }));

  const products: Row[] = [];
  const productMeta: { category: number; price: number; quality: number; pop: number; createdAt: number }[] = [];
  const perCategory = Math.max(6, Math.round(20 * Math.min(1, scale + 0.3)));
  const supplierWeights = SUPPLIERS.map((_, i) => 1 + ((i * 7) % 5)); // uneven supplier product counts
  CATEGORIES.forEach((cat, ci) => {
    const catBrands = [rng.int(1, BRANDS.length), rng.int(1, BRANDS.length), rng.int(1, BRANDS.length), rng.int(1, BRANDS.length), rng.int(1, BRANDS.length)];
    for (let k = 0; k < perCategory; k++) {
      const noun = cat.nouns[k % cat.nouns.length];
      const brandId = rng.pick(catBrands);
      const brandName = BRANDS[brandId - 1][0];
      const tier = rng.pick(["Lite", "Pro", "Plus", "Max", "Essential", "Classic", "Elite", "X"]);
      const model = 100 + rng.int(0, 899);
      const lo = cat.price[0];
      const hi = cat.price[1];
      // log-uniform price so cheap items are more common
      const price = round2(Math.exp(Math.log(lo) + rng.float() * (Math.log(hi) - Math.log(lo))));
      const id = products.length + 1;
      const createdAt = new Date(anchor.getTime() - rng.int(30, 1400) * DAY);
      products.push({
        product_id: id,
        sku: `SKU-${String(ci + 1).padStart(2, "0")}-${String(id).padStart(4, "0")}`,
        name: `${brandName} ${tier} ${noun} ${model}`,
        description: `${noun} from ${brandName} in the ${cat.name} range.`,
        category_id: ci + 1,
        brand_id: brandId,
        supplier_id: rng.weighted(SUPPLIERS.map((_, i) => i + 1), supplierWeights),
        unit_price: price,
        unit_cost: round2(price * (0.45 + rng.float() * 0.3)),
        weight_kg: round2(0.1 + rng.float() * (cat.name === "Furniture" ? 40 : 4)),
        is_active: rng.chance(0.95),
        created_at: isoTs(createdAt),
      });
      productMeta.push({
        category: ci,
        price,
        quality: Math.min(4.9, Math.max(2.6, rng.normal(3.9, 0.55))),
        pop: Math.pow(rng.float() + 0.05, 1.6) * cat.pop, // heavy tail: a few bestsellers
        createdAt: createdAt.getTime(),
      });
    }
  });
  ds.products = products;

  // ── customers & addresses ──
  const customerCount = Math.round(1800 * scale);
  const customers: Row[] = [];
  const customerMeta: { signup: number; weight: number }[] = [];
  const cityWeights = CITIES.map((c) => c.weight);
  const customerCity: City[] = [];
  const emailSet = new Set<string>();
  const signupStart = addMonths(anchor, -36).getTime();
  for (let i = 0; i < customerCount; i++) {
    // signup dates skew towards recent (growing business)
    const f = Math.pow(rng.float(), 0.7);
    const signup = new Date(signupStart + f * (anchor.getTime() - signupStart - 3 * DAY));
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let email = `${first}.${last}@mail.example`.toLowerCase();
    let n = 1;
    while (emailSet.has(email)) email = `${first}.${last}${++n}@mail.example`.toLowerCase();
    emailSet.add(email);
    const segRoll = rng.float();
    const segment = segRoll < 0.72 ? "standard" : segRoll < 0.93 ? "premium" : "vip";
    customers.push({
      customer_id: i + 1,
      first_name: first,
      last_name: last,
      email,
      phone: `+1-555-${String(rng.int(0, 9999999)).padStart(7, "0")}`,
      birth_date: isoDate(new Date(Date.UTC(rng.int(1950, 2006), rng.int(0, 11), rng.int(1, 28)))),
      signup_date: isoDate(signup),
      segment,
      acquisition_channel: rng.weighted(["organic", "paid_search", "social", "email", "referral"], [34, 26, 18, 12, 10]),
      is_active: rng.chance(0.92),
    });
    // heavy-tailed activity so some customers buy a lot; vips buy more
    const activity = Math.exp(rng.normal(0, 0.9)) * (segment === "vip" ? 3 : segment === "premium" ? 1.6 : 1);
    customerMeta.push({ signup: signup.getTime(), weight: activity });
    customerCity.push(rng.weighted(CITIES, cityWeights));
  }
  // Order customers by signup so we can sample among customers "who already exist" at order time.
  const customerOrder = customers.map((_, i) => i).sort((a, b) => customerMeta[a].signup - customerMeta[b].signup);
  const cumCustomerWeights: number[] = [];
  customerOrder.forEach((ci, idx) => {
    cumCustomerWeights.push((idx ? cumCustomerWeights[idx - 1] : 0) + customerMeta[ci].weight);
  });
  const customerSignupsSorted = customerOrder.map((ci) => customerMeta[ci].signup);
  ds.customers = customers;

  const addresses: Row[] = [];
  const shippingAddressOf = new Map<number, number>();
  customers.forEach((c, i) => {
    const city = customerCity[i];
    const mk = (type: "shipping" | "billing", isDefault: boolean, cityOverride?: City) => {
      const ct = cityOverride ?? city;
      const id = addresses.length + 1;
      addresses.push({
        address_id: id,
        customer_id: c.customer_id as number,
        address_type: type,
        street: `${rng.int(10, 9899)} ${rng.pick(STREETS)} ${rng.pick(STREET_TYPES)}`,
        city: ct.city,
        region: ct.region,
        postal_code: String(rng.int(10000, 99999)),
        country: ct.country,
        is_default: isDefault,
      });
      return id;
    };
    const ship = mk("shipping", true);
    shippingAddressOf.set(c.customer_id as number, ship);
    if (rng.chance(0.6)) mk("billing", true);
    if (rng.chance(0.15)) mk("shipping", false, rng.weighted(CITIES, cityWeights));
  });
  ds.customer_addresses = addresses;

  // ── promotions (one row per campaign occurrence) ──
  const promotions: Row[] = [];
  const promoWindows: { id: number; start: number; end: number; def: PromoDef }[] = [];
  const addPromotion = (def: PromoDef, code: string, start: Date, end: Date) => {
    const id = promotions.length + 1;
    promotions.push({
      promotion_id: id,
      code,
      name: def.name,
      description: def.description,
      discount_type: def.type,
      discount_value: def.value,
      start_date: isoDate(start),
      end_date: isoDate(end),
      min_order_amount: def.min,
    });
    promoWindows.push({ id, start: start.getTime(), end: end.getTime(), def });
  };
  for (const def of PROMO_DEFS) {
    if (def.always) {
      addPromotion(def, def.code, windowStart, new Date(Date.UTC(anchor.getUTCFullYear() + 1, anchor.getUTCMonth(), anchor.getUTCDate())));
      continue;
    }
    for (let year = windowStart.getUTCFullYear(); year <= anchor.getUTCFullYear(); year++) {
      for (const [month, day, len] of def.windows ?? []) {
        const start = new Date(Date.UTC(year, month - 1, day));
        const end = new Date(start.getTime() + (len - 1) * DAY);
        if (end.getTime() < windowStart.getTime() || start.getTime() > anchor.getTime()) continue;
        addPromotion(def, `${def.code}-${year}${(def.windows?.length ?? 0) > 1 ? `-${String(month).padStart(2, "0")}` : ""}`, start, end);
      }
    }
  }
  // Short campaigns are tried first so always-on codes don't crowd them out.
  promoWindows.sort((a, b) => a.end - a.start - (b.end - b.start));
  ds.promotions = promotions;

  // ── product sampling tables (category growth over time) ──
  const monthCount = 25; // 24 full months back + current partial month
  const monthStarts = Array.from({ length: monthCount }, (_, m) => addMonths(windowStart, m));
  const productCum: number[][] = monthStarts.map((ms) => {
    const years = (ms.getTime() - windowStart.getTime()) / (365 * DAY);
    const cum: number[] = [];
    let run = 0;
    productMeta.forEach((p) => {
      const active = p.createdAt <= ms.getTime() + 28 * DAY ? 1 : 0.05;
      run += p.pop * Math.exp(CATEGORIES[p.category].growth * years) * active;
      cum.push(run);
    });
    return cum;
  });
  const monthIndexOf = (t: number) => {
    const d = new Date(t);
    return (d.getUTCFullYear() - windowStart.getUTCFullYear()) * 12 + d.getUTCMonth() - windowStart.getUTCMonth();
  };

  // ── orders, order_items, payments, refunds, shipping ──
  const orders: Row[] = [];
  const orderItems: Row[] = [];
  const payments: Row[] = [];
  const refunds: Row[] = [];
  const shipping: Row[] = [];
  const deliveredItems: { customer: number; product: number; deliveredAt: number }[] = [];

  const BASE_ORDERS_PER_MONTH = 300 * scale;
  const seasonal = [0.85, 0.8, 0.9, 0.95, 1.0, 1.0, 0.95, 1.0, 1.05, 1.1, 1.45, 1.55]; // Jan..Dec
  const anchorDay = anchor.getUTCDate();
  for (let m = 0; m < monthCount; m++) {
    const ms = monthStarts[m];
    const daysInMonth = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0)).getUTCDate();
    const isLast = m === monthCount - 1;
    const activeDays = isLast ? anchorDay : daysInMonth;
    const expected = BASE_ORDERS_PER_MONTH * (1 + 0.035 * m) * seasonal[ms.getUTCMonth()] * (activeDays / daysInMonth);
    const n = Math.round(expected * (0.94 + rng.float() * 0.12));
    for (let k = 0; k < n; k++) {
      const day = rng.int(0, activeDays - 1);
      const hour = Math.min(23, Math.max(0, Math.round(rng.normal(15, 4.5))));
      const t = new Date(ms.getTime() + day * DAY + hour * 3_600_000 + rng.int(0, 59) * 60_000 + rng.int(0, 59) * 1000);
      if (t.getTime() > anchor.getTime()) continue;

      // customer who exists at order time
      const eligible = customerSignupsSorted.findIndex((s) => s > t.getTime());
      const hi = eligible === -1 ? customerOrder.length - 1 : Math.max(0, eligible - 1);
      const custIdx = customerOrder[sampleCum(cumCustomerWeights, rng.float(), 0, hi)];
      const customerId = custIdx + 1;

      // items
      const itemCount = rng.weighted([1, 2, 3, 4, 5], [45, 28, 15, 8, 4]);
      const chosen = new Set<number>();
      const lines: { productIdx: number; qty: number; price: number }[] = [];
      const cum = productCum[Math.min(monthIndexOf(t.getTime()), monthCount - 1)];
      for (let j = 0; j < itemCount * 2 && chosen.size < itemCount; j++) chosen.add(sampleCum(cum, rng.float()));
      for (const pi of chosen) {
        const meta = productMeta[pi];
        const qty = meta.price > 400 ? 1 : rng.weighted([1, 2, 3], [78, 17, 5]);
        lines.push({ productIdx: pi, qty, price: meta.price });
      }
      const gross = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));

      // promotion
      let promo: (typeof promoWindows)[number] | undefined;
      for (const w of promoWindows) {
        if (t.getTime() >= w.start && t.getTime() <= w.end + DAY && gross >= w.def.min && rng.chance(w.def.takeRate)) {
          promo = w;
          break;
        }
      }
      const discounts = lines.map(() => 0);
      if (promo) {
        if (promo.def.type === "percentage") {
          lines.forEach((l, li) => (discounts[li] = round2((l.qty * l.price * promo!.def.value) / 100)));
        } else {
          const fixed = Math.min(promo.def.value, gross * 0.5);
          lines.forEach((l, li) => (discounts[li] = round2((fixed * l.qty * l.price) / gross)));
        }
      }
      const total = round2(lines.reduce((s, l, li) => s + l.qty * l.price - discounts[li], 0));

      // status depends on age
      const ageDays = (anchor.getTime() - t.getTime()) / DAY;
      let status: string;
      if (ageDays > 14) status = rng.chance(0.055) ? "cancelled" : "delivered";
      else if (ageDays > 6) status = rng.weighted(["delivered", "shipped", "cancelled", "processing"], [45, 45, 4, 6]);
      else if (ageDays > 2) status = rng.weighted(["shipped", "processing", "cancelled", "delivered"], [50, 40, 4, 6]);
      else status = rng.weighted(["pending", "processing", "cancelled"], [55, 42, 3]);

      const orderId = orders.length + 1;
      orders.push({
        order_id: orderId,
        customer_id: customerId,
        order_date: isoTs(t),
        status,
        promotion_id: promo ? promo.id : null,
        shipping_address_id: shippingAddressOf.get(customerId) ?? null,
        total_amount: total,
      });
      lines.forEach((l, li) =>
        orderItems.push({
          order_item_id: orderItems.length + 1,
          order_id: orderId,
          product_id: l.productIdx + 1,
          quantity: l.qty,
          unit_price: l.price,
          discount_amount: discounts[li],
        }),
      );

      // payment
      let paymentId: number | null = null;
      if (status === "cancelled") {
        if (rng.chance(0.4)) {
          paymentId = payments.length + 1;
          payments.push({ payment_id: paymentId, order_id: orderId, payment_method: rng.weighted([...PAYMENT_METHODS], PAYMENT_WEIGHTS), amount: total, status: "failed", paid_at: isoTs(new Date(t.getTime() + 60_000)) });
        }
      } else {
        paymentId = payments.length + 1;
        payments.push({ payment_id: paymentId, order_id: orderId, payment_method: rng.weighted([...PAYMENT_METHODS], PAYMENT_WEIGHTS), amount: total, status: "paid", paid_at: isoTs(new Date(t.getTime() + rng.int(1, 30) * 60_000)) });
      }

      // shipping
      let deliveredAt: Date | null = null;
      if (status === "processing" || status === "shipped" || status === "delivered") {
        const shippedAt = status === "processing" ? null : new Date(t.getTime() + rng.int(6, 60) * 3_600_000);
        if (status === "delivered" && shippedAt) deliveredAt = new Date(shippedAt.getTime() + rng.int(2, 8) * DAY + rng.int(0, 20) * 3_600_000);
        const shipStatus = status === "processing" ? "preparing" : status === "shipped" ? "in_transit" : "delivered";
        const country = addresses[(shippingAddressOf.get(customerId) ?? 1) - 1].country;
        const whId = country === "Canada" ? 4 : country === "United Kingdom" || country === "Germany" || country === "France" ? 5 : rng.pick([1, 2, 3]);
        shipping.push({
          shipping_id: shipping.length + 1,
          order_id: orderId,
          warehouse_id: whId,
          carrier: country === "United Kingdom" ? "Royal Mail" : country === "Canada" ? "Canada Post" : rng.pick(CARRIERS.slice(0, 4)),
          tracking_number: `TRK${String(orderId).padStart(8, "0")}${rng.int(100, 999)}`,
          status: shipStatus,
          shipping_cost: round2(3 + rng.float() * 20),
          shipped_at: shippedAt ? isoTs(shippedAt) : null,
          delivered_at: deliveredAt && deliveredAt.getTime() <= anchor.getTime() ? isoTs(deliveredAt) : null,
        });
        if (status === "delivered" && deliveredAt && deliveredAt.getTime() > anchor.getTime()) {
          // delivery falls after the anchor date: keep the order consistent as still in transit
          (orders[orders.length - 1] as Row).status = "shipped";
          (shipping[shipping.length - 1] as Row).status = "in_transit";
          deliveredAt = null;
        }
      }

      // refunds (only for delivered orders)
      if (deliveredAt && paymentId && rng.chance(0.062)) {
        const full = rng.chance(0.4);
        const amount = full ? total : round2(total * (0.2 + rng.float() * 0.6));
        const refundedAt = new Date(deliveredAt.getTime() + rng.int(1, 20) * DAY);
        if (refundedAt.getTime() <= anchor.getTime() && amount > 0) {
          const reason = rng.weighted(["damaged", "wrong_item", "not_as_described", "changed_mind", "late_delivery"], [24, 14, 26, 26, 10]);
          refunds.push({
            refund_id: refunds.length + 1,
            order_id: orderId,
            payment_id: paymentId,
            refund_amount: amount,
            reason,
            refunded_at: isoTs(refundedAt),
          });
          if (full) (payments[paymentId - 1] as Row).status = "refunded";
          // goods sent back for faulty / wrong items
          if (full && (reason === "damaged" || reason === "wrong_item" || reason === "not_as_described") && rng.chance(0.7)) {
            (shipping[shipping.length - 1] as Row).status = "returned";
          }
        }
      }

      if (deliveredAt) for (const l of lines) deliveredItems.push({ customer: customerId, product: l.productIdx + 1, deliveredAt: deliveredAt.getTime() });
    }
  }
  ds.orders = orders;
  ds.order_items = orderItems;
  ds.payments = payments;
  ds.refunds = refunds;
  ds.shipping = shipping;

  // ── store sales (in-store point-of-sale lines) ──
  const storeSales: Row[] = [];
  const storeWeights = STORE_DEFS.map((s) => s.weight);
  const storeSalesPerMonth = 560 * scale;
  for (let m = 0; m < monthCount; m++) {
    const ms = monthStarts[m];
    const daysInMonth = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 0)).getUTCDate();
    const activeDays = m === monthCount - 1 ? anchorDay : daysInMonth;
    const n = Math.round(storeSalesPerMonth * (1 + 0.02 * m) * seasonal[ms.getUTCMonth()] * (activeDays / daysInMonth));
    for (let k = 0; k < n; k++) {
      const storeIdx = STORE_DEFS.indexOf(rng.weighted(STORE_DEFS, storeWeights));
      const storeId = storeIdx + 1;
      const openedAt = new Date(ds.stores[storeIdx].opened_date as string).getTime();
      const saleDate = new Date(ms.getTime() + rng.int(0, activeDays - 1) * DAY);
      if (saleDate.getTime() < openedAt) continue;
      const staff = storeStaff.get(storeId)!;
      const productIdx = sampleCum(productCum[m], rng.float());
      storeSales.push({
        sale_id: storeSales.length + 1,
        store_id: storeId,
        employee_id: rng.pick(staff.slice(1)),
        product_id: productIdx + 1,
        sale_date: isoDate(saleDate),
        quantity: rng.weighted([1, 2, 3], [80, 15, 5]),
        unit_price: productMeta[productIdx].price,
      });
    }
  }
  ds.store_sales = storeSales;

  // ── reviews (only for delivered purchases; one per customer+product) ──
  const reviews: Row[] = [];
  const reviewed = new Set<string>();
  for (const it of deliveredItems) {
    if (!rng.chance(0.2)) continue;
    const key = `${it.customer}:${it.product}`;
    if (reviewed.has(key)) continue;
    reviewed.add(key);
    const q = productMeta[it.product - 1].quality;
    const rating = Math.min(5, Math.max(1, Math.round(rng.normal(q, 0.9))));
    const createdAt = new Date(it.deliveredAt + rng.int(2, 30) * DAY);
    if (createdAt.getTime() > anchor.getTime()) continue;
    reviews.push({
      review_id: reviews.length + 1,
      product_id: it.product,
      customer_id: it.customer,
      rating,
      title: rng.pick(REVIEW_TITLES[rating]),
      body: rng.chance(0.85) ? rng.pick(REVIEW_BODIES[rating]) : null,
      created_at: isoTs(createdAt),
    });
  }
  ds.reviews = reviews;

  // ── warehouse inventory & movements ──
  const inventory: Row[] = [];
  for (let pi = 0; pi < products.length; pi++) {
    const meta = productMeta[pi];
    const whCount = rng.weighted([1, 2, 3], [25, 45, 30]);
    const whs = new Set<number>();
    while (whs.size < whCount) whs.add(rng.int(1, WAREHOUSES.length));
    for (const wh of whs) {
      const reorder = Math.max(5, Math.round(10 + meta.pop * 25 + rng.int(0, 20)));
      const low = rng.chance(0.16);
      const qty = low ? rng.int(0, reorder) : reorder + rng.int(5, 260);
      inventory.push({
        warehouse_id: wh,
        product_id: pi + 1,
        quantity_on_hand: qty,
        reorder_level: reorder,
        last_restocked_at: isoTs(new Date(anchor.getTime() - rng.int(1, 120) * DAY)),
      });
    }
  }
  ds.warehouse_inventory = inventory;

  const movements: Row[] = [];
  const movementCount = Math.round(12000 * scale);
  for (let i = 0; i < movementCount; i++) {
    const inv = inventory[rng.int(0, inventory.length - 1)];
    const type = rng.weighted(["sale", "restock", "return", "adjustment"], [55, 30, 8, 7]);
    const qty = type === "sale" ? -rng.int(1, 4) : type === "restock" ? rng.int(20, 200) : type === "return" ? rng.int(1, 2) : rng.int(-5, 5) || 1;
    movements.push({
      movement_id: i + 1,
      product_id: inv.product_id,
      warehouse_id: inv.warehouse_id,
      movement_type: type,
      quantity_change: qty,
      moved_at: isoTs(new Date(windowStart.getTime() + rng.float() * (anchor.getTime() - windowStart.getTime()))),
    });
  }
  ds.inventory_movements = movements;

  return ds;
}

/** Insert order respects foreign keys. */
export const TABLE_LOAD_ORDER = [
  "departments",
  "stores",
  "employees",
  "product_categories",
  "product_brands",
  "suppliers",
  "products",
  "warehouses",
  "warehouse_inventory",
  "inventory_movements",
  "customers",
  "customer_addresses",
  "promotions",
  "orders",
  "order_items",
  "payments",
  "refunds",
  "shipping",
  "store_sales",
  "reviews",
] as const;
