// Shared state, data loading, species_subsp color palette, tab navigation,
// and the cross-panel selection event bus. Every panel module imports
// `state` and the two exported functions below rather than fetching or
// selecting on its own, so all four panels always agree.

export const state = {
  genomes: [],
  clusters: [],
  tree: null,
  genomesByAccession: new Map(),
  speciesOrder: [],
  speciesColor: null, // species_subsp -> hex (by colour group, see COLOR_GROUPS)
  selectedAccession: null,
  selectedClusterId: null,
  pinnedClusterIds: [], // clusters pinned for comparison, in pin order — see pinCluster
  activeClusterIds: new Set(), // shared hierarchical filter — see initFilterControl
};

// Colour = species GROUP, with subspecies as SHADES of their group's hue.
// No palette keeps ~37 species_subsp labels apart (least of all for
// colour-blind readers), so the six largest parent species get the six
// chromatic Okabe–Ito colours and everything else is one light-grey
// "Other" (~93% of genomes get a distinct hue). Validated all-pairs with the
// dataviz skill's validate_palette.js (any two can sit side by side on the
// map): normal-vision ΔE >= 15.3; worst colour-blind pair (bifidum purple vs
// breve green) ΔE 7.6 = "warn" band, acceptable only because identity is
// always also in labels/tooltips/legend/table. Do NOT add a 7th hue: every
// candidate tested failed somewhere. Orange, purple, sky blue and the grey
// are under 3:1 on white — never use them for text.
//
// Subspecies shades (only B. longum and B. animalis have subspecies): found
// by searching lightness steps of the group's own hue, keeping only shades
// >= 15 ΔE (normal) and >= 6 ΔE (simulated colour blindness) from every
// OTHER group. Two constraints shaped this:
//   - lighter blues collide with B. adolescentis sky blue, so longum shades
//     go darker; darker blues collided with the old charcoal "Other", which
//     is why Other is now light grey #c8c8c8 (the darkest grey still >= 15
//     from sky blue).
//   - mid oranges collide with B. pseudocatenulatum vermillion under
//     red-green colour blindness, so animalis gets a dark brown and a light
//     amber instead.
// Within a group some pairs are only ~7 ΔE apart (slate vs steel blue,
// orange vs amber): visible but subtle, by design — they should still read
// as one species, and labels give the exact name.
// Assigned by name, never by rank, so data updates never repaint anything.
export const COLOR_GROUPS = [
  {
    key: "Bifidobacterium longum",
    label: "B. longum",
    color: "#0072B2",
    shades: [
      { key: "Bifidobacterium longum subsp. longum", label: "subsp. longum", color: "#0072B2" },
      { key: "Bifidobacterium longum subsp. infantis", label: "subsp. infantis", color: "#003355" },
      { key: "Bifidobacterium longum unspecified", label: "unspecified", color: "#245478" },
      { key: "Bifidobacterium longum subsp. suis", label: "subsp. suis", color: "#39688d" },
      { key: "Bifidobacterium longum subsp. suillum", label: "subsp. suillum", color: "#39688d" },
    ],
  },
  {
    key: "Bifidobacterium animalis",
    label: "B. animalis",
    color: "#E69F00",
    shades: [
      { key: "Bifidobacterium animalis subsp. lactis", label: "subsp. lactis", color: "#E69F00" },
      { key: "Bifidobacterium animalis unspecified", label: "unspecified", color: "#fdb533" },
      { key: "Bifidobacterium animalis subsp. animalis", label: "subsp. animalis", color: "#724d00" },
    ],
  },
  { key: "Bifidobacterium breve", label: "B. breve", color: "#009E73" },
  { key: "Bifidobacterium pseudocatenulatum", label: "B. pseudocatenulatum", color: "#D55E00" },
  { key: "Bifidobacterium bifidum", label: "B. bifidum", color: "#CC79A7" },
  { key: "Bifidobacterium adolescentis", label: "B. adolescentis", color: "#56B4E9" },
  { key: "Other", label: "Other species", color: "#c8c8c8" },
];
const GROUP_BY_KEY = new Map(COLOR_GROUPS.map((g) => [g.key, g]));
const SHADE_BY_KEY = new Map(COLOR_GROUPS.flatMap((g) => (g.shades || []).map((s) => [s.key, { ...s, group: g }])));

