"""Transcribe el audio (en español) de 'audio.mp4', en la raíz del
proyecto, a 'audio.txt', indicando qué hablante dice cada frase.

Uso:
    python transcribir.py
    python transcribir.py --hablantes 2 --nombres "Ana,Luis"
    python transcribir.py -o salida.txt --modelo medium --cpu
    python transcribir.py --preciso

Para usarlo desde el navegador, ejecuta 'python servidor.py'.
"""

import argparse
import functools
import os
import shutil
import ssl
import sys
import tarfile
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

MODELOS = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")
MODELO_POR_DEFECTO = "large-v3-turbo"
# Candidatos que Whisper explora en paralelo. Por defecto, búsqueda simple
# (1): en las pruebas en CPU fue un 17 % más rápida que explorar 5 y dio el
# mismo texto. La opción --preciso vuelve a explorar 5.
BEAM_POR_DEFECTO = 1
BEAM_PRECISO = 5
RAIZ_PROYECTO = Path(__file__).resolve().parent
ARCHIVO_ENTRADA = RAIZ_PROYECTO / "audio.mp4"
FRECUENCIA_MUESTREO = 16000
PUNTOS_ONDA = 1200  # picos de la forma de onda que dibuja la interfaz web

# Modelos de diarización (quién habla), de las releases oficiales de
# sherpa-onnx. "recongition" es la errata real de la URL: no corregirla.
# Embeddings: CAM++ entrenado con VoxCeleb. En las pruebas fue unas 2,3
# veces más rápido que ERes2Net (entrenado con hablantes chinos), que
# además partía en 3 hablantes un audio de una sola persona.
CARPETA_MODELOS = RAIZ_PROYECTO / "modelos"
RELEASES_SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
URL_SEGMENTACION = (RELEASES_SHERPA + "speaker-segmentation-models/"
                    "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2")
MODELO_SEGMENTACION = (CARPETA_MODELOS
                       / "sherpa-onnx-pyannote-segmentation-3-0"
                       / "model.onnx")
NOMBRE_EMBEDDINGS = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
URL_EMBEDDINGS = (RELEASES_SHERPA + "speaker-recongition-models/"
                  + NOMBRE_EMBEDDINGS)
MODELO_EMBEDDINGS = CARPETA_MODELOS / NOMBRE_EMBEDDINGS

# Silencia avisos irrelevantes de la descarga del modelo en Windows
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# Recibe (fase, mensaje, fracción completada de 0 a 1, o None si no se
# sabe). Fases: "preparacion", "transcripcion", "segmento" (una frase ya
# transcrita), "diarizacion" y "aviso" (un problema que no detiene el
# proceso, como no poder usar la GPU).
Avisar = Callable[[str, str, float | None], None]
Palabra = tuple[float, float, str]  # (inicio, fin, texto)
Turno = tuple[float, float, int]  # (inicio, fin, id interno del hablante)


class Intervencion(NamedTuple):
    """Palabras seguidas de un mismo hablante."""
    inicio: float
    fin: float
    hablante: int  # 0, 1, 2... por orden de aparición en el audio
    texto: str
    palabras: list[Palabra]  # la web las resalta al reproducir el audio


def avisar_consola(fase: str, mensaje: str, fraccion: float | None) -> None:
    """Muestra el progreso en la consola (uso desde la línea de comandos)."""
    if fase == "diarizacion" and fraccion is not None:
        fin = "\n" if fraccion >= 1 else ""
        print(f"\r{mensaje} {fraccion * 100:5.1f}%", end=fin, flush=True)
    else:
        print(mensaje, file=sys.stderr if fase == "aviso" else sys.stdout)


@functools.cache
def registrar_dlls_cuda() -> None:
    """Hace visibles las DLL de CUDA instaladas con pip (nvidia-cublas-cu12,
    nvidia-cudnn-cu12). Debe llamarse antes de importar faster_whisper."""
    try:
        import nvidia  # paquete "namespace" creado por los paquetes nvidia-*
    except ImportError:
        return
    for base in nvidia.__path__:
        for carpeta_bin in Path(base).glob("*/bin"):
            ruta = str(carpeta_bin)
            os.environ["PATH"] = ruta + os.pathsep + os.environ.get("PATH", "")
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(ruta)


