/**
 * ============================================================================
 * Spreadsheet & CSV Helper (Excel .xlsx / .xls & RFC-4180 CSV Engine)
 * ============================================================================
 * Provides robust, user-friendly importing and exporting for:
 *   - Inventory Component Sheets (Excel .xlsx / CSV)
 *   - BOM Assemblies & Bill of Materials (Excel .xlsx / CSV)
 *   - BOM Availability & Shortage Reports
 *   - Clean Starter Excel / CSV Templates
 *
 * All imported spreadsheet data is transferred directly into the application's
 * persistent database (local SQLite and optional online MySQL).
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/**
 * Standard starter inventory examples for the Excel/CSV template.
 */
const TEMPLATE_SAMPLE_ROWS = [
  { mpn: 'STM32F103C8T6', quantity: 24, componentType: 'IC', value: '32-bit ARM Cortex-M3 MCU', footprint: 'LQFP-48', location: 'Cabinet A - Bin 01', customerCode: 'MCU-001' },
  { mpn: 'ESP32-WROOM-32E', quantity: 15, componentType: 'IC', value: 'Wi-Fi + BT SoC Module', footprint: 'SMD-38', location: 'Cabinet A - Bin 02', customerCode: 'MOD-002' },
  { mpn: 'AMS1117-3.3', quantity: 45, componentType: 'IC', value: '3.3V 1A LDO Regulator', footprint: 'SOT-223', location: 'Cabinet A - Bin 04', customerCode: 'REG-003' },
  { mpn: 'RC0603FR-0710KL', quantity: 250, componentType: 'Resistor', value: '10k 1% 100mW', footprint: '0603', location: 'Rack R - Drawer 01', customerCode: 'RES-10K' },
  { mpn: 'CL10B104KB8NNNC', quantity: 320, componentType: 'Capacitor', value: '100nF 50V X7R', footprint: '0603', location: 'Rack C - Drawer 01', customerCode: 'CAP-100N' },
  { mpn: '1N4148W-7-F', quantity: 110, componentType: 'Diode', value: '100V 300mA Fast Switching', footprint: 'SOD-123', location: 'Cabinet D - Bin 03', customerCode: 'DIO-4148' },
  { mpn: 'AO3400A', quantity: 60, componentType: 'MOSFET', value: '30V 5.7A N-Channel', footprint: 'SOT-23', location: 'Cabinet B - Bin 02', customerCode: 'MOS-002' }
];

/**
 * Normalizes header string for fuzzy matching across CAD/EDA outputs.
 */
function normalizeHeader(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Determines column indices from header row for inventory import.
 */
function resolveInventoryColumns(headers) {
  const mapping = {
    mpn: -1,
    quantity: -1,
    type: -1,
    value: -1,
    footprint: -1,
    location: -1,
    customerCode: -1
  };

  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    if (!h) continue;

    if (mapping.mpn === -1 && (h === 'mpn' || h.includes('partnumber') || h.includes('mfgpart') || h === 'partno' || h === 'part')) {
      mapping.mpn = i;
    } else if (mapping.quantity === -1 && (h === 'quantity' || h === 'qty' || h === 'stock' || h === 'count' || h === 'units')) {
      mapping.quantity = i;
    } else if (mapping.type === -1 && (h === 'type' || h.includes('componenttype') || h === 'category' || h === 'group')) {
      mapping.type = i;
    } else if (mapping.value === -1 && (h === 'value' || h.includes('componentvalue') || h === 'comment' || h === 'val')) {
      mapping.value = i;
    } else if (mapping.footprint === -1 && (h === 'footprint' || h === 'package' || h === 'pkg' || h === 'case')) {
      mapping.footprint = i;
    } else if (mapping.location === -1 && (h.includes('location') || h === 'bin' || h === 'shelf' || h === 'cabinet' || h === 'rack')) {
      mapping.location = i;
    } else if (mapping.customerCode === -1 && (h.includes('customercode') || h === 'code' || h === 'designator' || h === 'refdes' || h === 'reference')) {
      mapping.customerCode = i;
    }
  }

  return mapping;
}

