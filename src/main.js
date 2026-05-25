// src/main.js
import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

// Configurações do DuckDB omitidas por brevidade (são iguais) ...
const MANUAL_BUNDLES = {
    mvp: { mainModule: duckdb_wasm, mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).href },
    eh: { mainModule: duckdb_wasm_eh, mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).href },
};

const chartContainer = d3.select("#chart");
const containerWidth = chartContainer.node().clientWidth;
const containerHeight = chartContainer.node().clientHeight || 640;

const margin = { top: 40, right: 40, bottom: 60, left: 55 };
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
    Revival: "Revival",
    New: "New Musical",
};

const CATEGORY_COLORS = {
    Revival: "#D81B60", 
    New: "#0288D1",     
};

async function inicializarESQL() {
    // Mesma lógica de inicialização do DB ...
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
        SELECT year(opening_date_parsed) as year, show_name, first_name, last_name, role, production_type, performances, show_category as category, opening_date_parsed
        FROM clean_data ORDER BY year, show_name;
    `);

    const details = detailsResult.toArray().map(row => {
        const d = row.toJSON();
        return {
            year: Number(d.year), show_name: d.show_name, first_name: d.first_name, last_name: d.last_name, role: d.role,
            production_type: d.production_type, performances: d.performances ? Number(d.performances) : null,
            category: d.category, opening_date: d.opening_date_parsed ? new Date(d.opening_date_parsed) : null,
        };
    });

    d3.select(".revival-dot").style("background-color", CATEGORY_COLORS.Revival);
    d3.select(".new-dot").style("background-color", CATEGORY_COLORS.New);

    configurarFiltroAno(details);
    desenharGrafico(details);

    await conn.close();
    await db.terminate();
}

function configurarFiltroAno(details) {
    if (!yearFilter) return;

    const years = Array.from(new Set(details.map(item => item.year)))
        .filter(year => Number.isFinite(year))
        .sort((a, b) => a - b);

    yearFilter.innerHTML = "<option value=\"all\">All years</option>";
    years.forEach(year => {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        yearFilter.appendChild(option);
    });

    yearFilter.addEventListener("change", () => desenharGrafico(details));
}

function desenharGrafico(details) {
    const selectedYear = yearFilter && yearFilter.value !== "all" ? Number(yearFilter.value) : null;
    svg.selectAll("*").remove(); 

    if (selectedYear !== null) {
        const dadosDoAno = details.filter(item => item.year === selectedYear);
        if (!dadosDoAno.length) {
            detailsTitle.text("No data for the selected year");
            detailsSubtitle.text("Choose another year or clear the filter.");
            detailsList.html("");
        } else {
            desenharTimeline(dadosDoAno, selectedYear);
        }
    } else {
        desenharBarras(details);
    }
}

// ----------------------------------------------------
// 1. VISÃO GERAL: GRÁFICO DE BARRAS EMPILHADAS
// ----------------------------------------------------
function desenharBarras(details) {
    detailsTitle.text("Overview");
    detailsSubtitle.text("Hover over a column to see details or click to pin.");
    detailsList.html("");

    let pinnedKey = null;
    const detailsByKey = d3.group(details, d => d.year);

    function updateHighlight(key) {
        svg.selectAll("rect.year-overlay").classed("is-active", d => key !== null && d.key === key);
        svg.selectAll("g.bar-layer rect").classed("is-dimmed", d => key !== null && d.bucketKey !== key);
    }

    // Fundo invisível para capturar o clique no "vazio" e limpar a seleção
    svg.append("rect")
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "transparent")
        .on("click", () => {
            if (pinnedKey !== null) {
                pinnedKey = null;
                detailsTitle.text("Overview"); 
                detailsSubtitle.text("Hover over a column to see details or click to pin."); 
                detailsList.html(""); 
                updateHighlight(null);
            }
        });

    const dataByYear = d3.rollups(
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
    ).map(([, value]) => value).sort((a, b) => d3.ascending(a.key, b.key));

    const maxTotal = d3.max(dataByYear, d => d.total) || 1;

    const x = d3.scaleBand().domain(dataByYear.map(d => d.key)).range([0, width]).padding(0.12);
    const y = d3.scaleLinear().domain([0, maxTotal]).nice().range([height, 0]);

    svg.selectAll("line.grid-line").data(y.ticks(8)).enter().append("line").attr("class", "grid-line")
        .attr("x1", 0).attr("x2", width).attr("y1", d => y(d)).attr("y2", d => y(d));

    const xAxis = d3.axisBottom(x).tickValues(dataByYear.length > 15 ? dataByYear.filter(d => d.key % 5 === 0).map(d => d.key) : dataByYear.map(d => d.key)).tickFormat(d3.format("d"));
    svg.append("g").attr("class", "axis axis-x").attr("transform", `translate(0, ${height})`).call(xAxis);
    svg.append("g").attr("class", "axis axis-y").call(d3.axisLeft(y).ticks(8));

    svg.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -15).text("Total shows");

    const stack = d3.stack().keys(CATEGORY_KEYS);
    const series = stack(dataByYear);

    const layers = svg.selectAll("g.bar-layer").data(series).enter().append("g").attr("class", "bar-layer").attr("fill", d => CATEGORY_COLORS[d.key]);
    layers.selectAll("rect").data(d => d.map(item => ({ key: d.key, bucketKey: item.data.key, y0: item[0], y1: item[1] }))).enter()
        .append("rect").attr("x", d => x(d.bucketKey)).attr("y", d => y(d.y1)).attr("height", d => y(d.y0) - y(d.y1)).attr("width", x.bandwidth())
        .style("pointer-events", "none"); 

    // DE VOLTA: .year-overlay ocupando toda a altura do gráfico (y = 0, height = height)
    svg.selectAll("rect.year-overlay").data(dataByYear).enter().append("rect").attr("class", "year-overlay")
        .attr("x", d => x(d.key))
        .attr("y", 0) 
        .attr("width", x.bandwidth())
        .attr("height", height) 
        .attr("opacity", 0)
        .on("mouseover", (_, d) => { 
            if (pinnedKey === null) { renderizarCardsLaterais(d.key, false, detailsByKey); updateHighlight(d.key); } 
        })
        .on("mouseout", () => {
            if (pinnedKey === null) {
                detailsTitle.text("Overview"); detailsSubtitle.text("Hover over a column to see details or click to pin."); detailsList.html(""); updateHighlight(null);
            }
        })
        .on("click", (event, d) => {
            event.stopPropagation(); 
            pinnedKey = pinnedKey === d.key ? null : d.key;
            if (pinnedKey === null) {
                detailsTitle.text("Overview"); detailsSubtitle.text("Hover over a column to see details or click to pin."); detailsList.html(""); updateHighlight(null);
            } else {
                renderizarCardsLaterais(pinnedKey, true, detailsByKey); updateHighlight(pinnedKey);
            }
        });
}

function renderizarCardsLaterais(key, isPinned, detailsByKey) {
    const items = detailsByKey.get(key) || [];
    const grouped = d3.group(items, d => d.show_name);
    const totalShows = grouped.size; // Calcula o número correto de espetáculos únicos no ano

    detailsTitle.text(`Year of ${key}`);
    
    const pinText = isPinned ? "Selected. Click the column or empty space to clear." : "Click the column to pin the selection.";

    // Se não houver itens, mostra estado vazio
    if (totalShows === 0) {
        detailsSubtitle.text(pinText);
        detailsList.html(`<p class=\"details-empty\">No records for this year.</p>`);
        return;
    }

    // NOVO: Exibe o Total de Shows em destaque no subtítulo e as instruções abaixo
    detailsSubtitle.html(`<span style="color: var(--text-color); font-weight: 700; font-size: 13px;">Total shows: ${totalShows}</span> <br> <span style="margin-top: 4px; display: inline-block;">${pinText}</span>`);

    const showItems = Array.from(grouped, ([show_name, rows]) => ({ show_name, rows, performances: rows[0].performances, category: rows[0].category }));

    const cards = detailsList.selectAll("div.detail-item").data(showItems, d => d.show_name);
    cards.exit().remove();
    const cardsEnter = cards.enter().append("div").attr("class", "detail-item");
    cardsEnter.append("div").attr("class", "detail-show");
    cardsEnter.append("ul").attr("class", "detail-people");

    const cardsMerge = cardsEnter.merge(cards);

    cardsMerge.select(".detail-show").each(function(d) {
        const container = d3.select(this);
        container.selectAll("*").remove();
        container.append("span").text(d.show_name);
        if (Number.isFinite(d.performances)) {
            container.append("div").attr("class", "detail-meta").text(`Performances: ${d.performances}`);
        }
        container.append("span").attr("class", `detail-tag`).style("background", `${CATEGORY_COLORS[d.category]}22`).style("color", CATEGORY_COLORS[d.category]).text(CATEGORY_LABELS[d.category]);
    });

    cardsMerge.select(".detail-people").selectAll("li").data(d => d.rows).join("li").text(row => `${row.first_name} ${row.last_name} — ${row.role}`);
}


