"use strict";

const $ = (selector) => document.querySelector(selector);

const DESCRIPCION_MODELOS = {
  "tiny": "El más rápido, poco preciso. Útil para pruebas.",
  "base": "Muy rápido, precisión baja.",
  "small": "Rápido, precisión aceptable.",
  "medium": "Equilibrado entre velocidad y precisión.",
  "large-v3": "El más preciso, pero lento.",
  "large-v3-turbo": "Casi tan preciso como large-v3 y mucho más rápido.",
};
const NUM_COLORES = 6;  // --h0 … --h5 en estilos.css
const PASOS = ["subida", "transcripcion", "diarizacion"];
const PASO_DE_FASE = {
  cola: "subida",
  preparacion: "transcripcion",
  transcripcion: "transcripcion",
  segmento: "transcripcion",
  diarizacion: "diarizacion",
};

const estado = {
  archivo: null,
  intervenciones: [],
  nombres: [],       // nombre escrito para cada hablante (por número)
  enCurso: false,
  cronometro: null,
  urlAudio: null,    // URL local del archivo elegido, para reproducirlo
};

// Elementos de la transcripción ordenados por inicio, para saber cuál
// está sonando en cada momento
const reproduccion = {
  palabras: [],      // { inicio, fin, el }
  lineas: [],        // { inicio, fin, el }
  palabraActiva: -1,
  lineaActiva: -1,
  animacion: null,
};
// Segundos que una palabra o línea sigue resaltada tras terminar, para
// que el resaltado no parpadee en las pausas cortas
const MARGEN_PALABRA = 0.3;
const MARGEN_LINEA = 1.5;
const SALTO_TECLADO = 5;

// ------------------------------------------------------------ utilidades

function formatearTamano(bytes) {
  const unidades = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < unidades.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toLocaleString("es", { maximumFractionDigits: 1 })} ${unidades[i]}`;
}

function formatearDuracion(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function mostrarVista(nombre) {
  for (const vista of ["formulario", "progreso", "resultado"]) {
    $(`#vista-${vista}`).hidden = vista !== nombre;
  }
}

function etiqueta(hablante) {
  return estado.nombres[hablante]?.trim() || `Hablante ${hablante + 1}`;
}

function colorDe(hablante) {
  return `var(--h${hablante % NUM_COLORES})`;
}

function crear(etiquetaHtml, clase, texto) {
  const el = document.createElement(etiquetaHtml);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
}

// ------------------------------------------------------------ formulario

async function cargarInfo() {
  try {
    const respuesta = await fetch("/api/info");
    const info = await respuesta.json();
    const select = $("#modelo");
    for (const modelo of info.modelos) {
      const porDefecto = modelo === info.modelo_por_defecto;
      select.add(new Option(porDefecto ? `${modelo} (recomendado)` : modelo,
                            modelo, porDefecto, porDefecto));
    }
    actualizarAyudaModelo();

    const chip = $("#dispositivo");
    chip.textContent = info.gpu ? "GPU NVIDIA" : "Solo CPU";
    chip.classList.toggle("gpu", info.gpu);
    if (!info.gpu) {
      $("#cpu").checked = true;
      $("#cpu").disabled = true;
      $("#casilla-cpu").classList.add("desactivada");
      $("#casilla-cpu").title = "No se ha detectado una GPU NVIDIA";
    }
  } catch {
    $("#dispositivo").textContent = "Sin conexión";
  }
}

function actualizarAyudaModelo() {
  $("#modelo-ayuda").textContent = DESCRIPCION_MODELOS[$("#modelo").value] || "";
}

function elegirArchivo(archivo) {
  if (!archivo) return;
  estado.archivo = archivo;
  $("#zona").classList.add("con-archivo");
  $("#zona-titulo").textContent = archivo.name;
  $("#zona-detalle").textContent = `${formatearTamano(archivo.size)} · haz clic para cambiarlo`;
  $("#boton-transcribir").disabled = false;
}