@functools.cache
def hay_gpu_cuda() -> bool:
    """Indica si CTranslate2 (el motor de faster-whisper) ve una GPU NVIDIA.

    Debe llamarse después de registrar_dlls_cuda(). Detectar una GPU no
    garantiza que funcione (pueden faltar librerías CUDA), así que el
    programa mantiene además el paso a CPU si la transcripción falla.
    """
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except (ImportError, OSError, RuntimeError):
        return False


def num_hilos() -> int:
    """Hilos de CPU disponibles para este proceso en el equipo actual."""
    # process_cpu_count (Python 3.13+) respeta los núcleos asignados al
    # proceso; en versiones anteriores se usan todos los del equipo.
    contar = getattr(os, "process_cpu_count", os.cpu_count)
    return contar() or 1


def formatear_tiempo(segundos: float) -> str:
    total = int(segundos)
    h, resto = divmod(total, 3600)
    m, s = divmod(resto, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def calcular_onda(audio, puntos: int = PUNTOS_ONDA) -> list[float]:
    """Picos del audio normalizados de 0 a 1, para dibujar la forma de onda.

    Se normaliza con el percentil 99 para que un golpe aislado no aplane
    el resto de la onda."""
    import numpy as np

    n = len(audio)
    if n == 0:
        return []
    puntos = min(puntos, n)
    tramos = np.asarray(audio[:n - n % puntos]).reshape(puntos, -1)
    picos = np.abs(tramos).max(axis=1)
    techo = float(np.percentile(picos, 99)) or 1.0
    return [round(min(float(p) / techo, 1.0), 3) for p in picos]


# ------------------------------------------------------------ transcripción

@functools.lru_cache(maxsize=1)
def cargar_whisper(modelo: str, dispositivo: str):
    """Carga el modelo de Whisper. El último queda en memoria para que la
    interfaz web no tenga que recargarlo en cada transcripción."""
    from faster_whisper import WhisperModel

    tipo = "float16" if dispositivo == "cuda" else "int8"
    # cpu_threads solo afecta a la CPU (por defecto faster-whisper usa 4)
    return WhisperModel(modelo, device=dispositivo, compute_type=tipo,
                        cpu_threads=num_hilos())


def transcribir(audio, modelo: str, dispositivo: str, beam_size: int,
                avisar: Avisar = avisar_consola) -> list[Palabra]:
    """Devuelve la lista de palabras (inicio, fin, texto) del audio."""
    if dispositivo == "cuda":
        detalle = "float16"
    else:
        detalle = f"int8, {num_hilos()} hilos"
    avisar("transcripcion", f"Cargando modelo '{modelo}' en "
           f"{dispositivo.upper()} ({detalle})...", None)
    whisper = cargar_whisper(modelo, dispositivo)

    segmentos, info = whisper.transcribe(
        audio,
        language="es",
        beam_size=beam_size,
        vad_filter=True,
        word_timestamps=True,
    )
    duracion = info.duration
    avisar("transcripcion", f"Duración del audio: "
           f"{formatear_tiempo(duracion)}. Transcribiendo...", None)

    palabras = []
    for seg in segmentos:  # la transcripción ocurre al recorrer el generador
        texto = seg.text.strip()
        if not texto:
            continue
        fraccion = min(seg.end / duracion, 1.0) if duracion else None
        avisar("segmento", f"[{formatear_tiempo(seg.start)}] {texto}",
               fraccion)
        palabras.extend((p.start, p.end, p.word) for p in (seg.words or []))
    return palabras


# -------------------------------------------------------------- diarización

def descargar(url: str, destino: Path, avisar: Avisar) -> Path:
    # truststore verifica los certificados con el sistema operativo (en
    # Windows, el ssl de Python puede fallar con "unable to get issuer
    # certificate" si falta un certificado raíz en el almacén).
    import truststore

    destino.parent.mkdir(parents=True, exist_ok=True)
    temporal = destino.with_name(destino.name + ".part")
    avisar("diarizacion", f"Descargando {destino.name}...", None)
    contexto = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    try:
        with (urllib.request.urlopen(url, context=contexto) as respuesta,
              open(temporal, "wb") as archivo):
            shutil.copyfileobj(respuesta, archivo)
    except BaseException:
        temporal.unlink(missing_ok=True)
        raise
    temporal.replace(destino)
    return destino


def descargar_modelos(avisar: Avisar) -> None:
    """Descarga los modelos de diarización a 'modelos/' si aún no están."""
    if not MODELO_SEGMENTACION.is_file():
        archivo = descargar(
            URL_SEGMENTACION,
            CARPETA_MODELOS / URL_SEGMENTACION.rsplit("/", 1)[1], avisar)
        with tarfile.open(archivo, "r:bz2") as tar:
            tar.extractall(CARPETA_MODELOS, filter="data")
        archivo.unlink()
    if not MODELO_EMBEDDINGS.is_file():
        descargar(URL_EMBEDDINGS, MODELO_EMBEDDINGS, avisar)


def diarizar(audio, num_hablantes: int | None,
             avisar: Avisar = avisar_consola) -> list[Turno]:
    """Devuelve los turnos de habla (inicio, fin, id_hablante) ordenados
    por inicio."""
    import sherpa_onnx

    descargar_modelos(avisar)
    hilos = num_hilos()  # sherpa-onnx usa 1 hilo si no se indica
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(MODELO_SEGMENTACION)),
            num_threads=hilos,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(MODELO_EMBEDDINGS), num_threads=hilos),
        clustering=sherpa_onnx.FastClusteringConfig(
            # -1 = detectar el número de hablantes automáticamente
            num_clusters=num_hablantes or -1,
            threshold=0.5,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Configuración de diarización no válida: "
                           "revisa la carpeta 'modelos/'.")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    if sd.sample_rate != FRECUENCIA_MUESTREO:
        raise RuntimeError(
            f"El modelo de diarización espera {sd.sample_rate} Hz.")

    mensaje = f"Identificando hablantes ({hilos} hilos)..."
    avisar("diarizacion", mensaje, 0.0)

    def progreso(hechos: int, total: int) -> int:
        avisar("diarizacion", mensaje, hechos / total if total else 1.0)
        return 0

    resultado = sd.process(audio, callback=progreso).sort_by_start_time()
    return [(r.start, r.end, r.speaker) for r in resultado]


