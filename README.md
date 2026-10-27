# BRI'S CUISINE Offline Management System

## Install on Windows

1. Double-click **Install BRI Cuisine.exe**.
2. Select **Yes** when Windows asks for administrator permission.
3. Wait for **Installation complete** and select **Open BRI'S CUISINE**.

The installer is a single self-contained file. It copies the application to:

`C:\Program Files\BRI Cuisine`

It also creates branded **BRI'S CUISINE** shortcuts on the Desktop and in the Windows Start Menu. The installed launcher contains its own offline web server, so Node.js is not required.

Windows may show **Unknown publisher** because this locally built installer does not have a commercial code-signing certificate. Only run the installer produced from this trusted BRI folder.

## Open the system after installation

Double-click the **BRI'S CUISINE** Desktop shortcut. The native launcher starts silently in the Windows system tray and opens the management system in the default browser.

The application remains completely offline. `127.0.0.1` refers only to the same computer and does not use the internet.

To close it, right-click the BRI'S CUISINE tray icon and select **Exit**.

## Starter accounts

| Access | Username | Starter password |
|---|---|---|
| CEO | `ceo` | `BRI@2026` |
| Food | `food` | `Food@2026` |
| Snacks & Pastries | `snacks` | `Snacks@2026` |
| Drinks | `drinks` | `Drinks@2026` |

Change each starter password after the first sign-in. The CEO can add, disable, or reset users under **Team access**.

## Automatic JSON saving and power-failure recovery

There is no manual Save button. Every completed sale, stock update, expense, shift action, account change, and cash reconciliation immediately triggers:

1. A synchronous JSON save in the browser.
2. A rolling browser recovery copy.
3. An atomic write to `C:\Program Files\BRI Cuisine\data\bris-cuisine-data.json`.
4. A rolling disk copy at `bris-cuisine-data.backup.json` after the first update.

The disk writer completes and flushes a temporary JSON file before replacing the primary file. This reduces the risk of a half-written database during a power interruption.

The top bar displays **JSON file saved** when the disk database is connected. The CEO can also download a separate portable JSON backup under **Backup & settings**.

## Updating the application

Exit BRI'S CUISINE from the system tray, then run a newer **Install BRI Cuisine.exe**. The installer replaces application files but deliberately preserves the existing live JSON database.

## Recommended daily routine

1. Open the system from the Desktop shortcut.
2. Each department opens its day or night shift with the opening cash balance.
3. Register products and selling prices under **Stock & products**.
4. Record every sale and expense as it happens.
5. Close the shift with actual cash counted; the system calculates the variance.
6. Let the CEO verify closed shifts and download a JSON backup regularly.

## Logo and installer source

The reusable brand files are located at:

- `data\bri-cuisine-logo.png`
- `data\bri-cuisine-logo.ico`

The native launcher and installer source are in `desktop`. To rebuild after changing the application, double-click **Build Desktop Installer.bat**.

## Development fallback

**Start BRI System.bat** remains available for development from the source folder when Node.js is installed. Normal business users should use the installed Desktop shortcut instead.
