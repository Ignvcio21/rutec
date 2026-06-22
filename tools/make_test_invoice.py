"""Genera una factura de prueba (imagen) para validar el OCR."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).resolve().parent / "test_factura.png"
img = Image.new("RGB", (900, 600), "white")
d = ImageDraw.Draw(img)

def font(sz):
    try:
        return ImageFont.truetype("arial.ttf", sz)
    except Exception:
        return ImageFont.load_default()

d.rectangle([10, 10, 890, 590], outline="black", width=2)
d.text((30, 30), "COSAM SUR SPA", font=font(34), fill="black")
d.text((30, 75), "COMERCIALIZACION Y DISTRIBUCION DE PRODUCTOS", font=font(16), fill="black")
d.text((600, 30), "FACTURA ELECTRONICA", font=font(20), fill="black")
d.text((600, 60), "Nro.: 0002164287", font=font(18), fill="black")

d.line([20, 130, 880, 130], fill="black", width=1)
d.text((30, 150), "FECHA EMISION:  18 Junio 2026", font=font(20), fill="black")
d.text((30, 190), "SENOR(ES):  COMERCIALIZADORA ELIMELEC SPA", font=font(22), fill="black")
d.text((30, 230), "DIRECCION:  5 PONIENTE 3 Y 4 NORTE 1433", font=font(22), fill="black")
d.text((30, 270), "GIRO:  ALMACEN", font=font(20), fill="black")
d.text((600, 190), "COMUNA:  TALCA", font=font(22), fill="black")
d.text((600, 230), "VENDEDOR:  009", font=font(20), fill="black")

d.line([20, 320, 880, 320], fill="black", width=1)
d.text((30, 340), "CODIGO   DESCRIPCION                CANT   VALOR", font=font(18), fill="black")
d.text((30, 375), "312988   FLIPY 30 X 90 GR            10     6.303", font=font(18), fill="black")
d.text((30, 405), "385002   BOMBON CEREZAS 2 KG         1      27.975", font=font(18), fill="black")

img.save(OUT)
print("OK ->", OUT)