def asignar_hablantes(palabras, turnos) -> list[int]:
    """Asigna a cada palabra el hablante del turno con el que más se solapa
    (o el más cercano)."""
    if not turnos:
        return [0] * len(palabras)
    hablantes = []
    for inicio, fin, _ in palabras:
        mejor, mejor_puntuacion = turnos[0][2], float("-inf")
        for t_inicio, t_fin, hablante in turnos:
            # negativo = distancia entre la palabra y el turno
            solape = min(fin, t_fin) - max(inicio, t_inicio)
            if solape > mejor_puntuacion:
                mejor, mejor_puntuacion = hablante, solape
        hablantes.append(mejor)
    return hablantes


def agrupar_por_hablante(palabras, hablantes) -> list[Intervencion]:
    """Une las palabras consecutivas del mismo hablante y renumera los
    hablantes por orden de aparición."""
    grupos: list[tuple[int, list[Palabra]]] = []
    for palabra, hablante in zip(palabras, hablantes):
        if not grupos or grupos[-1][0] != hablante:
            grupos.append((hablante, []))
        grupos[-1][1].append(palabra)
    orden: dict[int, int] = {}  # id interno -> número por orden de aparición
    return [Intervencion(inicio=suyas[0][0], fin=suyas[-1][1],
                         hablante=orden.setdefault(h, len(orden)),
                         texto="".join(p[2] for p in suyas).strip(),
                         palabras=suyas)
            for h, suyas in grupos]


def etiqueta_hablante(hablante: int, nombres: list[str]) -> str:
    if hablante < len(nombres):
        return nombres[hablante]
    return f"Hablante {hablante + 1}"


def formatear_lineas(intervenciones: list[Intervencion],
                     nombres: list[str]) -> list[str]:
    """Líneas '[mm:ss] Etiqueta: texto', una por intervención."""
    return [f"[{formatear_tiempo(i.inicio)}] "
            f"{etiqueta_hablante(i.hablante, nombres)}: {i.texto}"
            for i in intervenciones]


# ----------------------------------------------------------------- programa