function desenharTimeline(baseDetails, selectedYear) {
    let pinnedShowName = null;

    // NOVO: Fundo invisível para capturar clique no "vazio" e resetar a seleção na Timeline
    svg.append("rect")
        .attr("width", width)
        .attr("height", height)
        .attr("fill", "transparent")
        .on("click", () => {
            if (pinnedShowName !== null) {
                pinnedShowName = null;
                updateTimelineHighlight(null, false);
            }
        });

    const shows = Array.from(d3.group(baseDetails, d => d.show_name), ([show_name, rows]) => {
        return { show_name, opening_date: rows[0].opening_date, category: rows[0].category, performances: rows[0].performances, people: rows };
    }).filter(d => d.opening_date).sort((a, b) => a.opening_date - b.opening_date);

    const xTime = d3.scaleTime().domain([new Date(selectedYear, 0, 1), new Date(selectedYear, 11, 31)]).range([0, width]);
    const yOrdinal = d3.scalePoint().domain(shows.map(d => d.show_name)).range([20, height - 30]).padding(0.5);

    const xAxis = d3.axisBottom(xTime).ticks(width < 600 ? d3.timeMonth.every(2) : d3.timeMonth.every(1)).tickFormat(d3.timeFormat("%b")).tickSizeOuter(0);

    svg.append("g").attr("class", "axis axis-x").attr("transform", `translate(0, ${height})`).call(xAxis).selectAll("text").style("text-transform", "capitalize").attr("dy", "1em");
    svg.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -15).text("Shows opening throughout the year");

    const dropLines = svg.selectAll("line.drop-line").data(shows).enter().append("line").attr("class", "drop-line")
        .attr("x1", d => xTime(d.opening_date)).attr("x2", d => xTime(d.opening_date)).attr("y1", d => yOrdinal(d.show_name)).attr("y2", height)
        .attr("stroke", "var(--grid-color)").attr("stroke-dasharray", "4 4");

    const nodes = svg.selectAll("g.timeline-node").data(shows).enter().append("g").attr("class", "timeline-node")
        .attr("transform", d => `translate(${xTime(d.opening_date)}, ${yOrdinal(d.show_name)})`).style("cursor", "pointer");

    nodes.append("circle").attr("r", 7).attr("fill", d => CATEGORY_COLORS[d.category]).attr("stroke", "#fff").attr("stroke-width", 2);
    nodes.append("text").attr("x", d => xTime(d.opening_date) > width * 0.75 ? -14 : 14).attr("y", 4)
        .attr("text-anchor", d => xTime(d.opening_date) > width * 0.75 ? "end" : "start").attr("font-weight", "bold").attr("font-size", "12px").attr("fill", "var(--text-color)").text(d => d.show_name);

    detailsTitle.text(`Year of ${selectedYear}`);
    detailsSubtitle.text("Hover over a point or line to highlight, click to pin.");

    const cards = detailsList.selectAll("div.detail-item").data(shows, d => d.show_name);
    cards.exit().remove();
    
    const cardsEnter = cards.enter().append("div").attr("class", "detail-item").attr("id", d => `card-${d.show_name.replace(/[^a-zA-Z0-9]/g, '-')}`);
    cardsEnter.append("div").attr("class", "detail-show");
    cardsEnter.append("ul").attr("class", "detail-people");

    const cardsMerge = cardsEnter.merge(cards);

    cardsMerge.select(".detail-show").each(function(data) {
        const container = d3.select(this);
        container.selectAll("*").remove();
        
        const dataFormatada = d3.timeFormat("%m/%d/%Y")(new Date(data.opening_date.getTime() + data.opening_date.getTimezoneOffset() * 60000));
        
        container.append("span").style("font-weight", "bold").style("display", "block").text(data.show_name);
        container.append("div").attr("class", "detail-meta").style("margin-top", "6px").html(`<strong>Opening:</strong> ${dataFormatada}`);
        
        if (Number.isFinite(data.performances)) {
            container.append("div").attr("class", "detail-meta").html(`<strong>Performances:</strong> ${data.performances}`);
        }

        container.append("span").attr("class", `detail-tag`).style("background", `${CATEGORY_COLORS[data.category]}22`).style("color", CATEGORY_COLORS[data.category]).style("margin-top", "8px").text(CATEGORY_LABELS[data.category]);
    });

    cardsMerge.select(".detail-people").selectAll("li").data(data => data.people).join("li").text(row => `${row.first_name} ${row.last_name} — ${row.role}`);

    function updateTimelineHighlight(hoveredShowName, smoothScroll = true) {
        const targetShow = hoveredShowName || pinnedShowName;

        svg.selectAll("g.timeline-node circle").attr("r", 7).attr("stroke", "#fff");
        svg.selectAll("g.timeline-node text").attr("opacity", targetShow ? 0.3 : 1);
        svg.selectAll("line.drop-line").classed("is-hovered", false).attr("opacity", targetShow ? 0.3 : 1);

        if (targetShow) {
            svg.selectAll("g.timeline-node").filter(d => d.show_name === targetShow).select("circle").attr("r", 10).attr("stroke", "#000");
            svg.selectAll("g.timeline-node").filter(d => d.show_name === targetShow).select("text").attr("opacity", 1);
            svg.selectAll("line.drop-line").filter(d => d.show_name === targetShow).classed("is-hovered", true).attr("opacity", 1);
                
            if (smoothScroll) {
                const targetId = `#card-${targetShow.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const targetCard = document.querySelector(targetId);
                const sidebar = document.querySelector('.sidebar');
                if (targetCard && sidebar) {
                    const sidebarTop = sidebar.getBoundingClientRect().top;
                    const cardTop = targetCard.getBoundingClientRect().top;
                    const scrollTop = sidebar.scrollTop + (cardTop - sidebarTop) - 24; 
                    sidebar.scrollTo({ top: scrollTop, behavior: 'smooth' });
                }
            }
        }

        detailsList.selectAll("div.detail-item")
            .style("opacity", d => (!targetShow || d.show_name === targetShow) ? "1" : "0.3")
            .style("border-left", d => (targetShow && d.show_name === targetShow) ? `4px solid ${CATEGORY_COLORS[d.category]}` : "1px solid var(--border-color)")
            .style("transition", "opacity 0.2s, border-left 0.2s");
            
        if (pinnedShowName) {
            detailsSubtitle.text("Selected. Click the point, line, or empty space to clear.");
        } else if (hoveredShowName) {
            detailsSubtitle.text("Click the point or line to pin the selection.");
        } else {
            detailsSubtitle.text("Hover over a point or line to highlight, click to pin.");
        }
    }

    const handleMouseOver = (_, d) => updateTimelineHighlight(d.show_name);
    const handleMouseOut = () => updateTimelineHighlight(null, false);
    const handleClick = (event, d) => {
        event.stopPropagation(); // NOVO: Impede que o clique no nó/linha resete imediatamente
        pinnedShowName = (pinnedShowName === d.show_name) ? null : d.show_name;
        updateTimelineHighlight(pinnedShowName ? d.show_name : null);
    };

    nodes.on("mouseover", handleMouseOver).on("mouseout", handleMouseOut).on("click", handleClick);
    dropLines.on("mouseover", handleMouseOver).on("mouseout", handleMouseOut).on("click", handleClick);
}

inicializarESQL();