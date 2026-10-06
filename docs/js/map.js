// Leaflet map. One marker per genome with a resolved map coordinate
// (geo_precision !== 'none' — see scripts/preprocess.py for the 3-tier
// coordinates -> geo_loc_name -> geo_loc_country fallback). Many genomes
// share an identical country-centroid fallback coordinate, so markers are
// deterministically jittered around shared points to stay visible/clickable.
import {
  state,
  selectGenome,
  locationDetailRows,
  countryLabel,
  BASEMAP_URL,
  BASEMAP_ATTRIBUTION,
  BASEMAP_MAX_ZOOM,
  MAP_MAX_ZOOM,
  CLUSTER_FIT_MAX_ZOOM,
  UN_CRS,
  highlightedClusterIds,
  clusterBadge,
} from "./main.js";
import { badgeIcon } from "./clusterDetail.js";

let map;
let markersByAccession = new Map();
let badgeLayer; // numbered overlays on compared clusters' markers (non-interactive)

export function renderMap() {
  const mapped = state.genomes.filter((g) => g.geo_precision !== "none");

  // worldCopyJump isn't supported outside the default EPSG3857 CRS, and
  // isn't needed at this basemap's zoom-6 ceiling anyway.
  //
  // Free dragging/zooming is fully enabled. The "MAP NOT AVAILABLE AT THIS
  // SCALE" placeholder was never actually a zoom-cap-only problem: at low
  // zoom, or near the left/right edge, Leaflet's tile grid prefetches a
  // buffer tile one column/row beyond what's visible (standard GridLayer
  // behavior, not specific to this basemap), and even with `noWrap`, under
  // this basemap's custom CRS that buffer tile's index can land just
  // outside the real 0..(2^z-1) column range — confirmed by directly
  // requesting tile 2/1/-1 (column -1, one past the left edge at zoom 2):
  // ArcGIS returns the placeholder image (442×354) there instead of a 404,
  // and `noWrap` alone doesn't stop Leaflet from asking for it in the first
  // place. The real fix is the tile layer's `bounds` option below, which
  // makes Leaflet check each candidate tile's actual geographic coverage
  // against the valid world extent before ever requesting it — including
  // that buffer tile — so the placeholder is simply never fetched,
  // regardless of pan or zoom.
  //
  // Deliberately NOT also setting `maxBounds` on the map itself — tried
  // that first as a belt-and-suspenders backstop, but it actively broke
  // programmatic panning: at low zoom (world smaller than the viewport),
  // `maxBoundsViscosity`'s re-centering logic re-fires on every zoom
  // change and snaps the view back toward the bounds' own center,
  // overriding a just-completed `panTo`/`setView` to a selected genome
  // (confirmed — selecting a Japan genome, then zooming in via the
  // toolbar, landed back over the Atlantic instead of staying on Japan).
  // The tile layer's `bounds` option alone is sufficient (verified against
  // 0 placeholder tiles across extensive pan/zoom stress-testing) and
  // doesn't touch the map's pan/zoom behavior at all.
  // zoomSnap 0: whole-number zoom levels left the world either smaller than
  // the panel (grey margins) or cropped; any fractional zoom lets the world
  // exactly fill the panel width (see fitWorldToWidth). Buttons still step 1.
  map = L.map("map", {
    crs: UN_CRS,
    maxZoom: MAP_MAX_ZOOM,
    zoomSnap: 0,
    scrollWheelZoom: false, // replaced by enableSmoothWheelZoom() below
  }).setView([20, 10], 2);
  enableSmoothWheelZoom(map);
  L.tileLayer(BASEMAP_URL, {
    attribution: BASEMAP_ATTRIBUTION,
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: BASEMAP_MAX_ZOOM,
    noWrap: true,
    bounds: [
      [-90, -180],
      [90, 180],
    ],
  }).addTo(map);

  badgeLayer = L.layerGroup().addTo(map);
  const coords = jitterCoordinates(mapped);

  mapped.forEach((g) => {
    const [lat, lon] = coords.get(g.assembly_accession);
    const color = state.speciesColor(g.species_subsp);

    const marker = L.circleMarker([lat, lon], {
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: g.is_rep ? 0.9 : 0.15,
      interactive: true,
    });

    marker.bindTooltip(buildTooltipContent(g), { direction: "top", offset: [0, -6] });
    marker.on("click", () => selectGenome(g.assembly_accession));

    marker.addTo(map);
    markersByAccession.set(g.assembly_accession, { marker, genome: g });
  });

  document.addEventListener("genomeSelected", (e) => onGenomeSelected(e.detail.accession));
  document.addEventListener("clusterSelected", (e) => {
    if (e.detail.clusterId) onClusterSelected();
    else restyle();
  });
  document.addEventListener("pinsChanged", onClusterSelected);
  document.addEventListener("filterChanged", applyFilter);

  // The map panel is hidden (display:none) on first load since Tree is the
  // active tab, so Leaflet computes a bogus size at construction time and
  // only paints a corner of tiles. Fix it up the first time the tab is shown.
  let fittedOnce = false;
  document.addEventListener("panelActivated", (e) => {
    if (e.detail.panel !== "panel-map") return;
    sizeMapToWindow();
    if (!fittedOnce && !pendingMapAction) {
      map.fitBounds(
        [
          [-90, -180],
          [90, 180],
        ],
        { animate: false }
      );
    }
    fittedOnce = true;
    if (pendingMapAction) {
      pendingMapAction();
      pendingMapAction = null;
    }
  });
  window.addEventListener("resize", () => {
    if (isMapPanelVisible()) sizeMapToWindow();
  });
}

