# Ultimate Project Manager

A **VS Code** and **Cursor** extension for keeping a **personal list of workspace folders** in one place. You add projects yourself (name, description, color, category). Nothing depends on the third-party Project Manager extension—data is stored locally with this extension.

## What it does

Open the **Projects** icon in the Activity Bar to see your list. Each entry shows a **color dot**, **title**, and optional **short description**. Projects are grouped by **category** so long lists stay readable. You can also open a full **Project Dashboard** webview from the view title bar.

**“Home page” behavior:** Extensions cannot embed a custom dashboard inside the built-in Welcome / Start screen. This extension can **open the same dashboard as a webview tab in the editor** when the window loads (optional; see settings below)—that is the supported way to get a home-like experience.

## Features

- **Startup dashboard** — Optionally open the Project Dashboard in the editor after startup (with an optional “only when no folder is open” guard).
- **Your projects** — Add folders you care about; metadata stays with this extension.
- **Categories** — One category per project (e.g. Mobile, Next.js, Backend, a client name). Uncategorized items appear under **Uncategorized**.
- **Collapsible groups** — Category headers expand/collapse like a simple file tree.
- **Colors** — Pick a named color for each project’s dot (stored as hex under the hood).
- **Quick actions** — Right-click a project: **Open**, **Reveal in Finder**, **Edit**, **Delete**.
- **Category commands** — Create, rename, or delete categories from the Command Palette (deleting a category moves its projects to Uncategorized).

## Commands (Command Palette)

Prefix: **Project Dashboard:** (command IDs still use `projectDashboard` for compatibility.)

| Command | Purpose |
|--------|---------|
| Add Project | Pick folder, name, description, color, category |
| Edit Project | Update an existing project |
| Open Project | Open a saved folder |
| Remove Project | Remove from the list |
| Reveal in Finder | Show the folder in the system file manager |
| Create / Rename / Delete Category | Manage categories |
| Open Webview | Open the dashboard in the editor area |

## Settings

| Setting | Default | Description |
|--------|---------|-------------|
| `projectDashboard.openInNewWindow` | `false` | When opening a project from the list, open it in a new window |
| `projectDashboard.showDashboardOnStartup` | `true` | Open the Project Dashboard webview in the editor after the window finishes loading |
| `projectDashboard.showDashboardOnlyWhenEmpty` | `true` | If startup dashboard is enabled, only auto-open when no workspace folder is open |

## Data storage

Projects are saved as JSON in the extension’s **global storage** (under your user profile), not inside your repo. Paths and metadata stay on your machine.

## Installation (from `.vsix`)

1. Build: `npm run package`
2. In VS Code / Cursor: **Extensions** → **⋯** → **Install from VSIX…**
3. Choose the generated `ultimate-project-manager-*.vsix` file

## Requirements

- **VS Code** `^1.80.0` or compatible (including Cursor).
