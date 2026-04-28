// Markdown rendering and HTML escaping utilities. Pure functions, no external state.
function getImgSrc(img) {
  if (img.mimeType === 'url') return img.imageBase64;
  return `data:${img.mimeType};base64,${img.imageBase64}`;
}

function renderMarkdown(raw) {
  const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function inlineFormat(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/`(.+?)`/g,       '<code>$1</code>');
  }

  const lines  = raw.split('\n');
  const output = [];
  let inUl = false;
  let inTable = false;
  let inBlockquote = false;

  function closeLists() {
    if (inUl) { output.push('</ul>'); inUl = false; }
  }

  function closeTable() {
    if (inTable) { output.push('</tbody></table></div>'); inTable = false; }
  }

  function closeBlockquote() {
    if (inBlockquote) { output.push('</blockquote>'); inBlockquote = false; }
  }

  function closeAll() { closeLists(); closeTable(); closeBlockquote(); }

  for (const raw_line of lines) {
    const line = escape(raw_line);

    if (raw_line.startsWith('> ') || raw_line === '>') {
      closeLists(); closeTable();
      if (!inBlockquote) { output.push('<blockquote>'); inBlockquote = true; }
      const bqContent = raw_line.startsWith('> ') ? raw_line.slice(2) : '';
      output.push(`<p>${inlineFormat(escape(bqContent))}</p>`);
      continue;
    }
    closeBlockquote();

    if (/^\|(.+)\|$/.test(line.trim())) {
      closeLists();
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue; // skip separator rows
      if (!inTable) {
        output.push('<div class="table-scroll-wrap"><table class="md-table"><thead><tr>');
        cells.forEach(c => output.push('<th>' + inlineFormat(c) + '</th>'));
        output.push('</tr></thead><tbody>');
        inTable = true;
      } else {
        output.push('<tr>');
        cells.forEach(c => output.push('<td>' + inlineFormat(c) + '</td>'));
        output.push('</tr>');
      }
      continue;
    }
    closeTable();

    if (/^### (.+)$/.test(line)) {
      closeLists();
      output.push(`<h3>${inlineFormat(line.replace(/^### /, ''))}</h3>`);
    } else if (/^## (.+)$/.test(line)) {
      closeLists();
      output.push(`<h2>${inlineFormat(line.replace(/^## /, ''))}</h2>`);
    } else if (/^# (.+)$/.test(line)) {
      closeLists();
      output.push(`<h1>${inlineFormat(line.replace(/^# /, ''))}</h1>`);
    } else if (/^[-*•] (.+)$/.test(line)) {
      if (!inUl) { output.push('<ul>'); inUl = true; }
      output.push(`<li>${inlineFormat(line.replace(/^[-*•] /, ''))}</li>`);
    } else if (/^(\d+)\. (.+)$/.test(line)) {
      if (inUl) { output.push('</ul>'); inUl = false; }
      const m = line.match(/^(\d+)\. (.+)$/);
      output.push(`<p class="md-ol-item"><span class="md-ol-num">${m[1]}.</span> ${inlineFormat(m[2])}</p>`);
    } else if (/^---+$/.test(line.trim())) {
      closeLists();
      output.push('<hr>');
    } else if (line.trim() === '') {
      closeLists();
      output.push('<p style="margin:0.3rem 0"></p>');
    } else {
      closeLists();
      output.push(`<p>${inlineFormat(line)}</p>`);
    }
  }

  closeAll();
  let html = `<div class="md-content">${output.join('')}</div>`;
  html = html.replace(/<strong>⭐\s*([^<]*)<\/strong>/g, '<strong class="highlight-important">⭐ $1</strong>');
  html = html.replace(/&lt;br&gt;/gi, '<br>').replace(/&lt;br\/&gt;/gi, '<br>');
  return html;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
