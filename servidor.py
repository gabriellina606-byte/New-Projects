#!/usr/bin/env python3
"""
Versão web do leitor de notificações trabalhistas, para usar dentro do ERP.

A página (web/) recebe os PDFs, mostra o andamento do OCR, deixa conferir e
editar cada linha (com o PDF original ao lado) e gera o Excel no modelo
"Audiências 2026". Toda a leitura é feita pelo leitor_processos.py.

Uso:
    python servidor.py                       # http://127.0.0.1:8000
    python servidor.py --host 0.0.0.0 --porta 8080

Variáveis de ambiente (opcionais):
    LEITOR_TOKEN            senha compartilhada exigida em todas as chamadas
                            (o ERP abre a página com ?token=...)
    LEITOR_ORIGENS_ERP      endereços que podem embutir a página em iframe,
                            separados por espaço (ex.: "https://erp.escritorio.com.br")
    LEITOR_PASTA_DADOS      onde ficam os PDFs enviados (padrão: ./dados)
    LEITOR_HORAS_RETENCAO   apaga leituras mais antigas que isso (padrão: 72)
    LEITOR_OCR_SIMULTANEOS  quantas leituras rodam ao mesmo tempo (padrão: 1)
    LEITOR_DPI              resolução do OCR (padrão: 300)
    LEITOR_MAX_MB           tamanho máximo do envio (padrão: 300)
    TESSERACT_CMD           caminho do tesseract.exe (Windows)
"""
import argparse
import hmac
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

import leitor_processos as lp

RAIZ = Path(__file__).resolve().parent
PASTA_WEB = RAIZ / "web"
PASTA_VISUALIZADOR = RAIZ / "visualizador"
PASTA_DADOS = Path(os.environ.get("LEITOR_PASTA_DADOS", RAIZ / "dados")).resolve()
TOKEN = os.environ.get("LEITOR_TOKEN", "")
ORIGENS_ERP = os.environ.get("LEITOR_ORIGENS_ERP", "").split()
HORAS_RETENCAO = float(os.environ.get("LEITOR_HORAS_RETENCAO", 72))
DPI = int(os.environ.get("LEITOR_DPI", 300))
ID_RE = re.compile(r"^[0-9a-f]{32}$")

if os.environ.get("TESSERACT_CMD"):
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = os.environ["TESSERACT_CMD"]

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("LEITOR_MAX_MB", 300)) * 1024 * 1024
app.json.ensure_ascii = False

lotes = {}  # id -> estado da leitura (também salvo em dados/<id>/lote.json)
trava = threading.Lock()
fila = ThreadPoolExecutor(max_workers=int(os.environ.get("LEITOR_OCR_SIMULTANEOS", 1)))


# --------------------------------------------------------------------------
# Segurança
# --------------------------------------------------------------------------
@app.before_request
def exigir_token():
    if not TOKEN or not request.path.startswith("/api/"):
        return None
    enviado = request.headers.get("X-Token") or request.args.get("token") or ""
    if not hmac.compare_digest(enviado, TOKEN):
        return jsonify(erro="Acesso não autorizado."), 401
    return None