// Ordered colour keys for stacked charts: each subspecies shade on its own,
// then the plain groups. A genome's key is its species_subsp if that has a
// shade, else its group.
export const COLOR_KEYS = COLOR_GROUPS.flatMap((g) => (g.shades ? g.shades.map((s) => s.key) : [g.key]));

// "Bifidobacterium longum subsp. infantis" / "... unspecified" -> parent
// species; anything outside the six named groups -> "Other".
export function colorGroupOf(speciesSubsp) {
  const parent = String(speciesSubsp || "").replace(/\s+(subsp\.\s+\S+|unspecified)$/, "");
  return GROUP_BY_KEY.has(parent) ? parent : "Other";
}

export function colorKeyOf(speciesSubsp) {
  return SHADE_BY_KEY.has(speciesSubsp) ? speciesSubsp : colorGroupOf(speciesSubsp);
}

export function colorKeyLabel(key) {
  const shade = SHADE_BY_KEY.get(key);
  if (shade) return `${shade.group.label} ${shade.label}`;
  return GROUP_BY_KEY.get(key)?.label ?? key;
}

function speciesColor(speciesSubsp) {
  const shade = SHADE_BY_KEY.get(speciesSubsp);
  return shade ? shade.color : GROUP_BY_KEY.get(colorGroupOf(speciesSubsp)).color;
}

