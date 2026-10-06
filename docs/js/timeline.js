// D3 stacked bar chart: submission_year x count, stacked/colored by
// colour key (main.js COLOR_KEYS — subspecies shades + six named species/Other;
// stacking by all ~37 species_subsp would put same-coloured segments on top
// of each other). Filtering comes from the shared hierarchical filter (see
// main.js initFilterControl) rather than a timeline-only legend — removing
// a cluster never repaints the colors of the ones that remain (same fixed
// speciesColor scale throughout). X domain is the actual observed year
// range in the data (2009-2026), not the 2016-2026 window CLAUDE.md's spec
// assumed.
import {
  state,
  showTooltip,
  hideTooltip,
  COLOR_KEYS,
  colorKeyOf,
  colorKeyLabel,
  highlightedClusterIds,
  clusterBadge,
} from "./main.js";

const GROUP_KEYS = COLOR_KEYS; // subspecies shades + plain groups (main.js)

const margin = { top: 20, right: 20, bottom: 34, left: 44 };
const MAX_BAR_WIDTH = 24;
const CHART_HEIGHT = 460;
const OVERLAY_HEIGHT = 60; // per highlighted cluster

export function renderTimeline() {
  draw();

  // Timeline is rendered during initial load while its panel is still
  // display:none (Tree is the active tab), so the container's clientWidth
  // is 0 at that point and draw() falls back to a fixed width. Redraw with
  // the real width the first time this tab is actually shown.
  document.addEventListener("panelActivated", (e) => {
    if (e.detail.panel === "panel-timeline") draw();
  });

  document.addEventListener("filterChanged", draw);

  // Selected or pinned clusters -> one strip each under the chart showing
  // exactly which years that cluster's own genomes fall in, aligned to the
  // same year axis as the main chart. A selected genome's cluster joins the
  // strips while pins exist (main.js highlightedClusterIds).
  ["clusterSelected", "genomeSelected", "pinsChanged"].forEach((type) => document.addEventListener(type, draw));
}

function computeSeries() {
  const byYear = d3.rollup(
    state.genomes,
    (rows) => {
      const counts = {};
      GROUP_KEYS.forEach((k) => (counts[k] = 0));
      rows.forEach((g) => {
        if (state.activeClusterIds.has(g.cluster_id)) counts[colorKeyOf(g.species_subsp)] += 1;
      });
      return counts;
    },
    (g) => g.submission_year
  );

  const years = Array.from(byYear.keys())
    .filter((y) => y != null)
    .sort((a, b) => a - b);

  const data = years.map((year) => ({ year, ...byYear.get(year) }));
  return { years, data };
}

function draw() {
  const container = d3.select("#timeline-container");
  container.selectAll("*").remove();

  const { years, data } = computeSeries();
  const activeOrder = GROUP_KEYS;

  const width = Math.max(container.node().clientWidth, 600);
  const overlayIds = highlightedClusterIds();
  const totalHeight = CHART_HEIGHT + overlayIds.length * OVERLAY_HEIGHT;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = CHART_HEIGHT - margin.top - margin.bottom;

  const svg = container
    .append("svg")
    .attr("id", "timeline-svg")
    .attr("width", width)
    .attr("height", totalHeight);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(years).range([0, innerWidth]).paddingInner(0.3);

  const stack = d3.stack().keys(activeOrder)(data);
  const yMax = d3.max(data, (d) => activeOrder.reduce((sum, k) => sum + d[k], 0)) || 1;
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerHeight, 0]);

  // Gridlines (recessive, hairline, solid).
  g.append("g")
    .attr("class", "axis grid")
    .call(d3.axisLeft(y).ticks(6).tickSize(-innerWidth).tickFormat(""))
    .call((axis) => axis.select(".domain").remove())
    .selectAll("line")
    .attr("stroke", "#e8eaed");

  const barWidth = Math.min(x.bandwidth(), MAX_BAR_WIDTH);
  const barOffset = (x.bandwidth() - barWidth) / 2;

  const seriesG = g
    .selectAll("g.series")
    .data(stack)
    .join("g")
    .attr("class", "series")
    .attr("fill", (d) => state.speciesColor(d.key));

  seriesG
    .selectAll("rect")
    .data((d) => d.map((v) => ({ ...v, key: d.key })))
    .join("rect")
    .attr("class", "bar")
    .attr("x", (d) => x(d.data.year) + barOffset)
    .attr("width", barWidth)
    .attr("y", (d) => y(d[1]))
    .attr("height", (d) => Math.max(0, y(d[0]) - y(d[1])))
    .attr("rx", 0)
    .on("mousemove", (event, d) => {
      const count = d.data[d.key];
      if (count === 0) return;
      showTooltip(event.clientX, event.clientY, colorKeyLabel(d.key), [
        ["Year", String(d.data.year)],
        ["Genomes", String(count)],
      ]);
    })
    .on("mouseleave", hideTooltip);

  // Round only the top cap of each bar's topmost non-zero segment.
  seriesG.each(function (seriesData, seriesIndex) {
    d3.select(this)
      .selectAll("rect")
      .each(function (d) {
        const isTop = topSeriesForYear(stack, d.data.year) === d.key;
        if (isTop && d.data[d.key] > 0) {
          d3.select(this).attr("rx", 4).attr("ry", 4);
        }
      });
  });

  // Axes
  g.append("g")
    .attr("class", "axis x-axis")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).tickValues(years.filter((_, i) => i % Math.ceil(years.length / 18) === 0)));

  g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).ticks(6));

  g.append("text")
    .attr("class", "axis-label")
    .attr("x", -margin.left + 10)
    .attr("y", -8)
    .attr("fill", "#8a939c")
    .attr("font-size", 11)
    .text("Genomes");

  overlayIds.forEach((id, i) => {
    const overlayG = svg
      .append("g")
      .attr("class", "cluster-overlay")
      .attr("transform", `translate(${margin.left},${CHART_HEIGHT + 8 + i * OVERLAY_HEIGHT})`);
    renderClusterOverlay(overlayG, id, x, barOffset, barWidth);
  });
}

