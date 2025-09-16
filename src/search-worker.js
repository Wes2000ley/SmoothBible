// Web Worker for non-blocking search.
// Strategy: the main thread sends metadata (book list + chapter counts).
// We pull chapters on demand, scan for query tokens, and send back preview hits.

let meta = null;

self.onmessage = async (ev)=>{
  const { type } = ev.data || {};
  if(type === 'init'){
    meta = ev.data.indexMeta;
  }else if(type === 'search'){
    if(!meta) return;
    const { query, limit=100 } = ev.data;
    const hits = await search(query, limit);
    postMessage({ type:'hits', hits });
  }else if(type === 'chapter-data'){
    const { book, chapter, verses } = ev.data;
    _chapterCache.set(key(book,chapter), verses);
    _pendingResolvers.get(key(book,chapter))?.(verses);
    _pendingResolvers.delete(key(book,chapter));
  }
};

const _chapterCache = new Map(); // key -> verses
const _pendingResolvers = new Map(); // key -> resolve
function key(b,c){ return `${b}:${c}` }

async function getChapter(b,c){
  const k = key(b,c);
  if(_chapterCache.has(k)) return _chapterCache.get(k);
  // request from main
  const verses = await new Promise(resolve=>{
    _pendingResolvers.set(k, resolve);
    postMessage({ type:'need-chapter', book:b, chapter:c });
  });
  return verses;
}

async function search(q, limit){
  const tokens = tokenize(q);
  if(tokens.length === 0) return [];
  const results = [];
  outer: for(let bi=0; bi<meta.books.length; bi++){
    const b = meta.books[bi];
    const cc = meta.chapterCounts[bi] || 1;
    for(let c=1; c<=cc; c++){
      const verses = await getChapter(b,c);
      for(const v of verses){
        const txt = v.text.toLowerCase();
        let ok = true;
        for(const t of tokens){ if(!txt.includes(t)){ ok=false; break; } }
        if(ok){
          results.push({
            book:b, chapter:c, verse:v.verse,
            previewHtml: highlight(v.text, tokens),
          });
          if(results.length >= limit) break outer;
        }
      }
    }
  }
  return results;
}

function tokenize(s){
  return s.toLowerCase().split(/\s+/).map(x=>x.trim()).filter(Boolean).slice(0,5);
}
function esc(s){ return s.replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function highlight(text, tokens){
  let out = esc(text);
  for(const t of tokens){
    const re = new RegExp(`(${escapeRegExp(t)})`, 'ig');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
