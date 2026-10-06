# Bifidobacterium Genome Browser

A public-facing static website (GitHub Pages, served from `docs/`) that
visualizes 809 curated commercial *Bifidobacterium* probiotic genomes — their
dRep dereplication clusters, quality metrics, geographic origins, and
submission timeline. Intended for publication alongside a peer-reviewed
manuscript (Matt Olm lab, University of Colorado).

---

## Status — read this first

**Built and working end-to-end:** five cross-linked tabs (Tree / Map /
Timeline / Table / Summary), verified repeatedly with headless-Chrome smoke
tests. **Nothing is committed to git yet** (`main` has zero commits, all files
untracked) and **nothing is deployed** — only ever run locally.

### Open / next up

1. **Upcoming metadata/genome-info change (user will describe it next
   session).** `genome_withcluster_metadata.tsv` and/or
   `genomeInformation.csv` are expected to change (new rows, new or renamed
   columns, etc.). Be ready to update `scripts/preprocess.py` accordingly:
   - Column names are referenced directly in `load_metadata()`,
     `load_genome_info()`, `build_cluster_dendrogram()` → `leaf_dict()`
     (fields carried into `tree.json` leaves), `build_clusters()`, and
     `resolve_location()`.
   - Re-check every assumption in **Data sources → Corrections** below
     (`cluster` vs `cluster_id`, `cluster_role`, `strain`/`user_strain_name`,
     non-uniform `species_subsp`) against the new file — they were found by
     inspecting the data, not from column names, and may no longer hold.
   - New `geo_loc_name` strings need entries in `GEO_NAME_COORDS` /
     `COUNTRY_COORDS` or they fall back to country centroid / `"none"`.
     After any geocoding change, re-verify coordinates (a past sign error put
     Santiago, Chile in the Atlantic).
   - Counts hard-coded in prose here (809 genomes, 352 clusters as of 2026-10-05, 36/37
     species, 41 countries, 211-genome Japan group, etc.) will go stale —
     update this file after regenerating.
   - Regenerate: `.venv/bin/python scripts/preprocess.py`, then reload the
     site and spot-check every tab.
2. **Unresolved: user reported the page "opens but is frozen."** Could not
   reproduce: headless load (~3s, no errors), expanding the 90-member
   cluster, rapid tab switching, syntax check of every JS file all fine.
   Asked the user how they open it (must be via a local server, e.g.
   `python3 -m http.server --directory docs 8000` — opening `index.html`
   directly breaks `fetch()` of the JSON) and for any console errors; no
   answer yet. Follow up.
3. **Cluster pinning/comparison (2026-10-02) is on trial** — the user may
   reject it. Rollback snapshot of the pre-pinning site:
   `backups/docs-before-pinning-2026-10-02.tar.gz` (contains `docs/` and
   `CLAUDE.md`; restore with `tar xzf` from the project root, which
   overwrites both). Once the user decides, delete the snapshot (and don't
   commit `backups/`).
4. Commit → push → enable GitHub Pages, whenever the user wants.
5. Mobile layout untested (desktop-first by design).
6. Favicon 404 in every console check — cosmetic, never fixed.
7. No automated test suite; verification has been one-off puppeteer scripts
   (`puppeteer-core` driving system Chrome) kept outside the repo.

---

## Stack

- Pure HTML/CSS/JS, no framework, no build step.
- D3 v7 (tree, timeline, summary charts), Leaflet (map + detail-panel
  mini-map), DataTables + jQuery (table).
- Basemap: UN Geospatial "Clear Map" (not OSM) — see Map below.
- Python preprocessing only (pandas / numpy / scipy). macOS system Python is
  externally managed → use the `.venv` described in `README.md`.

## Repository layout

```
bifido_genome_browser/
├── data/raw/
│   ├── genome_withcluster_metadata.tsv   # primary metadata + cluster assignments
│   ├── Ndb.csv                           # dRep pairwise ANI
│   └── genomeInformation.csv             # dRep per-genome stats (CheckM, N50, length, centrality)
├── scripts/
│   ├── preprocess.py                     # raw files -> docs/data/*.json
│   └── requirements.txt
├── docs/                                 # GitHub Pages root
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── main.js          # state, data load, palette, tabs, selection bus, shared filter, basemap constants
│   │   ├── tree.js          # radial D3 dendrogram
│   │   ├── clusterDetail.js # tree's cluster detail panel (dendrogram + mini map + mini timeline)
│   │   ├── map.js           # Leaflet map
│   │   ├── timeline.js      # stacked bars by year
│   │   ├── table.js         # DataTables
│   │   └── stats.js         # Summary tab
│   └── data/{genomes,clusters,tree}.json # generated — never hand-edit
├── README.md
└── .venv/                                # not committed
```

