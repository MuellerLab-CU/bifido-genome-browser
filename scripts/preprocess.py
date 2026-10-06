#!/usr/bin/env python3
"""
preprocess.py — build docs/data/{genomes,clusters,tree}.json for the
Bifidobacterium genome browser from the raw dRep / metadata exports.

Inputs (data/raw/):
    genome_withcluster_metadata.tsv   773 rows, primary metadata + cluster assignments
    Ndb.csv                           dRep pairwise ANI matrix (773^2-ish rows)
    genomeInformation.csv             dRep per-genome CheckM2 stats + centrality

Outputs (docs/data/):
    genomes.json
    clusters.json
    tree.json

Run:
    python3 scripts/preprocess.py
(from a venv with pandas/numpy/scipy installed — see scripts/requirements.txt)

--------------------------------------------------------------------------
Notes on deviations from the nominal schema described in CLAUDE.md, found
while inspecting the actual raw files in this repo:

* The metadata TSV has a `cluster_id` column, but it is NOT the dRep
  cluster id — it holds values like "gcfgca:GCA_000003135.1" for a
  minority of rows and is otherwise empty. It is ignored entirely. The
  real `{primary}_{secondary}` dRep cluster id (e.g. "1_46") lives in the
  `cluster` column, which is populated for all 773 rows; this script
  drops the raw `cluster_id` column and renames `cluster` to `cluster_id`
  for the site.

* `cluster_role` ("canonical" / blank) does NOT mark the dRep cluster
  representative — the majority of rows (756/773) are "canonical", far
  more than the 323 actual cluster representatives. It is passed through
  as raw metadata but not used for any logic. `is_rep` is derived solely
  from `assembly_accession == rep_assembly_accession`.

* `drep_score` is taken from the metadata TSV's own `score` column
  (present there, not in genomeInformation.csv).
--------------------------------------------------------------------------
"""

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage, to_tree
from scipy.spatial.distance import squareform

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
OUT_DIR = REPO_ROOT / "docs" / "data"

METADATA_TSV = RAW_DIR / "genome_withcluster_metadata.tsv"
NDB_CSV = RAW_DIR / "Ndb.csv"
GENOME_INFO_CSV = RAW_DIR / "genomeInformation.csv"

MIN_ALIGNMENT_COVERAGE = 0.3
NCBI_URL_TEMPLATE = "https://www.ncbi.nlm.nih.gov/datasets/genome/{accession}/"

# ---------------------------------------------------------------------------
# Map geocoding gazetteer
#
# Only 1 of 773 genomes has an explicit geo_loc_latitude/longitude, so the
# map is almost entirely dependent on geocoding the free-text geo_loc_name
# field. The site has no build step and does no live geocoding calls, so
# resolution happens once here, at preprocess time, against a hand-curated
# lookup covering every distinct geo_loc_name string actually present in
# data/raw/genome_withcluster_metadata.tsv (a closed, fixed set — 115
# distinct non-junk values as of this dataset). Coordinates are approximate
# centroids (city/region/country scale), fine for a dot-on-a-world-map
# visualization, not survey-grade.
#
# Resolution order per genome (per user instruction):
#   1. geo_loc_latitude/longitude, if present       -> precision "coordinates"
#   2. geo_loc_name matched in GEO_NAME_COORDS below -> precision "geo_loc_name"
#   3. geo_loc_country matched in COUNTRY_COORDS     -> precision "geo_loc_country"
#   4. none of the above                             -> precision "none" (excluded from map)
#
# Bare-country geo_loc_name values (e.g. "Belgium") are deliberately not
# duplicated into GEO_NAME_COORDS — they fall through to COUNTRY_COORDS via
# geo_loc_country and resolve to the identical coordinate anyway. Junk
# placeholder values ("missing", "not determined", "not applicable", "not
# provided", "unknown", "missing: lab stock", blank) are simply absent from
# both dicts, so they resolve to "none" with no special-casing needed.
# ---------------------------------------------------------------------------

