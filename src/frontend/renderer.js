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
    case 'error':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>`;
    case 'warning':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
      </svg>`;
    case 'question':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 16h-2v-2h2v2zm1.07-7.75l-.9.92C12.45 11.9 12 12.5 12 14h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/>
      </svg>`;
    case 'success':
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>`;
    case 'info':
    default:
      return `<svg class="dialog-status-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
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

  const rawType = String(options.type || 'info').toLowerCase();
  let iconType = 'info';
  if (rawType.includes('err')) iconType = 'error';
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

// ============================================================================
// String Normalization & Data Model Helpers
// ============================================================================

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
  const exportBtn = document.getElementById('exportBomReportPushButton');
  const deductBtn = document.getElementById('deductBomStockPushButton');
  const clearBtn = document.getElementById('clearBomPushButton');
  if (exportBtn) exportBtn.disabled = !hasBom;
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
      componentList[existingIdx].quantity += userQuantity;
      renderInventoryTable();
      refreshBomAnalysis();
      clearAddComponentForm();
      showToast(`Added +${userQuantity} stock to ${userMPN}`);
    }
  }
}

async function onCleanPushButtonClicked() {
  const { response } = await showAppDialog({
    type: 'warning',
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Clear All Inventory Data',
    message: 'Are you sure you want to permanently clear all components from the inventory table?'
  });

  if (response === 0) {
    componentList = [];
    resetEditTabState();
    renderInventoryTable();
    refreshBomAnalysis();

    const res = await window.electronAPI.saveDB(componentList);
    if (!res.ok) {
      await showAppDialog({
        type: 'warning',
        title: 'Clear Sync Failed',
        message: res.error
      });
    } else {
      componentListOldSave = cloneComponentList(componentList);
      updateDashboardMetrics();
      showToast('Cleared all inventory items');
    }
  }
}

async function onResetPushButtonClicked() {
  const { response } = await showAppDialog({
    type: 'question',
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Reset to Last Save',
    message: 'Do you want to discard unsaved changes and reload the last saved inventory?'
  });

  if (response === 0) {
    const dbRes = await window.electronAPI.initAndLoadDB();
    if (!dbRes.ok) {
      await showAppDialog({
        type: 'warning',
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
    showToast('Reverted to last saved database state');
  }
}

async function onSavePushButtonClicked() {
  const { response } = await showAppDialog({
    type: 'question',
    buttons: ['OK', 'Cancel'],
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
      showToast('Database saved successfully');
      syncDatabaseQuietly();
    } else {
      await showAppDialog({
        type: 'warning',
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

  let addedCount = 0;
  let mergedCount = 0;

  for (const inc of incomingList) {
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
    showToast(`Imported ${incomingList.length} rows (${addedCount} new, ${mergedCount} merged) & saved to DB`);
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
  let targetIdx = searchComponentByMPN(componentList, selectedMPN);
  if (targetIdx === -1) {
    targetIdx = searchComponentByMPN(componentList, document.getElementById('editMPNLineEdit').value);
  }
  if (targetIdx === -1) return;

  const comp = componentList[targetIdx];
  comp.location = document.getElementById('editLocatioLineEdit').value.trim();
  comp.footprint = document.getElementById('editFootprintLineEdit').value.trim();
  comp.quantity = Math.max(0, parseInt(document.getElementById('editQuantitySpinBox').value, 10) || 0);
  comp.type = document.getElementById('editTypeComboBox').value.trim();
  comp.value = document.getElementById('editValueLineEdit').value.trim();
  comp.customerCode = document.getElementById('editCustomerCodeLineEdit').value.trim();

  renderInventoryTable();
  refreshBomAnalysis();
  resetEditTabState();
  showToast(`Saved edits for ${comp.mpn}`);
}

async function onDeleteComponentpushButtonClicked() {
  let targetIdx = searchComponentByMPN(componentList, selectedMPN);
  if (targetIdx === -1) {
    targetIdx = searchComponentByMPN(componentList, document.getElementById('editMPNLineEdit').value);
  }
  if (targetIdx === -1) return;

  const targetMPN = componentList[targetIdx].mpn;
  const { response } = await showAppDialog({
    type: 'question',
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Delete Component',
    message: `Are you sure you want to delete component '${targetMPN}' from the inventory?`
  });

  if (response === 0) {
    componentList.splice(targetIdx, 1);
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

function onLoadSampleBomClicked() {
  bomItems = [];
  const boardInput = document.getElementById('BomBoardNamelineEdit');
  if (!boardInput.value.trim()) {
    boardInput.value = 'STM32_Motor_Driver_RevA';
  }

  if (componentList.length > 0) {
    const count = Math.min(componentList.length, 6);
    for (let i = 0; i < count; i++) {
      const c = { ...componentList[i] };
      const reqQty = i % 3 === 0 ? 2 : i % 2 === 0 ? 4 : 1;
      c.quantity = reqQty;
      if (!c.customerCode) {
        c.customerCode = `U${i + 1}`;
      }
      bomItems.push(c);
    }
  } else {
    bomItems.push(createComponent('STM32F103C8T6', 1, 'IC', '32-bit MCU', 'LQFP-48', 'Bin-A1', 'U1'));
    bomItems.push(createComponent('AMS1117-3.3', 2, 'IC', '3.3V 1A LDO', 'SOT-223', 'Bin-A2', 'U2, U3'));
    bomItems.push(createComponent('RC0603FR-0710KL', 8, 'Resistor', '10k', '0603', 'Bin-R1', 'R1-R8'));
    bomItems.push(createComponent('CL10B104KB8NNNC', 12, 'Capacitor', '100nF', '0603', 'Bin-C1', 'C1-C12'));
    bomItems.push(createComponent('IRFZ44NPBF', 4, 'MOSFET', '55V 49A', 'TO-220', 'Bin-M1', 'Q1-Q4'));
  }

  bomItems.push(createComponent('TPS5430DDAR', 2, 'IC', '3A Buck Converter', 'SOP-8', '—', 'U9, U10'));

  refreshBomAnalysis();
  showToast('Loaded sample BOM for STM32_Motor_Driver_RevA');
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

async function openDatabaseModal() {
  const modal = document.getElementById('dbSettingsModal');
  const feedback = document.getElementById('dbTestFeedback');
  feedback.className = 'db-feedback-box hidden';
  feedback.textContent = '';

  // Synchronize current theme selection & Windows detection badge
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

  const cfg = await window.electronAPI.getMySQLConfig();
  document.getElementById('dbEnableSyncToggle').checked = Boolean(cfg.enabled);
  document.getElementById('dbHostInput').value = cfg.host || 'localhost';
  document.getElementById('dbPortInput').value = cfg.port || 3306;
  document.getElementById('dbNameInput').value = cfg.database || 'lab_inventory_db';
  document.getElementById('dbUserInput').value = cfg.user || 'root';
  document.getElementById('dbPasswordInput').value = cfg.password || '';

  await refreshDatabaseStatus();
  modal.classList.remove('hidden');
}

function closeDatabaseModal() {
  const modal = document.getElementById('dbSettingsModal');
  modal.classList.add('hidden');
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
    feedback.textContent = '✓ ' + (res.message || 'Connected successfully to MySQL server!');
  } else {
    feedback.className = 'db-feedback-box feedback-error';
    feedback.textContent = '✗ ' + (res.message || 'Connection failed. Check host, port, credentials, and firewall.');
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

async function syncDatabaseWithUI() {
  if (isSyncing) return;
  isSyncing = true;

  const dot = document.getElementById('dbStatusDot');
  const modalDot = document.getElementById('modalStatusDot');
  const syncBtn = document.getElementById('dbSyncBtn');

  if (dot) dot.className = 'db-status-dot dot-syncing';
  if (modalDot) modalDot.className = 'db-status-dot dot-syncing';
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
  }

  try {
    const res = await window.electronAPI.syncMySQLNow(componentList);
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
    }

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
      showToast(res.message);
    } else {
      showToast(res.message);
    }
  } catch (err) {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
    }
    showToast('Sync error: ' + err.message);
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
          type: 'question',
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
  document.getElementById('loadSampleBomPushButton').addEventListener('click', onLoadSampleBomClicked);
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

  // 13. Settings & Database Remote Sync Listeners
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', openDatabaseModal);
  }
  const dbStatusPill = document.getElementById('dbStatusPill');
  if (dbStatusPill) {
    dbStatusPill.addEventListener('click', openDatabaseModal);
  }
  document.getElementById('dbModalCloseBtn').addEventListener('click', closeDatabaseModal);
  document.getElementById('dbTestBtn').addEventListener('click', onTestDatabaseConnection);
  document.getElementById('dbSaveBtn').addEventListener('click', onSaveDatabaseSettings);
  document.getElementById('dbSyncBtn').addEventListener('click', syncDatabaseWithUI);
  document.getElementById('dbSettingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'dbSettingsModal') {
      closeDatabaseModal();
    }
  });

  // Check initial database sync status
  await refreshDatabaseStatus();
  syncDatabaseQuietly();

  // 14. Handle Close Guard with Unsaved Changes via In-App Material 3 Modal
  if (window.electronAPI && window.electronAPI.onPromptCloseSave) {
    window.electronAPI.onPromptCloseSave(async () => {
      const { response } = await showAppDialog({
        type: 'question',
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
});
