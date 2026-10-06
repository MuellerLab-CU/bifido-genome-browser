// Tree tab, overview half: a radial species -> cluster tree that NEVER
// expands in place. Clicking a cluster opens its real ANI dendrogram in the
// side panel (clusterDetail.js) instead.
//
// Why not expand inline (the previous design): one big cluster's leaves
// competed with every other node for the same circle — a 90-genome cluster
// took ~90% of it, reflowed every other node, and looked like an explosion.
// Keeping the overview fixed also means species labels can be laid out once
// per zoom level instead of jumping around on every click.
//
// Labels and dots are drawn at a constant on-screen size (counter-scaled
// against the zoom), so the default "whole circle" view is readable and
// zooming in only spreads things out rather than inflating the text.
import { state, selectCluster, togglePin, comparedClusterIds, clusterBadge, showTooltip, hideTooltip } from "./main.js";

// Layout units (pre-zoom). Only ratios matter; fitToView() scales to fit.
const R_SPECIES = 330;
const R_CLUSTER = 700;
const R_ARC_INNER = 714; // species arc band, just outside the cluster dots
const R_ARC_OUTER = 726;
const R_LABEL = 734; // label anchor point (leader lines start here)

// Screen-pixel sizes (constant regardless of zoom).
const DOT_R = 4;
const DOT_HIT_R = 8;
const BADGE_R = 7.5; // comparison number badge
const BADGE_OFFSET_PX = 15; // badge sits this far inward from its dot
const SPECIES_DOT_R = 4.5;
const LABEL_GAP_PX = 18; // min vertical distance between stacked labels
const LABEL_X_PX = 8; // horizontal gap from anchor to text
const LABEL_W_PX = 250; // budget reserved for labels when fitting to view

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 12;

// Leave a gap at 12 o'clock so the first and last species aren't drawn
// next to each other (d3.tree never compares those two, so it can't keep
// them apart on its own).
const SWEEP = 2 * Math.PI * 0.95;

const treeLayout = d3
  .tree()
  .size([SWEEP, 1])
  .separation((a, b) => (a.parent === b.parent ? 1 : 6)); // gap between species groups

let root = null;
let svg, g, gLinks, gArcs, gNodes, gBadges, gLabels, zoomBehavior;
let currentK = 1;

export function renderTree() {
  const container = d3.select("#tree-container");
  container.selectAll("*").remove();

  svg = container.append("svg").attr("id", "tree-svg");
  sizeSvg();

  g = svg.append("g");
  gLinks = g.append("g").attr("class", "links");
  gArcs = g.append("g").attr("class", "species-arcs");
  gNodes = g.append("g").attr("class", "nodes");
  gBadges = g.append("g").attr("class", "tree-badges");
  gLabels = g.append("g").attr("class", "species-labels");

  zoomBehavior = d3
    .zoom()
    .scaleExtent([MIN_ZOOM, MAX_ZOOM])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
      if (event.transform.k !== currentK) {
        currentK = event.transform.k;
        applyScreenSizes();
      }
    });
  svg.call(zoomBehavior).on("dblclick.zoom", null);

  build();
  fitToView(false);
  initToolbar();

  document.addEventListener("filterChanged", () => {
    build();
    fitToView(true);
  });
  // Highlight = every cluster in the detail panel (pins + current selection).
  ["clusterSelected", "genomeSelected", "pinsChanged", "clusterDetailClosed"].forEach((type) =>
    document.addEventListener(type, setHighlight)
  );
  // The detail panel opening/closing changes the overview's width.
  document.addEventListener("clusterDetailToggled", refit);
  document.addEventListener("panelActivated", (e) => {
    if (e.detail.panel === "panel-tree") refit();
  });
  window.addEventListener("resize", () => {
    if (document.getElementById("panel-tree").classList.contains("active")) refit();
  });
}

function sizeSvg() {
  const node = document.getElementById("tree-container");
  const width = node.clientWidth || 900;
  const height = node.clientHeight || 720;
  svg.attr("width", width).attr("height", height);
}

