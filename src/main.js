// src/main.js
import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

const MANUAL_BUNDLES = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).href,
    },
    eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).href,
    },
};

const chartContainer = d3.select("#chart");
const containerWidth = chartContainer.node().clientWidth;
const containerHeight = chartContainer.node().clientHeight || 640;

const margin = { top: 30, right: 30, bottom: 60, left: 55 };
const width = containerWidth - margin.left - margin.right;
const height = containerHeight - margin.top - margin.bottom;

const svg = chartContainer
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

const detailsTitle = d3.select("#details-title");
const detailsSubtitle = d3.select("#details-subtitle");
const detailsList = d3.select("#details-list");

const CATEGORY_KEYS = ["Revival", "New"];
const CATEGORY_LABELS = {
    Revival: "Reprise",
    New: "Musical original",
};
const CATEGORY_COLORS = {
    Revival: "#1b9e77",
    New: "#d95f02",
};

async function inicializarESQL() {
    console.log("Inicializando DuckDB...");

    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.VoidLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();

    const csvPath = '/data/maestras_broadway.csv';
    await db.registerFileURL('maestras_broadway.csv', csvPath, duckdb.DuckDBDataProtocol.HTTP, false);

    await conn.query(`
        CREATE TABLE shows AS SELECT * FROM read_csv_auto('maestras_broadway.csv', header=True);

        CREATE VIEW clean_data AS
        SELECT
            "SHOW" as show_name,
            "FIRST NAME" as first_name,
            "LAST NAME" as last_name,
            "Role" as role,
            "PRODUCTION TYPE" as production_type,
            "# of  PERFORMANCES" as performances,
            "OPENING  DATE"::DATE as opening_date_parsed,
            CASE WHEN lower("PRODUCTION TYPE") LIKE '%revival%' THEN 'Revival' ELSE 'New' END as show_category
        FROM shows
        WHERE "OPENING  DATE" IS NOT NULL;
    `);

    const detailsResult = await conn.query(`
        SELECT
            year(opening_date_parsed) as year,
            show_name,
            first_name,
            last_name,
            role,
            production_type,
            performances,
            show_category as category
        FROM clean_data
        ORDER BY year, show_name;
    `);

    const details = detailsResult.toArray().map(row => {
        const d = row.toJSON();
        return {
            year: Number(d.year),
            show_name: d.show_name,
            first_name: d.first_name,
            last_name: d.last_name,
            role: d.role,
            production_type: d.production_type,
            performances: d.performances ? Number(d.performances) : null,
            category: d.category,
        };
    });

    desenharBarrasEmpilhadas(details);

    await conn.close();
    await db.terminate();
}