function configurarZona() {
  const zona = $("#zona");
  $("#archivo").addEventListener("change", (e) => elegirArchivo(e.target.files[0]));
  for (const evento of ["dragenter", "dragover"]) {
    zona.addEventListener(evento, (e) => {
      e.preventDefault();
      zona.classList.add("encima");
    });
  }
  for (const evento of ["dragleave", "drop"]) {
    zona.addEventListener(evento, () => zona.classList.remove("encima"));
  }
  zona.addEventListener("drop", (e) => {
    e.preventDefault();
    elegirArchivo(e.dataTransfer.files[0]);
  });
  // Soltar un archivo fuera de la zona no debe abrirlo en el navegador
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

// -------------------------------------------------------------- progreso

function marcarPaso(paso) {
  const actual = PASOS.indexOf(paso);
  document.querySelectorAll("#pasos li").forEach((li, i) => {
    li.classList.toggle("hecho", i < actual);
    li.classList.toggle("activo", i === actual);
  });
}

function actualizarBarra(fraccion) {
  const barra = $("#barra");
  const indeterminada = fraccion === null || fraccion === undefined;
  barra.classList.toggle("indeterminada", indeterminada);
  if (indeterminada) {
    $("#barra-relleno").style.width = "";
    barra.removeAttribute("aria-valuenow");
  } else {
    const porcentaje = Math.round(fraccion * 100);
    $("#barra-relleno").style.width = `${porcentaje}%`;
    barra.setAttribute("aria-valuenow", porcentaje);
  }
}

function ponerEstado(texto, fraccion) {
  const porcentaje = fraccion === null || fraccion === undefined
    ? "" : ` ${Math.round(fraccion * 100)} %`;
  $("#estado").textContent = texto + porcentaje;
  actualizarBarra(fraccion);
}

function empezarProgreso() {
  estado.enCurso = true;
  $("#progreso-archivo").textContent = estado.archivo.name;
  $("#vista-previa").replaceChildren();
  $("#aviso").hidden = true;
  $("#error").hidden = true;
  $("#barra").hidden = false;
  marcarPaso("subida");
  ponerEstado("Subiendo el archivo…", 0);
  mostrarVista("progreso");

  const inicio = Date.now();
  $("#cronometro").textContent = "0:00";
  estado.cronometro = setInterval(() => {
    $("#cronometro").textContent = formatearDuracion((Date.now() - inicio) / 1000);
  }, 1000);
}

function terminarProgreso() {
  estado.enCurso = false;
  clearInterval(estado.cronometro);
}

function mostrarError(mensaje) {
  terminarProgreso();
  $("#barra").hidden = true;
  $("#estado").textContent = "No se pudo completar la transcripción.";
  $("#error-mensaje").textContent = mensaje;
  $("#error").hidden = false;
}

function mensajeDeError(respuesta) {
  const detalle = respuesta?.detail;
  if (typeof detalle === "string") return detalle;
  if (Array.isArray(detalle)) return "Datos del formulario no válidos.";
  return "Error inesperado del servidor.";
}

// fetch no informa del progreso de subida; XMLHttpRequest sí
function subir(datos) {
  return new Promise((resolver, rechazar) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/trabajos");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) ponerEstado("Subiendo el archivo…", e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolver(xhr.response);
      else rechazar(new Error(mensajeDeError(xhr.response)));
    });
    xhr.addEventListener("error", () => rechazar(new Error("No se pudo conectar con el servidor.")));
    xhr.send(datos);
  });
}

function manejarProgreso({ fase, mensaje, fraccion }) {
  if (fase === "aviso") {
    $("#aviso").textContent = mensaje;
    $("#aviso").hidden = false;
    return;
  }
  marcarPaso(PASO_DE_FASE[fase] || "transcripcion");
  if (fase === "segmento") {
    const previa = $("#vista-previa");
    const abajo = previa.scrollHeight - previa.scrollTop - previa.clientHeight < 30;
    previa.append(crear("p", "", mensaje));
    if (abajo) previa.scrollTop = previa.scrollHeight;
    ponerEstado("Transcribiendo…", fraccion);
  } else {
    ponerEstado(mensaje.replace(/\.\.\.$/, "…"), fraccion);
  }
}

