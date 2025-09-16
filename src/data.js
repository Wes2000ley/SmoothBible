// Data loader & normalizer
// Supports:
//  - Inline JSON via <script id="kjv-json" type="application/json">...</script>
//  - Single-file JSON at data/kjv.json
//  - Per-book JSON files in ./data/books/*.json (various common shapes)
// Uses data/canon.json for book list + chapter counts when single-file is absent.

const BUILT_IN_CANON = [
  ["Genesis",50],["Exodus",40],["Leviticus",27],["Numbers",36],["Deuteronomy",34],
  ["Joshua",24],["Judges",21],["Ruth",4],["1 Samuel",31],["2 Samuel",24],
  ["1 Kings",22],["2 Kings",25],["1 Chronicles",29],["2 Chronicles",36],["Ezra",10],
  ["Nehemiah",13],["Esther",10],["Job",42],["Psalms",150],["Proverbs",31],
  ["Ecclesiastes",12],["Song of Solomon",8],["Isaiah",66],["Jeremiah",52],["Lamentations",5],
  ["Ezekiel",48],["Daniel",12],["Hosea",14],["Joel",3],["Amos",9],
  ["Obadiah",1],["Jonah",4],["Micah",7],["Nahum",3],["Habakkuk",3],
  ["Zephaniah",3],["Haggai",2],["Zechariah",14],["Malachi",4],
  ["Matthew",28],["Mark",16],["Luke",24],["John",21],["Acts",28],
  ["Romans",16],["1 Corinthians",16],["2 Corinthians",13],["Galatians",6],["Ephesians",6],
  ["Philippians",4],["Colossians",4],["1 Thessalonians",5],["2 Thessalonians",3],["1 Timothy",6],
  ["2 Timothy",4],["Titus",3],["Philemon",1],["Hebrews",13],["James",5],
  ["1 Peter",5],["2 Peter",3],["1 John",5],["2 John",1],["3 John",1],
  ["Jude",1],["Revelation",22]
];
const CANON_66 = BUILT_IN_CANON.map(([n])=>n);
function bookFromId(n){
  const i = Number(n) | 0;
  return (i >= 1 && i <= 66) ? CANON_66[i-1] : null;
}
function firstArrayInObject(obj){
  if(!obj || typeof obj!=='object') return [];
  if(Array.isArray(obj.data))   return obj.data;
  if(Array.isArray(obj.verses)) return obj.verses;
  if(Array.isArray(obj.items))  return obj.items;
  if(Array.isArray(obj.text))   return obj.text;
  const arrs = Object.values(obj).filter(Array.isArray);
  return arrs.length ? arrs.flat() : [];
}

export class Data{
  constructor(opts){
    this.singleFile = opts.singleFile;
    this.perBookDir = opts.perBookDir;
    this.canonFile  = opts.canonFile;
    this.books = [];
    this._bookChapters = new Map(); // book -> chapterCount
    this._cache = new Map();        // `${book}:${chapter}` -> verses[]
    this._singleByRef = null;       // Map `${book}:${chapter}` -> verses[]
  }

  async init(){
    // 1) Inline JSON (no fetch, no CORS)
    let singleLoaded = false;
    try{
      const el = document.getElementById('kjv-json');
      const raw = el?.textContent?.trim();
      if(raw && raw.length){
        let json;
        try{ json = JSON.parse(raw); }
        catch(e){ throw new Error(`Inline kjv-json could not be parsed: ${e.message}`); }
        this._ingestSingle(json);
        singleLoaded = true;
      }
    }catch(e){
      console.error('[Data] inline load failed:', e);
    }

    // 2) Single-file JSON fallback
    try{
      if(!singleLoaded){
        const res = await fetch(this.singleFile, { cache:'force-cache' });
        if(res.ok){
          const text = await res.text(); // detect HTML masquerading as JSON
          if(/<html/i.test(text.slice(0,512))){
            throw new Error(`"${this.singleFile}" looks like an HTML page, not JSON`);
          }
          const json = JSON.parse(text);
          this._ingestSingle(json);
          singleLoaded = true;
        }
      }
    }catch(e){
      console.error('[Data] single-file load failed:', e);
    }

    // 3) If still not loaded, fall back to canon for list & counts (per-book fetch will be used)
    if(!singleLoaded){
      let canon = null;
      try{
        const res = await fetch(this.canonFile, { cache:'force-cache' });
        if(res.ok) canon = await res.json();
      }catch(_){ /* ignore */ }

      if(canon && Array.isArray(canon)){
        this.books = canon.map(e=>e.name);
        for(const e of canon) this._bookChapters.set(e.name, Number(e.chapters));
      }else{
        // Minimal fallback
        this.books = [...CANON_66];
        this._bookChapters = new Map(BUILT_IN_CANON.map(([name, chs]) => [name, chs]));
      }
    }
  }

