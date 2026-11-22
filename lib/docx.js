// Minimal .docx (Office Open XML) writer for the manual / test evidence exports. Needs JSZip on the page.
// Supports: headings, paragraphs with formatted runs, tables, inline pictures, page footer with page numbers.
// A4 page, 2 cm margins.
/* global JSZip */

const EMU_PER_CM = 360000;
const TWIP_PER_CM = 567;
export const PAGE_W_CM = 21, MARGIN_CM = 2;
export const CONTENT_TWIPS = Math.round((PAGE_W_CM - 2 * MARGIN_CM) * TWIP_PER_CM); // usable width for tables

// XML text: escape, and drop characters XML 1.0 does not allow (Word refuses the file otherwise)
export const x = (s) => String(s == null ? '' : s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const hex = (c, fallback = '4F46E5') => (/^#?[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).replace('#', '').toUpperCase() : fallback);

/** a run of text. o: { b, i, color, size (pt), shade (background), font }. "\n" becomes a line break. */
export function run(text, o = {}) {
  const pr = [];
  if (o.font) pr.push(`<w:rFonts w:ascii="${x(o.font)}" w:hAnsi="${x(o.font)}" w:cs="${x(o.font)}"/>`);
  if (o.b) pr.push('<w:b/><w:bCs/>');
  if (o.i) pr.push('<w:i/><w:iCs/>');
  if (o.color) pr.push(`<w:color w:val="${hex(o.color, '111827')}"/>`);
  if (o.size) pr.push(`<w:sz w:val="${Math.round(o.size * 2)}"/><w:szCs w:val="${Math.round(o.size * 2)}"/>`);
  if (o.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(o.shade, 'FFFFFF')}"/>`);
  const body = String(text == null ? '' : text).split(/\r?\n/).map((t) => `<w:t xml:space="preserve">${x(t)}</w:t>`).join('<w:br/>');
  return `<w:r>${pr.length ? `<w:rPr>${pr.join('')}</w:rPr>` : ''}${body}</w:r>`;
}

/** a paragraph. runs: string of run() XML (or plain text). o: { style, keepNext, before, after, indent (cm), align } */
export function para(runs, o = {}) {
  const pr = [];
  if (o.style) pr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.keepNext) pr.push('<w:keepNext/>');
  if (o.before != null || o.after != null) pr.push(`<w:spacing${o.before != null ? ` w:before="${o.before}"` : ''}${o.after != null ? ` w:after="${o.after}"` : ''}/>`);
  if (o.indent) pr.push(`<w:ind w:left="${Math.round(o.indent * TWIP_PER_CM)}"/>`);
  if (o.align) pr.push(`<w:jc w:val="${o.align}"/>`);
  const content = typeof runs === 'string' && !runs.startsWith('<w:') ? run(runs) : runs || '';
  return `<w:p>${pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : ''}${content}</w:p>`;
}

/**
 * a table. rows: [{ header?: bool, cells: [{ content: paragraph XML | text, shade?: colour }] }]
 * widths: column widths in twips (sum = table width)
 */
export function table(rows, widths, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const border = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="${o.border || 'D1D5DB'}"/>`;
  const cell = (c, w) => {
    const content = typeof c.content === 'string' && !c.content.startsWith('<w:') ? para(run(c.content, c.run || {}), { after: 0 }) : c.content || para('', { after: 0 });
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${c.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.shade, 'FFFFFF')}"/>` : ''}</w:tcPr>${content}</w:tc>`;
  };
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`
    + `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
    + rows.map((r) => `<w:tr>${r.header ? '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${r.cells.map((c, i) => cell(c, widths[i])).join('')}</w:tr>`).join('')
    + '</w:tbl>' + para('', { after: 60 }); // Word needs a paragraph between two tables
}

export class Docx {
  constructor({ title = 'Document', color = '#4f46e5', footer = '' } = {}) {
    this.title = title;
    this.color = hex(color);
    this.footer = footer || title;
    this.body = [];
    this.media = []; // { name, data (Blob), rid }
  }

  add(xml) { this.body.push(xml); return this; }

  /** picture as its own paragraph, scaled to fit maxW × maxH cm (never enlarged beyond its pixel size at 96 dpi) */
  async image(blob, { maxWcm = PAGE_W_CM - 2 * MARGIN_CM, maxHcm = 20, align, border = true } = {}) {
    if (!blob) return '';
    let data = blob;
    let ext = /jpe?g/i.test(blob.type) ? 'jpeg' : 'png';
    const bmp = await createImageBitmap(blob);
    if (!/png|jpe?g/i.test(blob.type)) { // Word does not show WebP / SVG: convert to PNG
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      data = await c.convertToBlob({ type: 'image/png' });
      ext = 'png';
    }
    const n = this.media.length + 1;
    const rid = `rIdImg${n}`;
    this.media.push({ name: `image${n}.${ext}`, data, rid, ext });
    const pxCm = 2.54 / 96;
    let w = bmp.width * pxCm, h = bmp.height * pxCm;
    const k = Math.min(1, maxWcm / w, maxHcm / h);
    w *= k; h *= k;
    bmp.close();
    const cx = Math.round(w * EMU_PER_CM), cy = Math.round(h * EMU_PER_CM);
    const ln = border ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:ln>' : '';
    const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${n}" name="Picture ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${ln}</pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    return para(drawing, { after: 160, align });
  }

  styles() {
    const c = this.color;
    const h = (id, name, lvl, size, color, before, after, border) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
      + `<w:pPr><w:keepNext/><w:keepLines/>${border ? `<w:pBdr><w:bottom w:val="single" w:sz="${border}" w:space="3" w:color="${c}"/></w:pBdr>` : ''}<w:spacing w:before="${before}" w:after="${after}"/>${lvl != null ? `<w:outlineLvl w:val="${lvl}"/>` : ''}</w:pPr>`
      + `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Nirmala UI"/><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr></w:style>`;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
      + h('Title', 'Title', null, 26, '111827', 0, 80, 18)
      + h('Heading1', 'heading 1', 0, 16, c, 360, 120, 8)
      + h('Heading2', 'heading 2', 1, 13, '111827', 240, 80, 0)
      + h('Heading3', 'heading 3', 2, 11, '374151', 160, 60, 0)
      + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
      + '</w:styles>';
  }

  async toBlob() {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const ns = `${W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
    const tw = (cm) => Math.round(cm * TWIP_PER_CM);
    const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${tw(PAGE_W_CM)}" w:h="${tw(29.7)}"/>`
      + `<w:pgMar w:top="${tw(MARGIN_CM)}" w:right="${tw(MARGIN_CM)}" w:bottom="${tw(MARGIN_CM)}" w:left="${tw(MARGIN_CM)}" w:header="${tw(1)}" w:footer="${tw(1)}" w:gutter="0"/></w:sectPr>`;
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${this.body.join('')}${sect}</w:body></w:document>`;
    const small = '<w:rPr><w:color w:val="6B7280"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>';
    // MERGEFORMAT: Word keeps the small grey look when it fills in the page numbers
    const fld = (instr) => `<w:fldSimple w:instr=" ${instr} \\* MERGEFORMAT "><w:r>${small}<w:t>1</w:t></w:r></w:fldSimple>`;
    const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
      + `<w:r>${small}<w:t xml:space="preserve">${x(this.footer)}  ·  Page </w:t></w:r>${fld('PAGE')}<w:r>${small}<w:t xml:space="preserve"> of </w:t></w:r>${fld('NUMPAGES')}</w:p></w:ftr>`;
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
      + '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
      + this.media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')
      + '</Relationships>';
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '</Relationships>';
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${x(this.title)}</dc:title><dc:creator>EvidenceKit</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
    const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>EvidenceKit</Application></Properties>';

    const zip = new JSZip();
    // no folder entries in the zip: Word (opened through OneDrive / SharePoint) has refused files that have them
    const put = (name, data) => zip.file(name, data, { createFolders: false });
    put('[Content_Types].xml', types);
    put('_rels/.rels', rootRels);
    put('docProps/core.xml', core);
    put('docProps/app.xml', app);
    put('word/document.xml', doc);
    put('word/styles.xml', this.styles());
    put('word/settings.xml', settings);
    put('word/footer1.xml', footer);
    put('word/_rels/document.xml.rels', rels);
    for (const m of this.media) put(`word/media/${m.name}`, m.data);
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  }
}