// Shared legend (all tabs), so colour is never the only way to tell groups
// apart. Groups with subspecies list each shade.
export function initColorLegend() {
  const el = document.getElementById("color-legend");
  if (!el) return;
  const swatch = (color) => {
    const sw = document.createElement("span");
    sw.className = "color-legend__swatch";
    sw.style.background = color;
    return sw;
  };
  const title = document.createElement("span");
  title.className = "color-legend__title";
  title.textContent = "Colour:";
  el.appendChild(title);
  COLOR_GROUPS.forEach((g) => {
    const item = document.createElement("span");
    item.className = "color-legend__item";
    const name = document.createElement("span");
    name.textContent = g.label;
    if (g.key !== "Other") name.className = "color-legend__species";
    if (!g.shades) {
      item.append(swatch(g.color), name);
    } else {
      item.append(name);
      const seen = new Set();
      const sub = document.createElement("span");
      sub.className = "color-legend__shades";
      g.shades.forEach((s) => {
        // suis & suillum share a shade: show it once with both names.
        const label = g.shades.filter((x) => x.color === s.color).map((x) => x.label.replace("subsp. ", "")).join("/");
        if (seen.has(s.color)) return;
        seen.add(s.color);
        const part = document.createElement("span");
        part.className = "color-legend__shade";
        const txt = document.createElement("span");
        txt.textContent = label;
        part.append(swatch(s.color), txt);
        sub.appendChild(part);
      });
      item.appendChild(sub);
    }
    el.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Basemap (shared by the main map and the tree's cluster-popup mini-map)
// ---------------------------------------------------------------------------

// UN Geospatial's "Clear Map" — chosen over OpenStreetMap for two things
// OSM doesn't guarantee: it's produced by an international organization
// (relevant for not appearing to take a side on disputed borders/names) and
// its labels are English-only everywhere (verified by hand — e.g. "Beijing"
// renders as "Beijing", never local script). The real tradeoff: ArcGIS only
// has cached tiles up to zoom 6 (country/region scale) — past that it
// serves a "MAP NOT AVAILABLE AT THIS SCALE" placeholder instead of a real
// tile. BASEMAP_MAX_ZOOM is the real-tile-detail ceiling, used as the tile
// layer's `maxNativeZoom` (never request tiles past it) — not as the map's
// own `maxZoom` (see MAP_MAX_ZOOM below), so this is still the right
// constant to reach for if that basemap detail ceiling itself ever changes.
export const BASEMAP_URL =
  "https://geoservices.un.org/arcgis/rest/services/ClearMap_Plain/MapServer/tile/{z}/{y}/{x}";
export const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://geoportal.un.org/arcgis/home/item.html?id=541557fd0d4d42efb24449be614e6887" target="_blank" rel="noopener">United Nations Geospatial</a>';
export const BASEMAP_MAX_ZOOM = 6;

// How far the MAP ITSELF (and its marker layer) is allowed to zoom — past
// BASEMAP_MAX_ZOOM, past the basemap's own real detail. This is
// deliberate: many genomes share one geocoding fallback coordinate (see
// jitterCoordinates in map.js), spread apart by a small, deliberately
// *bounded* radius — bounded because a bigger jitter radius risks a point
// landing outside the real country/region it belongs to (confirmed bug,
// since fixed — see map.js). That bound is in real-world degrees, so it
// doesn't grow if the map zooms in — only its on-screen PIXEL size does.
// At BASEMAP_MAX_ZOOM alone, the densest shared-coordinate group (211
// genomes defaulted to Japan's centroid) separates by under 2px — not
// clickable. Letting the map zoom in further (Leaflet reuses/upscales the
// highest real tile via the tile layer's `maxNativeZoom`, so this never
// requests a tile beyond BASEMAP_MAX_ZOOM — the "MAP NOT AVAILABLE"
// placeholder stays exactly as unreachable as before) grows that same
// jitter spiral's apparent on-screen separation instead — at this zoom,
// roughly 40px for that 211-genome group, comfortably clickable — without
// touching the jitter geometry (and its established geographic safety) at
// all. The basemap imagery itself just looks blurrier up here, which is an
// acceptable tradeoff since the goal at this zoom is picking apart
// individual markers, not reading map detail.
export const MAP_MAX_ZOOM = 11;

// Ceiling for *automatic* zoom when a cluster/genome is selected (main map
// fitBounds/setView and the tree popup's mini-map). MAP_MAX_ZOOM is only for
// a user deliberately zooming in to pick apart markers; auto-fitting a
// cluster to it landed on upscaled, blurry tiles with no geographic context
// (feedback: "you can barely see a thing"). Zoom 4 = country with neighbours,
// still on real basemap tiles.
export const CLUSTER_FIT_MAX_ZOOM = 4;

// This tile service is geographic (plate carrée), not Web Mercator, so every
// L.map() using it must be constructed with this CRS — otherwise Leaflet
// places markers using Web-Mercator math against imagery that isn't Web
// Mercator, and the mismatch grows with latitude (confirmed: Qingdao ~36°N
// visibly off, Japan ~35-38°N markers landing in open water). Verified
// against the service's own tileInfo (MapServer?f=json): origin
// (-180, 180), resolution 1.40625/2^z degrees/px, i.e. the world is
// 256*2^z px wide (ONE tile wide at z0). Leaflet's built-in L.CRS.EPSG4326
// assumes a world 512*2^z px wide (TWO tiles wide at z0) — exactly double —
// so it requests tiles one zoom level off from what this server actually
// has cached at that URL zoom, which is why raw L.CRS.EPSG4326 rendered
// nothing but "MAP NOT AVAILABLE" placeholders. This transformation
// (1/360, 0.5, -1/360, 0.5) is EPSG:4326's but with the x/y scale factor
// halved to match; pixel-checked against a directly-fetched tile
// (z6/y25/x53, which contains Qingdao) by computing the exact expected
// pixel offset from the origin/resolution and confirming it lands on the
// coastline.
export const UN_CRS = L.extend({}, L.CRS.EPSG4326, {
  transformation: new L.Transformation(1 / 360, 0.5, -1 / 360, 0.5),
});

// ---------------------------------------------------------------------------
// Location precision helpers (shared by the map and the cluster popup)
// ---------------------------------------------------------------------------

// The sub-country portion of geo_loc_name (everything after the first ':'),
// only when the location actually resolved at that granularity —
// e.g. "China: Beijing" -> "Beijing". null for country-only or coordinate
// resolutions, where there's no sub-country string to show.
export function subRegionOf(genome) {
  if (genome.geo_precision !== "geo_loc_name") return null;
  const parts = (genome.geo_loc_name || "").split(":");
  if (parts.length < 2) return null;
  const sub = parts.slice(1).join(":").trim();
  return sub || null;
}

const PRECISION_LABEL = {
  coordinates: "exact",
  geo_loc_name: "approx., geocoded",
  geo_loc_country: "approx., country/region centroid",
  submitter: "approx., country of submitting institution",
};

// Country/Region for display. Countries inferred from the submitter (no
// location in the metadata; see preprocess.py SUBMITTER_COUNTRY) are marked,
// since that's the lab's country, not necessarily where the strain came from.
export function countryLabel(genome) {
  if (!genome || !genome.geo_loc_country || genome.geo_precision === "none") return "—";
  return genome.geo_precision === "submitter"
    ? `${genome.geo_loc_country} (inferred from submitter)`
    : genome.geo_loc_country;
}

// [label, value] rows describing exactly how a genome's map position was
// resolved — a sub-country location when there is one, and always the
// coordinate itself with an honest precision label, so "Country/Region"
// never silently overstates precision that's really just a centroid.
export function locationDetailRows(genome) {
  const rows = [];
  const sub = subRegionOf(genome);
  if (sub) rows.push(["Sub-country location", sub]);
  if (genome.map_latitude != null && genome.map_longitude != null) {
    const label = PRECISION_LABEL[genome.geo_precision] || "approx.";
    rows.push([
      "Coordinates",
      `${genome.map_latitude.toFixed(4)}, ${genome.map_longitude.toFixed(4)} (${label})`,
    ]);
  }
  return rows;
}

export async function loadData() {
  // cache: "no-cache" = always ask the server whether the file changed
  // (a cheap 304 if not). Without it the browser kept serving the old JSON
  // for hours after preprocess.py regenerated it (the local server, like
  // GitHub Pages, sends no Cache-Control, so browsers guess a freshness
  // window from the file's age).
  const load = (path) => fetch(path, { cache: "no-cache" }).then((r) => r.json());
  const [genomes, clusters, tree] = await Promise.all([
    load("data/genomes.json"),
    load("data/clusters.json"),
    load("data/tree.json"),
  ]);

  state.genomes = genomes;
  state.clusters = clusters;
  state.tree = tree;
  state.genomesByAccession = new Map(genomes.map((g) => [g.assembly_accession, g]));
  state.speciesOrder = Array.from(new Set(genomes.map((g) => g.species_subsp))).sort();
  state.speciesColor = speciesColor;
  state.activeClusterIds = new Set(clusters.map((c) => c.cluster_id));

  return state;
}

// Genome selection and cluster selection are mutually exclusive (both drive
// highlighting on the map/timeline, and showing both at once would be
// ambiguous about which highlight is "live"). Selecting one clears the other.
export function selectGenome(accession) {
  state.selectedAccession = accession;
  if (state.selectedClusterId) {
    state.selectedClusterId = null;
    document.dispatchEvent(new CustomEvent("clusterSelected", { detail: { clusterId: null } }));
  }
  document.dispatchEvent(new CustomEvent("genomeSelected", { detail: { accession } }));
}

export function clearSelection() {
  selectGenome(null);
}

export function selectCluster(clusterId) {
  state.selectedClusterId = clusterId;
  if (state.selectedAccession) {
    state.selectedAccession = null;
    document.dispatchEvent(new CustomEvent("genomeSelected", { detail: { accession: null } }));
  }
  document.dispatchEvent(new CustomEvent("clusterSelected", { detail: { clusterId } }));
}

export function clearClusterSelection() {
  selectCluster(null);
}

// ---------------------------------------------------------------------------
// Pinned clusters (comparison)
// ---------------------------------------------------------------------------
// Pins are independent of the genome/cluster selection above: selecting
// anything never unpins. The tree's detail panel shows every pinned cluster
// plus the current selection's cluster (the unpinned "preview", replaced on
// the next click). Order = pin order, preview last, so a cluster's number
// badge doesn't change when the preview gets pinned.
export const MAX_PINNED = 4;

export function pinCluster(clusterId) {
  const pins = state.pinnedClusterIds;
  if (!clusterId || pins.includes(clusterId) || pins.length >= MAX_PINNED) return;
  pins.push(clusterId);
  document.dispatchEvent(new CustomEvent("pinsChanged"));
}

export function unpinCluster(clusterId) {
  const i = state.pinnedClusterIds.indexOf(clusterId);
  if (i === -1) return;
  state.pinnedClusterIds.splice(i, 1);
  document.dispatchEvent(new CustomEvent("pinsChanged"));
}

export function togglePin(clusterId) {
  if (state.pinnedClusterIds.includes(clusterId)) unpinCluster(clusterId);
  else pinCluster(clusterId);
}

export function clearPins() {
  if (!state.pinnedClusterIds.length) return;
  state.pinnedClusterIds = [];
  document.dispatchEvent(new CustomEvent("pinsChanged"));
}

// Unpin everything and clear the selection (panel's top ×, banner "Clear all").
export function clearComparison() {
  clearPins();
  if (state.selectedAccession) clearSelection();
  if (state.selectedClusterId) clearClusterSelection();
}

// The current selection's cluster (a selected cluster, or a selected
// genome's cluster), or null.
export function previewClusterId() {
  if (state.selectedClusterId) return state.selectedClusterId;
  const g = state.selectedAccession && state.genomesByAccession.get(state.selectedAccession);
  return g ? g.cluster_id : null;
}

// Clusters shown in the detail panel / overview highlight: pins, then the
// preview if it isn't pinned.
export function comparedClusterIds() {
  const ids = [...state.pinnedClusterIds];
  const p = previewClusterId();
  if (p && !ids.includes(p)) ids.push(p);
  return ids;
}

// Clusters the Map and Timeline tabs emphasise. Without pins this is the
// pre-pinning behaviour (only an explicitly selected cluster; selecting a
// genome alone dims nothing); with pins it matches the detail panel.
export function highlightedClusterIds() {
  if (state.pinnedClusterIds.length) return comparedClusterIds();
  return state.selectedClusterId ? [state.selectedClusterId] : [];
}

// Number badge (1-based) for a cluster while 2+ are being compared, else null.
export function clusterBadge(clusterId) {
  const ids = comparedClusterIds();
  if (ids.length < 2) return null;
  const i = ids.indexOf(clusterId);
  return i === -1 ? null : i + 1;
}

// Filtering a pinned cluster out unpins it (it can't be shown anyway).
function dropFilteredPins() {
  const kept = state.pinnedClusterIds.filter((id) => state.activeClusterIds.has(id));
  if (kept.length === state.pinnedClusterIds.length) return;
  state.pinnedClusterIds = kept;
  document.dispatchEvent(new CustomEvent("pinsChanged"));
}

export function initTabs() {
  const buttons = Array.from(document.querySelectorAll(".tab-button"));
  const panels = Array.from(document.querySelectorAll(".panel"));

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
      document.dispatchEvent(
        new CustomEvent("panelActivated", { detail: { panel: btn.dataset.panel } })
      );
    });
  });
}

