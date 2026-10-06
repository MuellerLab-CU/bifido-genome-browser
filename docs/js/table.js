// DataTables genome browser: all rows, NCBI-linked accession, rep
// badge, tier badge, global search + per-column dropdown filters, sortable.
// Row click selects the genome across all panels; selecting a genome from
// another panel jumps to (and highlights) its row here.
import { state, selectGenome, countryLabel } from "./main.js";

let table = null;
let originatedHere = false;

const FILTER_COLUMNS = [
  { index: 4, label: "Species" }, // species_subsp
  { index: 3, label: "Tier" },
  { index: 11, label: "Assembly level" },
  { index: 13, label: "Country/Region" },
];

export function renderTable() {
  const rows = state.genomes;

  table = $("#genome-table").DataTable({
    data: rows,
    pageLength: 25,
    order: [[0, "asc"]],
    scrollX: true,
    columns: [
      {
        title: "Accession",
        data: "assembly_accession",
        render: (data, type, row) => {
          if (type !== "display") return data;
          const badge = row.is_rep ? ' <span class="badge badge--rep">REP</span>' : "";
          return `<a href="${escapeAttr(row.ncbi_url)}" target="_blank" rel="noopener">${escapeHtml(data)}</a>${badge}`;
        },
      },
      { title: "Organism", data: "organism_name", render: renderText },
      { title: "Strain", data: "strain", render: renderText },
      {
        title: "Tier",
        data: "tier",
        render: (data, type) => {
          if (type !== "display") return data || "";
          if (!data) return "";
          const cls = data === "Tier1" ? "badge--tier1" : data === "Tier2" ? "badge--tier2" : "badge--tier2-unconfirmed";
          return `<span class="badge ${cls}">${escapeHtml(data)}</span>`;
        },
      },
      { title: "Species", data: "species_subsp", render: renderText },
      { title: "Cluster", data: "cluster_id", render: renderText },
      { title: "Rep accession", data: "rep_assembly_accession", render: renderText },
      { title: "Completeness", data: "completeness", render: renderPct },
      { title: "Contamination", data: "contamination", render: renderPct },
      { title: "N50", data: "n50", render: renderInt },
      { title: "Centrality", data: "centrality", render: renderNum },
      { title: "Assembly level", data: "assembly_level", render: renderText },
      { title: "Submitter", data: "submitter", render: renderText },
      {
        title: "Country/Region",
        data: "geo_loc_country",
        // Sort/filter on the plain country; display marks submitter-inferred ones.
        render: (data, type, row) => (type === "display" ? escapeHtml(countryLabel(row)) : row.geo_precision === "none" ? "" : data || ""),
      },
      { title: "Year", data: "submission_year", render: renderInt },
      { title: "Evidence", data: "evidence_sources", render: renderText },
    ],
    dom: '<"top"f>rt<"bottom"lip>',
  });

  buildColumnFilters();

  $("#genome-table tbody").on("click", "tr", function () {
    const data = table.row(this).data();
    if (!data) return;
    originatedHere = true;
    selectGenome(data.assembly_accession);
    originatedHere = false;
  });

  document.addEventListener("genomeSelected", (e) => onGenomeSelected(e.detail.accession));

  // Same hidden-container issue as map/timeline: DataTables' scrollX layout
  // is computed while this panel is still display:none on first load.
  document.addEventListener("panelActivated", (e) => {
    if (e.detail.panel === "panel-table") table.columns.adjust();
  });
}

function renderText(data, type) {
  if (type !== "display") return data || "";
  return data ? escapeHtml(data) : "";
}
function renderPct(data, type) {
  if (type !== "display") return data;
  return data == null ? "" : `${Number(data).toFixed(2)}%`;
}
function renderNum(data, type) {
  if (type !== "display") return data;
  return data == null ? "" : Number(data).toFixed(4);
}
function renderInt(data, type) {
  if (type !== "display") return data;
  return data == null ? "" : Number(data).toLocaleString();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}

function buildColumnFilters() {
  const filterRow = document.getElementById("table-filters");
  filterRow.replaceChildren();

  FILTER_COLUMNS.forEach(({ index, label }) => {
    const column = table.column(index);
    const values = Array.from(new Set(column.data().toArray().filter((v) => v))).sort();

    const wrap = document.createElement("label");
    wrap.className = "table-filter";

    const span = document.createElement("span");
    span.textContent = label;

    const select = document.createElement("select");
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All";
    select.appendChild(allOption);

    values.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });

    select.addEventListener("change", () => {
      const val = select.value;
      column.search(val ? `^${escapeRegex(val)}$` : "", true, false).draw();
    });

    wrap.append(span, select);
    filterRow.appendChild(wrap);
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function onGenomeSelected(accession) {
  $("#genome-table tbody tr").removeClass("selected-row");
  if (!accession) return;

  const indexes = table.rows((idx, data) => data.assembly_accession === accession).indexes();
  if (indexes.length === 0) return;
  const rowIdx = indexes[0];

  if (!originatedHere) {
    const visiblePosition = table.rows({ search: "applied", order: "applied" }).indexes().indexOf(rowIdx);
    if (visiblePosition === -1) {
      // Row is filtered out by a column filter; nothing sensible to jump to.
      return;
    }
    const pageLen = table.page.len();
    table.page(Math.floor(visiblePosition / pageLen)).draw(false);
  }

  const node = table.row(rowIdx).node();
  if (node) {
    $(node).addClass("selected-row");
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
