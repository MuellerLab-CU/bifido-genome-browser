// Summary statistics tab (v1): a handful of top-line counts plus bar
// charts — genomes per species_subsp, genomes per country/region (stacked
// by species_subsp, top 15 by total), and a country x year heatmap grid.
// Like Tree/Map/Timeline (not Table), this respects the shared
// hierarchical filter: toggling a species/cluster off recomputes every
// number and chart here too. A second, Summary-only species picker
// (`#stats-species-dropdown` — a multi-select checkbox list, separate from
// that shared filter, which is cumbersome for isolating/comparing a
// handful of species out of 37) narrows every chart down to exactly the
// species picked, intersected with whatever the shared filter already
// allows. Three distinct modes, all driven by `selectedSpecies.size`: 0
// ("All") behaves exactly as if there were no picker; 1 drops every
// "by species/subspecies" qualifier and the now-redundant species bar
// chart entirely (see draw()); 2+ is "compare mode" (any count — only the
// heatmap grid caps at MAX_HEATMAP_SPECIES tiles, since that's the one
// chart where each extra species costs real screen space, not just an
// extra row/segment).
import { state, showTooltip, hideTooltip, COLOR_KEYS, colorKeyOf, colorKeyLabel } from "./main.js";

const GROUP_KEYS = COLOR_KEYS; // subspecies shades + plain groups (main.js)

const margin = { top: 10, right: 30, bottom: 30, left: 310 };
const ROW_HEIGHT = 22;
const TOP_N_COUNTRIES = 15;
const HEATMAP_CELL = 15;

// geo_loc_country is just the first token of geo_loc_name, taken
// independent of whether that string resolved to anywhere real — values
// like "missing"/"not determined"/"not applicable" would otherwise show up
// ranked as if they were actual countries. geo_precision !== "none" is the
// same resolved-location criterion the Map already uses.
function resolvedByCountry(genomes) {
  return genomes.filter((g) => g.geo_precision !== "none" && g.geo_loc_country);
}

function topCountries(genomes, n) {
  const totals = d3.rollup(
    resolvedByCountry(genomes),
    (rows) => rows.length,
    (g) => g.geo_loc_country
  );
  return Array.from(totals, ([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
    .map((d) => d.country);
}

// Empty set = "All" (every chart behaves exactly as if there were no
// picker at all). 1 selected narrows everything to that one species and
// drops the now-meaningless "by species/subspecies" chart/qualifiers (see
// draw()). 2+ selected is "compare mode": the species bar chart and
// country breakdown show exactly the selected set (any size — a sorted
// bar list or a stacked bar doesn't get harder to read with more rows),
// but the heatmap small-multiples grid caps at 8 tiles (picking the
// top-by-count among the selection) since that's the one chart where each
// extra species is a whole extra tile of screen real estate, not just a
// longer list.
const selectedSpecies = new Set();
const MAX_HEATMAP_SPECIES = 8;

export function renderStats() {
  buildSpeciesPicker();
  draw();

  // Same hidden-container-on-first-load issue as Map/Timeline: this panel
  // isn't the active tab at initial render, so clientWidth is 0 until it's
  // actually shown.
  document.addEventListener("panelActivated", (e) => {
    if (e.detail.panel === "panel-stats") draw();
  });
  document.addEventListener("filterChanged", draw);
}

function buildSpeciesPicker() {
  const toggleBtn = document.getElementById("stats-species-toggle");
  const toggleLabel = document.getElementById("stats-species-toggle-label");
  const dropdown = document.getElementById("stats-species-dropdown");
  const listEl = document.getElementById("stats-species-list");
  const checkboxes = new Map();

  state.speciesOrder.forEach((name) => {
    const row = document.createElement("label");
    row.className = "filter-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    const swatch = document.createElement("span");
    swatch.className = "filter-row__swatch";
    swatch.style.background = state.speciesColor(name);

    const label = document.createElement("span");
    label.className = "filter-row__label";
    label.textContent = name;

    row.append(checkbox, swatch, label);
    listEl.appendChild(row);
    checkboxes.set(name, checkbox);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedSpecies.add(name);
      else selectedSpecies.delete(name);
      updateToggleLabel();
      draw();
    });
  });

  function updateToggleLabel() {
    if (selectedSpecies.size === 0) toggleLabel.textContent = "All species/subspecies";
    else if (selectedSpecies.size === 1) toggleLabel.textContent = [...selectedSpecies][0];
    else toggleLabel.textContent = `${selectedSpecies.size} species/subspecies selected`;
  }

  document.getElementById("stats-species-clear").addEventListener("click", () => {
    selectedSpecies.clear();
    checkboxes.forEach((cb) => (cb.checked = false));
    updateToggleLabel();
    draw();
  });

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!dropdown.classList.contains("open")) return;
    if (dropdown.contains(e.target) || e.target === toggleBtn) return;
    dropdown.classList.remove("open");
  });
}

