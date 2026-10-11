// Leitor de PDF para o ERP — renderização com pdf.js (mozilla/pdf.js).
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import CONFIG_PADRAO from "./config.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

const CSS_POR_PT = pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS; // 96 / 72
const PASSOS_ZOOM = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10;
const MARGEM_HORIZONTAL = 20;
const MARGEM_VERTICAL = 16;
const LARGURA_MINIATURA = 140;
const MAX_PIXELS_CANVAS = 16_777_216; // limite seguro para a maioria dos navegadores
const ID_MENSAGEM = "leitor-pdf";

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  area: $("areaVisualizacao"),
  paginas: $("paginas"),
  sidebar: $("sidebar"),
  miniaturas: $("painelMiniaturas"),
  sumario: $("painelSumario"),
  abaMiniaturas: $("abaMiniaturas"),
  abaSumario: $("abaSumario"),
  inputPagina: $("inputPagina"),
  totalPaginas: $("totalPaginas"),
  selectZoom: $("selectZoom"),
  opcaoZoomCustom: $("opcaoZoomCustom"),
  nomeArquivo: $("nomeArquivo"),
  inputArquivo: $("inputArquivo"),
  barraBusca: $("barraBusca"),
  inputBusca: $("inputBusca"),
  statusBusca: $("statusBusca"),
  estadoCarregando: $("estadoCarregando"),
  textoCarregando: $("textoCarregando"),
  progressoCarregando: $("progressoCarregando"),
  estadoErro: $("estadoErro"),
  textoErro: $("textoErro"),
  soltarArquivo: $("soltarArquivo"),
  dialogoSenha: $("dialogoSenha"),
  textoSenha: $("textoSenha"),
  inputSenha: $("inputSenha"),
  dialogoAjuda: $("dialogoAjuda"),
  aviso: $("aviso"),
  areaImpressao: $("areaImpressao"),
};

// ---------------------------------------------------------------------------
// Configuração (config.js + parâmetros da URL)
// ---------------------------------------------------------------------------
const params = lerParametros();
const config = { ...CONFIG_PADRAO };
if (params.get("download") === "0") config.permitirDownload = false;
if (params.get("impressao") === "0") config.permitirImpressao = false;
if (params.get("abrir") === "0") config.permitirAbrirArquivoLocal = false;
if (params.has("marcadagua")) config.marcaDagua = params.get("marcadagua");
if (params.has("zoom")) config.zoomInicial = interpretarZoom(params.get("zoom")) ?? config.zoomInicial;

function lerParametros() {
  const p = new URLSearchParams(location.search);
  // Também aceita parâmetros no hash (#pagina=3&zoom=150), como o pdf.js.
  const hash = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of hash) if (!p.has(k)) p.set(k, v);
  // Sinônimos em inglês para facilitar integração.
  for (const [en, pt] of [["file", "arquivo"], ["page", "pagina"], ["search", "busca"], ["name", "nome"]]) {
    if (p.has(en) && !p.has(pt)) p.set(pt, p.get(en));
  }
  return p;
}

function interpretarZoom(valor) {
  if (valor == null) return null;
  const v = String(valor).trim().toLowerCase();
  const nomes = { auto: "auto", largura: "page-width", "page-width": "page-width", pagina: "page-fit", "page-fit": "page-fit" };
  if (nomes[v]) return nomes[v];
  let n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (v.endsWith("%") || n > 10) n /= 100;
  return limitar(n, ZOOM_MIN, ZOOM_MAX);
}

const origensPermitidas = new Set([location.origin, ...(config.origensPermitidas || [])]);
const aceitaQualquerOrigem = origensPermitidas.has("*");
function origemPermitida(origem) {
  return aceitaQualquerOrigem || origensPermitidas.has(origem);
}