function seguir(id) {
  const fuente = new EventSource(`/api/trabajos/${id}/eventos`);
  fuente.addEventListener("message", (e) => {
    const evento = JSON.parse(e.data);
    if (evento.tipo === "progreso") {
      manejarProgreso(evento);
    } else if (evento.tipo === "fin") {
      fuente.close();
      terminarProgreso();
      mostrarResultado(evento);
    } else if (evento.tipo === "error") {
      fuente.close();
      mostrarError(evento.mensaje);
    }
  });
  // EventSource se reconecta solo si se corta; solo se rinde si el
  // servidor rechaza la conexión (por ejemplo, tras reiniciarlo)
  fuente.addEventListener("error", () => {
    if (fuente.readyState === EventSource.CLOSED) {
      mostrarError("Se ha perdido la conexión con el servidor.");
    }
  });
}

async function transcribir(e) {
  e.preventDefault();
  if (!estado.archivo || estado.enCurso) return;

  const datos = new FormData();
  datos.append("archivo", estado.archivo);
  datos.append("modelo", $("#modelo").value);
  const hablantes = $("#hablantes").value.trim();
  if (hablantes) datos.append("hablantes", hablantes);
  datos.append("cpu", $("#cpu").checked);
  datos.append("rapido", $("#rapido").checked);

  empezarProgreso();
  try {
    const { id } = await subir(datos);
    marcarPaso("transcripcion");
    ponerEstado("Preparando…", null);
    seguir(id);
  } catch (error) {
    mostrarError(error.message);
  }
}

// ------------------------------------------------------------- resultado

function textoPlano() {
  return estado.intervenciones
    .map((i) => `[${i.tiempo}] ${etiqueta(i.hablante)}: ${i.texto}`)
    .join("\n") + "\n";
}

function pintarTexto(parrafo, palabras) {
  palabras.forEach(([inicio, fin, texto], n) => {
    // Whisper pone el espacio delante de cada palabra; se deja fuera del
    // <span> para que el resaltado cubra solo la palabra
    const [, espacio, palabra] = texto.match(/^(\s*)(.*)$/s);
    if (espacio && n > 0) parrafo.append(" ");
    const span = crear("span", "palabra", palabra);
    span.dataset.inicio = inicio;
    reproduccion.palabras.push({ inicio, fin, el: span });
    parrafo.append(span);
  });
}

function pintarTranscripcion() {
  reproduccion.palabras = [];
  reproduccion.lineas = [];
  reproduccion.palabraActiva = -1;
  reproduccion.lineaActiva = -1;

  const filas = estado.intervenciones.map((i) => {
    const fila = crear("div", "linea");
    const tiempo = crear("button", "linea-tiempo", i.tiempo);
    tiempo.type = "button";
    tiempo.dataset.inicio = i.inicio;
    tiempo.title = "Escuchar desde aquí";
    const hablante = crear("span", "linea-hablante", etiqueta(i.hablante));
    hablante.dataset.hablante = i.hablante;
    hablante.style.color = colorDe(i.hablante);
    const texto = crear("p", "linea-texto");
    pintarTexto(texto, i.palabras);
    fila.append(tiempo, hablante, texto);
    reproduccion.lineas.push({ inicio: i.inicio, fin: i.fin, el: fila });
    return fila;
  });
  if (!filas.length) {
    filas.push(crear("p", "ayuda", "No se ha detectado voz en el audio."));
  }
  $("#transcripcion").replaceChildren(...filas);
}

function renombrar(hablante) {
  document.querySelectorAll(`.linea-hablante[data-hablante="${hablante}"]`)
    .forEach((el) => { el.textContent = etiqueta(hablante); });
}

