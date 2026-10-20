/**
 * ============================================================================
 * Frontend Application Controller (Renderer Process)
 * ============================================================================
 * Manages all DOM interactions, data reactivity, SQLite/MySQL persistence,
 * interactive table rendering, in-place cell editing, and the BOM Analyzer Engine.
 *
 * Communicates with the backend main process via `window.electronAPI.*`.
 *
 * TABLE OF CONTENTS:
 *   1. Application State & Constants
 *   2. Micro-Animations & Notifications (Ripple, Number Tween, Toast)
 *   3. Data Models & Normalization Helpers
 *   4. Lookup, Search & Filter Helpers
 *   5. UI Rendering & Metrics (Inventory Table, KPI Badges, In-Place Edit)
 *   6. BOM Analyzer Engine (Readiness Analysis, Shortages, Buildable Boards)
 *   7. Inventory Action Handlers (Add, Edit, Stepper, Clear, Delete, Revert, Save)
 *   8. BOM Action Handlers (Load Sample, Clear, Deduct Stock)
 *   9. Remote MySQL Sync Modal Controller
 *  10. Application Initialization & Event Wiring (DOM Ready, Keybindings, Window Controls)
 * ============================================================================
 */

const LOW_STOCK_THRESHOLD = 10;

// Application State
let componentList = [];
let componentListOldSave = [];
let bomItems = [];
let bomAnalysis = [];

let selectedMPN = '';
let isDarkMode = true;
let themePreference = 'system';
let activeSubTab = 'addComponentTab';

// Sorting state for Inventory Table & BOM Table
let invSortCol = null;
let invSortAsc = true;
let bomSortCol = null;
let bomSortAsc = true;

// ============================================================================
// Interactive Micro-Animations (Material Ripple, Number Tween, Snackbar Toast)
// ============================================================================

function attachMaterialRipples() {
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.ripple-btn');
    if (!btn || btn.disabled) return;

    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    wave.style.width = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left = `${e.clientX - rect.left - size / 2}px`;
    wave.style.top = `${e.clientY - rect.top - size / 2}px`;

    btn.appendChild(wave);
    const removeWave = () => {
      if (wave.parentNode) wave.remove();
    };
    wave.addEventListener('animationend', removeWave, { once: true });
    setTimeout(removeWave, 600);
  });
}

const counterAnimationMap = new WeakMap();

function animateCounter(el, targetValue) {
  if (!el) return;
  const startValue = parseInt(el.dataset.numericVal ?? el.textContent, 10) || 0;
  el.dataset.numericVal = String(targetValue);

  if (startValue === targetValue) {
    el.textContent = String(targetValue);
    return;
  }

  if (counterAnimationMap.has(el)) {
    cancelAnimationFrame(counterAnimationMap.get(el));
  }

  const duration = 360;
  const startTime = performance.now();

  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(startValue + (targetValue - startValue) * eased);
    el.textContent = String(current);
    if (progress < 1) {
      counterAnimationMap.set(el, requestAnimationFrame(step));
    } else {
      el.textContent = String(targetValue);
    }
  };

  counterAnimationMap.set(el, requestAnimationFrame(step));
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'google-toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    toast.addEventListener('animationend', () => toast.remove());
  }, 2600);
}

// ============================================================================
// Modern In-App Material 3 Alert & Confirmation Dialog
// Replaces native OS message boxes with theme-aware (Dark/Light) modal cards.
// ============================================================================

let dialogQueue = [];
let isDialogOpen = false;