GEO_NAME_COORDS = {
    "Bulgaria: Sofia": (42.6977, 23.3219),
    "Chile:Santiago": (-33.4489, -70.6693),
    "China: Bama, Guangxi": (24.03, 107.23),
    "China: Beijing": (39.9042, 116.4074),
    "China: Guangxi": (23.8298, 108.7881),
    "China: Guangxi Zhuang Autonomous Region": (23.8298, 108.7881),
    "China: GuangXi": (23.8298, 108.7881),
    "China: guangxi province": (23.8298, 108.7881),
    "China: Harbin": (45.8038, 126.5350),
    "China: Hefei, Anhui": (31.8206, 117.2272),
    "China: Hongyuan, Sichuan": (32.7987, 102.5522),
    "China: Nanchang, Jiangxi": (28.6820, 115.8579),
    "China: Neimenggu": (40.8414, 111.7519),
    "China: Qingdao": (36.0671, 120.3826),
    "China: Qinghai": (36.6171, 101.7782),
    "China: Shanghai": (31.2304, 121.4737),
    "China: Shenzhen": (22.5431, 114.0579),
    "China: Sichuan": (30.6171, 102.7103),
    "China: village Bama, guangxi": (24.03, 107.23),
    "China: Wuhan": (30.5928, 114.3055),
    "China: Xinjiang": (43.8256, 87.6168),
    "China:Bama": (24.03, 107.23),
    "China:Bama-Guangxi": (24.03, 107.23),
    "China:Bama, Guangxi": (24.03, 107.23),
    "China:Guangxi Bama": (24.03, 107.23),
    "China:Hangzhou": (30.2741, 120.1551),
    "China:Harbin": (45.8038, 126.5350),
    "China:Inner Mongolia": (40.8414, 111.7519),
    "China:Shenzhen": (22.5431, 114.0579),
    "China:Tibet": (29.6520, 91.1721),
    "China:Xuzhou, Jiangsu": (34.2044, 117.2857),
    "China:Zhejiang": (29.1832, 120.0934),
    "China:Zhejiang province": (29.1832, 120.0934),
    "Finland: Tampere": (61.4978, 23.7610),
    "Germany: Ulm": (48.4011, 9.9876),
    "India: Maharashtra": (19.7515, 75.7139),
    "India: Unique Biotech Limited, Hyderabad": (17.3850, 78.4867),
    "India:Chandigarh": (30.7333, 76.7794),
    "India:Hyderabad": (17.3850, 78.4867),
    "Italy: Parma": (44.8015, 10.3279),
    "Italy: Verona, San Giovanni Lupatoto": (45.4384, 10.9916),
    "Italy:Verona": (45.4384, 10.9916),
    "Japan: Tsuruoka, Yamagata": (38.7278, 139.8272),
    "Japan:Kanagawa": (35.4478, 139.6425),
    "Kenya: Msambweni County": (-4.4667, 39.4833),
    "Russia: Central region": (55.7558, 37.6173),
    "Russia: Moscow": (55.7558, 37.6173),
    "Russia: Orenburg": (51.7727, 55.0988),
    "Russia: South Ural": (55.1644, 61.4368),
    "Russia:Tver": (56.8587, 35.9176),
    "South Africa: Irene": (-25.9167, 28.2167),
    "South Korea: Anseong City": (37.0078, 127.2797),
    "South Korea: Asan": (36.7898, 127.0018),
    "South Korea: Bundang": (37.3826, 127.1189),
    "South Korea: Daegu": (35.8714, 128.6014),
    "South Korea: Gwangju": (35.1595, 126.8526),
    "South Korea: Gyeonggi": (37.4138, 127.5183),
    "South Korea: Gyeonggido, Giheung": (37.2761, 127.1131),
    "South Korea: Hwaseong": (37.1996, 126.8310),
    "South Korea: Jeongup": (35.5699, 126.8555),
    "South Korea: Paju, Gyeonggi-do": (37.8154, 126.7936),
    "South Korea: Seoul": (37.5665, 126.9780),
    "South Korea: Yongin-si": (37.2411, 127.1776),
    "Spain: Asturias": (43.3619, -5.8494),
    "Spain: Valencia": (39.4699, -0.3763),
    "Spain:Valencia": (39.4699, -0.3763),
    "Taiwan:Taipei": (25.0330, 121.5654),
    "Thailand: Bangkok": (13.7563, 100.5018),
    "Thailand: Khon Kean": (16.4419, 102.8360),
    "Thailand:Bangkok": (13.7563, 100.5018),
    "Thailand:Nakhonratchasima": (14.9799, 102.0977),
    "Turkey: Izmir, Bornova": (38.4622, 27.2166),
    "Turkey:Sakarya-Adapazari": (40.7569, 30.4030),
    "United Kingdom: England": (52.3555, -1.1743),
    "United Kingdom: Norwich": (52.6309, 1.2974),
    "USA: CA": (36.7783, -119.4179),
    "USA: Hadley, MA": (42.3556, -72.5934),
    "USA: Lincoln, NE": (40.8136, -96.7026),
    "USA: Madison, WI": (43.0731, -89.4012),
    "USA: Madison, Wisconsin": (43.0731, -89.4012),
    "USA: San Francisco, CA": (37.7749, -122.4194),
    "USA:MD": (39.0458, -76.6413),
}

