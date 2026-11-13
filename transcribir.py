"""Transcribe el audio (en español) de 'audio.mp4', en la raíz del proyecto, a 'audio.txt',
indicando qué hablante dice cada frase.

Uso:
    python transcribir.py
    python transcribir.py --hablantes 2 --nombres "Ana,Luis"
    python transcribir.py -o salida.txt --modelo medium --cpu
    python transcribir.py --rapido
"""

import argparse
import os
import shutil
import ssl
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

MODELO_POR_DEFECTO = "large-v3-turbo"
# Candidatos que Whisper explora en paralelo: más = algo más preciso pero
# más lento; 1 = búsqueda simple (opción --rapido)
BEAM_POR_DEFECTO = 5
BEAM_RAPIDO = 1
RAIZ_PROYECTO = Path(__file__).resolve().parent
ARCHIVO_ENTRADA = RAIZ_PROYECTO / "audio.mp4"
FRECUENCIA_MUESTREO = 16000

# Modelos de diarización (quién habla), de las releases oficiales de sherpa-onnx
CARPETA_MODELOS = RAIZ_PROYECTO / "modelos"
URL_SEGMENTACION = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
                    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2")
MODELO_SEGMENTACION = CARPETA_MODELOS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
URL_EMBEDDINGS = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
                  "speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx")
MODELO_EMBEDDINGS = CARPETA_MODELOS / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

# Silencia avisos irrelevantes de la descarga del modelo en Windows
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def registrar_dlls_cuda() -> None:
    """Hace visibles las DLL de CUDA instaladas con pip (nvidia-cublas-cu12, nvidia-cudnn-cu12)."""
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


# --------------------------------------------------------------------------- transcripción

def transcribir(audio, modelo: str, dispositivo: str,
                beam_size: int) -> list[tuple[float, float, str]]:
    """Devuelve la lista de palabras (inicio, fin, texto) del audio."""
    from faster_whisper import WhisperModel

    if dispositivo == "cuda":
        tipo, detalle = "float16", "float16"
    else:
        tipo, detalle = "int8", f"int8, {num_hilos()} hilos"
    print(f"Cargando modelo '{modelo}' en {dispositivo.upper()} "
          f"({detalle})...")
    # cpu_threads solo afecta a la CPU (por defecto faster-whisper usa 4)
    whisper = WhisperModel(modelo, device=dispositivo, compute_type=tipo,
                           cpu_threads=num_hilos())

    segmentos, info = whisper.transcribe(
        audio,
        language="es",
        beam_size=beam_size,
        vad_filter=True,
        word_timestamps=True,
    )
    print(f"Duración del audio: {formatear_tiempo(info.duration)}. Transcribiendo...\n")

    palabras = []
    for seg in segmentos:  # la transcripción ocurre al recorrer el generador
        texto = seg.text.strip()
        if not texto:
            continue
        print(f"[{formatear_tiempo(seg.start)}] {texto}")
        palabras.extend((p.start, p.end, p.word) for p in (seg.words or []))
    return palabras


# --------------------------------------------------------------------------- diarización

def descargar(url: str, destino: Path) -> Path:
    # truststore verifica los certificados con el sistema operativo (en Windows, el ssl de Python
    # puede fallar con "unable to get issuer certificate" si falta un certificado raíz en el almacén).
    import truststore

    destino.parent.mkdir(parents=True, exist_ok=True)
    temporal = destino.with_name(destino.name + ".part")
    print(f"Descargando {destino.name}...")
    contexto = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    try:
        with urllib.request.urlopen(url, context=contexto) as respuesta, open(temporal, "wb") as archivo:
            shutil.copyfileobj(respuesta, archivo)
    except BaseException:
        temporal.unlink(missing_ok=True)
        raise
    temporal.replace(destino)
    return destino


def descargar_modelos() -> None:
    """Descarga los modelos de diarización a 'modelos/' si aún no están."""
    if not MODELO_SEGMENTACION.is_file():
        archivo = descargar(URL_SEGMENTACION, CARPETA_MODELOS / Path(URL_SEGMENTACION).name)
        with tarfile.open(archivo, "r:bz2") as tar:
            tar.extractall(CARPETA_MODELOS, filter="data")
        archivo.unlink()
    if not MODELO_EMBEDDINGS.is_file():
        descargar(URL_EMBEDDINGS, MODELO_EMBEDDINGS)


def diarizar(audio, num_hablantes: int | None) -> list[tuple[float, float, int]]:
    """Devuelve los turnos de habla (inicio, fin, id_hablante) ordenados por inicio."""
    import sherpa_onnx

    descargar_modelos()
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
            num_clusters=num_hablantes or -1,  # -1 = detectar el número automáticamente
            threshold=0.5,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Configuración de diarización no válida: revisa la carpeta 'modelos/'.")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    if sd.sample_rate != FRECUENCIA_MUESTREO:
        raise RuntimeError(f"El modelo de diarización espera {sd.sample_rate} Hz.")

    def progreso(hechos: int, total: int) -> int:
        print(f"\rIdentificando hablantes ({hilos} hilos)... "
              f"{hechos / total * 100:5.1f}%", end="", flush=True)
        return 0

    resultado = sd.process(audio, callback=progreso).sort_by_start_time()
    print()
    return [(r.start, r.end, r.speaker) for r in resultado]