function getDialogIconSVG(type) {
  switch (type) {
    case 'save':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>`;
    case 'clear':
    case 'delete':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>`;
    case 'reset':
    case 'revert':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"></polyline>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
      </svg>`;
    case 'logout':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
        <polyline points="16 17 21 12 16 7"></polyline>
        <line x1="21" y1="12" x2="9" y2="12"></line>
      </svg>`;
    case 'error':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>`;
    case 'warning':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>`;
    case 'question':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>`;
    case 'success':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>`;
    case 'info':
    default:
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>`;
  }
}

function processNextDialog() {
  if (dialogQueue.length === 0) {
    isDialogOpen = false;
    return;
  }

  isDialogOpen = true;
  const { options, resolve } = dialogQueue.shift();

  const modal = document.getElementById('appDialogModal');
  const iconWrap = document.getElementById('appDialogIconWrap');
  const titleEl = document.getElementById('appDialogTitle');
  const msgEl = document.getElementById('appDialogMessage');
  const actionsEl = document.getElementById('appDialogActions');

  if (!modal || !iconWrap || !titleEl || !msgEl || !actionsEl) {
    resolve({ response: 0 });
    isDialogOpen = false;
    return;
  }

  const rawType = String(options.icon || options.type || 'info').toLowerCase();
  let iconType = 'info';
  if (rawType.includes('save') || rawType.includes('sync')) iconType = 'save';
  else if (rawType.includes('clear') || rawType.includes('delete') || rawType.includes('trash')) iconType = 'clear';
  else if (rawType.includes('reset') || rawType.includes('revert') || rawType.includes('reload')) iconType = 'reset';
  else if (rawType.includes('logout') || rawType.includes('signout')) iconType = 'logout';
  else if (rawType.includes('err')) iconType = 'error';
  else if (rawType.includes('warn')) iconType = 'warning';
  else if (rawType.includes('quest')) iconType = 'question';
  else if (rawType.includes('succ')) iconType = 'success';
  else iconType = 'info';

  iconWrap.className = `app-dialog-icon-wrap icon-type-${iconType}`;
  iconWrap.innerHTML = getDialogIconSVG(iconType);

  titleEl.textContent = options.title || 'Notification';
  msgEl.textContent = options.message || '';

  actionsEl.innerHTML = '';
  const buttons = Array.isArray(options.buttons) && options.buttons.length > 0 ? options.buttons : ['OK'];
  const defaultId = Number.isInteger(options.defaultId) ? Math.min(Math.max(0, options.defaultId), buttons.length - 1) : 0;
  const cancelId = Number.isInteger(options.cancelId) ? Math.min(Math.max(0, options.cancelId), buttons.length - 1) : (buttons.length > 1 ? buttons.length - 1 : 0);

  let keyListener = null;

  function finish(responseIndex) {
    if (keyListener) {
      document.removeEventListener('keydown', keyListener, true);
      keyListener = null;
    }
    modal.classList.add('hidden');
    resolve({ response: responseIndex });
    setTimeout(processNextDialog, 60);
  }

  buttons.forEach((label, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    const lower = String(label).toLowerCase();
    const isDestructive = lower.includes('delete') || lower.includes('clear') || lower.includes('discard') || lower === "don't save";

    if (isDestructive) {
      btn.className = 'btn-tonal-danger ripple-btn';
    } else if (idx === defaultId) {
      btn.className = 'btn-filled-primary ripple-btn';
    } else {
      btn.className = 'btn-tonal ripple-btn';
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      finish(idx);
    });

    actionsEl.appendChild(btn);
  });

  modal.classList.remove('hidden');

  const defaultBtn = actionsEl.children[defaultId] || actionsEl.firstElementChild;
  if (defaultBtn) {
    setTimeout(() => defaultBtn.focus(), 40);
  }

  keyListener = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(cancelId);
    } else if (e.key === 'Enter') {
      const active = document.activeElement;
      if (active && active.tagName === 'BUTTON' && actionsEl.contains(active)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      finish(defaultId);
    }
  };

  document.addEventListener('keydown', keyListener, true);
}

function showAppDialog(options = {}) {
  return new Promise((resolve) => {
    dialogQueue.push({ options, resolve });
    if (!isDialogOpen) {
      processNextDialog();
    }
  });
}

// Alias showMessage to showAppDialog
const showMessage = showAppDialog;
window.showAppDialog = showAppDialog;

/**
 * Records an inventory change in the audit log via the Electron IPC bridge.
 * Non-blocking, fails gracefully if IPC is not yet loaded.
 *
 * @param {string} actionType 'ADD' | 'EDIT' | 'DELETE' | 'IMPORT' | 'CLEAR_ALL' | 'BOM_DEDUCT' | 'REVERT' | 'SAVE'
 * @param {string} mpn Component MPN or target descriptor
 * @param {string} changeDetails Human-readable description of change
 */
function logAuditRecord(actionType, mpn, changeDetails) {
  if (window.electronAPI && typeof window.electronAPI.logAuditChange === 'function') {
    let username;
    try {
      const user = window.authController && typeof window.authController.getCurrentUser === 'function' ? window.authController.getCurrentUser() : null;
      if (user && user.username) username = user.username;
    } catch {}
    window.electronAPI.logAuditChange({
      username,
      actionType,
      mpn,
      changeDetails
    }).catch((err) => {
      console.warn('Audit log write notice:', err.message);
    });
  }
}

// ============================================================================
// String Normalization & Data Model Helpers
// ============================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

function normalizeString(str) {
  return String(str || '')
    .trim()
    .replace(/[\s\n\t]+/g, '')
    .toUpperCase();
}

function createComponent(mpn = '', quantity = 0, type = '', value = '', footprint = '', location = '', customerCode = '') {
  const q = Number.isFinite(Number(quantity)) ? Math.max(0, parseInt(quantity, 10)) : 0;
  return {
    mpn: String(mpn || '').trim(),
    quantity: q,
    type: String(type || '').trim(),
    value: String(value || '').trim(),
    footprint: String(footprint || '').trim(),
    location: String(location || '').trim(),
    customerCode: String(customerCode || '').trim()
  };
}

function cloneComponentList(list) {
  return list.map((c) => ({ ...c }));
}

function areComponentListsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const c1 = a[i];
    const c2 = b[i];
    if (
      c1.mpn !== c2.mpn ||
      c1.quantity !== c2.quantity ||
      c1.type !== c2.type ||
      c1.value !== c2.value ||
      c1.footprint !== c2.footprint ||
      c1.location !== c2.location ||
      c1.customerCode !== c2.customerCode
    ) {
      return false;
    }
  }
  return true;
}



// ============================================================================
// Lookup & Filter Helpers
// ============================================================================

function searchComponentByMPN(list, mpn) {
  const target = normalizeString(mpn);
  if (!target) return -1;
  for (let i = 0; i < list.length; i++) {
    if (normalizeString(list[i].mpn) === target) {
      return i;
    }
  }
  return -1;
}

function matchesComponentFilter(comp, filterText, typeFilter, stockFilter) {
  const normalizedQuery = normalizeString(filterText);
  const checkType = Boolean(typeFilter) && typeFilter.toLowerCase() !== 'all types';
  const checkStock = Boolean(stockFilter) && stockFilter.toLowerCase() !== 'all stock';

  let textMatched = !normalizedQuery;
  if (!textMatched) {
    const fields = [
      comp.mpn,
      String(comp.quantity),
      comp.type,
      comp.value,
      comp.footprint,
      comp.location,
      comp.customerCode
    ];
    textMatched = fields.some((f) => normalizeString(f).includes(normalizedQuery));
  }

  let typeMatched = true;
  if (checkType) {
    typeMatched = comp.type.trim().toLowerCase() === typeFilter.trim().toLowerCase();
  }

  let stockMatched = true;
  if (checkStock) {
    const qty = comp.quantity;
    const sf = stockFilter.toLowerCase();
    if (sf.includes('out of stock')) {
      stockMatched = qty <= 0;
    } else if (sf.includes('low stock')) {
      stockMatched = qty > 0 && qty <= LOW_STOCK_THRESHOLD;
    } else if (sf.includes('in stock')) {
      stockMatched = qty > 0;
    } else if (sf.includes('healthy')) {
      stockMatched = qty > LOW_STOCK_THRESHOLD;
    }
  }

  return textMatched && typeMatched && stockMatched;
}

// ============================================================================
// UI Rendering & Metrics
// ============================================================================

function renderInventoryTable(overrideSearchQuery = null) {
  const tbody = document.getElementById('inventoryTableBody');
  tbody.innerHTML = '';

  const query =
    overrideSearchQuery !== null
      ? overrideSearchQuery
      : document.getElementById('quickFilterLineEdit').value;
  const typeFilter = document.getElementById('typeFilterComboBox').value;
  const stockFilter = document.getElementById('stockFilterComboBox').value;

  const displayList = [...componentList];
  if (invSortCol !== null) {
    displayList.sort((a, b) => {
      let vA;
      let vB;
      switch (invSortCol) {
        case 0:
          vA = a.mpn.toLowerCase();
          vB = b.mpn.toLowerCase();
          break;
        case 1:
          vA = a.quantity;
          vB = b.quantity;
          break;
        case 2:
          vA = a.type.toLowerCase();
          vB = b.type.toLowerCase();
          break;
        case 3:
          vA = a.value.toLowerCase();
          vB = b.value.toLowerCase();
          break;
        case 4:
          vA = a.footprint.toLowerCase();
          vB = b.footprint.toLowerCase();
          break;
        case 5:
          vA = a.location.toLowerCase();
          vB = b.location.toLowerCase();
          break;
        case 6:
          vA = a.customerCode.toLowerCase();
          vB = b.customerCode.toLowerCase();
          break;
        default:
          vA = '';
          vB = '';
      }
      if (vA < vB) return invSortAsc ? -1 : 1;
      if (vA > vB) return invSortAsc ? 1 : -1;
      return 0;
    });
  }

  let visibleCount = 0;

  for (let rowIndex = 0; rowIndex < displayList.length; rowIndex++) {
    const comp = displayList[rowIndex];
    const isVisible = matchesComponentFilter(comp, query, typeFilter, stockFilter);
    if (!isVisible) continue;
    visibleCount++;

    const tr = document.createElement('tr');
    tr.dataset.mpn = comp.mpn;
    tr.style.animationDelay = `${Math.min(visibleCount * 12, 180)}ms`;

    if (selectedMPN && normalizeString(selectedMPN) === normalizeString(comp.mpn)) {
      tr.classList.add('selected-row');
    }

    let stockClass = 'stock-ok';
    let stockTitle = 'Healthy Stock';
    if (comp.quantity <= 0) {
      stockClass = 'stock-err';
      stockTitle = 'Out of Stock (0 units)';
    } else if (comp.quantity <= LOW_STOCK_THRESHOLD) {
      stockClass = 'stock-warn';
      stockTitle = 'Low Stock (<= 10 units)';
    }

    // Column 0: MPN
    const tdMpn = document.createElement('td');
    tdMpn.className = 'cell-bold';
    tdMpn.textContent = comp.mpn;
    tr.appendChild(tdMpn);

    // Column 1: Quantity Pill Badge
    const tdQty = document.createElement('td');
    tdQty.className = 'cell-center';
    tdQty.title = stockTitle;
    const qtyBadge = document.createElement('span');
    qtyBadge.className = `stock-pill ${stockClass}`;
    qtyBadge.textContent = String(comp.quantity);
    tdQty.appendChild(qtyBadge);
    tdQty.addEventListener('dblclick', (e) => {
      if (activeSubTab !== 'EditComponentTab') return;
      e.stopPropagation();
      startInlineCellEdit(tdQty, comp.mpn, 1, String(comp.quantity));
    });
    tr.appendChild(tdQty);

    // Column 2: Type Chip
    const tdType = document.createElement('td');
    const typeSpan = document.createElement('span');
    typeSpan.className = 'type-chip';
    typeSpan.textContent = comp.type || '—';
    tdType.appendChild(typeSpan);
    tdType.addEventListener('dblclick', (e) => {
      if (activeSubTab !== 'EditComponentTab') return;
      e.stopPropagation();
      startInlineCellEdit(tdType, comp.mpn, 2, comp.type);
    });
    tr.appendChild(tdType);

    // Columns 3..6
    const otherCols = [
      { text: comp.value, col: 3 },
      { text: comp.footprint, col: 4 },
      { text: comp.location, col: 5 },
      { text: comp.customerCode, col: 6 }
    ];

    for (const cDef of otherCols) {
      const td = document.createElement('td');
      td.textContent = cDef.text;
      td.addEventListener('dblclick', (e) => {
        if (activeSubTab !== 'EditComponentTab') return;
        e.stopPropagation();
        startInlineCellEdit(td, comp.mpn, cDef.col, cDef.text);
      });
      tr.appendChild(td);
    }

    tr.addEventListener('click', () => {
      const idx = searchComponentByMPN(componentList, comp.mpn);
      if (idx === -1) return;
      selectedMPN = componentList[idx].mpn;
      populateInspectorForComponent(componentList[idx]);
      highlightSelectedInventoryRow();
    });

    tbody.appendChild(tr);
  }

  document.getElementById('visibleRowsBadgeLabel').textContent = `Showing ${visibleCount} of ${componentList.length}`;
  updateDashboardMetrics();
}

function highlightSelectedInventoryRow() {
  const rows = document.querySelectorAll('#inventoryTableBody tr');
  rows.forEach((r) => {
    if (selectedMPN && normalizeString(r.dataset.mpn) === normalizeString(selectedMPN)) {
      r.classList.add('selected-row');
    } else {
      r.classList.remove('selected-row');
    }
  });
}

function startInlineCellEdit(td, canonicalMPN, colIndex, initialText) {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Editing cells is disabled.');
    return;
  }
  if (td.querySelector('input')) return;
  const idx = searchComponentByMPN(componentList, canonicalMPN);
  if (idx === -1) return;
  const comp = componentList[idx];

  const input = document.createElement('input');
  input.type = colIndex === 1 ? 'number' : 'text';
  if (colIndex === 1) input.min = '0';
  input.value = initialText;
  input.className = 'inline-cell-input';

  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const newVal = input.value.trim();
    switch (colIndex) {
      case 1:
        comp.quantity = Math.max(0, parseInt(newVal, 10) || 0);
        break;
      case 2:
        comp.type = newVal;
        break;
      case 3:
        comp.value = newVal;
        break;
      case 4:
        comp.footprint = newVal;
        break;
      case 5:
        comp.location = newVal;
        break;
      case 6:
        comp.customerCode = newVal;
        break;
    }
    populateInspectorForComponent(comp);
    renderInventoryTable();
    refreshBomAnalysis();
    showToast(`Updated ${comp.mpn}`);

    if (String(initialText).trim() !== String(newVal).trim()) {
      const colNames = ['', 'Quantity', 'Type', 'Value', 'Footprint', 'Location', 'Customer Code'];
      const fieldName = colNames[colIndex] || 'Field';
      logAuditRecord('EDIT', comp.mpn, `Inline edited ${fieldName}: '${initialText}' → '${newVal}'`);
    }
  };

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      input.blur();
    } else if (ev.key === 'Escape') {
      input.removeEventListener('blur', commit);
      renderInventoryTable();
    }
  });
}

function updateDashboardMetrics() {
  const uniqueParts = componentList.length;
  let totalUnits = 0;
  let lowOrOutCount = 0;

  for (const c of componentList) {
    totalUnits += c.quantity;
    if (c.quantity <= LOW_STOCK_THRESHOLD) {
      lowOrOutCount++;
    }
  }

  animateCounter(document.getElementById('statUniquePartsValue'), uniqueParts);
  animateCounter(document.getElementById('statTotalUnitsValue'), totalUnits);

  const lowEl = document.getElementById('statLowStockValue');
  animateCounter(lowEl, lowOrOutCount);
  lowEl.className = 'stat-card-value ' + (lowOrOutCount > 0 ? 'status-warn' : 'status-saved');

  const isDirty = !areComponentListsEqual(componentListOldSave, componentList);
  const syncEl = document.getElementById('statSyncStatusValue');
  syncEl.textContent = isDirty ? 'Unsaved *' : 'Saved';
  syncEl.className = 'stat-card-value ' + (isDirty ? 'status-dirty' : 'status-saved');

  const syncDot = document.getElementById('syncStatusDot');
  if (syncDot) {
    syncDot.classList.toggle('dirty', isDirty);
  }

  window.electronAPI.setDirty(isDirty);
}

function populateInspectorForComponent(comp) {
  const editMPN = document.getElementById('editMPNLineEdit');
  editMPN.value = comp.mpn;
  editMPN.disabled = true;

  document.getElementById('editFindpushButton').disabled = true;

  const editQty = document.getElementById('editQuantitySpinBox');
  editQty.value = comp.quantity;
  editQty.disabled = false;

  const editLoc = document.getElementById('editLocatioLineEdit');
  editLoc.value = comp.location;
  editLoc.disabled = false;

  const editVal = document.getElementById('editValueLineEdit');
  editVal.value = comp.value;
  editVal.disabled = false;

  const editFp = document.getElementById('editFootprintLineEdit');
  editFp.value = comp.footprint;
  editFp.disabled = false;

  const editType = document.getElementById('editTypeComboBox');
  const matchingOption = Array.from(editType.options).find(
    (opt) => opt.value.toLowerCase() === comp.type.trim().toLowerCase()
  );
  if (matchingOption) {
    editType.value = matchingOption.value;
  }
  editType.disabled = false;

  const editCode = document.getElementById('editCustomerCodeLineEdit');
  editCode.value = comp.customerCode;
  editCode.disabled = false;

  document.getElementById('applyEditspushButton').disabled = false;
  document.getElementById('deleteComponentpushButton').disabled = false;
  document.getElementById('incStockPushButton').disabled = false;
  document.getElementById('decStockPushButton').disabled = false;

  // Populate Inspector Tab tiles
  document.getElementById('foundedQuantityLabel').textContent = `${comp.quantity} units`;
  document.getElementById('foundedLocationLable').textContent = comp.location || '-';
  document.getElementById('foundedFootprintLabel').textContent = comp.footprint || '-';
  document.getElementById('foundedTypeLable').textContent = comp.type || '-';
  document.getElementById('foundedValueLabel').textContent = comp.value || '-';
  document.getElementById('foundedCustomerCodeLabel').textContent = comp.customerCode || '-';
}

function resetEditTabState() {
  const editMPN = document.getElementById('editMPNLineEdit');
  editMPN.value = '';
  editMPN.disabled = false;

  document.getElementById('editFindpushButton').disabled = false;

  const editQty = document.getElementById('editQuantitySpinBox');
  editQty.value = 0;
  editQty.disabled = true;

  const editLoc = document.getElementById('editLocatioLineEdit');
  editLoc.value = '';
  editLoc.disabled = true;

  const editVal = document.getElementById('editValueLineEdit');
  editVal.value = '';
  editVal.disabled = true;

  const editFp = document.getElementById('editFootprintLineEdit');
  editFp.value = '';
  editFp.disabled = true;

  const editType = document.getElementById('editTypeComboBox');
  editType.selectedIndex = 0;
  editType.disabled = true;

  const editCode = document.getElementById('editCustomerCodeLineEdit');
  editCode.value = '';
  editCode.disabled = true;

  document.getElementById('applyEditspushButton').disabled = true;
  document.getElementById('deleteComponentpushButton').disabled = true;
  document.getElementById('incStockPushButton').disabled = true;
  document.getElementById('decStockPushButton').disabled = true;

  selectedMPN = '';
  highlightSelectedInventoryRow();
}

function clearAddComponentForm() {
  document.getElementById('MPNLineEdit').value = '';
  document.getElementById('locationLineEdit').value = '';
  document.getElementById('addValueLineEdit').value = '';
  document.getElementById('addCustomerCodeLineEdit').value = '';
  document.getElementById('typeComboBox').selectedIndex = 0;
  document.getElementById('footprintComboBox').value = 'SOT-8';
  document.getElementById('quantitySpinBox').value = 0;
}

// ============================================================================
// BOM Analyzer Engine
// ============================================================================

function refreshBomAnalysis() {
  bomAnalysis = [];
  const boardsInput = document.getElementById('bomBoardsSpinBox');
  let boardsCount = parseInt(boardsInput.value, 10) || 1;
  if (boardsCount < 1) boardsCount = 1;

  let readyLines = 0;
  let shortageLines = 0;
  let maxBuildableBoards = bomItems.length === 0 ? 0 : Number.MAX_SAFE_INTEGER;

  for (const bomComp of bomItems) {
    const compCopy = { ...bomComp };
    const qtyPerBoard = Math.max(1, compCopy.quantity);
    const totalRequired = qtyPerBoard * boardsCount;

    const invIdx = searchComponentByMPN(componentList, compCopy.mpn);
    let availableInLab = 0;
    let labLocation = '';
    let shortage = 0;
    let statusText = '';

    if (invIdx !== -1) {
      const invComp = componentList[invIdx];
      availableInLab = invComp.quantity;
      labLocation = invComp.location;

      if (!compCopy.type) compCopy.type = invComp.type;
      if (!compCopy.value) compCopy.value = invComp.value;
      if (!compCopy.footprint) compCopy.footprint = invComp.footprint;

      const possibleBoardsForPart = Math.floor(availableInLab / qtyPerBoard);
      maxBuildableBoards = Math.min(maxBuildableBoards, possibleBoardsForPart);

      if (availableInLab >= totalRequired) {
        shortage = 0;
        statusText = 'READY';
        readyLines++;
      } else {
        shortage = totalRequired - availableInLab;
        statusText = availableInLab > 0 ? 'SHORTAGE' : 'OUT OF STOCK';
        shortageLines++;
      }
    } else {
      availableInLab = 0;
      shortage = totalRequired;
      labLocation = 'Not in Lab';
      statusText = 'MISSING IN LAB';
      maxBuildableBoards = 0;
      shortageLines++;
    }

    bomAnalysis.push({
      bomComponent: compCopy,
      totalRequired,
      availableInLab,
      shortage,
      labLocation,
      statusText
    });
  }

  if (maxBuildableBoards === Number.MAX_SAFE_INTEGER) {
    maxBuildableBoards = 0;
  }

  const displayBom = [...bomAnalysis];
  if (bomSortCol !== null) {
    displayBom.sort((a, b) => {
      let vA;
      let vB;
      switch (bomSortCol) {
        case 0:
          vA = a.bomComponent.mpn.toLowerCase();
          vB = b.bomComponent.mpn.toLowerCase();
          break;
        case 1:
          vA = a.bomComponent.type.toLowerCase();
          vB = b.bomComponent.type.toLowerCase();
          break;
        case 2:
          vA = a.bomComponent.value.toLowerCase();
          vB = b.bomComponent.value.toLowerCase();
          break;
        case 3:
          vA = a.bomComponent.footprint.toLowerCase();
          vB = b.bomComponent.footprint.toLowerCase();
          break;
        case 4:
          vA = a.bomComponent.customerCode.toLowerCase();
          vB = b.bomComponent.customerCode.toLowerCase();
          break;
        case 5:
          vA = a.bomComponent.quantity;
          vB = b.bomComponent.quantity;
          break;
        case 6:
          vA = a.totalRequired;
          vB = b.totalRequired;
          break;
        case 7:
          vA = a.availableInLab;
          vB = b.availableInLab;
          break;
        case 8:
          vA = a.shortage;
          vB = b.shortage;
          break;
        case 9:
          vA = a.labLocation.toLowerCase();
          vB = b.labLocation.toLowerCase();
          break;
        case 10:
          vA = a.statusText.toLowerCase();
          vB = b.statusText.toLowerCase();
          break;
        default:
          vA = '';
          vB = '';
      }
      if (vA < vB) return bomSortAsc ? -1 : 1;
      if (vA > vB) return bomSortAsc ? 1 : -1;
      return 0;
    });
  }

  const tbody = document.getElementById('bomTableBody');
  tbody.innerHTML = '';

  for (let i = 0; i < displayBom.length; i++) {
    const a = displayBom[i];
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${Math.min(i * 15, 180)}ms`;

    let statusColorClass = 'stock-err';
    if (a.statusText === 'READY') statusColorClass = 'stock-ok';
    else if (a.statusText === 'SHORTAGE') statusColorClass = 'stock-warn';

    const rowCells = [
      { text: a.bomComponent.mpn, className: 'cell-bold' },
      { text: a.bomComponent.type, isTypeChip: true },
      { text: a.bomComponent.value },
      { text: a.bomComponent.footprint },
      { text: a.bomComponent.customerCode },
      { text: String(a.bomComponent.quantity), className: 'cell-center' },
      { text: String(a.totalRequired), className: 'cell-center cell-bold' },
      { text: String(a.availableInLab), className: 'cell-center' },
      { text: String(a.shortage), className: 'cell-center', pillClass: statusColorClass },
      { text: a.labLocation },
      { text: a.statusText, className: 'cell-center', pillClass: statusColorClass }
    ];

    for (const c of rowCells) {
      const td = document.createElement('td');
      if (c.className) td.className = c.className;

      if (c.pillClass) {
        const badge = document.createElement('span');
        badge.className = `stock-pill ${c.pillClass}`;
        badge.textContent = c.text;
        td.appendChild(badge);
      } else if (c.isTypeChip) {
        const chip = document.createElement('span');
        chip.className = 'type-chip';
        chip.textContent = c.text || '—';
        td.appendChild(chip);
      } else {
        td.textContent = c.text;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  animateCounter(document.getElementById('bomSummaryTotalLabel'), bomAnalysis.length);
  animateCounter(document.getElementById('bomSummaryReadyLabel'), readyLines);
  animateCounter(document.getElementById('bomSummaryShortageLabel'), shortageLines);
  animateCounter(document.getElementById('bomSummaryMaxBuildsLabel'), maxBuildableBoards);

  const hasBom = bomAnalysis.length > 0;
  const saveBomBtn = document.getElementById('saveBomPushButton');
  const exportBtn = document.getElementById('exportBomReportPushButton');
  const assemblyListBtn = document.getElementById('exportAssemblyListPushButton');
  const deductBtn = document.getElementById('deductBomStockPushButton');
  const clearBtn = document.getElementById('clearBomPushButton');
  if (saveBomBtn) saveBomBtn.disabled = !hasBom;
  if (exportBtn) exportBtn.disabled = !hasBom;
  if (assemblyListBtn) assemblyListBtn.disabled = !hasBom;
  if (deductBtn) deductBtn.disabled = !hasBom;
  if (clearBtn) clearBtn.disabled = !hasBom;
}

// ============================================================================
// Event Handlers & Actions
// ============================================================================

function switchSubTab(targetSubTabId) {
  activeSubTab = targetSubTabId;
  document.querySelectorAll('.sub-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subTab === targetSubTabId);
  });
  document.querySelectorAll('.sub-tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === targetSubTabId);
  });
}

async function onAddPushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Adding components is disabled.');
    return;
  }
  const rawMpn = document.getElementById('MPNLineEdit').value.trim();
  const rawLoc = document.getElementById('locationLineEdit').value.trim();

  if (!rawMpn && !rawLoc) {
    await showAppDialog({
      type: 'error',
      title: 'Incomplete Information',
      message: 'Please enter both the Manufacturer Part Number (MPN) and Location of the component.'
    });
    return;
  } else if (!rawMpn) {
    await showAppDialog({
      type: 'error',
      title: 'Incomplete Information',
      message: 'Please enter the Manufacturer Part Number (MPN) of the component.'
    });
    return;
  } else if (!rawLoc) {
    await showAppDialog({
      type: 'error',
      title: 'Incomplete Information',
      message: 'Please enter the storage Location of the component in the lab.'
    });
    return;
  }

  const userMPN = rawMpn.replace(/[\s\n]+/g, '');
  const userLocation = rawLoc;
  const userType = document.getElementById('typeComboBox').value.trim();
  const userFootprint = document.getElementById('footprintComboBox').value.trim();
  const userValue = document.getElementById('addValueLineEdit').value.trim();
  const userCustomerCode = document.getElementById('addCustomerCodeLineEdit').value.trim();
  const userQuantity = Math.max(0, parseInt(document.getElementById('quantitySpinBox').value, 10) || 0);

  const existingIdx = searchComponentByMPN(componentList, userMPN);
  if (existingIdx === -1) {
    componentList.push(
      createComponent(userMPN, userQuantity, userType, userValue, userFootprint, userLocation, userCustomerCode)
    );
    logAuditRecord(
      'ADD',
      userMPN,
      `Added new part: Qty ${userQuantity}, Loc: '${userLocation}', Type: '${userType || 'N/A'}', Val: '${userValue || 'N/A'}'`
    );
    renderInventoryTable();
    refreshBomAnalysis();
    clearAddComponentForm();
    showToast(`Added ${userMPN} to inventory`);
  } else {
    const { response } = await showAppDialog({
      type: 'question',
      buttons: ['Yes', 'No'],
      defaultId: 0,
      cancelId: 1,
      title: 'Component Already Exists',
      message:
        `Component '${userMPN}' already exists in your inventory (Current Stock: ${componentList[existingIdx].quantity}).\n\n` +
        `Would you like to add +${userQuantity} to its existing stock quantity?`
    });

    if (response === 0 && userQuantity > 0) {
      const prevQty = componentList[existingIdx].quantity;
      componentList[existingIdx].quantity += userQuantity;
      logAuditRecord('EDIT', userMPN, `Incremented stock: ${prevQty} → ${componentList[existingIdx].quantity} (+${userQuantity})`);
      renderInventoryTable();
      refreshBomAnalysis();
      clearAddComponentForm();
      showToast(`Added +${userQuantity} stock to ${userMPN}`);
    }
  }
}

