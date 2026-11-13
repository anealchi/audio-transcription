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
identificación de voces (~35 MB, en la carpeta `modelos/`).

## Uso desde el navegador

```
.venv\Scripts\activate
python servidor.py
```

Se abre `http://127.0.0.1:8000` en el navegador (solo accesible desde tu equipo). Arrastra un audio o
vídeo, elige las opciones y pulsa **Transcribir**: verás el progreso y las frases a medida que se
transcriben. Al terminar puedes poner nombre a cada hablante (se muestra su primera frase para
reconocerlo), copiar el texto o descargarlo como `.txt`.

Para revisar la transcripción, reproduce el audio desde la propia página. La palabra que está sonando
se resalta y la página se desplaza sola para seguirla (se puede desactivar con *Seguir el audio*). Haz
clic en una palabra o en el tiempo de una línea para escuchar desde ese punto. También puedes cambiar
la velocidad, usar `Espacio` para reproducir o pausar y `←`/`→` para retroceder o avanzar 5 segundos.

Opciones del servidor: `--puerto 8080` para usar otro puerto y `--sin-navegador` para no abrirlo
automáticamente. Las transcripciones se hacen de una en una; si lanzas varias, esperan en cola.

## Uso desde la línea de comandos

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
- `--preciso` — explora 5 candidatos al transcribir en lugar de hacer una búsqueda simple. Es más
  lento y, en algunos audios, algo más preciso. En la web es la opción *Modo preciso*.

El programa se adapta al equipo en el que se ejecuta: usa la GPU NVIDIA solo si la detecta (si no,
pasa directamente a la CPU) y, en la CPU, aprovecha todos los núcleos disponibles tanto para
transcribir como para identificar las voces.