function activeGenomes() {
  return state.genomes.filter(
    (g) => state.activeClusterIds.has(g.cluster_id) && (selectedSpecies.size === 0 || selectedSpecies.has(g.species_subsp))
  );
}

function drawTiles(container, genomes) {
  const tilesEl = container.append("div").attr("class", "stats-tiles");

  const clusterIds = new Set(genomes.map((g) => g.cluster_id));
  const species = new Set(genomes.map((g) => g.species_subsp));
  const countries = new Set(genomes.map((g) => g.geo_loc_country).filter(Boolean));
  const tierCounts = d3.rollup(
    genomes,
    (rows) => rows.length,
    (g) => g.tier
  );

  const tiles = [
    ["Genomes shown", genomes.length],
    ["Clusters shown", clusterIds.size],
    ["Species/subspecies", species.size],
    ["Countries/regions", countries.size],
    ["Tier1", tierCounts.get("Tier1") || 0],
    ["Tier2", tierCounts.get("Tier2") || 0],
  ];

  tiles.forEach(([label, value]) => {
    const tile = tilesEl.append("div").attr("class", "stats-tile");
    tile.append("div").attr("class", "stats-tile__value").text(value.toLocaleString());
    tile.append("div").attr("class", "stats-tile__label").text(label);
  });
}

function drawSpeciesChart(container, genomes) {
  const wrap = container.append("div").attr("class", "stats-chart");
  wrap.append("h3").attr("class", "stats-chart__title").text("Genomes by species/subspecies");

  const counts = d3.rollup(
    genomes,
    (rows) => rows.length,
    (g) => g.species_subsp
  );
  const data = Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  const width = Math.max(wrap.node().clientWidth || 900, 500);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = data.length * ROW_HEIGHT;
  const height = innerHeight + margin.top + margin.bottom;

  const svg = wrap.append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(data.map((d) => d.name)).range([0, innerHeight]).padding(0.2);
  const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.count) || 1]).nice().range([0, innerWidth]);

  g.append("g")
    .attr("class", "axis grid")
    .call(d3.axisTop(x).ticks(6).tickSize(-innerHeight).tickFormat(""))
    .call((axis) => axis.select(".domain").remove())
    .selectAll("line")
    .attr("stroke", "#e8eaed");

  g.append("g")
    .attr("class", "axis y-axis")
    .call(d3.axisLeft(y).tickSize(0))
    .call((axis) => axis.select(".domain").remove());

  g.selectAll("rect.bar")
    .data(data)
    .join("rect")
    .attr("class", "bar")
    .attr("y", (d) => y(d.name))
    .attr("height", y.bandwidth())
    .attr("x", 0)
    .attr("width", (d) => x(d.count))
    .attr("rx", 3)
    .attr("fill", (d) => state.speciesColor(d.name))
    .on("mousemove", (event, d) => {
      showTooltip(event.clientX, event.clientY, d.name, [["Genomes", String(d.count)]]);
    })
    .on("mouseleave", hideTooltip);

  g.selectAll("text.bar-value")
    .data(data)
    .join("text")
    .attr("class", "bar-value")
    .attr("x", (d) => x(d.count) + 6)
    .attr("y", (d) => y(d.name) + y.bandwidth() / 2)
    .attr("dy", "0.32em")
    .attr("font-size", 11)
    .attr("fill", "#55606b")
    .text((d) => d.count);
}

