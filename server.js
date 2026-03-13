const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const WORK_DIR = '/tmp/nexus_workspace';
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ── In-Memory Storage ──
const store = { memory:{}, todos:{}, history:{} };
function getObj(obj, s){ if(!obj[s])obj[s]={}; return obj[s]; }
function getArr(obj, s){ if(!obj[s])obj[s]=[]; return obj[s]; }

// ── Health ──
app.get('/', (req, res) => res.json({
  status: 'NEXUS Online',
  version: '3.0',
  features: ['execute','memory','todos','history','fetch','browse','vision','build','vite','git'],
  storage: 'in-memory'
}));

// ── Execute Code ──
app.post('/execute', async (req, res) => {
  const { code, language, filename } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  const dir = path.join(WORK_DIR, Date.now().toString());
  fs.mkdirSync(dir, { recursive: true });
  const fname = filename || (language==='python'?'script.py':language==='node'?'script.js':'script.sh');
  const fp = path.join(dir, fname);
  fs.writeFileSync(fp, code);
  try {
    let stdout='', stderr='';
    const opts = { timeout:30000, cwd:dir };
    if(language==='python')     ({stdout,stderr}=await execAsync(`python3 "${fp}"`,opts));
    else if(language==='node')  ({stdout,stderr}=await execAsync(`node "${fp}"`,opts));
    else if(language==='bash')  ({stdout,stderr}=await execAsync(`bash "${fp}"`,opts));
    else stdout='File created';
    const files=fs.readdirSync(dir).map(f=>{
      const p=path.join(dir,f); let content='';
      try{content=fs.readFileSync(p,'utf8');}catch{}
      return{name:f,size:fs.statSync(p).size,content};
    });
    res.json({success:true,stdout,stderr,files});
  } catch(err){ res.json({success:false,stdout:'',stderr:err.message,files:[]}); }
});

// ── Install ──
app.post('/install', async (req, res) => {
  const { packages, manager } = req.body;
  if (!packages?.length) return res.status(400).json({ error: 'No packages' });
  try {
    const cmd = manager==='pip'
      ? `pip install ${packages.join(' ')} --quiet 2>&1`
      : `npm install ${packages.join(' ')} 2>&1`;
    const {stdout} = await execAsync(cmd, {timeout:120000});
    res.json({success:true,output:stdout});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── Memory ──
app.post('/memory/set',(req,res)=>{
  const{session='default',key,value}=req.body;
  if(!key)return res.status(400).json({error:'No key'});
  getObj(store.memory,session)[key]=value;
  res.json({success:true});
});
app.post('/memory/get',(req,res)=>{
  const{session='default',key}=req.body;
  res.json({success:true,value:getObj(store.memory,session)[key]??null});
});
app.post('/memory/all',(req,res)=>{
  const{session='default'}=req.body;
  res.json({success:true,data:getObj(store.memory,session)});
});

// ── Todos ──
app.post('/todos/add',(req,res)=>{
  const{session='default',task}=req.body;
  if(!task)return res.status(400).json({error:'No task'});
  getArr(store.todos,session).push({task,done:false,ts:Date.now()});
  res.json({success:true});
});
app.post('/todos/done',(req,res)=>{
  const{session='default',task}=req.body;
  const t=getArr(store.todos,session).find(x=>x.task===task);
  if(t)t.done=true;
  res.json({success:true});
});
app.post('/todos/list',(req,res)=>{
  const{session='default'}=req.body;
  res.json({success:true,todos:getArr(store.todos,session)});
});

// ── History ──
app.post('/history/add',(req,res)=>{
  const{session='default',role,content}=req.body;
  const h=getArr(store.history,session);
  h.push({role,content,ts:Date.now()});
  if(h.length>50)store.history[session]=h.slice(-50);
  res.json({success:true});
});
app.post('/history/get',(req,res)=>{
  const{session='default',limit=20}=req.body;
  res.json({success:true,messages:getArr(store.history,session).slice(-limit)});
});
app.post('/history/clear',(req,res)=>{
  const{session='default'}=req.body;
  store.history[session]=[];store.todos[session]=[];store.memory[session]={};
  res.json({success:true});
});

// ── Fetch URL (basic) ──
app.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });
  try {
    const {stdout} = await execAsync(
      `curl -s -L --max-time 15 --compressed -A "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" "${url.replace(/"/g,'')}" | head -c 80000`,
      {timeout:20000}
    );
    const clean=stdout
      .replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<style[\s\S]*?<\/style>/gi,'')
      .replace(/<[^>]+>/g,' ')
      .replace(/\s+/g,' ').trim().substring(0,8000);
    res.json({success:true,content:stdout,text:clean});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── Browse with Puppeteer ──
app.post('/browse', async (req, res) => {
  const { url, action='content', selector='', script='' } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });

  // تحقق من وجود puppeteer
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch {
    // fallback to basic fetch
    try {
      const {stdout} = await execAsync(
        `curl -s -L --max-time 20 -A "Mozilla/5.0" "${url.replace(/"/g,'')}" | head -c 100000`,
        {timeout:25000}
      );
      const clean=stdout.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,10000);
      return res.json({success:true,content:clean,method:'curl'});
    } catch(e){ return res.json({success:false,error:'No browser available: '+e.message}); }
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      headless: 'new'
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120');
    await page.goto(url, {waitUntil:'networkidle2',timeout:20000});

    let result = {};

    if(action==='screenshot'){
      const shot = await page.screenshot({encoding:'base64',fullPage:false});
      result = {screenshot: shot, type:'base64'};
    } else if(action==='click' && selector){
      await page.click(selector);
      await page.waitForTimeout(1000);
      result = {content: await page.content()};
    } else if(action==='fill' && selector && script){
      await page.type(selector, script);
      result = {content:'Filled: '+selector};
    } else if(action==='extract' && selector){
      const text = await page.$eval(selector, el=>el.innerText).catch(()=>'Not found');
      result = {text};
    } else if(action==='links'){
      const links = await page.$$eval('a[href]', els=>els.slice(0,20).map(e=>({text:e.innerText.trim(),href:e.href})));
      result = {links};
    } else {
      // default: get content
      const content = await page.evaluate(()=>{
        document.querySelectorAll('script,style,nav,footer,header,aside').forEach(e=>e.remove());
        return document.body?.innerText||document.body?.textContent||'';
      });
      result = {text: content.replace(/\s+/g,' ').trim().substring(0,8000)};
    }

    res.json({success:true, url, action, ...result, method:'puppeteer'});
  } catch(err){
    res.json({success:false, error:err.message});
  } finally {
    if(browser) await browser.close().catch(()=>{});
  }
});

