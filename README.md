# Transcripción de audio (.mp4 → .txt)

Transcribe el audio en español de `audio.mp4` (en la raíz del proyecto) a un archivo `.txt`, en local,
indicando qué persona dice cada frase. Usa [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
para el texto (con la GPU NVIDIA si está disponible y, si no, la CPU) y
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) para distinguir las voces. No necesita ffmpeg instalado.

## Instalación (una sola vez)

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

La primera ejecución descarga los modelos: Whisper (~1,6 GB para `large-v3-turbo`) y los de
identificación de voces (~40 MB, en la carpeta `modelos/`).

## Uso

Coloca el vídeo en la raíz del proyecto con el nombre `audio.mp4` y ejecuta:

```
.venv\Scripts\activate
python transcribir.py
```

Genera `audio.txt` en la raíz del proyecto, con una línea por intervención:

```
[00:00] Hablante 1: Hola, ¿qué tal estás?
[00:03] Hablante 2: Muy bien, gracias. ¿Y tú?
```

Opciones:

- `--hablantes 2` — número de personas que hablan, si lo sabes. Si no se indica, se detecta solo;
  indicarlo mejora la precisión cuando se mezclan voces.
- `--nombres "Ana,Luis"` — sustituye "Hablante 1", "Hablante 2"... por esos nombres, **en orden de
  aparición** (el primero que habla en el audio será "Ana").
- `-o salida.txt` — elegir dónde guardar el texto.
- `--modelo medium` — otro modelo de Whisper (`tiny`, `base`, `small`, `medium`, `large-v3`,
  `large-v3-turbo`). Más pequeño = más rápido pero menos preciso.
- `--cpu` — forzar CPU para la transcripción.
- `--rapido` — transcripción más rápida y algo menos precisa (búsqueda simple en lugar de explorar
  5 candidatos).

El programa se adapta al equipo en el que se ejecuta: usa la GPU NVIDIA solo si la detecta (si no,
pasa directamente a la CPU) y, en la CPU, aprovecha todos los núcleos disponibles tanto para
transcribir como para identificar las voces.
