const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Cache de 30 minutos para nao sobrecarregar o site
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000;

async function scrapeEstoque() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const url = "https://jrveiculospr.com.br/busca";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const veiculos = [];

  // Cada veiculo esta dentro de div.carro
  $("div.carro").each((i, el) => {
    const card = $(el);

    // Modelo: dentro de .carro-info, link com texto do modelo
    const modeloEl = card.find(".carro-info a[href*='/carros/']").first();
    const modelo = modeloEl.text().replace(/\s+/g, " ").trim();

    // Link do veiculo
    const href = modeloEl.attr("href") || card.find("a[href*='/carros/']").first().attr("href") || "";
    const link = href.startsWith("http") ? href : href ? "https://jrveiculospr.com.br" + href : null;

    // Preco: dentro de .carro-preco h3.preco span
    const precoSpan = card.find(".carro-preco span[id^='valor_veic']").text().trim();
    const preco = precoSpan ? "R$ " + precoSpan : null;

    // Info do veiculo: .resu-veiculo contém detalhes (combustivel, cor, ano, km)
    const infoItems = [];
    card.find(".resu-veiculo li").each((j, li) => {
      infoItems.push($(li).text().replace(/\s+/g, " ").trim());
    });

    // Extrai ano do modelo texto (ex: "2024 FIAT STRADA...")
    const anoMatch = modelo.match(/^((?:19|20)\d{2})/);
    const ano = anoMatch ? anoMatch[1] : null;

    // Extrai nome sem o ano
    const nome = ano ? modelo.replace(/^\d{4}\s*/, "").trim() : modelo;

    // Extrai km dos itens de info
    let km = null;
    let combustivel = null;
    let cor = null;
    for (const info of infoItems) {
      if (info.match(/\d+.*km/i)) {
        const kmMatch = info.match(/([\d.,]+)\s*km/i);
        if (kmMatch) km = kmMatch[1] + " km";
      }
      if (info.match(/flex|diesel|gasolina|etanol|gnv/i)) {
        combustivel = info.trim();
      }
      if (info.match(/branco|prata|preto|cinza|vermelho|azul|verde|bege|marrom|dourado/i)) {
        cor = info.trim();
      }
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

  cache.data = veiculos;
  cache.timestamp = now;
  return veiculos;
}

// Endpoint principal - retorna estoque completo
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
            (v.cor && v.cor.toLowerCase().includes(termo))
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

// Endpoint para Conversation AI - retorna texto formatado
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

    let texto = "Temos " + filtrados.length + " veiculo(s) disponivel(is):\n\n";
    filtrados.forEach((v, i) => {
      texto += (i + 1) + ". " + v.modelo;
      if (v.ano) texto += " - Ano: " + v.ano;
      if (v.preco) texto += " - " + v.preco;
      if (v.km) texto += " - " + v.km;
      if (v.combustivel) texto += " - " + v.combustivel;
      if (v.cor) texto += " - " + v.cor;
      if (v.link) texto += "\nLink: " + v.link;
      texto += "\n\n";
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
