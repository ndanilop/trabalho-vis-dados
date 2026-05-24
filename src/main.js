// src/main.js
import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

// --- 1. Configuração do DuckDB-Wasm ---
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

// --- 2. Configurações Globais da Visualização D3 ---
const chartContainer = d3.select("#chart");
const containerWidth = chartContainer.node().clientWidth;
const containerHeight = chartContainer.node().clientHeight || 600;

const margin = { top: 60, right: 80, bottom: 50, left: 20 };
const width = containerWidth - margin.left - margin.right;
const height = containerHeight - margin.top - margin.bottom;

const svg = chartContainer
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`) 
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

const defs = svg.append("defs");
const gradient = defs.append("linearGradient")
    .attr("id", "area-gradient")
    .attr("x1", "0%").attr("y1", "0%")
    .attr("x2", "0%").attr("y2", "100%");

gradient.append("stop")
    .attr("offset", "0%")
    .attr("stop-color", "rgba(67, 109, 147, 0.8)"); 
gradient.append("stop")
    .attr("offset", "100%")
    .attr("stop-color", "rgba(67, 109, 147, 0.05)");

const tooltip = d3.select("#tooltip");

// --- 3. Função Principal Assíncrona ---
async function inicializarESQL() {
    console.log("Inicializando DuckDB...");
    
    // Passo A: Inicializar o motor do banco de dados (que havia sumido)
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.VoidLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();

    // Passo B: Carregar CSV localmente da pasta 'static'
    const csvPath = '/data/maestras_broadway.csv'; 
    await db.registerFileURL('maestras_broadway.csv', csvPath, duckdb.DuckDBDataProtocol.HTTP, false);
    
    console.log("Processando SQL...");
    // Passo C: Criar tabela e processar dados
    await conn.query(`
        CREATE TABLE shows AS SELECT * FROM read_csv_auto('maestras_broadway.csv', header=True);
        
        CREATE VIEW processed_shows AS 
        WITH clean_data AS (
            SELECT *,
                   "OPENING  DATE"::DATE as opening_date_parsed,
                   CASE WHEN lower("PRODUCTION TYPE") LIKE '%revival%' THEN 'Revival' ELSE 'New' END as show_category
            FROM shows
            WHERE "OPENING  DATE" IS NOT NULL
        ),
        cumulative AS (
            SELECT *,
                   count(*) OVER (ORDER BY opening_date_parsed) as cumulative_total
            FROM clean_data
        )
        SELECT *,
               year(opening_date_parsed) as opening_year,
               row_number() OVER (PARTITION BY year(opening_date_parsed) ORDER BY opening_date_parsed) - 1 as stack_index
        FROM cumulative
        ORDER BY opening_date_parsed;
    `);

    console.log("SQL executado. Buscando resultados para o D3...");
    
    // Passo D: Buscar os resultados calculados
    const result = await conn.query('SELECT * FROM processed_shows');
    
    // Passo E: Converter resultados e transformar BigInt em Number comum
    const dataForD3 = result.toArray().map(row => {
        const d = row.toJSON();
        d.cumulative_total = Number(d.cumulative_total);
        d.stack_index = Number(d.stack_index);
        d.opening_year = Number(d.opening_year);
        return d;
    });

    // Passo F: Desenhar
    desenharVisualizacaoCompleta(dataForD3);

    // Passo G: Limpeza
    await conn.close();
    await db.terminate();
}

// --- 4. Implementação da Lógica de Desenho D3 Completa ---
function desenharVisualizacaoCompleta(data) {
    console.log("D3 iniciando desenho com dados processados pelo SQL:", data);

    const x = d3.scaleTime()
        .domain([new Date(1980, 0, 1), new Date(2025, 11, 31)])
        .range([0, width]);

    const maxCumulative = d3.max(data, d => d.cumulative_total) || 10;
    const y = d3.scaleLinear()
        .domain([0, maxCumulative + 15]) 
        .range([height, 0]);

    svg.selectAll("line.grid-line")
        .data(x.ticks(d3.timeYear.every(5))) 
        .enter()
        .append("line")
        .attr("class", "grid-line") 
        .attr("x1", d => x(d))
        .attr("x2", d => x(d))
        .attr("y1", 0)
        .attr("y2", height);

    const xAxis = d3.axisTop(x)
        .ticks(d3.timeYear.every(5))
        .tickFormat(d3.timeFormat("%Y"));

    const gXAxis = svg.append("g")
        .attr("class", "axis axis-x")
        .attr("transform", `translate(0, 0)`) 
        .call(xAxis);
        
    gXAxis.selectAll("text").attr("class", "axis-label"); 
    gXAxis.select(".domain").attr("opacity", 0);

    const yAxis = d3.axisRight(y).ticks(15);
    
    const gYAxis = svg.append("g")
        .attr("class", "axis axis-y")
        .attr("transform", `translate(${width}, 0)`)
        .call(yAxis);
        
    gYAxis.selectAll("text").attr("class", "axis-label");

    svg.append("text")
        .attr("transform", `translate(${width + 45}, ${height/2}) rotate(-90)`)
        .attr("class", "axis-label") 
        .style("text-anchor", "middle")
        .text("QUANTIDADE ACUMULADA DE PRODUÇÕES COM REGENTES MAESTRA");

    const areaGenerator = d3.area()
        .x(d => x(new Date(d.opening_date_parsed)))
        .y0(height) 
        .y1(d => y(d.cumulative_total)) 
        .curve(d3.curveMonotoneX); 

    const lineGenerator = d3.line()
        .x(d => x(new Date(d.opening_date_parsed)))
        .y(d => y(d.cumulative_total))
        .curve(d3.curveMonotoneX);

    svg.append("path")
        .datum(data)
        .attr("class", "chart-area")
        .attr("fill", "url(#area-gradient)")
        .attr("d", areaGenerator);

    svg.append("path")
        .datum(data)
        .attr("class", "chart-line")
        .attr("fill", "none")
        .attr("stroke", "rgb(67, 109, 147)") 
        .attr("stroke-width", 3)
        .attr("d", lineGenerator);

    const dotSpacing = 16; 

    const circles = svg.selectAll("circle.show-dot")
        .data(data)
        .enter()
        .append("circle")
        .attr("class", "show-dot")
        .attr("cx", d => x(new Date(d.opening_date_parsed)))
        .attr("cy", d => height - 20 - (d.stack_index * dotSpacing)) 
        .attr("r", 5.5) 
        .attr("fill", d => d.show_category === 'Revival' ? "#e37b98" : "#79bad5")
        .attr("stroke", "#666")
        .attr("stroke-width", 1)
        .style("cursor", "pointer");

    const labelData = data.filter((d, i) => i % 5 === 0 || i === data.length - 1);

    svg.selectAll("text.cumulative-label")
        .data(labelData)
        .enter()
        .append("text")
        .attr("class", "cumulative-label axis-label") 
        .attr("x", d => x(new Date(d.opening_date_parsed)))
        .attr("y", d => y(d.cumulative_total) - 10) 
        .text(d => d.cumulative_total)
        .attr("text-anchor", "middle")
        .style("font-weight", "bold");

    circles.on("mouseover", function(event, d) {
        d3.select(this).attr("stroke-width", 2.5).attr("stroke", "#000");
        
        // Pega a data ajustada do fuso horário para mostrar no tooltip
        const dateObj = new Date(d.opening_date_parsed);
        const dataFormatada = d3.timeFormat("%d/%m/%Y")(new Date(dateObj.getTime() + dateObj.getTimezoneOffset() * 60000));

        tooltip.transition().duration(150).style("opacity", 1);
        tooltip.html(`
            <h3>${d["SHOW"]}</h3>
            <p class="tooltip-title">DETALHES DA MAESTRA E REGENTES:</p>
            <p><strong>${d["FIRST NAME"]} ${d["LAST NAME"]}</strong></p>
            <p>${d["Role"]}</p>
            <p>Tipo: ${d["PRODUCTION TYPE"]}</p>
            <p>Estreia: ${dataFormatada}</p>
        `)
        .style("left", (event.pageX + 18) + "px")
        .style("top", (event.pageY - 30) + "px");
    })
    .on("mouseout", function() {
        d3.select(this).attr("stroke-width", 1).attr("stroke", "#666");
        tooltip.transition().duration(400).style("opacity", 0);
    });
}

// --- Inicia o Processo ---
inicializarESQL();