function pintarHablantes(numHablantes) {
  const lista = [];
  for (let n = 0; n < numHablantes; n++) {
    const fila = crear("div", "hablante");
    const punto = crear("span", "punto");
    punto.style.background = colorDe(n);

    const entrada = crear("input");
    entrada.type = "text";
    entrada.placeholder = `Hablante ${n + 1}`;
    entrada.value = estado.nombres[n] || "";
    entrada.setAttribute("aria-label", `Nombre del hablante ${n + 1}`);
    entrada.addEventListener("input", () => {
      estado.nombres[n] = entrada.value;
      renombrar(n);
    });

    // Su primera frase ayuda a reconocer quién es
    const primera = estado.intervenciones.find((i) => i.hablante === n);
    const veces = estado.intervenciones.filter((i) => i.hablante === n).length;
    const muestra = crear("span", "hablante-muestra",
      `${veces} intervención${veces === 1 ? "" : "es"} · Empieza en ${primera.tiempo}: «${primera.texto}»`);
    muestra.title = primera.texto;

    fila.append(punto, entrada, muestra);
    lista.push(fila);
  }
  $("#lista-hablantes").replaceChildren(...lista);
  $("#lista-hablantes").closest(".tarjeta").hidden = numHablantes === 0;
}

function mostrarResultado({ intervenciones, segundos }) {
  estado.intervenciones = intervenciones;
  estado.nombres = [];
  const numHablantes = intervenciones.reduce((max, i) => Math.max(max, i.hablante + 1), 0);

  $("#resumen-titulo").textContent = estado.archivo.name;
  $("#resumen-detalle").textContent =
    `${numHablantes} hablante${numHablantes === 1 ? "" : "s"} · ` +
    `${intervenciones.length} intervenciones · lista en ${formatearDuracion(segundos)}`;
  pintarHablantes(numHablantes);
  pintarTranscripcion();
  prepararAudio();
  mostrarVista("resultado");
}

// ----------------------------------------------------------- reproducción

function prepararAudio() {
  const audio = $("#audio");
  // El navegador reproduce el archivo que ya tiene; no se vuelve a pedir
  if (estado.urlAudio) URL.revokeObjectURL(estado.urlAudio);
  estado.urlAudio = URL.createObjectURL(estado.archivo);
  $("#aviso-audio").hidden = true;
  $("#reproductor-opciones").hidden = false;
  audio.hidden = false;
  audio.src = estado.urlAudio;
}

// Índice del último elemento que empieza en t o antes (-1 si ninguno)
function ultimoAntesDe(lista, t) {
  let bajo = 0;
  let alto = lista.length - 1;
  let resultado = -1;
  while (bajo <= alto) {
    const medio = (bajo + alto) >> 1;
    if (lista[medio].inicio <= t) {
      resultado = medio;
      bajo = medio + 1;
    } else {
      alto = medio - 1;
    }
  }
  return resultado;
}

function activo(lista, t, margen) {
  const i = ultimoAntesDe(lista, t);
  return i >= 0 && t <= lista[i].fin + margen ? i : -1;
}

function cambiarActivo(lista, anterior, nuevo) {
  if (anterior >= 0) lista[anterior].el.classList.remove("activa");
  if (nuevo >= 0) lista[nuevo].el.classList.add("activa");
}

function resaltar() {
  const audio = $("#audio");
  const t = audio.currentTime;

  const palabra = activo(reproduccion.palabras, t, MARGEN_PALABRA);
  if (palabra !== reproduccion.palabraActiva) {
    cambiarActivo(reproduccion.palabras, reproduccion.palabraActiva, palabra);
    reproduccion.palabraActiva = palabra;
  }

  const linea = activo(reproduccion.lineas, t, MARGEN_LINEA);
  if (linea !== reproduccion.lineaActiva) {
    cambiarActivo(reproduccion.lineas, reproduccion.lineaActiva, linea);
    reproduccion.lineaActiva = linea;
    if (linea >= 0 && !audio.paused && $("#seguir").checked) {
      const suave = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      reproduccion.lineas[linea].el.scrollIntoView({
        block: "center", behavior: suave ? "smooth" : "auto",
      });
    }
  }
}