// ---------------------------------------------------------------------------
// Preferências locais (tema, painel lateral)
// ---------------------------------------------------------------------------
const preferencias = {
  ler(chave, padrao) {
    try {
      const v = localStorage.getItem("leitorPdf." + chave);
      return v === null ? padrao : JSON.parse(v);
    } catch {
      return padrao;
    }
  },
  gravar(chave, valor) {
    try {
      localStorage.setItem("leitorPdf." + chave, JSON.stringify(valor));
    } catch {
      /* armazenamento indisponível (modo privado, iframe bloqueado) */
    }
  },
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const estado = {
  doc: null,
  tarefaCarregamento: null,
  idDoc: 0,
  nome: "",
  paginas: [], // PaginaView[]
  escala: 1, // 1 = 100%
  valorZoom: config.zoomInicial, // "auto" | "page-fit" | "page-width" | número
  rotacao: 0,
  paginaAtual: 1,
  visiveis: new Set(),
  textos: new Map(), // número da página -> Promise<InfoTexto>
};

const busca = {
  termo: "",
  resultados: [], // { pagina, inicio, fim }
  porPagina: new Map(), // pagina -> índices em resultados
  atual: -1,
  token: 0,
  concluida: false,
  rolarParaAtual: false,
};

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
class PaginaView {
  constructor(numero, largura, altura) {
    this.numero = numero;
    this.largura = largura; // em pontos PDF, já com a rotação própria da página
    this.altura = altura;
    this.tamanhoConfirmado = false;
    this.pdfPage = null;
    this.status = "vazia"; // vazia | renderizando | pronta
    this.tarefaRender = null;
    this.camadaTexto = null;
    this.textDivs = null;
    this.textStrs = null;
    this.divsDestacados = [];

    this.div = document.createElement("div");
    this.div.className = "pagina";
    this.div.dataset.pagina = numero;
    this.div.setAttribute("role", "region");
    this.div.setAttribute("aria-label", `Página ${numero}`);
    this.carregando = document.createElement("div");
    this.carregando.className = "carregando-pagina";
    this.carregando.textContent = `Página ${numero}`;
    this.div.append(this.carregando);
    this.atualizarTamanho();
  }

  get escalaViewport() {
    return estado.escala * CSS_POR_PT;
  }

  atualizarTamanho() {
    const girada = estado.rotacao % 180 !== 0;
    const s = this.escalaViewport;
    const w = (girada ? this.altura : this.largura) * s;
    const h = (girada ? this.largura : this.altura) * s;
    this.div.style.width = Math.floor(w) + "px";
    this.div.style.height = Math.floor(h) + "px";
    this.div.style.setProperty("--scale-factor", s);
  }

  async obterPagina() {
    if (!this.pdfPage) {
      this.pdfPage = await estado.doc.getPage(this.numero);
      if (this.definirTamanhoReal(this.pdfPage)) this.atualizarTamanho();
    }
    return this.pdfPage;
  }

  definirTamanhoReal(pdfPage) {
    const vp = pdfPage.getViewport({ scale: 1 });
    this.tamanhoConfirmado = true;
    if (Math.abs(vp.width - this.largura) > 0.5 || Math.abs(vp.height - this.altura) > 0.5) {
      this.largura = vp.width;
      this.altura = vp.height;
      return true;
    }
    return false;
  }

  viewport(pdfPage, escala = this.escalaViewport) {
    return pdfPage.getViewport({ scale: escala, rotation: (pdfPage.rotate + estado.rotacao) % 360 });
  }

  async renderizar() {
    if (this.status !== "vazia") return;
    this.status = "renderizando";
    const idDoc = estado.idDoc;
    try {
      const pdfPage = await this.obterPagina();
      if (idDoc !== estado.idDoc || this.status !== "renderizando") return;

      const vp = this.viewport(pdfPage);
      let fator = window.devicePixelRatio || 1;
      const pixels = vp.width * vp.height * fator * fator;
      if (pixels > MAX_PIXELS_CANVAS) fator = Math.sqrt(MAX_PIXELS_CANVAS / (vp.width * vp.height));

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width * fator));
      canvas.height = Math.max(1, Math.floor(vp.height * fator));
      canvas.setAttribute("aria-hidden", "true");
      const ctx = canvas.getContext("2d", { alpha: false });
      this.tarefaRender = pdfPage.render({
        canvasContext: ctx,
        viewport: vp,
        transform: fator !== 1 ? [fator, 0, 0, fator, 0, 0] : null,
      });
      await this.tarefaRender.promise;
      this.tarefaRender = null;
      if (idDoc !== estado.idDoc || this.status !== "renderizando") return;

      // Troca o canvas antigo (esticado durante o zoom) pelo novo, sem piscar.
      this.div.querySelectorAll("canvas").forEach((c) => c.remove());
      this.carregando.hidden = true;
      this.div.prepend(canvas);

      this.renderizarMarcaDagua();
      await this.renderizarCamadaTexto(pdfPage, vp, idDoc);
      await this.renderizarLinks(pdfPage, vp, idDoc);
      if (this.status === "renderizando") this.status = "pronta";
    } catch (erro) {
      if (erro?.name === "RenderingCancelledException") return;
      if (idDoc !== estado.idDoc) return;
      console.error(`Erro ao renderizar a página ${this.numero}`, erro);
      this.status = "vazia";
      this.carregando.hidden = false;
      this.carregando.textContent = `Erro ao exibir a página ${this.numero}`;
    }
  }

  async renderizarCamadaTexto(pdfPage, vp, idDoc) {
    this.div.querySelector(".textLayer")?.remove();
    const info = await obterTexto(this.numero);
    if (idDoc !== estado.idDoc || this.status !== "renderizando") return;
    const container = document.createElement("div");
    container.className = "textLayer";
    this.div.append(container);
    const camada = new pdfjsLib.TextLayer({ textContentSource: info.conteudo, container, viewport: vp });
    this.camadaTexto = camada;
    await camada.render();
    if (this.camadaTexto !== camada) return;
    const fim = document.createElement("div");
    fim.className = "endOfContent";
    container.append(fim);
    container.addEventListener("mousedown", () => container.classList.add("selecionando"));
    this.textDivs = camada.textDivs;
    this.textStrs = camada.textContentItemsStr;
    this.divsDestacados = [];
    aplicarDestaques(this);
  }

  async renderizarLinks(pdfPage, vp, idDoc) {
    this.div.querySelector(".camada-links")?.remove();
    let anotacoes;
    try {
      anotacoes = await pdfPage.getAnnotations({ intent: "display" });
    } catch {
      return;
    }
    if (idDoc !== estado.idDoc || this.status !== "renderizando") return;
    const links = anotacoes.filter((a) => a.subtype === "Link" && (a.url || a.dest || a.unsafeUrl));
    if (!links.length) return;
    const camada = document.createElement("div");
    camada.className = "camada-links";
    for (const link of links) {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(link.rect);
      const a = document.createElement("a");
      a.style.left = (Math.min(x1, x2) / vp.width) * 100 + "%";
      a.style.top = (Math.min(y1, y2) / vp.height) * 100 + "%";
      a.style.width = (Math.abs(x2 - x1) / vp.width) * 100 + "%";
      a.style.height = (Math.abs(y2 - y1) / vp.height) * 100 + "%";
      const url = urlSegura(link.url || link.unsafeUrl);
      if (url) {
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = url;
      } else if (link.dest) {
        a.href = "#";
        a.title = "Ir para o destino no documento";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          irParaDestino(link.dest);
        });
      } else {
        continue;
      }
      camada.append(a);
    }
    this.div.append(camada);
  }

  renderizarMarcaDagua() {
    this.div.querySelector(".marca-dagua")?.remove();
    if (!config.marcaDagua) return;
    const marca = document.createElement("div");
    marca.className = "marca-dagua";
    const span = document.createElement("span");
    span.textContent = config.marcaDagua;
    const girada = estado.rotacao % 180 !== 0;
    const tamanho = tamanhoMarcaDagua(girada ? this.altura : this.largura);
    span.style.fontSize = `calc(var(--scale-factor) * ${tamanho}px)`;
    marca.append(span);
    this.div.append(marca);
  }

  // Descarta a renderização atual. Se manterCanvas, o canvas antigo continua
  // visível (esticado) até a nova renderização ficar pronta.
  invalidar(manterCanvas = false) {
    if (this.tarefaRender) {
      this.tarefaRender.cancel();
      this.tarefaRender = null;
    }
    this.camadaTexto?.cancel?.();
    this.camadaTexto = null;
    this.textDivs = null;
    this.textStrs = null;
    this.divsDestacados = [];
    this.div.querySelectorAll(".textLayer, .camada-links, .marca-dagua").forEach((n) => n.remove());
    if (!manterCanvas) {
      this.div.querySelectorAll("canvas").forEach((c) => {
        c.width = c.height = 0; // libera memória rapidamente
        c.remove();
      });
      this.carregando.hidden = false;
      this.carregando.textContent = `Página ${this.numero}`;
    }
    this.status = "vazia";
  }

  liberar() {
    this.invalidar(false);
    if (this.pdfPage) this.pdfPage.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Fila de renderização: renderiza as páginas visíveis, mais próximas primeiro.
// ---------------------------------------------------------------------------
let renderizando = false;
let timerRender = 0;

function agendarRender(atraso = 0) {
  clearTimeout(timerRender);
  timerRender = setTimeout(processarFila, atraso);
}

async function processarFila() {
  if (renderizando) return;
  renderizando = true;
  try {
    for (;;) {
      const pendentes = [...estado.visiveis]
        .map((n) => estado.paginas[n - 1])
        .filter((p) => p && p.status === "vazia");
      if (!pendentes.length) break;
      pendentes.sort((a, b) => Math.abs(a.numero - estado.paginaAtual) - Math.abs(b.numero - estado.paginaAtual));
      await pendentes[0].renderizar();
    }
  } finally {
    renderizando = false;
  }
}

const observadorPaginas = new IntersectionObserver(
  (entradas) => {
    for (const entrada of entradas) {
      const numero = Number(entrada.target.dataset.pagina);
      const pagina = estado.paginas[numero - 1];
      if (!pagina) continue;
      if (entrada.isIntersecting) {
        estado.visiveis.add(numero);
      } else {
        estado.visiveis.delete(numero);
        if (pagina.status !== "vazia" || pagina.div.querySelector("canvas")) pagina.liberar();
      }
    }
    agendarRender();
  },
  { root: el.area, rootMargin: "120% 0px" },
);

// ---------------------------------------------------------------------------
// Abertura de documentos
// ---------------------------------------------------------------------------
function urlSegura(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function urlDeArquivoPermitida(url) {
  try {
    const u = new URL(url, location.href);
    if (u.protocol === "blob:") return u.origin === location.origin;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return origemPermitida(u.origin);
  } catch {
    return false;
  }
}

function nomeDaUrl(url) {
  try {
    const u = new URL(url, location.href);
    const ultimo = decodeURIComponent(u.pathname.split("/").pop() || "");
    return ultimo || "documento.pdf";
  } catch {
    return "documento.pdf";
  }
}

async function fecharDocumento() {
  estado.idDoc++;
  busca.token++;
  for (const p of estado.paginas) {
    observadorPaginas.unobserve(p.div);
    p.invalidar(false);
  }
  observadorMiniaturas.disconnect();
  estado.paginas = [];
  estado.visiveis.clear();
  estado.textos.clear();
  el.paginas.replaceChildren();
  el.miniaturas.replaceChildren();
  el.sumario.replaceChildren();
  limparBusca(false);
  const tarefa = estado.tarefaCarregamento;
  estado.tarefaCarregamento = null;
  estado.doc = null;
  if (tarefa) await tarefa.destroy().catch(() => {});
}

/**
 * Abre um PDF. Origem: { url } ou { dados: ArrayBuffer | Uint8Array | Blob }.
 * Opções: nome, pagina, busca.
 */
async function abrirDocumento({ url, dados, nome, pagina, busca: termoBusca } = {}) {
  await fecharDocumento();
  const idDoc = estado.idDoc;
  esconderErro();
  el.app.classList.remove("sem-documento");
  mostrarCarregando("Carregando documento…", 0);

  const fonte = {
    cMapUrl: VENDOR + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: VENDOR + "standard_fonts/",
    isEvalSupported: false,
    enableXfa: false,
  };
  try {
    if (dados) {
      if (dados instanceof Blob) dados = await dados.arrayBuffer();
      fonte.data = dados instanceof Uint8Array ? dados : new Uint8Array(dados);
      estado.nome = nome || "documento.pdf";
    } else if (url) {
      if (!urlDeArquivoPermitida(url)) {
        throw Object.assign(new Error("Origem do arquivo não permitida."), { name: "OrigemNaoPermitida" });
      }
      fonte.url = new URL(url, location.href).href;
      fonte.withCredentials = !!config.enviarCredenciais;
      estado.nome = nome || nomeDaUrl(url);
    } else {
      throw new Error("Nenhum arquivo informado.");
    }
  } catch (erro) {
    if (idDoc === estado.idDoc) falhaAoAbrir(erro);
    return;
  }

  el.nomeArquivo.textContent = estado.nome;
  el.nomeArquivo.title = estado.nome;
  document.title = `${estado.nome} — Leitor de PDF`;

  const tarefa = pdfjsLib.getDocument(fonte);
  estado.tarefaCarregamento = tarefa;
  tarefa.onProgress = ({ loaded, total }) => {
    if (total) mostrarCarregando("Carregando documento…", loaded / total);
  };
  tarefa.onPassword = (atualizarSenha, motivo) => {
    pedirSenha(motivo === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD)
      .then(atualizarSenha)
      .catch(() => {
        if (idDoc !== estado.idDoc) return;
        fecharDocumento();
        esconderCarregando();
        el.app.classList.add("sem-documento");
        el.nomeArquivo.textContent = "";
        atualizarControles();
      });
  };

  let doc;
  try {
    doc = await tarefa.promise;
  } catch (erro) {
    if (idDoc === estado.idDoc) falhaAoAbrir(erro);
    return;
  }
  if (idDoc !== estado.idDoc) return;
  estado.doc = doc;
  estado.paginaAtual = 0; // força o evento "paginaAlterada" da página inicial

  const primeira = await doc.getPage(1);
  if (idDoc !== estado.idDoc) return;
  const vp1 = primeira.getViewport({ scale: 1 });
  estado.rotacao = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const p = new PaginaView(n, vp1.width, vp1.height);
    estado.paginas.push(p);
  }
  estado.paginas[0].pdfPage = primeira;
  estado.paginas[0].tamanhoConfirmado = true;

  esconderCarregando();
  estado.escala = calcularEscala(estado.valorZoom);
  const fragmento = document.createDocumentFragment();
  for (const p of estado.paginas) {
    p.atualizarTamanho();
    fragmento.append(p.div);
  }
  el.paginas.append(fragmento);
  for (const p of estado.paginas) observadorPaginas.observe(p.div);

  construirMiniaturas();
  construirSumario(doc, idDoc);
  atualizarControles();

  const paginaInicial = limitar(parseInt(pagina, 10) || 1, 1, doc.numPages);
  irParaPagina(paginaInicial, { instantaneo: true });

  doc.getMetadata().then(({ info }) => {
    if (idDoc === estado.idDoc && info?.Title && typeof info.Title === "string" && info.Title.trim()) {
      document.title = `${info.Title.trim()} — Leitor de PDF`;
    }
  }).catch(() => {});

  enviarAoHost("documentoCarregado", { nome: estado.nome, totalPaginas: doc.numPages });

  if (termoBusca) {
    abrirBusca(termoBusca);
  } else if (busca.termo) {
    executarBusca(busca.termo);
  }

  confirmarTamanhos(doc, idDoc);
}

// Lê o tamanho real de todas as páginas em segundo plano e corrige o layout
// quando o documento tem páginas de tamanhos diferentes.
async function confirmarTamanhos(doc, idDoc) {
  let mudou = false;
  for (const p of estado.paginas) {
    if (idDoc !== estado.idDoc) return;
    if (p.tamanhoConfirmado) continue;
    try {
      const pdfPage = await doc.getPage(p.numero);
      if (idDoc !== estado.idDoc) return;
      p.pdfPage = pdfPage;
      if (p.definirTamanhoReal(pdfPage)) mudou = true;
    } catch {
      /* página corrompida: mantém o tamanho estimado */
    }
  }
  if (mudou && idDoc === estado.idDoc) {
    relayout(() => {
      for (const p of estado.paginas) p.atualizarTamanho();
      atualizarTamanhoMiniaturas();
    });
  }
}

function falhaAoAbrir(erro) {
  console.error(erro);
  esconderCarregando();
  let mensagem;
  switch (erro?.name) {
    case "InvalidPDFException":
      mensagem = "O arquivo não é um PDF válido ou está corrompido.";
      break;
    case "MissingPDFException":
      mensagem = "O arquivo não foi encontrado no servidor.";
      break;
    case "UnexpectedResponseException":
      mensagem = `O servidor respondeu com erro${erro.status ? ` (código ${erro.status})` : ""}.`;
      break;
    case "OrigemNaoPermitida":
      mensagem = "Este endereço de arquivo não está autorizado. Inclua a origem em origensPermitidas (js/config.js).";
      break;
    case "PasswordException":
      mensagem = "Senha incorreta ou documento protegido.";
      break;
    default:
      mensagem = /fetch|network|cors/i.test(String(erro?.message))
        ? "Falha de rede ao baixar o arquivo (verifique a conexão e a configuração de CORS do servidor)."
        : erro?.message || "Erro desconhecido.";
  }
  el.textoErro.textContent = mensagem;
  el.estadoErro.hidden = false;
  atualizarControles();
  enviarAoHost("erro", { mensagem });
}

function esconderErro() {
  el.estadoErro.hidden = true;
}

function mostrarCarregando(texto, progresso) {
  el.textoCarregando.textContent = texto;
  el.progressoCarregando.style.width = Math.round(limitar(progresso, 0, 1) * 100) + "%";
  el.estadoCarregando.hidden = false;
}

function esconderCarregando() {
  el.estadoCarregando.hidden = true;
}

function pedirSenha(incorreta) {
  return new Promise((resolve, reject) => {
    el.textoSenha.textContent = incorreta
      ? "Senha incorreta. Tente novamente."
      : "Este PDF exige uma senha para ser aberto.";
    el.inputSenha.value = "";
    const aoEnviar = (e) => {
      e.preventDefault();
      limpar();
      el.dialogoSenha.close();
      resolve(el.inputSenha.value);
    };
    const aoCancelar = () => {
      limpar();
      el.dialogoSenha.close();
      reject(new Error("cancelado"));
    };
    const limpar = () => {
      $("formSenha").removeEventListener("submit", aoEnviar);
      $("btnCancelarSenha").removeEventListener("click", aoCancelar);
      el.dialogoSenha.removeEventListener("cancel", aoCancelar);
    };
    $("formSenha").addEventListener("submit", aoEnviar);
    $("btnCancelarSenha").addEventListener("click", aoCancelar);
    el.dialogoSenha.addEventListener("cancel", aoCancelar);
    el.dialogoSenha.showModal();
    el.inputSenha.focus();
  });
}

// ---------------------------------------------------------------------------
// Zoom, rotação e layout
// ---------------------------------------------------------------------------
function limitar(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function calcularEscala(valor) {
  if (typeof valor === "number") return limitar(valor, ZOOM_MIN, ZOOM_MAX);
  const ref = estado.paginas[estado.paginaAtual - 1] || estado.paginas[0];
  if (!ref) return 1;
  const girada = estado.rotacao % 180 !== 0;
  const w = (girada ? ref.altura : ref.largura) * CSS_POR_PT;
  const h = (girada ? ref.largura : ref.altura) * CSS_POR_PT;
  const larguraUtil = Math.max(50, el.area.clientWidth - MARGEM_HORIZONTAL * 2);
  const alturaUtil = Math.max(50, el.area.clientHeight - MARGEM_VERTICAL * 2);
  const porLargura = larguraUtil / w;
  const porAltura = alturaUtil / h;
  let escala;
  if (valor === "page-width") escala = porLargura;
  else if (valor === "page-fit") escala = Math.min(porLargura, porAltura);
  else escala = w > h ? Math.min(porLargura, porAltura) : Math.min(1.25, porLargura);
  return limitar(escala, ZOOM_MIN, ZOOM_MAX);
}

// Executa uma mudança de layout mantendo fixo o ponto do documento que está em
// "ancora" (coordenadas relativas à área de visualização).
function relayout(mudanca, ancora = { x: 0, y: 0 }) {
  const area = el.area;
  const yAbs = area.scrollTop + ancora.y;
  const pagina = paginaNaPosicao(yAbs);
  let fracaoY = 0;
  if (pagina) fracaoY = (yAbs - pagina.div.offsetTop) / Math.max(1, pagina.div.offsetHeight);
  const fracaoX = (area.scrollLeft + ancora.x) / Math.max(1, area.scrollWidth);

  mudanca();

  if (pagina) {
    area.scrollTop = pagina.div.offsetTop + fracaoY * pagina.div.offsetHeight - ancora.y;
  }
  area.scrollLeft = fracaoX * area.scrollWidth - ancora.x;
}

function aplicarZoom(valor, ancora) {
  if (!estado.doc) return;
  const novaEscala = calcularEscala(valor);
  estado.valorZoom = valor;
  if (Math.abs(novaEscala - estado.escala) < 1e-4) {
    atualizarSelectZoom();
    return;
  }
  relayout(() => {
    estado.escala = novaEscala;
    for (const p of estado.paginas) {
      p.atualizarTamanho();
      if (p.status !== "vazia" || p.div.querySelector("canvas")) p.invalidar(estado.visiveis.has(p.numero));
    }
  }, ancora);
  atualizarSelectZoom();
  agendarRender(120);
  enviarAoHost("zoomAlterado", { zoom: Math.round(estado.escala * 100) / 100 });
}

function passoZoom(direcao, ancora) {
  const atual = estado.escala;
  let alvo;
  if (direcao > 0) alvo = PASSOS_ZOOM.find((z) => z > atual + 0.001) ?? ZOOM_MAX;
  else alvo = [...PASSOS_ZOOM].reverse().find((z) => z < atual - 0.001) ?? ZOOM_MIN;
  aplicarZoom(alvo, ancora);
}

function atualizarSelectZoom() {
  const valor = estado.valorZoom;
  const custom = el.opcaoZoomCustom;
  const porcentagem = Math.round(estado.escala * 100) + "%";
  if (typeof valor === "string") {
    el.selectZoom.value = valor;
    custom.hidden = true;
  } else {
    const opcao = [...el.selectZoom.options].find((o) => !o.disabled && Number(o.value) === valor);
    if (opcao) {
      el.selectZoom.value = opcao.value;
      custom.hidden = true;
    } else {
      custom.textContent = porcentagem;
      custom.hidden = false;
      el.selectZoom.value = "custom";
    }
  }
  el.selectZoom.title = `Zoom: ${porcentagem}`;
}

function girar(graus) {
  if (!estado.doc) return;
  const pagina = estado.paginaAtual;
  estado.rotacao = (estado.rotacao + graus + 360) % 360;
  estado.escala = calcularEscala(estado.valorZoom);
  for (const p of estado.paginas) {
    p.atualizarTamanho();
    p.invalidar(false);
  }
  atualizarSelectZoom();
  irParaPagina(pagina, { instantaneo: true });
  construirMiniaturas();
  agendarRender();
}

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------
function paginaNaPosicao(y) {
  const paginas = estado.paginas;
  if (!paginas.length) return null;
  let ini = 0;
  let fim = paginas.length - 1;
  while (ini < fim) {
    const meio = (ini + fim + 1) >> 1;
    if (paginas[meio].div.offsetTop <= y) ini = meio;
    else fim = meio - 1;
  }
  return paginas[ini];
}

function irParaPagina(numero, { instantaneo = false, deslocamento = 0 } = {}) {
  if (!estado.doc) return;
  numero = limitar(Math.round(numero) || 1, 1, estado.paginas.length);
  const pagina = estado.paginas[numero - 1];
  const topo = Math.max(0, pagina.div.offsetTop - (deslocamento ? 0 : 8) + deslocamento);
  if (Math.abs(el.area.scrollTop - topo) >= 1) paginaFixada = numero;
  el.area.scrollTo({ top: topo, behavior: instantaneo ? "instant" : "auto" });
  definirPaginaAtual(numero);
}

async function irParaDestino(destino) {
  const doc = estado.doc;
  if (!doc) return;
  try {
    const explicito = typeof destino === "string" ? await doc.getDestination(destino) : destino;
    if (!Array.isArray(explicito)) return;
    const ref = explicito[0];
    let indice;
    if (typeof ref === "object" && ref !== null) indice = await doc.getPageIndex(ref);
    else if (Number.isInteger(ref)) indice = ref;
    else return;
    const pagina = estado.paginas[indice];
    if (!pagina) return;
    let deslocamento = 0;
    const tipo = explicito[1]?.name;
    const topo = tipo === "XYZ" ? explicito[3] : tipo === "FitH" || tipo === "FitBH" ? explicito[2] : null;
    if (typeof topo === "number") {
      const pdfPage = await pagina.obterPagina();
      const vp = pagina.viewport(pdfPage);
      const [, y] = vp.convertToViewportPoint(0, topo);
      deslocamento = Math.max(0, y - 8);
    }
    irParaPagina(indice + 1, { deslocamento: deslocamento || 0 });
  } catch (erro) {
    console.warn("Destino inválido no PDF", erro);
  }
}

// Após uma navegação explícita, a página escolhida prevalece sobre a
// detectada pela posição de rolagem (relevante com páginas pequenas).
let paginaFixada = 0;
let rafRolagem = 0;
function aoRolar() {
  if (rafRolagem) return;
  rafRolagem = requestAnimationFrame(() => {
    rafRolagem = 0;
    if (paginaFixada) {
      paginaFixada = 0;
      return;
    }
    atualizarPaginaAtual();
  });
}

function definirPaginaAtual(numero, forcar = false) {
  if (numero === estado.paginaAtual && !forcar) return;
  estado.paginaAtual = numero;
  atualizarControles();
  destacarMiniaturaAtual();
  enviarAoHost("paginaAlterada", { pagina: numero, totalPaginas: estado.paginas.length });
}

function atualizarPaginaAtual(forcar = false) {
  if (!estado.paginas.length) return;
  const area = el.area;
  let pagina;
  if (area.scrollTop + area.clientHeight >= area.scrollHeight - 2) {
    pagina = estado.paginas[estado.paginas.length - 1];
    // Se a última página não está visível em grande parte, use a do ponto de referência.
    if (pagina.div.offsetTop > area.scrollTop + area.clientHeight * 0.5) {
      pagina = paginaNaPosicao(area.scrollTop + area.clientHeight * 0.3);
    }
  } else {
    pagina = paginaNaPosicao(area.scrollTop + area.clientHeight * 0.3);
  }
  if (pagina) definirPaginaAtual(pagina.numero, forcar);
}

function atualizarControles() {
  const total = estado.doc ? estado.paginas.length : 0;
  const temDoc = total > 0;
  el.totalPaginas.textContent = `/ ${total}`;
  if (document.activeElement !== el.inputPagina) el.inputPagina.value = temDoc ? estado.paginaAtual : 0;
  el.inputPagina.disabled = !temDoc;
  $("btnAnterior").disabled = !temDoc || estado.paginaAtual <= 1;
  $("btnProxima").disabled = !temDoc || estado.paginaAtual >= total;
  for (const id of ["btnZoomMenos", "btnZoomMais", "btnGirar", "btnBusca", "selectZoom"]) $(id).disabled = !temDoc;
  $("btnImprimir").hidden = !config.permitirImpressao;
  $("btnBaixar").hidden = !config.permitirDownload;
  $("btnImprimir").disabled = !temDoc;
  $("btnBaixar").disabled = !temDoc;
  $("btnAbrir").hidden = !config.permitirAbrirArquivoLocal;
  $("btnAbrirVazio").hidden = !config.permitirAbrirArquivoLocal;
  $("btnTelaCheia").hidden = !document.fullscreenEnabled;
}

// ---------------------------------------------------------------------------
// Painel lateral: miniaturas e sumário
// ---------------------------------------------------------------------------
let filaMiniaturas = Promise.resolve();

const observadorMiniaturas = new IntersectionObserver(
  (entradas) => {
    if (!el.app.classList.contains("sidebar-aberta")) return;
    for (const entrada of entradas) {
      if (!entrada.isIntersecting) continue;
      const botao = entrada.target;
      observadorMiniaturas.unobserve(botao);
      const idDoc = estado.idDoc;
      filaMiniaturas = filaMiniaturas.then(() => renderizarMiniatura(botao, idDoc)).catch(() => {});
    }
  },
  { root: el.miniaturas, rootMargin: "300px 0px" },
);

function dimensoesMiniatura(p) {
  const girada = estado.rotacao % 180 !== 0;
  const w = girada ? p.altura : p.largura;
  const h = girada ? p.largura : p.altura;
  const escala = Math.min(LARGURA_MINIATURA / w, (LARGURA_MINIATURA * 1.3) / h);
  return { largura: Math.round(w * escala), altura: Math.round(h * escala) };
}

function construirMiniaturas() {
  observadorMiniaturas.disconnect();
  el.miniaturas.replaceChildren();
  const fragmento = document.createDocumentFragment();
  for (const p of estado.paginas) {
    const botao = document.createElement("button");
    botao.className = "miniatura";
    botao.dataset.pagina = p.numero;
    botao.setAttribute("aria-label", `Ir para a página ${p.numero}`);
    const quadro = document.createElement("div");
    quadro.className = "quadro";
    const legenda = document.createElement("span");
    legenda.textContent = p.numero;
    botao.append(quadro, legenda);
    botao.addEventListener("click", () => {
      irParaPagina(p.numero);
      if (window.matchMedia("(max-width: 600px)").matches) alternarSidebar(false);
    });
    fragmento.append(botao);
  }
  el.miniaturas.append(fragmento);
  atualizarTamanhoMiniaturas();
  observarMiniaturas();
  destacarMiniaturaAtual();
}

function atualizarTamanhoMiniaturas() {
  for (const botao of el.miniaturas.children) {
    const p = estado.paginas[Number(botao.dataset.pagina) - 1];
    const { largura, altura } = dimensoesMiniatura(p);
    const quadro = botao.firstChild;
    quadro.style.width = largura + "px";
    quadro.style.height = altura + "px";
  }
}

function observarMiniaturas() {
  // Observar de novo força uma nova verificação de visibilidade.
  for (const botao of el.miniaturas.children) {
    observadorMiniaturas.unobserve(botao);
    if (!botao.querySelector("canvas")) observadorMiniaturas.observe(botao);
  }
}

async function renderizarMiniatura(botao, idDoc) {
  if (idDoc !== estado.idDoc || !botao.isConnected) return;
  const p = estado.paginas[Number(botao.dataset.pagina) - 1];
  const pdfPage = await p.obterPagina();
  if (idDoc !== estado.idDoc || !botao.isConnected) return;
  const { largura, altura } = dimensoesMiniatura(p);
  const quadro = botao.firstChild;
  quadro.style.width = largura + "px";
  quadro.style.height = altura + "px";
  const fator = Math.min(2, window.devicePixelRatio || 1);
  const vpBase = p.viewport(pdfPage, 1);
  const vp = p.viewport(pdfPage, (largura * fator) / vpBase.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await pdfPage.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp }).promise;
  if (idDoc !== estado.idDoc || !botao.isConnected) return;
  quadro.replaceChildren(canvas);
}

function destacarMiniaturaAtual() {
  const anterior = el.miniaturas.querySelector(".miniatura.atual");
  const atual = el.miniaturas.children[estado.paginaAtual - 1];
  if (anterior === atual) return;
  anterior?.classList.remove("atual");
  anterior?.removeAttribute("aria-current");
  if (atual) {
    atual.classList.add("atual");
    atual.setAttribute("aria-current", "page");
    if (el.app.classList.contains("sidebar-aberta")) {
      const painel = el.miniaturas;
      const topo = atual.offsetTop - painel.offsetTop;
      if (topo < painel.scrollTop || topo + atual.offsetHeight > painel.scrollTop + painel.clientHeight) {
        painel.scrollTop = topo - painel.clientHeight / 2 + atual.offsetHeight / 2;
      }
    }
  }
}

async function construirSumario(doc, idDoc) {
  let itens = null;
  try {
    itens = await doc.getOutline();
  } catch {
    /* sem sumário */
  }
  if (idDoc !== estado.idDoc) return;
  el.sumario.replaceChildren();
  if (!itens || !itens.length) {
    const vazio = document.createElement("p");
    vazio.className = "sumario-vazio";
    vazio.textContent = "Este documento não possui sumário.";
    el.sumario.append(vazio);
    return;
  }
  const montar = (lista) => {
    const ul = document.createElement("ul");
    for (const item of lista) {
      const li = document.createElement("li");
      const botao = document.createElement("button");
      botao.className = "item-sumario";
      botao.textContent = item.title || "(sem título)";
      if (item.bold) botao.style.fontWeight = "600";
      if (item.italic) botao.style.fontStyle = "italic";
      botao.addEventListener("click", () => {
        const url = urlSegura(item.url || item.unsafeUrl);
        if (url) window.open(url, "_blank", "noopener");
        else if (item.dest) irParaDestino(item.dest);
      });
      li.append(botao);
      if (item.items?.length) li.append(montar(item.items));
      ul.append(li);
    }
    return ul;
  };
  const raiz = montar(itens);
  raiz.className = "sumario";
  el.sumario.append(raiz);
}

function alternarSidebar(abrir = !el.app.classList.contains("sidebar-aberta"), lembrar = true) {
  el.app.classList.toggle("sidebar-aberta", abrir);
  $("btnSidebar").setAttribute("aria-pressed", String(abrir));
  if (lembrar) preferencias.gravar("sidebar", abrir);
  if (abrir) {
    observarMiniaturas();
    requestAnimationFrame(destacarMiniaturaAtual);
  }
}

function selecionarAba(aba) {
  const sumario = aba === "sumario";
  el.abaSumario.classList.toggle("ativa", sumario);
  el.abaMiniaturas.classList.toggle("ativa", !sumario);
  el.abaSumario.setAttribute("aria-selected", String(sumario));
  el.abaMiniaturas.setAttribute("aria-selected", String(!sumario));
  el.sumario.hidden = !sumario;
  el.miniaturas.hidden = sumario;
  if (!sumario) observarMiniaturas();
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------
// Normaliza para busca sem acento e sem diferenciar maiúsculas, guardando o
// mapeamento de cada caractere normalizado para a posição no texto original.
function normalizar(texto) {
  let saida = "";
  const mapa = [];
  let espacoAnterior = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (/\s/.test(ch)) {
      if (!espacoAnterior) {
        saida += " ";
        mapa.push(i);
        espacoAnterior = true;
      }
      continue;
    }
    espacoAnterior = false;
    const n = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const c of n) {
      saida += c;
      mapa.push(i);
    }
  }
  return { saida, mapa };
}

