// ─── SPARQL Query ───────────────────────────────────────────────────────────

const SPARQL = `
SELECT
  ?countryLabel ?personLabel ?positionLabel ?startDate
  ?genderLabel ?birthDate ?age ?yearsInOffice
  ?occupations ?religions
WHERE {
  {
    SELECT
      ?country ?person ?position ?startDate ?gender ?birthDate
      (GROUP_CONCAT(DISTINCT ?occupation; separator=", ") AS ?occupationList)
      (GROUP_CONCAT(DISTINCT ?religion;  separator=", ") AS ?religionList)
    WHERE {
      ?country wdt:P31 wd:Q6256.
      {
        ?country p:P35 ?stmt.
        ?stmt ps:P35 ?person.
      } UNION {
        ?country p:P6 ?stmt.
        ?stmt ps:P6 ?person.
      }
      FILTER NOT EXISTS { ?stmt pq:P582 ?endDate }
      ?person wdt:P39 ?position.
      OPTIONAL { ?stmt pq:P580 ?startDate }
      OPTIONAL { ?person wdt:P21 ?gender. }
      OPTIONAL { ?person wdt:P569 ?birthDate. }
      OPTIONAL { ?person wdt:P106 ?occupationEntity.
                 ?occupationEntity rdfs:label ?occupation.
                 FILTER(LANG(?occupation) = "he" || LANG(?occupation) = "en") }
      OPTIONAL { ?person wdt:P140 ?religionEntity.
                 ?religionEntity rdfs:label ?religion.
                 FILTER(LANG(?religion) = "he" || LANG(?religion) = "en") }
    }
    GROUP BY ?country ?person ?position ?startDate ?gender ?birthDate
  }

  BIND(
    YEAR(NOW()) - YEAR(?birthDate) -
    IF(MONTH(NOW()) < MONTH(?birthDate) ||
      (MONTH(NOW()) = MONTH(?birthDate) && DAY(NOW()) < DAY(?birthDate)), 1, 0)
    AS ?age
  )
  BIND(
    YEAR(NOW()) - YEAR(?startDate) -
    IF(MONTH(NOW()) < MONTH(?startDate) ||
      (MONTH(NOW()) = MONTH(?startDate) && DAY(NOW()) < DAY(?startDate)), 1, 0)
    AS ?yearsInOffice
  )
  BIND(IF(?occupationList != "", ?occupationList, "—") AS ?occupations)
  BIND(IF(?religionList   != "", ?religionList,   "—") AS ?religions)

  SERVICE wikibase:label { bd:serviceParam wikibase:language "he,en". }
}
ORDER BY ?countryLabel
`;

const ENDPOINT = 'https://query.wikidata.org/sparql';

// ─── Role Classification ─────────────────────────────────────────────────────

function classifyRole(lbl) {
  if (!lbl) return 'אחר';
  const l = lbl.toLowerCase();
  if (l.includes('ראש ממשלה') || l.includes('prime minister') || l.includes('chancellor') || l.includes('premier')) return 'ראש ממשלה';
  if (l.includes('נשיא') || l.includes('president')) return 'נשיא';
  if (
    l.includes('מלך') || l.includes('מלכה') || l.includes('אמיר') ||
    l.includes('סולטן') || l.includes('מונרך') || l.includes('נסיך') ||
    l.includes('king') || l.includes('queen') || l.includes('emir') ||
    l.includes('sultan') || l.includes('monarch') || l.includes('prince') ||
    l.includes('emperor') || l.includes('sheikh')
  ) return 'מונרך';
  return 'אחר';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '—';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d.slice(0, 10) || '—';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function roleBadge(role) {
  const map = {
    'ראש ממשלה': 'badge badge-pm',
    'נשיא':      'badge badge-pres',
    'מונרך':     'badge badge-mon',
    'אחר':       'badge badge-other',
  };
  return `<span class="${map[role] || 'badge badge-other'}">${role}</span>`;
}

function genderCell(g) {
  if (!g || g === '—') return '<span class="gender-dot"><span class="dot dot-o"></span>—</span>';
  const isF = g.includes('נקב') || g.toLowerCase().includes('female');
  const isM = g.includes('זכר') || g.toLowerCase().includes('male');
  const cls = isF ? 'dot-f' : isM ? 'dot-m' : 'dot-o';
  const label = isF ? 'נקבה' : isM ? 'זכר' : g;
  return `<span class="gender-dot"><span class="dot ${cls}"></span>${label}</span>`;
}

function ageClass(age) {
  if (!age || isNaN(age)) return '';
  if (age < 50) return 'age-young';
  if (age < 70) return 'age-mid';
  return 'age-old';
}

// ─── State ───────────────────────────────────────────────────────────────────

let allData = [];
let filtered = [];
let sortCol = 'country';
let sortAsc = true;
let page = 0;
const PER_PAGE = 30;

// ─── Fetch & Parse ───────────────────────────────────────────────────────────

async function fetchData() {
  const url = `${ENDPOINT}?query=${encodeURIComponent(SPARQL)}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseRows(json) {
  const seen = new Set();
  const rows = [];

  for (const row of json.results.bindings) {
    const country    = row.countryLabel?.value    || '';
    const person     = row.personLabel?.value     || '';
    const position   = row.positionLabel?.value   || '';
    const occupation = row.occupations?.value || '—';
    const religion   = row.religions?.value  || '—';
    const gender     = row.genderLabel?.value     || '—';
    const birthDate  = row.birthDate?.value       || '';
    const startDate  = row.startDate?.value       || '';
    const age        = row.age?.value             ? parseInt(row.age.value) : null;
    const yio        = row.yearsInOffice?.value   ? parseInt(row.yearsInOffice.value) : null;
    const role       = classifyRole(position);

    // Deduplicate by country+person+role (multiple occupations/religions may cause dupes)
    const key = `${country}|${person}|${role}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({ country, person, position, role, gender, age, yio, startDate, birthDate, occupation, religion });
  }

  return rows;
}