// Compact "currently selected genome" banner, shared across all panels.
// Shared hover tooltip for the two SVG panels (tree, timeline). Leaflet
// markers use their own bindTooltip and don't go through this.
let tooltipEl = null;

function getTooltipEl() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "viz-tooltip";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

// `rows` is an array of [label, value] pairs; inserted via textContent, never
// innerHTML, since these values come from the dataset (untrusted labels).
export function showTooltip(clientX, clientY, title, rows) {
  const el = getTooltipEl();
  el.replaceChildren();

  const strong = document.createElement("strong");
  strong.textContent = title;
  el.appendChild(strong);

  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "tt-row";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.textContent = value;
    row.append(l, v);
    el.appendChild(row);
  });

  const pad = 14;
  let left = clientX + pad;
  let top = clientY + pad;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.classList.add("visible");

  // Keep it on-screen; flip to the left/above if it would overflow.
  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    el.style.left = `${clientX - rect.width - pad}px`;
  }
  if (rect.bottom > window.innerHeight) {
    el.style.top = `${clientY - rect.height - pad}px`;
  }
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.remove("visible");
}

// Shared hierarchical filter + color legend, used by tree/map/timeline
// alike instead of each panel keeping its own always-on legend row. Built
// from tree.json's species->cluster grouping (36 species — the one
// species_subsp that never anchors a cluster as its rep, see
// preprocess.py, simply never gets its own row here; its genomes are still
// filterable via whichever cluster they actually belong to).
function announceFilterChange() {
  dropFilteredPins();
  document.dispatchEvent(new CustomEvent("filterChanged"));
}