function obterTexto(numero) {
  let promessa = estado.textos.get(numero);
  if (!promessa) {
    const doc = estado.doc;
    if (!doc) return Promise.reject(new Error("Nenhum documento aberto."));
    promessa = doc
      .getPage(numero)
      .then((p) => p.getTextContent())
      .then((conteudo) => {
        let original = "";
        const inicios = [];
        for (const item of conteudo.items) {
          inicios.push(original.length);
          original += item.str ?? "";
          if (item.hasEOL) original += " ";
        }
        const { saida, mapa } = normalizar(original);
        return { conteudo, inicios, normalizado: saida, mapa };
      });
    estado.textos.set(numero, promessa);
    promessa.catch(() => estado.textos.delete(numero));
  }
  return promessa;
}

let timerBusca = 0;

function abrirBusca(termo) {
  if (!estado.doc) return;
  el.barraBusca.hidden = false;
  $("btnBusca").setAttribute("aria-pressed", "true");
  if (typeof termo === "string") {
    el.inputBusca.value = termo;
    executarBusca(termo);
  }
  el.inputBusca.focus();
  el.inputBusca.select();
}

function fecharBusca() {
  el.barraBusca.hidden = true;
  $("btnBusca").setAttribute("aria-pressed", "false");
  limparBusca(true);
  el.area.focus({ preventScroll: true });
}

