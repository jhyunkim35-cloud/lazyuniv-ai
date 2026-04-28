// PPTX/PDF parsing: text extraction, image extraction, speaker separation.
// Depends on: constants.js (pdfjsLib, pptFile, txtFiles, recIdCounter, abortController, REC_ORDINALS, dragSrcRecId, debugLog).

/* ═══════════════════════════════════════════════
   PDF.js — load worker via importScripts-compatible shim.
   pdf.min.mjs is an ES module; we load it dynamically so we
   can set the workerSrc before first use.
═══════════════════════════════════════════════ */
async function getPdfjsLib() {
  if (pdfjsLib) return pdfjsLib;
  const mod = await import(
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
  );
  mod.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  pdfjsLib = mod;
  return pdfjsLib;
}

/* ═══════════════════════════════════════════════
   File handling
═══════════════════════════════════════════════ */
function onPptChange(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith('.pptx') && !name.endsWith('.pdf')) {
    showToast('⚠️ .pptx 또는 .pdf 파일만 업로드할 수 있습니다.');
    return;
  }
  pptFile = file;
  document.getElementById('pptIcon').textContent = name.endsWith('.pdf') ? '📄' : '📊';
  document.getElementById('pptTagName').textContent = file.name;
  document.getElementById('pptTag').style.display = 'inline-flex';
  document.getElementById('pptZone').classList.add('has-file');
  checkReady();
}

/* ── Multi-recording slot management ─────────── */

function addRecSlot(file = null) {
  const id = ++recIdCounter;
  txtFiles.push({ id, file });
  renderRecSlots();
  checkReady();
}

function removeRecSlot(id) {
  txtFiles = txtFiles.filter(s => s.id !== id);
  renderRecSlots();
  checkReady();
}

function setRecSlotFile(id, file) {
  const slot = txtFiles.find(s => s.id === id);
  if (slot) slot.file = file;
  renderRecSlots();
  checkReady();
}

function reorderRecSlots(srcId, dstId) {
  const srcIdx = txtFiles.findIndex(s => s.id === srcId);
  const dstIdx = txtFiles.findIndex(s => s.id === dstId);
  if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return;
  const [item] = txtFiles.splice(srcIdx, 1);
  txtFiles.splice(dstIdx, 0, item);
  renderRecSlots();
}

function renderRecSlots() {
  const list = document.getElementById('multiRecList');
  const zone = document.getElementById('multiRecZone');
  if (!list) return;

  list.innerHTML = '';

  const hasFiles = txtFiles.some(s => s.file !== null);
  if (zone) zone.classList.toggle('has-files', hasFiles);

  if (txtFiles.length === 0) {
    list.innerHTML = '<div class="rec-empty-hint">녹취록이 없으면 PPT만으로 노트를 작성합니다</div>';
    return;
  }

  txtFiles.forEach((item, idx) => {
    const orderLabel = REC_ORDINALS[idx] ?? `${idx + 1}교시`;
    const fileName   = item.file ? item.file.name : null;

    const div = document.createElement('div');
    div.className    = 'rec-slot';
    div.dataset.id   = item.id;

    const handle = document.createElement('span');
    handle.className = 'rec-drag-handle';
    handle.title     = '드래그하여 순서 변경';
    handle.textContent = '⠿';

    const orderSpan = document.createElement('span');
    orderSpan.className   = 'rec-order-label';
    orderSpan.textContent = orderLabel;

    const fileArea = document.createElement('div');
    fileArea.className = 'rec-file-area';

    const fileInput = document.createElement('input');
    fileInput.type   = 'file';
    fileInput.accept = '.txt';
    fileInput.className = 'rec-file-input';

    const fileNameSpan = document.createElement('span');
    fileNameSpan.className   = 'rec-file-name' + (fileName ? ' has-file' : '');
    fileNameSpan.textContent = fileName ? ('✓ ' + fileName) : '파일 선택 또는 여기에 드롭';

    fileArea.append(fileInput, fileNameSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'rec-remove-btn';
    removeBtn.title       = '제거';
    removeBtn.textContent = '×';

    div.append(handle, orderSpan, fileArea, removeBtn);

    // ── File input change ──
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith('.txt')) {
        showToast('⚠️ .txt 파일만 업로드할 수 있습니다.');
        return;
      }
      setRecSlotFile(item.id, f);
    });

    // ── Remove ──
    removeBtn.addEventListener('click', () => removeRecSlot(item.id));

    // ── Drag to reorder: enable dragging only via handle ──
    handle.addEventListener('mousedown', () => div.setAttribute('draggable', 'true'));
    div.addEventListener('dragend',  () => {
      div.setAttribute('draggable', 'false');
      div.classList.remove('dragging');
      document.querySelectorAll('.rec-slot').forEach(s => s.classList.remove('drag-over-slot'));
    });
    div.addEventListener('mouseup', () => div.setAttribute('draggable', 'false'));

    div.addEventListener('dragstart', e => {
      dragSrcRecId = item.id;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(item.id)); // Firefox requires this
    });

    div.addEventListener('dragover', e => {
      e.preventDefault();
      // File drag from OS: highlight the file area, not the slot border
      if (e.dataTransfer.types.includes('Files')) {
        div.classList.remove('drag-over-slot');
      } else {
        e.dataTransfer.dropEffect = 'move';
        div.classList.add('drag-over-slot');
      }
    });

    div.addEventListener('dragleave', e => {
      // Only remove if leaving the slot entirely
      if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over-slot');
    });

    div.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation(); // prevent multiRecZone's drop from firing
      div.classList.remove('drag-over-slot');

      if (e.dataTransfer.files.length > 0) {
        // OS file drop onto this slot
        const f = e.dataTransfer.files[0];
        if (!f.name.toLowerCase().endsWith('.txt')) {
          showToast('⚠️ .txt 파일만 업로드할 수 있습니다.');
          return;
        }
        setRecSlotFile(item.id, f);
      } else if (dragSrcRecId !== null && dragSrcRecId !== item.id) {
        // Slot reorder
        reorderRecSlots(dragSrcRecId, item.id);
      }
      dragSrcRecId = null;
    });

    list.appendChild(div);
  });
}

