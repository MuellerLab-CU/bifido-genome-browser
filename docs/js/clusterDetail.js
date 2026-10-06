// Tree tab, detail half: a side panel of cluster CARDS, one per cluster
// being looked at — every pinned cluster (in pin order) plus the current
// selection's cluster as an unpinned "preview" card that the next click
// replaces (see main.js comparedClusterIds). Each card holds:
//   - a left-to-right (rectangular) dendrogram of the cluster: one row per
//     genome, x position = ANI from the scipy average-linkage tree, with an
//     ANI scale on top. Genomes with no measurable ANI distance between them
//     (merge height 0) collapse into one expandable "×N identical" row —
//     71 of the 90 genomes in the largest cluster are such ties.
// Below the cards, ONE mini map and ONE mini timeline cover all of them.
// With 2+ clusters, colour can't tell them apart (colour = species, and
// compared clusters are often the same species), so each cluster gets a
// number badge, repeated on its card, its map markers and its timeline row.
//
// The panel mirrors state: it re-renders on clusterSelected /
// genomeSelected / pinsChanged and hides when nothing is pinned or selected.
import {
  state,
  selectGenome,
  clearSelection,
  clearClusterSelection,
  clearComparison,
  pinCluster,
  unpinCluster,
  comparedClusterIds,
  clusterBadge,
  badgeEl,
  MAX_PINNED,
  subRegionOf,
  countryLabel,
  showTooltip,
  hideTooltip,
  BASEMAP_URL,
  BASEMAP_MAX_ZOOM,
  MAP_MAX_ZOOM,
  CLUSTER_FIT_MAX_ZOOM,
  UN_CRS,
} from "./main.js";

const ROW_H = 20;
const AXIS_H = 38;
const LEFT = 14;
const EPS = 1e-9;

let panelEl, summaryEl, cardsEl, mapEl, mapEmptyEl, timelineSvg, timelineEmptyEl;
let miniMap = null;
let miniLayer = null;

let clusterNodes = null; // cluster_id -> cluster node from tree.json
// cluster_id -> { el, treeEl, expandedGroups: Set, collapsed: bool }.
// Kept across re-renders so a card's scroll position and expanded rows
// survive clicks elsewhere.
const cards = new Map();
let shownKey = ""; // ids + badges the mini map/timeline were last drawn for
let renderQueued = false;

export function initClusterDetail() {
  panelEl = document.getElementById("cluster-detail");
  summaryEl = document.getElementById("cluster-detail-summary");
  cardsEl = document.getElementById("cluster-detail-cards");
  mapEl = document.getElementById("cluster-detail-map");
  mapEmptyEl = document.getElementById("cluster-detail-map-empty");
  timelineSvg = document.getElementById("cluster-detail-timeline");
  timelineEmptyEl = document.getElementById("cluster-detail-timeline-empty");

  document.getElementById("cluster-detail-close").addEventListener("click", () => clearComparison());

  // selectGenome()/selectCluster() fire "clear the other selection" just
  // before the new one, and pin changes can arrive in the same tick.
  // Coalesce into one render per microtask so a hand-off never closes and
  // reopens the panel.
  ["clusterSelected", "genomeSelected", "pinsChanged", "filterChanged"].forEach((type) =>
    document.addEventListener(type, scheduleRender)
  );
  document.addEventListener("panelActivated", (e) => {
    // Anything drawn while the tab was hidden was measured at width 0.
    if (e.detail.panel === "panel-tree" && !panelEl.hidden) {
      shownKey = "";
      render();
    }
  });
}

// Mini map/timeline and dendrograms are drawn to the panel's width.
window.addEventListener("resize", () => {
  if (!panelEl || panelEl.hidden || !panelEl.clientWidth) return;
  shownKey = "";
  render();
});

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
}

// Kept for callers that want a cluster on screen without changing selection.
export function openClusterDetail() {
  render();
}

function ensureClusterNodes() {
  if (clusterNodes) return;
  clusterNodes = new Map();
  state.tree.children.forEach((sp) => sp.children.forEach((cl) => clusterNodes.set(cl.name, cl)));
}