function limparBusca(atualizarPaginas) {
  busca.token++;
  const paginasAfetadas = [...busca.porPagina.keys()];
  busca.termo = "";
  busca.resultados = [];
  busca.porPagina = new Map();
  busca.atual = -1;
  busca.concluida = false;
  el.statusBusca.textContent = "";
  el.inputBusca.classList.remove("sem-resultado");
  if (atualizarPaginas) {
    el.inputBusca.value = "";
    for (const n of paginasAfetadas) {
      const p = estado.paginas[n - 1];
      if (p) aplicarDestaques(p);
    }
  }
}

async function executarBusca(termo) {
  const paginasAntes = [...busca.porPagina.keys()];
  limparBusca(false);
  for (const n of paginasAntes) {
    const p = estado.paginas[n - 1];
    if (p) aplicarDestaques(p);
  }
  const consulta = normalizar(termo.trim()).saida;
  busca.termo = termo;
  if (!consulta || !estado.doc) return;
  const token = busca.token;
  const total = estado.paginas.length;
  // Começa da página atual e dá a volta no documento.
  const inicio = estado.paginaAtual;
  const encontrados = [];
  for (let k = 0; k < total; k++) {
    const numero = ((inicio - 1 + k) % total) + 1;
    let info;
    try {
      info = await obterTexto(numero);
    } catch {
      continue;
    }
    if (token !== busca.token) return;
    const achados = [];
    let pos = info.normalizado.indexOf(consulta);
    while (pos !== -1) {
      const fimNorm = pos + consulta.length - 1;
      achados.push({ pagina: numero, inicio: info.mapa[pos], fim: info.mapa[fimNorm] + 1 });
      pos = info.normalizado.indexOf(consulta, pos + consulta.length);
    }
    if (achados.length) {
      encontrados.push(...achados);
      reindexarResultados(encontrados);
      if (busca.atual === -1) {
        busca.atual = busca.resultados.indexOf(achados[0]);
        busca.rolarParaAtual = true;
        mostrarResultadoAtual();
      } else {
        const p = estado.paginas[numero - 1];
        if (p) aplicarDestaques(p);
      }
    }
    if (k % 20 === 0 || k === total - 1) atualizarStatusBusca(k + 1, total);
  }
  busca.concluida = true;
  atualizarStatusBusca(total, total);
  enviarAoHost("buscaConcluida", { termo, resultados: busca.resultados.length });
}

