const vscode = require('vscode');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const PROJECTS_FILE = 'projects.json';
const UNCATEGORIZED_LABEL = 'Uncategorized';
const NAMED_COLORS = [
  { name: 'Blue', hex: '#3B82F6', dot: '🔵' },
  { name: 'Orange', hex: '#F59E0B', dot: '🟠' },
  { name: 'Pink', hex: '#EC4899', dot: '🩷' },
  { name: 'Green', hex: '#10B981', dot: '🟢' },
  { name: 'Purple', hex: '#A855F7', dot: '🟣' },
  { name: 'Red', hex: '#EF4444', dot: '🔴' },
  { name: 'Teal', hex: '#14B8A6', dot: '🔹' },
  { name: 'Amber', hex: '#F97316', dot: '🟧' },
];
const DEFAULT_COLORS = NAMED_COLORS.map((item) => item.hex);

/** @type {import('vscode').WebviewPanel | null} */
let dashboardPanelRef = null;

class ProjectStore {
  constructor(context) {
    this.context = context;
    this.storageDir = context.globalStorageUri.fsPath;
    this.projectsFile = path.join(this.storageDir, PROJECTS_FILE);
  }

  async ensureStorage() {
    await fs.mkdir(this.storageDir, { recursive: true });
  }

  async listProjects() {
    await this.ensureStorage();
    try {
      const raw = await fs.readFile(this.projectsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      const normalized = parsed.map((project) => ({
        ...project,
        id: project.id || crypto.randomUUID(),
        category: normalizeCategory(project.category),
        color:
          project.color ||
          DEFAULT_COLORS[Math.abs(hashString(project.rootPath || project.name || project.id || '')) % DEFAULT_COLORS.length],
      }));

      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
        await this.saveProjects(normalized);
      }

      return normalized;
    } catch (error) {
      return [];
    }
  }

  async saveProjects(projects) {
    await this.ensureStorage();
    await fs.writeFile(this.projectsFile, JSON.stringify(projects, null, 2), 'utf8');
  }

  async addProject(project) {
    const projects = await this.listProjects();
    const existingIndex = projects.findIndex((item) => item.rootPath === project.rootPath);
    if (existingIndex >= 0) {
      projects[existingIndex] = {
        ...projects[existingIndex],
        ...project,
        updatedAt: new Date().toISOString(),
      };
    } else {
      projects.push({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...project,
      });
    }
    await this.saveProjects(projects);
  }