// timeupdate llega solo unas 4 veces por segundo: para seguir palabra a
// palabra se comprueba en cada fotograma mientras suena
function bucleResaltado() {
  resaltar();
  reproduccion.animacion = requestAnimationFrame(bucleResaltado);
}

function pararBucle() {
  cancelAnimationFrame(reproduccion.animacion);
  reproduccion.animacion = null;
  resaltar();
}

function escucharDesde(segundos) {
  const audio = $("#audio");
  audio.currentTime = segundos;
  audio.play().catch(() => {});
}

function alternarReproduccion() {
  const audio = $("#audio");
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function configurarReproductor() {
  const audio = $("#audio");
  audio.addEventListener("play", () => {
    if (!reproduccion.animacion) bucleResaltado();
  });
  audio.addEventListener("pause", pararBucle);
  audio.addEventListener("ended", pararBucle);
  audio.addEventListener("seeked", resaltar);
  audio.addEventListener("error", () => {
    if (!audio.getAttribute("src")) return;
    audio.hidden = true;
    $("#reproductor-opciones").hidden = true;
    $("#aviso-audio").hidden = false;
  });

  $("#velocidad").addEventListener("change", (e) => {
    audio.playbackRate = audio.defaultPlaybackRate = Number(e.target.value);
  });

  // Clic en una palabra o en el tiempo de una línea: escuchar desde ahí
  $("#transcripcion").addEventListener("click", (e) => {
    const destino = e.target.closest(".palabra, .linea-tiempo");
    if (destino && !audio.hidden) escucharDesde(Number(destino.dataset.inicio));
  });

  document.addEventListener("keydown", (e) => {
    if ($("#vista-resultado").hidden || audio.hidden) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Sin interferir con la escritura de nombres ni con los controles.
    // Los tiempos de línea sí cuentan: tras pulsar uno, Espacio debe pausar
    // y no volver a saltar a ese punto.
    const control = "input, select, textarea, audio, button:not(.linea-tiempo)";
    if (e.target.closest(control)) return;
    if (e.key === " ") {
      e.preventDefault();
      alternarReproduccion();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const salto = e.key === "ArrowLeft" ? -SALTO_TECLADO : SALTO_TECLADO;
      audio.currentTime = Math.max(0, audio.currentTime + salto);
    }
  });
}

function descargar() {
  const blob = new Blob([textoPlano()], { type: "text/plain;charset=utf-8" });
  const enlace = crear("a");
  enlace.href = URL.createObjectURL(blob);
  enlace.download = estado.archivo.name.replace(/\.[^.]+$/, "") + ".txt";
  enlace.click();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
}

async function copiar() {
  const boton = $("#boton-copiar");
  try {
    await navigator.clipboard.writeText(textoPlano());
    boton.textContent = "Copiado";
  } catch {
    boton.textContent = "No se pudo copiar";
  }
  setTimeout(() => { boton.textContent = "Copiar"; }, 1500);
}

// ----------------------------------------------------------------- inicio

document.addEventListener("DOMContentLoaded", () => {
  configurarZona();
  configurarReproductor();
  cargarInfo();
  $("#modelo").addEventListener("change", actualizarAyudaModelo);
  $("#formulario").addEventListener("submit", transcribir);
  $("#boton-volver").addEventListener("click", () => mostrarVista("formulario"));
  $("#boton-nueva").addEventListener("click", () => {
    $("#audio").pause();
    mostrarVista("formulario");
  });
  $("#boton-descargar").addEventListener("click", descargar);
  $("#boton-copiar").addEventListener("click", copiar);
  window.addEventListener("beforeunload", (e) => {
    if (estado.enCurso) e.preventDefault();
  });
});