---

## Data sources

### `genome_withcluster_metadata.tsv` (primary, one row per genome)

| Column | Used for |
|--------|----------|
| `assembly_accession` | Primary key, NCBI link |
| `organism_name` | Display name |
| `strain` | Strain label (falls back to `user_strain_name`, see below) |
| `species_subsp` | Species/subspecies grouping; color palette key |
| `tier` / `tier_reason` | Tier1 / Tier2 / Tier2-unconfirmed |
| `submitter`, `evidence_sources` / `evidence_details`, `literature_paper_count`, `type_material` | Metadata / tooltips |
| `geo_loc_name` | Free-text location, geocoded (see Preprocessing) |
| `geo_loc_latitude` / `geo_loc_longitude` | Exact coords — only 1/809 rows |
| `biosample_submission_date` | ISO 8601 → `submission_year` |
| `cluster` | **The real dRep cluster id** (`{primary}_{secondary}`, e.g. `1_46`) |
| `rep_assembly_accession`, `rep_score`, `score` | Cluster rep / dRep scores |
| `tier_checkm2`, `rep_tier_checkm2` | **Not used** — see below |
| `checkm_*`, `contig_n50`, `total_length`, … | Fallback only — prefer `genomeInformation.csv` |

**Corrections found by inspecting the data (not obvious from column names):**

- **`cluster_id` is NOT the cluster id** (holds `"gcfgca:GCA_…"` or blank).
  Dropped; `cluster` is used and exposed to the site as `cluster_id`.
- **`cluster_role` does NOT mark the rep** (792/809 are `"canonical"`).
  `is_rep = assembly_accession == rep_assembly_accession`, nothing else.
- **Tier = `tier_checkm2`** (user decision, 2026-10). `load_metadata()`
  renames the raw `tier` to `tier_original` and copies `tier_checkm2` into
  `tier`, so the JSON/site still read `tier`. Only Tier1/Tier2 exist now (no
  Tier2-unconfirmed; its Summary tile was removed). Preprocessing **aborts**
  if `tier_checkm2` holds anything else — the first 2026-10 file had stray
  numeric values (genome lengths) for 11 genomes; fixed upstream, all 11 are
  Tier2. Current split: 260 Tier1 / 549 Tier2 (the 17 old
  Tier2-unconfirmed are now Tier2).
  Rep tier is read from the rep genome's own `tier`, not `rep_tier_checkm2`
  (renamed from `rep_tier` in that update), so the two can't disagree.
- **34 genomes have neither `strain` nor `user_strain_name`** (2026-10
  data); their labels fall back to accession only.
- **`strain` blank but `user_strain_name` set** for 2 rows (`GCF_000817045.1`
  → "lactis A6", `GCF_902167885.1` → "EVC001"); they never disagree when both
  present. `load_metadata()` fills blank `strain` from `user_strain_name`.
- **`species_subsp` isn't uniform within a cluster** (37/329 mix an
  `unspecified` label with a subspecies). Cluster-level species and tree
  placement are anchored to the **rep's own label**, not a majority vote;
  the full split is in `species_subsp_breakdown`. Consequence:
  *B. animalis subsp. lactis* never reps a cluster, so it gets no top-level
  tree branch (36 tree species vs 37 total) — its genomes still appear
  everywhere, filed under a sibling species node.

### `Ndb.csv`
Pairwise ANI (`reference`, `querry`, `ani`, `alignment_coverage`, …). Names
carry `.fna` — strip before joining. Self-pairs exist; directional rows can
differ slightly in coverage. ~241k rows, filtered to
`alignment_coverage >= 0.3`.

### `genomeInformation.csv`
`genome` (`.fna`), `completeness`, `contamination`, `length`, `N50`,
`centrality`. Full coverage of all genomes → wins over the TSV's `checkm_*` /
assembly columns (which have gaps for Tier2-unconfirmed).

---

## Preprocessing (`scripts/preprocess.py`)

Run: `.venv/bin/python scripts/preprocess.py` → writes `docs/data/`.

- Strip `.fna` from dRep names; merge `genomeInformation.csv` stats onto
  metadata (fallback to TSV only where missing).