// Draws a small strip below the main chart showing exactly which years this
// cluster's own genomes fall in, x-aligned to the same year bands as the
// bars above — deliberately not touching the main chart's opacity/data, per
// the "too much traffic" pushback on the earlier ghost-context prototype.
function renderClusterOverlay(g, clusterId, x, barOffset, barWidth) {
  const cluster = state.clusters.find((c) => c.cluster_id === clusterId);
  if (!cluster) return;

  const members = cluster.members.map((a) => state.genomesByAccession.get(a)).filter(Boolean);
  const dated = members.filter((m) => m.submission_year != null);
  const color = state.speciesColor(cluster.species_subsp);
  const baseline = 42;

  g.append("line").attr("x1", 0).attr("x2", x.range()[1]).attr("y1", baseline).attr("y2", baseline).attr("stroke", "#e2e5e8");

  // Number badge (same as the tree/panel/map) while 2+ clusters are compared.
  const badge = clusterBadge(clusterId);
  if (badge) {
    const b = g.append("g").attr("transform", "translate(-22,6)");
    b.append("circle").attr("class", "svg-badge__disc").attr("r", 8);
    b.append("text").attr("class", "svg-badge__text").attr("dy", "0.34em").text(badge);
  }

  g.append("text")
    .attr("x", 0)
    .attr("y", 10)
    .attr("font-size", 11)
    .attr("fill", "#55606b")
    .text(
      `Cluster ${cluster.cluster_id} (${cluster.species_subsp}) — ${dated.length} of ${members.length} member${members.length === 1 ? "" : "s"} dated`
    );

  const stackCount = {};
  dated.forEach((m) => {
    const bandStart = x(m.submission_year);
    if (bandStart === undefined) return;
    stackCount[m.submission_year] = (stackCount[m.submission_year] || 0) + 1;
    const k = stackCount[m.submission_year];
    const cx = bandStart + barOffset + barWidth / 2;
    const cy = Math.max(18, baseline - 10 - (k - 1) * 11);

    const dot = g
      .append("circle")
      .attr("cx", cx)
      .attr("cy", cy)
      .attr("r", 4.5)
      .attr("fill", color)
      .attr("stroke", "#fff")
      .attr("stroke-width", 1);
    dot.append("title").text(`${m.assembly_accession}${m.is_rep ? " (rep)" : ""} — ${m.submission_year}`);
  });
}

function topSeriesForYear(stack, year) {
  let top = null;
  stack.forEach((series) => {
    const point = series.find((d) => d.data.year === year);
    if (point && point.data[series.key] > 0) top = series.key;
  });
  return top;
}

window.addEventListener("resize", () => {
  if (document.getElementById("panel-timeline").classList.contains("active")) draw();
});
