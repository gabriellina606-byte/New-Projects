// Configuração do Leitor de PDF.
// Ajuste estes valores ao publicar o leitor dentro do ERP.
export default {
  // Origens (protocolo + domínio + porta) que podem controlar o leitor via
  // postMessage e de onde o leitor aceita abrir PDFs pelo parâmetro ?arquivo=.
  // A própria origem do leitor é sempre permitida.
  // Exemplo: ["https://erp.meuescritorio.com.br"]
  origensPermitidas: [],

  // Envia cookies/credenciais ao baixar PDFs de outra origem (requer CORS com
  // Access-Control-Allow-Credentials no servidor do ERP).
  enviarCredenciais: false,

  // Recursos que podem ser desligados (também via URL: ?download=0&impressao=0&abrir=0).
  // Atenção: ocultar botões não impede que alguém copie o PDF — não é DRM.
  permitirDownload: true,
  permitirImpressao: true,
  permitirAbrirArquivoLocal: true,

  // Zoom inicial: "auto", "page-width", "page-fit" ou um número (1 = 100%).
  zoomInicial: "auto",

  // Texto de marca d'água exibido sobre as páginas e na impressão (vazio = sem).
  marcaDagua: "",

  // Resolução usada na impressão (pontos por polegada).
  dpiImpressao: 150,
};