function drawCountryChart(container, genomes) {
  const wrap = container.append("div").attr("class", "stats-chart");
  // "by species/subspecies" (the stacking) is meaningless noise once
  // exactly one species is selected — every segment would be the same
  // color anyway.
  const title =
    selectedSpecies.size === 1
      ? `Genomes by country/region (top ${TOP_N_COUNTRIES})`
      : `Genomes by country/region (top ${TOP_N_COUNTRIES}, coloured by species group)`;
  wrap.append("h3").attr("class", "stats-chart__title").text(title);

  const resolved = resolvedByCountry(genomes);
  const countries = topCountries(genomes, TOP_N_COUNTRIES);

  if (countries.length === 0) {
    wrap.append("p").attr("class", "stats-chart__empty").text("No resolved country/region data for the current filter.");
    return;
  }

  const totals = d3.rollup(
    resolved,
    (rows) => rows.length,
    (g) => g.geo_loc_country
  );

  const bySpeciesPerCountry = countries.map((country) => {
    const row = { country };
    // Stacked by colour group, not species_subsp (same-coloured segments
    // would merge visually — see main.js COLOR_GROUPS).
    GROUP_KEYS.forEach((k) => (row[k] = 0));
    resolved
      .filter((g) => g.geo_loc_country === country)
      .forEach((g) => (row[colorKeyOf(g.species_subsp)] += 1));
    return row;
  });

  const width = Math.max(wrap.node().clientWidth || 900, 500);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = countries.length * ROW_HEIGHT;
  const height = innerHeight + margin.top + margin.bottom;

  const svg = wrap.append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const y = d3.scaleBand().domain(countries).range([0, innerHeight]).padding(0.2);
  const totalByCountry = new Map(countries.map((c) => [c, totals.get(c) || 0]));
  const x = d3
    .scaleLinear()
    .domain([0, d3.max(Array.from(totalByCountry.values())) || 1])
    .nice()
    .range([0, innerWidth]);

  g.append("g")
    .attr("class", "axis grid")
    .call(d3.axisTop(x).ticks(6).tickSize(-innerHeight).tickFormat(""))
    .call((axis) => axis.select(".domain").remove())
    .selectAll("line")
    .attr("stroke", "#e8eaed");

  g.append("g")
    .attr("class", "axis y-axis")
    .call(d3.axisLeft(y).tickSize(0))
    .call((axis) => axis.select(".domain").remove());

  const stack = d3.stack().keys(GROUP_KEYS)(bySpeciesPerCountry);

  g.selectAll("g.series")
    .data(stack)
    .join("g")
    .attr("class", "series")
    .attr("fill", (d) => state.speciesColor(d.key))
    .selectAll("rect")
    .data((d) => d.map((v) => ({ ...v, key: d.key })))
    .join("rect")
    .attr("y", (d) => y(d.data.country))
    .attr("height", y.bandwidth())
    .attr("x", (d) => x(d[0]))
    .attr("width", (d) => Math.max(0, x(d[1]) - x(d[0])))
    .on("mousemove", (event, d) => {
      const count = d.data[d.key];
      if (count === 0) return;
      showTooltip(event.clientX, event.clientY, colorKeyLabel(d.key), [
        ["Country/Region", d.data.country],
        ["Genomes", String(count)],
      ]);
    })
    .on("mouseleave", hideTooltip);

  g.selectAll("text.bar-value")
    .data(countries)
    .join("text")
    .attr("class", "bar-value")
    .attr("x", (c) => x(totalByCountry.get(c)) + 6)
    .attr("y", (c) => y(c) + y.bandwidth() / 2)
    .attr("dy", "0.32em")
    .attr("font-size", 11)
    .attr("fill", "#55606b")
    .text((c) => totalByCountry.get(c));
}