@app.after_request
def cabecalhos(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if ORIGENS_ERP:
        resp.headers["Content-Security-Policy"] = "frame-ancestors 'self' " + " ".join(ORIGENS_ERP)
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------
# Lotes de leitura
# --------------------------------------------------------------------------
def pasta_lote(lote_id: str) -> Path:
    return PASTA_DADOS / lote_id


def salvar_lote(lote: dict):
    with trava:
        conteudo = json.dumps(lote, ensure_ascii=False, default=str)
    destino = pasta_lote(lote["id"]) / "lote.json"
    temporario = destino.with_suffix(".tmp")
    temporario.write_text(conteudo, encoding="utf-8")
    temporario.replace(destino)


def obter_lote(lote_id: str) -> dict:
    if not ID_RE.match(lote_id):
        abort(404)
    with trava:
        lote = lotes.get(lote_id)
    if lote is None:  # servidor reiniciado: lê do disco
        arquivo = pasta_lote(lote_id) / "lote.json"
        if not arquivo.exists():
            abort(404)
        lote = json.loads(arquivo.read_text(encoding="utf-8"))
        if lote["status"] in ("na_fila", "processando"):
            lote["status"] = "erro"
            lote["erro"] = "A leitura foi interrompida (o servidor reiniciou). Envie os arquivos de novo."
        with trava:
            lotes[lote_id] = lote
    return lote


def limpar_antigos():
    if not PASTA_DADOS.exists():
        return
    limite = time.time() - HORAS_RETENCAO * 3600
    for pasta in PASTA_DADOS.iterdir():
        if pasta.is_dir() and ID_RE.match(pasta.name) and pasta.stat().st_mtime < limite:
            with trava:
                lote = lotes.get(pasta.name)
                if lote and lote["status"] in ("na_fila", "processando"):
                    continue
                lotes.pop(pasta.name, None)
            shutil.rmtree(pasta, ignore_errors=True)


def nome_unico(nome: str, usados: set) -> str:
    nome = Path(nome or "documento.pdf").name.strip() or "documento.pdf"
    base, ext = os.path.splitext(nome)
    candidato, n = nome, 2
    while candidato.lower() in usados:
        candidato = f"{base} ({n}){ext}"
        n += 1
    usados.add(candidato.lower())
    return candidato


def processar_lote(lote_id: str):
    lote = lotes[lote_id]
    pasta = pasta_lote(lote_id)

    def atualizar(**campos):  # as rotas leem o lote enquanto ele é processado
        with trava:
            lote.update(campos)

    def avisar(texto):
        with trava:
            lote["avisos"].append(texto)

    atualizar(status="processando", inicio=time.time())
    todas = []
    try:
        for i, arq in enumerate(lote["arquivos"]):
            def progresso(pagina, total, i=i):
                atualizar(progresso={"arquivo": i, "pagina": pagina, "paginas": total})

            progresso(0, 1)
            try:
                paginas = lp.extrair_paginas(pasta / arq["salvo"], dpi=DPI, progresso=progresso)
            except Exception as e:  # PDF corrompido, protegido etc.
                with trava:
                    arq["erro"] = f"Não foi possível ler o arquivo: {e}"
                avisar(f"{arq['nome']}: {arq['erro']}")
                continue
            texto = "\n".join(f"\n=== PÁGINA {k} ===\n{t}" for k, t in enumerate(paginas, 1))
            (pasta / f"{arq['salvo']}.txt").write_text(texto, encoding="utf-8")
            notifs, orfas = lp.processar_paginas(paginas, arq["nome"])
            with trava:
                arq.update(paginas=len(paginas), notificacoes=len(notifs))
            if orfas:
                avisar(f"{arq['nome']}: páginas {orfas} não reconhecidas como notificação.")
            if not notifs:
                avisar(f"{arq['nome']}: nenhuma notificação encontrada.")
            todas += notifs

        linhas = lp.montar_linhas(lp.agrupar(todas))
        atualizar(linhas=linhas, notificacoes=len(todas), nome_excel=lp.nome_arquivo_padrao(linhas),
                  status="concluido")
    except Exception as e:
        app.logger.exception("Falha ao processar o lote %s", lote_id)
        atualizar(status="erro", erro=f"Erro inesperado na leitura: {e}")
    finally:
        with trava:
            lote["fim"] = time.time()
            lote.pop("progresso", None)
        salvar_lote(lote)


@app.post("/api/lotes")
def criar_lote():
    enviados = [f for f in request.files.getlist("arquivos") if f and f.filename]
    if not enviados:
        return jsonify(erro="Envie pelo menos um arquivo PDF."), 400
    limpar_antigos()

    lote_id = uuid.uuid4().hex
    pasta = pasta_lote(lote_id)
    pasta.mkdir(parents=True)
    arquivos, usados = [], set()
    for k, f in enumerate(enviados):
        cabeca = f.stream.read(1024)
        if b"%PDF" not in cabeca:
            shutil.rmtree(pasta, ignore_errors=True)
            return jsonify(erro=f"“{f.filename}” não é um PDF."), 400
        salvo = f"{k:03d}.pdf"
        with open(pasta / salvo, "wb") as destino:
            destino.write(cabeca)
            shutil.copyfileobj(f.stream, destino)
        arquivos.append({"nome": nome_unico(f.filename, usados), "salvo": salvo})

    lote = {
        "id": lote_id, "criado": time.time(), "status": "na_fila", "arquivos": arquivos,
        "avisos": [], "linhas": [], "erro": "",
    }
    with trava:
        lotes[lote_id] = lote
    salvar_lote(lote)
    fila.submit(processar_lote, lote_id)
    return jsonify(id=lote_id), 201


@app.get("/api/lotes/<lote_id>")
def ver_lote(lote_id):
    lote = obter_lote(lote_id)
    with trava:
        dados = json.loads(json.dumps(lote, ensure_ascii=False, default=str))
    for arq in dados["arquivos"]:
        arq.pop("salvo", None)
    if dados["status"] == "na_fila":
        with trava:
            dados["posicao_fila"] = sum(
                1 for l in lotes.values() if l["status"] in ("na_fila", "processando") and l["criado"] < lote["criado"]
            )
    return jsonify(dados)


@app.get("/api/lotes/<lote_id>/arquivos/<int:indice>")
def baixar_pdf(lote_id, indice):
    lote = obter_lote(lote_id)
    if not 0 <= indice < len(lote["arquivos"]):
        abort(404)
    arq = lote["arquivos"][indice]
    return send_from_directory(pasta_lote(lote_id), arq["salvo"], mimetype="application/pdf",
                               download_name=arq["nome"], conditional=True)


@app.get("/api/lotes/<lote_id>/texto/<int:indice>")
def ver_texto(lote_id, indice):
    """Texto lido pelo OCR (para entender por que um campo não foi encontrado)."""
    lote = obter_lote(lote_id)
    if not 0 <= indice < len(lote["arquivos"]):
        abort(404)
    caminho = pasta_lote(lote_id) / f"{lote['arquivos'][indice]['salvo']}.txt"
    if not caminho.exists():
        abort(404)
    return Response(caminho.read_text(encoding="utf-8"), mimetype="text/plain; charset=utf-8")


@app.post("/api/lotes/<lote_id>/excel")
def gerar_excel(lote_id):
    """Gera o Excel com as linhas como estão na tela (já conferidas/editadas)."""
    lote = obter_lote(lote_id)
    corpo = request.get_json(silent=True) or {}
    linhas = corpo.get("linhas", lote["linhas"])
    if not isinstance(linhas, list) or not all(isinstance(l, dict) for l in linhas):
        return jsonify(erro="Formato inválido."), 400
    buf = io.BytesIO()
    lp.gerar_excel(linhas, buf)
    buf.seek(0)
    nome = lp.nome_arquivo_padrao(linhas)
    resp = send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     as_attachment=True, download_name=nome)
    resp.headers["X-Nome-Arquivo"] = quote(nome)
    return resp