async function onCleanPushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canDeleteAll = isAdmin || (user && user.canDeleteAll);
  if (!canDeleteAll) {
    await showAppDialog({
      type: 'warning',
      title: 'Permission Denied',
      message: 'You do not have permission to delete all inventory data. Only Administrator accounts or users granted Delete All access can perform this action.'
    });
    return;
  }

  const { response } = await showAppDialog({
    type: 'clear',
    icon: 'clear',
    buttons: ['Clear All Data', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Clear All Inventory Data',
    message: 'Are you sure you want to permanently clear all components from the inventory table? This action cannot be undone.'
  });

  if (response === 0) {
    const clearedCount = componentList.length;
    componentList = [];
    resetEditTabState();
    renderInventoryTable();
    refreshBomAnalysis();

    const res = await window.electronAPI.saveDB(componentList);
    if (!res.ok) {
      await showAppDialog({
        type: 'error',
        title: 'Clear Sync Failed',
        message: res.error
      });
    } else {
      componentListOldSave = cloneComponentList(componentList);
      updateDashboardMetrics();
      logAuditRecord('CLEAR_ALL', 'ALL', `Cleared all inventory records (${clearedCount} parts)`);
      showToast('Cleared all inventory items');
    }
  }
}

async function onResetPushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Reverting database is disabled.');
    return;
  }
  const { response } = await showAppDialog({
    type: 'reset',
    icon: 'reset',
    buttons: ['Discard Changes', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Reset to Last Save',
    message: 'Do you want to discard unsaved changes and reload the last saved database state?'
  });

  if (response === 0) {
    const dbRes = await window.electronAPI.initAndLoadDB();
    if (!dbRes.ok) {
      await showAppDialog({
        type: 'error',
        title: 'Reset Failed',
        message: 'Could not load database: ' + dbRes.error
      });
      return;
    }

    componentList = (dbRes.list || []).map((c) =>
      createComponent(c.mpn, c.quantity, c.type || c.componentType, c.value, c.footprint, c.location, c.customerCode)
    );
    componentListOldSave = cloneComponentList(componentList);
    resetEditTabState();
    renderInventoryTable();
    refreshBomAnalysis();
    logAuditRecord('REVERT', 'ALL', `Reverted unsaved changes to last saved state (${componentList.length} components)`);
    showToast('Reverted to last saved database state');
  }
}

async function onSavePushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Saving changes is disabled.');
    return;
  }
  const { response } = await showAppDialog({
    type: 'save',
    icon: 'save',
    buttons: ['Save Database', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Save Inventory Table',
    message: 'Do you want to save all changes to the local inventory database?'
  });

  if (response === 0) {
    const res = await window.electronAPI.saveDB(componentList);
    if (res.ok) {
      componentListOldSave = cloneComponentList(componentList);
      updateDashboardMetrics();
      logAuditRecord('SAVE', 'DATABASE', `Saved ${componentList.length} components to local database`);
      showToast('Database saved successfully');
      syncDatabaseQuietly();
    } else {
      await showAppDialog({
        type: 'error',
        title: 'Save Failed',
        message: res.error
      });
    }
  }
}

async function onExportPushButtonClicked() {
  const res = await window.electronAPI.exportDBDialog({
    title: 'Export Inventory (Excel / CSV / DB)',
    defaultPath: 'My_Lab_Inventory.xlsx',
    components: componentList
  });
  if (res.canceled) return;
  if (res.ok) {
    showToast('Exported inventory file');
  } else {
    await showAppDialog({
      type: 'warning',
      title: 'Export Failed',
      message: res.error
    });
  }
}

async function onImportPushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Importing data is disabled.');
    return;
  }
  const res = await window.electronAPI.importDBDialog('Import Inventory Spreadsheet (Excel / CSV / DB)');
  if (res.canceled) return;
  if (!res.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'Import Failed',
      message: res.error
    });
    return;
  }

  const incomingList = (res.list || []).map((c) =>
    createComponent(c.mpn, c.quantity, c.type || c.componentType, c.value, c.footprint, c.location, c.customerCode)
  );

  if (incomingList.length === 0) {
    showToast('No valid component rows found in the selected file.');
    return;
  }

  // Identify duplicate MPNs with existing inventory
  const duplicateItems = [];
  const brandNewItems = [];

  for (const inc of incomingList) {
    const exists = componentList.some(
      (c) => normalizeString(c.mpn) === normalizeString(inc.mpn)
    );
    if (exists) {
      duplicateItems.push(inc);
    } else {
      brandNewItems.push(inc);
    }
  }

  let mode = 'merge'; // 'merge' (add quantity) or 'new_row' (store in new place)

  if (duplicateItems.length > 0) {
    const sampleDupes = duplicateItems.slice(0, 3).map((d) => d.mpn).join(', ');
    const moreText = duplicateItems.length > 3 ? ` and ${duplicateItems.length - 3} more` : '';

    const { response } = await showAppDialog({
      type: 'question',
      buttons: ['Add Quantity to Old One', 'Store in New Place (New Row)', 'Cancel Import'],
      defaultId: 0,
      cancelId: 2,
      title: 'Duplicate MPN Detected',
      message:
        `Found ${duplicateItems.length} component(s) whose MPN already exists in your inventory:\n` +
        `(${sampleDupes}${moreText})\n\n` +
        `How would you like to handle these components?\n\n` +
        `• "Add Quantity to Old One": Adds the imported quantity to the existing component's stock.\n` +
        `• "Store in New Place (New Row)": Keeps the old component unchanged and creates a new separate row (e.g. for a different cabinet / bin).\n` +
        `• "Cancel Import": Aborts without making any changes.`
    });

    if (response === 2 || response === undefined || response === -1) {
      return; // Cancelled
    }

    if (response === 0) {
      mode = 'merge';
    } else if (response === 1) {
      mode = 'new_row';
    }
  }

  let addedCount = 0;
  let mergedCount = 0;

  if (mode === 'merge') {
    for (const inc of duplicateItems) {
      const existingIdx = searchComponentByMPN(componentList, inc.mpn);
      if (existingIdx !== -1) {
        const target = componentList[existingIdx];
        target.quantity += inc.quantity;
        if (!target.value && inc.value) target.value = inc.value;
        if (!target.footprint && inc.footprint) target.footprint = inc.footprint;
        if (!target.location && inc.location) target.location = inc.location;
        if (!target.customerCode && inc.customerCode) target.customerCode = inc.customerCode;
        mergedCount++;
      } else {
        componentList.push(inc);
        addedCount++;
      }
    }
    for (const inc of brandNewItems) {
      componentList.push(inc);
      addedCount++;
    }
  } else {
    // mode === 'new_row': all incoming items (both brand new and duplicates) are stored as separate rows
    for (const inc of incomingList) {
      componentList.push(inc);
      addedCount++;
    }
  }

  renderInventoryTable();
  refreshBomAnalysis();

  const saveRes = await window.electronAPI.saveDB(componentList);
  if (!saveRes.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'Auto-Save Failed',
      message: saveRes.error
    });
  } else {
    componentListOldSave = cloneComponentList(componentList);
    updateDashboardMetrics();
    const summary = mode === 'merge'
      ? `Imported ${incomingList.length} rows (${addedCount} new, ${mergedCount} quantities added to existing) & saved to DB`
      : `Imported ${incomingList.length} rows as separate inventory rows & saved to DB`;
    logAuditRecord('IMPORT', 'BATCH', summary);
    showToast(summary);
    syncDatabaseQuietly();
  }
}

async function onSaveExamplePushButtonClicked() {
  const res = await window.electronAPI.saveTemplateDB();
  if (res.canceled) return;
  if (res.ok) {
    showToast('Saved inventory starter template (Excel / CSV)');
  } else {
    await showAppDialog({
      type: 'warning',
      title: 'Save Template Failed',
      message: res.error || 'Could not export template file.'
    });
  }
}

async function onFindPushButtonClicked() {
  const queryMPN = document.getElementById('searchMPNLineEdit').value.trim();
  if (!queryMPN) {
    await showAppDialog({
      type: 'warning',
      title: 'Component Search',
      message: 'Please enter a Manufacturer Part Number (MPN) to search.'
    });
    return;
  }

  const vecIdx = searchComponentByMPN(componentList, queryMPN);
  if (vecIdx !== -1) {
    const comp = componentList[vecIdx];
    selectedMPN = comp.mpn;
    populateInspectorForComponent(comp);
    highlightSelectedInventoryRow();
    showToast(`Found ${comp.mpn}`);
  } else {
    const { response } = await showAppDialog({
      type: 'question',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Component Not Found',
      message: `The MPN '${queryMPN}' is not in your inventory.\nWould you like to add it now?`
    });

    if (response === 0) {
      switchSubTab('addComponentTab');
      document.getElementById('MPNLineEdit').value = queryMPN;
      document.getElementById('locationLineEdit').focus();
      document.getElementById('searchMPNLineEdit').value = '';
      renderInventoryTable();
    }
  }
}

async function onEditComponentPushButtonClicked() {
  let targetMPN = selectedMPN;
  if (!targetMPN) {
    targetMPN = document.getElementById('searchMPNLineEdit').value.trim();
  }

  const vecIdx = searchComponentByMPN(componentList, targetMPN);
  if (vecIdx === -1) {
    await showAppDialog({
      type: 'info',
      title: 'Select a Component',
      message: 'Please find or click a component in the table first before editing.'
    });
    return;
  }

  selectedMPN = componentList[vecIdx].mpn;
  populateInspectorForComponent(componentList[vecIdx]);
  switchSubTab('EditComponentTab');

  document.getElementById('searchMPNLineEdit').value = '';
  renderInventoryTable();
}

async function onEditFindpushButtonClicked() {
  const queryMPN = document.getElementById('editMPNLineEdit').value.trim();
  if (!queryMPN) {
    await showAppDialog({
      type: 'warning',
      title: 'Component Search',
      message: 'Please enter a Manufacturer Part Number (MPN) to select.'
    });
    return;
  }

  const vecIdx = searchComponentByMPN(componentList, queryMPN);
  if (vecIdx !== -1) {
    selectedMPN = componentList[vecIdx].mpn;
    populateInspectorForComponent(componentList[vecIdx]);
    highlightSelectedInventoryRow();
  } else {
    const { response } = await showAppDialog({
      type: 'question',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Component Not Found',
      message: `The MPN '${queryMPN}' is not in your inventory.\nWould you like to add it now?`
    });

    if (response === 0) {
      switchSubTab('addComponentTab');
      document.getElementById('MPNLineEdit').value = queryMPN;
      document.getElementById('locationLineEdit').focus();
      resetEditTabState();
      renderInventoryTable();
    }
  }
}

function onApplyEditspushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Editing components is disabled.');
    return;
  }
  let targetIdx = searchComponentByMPN(componentList, selectedMPN);
  if (targetIdx === -1) {
    targetIdx = searchComponentByMPN(componentList, document.getElementById('editMPNLineEdit').value);
  }
  if (targetIdx === -1) return;

  const comp = componentList[targetIdx];
  const oldComp = { ...comp };

  comp.location = document.getElementById('editLocatioLineEdit').value.trim();
  comp.footprint = document.getElementById('editFootprintLineEdit').value.trim();
  comp.quantity = Math.max(0, parseInt(document.getElementById('editQuantitySpinBox').value, 10) || 0);
  comp.type = document.getElementById('editTypeComboBox').value.trim();
  comp.value = document.getElementById('editValueLineEdit').value.trim();
  comp.customerCode = document.getElementById('editCustomerCodeLineEdit').value.trim();

  // Compute diff summary for audit history
  const diffParts = [];
  if (oldComp.quantity !== comp.quantity) diffParts.push(`Qty: ${oldComp.quantity} → ${comp.quantity}`);
  if (oldComp.location !== comp.location) diffParts.push(`Loc: '${oldComp.location || 'N/A'}' → '${comp.location || 'N/A'}'`);
  if (oldComp.value !== comp.value) diffParts.push(`Val: '${oldComp.value || 'N/A'}' → '${comp.value || 'N/A'}'`);
  if (oldComp.footprint !== comp.footprint) diffParts.push(`FP: '${oldComp.footprint || 'N/A'}' → '${comp.footprint || 'N/A'}'`);
  if (oldComp.type !== comp.type) diffParts.push(`Type: '${oldComp.type || 'N/A'}' → '${comp.type || 'N/A'}'`);
  if (oldComp.customerCode !== comp.customerCode) diffParts.push(`Code: '${oldComp.customerCode || 'N/A'}' → '${comp.customerCode || 'N/A'}'`);

  const changeSummary = diffParts.length > 0 ? diffParts.join(' | ') : 'Updated component fields';
  logAuditRecord('EDIT', comp.mpn, changeSummary);

  renderInventoryTable();
  refreshBomAnalysis();
  resetEditTabState();
  showToast(`Saved edits for ${comp.mpn}`);
}

async function onDeleteComponentpushButtonClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Deleting components is disabled.');
    return;
  }
  let targetIdx = searchComponentByMPN(componentList, selectedMPN);
  if (targetIdx === -1) {
    targetIdx = searchComponentByMPN(componentList, document.getElementById('editMPNLineEdit').value);
  }
  if (targetIdx === -1) return;

  const targetMPN = componentList[targetIdx].mpn;
  const { response } = await showAppDialog({
    type: 'delete',
    icon: 'delete',
    buttons: ['Delete Component', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Delete Component',
    message: `Are you sure you want to delete component '${targetMPN}' from the inventory?`
  });

  if (response === 0) {
    const deletedPart = componentList[targetIdx];
    const details = `Deleted part (was Qty: ${deletedPart.quantity}, Loc: '${deletedPart.location || 'N/A'}')`;
    componentList.splice(targetIdx, 1);
    logAuditRecord('DELETE', targetMPN, details);
    renderInventoryTable();
    refreshBomAnalysis();
    resetEditTabState();
    showToast(`Deleted ${targetMPN}`);
  }
}