def ejecutar(entrada: Path, modelo: str = MODELO_POR_DEFECTO,
             cpu: bool = False, preciso: bool = False,
             hablantes: int | None = None,
             avisar: Avisar = avisar_consola,
             al_leer_audio: Callable[[list[float], float], None] | None = None,
             ) -> list[Intervencion]:
    """Transcribe y diariza 'entrada'. Lo usan la línea de comandos y la
    interfaz web. Si se indica, 'al_leer_audio' recibe la forma de onda
    (calcular_onda) y la duración en segundos nada más leer el audio."""
    usar_gpu = False
    if not cpu:
        registrar_dlls_cuda()  # antes de importar faster_whisper/ctranslate2
        usar_gpu = hay_gpu_cuda()
        if not usar_gpu:
            avisar("preparacion",
                   "No se ha detectado una GPU NVIDIA: se usará la CPU.", None)
    beam = BEAM_PRECISO if preciso else BEAM_POR_DEFECTO

    from faster_whisper import decode_audio

    avisar("preparacion", "Leyendo el audio...", None)
    audio = decode_audio(str(entrada), sampling_rate=FRECUENCIA_MUESTREO)
    if al_leer_audio is not None:
        al_leer_audio(calcular_onda(audio), len(audio) / FRECUENCIA_MUESTREO)

    palabras = None
    if usar_gpu:
        try:
            palabras = transcribir(audio, modelo, "cuda", beam, avisar)
        except (RuntimeError, OSError, ValueError) as e:
            # GPU detectada, pero faltan librerías CUDA o no hay memoria
            cargar_whisper.cache_clear()  # libera la memoria de la GPU
            avisar("aviso", f"No se pudo usar la GPU ({e}). "
                   "Reintentando en CPU...", None)
    if palabras is None:
        palabras = transcribir(audio, modelo, "cpu", beam, avisar)

    turnos = diarizar(audio, hablantes, avisar)
    return agrupar_por_hablante(palabras, asignar_hablantes(palabras, turnos))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=f"Transcribe el audio en español de "
                    f"'{ARCHIVO_ENTRADA.name}' (raíz del proyecto) a un "
                    f".txt, indicando quién habla.")
    parser.add_argument(
        "-o", "--salida", type=Path,
        help=f"Ruta del .txt (por defecto, "
             f"{ARCHIVO_ENTRADA.with_suffix('.txt').name} en la raíz)")
    parser.add_argument(
        "--modelo", default=MODELO_POR_DEFECTO,
        help=f"Modelo de Whisper: {', '.join(MODELOS)}... "
             f"(por defecto {MODELO_POR_DEFECTO})")
    parser.add_argument("--cpu", action="store_true",
                        help="Forzar el uso de CPU en lugar de la GPU")
    parser.add_argument("--preciso", action="store_true",
                        help="Explorar más candidatos al transcribir: más "
                             "lento y a veces algo más preciso "
                             f"(beam_size={BEAM_PRECISO} en lugar de "
                             f"{BEAM_POR_DEFECTO})")
    parser.add_argument("--hablantes", type=int,
                        help="Número de personas que hablan, si se conoce "
                             "(mejora la precisión)")
    parser.add_argument("--nombres",
                        help="Nombres separados por comas, en orden de "
                             'aparición. Ej.: --nombres "Ana,Luis"')
    args = parser.parse_args()

    if args.hablantes is not None and args.hablantes < 1:
        parser.error("--hablantes debe ser 1 o más.")
    nombres = [n.strip() for n in (args.nombres or "").split(",")
               if n.strip()]

    entrada = ARCHIVO_ENTRADA
    if not entrada.is_file():
        print(f"Error: no existe '{entrada.name}' en la raíz del proyecto "
              f"({RAIZ_PROYECTO}).", file=sys.stderr)
        return 1
    salida: Path = args.salida or entrada.with_suffix(".txt")

    inicio = time.perf_counter()
    intervenciones = ejecutar(entrada, args.modelo, args.cpu, args.preciso,
                              args.hablantes)
    lineas = formatear_lineas(intervenciones, nombres)

    salida.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lineas))
    print(f"\nListo en {time.perf_counter() - inicio:.1f} s. "
          f"Transcripción guardada en: {salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