// Leaflet's own wheel zoom crawls with zoomSnap 0: it turns each 40ms
// batch of wheel delta into a zoom step through a curve that's nearly flat
// for small deltas, and only zoomSnap's rounding-up ever made it feel fast.
// A trackpad pinch (Chrome/Edge/Firefox send it as ctrl+wheel with deltas of
// a few px) measured ~0.2 zoom levels per second of pinching. Instead, zoom
// in direct proportion to the delta, applied once per animation frame,
// around the pointer:
//   - pinch: Chrome scales pages by e^(-deltaY/100), so -deltaY/(100·ln2)
//     zoom levels tracks the fingers 1:1;
//   - mouse wheel / two-finger scroll: ~0.8 level per 100px wheel notch.
const PINCH_ZOOM_PER_PX = 1 / (100 * Math.LN2);
const WHEEL_ZOOM_PER_PX = 0.008;

function enableSmoothWheelZoom(m) {
  const el = m.getContainer();
  let pending = 0;
  let anchor = null;
  let frame = null;
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault(); // no page scroll / browser zoom while over the map
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      pending -= px * (e.ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX);
      anchor = m.mouseEventToContainerPoint(e);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const z = Math.max(m.getMinZoom(), Math.min(m.getMaxZoom(), m.getZoom() + pending));
        pending = 0;
        if (z !== m.getZoom()) m.setZoomAround(anchor, z, { animate: false });
      });
    },
    { passive: false }
  );
}

// The previous fixed 560px height left a large empty band under the map on
// normal screens. Now: zoom so the whole world (360° of longitude) exactly
// spans the panel's width, and make the map as tall as that world is
// (width/2 — this basemap is plate carrée), capped by the space left in the
// window. That zoom is also the minimum zoom, so zooming out never shows
// grey beyond the edge of the world. If the window is shorter than width/2,
// the map is cropped top/bottom and can be panned (min height keeps it usable).
const MAP_MIN_HEIGHT = 420;
const MAP_BOTTOM_GAP = 36; // panel padding + page margin below the map