function setupDrop(zoneId, handler) {
  const zone = document.getElementById(zoneId);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
  });
}

function checkReady() {
  if (isBatchMode) {
    checkBatchReady();
  } else {
    analyzeBtn.disabled = isRunning || !pptFile;
    const notice = document.getElementById('pptOnlyNotice');
    const hasRecordings = txtFiles.some(s => s.file !== null);
    if (pptFile && !hasRecordings) notice.classList.add('visible');
    else notice.classList.remove('visible');
  }
}

/* ═══════════════════════════════════════════════
   Presentation text extraction — dispatches by type
═══════════════════════════════════════════════ */
async function extractPresentationText(file) {
  if (file.name.toLowerCase().endsWith('.pdf')) {
    return extractPdfText(file);
  }
  return extractPptxText(file);
}

/* ── PPTX via JSZip + XML ─────────────────────── */

/* Resolve the notesSlide path for a given slide via its .rels file.
   Notes slides are numbered independently from slide numbers, so we
   must look up the relationship rather than assuming matching numbers. */
async function findNotesPath(zip, slidePath) {
  const slideFile = slidePath.split('/').pop();                      // e.g. "slide3.xml"
  const relsPath  = `ppt/slides/_rels/${slideFile}.rels`;
  if (!zip.files[relsPath]) return null;
  const relsXml = await zip.files[relsPath].async('text');
  const m = relsXml.match(/Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"/);
  if (!m) return null;
  const target   = m[1];                                             // e.g. "../notesSlides/notesSlide2.xml"
  const resolved = target.startsWith('../')
    ? 'ppt/' + target.slice(3)
    : 'ppt/slides/' + target;
  return zip.files[resolved] ? resolved : null;
}

/* Parse slide's .rels file to find chart and SmartArt diagram relationships.
   Returns { charts: [resolvedPath,...], diagrams: [resolvedPath,...] }. */
async function findSlideRelationships(zip, slidePath) {
  const slideFile = slidePath.split('/').pop();
  const relsPath  = `ppt/slides/_rels/${slideFile}.rels`;
  const result    = { charts: [], diagrams: [] };
  if (!zip.files[relsPath]) return result;

  const relsXml = await zip.files[relsPath].async('text');
  const relRe   = /<Relationship[^>]+Type="([^"]+)"[^>]+Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relsXml)) !== null) {
    const type     = m[1];
    const target   = m[2];
    const resolved = target.startsWith('../')
      ? 'ppt/' + target.slice(3)
      : 'ppt/slides/' + target;
    if (!zip.files[resolved]) continue;
    if (type.includes('/chart'))       result.charts.push(resolved);
    if (type.includes('/diagramData')) result.diagrams.push(resolved);
  }
  return result;
}