@app.get("/api/saude")
def saude():
    try:
        import pytesseract

        versao = str(pytesseract.get_tesseract_version())
        idiomas = pytesseract.get_languages()
    except Exception as e:
        return jsonify(ok=False, erro=f"Tesseract indisponível: {e}"), 503
    return jsonify(ok=True, tesseract=versao, portugues="por" in idiomas, token=bool(TOKEN))


# --------------------------------------------------------------------------
# Páginas
# --------------------------------------------------------------------------
@app.get("/")
def inicio():
    return send_from_directory(PASTA_WEB, "index.html")


@app.get("/web/<path:caminho>")
def arquivos_web(caminho):
    return send_from_directory(PASTA_WEB, caminho)


@app.get("/visualizador/<path:caminho>")
def visualizador(caminho):
    return send_from_directory(PASTA_VISUALIZADOR, caminho)


@app.errorhandler(413)
def grande_demais(_):
    return jsonify(erro=f"Envio maior que o limite de {app.config['MAX_CONTENT_LENGTH'] // 2**20} MB."), 413


def main():
    ap = argparse.ArgumentParser(description="Servidor web do leitor de notificações.")
    ap.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 para aceitar acessos da rede")
    ap.add_argument("--porta", type=int, default=8000)
    args = ap.parse_args()
    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    print(f"Leitor de notificações em http://{args.host}:{args.porta}")
    try:
        from waitress import serve
    except ImportError:
        print("(waitress não instalado: usando o servidor de desenvolvimento do Flask)")
        app.run(host=args.host, port=args.porta, threaded=True)
    else:
        serve(app, host=args.host, port=args.porta, threads=8)


if __name__ == "__main__":
    main()