COUNTRY_COORDS = {
    "belgium": (50.5039, 4.4699),
    "brazil": (-14.2350, -51.9253),
    "cameroon": (7.3697, 12.3547),
    "chile": (-35.6751, -71.5430),
    "china": (35.8617, 104.1954),
    "belarus": (53.7098, 27.9534),
    "czech republic": (49.8175, 15.4730),
    "denmark": (56.2639, 9.5018),
    "finland": (61.9241, 25.7482),
    "france": (46.2276, 2.2137),
    "germany": (51.1657, 10.4515),
    "india": (20.5937, 78.9629),
    "indonesia": (-0.7893, 113.9213),
    "ireland": (53.4129, -8.2439),
    "israel": (31.0461, 34.8516),
    "italy": (41.8719, 12.5674),
    "japan": (36.2048, 138.2529),
    "kenya": (-0.0236, 37.9062),
    "korea": (35.9078, 127.7669),
    "mexico": (23.6345, -102.5528),
    "netherlands": (52.1326, 5.2913),
    "papua new guinea": (-6.3149, 143.9555),
    "russia": (61.5240, 105.3188),
    "singapore": (1.3521, 103.8198),
    "south africa": (-30.5595, 22.9375),
    "south korea": (35.9078, 127.7669),
    "spain": (40.4637, -3.7492),
    "sweden": (60.1282, 18.6435),
    "switzerland": (46.8182, 8.2275),
    "taiwan": (23.6978, 120.9605),
    "thailand": (15.8700, 100.9925),
    "turkey": (38.9637, 35.2433),
    "united kingdom": (55.3781, -3.4360),
    "usa": (37.0902, -95.7129),
    "zimbabwe": (-19.0154, 29.1549),
}


# Last-resort tier 4 (user request, 2026-10): when a genome has no usable
# location at all, use the country of the SUBMITTING institution. This is
# the lab's country, not necessarily where the strain was isolated (e.g.
# JGI / WashU GSC / Broad sequenced strains from collections worldwide), so
# these get geo_precision "submitter" and the site labels them as inferred.
# Only institutions whose country is unambiguous are listed; multinational
# companies (DuPont), consortia (metaHIT, Lactic Acid Bacteria Genome
# Consortium) and unclear names (SC, MET-4, Purity-IQ Inc.) are left out on
# purpose. Keys are exact `submitter` strings; values must exist in
# COUNTRY_COORDS (case-insensitive) and match the data's country spelling.
SUBMITTER_COUNTRY = {
    "Yakult Central Institute": "Japan",
    "Graduate School of Frontier Sciences, University of Tokyo": "Japan",
    "University of Tokyo, Graduate School of Frontier Sciences": "Japan",
    "Gifu University": "Japan",
    "Gifu University, Life Science Research Center, Japan": "Japan",
    "Graduate School of Biostudies, Kyoto University": "Japan",
    "Kagoshima university": "Japan",
    "RIKEN-BRC": "Japan",
    "Fudan University": "China",
    "Inner Mongolia Agricultural University": "China",
    "Key Laboratory of Dairy BiotecInner Mongolia Agricultural University": "China",
    "The Key Laboratory of Dairy Biotechnology and Bioengineering, Education Ministry of P. R. China, Department of Food Science and Engineering, Inner Mongolia Agricultural University, China": "China",
    "Key Lab of Functional Dairy Science of Chinese Ministry of Education, College of Food Science and Nutritional Engineering, China Agricultural University": "China",
    "Department of Medical Microbiology and Parasitology,Shanghai Jiao Tong University School of Medicine": "China",
    "Northeast Agricultural University": "China",
    "Korea University": "South Korea",
    "Korea Research Institute of Bioscience and Biotechnology (KRIBB)": "South Korea",
    "National Livestock Research Institute, RDA": "South Korea",
    "Washington University Genome Sequencing Center": "USA",
    "Washington University School of Medicine Center for Genome Sciences and Systems Biology": "USA",
    "The Edison Family Center for Genome Sciences and Systems Biology": "USA",
    "Baylor College of Medicine": "USA",
    "Broad Institute": "USA",
    "Danisco USA Inc.": "USA",
    "US DOE Joint Genome Institute": "USA",
    "DOE Joint Genome Institute": "USA",
    "DOE - JOINT GENOME INSTITUTE": "USA",
    "J. Craig Venter Institute": "USA",
    "JCVI": "USA",
    "Penn State": "USA",
    "Penn State University, Department of Food Science": "USA",
    "Utah State University": "USA",
    "Kaleido Biosciences": "USA",
    "University of Parma": "Italy",
    "University of Parma Sacco srl": "Italy",
    "Laboratory of Probiogenomics, Department of genetics, university of Parma, Italy": "Italy",
    "Probiotical Spa": "Italy",
    "University College Cork": "Ireland",
    "Bioprox": "France",
    "Chr. Hansen A/S": "Denmark",
    "Nestle Research Center, Switzerland": "Switzerland",
    "ETH Zurich": "Switzerland",
    "University of Ulm": "Germany",
    "Institute of Microbiology and Biotechnology, University of Ulm": "Germany",
    "IPLA-CSIC": "Spain",
    "ERA7": "Spain",
    "Ordesa": "Spain",
    "Institute of Microbiology, Belarus National Academy of Sciences": "Belarus",
}


