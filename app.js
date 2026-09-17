/* ============================================================
   ABW – Aarna Brick Works
   Application Logic • Google Drive Sync • PWA
   ============================================================ */

// ─── Constants ───────────────────────────────────────────────
const LOCAL_STORAGE_KEY = 'abw_tracker_db_v1';
const GDRIVE_BACKUP_FILENAME = 'ABW_Database_Backup.json';
const GDRIVE_CLIENT_ID = '434441892966-203633m5fa73di5u7al48o4niilu1obh.apps.googleusercontent.com';

// ─── State ───────────────────────────────────────────────────
let state = {
  customers: [],
  sales: [],
  payments: [],
  inventoryEntries: [],
  batches: [],
  salaryPayments: [],
  gdrive: {
    clientId: '',
    autoSync: false,
    accessToken: '',
    tokenExpiry: 0,
    lastSyncTime: null,
    fileId: null,
    userEmail: ''
  }
};

let currentTab = 'dashboard';
let currentSalesSubTab = 'customers';
let editingId = null;
let confirmCallback = null;
let autoSyncTimeout = null;
let gdriveTokenClient = null;

// ─── Utilities ───────────────────────────────────────────────
function generateId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCurrency(n) {
  if (n === null || n === undefined || isNaN(n)) return '₹0';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-IN');
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function sanitizePhone(p) {
  if (!p) return '';
  return p.replace(/[^0-9+]/g, '');
}

// ─── State Persistence ───────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        customers: parsed.customers || [],
        sales: parsed.sales || [],
        payments: parsed.payments || [],
        inventoryEntries: parsed.inventoryEntries || [],
        batches: parsed.batches || [],
        salaryPayments: parsed.salaryPayments || [],
        gdrive: {
          clientId: '',
          autoSync: false,
          accessToken: '',
          tokenExpiry: 0,
          lastSyncTime: null,
          fileId: null,
          userEmail: '',
          ...(parsed.gdrive || {})
        }
      };
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
    triggerAutoSyncGoogleDrive();
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// ─── Toast ───────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2500);
}

// ─── Modal Helpers ───────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  document.body.style.overflow = '';
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay.active').forEach(m => {
    m.classList.remove('active');
  });
  document.body.style.overflow = '';
}

function resetForm(modalId) {
  const modal = document.getElementById(modalId);
  modal.querySelectorAll('input:not([type="file"]):not([type="checkbox"]), textarea, select').forEach(el => {
    if (el.tagName === 'SELECT') {
      el.selectedIndex = 0;
    } else {
      el.value = '';
    }
  });
  editingId = null;
}

// ─── Confirm Dialog ──────────────────────────────────────────
function showConfirm(title, message, callback) {
  document.getElementById('modal-confirm-title').textContent = title;
  document.getElementById('modal-confirm-message').textContent = message;
  confirmCallback = callback;
  openModal('modal-confirm');
}

// ─── Tab Navigation ──────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.tab === tab);
  });
  // Update views
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === 'view-' + tab);
  });
  // Hide settings if switching to a tab
  document.getElementById('view-settings').classList.remove('active');
  // Render active view
  renderCurrentView();
  // Close FAB menus
  closeFabMenus();
  // Update URL hash
  if (window.location.hash !== '#' + tab) {
    history.replaceState(null, '', '#' + tab);
  }
}

function renderCurrentView() {
  switch (currentTab) {
    case 'dashboard': renderDashboard(); break;
    case 'sales': renderSalesView(); break;
    case 'inventory': renderInventory(); break;
    case 'workers': renderWorkers(); break;
  }
}

// ─── FAB Menu ────────────────────────────────────────────────
function toggleFabMenu(section) {
  const menu = document.getElementById('fab-menu-' + section);
  const overlay = document.getElementById('fab-overlay-' + section);
  const isActive = menu.classList.contains('active');
  closeFabMenus();
  if (!isActive) {
    menu.classList.add('active');
    overlay.classList.add('active');
  }
}

