// Test Evidence documents: the same steps and sections as the User Manual, but every section is a test case
// with an ID, precondition, expected / actual result, status (Pass / Fail / Blocked / Not run) and bug ID.
// Builds the HTML (also used for PDF printing and Word) and the Markdown export.

export const STATUS = {
  pass: { label: 'PASS', fg: '#166534', bg: '#dcfce7', line: '#16a34a' },
  fail: { label: 'FAIL', fg: '#991b1b', bg: '#fee2e2', line: '#dc2626' },
  blocked: { label: 'BLOCKED', fg: '#9a3412', bg: '#ffedd5', line: '#ea580c' },
  untested: { label: 'NOT RUN', fg: '#4b5563', bg: '#f3f4f6', line: '#9ca3af' },
};
export const STATUS_OPTIONS = [['untested', 'Not run'], ['pass', 'Pass'], ['fail', 'Fail'], ['blocked', 'Blocked']];
export const statusOf = (v) => (STATUS[v] ? v : 'untested');

// a test case without its own ID gets TC-01, TC-02 … from its position
export const tcIdOf = (tc, index) => String((tc && tc.id) || '').trim() || `TC-${String(index).padStart(2, '0')}`;

// "Pass" with nothing typed in Actual result means it behaved as expected
export const actualOf = (o) => String((o && o.actual) || '').trim() || (statusOf(o && o.status) === 'pass' ? 'As expected.' : '');

export const INFO_FIELDS = [
  ['project', 'Project / Module'], ['ticket', 'Ticket / Release'], ['build', 'Build / Version'],
  ['env', 'Environment'], ['tester', 'Tested by'], ['date', 'Test date'],
];