// ── Screenshot & Vision Analysis ──
app.post('/vision', async (req, res) => {
  const { url, question='ماذا ترى في هذه الصفحة؟' } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL' });

  let screenshot = null;

  // حاول تصوير الصفحة
  try {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
      args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      headless:'new'
    });
    const page = await browser.newPage();
    await page.setViewport({width:1280,height:720});
    await page.goto(url,{waitUntil:'networkidle2',timeout:15000});
    screenshot = await page.screenshot({encoding:'base64'});
    await browser.close();
  } catch(e){
    return res.json({success:false, error:'Screenshot failed: '+e.message, note:'Install chromium for vision support'});
  }

  res.json({success:true, screenshot, question, note:'Send screenshot to vision model on frontend'});
});

// ── Build Vite/React Project ──
app.post('/build/vite', async (req, res) => {
  const { files={}, template='react' } = req.body;
  const buildDir = path.join(WORK_DIR, 'vite_'+Date.now());
  fs.mkdirSync(buildDir, {recursive:true});
  try {
    // كتابة ملفات المشروع
    for(const [fname, content] of Object.entries(files)){
      const fp = path.join(buildDir, fname);
      fs.mkdirSync(path.dirname(fp), {recursive:true});
      fs.writeFileSync(fp, content);
    }

    // إنشاء package.json لو مش موجود
    if(!files['package.json']){
      fs.writeFileSync(path.join(buildDir,'package.json'), JSON.stringify({
        name:'nexus-app',version:'1.0.0',
        scripts:{dev:'vite',build:'vite build',preview:'vite preview'},
        dependencies:{react:'^18.0.0','react-dom':'^18.0.0'},
        devDependencies:{'@vitejs/plugin-react':'^4.0.0',vite:'^4.0.0'}
      },null,2));
    }

    // إنشاء vite.config.js لو مش موجود
    if(!files['vite.config.js'] && !files['vite.config.ts']){
      fs.writeFileSync(path.join(buildDir,'vite.config.js'),
        `import{defineConfig}from'vite';import react from'@vitejs/plugin-react';export default defineConfig({plugins:[react()],build:{outDir:'dist'}});`
      );
    }

    // npm install
    await execAsync('npm install --legacy-peer-deps 2>&1', {cwd:buildDir, timeout:120000});

    // npm run build
    const {stdout,stderr} = await execAsync('npm run build 2>&1', {cwd:buildDir, timeout:90000});

    // جمع ملفات dist
    const distDir = path.join(buildDir,'dist');
    const distFiles = {};
    if(fs.existsSync(distDir)){
      const walk=(dir)=>{
        for(const f of fs.readdirSync(dir)){
          const fp=path.join(dir,f);
          if(fs.statSync(fp).isDirectory()){walk(fp);continue;}
          try{distFiles[path.relative(distDir,fp)]=fs.readFileSync(fp,'utf8');}catch{}
        }
      };
      walk(distDir);
    }

    res.json({success:true, output:stdout+stderr, files:distFiles, buildDir});
  } catch(err){ res.json({success:false, error:err.message}); }
});

