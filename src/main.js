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
const yearFilter = document.querySelector("#year-filter");

const CATEGORY_KEYS = ["Revival", "New"];
const CATEGORY_LABELS = {
    Revival: "Reprise",
    New: "Musical original",
};
const CATEGORY_COLORS = {
    Revival: "#1b9e77",
    New: "#d95f02",
};
const MONTH_LABELS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MONTH_LABELS_FULL = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

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
            show_category as category,
            opening_date_parsed
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
            opening_date: d.opening_date_parsed ? new Date(d.opening_date_parsed) : null,
        };
    });

    configurarFiltroAno(details);
    desenharBarrasEmpilhadas(details);

    await conn.close();
    await db.terminate();
}

function configurarFiltroAno(details) {
    if (!yearFilter) return;

    const years = Array.from(new Set(details.map(item => item.year)))
        .filter(year => Number.isFinite(year))
        .sort((a, b) => a - b);

    yearFilter.innerHTML = "<option value=\"all\">Todos os anos</option>";
    years.forEach(year => {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        yearFilter.appendChild(option);
    });

    yearFilter.addEventListener("change", () => {
        desenharBarrasEmpilhadas(details);
    });
}

function desenharBarrasEmpilhadas(details) {
    const selectedYear = yearFilter && yearFilter.value !== "all"
        ? Number(yearFilter.value)
        : null;
    const isMonthView = Number.isFinite(selectedYear);
    svg.selectAll("*").remove();

    const baseDetails = isMonthView
        ? details.filter(item => item.year === selectedYear)
        : details;

    if (!baseDetails.length) {
        detailsTitle.text("Sem dados para o ano selecionado");
        detailsSubtitle.text("Escolha outro ano ou limpe o filtro.");
        detailsList.html("");
        return;
    }

    detailsTitle.text(isMonthView ? "Passe o mouse em um mês" : "Passe o mouse em um ano para ver detalhes");
    detailsSubtitle.text("Clique para fixar a seleção.");
    detailsList.html("");

    const dataByTime = isMonthView
        ? MONTH_LABELS.map((label, index) => {
            const monthItems = baseDetails.filter(item => {
                if (!item.opening_date || Number.isNaN(item.opening_date.getTime())) return false;
                return item.opening_date.getMonth() === index;
            });
            const grouped = d3.group(monthItems, d => d.category);
            const row = { key: index, label, Revival: 0, New: 0, total: 0 };
            CATEGORY_KEYS.forEach(key => {
                const set = new Set((grouped.get(key) || []).map(item => item.show_name));
                row[key] = set.size;
                row.total += row[key];
            });
            return row;
        })
        : d3
            .rollups(
                details,
                values => {
                    const row = { key: values[0].year, label: values[0].year, Revival: 0, New: 0, total: 0 };
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
            .sort((a, b) => d3.ascending(a.key, b.key));

    const maxTotal = d3.max(dataByTime, d => d.total) || 1;

    const x = d3.scaleBand()
        .domain(dataByTime.map(d => d.key))
        .range([0, width])
        .padding(0.12);

    const y = d3.scaleLinear()
        .domain([0, maxTotal])
        .nice()
        .range([height, 0]);

    const yTickValues = isMonthView
        ? [0, 1, 2, 3]
        : y.ticks(8);

    svg.selectAll("line.grid-line")
        .data(yTickValues)
        .enter()
        .append("line")
        .attr("class", "grid-line")
        .attr("x1", 0)
        .attr("x2", width)
        .attr("y1", d => y(d))
        .attr("y2", d => y(d));

    const xAxis = isMonthView
        ? d3.axisBottom(x).tickFormat(key => MONTH_LABELS[key])
        : d3.axisBottom(x)
            .tickValues(dataByTime.length > 15 ? dataByTime.filter(d => d.key % 5 === 0).map(d => d.key) : dataByTime.map(d => d.key))
            .tickFormat(d3.format("d"));

    svg.append("g")
        .attr("class", "axis axis-x")
        .attr("transform", `translate(0, ${height})`)
        .call(xAxis);

    const yAxis = isMonthView
        ? d3.axisLeft(y).tickValues(yTickValues).tickFormat(d3.format("d"))
        : d3.axisLeft(y).ticks(8);

    svg.append("g")
        .attr("class", "axis axis-y")
        .call(yAxis);

    svg.append("text")
        .attr("class", "axis-label")
        .attr("x", 0)
        .attr("y", -10)
        .text(isMonthView ? `Total de espetáculos por mês em ${selectedYear}` : "Total de espetáculos por ano");

    const stack = d3.stack().keys(CATEGORY_KEYS);
    const series = stack(dataByTime);

    const layers = svg.selectAll("g.bar-layer")
        .data(series)
        .enter()
        .append("g")
        .attr("class", "bar-layer")
        .attr("fill", d => CATEGORY_COLORS[d.key]);

    layers.selectAll("rect")
        .data(d => d.map(item => ({
            key: d.key,
            bucketKey: item.data.key,
            y0: item[0],
            y1: item[1],
        })))
        .enter()
        .append("rect")
        .attr("x", d => x(d.bucketKey))
        .attr("y", d => y(d.y1))
        .attr("height", d => y(d.y0) - y(d.y1))
        .attr("width", x.bandwidth());

    let pinnedKey = null;
    const detailsByKey = isMonthView
        ? d3.group(baseDetails, d => (d.opening_date ? d.opening_date.getMonth() : -1))
        : d3.group(details, d => d.year);

    function updateHighlight(key) {
        svg.selectAll("rect.year-overlay")
            .classed("is-active", d => key !== null && d.key === key);

        svg.selectAll("g.bar-layer rect")
            .classed("is-dimmed", d => key !== null && d.bucketKey !== key);
    }

    function clearDetails() {
        detailsTitle.text(isMonthView ? "Passe o mouse em um mês" : "Passe o mouse em um ano para ver detalhes");
        detailsSubtitle.text("Clique para fixar a seleção.");
        detailsList.html("");
        updateHighlight(null);
    }

    function updateDetails(key, isPinned) {
        const items = detailsByKey.get(key) || [];

        if (isMonthView) {
            detailsTitle.text(`Mês de ${MONTH_LABELS_FULL[key]} de ${selectedYear}`);
        } else {
            detailsTitle.text(`Ano ${key}`);
        }
        detailsSubtitle.text(isPinned ? "Selecionado. Clique novamente para limpar." : "Clique para fixar a seleção.");

        if (!items.length) {
            detailsList.html(`<p class=\"details-empty\">Sem registros para este ${isMonthView ? "mês" : "ano"}.</p>`);
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
                    .text(`Apresentações: ${d.performances}`);
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
        .data(dataByTime)
        .enter()
        .append("rect")
        .attr("class", "year-overlay")
        .attr("x", d => x(d.key))
        .attr("y", 0)
        .attr("width", x.bandwidth())
        .attr("height", height)
        .on("mouseover", (_, d) => {
            if (pinnedKey === null) {
                updateDetails(d.key, false);
                updateHighlight(d.key);
            }
        })
        .on("mouseout", () => {
            if (pinnedKey === null) {
                clearDetails();
            }
        })
        .on("click", (_, d) => {
            pinnedKey = pinnedKey === d.key ? null : d.key;
            if (pinnedKey === null) {
                clearDetails();
            } else {
                updateDetails(pinnedKey, true);
                updateHighlight(pinnedKey);
            }
        });
}

inicializarESQL();