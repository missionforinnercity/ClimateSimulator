const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const kpis = item => item?.summary?.kpis || item?.kpis || {};
const results = report => report.areaAnalysis?.results || {};

export function weightedGroups(samples, key) {
  const groups = new Map();
  for (const sample of samples || []) {
    const name = String(sample[key] || '').trim();
    if (!name || !finite(sample.value) || !finite(sample.area_m2) || Number(sample.area_m2) <= 0) continue;
    const group = groups.get(name) || { label: name, area: 0, total: 0 };
    group.area += Number(sample.area_m2);
    group.total += Number(sample.value) * Number(sample.area_m2);
    groups.set(name, group);
  }
  return [...groups.values()].map(group => ({ label: group.label, value: group.total / group.area, area: group.area }));
}

export function buildReportFacts(report) {
  const data = results(report), facts = [];
  const add = (id, label, value, unit, context) => {
    if (finite(value)) facts.push({ id, label: label.slice(0, 160), value: Number(value), unit, context: context.slice(0, 320) });
  };
  if (data.heat?.status === 'ready') {
    const context = 'Mapped surface temperature, not air temperature or personal comfort. Study date: ' + (data.heat.summary?.scenario?.date || 'unknown') + '.';
    add('heat_mean', 'Average mapped surface temperature', kpis(data.heat).average_surface_temperature_c, '°C', context);
    const streets = weightedGroups(data.heat.samples, 'nearest_road_name').sort((a, b) => b.value - a.value);
    if (streets.length > 1) {
      add('heat_warm_street', 'Warmer mapped surfaces near ' + streets[0].label, streets[0].value, '°C', context + ' Highest street-group average within this square.');
      add('heat_cool_street', 'Cooler mapped surfaces near ' + streets.at(-1).label, streets.at(-1).value, '°C', context + ' Lowest street-group average within this square.');
    }
  }
  if (data.sun?.status === 'ready') {
    const scenario = data.sun.summary?.scenario || {};
    add('sun_mean', 'Average direct sunlight', kpis(data.sun).average_direct_sun_hours, 'h',
      'Clear-sky model over mapped surfaces. Date ' + (scenario.date || 'unknown') + '; window in local minutes: ' + (scenario.start_minutes ?? 'unknown') + '–' + (scenario.end_minutes ?? 'unknown') + '. Clouds are excluded.');
  }
  if (data.wind?.status === 'ready') {
    const context = data.wind.result_source === 'single-direction-fallback'
      ? 'Exploratory one-direction wind screen only; not seasonal comfort or measured conditions.'
      : 'Exploratory modelled pedestrian wind for ' + (data.wind.season || 'the selected period') + '; not measured or certified comfort.';
    if (finite(kpis(data.wind).mean_speed_mps)) add('wind_mean', 'Average modelled pedestrian wind', Number(kpis(data.wind).mean_speed_mps) * 3.6, 'km/h', context);
    for (const [key, title] of [['best', 'More sheltered mapped street: '], ['worst', 'More exposed mapped street: ']]) {
      const street = data.wind.street_rankings?.[key]?.[0];
      if (street?.name && finite(street.mean_speed_mps)) add('wind_' + key + '_street', title + street.name, Number(street.mean_speed_mps) * 3.6, 'km/h', context + ' Relative ranking within this square.');
    }
  }
  if (data.viewshed?.status === 'ready') add('visibility', 'Ground visible from the selected observer point', kpis(data.viewshed).visible_ground_pct, '%', 'One observer point near the centre. Trees and small objects are not included as obstacles. No safety conclusion can be drawn.');
  if (report.siteContext?.status === 'ready') add('canopy', 'Approximate mapped canopy cover', report.siteContext.canopy_cover_pct, '%', 'Mapped crown footprint coverage only; not current tree health, tree count, species or actual shade hours. No site suitability data for planting.');
  return facts;
}

export function buildReportComparisons(report) {
  const data = results(report), charts = [];
  if (data.heat?.status === 'ready') {
    const rows = weightedGroups(data.heat.samples, 'nearest_road_name').sort((a, b) => b.value - a.value).slice(0, 5);
    if (rows.length > 1) charts.push({ title: 'Surface heat around named streets', unit: '°C',
      note: 'Up to five warmest street-group averages. Surface samples are assigned to their nearest street and weighted by area.', rows });
  }
  if (data.sun?.status === 'ready') {
    const rows = weightedGroups(data.sun.samples, 'surface_type').sort((a, b) => b.area - a.area).slice(0, 5)
      .map(row => ({ ...row, label: row.label.replaceAll('_', ' ') }));
    if (rows.length > 1) charts.push({ title: 'Direct sunlight by mapped surface', unit: 'h',
      note: 'Average direct sunlight during the recorded study window; the five largest mapped surface groups are shown.', rows });
  }
  const studies = (data.wind?.directional_studies || []).filter(item => item.status === 'ready' && finite(kpis(item).mean_speed_mps));
  if (studies.length > 1) charts.push({ title: 'How wind changes with direction', unit: 'km/h',
    note: 'Mean modelled speed for each solved direction. These separate cases do not describe how often each wind occurs.',
    rows: studies.map(item => ({ label: item.key === 'se' ? 'From southeast' : item.key === 'nw' ? 'From northwest' : item.label, value: Number(kpis(item).mean_speed_mps) * 3.6 })) });
  return charts;
}