// ============================================================================
// BOM Actions
// ============================================================================

async function onImportBomPushButtonClicked() {
  const res = await window.electronAPI.importBomDialog('Import BOM (Excel / CSV / DB)');
  if (res.canceled) return;
  if (!res.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'BOM Import Failed',
      message: res.error
    });
    return;
  }

  const list = (res.list || []).map((c) =>
    createComponent(c.mpn, Math.max(1, c.quantity || 1), c.type || c.componentType, c.value, c.footprint, c.location, c.customerCode)
  );

  if (list.length === 0) {
    await showAppDialog({
      type: 'info',
      title: 'Empty BOM',
      message: 'No valid component rows were found in the selected BOM file.'
    });
    return;
  }

  bomItems = list;
  const boardInput = document.getElementById('BomBoardNamelineEdit');
  if (!boardInput.value.trim() && res.baseName) {
    boardInput.value = res.baseName;
  }
  refreshBomAnalysis();
  showToast(`Loaded BOM with ${bomItems.length} unique parts`);
}

async function onExportAssemblyListClicked() {
  if (bomAnalysis.length === 0) return;

  const boardName = document.getElementById('BomBoardNamelineEdit').value.trim() || 'Board_Assembly';
  const boardsCount = Math.max(1, parseInt(document.getElementById('bomBoardsSpinBox').value, 10) || 1);
  const safeBoard = boardName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const defaultFile = `${safeBoard}_Assembly_List_${boardsCount}boards.xlsx`;

  const res = await window.electronAPI.exportAssemblyList({
    defaultPath: defaultFile,
    boardName,
    boardsCount,
    analysisItems: bomAnalysis
  });

  if (res.canceled) return;
  if (res.ok) {
    showToast(`Exported Assembly Pick List for ${boardsCount}x '${boardName}' (Excel / CSV)`, 'success');
  } else {
    await showAppDialog({
      type: 'warning',
      title: 'Export Failed',
      message: res.error || 'Could not export assembly pick list.'
    });
  }
}

async function onExportBomReportClicked() {
  if (bomAnalysis.length === 0) return;

  const boardName = document.getElementById('BomBoardNamelineEdit').value.trim() || 'Board_BOM';
  const defaultFile = `${boardName}_Availability_Report.xlsx`;
  const boardsCount = Math.max(1, parseInt(document.getElementById('bomBoardsSpinBox').value, 10) || 1);

  const res = await window.electronAPI.exportBomReportDB({
    defaultPath: defaultFile,
    boardName,
    boardsCount,
    analysisItems: bomAnalysis
  });

  if (res.canceled) return;
  if (res.ok) {
    showToast('Exported BOM Availability Report (Excel / CSV)');
  } else {
    await showAppDialog({
      type: 'warning',
      title: 'Export Failed',
      message: res.error
    });
  }
}

async function onDeductBomStockClicked() {
  const user = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin');
  const canModify = isAdmin || !user || user.canModifyInventory;
  if (!canModify) {
    showToast('Explore Mode: Deducting inventory is disabled.');
    return;
  }
  if (bomAnalysis.length === 0) return;

  const boardsCount = Math.max(1, parseInt(document.getElementById('bomBoardsSpinBox').value, 10) || 1);
  const boardName = document.getElementById('BomBoardNamelineEdit').value.trim() || 'Unnamed Board';

  let shortageCount = 0;
  for (const item of bomAnalysis) {
    if (item.shortage > 0) shortageCount++;
  }

  let promptMsg;
  if (shortageCount > 0) {
    promptMsg =
      `Warning: ${shortageCount} BOM line(s) have insufficient stock for ${boardsCount}x '${boardName}'.\n\n` +
      `Do you want to proceed and deduct all available stock for this build (clamping insufficient items to 0)?`;
  } else {
    promptMsg =
      `All components are in stock to build ${boardsCount}x '${boardName}'!\n\n` +
      `Do you want to deduct the required BOM quantities from your Lab Inventory now?`;
  }

  const { response } = await showAppDialog({
    type: 'question',
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1,
    title: 'Confirm BOM Stock Deduction',
    message: promptMsg
  });

  if (response !== 0) return;

  let deductedParts = 0;
  let totalUnitsDeducted = 0;

  for (const item of bomAnalysis) {
    const invIdx = searchComponentByMPN(componentList, item.bomComponent.mpn);
    if (invIdx !== -1) {
      const invComp = componentList[invIdx];
      const currentQty = invComp.quantity;
      const deductQty = Math.min(currentQty, item.totalRequired);
      if (deductQty > 0) {
        invComp.quantity = currentQty - deductQty;
        deductedParts++;
        totalUnitsDeducted += deductQty;
      }
    }
  }

  renderInventoryTable();
  refreshBomAnalysis();
  logAuditRecord(
    'BOM_DEDUCT',
    boardName,
    `Deducted ${totalUnitsDeducted} units across ${deductedParts} parts for build of ${boardsCount}x '${boardName}'`
  );
  showToast(`Deducted ${totalUnitsDeducted} units across ${deductedParts} parts`);
}

function onClearBomClicked() {
  bomItems = [];
  document.getElementById('BomBoardNamelineEdit').value = '';
  document.getElementById('bomBoardsSpinBox').value = 1;
  refreshBomAnalysis();
  showToast('Cleared BOM table');
}

// ============================================================================
// Saved BOM Projects (Local SQLite & Online MySQL)
// ============================================================================

let savedBomsCache = [];

async function onSaveBomPushButtonClicked() {
  if (!bomItems || bomItems.length === 0) {
    showToast('No BOM loaded to save.');
    return;
  }

  const boardNameInput = document.getElementById('BomBoardNamelineEdit');
  let boardName = (boardNameInput ? boardNameInput.value : '').trim();
  const boardsCount = Math.max(1, parseInt(document.getElementById('bomBoardsSpinBox').value, 10) || 1);

  if (!boardName) {
    const defaultName = `Project_BOM_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const { response } = await showAppDialog({
      type: 'question',
      buttons: ['Save as ' + defaultName, 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Project Name Needed',
      message: 'Please provide a Board / Project Name before saving.\n\nWould you like to save with the default name: "' + defaultName + '"?'
    });
    if (response !== 0) return;
    boardName = defaultName;
    if (boardNameInput) boardNameInput.value = defaultName;
  }

  // Check if project already exists
  try {
    const listRes = await window.electronAPI.listSavedBoms();
    if (listRes.ok && Array.isArray(listRes.list)) {
      const exists = listRes.list.some(b => b.name && b.name.toLowerCase() === boardName.toLowerCase());
      if (exists) {
        const { response } = await showAppDialog({
          type: 'question',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Project Already Exists',
          message: `A BOM project named '${boardName}' already exists in the database.\n\nDo you want to overwrite it with current data (${bomItems.length} parts, ${boardsCount} boards)?`
        });
        if (response !== 0) return;
      }
    }
  } catch (err) {
    console.warn('Could not check existing BOMs:', err.message);
  }

  const res = await window.electronAPI.saveBomProject({
    name: boardName,
    boardsCount,
    items: bomItems
  });

  if (!res.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'Save Failed',
      message: res.error || 'Could not save BOM project.'
    });
    return;
  }

  if (res.syncedOnline) {
    showToast(`Saved '${boardName}' to local SQLite & online MySQL!`, 'success');
  } else {
    showToast(`Saved '${boardName}' to local SQLite database!`, 'success');
  }
}

function openSavedBomsModal() {
  const modal = document.getElementById('savedBomsModal');
  if (modal) {
    modal.classList.remove('hidden');
    loadAndRenderSavedBoms();
    const searchInput = document.getElementById('savedBomsSearchInput');
    if (searchInput) {
      searchInput.value = '';
      setTimeout(() => searchInput.focus(), 100);
    }
  }
}

function closeSavedBomsModal() {
  const modal = document.getElementById('savedBomsModal');
  if (modal) modal.classList.add('hidden');
}

async function loadAndRenderSavedBoms() {
  const container = document.getElementById('savedBomsListContainer');
  const emptyState = document.getElementById('savedBomsEmptyState');
  if (!container) return;

  container.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Loading projects...</div>';
  if (emptyState) emptyState.classList.add('hidden');

  const res = await window.electronAPI.listSavedBoms();
  if (!res.ok) {
    container.innerHTML = `<div style="padding: 24px; text-align: center; color: #EA4335;">Failed to load saved projects: ${res.error || 'Unknown error'}</div>`;
    return;
  }

  savedBomsCache = res.list || [];
  renderSavedBomsList();
}

function renderSavedBomsList() {
  const container = document.getElementById('savedBomsListContainer');
  const emptyState = document.getElementById('savedBomsEmptyState');
  if (!container) return;

  const searchInput = document.getElementById('savedBomsSearchInput');
  const filter = (searchInput ? searchInput.value : '').trim().toLowerCase();

  const filtered = savedBomsCache.filter(b => {
    if (!filter) return true;
    const nameMatch = (b.name || '').toLowerCase().includes(filter);
    const authorMatch = (b.createdBy || '').toLowerCase().includes(filter);
    return nameMatch || authorMatch;
  });

  container.innerHTML = '';

  if (filtered.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  filtered.forEach(b => {
    const card = document.createElement('div');
    card.className = 'saved-bom-card';

    const left = document.createElement('div');
    left.className = 'saved-bom-card-left';

    const nameEl = document.createElement('div');
    nameEl.className = 'saved-bom-card-name';
    nameEl.textContent = b.name || 'Untitled Board';

    const meta = document.createElement('div');
    meta.className = 'saved-bom-card-meta';

    const partsPill = document.createElement('span');
    partsPill.className = 'saved-bom-pill pill-parts';
    partsPill.textContent = `${b.itemsCount || 0} unique parts`;
    meta.appendChild(partsPill);

    const boardsPill = document.createElement('span');
    boardsPill.className = 'saved-bom-pill';
    boardsPill.textContent = `${b.boardsCount || 1} boards`;
    meta.appendChild(boardsPill);

    const authorPill = document.createElement('span');
    authorPill.className = 'saved-bom-pill';
    authorPill.textContent = `By ${b.createdBy || 'Admin'}`;
    meta.appendChild(authorPill);

    if (b.updatedAt) {
      const dateSpan = document.createElement('span');
      dateSpan.style.color = 'var(--text-muted)';
      dateSpan.style.fontSize = '11px';
      try {
        const d = new Date(b.updatedAt);
        dateSpan.textContent = `Updated: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } catch {
        dateSpan.textContent = `Updated: ${b.updatedAt}`;
      }
      meta.appendChild(dateSpan);
    }

    left.appendChild(nameEl);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'saved-bom-card-actions';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn-filled-primary ripple-btn saved-bom-btn-load';
    loadBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14"></path>
        <path d="M12 5l7 7-7 7"></path>
      </svg>
      <span>Load</span>
    `;
    loadBtn.title = `Load '${b.name}' into BOM Analyzer`;
    loadBtn.addEventListener('click', () => onLoadSavedBomProject(b.name));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-tonal-danger ripple-btn saved-bom-btn-del';
    delBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
      <span>Delete</span>
    `;
    delBtn.title = `Delete '${b.name}' from database`;
    delBtn.addEventListener('click', () => onDeleteSavedBomProject(b.name));

    actions.appendChild(loadBtn);
    actions.appendChild(delBtn);

    card.appendChild(left);
    card.appendChild(actions);

    container.appendChild(card);
  });
}

async function onLoadSavedBomProject(name) {
  const res = await window.electronAPI.loadSavedBomProject(name);
  if (!res.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'Load Failed',
      message: res.error || `Could not load BOM project '${name}'.`
    });
    return;
  }

  const list = (res.items || []).map((c) =>
    createComponent(c.mpn, Math.max(1, c.quantity || 1), c.componentType || c.type, c.value, c.footprint, '', c.customerCode)
  );

  bomItems = list;
  const boardInput = document.getElementById('BomBoardNamelineEdit');
  if (boardInput) boardInput.value = res.bom.name || name;

  const boardsInput = document.getElementById('bomBoardsSpinBox');
  if (boardsInput) boardsInput.value = res.bom.boardsCount || 1;

  refreshBomAnalysis();
  closeSavedBomsModal();
  showToast(`Loaded '${res.bom.name}' (${bomItems.length} parts)`, 'success');
}

