// ─── SPARQL Query ───────────────────────────────────────────────────────────

const SPARQL = `
SELECT
  ?countryLabel ?personLabel ?stmtRole ?startDate
  ?genderLabel ?birthDate ?age ?yearsInOffice
  ?occupations ?religions ?isMonarch
WHERE {
  {
    SELECT
      ?country ?person ?stmtRole ?startDate ?gender ?birthDate ?isMonarch
      (GROUP_CONCAT(DISTINCT ?occupation; separator=", ") AS ?occupationList)
      (GROUP_CONCAT(DISTINCT ?religion;  separator=", ") AS ?religionList)
    WHERE {
      ?country wdt:P31 wd:Q6256.
      {
        ?country p:P35 ?stmt.
        ?stmt ps:P35 ?person.
        BIND("head_of_state" AS ?stmtRole)
      } UNION {
        ?country p:P6 ?stmt.
        ?stmt ps:P6 ?person.
        BIND("head_of_government" AS ?stmtRole)
      }
      FILTER NOT EXISTS { ?stmt pq:P582 ?endDate }
      OPTIONAL { ?stmt pq:P580 ?startDate }
      OPTIONAL { ?person wdt:P21 ?gender. }
      OPTIONAL { ?person wdt:P569 ?birthDate. }
      OPTIONAL {
        ?person wdt:P39 ?posEnt.
        ?posEnt wdt:P279* wd:Q116.
        BIND("true" AS ?isMonarch)
      }
      OPTIONAL { ?person wdt:P106 ?occupationEntity.
                 OPTIONAL { ?occupationEntity rdfs:label ?occupation.
                            FILTER(LANG(?occupation) = "en") } }
      OPTIONAL { ?person wdt:P140 ?religionEntity.
                 OPTIONAL { ?religionEntity rdfs:label ?religion.
                            FILTER(LANG(?religion) = "en") } }
    }
    GROUP BY ?country ?person ?stmtRole ?startDate ?gender ?birthDate ?isMonarch
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
  BIND(IF(?occupationList != "", ?occupationList, "") AS ?occupations)
  BIND(IF(?religionList   != "", ?religionList,   "") AS ?religions)

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?countryLabel
`;

const ENDPOINT = 'https://query.wikidata.org/sparql';

// ─── Role Classification ─────────────────────────────────────────────────────
// Based on stmt property (P35/P6) + monarch check — NOT on label strings

function classifyRole(stmtRole, isMonarch) {
  if (stmtRole === 'head_of_government') return 'Prime Minister';
  if (stmtRole === 'head_of_state') {
    if (isMonarch === 'true') return 'Monarch';
    return 'President';
  }
  return 'Other';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '—';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  // If Jan 1 — likely year-precision only, show year only
  if (m[2] === '01' && m[3] === '01') return m[1];
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function sanitizeAge(age) {
  if (age == null || isNaN(age)) return null;
  if (age < 20 || age > 120) return null;
  return age;
}

function sanitizeYIO(yio) {
  if (yio == null || isNaN(yio)) return null;
  if (yio < 0 || yio > 80) return null;
  return yio;
}

function sanitizeOccupation(occ) {
  if (!occ) return '—';
  // Remove trivial-only entries
  const parts = occ.split(', ').filter(p => p.trim().toLowerCase() !== 'politician');
  return parts.length > 0 ? parts.join(', ') : 'politician';
}

function roleBadge(role) {
  const map = {
    'Prime Minister': 'badge badge-pm',
    'President':      'badge badge-pres',
    'Monarch':        'badge badge-mon',
    'Other':          'badge badge-other',
  };
  return `<span class="${map[role] || 'badge badge-other'}">${role}</span>`;
}

function genderCell(g) {
  if (!g || g === '—') return '<span class="gender-dot"><span class="dot dot-o"></span>—</span>';
  const isF = g.toLowerCase().includes('female');
  const isM = g.toLowerCase().includes('male');
  const cls   = isF ? 'dot-f' : isM ? 'dot-m' : 'dot-o';
  const label = isF ? 'Female' : isM ? 'Male' : g;
  return `<span class="gender-dot"><span class="dot ${cls}"></span>${label}</span>`;
}

function ageClass(age) {
  if (age == null) return '';
  if (age < 50) return 'age-young';
  if (age < 70) return 'age-mid';
  return 'age-old';
}

// ─── State ───────────────────────────────────────────────────────────────────

let allData = [];
let filtered = [];
let sortCol  = 'country';
let sortAsc  = true;
let page     = 0;
const PER_PAGE = 30;

// ─── Fetch & Parse ───────────────────────────────────────────────────────────

async function fetchData() {
  const url = `${ENDPOINT}?query=${encodeURIComponent(SPARQL)}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseRows(json) {
  // Dedup key: country|person|stmtRole — allows same person in two roles (e.g. US president)
  // but blocks duplicate rows for same role
  const seen = new Set();
  const rows = [];

  for (const row of json.results.bindings) {
    const country   = row.countryLabel?.value || '';
    const person    = row.personLabel?.value  || '';
    const stmtRole  = row.stmtRole?.value     || '';
    const isMonarch = row.isMonarch?.value    || '';
    const gender    = row.genderLabel?.value  || '—';
    const birthDate = row.birthDate?.value    || '';
    const startDate = row.startDate?.value    || '';

    const rawAge = row.age?.value          ? parseInt(row.age.value)           : null;
    const rawYio = row.yearsInOffice?.value ? parseInt(row.yearsInOffice.value) : null;
    const age    = sanitizeAge(rawAge);
    const yio    = sanitizeYIO(rawYio);

    const rawOcc    = row.occupations?.value || '';
    const rawRel    = row.religions?.value   || '';
    const occupation = sanitizeOccupation(rawOcc);
    const religion   = rawRel || '—';

    const role = classifyRole(stmtRole, isMonarch);

    // Skip clearly bad rows
    if (!country || !person) continue;

    const key = `${country}|${person}|${stmtRole}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({ country, person, stmtRole, role, gender, age, yio, startDate, birthDate, occupation, religion });
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
    const g = d.gender.toLowerCase();
    if (gend === 'male'   && !g.includes('male'))   return false;
    if (gend === 'female' && !g.includes('female')) return false;
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
      case 'country':       av = a.country;     bv = b.country;     break;
      case 'person':        av = a.person;      bv = b.person;      break;
      case 'role':          av = a.role;        bv = b.role;        break;
      case 'gender':        av = a.gender;      bv = b.gender;      break;
      case 'age':           av = a.age  ?? 999; bv = b.age  ?? 999; break;
      case 'yearsInOffice': av = a.yio  ?? -1;  bv = b.yio  ?? -1;  break;
      case 'startDate':     av = a.startDate;   bv = b.startDate;   break;
      case 'occupation':    av = a.occupation;  bv = b.occupation;  break;
      case 'religion':      av = a.religion;    bv = b.religion;    break;
      default:              av = a.country;     bv = b.country;
    }
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ?  1 : -1;
    return 0;
  });
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderStats() {
  const el = document.getElementById('stats');
  const counts = { total: filtered.length };
  for (const d of filtered) counts[d.role] = (counts[d.role] || 0) + 1;

  const items = [
    { label: 'Total',           value: counts.total,                   cls: 'accent' },
    { label: 'Prime Ministers', value: counts['Prime Minister'] || 0 },
    { label: 'Presidents',      value: counts['President']      || 0 },
    { label: 'Monarchs',        value: counts['Monarch']        || 0 },
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
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">No results found</td></tr>`;
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
    errEl.textContent = `Error loading data: ${err.message}`;
  }
})();