  async updateProjectById(id, updates) {
    const projects = await this.listProjects();
    const index = projects.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    projects[index] = {
      ...projects[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.saveProjects(projects);
    return true;
  }

  async updateProjects(projects) {
    await this.saveProjects(projects);
  }

  async removeProjectByRootPath(rootPath) {
    const projects = await this.listProjects();
    const remaining = projects.filter((item) => item.rootPath !== rootPath);
    if (remaining.length === projects.length) {
      return false;
    }
    await this.saveProjects(remaining);
    return true;
  }
}

class ProjectDashboardViewProvider {
  constructor(context, store) {
    this.context = context;
    this.store = store;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    this.refresh().catch(() => {});

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'openProject':
          await openProjectFolder(message.rootPath);
          return;
        case 'removeProject':
          await this.store.removeProjectByRootPath(message.rootPath);
          await this.refresh();
          return;
        case 'addProject':
          await addProjectFlow(this.store, this);
          return;
        case 'editProject':
          await editProjectFlow(this.store, this, message.id);
          return;
        case 'revealInFinder':
          await revealInFinder(message.rootPath);
          return;
        default:
          return;
      }
    });
  }

  async refresh() {
    if (!this.view) {
      return;
    }
    const projects = await this.store.listProjects();
    this.view.webview.html = getSidebarHtml(this.view.webview, projects, this.store);
    await refreshOpenDashboardPanel(this.store);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashString(value) {
  const input = String(value);
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function normalizeCategory(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function getCategoryLabel(value) {
  const normalized = normalizeCategory(value);
  return normalized || UNCATEGORIZED_LABEL;
}

function sortCategories(categories) {
  return [...categories].sort((a, b) => {
    if (a === UNCATEGORIZED_LABEL) return 1;
    if (b === UNCATEGORIZED_LABEL) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

function getCustomCategories(projects) {
  const categorySet = new Set();
  for (const project of projects) {
    const category = normalizeCategory(project.category);
    if (category) {
      categorySet.add(category);
    }
  }
  return [...categorySet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function groupProjectsByCategory(projects) {
  const groups = new Map();
  for (const project of projects) {
    const label = getCategoryLabel(project.category);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(project);
  }

  const sortedCategoryNames = sortCategories([...groups.keys()]);
  return sortedCategoryNames.map((categoryName) => {
    const items = groups.get(categoryName) || [];
    items.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    return { categoryName, items };
  });
}

function getSidebarHtml(webview, projects, store) {
  const groups = groupProjectsByCategory(projects);
  const groupsHtml = groups
    .map((group) => {
      const rowsHtml = group.items
        .map((project) => {
      const safeName = escapeHtml(project.name || 'Untitled Project');
      const safePath = escapeHtml(project.rootPath || '');
      const safeDescription = escapeHtml(project.description || '');
      const safeColor = escapeHtml(project.color || DEFAULT_COLORS[0]);
      const rootPayload = JSON.stringify(project.rootPath || '');
      const idPayload = JSON.stringify(project.id || '');

      return `
      <div class="row" data-root=${rootPayload} data-id=${idPayload} title="${safePath}">
        <span class="dot" style="background:${safeColor}"></span>
        <div class="text">
          <div class="name">${safeName}</div>
          ${safeDescription ? `<div class="desc">${safeDescription}</div>` : ''}
        </div>
      </div>`;
        })
        .join('');

      const categoryKey = escapeHtml(group.categoryName);
      return `
      <section class="category-group" data-category="${categoryKey}">
        <button class="category-toggle" data-category="${categoryKey}" title="${categoryKey}">
          <span class="chevron">▾</span>
          <span class="category-title">${categoryKey}</span>
        </button>
        <div class="list">${rowsHtml}</div>
      </section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Project Dashboard</title>
  <style>
    body { margin: 0; padding: 10px 10px 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    .add { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; user-select: none; color: var(--vscode-textLink-foreground); padding: 6px 6px; border-radius: 6px; }
    .add:hover { background: var(--vscode-list-hoverBackground); }
    .add .plus { font-weight: 600; width: 16px; display: inline-flex; justify-content: center; }
    .category-group { margin-bottom: 8px; }
    .category-toggle { width: 100%; display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--vscode-descriptionForeground); padding: 4px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.4px; font-size: 11px; cursor: pointer; }
    .category-toggle:hover { background: var(--vscode-list-hoverBackground); }
    .chevron { width: 10px; display: inline-flex; justify-content: center; font-size: 11px; transition: transform 0.12s ease; }
    .category-group.collapsed .chevron { transform: rotate(-90deg); }
    .category-group.collapsed .list { display: none; }
    .category-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list { display: grid; gap: 4px; }
    .row { display: grid; grid-template-columns: 18px 1fr; gap: 10px; align-items: center; padding: 8px 8px; border-radius: 8px; cursor: pointer; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .dot { width: 16px; height: 16px; border-radius: 999px; box-shadow: 0 0 0 2px rgba(255,255,255,0.06) inset; }
    .name { font-size: 13px; line-height: 1.2; }
    .desc { margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px 0; }
    .menu { position: fixed; z-index: 9999; display: none; min-width: 190px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 8px; padding: 6px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); }
    .menu button { width: 100%; text-align: left; background: transparent; border: 0; color: inherit; padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .menu button:hover { background: var(--vscode-list-hoverBackground); }
    .menu .danger { color: var(--vscode-errorForeground, #f14c4c); }
    .sep { height: 1px; background: var(--vscode-panel-border); margin: 6px 4px; opacity: 0.8; }
  </style>
</head>
<body>
  ${projects.length ? groupsHtml : '<div class="empty">No projects yet.</div>'}
  <div class="add" role="button" tabindex="0" onclick="addProject()"><span class="plus">+</span> Add new project</div>

  <div class="menu" id="menu" role="menu" aria-hidden="true">
    <button onclick="menuAction('open')">Open</button>
    <button onclick="menuAction('reveal')">Reveal in Finder</button>
    <div class="sep"></div>
    <button onclick="menuAction('edit')">Edit</button>
    <button class="danger" onclick="menuAction('delete')">Delete</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const persistedState = vscode.getState() || { collapsedCategories: [] };
    const menu = document.getElementById('menu');
    let menuTarget = null;
    const collapsedCategories = new Set(persistedState.collapsedCategories || []);

    function addProject() { vscode.postMessage({ command: 'addProject' }); }

    function openProject(rootPath) { vscode.postMessage({ command: 'openProject', rootPath }); }
    function removeProject(rootPath) { vscode.postMessage({ command: 'removeProject', rootPath }); }
    function editProject(id) { vscode.postMessage({ command: 'editProject', id }); }
    function revealInFinder(rootPath) { vscode.postMessage({ command: 'revealInFinder', rootPath }); }
    function saveState() { vscode.setState({ collapsedCategories: Array.from(collapsedCategories) }); }

    function hideMenu() {
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
      menuTarget = null;
    }

    function showMenu(x, y, target) {
      menuTarget = target;
      menu.style.display = 'block';
      menu.setAttribute('aria-hidden', 'false');
      const padding = 8;
      const maxX = window.innerWidth - menu.offsetWidth - padding;
      const maxY = window.innerHeight - menu.offsetHeight - padding;
      menu.style.left = Math.max(padding, Math.min(x, maxX)) + 'px';
      menu.style.top = Math.max(padding, Math.min(y, maxY)) + 'px';
    }

    function menuAction(action) {
      if (!menuTarget) return;
      const rootPath = menuTarget.getAttribute('data-root');
      const id = menuTarget.getAttribute('data-id');
      hideMenu();
      if (action === 'open') return openProject(rootPath);
      if (action === 'reveal') return revealInFinder(rootPath);
      if (action === 'edit') return editProject(id);
      if (action === 'delete') return removeProject(rootPath);
    }

    function findRow(el) {
      if (!el) return null;
      if (el.classList && el.classList.contains('row')) return el;
      return el.closest ? el.closest('.row') : null;
    }

    function applyCollapsedState() {
      document.querySelectorAll('.category-group').forEach((group) => {
        const key = group.getAttribute('data-category');
        if (collapsedCategories.has(key)) {
          group.classList.add('collapsed');
        } else {
          group.classList.remove('collapsed');
        }
      });
    }

    document.querySelectorAll('.category-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        const key = toggle.getAttribute('data-category');
        if (collapsedCategories.has(key)) {
          collapsedCategories.delete(key);
        } else {
          collapsedCategories.add(key);
        }
        applyCollapsedState();
        saveState();
      });
    });

    document.addEventListener('click', (e) => {
      const row = findRow(e.target);
      if (menu.style.display === 'block') hideMenu();
      if (row) {
        const rootPath = row.getAttribute('data-root');
        openProject(rootPath);
      }
    });

    document.addEventListener('contextmenu', (e) => {
      const row = findRow(e.target);
      if (!row) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, row);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideMenu();
    });

    window.addEventListener('blur', hideMenu);
    applyCollapsedState();
  </script>
</body>
</html>`;
}

async function refreshOpenDashboardPanel(store) {
  if (!dashboardPanelRef) {
    return;
  }
  const projects = await store.listProjects();
  dashboardPanelRef.webview.html = getDashboardHtml(dashboardPanelRef.webview, projects);
}

function getDashboardHtml(webview, projects) {
  const categories = sortCategories([...new Set(projects.map((project) => getCategoryLabel(project.category)))]);
  const filterButtonsHtml = [
    '<button class="filter-chip active" data-filter="__all__" type="button">All</button>',
    ...categories.map((category) => {
      const safeCategory = escapeHtml(category);
      return `<button class="filter-chip" data-filter="${safeCategory}" type="button">${safeCategory}</button>`;
    }),
  ].join('');

  const cardsHtml = projects
    .map((project) => {
      const safeName = escapeHtml(project.name || 'Untitled Project');
      const safeDescription = escapeHtml(project.description || '');
      const safePath = escapeHtml(project.rootPath || '');
      const safeCategory = escapeHtml(getCategoryLabel(project.category));
      const safeColor = escapeHtml(project.color || DEFAULT_COLORS[0]);
      const safeId = escapeHtml(project.id || '');

      return `
      <article class="project-card" data-root="${safePath}" data-id="${safeId}" data-category="${safeCategory}" title="${safePath}">
        <div class="card-top">
          <span class="dot" style="background:${safeColor}"></span>
          <span class="category-label">${safeCategory}</span>
        </div>
        <h3 class="card-title">${safeName}</h3>
        ${safeDescription ? `<p class="card-description">${safeDescription}</p>` : '<p class="card-description empty-description">No description</p>'}
      </article>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Project Dashboard</title>
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .shell { max-width: 980px; margin: 0 auto; padding: 28px 20px 36px; }
    .top-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
    .title { margin: 0; font-size: 18px; font-weight: 600; }
    .add { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 8px; padding: 6px 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    .add:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    .filter-chip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 5px 11px; background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; }
    .filter-chip:hover { background: var(--vscode-list-hoverBackground); }
    .filter-chip.active { background: var(--vscode-button-background); border-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .project-card { border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 10px 10px 14px; background: var(--vscode-sideBar-background); cursor: pointer; display: grid; align-content: start; gap: 6px; }
    .project-card:hover { border-color: var(--vscode-focusBorder); transform: translateY(-1px); }
    .card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .dot { width: 12px; height: 12px; border-radius: 999px; flex-shrink: 0; }
    .category-label { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-title { margin: 0; font-size: 14px; line-height: 1.2; }
    .card-description { margin: 0; font-size: 12px; line-height: 1.25; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .empty-description { opacity: 0.7; font-style: italic; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 10px; padding: 16px; }
    .no-results { display: none; margin-top: 6px; color: var(--vscode-descriptionForeground); }
    .menu { position: fixed; z-index: 9999; display: none; min-width: 190px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 8px; padding: 6px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); }
    .menu button { width: 100%; text-align: left; background: transparent; border: 0; color: inherit; padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .menu button:hover { background: var(--vscode-list-hoverBackground); }
    .menu .danger { color: var(--vscode-errorForeground, #f14c4c); }
    .sep { height: 1px; background: var(--vscode-panel-border); margin: 6px 4px; opacity: 0.8; }
  </style>
</head>
<body>
  <main class="shell">
    <div class="top-row">
      <h1 class="title">Projects</h1>
      <button class="add" type="button" onclick="addProject()">+ Add project</button>
    </div>
    ${projects.length ? `
      <section class="filters" id="filters">
        ${filterButtonsHtml}
      </section>
      <section class="cards" id="cards">
        ${cardsHtml}
      </section>
      <div class="no-results" id="noResults">No projects in this category.</div>
    ` : '<div class="empty">No projects yet.</div>'}
  </main>

  <div class="menu" id="menu" role="menu" aria-hidden="true">
    <button onclick="menuAction('open')">Open</button>
    <button onclick="menuAction('reveal')">Reveal in Finder</button>
    <div class="sep"></div>
    <button onclick="menuAction('edit')">Edit</button>
    <button class="danger" onclick="menuAction('delete')">Delete</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const persistedState = vscode.getState() || { activeFilter: '__all__' };
    const menu = document.getElementById('menu');
    const cardsRoot = document.getElementById('cards');
    const noResults = document.getElementById('noResults');
    let menuTarget = null;
    let activeFilter = persistedState.activeFilter || '__all__';

    function addProject() { vscode.postMessage({ command: 'addProject' }); }
    function openProject(rootPath) { vscode.postMessage({ command: 'openProject', rootPath }); }
    function removeProject(rootPath) { vscode.postMessage({ command: 'removeProject', rootPath }); }
    function editProject(id) { vscode.postMessage({ command: 'editProject', id }); }
    function revealInFinder(rootPath) { vscode.postMessage({ command: 'revealInFinder', rootPath }); }
    function saveState() { vscode.setState({ activeFilter }); }

    function hideMenu() {
      if (!menu) return;
      menu.style.display = 'none';
      menu.setAttribute('aria-hidden', 'true');
      menuTarget = null;
    }

    function showMenu(x, y, target) {
      if (!menu) return;
      menuTarget = target;
      menu.style.display = 'block';
      menu.setAttribute('aria-hidden', 'false');
      const padding = 8;
      const maxX = window.innerWidth - menu.offsetWidth - padding;
      const maxY = window.innerHeight - menu.offsetHeight - padding;
      menu.style.left = Math.max(padding, Math.min(x, maxX)) + 'px';
      menu.style.top = Math.max(padding, Math.min(y, maxY)) + 'px';
    }

    function menuAction(action) {
      if (!menuTarget) return;
      const rootPath = menuTarget.getAttribute('data-root');
      const id = menuTarget.getAttribute('data-id');
      hideMenu();
      if (action === 'open') return openProject(rootPath);
      if (action === 'reveal') return revealInFinder(rootPath);
      if (action === 'edit') return editProject(id);
      if (action === 'delete') return removeProject(rootPath);
    }

    function findCard(el) {
      if (!el) return null;
      if (el.classList && el.classList.contains('project-card')) return el;
      return el.closest ? el.closest('.project-card') : null;
    }

    function applyFilters() {
      if (!cardsRoot) return;
      let visibleCount = 0;
      cardsRoot.querySelectorAll('.project-card').forEach((card) => {
        const category = card.getAttribute('data-category') || '';
        const visible = activeFilter === '__all__' || category === activeFilter;
        card.style.display = visible ? '' : 'none';
        if (visible) visibleCount += 1;
      });
      if (noResults) {
        noResults.style.display = visibleCount ? 'none' : 'block';
      }
      document.querySelectorAll('.filter-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.getAttribute('data-filter') === activeFilter);
      });
    }

    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        activeFilter = chip.getAttribute('data-filter') || '__all__';
        saveState();
        applyFilters();
      });
    });

    document.addEventListener('click', (e) => {
      if (menu && menu.style.display === 'block') hideMenu();
      const card = findCard(e.target);
      if (!card) return;
      openProject(card.getAttribute('data-root'));
    });

    document.addEventListener('contextmenu', (e) => {
      const card = findCard(e.target);
      if (!card) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, card);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideMenu();
    });

    window.addEventListener('blur', hideMenu);
    applyFilters();
  </script>
</body>
</html>`;
}

async function openProjectFolder(rootPath) {
  if (!rootPath) {
    return;
  }
  const config = vscode.workspace.getConfiguration('projectDashboard');
  const forceNewWindow = config.get('openInNewWindow', false);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(rootPath), { forceNewWindow });
}

async function revealInFinder(rootPath) {
  if (!rootPath) {
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(rootPath));
}

async function pickColor(currentColor) {
  const items = NAMED_COLORS.map((item) => ({
    label: `${item.dot} ${item.name}`,
    description: item.hex === currentColor ? `${item.hex} (Current)` : item.hex,
    color: item.hex,
  }));
  items.unshift({ label: 'Random', description: 'Pick a random color', color: '' });

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Project color',
    placeHolder: 'Choose a color dot for this project',
  });
  if (!selected) {
    return undefined;
  }
  if (!selected.color) {
    return DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];
  }
  return selected.color;
}

async function pickCategory(projects, currentCategory) {
  const categories = getCustomCategories(projects);
  const items = categories.map((category) => ({
    label: `$(folder) ${category}`,
    category,
    description: category === normalizeCategory(currentCategory) ? 'Current' : '',
  }));

  items.unshift(
    {
      label: `$(add) Create new category...`,
      category: '__new__',
    },
    {
      label: `$(circle-slash) ${UNCATEGORIZED_LABEL}`,
      category: '',
      description: normalizeCategory(currentCategory) ? '' : 'Current',
    }
  );

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Project category',
    placeHolder: 'Assign a category to this project',
  });
  if (!selected) {
    return undefined;
  }

  if (selected.category === '__new__') {
    const created = await promptForCategoryName(categories);
    return created;
  }

  return selected.category;
}

async function promptForCategoryName(existingCategories) {
  const existingSet = new Set((existingCategories || []).map((c) => c.toLowerCase()));
  const categoryName = await vscode.window.showInputBox({
    prompt: 'New category name',
    placeHolder: 'e.g. Mobile Apps, Backend, Company A',
    validateInput: (value) => {
      const normalized = normalizeCategory(value);
      if (!normalized) {
        return 'Category name is required';
      }
      if (normalized.toLowerCase() === UNCATEGORIZED_LABEL.toLowerCase()) {
        return `"${UNCATEGORIZED_LABEL}" is reserved`;
      }
      if (existingSet.has(normalized.toLowerCase())) {
        return 'This category already exists';
      }
      return null;
    },
  });

  if (categoryName === undefined) {
    return undefined;
  }
  return normalizeCategory(categoryName);
}

async function addProjectFlow(store, provider) {
  const existingProjects = await store.listProjects();
  const folderUris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Select project folder',
  });
  if (!folderUris || folderUris.length === 0) {
    return;
  }
  const rootPath = folderUris[0].fsPath;

  const defaultName = path.basename(rootPath);
  const name = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: defaultName,
    validateInput: (value) => (!value || !value.trim() ? 'Name is required' : null),
  });
  if (!name) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'Project description',
    placeHolder: 'Short summary of the project',
  });
  if (description === undefined) {
    return;
  }

  const color = await pickColor();
  if (color === undefined) {
    return;
  }

  const category = await pickCategory(existingProjects);
  if (category === undefined) {
    return;
  }

  await store.addProject({
    name: name.trim(),
    description: description.trim(),
    rootPath,
    color,
    category,
  });

  await provider.refresh();
  vscode.window.showInformationMessage('Project saved to Project Dashboard.');
}