/**
 * Reads an Excel (.xlsx / .xls) or CSV file and extracts inventory components.
 *
 * @param {string} filePath
 * @returns {{ ok: boolean, list?: Array, baseName?: string, error?: string }}
 */
function readInventorySpreadsheet(filePath) {
  try {
    const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { ok: false, error: 'The selected spreadsheet file contains no sheets.' };
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rawRows || rawRows.length < 2) {
      return { ok: false, error: 'The selected file is empty or missing a data header row.' };
    }

    const headers = rawRows[0];
    const mapping = resolveInventoryColumns(headers);

    if (mapping.mpn === -1) {
      return {
        ok: false,
        error:
          "Could not find a 'Manufacturer Part Number' (or 'MPN' / 'Part Number') column.\n\n" +
          "Please verify that the first row of your Excel or CSV file includes standard column headers."
      };
    }

    const components = [];
    for (let r = 1; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!row || !row.length) continue;

      const mpn = String(row[mapping.mpn] || '').trim();
      if (!mpn) continue;

      let qty = 0;
      if (mapping.quantity !== -1 && row[mapping.quantity] !== undefined) {
        const parsedQty = parseInt(row[mapping.quantity], 10);
        if (Number.isFinite(parsedQty) && parsedQty >= 0) {
          qty = parsedQty;
        }
      }

      const type = mapping.type !== -1 ? String(row[mapping.type] || '').trim() : '';
      const value = mapping.value !== -1 ? String(row[mapping.value] || '').trim() : '';
      const footprint = mapping.footprint !== -1 ? String(row[mapping.footprint] || '').trim() : '';
      const location = mapping.location !== -1 ? String(row[mapping.location] || '').trim() : '';
      const customerCode = mapping.customerCode !== -1 ? String(row[mapping.customerCode] || '').trim() : '';

      components.push({
        mpn,
        quantity: qty,
        type: type || 'Other',
        componentType: type || 'Other',
        value,
        footprint,
        location,
        customerCode
      });
    }

    return {
      ok: true,
      list: components,
      baseName: path.basename(filePath, path.extname(filePath))
    };
  } catch (err) {
    return { ok: false, error: `Failed to read file: ${err.message}` };
  }
}

/**
 * Writes components to an Excel (.xlsx) or CSV file.
 *
 * @param {string} filePath
 * @param {Array} components
 * @returns {{ ok: boolean, error?: string }}
 */
