#!/usr/bin/env python3
"""Gera PDFs escaneados FICTÍCIOS de notificações do TRT-1 para testar o leitor.

Cada página é desenhada como imagem (sem camada de texto), com leve ruído e
inclinação, para obrigar o caminho do OCR. Nomes e números são inventados.

    python testes/gerar_exemplos.py testes/pdfs
"""
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTE = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONTE_N = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def cnj(seq: int, ano: int, vara: int) -> str:
    n = f"{seq:07d}"
    resto = int(f"{n}{ano}501{vara:04d}00") % 97
    return f"{n}-{98 - resto:02d}.{ano}.5.01.{vara:04d}"


NOTIFICACOES = [
    {   # telepresencial com Zoom
        "arquivo": "lote_semana_1.pdf",
        "processo": cnj(100123, 2025, 45), "vara": 45,
        "reclamante": "MARIA APARECIDA DOS SANTOS",
        "reclamado": "CASA DE PORTUGAL- HOSPITAL GERAL LTDA E OUTROS (3)",
        "destinatario": "CASA DE PORTUGAL- HOSPITAL GERAL LTDA / RUA BENTO LISBOA, 1000",
        "titulo": "AUDIÊNCIA UNA - TELEPRESENCIAL",
        "quando": "15/04/2026 às 10:30",
        "zoom": ("https://trt1-jus-br.zoom.us/j/81234567890?pwd=AbCdEf123", "812 3456 7890", "445566"),
    },
    {   # mesmo processo, outra empresa da rede (deve virar UMA linha)
        "arquivo": "lote_semana_1.pdf",
        "processo": cnj(100123, 2025, 45), "vara": 45,
        "reclamante": "MARIA APARECIDA DOS SANTOS",
        "reclamado": "CASA DE PORTUGAL- HOSPITAL GERAL LTDA E OUTROS (3)",
        "destinatario": "PRONTOCOR SERVICOS MEDICOS LTDA",
        "titulo": "AUDIÊNCIA UNA - TELEPRESENCIAL",
        "quando": "15/04/2026 às 10:30",
        "zoom": ("https://trt1-jus-br.zoom.us/j/81234567890?pwd=AbCdEf123", "812 3456 7890", "445566"),
    },
    {   # presencial, inicial, no fórum do Lavradio
        "arquivo": "lote_semana_2.pdf",
        "processo": cnj(100877, 2026, 12), "vara": 12,
        "reclamante": "JOSE CARLOS DA SILVA PEREIRA",
        "reclamado": "HOSPITAL ILHA DO GOVERNADOR S.A.",
        "destinatario": "HOSPITAL ILHA DO GOVERNADOR S.A.",
        "titulo": "AUDIÊNCIA INICIAL - PRESENCIAL",
        "quando": "22/04/2026 às 09:00",
        "forum": "Rua do Lavradio, 132, 5º andar, Centro, Rio de Janeiro/RJ, CEP 20230-070",
        "sem_testemunhas": True,
    },
]


def desenhar_pagina(linhas, largura=1654, altura=2339):
    img = Image.new("L", (largura, altura), 250)
    d = ImageDraw.Draw(img)
    y = 140
    for texto, tam, negrito in linhas:
        if texto is None:
            y += tam
            continue
        f = ImageFont.truetype(FONTE_N if negrito else FONTE, tam)
        d.text((150, y), texto, fill=20, font=f)
        y += int(tam * 1.55)
    # "escaneado": leve inclinação, desfoque e ruído
    img = img.rotate(random.uniform(-0.6, 0.6), fillcolor=250, resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    for _ in range(6000):
        px[random.randrange(largura), random.randrange(altura)] = random.choice((60, 120, 200))
    return img


def pagina_principal(n):
    L = [
        ("PODER JUDICIÁRIO", 30, True),
        ("JUSTIÇA DO TRABALHO", 30, True),
        ("TRIBUNAL REGIONAL DO TRABALHO DA 1ª REGIÃO", 28, False),
        (f"{n['vara']}ª Vara do Trabalho do Rio de Janeiro", 28, False),
        (None, 30, False),
        ("NOTIFICAÇÃO PJe-JT", 32, True),
        (f"PROCESSO: {n['processo']}", 28, False),
        (f"RECLAMANTE: {n['reclamante']}", 28, False),
        (f"RECLAMADO: {n['reclamado']}", 28, False),
        (None, 20, False),
        (f"DESTINATÁRIO: {n['destinatario']}", 28, False),
        (None, 30, False),
        (n["titulo"], 30, True),
        (None, 10, False),
        ("Fica Vossa Senhoria notificado(a) a comparecer à audiência designada", 26, False),
        (f"para o dia {n['quando']}, sob as penas da lei.", 26, False),
    ]
    if "zoom" in n:
        link, ident, senha = n["zoom"]
        L += [
            (None, 20, False),
            ("A audiência será realizada por videoconferência na plataforma Zoom:", 26, False),
            (link, 26, False),
            (f"ID da reunião: {ident}", 26, False),
            (f"Senha de acesso: {senha}", 26, False),
        ]
    if "forum" in n:
        L += [
            (None, 20, False),
            ("Local da audiência:", 26, False),
            (n["forum"], 24, False),
        ]
    if n.get("sem_testemunhas"):
        L += [(None, 20, False), ("Não será produzida prova testemunhal nesta audiência.", 26, False)]
    L += [(None, 60, False), ("Rio de Janeiro, 10/03/2026.", 26, False), ("Diretor de Secretaria", 26, False)]
    return desenhar_pagina(L)


def envelope(n):
    nome = n["destinatario"].split(" / ")[0]
    return desenhar_pagina([
        ("CORREIOS - CARTA REGISTRADA", 32, True),
        ("DATA DE POSTAGEM: 11/03/2026", 26, False),
        (None, 60, False),
        (nome, 30, False),
        ("RUA BENTO LISBOA, 1000", 28, False),
        ("CATETE - RIO DE JANEIRO/RJ", 28, False),
        ("CEP 22221-011", 28, False),
    ])


def main(destino: Path):
    random.seed(7)
    destino.mkdir(parents=True, exist_ok=True)
    por_arquivo = {}
    for n in NOTIFICACOES:
        por_arquivo.setdefault(n["arquivo"], []).extend([pagina_principal(n), envelope(n)])
    for nome, paginas in por_arquivo.items():
        paginas[0].save(destino / nome, save_all=True, append_images=paginas[1:], resolution=200)
        print(destino / nome, len(paginas), "páginas")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "testes/pdfs"))