async function editProjectFlow(store, provider, id) {
  if (!id) {
    return;
  }
  const projects = await store.listProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    vscode.window.showWarningMessage('Project not found.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Project name',
    value: project.name || '',
    validateInput: (value) => (!value || !value.trim() ? 'Name is required' : null),
  });
  if (!name) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'Project description',
    value: project.description || '',
  });
  if (description === undefined) {
    return;
  }

  const color = await pickColor(project.color);
  if (color === undefined) {
    return;
  }

  const category = await pickCategory(projects, project.category);
  if (category === undefined) {
    return;
  }

  const result = await store.updateProjectById(id, {
    name: name.trim(),
    description: description.trim(),
    color,
    category,
  });

  if (!result) {
    vscode.window.showWarningMessage('Could not update project.');
    return;
  }

  await provider.refresh();
}

async function removeProjectFlow(store, provider) {
  const projects = await store.listProjects();
  if (!projects.length) {
    vscode.window.showInformationMessage('No saved projects to remove.');
    return;
  }

  const picks = projects.map((item) => ({
    label: item.name,
    description: item.rootPath,
    rootPath: item.rootPath,
  }));
  const selected = await vscode.window.showQuickPick(picks, {
    title: 'Remove project',
    placeHolder: 'Select a project to remove from dashboard',
  });
  if (!selected) {
    return;
  }

  await store.removeProjectByRootPath(selected.rootPath);
  await provider.refresh();
}

