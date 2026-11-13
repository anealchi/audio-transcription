"""Interfaz web local del transcriptor (FastAPI + HTML/JS).

Uso:
    python servidor.py                       # abre http://127.0.0.1:8000
    python servidor.py --puerto 8080 --sin-navegador

Las transcripciones se hacen de una en una, en un hilo aparte. La página
sigue el progreso mediante Server-Sent Events (/api/trabajos/{id}/eventos).
"""

import argparse
import asyncio
import json
import queue
import shutil
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import transcribir as tr

CARPETA_WEB = tr.RAIZ_PROYECTO / "web"
PUERTO_POR_DEFECTO = 8000
INTERVALO_EVENTOS = 0.25  # segundos entre comprobaciones de eventos nuevos


@dataclass
class Trabajo:
    """Una transcripción pedida desde la página, con su historial de
    eventos (la página puede reconectarse y recibirlos de nuevo)."""
    ruta: Path  # copia temporal del archivo subido
    opciones: dict
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    eventos: list[dict] = field(default_factory=list)
    terminado: bool = False
    candado: threading.Lock = field(default_factory=threading.Lock)

    def emitir(self, tipo: str, final: bool = False, **datos) -> None:
        with self.candado:
            self.eventos.append({"tipo": tipo, **datos})
            self.terminado = self.terminado or final

    def eventos_desde(self, n: int) -> tuple[list[dict], bool]:
        with self.candado:
            return self.eventos[n:], self.terminado


trabajos: dict[str, Trabajo] = {}
cola: queue.Queue[Trabajo] = queue.Queue()


def procesar(trabajo: Trabajo) -> None:
    def avisar(fase: str, mensaje: str, fraccion: float | None) -> None:
        trabajo.emitir("progreso", fase=fase, mensaje=mensaje,
                       fraccion=fraccion)

    inicio = time.perf_counter()
    try:
        intervenciones = tr.ejecutar(trabajo.ruta, avisar=avisar,
                                     **trabajo.opciones)
    except Exception as e:  # cualquier fallo se muestra en la página
        traceback.print_exc()
        trabajo.emitir("error", final=True,
                       mensaje=str(e) or type(e).__name__)
    else:
        trabajo.emitir(
            "fin", final=True,
            segundos=round(time.perf_counter() - inicio, 1),
            intervenciones=[a_json(i) for i in intervenciones])
    finally:
        shutil.rmtree(trabajo.ruta.parent, ignore_errors=True)


def a_json(intervencion: tr.Intervencion) -> dict:
    """Intervención para la página. Los tiempos se redondean a centésimas
    para que el resultado de un audio largo no pese demasiado."""
    return {
        "inicio": round(intervencion.inicio, 2),
        "fin": round(intervencion.fin, 2),
        "tiempo": tr.formatear_tiempo(intervencion.inicio),
        "hablante": intervencion.hablante,
        "texto": intervencion.texto,
        # [inicio, fin, texto] de cada palabra, para resaltarlas al
        # reproducir el audio
        "palabras": [[round(inicio, 2), round(fin, 2), texto]
                     for inicio, fin, texto in intervencion.palabras],
    }


def procesar_cola() -> None:
    """Hilo que hace las transcripciones de una en una: varias a la vez
    saturarían la GPU o la CPU."""
    while True:
        procesar(cola.get())


app = FastAPI(title="Transcriptor")


@app.get("/api/info")
def info() -> dict:
    return {
        "modelos": tr.MODELOS,
        "modelo_por_defecto": tr.MODELO_POR_DEFECTO,
        "gpu": tr.hay_gpu_cuda(),
    }


@app.post("/api/trabajos")
def crear_trabajo(
    archivo: Annotated[UploadFile, File()],
    modelo: Annotated[str, Form()] = tr.MODELO_POR_DEFECTO,
    hablantes: Annotated[int | None, Form()] = None,
    cpu: Annotated[bool, Form()] = False,
    rapido: Annotated[bool, Form()] = False,
) -> dict:
    if modelo not in tr.MODELOS:
        raise HTTPException(422, f"Modelo desconocido: '{modelo}'.")
    if hablantes is not None and hablantes < 1:
        raise HTTPException(422, "El número de hablantes debe ser 1 o más.")

    # PyAV detecta el formato por el contenido; la extensión es solo ayuda
    sufijo = Path(archivo.filename or "").suffix
    if not sufijo[1:].isalnum():
        sufijo = ""
    carpeta = Path(tempfile.mkdtemp(prefix="transcriptor-"))
    ruta = carpeta / f"entrada{sufijo}"
    with ruta.open("wb") as destino:
        shutil.copyfileobj(archivo.file, destino)

    delante = sum(not t.terminado for t in trabajos.values())
    trabajo = Trabajo(ruta, {"modelo": modelo, "hablantes": hablantes,
                             "cpu": cpu, "rapido": rapido})
    if delante:
        trabajo.emitir("progreso", fase="cola", fraccion=None,
                       mensaje=f"En cola: {delante} transcripción(es) "
                               "por delante.")
    trabajos[trabajo.id] = trabajo
    cola.put(trabajo)
    return {"id": trabajo.id}


@app.get("/api/trabajos/{id_trabajo}/eventos")
async def eventos(id_trabajo: str, request: Request) -> StreamingResponse:
    trabajo = trabajos.get(id_trabajo)
    if trabajo is None:
        raise HTTPException(404, "No existe esa transcripción.")
    # Al reconectarse, EventSource indica el último evento que recibió
    try:
        siguiente = int(request.headers.get("last-event-id", -1)) + 1
    except ValueError:
        siguiente = 0

    async def generar():
        n = siguiente
        while True:
            nuevos, terminado = trabajo.eventos_desde(n)
            for evento in nuevos:
                datos = json.dumps(evento, ensure_ascii=False)
                yield f"id: {n}\ndata: {datos}\n\n"
                n += 1
            if terminado or await request.is_disconnected():
                return
            await asyncio.sleep(INTERVALO_EVENTOS)

    return StreamingResponse(generar(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


# Al final, para que las rutas /api tengan prioridad sobre los estáticos
app.mount("/", StaticFiles(directory=CARPETA_WEB, html=True), name="web")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interfaz web local del transcriptor.")
    parser.add_argument("--puerto", type=int, default=PUERTO_POR_DEFECTO,
                        help=f"Puerto (por defecto {PUERTO_POR_DEFECTO})")
    parser.add_argument("--sin-navegador", action="store_true",
                        help="No abrir el navegador al arrancar")
    args = parser.parse_args()

    tr.registrar_dlls_cuda()  # antes de que nada importe faster_whisper
    threading.Thread(target=procesar_cola, daemon=True).start()

    url = f"http://127.0.0.1:{args.puerto}"
    print(f"Interfaz disponible en {url} (Ctrl+C para salir)")
    if not args.sin_navegador:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    # Solo en local (127.0.0.1). El límite de cierre evita que una página
    # abierta escuchando eventos impida salir con Ctrl+C.
    uvicorn.run(app, host="127.0.0.1", port=args.puerto, log_level="warning",
                timeout_graceful_shutdown=2)


if __name__ == "__main__":
    main()