// ─── Filter & Sort ───────────────────────────────────────────────────────────

function applyFilter() {
  const q    = document.getElementById('search').value.trim().toLowerCase();
  const role = document.getElementById('roleFilter').value;
  const gend = document.getElementById('genderFilter').value;

  filtered = allData.filter(d => {
    if (role && d.role !== role) return false;
    if (gend === 'זכר'  && !(d.gender.includes('זכר')  || d.gender.toLowerCase().includes('male')))   return false;
    if (gend === 'נקבה' && !(d.gender.includes('נקב') || d.gender.toLowerCase().includes('female'))) return false;
    if (q && !d.country.toLowerCase().includes(q) && !d.person.toLowerCase().includes(q)) return false;
    return true;
  });

  applySort();
  page = 0;
  renderStats();
  renderTable();
  renderPagination();
}

function applySort() {
  filtered.sort((a, b) => {
    let av, bv;
    switch (sortCol) {
      case 'country':       av = a.country;    bv = b.country;    break;
      case 'person':        av = a.person;     bv = b.person;     break;
      case 'role':          av = a.role;       bv = b.role;       break;
      case 'gender':        av = a.gender;     bv = b.gender;     break;
      case 'age':           av = a.age ?? 999; bv = b.age ?? 999; break;
      case 'yearsInOffice': av = a.yio ?? -1;  bv = b.yio ?? -1;  break;
      case 'startDate':     av = a.startDate;  bv = b.startDate;  break;
      case 'occupation':    av = a.occupation; bv = b.occupation; break;
      case 'religion':      av = a.religion;   bv = b.religion;   break;
      default:              av = a.country;    bv = b.country;
    }
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    return 0;
  });
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderStats() {
  const el = document.getElementById('stats');
  const counts = { total: filtered.length };
  for (const d of filtered) counts[d.role] = (counts[d.role] || 0) + 1;

  const items = [
    { label: 'סה"כ', value: counts.total, cls: 'accent' },
    { label: 'ראשי ממשלה', value: counts['ראש ממשלה'] || 0 },
    { label: 'נשיאים',     value: counts['נשיא']       || 0 },
    { label: 'מונרכים',    value: counts['מונרך']      || 0 },
  ];

  el.innerHTML = items.map(i =>
    `<div class="stat-card ${i.cls || ''}">
      <div class="stat-label">${i.label}</div>
      <div class="stat-value">${i.value}</div>
    </div>`
  ).join('');
}

function renderTable() {
  const tbody = document.getElementById('tbody');
  const table = document.getElementById('mainTable');
  const start = page * PER_PAGE;
  const slice = filtered.slice(start, start + PER_PAGE);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">אין תוצאות</td></tr>`;
    table.style.display = 'table';
    return;
  }

  tbody.innerHTML = slice.map(d => `
    <tr>
      <td class="country">${d.country}</td>
      <td class="name">${d.person}</td>
      <td>${roleBadge(d.role)}</td>
      <td>${genderCell(d.gender)}</td>
      <td class="${ageClass(d.age)}">${d.age != null ? d.age : '—'}</td>
      <td class="muted">${d.yio != null ? d.yio : '—'}</td>
      <td class="muted">${formatDate(d.startDate)}</td>
      <td class="muted">${d.occupation}</td>
      <td class="muted">${d.religion}</td>
    </tr>
  `).join('');

  table.style.display = 'table';

  // Update sort indicators
  document.querySelectorAll('thead th').forEach(th => {
    th.classList.remove('sorted', 'asc');
    if (th.dataset.col === sortCol) {
      th.classList.add('sorted');
      if (sortAsc) th.classList.add('asc');
    }
  });
}

function renderPagination() {
  const el = document.getElementById('pagination');
  const total = Math.ceil(filtered.length / PER_PAGE);
  if (total <= 1) { el.innerHTML = ''; return; }

  let html = '';
  for (let i = 0; i < total; i++) {
    html += `<button class="${i === page ? 'active' : ''}" data-page="${i}">${i + 1}</button>`;
  }
  el.innerHTML = html;

  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      page = parseInt(btn.dataset.page);
      renderTable();
      renderPagination();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// ─── Sort Clicks ─────────────────────────────────────────────────────────────

document.querySelectorAll('thead th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) {
      sortAsc = !sortAsc;
    } else {
      sortCol = col;
      sortAsc = true;
    }
    applySort();
    page = 0;
    renderTable();
    renderPagination();
  });
});

// ─── Filter Listeners ────────────────────────────────────────────────────────

document.getElementById('search').addEventListener('input', applyFilter);
document.getElementById('roleFilter').addEventListener('change', applyFilter);
document.getElementById('genderFilter').addEventListener('change', applyFilter);

// ─── Init ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const json = await fetchData();
    allData = parseRows(json);
    document.getElementById('loadMsg').style.display = 'none';
    applyFilter();
  } catch (err) {
    document.getElementById('loadMsg').style.display = 'none';
    const errEl = document.getElementById('errorMsg');
    errEl.style.display = 'block';
    errEl.textContent = `שגיאה בטעינה: ${err.message}`;
  }
})();