async function onDeleteSavedBomProject(name) {
  const { response } = await showAppDialog({
    type: 'question',
    buttons: ['Delete Project', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete Saved BOM',
    message: `Are you sure you want to permanently delete the BOM project '${name}' from both local and online database?\n\nThis action cannot be undone.`
  });

  if (response !== 0) return;

  const res = await window.electronAPI.deleteSavedBomProject(name);
  if (!res.ok) {
    await showAppDialog({
      type: 'warning',
      title: 'Delete Failed',
      message: res.error || 'Could not delete BOM project.'
    });
    return;
  }

  showToast(`Deleted BOM project '${name}'`, 'info');
  loadAndRenderSavedBoms();
}

// ============================================================================
// Database & Remote MySQL Synchronization
// ============================================================================

let isSyncing = false;

async function refreshDatabaseStatus() {
  const dot = document.getElementById('dbStatusDot');
  const label = document.getElementById('dbStatusLabel');
  const modalDot = document.getElementById('modalStatusDot');
  const modalText = document.getElementById('modalStatusText');
  const modalLastSync = document.getElementById('modalLastSyncText');

  try {
    const status = await window.electronAPI.getMySQLStatus();

    if (modalLastSync) modalLastSync.textContent = `Last sync: ${status.lastSyncTime || 'Never'}`;

    if (!status.enabled) {
      if (dot) dot.className = 'db-status-dot dot-offline';
      if (label) label.textContent = 'Offline (Local)';
      if (modalDot) modalDot.className = 'db-status-dot dot-offline';
      if (modalText) modalText.textContent = 'Offline (Local SQLite Database)';
    } else if (status.online) {
      if (dot) dot.className = 'db-status-dot dot-online';
      if (label) label.textContent = 'Online (MySQL)';
      if (modalDot) modalDot.className = 'db-status-dot dot-online';
      if (modalText) modalText.textContent = `Connected to ${status.host} (${status.database})`;
    } else {
      if (dot) dot.className = 'db-status-dot dot-error';
      if (label) label.textContent = 'MySQL Offline';
      if (modalDot) modalDot.className = 'db-status-dot dot-error';
      if (modalText) modalText.textContent = `Offline (${status.message || 'Cannot reach MySQL'})`;
    }
  } catch (err) {
    if (dot) dot.className = 'db-status-dot dot-offline';
    if (label) label.textContent = 'Offline (Local)';
  }
}

function getSystemWindowsTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateSystemThemeBadge() {
  const badge = document.getElementById('themeSystemBadge');
  if (badge) {
    const sysTheme = getSystemWindowsTheme();
    badge.textContent = sysTheme === 'dark' ? 'Windows: Dark' : 'Windows: Light';
  }
}

function applyTheme(preference, notify = false) {
  themePreference = preference;
  try {
    localStorage.setItem('app_theme_preference', preference);
  } catch {}

  const sysTheme = getSystemWindowsTheme();
  let effectiveTheme = preference;
  if (preference === 'system') {
    effectiveTheme = sysTheme;
  }

  isDarkMode = (effectiveTheme === 'dark');

  // Update Body Theme Classes
  document.body.classList.toggle('dark-theme', isDarkMode);
  document.body.classList.toggle('light-theme', !isDarkMode);

  // Update Titlebar Quick Switch UI
  const themeSwitchText = document.getElementById('themeSwitchText');
  const themeSwitchBtn = document.getElementById('themeSwitchBtn');
  if (themeSwitchText) {
    themeSwitchText.textContent = isDarkMode ? 'Dark' : 'Light';
  }
  if (themeSwitchBtn) {
    themeSwitchBtn.setAttribute('aria-checked', String(!isDarkMode));
    themeSwitchBtn.title = `Switch Theme (Current: ${preference === 'system' ? 'Windows ' + sysTheme : preference})`;
  }

  // Update Settings Modal Radios
  const radioSystem = document.getElementById('themeRadioSystem');
  const radioDark = document.getElementById('themeRadioDark');
  const radioLight = document.getElementById('themeRadioLight');
  if (radioSystem) radioSystem.checked = (preference === 'system');
  if (radioDark) radioDark.checked = (preference === 'dark');
  if (radioLight) radioLight.checked = (preference === 'light');

  updateSystemThemeBadge();

  if (notify) {
    if (preference === 'system') {
      showToast(`Theme: System Default (${sysTheme === 'dark' ? 'Windows Dark' : 'Windows Light'})`);
    } else if (preference === 'dark') {
      showToast('Theme: Dark Mode');
    } else {
      showToast('Theme: Light Mode');
    }
  }
}

// ============================================================================
// Multi-Tab Application Settings System (Antigravity Modern Style)
// ============================================================================

let currentSettingsTab = 'account';
let activeUpdatePayload = null;
let latestDownloadedFilePath = null;

/**
 * Switches the active settings panel and updates the navigation sidebar.
 * @param {'account' | 'preferences' | 'database' | 'about'} tabKey
 */
function switchSettingsTab(tabKey) {
  const currentAuth = window.authController ? window.authController.getCurrentUser() : null;
  const isAdmin = Boolean(currentAuth && (currentAuth.role === 'admin' || String(currentAuth.username).toLowerCase() === 'admin'));
  const canManageDb = Boolean(currentAuth && (isAdmin || currentAuth.canManageDatabase));

  if (tabKey === 'database' && !canManageDb) {
    tabKey = 'account';
  }
  if (tabKey === 'permissions' && !isAdmin) {
    tabKey = 'account';
  }

  const tabs = ['account', 'preferences', 'database', 'about', 'permissions'];
  if (!tabs.includes(tabKey)) tabKey = 'account';
  currentSettingsTab = tabKey;

  tabs.forEach((key) => {
    const capitalized = key.charAt(0).toUpperCase() + key.slice(1);
    const btn = document.getElementById(`settingsTabBtn${capitalized}`);
    const panel = document.getElementById(`settingsPanel${capitalized}`);

    const isActive = (key === tabKey);
    if (btn) {
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('active', isActive);
    }
  });

  if (tabKey === 'permissions') {
    loadPermissionsPanel();
  }
}

/**
 * Applies role and permission rules across the application UI.
 */
function applyUserPermissions(user) {
  const isAdmin = Boolean(user && (user.role === 'admin' || String(user.username).toLowerCase() === 'admin'));
  const canDeleteAll = Boolean(user && (isAdmin || user.canDeleteAll));
  const canModify = Boolean(user && (isAdmin || user.canModifyInventory));
  const canManageDb = Boolean(user && (isAdmin || user.canManageDatabase));

  // 1. Settings tab for Permissions (Only for admin)
  const permBtn = document.getElementById('settingsTabBtnPermissions');
  if (permBtn) {
    permBtn.classList.toggle('hidden', !isAdmin);
    if (!isAdmin && currentSettingsTab === 'permissions') {
      switchSettingsTab('account');
    }
  }

  // 2. Settings tab for Database (Only for admin and users with canManageDatabase)
  const dbTabBtn = document.getElementById('settingsTabBtnDatabase');
  if (dbTabBtn) {
    dbTabBtn.classList.toggle('hidden', !canManageDb);
    if (!canManageDb && currentSettingsTab === 'database') {
      switchSettingsTab('account');
    }
  }

  // 3. Clear All Button
  const cleanBtn = document.getElementById('cleanPushButton');
  if (cleanBtn) {
    if (canDeleteAll) {
      cleanBtn.classList.remove('btn-disabled-perm');
      cleanBtn.title = 'Clear all inventory components';
    } else {
      cleanBtn.classList.add('btn-disabled-perm');
      cleanBtn.title = 'Clear All Data is restricted. Contact Administrator for access.';
    }
  }

  // 4. View-Only Pill in header
  const readOnlyPill = document.getElementById('readOnlyModeBanner');
  if (readOnlyPill) {
    readOnlyPill.classList.toggle('hidden', canModify);
  }

  // 5. Modifying action buttons
  const modifyBtnIds = [
    'importPushButton',
    'savePushButton',
    'resetPushButton',
    'addPushButton',
    'clearPushButton',
    'applyEditspushButton',
    'deleteComponentpushButton',
    'incStockPushButton',
    'decStockPushButton',
    'deductBomStockPushButton'
  ];

  modifyBtnIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      if (!canModify) {
        el.classList.add('btn-disabled-perm');
        el.title = 'Explore Mode: Inventory modification is disabled for your account.';
      } else {
        el.classList.remove('btn-disabled-perm');
        if (id === 'importPushButton') el.title = 'Import inventory components from Excel (.xlsx) or CSV file and save to database';
        else if (id === 'savePushButton') el.title = 'Save changes to local SQLite database (and sync to MySQL)';
        else if (id === 'resetPushButton') el.title = 'Discard unsaved changes and reload last saved database state';
      }
    }
  });

  // 6. Account role badge
  const roleBadge = document.getElementById('settingsAccountRoleBadge');
  if (roleBadge) {
    if (user) {
      if (isAdmin) {
        roleBadge.textContent = 'Administrator';
        roleBadge.className = 'account-status-badge badge-admin';
      } else if (canModify) {
        roleBadge.textContent = canDeleteAll ? 'Editor (Full Access)' : 'Editor';
        roleBadge.className = 'account-status-badge badge-active';
      } else {
        roleBadge.textContent = 'Viewer (Explore Only)';
        roleBadge.className = 'account-status-badge badge-readonly';
      }
    } else {
      roleBadge.textContent = 'Guest';
      roleBadge.className = 'account-status-badge badge-offline';
    }
  }
}

/**
 * Loads and renders registered users into the Admin User Permissions table.
 */
async function loadPermissionsPanel() {
  const tbody = document.getElementById('permissionsTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">Loading user permissions...</td></tr>';

  try {
    const res = await window.electronAPI.getAllUsers();
    if (!res.ok || !Array.isArray(res.users)) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--danger);">Failed to load users: ${escapeHtml(res.error || 'Unknown error')}</td></tr>`;
      return;
    }

    const currentAuth = window.authController ? window.authController.getCurrentUser() : null;
    const currentUsername = currentAuth ? currentAuth.username.toLowerCase() : '';

    if (res.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">No registered users found.</td></tr>';
      return;
    }

    tbody.innerHTML = res.users.map((u) => {
      const isRootAdmin = u.username.toLowerCase() === 'admin';
      const isMe = u.username.toLowerCase() === currentUsername;
      const isAdmin = u.role === 'admin' || isRootAdmin;
      const canDelete = isAdmin || Boolean(u.canDeleteAll);
      const canModify = isAdmin || Boolean(u.canModifyInventory);

      let accessBadgeHtml = '';
      if (isAdmin) {
        accessBadgeHtml = '<span class="badge-admin">Admin</span>';
      } else if (canModify && canDelete) {
        accessBadgeHtml = '<span class="badge-full">Full Access</span>';
      } else if (canModify) {
        accessBadgeHtml = '<span class="badge-editor">Editor</span>';
      } else {
        accessBadgeHtml = '<span class="badge-readonly">Explore Only</span>';
      }

      return `
        <tr data-username="${escapeHtml(u.username)}">
          <td>
            <strong>${escapeHtml(u.username)}</strong>
            ${isMe ? '<span style="font-size: 10px; opacity: 0.6; margin-left: 4px;">(You)</span>' : ''}
          </td>
          <td style="color: var(--text-muted); font-size: 12px;">${escapeHtml(u.email || '—')}</td>
          <td><span style="text-transform: capitalize;">${escapeHtml(u.role || 'user')}</span></td>
          <td style="text-align: center;">
            <label class="modern-switch" title="${isRootAdmin ? 'Root admin always has delete permission' : 'Toggle Delete All Data permission'}">
              <input type="checkbox" class="perm-delete-checkbox" ${canDelete ? 'checked' : ''} ${isRootAdmin ? 'disabled' : ''} data-user="${escapeHtml(u.username)}" />
              <span class="modern-switch-slider"></span>
            </label>
          </td>
          <td style="text-align: center;">
            <label class="modern-switch" title="${isRootAdmin ? 'Root admin always has modify permission' : 'Toggle Modify Inventory permission'}">
              <input type="checkbox" class="perm-modify-checkbox" ${canModify ? 'checked' : ''} ${isRootAdmin ? 'disabled' : ''} data-user="${escapeHtml(u.username)}" />
              <span class="modern-switch-slider"></span>
            </label>
          </td>
          <td class="perm-status-cell">${accessBadgeHtml}</td>
        </tr>
      `;
    }).join('');

    // Attach switch change listeners
    tbody.querySelectorAll('.perm-delete-checkbox, .perm-modify-checkbox').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const username = e.target.getAttribute('data-user');
        const tr = e.target.closest('tr');
        const deleteCb = tr.querySelector('.perm-delete-checkbox');
        const modifyCb = tr.querySelector('.perm-modify-checkbox');
        const statusCell = tr.querySelector('.perm-status-cell');

        const newDeleteAll = deleteCb.checked;
        const newModify = modifyCb.checked;

        try {
          const updateRes = await window.electronAPI.updateUserPermissions({
            targetUsername: username,
            permissions: {
              canDeleteAll: newDeleteAll,
              canModifyInventory: newModify
            }
          });

          if (!updateRes.ok) {
            showToast(`Error: ${updateRes.error || 'Failed to update permissions'}`);
            e.target.checked = !e.target.checked;
            return;
          }

          if (newModify && newDeleteAll) {
            statusCell.innerHTML = '<span class="badge-full">Full Access</span>';
          } else if (newModify) {
            statusCell.innerHTML = '<span class="badge-editor">Editor</span>';
          } else {
            statusCell.innerHTML = '<span class="badge-readonly">Explore Only</span>';
          }

          showToast(`Updated permissions for ${username}`);

          if (currentAuth && currentAuth.username.toLowerCase() === username.toLowerCase()) {
            currentAuth.canDeleteAll = newDeleteAll;
            currentAuth.canModifyInventory = newModify;
            applyUserPermissions(currentAuth);
          }
        } catch (err) {
          showToast(`Update error: ${err.message}`);
          e.target.checked = !e.target.checked;
        }
      });
    });

  } catch (err) {
    const errorMsg = (err && err.message) ? err.message : String(err);
    console.error('Failed to load user permissions:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--danger);">Error loading users: ${escapeHtml(errorMsg)}</td></tr>`;
  }
}

/**
 * Updates Account Tab information from session state.
 */
async function refreshAccountTab() {
  const usernameLabel = document.getElementById('settingsAccountUsername');
  const emailLabel = document.getElementById('settingsAccountEmail');
  const statusBadge = document.getElementById('settingsAccountStatusBadge');
  const lastLoginLabel = document.getElementById('settingsAccountLastLogin');
  const avatarInitials = document.getElementById('settingsAvatarInitials');

  let user = null;
  if (window.authController && typeof window.authController.getCurrentUser === 'function') {
    user = window.authController.getCurrentUser();
  }
  if (!user && window.electronAPI && window.electronAPI.getCurrentUser) {
    try {
      user = await window.electronAPI.getCurrentUser();
    } catch {}
  }

  if (user) {
    if (usernameLabel) usernameLabel.textContent = user.username;
    if (emailLabel) emailLabel.textContent = user.email || 'No email registered';
    if (statusBadge) {
      statusBadge.textContent = 'Active Session';
      statusBadge.className = 'account-status-badge badge-active';
    }
    if (avatarInitials) {
      avatarInitials.textContent = (user.username || 'U').charAt(0).toUpperCase();
    }
    if (lastLoginLabel) {
      const formattedLogin = (window.authController && typeof window.authController.formatAuditDate === 'function') ? window.authController.formatAuditDate(user.lastLogin) : user.lastLogin;
      lastLoginLabel.textContent = user.lastLogin ? ('Last login: ' + formattedLogin) : 'Current session';
    }
  } else {
    if (usernameLabel) usernameLabel.textContent = 'Guest / Anonymous';
    if (emailLabel) emailLabel.textContent = 'No account logged in';
    if (statusBadge) {
      statusBadge.textContent = 'Not Authenticated';
      statusBadge.className = 'account-status-badge badge-offline';
    }
    if (avatarInitials) avatarInitials.textContent = '?';
    if (lastLoginLabel) lastLoginLabel.textContent = 'Sign in or register to protect your data';
  }

  // Clear feedback boxes
  const emailFb = document.getElementById('changeEmailFeedback');
  if (emailFb) {
    emailFb.className = 'settings-feedback-box hidden';
    emailFb.textContent = '';
  }
  const passFb = document.getElementById('changePassFeedback');
  if (passFb) {
    passFb.className = 'settings-feedback-box hidden';
    passFb.textContent = '';
  }
}

/**
 * Updates Preferences Tab controls (theme tiles, windows startup, auto-login).
 */
async function refreshPreferencesTab() {
  // Sync Theme
  updateSystemThemeBadge();
  let currentPref = 'system';
  try {
    currentPref = localStorage.getItem('app_theme_preference') || 'system';
  } catch {}
  const radioSystem = document.getElementById('themeRadioSystem');
  const radioDark = document.getElementById('themeRadioDark');
  const radioLight = document.getElementById('themeRadioLight');
  if (radioSystem) radioSystem.checked = (currentPref === 'system');
  if (radioDark) radioDark.checked = (currentPref === 'dark');
  if (radioLight) radioLight.checked = (currentPref === 'light');

  // Sync Startup & Auto-login
  if (window.electronAPI) {
    if (window.electronAPI.getAutoStart) {
      try {
        const autoStart = await window.electronAPI.getAutoStart();
        const startupToggle = document.getElementById('launchAtStartupToggle');
        if (startupToggle) startupToggle.checked = Boolean(autoStart.openAtLogin);
      } catch (err) {
        console.warn('Failed to load auto start:', err);
      }
    }

    if (window.electronAPI.getAppSettings) {
      try {
        const settings = await window.electronAPI.getAppSettings();
        const autoLoginToggle = document.getElementById('autoLoginToggle');
        if (autoLoginToggle) autoLoginToggle.checked = Boolean(settings.autoLogin);
        const updatesToggle = document.getElementById('checkUpdatesStartupToggle');
        if (updatesToggle && settings.checkUpdatesOnStartup !== undefined) {
          updatesToggle.checked = Boolean(settings.checkUpdatesOnStartup);
        }
      } catch (err) {
        console.warn('Failed to load app settings:', err);
      }
    }
  }
}

/**
 * Updates About Tab info (version, runtime specs).
 */