def apply_submitter_country(df: pd.DataFrame) -> pd.DataFrame:
    """Tier 4 geocoding — see SUBMITTER_COUNTRY."""
    for idx, row in df[df["geo_precision"] == "none"].iterrows():
        country = SUBMITTER_COUNTRY.get(str(row["submitter"]).strip()) if pd.notna(row["submitter"]) else None
        if not country:
            continue
        lat, lon = COUNTRY_COORDS[country.lower()]
        df.at[idx, "geo_loc_country"] = country
        df.at[idx, "map_latitude"] = lat
        df.at[idx, "map_longitude"] = lon
        df.at[idx, "geo_precision"] = "submitter"
    return df


def resolve_location(row) -> tuple:
    """3-tier fallback: exact coords -> geo_loc_name -> geo_loc_country."""
    lat, lon = row["geo_loc_latitude"], row["geo_loc_longitude"]
    if pd.notna(lat) and pd.notna(lon):
        return float(lat), float(lon), "coordinates"

    raw_name = row["geo_loc_name"]
    if pd.notna(raw_name):
        coords = GEO_NAME_COORDS.get(str(raw_name).strip())
        if coords:
            return coords[0], coords[1], "geo_loc_name"

    country = row["geo_loc_country"]
    if pd.notna(country):
        coords = COUNTRY_COORDS.get(str(country).strip().lower())
        if coords:
            return coords[0], coords[1], "geo_loc_country"

    return None, None, "none"