- Cluster id = `cluster` column; `is_rep` as above; `strain` fallback as above.
- **Geocoding** (`resolve_location()` + `apply_submitter_country()` →
  `map_latitude`, `map_longitude`, `geo_precision`):
  1. exact `geo_loc_latitude/longitude` → `"coordinates"`
  2. `geo_loc_name` in hand-curated `GEO_NAME_COORDS` (~80) → `"geo_loc_name"`
  3. first token of `geo_loc_name` in `COUNTRY_COORDS` → `"geo_loc_country"`
  4. **(added 2026-10, user request)** no location at all → country of the
     *submitting institution* from hand-curated `SUBMITTER_COUNTRY` →
     `"submitter"`; also overwrites `geo_loc_country`. This is the lab's
     country, not necessarily the isolation origin (JGI/WashU/Broad etc.
     sequenced strains from anywhere), so the site always labels it
     "(inferred from submitter)" via `countryLabel()` in `main.js`. Only
     unambiguous institutions are listed; DuPont, metaHIT, Lactic Acid
     Bacteria Genome Consortium, MET-4, Purity-IQ Inc., SC left out.
  5. else `"none"` (junk like "missing", "not determined", "not applicable").
  Current split: 214 geo_loc_name / 463 country / 123 submitter / 1 exact /
  8 none. Dict entries audited by reverse-geocoding (Nominatim). New
  submitters in a data update need adding to `SUBMITTER_COUNTRY` too.
- `geo_loc_country` = first token of `geo_loc_name` regardless of whether it
  resolved — so it can hold junk; anything treating it as a real country
  must also require `geo_precision !== "none"`.
- **Per-cluster dendrogram:** pairwise `1 - ani` among members → scipy
  `linkage(method="average")` + `to_tree()` → nested JSON with real `height`
  at merge nodes (leaves `height: 0`). Singletons skip linkage.

### Outputs
- **`genomes.json`** — one record per genome: all TSV columns + merged dRep
  stats, `submission_year`, `geo_loc_country`, `map_latitude/longitude`,
  `geo_precision`, `is_rep`, `is_type_material`, `ncbi_url`, `cluster_id`.
