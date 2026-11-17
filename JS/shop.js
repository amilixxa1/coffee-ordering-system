(() => {
  const money = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₸';
  const $ = selector => document.querySelector(selector);
  let menu = [];
  let activeCategory = 'Все';
  let cart = readCart();
  let pollTimer;
  let historyTimer;
  let toastTimer;
  let customerIdentity = null;
  const categories = ['Все', 'Кофе', 'Чай', 'Десерты'];

  function readCart() {
    try {
      const saved = JSON.parse(localStorage.getItem('warm-circle-cart') || '{}');
      return Object.fromEntries(Object.entries(saved).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity <= 20));
    } catch { return {}; }
  }
  function saveCart() { localStorage.setItem('warm-circle-cart', JSON.stringify(cart)); }
  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
  }
  function esc(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
    return data;
  }
  function renderCategories() {
    $('#categories').innerHTML = categories.map(category => `<button role="tab" aria-selected="${activeCategory === category}" class="category-tab ${activeCategory === category ? 'active' : ''}" data-category="${category}">${category}</button>`).join('');
    $('#categories').querySelectorAll('button').forEach(button => button.addEventListener('click', () => { activeCategory = button.dataset.category; renderCategories(); renderMenu(); }));
  }
  function renderMenu() {
    const products = menu.filter(product => activeCategory === 'Все' || product.category === activeCategory);
    $('#product-grid').innerHTML = products.map(product => `<article class="product-card"><img class="product-image" src="${esc(product.image)}" alt="${esc(product.name)}" loading="lazy">${product.tag ? `<span class="product-tag">${esc(product.tag)}</span>` : ''}<div class="product-info"><div class="product-top"><h3>${esc(product.name)}</h3><span class="product-price">${money(product.price)}</span></div><p>${esc(product.description)}</p><button class="add-button" data-add="${esc(product.id)}">${cart[product.id] ? `В корзине · ${cart[product.id]}` : 'Добавить в корзину +'}</button></div></article>`).join('');
    $('#product-grid').querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addItem(button.dataset.add)));
  }
  function addItem(id) {
    if ((cart[id] || 0) >= 20) return toast('Можно добавить не больше 20 штук.');
    cart[id] = (cart[id] || 0) + 1; saveCart(); renderMenu(); renderCart(); toast('Добавили в корзину ☕');
  }
  function total() { return menu.reduce((sum, product) => sum + product.price * (cart[product.id] || 0), 0); }
  function renderCart() {
    const entries = menu.filter(product => cart[product.id]);
    const count = entries.reduce((sum, product) => sum + cart[product.id], 0);
    $('#cart-count').textContent = count;
    $('#cart-total').textContent = money(total());
    $('#checkout-total').textContent = money(total());
    $('#checkout-summary-text').textContent = `${count} ${plural(count, 'позиция', 'позиции', 'позиций')}`;
    $('#cart-empty').classList.toggle('visible', !entries.length);
    $('#cart-items').style.display = entries.length ? '' : 'none';
    $('#checkout-open').disabled = !entries.length;
    $('#cart-items').innerHTML = entries.map(product => `<div class="cart-line"><img src="${esc(product.image)}" alt=""><div><h3>${esc(product.name)}</h3><span class="unit-price">${money(product.price)} за шт.</span><div class="quantity-controls"><button aria-label="Уменьшить" data-change="-1" data-id="${esc(product.id)}">−</button><span>${cart[product.id]}</span><button aria-label="Увеличить" data-change="1" data-id="${esc(product.id)}">+</button></div></div><div><div class="line-total">${money(product.price * cart[product.id])}</div><button class="remove-line" data-remove="${esc(product.id)}">Удалить</button></div></div>`).join('');
    $('#cart-items').querySelectorAll('[data-change]').forEach(button => button.addEventListener('click', () => changeQty(button.dataset.id, Number(button.dataset.change))));
    $('#cart-items').querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { delete cart[button.dataset.remove]; updateCart(); }));
  }
  function plural(n, one, few, many) { const n10=n%10,n100=n%100; return n10===1&&n100!==11?one:n10>=2&&n10<=4&&(n100<12||n100>14)?few:many; }
  function changeQty(id, delta) { const next = (cart[id] || 0) + delta; if (next < 1) delete cart[id]; else if (next <= 20) cart[id] = next; else return toast('Можно добавить не больше 20 штук.'); updateCart(); }
  function updateCart() { saveCart(); renderCart(); renderMenu(); }
  function openCart() { $('#scrim').classList.add('open'); $('#cart-drawer').classList.add('open'); $('#cart-drawer').setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; }
  function closeCart() { $('#scrim').classList.remove('open'); $('#cart-drawer').classList.remove('open'); $('#cart-drawer').setAttribute('aria-hidden','true'); document.body.style.overflow=''; }
  function openModal(id) { $(id).classList.add('open'); $(id).setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; }
  function closeModal(id) { $(id).classList.remove('open'); $(id).setAttribute('aria-hidden','true'); document.body.style.overflow=''; }
  function statusLabel(status) { return ({'Новый':'Мы получили заказ','Принят':'Заказ принят','Готовится':'Готовим ваш заказ','Готов к выдаче':'Можно забирать','Завершён':'Заказ завершён'})[status] || status; }
  function displayOrder(order, target) {
    const created = new Date(order.created_at).toLocaleString('ru-RU', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
    target.innerHTML = `<strong>${esc(statusLabel(order.status))}</strong> · ${esc(created)}<span class="track-items">${order.items.map(item => `${esc(item.name)} × ${item.quantity}`).join(' · ')} — ${money(order.total)}</span>`;
  }
  async function lookupOrder(id, target) {
    if (!/^[\da-f-]{36}$/i.test(id)) { target.textContent = 'Введите полный номер заказа из подтверждения.'; return; }
    target.textContent = 'Ищем заказ…';
    try { displayOrder(await api(`/api/orders/${encodeURIComponent(id)}`), target); }
    catch (error) { target.textContent = error.message; }
  }
  async function renderHistory() {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem('warm-circle-order-history') || '[]'); } catch {}
    ids = [...new Set(ids.filter(id => typeof id === 'string'))].slice(0, 8);
    const box = $('#customer-history');
    if (!ids.length) { box.hidden = true; return; }
    box.hidden = false;
    const entries = await Promise.all(ids.map(async id => { try { return await api(`/api/orders/${encodeURIComponent(id)}`); } catch { return null; } }));
    $('#history-list').innerHTML = entries.filter(Boolean).map(order => `<button class="history-entry" data-history-id="${esc(order.id)}"><span><strong>${esc(order.id.slice(0,8).toUpperCase())}</strong><small>${esc(new Date(order.created_at).toLocaleDateString('ru-RU'))} · ${order.items.length} поз.</small></span><span class="history-status">${esc(statusLabel(order.status))}</span><b>${money(order.total)}</b></button>`).join('') || '<p class="history-empty">История появится после первого заказа.</p>';
    $('#history-list').querySelectorAll('[data-history-id]').forEach(button => button.addEventListener('click', () => { $('#order-id').value = button.dataset.historyId; lookupOrder(button.dataset.historyId, $('#track-result')); }));
  }
  function receiptMarkup(receipt) {
    return `<div class="receipt-paper"><div class="receipt-logo"><span class="brand-mark">т</span><strong>тёплый круг</strong></div><h2>Электронный чек</h2><div class="receipt-line"><span>Номер чека</span><b>${esc(receipt.receipt_number)}</b></div><div class="receipt-line"><span>Номер заказа</span><b>${esc(receipt.order_id)}</b></div><div class="receipt-line"><span>Дата и время</span><b>${esc(new Date(receipt.order_created_at||receipt.created_at).toLocaleString('ru-RU'))}</b></div><div class="receipt-line"><span>Покупатель</span><b>${esc(receipt.customer_name||'—')}</b></div><div class="receipt-line"><span>Сотрудник</span><b>${esc(receipt.employee_name||'—')}</b></div><hr><div class="receipt-items">${receipt.items.map(item=>`<div class="receipt-product"><span>${esc(item.name)} × ${item.quantity}<small>${item.quantity} × ${money(item.price)}</small></span><b>${money(item.price*item.quantity)}</b></div>`).join('')}</div><hr><div class="receipt-line"><span>Стоимость товаров</span><b>${money(receipt.subtotal)}</b></div><div class="receipt-line"><span>Скидка</span><b>−${money(receipt.discount_amount)}</b></div><div class="receipt-line receipt-total"><span>Итого к оплате</span><b>${money(receipt.total)}</b></div><div class="receipt-line"><span>Способ оплаты</span><b>${esc(receipt.payment_method)}</b></div><div class="receipt-line"><span>Статус оплаты</span><b>${esc(receipt.payment_status)}</b></div><p class="receipt-thanks">Спасибо за покупку!</p></div>`;
  }
  async function lookupMyOrders(name, phone) {
    customerIdentity={name:name.trim(),phone:phone.trim()};$('#my-orders-error').textContent='';$('#my-orders-list').innerHTML='<p class="history-empty">Загружаем заказы…</p>';
    try {
      const rows=await api('/api/customer/orders',{method:'POST',body:JSON.stringify(customerIdentity)});
      $('#my-orders-list').innerHTML=rows.length?rows.map(order=>`<article class="customer-order"><div class="customer-order-head"><strong>Заказ #${esc(order.id.slice(0,8).toUpperCase())}</strong><span>${esc(new Date(order.created_at).toLocaleString('ru-RU'))}</span><span class="order-status" data-status="${esc(order.status)}">${esc(order.status)}</span></div><div class="customer-order-items">${order.items.map(i=>`${esc(i.name)} × ${i.quantity}`).join(' · ')}</div><div class="customer-order-bottom"><strong>${money(order.total)}</strong>${order.status==='Завершён'&&order.payment_status==='Оплачен'?`<button class="button button-outline customer-receipt-button" data-receipt-order="${esc(order.id)}">Посмотреть чек ↗</button>`:`<span class="payment-label">${esc(order.payment_status)}</span>`}</div></article>`).join(''):'<p class="history-empty">Заказов с такими именем и телефоном не найдено.</p>';
      $('#my-orders-list').querySelectorAll('[data-receipt-order]').forEach(button=>button.onclick=()=>openCustomerReceipt(button.dataset.receiptOrder));
    } catch(error) { $('#my-orders-error').textContent=error.message;$('#my-orders-list').innerHTML=''; }
  }
  async function openCustomerReceipt(orderId) {
    if(!customerIdentity)return;
    try{const receipt=await api(`/api/customer/receipts/${encodeURIComponent(orderId)}`,{method:'POST',body:JSON.stringify(customerIdentity)});$('#customer-receipt-content').innerHTML=receiptMarkup(receipt);$('#customer-receipt-modal').dataset.receiptId=receipt.id;openModal('#customer-receipt-modal');}
    catch(error){toast(error.message);}
  }
  async function downloadCustomerReceipt() {
    if(!customerIdentity)return;const id=$('#customer-receipt-modal').dataset.receiptId;
    try{const response=await fetch(`/api/customer/receipts/${encodeURIComponent(id)}/pdf`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(customerIdentity)});if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'Не удалось скачать PDF.');}const blob=await response.blob(),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='coffee-receipt.pdf';link.click();URL.revokeObjectURL(link.href);}catch(error){toast(error.message);}
  }
  $('#cart-open').addEventListener('click', openCart);
  $('#cart-close').addEventListener('click', closeCart);
  $('#scrim').addEventListener('click', closeCart);
  $('#go-menu').addEventListener('click', () => { closeCart(); $('#menu').scrollIntoView({behavior:'smooth'}); });
  $('#checkout-open').addEventListener('click', () => { closeCart(); openModal('#checkout-modal'); });
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => { closeModal('#checkout-modal'); closeModal('#success-modal'); }));
  document.querySelectorAll('.modal-wrap').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModal(`#${modal.id}`); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeCart(); closeModal('#checkout-modal'); closeModal('#success-modal'); } });
  $('#track-form').addEventListener('submit', event => { event.preventDefault(); lookupOrder($('#order-id').value.trim(), $('#track-result')); });
  $('#my-orders-form').addEventListener('submit',event=>{event.preventDefault();lookupMyOrders($('#history-name').value,$('#history-phone').value);});
  $('#customer-receipt-close').addEventListener('click',()=>closeModal('#customer-receipt-modal'));
  $('#customer-receipt-modal').addEventListener('click',event=>{if(event.target.id==='customer-receipt-modal')closeModal('#customer-receipt-modal');});
  $('#customer-receipt-print').addEventListener('click',()=>{document.body.classList.add('printing-customer-receipt');window.print();setTimeout(()=>document.body.classList.remove('printing-customer-receipt'),500);});
  $('#customer-receipt-pdf').addEventListener('click',downloadCustomerReceipt);
  $('#checkout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const errorEl = $('#checkout-error'); errorEl.textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const customerName=$('#customer-name').value,customerPhone=$('#customer-phone').value;
      const order = await api('/api/orders', { method:'POST', body: JSON.stringify({ name:customerName, phone:customerPhone, comment:$('#customer-comment').value, items:Object.entries(cart).map(([id,quantity]) => ({id,quantity})) }) });
      cart = {}; updateCart(); event.currentTarget.reset(); closeModal('#checkout-modal'); $('#success-id').textContent = order.id; $('#success-status').textContent = statusLabel(order.status); openModal('#success-modal');
      let history=[];try{history=JSON.parse(localStorage.getItem('warm-circle-order-history')||'[]')}catch{};localStorage.setItem('warm-circle-order-history',JSON.stringify([order.id,...history].slice(0,8)));renderHistory();
      $('#history-name').value=customerName;$('#history-phone').value=customerPhone;lookupMyOrders(customerName,customerPhone);
      clearInterval(pollTimer); pollTimer = setInterval(async () => { try { const fresh = await api(`/api/orders/${order.id}`); $('#success-status').textContent = statusLabel(fresh.status); if (fresh.status === 'Завершён') clearInterval(pollTimer); } catch {} }, 7000);
    } catch (error) { errorEl.textContent = error.message; }
    finally { button.disabled = false; }
  });

  renderCategories(); renderCart(); renderHistory(); historyTimer=setInterval(renderHistory,20000);
  api('/api/menu').then(items => { menu = items; renderMenu(); renderCart(); }).catch(error => { $('#product-grid').innerHTML = `<p class="form-error">${esc(error.message)} Проверьте, что сервер запущен.</p>`; });
})();
