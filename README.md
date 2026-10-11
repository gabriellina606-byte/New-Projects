# Leitor de Audiências

Lê as **notificações trabalhistas escaneadas (PDF)**, usando OCR, e monta a
planilha de audiências no modelo **"Audiências 2026"**:

`STATUS | DATA | HORA | HOSPITAL | RECLAMANTE | PROCESSO | VARA | MODALIDADE | AUDIÊNCIAS | TESTEMUNHAS | OBSERVAÇÃO | LINK E SENHA`

Pode ser usado de dois jeitos:

- **Página web, dentro do ERP** (`servidor.py`): envia os PDFs pelo navegador,
  confere e edita cada linha vendo o documento original ao lado, e baixa o Excel.
- **Linha de comando** (`leitor_processos.py`): lê uma pasta de PDFs e gera o Excel direto,
  como antes.

## Instalação

1. Python 3.10 ou mais novo.
2. Tesseract OCR com o idioma **português**:
   - Windows: instalador do [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki).
     Marque "Portuguese" em *Additional language data*.
   - Linux: `sudo apt install tesseract-ocr tesseract-ocr-por`
3. Dependências do Python:

```bash
pip install -r requirements.txt
```

## Versão web

```bash
python servidor.py                          # só neste computador: http://127.0.0.1:8000
python servidor.py --host 0.0.0.0 --porta 8080   # acessível pela rede do escritório
```

No Windows, se o Tesseract não estiver no PATH:

```bat
set TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
python servidor.py --host 0.0.0.0 --porta 8080
```

### Como funciona

1. **Enviar:** arraste os PDFs da semana para a página. Pode enviar vários de uma vez.
2. **Ler:** a página mostra o andamento ("arquivo 1 de 3, página 2 de 8"). O OCR leva
   alguns segundos por página. Se a página for fechada, a leitura continua no servidor:
   o endereço (`#lote=…`) leva de volta ao resultado.
3. **Conferir:** linhas com alerta ficam marcadas em amarelo. Clique no ⚠ para ver:
   - os pontos a conferir (ex.: "Link do Zoom lido por OCR");
   - como os nomes aparecem no documento;
   - o **PDF original aberto na página da notificação**, ao lado da tabela.

   Edite o que for preciso direto na tabela e marque **Conferido**.
   As edições ficam salvas no navegador. "Desfazer todas as edições" volta ao que o OCR leu.
4. **Baixar Excel:** gera a planilha com as linhas como estão na tela. O nome do arquivo
   sai pelas datas (`Audiências_2026_-_15_04_2026_a_22_04_2026.xlsx`). Linhas ainda não
   conferidas saem com o processo em amarelo e o alerta no comentário da célula. A aba
   "Conferir" tem os nomes completos, os alertas e a origem de cada linha.

O botão **OCR**, no painel do documento, mostra o texto que o Tesseract leu. Ele ajuda a
entender por que um campo não foi encontrado.

### Colocar dentro do ERP

Abra a página num `<iframe>` (ou num link) do ERP:

```html
<iframe src="http://servidor-do-escritorio:8080/" style="width:100%;height:100%;border:0"></iframe>
```

Configurações por variável de ambiente:

| Variável | Para que serve |
|---|---|
| `LEITOR_TOKEN` | Senha compartilhada. Sem ela, a API recusa os pedidos. O ERP abre a página com `?token=…` (o token sai da barra de endereço e fica só na aba). |
| `LEITOR_ORIGENS_ERP` | Endereços que podem embutir a página em iframe, separados por espaço (ex.: `https://erp.escritorio.com.br`). Se ficar vazio, qualquer site pode embutir. |
| `LEITOR_PASTA_DADOS` | Onde ficam os PDFs enviados (padrão `./dados`). |
| `LEITOR_HORAS_RETENCAO` | Leituras mais antigas que isso são apagadas (padrão 72 h). |
| `LEITOR_OCR_SIMULTANEOS` | Quantas leituras rodam ao mesmo tempo (padrão 1; as outras esperam na fila). |
| `LEITOR_DPI` | Resolução do OCR (padrão 300). |
| `LEITOR_MAX_MB` | Tamanho máximo de um envio (padrão 300 MB). |
| `TESSERACT_CMD` | Caminho do `tesseract.exe`. |

> Os documentos têm dados pessoais. Mantenha o servidor só na rede interna (ou atrás do
> login do ERP), use `LEITOR_TOKEN` e não aumente a retenção mais do que o necessário.

### API (para automatizar pelo ERP)

| Método | Caminho | |
|---|---|---|
| `POST` | `/api/lotes` | envia os PDFs (`multipart`, campo `arquivos`); responde `{"id": …}` |
| `GET` | `/api/lotes/<id>` | andamento (`na_fila`, `processando`, `concluido`, `erro`) e as linhas |
| `POST` | `/api/lotes/<id>/excel` | gera o Excel; corpo opcional `{"linhas": [...]}` com as linhas editadas |
| `GET` | `/api/lotes/<id>/arquivos/<n>` | PDF original nº `n` |
| `GET` | `/api/lotes/<id>/texto/<n>` | texto lido pelo OCR do PDF nº `n` |
| `GET` | `/api/saude` | confere se o Tesseract (com português) está disponível |

## Linha de comando

```bash
python leitor_processos.py pasta_com_pdfs                 # nome do Excel sai pelas datas
python leitor_processos.py pasta_com_pdfs -o semana.xlsx --salvar-texto
python leitor_processos.py pasta_com_pdfs --tesseract-cmd "C:/Program Files/Tesseract-OCR/tesseract.exe"
```

As regras de leitura (apelidos dos hospitais, status padrão etc.) ficam no topo do
`leitor_processos.py`. A versão web usa o mesmo arquivo: uma mudança lá vale para as duas.

## Testes

```bash
python -m unittest discover -s testes -v
```

`testes/gerar_exemplos.py` cria notificações **fictícias** escaneadas (só imagem, com ruído)
para testar o OCR de ponta a ponta. Os testes cobrem os erros de OCR já vistos: `5:01` no
lugar de `5.01` no nº do processo, letra solta depois de "S.A." e `trtl` no link do Zoom.

## Estrutura

```
leitor_processos.py   leitura dos PDFs, regras de extração e geração do Excel (também é a linha de comando)
servidor.py           servidor web (Flask/waitress)
web/                  página do leitor de audiências
visualizador/         visualizador de PDF usado para mostrar o documento original (pdf.js)
testes/               testes e gerador de PDFs fictícios
```
