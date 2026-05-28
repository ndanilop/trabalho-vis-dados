// src/main.js
import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';

// Controle de modo de visualizacao via query string para recalcular o layout.
const viewModeSelect = document.querySelector("#view-mode");
const viewParam = new URLSearchParams(window.location.search).get("view");
const isSoloView = viewParam === "solo";

if (isSoloView) {
    // Esconde o painel de referencia e deixa o grafico ocupar toda a largura.
    document.body.classList.add("is-reference-hidden");
}

if (viewModeSelect) {
    // Sincroniza o select com a URL atual.
    viewModeSelect.value = isSoloView ? "solo" : "split";
    viewModeSelect.addEventListener("change", () => {
        const mode = viewModeSelect.value;
        const params = new URLSearchParams(window.location.search);

        // Atualiza a query para que o tamanho do grafico seja recalculado ao recarregar.
        if (mode === "solo") {
            params.set("view", "solo");
        } else {
            params.delete("view");
        }

        const query = params.toString();
        const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.location.assign(nextUrl);
    });
}

// ----------------------------------------------------
// CONFIGURAÇÃO DO DUCKDB (WASM)
// ----------------------------------------------------
// Define os bundles manuais para carregar o DuckDB no navegador.
// Isso permite processar os dados do CSV localmente via SQL com alta performance.
const MANUAL_BUNDLES = {
    mvp: { mainModule: duckdb_wasm, mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js', import.meta.url).href },
    eh: { mainModule: duckdb_wasm_eh, mainWorker: new URL('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', import.meta.url).href },
};

// ----------------------------------------------------
// CONFIGURAÇÃO DO CONTAINER SVG (D3.js)
// ----------------------------------------------------
// Captura as dimensões dinâmicas do container para garantir responsividade.
const chartContainer = d3.select("#chart");
const containerWidth = chartContainer.node().clientWidth;
const containerHeight = chartContainer.node().clientHeight || 640;

// Define margens para acomodar eixos e rótulos sem cortá-los.
const margin = { top: 40, right: 40, bottom: 60, left: 55 };
const width = containerWidth - margin.left - margin.right;
const height = containerHeight - margin.top - margin.bottom;

// Inicializa o SVG com viewBox. O uso de viewBox corrige distorções em 
// redimensionamentos, mantendo a proporção (aspect ratio) do gráfico.
const svg = chartContainer
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

// Referências na DOM para a barra lateral de detalhes.
const detailsTitle = d3.select("#details-title");
const detailsSubtitle = d3.select("#details-subtitle");
const detailsList = d3.select("#details-list");
// Usa os textos iniciais do HTML como padrao para evitar troca depois do load.
const DEFAULT_DETAILS_TITLE = detailsTitle.text();
const DEFAULT_DETAILS_SUBTITLE = detailsSubtitle.text();

// Definição de chaves e paleta de cores para consistência visual.
const CATEGORY_KEYS = ["Revival", "New"];
const CATEGORY_LABELS = { Revival: "Revival", New: "New Musical" };
// Usa somente as cores do CSS para manter legenda e grafico sincronizados.
const rootStyles = getComputedStyle(document.documentElement);
const revivalColor = rootStyles.getPropertyValue("--revival-color").trim();
const newColor = rootStyles.getPropertyValue("--new-color").trim();
const CATEGORY_COLORS = {
    Revival: revivalColor,
    New: newColor
};

let dadosOriginais = [];

// ----------------------------------------------------
// INICIALIZAÇÃO DE DADOS (DuckDB)
// ----------------------------------------------------
async function inicializarESQL() {
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.VoidLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();

    // Registra o CSV para leitura.
    await db.registerFileURL('maestras_broadway.csv', '/data/maestras_broadway.csv', duckdb.DuckDBDataProtocol.HTTP, false);

    // Limpeza e normalização dos dados:
    // - Converte datas para o tipo nativo DATE (essencial para escalas de tempo).
    // - Cria uma flag 'show_category' simplificada usando regex no texto original.
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
            CASE WHEN lower("PRODUCTION TYPE") LIKE '%revival%' THEN 'Revival' ELSE 'New' END as show_category,
            "LINK TO PHOTO" as link_to_photo,
            "PERSON FUN FACTS" as fun_facts,
            "Photo Credit" as photo_credit
        FROM shows
        WHERE "OPENING  DATE" IS NOT NULL;
    `);

    const detailsResult = await conn.query(`
        SELECT year(opening_date_parsed) as year, show_name, first_name, last_name, role, production_type, performances, show_category as category, opening_date_parsed, link_to_photo, fun_facts, photo_credit
        FROM clean_data ORDER BY year, show_name;
    `);

    // Mapeia o resultado do DuckDB para objetos JS puros para uso no D3.
    dadosOriginais = detailsResult.toArray().map(row => {
        const d = row.toJSON();
        return {
            year: Number(d.year), show_name: d.show_name, first_name: d.first_name, last_name: d.last_name, role: d.role,
            production_type: d.production_type, performances: d.performances ? Number(d.performances) : null,
            category: d.category, opening_date: d.opening_date_parsed ? new Date(d.opening_date_parsed) : null,
            "LINK TO PHOTO": d.link_to_photo, "PERSON FUN FACTS": d.fun_facts, "Photo Credit": d.photo_credit
        };
    });

    preencherDatalists(dadosOriginais);
    configurarFiltroAno(dadosOriginais);
    configurarEventosFiltros();
    
    // Inicia com a visualização padrão.
    aplicarFiltros('none');

    await conn.close();
    await db.terminate();
}

// Preenche os autocompletes (<datalist>) nativos do HTML para pesquisa.
function preencherDatalists(dados) {
    const shows = Array.from(new Set(dados.map(d => d.show_name).filter(Boolean))).sort();
    d3.select("#shows-list").selectAll("option").data(shows).join("option").attr("value", d => d);

    const pessoas = Array.from(new Set(dados.map(d => `${d.first_name} ${d.last_name}`).filter(n => n.trim() !== ""))).sort();
    d3.select("#people-list").selectAll("option").data(pessoas).join("option").attr("value", d => d);
}

// Popula dinamicamente o <select> de anos garantindo que apenas anos existentes nos dados apareçam.
function configurarFiltroAno(details) {
    const yearFilter = document.querySelector("#year-filter");
    if (!yearFilter) return;

    const years = Array.from(new Set(details.map(item => item.year)))
        .filter(year => Number.isFinite(year))
        .sort((a, b) => a - b);

    // Mantem o texto do HTML como principal para evitar mudanca visual.
    const defaultAllOption = yearFilter.querySelector("option[value=\"all\"]");
    const allLabel = defaultAllOption ? defaultAllOption.textContent : "All years";
    yearFilter.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = allLabel;
    yearFilter.appendChild(allOption);
    years.forEach(year => {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        yearFilter.appendChild(option);
    });
}

// Configura os Listeners. Intercepta 'input' e 'change' para re-renderizar a view.
function configurarEventosFiltros() {
    const showInput = d3.select("#search-show");
    const personInput = d3.select("#search-person");
    const yearFilter = document.querySelector("#year-filter");

    if (showInput.node()) showInput.on("input", () => aplicarFiltros('show'));
    if (personInput.node()) personInput.on("input", () => aplicarFiltros('person'));
    if (yearFilter) yearFilter.addEventListener("change", () => aplicarFiltros('year'));
}

// ----------------------------------------------------
// GERENCIADOR DE ESTADO (Roteador visual)
// ----------------------------------------------------
function aplicarFiltros(trigger) {
    const showInput = d3.select("#search-show");
    const personInput = d3.select("#search-person");
    const yearFilter = document.querySelector("#year-filter");

    // Lógica de Mutuamente Exclusivo:
    // Evita conflitos limpando os outros inputs dependendo de qual disparou a pesquisa.
    if (trigger === 'show' && showInput.property("value") !== "") {
        if (personInput.node()) personInput.property("value", "");
        if (yearFilter) yearFilter.value = "all";
    } else if (trigger === 'person' && personInput.property("value") !== "") {
        if (showInput.node()) showInput.property("value", "");
        if (yearFilter) yearFilter.value = "all";
    } else if (trigger === 'year' && yearFilter.value !== "all") {
        if (showInput.node()) showInput.property("value", "");
        if (personInput.node()) personInput.property("value", "");
    }

    const showTerm = showInput.node() ? showInput.property("value").toLowerCase() : "";
    const personTerm = personInput.node() ? personInput.property("value").toLowerCase() : "";
    const selectedYear = (yearFilter && yearFilter.value !== "all") ? Number(yearFilter.value) : null;

    const isFiltered = showTerm !== "" || personTerm !== "" || selectedYear !== null;

    // Filtra no frontend, combinando as regras dos inputs
    const dadosFiltrados = dadosOriginais.filter(d => {
        const matchShow = showTerm === "" || (d.show_name || "").toLowerCase().includes(showTerm);
        const matchPerson = personTerm === "" || `${d.first_name} ${d.last_name}`.toLowerCase().includes(personTerm);
        const matchYear = selectedYear === null || d.year === selectedYear;
        return matchShow && matchPerson && matchYear;
    });

    detailsTitle.text(DEFAULT_DETAILS_TITLE);
    detailsSubtitle.text(DEFAULT_DETAILS_SUBTITLE);
    detailsList.html("");
    
    // Limpa qualquer visualização anterior (SVG e ForeignObjects)
    svg.selectAll("*").remove();

    if (dadosFiltrados.length === 0) {
        svg.append("text").attr("x", width / 2).attr("y", height / 2).attr("text-anchor", "middle").style("fill", "#888").text("No results match your filters.");
        return;
    }

    // Define qual tipo de gráfico processar com base no tipo de filtro:
    if (isFiltered) {
        if (showTerm !== "") {
            // Filtro de Espetáculo (Apenas um data point): Card Detalhado ao centro (Sem Timeline)
            desenharCardCentral(dadosFiltrados);
        } else {
            // Filtro de Pessoa/Ano (Eventos sequenciais): Timeline de fatos
            desenharTimeline(dadosFiltrados, selectedYear, showTerm, personTerm);
        }
    } else {
        // Sem filtro: Visão panorâmica (Barras)
        desenharBarras(dadosFiltrados);
    }
}

// ----------------------------------------------------
// UTILS: RENDERIZAÇÃO NORMALIZADA DE CARDS
// ----------------------------------------------------
function renderizarListaPessoas(container, pessoas, showRichDetails) {
    container.selectAll("*").remove();

    if (showRichDetails) {
        // Manipulação de DOM para layouts complexos de cartões com fotos
        const personCards = container.selectAll("div.person-rich-card")
            .data(pessoas).enter().append("div").attr("class", "person-rich-card")
            .style("display", "flex").style("gap", "12px").style("margin-top", "12px").style("padding", "12px")
            .style("background", "#ffffff").style("border-radius", "8px").style("box-shadow", "0 1px 3px rgba(0,0,0,0.05)").style("border", "1px solid #eaeaea")
            .style("text-align", "left");

        personCards.each(function(row) {
            const card = d3.select(this);
            const photoUrl = row["LINK TO PHOTO"];
            
            if (photoUrl && photoUrl.trim() !== "") {
                const imgWrapper = card.append("div").style("flex-shrink", "0").style("width", "65px").style("text-align", "center");
                // Correção de distorção de imagem: Uso de object-fit "cover" para evitar que 
                // imagens com aspect ratios diferentes apareçam esticadas dentro do border-radius.
                imgWrapper.append("img").attr("src", photoUrl).attr("alt", `${row.first_name} ${row.last_name}`)
                    .style("width", "60px").style("height", "60px").style("object-fit", "cover").style("border-radius", "50%").style("border", "2px solid #eaeaea")
                    .on("error", function() { d3.select(this).style("display", "none"); }); // Fallback para links quebrados

                const photoCredit = row["Photo Credit"];
                if (photoCredit && photoCredit.trim() !== "") {
                    imgWrapper.append("div").style("font-size", "9px").style("color", "#888").style("margin-top", "4px").style("line-height", "1.1").style("word-break", "break-word").text(`© ${photoCredit}`);
                }
            }

            const textContainer = card.append("div").style("flex-grow", "1");
            textContainer.append("div").style("font-weight", "600").style("font-size", "14px").style("color", "var(--text-color, #222)").text(`${row.first_name} ${row.last_name}`);
            textContainer.append("div").style("font-size", "12px").style("color", "#666").style("margin-bottom", "6px").text(row.role);

            const funFact = row["PERSON FUN FACTS"];
            if (funFact && funFact.trim() !== "") {
                textContainer.append("div").style("font-size", "11px").style("font-style", "italic").style("color", "#555").style("background", "#f5f7fa")
                    .style("padding", "8px").style("border-left", `3px solid ${CATEGORY_COLORS[row.category] || '#4a90e2'}`).style("margin-top", "6px").style("border-radius", "0 4px 4px 0").text(funFact);
            }
        });
    } else {
        // Layout simplificado para evitar poluição visual na barra lateral
        const ul = container.append("ul").attr("class", "detail-people").style("margin-top", "8px").style("padding-left", "20px");
        ul.selectAll("li").data(pessoas).enter().append("li").style("font-size", "13px").style("margin-bottom", "4px").style("color", "var(--text-color)")
          .text(row => `${row.first_name} ${row.last_name} — ${row.role}`);
    }
}

// ----------------------------------------------------
// 3. VISÃO EXCLUSIVA DE ESPETÁCULO (CARD CENTRAL HTML)
// ----------------------------------------------------
function desenharCardCentral(baseDetails) {
    // Agrupa dados por show_name, já que um espetáculo pode ter múltiplas pessoas (linhas).
    const shows = Array.from(d3.group(baseDetails, d => d.show_name), ([show_name, rows]) => {
        return { show_name, opening_date: rows[0].opening_date, category: rows[0].category, performances: rows[0].performances, people: rows };
    }).sort((a, b) => a.opening_date - b.opening_date);

    // D3 Trick: Uso de foreignObject para envelopar código HTML puro (divs flex/scroll)
    // dentro de um SVG. Isso evita ter que calcular x/y manuais para textos que quebram linha.
    // Expande sobre margens aplicando offsets negativos (-margin.left/top).
    const fo = svg.append("foreignObject")
        .attr("x", -margin.left)
        .attr("y", -margin.top)
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom);

    const container = fo.append("xhtml:div")
        .style("width", "100%")
        .style("height", "100%")
        .style("overflow-y", "auto")
        .style("padding", "40px 20px")
        .style("box-sizing", "border-box")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center")
        .style("gap", "24px")
        .style("background-color", "rgba(250, 250, 250, 0.5)"); // Fundo suave sobreposto

    const cards = container.selectAll("div.central-card")
        .data(shows).enter().append("div").attr("class", "central-card")
        .style("width", "100%")
        .style("max-width", "600px") // Limite horizontal impõe leitura confortável (sem distorção de largura)
        .style("background", "#fff")
        .style("border-radius", "12px")
        .style("box-shadow", "0 4px 16px rgba(0,0,0,0.08)")
        .style("padding", "30px")
        .style("border-top", d => `6px solid ${CATEGORY_COLORS[d.category]}`); // Borda temática baseada na categoria

    cards.each(function(data) {
        const card = d3.select(this);
        
        // Correção de Fuso Horário (Distorção): Datas parsed do DuckDB costumam assumir UTC.
        // Adicionando o offset, prevenimos que o dia reverta pro dia anterior em fusos da américa do sul/norte.
        const dataFormatada = data.opening_date ? d3.timeFormat("%B %d, %Y")(new Date(data.opening_date.getTime() + data.opening_date.getTimezoneOffset() * 60000)) : "Unknown";

        const header = card.append("div").style("text-align", "center").style("margin-bottom", "24px");
        header.append("h2").style("margin", "0 0 12px 0").style("color", "var(--text-color)").style("font-size", "24px").text(data.show_name);
        
        const metaList = header.append("div").style("display", "flex").style("justify-content", "center").style("gap", "20px").style("font-size", "14px").style("color", "#666");
        metaList.append("span").html(`<strong>Opening:</strong> ${dataFormatada}`);
        
        if (Number.isFinite(data.performances)) {
            metaList.append("span").html(`<strong>Performances:</strong> ${data.performances}`);
        }
        
        header.append("div").style("margin-top", "16px")
            .append("span").style("background", `${CATEGORY_COLORS[data.category]}22`).style("color", CATEGORY_COLORS[data.category])
            .style("padding", "6px 12px").style("border-radius", "6px").style("font-size", "13px").style("font-weight", "bold").style("text-transform", "uppercase")
            .text(CATEGORY_LABELS[data.category]);

        const peopleContainer = card.append("div").attr("class", "detail-people-container");
        
        // Invoca as ricas UI de pessoas.
        renderizarListaPessoas(peopleContainer, data.people, true);
    });

    detailsTitle.text("Show Spotlight");
    detailsSubtitle.text(`Found ${shows.length} show(s) matching your search.`);
}

// ----------------------------------------------------
// 1. VISÃO GERAL: GRÁFICO DE BARRAS EMPILHADAS
// ----------------------------------------------------
function desenharBarras(details) {
    let pinnedKey = null; // Variável de estado para fixar o hover
    const detailsByKey = d3.group(details, d => d.year);

    function updateHighlight(key) {
        // Escurece barras não selecionadas (is-dimmed é controlado via CSS opacity)
        svg.selectAll("rect.year-overlay").classed("is-active", d => key !== null && d.key === key);
        svg.selectAll("g.bar-layer rect").classed("is-dimmed", d => key !== null && d.bucketKey !== key);
    }

    svg.append("rect")
        .attr("width", width).attr("height", height).attr("fill", "transparent")
        .on("click", () => {
            if (pinnedKey !== null) {
                pinnedKey = null;
                detailsTitle.text(DEFAULT_DETAILS_TITLE); detailsSubtitle.text(DEFAULT_DETAILS_SUBTITLE); detailsList.html(""); updateHighlight(null);
            }
        });

    // Agregação complexa de dados: Rollup por Ano
    // Calcula o total por categoria ("Revival" vs "New") ignorando duplicatas de pessoas do mesmo espetáculo.
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

    // Escalas
    // Banda X: Eixo categórico ordenado temporalmente, separando espaço visual.
    const x = d3.scaleBand().domain(dataByYear.map(d => d.key)).range([0, width]).padding(0.12);
    // Linear Y: Usando ".nice()" para evitar que a maior barra toque no limite superior da escala cruamente.
    const y = d3.scaleLinear().domain([0, maxTotal]).nice().range([height, 0]);

    svg.selectAll("line.grid-line").data(y.ticks(8)).enter().append("line").attr("class", "grid-line")
        .attr("x1", 0).attr("x2", width).attr("y1", d => y(d)).attr("y2", d => y(d));

    // Correção visual do eixo X: Oculta rótulos sobrepostos limitando a 1 por década ou qinqüênio se houver excesso.
    const xAxis = d3.axisBottom(x).tickValues(dataByYear.length > 15 ? dataByYear.filter(d => d.key % 5 === 0).map(d => d.key) : dataByYear.map(d => d.key)).tickFormat(d3.format("d"));
    svg.append("g").attr("class", "axis axis-x").attr("transform", `translate(0, ${height})`).call(xAxis);
    svg.append("g").attr("class", "axis axis-y").call(d3.axisLeft(y).ticks(8));

    svg.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -15).text("Total shows");

    // Lógica de empilhamento
    const stack = d3.stack().keys(CATEGORY_KEYS);
    const series = stack(dataByYear);

    // Renderiza as camadas
    const layers = svg.selectAll("g.bar-layer").data(series).enter().append("g").attr("class", "bar-layer").attr("fill", d => CATEGORY_COLORS[d.key]);
    layers.selectAll("rect").data(d => d.map(item => ({ key: d.key, bucketKey: item.data.key, y0: item[0], y1: item[1] }))).enter()
        .append("rect").attr("x", d => x(d.bucketKey)).attr("y", d => y(d.y1)).attr("height", d => y(d.y0) - y(d.y1)).attr("width", x.bandwidth())
        .style("pointer-events", "none"); 

    // Camada invisível interativa (Hitbox Overlay). Facilita o hover capturando área cheia, 
    // mesmo nos espaços vazios acima das barras.
    svg.selectAll("rect.year-overlay").data(dataByYear).enter().append("rect").attr("class", "year-overlay")
        .attr("x", d => x(d.key)).attr("y", 0).attr("width", x.bandwidth()).attr("height", height).attr("opacity", 0)
        .on("mouseover", (_, d) => { if (pinnedKey === null) { renderizarCardsLaterais(d.key, false, detailsByKey); updateHighlight(d.key); } })
        .on("mouseout", () => { if (pinnedKey === null) { detailsTitle.text(DEFAULT_DETAILS_TITLE); detailsSubtitle.text(DEFAULT_DETAILS_SUBTITLE); detailsList.html(""); updateHighlight(null); } })
        .on("click", (event, d) => {
            event.stopPropagation(); 
            pinnedKey = pinnedKey === d.key ? null : d.key;
            if (pinnedKey === null) {
                detailsTitle.text(DEFAULT_DETAILS_TITLE); detailsSubtitle.text(DEFAULT_DETAILS_SUBTITLE); detailsList.html(""); updateHighlight(null);
            } else {
                renderizarCardsLaterais(pinnedKey, true, detailsByKey); updateHighlight(pinnedKey);
            }
        });
}

function renderizarCardsLaterais(key, isPinned, detailsByKey) {
    const items = detailsByKey.get(key) || [];
    const grouped = d3.group(items, d => d.show_name);
    const totalShows = grouped.size; 

    detailsTitle.text(`Year of ${key}`);
    const pinText = isPinned ? "Selected. Click the column or empty space to clear." : "Click the column to pin the selection.";

    detailsSubtitle.html(`<span style="color: var(--text-color); font-weight: 700; font-size: 13px;">Total shows: ${totalShows}</span> <br> <span style="margin-top: 4px; display: inline-block;">${pinText}</span>`);

    const showItems = Array.from(grouped, ([show_name, rows]) => ({ show_name, people: rows, performances: rows[0].performances, category: rows[0].category }));

    // Update Pattern do D3 para listas DOM
    const cards = detailsList.selectAll("div.detail-item").data(showItems, d => d.show_name);
    cards.exit().remove();
    
    const cardsEnter = cards.enter().append("div").attr("class", "detail-item");
    cardsEnter.append("div").attr("class", "detail-show");
    cardsEnter.append("div").attr("class", "detail-people-container"); 

    const cardsMerge = cardsEnter.merge(cards);

    cardsMerge.select(".detail-show").each(function(d) {
        const container = d3.select(this);
        container.selectAll("*").remove();
        container.append("span").style("font-weight", "bold").style("display", "block").text(d.show_name);
        if (Number.isFinite(d.performances)) { container.append("div").attr("class", "detail-meta").style("margin-top", "6px").text(`Performances: ${d.performances}`); }
        container.append("span").attr("class", `detail-tag`).style("background", `${CATEGORY_COLORS[d.category]}22`).style("color", CATEGORY_COLORS[d.category]).style("margin-top", "8px").text(CATEGORY_LABELS[d.category]);
    });

    cardsMerge.select(".detail-people-container").each(function(d) {
        renderizarListaPessoas(d3.select(this), d.people, false);
    });
}

// ----------------------------------------------------
// 2. VISÃO DE LINHA DO TEMPO (PESSOAS/ANOS)
// ----------------------------------------------------
function desenharTimeline(baseDetails, selectedYear, showTerm, personTerm) {
    let pinnedShowName = null;

    svg.append("rect")
        .attr("width", width).attr("height", height).attr("fill", "transparent")
        .on("click", () => {
            if (pinnedShowName !== null) { pinnedShowName = null; updateTimelineHighlight(null, false, true); }
        });

    const shows = Array.from(d3.group(baseDetails, d => d.show_name), ([show_name, rows]) => {
        return { show_name, opening_date: rows[0].opening_date, category: rows[0].category, performances: rows[0].performances, people: rows };
    }).filter(d => d.opening_date).sort((a, b) => a.opening_date - b.opening_date);

    const dates = shows.map(d => d.opening_date);
    let minDate, maxDate;

    // Cálculo dinâmico do domínio: Ajusta a "janela" do tempo baseado no filtro.
    if (selectedYear !== null) {
        minDate = new Date(selectedYear, 0, 1);
        maxDate = new Date(selectedYear, 11, 31);
    } else {
        minDate = d3.min(dates); maxDate = d3.max(dates);
        // Fallback e margem de tempo ("Padding temporal") para evitar que nós no extremo 
        // toquem os eixos ou fiquem espremidos.
        if (!minDate || !maxDate) { minDate = new Date(2000, 0, 1); maxDate = new Date(2024, 11, 31); } 
        else if (minDate.getTime() === maxDate.getTime()) { minDate = d3.timeMonth.offset(minDate, -3); maxDate = d3.timeMonth.offset(maxDate, 3); } 
        else { minDate = d3.timeMonth.offset(minDate, -1); maxDate = d3.timeMonth.offset(maxDate, 1); }
    }

    // Escalas da Timeline
    // xTime mapeia nativamente objetos Date para o eixo horizontal
    const xTime = d3.scaleTime().domain([minDate, maxDate]).range([0, width]);
    // scalePoint alinha os espetáculos de forma uniforme no eixo vertical
    const yOrdinal = d3.scalePoint().domain(shows.map(d => d.show_name)).range([20, height - 30]).padding(0.5);

    // Resolução Dinâmica de Ticks (Correção de Distorção de Labels):
    // Impede a sobreposição (overlap) dos textos no eixo X trocando o formatador
    // baseado na diferença entre max e min, e a largura física atual da tela (width).
    const domainSpan = maxDate - minDate;
    const yearsSpan = domainSpan / (1000 * 60 * 60 * 24 * 365);
    
    let tickConfig, tickFormat;
    if (yearsSpan > 5) { tickConfig = d3.timeYear.every(1); tickFormat = d3.timeFormat("%Y"); } 
    else if (yearsSpan > 2) { tickConfig = width < 600 ? d3.timeYear.every(1) : d3.timeMonth.every(6); tickFormat = d3.timeFormat("%b %Y"); } 
    else if (yearsSpan > 1) { tickConfig = d3.timeMonth.every(3); tickFormat = d3.timeFormat("%b %Y"); } 
    else { tickConfig = width < 600 ? d3.timeMonth.every(2) : d3.timeMonth.every(1); tickFormat = d3.timeFormat("%b"); }

    const xAxis = d3.axisBottom(xTime).ticks(tickConfig).tickFormat(tickFormat).tickSizeOuter(0);
    svg.append("g").attr("class", "axis axis-x").attr("transform", `translate(0, ${height})`).call(xAxis).selectAll("text").style("text-transform", "capitalize").attr("dy", "1em");
    
    const labelTitle = selectedYear !== null ? "Shows opening throughout the year" : "Timeline of filtered results";
    svg.append("text").attr("class", "axis-label").attr("x", 0).attr("y", -15).text(labelTitle);

    // Linhas de queda (Lollipops) indicativas de posição
    const dropLines = svg.selectAll("line.drop-line").data(shows).enter().append("line").attr("class", "drop-line")
        .attr("x1", d => xTime(d.opening_date)).attr("x2", d => xTime(d.opening_date)).attr("y1", d => yOrdinal(d.show_name)).attr("y2", height)
        .attr("stroke", "var(--grid-color)").attr("stroke-dasharray", "4 4");

    const nodes = svg.selectAll("g.timeline-node").data(shows).enter().append("g").attr("class", "timeline-node")
        .attr("transform", d => `translate(${xTime(d.opening_date)}, ${yOrdinal(d.show_name)})`).style("cursor", "pointer");

    nodes.append("circle").attr("r", 7).attr("fill", d => CATEGORY_COLORS[d.category]).attr("stroke", "#fff").attr("stroke-width", 2);
    // Posiciona texto na direita ou esquerda dinamicamente para não cortar na borda direita (Distorção de overflow)
    nodes.append("text").attr("x", d => xTime(d.opening_date) > width * 0.75 ? -14 : 14).attr("y", 4)
        .attr("text-anchor", d => xTime(d.opening_date) > width * 0.75 ? "end" : "start").attr("font-weight", "bold").attr("font-size", "12px").attr("fill", "var(--text-color)").text(d => d.show_name);

    if (selectedYear !== null) detailsTitle.text(`Year of ${selectedYear}`);
    else if (personTerm) detailsTitle.text(`Career timeline`);
    
    detailsSubtitle.text("Hover over a point or line to highlight, click to pin.");

    const cards = detailsList.selectAll("div.detail-item").data(shows, d => d.show_name);
    cards.exit().remove();
    
    const cardsEnter = cards.enter().append("div").attr("class", "detail-item").attr("id", d => `card-${d.show_name.replace(/[^a-zA-Z0-9]/g, '-')}`);
    cardsEnter.append("div").attr("class", "detail-show");
    cardsEnter.append("div").attr("class", "detail-people-container");

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

    cardsMerge.select(".detail-people-container").each(function(d) {
        renderizarListaPessoas(d3.select(this), d.people, false);
    });

    // Animações complexas acopladas: Destaca no gráfico E altera opacidade na barra lateral simultaneamente.
    function updateTimelineHighlight(hoveredShowName, smoothScroll = true, updateRichCards = false) {
        const targetShow = hoveredShowName || pinnedShowName;

        svg.selectAll("g.timeline-node circle").attr("r", 7).attr("stroke", "#fff");
        svg.selectAll("g.timeline-node text").attr("opacity", targetShow ? 0.3 : 1);
        svg.selectAll("line.drop-line").classed("is-hovered", false).attr("opacity", targetShow ? 0.3 : 1);

        if (targetShow) {
            svg.selectAll("g.timeline-node").filter(d => d.show_name === targetShow).select("circle").attr("r", 10).attr("stroke", "#000");
            svg.selectAll("g.timeline-node").filter(d => d.show_name === targetShow).select("text").attr("opacity", 1);
            svg.selectAll("line.drop-line").filter(d => d.show_name === targetShow).classed("is-hovered", true).attr("opacity", 1);
                
            // Scroll Sync: Sincroniza o hover do gráfico com a rolagem automática da barra lateral.
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
            
        if (updateRichCards) {
            detailsList.selectAll("div.detail-item").select(".detail-people-container").each(function(d) {
                const isPinned = pinnedShowName === d.show_name;
                renderizarListaPessoas(d3.select(this), d.people, isPinned);
            });
        }
            
        if (pinnedShowName) { detailsSubtitle.text("Selected. Click the point, line, or empty space to clear."); }
        else if (hoveredShowName) { detailsSubtitle.text("Click the point or line to expand details."); }
        else { detailsSubtitle.text("Hover over a point or line to highlight, click to expand."); }
    }

    const handleMouseOver = (_, d) => updateTimelineHighlight(d.show_name);
    const handleMouseOut = () => updateTimelineHighlight(null, false);
    
    const handleClick = (event, d) => {
        event.stopPropagation(); 
        pinnedShowName = (pinnedShowName === d.show_name) ? null : d.show_name;
        updateTimelineHighlight(pinnedShowName ? d.show_name : null, true, true);
    };

    nodes.on("mouseover", handleMouseOver).on("mouseout", handleMouseOut).on("click", handleClick);
    dropLines.on("mouseover", handleMouseOver).on("mouseout", handleMouseOut).on("click", handleClick);
}

inicializarESQL();