function render() {
  ensureClusterNodes();
  const ids = comparedClusterIds().filter((id) => clusterNodes.has(id) && state.activeClusterIds.has(id));

  if (!ids.length) {
    if (!panelEl.hidden) {
      panelEl.hidden = true;
      hideTooltip();
      cards.clear();
      cardsEl.replaceChildren();
      shownKey = "";
      document.dispatchEvent(new CustomEvent("clusterDetailClosed"));
      document.dispatchEvent(new CustomEvent("clusterDetailToggled"));
    }
    return;
  }

  const wasHidden = panelEl.hidden;
  panelEl.hidden = false;
  const multi = ids.length > 1;
  panelEl.classList.toggle("is-multi", multi);
  renderSummary(ids);

  // Drop cards no longer shown; create new ones; keep order = ids.
  [...cards.keys()].forEach((id) => {
    if (!ids.includes(id)) {
      cards.get(id).el.remove();
      cards.delete(id);
    }
  });
  const selectedCluster = selectedGenomeCluster();
  ids.forEach((id, i) => {
    let card = cards.get(id);
    if (!card) {
      card = createCard(id);
      cards.set(id, card);
    }
    // A genome selected elsewhere opens its card if it was collapsed.
    if (selectedCluster === id) card.collapsed = false;
    // Only move a card if it's out of place: re-inserting a node can reset
    // its scroll position.
    if (cardsEl.children[i] !== card.el) cardsEl.insertBefore(card.el, cardsEl.children[i] || null);
    renderCardHead(card, id, multi);
    card.el.classList.toggle("is-collapsed", multi && card.collapsed);
  });

  // Dendrograms need real widths, so they're drawn after the panel is shown.
  ids.forEach((id) => renderDendrogram(cards.get(id), clusterNodes.get(id)));

  const key = ids.map((id) => `${id}:${clusterBadge(id) ?? ""}`).join("|");
  if (key !== shownKey) {
    shownKey = key;
    const groups = ids.map((id) => {
      const cluster = state.clusters.find((c) => c.cluster_id === id);
      return {
        id,
        badge: clusterBadge(id),
        color: state.speciesColor(cluster.species_subsp),
        members: cluster.members.map((a) => state.genomesByAccession.get(a)).filter(Boolean),
      };
    });
    renderMiniMap(groups);
    renderMiniTimeline(groups);
  }

  // Scroll the selected genome's card into view inside the card list.
  if (selectedCluster && cards.has(selectedCluster) && multi) {
    const el = cards.get(selectedCluster).el;
    const top = el.offsetTop - cardsEl.offsetTop;
    if (top < cardsEl.scrollTop || top > cardsEl.scrollTop + cardsEl.clientHeight - 60) cardsEl.scrollTop = top;
  }

  if (wasHidden) document.dispatchEvent(new CustomEvent("clusterDetailToggled"));
}

function selectedGenomeCluster() {
  const g = state.selectedAccession && state.genomesByAccession.get(state.selectedAccession);
  return g ? g.cluster_id : null;
}