/* Parse c:chart XML and build a markdown table from series data.
   Returns a formatted string like "차트(title):\n| header |...\n| row |...". */
function extractChartData(chartXml) {
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(chartXml, 'application/xml');
  const titleEls = doc.getElementsByTagName('c:t');
  const title    = titleEls.length ? titleEls[0].textContent.trim() : '';

  const series = [];
  for (const ser of doc.getElementsByTagName('c:ser')) {
    const txEl  = ser.getElementsByTagName('c:tx')[0];
    const nameV = txEl ? txEl.getElementsByTagName('c:v')[0] : null;
    const name  = nameV ? nameV.textContent.trim() : `시리즈${series.length + 1}`;

    const catEl = ser.getElementsByTagName('c:cat')[0];
    const cats  = catEl
      ? Array.from(catEl.getElementsByTagName('c:v')).map(v => v.textContent.trim())
      : [];

    const valEl = ser.getElementsByTagName('c:val')[0] || ser.getElementsByTagName('c:yVal')[0];
    const vals  = valEl
      ? Array.from(valEl.getElementsByTagName('c:v')).map(v => v.textContent.trim())
      : [];

    series.push({ name, cats, vals });
  }

  if (!series.length) return title ? `차트(${title}): 데이터 없음` : '';

  const allCats = series[0].cats.length
    ? series[0].cats
    : series[0].vals.map((_, i) => String(i + 1));
  const header  = '| 카테고리 | ' + series.map(s => s.name).join(' | ') + ' |';
  const sep     = '| --- | '     + series.map(() => '---').join(' | ') + ' |';
  const rows    = allCats.map((cat, i) =>
    '| ' + cat + ' | ' + series.map(s => s.vals[i] ?? '').join(' | ') + ' |'
  );

  const label = title ? `차트(${title})` : '차트';
  return `${label}:\n${header}\n${sep}\n${rows.join('\n')}`;
}

/* Parse SmartArt diagram data XML and return " / "-separated text. */
function extractDiagramText(diagramXml) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(diagramXml, 'application/xml');

  // Try namespace-prefixed elements first, then unprefixed fallback
  const pts    = doc.getElementsByTagName('dgm:pt').length
    ? doc.getElementsByTagName('dgm:pt')
    : doc.getElementsByTagName('pt');

  const texts = [];
  for (const pt of pts) {
    const type = pt.getAttribute('type') || '';
    if (type === 'parTrans' || type === 'sibTrans') continue;
    const atEls = pt.getElementsByTagName('a:t').length
      ? pt.getElementsByTagName('a:t')
      : pt.getElementsByTagName('t');
    for (const el of atEls) {
      const t = el.textContent.trim();
      if (t) texts.push(t);
    }
  }
  return texts.join(' / ');
}

