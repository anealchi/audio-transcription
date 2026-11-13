# CLAUDE.md

Este archivo sirve de guía a Claude Code (claude.ai/code) para trabajar con el código de este repositorio.

## Descripción general

Herramienta (`transcribir.py`, con una interfaz web opcional en `servidor.py` + `web/`) que transcribe el audio en español de `audio.mp4`, en la raíz del proyecto, a `audio.txt`, indicando en cada línea qué persona habla (`[mm:ss] Hablante N: texto`). Funciona totalmente en local, en Windows. El código, los comentarios, las opciones de línea de comandos, los mensajes al usuario y el README están en **español**; el código nuevo debe seguir igual.

## Normas de estilo

- Todos los archivos `.py` deben cumplir las normas de **flake8**. Revisa con `flake8 transcribir.py servidor.py` antes de dar un cambio por terminado. flake8 no está en `requirements.txt`; instálalo con `pip install flake8` dentro del entorno virtual. No hay configuración propia, así que se aplica la longitud máxima de línea por defecto (79 caracteres).

## Comandos

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

python transcribir.py                                  # GPU si la hay; si no, CPU
python transcribir.py --hablantes 2 --nombres "Ana,Luis"
python transcribir.py -o salida.txt --modelo medium --cpu
python transcribir.py --rapido                         # beam_size=1 en lugar de 5

python servidor.py                                     # interfaz web en http://127.0.0.1:8000
python servidor.py --puerto 8080 --sin-navegador
```

No hay tests ni proceso de compilación. Para probar cambios rápido, usa un `audio.mp4` corto y `--modelo tiny`.

## Arquitectura

`ejecutar(entrada, modelo, cpu, rapido, hablantes, avisar)` hace todo el proceso y devuelve una lista de `Intervencion(inicio, hablante, texto)`. La usan tanto `main()` (CLI) como `servidor.py`. El progreso no se imprime directamente: se comunica con el callback `avisar(fase, mensaje, fraccion)`. `avisar_consola` lo imprime y el servidor lo convierte en eventos. Fases: `preparacion`, `transcripcion`, `segmento`, `diarizacion` y `aviso`. Los pasos que sigue `ejecutar()`:

1. **Decodificar una vez**: `faster_whisper.decode_audio` (usa PyAV, no hace falta ffmpeg) carga `audio.mp4` como un array mono a 16 kHz. El mismo array se pasa a Whisper y a la diarización, así que ambos comparten la misma línea de tiempo.
2. **Transcribir** (`transcribir`): faster-whisper con `word_timestamps=True` y VAD; devuelve una lista plana de palabras `(inicio, fin, texto)`. La transcripción ocurre al recorrer el generador de segmentos.
3. **Diarizar** (`diarizar`): diarización offline de sherpa-onnx (segmentación de pyannote + embeddings de 3D-Speaker + clustering rápido), solo en CPU. `--hablantes` fija `num_clusters`; si no se indica, se usa `-1` con `threshold=0.5` y el diarizador decide cuántas personas hay.
4. **Combinar** (`asignar_hablantes`): cada palabra se asigna al turno de habla con el que más se solapa. Un solape negativo cuenta como distancia, así que una palabra que cae en un hueco va al turno más cercano.
5. **Agrupar** (`agrupar_por_hablante`): las palabras seguidas de un mismo hablante forman una `Intervencion`. Los ids de hablante se renumeran por orden de aparición, que es como `--nombres` asigna los nombres. `formatear_lineas` genera las líneas de texto finales.

Interfaz web (`servidor.py`, FastAPI):

- `GET /api/info` devuelve los modelos y si hay GPU. `POST /api/trabajos` recibe el archivo (multipart) y las opciones, lo guarda en una carpeta temporal (que se borra al terminar) y lo pone en cola. `GET /api/trabajos/{id}/eventos` envía el progreso por Server-Sent Events (`progreso`, `fin` con las intervenciones, o `error`).
- Un único hilo (`procesar_cola`) hace las transcripciones de una en una. Cada `Trabajo` guarda en memoria todos sus eventos, así que la página puede reconectarse (`Last-Event-ID`) sin perder ninguno.
- `cargar_whisper` deja el último modelo en caché (`lru_cache(maxsize=1)`) para no recargarlo en cada petición. Si CUDA falla, se vacía la caché para liberar la GPU.
- El frontend (`web/index.html`, `app.js`, `estilos.css`) es HTML/JS sin dependencias ni compilación. El renombrado de hablantes y la descarga del `.txt` se hacen en el navegador, sin volver a procesar el audio.
- El servidor solo escucha en `127.0.0.1`.

Detalles poco evidentes:

- **Varios equipos**: el proyecto se prueba en portátiles con CPU y GPU distintas, así que nada debe depender del hardware de una máquina concreta (número de hilos, GPU, memoria). Los hilos se calculan en cada ejecución con `num_hilos()` y se pasan tanto a Whisper (`cpu_threads`, que por defecto sería 4) como a los dos modelos de sherpa-onnx (`num_threads`, que por defecto sería 1).
- **Elección de GPU o CPU**: `registrar_dlls_cuda()` añade las carpetas `bin/` de los paquetes `nvidia-*` instalados con pip a `PATH` y a `add_dll_directory`. Tiene que ejecutarse *antes* de importar `faster_whisper` o `ctranslate2`. Después, `hay_gpu_cuda()` pregunta a CTranslate2 si hay GPU; si no la hay, se usa directamente la CPU sin intentar CUDA. Aunque haya GPU, si CUDA falla (`RuntimeError`/`OSError`/`ValueError`) la transcripción se repite en CPU con `int8` (en GPU se usa `float16`).
- **Imports diferidos**: las librerías pesadas (`faster_whisper`, `sherpa_onnx`, `truststore`) se importan dentro de las funciones para que la configuración de las DLL y la lectura de argumentos vayan primero.
- **Descarga de modelos**: los modelos de Whisper van a la caché de Hugging Face. Los de diarización se descargan de las releases de sherpa-onnx en GitHub a `modelos/` (ignorada por git). Cada descarga se escribe en un archivo `.part` y se renombra al terminar. Se usa `truststore` para SSL porque los certificados que trae Python fallan en algunos equipos Windows. La errata `speaker-recongition-models` de `URL_EMBEDDINGS` es la URL real del proyecto original: no hay que "corregirla".
- **Versiones fijadas** (`requirements.txt`): `av<16` porque PyAV 16 eliminó un parámetro que usa faster-whisper; `nvidia-cudnn-cu12==9.*` para que coincida con CTranslate2.
- **La ruta de entrada es fija en la CLI**: en la línea de comandos la entrada siempre es `RAIZ_PROYECTO / "audio.mp4"` y no es un argumento. Solo se puede cambiar la ruta de salida (`-o`). `ejecutar()` sí recibe la ruta, porque la interfaz web procesa el archivo que se sube.
- **Imports diferidos y CUDA en el servidor**: `servidor.py` llama a `registrar_dlls_cuda()` al arrancar, antes de que nada importe `faster_whisper`. La función usa `functools.cache`, así que solo se ejecuta una vez.
- **`.gitignore` excluye todos los `*.mp4` y `*.txt`** salvo `requirements.txt`. Cualquier `.txt` nuevo que deba versionarse necesita su propia excepción con `!`.
