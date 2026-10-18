# Lab Inventory v2.0 (Electron Edition)

A modern desktop application for managing electronics lab component inventory and analyzing Bill of Materials (BOM) stock readiness — converted from Qt/C++ to Electron.

## Features
- **Modern KPI Dashboard**: Live counters for Unique Parts, Total Stock Units, Low/Out-of-Stock alerts (`<= 10`), and Database Sync Status (`Saved` / `Unsaved Changes *`).
- **Multi-Criteria Quick Filter Bar**: Instant search across MPN, Value, Footprint, Location, and Customer Code, combined with Component Type and Stock Status filters.
- **Interactive Inventory Table**:
  - Sortable columns (numeric sorting on Quantity, text sorting on all other columns).
  - Color-coded stock indicators (Green: Healthy `> 10`, Amber: Low `1–10`, Red: Out of Stock `0`).
  - Click any row to populate the Edit and Search inspectors.
  - Double-click cells while in the **Edit Component** tab to edit values inline.
- **Component Management (Add / Edit / Search)**:
  - Add new components with duplicate-MPN detection and optional stock accumulation.
  - Edit components with quick `-1` / `+1` stock step buttons.
  - Search components by MPN with one-click jump to Add or Edit.
- **BOM Analyzer & Board Builder**:
  - Import BOM files from Excel (`.xlsx`) or CSV (supports EDA outputs from KiCad, Altium, and Eagle) with automatic duplicate MPN consolidation.
  - Load a realistic sample BOM with one click.
  - Configure **Boards to Build** multiplier and view **Max Buildable Boards**, **Ready in Stock**, and **Shortages / Missing** counts.
  - Deduct required BOM stock from Lab Inventory for a board build.
  - Export full BOM Availability & Shortage Reports to Excel (`.xlsx`) or CSV.
- **User-Friendly Excel & CSV Interface**:
  - **Import Sheet**: Load components from any Excel (`.xlsx`, `.xls`) or CSV file; data is automatically parsed, merged, and transferred directly into the active database.
  - **Export Sheet**: Download inventory into formatted Excel workbooks or CSV spreadsheets.
  - **Starter Template**: One-click download of a standardized Excel/CSV template with sample parts.
- **Dual Database Architecture (SQLite & MySQL)**:
  - **Local Offline**: Persistent SQLite database (`data/lab_inventory.db`), viewable in DBeaver.
  - **Online Sync**: Optional real-time synchronization with remote MySQL servers.
- **Settings & Unified Configuration Dialog**:
  - Dedicated **Settings** button in the titlebar opening a unified configuration modal.
  - **Automatic Windows Theme Detection**: Auto-detects Windows OS Dark or Light mode by default, reacting live when Windows appearance changes.
  - **Custom Theme Overrides**: Choose between System Default (Windows Auto-detect), explicit Dark Mode, or explicit Light Mode with persistent local storage.
  - Full MySQL remote server settings, connection testing, and DBeaver integration guides.

## Development & Build Commands

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Package Windows release (Portable .exe and unpacked directory)
npm run dist
```

## Project Architecture

The codebase is organized into backend (Node.js/Electron main process) and frontend (Chromium renderer process):

```
Electronics_Lab_Inventory/
├── assets/
│   └── Images/               # Application icons and logos
├── data/
│   ├── lab_inventory.db      # Local SQLite database (viewable in DBeaver)
│   └── mysql_config.json     # Saved MySQL credentials (auto-created)
├── src/
│   ├── backend/              # Node.js Electron Main Process
│   │   ├── main.js           # App lifecycle, frameless window, close guard
│   │   ├── sqliteDatabase.js # Local SQLite3 database manager (sql.js WASM engine)
│   │   ├── spreadsheetHelper.js # Excel (.xlsx) & CSV parser / serializer (SheetJS)
│   │   ├── mysqlClient.js    # MySQL connection pooling, auto table creation, two-way sync
│   │   ├── ipcHandlers.js    # IPC endpoints (database, spreadsheets, window controls, MySQL)
│   │   └── preload.js        # Secure context bridge (window.electronAPI)
│   │
│   └── frontend/             # Chromium Renderer Process (UI)
│       ├── index.html        # Semantic HTML layout and Material 3 structure
│       ├── styles.css        # Material 3 styling tokens, light/dark themes
│       └── renderer.js       # UI state, table rendering, BOM analyzer engine
├── package.json              # App manifest (main: src/backend/main.js)
└── README.md
```

## Database Architecture: Local SQLite + Remote MySQL

The application uses an **Offline-First SQLite Architecture** with optional **Remote MySQL Synchronization**:
- **Offline / Default**: All components are stored in a real SQLite database file (`data/lab_inventory.db`). Any user can run the app without installing MySQL or any background service.
- **Online (MySQL)**: When enabled, the app two-way synchronizes the local SQLite database with your remote MySQL server.
- **DBeaver Support**: DBeaver can open `data/lab_inventory.db` directly as a native SQLite database!

### Accessing the Database in DBeaver

#### 1. Open the Local Offline Database (SQLite)
1. Open **DBeaver**.
2. Click **New Database Connection** (top-left plug icon).
3. Select **SQLite** and click **Next**.
4. In the **Path** field, click **Browse...** and select:
   ```
   C:\Users\aboei\Desktop\Rnd\My_Repos\Electronics_Lab_Inventory\data\lab_inventory.db
   ```
5. Click **Finish**.
6. In DBeaver's left tree, expand `lab_inventory.db` &rarr; `Tables` &rarr; double-click `lab_inventory` &rarr; open the **Data** tab.

#### 2. Open the Remote Database (MySQL)
1. In DBeaver, click **New Database Connection** &rarr; select **MySQL**.
2. Enter your MySQL Server Host, Port (3306), Database name (`lab_inventory_db`), Username, and Password.
3. Click **Finish**. Both local SQLite and remote MySQL share the exact same table name (`lab_inventory`) and schema!

#### 3. Table Schema (`lab_inventory`)

```sql
CREATE TABLE `lab_inventory` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `mpn` VARCHAR(120) NOT NULL UNIQUE,
  `quantity` INT NOT NULL DEFAULT 0,
  `component_type` VARCHAR(80) DEFAULT '',
  `value` VARCHAR(80) DEFAULT '',
  `footprint` VARCHAR(80) DEFAULT '',
  `location` VARCHAR(120) DEFAULT '',
  `customer_code` VARCHAR(80) DEFAULT '',
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_mpn` (`mpn`),
  INDEX `idx_type` (`component_type`)
);
```