async function extractPptxText(file) {
  const zip = await JSZip.loadAsync(file);

  const slidePaths = [];
  zip.forEach(path => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) slidePaths.push(path);
  });
  slidePaths.sort((a, b) =>
    parseInt(a.match(/(\d+)/)[1]) - parseInt(b.match(/(\d+)/)[1])
  );

  if (slidePaths.length === 0) return '슬라이드 내용을 찾을 수 없습니다.';

  const lines = [];
  for (const path of slidePaths) {
    const num      = path.match(/(\d+)/)[1];
    const slideXml = await zip.files[path].async('text');

    // Resolve notes path via rels (correct) rather than assuming number match
    const notesPath = await findNotesPath(zip, path);
    const notesXml  = notesPath ? await zip.files[notesPath].async('text') : '';

    const { title, body, tables, notes } = extractSlideContent(slideXml, notesXml);

    // Extract chart and SmartArt diagram data via slide relationships
    const rels        = await findSlideRelationships(zip, path);
    const chartTexts  = [];
    for (const chartPath of rels.charts) {
      const ct = extractChartData(await zip.files[chartPath].async('text'));
      if (ct) chartTexts.push(ct);
    }
    const diagramTexts = [];
    for (const dgmPath of rels.diagrams) {
      const dt = extractDiagramText(await zip.files[dgmPath].async('text'));
      if (dt) diagramTexts.push(dt);
    }

    const hasContent = title || body || tables.length > 0 || notes
                    || chartTexts.length > 0 || diagramTexts.length > 0;
    lines.push(`[슬라이드 ${num}]`);
    if (!hasContent) {
      lines.push('(텍스트 없음 — 이미지 전용 슬라이드)');
    } else {
      if (title)              lines.push(`제목: ${title}`);
      if (body)               lines.push(`내용: ${body}`);
      tables.forEach(t     => lines.push(`표:\n${t}`));
      chartTexts.forEach(c  => lines.push(c));
      diagramTexts.forEach(d => lines.push(`다이어그램: ${d}`));
      if (notes)              lines.push(`노트: ${notes}`);
    }
    if (tables.length || chartTexts.length || diagramTexts.length) {
      console.log(`[슬라이드 ${num}] 구조 데이터:`,
        { tables: tables.length, charts: chartTexts.length, diagrams: diagramTexts.length });
    }
    lines.push('');
  }

  const result = lines.join('\n').trim() || 'PPT에서 텍스트를 추출할 수 없습니다.';
  debugLog('PPT', `Extracted ${slidePaths.length} slides, ${result.length} chars, tables=${/표:/.test(result)}, charts=${/차트/.test(result)}, diagrams=${/다이어그램:/.test(result)}`);
  console.log('[PPT 추출 완료] storedPptText 길이:', result.length);
  console.log('[PPT 추출 완료] 표/차트 포함 여부:', /표:|차트|다이어그램:/.test(result) ? '✅' : '❌');
  console.log('[PPT 추출 결과 전문]', result);
  return result;
}

/* Extract structured content from a single slide's XML.
   Uses getElementsByTagName('ns:local') which is reliable for namespace-
   prefixed elements in DOMParser/application/xml documents across all
   modern browsers, avoiding the broad unqualified fallback selectors
   (", t" / ", p" / ", sp") that could match spurious XML elements. */
function extractSlideContent(slideXml, notesXml) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(slideXml, 'application/xml');

  // All <a:t> text inside el, joined by space
  function getAtTexts(el) {
    return Array.from(el.getElementsByTagName('a:t'))
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
  }

  // Text per <a:p> paragraph — runs within a paragraph are concatenated directly
  function getParaTexts(el) {
    return Array.from(el.getElementsByTagName('a:p'))
      .map(p => Array.from(p.getElementsByTagName('a:t'))
        .map(n => n.textContent.trim()).filter(Boolean).join(''))
      .filter(Boolean);
  }

  // Title: <p:sp> whose <p:ph> has type="title" or type="ctrTitle"
  let title   = '';
  let titleSp = null;
  for (const sp of doc.getElementsByTagName('p:sp')) {
    const phs = sp.getElementsByTagName('p:ph');
    if (phs.length && /^(title|ctrTitle)$/i.test(phs[0].getAttribute('type') || '')) {
      titleSp = sp;
      break;
    }
  }
  if (titleSp) {
    const txBodies = titleSp.getElementsByTagName('p:txBody');
    if (txBodies.length) title = getAtTexts(txBodies[0]);
  }

  // Body: all <p:sp> shapes except title; skip date/footer/slideNum placeholders
  const bodyParts = [];
  for (const sp of doc.getElementsByTagName('p:sp')) {
    if (sp === titleSp) continue;
    const phs    = sp.getElementsByTagName('p:ph');
    const phType = phs.length ? (phs[0].getAttribute('type') || '') : '';
    if (/^(dt|ftr|sldNum)$/i.test(phType)) continue;
    const txBodies = sp.getElementsByTagName('p:txBody');
    if (!txBodies.length) continue;
    const paras = getParaTexts(txBodies[0]);
    if (paras.length) bodyParts.push(paras.join('\n'));
  }
  const body = bodyParts.join('\n').trim();

  // Tables: <p:graphicFrame> → <a:tbl> → rows → cells (namespace fallbacks for edge cases)
  const tables = [];
  const frames = doc.getElementsByTagName('p:graphicFrame').length
    ? doc.getElementsByTagName('p:graphicFrame')
    : doc.getElementsByTagName('graphicFrame');
  for (const frame of frames) {
    const tbls = frame.getElementsByTagName('a:tbl').length
      ? frame.getElementsByTagName('a:tbl')
      : frame.getElementsByTagName('tbl');
    if (!tbls.length) continue;
    const trEls = tbls[0].getElementsByTagName('a:tr').length
      ? tbls[0].getElementsByTagName('a:tr')
      : tbls[0].getElementsByTagName('tr');
    const rows = [];
    Array.from(trEls).forEach((tr, rowIdx) => {
      const tcEls = tr.getElementsByTagName('a:tc').length
        ? tr.getElementsByTagName('a:tc')
        : tr.getElementsByTagName('tc');
      const cells = Array.from(tcEls).map(tc => {
        const apEls = tc.getElementsByTagName('a:p').length
          ? tc.getElementsByTagName('a:p')
          : tc.getElementsByTagName('p');
        const cellText = Array.from(apEls).map(ap => {
          const atEls = ap.getElementsByTagName('a:t').length
            ? ap.getElementsByTagName('a:t')
            : ap.getElementsByTagName('t');
          return Array.from(atEls).map(n => n.textContent.trim()).filter(Boolean).join('');
        }).filter(Boolean).join(' / ').replace(/<[^>]*>/g, '') || ' ';
        return cellText;
      });
      rows.push('| ' + cells.join(' | ') + ' |');
      if (rowIdx === 0) {
        rows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      }
    });
    if (rows.length) tables.push(rows.join('\n'));
  }

  // Notes: skip date/footer/slideNum placeholders
  let notes = '';
  if (notesXml) {
    const ndoc       = parser.parseFromString(notesXml, 'application/xml');
    const notesParts = [];
    for (const sp of ndoc.getElementsByTagName('p:sp')) {
      const phs    = sp.getElementsByTagName('p:ph');
      const phType = phs.length
        ? (phs[0].getAttribute('type') || phs[0].getAttribute('idx') || '')
        : '';
      if (/^(dt|ftr|sldNum)$/i.test(phType)) continue;
      const txBodies = sp.getElementsByTagName('p:txBody');
      if (!txBodies.length) continue;
      const paras = getParaTexts(txBodies[0]);
      if (paras.length) notesParts.push(paras.join(' '));
    }
    notes = notesParts.join(' ').trim();
  }

  return { title, body, tables, notes };
}