def clean(value):
    """Convert pandas/numpy scalars to plain JSON-safe Python values."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (np.floating,)):
        return None if math.isnan(value) else float(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if pd.isna(value):
        return None
    return value


def clean_record(record: dict) -> dict:
    return {k: clean(v) for k, v in record.items()}


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------

def load_metadata() -> pd.DataFrame:
    df = pd.read_csv(METADATA_TSV, sep="\t", dtype={"assembly_accession": str})

    # The raw `cluster_id` column is not the dRep cluster id (see module
    # docstring) — drop it and use `cluster` as the sole cluster id,
    # renamed to `cluster_id` for the site.
    df = df.drop(columns=["cluster_id"]).rename(columns={"cluster": "cluster_id"})

    # `tier_checkm2` is the authoritative tier (per the user, 2026-10). Copy
    # it over `tier` so every downstream consumer (JSON, site) is unchanged;
    # the old value is kept as `tier_original` for reference. Refuse to run
    # on anything other than Tier1/Tier2 — this column has carried stray
    # numeric values (genome lengths) before, and a wrong tier badge on a
    # published site is worse than a failed build.
    bad = df[~df["tier_checkm2"].isin(["Tier1", "Tier2"])]
    if not bad.empty:
        listing = "\n".join(
            f"  {r.assembly_accession}: {r.tier_checkm2!r}" for r in bad.itertuples()
        )
        raise SystemExit(
            f"tier_checkm2 has {len(bad)} non-tier value(s); fix the metadata TSV:\n{listing}"
        )
    df = df.rename(columns={"tier": "tier_original"})
    df["tier"] = df["tier_checkm2"]

    # Year of submission, parsed from an ISO-8601-with-milliseconds string.
    dates = pd.to_datetime(df["biosample_submission_date"], errors="coerce")
    df["submission_year"] = dates.dt.year

    # `strain` is blank for a handful of rows that do have a submitter-
    # provided name in `user_strain_name` instead (observed: 2 of 773 rows,
    # and in every row where both columns are populated they never
    # disagree) — fall back to it rather than showing a blank strain label.
    blank_strain = df["strain"].isna() | (df["strain"].astype(str).str.strip() == "")
    df.loc[blank_strain, "strain"] = df.loc[blank_strain, "user_strain_name"]

    # Normalize geo_loc_name -> country (first token before ':').
    def to_country(raw):
        if pd.isna(raw) or str(raw).strip() == "":
            return None
        return str(raw).split(":")[0].strip()

    df["geo_loc_country"] = df["geo_loc_name"].apply(to_country)

    # Resolved map coordinates: coordinates -> geo_loc_name -> geo_loc_country.
    resolved = df.apply(resolve_location, axis=1, result_type="expand")
    resolved.columns = ["map_latitude", "map_longitude", "geo_precision"]
    df = pd.concat([df, resolved], axis=1)
    df = apply_submitter_country(df)

    df["is_type_material"] = df["type_material"].notna() & (
        df["type_material"].astype(str).str.strip() != ""
    )

    # Authoritative rep flag: accession IS the cluster's rep accession.
    df["is_rep"] = df["assembly_accession"] == df["rep_assembly_accession"]

    df["ncbi_url"] = df["assembly_accession"].apply(
        lambda acc: NCBI_URL_TEMPLATE.format(accession=acc)
    )

    return df


def load_genome_info() -> pd.DataFrame:
    df = pd.read_csv(GENOME_INFO_CSV)
    df["assembly_accession"] = df["genome"].str.replace(".fna", "", regex=False)
    df = df.rename(columns={"N50": "n50"})
    return df[["assembly_accession", "completeness", "contamination", "length", "n50", "centrality"]]


def load_ndb() -> pd.DataFrame:
    df = pd.read_csv(NDB_CSV)
    df["querry"] = df["querry"].str.replace(".fna", "", regex=False)
    df["reference"] = df["reference"].str.replace(".fna", "", regex=False)
    return df


# ---------------------------------------------------------------------------
# Merge quality stats
# ---------------------------------------------------------------------------

def merge_quality_stats(meta: pd.DataFrame, genome_info: pd.DataFrame) -> pd.DataFrame:
    merged = meta.merge(genome_info, on="assembly_accession", how="left", validate="one_to_one")

    # genomeInfo.csv (CheckM2) values take priority; fall back to the TSV's
    # checkm_* / assembly columns where genomeInfo is missing a value.
    merged["completeness"] = merged["completeness"].fillna(merged["checkm_completeness"])
    merged["contamination"] = merged["contamination"].fillna(merged["checkm_contamination"])
    merged["length"] = merged["length"].fillna(merged["total_length"])
    merged["n50"] = merged["n50"].fillna(merged["contig_n50"])

    merged["drep_score"] = merged["score"]

    return merged


# ---------------------------------------------------------------------------
# ANI helpers
# ---------------------------------------------------------------------------

def build_ani_lookup(ndb: pd.DataFrame) -> dict:
    """(accession_a, accession_b) -sorted tuple-> mean ANI, coverage-filtered.

    Ndb.csv is directionally reported (querry->reference and reference->
    querry rows can have slightly different alignment_coverage); average
    the ANI of whichever direction(s) clear the coverage threshold.
    """
    filtered = ndb[ndb["alignment_coverage"] >= MIN_ALIGNMENT_COVERAGE]
    pairs: dict[tuple[str, str], list[float]] = {}
    for a, b, ani in zip(filtered["querry"], filtered["reference"], filtered["ani"]):
        key = (a, b) if a <= b else (b, a)
        pairs.setdefault(key, []).append(float(ani))
    return {k: sum(v) / len(v) for k, v in pairs.items()}


def ani_between(lookup: dict, acc_a: str, acc_b: str):
    if acc_a == acc_b:
        return 1.0
    key = (acc_a, acc_b) if acc_a <= acc_b else (acc_b, acc_a)
    return lookup.get(key)


# ---------------------------------------------------------------------------
# Build outputs
# ---------------------------------------------------------------------------

def build_genomes(df: pd.DataFrame) -> list:
    records = df.to_dict(orient="records")
    return [clean_record(r) for r in records]


def get_rep_accession(cluster_group: pd.DataFrame):
    rep_row = cluster_group[cluster_group["is_rep"]]
    if not rep_row.empty:
        return rep_row["assembly_accession"].iloc[0]
    return cluster_group["rep_assembly_accession"].iloc[0]


def species_breakdown(cluster_group: pd.DataFrame) -> list:
    counts = cluster_group["species_subsp"].value_counts()
    return [{"species_subsp": clean(k), "count": int(v)} for k, v in counts.items()]


def build_clusters(df: pd.DataFrame) -> list:
    """One row per dRep cluster_id.

    species_subsp is NOT always uniform within a cluster: 33/323 clusters
    (~10%) mix an "unspecified" label with a resolved subspecies among
    members (dRep clusters by ANI; subspecies calls aren't always fully
    resolved for every member) — see species_subsp_breakdown for the full
    per-member split. The single `species_subsp` field here is anchored to
    the cluster's own representative genome, matching how rep_tier/rep_score
    already define cluster identity everywhere else on the site. This means
    one real subspecies (Bifidobacterium animalis subsp. lactis, ~90
    genomes) is never itself a cluster's rep, so it never appears as this
    field's value — its genomes are still fully present (nothing is
    dropped), just filed under the sibling label their cluster's rep
    happens to carry; species_subsp_breakdown is how a client discovers that.
    """
    clusters = []
    for cluster_id, group in df.groupby("cluster_id"):
        rep_accession = get_rep_accession(group)
        rep_row = group.set_index("assembly_accession").loc[rep_accession]
        # Read from the rep genome's own `tier` (= its tier_checkm2, see
        # load_metadata) rather than the rep_tier_checkm2 column, so the rep
        # tier can never disagree with the tier shown on the rep itself.
        rep_tier = rep_row["tier"]
        clusters.append(
            {
                "cluster_id": cluster_id,
                "rep_accession": clean(rep_accession),
                "rep_tier": clean(rep_tier),
                "species_subsp": clean(rep_row["species_subsp"]),
                "species_subsp_breakdown": species_breakdown(group),
                "member_count": int(len(group)),
                "members": group["assembly_accession"].tolist(),
            }
        )
    clusters.sort(key=lambda c: c["cluster_id"])
    return clusters


def build_cluster_dendrogram(cluster_group: pd.DataFrame, ani_lookup: dict):
    """Real scipy hierarchical clustering (average linkage on 1-ANI distance)
    per cluster, so the tree's branch structure/heights inside a cluster are
    actual genetic distances rather than a uniform fan of leaves.

    Returns (nested_node_dict, root_height). A single-member cluster has no
    internal distance to show, so it returns the bare leaf with height 0.
    """
    accessions = cluster_group["assembly_accession"].tolist()
    rep_accession = get_rep_accession(cluster_group)
    rows = cluster_group.set_index("assembly_accession")

    def leaf_dict(acc):
        row = rows.loc[acc]
        return {
            "name": acc,
            "is_rep": bool(row["is_rep"]),
            "tier": clean(row["tier"]),
            "height": 0.0,
            "ani_to_rep": clean(ani_between(ani_lookup, acc, rep_accession)),
            "strain": clean(row["strain"]),
            "organism_name": clean(row["organism_name"]),
            "submission_year": clean(row["submission_year"]),
            "geo_loc_country": clean(row["geo_loc_country"]),
            "submitter": clean(row["submitter"]),
            "evidence_sources": clean(row["evidence_sources"]),
        }

    n = len(accessions)
    if n == 1:
        return leaf_dict(accessions[0]), 0.0

    dist = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            ani = ani_between(ani_lookup, accessions[i], accessions[j])
            d = 1.0 - ani if ani is not None else 1.0
            dist[i, j] = dist[j, i] = d

    condensed = squareform(dist, checks=False)
    z = linkage(condensed, method="average")
    scipy_root = to_tree(z)

    def convert(node):
        if node.is_leaf():
            return leaf_dict(accessions[node.id])
        return {
            "height": float(node.dist),
            "children": [convert(node.left), convert(node.right)],
        }

    return convert(scipy_root), float(scipy_root.dist)


def build_tree(df: pd.DataFrame, ani_lookup: dict) -> dict:
    """Single pass over clusters (never species-then-cluster) so a cluster
    is placed exactly once, under its rep's species_subsp — see
    build_clusters' docstring for why species_subsp isn't always uniform
    within a cluster. Grouping species-first and then filtering to cluster
    members within each species group (the original approach) silently
    fragmented/duplicated the ~10% of clusters that mix labels, since a
    "cluster_group" filtered to one species_subsp is a subset of the real
    cluster membership, not the whole thing.
    """
    global_max_height = 0.0
    species_buckets: dict[str, list] = {}

    for cluster_id, cluster_group in df.groupby("cluster_id"):
        dendro, height = build_cluster_dendrogram(cluster_group, ani_lookup)
        global_max_height = max(global_max_height, height)

        rep_accession = get_rep_accession(cluster_group)
        rep_row = cluster_group.set_index("assembly_accession").loc[rep_accession]
        home_species = rep_row["species_subsp"]
        breakdown = species_breakdown(cluster_group)

        cluster_node = {
            "name": cluster_id,
            "rep": rep_accession,
            "rep_tier": clean(rep_row["tier"]),  # see build_clusters
            "member_count": int(len(cluster_group)),
            "max_height": height,
            "species_subsp_breakdown": breakdown if len(breakdown) > 1 else None,
            "children": [dendro],
        }
        species_buckets.setdefault(home_species, []).append(cluster_node)

    root = {"name": "root", "children": []}
    for species_subsp, cluster_nodes in species_buckets.items():
        cluster_nodes.sort(key=lambda c: c["name"])
        root["children"].append({"name": species_subsp, "children": cluster_nodes})

    root["children"].sort(key=lambda c: c["name"])
    # Shared across every cluster so radial distance is comparable
    # cluster-to-cluster: a tight cluster's leaves genuinely sit close to its
    # anchor, a diverse cluster's leaves genuinely fan out further.
    root["max_merge_height"] = global_max_height
    return root


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"Loading metadata from {METADATA_TSV} ...")
    meta = load_metadata()
    print(f"  {len(meta)} genome rows")

    print(f"Loading genome quality info from {GENOME_INFO_CSV} ...")
    genome_info = load_genome_info()

    print(f"Loading pairwise ANI from {NDB_CSV} ...")
    ndb = load_ndb()
    print(f"  {len(ndb)} pairwise rows")

    df = merge_quality_stats(meta, genome_info)

    print("Building ANI lookup (coverage >= "
          f"{MIN_ALIGNMENT_COVERAGE}) ...")
    ani_lookup = build_ani_lookup(ndb)
    print(f"  {len(ani_lookup)} unique pairs retained")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Building genomes.json ...")
    genomes = build_genomes(df)
    with open(OUT_DIR / "genomes.json", "w") as f:
        json.dump(genomes, f, indent=2)
    print(f"  wrote {len(genomes)} records -> {OUT_DIR / 'genomes.json'}")

    print("Building clusters.json ...")
    clusters = build_clusters(df)
    with open(OUT_DIR / "clusters.json", "w") as f:
        json.dump(clusters, f, indent=2)
    print(f"  wrote {len(clusters)} clusters -> {OUT_DIR / 'clusters.json'}")

    print("Building tree.json ...")
    tree = build_tree(df, ani_lookup)
    with open(OUT_DIR / "tree.json", "w") as f:
        json.dump(tree, f, indent=2)

    def count_leaves(node):
        if "children" not in node:
            return 1
        return sum(count_leaves(c) for c in node["children"])

    n_species = len(tree["children"])
    n_clusters = sum(len(sp["children"]) for sp in tree["children"])
    n_leaves = sum(count_leaves(cl) for sp in tree["children"] for cl in sp["children"])
    print(
        f"  wrote {n_species} species/subsp groups, {n_clusters} clusters, "
        f"{n_leaves} leaves, max_merge_height={tree['max_merge_height']:.4f} -> {OUT_DIR / 'tree.json'}"
    )

    print("Done.")


if __name__ == "__main__":
    main()