  hasBook(b){ return this.books.includes(b); }

  resolveBook(q){
    const norm = (s)=> String(s).toLowerCase().replace(/\s+/g,'')
                       .replace(/^1st|^2nd|^3rd/,(m)=>m[0]);    const n = norm(q);
    return this.books.find(b=> norm(b)===n) || this.books.find(b=> norm(b).startsWith(n));
  }

  chapterCount(book){
    const val = this._bookChapters.get(book);
    return val || 1;
  }

  async getChapter(book, chapter){
    const key = `${book}:${chapter}`;
    if(this._cache.has(key)) return this._cache.get(key);

    // Single-file (or inline) fast path
    if(this._singleByRef){
      const verses = (this._singleByRef.get(key) || []).map(v=>({ ...v }));
      this._cache.set(key, verses);
      return verses;
    }

    // Per-book: fetch once then slice
    const jb = await this._fetchMaybe(`${this.perBookDir}${encodeURIComponent(book)}.json`);
    if(!jb) throw new Error(`Missing data for book: ${book}`);
    const { chapterCount, chapters } = this._normalizePerBook(book, jb);
    if(!this._bookChapters.has(book) || this._bookChapters.get(book) !== chapterCount){
      this._bookChapters.set(book, chapterCount);
    }
    const verses = chapters.get(chapter) || [];
    this._cache.set(key, verses);
    return verses;
  }

  indexMeta(){
    return {
      books: this.books,
      chapterCounts: this.books.map(b=> this.chapterCount(b)),
    };
  }

  // --- internal helpers

