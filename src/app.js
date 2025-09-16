// Smooth Bible - main module
// - Robust data loader (inline JSON, single-file, or per-book)
// - Simple router (#/Book/Chapter[/Verse])
// - Reader rendering with paragraph/verse spans
// - Non-blocking search via Web Worker
// - Offline support handshake with service worker

import { Data } from './data.js';

const els = {
  drawer: document.getElementById('drawer'),
  menuBtn: document.getElementById('menuBtn'),
  themeToggle: document.getElementById('themeToggle'),
  themeSelect: document.getElementById('themeSelect'),
  fontSelect : document.getElementById('fontSelect'),
  fontSize   : document.getElementById('fontSize'),
  lineHeight : document.getElementById('lineHeight'),
  showVerses : document.getElementById('showVerses'),
  bookSel: document.getElementById('bookSelect'),
  chapSel: document.getElementById('chapterSelect'),
  ref: document.getElementById('ref'),
  reader: document.getElementById('reader'),
  searchInput: document.getElementById('searchInput'),
  results: document.getElementById('searchResults'),
  resultsList: document.getElementById('resultsList'),
  closeResults: document.getElementById('closeResults'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('paletteInput'),
  paletteList: document.getElementById('paletteList'),
  swStatus: document.getElementById('swStatus'),
  paletteBtn: document.getElementById('paletteBtn'),
};

const prefs = {
  get(key, fallback){ try{ return JSON.parse(localStorage.getItem(key)) ?? fallback }catch{ return fallback } },
  set(key, val){ localStorage.setItem(key, JSON.stringify(val)) }
};

// --- UI wiring
function toggleDrawer(open){
  els.drawer.classList.toggle('open', open ?? !els.drawer.classList.contains('open'));
}
els.menuBtn.addEventListener('click', ()=> toggleDrawer());
document.addEventListener('keydown', (e)=>{
  if(e.key === '.') toggleDrawer();
  if(e.key === 'Escape'){ els.palette.hidden = true; els.results.hidden = true; toggleDrawer(false); }
  if(e.key === '/' && document.activeElement !== els.searchInput){ e.preventDefault(); els.searchInput.focus(); }
  if((e.key.toLowerCase()==='k') && (e.ctrlKey || e.metaKey)){ e.preventDefault(); openPalette(); }
});
els.paletteBtn.addEventListener('click', ()=> openPalette());

// Theme & type
function applyTheme(value){
  const html = document.documentElement;
  html.classList.remove('theme-light','theme-dark','theme-sepia');
  if(value === 'light') html.classList.add('theme-light');
  else if(value === 'dark') html.classList.add('theme-dark');
  else if(value === 'sepia') html.classList.add('theme-sepia');
}
function applyFont(value){
  const html = document.documentElement;
  html.classList.remove('font-serif','font-sans','font-mono');
  html.classList.add(value === 'mono' ? 'font-mono' : value === 'sans' ? 'font-sans' : 'font-serif');
}
function applySize(px){
  const html = document.documentElement;
  for(let i=15;i<=22;i++) html.classList.remove(`size-${i}`);
  html.classList.add(`size-${px}`);
}
function applyLineHeight(v){ document.documentElement.style.setProperty('--lh', v); }

// Persist + restore UI prefs
function restorePrefs(){
  const theme = prefs.get('theme','auto'); els.themeSelect.value = theme; applyTheme(theme);
  const font  = prefs.get('font','serif'); els.fontSelect.value = font; applyFont(font);
  const size  = prefs.get('size',18); els.fontSize.value = size; applySize(size);
  const lh    = prefs.get('lh',1.5); els.lineHeight.value = lh; applyLineHeight(lh);
  const show  = prefs.get('showVerses', true); els.showVerses.checked = show;
  document.body.classList.toggle('hide-verse-numbers', !show);
}
restorePrefs();
els.themeSelect.addEventListener('change', (e)=>{ prefs.set('theme', e.target.value); applyTheme(e.target.value); });
els.fontSelect.addEventListener('change', (e)=>{ prefs.set('font', e.target.value); applyFont(e.target.value); });
els.fontSize.addEventListener('input', (e)=>{ const v=Number(e.target.value); prefs.set('size', v); applySize(v); });
els.lineHeight.addEventListener('input', (e)=>{ const v=Number(e.target.value); prefs.set('lh', v); applyLineHeight(v); });
els.showVerses.addEventListener('change', (e)=>{ prefs.set('showVerses', e.target.checked); document.body.classList.toggle('hide-verse-numbers', !e.target.checked); });
// Theme toggle button: flip light/dark quickly
els.themeToggle?.addEventListener('click', ()=>{
  const cur = els.themeSelect.value;
  const next = cur === 'dark' ? 'light' : 'dark';
  els.themeSelect.value = next;
  prefs.set('theme', next);
  applyTheme(next);
});

// --- Data + router
const data = new Data({
  singleFile: 'data/kjv.json',   // optional: single-file if not inlined
  perBookDir: 'data/books/',     // optional: per-book fallback
  canonFile : 'data/canon.json', // used only if neither inline nor single-file are available
});

function setBusy(b){ els.reader.setAttribute('aria-busy', String(b)); }

async function init(){
  setBusy(true);
  await data.init();
  populateBookSelect();
  window.addEventListener('hashchange', route);
   // hide search results on navigation
   window.addEventListener('hashchange', ()=>{ els.results.hidden = true; });
  if(!location.hash) location.hash = `#/${encodeURIComponent(data.books[0])}/1`;
  await route();
  setupSearch();
  registerSW();
  setBusy(false);
}

function populateBookSelect(){
  els.bookSel.innerHTML = '';
  for(const b of data.books){
    const opt = document.createElement('option');
    opt.value = b; opt.textContent = b;
    els.bookSel.appendChild(opt);
  }
  els.bookSel.addEventListener('change', async ()=>{
    const book = els.bookSel.value;
    const chap = 1;
    location.hash = `#/${encodeURIComponent(book)}/${chap}`;
  });
  els.chapSel.addEventListener('change', ()=>{
    const book = els.bookSel.value;
    const chap = Number(els.chapSel.value);
    location.hash = `#/${encodeURIComponent(book)}/${chap}`;
  });
}

async function route(){
  const m = location.hash.match(/^#\/([^\/]+)\/(\d+)(?:\/(\d+))?$/);
  let book = decodeURIComponent(m?.[1] || data.books[0]);
  let chap = Number(m?.[2] || 1);
  const verse = m?.[3] ? Number(m[3]) : null;

  if(!data.hasBook(book)) book = data.books[0];
  chap = Math.min(Math.max(1, chap), data.chapterCount(book));

  els.bookSel.value = book;
  els.chapSel.innerHTML = '';
  for(let i=1;i<=data.chapterCount(book);i++){
    const o=document.createElement('option');
    o.value=String(i); o.textContent=String(i);
    els.chapSel.appendChild(o);
  }
  els.chapSel.value = String(chap);
  els.ref.textContent = `${book} ${chap}`;

  await renderChapter(book, chap);

  if(verse){
    const id = verseId(book, chap, verse);
    const node = document.getElementById(id);
    if(node){
      node.scrollIntoView({ behavior:'smooth', block:'center' });
      node.classList.add('accent');
      setTimeout(()=> node.classList.remove('accent'), 1200);
    }
  }else{
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function verseId(book, chap, v){
  return `v-${encodeURIComponent(book)}-${chap}-${v}`;
}

async function renderChapter(book, chap){
  setBusy(true);
  const verses = await data.getChapter(book, chap);
  els.reader.innerHTML = '';
  const h = document.createElement('h1'); h.textContent = `${book} ${chap}`; els.reader.appendChild(h);
  let currentPara = document.createElement('p'); currentPara.className = 'para'; els.reader.appendChild(currentPara);
  for(const v of verses){
    if(v.paragraphStart && currentPara.childNodes.length){
      currentPara = document.createElement('p'); currentPara.className='para'; els.reader.appendChild(currentPara);
    }
    const span = document.createElement('span'); span.className = 'verse';
    const n = document.createElement('sup'); n.className = 'vnum'; n.textContent = v.verse.toString();
    n.id = verseId(book, chap, v.verse);
    span.appendChild(n);
    const t = document.createTextNode(' ' + v.text.trim());
    span.appendChild(t);
    currentPara.appendChild(span);
    currentPara.appendChild(document.createTextNode(' '));
  }
  setBusy(false);
}

// --- Search (Web Worker)
let worker;
function setupSearch(){
  worker = new Worker('src/search-worker.js', { type:'module' });
  worker.postMessage({ type:'init', indexMeta: data.indexMeta() });
  els.searchInput.addEventListener('input', (e)=>{
    const q = e.target.value.trim();
    if(q.length === 0){ els.results.hidden = true; els.resultsList.innerHTML = ''; return; }
    worker.postMessage({ type:'search', query:q, limit:100 });
  });
  els.closeResults.addEventListener('click', ()=>{ els.results.hidden = true; });
  worker.addEventListener('message', async (ev)=>{
    const { type } = ev.data || {};
    if(type === 'hits'){
      const { hits } = ev.data;
      renderHits(hits);
    }else if(type === 'need-chapter'){
      const { book, chapter } = ev.data;
      const verses = await data.getChapter(book, chapter);
      worker.postMessage({ type:'chapter-data', book, chapter, verses });
    }
  });
}
function renderHits(hits){
  els.results.hidden = false;
  els.resultsList.innerHTML = '';
  for(const h of hits){
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#/${encodeURIComponent(h.book)}/${h.chapter}/${h.verse}`;
    const ref = document.createElement('div'); ref.className = 'hit-ref'; ref.textContent = `${h.book} ${h.chapter}:${h.verse}`;
    const text = document.createElement('div'); text.className = 'hit-text';
    text.innerHTML = h.previewHtml;
    a.appendChild(ref); a.appendChild(text);
    li.appendChild(a); els.resultsList.appendChild(li);
  }
}

// --- Command palette (Go to reference)
function openPalette(){
  els.palette.hidden = false;
  els.paletteInput.value = '';
  els.paletteInput.focus();
  updatePaletteList('');
}
function updatePaletteList(input){
  const q = input.trim();
  const items = [];
  const ref = parseRef(q);
  if(ref){
    items.push({ label: `${ref.book} ${ref.chapter}${ref.verse ? ':'+ref.verse : ''}`, book:ref.book, chapter:ref.chapter, verse:ref.verse ?? null });
  }
  if(!q){
    for(const b of data.books) items.push({ label: b, book:b, chapter:1, verse:null });
  }else{
    const qq = q.toLowerCase();
    for(const b of data.books){
      if(b.toLowerCase().includes(qq)) items.push({ label: b, book:b, chapter:1, verse:null });
    }
  }
  els.paletteList.innerHTML = '';
  for(const it of items.slice(0,50)){
    const li=document.createElement('li'); const a=document.createElement('a');
    a.href = it.verse ? `#/${encodeURIComponent(it.book)}/${it.chapter}/${it.verse}` : `#/${encodeURIComponent(it.book)}/${it.chapter}`;
    a.textContent = it.label;
    li.appendChild(a); els.paletteList.appendChild(li);
  }
    // set first active
    paletteIdx = 0;
    setPaletteActive(paletteIdx);
}
// palette keyboard nav
let paletteIdx = 0;
function setPaletteActive(i){
  const items = Array.from(els.paletteList.querySelectorAll('li'));
  items.forEach(li=>li.classList.remove('active'));
  if(items[i]) items[i].classList.add('active');
}
els.paletteInput.addEventListener('keydown', (e)=>{
  const links = els.paletteList.querySelectorAll('a');
  if(!links.length) return;
  if(e.key === 'ArrowDown'){ e.preventDefault(); paletteIdx = Math.min(paletteIdx+1, links.length-1); links[paletteIdx].focus(); setPaletteActive(paletteIdx); }
  if(e.key === 'ArrowUp'){   e.preventDefault(); paletteIdx = Math.max(paletteIdx-1, 0);             links[paletteIdx].focus(); setPaletteActive(paletteIdx); }
  if(e.key === 'Enter'){     e.preventDefault(); links[paletteIdx].click(); els.palette.hidden = true; }
  if(e.key === 'Escape'){    e.preventDefault(); els.palette.hidden = true; }
});
els.paletteInput.addEventListener('input', (e)=> updatePaletteList(e.target.value));
document.addEventListener('click', (e)=>{if(e.target === els.palette) els.palette.hidden = true;
  // click-outside closes results
  if(!els.results.hidden && !els.results.contains(e.target) && e.target !== els.searchInput){
    els.results.hidden = true;
  }
 });
const BOOK_ALIASES = {
  'ps':'Psalms','psalm':'Psalms','psalms':'Psalms',
  'jn':'John','mk':'Mark','mt':'Matthew','lk':'Luke',
  'gen':'Genesis','ex':'Exodus','lev':'Leviticus','num':'Numbers','deut':'Deuteronomy',
};
function parseRef(s){
  if(!s) return null;
  const m = s.match(/^\s*([1-3]?\s*[A-Za-z.]+)\s+(\d+)(?::(\d+))?\s*$/);
  if(!m) return null;
  let b = m[1].replace(/\./g,'').trim();
  const key = b.toLowerCase();
  b = BOOK_ALIASES[key] || data.resolveBook(b) || b;
  if(!data.hasBook(b)) return null;
  const c = Math.min(Math.max(1, Number(m[2])), data.chapterCount(b));
  const v = m[3] ? Number(m[3]) : null;
  return { book:b, chapter:c, verse:v };
}

// --- Service worker / offline
async function registerSW(){
  if(!('serviceWorker' in navigator)) return;
  try{
    const reg = await navigator.serviceWorker.register('sw.js');
    els.swStatus.textContent = 'Offline ready';
    reg.addEventListener('updatefound', ()=>{
      els.swStatus.textContent = 'Updating…';
      reg.installing?.addEventListener('statechange', ()=>{
        if(reg.installing?.state === 'activated') els.swStatus.textContent = 'Updated';
      });
    });
  }catch(e){
    els.swStatus.textContent = 'Offline disabled';
    console.error('SW registration failed', e);
  }
}

// Kickoff
init();