- **`clusters.json`** — `cluster_id`, `rep_accession`, `rep_tier`,
  `species_subsp` (rep's label), `species_subsp_breakdown`, `member_count`,
  `members`.
- **`tree.json`** — root (`max_merge_height`, reference only) → species
  (36) → cluster nodes (`rep`, `rep_tier`, `member_count`, `max_height`,
  `species_subsp_breakdown` when mixed; single-element `children` wrapping
  the dendrogram root) → merge nodes (`height`) → leaves. Leaf fields come
  from `leaf_dict()`: `name`, `is_rep`, `tier`, `height`, `ani_to_rep`,
  `strain`, `organism_name`, `submission_year`, `geo_loc_country`,
  `submitter`, `evidence_sources`. To show a new field in tree tooltips,
  add it to `leaf_dict()` first.

---

## Site behavior (`docs/`)

### Shared across tabs
- **Header / branding:** title "*Bifidobacterium* Probiotics Genome
  Browser" (no subtitle / genome count). Right side: two lab blocks,
  **Mueller Lab first** (user's instruction) — each = short gold bar, lab
  name, "UNIVERSITY OF COLORADO" small caps, campus (Anschutz Medical
  Campus / Boulder), separated by a hairline. No "A collaboration between"
  eyebrow and no "&" (user removed both). Neither lab has a logo, so the
  shared identity is the university: CU gold `--cu-gold` #cfb87c only as an
  accent (4px top rule, lab bars, faint Front Range ridgeline SVG). Gold is
  too light for text. No official university logos. Footer: lab credits
  left, data sources + **"Version: 2026-09" pill bottom-right — bump it in
  `index.html` whenever data or site changes.** Lab website links not added
  (URLs unknown — ask the user).
- **Header filter** (`initFilterControl` in `main.js`): hierarchical
  species → cluster checkbox dropdown, drives `state.activeClusterIds` +
  `filterChanged`. Tree/Map/Timeline/Summary respect it; **Table does not**
  (always-complete view by design).
- **Events on `document`:** `genomeSelected {accession}` and
  `clusterSelected {clusterId}` (mutually exclusive — selecting one clears
  the other), `filterChanged`, `panelActivated {panel}` (used to redo
  anything measured while `display:none`: Leaflet `invalidateSize`, timeline
  /summary widths, DataTables columns; map pans are deferred via
  `runOrDefer` until the Map tab is visible).
- **Selection banner** at top reflects the active selection, `×` clears it;
  while clusters are pinned it adds a "Comparing" row of numbered chips
  (dashed chip = unpinned preview) + "Clear all".
- **Pinned clusters (comparison, on trial — see Status).** `state.
  pinnedClusterIds` (max `MAX_PINNED = 4`, pin order), independent of the
  genome/cluster selection; event `pinsChanged`. Helpers in `main.js`:
  `comparedClusterIds()` = pins + the selection's cluster ("preview",
  last, so pinning it keeps its number); `highlightedClusterIds()` = what
  Map/Timeline emphasise (without pins: only an explicitly selected
  cluster, as before; with pins: same as the panel); `clusterBadge(id)` =
  1-based number when 2+ are compared. **Numbers, not colour, identify
  compared clusters** (colour = species; compared clusters are often the
  same species) — the same number appears on the panel card, tree dot
  (pushed inward if neighbours collide), map markers (non-interactive
  `divIcon` overlays from `badgeIcon()`), banner chip and timeline strip.
  Filtering a pinned cluster out unpins it.
- **Colour = species group, subspecies = shades of it** (2026-10, for
  colour-blind safety; `COLOR_GROUPS` / `colorKeyOf()` / `COLOR_KEYS` in
  `main.js`). Six largest parent species get the six chromatic Okabe–Ito
  colours, by name (never by rank): *longum* #0072B2, *animalis* #E69F00,
  *breve* #009E73, *pseudocatenulatum* #D55E00, *bifidum* #CC79A7,
  *adolescentis* #56B4E9; the other 21 species (incl. *catenulatum*) are
  light grey #c8c8c8 "Other". Subspecies shades (only these two groups have
  subspecies): *longum* subsp. longum #0072B2 / infantis #003355 (navy) /
  unspecified #245478 / suis+suillum #39688d (shared); *animalis* subsp.
  lactis #E69F00 / unspecified #fdb533 / subsp. animalis #724d00.
  How they were chosen (re-run if colours change): the dataviz skill's
  `validate_palette.js` for the six base hues all-pairs (normal ΔE ≥ 15.3;
  worst colour-blind pair purple vs green 7.6 = "warn", OK only because
  identity is always also in labels/legend/table); shades found by a
  search over lightness of the group's hue, keeping only shades ≥ 15 ΔE
  normal and ≥ 6 ΔE colour-blind from every *other* group. Constraints
  that forced the design: lighter blues collide with *adolescentis* sky
  blue (so *longum* shades go darker); darker blues collided with the old
  charcoal "Other" (so Other became light grey — the darkest grey still
  ≥ 15 from sky blue); mid oranges collide with *pseudocatenulatum* under
  red-green colour blindness (so *animalis* gets dark brown + light amber).
  Some within-group pairs are only ~7 ΔE apart — subtle on purpose.
  **Don't add a 7th hue** (every candidate failed). Orange/purple/sky
  blue/grey are < 3:1 on white: never use them for text. Shared legend
  under the header lists groups and their shades (`initColorLegend()`).
  Timeline and Summary country bars stack by `COLOR_KEYS` (shades + plain
  groups), never by raw species_subsp. Tier and rep status are never
  encoded by colour.

### 1. Tree — overview (`tree.js`) + cluster detail panel (`clusterDetail.js`)

Redesigned 2026-10 after supervisor feedback (labels unreadable at default
zoom; expanding a big cluster "looked like a boom"). **Don't go back to
expanding clusters inline in the circle** — one 90-genome cluster took ~90%
of the circle and reflowed every other node.

- **Overview (`tree.js`):** fixed radial species → cluster tree that never
  expands. Species = coloured arc outside the cluster ring + label (genus
  abbreviated: "B. longum subsp. infantis"); clusters = dots (dashed if rep
  is Tier2). Labels sit in two columns (left/right of the circle), stacked
  ≥ `LABEL_GAP_PX` apart with leader lines to their arcs — placing them at
  the arc point let stacked labels slide back over the ring.
- **Constant screen size:** dot radii and labels are counter-scaled by the
  zoom factor (`applyScreenSizes()` runs on every zoom), strokes use
  `vector-effect: non-scaling-stroke`. Zooming spreads things out instead of
  inflating text; `fitToView()` reserves `LABEL_W_PX` per side for labels.
