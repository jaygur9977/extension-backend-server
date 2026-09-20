const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = 3030;

// ==================== IN-MEMORY STATE ====================
let explorerState = {
  hasRootFolder: false,
  rootFolderName: null,
  openFiles: [],
  activeFile: null,
  tree: null,           // ← Full folder tree
  fileCache: {},        // ← { "path/to/file.js": "content..." }
  lastUpdate: null
};

// ==================== SERVE UI ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'vscode.html'));
});

// ==================== HEALTH ====================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vscode-explorer',
    port: PORT,
    hasFolder: explorerState.hasRootFolder,
    folderName: explorerState.rootFolderName
  });
});

// ==================== STATE API ====================
app.post('/api/state', (req, res) => {
  const { tree, ...rest } = req.body;
  explorerState = {
    ...explorerState,
    ...rest,
    lastUpdate: new Date().toISOString()
  };
  if (tree) explorerState.tree = tree;
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json({
    hasRootFolder: explorerState.hasRootFolder,
    rootFolderName: explorerState.rootFolderName,
    openFiles: explorerState.openFiles,
    activeFile: explorerState.activeFile,
    lastUpdate: explorerState.lastUpdate
  });
});

// ==================== TREE API ====================
app.get('/api/tree', (req, res) => {
  if (!explorerState.tree) {
    return res.status(404).json({
      error: 'No folder open. Click "Open Folder" in explorer tab first.'
    });
  }
  res.json({
    root: explorerState.rootFolderName,
    tree: explorerState.tree
  });
});

// ==================== FILE READ (from cache) ====================
app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path query required' });

  const content = explorerState.fileCache[filePath];
  if (content === undefined) {
    return res.status(404).json({
      error: `File "${filePath}" not in cache. Open it in explorer first.`,
      cached_files: Object.keys(explorerState.fileCache)
    });
  }
  res.json({ path: filePath, content });
});

// ==================== FILE UPDATE CACHE (POST from explorer) ====================
app.post('/api/file-cache', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  explorerState.fileCache[filePath] = content;
  res.json({ ok: true });
});

// ==================== WILDCARD ROUTE — /api/<folder>/<file> ====================
// Shortcut for reading files: http://localhost:3030/api/src/index.js
app.get('/api/{*filePath}', (req, res) => {
  const filePath = req.params.filePath;

  // Handle known reserved routes first (already handled above)
  if (!filePath || filePath === 'state' || filePath === 'tree' || filePath === 'file' || filePath === 'file-cache') {
    return res.status(404).json({ error: 'not found' });
  }

  // Try to read from cache
  const content = explorerState.fileCache[filePath];
  if (content !== undefined) {
    return res.json({ path: filePath, content });
  }

  // Not in cache — return metadata + hint
  res.status(404).json({
    error: `File "${filePath}" not loaded. Use extension to open it, or check /api/tree.`,
    hint: 'Open the file in explorer tab to cache it, then retry'
  });
});



// ==================== STATUS (human-readable) ====================
app.get('/api/xyz', (req, res) => {
  res.json({
    folder: explorerState.rootFolderName || 'NONE',
    hasFolder: explorerState.hasRootFolder,
    openFiles: explorerState.openFiles?.map(f => f.path) || [],
    activeFile: explorerState.activeFile?.path || 'none',
    lastUpdate: explorerState.lastUpdate,
    hint: 'Visit /api/tree for full structure, /api/file?path=X for file content'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    service: 'vscode-explorer',
    hasFolder: explorerState.hasRootFolder,
    folderName: explorerState.rootFolderName,
    openFilesCount: explorerState.openFiles?.length || 0,
    lastUpdate: explorerState.lastUpdate
  });
});

// ==================== TREE ====================
app.get('/api/tree', (req, res) => {
  if (!explorerState.tree) {
    return res.status(404).json({ error: 'No folder open yet' });
  }
  res.json({
    root: explorerState.rootFolderName,
    tree: explorerState.tree
  });
});

// ==================== START ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VSCode Explorer: http://localhost:${PORT}`);
  console.log(`State API:       http://localhost:${PORT}/api/state`);
  console.log(`Tree API:        http://localhost:${PORT}/api/tree`);
  console.log(`File API:        http://localhost:${PORT}/api/file?path=<path>`);
  console.log(`Wildcard:        http://localhost:${PORT}/api/<folder>/<file>`);
});