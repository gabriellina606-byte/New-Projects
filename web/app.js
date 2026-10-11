// Leitor de Audiências — página web (envio, acompanhamento, conferência e Excel).

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Token (quando o servidor exige LEITOR_TOKEN, o ERP abre a página com ?token=)
// ---------------------------------------------------------------------------
const TOKEN = (() => {
  const daUrl = new URLSearchParams(location.search).get("token");
  try {
    if (daUrl) sessionStorage.setItem("audiencias.token", daUrl);
    return daUrl || sessionStorage.getItem("audiencias.token") || "";
  } catch {
    return daUrl || "";
  }
})();
if (TOKEN && new URLSearchParams(location.search).has("token")) {
  // Tira o token da barra de endereço (ele continua guardado nesta aba).
  const url = new URL(location.href);
  url.searchParams.delete("token");
  history.replaceState(null, "", url);
}

function comToken(url) {
  if (!TOKEN) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
}

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), ...(TOKEN ? { "X-Token": TOKEN } : {}) },
  });
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try {
      msg = (await resp.json()).erro || msg;
    } catch {
      /* resposta sem JSON */
    }
    throw new Error(msg);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const CAMPOS = [
  { chave: "status", classe: "c-status", lista: "opcoesStatus" },
  { chave: "data", classe: "c-data", tipo: "date" },
  { chave: "hora", classe: "c-hora", tipo: "time" },
  { chave: "hospital", classe: "c-hospital", multilinha: true },
  { chave: "reclamante", classe: "c-reclamante" },
  { chave: "processo", classe: "c-processo" },
  { chave: "vara", classe: "c-vara" },
  { chave: "modalidade", classe: "c-modalidade", lista: "opcoesModalidade" },
  { chave: "audiencias", classe: "c-audiencias", lista: "opcoesAudiencias" },
  { chave: "testemunhas", classe: "c-testemunhas", lista: "opcoesTestemunhas" },
  { chave: "observacao", classe: "c-observacao", multilinha: true },
  { chave: "link", classe: "c-link", multilinha: true },
];

let lote = null; // dados do servidor
let linhas = []; // cópia de trabalho (com as edições)
let arquivosEscolhidos = [];
let proximoId = 1;
const abertas = new Set(); // linhas com o detalhe aberto

const pendente = (l) => l.alertas.length > 0 && !l.conferida;

function prepararLinhas(doServidor) {
  return doServidor.map((l) => ({
    ...l,
    _id: proximoId++,
    _original: Object.fromEntries(CAMPOS.map((c) => [c.chave, l[c.chave] ?? ""])),
    conferida: false,
    alertas: l.alertas || [],
    fontes: l.fontes || [],
  }));
}

// Edições ficam guardadas no navegador, por leitura, para não se perderem num recarregamento.
const chaveLocal = () => `audiencias.lote.${lote.id}`;
function salvarLocal() {
  try {
    localStorage.setItem(chaveLocal(), JSON.stringify({ linhas, salvo: Date.now() }));
  } catch {
    /* armazenamento indisponível (modo privado): as edições valem só até fechar a página */
  }
  $("btnDesfazer").hidden = false;
}