function writeInventorySpreadsheet(filePath, components = []) {
  try {
    const data = [
      [
        'Manufacturer Part Number',
        'Quantity',
        'Component Type',
        'Value',
        'Footprint',
        'Lab Location',
        'Customer Code'
      ]
    ];

    for (const c of components) {
      data.push([
        c.mpn || '',
        Number(c.quantity) || 0,
        c.componentType || c.type || '',
        c.value || '',
        c.footprint || '',
        c.location || '',
        c.customerCode || ''
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);

    // Set nice column widths for Excel
    ws['!cols'] = [
      { wch: 26 }, // MPN
      { wch: 12 }, // Quantity
      { wch: 18 }, // Type
      { wch: 22 }, // Value
      { wch: 16 }, // Footprint
      { wch: 24 }, // Location
      { wch: 18 }  // Customer Code
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lab Inventory');

    const ext = path.extname(filePath).toLowerCase();
    const bookType = ext === '.csv' ? 'csv' : 'xlsx';

    XLSX.writeFile(wb, filePath, { bookType });
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `Failed to write file: ${err.message}` };
  }
}

/**
 * Generates and saves a clean starter template (.xlsx or .csv).
 *
 * @param {string} filePath
 * @returns {{ ok: boolean, error?: string }}
 */
function writeTemplateSpreadsheet(filePath) {
  return writeInventorySpreadsheet(filePath, TEMPLATE_SAMPLE_ROWS);
}

/**
 * Reads a BOM file (Excel .xlsx / .xls or CSV) and extracts required parts.
 *
 * @param {string} filePath
 * @returns {{ ok: boolean, list?: Array, baseName?: string, error?: string }}
 */
function readBomSpreadsheet(filePath) {
  try {
    const workbook = XLSX.readFile(filePath, { type: 'file' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { ok: false, error: 'The selected BOM file contains no sheets.' };
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rawRows || rawRows.length < 2) {
      return { ok: false, error: 'The selected BOM file is empty or missing headers.' };
    }

    const headers = rawRows[0];
    let mpnCol = -1;
    let qtyCol = -1;
    let typeCol = -1;
    let valCol = -1;
    let pkgCol = -1;
    let desCol = -1;

    for (let i = 0; i < headers.length; i++) {
      const h = normalizeHeader(headers[i]);
      if (!h) continue;

      if (mpnCol === -1 && (h === 'mpn' || h.includes('partnumber') || h.includes('mfgpart') || h === 'partno' || h === 'part')) {
        mpnCol = i;
      } else if (qtyCol === -1 && (h === 'quantity' || h === 'qty' || h.includes('qtyperboard') || h === 'count')) {
        qtyCol = i;
      } else if (typeCol === -1 && (h === 'type' || h.includes('componenttype') || h === 'category' || h === 'description')) {
        typeCol = i;
      } else if (valCol === -1 && (h === 'value' || h.includes('componentvalue') || h === 'comment')) {
        valCol = i;
      } else if (pkgCol === -1 && (h === 'footprint' || h === 'package' || h === 'pkg' || h === 'case')) {
        pkgCol = i;
      } else if (desCol === -1 && (h === 'designator' || h === 'refdes' || h === 'reference' || h.includes('customercode'))) {
        desCol = i;
      }
    }

    if (mpnCol === -1) {
      return {
        ok: false,
        error: "BOM file must include a 'Manufacturer Part Number' (or 'MPN' / 'Part Number') column."
      };
    }

    const bomList = [];
    for (let r = 1; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!row || !row.length) continue;

      const mpn = String(row[mpnCol] || '').trim();
      if (!mpn) continue;

      let qty = 1;
      if (qtyCol !== -1 && row[qtyCol] !== undefined) {
        const parsedQty = parseInt(row[qtyCol], 10);
        if (Number.isFinite(parsedQty) && parsedQty > 0) {
          qty = parsedQty;
        }
      }

      const type = typeCol !== -1 ? String(row[typeCol] || '').trim() : '';
      const value = valCol !== -1 ? String(row[valCol] || '').trim() : '';
      const footprint = pkgCol !== -1 ? String(row[pkgCol] || '').trim() : '';
      const designator = desCol !== -1 ? String(row[desCol] || '').trim() : '';

      // Merge duplicate MPNs automatically (sum quantities, concatenate designators)
      let merged = false;
      for (const existing of bomList) {
        if (existing.mpn.toLowerCase() === mpn.toLowerCase()) {
          existing.quantity += qty;
          if (designator) {
            if (!existing.customerCode) {
              existing.customerCode = designator;
            } else if (!existing.customerCode.includes(designator)) {
              existing.customerCode += ', ' + designator;
            }
          }
          merged = true;
          break;
        }
      }

      if (!merged) {
        bomList.push({
          mpn,
          quantity: qty,
          type: type || 'Component',
          componentType: type || 'Component',
          value,
          footprint,
          location: '',
          customerCode: designator
        });
      }
    }

    return {
      ok: true,
      list: bomList,
      baseName: path.basename(filePath, path.extname(filePath))
    };
  } catch (err) {
    return { ok: false, error: `Failed to read BOM file: ${err.message}` };
  }
}

/**
 * Exports full BOM Availability & Shortage Report to Excel (.xlsx) or CSV.
 *
 * @param {string} filePath
 * @param {string} boardName
 * @param {number} boardsCount
 * @param {Array} analysisItems
 * @returns {{ ok: boolean, error?: string }}
 */
function writeBomReportSpreadsheet(filePath, boardName, boardsCount, analysisItems = []) {
  try {
    const headers = [
      'Board Name',
      'Boards Count',
      'Manufacturer Part Number',
      'Component Type',
      'Value',
      'Footprint',
      'Designator / Reference',
      'Qty / Board',
      'Total Required',
      'Available in Lab',
      'Shortage',
      'Lab Location',
      'Availability Status'
    ];

    const data = [headers];
    const effectiveBoard = (boardName || '').trim() || 'Untitled_Board';

    for (const item of analysisItems) {
      const bc = item.bomComponent || {};
      data.push([
        effectiveBoard,
        Number(boardsCount) || 1,
        bc.mpn || '',
        bc.type || bc.componentType || '',
        bc.value || '',
        bc.footprint || '',
        bc.customerCode || '',
        Number(bc.quantity) || 1,
        Number(item.totalRequired) || 0,
        Number(item.availableInLab) || 0,
        Number(item.shortage) || 0,
        item.labLocation || 'Not in Lab',
        item.statusText || ''
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 22 }, // Board Name
      { wch: 14 }, // Boards Count
      { wch: 26 }, // MPN
      { wch: 18 }, // Type
      { wch: 20 }, // Value
      { wch: 16 }, // Footprint
      { wch: 22 }, // Designator
      { wch: 12 }, // Qty / Board
      { wch: 14 }, // Total Required
      { wch: 16 }, // Available in Lab
      { wch: 12 }, // Shortage
      { wch: 22 }, // Lab Location
      { wch: 18 }  // Status
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BOM Availability Report');

    const ext = path.extname(filePath).toLowerCase();
    const bookType = ext === '.csv' ? 'csv' : 'xlsx';

    XLSX.writeFile(wb, filePath, { bookType });
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `Failed to write BOM report: ${err.message}` };
  }
}

/**
 * Writes an Assembly Component Pick / Kitting List to an Excel (.xlsx) or CSV file.
 * Formats components with required quantities calculated for the assigned number of boards,
 * reference designators, and lab storage locations for assembly.
 *
 * @param {string} filePath Target file path (.xlsx or .csv)
 * @param {string} boardName Name of the PCB assembly/project
 * @param {number} boardsCount Number of boards to assemble
 * @param {Array} analysisItems Calculated BOM analysis items
 * @returns {{ ok: boolean, error?: string, path?: string }}
 */
function writeAssemblyPickListSpreadsheet(filePath, boardName, boardsCount, analysisItems = []) {
  try {
    const effectiveBoard = (boardName || '').trim() || 'Assembly_Project';
    const effectiveCount = Math.max(1, Number(boardsCount) || 1);

    const headers = [
      'Item #',
      'Board Name',
      'Boards to Build',
      'Manufacturer Part Number (MPN)',
      'Component Type',
      'Value / Rating',
      'Package / Footprint',
      'Reference Designators',
      'Qty / Board',
      'Total Required Qty',
      'Lab Location',
      'Stock Status',
      'Picked / Verified'
    ];

    const data = [headers];

    let itemNumber = 1;
    for (const item of analysisItems) {
      const bc = item.bomComponent || {};
      const qtyPerBoard = Number(bc.quantity) || 1;
      const totalRequired = Number(item.totalRequired) || (qtyPerBoard * effectiveCount);

      data.push([
        itemNumber++,
        effectiveBoard,
        effectiveCount,
        bc.mpn || '',
        bc.type || bc.componentType || '',
        bc.value || '',
        bc.footprint || '',
        bc.customerCode || '',
        qtyPerBoard,
        totalRequired,
        item.labLocation || 'Not in Lab',
        item.statusText || (item.shortage > 0 ? `SHORTAGE (${item.shortage} missing)` : 'READY IN STOCK'),
        ''
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 8 },
      { wch: 22 },
      { wch: 14 },
      { wch: 28 },
      { wch: 18 },
      { wch: 20 },
      { wch: 18 },
      { wch: 26 },
      { wch: 12 },
      { wch: 18 },
      { wch: 20 },
      { wch: 22 },
      { wch: 16 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Assembly Pick List');

    const ext = path.extname(filePath).toLowerCase();
    const bookType = ext === '.csv' ? 'csv' : 'xlsx';

    XLSX.writeFile(wb, filePath, { bookType });
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `Failed to write assembly pick list: ${err.message}` };
  }
}

module.exports = {
  readInventorySpreadsheet,
  writeInventorySpreadsheet,
  writeTemplateSpreadsheet,
  readBomSpreadsheet,
  writeBomReportSpreadsheet,
  writeAssemblyPickListSpreadsheet
};
