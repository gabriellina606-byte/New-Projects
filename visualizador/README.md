# Leitor de PDF para o ERP

Leitor de PDF em uma página web, feito para rodar **dentro do ERP do escritório**
(por link ou em um `<iframe>`). É HTML/CSS/JavaScript puro: não precisa de build
nem de Node.js. Basta copiar a pasta para o servidor web.

A renderização usa o [pdf.js](https://github.com/mozilla/pdf.js) da Mozilla
(versão 4.10.38, já incluída em `vendor/pdfjs/`). Por isso o leitor não depende de
CDN externo e funciona em uma intranet.

## Recursos

- Rolagem contínua, com renderização sob demanda: abre rápido mesmo com centenas de páginas.
- Miniaturas das páginas e sumário (marcadores do PDF) no painel lateral.
- Zoom: automático, largura da página, página inteira, de 10% a 1000%, Ctrl + roda do mouse.
- Rotação das páginas.
- Busca no documento inteiro, **sem diferenciar acentos nem maiúsculas** (“acao” encontra “Ação”),
  com destaque dos resultados e navegação por Enter / Shift+Enter.
- Texto selecionável e copiável.
- Links clicáveis (externos e internos ao documento).
- PDFs protegidos por senha.
- Impressão e download (podem ser desligados).
- Marca d’água opcional na tela e na impressão (ex.: “CONFIDENCIAL — Fulano”).
- Tema claro/escuro, tela cheia, atalhos de teclado (tecla `?`), layout para celular.
- Abrir arquivo local pelo botão ou arrastando e soltando.
- Integração com o ERP por parâmetros na URL ou por `postMessage`.

## Estrutura

```
index.html            página do leitor
css/leitor.css        estilos (cores em variáveis no topo do arquivo)
js/leitor.js          lógica do leitor
js/config.js          configurações (origens permitidas, download, impressão…)
vendor/pdfjs/         pdf.js (Apache-2.0)
exemplo-erp.html      exemplo de página do ERP com o leitor em iframe
exemplos/             PDF de exemplo
```

## Como testar localmente

O leitor usa módulos JavaScript. Por isso precisa ser servido por HTTP: abrir o
arquivo direto com `file://` não funciona.

```bash
python3 -m http.server 8000
# abra http://localhost:8000/exemplo-erp.html
# ou   http://localhost:8000/index.html?arquivo=exemplos/documento-exemplo.pdf
```

## Integração com o ERP

### 1. Por URL (mais simples)

```html
<iframe src="/leitor-pdf/index.html?arquivo=/api/documentos/123.pdf&nome=Contrato.pdf"
        allow="fullscreen" style="width:100%;height:100%;border:0"></iframe>
```

| Parâmetro      | Exemplo                       | Descrição |
|----------------|-------------------------------|-----------|
| `arquivo`      | `/docs/contrato.pdf`          | URL do PDF (também aceita `file`) |
| `nome`         | `Contrato.pdf`                | Nome exibido e usado no download |
| `pagina`       | `5`                           | Página inicial |
| `zoom`         | `auto`, `largura`, `pagina`, `150` | Zoom inicial |
| `busca`        | `rescisão`                    | Já abre buscando o termo |
| `marcadagua`   | `CONFIDENCIAL`                | Texto da marca d’água |
| `download`     | `0`                           | Oculta o botão de download |
| `impressao`    | `0`                           | Oculta o botão de imprimir |
| `abrir`        | `0`                           | Oculta “abrir arquivo local” |
| `sidebar`      | `1` / `0`                     | Painel lateral aberto/fechado |
| `tema`         | `claro` / `escuro`            | Força o tema |
| `cor`          | `1f5fbf`                      | Cor principal (identidade visual do ERP) |

Os parâmetros também funcionam no hash (`index.html#pagina=3`).

Por segurança, só são aceitos PDFs da **mesma origem do leitor** ou de origens
listadas em `origensPermitidas` (`js/config.js`). Se o PDF vier de outro domínio,
o servidor dele também precisa liberar CORS para o domínio do leitor.

### 2. Por `postMessage` (controle total)

Use quando o ERP baixa o arquivo com autenticação própria (token, sessão), ou
quando quer controlar o leitor a partir das suas telas. Veja `exemplo-erp.html`.

```js
const leitor = document.querySelector("iframe").contentWindow;
const ORIGEM_LEITOR = "https://leitor.meuescritorio.com.br";

// Abrir por URL
leitor.postMessage({ tipo: "abrir", url: "/docs/123.pdf", nome: "Petição.pdf", pagina: 1 }, ORIGEM_LEITOR);

// Abrir enviando os bytes (ArrayBuffer, Uint8Array ou Blob)
const dados = await (await fetch("/api/doc/123", { headers: { Authorization: "Bearer …" } })).arrayBuffer();
leitor.postMessage({ tipo: "abrir", dados, nome: "Petição.pdf" }, ORIGEM_LEITOR, [dados]);
```

**Comandos aceitos** (`tipo`):

| tipo           | campos                                   |
|----------------|------------------------------------------|
| `abrir`        | `url` ou `dados`, `nome?`, `pagina?`, `busca?` |
| `fechar`       | —                                        |
| `irParaPagina` | `pagina`                                 |
| `zoom`         | `valor` (`"auto"`, `"page-width"`, `"page-fit"`, `1.5`, `"150%"`) |
| `girar`        | `graus` (90, -90…)                       |
| `buscar`       | `texto` (vazio fecha a busca)            |
| `imprimir`     | —                                        |
| `baixar`       | —                                        |
| `configurar`   | `opcoes`: `permitirDownload`, `permitirImpressao`, `permitirAbrirArquivoLocal`, `marcaDagua`, `tema`, `corPrimaria`, `sidebar` |
| `estado`       | — (o leitor responde com o evento `estado`) |

**Eventos enviados pelo leitor** (todos com `origem: "leitor-pdf"`):
`pronto`, `documentoCarregado` (`nome`, `totalPaginas`), `paginaAlterada`
(`pagina`, `totalPaginas`), `zoomAlterado`, `buscaConcluida`, `erro` (`mensagem`), `estado`.

Se o ERP estiver em outro domínio, inclua-o em `origensPermitidas` no `js/config.js`:

```js
origensPermitidas: ["https://erp.meuescritorio.com.br"],
```

### Dicas para o iframe

- `allow="fullscreen"` habilita o botão de tela cheia.
- Se usar `sandbox`, inclua pelo menos `allow-scripts allow-same-origin allow-downloads allow-modals allow-popups`.
- Os PDFs devem ser servidos com `Content-Type: application/pdf`. Se possível,
  também com suporte a `Range`: assim o pdf.js baixa só as partes necessárias
  de arquivos grandes.

## Segurança

- O pdf.js roda com `isEvalSupported: false` (mitiga a CVE-2024-4367) e sem suporte a XFA.
- Links externos do PDF abrem em nova aba com `noopener`. Só `http`, `https` e `mailto` são aceitos.
- Mensagens `postMessage` de origens não autorizadas são ignoradas.
- Desligar download/impressão **apenas oculta os botões**. Quem visualiza um PDF
  sempre consegue obter o conteúdo. Para documentos sigilosos, controle o acesso
  no próprio ERP e use a marca d’água com o nome do usuário.

## Atualizar o pdf.js

```bash
npm pack pdfjs-dist@<versão> && tar xzf pdfjs-dist-<versão>.tgz
cp package/legacy/build/pdf.min.mjs package/legacy/build/pdf.worker.min.mjs vendor/pdfjs/
cp -r package/cmaps package/standard_fonts vendor/pdfjs/
```

Depois de atualizar, teste a busca e a seleção de texto, porque a API `TextLayer`
muda entre versões principais.