  _ingestSingle(json){
    // Accept array of verse rows OR any object that contains such an array.
    let arr = [];
    if(Array.isArray(json)) arr = json;
    else if(json && typeof json==='object') arr = firstArrayInObject(json);

    const verses = [];
    let sawBad = false;
    for(const r of (arr||[])){
      // Book name or numeric id 1..66
      // Prefer string-based names; map numeric ids only if needed
      let book =
        r.book_name ?? r.bookName ?? r.name ?? r.Book ?? r.BOOK ?? null;
      if(!book){
        const bid = r.book ?? r.book_id ?? r.bookid ?? r.b ?? r.bookNumber ?? r.book_number ?? r.bookIndex;
        if(bid != null) book = bookFromId(bid);
      }
      const chapter = Number(r.chapter ?? r.c ?? r.Chapter ?? r.CHAPTER ?? r.chapter_number ?? r.ch);
      const verse   = Number(r.verse   ?? r.v ?? r.Verse   ?? r.VERSE   ?? r.verse_number   ?? r.vs);
      if(!book || !Number.isFinite(chapter) || !Number.isFinite(verse)){ sawBad = true; continue; }

      let text = r.text ?? r.t ?? r.content ?? r.body ?? r.value ?? r.words ?? '';
      if(typeof text !== 'string') text = String(text ?? '');
      let paragraphStart = false;
      if(/^¶/.test(text)){ paragraphStart = true; text = text.replace(/^¶\s*/, ''); }
      if(text.startsWith('#')){ paragraphStart = true; text = text.replace(/^#+\s*/, ''); }
      verses.push({ book, chapter, verse, text, paragraphStart });
    }

    if(!verses.length){
      console.error('[Data] No usable verses found. Top-level keys:', Object.keys(json||{}));
      if(sawBad) throw new Error('KJV JSON parsed but verse rows used unknown field names.');
      throw new Error('KJV JSON parsed but contained no verse rows.');
    }

    // Organize by book/chapter
    const byBook = new Map();
    for(const v of verses){
      if(!byBook.has(v.book)) byBook.set(v.book, new Map());
      const bm = byBook.get(v.book);
      if(!bm.has(v.chapter)) bm.set(v.chapter, []);
      bm.get(v.chapter).push(v);
    }

    // Canonical order when possible
    const present = new Set(byBook.keys());
    const ordered = CANON_66.filter(b=>present.has(b));
    for(const b of byBook.keys()){ if(!ordered.includes(b)) ordered.push(b); }
    this.books = ordered.length ? ordered : Array.from(byBook.keys());

    // Chapter counts
    for(const [b, chs] of byBook.entries()){
      this._bookChapters.set(b, Math.max(...chs.keys()));
    }

    // Reference map for fast chapter load
    this._singleByRef = new Map();
    for(const [b, chs] of byBook.entries()){
      for(const [c, arr2] of chs.entries()){
        // Ensure verses are sorted
        arr2.sort((a,b)=>a.verse - b.verse);
        this._singleByRef.set(`${b}:${c}`, arr2.map(v=>({ book:b, chapter:c, verse:v.verse, text:v.text, paragraphStart:v.paragraphStart })));
      }
    }
  }

  _normalizePerBook(book, jb){
    // Produce: { chapterCount, chapters: Map<chapter, verse[]> }
    const chapters = new Map();

    // Shape A: { chapters: [ { chapter: 1, verses: [{verse, text, header?}, ...] }, ... ] }
    if(Array.isArray(jb?.chapters)){
      for(const ch of jb.chapters){
        const cnum = Number(ch.chapter ?? ch.number ?? ch.c ?? chapters.size+1);
        const arr = [];
        for(const v of (ch.verses || ch.Verses || [])){
          let txt = String(v.text ?? v.t ?? v.body ?? '');
          let paragraphStart = Boolean(v.header || v.paragraphStart);
          if(/^¶/.test(txt)){ paragraphStart = true; txt = txt.replace(/^¶\s*/, ''); }
          if(txt.startsWith('#')){ paragraphStart = true; txt = txt.replace(/^#+\s*/, ''); }
          arr.push({ book, chapter:cnum, verse:Number(v.verse ?? v.v ?? v.number), text:txt, paragraphStart });
        }
        arr.sort((a,b)=>a.verse-b.verse);
        chapters.set(cnum, arr);
      }
    }
    // Shape B: { [chapterNumber]: { [verseNumber]: "text" } }
    else if(jb && typeof jb === 'object'){
      for(const [k,v] of Object.entries(jb)){
        const cnum = Number(k);
        if(Number.isFinite(cnum) && v && typeof v === 'object'){
          const arr = [];
          for(const [vk, vv] of Object.entries(v)){
            if(!/^\d+$/.test(vk)) continue;
            let txt = String(vv);
            let paragraphStart = false;
            if(/^¶/.test(txt)){ paragraphStart = true; txt = txt.replace(/^¶\s*/, ''); }
            if(txt.startsWith('#')){ paragraphStart = true; txt = txt.replace(/^#+\s*/, ''); }
            arr.push({ book, chapter:cnum, verse:Number(vk), text:txt, paragraphStart });
          }
          arr.sort((a,b)=>a.verse-b.verse);
          chapters.set(cnum, arr);
        }
      }
    }
    const chapterCount = chapters.size || Number(jb?.chapterCount) || this._bookChapters.get(book) || 1;
    return { chapterCount, chapters };
  }

  async _fetchMaybe(url){
    try{
      const res = await fetch(url, { cache:'force-cache' });
      if(res.ok) return res.json();
    }catch(_){}
    return null;
  }
}