function closeFabMenus() {
  document.querySelectorAll('.fab-menu').forEach(m => m.classList.remove('active'));
  document.querySelectorAll('.fab-overlay').forEach(o => o.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════════
function renderDashboard() {
  const totalProduced = state.inventoryEntries.reduce((s, e) => s + (Number(e.brickCount) || 0), 0);
  const totalSold = state.sales.reduce((s, e) => s + (Number(e.brickCount) || 0), 0);
  const stock = totalProduced - totalSold;
  const totalSalesAmt = state.sales.reduce((s, e) => s + (Number(e.totalCost) || 0), 0);
  const totalReceived = state.payments.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const outstanding = totalSalesAmt - totalReceived;
  const totalSalary = state.salaryPayments.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  document.getElementById('dash-stock-count').textContent = formatNumber(stock);
  document.getElementById('dash-total-sales').textContent = formatCurrency(totalSalesAmt);
  document.getElementById('dash-total-received').textContent = formatCurrency(totalReceived);
  document.getElementById('dash-outstanding').textContent = formatCurrency(outstanding);
  document.getElementById('dash-total-salary').textContent = formatCurrency(totalSalary);

  renderRecentActivity();
}

function renderRecentActivity() {
  const activities = [];

  state.sales.forEach(s => {
    const cust = state.customers.find(c => c.id === s.customerId);
    activities.push({
      type: 'sale',
      date: s.date,
      text: `<strong>${formatNumber(s.brickCount)} bricks</strong> sold${cust ? ' to ' + escapeHtml(cust.name || 'Customer') : ''} — ${formatCurrency(s.totalCost)}`,
      ts: new Date(s.date + 'T00:00:00').getTime()
    });
  });

  state.payments.forEach(p => {
    const cust = state.customers.find(c => c.id === p.customerId);
    activities.push({
      type: 'payment',
      date: p.date,
      text: `${formatCurrency(p.amount)} received${cust ? ' from ' + escapeHtml(cust.name || 'Customer') : ''} (${p.mode || 'cash'})`,
      ts: new Date(p.date + 'T00:00:00').getTime()
    });
  });

  state.inventoryEntries.forEach(e => {
    activities.push({
      type: 'inventory',
      date: e.date,
      text: `<strong>${formatNumber(e.brickCount)} bricks</strong> produced${e.notes ? ' — ' + escapeHtml(e.notes) : ''}`,
      ts: new Date(e.date + 'T00:00:00').getTime()
    });
  });

  state.salaryPayments.forEach(s => {
    const batch = state.batches.find(b => b.id === s.batchId);
    activities.push({
      type: 'salary',
      date: s.date,
      text: `${formatCurrency(s.amount)} salary paid to <strong>${escapeHtml(batch ? batch.name : 'Batch')}</strong>`,
      ts: new Date(s.date + 'T00:00:00').getTime()
    });
  });

  activities.sort((a, b) => b.ts - a.ts);
  const recent = activities.slice(0, 8);

  const container = document.getElementById('dash-recent-activity');
  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">No activity yet</p>
        <p class="empty-state-sub">Start by adding inventory or sales</p>
      </div>`;
    return;
  }

  container.innerHTML = recent.map(a => `
    <div class="activity-item">
      <div class="activity-dot ${a.type}"></div>
      <div class="activity-text">${a.text}</div>
      <div class="activity-time">${formatDate(a.date)}</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════════
//  SALES
// ══════════════════════════════════════════════════════════════
function renderSalesView() {
  switch (currentSalesSubTab) {
    case 'customers': renderCustomers(); break;
    case 'sales': renderSalesList(); break;
    case 'payments': renderPaymentsList(); break;
  }
}

function switchSalesSubTab(tab) {
  currentSalesSubTab = tab;
  document.querySelectorAll('[data-sales-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.salesTab === tab);
  });
  document.querySelectorAll('.sales-sub-view').forEach(v => {
    v.classList.toggle('active', v.id === 'sales-tab-' + tab);
  });
  renderSalesView();
}

// ── Customers ────────────────────────────────────────────────
function renderCustomers() {
  const search = (document.getElementById('sales-search').value || '').toLowerCase();
  let customers = state.customers;
  if (search) {
    customers = customers.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      (c.phone || '').includes(search) ||
      (c.address || '').toLowerCase().includes(search)
    );
  }

  const container = document.getElementById('sales-customer-list');
  if (customers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">${search ? 'No customers found' : 'No customers yet'}</p>
        <p class="empty-state-sub">${search ? 'Try a different search' : 'Tap + to add a customer'}</p>
      </div>`;
    return;
  }

  container.innerHTML = customers.map(c => {
    const custSales = state.sales.filter(s => s.customerId === c.id);
    const custPayments = state.payments.filter(p => p.customerId === c.id);
    const totalBricks = custSales.reduce((s, e) => s + (Number(e.brickCount) || 0), 0);
    const totalCost = custSales.reduce((s, e) => s + (Number(e.totalCost) || 0), 0);
    const totalPaid = custPayments.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const balance = totalCost - totalPaid;
    const phone = sanitizePhone(c.phone);

    return `
      <div class="customer-card" data-id="${c.id}">
        <div class="customer-header">
          <div>
            <div class="customer-name">${escapeHtml(c.name || 'Unnamed Customer')}</div>
            ${c.phone ? `<div class="customer-phone">${escapeHtml(c.phone)}</div>` : ''}
          </div>
          <div class="customer-actions">
            ${phone ? `
              <a href="https://wa.me/91${phone}" target="_blank" rel="noopener" class="whatsapp-btn" title="WhatsApp">
                <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" fill="currentColor"/></svg>
              </a>
              <a href="tel:${phone}" class="call-btn" title="Call">
                <svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" fill="currentColor"/></svg>
              </a>
            ` : ''}
            <button class="btn-icon" onclick="editCustomer('${c.id}')" title="Edit">
              <svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.34a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/></svg>
            </button>
            <button class="btn-icon" onclick="deleteCustomer('${c.id}')" title="Delete">
              <svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
        <div class="customer-detail">
          ${c.address ? `<div class="customer-address"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/></svg><span>${escapeHtml(c.address)}</span></div>` : ''}
          <div class="customer-stats">
            <div class="customer-stat">
              <div class="customer-stat-value">${formatNumber(totalBricks)}</div>
              <div class="customer-stat-label">Bricks</div>
            </div>
            <div class="customer-stat">
              <div class="customer-stat-value">${formatCurrency(totalCost)}</div>
              <div class="customer-stat-label">Total</div>
            </div>
            <div class="customer-stat">
              <div class="customer-stat-value text-success">${formatCurrency(totalPaid)}</div>
              <div class="customer-stat-label">Paid</div>
            </div>
            <div class="customer-stat">
              <div class="customer-stat-value ${balance > 0 ? 'text-danger' : 'text-success'}">${formatCurrency(balance)}</div>
              <div class="customer-stat-label">Balance</div>
            </div>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" onclick="openSaleModalForCustomer('${c.id}')">+ Sale</button>
          <button class="btn btn-secondary btn-sm" onclick="openPaymentModalForCustomer('${c.id}')">+ Payment</button>
        </div>
      </div>
    `;
  }).join('');
}

function openCustomerModal(id) {
  resetForm('modal-customer');
  if (id) {
    editingId = id;
    const c = state.customers.find(x => x.id === id);
    if (!c) return;
    document.getElementById('modal-customer-title').textContent = 'Edit Customer';
    document.getElementById('cust-name').value = c.name || '';
    document.getElementById('cust-phone').value = c.phone || '';
    document.getElementById('cust-address').value = c.address || '';
  } else {
    document.getElementById('modal-customer-title').textContent = 'Add Customer';
  }
  openModal('modal-customer');
}

function saveCustomer() {
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const address = document.getElementById('cust-address').value.trim();

  if (!name && !phone) {
    showToast('Enter at least a name or phone', 'error');
    return;
  }

  if (editingId) {
    const c = state.customers.find(x => x.id === editingId);
    if (c) { c.name = name; c.phone = phone; c.address = address; }
    showToast('Customer updated', 'success');
  } else {
    state.customers.push({
      id: generateId('cust'),
      name, phone, address,
      createdAt: new Date().toISOString()
    });
    showToast('Customer added', 'success');
  }
  saveState();
  closeModal('modal-customer');
  renderSalesView();
}

function editCustomer(id) { openCustomerModal(id); }

function deleteCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  showConfirm('Delete Customer', `Delete "${c ? c.name || 'this customer' : 'customer'}" and all linked sales & payments?`, () => {
    state.customers = state.customers.filter(x => x.id !== id);
    state.sales = state.sales.filter(x => x.customerId !== id);
    state.payments = state.payments.filter(x => x.customerId !== id);
    saveState();
    renderSalesView();
    renderDashboard();
    showToast('Customer deleted', 'success');
  });
}

// ── Sales ────────────────────────────────────────────────────
function renderSalesList() {
  const search = (document.getElementById('sales-search').value || '').toLowerCase();
  let sales = [...state.sales].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (search) {
    sales = sales.filter(s => {
      const cust = state.customers.find(c => c.id === s.customerId);
      return (cust && (cust.name || '').toLowerCase().includes(search)) ||
             (s.notes || '').toLowerCase().includes(search) ||
             (s.date || '').includes(search);
    });
  }

  const container = document.getElementById('sales-list');
  if (sales.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">${search ? 'No sales found' : 'No sales yet'}</p>
        <p class="empty-state-sub">Tap + to record a sale</p>
      </div>`;
    return;
  }

  container.innerHTML = sales.map(s => {
    const cust = state.customers.find(c => c.id === s.customerId);
    return `
      <div class="list-item">
        <div class="list-item-content">
          <div class="list-item-primary">${formatNumber(s.brickCount)} bricks${cust ? ' — ' + escapeHtml(cust.name || 'Customer') : ''}</div>
          <div class="list-item-secondary">${s.notes ? escapeHtml(s.notes) : ''}</div>
          <div class="list-item-meta">${formatDate(s.date)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <div class="list-item-amount">${formatCurrency(s.totalCost)}</div>
          <button class="btn-icon" onclick="deleteSale('${s.id}')" title="Delete">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

function openSaleModal() {
  resetForm('modal-sale');
  document.getElementById('modal-sale-title').textContent = 'Add Sale';
  document.getElementById('sale-date').value = todayStr();
  populateCustomerSelect('sale-customer', true);
  openModal('modal-sale');
}

function openSaleModalForCustomer(custId) {
  resetForm('modal-sale');
  document.getElementById('modal-sale-title').textContent = 'Add Sale';
  document.getElementById('sale-date').value = todayStr();
  populateCustomerSelect('sale-customer', true);
  document.getElementById('sale-customer').value = custId;
  openModal('modal-sale');
}

function openPaymentModalForCustomer(custId) {
  resetForm('modal-payment');
  document.getElementById('modal-payment-title').textContent = 'Add Payment';
  document.getElementById('pay-date').value = todayStr();
  populateCustomerSelect('pay-customer', false);
  document.getElementById('pay-customer').value = custId;
  openModal('modal-payment');
}

function saveSale() {
  const customerId = document.getElementById('sale-customer').value || null;
  const date = document.getElementById('sale-date').value || todayStr();
  const brickCount = parseInt(document.getElementById('sale-bricks').value) || 0;
  const pricePerBrick = parseFloat(document.getElementById('sale-price').value) || 0;
  let totalCost = parseFloat(document.getElementById('sale-total').value) || 0;
  const notes = document.getElementById('sale-notes').value.trim();

  if (brickCount <= 0) {
    showToast('Enter brick count', 'error');
    return;
  }
  if (totalCost <= 0 && pricePerBrick > 0) {
    totalCost = brickCount * pricePerBrick;
  }
  if (totalCost <= 0) {
    showToast('Enter price or total cost', 'error');
    return;
  }

  state.sales.push({
    id: generateId('sale'),
    customerId, date, brickCount, pricePerBrick, totalCost, notes
  });
  saveState();
  closeModal('modal-sale');
  renderSalesView();
  showToast('Sale recorded', 'success');
}

function deleteSale(id) {
  showConfirm('Delete Sale', 'Remove this sale record?', () => {
    state.sales = state.sales.filter(x => x.id !== id);
    saveState();
    renderSalesView();
    showToast('Sale deleted', 'success');
  });
}

// ── Payments ─────────────────────────────────────────────────
function renderPaymentsList() {
  const search = (document.getElementById('sales-search').value || '').toLowerCase();
  let payments = [...state.payments].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (search) {
    payments = payments.filter(p => {
      const cust = state.customers.find(c => c.id === p.customerId);
      return (cust && (cust.name || '').toLowerCase().includes(search)) ||
             (p.notes || '').toLowerCase().includes(search) ||
             (p.mode || '').toLowerCase().includes(search);
    });
  }

  const container = document.getElementById('payments-list');
  if (payments.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M21 18v1a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1h-9a2 2 0 00-2 2v8a2 2 0 002 2h9zm-9-2h10V8H12v8zm4-2.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">${search ? 'No payments found' : 'No payments yet'}</p>
        <p class="empty-state-sub">Tap + to record a payment</p>
      </div>`;
    return;
  }

  container.innerHTML = payments.map(p => {
    const cust = state.customers.find(c => c.id === p.customerId);
    const modeLabel = { cash: 'Cash', upi: 'UPI', bank: 'Bank' }[p.mode] || p.mode || 'Cash';
    return `
      <div class="list-item">
        <div class="list-item-content">
          <div class="list-item-primary">${cust ? escapeHtml(cust.name || 'Customer') : 'Walk-in'}</div>
          <div class="list-item-secondary"><span class="badge badge-info">${modeLabel}</span> ${p.notes ? escapeHtml(p.notes) : ''}</div>
          <div class="list-item-meta">${formatDate(p.date)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <div class="list-item-amount credit">${formatCurrency(p.amount)}</div>
          <button class="btn-icon" onclick="deletePayment('${p.id}')" title="Delete">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

function openPaymentModal() {
  resetForm('modal-payment');
  document.getElementById('modal-payment-title').textContent = 'Add Payment';
  document.getElementById('pay-date').value = todayStr();
  populateCustomerSelect('pay-customer', false);
  openModal('modal-payment');
}

function savePayment() {
  const customerId = document.getElementById('pay-customer').value || null;
  const amount = parseFloat(document.getElementById('pay-amount').value) || 0;
  const date = document.getElementById('pay-date').value || todayStr();
  const mode = document.getElementById('pay-mode').value || 'cash';
  const notes = document.getElementById('pay-notes').value.trim();

  if (amount <= 0) {
    showToast('Enter payment amount', 'error');
    return;
  }
  if (!customerId) {
    showToast('Select a customer', 'error');
    return;
  }

  state.payments.push({
    id: generateId('pay'),
    customerId, amount, date, mode, notes
  });
  saveState();
  closeModal('modal-payment');
  renderSalesView();
  showToast('Payment recorded', 'success');
}

function deletePayment(id) {
  showConfirm('Delete Payment', 'Remove this payment record?', () => {
    state.payments = state.payments.filter(x => x.id !== id);
    saveState();
    renderSalesView();
    showToast('Payment deleted', 'success');
  });
}

function populateCustomerSelect(selectId, allowEmpty) {
  const sel = document.getElementById(selectId);
  const current = sel.value;
  sel.innerHTML = allowEmpty ? '<option value="">Walk-in (No Customer)</option>' : '<option value="">Select Customer</option>';
  state.customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || c.phone || 'Unnamed';
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// ── Sale auto-calculate ──────────────────────────────────────
function setupSaleAutoCalc() {
  const bricks = document.getElementById('sale-bricks');
  const price = document.getElementById('sale-price');
  const total = document.getElementById('sale-total');
  const calc = () => {
    const b = parseFloat(bricks.value) || 0;
    const p = parseFloat(price.value) || 0;
    if (b > 0 && p > 0) total.value = Math.round(b * p);
  };
  bricks.addEventListener('input', calc);
  price.addEventListener('input', calc);
}

// ══════════════════════════════════════════════════════════════
//  INVENTORY
// ══════════════════════════════════════════════════════════════
function renderInventory() {
  const totalProduced = state.inventoryEntries.reduce((s, e) => s + (Number(e.brickCount) || 0), 0);
  const totalSold = state.sales.reduce((s, e) => s + (Number(e.brickCount) || 0), 0);
  const stock = totalProduced - totalSold;
  document.getElementById('inv-stock-count').textContent = formatNumber(stock);

  const entries = [...state.inventoryEntries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const container = document.getElementById('inv-log-list');

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M3 3h8v2H3v-2zm0 4h8v2H3V7zm0 4h8v2H3v-2zm0 4h8v2H3v-2zm0 4h8v2H3v-2zm10-16h8v2h-8V3zm0 4h8v2h-8V7zm0 4h8v2h-8v-2zm0 4h8v2h-8v-2zm0 4h8v2h-8v-2z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">No inventory entries yet</p>
        <p class="empty-state-sub">Tap + to add bricks produced</p>
      </div>`;
    return;
  }

  container.innerHTML = entries.map(e => `
    <div class="list-item">
      <div class="list-item-content">
        <div class="list-item-primary">${formatNumber(e.brickCount)} bricks produced</div>
        ${e.notes ? `<div class="list-item-secondary">${escapeHtml(e.notes)}</div>` : ''}
        <div class="list-item-meta">${formatDate(e.date)}</div>
      </div>
      <div class="list-item-actions">
        <button class="btn-icon" onclick="deleteInventoryEntry('${e.id}')" title="Delete">
          <svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function openInventoryModal() {
  resetForm('modal-inventory');
  document.getElementById('modal-inventory-title').textContent = 'Add Bricks';
  document.getElementById('inv-date').value = todayStr();
  openModal('modal-inventory');
}

function saveInventoryEntry() {
  const date = document.getElementById('inv-date').value || todayStr();
  const brickCount = parseInt(document.getElementById('inv-count').value) || 0;
  const notes = document.getElementById('inv-notes').value.trim();

  if (brickCount <= 0) {
    showToast('Enter brick count', 'error');
    return;
  }

  state.inventoryEntries.push({
    id: generateId('inv'),
    date, brickCount, notes
  });
  saveState();
  closeModal('modal-inventory');
  renderInventory();
  showToast(`${formatNumber(brickCount)} bricks added`, 'success');
}

function deleteInventoryEntry(id) {
  showConfirm('Delete Entry', 'Remove this inventory entry?', () => {
    state.inventoryEntries = state.inventoryEntries.filter(x => x.id !== id);
    saveState();
    renderInventory();
    showToast('Entry deleted', 'success');
  });
}

// ══════════════════════════════════════════════════════════════
//  WORKERS
// ══════════════════════════════════════════════════════════════
function renderWorkers() {
  const totalSalary = state.salaryPayments.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  document.getElementById('workers-total-salary').textContent = formatCurrency(totalSalary);

  const container = document.getElementById('workers-batch-list');
  if (state.batches.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" fill="currentColor"/></svg></div>
        <p class="empty-state-text">No worker batches yet</p>
        <p class="empty-state-sub">Tap + to add a batch</p>
      </div>`;
    return;
  }

  container.innerHTML = state.batches.map(b => {
    const salaries = state.salaryPayments.filter(s => s.batchId === b.id).sort((a, c) => (c.date || '').localeCompare(a.date || ''));
    const batchTotal = salaries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    return `
      <div class="batch-card">
        <div class="batch-header">
          <div>
            <div class="batch-name">${escapeHtml(b.name)}</div>
            <div class="fs-xs text-muted">${salaries.length} payment${salaries.length !== 1 ? 's' : ''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="batch-total">${formatCurrency(batchTotal)}</div>
            <button class="btn btn-secondary btn-sm" onclick="openSalaryModalForBatch('${b.id}')" title="Pay Salary">₹ Pay</button>
            <button class="btn-icon" onclick="deleteBatch('${b.id}')" title="Delete batch">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
        ${salaries.length > 0 ? `
          <div class="batch-salary-list">
            ${salaries.map(s => `
              <div class="salary-item">
                <div class="salary-item-info">
                  <span>${formatCurrency(s.amount)}</span>
                  <span class="salary-item-date">${formatDate(s.date)}${s.notes ? ' — ' + escapeHtml(s.notes) : ''}</span>
                </div>
                <button class="btn-icon" onclick="deleteSalary('${s.id}')" title="Delete">
                  <svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
                </button>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function openBatchModal() {
  resetForm('modal-batch');
  document.getElementById('modal-batch-title').textContent = 'Add Worker Batch';
  openModal('modal-batch');
}

function saveBatch() {
  const name = document.getElementById('batch-name').value.trim();
  if (!name) {
    showToast('Enter batch name', 'error');
    return;
  }
  state.batches.push({
    id: generateId('batch'),
    name,
    createdAt: new Date().toISOString()
  });
  saveState();
  closeModal('modal-batch');
  renderWorkers();
  showToast('Batch added', 'success');
}

function deleteBatch(id) {
  const b = state.batches.find(x => x.id === id);
  showConfirm('Delete Batch', `Delete "${b ? b.name : 'batch'}" and all salary records?`, () => {
    state.batches = state.batches.filter(x => x.id !== id);
    state.salaryPayments = state.salaryPayments.filter(x => x.batchId !== id);
    saveState();
    renderWorkers();
    showToast('Batch deleted', 'success');
  });
}

function openSalaryModal() {
  resetForm('modal-salary');
  document.getElementById('modal-salary-title').textContent = 'Pay Salary';
  document.getElementById('sal-date').value = todayStr();
  const sel = document.getElementById('sal-batch');
  sel.innerHTML = '<option value="">Select Batch</option>';
  state.batches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    sel.appendChild(opt);
  });
  openModal('modal-salary');
}

function openSalaryModalForBatch(batchId) {
  openSalaryModal();
  document.getElementById('sal-batch').value = batchId;
}

function saveSalary() {
  const batchId = document.getElementById('sal-batch').value;
  const amount = parseFloat(document.getElementById('sal-amount').value) || 0;
  const date = document.getElementById('sal-date').value || todayStr();
  const notes = document.getElementById('sal-notes').value.trim();

  if (!batchId) { showToast('Select a batch', 'error'); return; }
  if (amount <= 0) { showToast('Enter salary amount', 'error'); return; }

  state.salaryPayments.push({
    id: generateId('sal'),
    batchId, amount, date, notes
  });
  saveState();
  closeModal('modal-salary');
  renderWorkers();
  showToast('Salary paid', 'success');
}

function deleteSalary(id) {
  showConfirm('Delete Salary', 'Remove this salary record?', () => {
    state.salaryPayments = state.salaryPayments.filter(x => x.id !== id);
    saveState();
    renderWorkers();
    showToast('Record deleted', 'success');
  });
}

// ══════════════════════════════════════════════════════════════
//  GOOGLE DRIVE SYNC (NDS pattern)
// ══════════════════════════════════════════════════════════════
function isGoogleDriveConnected() {
  return state.gdrive.accessToken && state.gdrive.tokenExpiry > Date.now();
}

function updateGDriveUI() {
  const connected = isGoogleDriveConnected();
  const syncBtn = document.getElementById('header-sync-btn');
  syncBtn.classList.toggle('synced', connected);

  document.getElementById('gdrive-status').textContent = connected ? 'Connected' : 'Not connected';
  document.getElementById('gdrive-email-row').style.display = connected ? '' : 'none';
  document.getElementById('gdrive-email').textContent = state.gdrive.userEmail || '—';
  document.getElementById('gdrive-last-sync-row').style.display = state.gdrive.lastSyncTime ? '' : 'none';
  document.getElementById('gdrive-last-sync').textContent = state.gdrive.lastSyncTime ? new Date(state.gdrive.lastSyncTime).toLocaleString('en-IN') : '—';
  document.getElementById('gdrive-connect-row').style.display = connected ? 'none' : '';
  document.getElementById('gdrive-disconnect-row').style.display = connected ? '' : 'none';
  document.getElementById('gdrive-auto-sync-row').style.display = connected ? '' : 'none';
  document.getElementById('gdrive-manual-row').style.display = connected ? '' : 'none';
  document.getElementById('gdrive-auto-sync-toggle').checked = state.gdrive.autoSync;
}

function connectGoogleDrive() {
  const clientId = GDRIVE_CLIENT_ID;
  state.gdrive.clientId = clientId;
  saveState();

  try {
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
      callback: async (tokenResponse) => {
        if (tokenResponse.error) {
          showToast('Auth failed: ' + tokenResponse.error, 'error');
          return;
        }
        state.gdrive.accessToken = tokenResponse.access_token;
        state.gdrive.tokenExpiry = Date.now() + (parseInt(tokenResponse.expires_in || 3600) - 60) * 1000;
        // Get user email
        try {
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + state.gdrive.accessToken }
          });
          if (res.ok) {
            const info = await res.json();
            state.gdrive.userEmail = info.email || '';
          }
        } catch (e) { /* ignore */ }
        // Find existing backup file
        await findGDriveFile();
        saveState();
        updateGDriveUI();
        showToast('Google Drive connected', 'success');
      },
      error_callback: (err) => {
        showToast('Auth error: ' + (err.message || 'Unknown'), 'error');
      }
    });
    gdriveTokenClient.requestAccessToken({ prompt: 'consent' });
  } catch (e) {
    showToast('Failed to init Google auth', 'error');
    console.error(e);
  }
}

function disconnectGoogleDrive() {
  showConfirm('Disconnect', 'Disconnect Google Drive sync? Local data will remain.', () => {
    if (state.gdrive.accessToken) {
      try { google.accounts.oauth2.revoke(state.gdrive.accessToken); } catch (e) { /* ignore */ }
    }
    state.gdrive.accessToken = '';
    state.gdrive.tokenExpiry = 0;
    state.gdrive.userEmail = '';
    state.gdrive.fileId = null;
    state.gdrive.autoSync = false;
    saveState();
    updateGDriveUI();
    showToast('Disconnected', 'success');
  });
}

async function findGDriveFile() {
  if (!isGoogleDriveConnected()) return;
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_BACKUP_FILENAME}' and trashed=false&fields=files(id,name)&spaces=drive`,
      { headers: { Authorization: 'Bearer ' + state.gdrive.accessToken } }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        state.gdrive.fileId = data.files[0].id;
      }
    }
  } catch (e) { console.error('findGDriveFile:', e); }
}

async function uploadToGoogleDrive(manual = true) {
  if (!isGoogleDriveConnected()) {
    if (manual) showToast('Not connected to Google Drive', 'error');
    return;
  }

  const syncBtn = document.getElementById('header-sync-btn');
  syncBtn.classList.add('syncing');

  const payload = JSON.stringify(state);

  try {
    let res;
    if (state.gdrive.fileId) {
      // Update existing
      res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${state.gdrive.fileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer ' + state.gdrive.accessToken,
            'Content-Type': 'application/json'
          },
          body: payload
        }
      );
    } else {
      // Create new (multipart)
      const boundary = '-------314159265358979323846';
      const metadata = JSON.stringify({
        name: GDRIVE_BACKUP_FILENAME,
        mimeType: 'application/json',
        description: 'ABW – Aarna Brick Works backup'
      });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;

      res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + state.gdrive.accessToken,
            'Content-Type': 'multipart/related; boundary=' + boundary
          },
          body
        }
      );
    }

    if (res.ok) {
      const data = await res.json();
      state.gdrive.fileId = data.id || state.gdrive.fileId;
      state.gdrive.lastSyncTime = new Date().toISOString();
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
      if (manual) showToast('Synced to Google Drive', 'success');
      updateGDriveUI();
    } else if (res.status === 401) {
      state.gdrive.tokenExpiry = 0;
      if (manual) showToast('Session expired. Reconnect.', 'error');
      updateGDriveUI();
    } else {
      if (manual) showToast('Sync failed', 'error');
    }
  } catch (e) {
    if (manual) showToast('Sync error', 'error');
    console.error('uploadToGoogleDrive:', e);
  } finally {
    syncBtn.classList.remove('syncing');
  }
}

