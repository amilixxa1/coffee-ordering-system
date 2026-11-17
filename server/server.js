const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { db, getMenu, createOrder, findOrder, listOrders, listCustomerOrders, updateOrder, createReceipt, getReceiptByOrder, getReceiptById } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const statuses = ['Новый', 'Принят', 'Готовится', 'Готов к выдаче', 'Завершён', 'Отменён'];
const sessionSecret = process.env.SESSION_SECRET || 'local-demo-secret-change-before-deploy';
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(session({ secret:sessionSecret, resave:false, saveUninitialized:false, store:new session.MemoryStore(), cookie:{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000} }));

const text = value => typeof value === 'string' ? value.trim() : '';
const isoNow = () => new Date().toISOString();
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64); }
function equalPassword(password, salt, expectedHex) {
  try { const actual=hashPassword(password,salt); const expected=Buffer.from(expectedHex,'hex'); return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected); } catch { return false; }
}
function seedUser(username, displayName, role, password) {
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=hashPassword(password,salt).toString('hex');
  db.prepare(`INSERT OR IGNORE INTO staff_users(username,display_name,role,salt,password_hash,active,created_at)
    VALUES(?,?,?,?,?,1,?)`).run(username,displayName,role,salt,hash,isoNow());
}
seedUser(process.env.ADMIN_USERNAME || 'ay3mx','Администратор','admin',process.env.ADMIN_PASSWORD || 'ay3mx');
seedUser('barista1','Бариста 1','staff','barista1');
seedUser('barista2','Бариста 2','staff','barista2');

