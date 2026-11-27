"""Leitura do PDF gerado, como o comprador e a portaria o veriam.

Cada página é rasterizada com o pdfium (o motor de PDF do Chrome) e o QR code é
lido da imagem com o zxing-cpp, então o teste prova que o que foi impresso
decodifica para o `code` do ingresso, não só que o código foi passado adiante.
"""

from dataclasses import dataclass

import pypdfium2 as pdfium
import zxingcpp


@dataclass(frozen=True)
class Page:
    text: str
    qr_codes: list[str]


def read_pdf(content: bytes) -> list[Page]:
    document = pdfium.PdfDocument(content)
    try:
        pages = []
        for index in range(len(document)):
            page = document[index]
            text = page.get_textpage().get_text_range().replace("\r\n", "\n")
            image = page.render(scale=2).to_pil()
            codes = [result.text for result in zxingcpp.read_barcodes(image) if result.format.name == "QRCode"]
            pages.append(Page(text=text, qr_codes=codes))
        return pages
    finally:
        document.close()
