# Electronics Lab Inventory v2.0

A modern, high-performance desktop application for managing electronics laboratory component inventory, analyzing Bill of Materials (BOM) stock readiness, managing board build kits, and synchronizing data between local SQLite and remote MySQL databases.

---

## 🌟 Key Features

### 1. 📦 Inventory Management & Quick Filtering
- **Live KPI Dashboard**: Instant visual metrics for Unique MPNs, Total Stock Units, Low Stock (`<= 10`), Out of Stock (`0`), and Database Sync Status (`Saved` / `Unsaved Changes *`).
- **Multi-Criteria Search & Filter**: Real-time filtering across MPN, Value, Footprint, Location, and Customer Code combined with Component Type and Stock Status dropdowns.
- **Interactive Component Table**:
  - Column sorting with numeric quantity sorting and alphabetical text sorting.
  - Color-coded stock status badges (Healthy `> 10`, Low Stock `1–10`, Out of Stock `0`).
  - Single-click row inspector and double-click inline editing in the Edit Component tab.
  - Multi-location component support: multiple rows with the same MPN can exist in different cabinets or bins.

### 2. 📥 Smart Additive Import & Duplicate MPN Resolution
- **Additive Import**: Importing Excel (`.xlsx`, `.xls`) or CSV files adds onto the current inventory instead of replacing it.
- **Intelligent Duplicate MPN Handling**:
  - If imported components have MPNs that already exist in the inventory, an interactive dialog provides options:
    - **Add Quantity to Old One**: Merges imported quantities into existing stock rows and updates empty fields.
    - **Store in New Place (New Row)**: Preserves existing items and creates separate rows for different storage locations/drawers.
    - **Cancel Import**: Aborts the operation without making changes.
- **Export & Templates**: Export the full inventory to formatted Excel/CSV files or generate a starter spreadsheet template with one click.

### 3. 🧩 BOM Analyzer, Saved BOMs & Assembly Kits
- **EDA / CAD BOM Importer**: Import BOMs directly from KiCad, Altium Designer, and Eagle (Excel or CSV) with automatic duplicate component consolidation.
- **Build Readiness & Shortage Analysis**:
  - Configure **Boards to Build** multiplier.
  - Calculates **Max Buildable Boards**, **Ready in Stock**, and detailed component **Shortage / Missing** counts.
  - Deduct required BOM stock from inventory upon completing builds.
- **Saved BOMs Tab**:
  - Save project BOM configurations directly to the database (both local SQLite and cloud MySQL).
  - Search, view, reload into analyzer, export to Excel, or delete saved BOM projects.
- **Export Assembly Kit**: Export a clean, production-ready spreadsheet listing parts, quantities, and storage locations required to build a designated batch of boards.

### 4. 🔐 User Authentication & Role-Based Access Control (RBAC)
- **Local & Cloud User Accounts**:
  - Secure credential storage using `scrypt` hashing with random cryptographically secure salts.
  - Built-in `admin` account with initial seed credentials.
  - User registration, password changes, and email management.
- **Granular Permissions**:
  - Roles: `admin` and `user`.
  - Toggleable permissions: `canDeleteAll`, `canModifyInventory`, and `canManageDatabase`.
  - **Permission-Gated Database Tab**: The Database Settings tab is strictly hidden from standard users and only visible to Administrators and users granted database management access.
  - **Explore Mode**: Users without inventory modification rights can inspect components and analyze BOMs in a safe, read-only mode.
- **Remote Login Fallback**: If SQLite is rebuilt or installed fresh, logging in automatically checks the remote MySQL database, caches the account locally, and authenticates seamlessly.

### 5. 📜 Comprehensive Audit History & Activity Logs
- **Full Action Tracking**: Automatically logs inventory additions, edits, deletions, stock adjustments, BOM deductions, imports, and database resets with timestamps and usernames.
- **Activity History Viewer**: Dedicated modal with search and action-type filtering (`ADD`, `EDIT`, `DELETE`, `DEDUCT`, `IMPORT`, `RESET`).
- **High-Speed Cloud Sync**: Fast batch synchronization pushes local logs to MySQL and pulls remote logs into SQLite in a single transaction.

### 6. 🔄 Dual Database Architecture: Local SQLite + Remote MySQL
- **Offline-First SQLite**: Uses `sql.js` (WebAssembly SQLite) storing data in `data/lab_inventory.db`. Zero setup or external server required.
- **Remote Cloud MySQL**:
  - Optional real-time sync with remote MySQL servers.
  - Three synchronization modes: **Merge** (smart bidirectional merge), **Push** (overwrite cloud), and **Pull** (overwrite local).
  - Bidirectional sync covers components, user accounts, saved BOM projects, and audit history.
  - Fast batch execution over WAN connections with connection pooling and schema caching.

### 7. 🎨 Modern Settings & Theme Customization
- **Multi-Tab Settings Dialog**:
  - **Account**: User profile, change registered email, update password, and view permission badges.
  - **Preferences**: Select System Theme (Windows auto-detect), Dark Theme, or Light Theme; toggle Windows startup launch and auto-login.
  - **Database**: Configure MySQL credentials, test connectivity, trigger sync, export/import SQLite `.db` files, and view DBeaver guides.
  - **About**: Inspect Electron, Chromium, Node.js, and app runtime specifications.
