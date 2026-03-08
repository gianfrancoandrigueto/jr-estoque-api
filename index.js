const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Cache de 30 minutos
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function scrapeDetalhe(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    const html = await res.text();
    const $ = cheerio.load(html);

    // Opcionais
    const opcionais = [];
    $(".veiculo-opcionais li.linha strong").each((i, el) => {
      let txt = $(el).text().trim();
      // Corrige encoding
      txt = txt.replace(/Dire..o/g, "Direcao").replace(/C.mbio/g, "Cambio")
        .replace(/El.tric/g, "Eletric").replace(/Hidr.ulic/g, "Hidraulic")
        .replace(/Autom.tic/g, "Automatic");
      if (txt) opcionais.push(txt);
    });

    // Dados da ficha (ano fab, cambio, portas, placa, etc)
    const dados = {};
    $(".detalhe-dados li, .detalhe-dados .item, .card-panel li").each((i, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text.includes(":")) {
        const parts = text.split(":");
        const key = parts[0].trim().toLowerCase();
        const val = parts.slice(1).join(":").trim();
        if (key && val) dados[key] = val;
      }
    });

    // Titulo completo
    const titulo = $(".titulo-veiculo, h1").first().text().replace(/\s+/g, " ").trim();

    // Descricao/observacao
    let descricao = "";
    $(".veiculo-detalhe, [class*=descri], [class*=observ]").each((i, el) => {
      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (txt.length > 20 && !descricao) descricao = txt.substring(0, 500);
    });

    // Ano fabricacao e modelo
    const anoFab = $(".detalhe-dados").text().match(/fabrica[çc][aã]o[:\s]*(\d{4})/i);
    const cambio = $(".detalhe-dados").text().match(/c[aâ]mbio[:\s]*([^\n,]+)/i);
    const portas = $(".detalhe-dados").text().match(/portas[:\s]*(\d)/i);
    const placa = $(".detalhe-dados").text().match(/placa[:\s]*([^\n,]+)/i);

    return {
      opcionais: opcionais,
      ano_fabricacao: anoFab ? anoFab[1] : null,
      cambio: cambio ? cambio[1].trim() : null,
      portas: portas ? portas[1] : null,
      final_placa: placa ? placa[1].trim() : null,
      descricao: descricao || null,
      dados_extras: Object.keys(dados).length > 0 ? dados : null,
    };
  } catch (err) {
    return { opcionais: [], erro: err.message };
  }
}

async function scrapeEstoque() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const url = "https://jrveiculospr.com.br/busca";
  const res = await fetch(url, { headers: HEADERS });
  const html = await res.text();
  const $ = cheerio.load(html);

  const veiculos = [];

  $("div.carro").each((i, el) => {
    const card = $(el);
    const modeloEl = card.find(".carro-info a[href*='/carros/']").first();
    const modelo = modeloEl.text().replace(/\s+/g, " ").trim();
    const href = modeloEl.attr("href") || card.find("a[href*='/carros/']").first().attr("href") || "";
    const link = href.startsWith("http") ? href : href ? "https://jrveiculospr.com.br" + href : null;
    const precoSpan = card.find(".carro-preco span[id^='valor_veic']").text().trim();
    const preco = precoSpan ? "R$ " + precoSpan : null;

    const infoItems = [];
    card.find(".resu-veiculo li").each((j, li) => {
      infoItems.push($(li).text().replace(/\s+/g, " ").trim());
    });

    const anoMatch = modelo.match(/^((?:19|20)\d{2})/);
    const ano = anoMatch ? anoMatch[1] : null;
    const nome = ano ? modelo.replace(/^\d{4}\s*/, "").trim() : modelo;

    let km = null, combustivel = null, cor = null;
    for (const info of infoItems) {
      if (info.match(/\d+.*km/i)) {
        const m = info.match(/([\d.,]+)\s*km/i);
        if (m) km = m[1] + " km";
      }
      if (info.match(/flex|diesel|gasolina|etanol|gnv/i)) combustivel = info.trim();
      if (info.match(/branco|prata|preto|cinza|vermelho|azul|verde|bege|marrom|dourado/i)) cor = info.trim();
    }

    if (nome) {
      veiculos.push({
        modelo: nome,
        ano: ano,
        preco: preco,
        km: km,
        combustivel: combustivel,
        cor: cor,
        link: link,
      });
    }
  });

  // Busca detalhes de cada veiculo em paralelo
  const detalhes = await Promise.all(
    veiculos.map((v) => (v.link ? scrapeDetalhe(v.link) : Promise.resolve({})))
  );

  for (let i = 0; i < veiculos.length; i++) {
    const d = detalhes[i];
    if (d) {
      veiculos[i].opcionais = d.opcionais || [];
      veiculos[i].cambio = d.cambio || null;
      veiculos[i].ano_fabricacao = d.ano_fabricacao || null;
      veiculos[i].portas = d.portas || null;
      veiculos[i].final_placa = d.final_placa || null;
      veiculos[i].descricao = d.descricao || null;
      if (d.dados_extras) veiculos[i].dados_extras = d.dados_extras;
    }
  }

  cache.data = veiculos;
  cache.timestamp = now;
  return veiculos;
}