def asignar_hablantes(palabras, turnos) -> list[int]:
    """Asigna a cada palabra el hablante del turno con el que más se solapa (o el más cercano)."""
    if not turnos:
        return [0] * len(palabras)
    hablantes = []
    for inicio, fin, _ in palabras:
        mejor, mejor_puntuacion = turnos[0][2], float("-inf")
        for t_inicio, t_fin, hablante in turnos:
            solape = min(fin, t_fin) - max(inicio, t_inicio)  # negativo = distancia entre ambos
            if solape > mejor_puntuacion:
                mejor, mejor_puntuacion = hablante, solape
        hablantes.append(mejor)
    return hablantes


def agrupar_por_hablante(palabras, hablantes, nombres: list[str]) -> list[str]:
    """Une palabras consecutivas del mismo hablante en líneas '[mm:ss] Etiqueta: texto'."""
    orden: dict[int, int] = {}  # id interno -> número por orden de aparición

    def etiqueta(hablante: int) -> str:
        n = orden.setdefault(hablante, len(orden))
        return nombres[n] if n < len(nombres) else f"Hablante {n + 1}"

    lineas = []
    actual, inicio, trozos = None, 0.0, []
    for (p_inicio, _, texto), hablante in zip(palabras, hablantes):
        if hablante != actual:
            if trozos:
                lineas.append(f"[{formatear_tiempo(inicio)}] {etiqueta(actual)}: {''.join(trozos).strip()}")
            actual, inicio, trozos = hablante, p_inicio, []
        trozos.append(texto)
    if trozos:
        lineas.append(f"[{formatear_tiempo(inicio)}] {etiqueta(actual)}: {''.join(trozos).strip()}")
    return lineas


# --------------------------------------------------------------------------- programa

def main() -> int:
    parser = argparse.ArgumentParser(
        description=f"Transcribe el audio en español de '{ARCHIVO_ENTRADA.name}' (raíz del proyecto) "
                    f"a un .txt, indicando quién habla.")
    parser.add_argument("-o", "--salida", type=Path,
                        help=f"Ruta del .txt (por defecto, {ARCHIVO_ENTRADA.with_suffix('.txt').name} en la raíz)")
    parser.add_argument("--modelo", default=MODELO_POR_DEFECTO,
                        help=f"Modelo de Whisper: tiny, base, small, medium, large-v3, large-v3-turbo... "
                             f"(por defecto {MODELO_POR_DEFECTO})")
    parser.add_argument("--cpu", action="store_true", help="Forzar el uso de CPU en lugar de la GPU")
    parser.add_argument("--rapido", action="store_true",
                        help="Transcripción más rápida y algo menos precisa "
                             f"(beam_size={BEAM_RAPIDO} en lugar de "
                             f"{BEAM_POR_DEFECTO})")
    parser.add_argument("--hablantes", type=int,
                        help="Número de personas que hablan, si se conoce (mejora la precisión)")
    parser.add_argument("--nombres",
                        help='Nombres separados por comas, en orden de aparición. Ej.: --nombres "Ana,Luis"')
    args = parser.parse_args()

    if args.hablantes is not None and args.hablantes < 1:
        parser.error("--hablantes debe ser 1 o más.")
    nombres = [n.strip() for n in (args.nombres or "").split(",") if n.strip()]

    entrada = ARCHIVO_ENTRADA
    if not entrada.is_file():
        print(f"Error: no existe '{entrada.name}' en la raíz del proyecto ({RAIZ_PROYECTO}).", file=sys.stderr)
        return 1
    salida: Path = args.salida or entrada.with_suffix(".txt")

    inicio = time.perf_counter()
    usar_gpu = False
    if not args.cpu:
        registrar_dlls_cuda()  # antes de importar faster_whisper/ctranslate2
        usar_gpu = hay_gpu_cuda()
        if not usar_gpu:
            print("No se ha detectado una GPU NVIDIA: se usará la CPU.")
    beam = BEAM_RAPIDO if args.rapido else BEAM_POR_DEFECTO

    from faster_whisper import decode_audio
    audio = decode_audio(str(entrada), sampling_rate=FRECUENCIA_MUESTREO)

    if not usar_gpu:
        palabras = transcribir(audio, args.modelo, "cpu", beam)
    else:
        try:
            palabras = transcribir(audio, args.modelo, "cuda", beam)
        except (RuntimeError, OSError, ValueError) as e:
            # GPU detectada, pero faltan librerías CUDA o no hay memoria
            print(f"\nNo se pudo usar la GPU ({e}).\n"
                  "Reintentando en CPU...\n", file=sys.stderr)
            palabras = transcribir(audio, args.modelo, "cpu", beam)

    print()
    turnos = diarizar(audio, args.hablantes)
    lineas = agrupar_por_hablante(palabras, asignar_hablantes(palabras, turnos), nombres)

    salida.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lineas))
    print(f"\nListo en {time.perf_counter() - inicio:.1f} s. Transcripción guardada en: {salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