function refit() {
  if (!document.getElementById("tree-container").clientWidth) return; // tab hidden
  sizeSvg();
  fitToView(true);
}

function initToolbar() {
  document.getElementById("tree-zoom-in").addEventListener("click", () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.5);
  });
  document.getElementById("tree-zoom-out").addEventListener("click", () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.5);
  });
  document.getElementById("tree-zoom-reset").addEventListener("click", () => fitToView(true));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Species with no active cluster (after filtering) simply don't appear.
function build() {
  const filtered = {
    name: "root",
    children: state.tree.children
      .map((sp) => {
        const clusters = sp.children
          .filter((cl) => state.activeClusterIds.has(cl.name))
          .map((cl) => ({ ...cl, children: undefined, kind: "cluster" }));
        return clusters.length ? { name: sp.name, kind: "species", children: clusters } : null;
      })
      .filter(Boolean),
  };

  root = d3.hierarchy(filtered);
  treeLayout(root);
  root.each((d) => {
    d.radius = d.depth === 0 ? 0 : d.depth === 1 ? R_SPECIES : R_CLUSTER;
  });

  drawLinks();
  drawNodes();
  drawSpeciesArcsAndLabels();
  applyScreenSizes();
  setHighlight();
}

function project(angle, radius) {
  const a = angle - Math.PI / 2;
  return [radius * Math.cos(a), radius * Math.sin(a)];
}

function drawLinks() {
  const link = d3
    .linkRadial()
    .angle((d) => d.x)
    .radius((d) => d.radius);
  gLinks
    .selectAll("path.link")
    .data(root.links(), (d) => d.target.data.name)
    .join("path")
    .attr("class", "link")
    .attr("d", link);
}

function drawNodes() {
  const species = root.children || [];
  const clusters = root.leaves().filter((d) => d.depth === 2);

  gNodes
    .selectAll("circle.species-node")
    .data(species, (d) => d.data.name)
    .join("circle")
    .attr("class", "species-node")
    .attr("cx", (d) => project(d.x, d.radius)[0])
    .attr("cy", (d) => project(d.x, d.radius)[1])
    .attr("fill", (d) => state.speciesColor(d.data.name))
    .on("mousemove", (event, d) =>
      showTooltip(event.clientX, event.clientY, d.data.name, [
        ["Clusters", String(d.children.length)],
        ["Genomes", String(d3.sum(d.children, (c) => c.data.member_count))],
      ])
    )
    .on("mouseleave", hideTooltip);

  const sel = gNodes
    .selectAll("g.cluster-node")
    .data(clusters, (d) => d.data.name)
    .join((enter) => {
      const ge = enter.append("g").attr("class", "cluster-node");
      ge.append("circle").attr("class", "cluster-node__hit");
      ge.append("circle").attr("class", "cluster-node__dot");
      return ge;
    })
    .attr("transform", (d) => `translate(${project(d.x, d.radius)})`)
    .classed("cluster-node--tier2", (d) => d.data.rep_tier !== "Tier1")
    .on("click", (event, d) => {
      event.stopPropagation();
      hideTooltip();
      // Shift-click pins/unpins straight away; a plain click previews.
      if (event.shiftKey) togglePin(d.data.name);
      else selectCluster(d.data.name); // clusterDetail.js opens its panel on this event
    })
    .on("mousemove", (event, d) => {
      const rows = [
        ["Species/subspecies", d.parent.data.name],
        ["Representative", d.data.rep],
        ["Rep tier", d.data.rep_tier || "—"],
        ["Genomes", String(d.data.member_count)],
      ];
      if (d.data.max_height > 0) rows.push(["Lowest ANI in cluster", fmtAni(1 - d.data.max_height)]);
      (d.data.species_subsp_breakdown || []).forEach((b) => rows.push([`  ${b.species_subsp}`, `${b.count}`]));
      showTooltip(event.clientX, event.clientY, `Cluster ${d.data.name} — click for details, shift-click to pin`, rows);
    })
    .on("mouseleave", hideTooltip);

  sel.select(".cluster-node__dot").attr("stroke", (d) => state.speciesColor(d.parent.data.name));
}