async function refreshAboutTab() {
  if (window.electronAPI && window.electronAPI.getSystemInfo) {
    try {
      const info = await window.electronAPI.getSystemInfo();
      const badge = document.getElementById('aboutAppVersionBadge');
      if (badge && info.appVersion) badge.textContent = `v${info.appVersion}`;

      const chipsGrid = document.getElementById('systemInfoChipsGrid');
      if (chipsGrid) {
        chipsGrid.innerHTML = `
          <div class="runtime-chip"><span class="chip-label">App:</span><span class="chip-val">v${info.appVersion}</span></div>
          <div class="runtime-chip"><span class="chip-label">Electron:</span><span class="chip-val">v${info.electronVersion}</span></div>
          <div class="runtime-chip"><span class="chip-label">Chromium:</span><span class="chip-val">v${info.chromeVersion}</span></div>
          <div class="runtime-chip"><span class="chip-label">Node:</span><span class="chip-val">v${info.nodeVersion}</span></div>
          <div class="runtime-chip"><span class="chip-label">Platform:</span><span class="chip-val">${info.platform} (${info.arch})</span></div>
          <div class="runtime-chip"><span class="chip-label">Database:</span><span class="chip-val">SQLite 3 / MySQL</span></div>
        `;
      }
    } catch (err) {
      console.warn('Failed to load system info:', err);
    }
  }
}

/**
 * Opens the main multi-tab Application Settings modal.
 * @param {'account' | 'preferences' | 'database' | 'about'} [preferredTab='account']
 */
async function openSettingsModal(preferredTab = 'account') {
  const modal = document.getElementById('dbSettingsModal');
  if (!modal) return;

  const currentAuth = window.authController ? window.authController.getCurrentUser() : null;
  applyUserPermissions(currentAuth);

  const isAdmin = Boolean(currentAuth && (currentAuth.role === 'admin' || String(currentAuth.username).toLowerCase() === 'admin'));
  const canManageDb = Boolean(currentAuth && (isAdmin || currentAuth.canManageDatabase));

  if (preferredTab === 'database' && !canManageDb) {
    preferredTab = 'account';
  }

  switchSettingsTab(preferredTab);

  // Refresh active tab views
  await refreshAccountTab();
  await refreshPreferencesTab();
  await refreshAboutTab();

  // Load MySQL Configuration into Database Tab (only if authorized)
  if (canManageDb && window.electronAPI && window.electronAPI.getMySQLConfig) {
    try {
      const cfg = await window.electronAPI.getMySQLConfig();
      const syncToggle = document.getElementById('dbEnableSyncToggle');
      if (syncToggle) syncToggle.checked = Boolean(cfg.enabled);
      const hostInput = document.getElementById('dbHostInput');
      if (hostInput) hostInput.value = cfg.host || 'localhost';
      const portInput = document.getElementById('dbPortInput');
      if (portInput) portInput.value = cfg.port || 3306;
      const nameInput = document.getElementById('dbNameInput');
      if (nameInput) nameInput.value = cfg.database || 'lab_inventory_db';
      const userInput = document.getElementById('dbUserInput');
      if (userInput) userInput.value = cfg.user || 'root';
      const passInput = document.getElementById('dbPasswordInput');
      if (passInput) passInput.value = cfg.password || '';
    } catch (err) {
      console.warn('Failed to load MySQL config:', err);
    }
  }

  await refreshDatabaseStatus();
  modal.classList.remove('hidden');
}

/**
 * Alias for backward compatibility with database sync triggers
 */
function openDatabaseModal() {
  return openSettingsModal('database');
}

function closeDatabaseModal() {
  const modal = document.getElementById('dbSettingsModal');
  if (modal) modal.classList.add('hidden');
}

const EYE_OPEN_SVG = `<svg class="pass-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_CLOSED_SVG = `<svg class="pass-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"></path><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>`;

/**
 * Helper to wire up password eye show/hide toggle buttons
 */
function setupPasswordToggle(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;

  btn.innerHTML = EYE_OPEN_SVG;
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('title', 'Show password');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    btn.innerHTML = isPass ? EYE_CLOSED_SVG : EYE_OPEN_SVG;
    const label = isPass ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  });
}

/**
 * Handles Account Tab: Change Email Submission
 */
async function onChangeEmailSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const emailInput = document.getElementById('changeEmailInput');
  const passInput = document.getElementById('changeEmailPasswordInput');
  const fb = document.getElementById('changeEmailFeedback');
  const btn = document.getElementById('changeEmailSubmitBtn');

  const newEmail = (emailInput ? emailInput.value : '').trim();
  const currentPassword = passInput ? passInput.value : '';

  let user = window.authController ? window.authController.getCurrentUser() : null;
  if (!user && window.electronAPI && window.electronAPI.getCurrentUser) {
    user = await window.electronAPI.getCurrentUser();
  }
  if (!user) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'Error: Please sign into your account first to change email.';
    }
    return;
  }

  if (!newEmail || !newEmail.includes('@')) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'Error: Please enter a valid email address.';
    }
    if (emailInput) emailInput.focus();
    return;
  }

  if (!currentPassword) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'Error: Please enter your current password to confirm.';
    }
    if (passInput) passInput.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    const t = btn.querySelector('.btn-text');
    if (t) t.textContent = 'Updating...';
    else btn.textContent = 'Updating...';
  }

  try {
    const res = await window.electronAPI.updateUserEmail({
      username: user.username,
      newEmail,
      currentPassword
    });

    if (res.ok) {
      if (fb) {
        fb.className = 'simple-feedback-box feedback-success';
        fb.textContent = `Success: Email address updated to ${res.email}.`;
      }
      if (emailInput) emailInput.value = '';
      if (passInput) passInput.value = '';
      const emailLabel = document.getElementById('settingsAccountEmail');
      if (emailLabel) emailLabel.textContent = res.email;
      showToast('Email address updated successfully');
    } else {
      if (fb) {
        fb.className = 'simple-feedback-box feedback-error';
        fb.textContent = `Error: ${res.error || 'Failed to update email address.'}`;
      }
    }
  } catch (err) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = `Error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      const t = btn.querySelector('.btn-text');
      if (t) t.textContent = 'Update Email';
      else btn.textContent = 'Update Email';
    }
  }
}

/**
 * Handles Account Tab: Change Password Submission
 */