function sizeMapToWindow() {
  const el = document.getElementById("map");
  const width = el.clientWidth;
  const top = el.getBoundingClientRect().top + window.scrollY;
  const available = window.innerHeight - top - MAP_BOTTOM_GAP;
  el.style.height = `${Math.round(Math.max(MAP_MIN_HEIGHT, Math.min(width / 2, available)))}px`;
  map.invalidateSize();
  // Zoom at which 360° of longitude exactly spans the width (a full-width,
  // zero-height box, so only the width constrains it).
  const minZoom = map.getBoundsZoom(
    [
      [0, -180],
      [0.0001, 180],
    ],
    false,
    [0, 0]
  );
  // setMinZoom() zooms in with an *animation* when the current zoom is below
  // the new minimum, and that animation lands after (and undoes) any
  // immediate fitBounds/panTo. Jump there without animation first.
  if (map.getZoom() < minZoom) map.setZoom(minZoom, { animate: false });
  map.setMinZoom(minZoom);
}

// A pan/fitBounds computed while the map panel is display:none uses a
// zero-size container and lands on a bogus view — invalidateSize() on tab
// activation fixes the container's size but doesn't retroactively fix a pan
// already computed against the wrong size. So: run the view change now if
// the panel is already visible, otherwise defer it until panelActivated.
let pendingMapAction = null;

function isMapPanelVisible() {
  return document.getElementById("panel-map").classList.contains("active");
}

function runOrDefer(action) {
  if (isMapPanelVisible()) {
    action();
  } else {
    pendingMapAction = action;
  }
}

function buildTooltipContent(g) {
  const box = document.createElement("div");
  const rows = [
    ["Accession", g.assembly_accession],
    ["Organism", g.organism_name],
    ["Strain", g.strain || "—"],
    ["Submitter", g.submitter || "—"],
    ["Country/Region", countryLabel(g)],
    ...locationDetailRows(g),
    ["Tier", g.tier],
  ];
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "tt-row";
    const l = document.createElement("span");
    l.textContent = label + ": ";
    l.style.fontWeight = "600";
    const v = document.createElement("span");
    v.textContent = value;
    row.append(l, v);
    box.appendChild(row);
  });
  return box;
}

function defaultStyle(genome) {
  return { weight: 2, opacity: 1, fillOpacity: genome.is_rep ? 0.9 : 0.15 };
}

let lastSelectedAccession = null;

function onGenomeSelected(accession) {
  pendingMapAction = null;

  if (lastSelectedAccession) {
    const prev = markersByAccession.get(lastSelectedAccession);
    if (prev) prev.marker.closeTooltip(); // opened below on select; otherwise it lingers
  }
  lastSelectedAccession = accession;
  // A genome's cluster joins the highlight while pins exist, so restyle
  // (and refit) whenever the selection changes then.
  if (state.pinnedClusterIds.length) onClusterSelected();
  else restyle();
  if (!accession) return;

  const entry = markersByAccession.get(accession);
  if (!entry) return; // genome has no resolvable map location

  entry.marker.setStyle({ weight: 4, opacity: 1, fillOpacity: entry.genome.is_rep ? 0.95 : 0.65 });
  entry.marker.bringToFront();
  entry.marker.openTooltip();
  runOrDefer(() => map.panTo(entry.marker.getLatLng(), { animate: true }));
}

// Cluster-level highlight: dim everything outside the highlighted clusters
// (the selected cluster, or every pinned/compared one — main.js
// highlightedClusterIds), emphasize everything inside, and while 2+ are
// compared put each cluster's number badge on its markers (colour can't
// separate two clusters of the same species).
function restyle() {
  const ids = new Set(highlightedClusterIds());
  badgeLayer.clearLayers();
  markersByAccession.forEach(({ marker, genome }) => {
    if (!ids.size) {
      marker.setStyle(defaultStyle(genome));
    } else if (ids.has(genome.cluster_id)) {
      marker.setStyle({ weight: 3, opacity: 1, fillOpacity: genome.is_rep ? 0.95 : 0.65 });
      marker.bringToFront();
      const n = clusterBadge(genome.cluster_id);
      if (n && map.hasLayer(marker)) {
        L.marker(marker.getLatLng(), {
          icon: badgeIcon(n, marker.options.color, genome.is_rep),
          interactive: false, // clicks/hover fall through to the circle marker
          keyboard: false,
        }).addTo(badgeLayer);
      }
    } else {
      marker.setStyle({ weight: 1, opacity: 0.15, fillOpacity: 0.03 });
    }
  });
  const sel = lastSelectedAccession && markersByAccession.get(lastSelectedAccession);
  if (sel) sel.marker.setStyle({ weight: 4, opacity: 1 });
}