function fmtAni(v) {
  return `${(v * 100).toFixed(2)}%`;
}

// Species are drawn as a coloured arc spanning their clusters, labelled at
// the arc's midpoint, outside the ring.
function drawSpeciesArcsAndLabels() {
  const species = root.children || [];

  // Angular width of one cluster slot, to pad each arc by half a slot.
  let step = Infinity;
  species.forEach((sp) => {
    const xs = sp.children.map((c) => c.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) step = Math.min(step, xs[i] - xs[i - 1]);
  });
  if (!isFinite(step)) step = 0.01;

  species.forEach((sp) => {
    const xs = sp.children.map((c) => c.x);
    sp.arcStart = d3.min(xs) - step / 2;
    sp.arcEnd = d3.max(xs) + step / 2;
    sp.arcMid = (sp.arcStart + sp.arcEnd) / 2;
  });

  const arc = d3
    .arc()
    .innerRadius(R_ARC_INNER)
    .outerRadius(R_ARC_OUTER)
    .startAngle((d) => d.arcStart)
    .endAngle((d) => d.arcEnd);

  gArcs
    .selectAll("path.species-arc")
    .data(species, (d) => d.data.name)
    .join("path")
    .attr("class", "species-arc")
    .attr("d", arc)
    .attr("fill", (d) => state.speciesColor(d.data.name));

  const labels = gLabels
    .selectAll("g.species-label")
    .data(species, (d) => d.data.name)
    .join((enter) => {
      const ge = enter.append("g").attr("class", "species-label");
      const inner = ge.append("g").attr("class", "species-label__inner");
      inner.append("line").attr("class", "species-label__leader");
      inner.append("text").attr("dy", "0.32em");
      return ge;
    })
    .attr("transform", (d) => `translate(${project(d.arcMid, R_LABEL)})`)
    .on("mousemove", (event, d) =>
      showTooltip(event.clientX, event.clientY, d.data.name, [
        ["Clusters", String(d.children.length)],
        ["Genomes", String(d3.sum(d.children, (c) => c.data.member_count))],
      ])
    )
    .on("mouseleave", hideTooltip);

  labels
    .select("text")
    .attr("text-anchor", (d) => (isLeftSide(d) ? "end" : "start"))
    .text((d) => shortSpecies(d.data.name));
}

function isLeftSide(sp) {
  return sp.arcMid >= Math.PI;
}

// "Bifidobacterium longum subsp. infantis" -> "B. longum subsp. infantis"
function shortSpecies(name) {
  return name.replace(/^Bifidobacterium\b/, "B.");
}