async function onChangePasswordSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const currentPassInput = document.getElementById('changePassCurrentInput');
  const newPassInput = document.getElementById('changePassNewInput');
  const confirmPassInput = document.getElementById('changePassConfirmInput');
  const fb = document.getElementById('changePassFeedback');
  const btn = document.getElementById('changePassSubmitBtn');

  const currentPassword = currentPassInput ? currentPassInput.value : '';
  const newPassword = newPassInput ? newPassInput.value : '';
  const confirmPassword = confirmPassInput ? confirmPassInput.value : '';

  let user = window.authController ? window.authController.getCurrentUser() : null;
  if (!user && window.electronAPI && window.electronAPI.getCurrentUser) {
    user = await window.electronAPI.getCurrentUser();
  }
  if (!user) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'Please sign into your account first to change password.';
    }
    return;
  }

  if (!currentPassword) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'Please enter your current password.';
    }
    if (currentPassInput) currentPassInput.focus();
    return;
  }

  if (!newPassword || newPassword.length < 4) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'New password must be at least 4 characters long.';
    }
    if (newPassInput) newPassInput.focus();
    return;
  }

  if (newPassword !== confirmPassword) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = 'New passwords do not match. Please re-type.';
    }
    if (confirmPassInput) confirmPassInput.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    const t = btn.querySelector('.btn-text');
    if (t) t.textContent = 'Updating...';
    else btn.textContent = 'Updating...';
  }

  try {
    const res = await window.electronAPI.updateUserPassword({
      username: user.username,
      currentPassword,
      newPassword
    });

    if (res.ok) {
      if (fb) {
        fb.className = 'simple-feedback-box feedback-success';
        fb.textContent = 'Success: Password changed successfully in database.';
      }
      if (currentPassInput) currentPassInput.value = '';
      if (newPassInput) newPassInput.value = '';
      if (confirmPassInput) confirmPassInput.value = '';
      showToast('Password updated successfully');
    } else {
      if (fb) {
        fb.className = 'simple-feedback-box feedback-error';
        fb.textContent = `Error: ${res.error || 'Failed to update password.'}`;
      }
    }
  } catch (err) {
    if (fb) {
      fb.className = 'simple-feedback-box feedback-error';
      fb.textContent = `Error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      const t = btn.querySelector('.btn-text');
      if (t) t.textContent = 'Change Password';
      else btn.textContent = 'Change Password';
    }
  }
}

/**
 * Handles checking GitHub repository releases for software updates
 */
async function onCheckForUpdates(simulate = false) {
  const btn = document.getElementById('checkForUpdatesBtn');
  const btnIcon = document.getElementById('updateBtnIcon');
  const btnText = document.getElementById('updateBtnText');
  const headline = document.getElementById('updateStatusHeadline');
  const subtext = document.getElementById('updateStatusSubtext');
  const lastChecked = document.getElementById('updateLastCheckedLabel');
  const iconWrapper = document.getElementById('updateStatusIconWrapper');
  const foundDetails = document.getElementById('updateFoundDetails');
  const dlBtn = document.getElementById('downloadUpdateBtn');

  if (btnIcon) btnIcon.classList.add('spinning');
  if (btnText) btnText.textContent = 'Checking...';
  if (btn) btn.disabled = true;

  try {
    const res = await window.electronAPI.checkForUpdates({ simulate });
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (lastChecked) lastChecked.textContent = `Last checked: Today at ${timeStr}`;

    if (!res.ok) {
      if (headline) headline.textContent = 'Update check failed';
      if (subtext) subtext.textContent = `Error: ${res.error || 'Failed to connect to GitHub releases.'}`;
      showToast('Failed to connect to GitHub releases');
      return;
    }

    activeUpdatePayload = res;

    if (res.hasUpdate) {
      if (headline) headline.textContent = `Update Available: v${res.latestVersion}`;
      if (subtext) subtext.textContent = `A newer release (${res.releaseName || 'v' + res.latestVersion}) is published on GitHub. (Installed: v${res.currentVersion})`;
      if (iconWrapper) iconWrapper.className = 'update-status-icon-wrapper icon-update';
      if (dlBtn) dlBtn.textContent = 'Download Update (.exe)';
      if (foundDetails) {
        foundDetails.classList.remove('hidden');
        const verTag = document.getElementById('updateFoundVersionTag');
        if (verTag) verTag.textContent = `v${res.latestVersion}`;
        const dateTag = document.getElementById('updateFoundDate');
        if (dateTag && res.publishedAt) {
          dateTag.textContent = ' • ' + new Date(res.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        const sizeTag = document.getElementById('updateFoundSize');
        if (sizeTag) sizeTag.textContent = res.assetSize ? ` • ${res.assetSize}` : '';
        const titleTag = document.getElementById('updateFoundTitle');
        if (titleTag) titleTag.textContent = res.releaseName || `Lab Inventory v${res.latestVersion}`;
        const changelog = document.getElementById('updateFoundChangelog');
        if (changelog) changelog.textContent = res.releaseNotes || 'No changelog provided.';
      }
      showToast(`New update available: v${res.latestVersion}`);
    } else if (res.isAhead) {
      if (headline) headline.textContent = `Up to Date (Installed: v${res.currentVersion})`;
      if (subtext) subtext.textContent = `Your installed version (v${res.currentVersion}) is ahead of the latest public GitHub release (v${res.latestVersion}).`;
      if (iconWrapper) iconWrapper.className = 'update-status-icon-wrapper icon-ok';
      if (dlBtn) dlBtn.textContent = `Download Release v${res.latestVersion} (.exe)`;
      if (foundDetails) {
        foundDetails.classList.remove('hidden');
        const verTag = document.getElementById('updateFoundVersionTag');
        if (verTag) verTag.textContent = `v${res.latestVersion}`;
        const dateTag = document.getElementById('updateFoundDate');
        if (dateTag && res.publishedAt) {
          dateTag.textContent = ' • ' + new Date(res.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        const sizeTag = document.getElementById('updateFoundSize');
        if (sizeTag) sizeTag.textContent = res.assetSize ? ` • ${res.assetSize}` : '';
        const titleTag = document.getElementById('updateFoundTitle');
        if (titleTag) titleTag.textContent = `Latest GitHub Release: ${res.releaseName || 'v' + res.latestVersion}`;
        const changelog = document.getElementById('updateFoundChangelog');
        if (changelog) changelog.textContent = res.releaseNotes || 'No changelog provided.';
      }
      showToast(`Installed v${res.currentVersion} is newer than GitHub release v${res.latestVersion}`);
    } else if (res.noReleases) {
      activeUpdatePayload = null;
      if (foundDetails) foundDetails.classList.add('hidden');
      if (iconWrapper) iconWrapper.className = 'update-status-icon-wrapper icon-ok';
      if (headline) headline.textContent = 'No Releases Published Yet';
      if (subtext) subtext.textContent = `Connected to repository AhmedAbo-Eita/Electronics_Lab_Inventory. Current build: v${res.currentVersion}.`;
      showToast('No GitHub releases found yet');
    } else {
      if (headline) headline.textContent = 'You are up to date!';
      if (subtext) subtext.textContent = `Installed version v${res.currentVersion} matches the latest release on GitHub (v${res.latestVersion}).`;
      if (iconWrapper) iconWrapper.className = 'update-status-icon-wrapper icon-ok';
      if (dlBtn) dlBtn.textContent = `Re-download Release v${res.latestVersion} (.exe)`;
      if (foundDetails) {
        foundDetails.classList.remove('hidden');
        const verTag = document.getElementById('updateFoundVersionTag');
        if (verTag) verTag.textContent = `v${res.latestVersion}`;
        const dateTag = document.getElementById('updateFoundDate');
        if (dateTag && res.publishedAt) {
          dateTag.textContent = ' • ' + new Date(res.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        const sizeTag = document.getElementById('updateFoundSize');
        if (sizeTag) sizeTag.textContent = res.assetSize ? ` • ${res.assetSize}` : '';
        const titleTag = document.getElementById('updateFoundTitle');
        if (titleTag) titleTag.textContent = res.releaseName || `Lab Inventory v${res.latestVersion}`;
        const changelog = document.getElementById('updateFoundChangelog');
        if (changelog) changelog.textContent = res.releaseNotes || 'No changelog provided.';
      }
      showToast('Application is up to date');
    }
  } catch (err) {
    if (headline) headline.textContent = 'Update check failed';
    if (subtext) subtext.textContent = `Error: ${err.message}`;
    showToast('Failed to connect to GitHub releases');
  } finally {
    if (btnIcon) btnIcon.classList.remove('spinning');
    if (btnText) btnText.textContent = 'Check for Updates';
    if (btn) btn.disabled = false;
  }
}

/**
 * Downloads the available update from GitHub releases with animated progress bar
 */
async function onDownloadUpdate() {
  if (!activeUpdatePayload || !activeUpdatePayload.downloadUrl) {
    showToast('No update download URL found');
    return;
  }

  const dlBtn = document.getElementById('downloadUpdateBtn');
  const progressWrapper = document.getElementById('updateDownloadProgressWrapper');
  const progressBar = document.getElementById('updateProgressBar');
  const progressPercent = document.getElementById('updateProgressPercent');
  const progressText = document.getElementById('updateProgressText');
  const openFileBtn = document.getElementById('openDownloadedFileBtn');

  if (progressWrapper) progressWrapper.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressText) progressText.textContent = 'Connecting to GitHub repository...';
  if (dlBtn) dlBtn.disabled = true;

  if (window.electronAPI && window.electronAPI.onUpdateDownloadProgress) {
    window.electronAPI.onUpdateDownloadProgress((p) => {
      if (progressBar) progressBar.style.width = `${p.percent}%`;
      if (progressPercent) progressPercent.textContent = `${p.percent}%`;
      if (progressText) {
        const mb = (p.transferred / (1024 * 1024)).toFixed(1);
        const totalMb = (p.total / (1024 * 1024)).toFixed(1);
        progressText.textContent = `Downloading installer: ${mb} MB / ${totalMb} MB (${p.percent}%)`;
      }
    });
  }

  try {
    const res = await window.electronAPI.downloadUpdate({
      downloadUrl: activeUpdatePayload.downloadUrl,
      assetName: activeUpdatePayload.assetName
    });

    if (res.ok) {
      latestDownloadedFilePath = res.filePath;
      if (progressText) progressText.textContent = `Success: Download complete. Saved to Downloads: ${res.fileName}`;
      if (progressBar) progressBar.style.width = '100%';
      if (progressPercent) progressPercent.textContent = '100%';
      if (openFileBtn) openFileBtn.classList.remove('hidden');
      showToast(`Installer downloaded: ${res.fileName}`);
    } else {
      if (progressText) progressText.textContent = `Error: Download failed - ${res.error}`;
      showToast('Download error: ' + res.error);
    }
  } catch (err) {
    if (progressText) progressText.textContent = `Error: ${err.message}`;
    showToast('Download failed');
  } finally {
    if (dlBtn) dlBtn.disabled = false;
  }
}

/**
 * Checks for updates quietly in background on launch if user has auto-check enabled
 */
async function checkUpdatesQuietlyOnStartup() {
  if (!window.electronAPI || !window.electronAPI.getAppSettings || !window.electronAPI.checkForUpdates) return;
  try {
    const settings = await window.electronAPI.getAppSettings();
    if (settings && settings.checkUpdatesOnStartup) {
      const res = await window.electronAPI.checkForUpdates();
      if (res && res.hasUpdate) {
        showToast(`Update Available: Lab Inventory v${res.latestVersion}. Open Settings to install.`);
        const openSettingsBtn = document.getElementById('openSettingsBtn');
        if (openSettingsBtn) {
          openSettingsBtn.classList.add('has-update-indicator');
        }
      }
    }
  } catch (err) {
    console.warn('Quiet update check skipped:', err.message);
  }
}

function getDatabaseFormValues() {
  return {
    enabled: document.getElementById('dbEnableSyncToggle').checked,
    host: document.getElementById('dbHostInput').value.trim() || 'localhost',
    port: parseInt(document.getElementById('dbPortInput').value, 10) || 3306,
    database: document.getElementById('dbNameInput').value.trim() || 'lab_inventory_db',
    user: document.getElementById('dbUserInput').value.trim() || 'root',
    password: document.getElementById('dbPasswordInput').value
  };
}

async function onTestDatabaseConnection() {
  const feedback = document.getElementById('dbTestFeedback');
  const btn = document.getElementById('dbTestBtn');
  btn.disabled = true;
  btn.textContent = 'Testing...';

  feedback.className = 'db-feedback-box hidden';
  const cfg = getDatabaseFormValues();

  const res = await window.electronAPI.testMySQLConnection(cfg);
  btn.disabled = false;
  btn.textContent = 'Test Connection';

  feedback.classList.remove('hidden');
  if (res.online) {
    feedback.className = 'db-feedback-box feedback-success';
    feedback.textContent = 'Success: ' + (res.message || 'Connected successfully to MySQL server.');
  } else {
    feedback.className = 'db-feedback-box feedback-error';
    feedback.textContent = 'Error: ' + (res.message || 'Connection failed. Check host, port, credentials, and firewall.');
  }
}

async function onSaveDatabaseSettings() {
  const btn = document.getElementById('dbSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const cfg = getDatabaseFormValues();
  await window.electronAPI.saveMySQLConfig(cfg);

  btn.disabled = false;
  btn.textContent = 'Save & Connect';

  await refreshDatabaseStatus();
  showToast(cfg.enabled ? 'Saved MySQL configuration' : 'MySQL disabled (Working offline)');

  if (cfg.enabled) {
    syncDatabaseWithUI();
  }
}

async function syncDatabaseWithUI(mode = 'merge') {
  if (isSyncing) return;
  isSyncing = true;

  const dot = document.getElementById('dbStatusDot');
  const modalDot = document.getElementById('modalStatusDot');
  const syncBtn = document.getElementById('dbSyncBtn');
  const pushBtn = document.getElementById('dbPushOverwriteBtn');
  const pullBtn = document.getElementById('dbPullOverwriteBtn');

  if (dot) dot.className = 'db-status-dot dot-syncing';
  if (modalDot) modalDot.className = 'db-status-dot dot-syncing';
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
  }
  if (pushBtn) pushBtn.disabled = true;
  if (pullBtn) pullBtn.disabled = true;

  try {
    const res = await window.electronAPI.syncMySQLNow(componentList, mode);
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now (Merge)';
    }
    if (pushBtn) pushBtn.disabled = false;
    if (pullBtn) pullBtn.disabled = false;

    if (res.ok) {
      if (res.mergedComponents && res.mergedComponents.length) {
        componentList = res.mergedComponents;
        componentListOldSave = cloneComponentList(componentList);
        renderInventoryTable();
        updateDashboardMetrics();
        refreshBomAnalysis();
        // Also update local SQLite database with fresh merged data
        await window.electronAPI.saveDB(componentList);
      }
      showToast(res.message, 'success');
    } else {
      showToast(res.message, 'error');
    }
  } catch (err) {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now (Merge)';
    }
    if (pushBtn) pushBtn.disabled = false;
    if (pullBtn) pullBtn.disabled = false;
    showToast('Sync error: ' + err.message, 'error');
  } finally {
    isSyncing = false;
    await refreshDatabaseStatus();
  }
}

async function syncDatabaseQuietly() {
  try {
    const status = await window.electronAPI.getMySQLStatus();
    if (status.enabled && status.online) {
      const res = await window.electronAPI.syncMySQLNow(componentList);
      if (res.ok && res.mergedComponents && res.mergedComponents.length > componentList.length) {
        componentList = res.mergedComponents;
        componentListOldSave = cloneComponentList(componentList);
        renderInventoryTable();
        updateDashboardMetrics();
      }
      await refreshDatabaseStatus();
    }
  } catch {}
}

// ============================================================================
// Initialization & Event Wiring
// ============================================================================

function updateSortHeaders(selector, activeCol, isAsc) {
  document.querySelectorAll(selector).forEach((th) => {
    const col = parseInt(th.dataset.col ?? th.dataset.bomCol, 10);
    const ind = th.querySelector('.sort-indicator');
    if (!ind) return;
    if (col === activeCol) {
      ind.textContent = isAsc ? '▲' : '▼';
    } else {
      ind.textContent = '';
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  attachMaterialRipples();

  const splashScreen = document.getElementById('appSplashScreen');
  const splashStatusText = document.getElementById('splashStatusText');

  const hideSplashScreen = () => {
    if (splashScreen && !splashScreen.classList.contains('splash-hidden')) {
      splashScreen.classList.add('splash-hidden');
      setTimeout(() => {
        splashScreen.remove();
      }, 550);
    }
  };

  // 1. Load database on startup
  const dbRes = await window.electronAPI.initAndLoadDB();
  if (!dbRes.ok) {
    if (splashStatusText) splashStatusText.textContent = 'Error loading database';
    hideSplashScreen();
    await showAppDialog({
      type: 'warning',
      title: 'Database Verification Error',
      message: dbRes.error || 'Could not initialize database.'
    });
  } else {
    componentList = (dbRes.list || []).map((c) =>
      createComponent(c.mpn, c.quantity, c.type || c.componentType, c.value, c.footprint, c.location, c.customerCode)
    );
    if (splashStatusText) splashStatusText.textContent = 'Ready!';
    // Smooth visual transition
    setTimeout(hideSplashScreen, 300);
  }

  componentListOldSave = cloneComponentList(componentList);
  renderInventoryTable();
  refreshBomAnalysis();

  // 2. Main Tab Switching
  document.querySelectorAll('[data-main-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.mainTab;
      document.querySelectorAll('[data-main-tab]').forEach((b) =>
        b.classList.toggle('active', b.dataset.mainTab === target)
      );
      document.querySelectorAll('.main-tab-container > .tab-pane').forEach((p) =>
        p.classList.toggle('active', p.id === target)
      );
    });
  });

  // 3. Interactive KPI Cards (Click to filter or save!)
  document.getElementById('statCardParts').addEventListener('click', () => {
    document.getElementById('stockFilterComboBox').selectedIndex = 0;
    document.getElementById('typeFilterComboBox').selectedIndex = 0;
    document.getElementById('quickFilterLineEdit').value = '';
    document.getElementById('quickFilterClearX').classList.add('hidden');
    renderInventoryTable();
    showToast('Showing all components');
  });

  document.getElementById('statCardUnits').addEventListener('click', () => {
    document.getElementById('stockFilterComboBox').selectedIndex = 1; // In Stock (> 0)
    renderInventoryTable();
    showToast('Filtered: In Stock (> 0)');
  });

  document.getElementById('statCardLowStock').addEventListener('click', () => {
    const stockCombo = document.getElementById('stockFilterComboBox');
    stockCombo.selectedIndex = stockCombo.selectedIndex === 3 ? 4 : 3; // Toggle Low Stock / Out of Stock
    renderInventoryTable();
    showToast(`Filtered: ${stockCombo.value}`);
  });

  document.getElementById('statCardSync').addEventListener('click', () => {
    onSavePushButtonClicked();
  });

  // 4. Sub-Tab Switching
  document.querySelectorAll('[data-sub-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchSubTab(btn.dataset.subTab);
    });
  });

  // 5. Theme & Appearance Management (System Auto-detect Windows mode or Manual)
  let savedTheme = 'system';
  try {
    savedTheme = localStorage.getItem('app_theme_preference') || 'system';
  } catch {}
  applyTheme(savedTheme, false);

  // Watch dynamically for Windows OS theme changes
  if (window.matchMedia) {
    const osSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleOSChange = () => {
      updateSystemThemeBadge();
      let cur = 'system';
      try {
        cur = localStorage.getItem('app_theme_preference') || 'system';
      } catch {}
      if (cur === 'system') {
        applyTheme('system', true);
      }
    };
    if (osSchemeQuery.addEventListener) {
      osSchemeQuery.addEventListener('change', handleOSChange);
    } else if (osSchemeQuery.addListener) {
      osSchemeQuery.addListener(handleOSChange);
    }
  }

  // Radio button listeners in Settings Dialog
  ['themeRadioSystem', 'themeRadioDark', 'themeRadioLight'].forEach((radioId) => {
    const radio = document.getElementById(radioId);
    if (radio) {
      radio.addEventListener('change', (e) => {
        if (e.target.checked) {
          applyTheme(e.target.value, true);
        }
      });
    }
  });

  // Quick switch toggle on Titlebar
  const themeSwitchBtn = document.getElementById('themeSwitchBtn');
  if (themeSwitchBtn) {
    themeSwitchBtn.addEventListener('click', () => {
      const nextTheme = isDarkMode ? 'light' : 'dark';
      applyTheme(nextTheme, true);
    });
  }

  // 5.1 In-App Window Controls (Spotify-Style Top Titlebar)
  const winMinBtn = document.getElementById('winMinBtn');
  const winMaxBtn = document.getElementById('winMaxBtn');
  const winCloseBtn = document.getElementById('winCloseBtn');
  const winMaxIcon = document.getElementById('winMaxIcon');
  const winRestoreIcon = document.getElementById('winRestoreIcon');

  const updateMaximizeUI = (isMaximized) => {
    if (winMaxIcon && winRestoreIcon) {
      winMaxIcon.classList.toggle('hidden', isMaximized);
      winRestoreIcon.classList.toggle('hidden', !isMaximized);
    }
    if (winMaxBtn) {
      winMaxBtn.title = isMaximized ? 'Restore Down' : 'Maximize Window';
    }
    document.body.classList.toggle('window-maximized', isMaximized);
  };

  if (winMinBtn) {
    winMinBtn.addEventListener('click', () => {
      window.electronAPI.minimizeWindow();
    });
  }

  if (winMaxBtn) {
    winMaxBtn.addEventListener('click', async () => {
      const isMax = await window.electronAPI.toggleMaximizeWindow();
      updateMaximizeUI(isMax);
    });
  }

  if (winCloseBtn) {
    winCloseBtn.addEventListener('click', async () => {
      if (!areComponentListsEqual(componentListOldSave, componentList)) {
        const { response } = await showAppDialog({
          type: 'save',
          icon: 'save',
          buttons: ['Save & Close', "Don't Save", 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          title: 'Unsaved Changes',
          message: 'You have unsaved changes in your inventory. Do you want to save before closing?'
        });

        if (response === 0) {
          const res = await window.electronAPI.saveDB(componentList);
          if (res.ok) {
            componentListOldSave = cloneComponentList(componentList);
            await window.electronAPI.confirmForceClose();
          } else {
            await showAppDialog({
              type: 'warning',
              title: 'Save Failed',
              message: 'Could not save changes: ' + (res.error || 'Unknown error')
            });
          }
        } else if (response === 1) {
          await window.electronAPI.confirmForceClose();
        }
        return;
      }
      window.electronAPI.closeWindow();
    });
  }

  // Double-click top titlebar or header to maximize/restore (Spotify & Windows desktop standard)
  const topTitleBar = document.getElementById('topTitleBar');
  if (topTitleBar) {
    topTitleBar.addEventListener('dblclick', async (e) => {
      if (e.target.closest('button, input, select, .theme-switch-wrapper')) return;
      const isMax = await window.electronAPI.toggleMaximizeWindow();
      updateMaximizeUI(isMax);
    });
  }

  const topHeaderBar = document.querySelector('.top-header-bar');
  if (topHeaderBar) {
    topHeaderBar.addEventListener('dblclick', async (e) => {
      if (e.target.closest('button, input, select, .interactive-card, .logo-wrap')) return;
      const isMax = await window.electronAPI.toggleMaximizeWindow();
      updateMaximizeUI(isMax);
    });
  }

  if (window.electronAPI.isWindowMaximized) {
    window.electronAPI.isWindowMaximized().then(updateMaximizeUI);
  }
  if (window.electronAPI.onWindowStateChange) {
    window.electronAPI.onWindowStateChange(updateMaximizeUI);
  }

  // 6. Quick Filter Bar
  const quickFilterInput = document.getElementById('quickFilterLineEdit');
  const quickFilterClearX = document.getElementById('quickFilterClearX');

  quickFilterInput.addEventListener('input', () => {
    quickFilterClearX.classList.toggle('hidden', !quickFilterInput.value);
    renderInventoryTable();
  });

  quickFilterClearX.addEventListener('click', () => {
    quickFilterInput.value = '';
    quickFilterClearX.classList.add('hidden');
    renderInventoryTable();
  });

  document.getElementById('typeFilterComboBox').addEventListener('change', () => renderInventoryTable());
  document.getElementById('stockFilterComboBox').addEventListener('change', () => renderInventoryTable());

  document.getElementById('clearFilterPushButton').addEventListener('click', () => {
    quickFilterInput.value = '';
    quickFilterClearX.classList.add('hidden');
    document.getElementById('typeFilterComboBox').selectedIndex = 0;
    document.getElementById('stockFilterComboBox').selectedIndex = 0;
    renderInventoryTable();
    showToast('Filters reset');
  });

  // 7. Toolbar Buttons
  document.getElementById('importPushButton').addEventListener('click', onImportPushButtonClicked);
  document.getElementById('exportPushButton').addEventListener('click', onExportPushButtonClicked);
  document.getElementById('savePushButton').addEventListener('click', onSavePushButtonClicked);
  document.getElementById('cleanPushButton').addEventListener('click', onCleanPushButtonClicked);
  document.getElementById('resetPushButton').addEventListener('click', onResetPushButtonClicked);
  document.getElementById('saveExamplePushButton').addEventListener('click', onSaveExamplePushButtonClicked);

  // 8. Add Component Tab
  document.getElementById('addPushButton').addEventListener('click', onAddPushButtonClicked);
  document.getElementById('clearPushButton').addEventListener('click', clearAddComponentForm);

  // 9. Edit Component Tab
  document.getElementById('editFindpushButton').addEventListener('click', onEditFindpushButtonClicked);
  document.getElementById('editClearSearchpushButton').addEventListener('click', () => {
    resetEditTabState();
    renderInventoryTable();
  });
  document.getElementById('applyEditspushButton').addEventListener('click', onApplyEditspushButtonClicked);
  document.getElementById('deleteComponentpushButton').addEventListener('click', onDeleteComponentpushButtonClicked);

  document.getElementById('incStockPushButton').addEventListener('click', () => {
    const spin = document.getElementById('editQuantitySpinBox');
    spin.value = (parseInt(spin.value, 10) || 0) + 1;
  });
  document.getElementById('decStockPushButton').addEventListener('click', () => {
    const spin = document.getElementById('editQuantitySpinBox');
    const cur = parseInt(spin.value, 10) || 0;
    if (cur > 0) spin.value = cur - 1;
  });

  document.getElementById('editMPNLineEdit').addEventListener('input', (e) => {
    if (!e.target.disabled) {
      renderInventoryTable(e.target.value);
    }
  });

  // 10. Search Component Tab
  document.getElementById('findPushButton').addEventListener('click', onFindPushButtonClicked);
  document.getElementById('EditComponentPushButton').addEventListener('click', onEditComponentPushButtonClicked);
  document.getElementById('searchMPNLineEdit').addEventListener('input', (e) => {
    renderInventoryTable(e.target.value);
  });

  // 11. BOM Manager Tab
  document.getElementById('ImportBomPushButton').addEventListener('click', onImportBomPushButtonClicked);
  const saveBomBtn = document.getElementById('saveBomPushButton');
  if (saveBomBtn) {
    saveBomBtn.addEventListener('click', onSaveBomPushButtonClicked);
  }
  const openSavedBomsBtn = document.getElementById('openSavedBomsPushButton');
  if (openSavedBomsBtn) {
    openSavedBomsBtn.addEventListener('click', openSavedBomsModal);
  }
  const closeSavedBomsBtn = document.getElementById('savedBomsModalCloseBtn');
  if (closeSavedBomsBtn) {
    closeSavedBomsBtn.addEventListener('click', closeSavedBomsModal);
  }
  const savedBomsModalEl = document.getElementById('savedBomsModal');
  if (savedBomsModalEl) {
    savedBomsModalEl.addEventListener('click', (e) => {
      if (e.target === savedBomsModalEl) closeSavedBomsModal();
    });
  }
  const refreshSavedBomsBtn = document.getElementById('refreshSavedBomsBtn');
  if (refreshSavedBomsBtn) {
    refreshSavedBomsBtn.addEventListener('click', loadAndRenderSavedBoms);
  }
  const savedBomsSearchInput = document.getElementById('savedBomsSearchInput');
  if (savedBomsSearchInput) {
    savedBomsSearchInput.addEventListener('input', renderSavedBomsList);
  }
  const assemblyListBtn = document.getElementById('exportAssemblyListPushButton');
  if (assemblyListBtn) {
    assemblyListBtn.addEventListener('click', onExportAssemblyListClicked);
  }
  document.getElementById('exportBomReportPushButton').addEventListener('click', onExportBomReportClicked);
  document.getElementById('deductBomStockPushButton').addEventListener('click', onDeductBomStockClicked);
  document.getElementById('clearBomPushButton').addEventListener('click', onClearBomClicked);
  document.getElementById('bomBoardsSpinBox').addEventListener('input', refreshBomAnalysis);

  // 12. Table Column Sorting
  document.querySelectorAll('#inventoryTableWidget thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = parseInt(th.dataset.col, 10);
      if (invSortCol === col) {
        invSortAsc = !invSortAsc;
      } else {
        invSortCol = col;
        invSortAsc = true;
      }
      updateSortHeaders('#inventoryTableWidget thead th', invSortCol, invSortAsc);
      renderInventoryTable();
    });
  });

  document.querySelectorAll('#BomTableWidget thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const col = parseInt(th.dataset.bomCol, 10);
      if (bomSortCol === col) {
        bomSortAsc = !bomSortAsc;
      } else {
        bomSortCol = col;
        bomSortAsc = true;
      }
      updateSortHeaders('#BomTableWidget thead th', bomSortCol, bomSortAsc);
      refreshBomAnalysis();
    });
  });

  // 13. Settings & Multi-Tab Configuration Listeners
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => openSettingsModal('account'));
  }
  const dbStatusPill = document.getElementById('dbStatusPill');
  if (dbStatusPill) {
    dbStatusPill.addEventListener('click', () => openSettingsModal('database'));
  }

  // Sidebar Tab Switchers
  ['account', 'preferences', 'database', 'about', 'permissions'].forEach((tabKey) => {
    const capitalized = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
    const btn = document.getElementById(`settingsTabBtn${capitalized}`);
    if (btn) {
      btn.addEventListener('click', () => switchSettingsTab(tabKey));
    }
  });

  const refreshPermsBtn = document.getElementById('refreshPermissionsBtn');
  if (refreshPermsBtn) {
    refreshPermsBtn.addEventListener('click', loadPermissionsPanel);
  }

  // Hook into auth state changes
  window.onAuthStateChanged = (authUser) => {
    applyUserPermissions(authUser);
    refreshAccountTab();
  };

  // Immediate permissions application on DOM ready
  const currentInitialUser = window.authController ? window.authController.getCurrentUser() : null;
  applyUserPermissions(currentInitialUser);

  // Mismatch Resolution Listeners
  const pushOverwriteBtn = document.getElementById('dbPushOverwriteBtn');
  if (pushOverwriteBtn) {
    pushOverwriteBtn.addEventListener('click', async () => {
      let proceed = false;
      if (typeof window.showAppDialog === 'function') {
        const { response } = await window.showAppDialog({
          type: 'warning',
          icon: 'warning',
          buttons: ['Overwrite Cloud', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Overwrite Online Database?',
          message: 'Are you sure you want to replace all components in the online MySQL database with your local inventory? Any components that exist only online will be removed from active inventory.'
        });
        proceed = (response === 0);
      } else {
        proceed = confirm('Overwrite online MySQL database with your local inventory?');
      }
      if (proceed) {
        syncDatabaseWithUI('push');
      }
    });
  }

  const pullOverwriteBtn = document.getElementById('dbPullOverwriteBtn');
  if (pullOverwriteBtn) {
    pullOverwriteBtn.addEventListener('click', async () => {
      let proceed = false;
      if (typeof window.showAppDialog === 'function') {
        const { response } = await window.showAppDialog({
          type: 'warning',
          icon: 'warning',
          buttons: ['Overwrite Local', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Overwrite Local Inventory?',
          message: 'Are you sure you want to replace your local inventory with the components currently in the online MySQL database? Any local components not yet synced to online will be replaced.'
        });
        proceed = (response === 0);
      } else {
        proceed = confirm('Overwrite local inventory with the online MySQL database?');
      }
      if (proceed) {
        syncDatabaseWithUI('pull');
      }
    });
  }

  // Password Visibility Toggle Eyes
  setupPasswordToggle('toggleChangeEmailPassBtn', 'changeEmailPasswordInput');
  setupPasswordToggle('togglePassCurrentBtn', 'changePassCurrentInput');
  setupPasswordToggle('togglePassNewBtn', 'changePassNewInput');
  setupPasswordToggle('togglePassConfirmBtn', 'changePassConfirmInput');
  setupPasswordToggle('toggleDbPasswordBtn', 'dbPasswordInput');

  // Account Tab Listeners
  const changeEmailForm = document.getElementById('settingsChangeEmailForm');
  if (changeEmailForm) {
    changeEmailForm.addEventListener('submit', onChangeEmailSubmit);
  }
  const changeEmailSubmitBtn = document.getElementById('changeEmailSubmitBtn');
  if (changeEmailSubmitBtn) {
    changeEmailSubmitBtn.addEventListener('click', onChangeEmailSubmit);
  }
  const changePasswordForm = document.getElementById('settingsChangePasswordForm');
  if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', onChangePasswordSubmit);
  }
  const changePassSubmitBtn = document.getElementById('changePassSubmitBtn');
  if (changePassSubmitBtn) {
    changePassSubmitBtn.addEventListener('click', onChangePasswordSubmit);
  }
  const settingsSignOutBtn = document.getElementById('settingsSignOutBtn');
  if (settingsSignOutBtn) {
    settingsSignOutBtn.addEventListener('click', () => {
      closeDatabaseModal();
      const logoutBtn = document.getElementById('authLogoutBtn');
      if (logoutBtn) logoutBtn.click();
    });
  }
  const settingsOpenAuditBtn = document.getElementById('settingsOpenAuditBtn');
  if (settingsOpenAuditBtn) {
    settingsOpenAuditBtn.addEventListener('click', () => {
      closeDatabaseModal();
      if (window.authController && window.authController.openAuditHistory) {
        window.authController.openAuditHistory();
      }
    });
  }

  // Preferences Tab Listeners
  const startupToggle = document.getElementById('launchAtStartupToggle');
  if (startupToggle) {
    startupToggle.addEventListener('change', async (e) => {
      if (window.electronAPI && window.electronAPI.setAutoStart) {
        await window.electronAPI.setAutoStart(e.target.checked);
        showToast(`Windows startup: ${e.target.checked ? 'Enabled' : 'Disabled'}`);
      }
    });
  }
  const autoLoginToggle = document.getElementById('autoLoginToggle');
  if (autoLoginToggle) {
    autoLoginToggle.addEventListener('change', async (e) => {
      if (window.electronAPI && window.electronAPI.saveAppSettings) {
        const user = window.authController ? window.authController.getCurrentUser() : null;
        await window.electronAPI.saveAppSettings({
          autoLogin: e.target.checked,
          autoLoginUsername: e.target.checked && user ? user.username : ''
        });
        showToast(`Auto-login on startup: ${e.target.checked ? 'Enabled' : 'Disabled'}`);
      }
    });
  }

  // Database Tab Listeners
  const modalCloseBtn = document.getElementById('dbModalCloseBtn');
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeDatabaseModal);
  const testDbBtn = document.getElementById('dbTestBtn');
  if (testDbBtn) testDbBtn.addEventListener('click', onTestDatabaseConnection);
  const saveDbBtn = document.getElementById('dbSaveBtn');
  if (saveDbBtn) saveDbBtn.addEventListener('click', onSaveDatabaseSettings);
  const syncDbBtn = document.getElementById('dbSyncBtn');
  if (syncDbBtn) syncDbBtn.addEventListener('click', syncDatabaseWithUI);

  // About & Software Updates Listeners
  const checkUpdatesBtn = document.getElementById('checkForUpdatesBtn');
  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', () => onCheckForUpdates(false));
  }
  const simulateUpdateBtn = document.getElementById('simulateUpdateBtn');
  if (simulateUpdateBtn) {
    simulateUpdateBtn.addEventListener('click', () => onCheckForUpdates(true));
  }
  const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
  if (downloadUpdateBtn) {
    downloadUpdateBtn.addEventListener('click', onDownloadUpdate);
  }
  const openDownloadedFileBtn = document.getElementById('openDownloadedFileBtn');
  if (openDownloadedFileBtn) {
    openDownloadedFileBtn.addEventListener('click', () => {
      if (latestDownloadedFilePath && window.electronAPI && window.electronAPI.openDownloadedFile) {
        window.electronAPI.openDownloadedFile(latestDownloadedFilePath);
      }
    });
  }
  const viewReleaseGitHubBtn = document.getElementById('viewReleaseGitHubBtn');
  if (viewReleaseGitHubBtn) {
    viewReleaseGitHubBtn.addEventListener('click', () => {
      const url = (activeUpdatePayload && activeUpdatePayload.htmlUrl) || 'https://github.com/AhmedAbo-Eita/Electronics_Lab_Inventory/releases';
      if (window.electronAPI && window.electronAPI.openExternalUrl) {
        window.electronAPI.openExternalUrl(url);
      }
    });
  }
  const checkUpdatesStartupToggle = document.getElementById('checkUpdatesStartupToggle');
  if (checkUpdatesStartupToggle) {
    checkUpdatesStartupToggle.addEventListener('change', async (e) => {
      if (window.electronAPI && window.electronAPI.saveAppSettings) {
        await window.electronAPI.saveAppSettings({ checkUpdatesOnStartup: e.target.checked });
        showToast(`Auto update check: ${e.target.checked ? 'Enabled' : 'Disabled'}`);
      }
    });
  }
  const openRepoBtn = document.getElementById('openRepoBtn');
  if (openRepoBtn) {
    openRepoBtn.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.openExternalUrl) {
        window.electronAPI.openExternalUrl('https://github.com/AhmedAbo-Eita/Electronics_Lab_Inventory');
      }
    });
  }
  const reportIssueBtn = document.getElementById('reportIssueBtn');
  if (reportIssueBtn) {
    reportIssueBtn.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.openExternalUrl) {
        window.electronAPI.openExternalUrl('https://github.com/AhmedAbo-Eita/Electronics_Lab_Inventory/issues');
      }
    });
  }

  document.getElementById('dbSettingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'dbSettingsModal') {
      closeDatabaseModal();
    }
  });

  // Check initial database sync status & quiet updates check
  await refreshDatabaseStatus();
  syncDatabaseQuietly();
  setTimeout(checkUpdatesQuietlyOnStartup, 3500);

  // 14. Handle Close Guard with Unsaved Changes via In-App Material 3 Modal
  if (window.electronAPI && window.electronAPI.onPromptCloseSave) {
    window.electronAPI.onPromptCloseSave(async () => {
      const { response } = await showAppDialog({
        type: 'save',
        icon: 'save',
        buttons: ['Save & Close', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved Changes',
        message: 'You have unsaved changes in your inventory. Do you want to save before closing?'
      });

      if (response === 0) {
        const res = await window.electronAPI.saveDB(componentList);
        if (res.ok) {
          componentListOldSave = cloneComponentList(componentList);
          await window.electronAPI.confirmForceClose();
        } else {
          await showAppDialog({
            type: 'warning',
            title: 'Save Failed',
            message: 'Could not save changes: ' + (res.error || 'Unknown error')
          });
        }
      } else if (response === 1) {
        await window.electronAPI.confirmForceClose();
      }
    });
  }

  if (window.electronAPI && window.electronAPI.onRequestSaveAndClose) {
    window.electronAPI.onRequestSaveAndClose(async () => {
      const res = await window.electronAPI.saveDB(componentList);
      if (res.ok) {
        componentListOldSave = cloneComponentList(componentList);
        await window.electronAPI.confirmForceClose();
      } else {
        await showAppDialog({
          type: 'warning',
          title: 'Save Failed',
          message: 'Could not save changes: ' + (res.error || 'Unknown error')
        });
      }
    });
  }

  // Expose global methods for inter-module integration
  window.openSettingsModal = openSettingsModal;
  window.openDatabaseModal = openDatabaseModal;
  window.switchSettingsTab = switchSettingsTab;
});