function renderSummary(ids) {
  summaryEl.replaceChildren();
  const pinned = state.pinnedClusterIds.length;
  const text = document.createElement("span");
  text.className = "cluster-detail__summary-text";
  if (ids.length > 1) {
    text.textContent = `Comparing ${ids.length} clusters`;
  } else if (pinned) {
    text.textContent = "1 pinned cluster";
  } else {
    text.textContent = "Cluster details";
  }
  const hint = document.createElement("span");
  hint.className = "cluster-detail__hint";
  hint.textContent =
    pinned >= MAX_PINNED
      ? `Pin limit reached (${MAX_PINNED}) — unpin one to add another`
      : pinned
        ? `Clicking another cluster adds it unpinned · up to ${MAX_PINNED} pins`
        : "Pin to keep this cluster while you click others · shift-click pins directly";
  summaryEl.append(text, hint);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const PIN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 1.5l4 4-2 1-2.5 2.5.5 3-1.5 1.5-3-3-3.5 3.5h-1v-1L5 9.5l-3-3L3.5 5l3 .5L9 3z"/></svg>';

function createCard(id) {
  const el = document.createElement("section");
  el.className = "cd-card";
  el.dataset.cluster = id;

  const head = document.createElement("div");
  head.className = "cd-card__head";

  const label = document.createElement("div");
  label.className = "cluster-detail__label cd-card__label";
  const labelText = document.createElement("span");
  labelText.innerHTML = "ANI tree <span>(average linkage; identical genomes grouped)</span>";
  // Expand/collapse every "identical genomes" group in this card at once.
  const groupCtl = document.createElement("span");
  groupCtl.className = "cd-groupctl";
  const expandAll = document.createElement("button");
  expandAll.type = "button";
  expandAll.textContent = "Expand all";
  const collapseAll = document.createElement("button");
  collapseAll.type = "button";
  collapseAll.textContent = "Collapse all";
  groupCtl.append(expandAll, collapseAll);
  label.append(labelText, groupCtl);

  const treeEl = document.createElement("div");
  treeEl.className = "cd-card__tree";

  el.append(head, label, treeEl);
  const card = {
    el,
    head,
    treeEl,
    groupCtl,
    expandAll,
    collapseAll,
    expandedGroups: new Set(),
    groupKeys: [],
    autoAcc: null, // selection a group was last auto-expanded for
    collapsed: false,
  };
  expandAll.addEventListener("click", () => {
    card.groupKeys.forEach((k) => card.expandedGroups.add(k));
    renderDendrogram(card, clusterNodes.get(id));
  });
  collapseAll.addEventListener("click", () => {
    card.expandedGroups.clear();
    renderDendrogram(card, clusterNodes.get(id));
  });
  return card;
}

function iconButton(className, label, html, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = html;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function renderCardHead(card, id, multi) {
  const cluster = state.clusters.find((c) => c.cluster_id === id);
  const node = clusterNodes.get(id);
  const color = state.speciesColor(cluster.species_subsp);
  const isPinned = state.pinnedClusterIds.includes(id);
  card.el.classList.toggle("is-pinned", isPinned);
  card.el.classList.toggle("is-preview", !isPinned);

  const head = card.head;
  head.replaceChildren();

  const badge = clusterBadge(id);
  if (badge) head.append(badgeEl(badge));

  const titles = document.createElement("div");
  titles.className = "cd-card__titles";
  const title = document.createElement("div");
  title.className = "cluster-detail__title";
  title.textContent = `Cluster ${cluster.cluster_id}`;
  if (!isPinned && multi) {
    const tag = document.createElement("span");
    tag.className = "cd-card__tag";
    tag.textContent = "not pinned";
    title.append(tag);
  }
  const sp = document.createElement("div");
  sp.className = "cluster-detail__species";
  // Species name in ink (orange/sky blue fail contrast as text); the colour
  // rides on a swatch beside it.
  const sw = document.createElement("span");
  sw.className = "cd-card__swatch";
  sw.style.background = color;
  sp.append(sw, document.createTextNode(cluster.species_subsp));
  const meta = document.createElement("div");
  meta.className = "cluster-detail__meta";
  const parts = [
    `${cluster.member_count} genome${cluster.member_count === 1 ? "" : "s"}`,
    `rep ${cluster.rep_accession} (${cluster.rep_tier})`,
  ];
  if (node.max_height > 0) parts.push(`lowest ANI ${aniLabel(1 - node.max_height, node.max_height)}`);
  meta.textContent = parts.join(" · ");
  titles.append(title, sp, meta);
  if (cluster.species_subsp_breakdown.length > 1) {
    const mix = document.createElement("div");
    mix.className = "cluster-detail__meta";
    mix.textContent =
      "Mixed labels: " + cluster.species_subsp_breakdown.map((b) => `${b.species_subsp} (${b.count})`).join(", ");
    titles.append(mix);
  }

  const actions = document.createElement("div");
  actions.className = "cd-card__actions";

  const full = !isPinned && state.pinnedClusterIds.length >= MAX_PINNED;
  const pinBtn = iconButton(
    "cd-pin" + (isPinned ? " is-on" : ""),
    isPinned ? `Unpin cluster ${id}` : full ? `Up to ${MAX_PINNED} clusters can be pinned — unpin one first` : `Pin cluster ${id} to compare`,
    `${PIN_ICON}<span>${isPinned ? "Pinned" : "Pin"}</span>`,
    () => (isPinned ? unpinCluster(id) : pinCluster(id))
  );
  pinBtn.disabled = full;
  pinBtn.setAttribute("aria-pressed", String(isPinned));
  actions.append(pinBtn);

  if (multi) {
    actions.append(
      iconButton("cd-icon-btn", card.collapsed ? "Expand" : "Collapse", card.collapsed ? "▸" : "▾", () => {
        card.collapsed = !card.collapsed;
        render();
      })
    );
  }
  actions.append(iconButton("cd-icon-btn cd-icon-btn--close", isPinned ? `Unpin and close cluster ${id}` : `Close cluster ${id}`, "&times;", () => closeCard(id)));

  head.append(titles, actions);
}

// A card's ×: unpin it, and drop the selection if that's what was showing it.
function closeCard(id) {
  const fromSelection = state.selectedClusterId === id || selectedGenomeCluster() === id;
  if (state.pinnedClusterIds.includes(id)) unpinCluster(id);
  if (fromSelection) {
    if (state.selectedAccession) clearSelection();
    if (state.selectedClusterId) clearClusterSelection();
  }
}

// ---------------------------------------------------------------------------
// Dendrogram
// ---------------------------------------------------------------------------

function leavesOf(n) {
  return n.children ? n.children.flatMap(leavesOf) : [n];
}

// Convert the scipy tree into what we draw: merge nodes, single genomes, and
// "identical" groups (a zero-height subtree = no ANI distance anywhere in it).
// An expanded group keeps its own row (now the "hide" toggle) and lists its
// genomes indented below it, so it closes from the same place it opened.
// `autoAcc`: a newly selected genome — its group opens automatically, once
// (re-opening on every redraw made such a group impossible to collapse).
function toDisplay(n, card, autoAcc) {
  if (!n.children) return { type: "leaf", leaf: n };
  if ((n.height ?? 0) <= EPS) {
    const leaves = leavesOf(n).sort((a, b) => (b.is_rep ? 1 : 0) - (a.is_rep ? 1 : 0) || a.name.localeCompare(b.name));
    const key = leaves.map((l) => l.name).sort()[0];
    card.groupKeys.push(key);
    if (autoAcc && leaves.some((l) => l.name === autoAcc)) card.expandedGroups.add(key);
    const group = { type: "group", key, leaves, height: 0, expanded: card.expandedGroups.has(key) };
    if (group.expanded) group.members = leaves.map((l) => ({ type: "leaf", leaf: l, group }));
    return group;
  }
  return { type: "merge", height: n.height, children: n.children.map((c) => toDisplay(c, card, autoAcc)) };
}

const MEMBER_INDENT = 18; // px, group members sit right of their group row

function renderDendrogram(card, clusterNode) {
  const treeEl = card.treeEl;
  if (card.el.classList.contains("is-collapsed")) return;
  const selectedAcc = state.selectedAccession;
  const prevScroll = treeEl.scrollTop;
  hideTooltip();
  const dendroRoot = clusterNode.children[0];
  const autoAcc = selectedAcc && selectedAcc !== card.autoAcc ? selectedAcc : null;
  // Only "use up" a new selection once the tree is on screen: a genome picked
  // in another tab is drawn here at height 0 first, and would otherwise never
  // get scrolled into view when the Tree tab opens.
  if (treeEl.clientHeight) card.autoAcc = selectedAcc;
  card.groupKeys = [];
  const disp = toDisplay(dendroRoot, card, autoAcc);

  let row = 0;
  (function assign(d) {
    if (!d.children) {
      d.row = row++;
      (d.members || []).forEach((m) => (m.row = row++));
      return;
    }
    d.children.forEach(assign);
    d.row = (d.children[0].row + d.children[d.children.length - 1].row) / 2;
  })(disp);
  const nRows = row;

  const width = Math.max(treeEl.clientWidth, 380);
  const leafX = Math.round(Math.min(190, width * 0.42));
  const maxH = Math.max(clusterNode.max_height || 0, 1e-6);
  // Square-root scale on distance (1 - ANI): within a cluster most merges
  // sit within ~0.1% of 100% ANI, which a linear axis squeezes into a few
  // pixels at the right edge. Ticks still show true ANI values.
  const x = d3.scaleSqrt().domain([maxH, 0]).range([LEFT, leafX]);
  const axisH = clusterNode.max_height > 0 ? AXIS_H : 8;
  const yOf = (d) => axisH + d.row * ROW_H + ROW_H / 2;
  const xOf = (d) => (d.type === "merge" ? x(d.height) : leafX);

  const svg = d3
    .create("svg")
    .attr("width", width)
    .attr("height", axisH + nRows * ROW_H + 8)
    .attr("class", "detail-tree");

  // ANI scale (only meaningful when there's more than one distinct position).
  if (clusterNode.max_height > 0) {
    svg
      .append("g")
      .attr("class", "detail-tree__axis")
      .attr("transform", `translate(0,${AXIS_H - 8})`)
      .call(
        d3
          .axisTop(x)
          .ticks(Math.max(2, Math.floor((leafX - LEFT) / 60)))
          .tickFormat((h) => aniLabel(1 - h, maxH))
      );
    svg
      .append("text")
      .attr("class", "detail-tree__axis-title")
      .attr("x", LEFT - 8)
      .attr("y", 9)
      .text("ANI (square-root scale; higher = more similar) →");
  }

  // Elbow links.
  const links = [];
  (function walk(d) {
    (d.children || []).forEach((c) => {
      links.push([d, c]);
      walk(c);
    });
  })(disp);
  svg
    .append("g")
    .attr("class", "detail-tree__links")
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("d", ([p, c]) => `M${xOf(p)},${yOf(p)}V${yOf(c)}H${xOf(c)}`);
  if (disp.children) {
    svg
      .append("path")
      .attr("class", "detail-tree__links")
      .attr("d", `M${LEFT - 8},${yOf(disp)}H${xOf(disp)}`);
  }

  // Rows (single genomes and collapsed groups).
  const rows = [];
  (function walk(d) {
    if (!d.children) {
      rows.push(d);
      (d.members || []).forEach((m) => rows.push(m));
    } else d.children.forEach(walk);
  })(disp);

  // Elbow from each expanded group's row down to its indented members.
  svg
    .append("g")
    .attr("class", "detail-tree__links detail-tree__members")
    .selectAll("path")
    .data(rows.filter((d) => d.group))
    .join("path")
    .attr("d", (d) => `M${leafX},${yOf(d.group) + 5}V${yOf(d)}H${leafX + MEMBER_INDENT - 5}`);

  const rowG = svg
    .append("g")
    .selectAll("g.detail-row")
    .data(rows)
    .join("g")
    .attr("class", (d) => {
      const sel = d.type === "leaf" && d.leaf.name === selectedAcc;
      const open = d.type === "group" && d.expanded ? " is-open" : "";
      const member = d.group ? " is-member" : "";
      return `detail-row detail-row--${d.type}${open}${member}${sel ? " is-selected" : ""}`;
    })
    .attr("transform", (d) => `translate(0,${yOf(d)})`);

  rowG
    .append("rect")
    .attr("class", "detail-row__bg")
    .attr("x", leafX - 10)
    .attr("y", -ROW_H / 2)
    .attr("width", width - leafX + 10)
    .attr("height", ROW_H);

  // Single genomes.
  const leafRows = rowG.filter((d) => d.type === "leaf");
  const lx = (d) => leafX + (d.group ? MEMBER_INDENT : 0);
  leafRows
    .append("circle")
    .attr("cx", lx)
    .attr("r", 4.5)
    .attr("class", (d) => (d.leaf.tier === "Tier1" ? "" : "is-tier2"))
    .attr("stroke", (d) => genomeColor(d.leaf.name))
    .attr("fill", (d) => (d.leaf.is_rep ? genomeColor(d.leaf.name) : "#fff"));
  const leafText = leafRows.append("text").attr("x", (d) => lx(d) + 10).attr("dy", "0.32em");
  leafText
    .append("tspan")
    .attr("class", "detail-row__acc")
    .text((d) => d.leaf.name);
  leafText
    .append("tspan")
    .attr("class", "detail-row__strain")
    .attr("dx", 6)
    .text((d) => [d.leaf.strain, d.leaf.is_rep ? "(rep)" : ""].filter(Boolean).join(" "));
  leafRows
    .on("click", (event, d) => selectGenome(d.leaf.name))
    .on("mousemove", (event, d) => showTooltip(event.clientX, event.clientY, d.leaf.name, leafTooltipRows(d.leaf)))
    .on("mouseleave", hideTooltip);

  // Collapsed groups.
  const groupRows = rowG.filter((d) => d.type === "group");
  groupRows.append("circle").attr("cx", leafX + 3).attr("r", 4.5).attr("class", "detail-row__stack");
  groupRows.append("circle").attr("cx", leafX).attr("r", 4.5).attr("class", "detail-row__stack");
  // Disclosure triangle (drawn, not a text glyph — "▸" renders tiny):
  // pointing right = closed, down = open.
  groupRows
    .append("path")
    .attr("class", "detail-row__toggle")
    .attr("transform", (d) => `translate(${leafX + 17},0)`)
    .attr("d", (d) => (d.expanded ? "M-4,-2.5L4,-2.5L0,3Z" : "M-2.5,-4L3,0L-2.5,4Z"));
  groupRows
    .append("text")
    .attr("x", leafX + 25)
    .attr("dy", "0.32em")
    .attr("class", "detail-row__group")
    .text((d) => `×${d.leaves.length} identical genomes${d.leaves.some((l) => l.is_rep) ? " (incl. rep)" : ""}`);
  groupRows
    .on("click", (event, d) => {
      hideTooltip();
      if (d.expanded) card.expandedGroups.delete(d.key);
      else card.expandedGroups.add(d.key);
      renderDendrogram(card, clusterNode);
    })
    .on("mousemove", (event, d) => {
      if (d.expanded) return hideTooltip(); // members are listed right below
      const shown = d.leaves.slice(0, 8).map((l) => [l.name, l.strain || ""]);
      if (d.leaves.length > 8) shown.push([`… and ${d.leaves.length - 8} more`, ""]);
      showTooltip(event.clientX, event.clientY, `${d.leaves.length} genomes, no ANI difference — click to list`, shown);
    })
    .on("mouseleave", hideTooltip);

  // Card-level controls: only when there are groups; disable no-ops.
  const nGroups = card.groupKeys.length;
  const nOpen = card.groupKeys.filter((k) => card.expandedGroups.has(k)).length;
  card.groupCtl.hidden = nGroups === 0;
  card.expandAll.disabled = nOpen === nGroups;
  card.collapseAll.disabled = nOpen === 0;

  treeEl.replaceChildren(svg.node());

  // Keep the reader's scroll position across redraws (opening/closing a
  // group, other cards changing). Only a NEWLY selected genome scrolls the
  // list, and only if it's off-screen — re-centring on every redraw yanked
  // the list back to the selected genome whenever a group was toggled.
  treeEl.scrollTop = prevScroll;
  const selRow = autoAcc && rows.find((d) => d.type === "leaf" && d.leaf.name === selectedAcc);
  if (selRow) {
    const y = yOf(selRow);
    const view = treeEl.clientHeight;
    if (y - ROW_H < treeEl.scrollTop || y + ROW_H > treeEl.scrollTop + view) {
      treeEl.scrollTop = Math.max(0, y - view / 2);
    }
  }
}

function genomeColor(acc) {
  const g = state.genomesByAccession.get(acc);
  return state.speciesColor(g ? g.species_subsp : null);
}

function leafTooltipRows(l) {
  return [
    ["Organism", l.organism_name || "—"],
    ["Strain", l.strain || "—"],
    ["Tier", l.tier || "—"],
    ["ANI to rep", l.is_rep ? "100% (rep)" : l.ani_to_rep == null ? "—" : `${(l.ani_to_rep * 100).toFixed(3)}%`],
    ["Country/Region", countryLabel(state.genomesByAccession.get(l.name))],
    ["Submission year", l.submission_year ?? "—"],
    ["Submitter", l.submitter || "—"],
    ["Evidence", l.evidence_sources || "—"],
  ];
}

// Enough decimals that axis ticks across this cluster's span are distinct.
function aniLabel(ani, span) {
  const spanPct = span * 100;
  const decimals = spanPct >= 0.5 ? 2 : spanPct >= 0.05 ? 3 : 4;
  return `${(ani * 100).toFixed(decimals)}%`;
}

// ---------------------------------------------------------------------------
// Shared mini map / timeline (all shown clusters)
// ---------------------------------------------------------------------------

function ensureMiniMap() {
  if (miniMap) return;
  // Same UN basemap setup as map.js (see notes there): UN_CRS, real tiles
  // to BASEMAP_MAX_ZOOM, `bounds` to never request placeholder tiles.
  miniMap = L.map("cluster-detail-map", { crs: UN_CRS, attributionControl: false, maxZoom: MAP_MAX_ZOOM });
  L.tileLayer(BASEMAP_URL, {
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: BASEMAP_MAX_ZOOM,
    noWrap: true,
    bounds: [
      [-90, -180],
      [90, 180],
    ],
  }).addTo(miniMap);
  miniLayer = L.layerGroup().addTo(miniMap);
}

// Numbered map marker for comparisons: white disc, species-coloured ring
// (thicker for the rep), dark number — the number, not the colour, says
// which cluster.
export function badgeIcon(n, color, isRep) {
  return L.divIcon({
    className: "map-badge-icon",
    html: `<span class="map-badge${isRep ? " is-rep" : ""}" style="border-color:${color}">${n}</span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function renderMiniMap(groups) {
  const multi = groups.length > 1;
  const points = [];
  groups.forEach((grp) =>
    grp.members.filter((g) => g.geo_precision !== "none").forEach((g) => points.push({ g, grp }))
  );
  mapEl.hidden = points.length === 0;
  mapEmptyEl.hidden = points.length !== 0;
  if (!points.length) return;

  ensureMiniMap();
  miniLayer.clearLayers();
  const latlngs = points.map(({ g, grp }) => {
    const ll = [g.map_latitude, g.map_longitude];
    const m = multi
      ? L.marker(ll, { icon: badgeIcon(grp.badge, grp.color, g.is_rep), zIndexOffset: g.is_rep ? 500 : 0 })
      : L.circleMarker(ll, {
          radius: 5,
          color: grp.color,
          weight: 2,
          fillColor: grp.color,
          fillOpacity: g.is_rep ? 0.9 : 0.2,
        });
    const sub = subRegionOf(g);
    const where = sub ? `${sub}, ${g.geo_loc_country}` : countryLabel(g);
    const prefix = multi ? `[${grp.badge}] Cluster ${grp.id}<br>` : "";
    m.bindTooltip(`${prefix}${g.assembly_accession}${g.is_rep ? " (rep)" : ""}<br>${escapeHtml(where)} — ${g.submission_year ?? "year unknown"}`);
    m.on("click", () => selectGenome(g.assembly_accession));
    m.addTo(miniLayer);
    return ll;
  });

  requestAnimationFrame(() => {
    miniMap.invalidateSize();
    if (latlngs.length === 1) miniMap.setView(latlngs[0], CLUSTER_FIT_MAX_ZOOM);
    else miniMap.fitBounds(latlngs, { padding: [20, 20], maxZoom: CLUSTER_FIT_MAX_ZOOM });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// One row of stacked dots per cluster, all on one shared year axis. A single
// cluster gets the whole height (as before); several share it, each row
// labelled with its badge on the left.
function renderMiniTimeline(groups) {
  const dated = groups.flatMap((grp) => grp.members.filter((g) => g.submission_year != null));
  timelineSvg.style.display = dated.length ? "block" : "none";
  timelineEmptyEl.hidden = dated.length !== 0;
  if (!dated.length) return;

  const multi = groups.length > 1;
  const w = timelineSvg.clientWidth || 210;
  const h = timelineSvg.clientHeight || 190;
  const base = h - 26;
  const left = multi ? 30 : 16;
  const years = dated.map((g) => g.submission_year);
  const x = d3
    .scalePoint()
    .domain(d3.range(d3.min(years) - 1, d3.max(years) + 2))
    .range([left, w - 16]);

  const svg = d3.select(timelineSvg).attr("viewBox", `0 0 ${w} ${h}`);
  svg.selectAll("*").remove();
  svg.append("line").attr("class", "cluster-detail__axis").attr("x1", left - 6).attr("x2", w - 10).attr("y1", base).attr("y2", base);

  // Label every Nth year so labels stay >= ~34px apart.
  const every = Math.max(1, Math.ceil(34 / x.step()));
  const first = d3.min(years);
  svg
    .selectAll("text.cluster-detail__axis-text")
    .data(x.domain().filter((y) => y >= first && y <= d3.max(years) && (y - first) % every === 0))
    .join("text")
    .attr("class", "cluster-detail__axis-text")
    .attr("x", (y) => x(y))
    .attr("y", base + 16)
    .attr("text-anchor", "middle")
    .text((y) => y);

  const bandH = (base - 6) / groups.length;
  groups.forEach((grp, i) => {
    const rowBase = 6 + bandH * (i + 1) - 4; // bottom of this cluster's band
    if (multi) {
      if (i < groups.length - 1) {
        svg
          .append("line")
          .attr("class", "cluster-detail__band-rule")
          .attr("x1", left - 6)
          .attr("x2", w - 10)
          .attr("y1", rowBase + 4)
          .attr("y2", rowBase + 4);
      }
      const bg = svg.append("g").attr("transform", `translate(4,${rowBase - Math.min(bandH, 30) / 2})`);
      bg.append("circle").attr("class", "svg-badge__disc").attr("cx", 8).attr("cy", 0).attr("r", 8);
      bg.append("text").attr("class", "svg-badge__text").attr("x", 8).attr("y", 0).attr("dy", "0.34em").text(grp.badge);
    }

    // Stack dots per year; shrink spacing if a year has more than fits.
    const mine = grp.members.filter((g) => g.submission_year != null);
    if (!mine.length) return;
    const perYear = d3.rollup(mine, (v) => v.length, (g) => g.submission_year);
    const maxStack = d3.max(perYear.values());
    const avail = (multi ? bandH : base) - 10;
    const gap = Math.min(10, avail / maxStack);
    const r = Math.max(1.5, Math.min(4, gap / 2 - 0.5));
    const count = {};
    const bottom = multi ? rowBase - r : base - 6;
    mine.forEach((g) => {
      const k = (count[g.submission_year] = (count[g.submission_year] || 0) + 1);
      svg
        .append("circle")
        .attr("class", "cluster-detail__dot")
        .attr("cx", x(g.submission_year))
        .attr("cy", bottom - (k - 1) * gap)
        .attr("r", r)
        .attr("fill", grp.color)
        .append("title")
        .text(`${multi ? `[${grp.badge}] ` : ""}${g.assembly_accession}${g.is_rep ? " (rep)" : ""} — ${g.submission_year}`);
    });
  });
}