// Everything that must stay a fixed number of SCREEN pixels: dot sizes, and
// the species labels (counter-scaled, then stacked so none overlap).
function applyScreenSizes() {
  const k = currentK;
  gNodes.selectAll("circle.species-node").attr("r", SPECIES_DOT_R / k);
  gNodes.selectAll(".cluster-node__dot").attr("r", DOT_R / k);
  gNodes.selectAll(".cluster-node__hit").attr("r", DOT_HIT_R / k);
  gNodes.selectAll("g.cluster-node.is-selected .cluster-node__dot").attr("r", (DOT_R * 1.8) / k);
  // Badges sit just inside their dot; neighbouring clusters' badges would
  // overlap, so a badge that would collide is pushed further inward.
  const placed = [];
  gBadges
    .selectAll("g.tree-badge")
    .sort((a, b) => clusterBadge(a.data.name) - clusterBadge(b.data.name))
    .attr("transform", (d) => {
      const [x, y] = project(d.x, d.radius);
      const [ux, uy] = project(d.x, 1);
      let off = BADGE_OFFSET_PX;
      let sx, sy;
      for (let tries = 0; tries < 8; tries++) {
        sx = x * k - ux * off; // screen px relative to the circle centre
        sy = y * k - uy * off;
        if (!placed.some(([px, py]) => Math.hypot(px - sx, py - sy) < BADGE_R * 2 + 2)) break;
        off += BADGE_R * 2 + 2;
      }
      placed.push([sx, sy]);
      return `translate(${sx / k},${sy / k}) scale(${1 / k})`;
    });

  // Labels sit in two vertical columns just outside the circle (left half /
  // right half), stacked so consecutive labels are >= LABEL_GAP_PX apart,
  // each joined to its arc by a leader line. Placing them at the arc point
  // itself (the earlier approach) let stacked labels slide back over the
  // ring where it bulges out, especially once the detail panel shrinks the
  // overview. All in screen pixels relative to the circle's centre.
  const species = root.children || [];
  const columnX = R_LABEL * k + LABEL_X_PX;
  ["left", "right"].forEach((side) => {
    const items = species
      .filter((sp) => (side === "left") === isLeftSide(sp))
      .map((sp) => ({ sp, y: project(sp.arcMid, R_LABEL)[1] * k }))
      .sort((a, b) => a.y - b.y);
    // Stack downward, then shift the whole stack up so it's centred on the
    // natural positions rather than only ever drifting downward.
    let prev = -Infinity;
    items.forEach((it) => {
      it.placed = Math.max(it.y, prev + LABEL_GAP_PX);
      prev = it.placed;
    });
    const drift = d3.mean(items, (it) => it.placed - it.y) || 0;
    prev = -Infinity;
    items.forEach((it) => {
      it.placed = Math.max(it.y - drift, prev + LABEL_GAP_PX);
      prev = it.placed;
      it.sp.labelY = it.placed;
    });
  });

  gLabels.selectAll("g.species-label").each(function (d) {
    const sign = isLeftSide(d) ? -1 : 1;
    const [ax, ay] = project(d.arcMid, R_LABEL); // anchor, layout units
    // Text position relative to the anchor, in screen px (inner group is
    // counter-scaled by 1/k).
    const tx = sign * columnX - ax * k;
    const ty = d.labelY - ay * k;
    const inner = d3.select(this).select(".species-label__inner").attr("transform", `scale(${1 / k})`);
    inner.select("text").attr("x", tx).attr("y", ty);
    inner
      .select("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", tx - sign * 3)
      .attr("y2", ty)
      .style("display", Math.hypot(tx, ty) > LABEL_X_PX + 3 ? null : "none");
  });
}

// ---------------------------------------------------------------------------
// Selection highlight
// ---------------------------------------------------------------------------

function setHighlight() {
  const ids = new Set(comparedClusterIds());
  gNodes
    .selectAll("g.cluster-node")
    .classed("is-selected", (d) => ids.has(d.data.name))
    .select(".cluster-node__dot")
    .attr("fill", (d) => (ids.has(d.data.name) ? state.speciesColor(d.parent.data.name) : "#fff"));
  gNodes.selectAll("g.cluster-node.is-selected").raise();

  // Number badges while 2+ clusters are compared (same numbers as the
  // detail panel, map and timeline).
  const badged = gNodes
    .selectAll("g.cluster-node.is-selected")
    .data()
    .filter((d) => clusterBadge(d.data.name));
  gBadges
    .selectAll("g.tree-badge")
    .data(badged, (d) => d.data.name)
    .join((enter) => {
      const b = enter.append("g").attr("class", "tree-badge");
      b.append("circle").attr("class", "svg-badge__disc").attr("r", BADGE_R);
      b.append("text").attr("class", "svg-badge__text").attr("dy", "0.34em");
      return b;
    })
    .select("text")
    .text((d) => clusterBadge(d.data.name));
  applyScreenSizes();
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

// Fit the whole circle plus room for the labels on both sides.
function fitToView(animate) {
  const w = +svg.attr("width");
  const h = +svg.attr("height");
  const pad = 24;
  const kW = (w - 2 * LABEL_W_PX - 2 * pad) / (2 * R_LABEL);
  const kH = (h - 2 * pad) / (2 * R_LABEL);
  const k = Math.max(MIN_ZOOM, Math.min(kW, kH));
  const t = d3.zoomIdentity.translate(w / 2, h / 2).scale(k);
  (animate ? svg.transition().duration(400) : svg).call(zoomBehavior.transform, t);
}