function lerLocal() {
  try {
    const dados = JSON.parse(localStorage.getItem(chaveLocal()) || "null");
    if (dados?.linhas?.length) {
      for (const l of dados.linhas) proximoId = Math.max(proximoId, l._id + 1);
      return dados.linhas;
    }
  } catch {
    /* ignora */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------
function mostrarEtapa(nome) {
  for (const id of ["etapaEnvio", "etapaProcessando", "etapaResultado", "etapaErro"]) $(id).hidden = id !== nome;
  $("btnNova").hidden = nome === "etapaEnvio";
  $("btnExcel").hidden = nome !== "etapaResultado";
  if (nome !== "etapaResultado") fecharPdf();
}

function novaLeitura() {
  clearTimeout(timerAcompanhar);
  loteAcompanhado = null;
  lote = null;
  linhas = [];
  abertas.clear();
  history.replaceState(null, "", location.pathname + location.search);
  arquivosEscolhidos = [];
  renderizarArquivos();
  mostrarEtapa("etapaEnvio");
}

// ---------------------------------------------------------------------------
// 1. Envio
// ---------------------------------------------------------------------------
function tamanho(bytes) {
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function adicionarArquivos(lista) {
  const pdfs = [...lista].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (pdfs.length < lista.length) toast("Apenas arquivos PDF foram adicionados.");
  for (const f of pdfs) {
    if (!arquivosEscolhidos.some((a) => a.name === f.name && a.size === f.size)) arquivosEscolhidos.push(f);
  }
  renderizarArquivos();
}

function renderizarArquivos() {
  const ul = $("listaArquivos");
  ul.replaceChildren();
  arquivosEscolhidos.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<svg><use href="#i-file"/></svg><span></span><small></small>`;
    li.children[1].textContent = f.name;
    li.children[2].textContent = tamanho(f.size);
    const remover = document.createElement("button");
    remover.className = "btn icone";
    remover.title = "Remover";
    remover.setAttribute("aria-label", `Remover ${f.name}`);
    remover.innerHTML = `<svg><use href="#i-close"/></svg>`;
    remover.addEventListener("click", () => {
      arquivosEscolhidos.splice(i, 1);
      renderizarArquivos();
    });
    li.append(remover);
    ul.append(li);
  });
  $("acoesEnvio").hidden = arquivosEscolhidos.length === 0;
  $("btnLer").textContent =
    arquivosEscolhidos.length > 1 ? `Ler ${arquivosEscolhidos.length} arquivos` : "Ler notificações";
  $("erroEnvio").hidden = true;
}

async function enviar() {
  if (!arquivosEscolhidos.length) return;
  const form = new FormData();
  for (const f of arquivosEscolhidos) form.append("arquivos", f, f.name);
  $("btnLer").disabled = true;
  $("btnLer").textContent = "Enviando…";
  try {
    const { id } = await (await api("/api/lotes", { method: "POST", body: form })).json();
    location.hash = "lote=" + id;
    acompanhar(id);
  } catch (e) {
    $("erroEnvio").textContent = e.message;
    $("erroEnvio").hidden = false;
  } finally {
    $("btnLer").disabled = false;
    renderizarArquivos();
  }
}

// ---------------------------------------------------------------------------
// 2. Acompanhamento
// ---------------------------------------------------------------------------
let timerAcompanhar = 0;
let loteAcompanhado = null;

async function acompanhar(id) {
  clearTimeout(timerAcompanhar);
  loteAcompanhado = id;
  mostrarEtapa("etapaProcessando");
  let dados;
  try {
    dados = await (await api(`/api/lotes/${id}`)).json();
    if (id !== loteAcompanhado) return; // o usuário já foi para outra leitura
  } catch (e) {
    if (id !== loteAcompanhado) return;
    $("textoErro").textContent =
      e.message === "Erro 404" ? "Esta leitura não existe mais (as leituras antigas são apagadas)." : e.message;
    mostrarEtapa("etapaErro");
    return;
  }
  if (dados.status === "concluido") {
    lote = dados;
    abrirResultado();
    return;
  }
  if (dados.status === "erro") {
    $("textoErro").textContent = dados.erro;
    mostrarEtapa("etapaErro");
    return;
  }
  const n = dados.arquivos.length;
  let texto = "Preparando…";
  let fracao = 0;
  if (dados.status === "na_fila") {
    texto = dados.posicao_fila ? `Aguardando ${dados.posicao_fila} leitura(s) na fila…` : "Começando…";
  } else if (dados.progresso) {
    const { arquivo, pagina, paginas } = dados.progresso;
    const nome = dados.arquivos[arquivo]?.nome ?? "";
    fracao = (arquivo + (paginas ? Math.max(0, pagina - 1) / paginas : 0)) / n;
    texto = `${nome} — ${n > 1 ? `arquivo ${arquivo + 1} de ${n}, ` : ""}página ${pagina} de ${paginas}`;
  }
  $("tituloProgresso").textContent = n > 1 ? `Lendo ${n} arquivos…` : "Lendo as notificações…";
  $("textoProgresso").textContent = texto;
  $("barraProgresso").style.width = Math.round(fracao * 100) + "%";
  timerAcompanhar = setTimeout(() => acompanhar(id), 1200);
}

// ---------------------------------------------------------------------------
// 3. Resultado
// ---------------------------------------------------------------------------
function abrirResultado() {
  const salvas = lerLocal();
  linhas = salvas || prepararLinhas(lote.linhas);
  $("btnDesfazer").hidden = !salvas;
  const avisos = $("avisos");
  avisos.hidden = !lote.avisos.length;
  avisos.querySelector("summary").textContent = `${lote.avisos.length} aviso(s) da leitura`;
  const ul = avisos.querySelector("ul");
  ul.replaceChildren(...lote.avisos.map((a) => Object.assign(document.createElement("li"), { textContent: a })));
  mostrarEtapa("etapaResultado");
  renderizarTabela();
}

function atualizarResumo() {
  const total = linhas.length;
  const pend = linhas.filter(pendente).length;
  const arqs = lote.arquivos.length;
  const notifs = lote.notificacoes ?? 0;
  const el = $("resumoNumeros");
  el.innerHTML = "";
  const chip = (html, classe = "") => {
    const s = document.createElement("span");
    s.className = "chip " + classe;
    s.innerHTML = html;
    el.append(s);
  };
  chip(`<b>${total}</b> processo${total === 1 ? "" : "s"}`);
  chip(`<b>${notifs}</b> notificaç${notifs === 1 ? "ão" : "ões"} em ${arqs} arquivo${arqs === 1 ? "" : "s"}`);
  if (pend) chip(`<svg><use href="#i-alert"/></svg><b>${pend}</b> para conferir`, "pendente");
  else chip(`<svg><use href="#i-ok"/></svg>tudo conferido`, "ok");
}

function normalizar(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function linhaVisivel(l) {
  if ($("filtroAlertas").checked && !pendente(l)) return false;
  const q = normalizar($("filtroTexto").value.trim());
  if (!q) return true;
  return normalizar(CAMPOS.map((c) => l[c.chave]).join(" ") + " " + (l.destinatarios || []).join(" ")).includes(q);
}

function renderizarTabela() {
  const corpo = $("corpoTabela");
  corpo.replaceChildren();
  for (const l of linhas) {
    if (!linhaVisivel(l)) continue;
    corpo.append(criarLinha(l));
    if (abertas.has(l._id)) corpo.append(criarDetalhe(l));
  }
  if (!corpo.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = CAMPOS.length + 2;
    td.style.padding = "24px";
    td.style.textAlign = "center";
    td.style.color = "var(--texto-suave)";
    td.textContent = linhas.length ? "Nenhuma linha corresponde ao filtro." : "Nenhuma notificação encontrada nos arquivos.";
    tr.append(td);
    corpo.append(tr);
  }
  atualizarResumo();
}

function classeLinha(l) {
  return "linha" + (pendente(l) ? " pendente" : "") + (l.conferida ? " conferida" : "");
}

function criarLinha(l) {
  const tr = document.createElement("tr");
  tr.className = classeLinha(l);
  tr.dataset.id = l._id;

  const ctl = document.createElement("td");
  ctl.className = "ctl";
  const b = document.createElement("button");
  b.className = "botao-alerta";
  atualizarBotaoAlerta(b, l);
  b.addEventListener("click", () => alternarDetalhe(l));
  ctl.append(b);
  tr.append(ctl);

  for (const c of CAMPOS) {
    const td = document.createElement("td");
    td.className = c.classe;
    const campo = document.createElement(c.multilinha ? "textarea" : "input");
    if (!c.multilinha) campo.type = c.tipo || "text";
    if (c.multilinha) campo.rows = Math.min(4, Math.max(1, String(l[c.chave] || "").split("\n").length));
    if (c.lista) campo.setAttribute("list", c.lista);
    campo.value = l[c.chave] ?? "";
    campo.setAttribute("aria-label", c.chave);
    if (l._original && campo.value !== (l._original[c.chave] ?? "")) campo.classList.add("editado");
    campo.addEventListener("input", () => {
      l[c.chave] = campo.value;
      campo.classList.toggle("editado", !l._original || campo.value !== (l._original[c.chave] ?? ""));
      salvarLocal();
    });
    td.append(campo);
    tr.append(td);
  }

  const rem = document.createElement("td");
  rem.className = "ctl";
  const br = document.createElement("button");
  br.className = "botao-alerta";
  br.title = "Remover linha";
  br.setAttribute("aria-label", "Remover linha");
  br.innerHTML = `<svg><use href="#i-trash"/></svg>`;
  br.addEventListener("click", () => {
    if (!confirm(`Remover a linha${l.processo ? " do processo " + l.processo : ""}?`)) return;
    linhas = linhas.filter((x) => x !== l);
    salvarLocal();
    renderizarTabela();
  });
  rem.append(br);
  tr.append(rem);
  return tr;
}

function atualizarBotaoAlerta(b, l) {
  const n = l.alertas.length;
  const icone = pendente(l) ? "i-alert" : n || l.conferida ? "i-ok" : "i-chevron";
  b.innerHTML = `<svg><use href="#${icone}"/></svg>`;
  b.title = pendente(l)
    ? `${n} ponto(s) para conferir — clique para ver`
    : l.conferida
      ? "Conferida — clique para ver detalhes"
      : "Ver detalhes e documento";
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-expanded", String(abertas.has(l._id)));
}

function alternarDetalhe(l, abrir = !abertas.has(l._id)) {
  if (abrir) abertas.add(l._id);
  else abertas.delete(l._id);
  renderizarTabela();
  if (abrir && l.fontes.length) abrirPdf(l, 0);
}

function criarDetalhe(l) {
  const tr = document.createElement("tr");
  tr.className = "detalhe";
  const td = document.createElement("td");
  td.colSpan = CAMPOS.length + 2;
  const grade = document.createElement("div");
  grade.className = "detalhe-grade";

  const colAlertas = document.createElement("div");
  colAlertas.innerHTML = "<h3>Pontos para conferir</h3>";
  if (l.alertas.length) {
    const ul = document.createElement("ul");
    for (const a of l.alertas) ul.append(Object.assign(document.createElement("li"), { textContent: a }));
    colAlertas.append(ul);
  } else {
    colAlertas.append(Object.assign(document.createElement("p"), { className: "sem-alertas", textContent: "Nenhum alerta." }));
  }
  if (l.alertas.length) {
    const lbl = document.createElement("label");
    lbl.className = "chave conferir";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = l.conferida;
    cb.addEventListener("change", () => {
      l.conferida = cb.checked;
      salvarLocal();
      renderizarTabela();
    });
    lbl.append(cb, " Conferido (tira o destaque amarelo da planilha)");
    colAlertas.append(lbl);
  }

  const colDest = document.createElement("div");
  colDest.innerHTML = "<h3>Como está no documento</h3>";
  const ulD = document.createElement("ul");
  if (l.reclamante_original) ulD.append(Object.assign(document.createElement("li"), { textContent: "Reclamante: " + l.reclamante_original }));
  for (const d of l.destinatarios || []) ulD.append(Object.assign(document.createElement("li"), { textContent: "Destinatário: " + d }));
  if (l.outros) ulD.append(Object.assign(document.createElement("li"), { textContent: `E outros (${l.outros})` }));
  if (!ulD.children.length) ulD.append(Object.assign(document.createElement("li"), { textContent: "Linha adicionada manualmente." }));
  colDest.append(ulD);

  const colFontes = document.createElement("div");
  colFontes.innerHTML = "<h3>Documento original</h3>";
  const fontes = document.createElement("div");
  fontes.className = "fontes";
  l.fontes.forEach((f, i) => {
    const b = document.createElement("button");
    b.className = "btn secundario";
    b.innerHTML = `<svg><use href="#i-eye"/></svg><span></span>`;
    b.lastChild.textContent = `${f.arquivo} · p. ${f.pagina}`;
    b.addEventListener("click", () => abrirPdf(l, i));
    fontes.append(b);
  });
  if (!l.fontes.length) fontes.textContent = "—";
  colFontes.append(fontes);

  grade.append(colAlertas, colDest, colFontes);
  td.append(grade);
  tr.append(td);
  return tr;
}

// ---------------------------------------------------------------------------
// Painel com o PDF original (usa o visualizador do projeto)
// ---------------------------------------------------------------------------
function indiceArquivo(nome) {
  return lote.arquivos.findIndex((a) => a.nome === nome);
}

function abrirPdf(l, i) {
  const f = l.fontes[i];
  const k = indiceArquivo(f?.arquivo);
  if (!f || k < 0) return;
  const arquivo = comToken(`/api/lotes/${lote.id}/arquivos/${k}`);
  const params = new URLSearchParams({ arquivo, nome: f.arquivo, pagina: f.pagina, sidebar: "0", abrir: "0", zoom: "largura" });
  const frame = $("framePdf");
  const src = `/visualizador/index.html?${params}`;
  if (frame.dataset.src !== src) {
    frame.src = src;
    frame.dataset.src = src;
  }
  $("linkTexto").href = comToken(`/api/lotes/${lote.id}/texto/${k}`);

  const abas = $("abasPdf");
  abas.replaceChildren();
  l.fontes.forEach((fo, j) => {
    const b = document.createElement("button");
    b.textContent = `${fo.arquivo} · p. ${fo.pagina}`;
    b.className = j === i ? "ativa" : "";
    b.addEventListener("click", () => abrirPdf(l, j));
    abas.append(b);
  });
  $("painelPdf").hidden = false;
  document.body.classList.add("com-pdf");
  document.querySelectorAll("tr.linha.selecionada").forEach((t) => t.classList.remove("selecionada"));
  document.querySelector(`tr.linha[data-id="${l._id}"]`)?.classList.add("selecionada");
}

function fecharPdf() {
  $("painelPdf").hidden = true;
  document.body.classList.remove("com-pdf");
  document.querySelectorAll("tr.linha.selecionada").forEach((t) => t.classList.remove("selecionada"));
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
async function baixarExcel() {
  const botao = $("btnExcel");
  botao.disabled = true;
  try {
    const corpo = {
      linhas: linhas.map((l) => {
        const saida = { ...l, alertas: l.conferida ? [] : l.alertas };
        for (const k of Object.keys(saida)) if (k.startsWith("_")) delete saida[k];
        return saida;
      }),
    };
    const resp = await api(`/api/lotes/${lote.id}/excel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const nome = decodeURIComponent(resp.headers.get("X-Nome-Arquivo") || "Audiências.xlsx");
    const url = URL.createObjectURL(await resp.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: nome });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const pend = linhas.filter(pendente).length;
    toast(pend ? `Excel gerado. ${pend} linha(s) ainda marcadas em amarelo para conferir.` : "Excel gerado.");
  } catch (e) {
    toast("Não foi possível gerar o Excel: " + e.message);
  } finally {
    botao.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Diversos
// ---------------------------------------------------------------------------
let timerToast = 0;
function toast(texto) {
  const el = $("toast");
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => (el.hidden = true), 4500);
}

async function verificarServidor() {
  try {
    const s = await (await api("/api/saude")).json();
    if (!s.portugues) $("dicaServidor").textContent = "Atenção: o Tesseract do servidor está sem o idioma português; a leitura pode piorar.";
  } catch (e) {
    $("dicaServidor").textContent = "Atenção: " + e.message;
  }
}

// Eventos
const areaSoltar = $("areaSoltar");
$("inputArquivos").addEventListener("change", (e) => {
  adicionarArquivos(e.target.files);
  e.target.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  areaSoltar.addEventListener(ev, (e) => {
    e.preventDefault();
    areaSoltar.classList.add("arrastando");
  });
}
for (const ev of ["dragleave", "drop"]) areaSoltar.addEventListener(ev, () => areaSoltar.classList.remove("arrastando"));
areaSoltar.addEventListener("drop", (e) => {
  e.preventDefault();
  adicionarArquivos(e.dataTransfer.files);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!$("etapaEnvio").hidden) adicionarArquivos(e.dataTransfer.files);
});

$("btnLer").addEventListener("click", enviar);
$("btnLimparArquivos").addEventListener("click", () => {
  arquivosEscolhidos = [];
  renderizarArquivos();
});
$("btnNova").addEventListener("click", () => {
  if (lote && !confirm("Começar uma nova leitura? As edições desta continuam salvas neste navegador.")) return;
  novaLeitura();
});
$("btnTentarNovamente").addEventListener("click", novaLeitura);
$("btnExcel").addEventListener("click", baixarExcel);
$("btnFecharPdf").addEventListener("click", fecharPdf);
$("filtroTexto").addEventListener("input", renderizarTabela);
$("filtroAlertas").addEventListener("change", renderizarTabela);
$("btnAdicionar").addEventListener("click", () => {
  const l = {
    ...Object.fromEntries(CAMPOS.map((c) => [c.chave, ""])),
    status: "Agendada",
    alertas: [],
    fontes: [],
    destinatarios: [],
    _id: proximoId++,
    _original: null,
    conferida: false,
  };
  linhas.push(l);
  $("filtroTexto").value = "";
  salvarLocal();
  renderizarTabela();
  document.querySelector(`tr.linha[data-id="${l._id}"] input`)?.focus();
});
$("btnDesfazer").addEventListener("click", () => {
  if (!confirm("Descartar todas as edições e voltar ao resultado original da leitura?")) return;
  try {
    localStorage.removeItem(chaveLocal());
  } catch {
    /* ignora */
  }
  linhas = prepararLinhas(lote.linhas);
  $("btnDesfazer").hidden = true;
  renderizarTabela();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("painelPdf").hidden) fecharPdf();
});
window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("lote");
  if (id && id !== loteAcompanhado) acompanhar(id);
});

// Largura visível da tabela (usada pelo painel de detalhes, que fica fixo à esquerda).
new ResizeObserver(([e]) => {
  $("tabela").style.setProperty("--largura-visivel", e.contentRect.width + "px");
}).observe(document.querySelector(".tabela-wrap"));

// Início
verificarServidor();
const loteInicial = new URLSearchParams(location.hash.slice(1)).get("lote");
if (loteInicial) acompanhar(loteInicial);
else mostrarEtapa("etapaEnvio");