/* ── PPTX image extraction ────────────────────── */
async function extractPptxImages(file) {
  const images = [];
  // EMF/WMF are Windows-only vector formats browsers cannot display — intentionally excluded
  const MIME_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  };
  // Skip base64 strings larger than ~3 MB to avoid freezing the browser
  const MAX_BASE64_LEN = 3 * 1024 * 1024;

  try {
    const zip = await JSZip.loadAsync(file);

    const slidePaths = [];
    zip.forEach(path => {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) slidePaths.push(path);
    });
    // Bug fix: use slide(\d+) so the SLIDE number is captured, not an incidental digit
    slidePaths.sort((a, b) =>
      parseInt(a.match(/slide(\d+)\.xml/)[1]) - parseInt(b.match(/slide(\d+)\.xml/)[1])
    );

    const seen = new Set();
    for (const slidePath of slidePaths) {
      // Bug fix: use slide(\d+) pattern, not the first digit in the full path string
      const slideNum = parseInt(slidePath.match(/slide(\d+)\.xml/)[1]);
      const relsPath = slidePath.replace('ppt/slides/slide', 'ppt/slides/_rels/slide') + '.rels';
      if (!zip.files[relsPath]) continue;

      const relsXml = await zip.files[relsPath].async('text');

      // Bug fix: the old regex used [^/]*? which halts on the '/' chars inside
      // the Type URL (e.g. http://…/relationships/image).  Parse each full
      // <Relationship …/> element as a unit instead.
      const relEls = relsXml.match(/<Relationship\s[^>]+\/?>/gi) || [];
      for (const rel of relEls) {
        const targetM = rel.match(/Target="([^"]+)"/i);
        if (!targetM) continue;

        // Bug fix: URL-decode paths like ../media/image%201.png
        let rawPath = targetM[1];
        try { rawPath = decodeURIComponent(rawPath); } catch (_) { /* keep raw */ }

        const ext = rawPath.split('.').pop().toLowerCase();
        const mimeType = MIME_MAP[ext];
        if (!mimeType) continue;   // skip EMF, WMF, TIFF, etc.

        let imgPath = rawPath;
        if (imgPath.startsWith('../')) imgPath = 'ppt/' + imgPath.slice(3);
        else if (!imgPath.startsWith('ppt/')) imgPath = 'ppt/slides/' + imgPath;

        if (!zip.files[imgPath]) continue;

        const dedupeKey = `${slideNum}|${imgPath}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const base64 = await zip.files[imgPath].async('base64');
        // Bug fix: skip oversized images that would freeze the browser
        if (base64.length > MAX_BASE64_LEN) {
          console.warn(`슬라이드 ${slideNum} 이미지 크기 초과 (${(base64.length / 1024 / 1024).toFixed(1)} MB) — 건너뜀`);
          continue;
        }

        images.push({
          slideNumber: slideNum,
          imageBase64: base64,
          mimeType,
          fileName: imgPath.split('/').pop(),
        });
      }
    }
  } catch (e) {
    console.warn('이미지 추출 오류:', e);
  }
  return images;
}

/* ── PDF via PDF.js ───────────────────────────── */
async function extractPdfText(file) {
  const pdfjs = await getPdfjsLib();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  const lines = [];
  for (let i = 1; i <= numPages; i++) {
    // Yield to the browser every 5 pages to keep the UI responsive
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    if (abortController?.signal.aborted) { pdf.destroy(); throw new DOMException('Aborted', 'AbortError'); }

    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();

    const itemsByY = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!itemsByY.has(y)) itemsByY.set(y, []);
      itemsByY.get(y).push(item);
    }

    const sortedYs = [...itemsByY.keys()].sort((a, b) => b - a);
    const pageLines = sortedYs.map(y => {
      const row = itemsByY.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      return row.map(it => it.str).join(' ').trim();
    }).filter(l => l.length > 0);

    if (pageLines.length > 0) {
      lines.push(`[페이지 ${i}]`);
      lines.push(pageLines.join('\n'));
      lines.push('');
    }
  }

  const result = lines.join('\n').trim() || 'PDF에서 텍스트를 추출할 수 없습니다.';
  pdf.destroy();
  return result;
}

/* ── PDF page image extraction ────────────────── */
async function extractPdfPageImages(file) {
  const images = [];
  try {
    const pdfjs = await getPdfjsLib();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

    for (let i = 1; i <= pdf.numPages; i++) {
      // Yield to the browser every 5 pages to keep the UI responsive
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
      if (abortController?.signal.aborted) { pdf.destroy(); throw new DOMException('Aborted', 'AbortError'); }

      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const dataURL = canvas.toDataURL('image/jpeg', 0.85);
      images.push({
        slideNumber: i,
        imageBase64: dataURL.split(',')[1],
        mimeType:    'image/jpeg',
      });
    }

    pdf.destroy();
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('PDF 페이지 이미지 추출 오류:', e);
  }
  return images;
}

/* ═══════════════════════════════════════════════
   Speaker separation (client-side)
   Clova format: optional [hh:mm:ss] prefix, then "참석자 N: text"
═══════════════════════════════════════════════ */
function separateSpeakers(rawText, professorNum) {
  const speakerRe = /^(?:\[[\d:]+\]\s*)?참석자\s*(\d+)\s*:/;
  const lines = rawText.split('\n');

  const speakers = new Set();
  for (const line of lines) {
    const m = line.match(speakerRe);
    if (m) speakers.add(parseInt(m[1]));
  }

  if (speakers.size <= 1) {
    const nonEmpty = lines.filter(l => l.trim()).length;
    return {
      text: rawText,
      totalLines: nonEmpty,
      professorLines: nonEmpty,
      speakerCount: speakers.size,
      allSpeakers: [...speakers].sort((a,b) => a - b),
      skipped: true,
      professorNum,
    };
  }

  const profLines = lines.filter(line => {
    const stripped = line.replace(/^\[[\d:]+\]\s*/, '');
    return stripped.startsWith(`참석자 ${professorNum}:`);
  });

  const extractedText = profLines
    .map(line => line.replace(/^\[[\d:]+\]\s*/, '').replace(/^참석자\s*\d+\s*:\s*/, '').trim())
    .filter(t => t.length > 0)
    .join('\n');

  const totalLabeled = lines.filter(l => speakerRe.test(l)).length;

  return {
    text: extractedText,
    totalLines: totalLabeled,
    professorLines: profLines.length,
    speakerCount: speakers.size,
    allSpeakers: [...speakers].sort((a,b) => a - b),
    skipped: false,
    professorNum,
  };
}