// Mantém os resultados ordenados por página/posição.
function reindexarResultados(encontrados) {
  const atual = busca.resultados[busca.atual];
  busca.resultados = [...encontrados].sort((a, b) => a.pagina - b.pagina || a.inicio - b.inicio);
  busca.porPagina = new Map();
  busca.resultados.forEach((r, i) => {
    if (!busca.porPagina.has(r.pagina)) busca.porPagina.set(r.pagina, []);
    busca.porPagina.get(r.pagina).push(i);
  });
  if (atual) busca.atual = busca.resultados.indexOf(atual);
}

function atualizarStatusBusca(processadas, total) {
  const n = busca.resultados.length;
  const emAndamento = processadas < total;
  el.inputBusca.classList.toggle("sem-resultado", !emAndamento && n === 0 && busca.termo.trim() !== "");
  if (!busca.termo.trim()) {
    el.statusBusca.textContent = "";
  } else if (n === 0) {
    el.statusBusca.textContent = emAndamento ? `Buscando… ${Math.round((processadas / total) * 100)}%` : "Nenhum resultado";
  } else {
    el.statusBusca.textContent = `${busca.atual + 1} de ${n}${emAndamento ? "+" : ""}`;
  }
}

function navegarBusca(direcao) {
  const n = busca.resultados.length;
  if (!n) {
    if (el.inputBusca.value.trim() && el.inputBusca.value !== busca.termo) executarBusca(el.inputBusca.value);
    return;
  }
  const anterior = busca.resultados[busca.atual];
  busca.atual = (busca.atual + direcao + n) % n;
  busca.rolarParaAtual = true;
  if (anterior && anterior.pagina !== busca.resultados[busca.atual].pagina) {
    const p = estado.paginas[anterior.pagina - 1];
    if (p) aplicarDestaques(p);
  }
  mostrarResultadoAtual();
  atualizarStatusBusca(busca.concluida ? 1 : 0, 1);
}