function desenharBarrasEmpilhadas(details) {
    const dataByYear = d3
        .rollups(
            details,
            values => {
                const row = { year: values[0].year, Revival: 0, New: 0, total: 0 };
                const grouped = d3.group(values, d => d.category);
                CATEGORY_KEYS.forEach(key => {
                    const set = new Set((grouped.get(key) || []).map(item => item.show_name));
                    row[key] = set.size;
                    row.total += row[key];
                });
                return row;
            },
            d => d.year
        )
        .map(([, value]) => value)
        .sort((a, b) => d3.ascending(a.year, b.year));

    const years = dataByYear.map(d => d.year);
    const maxTotal = d3.max(dataByYear, d => d.total) || 1;

    const x = d3.scaleBand()
        .domain(years)
        .range([0, width])
        .padding(0.12);

    const y = d3.scaleLinear()
        .domain([0, maxTotal])
        .nice()
        .range([height, 0]);

    const tickYears = years.length > 15 ? years.filter(year => year % 5 === 0) : years;

    svg.selectAll("line.grid-line")
        .data(y.ticks(8))
        .enter()
        .append("line")
        .attr("class", "grid-line")
        .attr("x1", 0)
        .attr("x2", width)
        .attr("y1", d => y(d))
        .attr("y2", d => y(d));

    svg.append("g")
        .attr("class", "axis axis-x")
        .attr("transform", `translate(0, ${height})`)
        .call(d3.axisBottom(x).tickValues(tickYears).tickFormat(d3.format("d")));

    svg.append("g")
        .attr("class", "axis axis-y")
        .call(d3.axisLeft(y).ticks(8));

    svg.append("text")
        .attr("class", "axis-label")
        .attr("x", 0)
        .attr("y", -10)
        .text("Total de espetaculos por ano");

    const stack = d3.stack().keys(CATEGORY_KEYS);
    const series = stack(dataByYear);

    const layers = svg.selectAll("g.bar-layer")
        .data(series)
        .enter()
        .append("g")
        .attr("class", "bar-layer")
        .attr("fill", d => CATEGORY_COLORS[d.key]);

    layers.selectAll("rect")
        .data(d => d.map(item => ({
            key: d.key,
            year: item.data.year,
            y0: item[0],
            y1: item[1],
        })))
        .enter()
        .append("rect")
        .attr("x", d => x(d.year))
        .attr("y", d => y(d.y1))
        .attr("height", d => y(d.y0) - y(d.y1))
        .attr("width", x.bandwidth());

    const detailsByYear = d3.group(details, d => d.year);
    let pinnedYear = null;

    function updateHighlight(year) {
        svg.selectAll("rect.year-overlay")
            .classed("is-active", d => year !== null && d.year === year);

        svg.selectAll("g.bar-layer rect")
            .classed("is-dimmed", d => year !== null && d.year !== year);
    }

    function clearDetails() {
        detailsTitle.text("Passe o rato num ano");
        detailsSubtitle.text("Clique para fixar a selecao.");
        detailsList.html("");
        updateHighlight(null);
    }

    function updateDetails(year, isPinned) {
        const items = detailsByYear.get(year) || [];

        detailsTitle.text(`Ano ${year}`);
        detailsSubtitle.text(isPinned ? "Selecionado. Clique novamente para limpar." : "Clique para fixar a selecao.");

        if (!items.length) {
            detailsList.html("<p class=\"details-empty\">Sem registros para este ano.</p>");
            return;
        }

        const grouped = d3.group(items, d => d.show_name);
        const showItems = Array.from(grouped, ([show_name, rows]) => ({
            show_name,
            rows,
            performances: rows[0].performances,
            category: rows[0].category,
        }));

        const cards = detailsList.selectAll("div.detail-item")
            .data(showItems, d => d.show_name);

        cards.exit().remove();

        const cardsEnter = cards.enter()
            .append("div")
            .attr("class", "detail-item");

        cardsEnter.append("div").attr("class", "detail-show");
        cardsEnter.append("ul").attr("class", "detail-people");

        const cardsMerge = cardsEnter.merge(cards);

        cardsMerge.select(".detail-show").each(function(d) {
            const container = d3.select(this);
            container.selectAll("*").remove();
            container.append("span").text(d.show_name);
            if (Number.isFinite(d.performances)) {
                container.append("div")
                    .attr("class", "detail-meta")
                    .text(`Apresentacoes: ${d.performances}`);
            }
            container.append("span")
                .attr("class", `detail-tag ${d.category === 'Revival' ? 'revival' : 'new'}`)
                .text(CATEGORY_LABELS[d.category]);
        });

        cardsMerge.select(".detail-people")
            .selectAll("li")
            .data(d => d.rows)
            .join("li")
            .text(row => `${row.first_name} ${row.last_name} — ${row.role}`);
    }

    svg.selectAll("rect.year-overlay")
        .data(dataByYear)
        .enter()
        .append("rect")
        .attr("class", "year-overlay")
        .attr("x", d => x(d.year))
        .attr("y", 0)
        .attr("width", x.bandwidth())
        .attr("height", height)
        .on("mouseover", (_, d) => {
            if (pinnedYear === null) {
                updateDetails(d.year, false);
                updateHighlight(d.year);
            }
        })
        .on("mouseout", () => {
            if (pinnedYear === null) {
                clearDetails();
            }
        })
        .on("click", (_, d) => {
            pinnedYear = pinnedYear === d.year ? null : d.year;
            if (pinnedYear === null) {
                clearDetails();
            } else {
                updateDetails(pinnedYear, true);
                updateHighlight(pinnedYear);
            }
        });
}

inicializarESQL();