- Toolbar: + / − / Reset view. Clicking a cluster calls `selectCluster()`;
  the detail panel opens itself on that event. Selected cluster dot is
  filled + red ring.
- **Detail panel (`clusterDetail.js`, right of the overview, below it
  under 1100px):** a stack of **cards**, one per `comparedClusterIds()`
  entry. Each card: Pin/Pinned button, collapse (multi only), × (unpins;
  also clears the selection if that's what showed it). Panel's top × =
  `clearComparison()`. Shift-click on a tree cluster toggles its pin.
  Single card fills the panel as before; with 2+ the list scrolls and each
  dendrogram is capped at 230px. One shared mini map (numbered markers when
  multi) and mini timeline (one band per cluster) below the cards. Renders
  are coalesced per microtask from state (not event details). Card
  contents: header (species, rep + tier, lowest ANI, mixed labels);
  a left-to-right dendrogram of the cluster's real scipy tree — one row per
  genome (accession + strain, rep/tier styling, click = select genome),
  **square-root ANI axis** (merges cluster within ~0.1% of 100%; linear
  squashed them into a few px), ticks show true ANI; then mini map + mini
  timeline (replaced the old floating popup / `clusterPopup.js`).
- **Identical genomes collapse:** any zero-height subtree (no ANI distance)
  renders as one "▸ ×N identical genomes" row (triangle only — user found
  "show/hide" words too much). Clicking expands it in place: the row stays
  (now "▾", the same click target closes it) and
  its genomes are listed indented beneath on a tinted band. Each card's
  label row has **Expand all / Collapse all** (hidden if the cluster has no
  groups; disabled when a no-op). A genome selected elsewhere opens its
  group **once** (`card.autoAcc`) — earlier it re-opened on every redraw,
  so that group could never be collapsed. Scroll position is kept across
  redraws; only a new selection scrolls, and only if off-screen (re-centring
  on every redraw made toggling a group jump to the selected genome). The
  new-selection flag is only consumed while the tree is visible, so a genome
  picked in another tab still scrolls into view when Tree opens. Biggest cluster (3_1, 90
  genomes) → 31 rows collapsed, 14 groups.
- **Panel mirrors state:** re-renders (coalesced into one microtask) on
  `clusterSelected` / `genomeSelected` / `pinsChanged` / `filterChanged`;
  hides when nothing is pinned or selected. The coalescing matters because
  `selectGenome()`/`selectCluster()` fire "clear the other selection"
  immediately before the new one — rendering on each event would close and
  reopen the panel. Cards persist by cluster id (scroll + expanded groups
  survive), and are only moved in the DOM when out of order. Fires
  `clusterDetailToggled` (overview refits) and `clusterDetailClosed`.
- Genome tooltip fields: organism, strain, tier, ANI to rep, country/region,
  submission year, submitter, evidence (completeness/contamination/
  centrality deliberately omitted; still in Table).

### 2. Map (`map.js`) and the detail panel's mini-map (`clusterDetail.js`)
- **Basemap:** UN Geospatial Clear Map — chosen for an international-org
  source (neutral on disputed borders) and English-only labels. Tooltips
  say **"Country/Region"**, never "Country".
- **Must use `crs: UN_CRS`** (from `main.js`). The service is plate carrée
  (`wkid 104257`, origin (-180, 180), 1.40625/2^z °/px — one tile wide at
  z0), not Web Mercator; Leaflet's default CRS and even its built-in
  EPSG4326 (two tiles wide at z0) misplace markers, increasingly with
  latitude. `UN_CRS` = EPSG4326 with transformation `(1/360, 0.5, -1/360,
  0.5)`, pixel-verified against raw tiles. Swap it out if the basemap ever
  becomes Web Mercator.
- **Zoom:** `BASEMAP_MAX_ZOOM = 6` is the last zoom with real tiles → used as
  the tile layer's `maxNativeZoom`. `MAP_MAX_ZOOM = 11` is the map's own
  `maxZoom` (Leaflet upscales z6 tiles). Needed so markers jittered around a
  shared fallback point (211 genomes at Japan's centroid) separate enough to
  click (~2px at z6, ~40–50px at z11). Don't raise `BASEMAP_MAX_ZOOM`
  without fetching tiles directly: real tile = 256×256, "MAP NOT AVAILABLE"
  placeholder = 442×354.
- **Placeholder prevention:** the tile layer's `noWrap` + `bounds:
  [[-90,-180],[90,180]]` stops Leaflet requesting out-of-range buffer tiles
  (e.g. column -1 returns the placeholder). Free drag/zoom is enabled.
  **Do not add `maxBounds`/`maxBoundsViscosity` to the map** — it snapped the
  view back after programmatic `panTo`/`fitBounds` at low zoom.
- Markers: one per genome with `geo_precision !== "none"`; shared-coordinate
  groups spread by a **bounded** Vogel spiral (`jitterCoordinates`,
  `MAX_JITTER_DEGREES = 0.35`, no cos(lat) stretch). An earlier unbounded
  version pushed points into the ocean — keep it bounded.
- **Size/initial view:** `sizeMapToWindow()` makes the map as tall as the
  world is at full width (width/2, plate carrée), capped by the window
  (min 420px), and sets that full-width zoom as `minZoom` — no grey margins,
  no empty band under the map. Needs `zoomSnap: 0` (fractional zoom).
  Gotcha: `setMinZoom()` zooms with an animation that lands *after* an
  immediate `fitBounds` and undoes it, so we `setZoom(..., {animate:false})`
  first. **Wheel/pinch zoom is custom** (`enableSmoothWheelZoom()`,
  Leaflet's `scrollWheelZoom` off): with `zoomSnap: 0` Leaflet's own wheel
  zoom crawled (~0.2 levels per second of trackpad pinch, user-reported
  2026-10-02). Now zoom ∝ wheel delta per animation frame: pinch
  (ctrl+wheel) 1/(100·ln2) level/px (tracks fingers 1:1 in Chrome), wheel
  0.008 level/px. The thin lines at the equator and 0°/±90° are the basemap's own
  graticule, not tile seams.
- Filled = rep, faint = non-rep. Tooltip includes sub-country location (when
  resolved at that level) and coordinates with an honest precision label
  (`locationDetailRows()` in `main.js`).
- Cluster selection dims others and fits to the cluster; genome selection
  pans to it. **Automatic** fits (cluster/genome selection, mini-map) are
  capped at `CLUSTER_FIT_MAX_ZOOM = 4` (country with neighbours, real
  tiles) — fitting to `MAP_MAX_ZOOM` landed on a blurry, context-free view.
  `MAP_MAX_ZOOM` is only for zooming in by hand.

### 3. Timeline (`timeline.js`)
Stacked bars by submission year (observed range 2009–2026), colored by
species. Each highlighted cluster (`highlightedClusterIds()`) adds an
aligned strip of its years below the chart, numbered when comparing.

### 4. Table (`table.js`)
All rows, `scrollX`, NCBI links, REP/tier badges, column dropdown filters
(incl. "Country/Region"), search. Row click selects genome cross-panel.

### 5. Summary (`stats.js`)
- Respects the header filter, plus its own **multi-select species picker**
  (`#stats-species-dropdown`, state `selectedSpecies: Set`), intersected
  with the header filter in `activeGenomes()`.
- Content: stat tiles (genomes, clusters, species, countries, Tier1/Tier2/
  Tier2-unconfirmed); "Genomes by species/subspecies" bars; "Genomes by
  country/region" top-15 stacked bars (country ranking recomputed for the
  current selection; requires `geo_precision !== "none"`); year × country
  heatmap small multiples, each tinted in its species' own color, shared
  axes across tiles. (Small multiples chosen over a 3D chart deliberately.)
- Modes by `selectedSpecies.size`:
  - **0 (All):** heatmap = top 8 species + grey "all other" tile; titles
    carry "(top N …)" / "by species/subspecies".
  - **1:** species bar chart hidden; all "by species/subspecies" / "top N
    species" qualifiers dropped; single heatmap tile.
  - **2+ (compare):** charts show exactly the selection; heatmap capped at
    `MAX_HEATMAP_SPECIES = 8` (top by count, title says "top 8 of N
    selected"); no "all other" tile.

---

## Misc

- NCBI link: `https://www.ncbi.nlm.nih.gov/datasets/genome/{accession}/`
- Local preview: `python3 -m http.server --directory docs 8000` (serving is
  required; `file://` breaks data loading). Beware stale servers on other
  ports serving old files — this caused a false "nothing changed" report once.
- Data JSON is fetched with `cache: "no-cache"` (`loadData()` in
  `main.js`): before that, the browser kept showing old data after a
  regenerate (2026-10-05, second false "nothing changed"). JS/CSS can still
  be cached — after code changes, hard-refresh (Cmd+Shift+R).