async function createCategoryFlow(store, provider) {
  const projects = await store.listProjects();
  const created = await promptForCategoryName(getCustomCategories(projects));
  if (created === undefined) {
    return;
  }
  vscode.window.showInformationMessage(`Category "${created}" created. Assign it when adding or editing a project.`);
  await provider.refresh();
}

async function renameCategoryFlow(store, provider) {
  const projects = await store.listProjects();
  const categories = getCustomCategories(projects);
  if (!categories.length) {
    vscode.window.showInformationMessage('No categories to rename yet.');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    categories.map((category) => ({ label: category, category })),
    { title: 'Rename category' }
  );
  if (!selected) {
    return;
  }

  const updatedName = await promptForCategoryName(categories.filter((c) => c !== selected.category));
  if (updatedName === undefined) {
    return;
  }

  const updatedProjects = projects.map((project) => {
    if (normalizeCategory(project.category) === selected.category) {
      return { ...project, category: updatedName, updatedAt: new Date().toISOString() };
    }
    return project;
  });
  await store.updateProjects(updatedProjects);
  await provider.refresh();
}

async function deleteCategoryFlow(store, provider) {
  const projects = await store.listProjects();
  const categories = getCustomCategories(projects);
  if (!categories.length) {
    vscode.window.showInformationMessage('No categories to delete yet.');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    categories.map((category) => ({ label: category, category })),
    { title: 'Delete category' }
  );
  if (!selected) {
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: `Move projects to ${UNCATEGORIZED_LABEL}`, value: 'uncategorized' },
      { label: 'Cancel', value: 'cancel' },
    ],
    { title: `Delete "${selected.category}"` }
  );
  if (!choice || choice.value === 'cancel') {
    return;
  }

  const updatedProjects = projects.map((project) => {
    if (normalizeCategory(project.category) === selected.category) {
      return { ...project, category: '', updatedAt: new Date().toISOString() };
    }
    return project;
  });
  await store.updateProjects(updatedProjects);
  await provider.refresh();
}