// Small multiples instead of a single chart with species crammed in as a
// third dimension: a true 3D chart (or color+size both doing double duty
// in one 2D grid) trades away exactly what a heatmap is good for — every
// cell precisely comparable. One compact year x country heatmap per top
// species, tinted in that species' own palette color (white -> that hue,
// light = few genomes, dark = many), keeps every number readable and stays
// visually tied to the same color coding as every other panel. Genome
// counts are heavily skewed (the top 8 species cover the large majority of
// genomes) so the long tail is folded into one neutral-grey "all other
// species" tile rather than rendering ~30 mostly-empty grids.
function drawSpeciesLocationTimeHeatmaps(container, genomes) {
  const wrap = container.append("div").attr("class", "stats-chart");

  // `genomes` is already restricted to the picked species (see
  // activeGenomes()), so counting within it and reading off
  // `selectedSpecies` is enough to decide, per picker state: which species
  // get a tile, whether there's an "all other" bucket (only ever in "All"
  // mode — once the user has explicitly picked species, silently lumping
  // in anything else would be confusing, not helpful), and what the title
  // should say.
  const speciesCounts = d3.rollup(
    genomes,
    (rows) => rows.length,
    (g) => g.species_subsp
  );
  const byCountDesc = (names) =>
    names
      .map((name) => ({ name, count: speciesCounts.get(name) || 0 }))
      .sort((a, b) => b.count - a.count)
      .map((d) => d.name);

  let topSpecies, includeOtherBucket, title;
  if (selectedSpecies.size === 0) {
    topSpecies = byCountDesc(state.speciesOrder).slice(0, MAX_HEATMAP_SPECIES);
    includeOtherBucket = true;
    title = `Genomes by country/region and year (top ${MAX_HEATMAP_SPECIES} species/subspecies)`;
  } else if (selectedSpecies.size === 1) {
    topSpecies = [...selectedSpecies];
    includeOtherBucket = false;
    title = "Genomes by country/region and year";
  } else if (selectedSpecies.size <= MAX_HEATMAP_SPECIES) {
    topSpecies = byCountDesc([...selectedSpecies]);
    includeOtherBucket = false;
    title = "Genomes by country/region and year (selected species/subspecies)";
  } else {
    topSpecies = byCountDesc([...selectedSpecies]).slice(0, MAX_HEATMAP_SPECIES);
    includeOtherBucket = false;
    title = `Genomes by country/region and year (top ${MAX_HEATMAP_SPECIES} of ${selectedSpecies.size} selected)`;
  }
  wrap.append("h3").attr("class", "stats-chart__title").text(title);

  const dated = resolvedByCountry(genomes).filter((g) => g.submission_year != null);
  if (dated.length === 0) {
    wrap
      .append("p")
      .attr("class", "stats-chart__empty")
      .text("No genomes with both a resolved location and submission year for the current filter.");
    return;
  }

  // Shared axes across every tile (same countries, same years) so the small
  // multiples are actually comparable at a glance, not just individually
  // readable. Countries: same top-15 list as the chart above. Years: full
  // contiguous range (gaps rendered as empty cells, not skipped) so a quiet
  // year reads as "no activity" rather than silently compressing the axis.
  const countries = topCountries(genomes, TOP_N_COUNTRIES);
  const minYear = d3.min(dated, (g) => g.submission_year);
  const maxYear = d3.max(dated, (g) => g.submission_year);
  const years = d3.range(minYear, maxYear + 1);

  const topSpeciesSet = new Set(topSpecies);
  const groups = topSpecies.map((name) => ({
    name,
    color: state.speciesColor(name),
    genomes: dated.filter((g) => g.species_subsp === name),
  }));
  if (includeOtherBucket) {
    const otherGenomes = dated.filter((g) => !topSpeciesSet.has(g.species_subsp));
    if (otherGenomes.length > 0) {
      groups.push({ name: "All other species/subspecies", color: null, genomes: otherGenomes });
    }
  }

  const grid = wrap.append("div").attr("class", "heatmap-grid");
  groups.forEach((group) => drawHeatmapTile(grid, group, countries, years));
}