async function restoreFromGoogleDrive() {
  if (!isGoogleDriveConnected()) {
    showToast('Not connected to Google Drive', 'error');
    return;
  }

  const syncBtn = document.getElementById('header-sync-btn');
  syncBtn.classList.add('syncing');

  try {
    // Find file
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_BACKUP_FILENAME}' and trashed=false&fields=files(id,name,modifiedTime)&spaces=drive`,
      { headers: { Authorization: 'Bearer ' + state.gdrive.accessToken } }
    );
    if (!searchRes.ok) { showToast('Search failed', 'error'); return; }

    const searchData = await searchRes.json();
    if (!searchData.files || searchData.files.length === 0) {
      showToast('No backup found on Drive', 'error');
      return;
    }

    const file = searchData.files[0];
    const dlRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: { Authorization: 'Bearer ' + state.gdrive.accessToken } }
    );
    if (!dlRes.ok) { showToast('Download failed', 'error'); return; }

    const backupData = await dlRes.json();

    // Validate
    if (!Array.isArray(backupData.customers) && !Array.isArray(backupData.inventoryEntries)) {
      showToast('Invalid backup file', 'error');
      return;
    }

    showConfirm('Restore Backup', `Restore from Google Drive? Modified: ${new Date(file.modifiedTime).toLocaleString('en-IN')}. This will overwrite local data.`, () => {
      const gdriveConfig = { ...state.gdrive };
      state = {
        customers: backupData.customers || [],
        sales: backupData.sales || [],
        payments: backupData.payments || [],
        inventoryEntries: backupData.inventoryEntries || [],
        batches: backupData.batches || [],
        salaryPayments: backupData.salaryPayments || [],
        gdrive: gdriveConfig
      };
      saveState();
      renderCurrentView();
      updateGDriveUI();
      showToast('Backup restored', 'success');
    });
  } catch (e) {
    showToast('Restore error', 'error');
    console.error('restoreFromGoogleDrive:', e);
  } finally {
    syncBtn.classList.remove('syncing');
  }
}