export function setClusterActive(clusterId, active) {
  if (active) state.activeClusterIds.add(clusterId);
  else state.activeClusterIds.delete(clusterId);
  announceFilterChange();
}

export function setSpeciesActive(speciesName, active) {
  const sp = state.tree.children.find((s) => s.name === speciesName);
  if (!sp) return;
  sp.children.forEach((cl) => {
    if (active) state.activeClusterIds.add(cl.name);
    else state.activeClusterIds.delete(cl.name);
  });
  announceFilterChange();
}

export function setAllClustersActive(active) {
  state.activeClusterIds = active ? new Set(state.clusters.map((c) => c.cluster_id)) : new Set();
  announceFilterChange();
}

export function initFilterControl() {
  const toggleBtn = document.getElementById("filter-toggle");
  const toggleLabel = document.getElementById("filter-toggle-label");
  const dropdown = document.getElementById("filter-dropdown");
  const listEl = document.getElementById("filter-list");

  const clusterCheckboxes = new Map(); // cluster_id -> checkbox
  const speciesInfo = []; // [{ name, checkbox, clusterIds }]

  state.tree.children.forEach((sp) => {
    const clusterIds = sp.children.map((cl) => cl.name);
    const totalGenomes = sp.children.reduce((sum, cl) => sum + cl.member_count, 0);

    const row = document.createElement("div");
    row.className = "filter-row filter-row--species";

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "filter-row__expand";
    expandBtn.textContent = "▸";
    expandBtn.setAttribute("aria-label", `Show clusters for ${sp.name}`);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;

    const swatch = document.createElement("span");
    swatch.className = "filter-row__swatch";
    swatch.style.background = state.speciesColor(sp.name);

    const label = document.createElement("span");
    label.className = "filter-row__label";
    label.textContent = sp.name;

    const count = document.createElement("span");
    count.className = "filter-row__count";
    count.textContent = `${clusterIds.length} cluster${clusterIds.length === 1 ? "" : "s"} · ${totalGenomes} genomes`;

    row.append(expandBtn, checkbox, swatch, label, count);

    const childrenEl = document.createElement("div");
    childrenEl.className = "filter-row__children";
    childrenEl.hidden = true;

    sp.children.forEach((cl) => {
      const crow = document.createElement("div");
      crow.className = "filter-row filter-row--cluster";

      const ccheck = document.createElement("input");
      ccheck.type = "checkbox";
      ccheck.checked = true;

      const clabel = document.createElement("span");
      clabel.className = "filter-row__label";
      clabel.textContent = cl.name;

      const ccount = document.createElement("span");
      ccount.className = "filter-row__count";
      ccount.textContent = `${cl.member_count} genome${cl.member_count === 1 ? "" : "s"}`;

      crow.append(ccheck, clabel, ccount);
      childrenEl.appendChild(crow);
      clusterCheckboxes.set(cl.name, ccheck);

      ccheck.addEventListener("change", () => {
        setClusterActive(cl.name, ccheck.checked);
        syncSpeciesRow(sp.name);
      });
    });

    expandBtn.addEventListener("click", () => {
      childrenEl.hidden = !childrenEl.hidden;
      expandBtn.textContent = childrenEl.hidden ? "▸" : "▾";
    });

    checkbox.addEventListener("change", () => {
      setSpeciesActive(sp.name, checkbox.checked);
      clusterIds.forEach((id) => {
        const cb = clusterCheckboxes.get(id);
        if (cb) cb.checked = checkbox.checked;
      });
    });

    listEl.append(row, childrenEl);
    speciesInfo.push({ name: sp.name, checkbox, clusterIds });
  });

  function syncSpeciesRow(speciesName) {
    const info = speciesInfo.find((s) => s.name === speciesName);
    if (!info) return;
    const active = info.clusterIds.map((id) => state.activeClusterIds.has(id));
    const allOn = active.every(Boolean);
    const allOff = active.every((v) => !v);
    info.checkbox.checked = allOn;
    info.checkbox.indeterminate = !allOn && !allOff;
  }

  function updateToggleLabel() {
    const total = state.clusters.length;
    const active = state.activeClusterIds.size;
    toggleLabel.textContent = active === total ? "All species/clusters shown" : `${active} / ${total} clusters shown`;
  }

  document.getElementById("filter-select-all").addEventListener("click", () => {
    setAllClustersActive(true);
    clusterCheckboxes.forEach((cb) => (cb.checked = true));
    speciesInfo.forEach((s) => {
      s.checkbox.checked = true;
      s.checkbox.indeterminate = false;
    });
  });
  document.getElementById("filter-select-none").addEventListener("click", () => {
    setAllClustersActive(false);
    clusterCheckboxes.forEach((cb) => (cb.checked = false));
    speciesInfo.forEach((s) => {
      s.checkbox.checked = false;
      s.checkbox.indeterminate = false;
    });
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

  document.addEventListener("filterChanged", updateToggleLabel);
  updateToggleLabel();
}

// Selection banner (top of every tab), rebuilt from state on any selection or
// pin change. Without pins: the selected genome or cluster, as before. With
// pins: a "Comparing" row of numbered chips (the preview chip is dashed =
// not pinned yet), plus the selected genome if there is one.
export function initSelectionBanner() {
  const banner = document.getElementById("selection-banner");
  const render = () => renderBanner(banner);
  document.addEventListener("genomeSelected", render);
  document.addEventListener("clusterSelected", render);
  document.addEventListener("pinsChanged", render);
}

function bannerClear(label, onClick) {
  const clear = document.createElement("button");
  clear.className = "selection-banner__clear";
  clear.type = "button";
  clear.setAttribute("aria-label", label);
  clear.textContent = "×";
  clear.addEventListener("click", onClick);
  return clear;
}

function bannerSwatch(speciesSubsp) {
  const swatch = document.createElement("span");
  swatch.className = "selection-banner__swatch";
  swatch.style.background = state.speciesColor(speciesSubsp);
  return swatch;
}

// Small numbered badge used everywhere a compared cluster appears.
export function badgeEl(n) {
  const b = document.createElement("span");
  b.className = "cluster-badge";
  b.textContent = String(n);
  return b;
}

function renderBanner(banner) {
  banner.replaceChildren();
  const g = state.selectedAccession && state.genomesByAccession.get(state.selectedAccession);
  const pinned = state.pinnedClusterIds.length > 0;

  if (g) {
    const part = document.createElement("span");
    part.className = "selection-banner__part";
    const text = document.createElement("span");
    text.className = "selection-banner__text";
    text.textContent = `${g.assembly_accession} — ${g.organism_name}${g.strain ? " " + g.strain : ""} (${g.tier})`;
    const link = document.createElement("a");
    link.href = g.ncbi_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "selection-banner__link";
    link.textContent = "NCBI ↗";
    part.append(bannerSwatch(g.species_subsp), text, link, bannerClear("Clear genome selection", () => clearSelection()));
    banner.append(part);
  } else if (state.selectedClusterId && !pinned) {
    const c = state.clusters.find((c) => c.cluster_id === state.selectedClusterId);
    if (c) {
      const part = document.createElement("span");
      part.className = "selection-banner__part";
      const text = document.createElement("span");
      text.className = "selection-banner__text";
      text.textContent = `Cluster ${c.cluster_id} — ${c.species_subsp} (${c.member_count} genomes, rep ${c.rep_accession})`;
      part.append(bannerSwatch(c.species_subsp), text, bannerClear("Clear cluster selection", () => clearClusterSelection()));
      banner.append(part);
    }
  }

  if (pinned) {
    const part = document.createElement("span");
    part.className = "selection-banner__part selection-banner__compare";
    const label = document.createElement("span");
    label.className = "selection-banner__label";
    label.textContent = "Comparing";
    part.append(label);
    comparedClusterIds().forEach((id) => {
      const c = state.clusters.find((c) => c.cluster_id === id);
      if (!c) return;
      const isPinned = state.pinnedClusterIds.includes(id);
      const chip = document.createElement("span");
      chip.className = "selection-banner__chip" + (isPinned ? "" : " is-preview");
      chip.title = isPinned ? `${c.species_subsp}, ${c.member_count} genomes` : `${c.species_subsp}, ${c.member_count} genomes — not pinned`;
      const name = document.createElement("span");
      name.textContent = `${c.cluster_id} · ${c.species_subsp.replace(/^Bifidobacterium\b/, "B.")}`;
      chip.append(badgeEl(clusterBadge(id) ?? 1), bannerSwatch(c.species_subsp), name);
      if (isPinned) chip.append(bannerClear(`Unpin cluster ${id}`, () => unpinCluster(id)));
      part.append(chip);
    });
    const all = document.createElement("button");
    all.type = "button";
    all.className = "selection-banner__clear-all";
    all.textContent = "Clear all";
    all.addEventListener("click", () => clearComparison());
    part.append(all);
    banner.append(part);
  }

  banner.hidden = banner.childElementCount === 0;
}