// Endpoint principal - retorna estoque completo com detalhes
app.get("/estoque", async (req, res) => {
  try {
    const veiculos = await scrapeEstoque();
    res.json({
      total: veiculos.length,
      atualizacao: new Date().toISOString(),
      veiculos: veiculos,
    });
  } catch (err) {
    res.status(500).json({ erro: "Falha ao consultar estoque", detalhe: err.message });
  }
});

// Endpoint de busca - filtra por termo
app.get("/estoque/busca", async (req, res) => {
  try {
    const termo = (req.query.q || "").toLowerCase();
    const veiculos = await scrapeEstoque();
    const filtrados = termo
      ? veiculos.filter(
          (v) =>
            v.modelo.toLowerCase().includes(termo) ||
            (v.ano && v.ano.includes(termo)) ||
            (v.combustivel && v.combustivel.toLowerCase().includes(termo)) ||
            (v.cor && v.cor.toLowerCase().includes(termo)) ||
            (v.cambio && v.cambio.toLowerCase().includes(termo)) ||
            (v.opcionais && v.opcionais.some((o) => o.toLowerCase().includes(termo)))
        )
      : veiculos;

    res.json({
      busca: termo,
      total: filtrados.length,
      veiculos: filtrados,
    });
  } catch (err) {
    res.status(500).json({ erro: "Falha na busca", detalhe: err.message });
  }
});

// Endpoint para Conversation AI - retorna texto formatado com todos os detalhes
app.get("/estoque/texto", async (req, res) => {
  try {
    const termo = (req.query.q || "").toLowerCase();
    const veiculos = await scrapeEstoque();
    const filtrados = termo
      ? veiculos.filter(
          (v) =>
            v.modelo.toLowerCase().includes(termo) ||
            (v.ano && v.ano.includes(termo)) ||
            (v.combustivel && v.combustivel.toLowerCase().includes(termo)) ||
            (v.cor && v.cor.toLowerCase().includes(termo))
        )
      : veiculos;

    if (filtrados.length === 0) {
      res.json({
        resposta:
          "No momento nao temos veiculos com essas caracteristicas no estoque. Posso ajudar com outra busca?",
      });
      return;
    }

    let texto = "Estoque JR Veiculos - " + filtrados.length + " veiculo(s) disponivel(is):\n\n";
    filtrados.forEach((v, i) => {
      texto += "--- VEICULO " + (i + 1) + " ---\n";
      texto += "Modelo: " + v.modelo + "\n";
      if (v.ano) texto += "Ano Modelo: " + v.ano + "\n";
      if (v.ano_fabricacao) texto += "Ano Fabricacao: " + v.ano_fabricacao + "\n";
      if (v.preco) texto += "Preco: " + v.preco + "\n";
      if (v.km) texto += "Quilometragem: " + v.km + "\n";
      if (v.combustivel) texto += "Combustivel: " + v.combustivel + "\n";
      if (v.cor) texto += "Cor: " + v.cor + "\n";
      if (v.cambio) texto += "Cambio: " + v.cambio + "\n";
      if (v.portas) texto += "Portas: " + v.portas + "\n";
      if (v.final_placa) texto += "Final da Placa: " + v.final_placa + "\n";
      if (v.opcionais && v.opcionais.length > 0) {
        texto += "Opcionais: " + v.opcionais.join(", ") + "\n";
      }
      if (v.link) texto += "Link: " + v.link + "\n";
      texto += "\n";
    });

    res.json({ resposta: texto.trim() });
  } catch (err) {
    res.status(500).json({ erro: "Falha ao gerar resposta", detalhe: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    endpoints: ["/estoque", "/estoque/busca?q=termo", "/estoque/texto?q=termo"],
  });
});

app.listen(PORT, () => {
  console.log("API JR Veiculos rodando na porta " + PORT);
});