function triggerAutoSyncGoogleDrive() {
  if (!state.gdrive || !state.gdrive.autoSync || !isGoogleDriveConnected()) return;
  if (autoSyncTimeout) clearTimeout(autoSyncTimeout);
  autoSyncTimeout = setTimeout(() => {
    uploadToGoogleDrive(false);
  }, 2500);
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS – Data Export / Import
// ══════════════════════════════════════════════════════════════
function exportData() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = todayStr().replace(/-/g, '_');
  a.href = url;
  a.download = `abw_backup_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Backup exported', 'success');
}

function importData() {
  document.getElementById('import-file-input').click();
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data.customers) && !Array.isArray(data.inventoryEntries)) {
        showToast('Invalid backup file', 'error');
        return;
      }
      showConfirm('Import Backup', `Import from "${file.name}"? This will overwrite all local data.`, () => {
        const gdriveConfig = { ...state.gdrive };
        state = {
          customers: data.customers || [],
          sales: data.sales || [],
          payments: data.payments || [],
          inventoryEntries: data.inventoryEntries || [],
          batches: data.batches || [],
          salaryPayments: data.salaryPayments || [],
          gdrive: gdriveConfig
        };
        saveState();
        renderCurrentView();
        updateGDriveUI();
        showToast('Data imported', 'success');
      });
    } catch (err) {
      showToast('Invalid JSON file', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ── Hard Refresh ─────────────────────────────────────────────
async function triggerHardRefresh() {
  showConfirm('Clear Cache', 'This will clear cache and reload the app. Your data is safe.', async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
      const keys = await caches.keys();
      for (const key of keys) await caches.delete(key);
    } catch (e) { /* ignore */ }
    window.location.reload(true);
  });
}

// ══════════════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION
// ══════════════════════════════════════════════════════════════
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('New version available. Refresh to update.');
          newWorker.postMessage('skipWaiting');
        }
      });
    });
  }).catch(err => {
    console.error('SW registration failed:', err);
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

// ══════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ══════════════════════════════════════════════════════════════
function bindEvents() {
  // ── Navigation ──
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Settings ──
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('view-settings').classList.add('active');
    updateGDriveUI();
  });
  document.getElementById('btn-back-from-settings').addEventListener('click', () => {
    switchTab(currentTab);
  });

  // ── Sales sub-tabs ──
  document.querySelectorAll('[data-sales-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchSalesSubTab(btn.dataset.salesTab));
  });

  // ── Search ──
  document.getElementById('sales-search').addEventListener('input', () => {
    renderSalesView();
  });

  // ── FABs ──
  document.getElementById('fab-sales').addEventListener('click', () => openCustomerModal());

  document.getElementById('fab-inventory').addEventListener('click', () => openInventoryModal());

  document.getElementById('fab-workers').addEventListener('click', () => openBatchModal());

  // ── Save buttons ──
  document.getElementById('btn-save-customer').addEventListener('click', saveCustomer);
  document.getElementById('btn-save-sale').addEventListener('click', saveSale);
  document.getElementById('btn-save-payment').addEventListener('click', savePayment);
  document.getElementById('btn-save-inventory').addEventListener('click', saveInventoryEntry);
  document.getElementById('btn-save-batch').addEventListener('click', saveBatch);
  document.getElementById('btn-save-salary').addEventListener('click', saveSalary);

  // ── Modal close/cancel ──
  document.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
    btn.addEventListener('click', () => closeAllModals());
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeAllModals();
    });
  });

  // ── Confirm dialog ──
  document.getElementById('btn-confirm-yes').addEventListener('click', () => {
    closeModal('modal-confirm');
    if (confirmCallback) { confirmCallback(); confirmCallback = null; }
  });
  document.getElementById('btn-confirm-no').addEventListener('click', () => {
    closeModal('modal-confirm');
    confirmCallback = null;
  });

  // ── Sale auto-calc ──
  setupSaleAutoCalc();

  // ── Google Drive ──
  document.getElementById('gdrive-connect-btn').addEventListener('click', connectGoogleDrive);
  document.getElementById('gdrive-disconnect-btn').addEventListener('click', disconnectGoogleDrive);
  document.getElementById('gdrive-sync-btn').addEventListener('click', () => uploadToGoogleDrive(true));
  document.getElementById('gdrive-restore-btn').addEventListener('click', restoreFromGoogleDrive);
  document.getElementById('gdrive-auto-sync-toggle').addEventListener('change', (e) => {
    state.gdrive.autoSync = e.target.checked;
    saveState();
    showToast(e.target.checked ? 'Auto-sync enabled' : 'Auto-sync disabled');
  });
  document.getElementById('header-sync-btn').addEventListener('click', () => {
    if (isGoogleDriveConnected()) uploadToGoogleDrive(true);
    else {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('view-settings').classList.add('active');
      updateGDriveUI();
    }
  });

  // ── Data management ──
  document.getElementById('btn-export-data').addEventListener('click', exportData);
  document.getElementById('btn-import-data').addEventListener('click', importData);
  document.getElementById('import-file-input').addEventListener('change', handleImportFile);
  document.getElementById('btn-hard-refresh').addEventListener('click', triggerHardRefresh);

  // ── Hash routing ──
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    if (['dashboard', 'sales', 'inventory', 'workers'].includes(hash)) {
      switchTab(hash);
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
function initApp() {
  loadState();
  bindEvents();

  // Route from hash or default to dashboard
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (['dashboard', 'sales', 'inventory', 'workers'].includes(hash)) {
    switchTab(hash);
  } else {
    switchTab('dashboard');
  }

  registerServiceWorker();
  updateGDriveUI();
}

document.addEventListener('DOMContentLoaded', initApp);