// Restyle, then fit the view to the highlighted clusters' markers.
function onClusterSelected() {
  pendingMapAction = null;
  restyle();

  const ids = new Set(highlightedClusterIds());
  if (!ids.size) return;
  const bounds = [];
  markersByAccession.forEach(({ marker, genome }) => {
    if (ids.has(genome.cluster_id) && map.hasLayer(marker)) bounds.push(marker.getLatLng());
  });

  if (bounds.length === 1) {
    runOrDefer(() => map.setView(bounds[0], CLUSTER_FIT_MAX_ZOOM));
  } else if (bounds.length > 1) {
    runOrDefer(() => map.fitBounds(bounds, { padding: [40, 40], maxZoom: CLUSTER_FIT_MAX_ZOOM }));
  }
}

// Driven by the shared hierarchical filter (see main.js initFilterControl)
// instead of a map-only species legend.
function applyFilter() {
  markersByAccession.forEach(({ marker, genome }) => {
    const active = state.activeClusterIds.has(genome.cluster_id);
    const onMap = map.hasLayer(marker);
    if (active && !onMap) marker.addTo(map);
    else if (!active && onMap) map.removeLayer(marker);
  });
  restyle(); // badges follow marker visibility
}

// Deterministic spiral jitter for genomes sharing an identical fallback
// coordinate (mostly the country-centroid tier), so they render as a visible,
// clickable cluster instead of one stacked dot.
//
// The radius is a Vogel/Fermat spiral normalized by GROUP SIZE, not raw
// index (`MAX_JITTER_DEGREES * sqrt((idx+0.5)/n)`), so every point in a
// group lands within MAX_JITTER_DEGREES of the true fallback point no
// matter how large the group is. The previous formula (`0.25 * sqrt(idx)`,
// no upper bound) grew without limit as a group got bigger — Japan's
// country-centroid fallback is shared by 211 genomes, which worked out to
// a ~3.6° jitter radius, easily enough to land in the sea around a narrow
// archipelago (confirmed by reverse-geocoding several jittered points that
// users reported seeing in the ocean). This also drops the old
// latitude-based longitude stretch (`/ cos(lat)`), which made the bug
// worse for exactly the countries most at risk: it deliberately enlarges
// the *longitude* jitter at high latitudes to keep the spiral visually
// circular, which is precisely the wrong axis to enlarge for a
// north-south-elongated, narrow-east-west country like Japan.
function jitterCoordinates(genomes) {
  const groups = new Map();
  genomes.forEach((g) => {
    const key = `${g.map_latitude},${g.map_longitude}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  });

  const result = new Map();
  const GOLDEN_ANGLE = 2.399963;
  const MAX_JITTER_DEGREES = 0.35;

  groups.forEach((arr) => {
    const n = arr.length;
    if (n === 1) {
      result.set(arr[0].assembly_accession, [arr[0].map_latitude, arr[0].map_longitude]);
      return;
    }
    arr.forEach((g, idx) => {
      const angle = idx * GOLDEN_ANGLE;
      const radiusDeg = MAX_JITTER_DEGREES * Math.sqrt((idx + 0.5) / n);
      const lat = g.map_latitude + radiusDeg * Math.cos(angle);
      const lon = g.map_longitude + radiusDeg * Math.sin(angle);
      result.set(g.assembly_accession, [lat, lon]);
    });
  });

  return result;
}