// ── Build General ──
app.post('/build', async (req, res) => {
  const { files, buildCmd } = req.body;
  if (!files) return res.status(400).json({ error: 'No files' });
  const buildDir = path.join(WORK_DIR, 'build_'+Date.now());
  fs.mkdirSync(buildDir, {recursive:true});
  try {
    for(const [name, content] of Object.entries(files)){
      const fp=path.join(buildDir,name);
      fs.mkdirSync(path.dirname(fp),{recursive:true});
      fs.writeFileSync(fp,content);
    }
    let output='Files written';
    if(buildCmd){const{stdout}=await execAsync(buildCmd,{cwd:buildDir,timeout:120000});output=stdout;}
    const allFiles={};
    const walk=(dir)=>{for(const f of fs.readdirSync(dir)){const fp=path.join(dir,f);if(fs.statSync(fp).isDirectory()){walk(fp);continue;}try{allFiles[path.relative(buildDir,fp)]=fs.readFileSync(fp,'utf8');}catch{}}};
    walk(buildDir);
    res.json({success:true,output,files:allFiles});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── File System ──
app.post('/files/write',(req,res)=>{
  const{filePath,content}=req.body;
  try{const full=path.join(WORK_DIR,filePath);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,content);res.json({success:true});}
  catch(err){res.json({success:false,error:err.message});}
});
app.get('/files/read',(req,res)=>{
  try{res.json({success:true,content:fs.readFileSync(path.join(WORK_DIR,req.query.filePath),'utf8')});}
  catch(err){res.json({success:false,error:err.message});}
});
app.get('/files/list',(req,res)=>{
  try{
    const dir=req.query.dir?path.join(WORK_DIR,req.query.dir):WORK_DIR;
    const files=fs.readdirSync(dir).map(f=>{const fp=path.join(dir,f);const s=fs.statSync(fp);return{name:f,size:s.size,isDir:s.isDirectory()};});
    res.json({success:true,files});
  }catch(err){res.json({success:false,error:err.message});}
});

// ── Git Push ──
app.post('/git/push', async (req, res) => {
  const { token, repo, files, message='NEXUS commit' } = req.body;
  if (!token||!repo||!files) return res.status(400).json({ error: 'Missing params' });
  const repoDir = path.join(WORK_DIR, 'git_'+Date.now());
  fs.mkdirSync(repoDir, {recursive:true});
  try {
    for(const [fname, content] of Object.entries(files)){
      const fp=path.join(repoDir,fname);
      fs.mkdirSync(path.dirname(fp),{recursive:true});
      fs.writeFileSync(fp,content);
    }
    const remote=`https://${token}@github.com/${repo}.git`;
    const {stdout}=await execAsync([
      'git init','git config user.email "nexus@agent.ai"','git config user.name "NEXUS"',
      'git add .',`git commit -m "${message}"`,
      `git remote add origin ${remote}`,
      'git push -u origin main --force 2>&1 || git push -u origin master --force 2>&1'
    ].join(' && '),{cwd:repoDir,timeout:60000});
    res.json({success:true,output:stdout});
  } catch(err){ res.json({success:false,error:err.message}); }
});

// ── Install Chromium ──
app.post('/install/chromium', async (req, res) => {
  try {
    const {stdout} = await execAsync('which chromium-browser || which chromium || which google-chrome || echo "not found"');
    if(stdout.includes('not found')){
      await execAsync('apt-get install -y chromium-browser 2>&1 || apt-get install -y chromium 2>&1', {timeout:120000});
    }
    res.json({success:true, path:stdout.trim()});
  } catch(err){ res.json({success:false,error:err.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEXUS v3.0 running on port ${PORT}`));
