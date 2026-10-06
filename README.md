# Bifidobacterium Genome Browser

A public-facing static website visualizing 773 curated commercial
*Bifidobacterium* probiotic genomes — their dereplication clusters, quality
metrics, geographic origins, and submission timeline. Built for publication
alongside a peer-reviewed manuscript (Matt Olm lab, University of Colorado).

Pure HTML/CSS/JS (D3.js, Leaflet.js, DataTables.js), served from `docs/` via
GitHub Pages. Python is used only for one-time preprocessing of the raw data
into the JSON the site consumes.

## Repository layout

```
bifido_genome_browser/
├── data/raw/
│   ├── genome_withcluster_metadata.tsv   # primary metadata + cluster assignments
│   ├── Ndb.csv                           # dRep pairwise ANI matrix
│   └── genomeInformation.csv             # dRep per-genome stats (CheckM2, N50, length, centrality)
├── scripts/
│   ├── preprocess.py       # generates docs/data/*.json from data/raw/
│   └── requirements.txt    # pandas / numpy / scipy
├── docs/                   # GitHub Pages root
│   ├── index.html
│   ├── css/
│   ├── js/
│   └── data/               # generated: genomes.json, clusters.json, tree.json
└── CLAUDE.md               # detailed data/schema/design notes for this repo
```

## Regenerating the JSON data

The preprocessing script needs pandas/numpy/scipy, which aren't part of the
system Python on macOS (Homebrew blocks global `pip install`). Use a local
virtualenv:

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

Then, whenever a file under `data/raw/` changes, regenerate the site data:

```bash
.venv/bin/python scripts/preprocess.py
```

This reads the three raw files and writes `docs/data/genomes.json`,
`docs/data/clusters.json`, and `docs/data/tree.json`.

## Viewing the site locally

```bash
python3 -m http.server --directory docs 8000
```

Then open `http://localhost:8000`.

## Data notes

See `CLAUDE.md` for the full data dictionary and design spec. A few
corrections to the raw files worth knowing if you touch `preprocess.py`:

- The metadata TSV's `cluster_id` column is **not** the dRep cluster id
  (it's mostly empty / holds unrelated values). The real cluster id
  (`{primary}_{secondary}`, e.g. `1_46`) is in the `cluster` column —
  `preprocess.py` drops the raw `cluster_id` and renames `cluster` to
  `cluster_id`.
- `cluster_role` (`canonical`/blank) does **not** mark the dRep cluster
  representative — it's unrelated to dRep. Representative status
  (`is_rep`) is derived from `assembly_accession == rep_assembly_accession`.
- `genomeInformation.csv` provides `completeness`, `contamination`,
  `length`, `N50`, and `centrality` per genome (CheckM2 + dRep) and should
  be preferred over the TSV's `checkm_*` columns, which have gaps for
  Tier2-unconfirmed genomes.