function drawHeatmapTile(container, group, countries, years) {
  const cell = HEATMAP_CELL;
  const tileMargin = { top: 4, right: 8, bottom: 20, left: 108 };
  const width = tileMargin.left + years.length * cell + tileMargin.right;
  const height = tileMargin.top + countries.length * cell + tileMargin.bottom;

  const tile = container.append("div").attr("class", "heatmap-tile");
  tile
    .append("div")
    .attr("class", "heatmap-tile__title")
    .style("color", group.color || "var(--ink-secondary)")
    .text(`${group.name} (${group.genomes.length})`);

  const counts = new Map();
  group.genomes.forEach((g) => {
    const key = `${g.geo_loc_country}|${g.submission_year}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const maxCount = d3.max(Array.from(counts.values())) || 1;
  const color = d3.scaleLinear().domain([0, maxCount]).range(["#f1f3f5", group.color || "#6b7684"]).interpolate(d3.interpolateRgb);

  const svg = tile.append("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${tileMargin.left},${tileMargin.top})`);

  g.selectAll("text.row-label")
    .data(countries)
    .join("text")
    .attr("class", "row-label")
    .attr("x", -6)
    .attr("y", (d, i) => i * cell + cell / 2)
    .attr("dy", "0.32em")
    .attr("text-anchor", "end")
    .text((d) => d);

  const cellsData = [];
  countries.forEach((country, ri) => {
    years.forEach((year, ci) => {
      cellsData.push({ country, year, ri, ci, count: counts.get(`${country}|${year}`) || 0 });
    });
  });

  g.selectAll("rect.cell")
    .data(cellsData)
    .join("rect")
    .attr("class", "cell")
    .attr("x", (d) => d.ci * cell)
    .attr("y", (d) => d.ri * cell)
    .attr("width", cell - 1)
    .attr("height", cell - 1)
    .attr("fill", (d) => (d.count === 0 ? "#fbfbfc" : color(d.count)))
    .on("mousemove", (event, d) => {
      if (d.count === 0) return;
      showTooltip(event.clientX, event.clientY, group.name, [
        ["Country/Region", d.country],
        ["Year", String(d.year)],
        ["Genomes", String(d.count)],
      ]);
    })
    .on("mouseleave", hideTooltip);

  const tickEvery = Math.max(1, Math.ceil(years.length / 6));
  g.selectAll("text.col-label")
    .data(years.filter((_, i) => i % tickEvery === 0))
    .join("text")
    .attr("class", "col-label")
    .attr("x", (y) => years.indexOf(y) * cell + cell / 2)
    .attr("y", countries.length * cell + 13)
    .attr("text-anchor", "middle")
    .text((y) => y);
}

function draw() {
  const container = d3.select("#stats-container");
  container.selectAll("*").remove();

  const genomes = activeGenomes();

  drawTiles(container, genomes);
  // A per-species breakdown is meaningless with exactly one species picked
  // — it would just be one bar restating the "Genomes shown" tile above.
  if (selectedSpecies.size !== 1) drawSpeciesChart(container, genomes);
  drawCountryChart(container, genomes);
  drawSpeciesLocationTimeHeatmaps(container, genomes);
}

window.addEventListener("resize", () => {
  if (document.getElementById("panel-stats").classList.contains("active")) draw();
});
