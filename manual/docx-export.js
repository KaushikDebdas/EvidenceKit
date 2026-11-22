// Word (.docx) exports of the User Manual and of the Test Evidence.
import { Docx, run, para, table, CONTENT_TWIPS } from '../lib/docx.js';
import { STATUS, statusOf, actualOf, countStatus, INFO_FIELDS } from './evidence-export.js';

const NBSP = ' ';
const badge = (st, text, size = 9) => {
  const s = STATUS[statusOf(st)];
  return run(`${NBSP}${text || s.label}${NBSP}`, { b: true, color: s.fg, shade: s.bg, size });
};
const cols = (...parts) => { // column widths from fractions of the page width
  const w = parts.map((f) => Math.round(CONTENT_TWIPS * f));
  w[w.length - 1] += CONTENT_TWIPS - w.reduce((a, b) => a + b, 0);
  return w;
};
const cellP = (runs) => para(runs, { after: 0 });
const labelCell = (text, shade = 'F3F4F6') => ({ content: cellP(run(text, { b: true })), shade });

async function head(d, { title, logo, metaLine }) {
  if (logo) d.add(await d.image(logo, { maxWcm: 5, maxHcm: 1.6, border: false }));
  d.add(para(run(title), { style: 'Title' }));
  if (metaLine) d.add(para(run(metaLine, { color: '6B7280', size: 9 }), { after: 240 }));
}

/** User Manual: { title, color, logo (Blob), metaLine, toc, groups: [{ title|null, items: [{ n, title, desc, blob }] }] } */
export async function manualDocx(m) {
  const d = new Docx({ title: m.title, color: m.color });
  await head(d, m);
  const total = m.groups.reduce((a, g) => a + g.items.length, 0);
  if (m.toc && total > 1) {
    d.add(para(run('Contents', { b: true, size: 12 }), { after: 60, keepNext: true }));
    for (const g of m.groups) {
      if (g.title) d.add(para(run(g.title, { b: true, color: m.color }), { after: 20 }));
      for (const it of g.items) d.add(para(run(`${it.n}. ${it.title || 'Step ' + it.n}`), { indent: g.title ? 0.6 : 0, after: 20 }));
    }
    d.add(para('', { after: 200 }));
  }
  for (const g of m.groups) {
    if (g.title) d.add(para(run(g.title), { style: 'Heading1' }));
    for (const it of g.items) {
      d.add(para(run(`${NBSP}Step ${it.n}${NBSP}`, { b: true, color: 'FFFFFF', shade: m.color }) + (it.title ? run(`  ${it.title}`) : ''), { style: 'Heading2' }));
      if (it.desc) d.add(para(run(it.desc), { keepNext: !!it.blob }));
      if (it.blob) d.add(await d.image(it.blob));
    }
  }
  return d.toBlob();
}

/** Test Evidence: the document built by collectEvidence() in manual.js; logo = Blob or null */
export async function evidenceDocx(doc, logo) {
  const d = new Docx({ title: doc.title, color: doc.color });
  await head(d, { title: doc.title, logo, metaLine: doc.metaLine });

  const info = INFO_FIELDS.filter(([k]) => String(doc.info[k] || '').trim());
  if (info.length) d.add(table(info.map(([k, label]) => ({ cells: [labelCell(label), { content: cellP(run(doc.info[k])) }] })), cols(0.3, 0.7)));

  const real = doc.cases.filter((t) => !t.loose);
  if (real.length) {
    const c = countStatus(doc.cases);
    d.add(para(run('Summary'), { style: 'Heading1' }));
    d.add(para(run(`${c.total} test case${c.total === 1 ? '' : 's'}    `, { b: true })
      + ['pass', 'fail', 'blocked', 'untested'].map((k) => badge(k, `${STATUS[k].label} ${c[k]}`) + run('  ')).join(''), { after: 120 }));
    const hdr = ['#', 'TC ID', 'Test case', 'Status', 'Bug ID'].map((t) => labelCell(t));
    d.add(table([{ header: true, cells: hdr }, ...real.map((t, i) => ({
      cells: [
        { content: cellP(run(String(i + 1))) },
        { content: cellP(run(t.tcId, { font: 'Consolas', size: 9.5 })) },
        { content: cellP(run(t.title || 'Untitled test case')) },
        { content: cellP(badge(t.status)) },
        { content: cellP(run(t.bug || '')) },
      ],
    }))], cols(0.06, 0.18, 0.46, 0.14, 0.16)));
  }

  for (const t of doc.cases) {
    if (t.loose) d.add(para(run('Steps without a test case'), { style: 'Heading1' }));
    else {
      d.add(para(run(`${t.tcId} — ${t.title || 'Untitled test case'}  `) + badge(t.status, '', 10), { style: 'Heading1' }));
      const rows = [['Precondition', t.pre], ['Expected result', t.expected], ['Actual result', actualOf(t)]]
        .filter(([, v]) => String(v || '').trim())
        .map(([k, v]) => ({ cells: [labelCell(k), { content: cellP(run(v)) }] }));
      rows.push({ cells: [labelCell('Status'), { content: cellP(badge(t.status)) }] });
      if (t.bug) rows.push({ cells: [labelCell('Bug ID'), { content: cellP(run(t.bug)) }] });
      d.add(table(rows, cols(0.26, 0.74)));
      if (t.steps.length) d.add(para(run(`Test steps (${t.steps.length})`), { style: 'Heading3' }));
    }
    for (const s of t.steps) {
      const more = !!(s.desc || s.check || s.blob);
      d.add(para(run(`${s.n}.  `, { b: true }) + run(s.title || `Step ${s.n}`, { b: true }), { keepNext: more, before: 120, after: 20 }));
      if (s.desc) d.add(para(run(s.desc, { color: '374151' }), { indent: 0.6, keepNext: !!(s.check || s.blob) }));
      if (s.check) {
        const ck = [{ cells: [labelCell('Checkpoint', 'FFFBEB'), { content: cellP(badge(s.status)) }] }];
        if (s.expected) ck.push({ cells: [labelCell('Expected', 'FFFBEB'), { content: cellP(run(s.expected)) }] });
        if (actualOf(s)) ck.push({ cells: [labelCell('Actual', 'FFFBEB'), { content: cellP(run(actualOf(s))) }] });
        d.add(table(ck, cols(0.2, 0.8), { border: 'FCD34D' }));
      }
      if (s.blob) d.add(await d.image(s.blob));
    }
  }
  return d.toBlob();
}
