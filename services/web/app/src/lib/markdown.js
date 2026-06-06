// Minimal Markdown → HTML (bold, italic, code, lists, #headers, GFM tables). Ported from the
// vanilla app. Output is inserted via dangerouslySetInnerHTML, so we escape first.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMarkdown(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const isSep = (line) => line.includes('|') && /^[\s:|-]+$/.test(line) && line.includes('-');

  const lines = String(src).split('\n');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if (line.startsWith('|') && i + 1 < lines.length && isSep(lines[i + 1].trim())) {
      closeList();
      const header = splitRow(line);
      let body = '';
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body += '<tr>' + splitRow(lines[i].trim()).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      i--;
      html += '<table class="md-table"><thead><tr>' + header.map((h) => `<th>${inline(h)}</th>`).join('')
        + '</tr></thead><tbody>' + body + '</tbody></table>';
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList(); html += `<div class="md-h">${inline(m[2])}</div>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (line === '') {
      closeList();
    } else {
      closeList(); html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}
