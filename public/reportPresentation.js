// This function is embedded in the exported HTML. Keep it self-contained so
// downloaded reports need no network connection or module imports.
export function renderReportEnrichment(report) {
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const number = value => new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 1 }).format(value);
  const facts = new Map((report.enrichment?.facts || []).map(fact => [fact.id, fact]));
  const citations = (parent, ids) => {
    const list = make('ul', 'evidence-chips');
    for (const id of ids || []) {
      const fact = facts.get(id);
      if (!fact) continue;
      const item = make('li', '', fact.label + ': ' + number(fact.value) + ' ' + fact.unit);
      item.title = fact.context;
      list.append(item);
    }
    parent.append(list);
  };
  const ai = report.enrichment?.ai;
  const status = document.getElementById('ai-status');
  if (ai?.status === 'ready' && ai.brief) {
    status.textContent = 'AI-assisted interpretation · Gemini · Based on the evidence shown below; review suggested actions on site.';
    document.getElementById('overview-copy').textContent = ai.brief.overview.text;
    citations(document.getElementById('ai-overview-evidence'), ai.brief.overview.evidence_ids);
    const insights = document.getElementById('ai-insights');
    for (const item of ai.brief.insights) {
      const card = make('article', 'insight-card');
      card.append(make('h3', '', item.title), make('p', '', item.text));
      citations(card, item.evidence_ids);
      insights.append(card);
    }
    document.getElementById('ai-insights-section').hidden = !insights.childElementCount;
    const priorities = document.getElementById('priority-list');
    priorities.replaceChildren();
    for (const item of ai.brief.next_steps) {
      const row = make('li');
      row.append(make('strong', '', item.title), make('span', '', item.text));
      citations(row, item.evidence_ids);
      priorities.append(row);
    }
  } else if (ai?.status === 'unavailable') {
    status.textContent = ai.reason || 'AI interpretation is unavailable. The report uses the recorded results directly.';
  }

  const context = report.enrichment?.placeContext;
  const placeSection = document.getElementById('place-section');
  const groups = (context?.groups || []).filter(group => group.status === 'ready');
  if (groups.length) {
    placeSection.hidden = false;
    const plot = document.getElementById('place-chart');
    const maximum = Math.max(1, ...groups.flatMap(group => [group.inside_count, group.nearby_count]));
    for (const group of groups) {
      const row = make('div', 'place-chart-row');
      row.append(make('strong', '', group.title));
      for (const [key, title, style] of [['inside_count', 'Inside square', 'inside'], ['nearby_count', 'Nearby outside square', 'nearby']]) {
        const entry = make('div', 'place-bar-row');
        const track = make('div', 'comparison-track');
        const bar = make('i', style); bar.style.width = (group[key] / maximum * 100) + '%'; track.append(bar);
        entry.append(make('span', '', title), track, make('b', '', String(group[key])));
        row.append(entry);
      }
      plot.append(row);
    }
    const details = document.getElementById('place-details');
    for (const group of groups) {
      const card = make('article', 'insight-card');
      card.append(make('h3', '', group.title));
      const list = make('ul', 'place-list');
      // Named facilities help locate the square; unnamed crossing rows add noise.
      if (group.key !== 'crossings') {
        for (const place of group.places || []) {
          const row = make('li');
          row.append(make('span', '', place.name), make('small', '', place.inside ? 'Inside the square' : number(place.distance_m) + ' m from square edge'));
          list.append(row);
        }
      }
      if (list.childElementCount) card.append(list);
      else card.append(make('p', '', group.key === 'crossings'
        ? 'Mapped crossing points can guide a walk-through. Their condition and suitability still need checking.'
        : 'No mapped locations were found inside or within the nearby search area.'));
      const link = make('a', 'source-link', 'City dataset ↗');
      // Links come from the server allow-list, with a scheme check for imported reports.
      if (/^https:\/\/www\.arcgis\.com\/home\/item\.html\?id=[a-f0-9]{32}$/.test(group.source?.url || '')) {
        link.href = group.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      }
      details.append(card);
    }
    document.getElementById('place-note').textContent = context.note;
    const missing = (context.groups || []).filter(group => group.status !== 'ready');
    if (missing.length) document.getElementById('place-note').append(' Unavailable layers: ' + missing.map(group => group.title).join(', ') + '.');
  } else if (context?.status === 'unavailable') {
    placeSection.hidden = false;
    document.getElementById('place-note').textContent = context.note || 'Local amenity data is unavailable for this report.';
  }

  const charts = document.getElementById('area-charts');
  for (const chart of report.comparisons || []) {
    if (!chart.rows?.length) continue;
    const card = make('article', 'area-chart-card');
    card.append(make('h3', '', chart.title), make('p', '', chart.note));
    const minimum = Math.min(0, ...chart.rows.map(row => row.value));
    const maximum = Math.max(0, ...chart.rows.map(row => row.value));
    const range = maximum - minimum || 1;
    const zero = -minimum / range * 100;
    const list = make('ol', 'comparison-list');
    for (const row of chart.rows) {
      const entry = make('li');
      entry.append(make('span', 'comparison-label', row.label));
      const track = make('div', 'comparison-track');
      const bar = make('i');
      const end = (row.value - minimum) / range * 100;
      bar.style.left = Math.min(zero, end) + '%';
      bar.style.width = Math.abs(end - zero) + '%';
      track.append(bar);
      entry.append(track, make('strong', '', number(row.value) + ' ' + chart.unit));
      list.append(entry);
    }
    card.append(list); charts.append(card);
  }
  if (charts.childElementCount) document.getElementById('charts-section').hidden = false;
}