function logActivity({username='',name='',role='',action,section,object='',result='Успешно',details=''}={}) {
  db.prepare(`INSERT INTO activity_logs(employee_username,employee_name,role,action,section,occurred_at,object,result,details)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(username,name,role,action,section,isoNow(),String(object||''),result,typeof details==='string'?details:JSON.stringify(details));
}
function actor(req) { return { username:req.session?.username||'', name:req.session?.displayName||'', role:req.session?.role||'' }; }
function requireStaff(req,res,next) {
  const user=req.session?.username&&db.prepare('SELECT username,display_name,role,active FROM staff_users WHERE username=?').get(req.session.username);
  if (!user||!user.active||!['admin','staff'].includes(user.role)) return res.status(401).json({error:'Требуется вход сотрудника.'});
  req.staff=user; return next();
}
function requireAdmin(req,res,next) { if(!req.staff)return requireStaff(req,res,()=>requireAdmin(req,res,next)); if(req.staff.role!=='admin')return res.status(403).json({error:'Раздел доступен только администратору.'}); return next(); }
function validDate(value) { if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false; const d=new Date(`${value}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value; }
function revenueBetween(from,to) { return db.prepare(`SELECT COALESCE(SUM(total),0) AS revenue FROM orders
  WHERE status='Завершён' AND payment_status='Оплачен' AND date(COALESCE(completed_at,created_at)) BETWEEN ? AND ?`).get(from,to).revenue; }
function shiftRevenue(from,to) { return db.prepare(`SELECT COALESCE(SUM(total),0) AS revenue FROM orders
  WHERE status='Завершён' AND payment_status='Оплачен' AND date(completed_at) BETWEEN ? AND ?`).get(from,to).revenue; }
function getAnalytics(from,to,bucket='day') {
  if(!validDate(from)||!validDate(to)||from>to)throw new Error('Укажите корректный период.');
  const metrics=db.prepare(`SELECT COUNT(*) AS orders,
    SUM(CASE WHEN status='Завершён' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='Отменён' THEN 1 ELSE 0 END) AS canceled,
    SUM(CASE WHEN status NOT IN ('Завершён','Отменён') THEN 1 ELSE 0 END) AS processing
    FROM orders WHERE date(created_at) BETWEEN ? AND ?`).get(from,to);
  const paid=db.prepare(`SELECT COALESCE(SUM(total),0) AS revenue,COUNT(*) AS paid_completed FROM orders
    WHERE status='Завершён' AND payment_status='Оплачен' AND date(COALESCE(completed_at,created_at)) BETWEEN ? AND ?`).get(from,to);
  metrics.revenue=paid.revenue;metrics.paid_completed=paid.paid_completed;
  const days=Math.max(1,Math.floor((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000)+1);
  const start=new Date(`${from}T00:00:00Z`);const prevTo=new Date(start.getTime()-86400000);const prevFrom=new Date(prevTo.getTime()-(days-1)*86400000);
  const previousFrom=prevFrom.toISOString().slice(0,10),previousTo=prevTo.toISOString().slice(0,10),previousRevenue=revenueBetween(previousFrom,previousTo);
  const bucketCompletionExpr={day:"date(COALESCE(o.completed_at,o.created_at))",week:"strftime('%Y-W%W',COALESCE(o.completed_at,o.created_at))",month:"strftime('%Y-%m',COALESCE(o.completed_at,o.created_at))"}[bucket]||"date(COALESCE(o.completed_at,o.created_at))";
  const series=db.prepare(`SELECT ${bucketCompletionExpr} AS date,COALESCE(SUM(o.total),0) AS revenue
    FROM orders o WHERE date(COALESCE(o.completed_at,o.created_at)) BETWEEN ? AND ? AND o.status='Завершён' AND o.payment_status='Оплачен' GROUP BY date ORDER BY date`).all(from,to);
  const popular=db.prepare(`SELECT i.product_id AS id,i.product_name AS name,SUM(i.quantity) AS quantity,SUM(i.quantity*i.unit_price) AS revenue
    FROM order_items i JOIN orders o ON o.id=i.order_id WHERE date(COALESCE(o.completed_at,o.created_at)) BETWEEN ? AND ? AND o.status='Завершён' AND o.payment_status='Оплачен'
    GROUP BY i.product_id,i.product_name ORDER BY quantity DESC,revenue DESC`).all(from,to);
  return {from,to,days,metrics:{...metrics,orders:metrics.orders||0,completed:metrics.completed||0,canceled:metrics.canceled||0,processing:metrics.processing||0,paid_completed:metrics.paid_completed||0,average_check:metrics.paid_completed?Math.round(metrics.revenue/metrics.paid_completed):0,average_orders_per_day:Number((metrics.orders/days).toFixed(2))},series,popular,best_by_revenue:popular.slice().sort((a,b)=>b.revenue-a.revenue)[0]||null,previous:{from:previousFrom,to:previousTo,revenue:previousRevenue,change_percent:previousRevenue?Number(((metrics.revenue-previousRevenue)*100/previousRevenue).toFixed(1)):null}};
}
function receiptForCustomer(id,name,phone) {
  const receipt=getReceiptById(id)||getReceiptByOrder(id);if(!receipt)return null;
  const order=findOrder(receipt.order_id);
  if(!order||order.status!=='Завершён'||order.payment_status!=='Оплачен'||receipt.customer_name!==name||order.phone!==phone)return null;
  return receipt;
}
function pdfFont() {
  const candidates=[path.join(process.env.WINDIR||'C:\\Windows','Fonts','arial.ttf'),'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
  return candidates.find(file=>fs.existsSync(file));
}
function sendReceiptPdf(res,receipt) {
  const doc=new PDFDocument({size:[226,Math.max(390,220+receipt.items.length*48)],margin:20});
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${receipt.receipt_number}.pdf"`);doc.pipe(res);
  const font=pdfFont();if(font)doc.font(font);
  doc.fillColor('#654333').fontSize(17).text('тёплый круг',{align:'center'});doc.moveDown(.35);doc.fontSize(9).fillColor('#756960').text('ЭЛЕКТРОННЫЙ ЧЕК',{align:'center'});doc.moveDown();
  doc.fontSize(8).fillColor('#34251f').text(`Чек: ${receipt.receipt_number}`).text(`Заказ: ${receipt.order_id}`).text(`Дата: ${new Date(receipt.order_created_at||receipt.created_at).toLocaleString('ru-RU')}`).text(`Покупатель: ${receipt.customer_name||'—'}`).text(`Сотрудник: ${receipt.employee_name||'—'}`);doc.moveDown(.7).text('--------------------------------',{align:'center'});
  for(const item of receipt.items){doc.fontSize(8).text(`${item.name} × ${item.quantity}`,{continued:true}).text(`${new Intl.NumberFormat('ru-RU').format(item.price*item.quantity)} ₸`,{align:'right'});doc.fontSize(7).fillColor('#82756c').text(`${item.quantity} × ${new Intl.NumberFormat('ru-RU').format(item.price)} ₸`).fillColor('#34251f');doc.moveDown(.4);}
  doc.text('--------------------------------',{align:'center'}).moveDown(.4);doc.fontSize(8).text(`Товары: ${receipt.subtotal} ₸`).text(`Скидка: −${receipt.discount_amount} ₸`).fontSize(11).text(`ИТОГО: ${receipt.total} ₸`).moveDown(.5).fontSize(8).text(`Оплата: ${receipt.payment_method}`).text(`Статус: ${receipt.payment_status}`).moveDown().text('Спасибо, что выбрали нас!',{align:'center'});doc.end();
}

app.get('/api/menu',(_req,res)=>res.json(getMenu()));
app.post('/api/orders',(req,res)=>{
  const name=text(req.body?.name),phone=text(req.body?.phone),comment=text(req.body?.comment).slice(0,500),items=req.body?.items;
  if(name.length<2||name.length>80)return res.status(400).json({error:'Укажите имя от 2 до 80 символов.'});
  if(!/^[+\d()\s-]{7,24}$/.test(phone))return res.status(400).json({error:'Проверьте номер телефона.'});
  if(!Array.isArray(items)||items.length<1||items.length>30)return res.status(400).json({error:'Корзина пуста или содержит слишком много позиций.'});
  try{const id=crypto.randomUUID();createOrder({id,name,phone,comment,items});logActivity({username:'system',name:'Система',role:'system',action:'Получен новый заказ',section:'Заказы',object:id,details:{customer:name}});res.status(201).json(findOrder(id));}
  catch(error){if(['UNKNOWN_PRODUCT','INVALID_QUANTITY'].includes(error.message))return res.status(400).json({error:'Проверьте выбранные товары и количество.'});console.error(error);res.status(500).json({error:'Не удалось сохранить заказ.'});}
});
app.post('/api/customer/orders',(req,res)=>{
  const name=text(req.body?.name),phone=text(req.body?.phone);if(name.length<2||!/^[+\d()\s-]{7,24}$/.test(phone))return res.status(400).json({error:'Укажите имя и телефон, указанные при заказе.'});
  res.json(listCustomerOrders(name,phone));
});
app.get('/api/orders/:id',(req,res)=>{if(!/^[\da-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:'Некорректный номер заказа.'});const order=findOrder(req.params.id);if(!order)return res.status(404).json({error:'Заказ не найден.'});res.json({id:order.id,created_at:order.created_at,status:order.status,items:order.items,total:order.total});});
app.post('/api/customer/receipts/:id',(req,res)=>{const receipt=receiptForCustomer(req.params.id,text(req.body?.name),text(req.body?.phone));if(!receipt)return res.status(404).json({error:'Чек не найден или данные покупателя не совпадают.'});res.json(receipt);});
app.post('/api/customer/receipts/:id/pdf',(req,res)=>{const receipt=receiptForCustomer(req.params.id,text(req.body?.name),text(req.body?.phone));if(!receipt)return res.status(404).json({error:'Чек не найден.'});sendReceiptPdf(res,receipt);});

app.post('/api/staff/login',(req,res,next)=>{
  const username=text(req.body?.username),password=typeof req.body?.password==='string'?req.body.password:'';
  const user=db.prepare('SELECT * FROM staff_users WHERE username=?').get(username);
  if(!user||!user.active||!equalPassword(password,user.salt,user.password_hash)){logActivity({username,name:username,role:'',action:'Неудачная попытка входа',section:'Авторизация',result:'Ошибка'});return res.status(401).json({error:'Неверный логин или пароль.'});}
  req.session.regenerate(error=>{if(error)return next(error);req.session.username=user.username;req.session.displayName=user.display_name;req.session.role=user.role;req.session.save(err=>{if(err)return next(err);logActivity({username:user.username,name:user.display_name,role:user.role,action:'Вход в систему',section:'Авторизация'});res.json({ok:true,username:user.username,displayName:user.display_name,role:user.role});});});
});
app.get('/api/staff/session',requireStaff,(req,res)=>res.json({ok:true,username:req.staff.username,displayName:req.staff.display_name,role:req.staff.role}));
app.post('/api/staff/logout',requireStaff,(req,res)=>{const a=actor(req);logActivity({...a,action:'Выход из системы',section:'Авторизация'});req.session.destroy(()=>res.json({ok:true}));});
app.get('/api/staff/orders',requireStaff,(_req,res)=>res.json(listOrders()));
app.patch('/api/staff/orders/:id/status',requireStaff,(req,res)=>{
  const status=text(req.body?.status),reason=text(req.body?.reason).slice(0,300);if(!statuses.includes(status)){logActivity({...actor(req),action:'Ошибка изменения статуса заказа',section:'Заказы',object:req.params.id,result:'Ошибка',details:'Недопустимый статус'});return res.status(400).json({error:'Недопустимый статус заказа.'});}if(status==='Отменён'&&reason.length<3){logActivity({...actor(req),action:'Ошибка отмены заказа',section:'Заказы',object:req.params.id,result:'Ошибка',details:'Не указана причина'});return res.status(400).json({error:'Укажите причину отмены.'});}
  const prior=findOrder(req.params.id);if(!prior){logActivity({...actor(req),action:'Ошибка изменения статуса заказа',section:'Заказы',object:req.params.id,result:'Ошибка',details:'Заказ не найден'});return res.status(404).json({error:'Заказ не найден.'});}if(prior.status==='Отменён'&&status!=='Отменён')return res.status(409).json({error:'Отменённый заказ нельзя возобновить.'});if(prior.status==='Завершён'&&status!=='Завершён')return res.status(409).json({error:'Завершённый заказ нельзя вернуть в обработку.'});
  const now=isoNow();const updated=updateOrder(req.params.id,{status,employee_name:req.staff.display_name,canceled_reason:status==='Отменён'?reason:'',completed_at:status==='Завершён'?now:null});
  let action=status==='Отменён'?'Отмена заказа':status==='Завершён'?'Завершение заказа':status==='Принят'?'Принятие заказа':'Изменение статуса';logActivity({...actor(req),action,section:'Заказы',object:req.params.id,details:status==='Отменён'?{status,reason}:{from:prior.status,to:status}});
  if(updated.status==='Завершён'&&updated.payment_status==='Оплачен'&&!getReceiptByOrder(updated.id)){createReceipt(updated.id,req.staff.display_name);logActivity({...actor(req),action:'Сформирован электронный чек',section:'Чеки',object:updated.id});}
  res.json(findOrder(req.params.id));
});
app.patch('/api/staff/orders/:id/payment',requireStaff,(req,res)=>{
  const status=text(req.body?.payment_status),method=text(req.body?.payment_method);if(!['Не оплачен','Оплачен'].includes(status)){logActivity({...actor(req),action:'Ошибка изменения оплаты',section:'Заказы',object:req.params.id,result:'Ошибка',details:'Некорректный статус оплаты'});return res.status(400).json({error:'Выберите статус оплаты.'});}if(status==='Оплачен'&&!['Наличные','Карта','Перевод'].includes(method)){logActivity({...actor(req),action:'Ошибка изменения оплаты',section:'Заказы',object:req.params.id,result:'Ошибка',details:'Не выбран способ оплаты'});return res.status(400).json({error:'Выберите способ оплаты.'});}
  const prior=findOrder(req.params.id);if(!prior)return res.status(404).json({error:'Заказ не найден.'});if(prior.status==='Отменён'&&status==='Оплачен')return res.status(409).json({error:'Нельзя отметить оплату отменённого заказа.'});if(getReceiptByOrder(req.params.id)&&status!=='Оплачен')return res.status(409).json({error:'Оплату уже оформленного чека нельзя отменить.'});const updated=updateOrder(req.params.id,{payment_status:status,payment_method:status==='Оплачен'?method:'',employee_name:req.staff.display_name});
  logActivity({...actor(req),action:status==='Оплачен'?'Отмечена оплата':'Изменён статус оплаты',section:'Заказы',object:req.params.id,details:{status,method}});if(updated.status==='Завершён'&&status==='Оплачен'&&!getReceiptByOrder(updated.id)){createReceipt(updated.id,req.staff.display_name);logActivity({...actor(req),action:'Сформирован электронный чек',section:'Чеки',object:updated.id});}res.json(findOrder(req.params.id));
});
app.get('/api/staff/receipts/:id',requireStaff,(req,res)=>{const receipt=getReceiptById(req.params.id)||getReceiptByOrder(req.params.id);if(!receipt)return res.status(404).json({error:'Чек доступен только по оплаченному завершённому заказу.'});const order=findOrder(receipt.order_id);if(!order||order.status!=='Завершён'||order.payment_status!=='Оплачен')return res.status(404).json({error:'Чек недоступен.'});logActivity({...actor(req),action:'Просмотр электронного чека',section:'Чеки',object:receipt.receipt_number});res.json(receipt);});
app.get('/api/staff/receipts/:id/pdf',requireStaff,(req,res)=>{const receipt=getReceiptById(req.params.id)||getReceiptByOrder(req.params.id);if(!receipt)return res.status(404).json({error:'Чек не найден.'});const order=findOrder(receipt.order_id);if(!order||order.status!=='Завершён'||order.payment_status!=='Оплачен')return res.status(404).json({error:'Чек недоступен.'});logActivity({...actor(req),action:'Экспорт чека PDF',section:'Чеки',object:receipt.receipt_number});sendReceiptPdf(res,receipt);});
app.get('/api/staff/shifts/current',requireStaff,(req,res)=>res.json(db.prepare('SELECT * FROM shifts WHERE username=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(req.staff.username)||null));
app.get('/api/staff/shifts',requireStaff,(req,res)=>res.json(db.prepare('SELECT * FROM shifts WHERE username=? ORDER BY started_at DESC LIMIT 50').all(req.staff.username)));
app.post('/api/staff/shifts/start',requireStaff,(req,res)=>{
  if(db.prepare('SELECT 1 FROM shifts WHERE username=? AND ended_at IS NULL').get(req.staff.username))return res.status(409).json({error:'Смена уже начата.'});const id=crypto.randomUUID(),started=isoNow();db.prepare('INSERT INTO shifts(id,username,employee_name,started_at,opening_note) VALUES(?,?,?,?,?)').run(id,req.staff.username,req.staff.display_name,started,text(req.body?.note).slice(0,300));logActivity({...actor(req),action:'Начало рабочей смены',section:'Смена',object:id});res.status(201).json(db.prepare('SELECT * FROM shifts WHERE id=?').get(id));
});
app.post('/api/staff/shifts/end',requireStaff,(req,res)=>{
  const shift=db.prepare('SELECT * FROM shifts WHERE username=? AND ended_at IS NULL').get(req.staff.username);if(!shift)return res.status(409).json({error:'Нет открытой смены.'});db.prepare('UPDATE shifts SET ended_at=?,closing_note=? WHERE id=?').run(isoNow(),text(req.body?.note).slice(0,300),shift.id);logActivity({...actor(req),action:'Завершение рабочей смены',section:'Смена',object:shift.id});res.json(db.prepare('SELECT * FROM shifts WHERE id=?').get(shift.id));
});

app.get('/api/staff/analytics',requireStaff,(req,res)=>{try{res.json(getAnalytics(text(req.query.from),text(req.query.to),text(req.query.bucket)||'day'));}catch(error){res.status(400).json({error:error.message});}});
app.get('/api/staff/analytics.csv',requireStaff,(req,res)=>{try{const data=getAnalytics(text(req.query.from),text(req.query.to),text(req.query.bucket)||'day');const lines=[['Отчёт кофейни',data.from,data.to],['Показатель','Значение'],['Выручка',data.metrics.revenue],['Все заказы',data.metrics.orders],['Средний чек',data.metrics.average_check],['Завершено',data.metrics.completed],['Отменено',data.metrics.canceled],['В обработке',data.metrics.processing],['Среднее заказов в день',data.metrics.average_orders_per_day],[],['Дата','Выручка'],...data.series.map(x=>[x.date,x.revenue]),[],['Товар','Продано порций','Выручка'],...data.popular.map(x=>[x.name,x.quantity,x.revenue])];const csv='\uFEFF'+lines.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(';')).join('\r\n');logActivity({...actor(req),action:'Экспорт аналитики CSV',section:'Аналитика',object:`${data.from} — ${data.to}`});res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="coffee-analytics.csv"');res.send(csv);}catch(error){res.status(400).json({error:error.message});}});
app.get('/api/staff/analytics.pdf',requireStaff,(req,res)=>{try{const data=getAnalytics(text(req.query.from),text(req.query.to),text(req.query.bucket)||'day');logActivity({...actor(req),action:'Экспорт аналитики PDF',section:'Аналитика',object:`${data.from} — ${data.to}`});const doc=new PDFDocument({size:'A4',margin:42});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="coffee-analytics.pdf"');doc.pipe(res);const font=pdfFont();if(font)doc.font(font);doc.fillColor('#654333').fontSize(20).text('Тёплый круг · Аналитика');doc.moveDown(.3).fontSize(10).fillColor('#756960').text(`Период: ${data.from} — ${data.to}`);doc.moveDown().fillColor('#34251f').fontSize(11).text(`Выручка: ${data.metrics.revenue} ₸`).text(`Заказов: ${data.metrics.orders} · Средний чек: ${data.metrics.average_check} ₸`).text(`Завершено: ${data.metrics.completed} · Отменено: ${data.metrics.canceled} · В работе: ${data.metrics.processing}`).text(`Среднее заказов в день: ${data.metrics.average_orders_per_day}`).text(`Изменение выручки к прошлому периоду: ${data.previous.change_percent}%`);doc.moveDown().fontSize(13).text('Выручка по периодам');data.series.forEach(row=>doc.fontSize(9).text(`${row.date}   ${row.revenue} ₸`));doc.moveDown().fontSize(13).text('Популярность товаров');data.popular.forEach((row,index)=>doc.fontSize(9).text(`${index+1}. ${row.name} — ${row.quantity} шт. · ${row.revenue} ₸`));doc.end();}catch(error){res.status(400).json({error:error.message});}});

app.get('/api/admin/activity',requireStaff,requireAdmin,(req,res)=>{
  const conditions=[],params=[];const employee=text(req.query.employee);if(employee){conditions.push('(employee_username LIKE ? OR employee_name LIKE ?)');params.push(`%${employee}%`,`%${employee}%`);}for(const [key,column] of [['action','action'],['section','section'],['result','result']]){const value=text(req.query[key]);if(value){conditions.push(`${column} LIKE ?`);params.push(`%${value}%`);}}
  const from=text(req.query.from),to=text(req.query.to),search=text(req.query.search);if(from&&validDate(from)){conditions.push('date(occurred_at)>=?');params.push(from);}if(to&&validDate(to)){conditions.push('date(occurred_at)<=?');params.push(to);}if(search){conditions.push('(employee_username LIKE ? OR employee_name LIKE ? OR action LIKE ? OR section LIKE ? OR object LIKE ? OR details LIKE ?)');params.push(...Array(6).fill(`%${search}%`));}
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';const requested=Number(req.query.limit),limit=Number.isInteger(requested)&&requested>0?Math.min(requested,10000):null;const sql=`SELECT * FROM activity_logs ${where} ORDER BY occurred_at DESC,id DESC${limit?' LIMIT ?':''}`;res.json(db.prepare(sql).all(...params,...(limit?[limit]:[])));
});

// Menu changes are administrator-only and always leave an append-only audit entry.
app.get('/api/admin/menu',requireStaff,requireAdmin,(_req,res)=>res.json(getMenu({includeUnavailable:true})));
app.post('/api/admin/menu',requireStaff,requireAdmin,(req,res)=>{const id=text(req.body?.id)||crypto.randomUUID();const name=text(req.body?.name),category=text(req.body?.category),price=Number(req.body?.price);if(name.length<2||name.length>100||!category||!Number.isInteger(price)||price<0)return res.status(400).json({error:'Проверьте название, категорию и цену.'});const now=isoNow();try{db.prepare('INSERT INTO menu_products(id,name,category,description,price,image,tag,available,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,category,text(req.body?.description),price,text(req.body?.image)||'/Assets/espresso.svg',text(req.body?.tag),req.body?.available===false?0:1,now,now);logActivity({...actor(req),action:'Добавление товара меню',section:'Меню',object:name});res.status(201).json(getMenu({includeUnavailable:true}).find(p=>p.id===id));}catch{res.status(409).json({error:'Такой идентификатор товара уже существует.'});}});
app.patch('/api/admin/menu/:id',requireStaff,requireAdmin,(req,res)=>{const current=db.prepare('SELECT * FROM menu_products WHERE id=?').get(req.params.id);if(!current)return res.status(404).json({error:'Товар не найден.'});const fields=['name','category','description','price','image','tag','available'];const updates=[];const values=[];for(const key of fields)if(Object.hasOwn(req.body||{},key)){const val=key==='available'?(req.body[key]?1:0):key==='price'?Number(req.body[key]):text(req.body[key]);if(key==='price'&&(!Number.isInteger(val)||val<0))return res.status(400).json({error:'Цена должна быть целым числом не меньше нуля.'});updates.push(`${key}=?`);values.push(val);}if(!updates.length)return res.json(current);updates.push('updated_at=?');values.push(isoNow(),req.params.id);db.prepare(`UPDATE menu_products SET ${updates.join(',')} WHERE id=?`).run(...values);const changed=db.prepare('SELECT * FROM menu_products WHERE id=?').get(req.params.id);const action=Object.hasOwn(req.body||{},'price')?'Изменение стоимости':Object.hasOwn(req.body||{},'description')?'Редактирование описания':Object.hasOwn(req.body||{},'available')?'Изменение доступности товара':'Редактирование товара меню';logActivity({...actor(req),action,section:'Меню',object:changed.name,details:{fields:Object.keys(req.body||{})}});res.json({...changed,available:Boolean(changed.available)});});
app.delete('/api/admin/menu/:id',requireStaff,requireAdmin,(req,res)=>{const p=db.prepare('SELECT name FROM menu_products WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'Товар не найден.'});db.prepare('UPDATE menu_products SET available=0,updated_at=? WHERE id=?').run(isoNow(),req.params.id);logActivity({...actor(req),action:'Удаление товара меню',section:'Меню',object:p.name});res.json({ok:true});});

app.get('/api/admin/users',requireStaff,requireAdmin,(_req,res)=>res.json(db.prepare('SELECT username,display_name,role,active,created_at FROM staff_users ORDER BY role,display_name').all().map(u=>({...u,active:Boolean(u.active)}))));
app.post('/api/admin/users',requireStaff,requireAdmin,(req,res)=>{const username=text(req.body?.username),displayName=text(req.body?.display_name),password=typeof req.body?.password==='string'?req.body.password:'',role=text(req.body?.role);if(!/^[A-Za-z0-9_-]{3,32}$/.test(username)||displayName.length<2||displayName.length>80||password.length<4||password.length>128||!['admin','staff'].includes(role))return res.status(400).json({error:'Проверьте логин, имя, пароль и роль.'});const salt=crypto.randomBytes(16).toString('hex'),hash=hashPassword(password,salt).toString('hex');try{db.prepare('INSERT INTO staff_users(username,display_name,role,salt,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)').run(username,displayName,role,salt,hash,isoNow());logActivity({...actor(req),action:'Добавление нового сотрудника',section:'Сотрудники',object:username,details:{role}});res.status(201).json({username,display_name:displayName,role,active:true});}catch{res.status(409).json({error:'Такой логин уже существует.'});}});
app.patch('/api/admin/users/:username',requireStaff,requireAdmin,(req,res)=>{const username=req.params.username,current=db.prepare('SELECT * FROM staff_users WHERE username=?').get(username);if(!current)return res.status(404).json({error:'Учётная запись не найдена.'});const nextRole=Object.hasOwn(req.body||{},'role')?text(req.body.role):current.role,nextActive=Object.hasOwn(req.body||{},'active')?(req.body.active?1:0):current.active,displayName=Object.hasOwn(req.body||{},'display_name')?text(req.body.display_name):current.display_name;if(!['admin','staff'].includes(nextRole)||displayName.length<2||displayName.length>80)return res.status(400).json({error:'Проверьте роль и имя.'});if(username===req.staff.username&&(nextRole!=='admin'||!nextActive))return res.status(400).json({error:'Нельзя отключить или понизить собственную учётную запись администратора.'});let sql='UPDATE staff_users SET display_name=?,role=?,active=?',values=[displayName,nextRole,nextActive];if(typeof req.body?.password==='string'&&req.body.password.length){if(req.body.password.length<4||req.body.password.length>128)return res.status(400).json({error:'Пароль должен содержать от 4 до 128 символов.'});const salt=crypto.randomBytes(16).toString('hex');sql+=',salt=?,password_hash=?';values.push(salt,hashPassword(req.body.password,salt).toString('hex'));}values.push(username);db.prepare(`${sql} WHERE username=?`).run(...values);const action=current.role!==nextRole?'Изменение роли пользователя':current.active!==nextActive?'Изменение доступа пользователя':'Изменение учётной записи';logActivity({...actor(req),action,section:'Сотрудники',object:username,details:{from:current.role,to:nextRole,active:Boolean(nextActive)}});res.json(db.prepare('SELECT username,display_name,role,active,created_at FROM staff_users WHERE username=?').get(username));});

const projectRoot=path.join(__dirname,'..');
app.get('/',(_req,res)=>res.sendFile(path.join(projectRoot,'HTML','index.html')));
app.get('/staff.html',(_req,res)=>res.sendFile(path.join(projectRoot,'HTML','staff.html')));
app.use('/HTML',express.static(path.join(projectRoot,'HTML')));app.use('/CSS',express.static(path.join(projectRoot,'CSS')));app.use('/JS',express.static(path.join(projectRoot,'JS')));app.use('/Assets',express.static(path.join(projectRoot,'Assets')));
app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:'Внутренняя ошибка сервера.'});});
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => console.log(`Тёплый круг открыт: http://localhost:${port}`));
}
module.exports = app;