async function createDashboardPanel(store, provider, context) {
  const projects = await store.listProjects();

  if (dashboardPanelRef) {
    dashboardPanelRef.reveal(vscode.ViewColumn.One);
    dashboardPanelRef.webview.html = getDashboardHtml(dashboardPanelRef.webview, projects);
    return dashboardPanelRef;
  }

  const panel = vscode.window.createWebviewPanel('projectDashboardPanel', 'Project Dashboard', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  dashboardPanelRef = panel;
  panel.webview.html = getDashboardHtml(panel.webview, projects);

  panel.onDidDispose(() => {
    dashboardPanelRef = null;
  });

  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'openProject':
          await openProjectFolder(message.rootPath);
          return;
        case 'removeProject':
          await store.removeProjectByRootPath(message.rootPath);
          await provider.refresh();
          return;
        case 'addProject':
          await addProjectFlow(store, provider);
          return;
        case 'editProject':
          await editProjectFlow(store, provider, message.id);
          return;
        case 'revealInFinder':
          await revealInFinder(message.rootPath);
          return;
        default:
          return;
      }
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

function activate(context) {
  const store = new ProjectStore(context);
  const provider = new ProjectDashboardViewProvider(context, store);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('projectDashboard.projectsView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.addProject', async () => {
      await addProjectFlow(store, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.editProject', async () => {
      const projects = await store.listProjects();
      if (!projects.length) {
        vscode.window.showInformationMessage('No saved projects to edit.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        projects.map((item) => ({ label: item.name, description: item.rootPath, id: item.id })),
        { title: 'Edit project' }
      );
      if (!selected) {
        return;
      }
      await editProjectFlow(store, provider, selected.id);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.createCategory', async () => {
      await createCategoryFlow(store, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.renameCategory', async () => {
      await renameCategoryFlow(store, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.deleteCategory', async () => {
      await deleteCategoryFlow(store, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.removeProject', async () => {
      await removeProjectFlow(store, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.openProject', async () => {
      const projects = await store.listProjects();
      const selected = await vscode.window.showQuickPick(
        projects.map((item) => ({ label: item.name, description: item.rootPath, rootPath: item.rootPath })),
        { title: 'Open project' }
      );
      if (selected) {
        await openProjectFolder(selected.rootPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.revealInFinder', async () => {
      const projects = await store.listProjects();
      const selected = await vscode.window.showQuickPick(
        projects.map((item) => ({ label: item.name, description: item.rootPath, rootPath: item.rootPath })),
        { title: 'Reveal in Finder' }
      );
      if (selected) {
        await revealInFinder(selected.rootPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectDashboard.open', async () => {
      await createDashboardPanel(store, provider, context);
    })
  );

  const dashConfig = vscode.workspace.getConfiguration('projectDashboard');
  if (dashConfig.get('showDashboardOnStartup', true)) {
    const onlyWhenEmpty = dashConfig.get('showDashboardOnlyWhenEmpty', true);
    const folders = vscode.workspace.workspaceFolders;
    const isEmpty = !folders || folders.length === 0;
    if (!onlyWhenEmpty || isEmpty) {
      setTimeout(() => {
        createDashboardPanel(store, provider, context).catch(() => {});
      }, 300);
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