- **Polished Animations**: Smooth spring transitions and geometrically centered exit buttons with zero rotation wobble.

---

## 🛠️ Development & Build Commands

### Prerequisites
- Node.js (v18 or higher recommended)
- npm (v9 or higher)

### Setup & Execution
```bash
# 1. Install dependencies
npm install

# 2. Run the application in development mode
npm start

# 3. Build and package Windows release (Portable .exe & unpacked folder)
npm run dist
```

Build outputs are saved to the `dist/` directory.

---

## 📁 Project Architecture

```
Electronics_Lab_Inventory/
├── assets/
│   └── Images/                  # Application icons, logos, and UI graphics
├── data/
│   ├── lab_inventory.db         # Persistent SQLite database (compatible with DBeaver)
│   └── mysql_config.json        # MySQL connection credentials and sync settings
├── src/
│   ├── backend/                 # Node.js Electron Main Process
│   │   ├── main.js              # Window lifecycle, native menu, close confirmation guard
│   │   ├── authService.js       # User authentication, scrypt hashing, permissions, and remote sync
│   │   ├── auditLogger.js       # Activity audit logging and cloud push dispatch
│   │   ├── sqliteDatabase.js    # SQLite3 WebAssembly engine (components, users, boms, history)
│   │   ├── mysqlClient.js       # MySQL connection pool, batch synchronization, and schema migrations
│   │   ├── spreadsheetHelper.js # Excel (.xlsx, .xls) and CSV parsing / generation (SheetJS)
│   │   ├── ipcHandlers.js       # Inter-Process Communication handlers between main & renderer
│   │   └── preload.js           # Secure contextBridge API definition (window.electronAPI)
│   │
│   └── frontend/                # Chromium Renderer Process (UI)
│       ├── index.html           # Main semantic HTML structure, dialogs, and modals
│       ├── styles.css           # Material 3 design tokens, responsive layout, dark/light themes
│       ├── authController.js    # Client-side authentication controller, login modal, session state
│       └── renderer.js          # Core UI logic, table rendering, BOM analyzer, settings tabs
├── package.json                 # Project manifest and build scripts
└── README.md
```

---

## 🗄️ Database Schemas

Both local SQLite and remote MySQL share identical schemas:

### 1. `lab_inventory` (Component Stock)
```sql
CREATE TABLE `lab_inventory` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `mpn` VARCHAR(120) NOT NULL,
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

### 2. `lab_users` (Accounts & Permissions)
```sql
CREATE TABLE `lab_users` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `username` VARCHAR(80) NOT NULL UNIQUE,
  `email` VARCHAR(120) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(30) DEFAULT 'user',
  `can_delete_all` TINYINT(1) DEFAULT 0,
  `can_modify_inventory` TINYINT(1) DEFAULT 1,
  `can_manage_database` TINYINT(1) DEFAULT 0,
  `last_login` DATETIME NULL DEFAULT NULL,
  `last_failed_login` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 3. `inventory_audit_log` (Activity History)
```sql
CREATE TABLE `inventory_audit_log` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `username` VARCHAR(80) NOT NULL,
  `action_type` VARCHAR(50) NOT NULL,
  `mpn` VARCHAR(120) DEFAULT '',
  `change_details` TEXT NOT NULL,
  `changed_at` DATETIME NOT NULL,
  INDEX `idx_changed_at` (`changed_at`),
  INDEX `idx_username` (`username`),
  INDEX `idx_mpn` (`mpn`)
);
```

### 4. `saved_boms` & `saved_bom_items` (Project BOMs)
```sql
CREATE TABLE `saved_boms` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `name` VARCHAR(150) NOT NULL UNIQUE,
  `boards_count` INT NOT NULL DEFAULT 1,
  `items_count` INT NOT NULL DEFAULT 0,
  `created_by` VARCHAR(80) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `saved_bom_items` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `bom_id` INT NOT NULL,
  `mpn` VARCHAR(120) NOT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `component_type` VARCHAR(80) DEFAULT '',
  `value` VARCHAR(80) DEFAULT '',
  `footprint` VARCHAR(80) DEFAULT '',
  `customer_code` VARCHAR(255) DEFAULT '',
  FOREIGN KEY (`bom_id`) REFERENCES `saved_boms`(`id`) ON DELETE CASCADE
);
```

---

## 🔌 Opening the Database in DBeaver

### Local SQLite Database
1. Open **DBeaver** and click **New Database Connection** (top-left plug icon).
2. Select **SQLite** and click **Next**.
3. In the **Path** field, browse to:
   ```
   <repo-directory>\data\lab_inventory.db
   ```
4. Click **Finish**. You can now view and edit `lab_inventory`, `lab_users`, `saved_boms`, and `inventory_audit_log`.

### Remote MySQL Database
1. In DBeaver, click **New Database Connection** &rarr; select **MySQL**.
2. Enter your MySQL Server Host, Port, Database name, Username, and Password.
3. Click **Finish** to query or inspect cloud tables directly.

---

## 📄 License
Internal Electronics Lab Inventory Application. All rights reserved.