function mostrarResultadoAtual() {
  const r = busca.resultados[busca.atual];
  if (!r) return;
  const pagina = estado.paginas[r.pagina - 1];
  if (pagina.textDivs) {
    aplicarDestaques(pagina);
  } else {
    irParaPagina(r.pagina, { instantaneo: true });
  }
}

function aplicarDestaques(pagina) {
  const divs = pagina.textDivs;
  const infoPromessa = estado.textos.get(pagina.numero);
  if (!divs || !infoPromessa) return;
  const strs = pagina.textStrs;

  infoPromessa.then((info) => {
    if (pagina.textDivs !== divs) return;
    for (const i of pagina.divsDestacados) divs[i].textContent = strs[i];
    pagina.divsDestacados = [];
    const indices = busca.porPagina.get(pagina.numero);
    if (!indices?.length) return;

    const porDiv = new Map();
    for (const ri of indices) {
      const r = busca.resultados[ri];
      // Busca binária do primeiro item que contém o início do resultado.
      let ini = 0;
      let fim = info.inicios.length - 1;
      while (ini < fim) {
        const meio = (ini + fim + 1) >> 1;
        if (info.inicios[meio] <= r.inicio) ini = meio;
        else fim = meio - 1;
      }
      for (let i = ini; i < info.inicios.length && info.inicios[i] < r.fim; i++) {
        const comeco = info.inicios[i];
        const tamanho = (strs[i] ?? "").length;
        const s = Math.max(r.inicio, comeco) - comeco;
        const e = Math.min(r.fim, comeco + tamanho) - comeco;
        if (e <= s) continue;
        if (!porDiv.has(i)) porDiv.set(i, []);
        porDiv.get(i).push({ s, e, atual: ri === busca.atual });
      }
    }
    let alvo = null;
    for (const [i, faixas] of porDiv) {
      const div = divs[i];
      if (!div) continue;
      const texto = strs[i];
      faixas.sort((a, b) => a.s - b.s);
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const f of faixas) {
        if (f.s < pos) continue;
        if (f.s > pos) frag.append(texto.slice(pos, f.s));
        const span = document.createElement("span");
        span.className = f.atual ? "hl atual" : "hl";
        span.textContent = texto.slice(f.s, f.e);
        frag.append(span);
        if (f.atual && !alvo) alvo = span;
        pos = f.e;
      }
      if (pos < texto.length) frag.append(texto.slice(pos));
      div.replaceChildren(frag);
      pagina.divsDestacados.push(i);
    }
    if (alvo && busca.rolarParaAtual) {
      busca.rolarParaAtual = false;
      rolarAteElemento(alvo);
    }
  });
}

