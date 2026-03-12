const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const WORK_DIR = '/tmp/nexus_workspace';
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });
app.get('/', (req, res) => res.json({ status: 'NEXUS Online' }));
app.post('/execute', async (req, res) => {
  const { code, language, filename } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  const sessionDir = path.join(WORK_DIR, Date.now().toString());
  fs.mkdirSync(sessionDir, { recursive: true });
  const fname = filename || (language === 'python' ? 'script.py' : language === 'node' ? 'script.js' : 'script.sh');
  const filePath = path.join(sessionDir, fname);
  fs.writeFileSync(filePath, code);
  try {
    let stdout = '', stderr = '';
    if (language === 'python') ({ stdout, stderr } = await execAsync(`python3 "${filePath}"`, { timeout: 30000 }));
    else if (language === 'node') ({ stdout, stderr } = await execAsync(`node "${filePath}"`, { timeout: 30000 }));
    else if (language === 'bash') ({ stdout, stderr } = await execAsync(`bash "${filePath}"`, { timeout: 30000 }));
    else stdout = 'File created';
    const files = fs.readdirSync(sessionDir).map(f => { const fp = path.join(sessionDir, f); let content = ''; try { content = fs.readFileSync(fp, 'utf8'); } catch {} return { name: f, size: fs.statSync(fp).size, content }; });
    res.json({ success: true, stdout, stderr, files });
  } catch (err) {
    res.json({ success: false, stdout: '', stderr: err.message, files: [] });
  }
});
app.post('/install', async (req, res) => {
  const { packages, manager } = req.body;
  if (!packages?.length) return res.status(400).json({ error: 'No packages' });
  try {
    const cmd = manager === 'pip' ? `pip install ${packages.join(' ')} --quiet` : `npm install ${packages.join(' ')}`;
    const { stdout } = await execAsync(cmd, { timeout: 60000 });
    res.json({ success: true, output: stdout });
  } catch (err) { res.json({ success: false, error: err.message }); }
});
app.post('/files/write', (req, res) => {
  const { filePath, content } = req.body;
  try { const full = path.join(WORK_DIR, filePath); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});
app.get('/files/read', (req, res) => {
  try { res.json({ success: true, content: fs.readFileSync(path.join(WORK_DIR, req.query.filePath), 'utf8') }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});
app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try { const { stdout } = await execAsync(`curl -s -L --max-time 15 -A "Mozilla/5.0" "${url}" | head -c 50000`, { timeout: 20000 }); res.json({ success: true, content: stdout }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});
app.post('/build', async (req, res) => {
  const { files, buildCmd } = req.body;
  if (!files) return res.status(400).json({ error: 'No files' });
  const buildDir = path.join(WORK_DIR, 'build_' + Date.now());
  fs.mkdirSync(buildDir, { recursive: true });
  try {
    for (const [name, content] of Object.entries(files)) { const fp = path.join(buildDir, name); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); }
    let output = 'Done';
    if (buildCmd) { const { stdout } = await execAsync(buildCmd, { cwd: buildDir, timeout: 60000 }); output = stdout; }
    const allFiles = {};
    const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); if (fs.statSync(fp).isDirectory()) { walk(fp); continue; } try { allFiles[path.relative(buildDir, fp)] = fs.readFileSync(fp, 'utf8'); } catch {} } };
    walk(buildDir);
    res.json({ success: true, output, files: allFiles });
  } catch (err) { res.json({ success: false, error: err.message }); }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXUS running on port ${PORT}`));