export function countStatus(cases) {
  const c = { total: 0, pass: 0, fail: 0, blocked: 0, untested: 0 };
  for (const t of cases) { if (t.loose) continue; c.total++; c[statusOf(t.status)]++; }
  return c;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const multi = (s) => esc(s).replace(/\n/g, '<br>');
const badge = (st) => { const s = STATUS[statusOf(st)]; return `<span class="badge" style="background:${s.bg};color:${s.fg}">${s.label}</span>`; };

/**
 * doc = { title, color, logo (data URL), metaLine, info: {project,…}, cases: [{ tcId, title, loose, status, bug, pre, expected, actual,
 *         steps: [{ n, title, desc, check, status, expected, actual, dataUrl, more: [{ blob, dataUrl }] }] }] }
 */
export function buildEvidenceHtml(doc, forWord) {
  const c = doc.color || '#4f46e5';
  const counts = countStatus(doc.cases);
  const anchor = (i) => `tc-${i + 1}`;
  const imgAttr = forWord ? ' width="620"' : '';
  const infoRows = INFO_FIELDS.filter(([k]) => String(doc.info[k] || '').trim())
    .map(([k, label]) => `<tr><th>${esc(label)}</th><td>${esc(doc.info[k])}</td></tr>`).join('');
  const real = doc.cases.filter((t) => !t.loose);
  const sumRows = real.map((t, i) => `<tr><td>${i + 1}</td><td class="mono"><a href="#${anchor(doc.cases.indexOf(t))}">${esc(t.tcId)}</a></td><td>${esc(t.title || 'Untitled test case')}</td><td>${badge(t.status)}</td><td>${esc(t.bug || '')}</td></tr>`).join('');
  const chips = ['pass', 'fail', 'blocked', 'untested'].map((k) => `<span class="badge" style="background:${STATUS[k].bg};color:${STATUS[k].fg}">${STATUS[k].label} ${counts[k]}</span>`).join(' ');

  const stepHtml = (s) => {
    const ck = s.check
      ? `<table class="kv ck"><tr><th>Checkpoint</th><td>${badge(s.status)}</td></tr>${s.expected ? `<tr><th>Expected</th><td>${multi(s.expected)}</td></tr>` : ''}${actualOf(s) ? `<tr><th>Actual</th><td>${multi(actualOf(s))}</td></tr>` : ''}</table>`
      : '';
    return `<li><div class="st">${esc(s.title || 'Step ' + s.n)}</div>${s.desc ? `<div class="sd">${multi(s.desc)}</div>` : ''}${ck}${[s.dataUrl ? s : null, ...(s.more || [])].filter(Boolean).map((m, k) => `<figure>${m.cap ? `<figcaption>${esc(m.cap)}</figcaption>` : ''}<img src="${m.dataUrl}" alt="${esc(m.cap || `Step ${s.n}${k ? ` — picture ${k + 1}` : ''}`)}"${imgAttr}></figure>`).join('')}</li>`;
  };

  const caseHtml = (t, i) => {
    if (t.loose) {
      return `<h2 class="tc" id="${anchor(i)}">Steps without a test case</h2><ol class="steps">${t.steps.map(stepHtml).join('')}</ol>`;
    }
    const st = STATUS[statusOf(t.status)];
    const rows = [
      ['Precondition', t.pre], ['Expected result', t.expected], ['Actual result', actualOf(t)],
    ].filter(([, v]) => String(v || '').trim()).map(([k, v]) => `<tr><th>${k}</th><td>${multi(v)}</td></tr>`).join('');
    return `<h2 class="tc" id="${anchor(i)}" style="border-color:${st.line}"><span class="mono">${esc(t.tcId)}</span> — ${esc(t.title || 'Untitled test case')} ${badge(t.status)}</h2>
<table class="kv">${rows}<tr><th>Status</th><td>${badge(t.status)}</td></tr>${t.bug ? `<tr><th>Bug ID</th><td>${esc(t.bug)}</td></tr>` : ''}</table>
${t.steps.length ? `<h3>Test steps (${t.steps.length})</h3><ol class="steps">${t.steps.map(stepHtml).join('')}</ol>` : ''}`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.title)}</title><style>
body{font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:30px auto;padding:0 16px;color:#111827;line-height:1.5}
.head{display:flex;align-items:center;gap:14px;border-bottom:3px solid ${c};padding-bottom:8px}.head img{max-height:56px;max-width:180px}
h1{margin:0}.meta{color:#6b7280;font-size:12px;margin:6px 0 16px}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:13.5px}
th,td{border:1px solid #d1d5db;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:700}
table.kv th{width:160px}
table.info th{width:180px}
table.ck{width:auto;min-width:60%;font-size:12.5px;margin:6px 0}
table.ck th{background:#fffbeb;width:110px}
.mono{font-family:Consolas,ui-monospace,monospace}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-weight:700;font-size:12px;white-space:nowrap}
h2{font-size:19px;margin:28px 0 8px}
h2.tc{border-bottom:3px solid ${c};padding-bottom:4px;page-break-before:auto}
h3{font-size:15px;margin:12px 0 6px;color:#374151}
a{color:${c};text-decoration:none}
ol.steps{padding-left:22px}ol.steps li{margin:0 0 14px;page-break-inside:avoid}
.st{font-weight:700}.sd{color:#374151;font-size:13.5px}
figure{margin:8px 0 0}figcaption{font-size:12.5px;font-weight:600;color:#374151;margin-bottom:3px}img{max-width:100%;border:1px solid #d1d5db;display:block}
.chips{margin:4px 0 8px}
</style></head><body>
<div class="head">${doc.logo ? `<img src="${doc.logo}" alt="">` : ''}<h1>${esc(doc.title)}</h1></div>
<div class="meta">${esc(doc.metaLine)}</div>
${infoRows ? `<table class="info">${infoRows}</table>` : ''}
${real.length ? `<h2>Summary</h2><div class="chips"><b>${counts.total} test case${counts.total === 1 ? '' : 's'}</b> &nbsp; ${chips}</div>
<table><tr><th>#</th><th>TC ID</th><th>Test case</th><th>Status</th><th>Bug ID</th></tr>${sumRows}</table>` : ''}
${doc.cases.map(caseHtml).join('\n')}
</body></html>`;
}

// Markdown + images (zip). Returns { md, files: [{ path, blob }] }
export function buildEvidenceMd(doc, logoFile) {
  const files = [];
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const counts = countStatus(doc.cases);
  let md = '';
  if (logoFile) { files.push(logoFile); md += `![logo](${logoFile.path})\n\n`; }
  md += `# ${doc.title}\n\n_${doc.metaLine}_\n\n`;
  const info = INFO_FIELDS.filter(([k]) => String(doc.info[k] || '').trim());
  if (info.length) md += `| | |\n|---|---|\n${info.map(([k, l]) => `| **${l}** | ${cell(doc.info[k])} |`).join('\n')}\n\n`;
  const real = doc.cases.filter((t) => !t.loose);
  if (real.length) {
    md += `## Summary\n\n**${counts.total} test cases** — PASS ${counts.pass} · FAIL ${counts.fail} · BLOCKED ${counts.blocked} · NOT RUN ${counts.untested}\n\n`;
    md += `| # | TC ID | Test case | Status | Bug ID |\n|---|---|---|---|---|\n`;
    md += real.map((t, i) => `| ${i + 1} | ${cell(t.tcId)} | ${cell(t.title || 'Untitled test case')} | **${STATUS[statusOf(t.status)].label}** | ${cell(t.bug)} |`).join('\n') + '\n\n';
  }
  let img = 0;
  doc.cases.forEach((t) => {
    if (t.loose) md += `## Steps without a test case\n\n`;
    else {
      md += `## ${t.tcId} — ${t.title || 'Untitled test case'} (${STATUS[statusOf(t.status)].label})\n\n| | |\n|---|---|\n`;
      [['Precondition', t.pre], ['Expected result', t.expected], ['Actual result', actualOf(t)], ['Status', STATUS[statusOf(t.status)].label], ['Bug ID', t.bug]]
        .filter(([, v]) => String(v || '').trim()).forEach(([k, v]) => { md += `| **${k}** | ${cell(v)} |\n`; });
      md += '\n';
      if (t.steps.length) md += `### Test steps\n\n`;
    }
    for (const s of t.steps) {
      md += `${s.n}. **${s.title || 'Step ' + s.n}**${s.desc ? ` — ${s.desc.replace(/\r?\n/g, ' ')}` : ''}\n`;
      if (s.check) {
        md += `   - Checkpoint: **${STATUS[statusOf(s.status)].label}**\n`;
        if (s.expected) md += `   - Expected: ${s.expected.replace(/\r?\n/g, ' ')}\n`;
        if (actualOf(s)) md += `   - Actual: ${actualOf(s).replace(/\r?\n/g, ' ')}\n`;
      }
      [s.blob ? s : null, ...(s.more || [])].filter(Boolean).forEach((m, k) => {
        const b = m.blob;
        const ext = /jpe?g/.test(b.type) ? 'jpg' : /webp/.test(b.type) ? 'webp' : 'png';
        const path = `images/${String(++img).padStart(3, '0')}-${t.loose ? 'step' : t.tcId.replace(/[^\w.-]+/g, '_')}-${s.n}${k ? `-${k + 1}` : ''}.${ext}`;
        files.push({ path, blob: b });
        md += `\n${m.cap ? `   **${m.cap.replace(/\r?\n/g, ' ')}**\n\n` : ''}   ![${m.cap ? m.cap.replace(/[\r\n\]]/g, ' ') : `Step ${s.n}${k ? ` — picture ${k + 1}` : ''}`}](${path})\n\n`;
      });
    }
    md += '\n';
  });
  return { md, files };
}