function rolarAteElemento(elemento) {
  const area = el.area;
  const r = elemento.getBoundingClientRect();
  const ra = area.getBoundingClientRect();
  const dentro = r.top >= ra.top + 40 && r.bottom <= ra.bottom - 40 && r.left >= ra.left && r.right <= ra.right;
  if (dentro) return;
  area.scrollTop += r.top - ra.top - area.clientHeight / 3;
  if (r.left < ra.left || r.right > ra.right) area.scrollLeft += r.left - ra.left - area.clientWidth / 3;
}

// ---------------------------------------------------------------------------
// Impressão e download
// ---------------------------------------------------------------------------
let imprimindo = false;

async function imprimir() {
  if (!estado.doc || !config.permitirImpressao || imprimindo) return;
  imprimindo = true;
  const doc = estado.doc;
  const idDoc = estado.idDoc;
  const urls = [];
  const area = el.areaImpressao;
  area.replaceChildren();
  try {
    const escala = (config.dpiImpressao || 150) / 72;
    for (let n = 1; n <= doc.numPages; n++) {
      mostrarCarregando(`Preparando impressão… página ${n} de ${doc.numPages}`, (n - 1) / doc.numPages);
      const pdfPage = await doc.getPage(n);
      if (idDoc !== estado.idDoc) return;
      const vp = pdfPage.getViewport({ scale: escala, rotation: (pdfPage.rotate + estado.rotacao) % 360 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
      desenharMarcaDagua(ctx, canvas.width, canvas.height, escala);
      const blob = await new Promise((ok) => canvas.toBlob(ok, "image/png"));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const folha = document.createElement("div");
      folha.className = "folha";
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      folha.append(img);
      area.append(folha);
    }
    await Promise.all([...area.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    esconderCarregando();
    document.body.classList.add("imprimindo");
    await new Promise((ok) => {
      const fim = () => {
        window.removeEventListener("afterprint", fim);
        ok();
      };
      window.addEventListener("afterprint", fim);
      const inicio = Date.now();
      window.print();
      // Na maioria dos navegadores window.print() bloqueia até o diálogo fechar;
      // caso contrário, espera o "afterprint" (com um limite de segurança).
      setTimeout(fim, Date.now() - inicio > 300 ? 0 : 120_000);
    });
  } catch (erro) {
    console.error(erro);
    mostrarAviso("Não foi possível preparar a impressão.");
  } finally {
    esconderCarregando();
    document.body.classList.remove("imprimindo");
    area.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
    imprimindo = false;
  }
}

// Tamanho da fonte (em pontos PDF) para a marca d'água caber na diagonal.
function tamanhoMarcaDagua(larguraPagina) {
  const caracteres = Math.max(1, config.marcaDagua.length);
  return Math.min(48, (larguraPagina * 1.05) / (caracteres * 0.62));
}

function desenharMarcaDagua(ctx, largura, altura, escala) {
  if (!config.marcaDagua) return;
  ctx.save();
  ctx.translate(largura / 2, altura / 2);
  ctx.rotate((-35 * Math.PI) / 180);
  ctx.font = `700 ${Math.round(tamanhoMarcaDagua(largura / escala) * escala)}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(120, 120, 120, 0.22)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(config.marcaDagua, 0, 0);
  ctx.restore();
}

async function baixar() {
  if (!estado.doc || !config.permitirDownload) return;
  try {
    const dados = await estado.doc.getData();
    const blob = new Blob([dados], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = /\.pdf$/i.test(estado.nome) ? estado.nome : estado.nome + ".pdf";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (erro) {
    console.error(erro);
    mostrarAviso("Não foi possível baixar o arquivo.");
  }
}

// ---------------------------------------------------------------------------
// Tema, tela cheia e avisos
// ---------------------------------------------------------------------------
function aplicarTema(tema) {
  if (tema === "claro" || tema === "escuro") document.documentElement.dataset.tema = tema;
  else delete document.documentElement.dataset.tema;
}

function alternarTema() {
  const escuroAtual =
    document.documentElement.dataset.tema === "escuro" ||
    (!document.documentElement.dataset.tema && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const novo = escuroAtual ? "claro" : "escuro";
  aplicarTema(novo);
  preferencias.gravar("tema", novo);
}

function alternarTelaCheia() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => mostrarAviso("Tela cheia não permitida aqui."));
}

let timerAviso = 0;
function mostrarAviso(texto) {
  el.aviso.textContent = texto;
  el.aviso.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.aviso.hidden = true), 3500);
}

// ---------------------------------------------------------------------------
// Integração com o ERP (postMessage)
// ---------------------------------------------------------------------------
let origemHost = null;
{
  // Se o leitor foi aberto dentro de um iframe de uma origem permitida, usa
  // essa origem para os eventos enviados antes de qualquer comando.
  try {
    const ref = document.referrer && new URL(document.referrer).origin;
    if (ref && origemPermitida(ref)) origemHost = ref;
  } catch {
    /* sem referrer */
  }
}

function enviarAoHost(tipo, dados = {}) {
  const alvo = window.parent !== window ? window.parent : window.opener;
  if (!alvo) return;
  const origem = origemHost || location.origin;
  try {
    alvo.postMessage({ origem: ID_MENSAGEM, tipo, ...dados }, origem);
  } catch {
    /* origem do host diferente: ignora */
  }
}

window.addEventListener("message", async (evento) => {
  const msg = evento.data;
  if (!msg || typeof msg !== "object" || typeof msg.tipo !== "string" || msg.origem === ID_MENSAGEM) return;
  if (!origemPermitida(evento.origin)) {
    console.warn(`Mensagem ignorada de origem não permitida: ${evento.origin}`);
    return;
  }
  origemHost = evento.origin === "null" ? origemHost : evento.origin;
  switch (msg.tipo) {
    case "abrir":
      await abrirDocumento({ url: msg.url, dados: msg.dados, nome: msg.nome, pagina: msg.pagina, busca: msg.busca });
      break;
    case "fechar":
      await fecharDocumento();
      el.app.classList.add("sem-documento");
      el.nomeArquivo.textContent = "";
      esconderErro();
      atualizarControles();
      break;
    case "irParaPagina":
      irParaPagina(Number(msg.pagina));
      break;
    case "zoom": {
      const valor = interpretarZoom(msg.valor);
      if (valor != null) aplicarZoom(valor);
      break;
    }
    case "girar":
      girar(Number(msg.graus) || 90);
      break;
    case "buscar":
      if (msg.texto) abrirBusca(String(msg.texto));
      else fecharBusca();
      break;
    case "imprimir":
      imprimir();
      break;
    case "baixar":
      baixar();
      break;
    case "configurar":
      configurar(msg.opcoes || {});
      break;
    case "estado":
      enviarAoHost("estado", {
        nome: estado.nome,
        pagina: estado.paginaAtual,
        totalPaginas: estado.doc ? estado.paginas.length : 0,
        zoom: estado.escala,
        rotacao: estado.rotacao,
      });
      break;
    default:
      console.warn(`Comando desconhecido: ${msg.tipo}`);
  }
});

function configurar(opcoes) {
  if ("permitirDownload" in opcoes) config.permitirDownload = !!opcoes.permitirDownload;
  if ("permitirImpressao" in opcoes) config.permitirImpressao = !!opcoes.permitirImpressao;
  if ("permitirAbrirArquivoLocal" in opcoes) config.permitirAbrirArquivoLocal = !!opcoes.permitirAbrirArquivoLocal;
  if ("tema" in opcoes) aplicarTema(opcoes.tema);
  if ("corPrimaria" in opcoes) aplicarCor(opcoes.corPrimaria);
  if ("sidebar" in opcoes) alternarSidebar(!!opcoes.sidebar);
  if ("marcaDagua" in opcoes) {
    config.marcaDagua = String(opcoes.marcaDagua || "");
    for (const p of estado.paginas) if (p.status === "pronta") p.renderizarMarcaDagua();
  }
  atualizarControles();
}

function aplicarCor(cor) {
  if (typeof cor === "string" && /^#?[0-9a-f]{3,8}$/i.test(cor)) {
    document.documentElement.style.setProperty("--cor-primaria", cor.startsWith("#") ? cor : "#" + cor);
  }
}

// ---------------------------------------------------------------------------
// Eventos da interface
// ---------------------------------------------------------------------------
function abrirArquivoLocal(arquivo) {
  if (!arquivo) return;
  if (arquivo.type && arquivo.type !== "application/pdf" && !/\.pdf$/i.test(arquivo.name)) {
    mostrarAviso("Selecione um arquivo PDF.");
    return;
  }
  abrirDocumento({ dados: arquivo, nome: arquivo.name });
}

function escolherArquivo() {
  if (config.permitirAbrirArquivoLocal) el.inputArquivo.click();
}

$("btnSidebar").addEventListener("click", () => alternarSidebar());
$("btnAbrir").addEventListener("click", escolherArquivo);
$("btnAbrirVazio").addEventListener("click", escolherArquivo);
el.inputArquivo.addEventListener("change", () => {
  abrirArquivoLocal(el.inputArquivo.files[0]);
  el.inputArquivo.value = "";
});
$("btnAnterior").addEventListener("click", () => irParaPagina(estado.paginaAtual - 1));
$("btnProxima").addEventListener("click", () => irParaPagina(estado.paginaAtual + 1));
$("btnZoomMenos").addEventListener("click", () => passoZoom(-1));
$("btnZoomMais").addEventListener("click", () => passoZoom(1));
$("btnGirar").addEventListener("click", () => girar(90));
$("btnBusca").addEventListener("click", () => (el.barraBusca.hidden ? abrirBusca() : fecharBusca()));
$("btnImprimir").addEventListener("click", imprimir);
$("btnBaixar").addEventListener("click", baixar);
$("btnTelaCheia").addEventListener("click", alternarTelaCheia);
$("btnTema").addEventListener("click", alternarTema);
$("btnAjuda").addEventListener("click", () => el.dialogoAjuda.showModal());
$("btnBuscaAnterior").addEventListener("click", () => navegarBusca(-1));
$("btnBuscaProxima").addEventListener("click", () => navegarBusca(1));
$("btnFecharBusca").addEventListener("click", fecharBusca);
el.abaMiniaturas.addEventListener("click", () => selecionarAba("miniaturas"));
el.abaSumario.addEventListener("click", () => selecionarAba("sumario"));

el.selectZoom.addEventListener("change", () => {
  const v = el.selectZoom.value;
  if (v === "custom") return;
  aplicarZoom(Number.isFinite(Number(v)) ? Number(v) : v);
});

el.inputPagina.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    irParaPagina(parseInt(el.inputPagina.value, 10));
    el.inputPagina.blur();
  } else if (e.key === "Escape") {
    el.inputPagina.blur();
  }
});
el.inputPagina.addEventListener("focus", () => el.inputPagina.select());
el.inputPagina.addEventListener("blur", () => {
  el.inputPagina.value = estado.doc ? estado.paginaAtual : 0;
});

el.inputBusca.addEventListener("input", () => {
  clearTimeout(timerBusca);
  timerBusca = setTimeout(() => executarBusca(el.inputBusca.value), 250);
});
el.inputBusca.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (el.inputBusca.value !== busca.termo) {
      clearTimeout(timerBusca);
      executarBusca(el.inputBusca.value);
    } else {
      navegarBusca(e.shiftKey ? -1 : 1);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    fecharBusca();
  }
});

el.area.addEventListener("scroll", aoRolar, { passive: true });
document.addEventListener("mouseup", () => {
  document.querySelectorAll(".textLayer.selecionando").forEach((t) => t.classList.remove("selecionando"));
});

// Zoom com Ctrl + roda do mouse (ou gesto de pinça no touchpad).
el.area.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !estado.doc) return;
    e.preventDefault();
    const r = el.area.getBoundingClientRect();
    const ancora = { x: e.clientX - r.left, y: e.clientY - r.top };
    const fator = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.0015));
    aplicarZoom(limitar(Math.round(estado.escala * fator * 1000) / 1000, ZOOM_MIN, ZOOM_MAX), ancora);
  },
  { passive: false },
);

// Recalcula o zoom automático quando a área muda de tamanho.
let timerResize = 0;
new ResizeObserver(() => {
  clearTimeout(timerResize);
  timerResize = setTimeout(() => {
    if (estado.doc && typeof estado.valorZoom === "string") aplicarZoom(estado.valorZoom);
  }, 100);
}).observe(el.area);

// Arrastar e soltar
let contadorArraste = 0;
const temArquivo = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!config.permitirAbrirArquivoLocal || !temArquivo(e)) return;
  e.preventDefault();
  contadorArraste++;
  el.soltarArquivo.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!config.permitirAbrirArquivoLocal || !temArquivo(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  contadorArraste = Math.max(0, contadorArraste - 1);
  if (!contadorArraste) el.soltarArquivo.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!config.permitirAbrirArquivoLocal || !temArquivo(e)) return;
  e.preventDefault();
  contadorArraste = 0;
  el.soltarArquivo.hidden = true;
  abrirArquivoLocal(e.dataTransfer.files[0]);
});

// Atalhos de teclado
window.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const alvo = e.target;
  const editando = alvo instanceof HTMLInputElement || alvo instanceof HTMLSelectElement || alvo instanceof HTMLTextAreaElement;
  const tecla = e.key.toLowerCase();

  if (ctrl && !e.altKey) {
    let tratado = true;
    if (tecla === "f") abrirBusca();
    else if (tecla === "p" && config.permitirImpressao) imprimir();
    else if (tecla === "s" && config.permitirDownload) baixar();
    else if (tecla === "o" && config.permitirAbrirArquivoLocal) escolherArquivo();
    else if (tecla === "g" && estado.doc) el.inputPagina.focus();
    else if ((tecla === "+" || tecla === "=") && estado.doc) passoZoom(1);
    else if (tecla === "-" && estado.doc) passoZoom(-1);
    else if (tecla === "0" && estado.doc) aplicarZoom("auto");
    else tratado = false;
    if (tratado) e.preventDefault();
    return;
  }
  if (e.key === "F4") {
    e.preventDefault();
    alternarSidebar();
    return;
  }
  if (editando || e.altKey || !estado.doc || document.querySelector("dialog[open]")) return;

  switch (e.key) {
    case "ArrowRight":
    case "PageDown":
    case "n":
    case "j":
      if (e.key === "ArrowRight" && el.area.scrollWidth > el.area.clientWidth) return;
      irParaPagina(estado.paginaAtual + 1);
      break;
    case "ArrowLeft":
    case "PageUp":
    case "p":
    case "k":
      if (e.key === "ArrowLeft" && el.area.scrollWidth > el.area.clientWidth) return;
      irParaPagina(estado.paginaAtual - 1);
      break;
    case "Home":
      irParaPagina(1);
      break;
    case "End":
      irParaPagina(estado.paginas.length);
      break;
    case "r":
      girar(90);
      break;
    case "R":
      girar(-90);
      break;
    case "?":
      el.dialogoAjuda.showModal();
      break;
    case "Escape":
      if (!el.barraBusca.hidden) fecharBusca();
      else return;
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
aplicarTema(params.get("tema") || preferencias.ler("tema", null));
if (params.has("cor")) aplicarCor(params.get("cor"));
const telaEstreita = window.matchMedia("(max-width: 600px)").matches;
alternarSidebar(params.has("sidebar") ? params.get("sidebar") === "1" : !telaEstreita && preferencias.ler("sidebar", false), false);
atualizarSelectZoom();
atualizarControles();

if (params.get("arquivo")) {
  abrirDocumento({
    url: params.get("arquivo"),
    nome: params.get("nome") || undefined,
    pagina: params.get("pagina"),
    busca: params.get("busca") || undefined,
  });
}

enviarAoHost("pronto", { versao: "2.0" });

// Exposto para depuração e para integrações na mesma origem.
window.leitorPdf = { abrir: abrirDocumento, irParaPagina, aplicarZoom, girar, buscar: abrirBusca, imprimir, baixar, configurar };
