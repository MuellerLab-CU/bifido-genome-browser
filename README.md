# *Bifidobacterium* Probiotics Genome Browser

An interactive website for exploring 809 curated genomes of commercial
*Bifidobacterium* probiotic strains: how they cluster by genome similarity,
where they were isolated, when they were submitted, and their assembly
quality.

**Website:** _link coming soon_

A collaboration between the **Mueller Lab** (University of Colorado Anschutz
Medical Campus) and the **Olm Lab** (University of Colorado Boulder).

## What's in the browser

| Tab | Shows |
|---|---|
| **Tree** | All 352 genome clusters arranged by species/subspecies. Click a cluster to see its genomes on an average-nucleotide-identity (ANI) tree, with a map and timeline of its members. Pin up to four clusters to compare them side by side. |
| **Map** | Where each genome was isolated (or, where no location was reported, the country of the submitting institution, marked as inferred). |
| **Timeline** | Genomes submitted per year, 2009–2026, by species. |
| **Table** | Every genome with its metadata, quality statistics and a link to NCBI; searchable and filterable. |
| **Summary** | Counts by species, country/region and year, for all genomes or a chosen set of species. |

Selecting a genome or cluster in any tab highlights it in all the others.

## Data

- **Genomes and metadata:** 809 *Bifidobacterium* genome assemblies from
  NCBI (27 species, 37 species/subspecies labels), with BioSample metadata
  (strain, submitter, location, submission date). Each genome is linked to
  a commercial probiotic through the submitter, the isolation source, the
  literature and/or an FDA GRAS notice.
- **Assembly quality:** genomes are grouped into two tiers (260 Tier1,
  549 Tier2) using assembly statistics and CheckM2 completeness and
  contamination estimates.
- **Clusters:** genomes were dereplicated with
  [dRep](https://github.com/MrOlm/drep) into 352 clusters; each cluster has
  one representative genome. Trees within clusters are average-linkage
  trees built from dRep's pairwise ANI values.
- **Locations:** reported locations were converted to map coordinates by
  hand. Most are country- or region-level, so map positions are approximate;
  the browser always states how precise each position is.

## Repository contents

```
docs/      the website (served by GitHub Pages)
scripts/   preprocess.py — builds the website's data files from data/raw/
data/raw/  input data: genome metadata, dRep genome statistics, pairwise ANI
```

## Citation

Manuscript in preparation. Please check back for the citation.

## Acknowledgements

Basemap: [United Nations Geospatial](https://geoportal.un.org/arcgis/home/item.html?id=541557fd0d4d42efb24449be614e6887).
Built with [D3](https://d3js.org), [Leaflet](https://leafletjs.com) and
[DataTables](https://datatables.net).

The website and its data-processing code were developed with the assistance
of Claude (Anthropic), an AI model, used through Claude Code. The authors
directed the work and reviewed the results.
