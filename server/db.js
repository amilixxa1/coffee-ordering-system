const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'coffee.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL CHECK(total >= 0),
    discount_amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Новый',
    payment_status TEXT NOT NULL DEFAULT 'Не оплачен',
    payment_method TEXT NOT NULL DEFAULT '',
    employee_name TEXT NOT NULL DEFAULT '',
    canceled_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0)
  );
  CREATE TABLE IF NOT EXISTS menu_products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL CHECK(price >= 0),
    image TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staff_users (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','staff')),
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    opening_note TEXT NOT NULL DEFAULT '',
    closing_note TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_employee ON shifts(username) WHERE ended_at IS NULL;
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    receipt_number TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    created_at TEXT NOT NULL,
    order_created_at TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    payment_status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_username TEXT NOT NULL DEFAULT '',
    employee_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    section TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    object TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'Успешно',
    details TEXT NOT NULL DEFAULT ''
  );
  CREATE TRIGGER IF NOT EXISTS activity_logs_no_update
  BEFORE UPDATE ON activity_logs BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS activity_logs_no_delete
  BEFORE DELETE ON activity_logs BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
`);

// Safe additive migrations for databases created by earlier app versions.
const orderColumns = new Set(db.pragma('table_info(orders)').map(column => column.name));
const migrations = {
  discount_amount: "INTEGER NOT NULL DEFAULT 0",
  payment_status: "TEXT NOT NULL DEFAULT 'Не оплачен'",
  payment_method: "TEXT NOT NULL DEFAULT ''",
  employee_name: "TEXT NOT NULL DEFAULT ''",
  canceled_reason: "TEXT NOT NULL DEFAULT ''",
  completed_at: 'TEXT'
};
for (const [column, definition] of Object.entries(migrations)) {
  if (!orderColumns.has(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
}
const receiptColumns = new Set(db.pragma('table_info(receipts)').map(column => column.name));
if (!receiptColumns.has('order_created_at')) db.exec('ALTER TABLE receipts ADD COLUMN order_created_at TEXT');

const seedMenu = [
  { id:'espresso', name:'Эспрессо', category:'Кофе', description:'Плотный, с шоколадным послевкусием', price:1800, image:'/Assets/espresso.svg', tag:'Классика' },
  { id:'flat-white', name:'Флэт уайт', category:'Кофе', description:'Двойной эспрессо и бархатное молоко', price:2600, image:'/Assets/flat-white.svg', tag:'Любимый' },
  { id:'lavender-latte', name:'Лавандовый латте', category:'Кофе', description:'Нежная лаванда, эспрессо и молоко', price:3200, image:'/Assets/lavender-latte.svg', tag:'Особенный' },
  { id:'cappuccino', name:'Капучино', category:'Кофе', description:'Воздушная молочная пена и какао', price:2500, image:'/Assets/cappuccino.svg', tag:'' },
  { id:'matcha', name:'Матча латте', category:'Чай', description:'Японская матча и мягкое молоко', price:3400, image:'/Assets/matcha.svg', tag:'Без кофе' },
  { id:'cinnamon-roll', name:'Булочка с корицей', category:'Десерты', description:'Тёплая, мягкая, с кремовой глазурью', price:2200, image:'/Assets/cinnamon-roll.svg', tag:'Свежая выпечка' }
];
const insertProduct = db.prepare(`INSERT OR IGNORE INTO menu_products
  (id,name,category,description,price,image,tag,available,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)`);
const now = new Date().toISOString();
seedMenu.forEach(p => insertProduct.run(p.id,p.name,p.category,p.description,p.price,p.image,p.tag,now,now));

function getMenu({ includeUnavailable = false } = {}) {
  const sql = `SELECT id,name,category,description,price,image,tag,available FROM menu_products ${includeUnavailable ? '' : 'WHERE available=1'} ORDER BY category,name`;
  return db.prepare(sql).all().map(row => ({ ...row, available: Boolean(row.available) }));
}
const getOrderRows = db.prepare(`SELECT o.*, json_group_array(json_object(
  'id', i.product_id, 'name', i.product_name, 'price', i.unit_price, 'quantity', i.quantity
)) AS items_json FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id`);
function shapeOrder(row) {
  if (!row) return null;
  const { items_json, customer_name, ...rest } = row;
  return { ...rest, customer: customer_name, items: JSON.parse(items_json || '[]').filter(item => item.id !== null) };
}
function findOrder(id) { return shapeOrder(getOrderRows.get(id)); }
function listOrders() { return getOrderRows.all().map(shapeOrder).sort((a,b) => b.created_at.localeCompare(a.created_at)); }

const createOrder = db.transaction(({ id, name, phone, comment, items }) => {
  const normalized = items.map(item => {
    const product = db.prepare('SELECT id,name,price FROM menu_products WHERE id=? AND available=1').get(item.id);
    if (!product) throw new Error('UNKNOWN_PRODUCT');
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('INVALID_QUANTITY');
    return { ...product, quantity };
  });
  const total = normalized.reduce((sum,item) => sum + item.price*item.quantity,0);
  db.prepare(`INSERT INTO orders(id,customer_name,phone,comment,total,status,created_at)
    VALUES(?,?,?,?,?,'Новый',?)`).run(id,name,phone,comment,total,new Date().toISOString());
  const insert = db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?)');
  normalized.forEach(item => insert.run(id,item.id,item.name,item.price,item.quantity));
  return total;
});

function listCustomerOrders(name, phone) {
  return getOrderRows.all().filter(row => row.customer_name === name && row.phone === phone).map(shapeOrder).sort((a,b)=>b.created_at.localeCompare(a.created_at));
}
function updateOrder(id, fields) {
  const allowed = ['status','employee_name','payment_status','payment_method','canceled_reason','completed_at'];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return findOrder(id);
  const sql = `UPDATE orders SET ${entries.map(([key])=>`${key}=?`).join(',')} WHERE id=?`;
  const result = db.prepare(sql).run(...entries.map(([,value])=>value),id);
  return result.changes ? findOrder(id) : null;
}
function createReceipt(orderId, employeeName) {
  const existing = db.prepare('SELECT * FROM receipts WHERE order_id=?').get(orderId);
  if (existing) return shapeReceipt(existing);
  const order = findOrder(orderId);
  if (!order || order.status !== 'Завершён' || order.payment_status !== 'Оплачен') return null;
  const createdAt = new Date().toISOString();
  const receiptNumber = `TK-${createdAt.slice(0,10).replaceAll('-','')}-${cryptoRandom(6)}`;
  const items = order.items.map(item => ({ ...item }));
  db.prepare(`INSERT INTO receipts(id,receipt_number,order_id,created_at,order_created_at,customer_name,employee_name,items_json,subtotal,discount_amount,total,payment_method,payment_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(cryptoRandom(32),receiptNumber,order.id,createdAt,order.created_at,order.customer,employeeName||order.employee_name||'',JSON.stringify(items),order.total+order.discount_amount,order.discount_amount,order.total,order.payment_method,order.payment_status);
  return getReceiptByOrder(orderId);
}
function cryptoRandom(length) { return require('node:crypto').randomBytes(length).toString('hex').toUpperCase(); }
function shapeReceipt(row) { return row ? { ...row, items: JSON.parse(row.items_json) } : null; }
function getReceiptByOrder(orderId) { return shapeReceipt(db.prepare('SELECT * FROM receipts WHERE order_id=?').get(orderId)); }
function getReceiptById(id) { return shapeReceipt(db.prepare('SELECT * FROM receipts WHERE id=? OR receipt_number=?').get(id,id)); }

module.exports = { db, seedMenu, getMenu, createOrder, findOrder, listOrders, listCustomerOrders, updateOrder, createReceipt, getReceiptByOrder, getReceiptById };
