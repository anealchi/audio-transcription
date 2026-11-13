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
  onda: null,        // picos del audio (0 a 1) que envía el servidor
  duracion: 0,       // segundos, según el audio que decodificó el servidor
};

// Lo que muestra la onda mientras se procesa el audio
const progreso = { paso: "subida", subida: 0, transcripcion: 0, diarizacion: 0 };

// Elementos de la transcripción ordenados por inicio, para saber cuál
// está sonando en cada momento
const reproduccion = {
  palabras: [],      // { inicio, fin, el }
  lineas: [],        // { inicio, fin, hablante, el }
  palabraActiva: -1,
  lineaActiva: -1,
  animacion: null,
  segundoMostrado: -1,
};
// Segundos que una palabra o línea sigue resaltada tras terminar, para
// que el resaltado no parpadee en las pausas cortas
const MARGEN_PALABRA = 0.3;
const MARGEN_LINEA = 1.5;
const SALTO_TECLADO = 5;

const menosMovimiento = matchMedia("(prefers-reduced-motion: reduce)");

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

// Igual que formatear_tiempo de transcribir.py: mm:ss, o h:mm:ss
function formatearTiempo(segundos) {
  const total = Math.max(0, Math.floor(segundos || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

function plural(n, singular, varios) {
  return `${n} ${n === 1 ? singular : varios}`;
}

function mostrarVista(nombre) {
  for (const vista of ["formulario", "progreso", "resultado"]) {
    $(`#vista-${vista}`).hidden = vista !== nombre;
  }
  window.scrollTo({ top: 0 });
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

function crearPunto(hablante) {
  const punto = crear("span", "punto");
  punto.style.background = colorDe(hablante);
  punto.setAttribute("aria-hidden", "true");
  return punto;
}

// --------------------------------------------------------- forma de onda

const BARRA = { paso: 3, ancho: 2, minimo: 2 };  // en píxeles CSS
let colores = null;

function leerColores() {
  const css = getComputedStyle(document.documentElement);
  const leer = (nombre) => css.getPropertyValue(nombre).trim();
  colores = {
    texto: leer("--deck-texto"),
    suave: leer("--deck-suave"),
    ambar: leer("--ambar"),
    hablantes: Array.from({ length: NUM_COLORES }, (_, i) => leer(`--h${i}`)),
  };
}

// Ajusta la resolución del lienzo a su tamaño en pantalla
function lienzo(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const ancho = Math.round(canvas.clientWidth * dpr);
  const alto = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== ancho || canvas.height !== alto) {
    canvas.width = ancho;
    canvas.height = alto;
  }
  return { ctx: canvas.getContext("2d"), ancho, alto, dpr };
}

// Reduce los picos a n barras tomando el máximo de cada tramo
function picos(onda, n) {
  const resultado = new Float32Array(n);
  if (!onda || !onda.length) return resultado;
  for (let i = 0; i < n; i++) {
    const desde = Math.floor((i * onda.length) / n);
    const hasta = Math.max(desde + 1, Math.floor(((i + 1) * onda.length) / n));
    let maximo = 0;
    for (let j = desde; j < hasta && j < onda.length; j++) maximo = Math.max(maximo, onda[j]);
    resultado[i] = maximo;
  }
  return resultado;
}

// estilo(x) devuelve [color, opacidad] para la barra en la posición x (0-1)
function dibujarOnda(canvas, { estilo, cabezal = null, crecimiento = 1 }) {
  if (!canvas.clientWidth) return;
  const { ctx, ancho, alto, dpr } = lienzo(canvas);
  const paso = BARRA.paso * dpr;
  const grosor = BARRA.ancho * dpr;
  const n = Math.max(1, Math.floor(ancho / paso));
  const valores = picos(estado.onda, n);
  ctx.clearRect(0, 0, ancho, alto);

  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    // Entrada: las barras crecen de izquierda a derecha
    const avance = Math.min(1, Math.max(0, (crecimiento - x * 0.45) / 0.55));
    const altura = Math.max(BARRA.minimo * dpr,
                            valores[i] * (alto - 2 * dpr) * (1 - (1 - avance) ** 3));
    const [color, opacidad] = estilo(x);
    ctx.globalAlpha = opacidad;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(i * paso, (alto - altura) / 2, grosor, altura, grosor / 2);
    ctx.fill();
  }

  if (cabezal !== null) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = colores.ambar;
    const xCabezal = Math.min(ancho - dpr, Math.max(dpr, cabezal * ancho));
    ctx.fillRect(Math.round(xCabezal - dpr), 0, 2 * dpr, alto);
  }
  ctx.globalAlpha = 1;
}

// El único movimiento que no pide el usuario: la onda real aparece
function animarEntrada(dibujar) {
  if (menosMovimiento.matches) return dibujar(1);
  const inicio = performance.now();
  const duracion = 900;
  const paso = (ahora) => {
    const t = Math.min(1, (ahora - inicio) / duracion);
    dibujar(t);
    if (t < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
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
    chip.textContent = info.gpu ? "GPU NVIDIA disponible" : "Sin GPU: se usará la CPU";
    chip.classList.toggle("gpu", info.gpu);
    if (!info.gpu) {
      $("#cpu").checked = true;
      $("#cpu").disabled = true;
      $("#casilla-cpu").classList.add("desactivada");
    }
  } catch {
    $("#dispositivo").textContent = "Sin conexión con el servidor";
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
  $("#zona-detalle").textContent = `${formatearTamano(archivo.size)}. Haz clic para elegir otro.`;
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
  progreso.paso = paso;
  const actual = PASOS.indexOf(paso);
  document.querySelectorAll("#pasos li").forEach((li, i) => {
    li.classList.toggle("hecho", i < actual);
    li.classList.toggle("activo", i === actual);
  });
}

// Cada pasada sobre el audio se ve en la onda: la transcripción la
// ilumina y la identificación de voces la pinta de ámbar
function estiloProgreso(x) {
  const { paso } = progreso;
  if (paso === "subida") {
    return x <= progreso.subida ? [colores.ambar, 1] : [colores.suave, 0.35];
  }
  if (paso === "diarizacion") {
    return x <= progreso.diarizacion ? [colores.ambar, 1] : [colores.texto, 0.85];
  }
  return x <= progreso.transcripcion ? [colores.texto, 0.9] : [colores.suave, 0.3];
}

function cabezalProgreso() {
  const valor = progreso[progreso.paso];
  return valor > 0 && valor < 1 ? valor : null;
}

function dibujarProgreso(crecimiento = 1) {
  dibujarOnda($("#onda-progreso"), {
    estilo: estiloProgreso, cabezal: cabezalProgreso(), crecimiento,
  });
}

function ponerEstado(texto, fraccion) {
  const conFraccion = fraccion !== null && fraccion !== undefined;
  $("#estado").textContent = conFraccion ? `${texto} ${Math.round(fraccion * 100)} %` : texto;
  if (conFraccion) {
    progreso[progreso.paso] = fraccion;
    $("#onda-progreso").setAttribute("aria-valuenow", Math.round(fraccion * 100));
  } else {
    $("#onda-progreso").removeAttribute("aria-valuenow");
  }
  dibujarProgreso();
}

function empezarProgreso() {
  estado.enCurso = true;
  estado.onda = null;
  estado.duracion = 0;
  Object.assign(progreso, { paso: "subida", subida: 0, transcripcion: 0, diarizacion: 0 });
  $("#progreso-archivo").textContent = estado.archivo.name;
  $("#vista-previa").replaceChildren();
  $("#aviso").hidden = true;
  $("#error").hidden = true;
  mostrarVista("progreso");
  marcarPaso("subida");
  ponerEstado("Subiendo el archivo…", 0);

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
  $("#estado").textContent = "No se pudo completar la transcripción.";
  $("#error-mensaje").textContent = mensaje;
  $("#error").hidden = false;
}

function mensajeDeError(respuesta) {
  const detalle = respuesta?.detail;
  if (typeof detalle === "string") return detalle;
  if (Array.isArray(detalle)) return "Revisa las opciones del formulario: hay algún dato no válido.";
  return "El servidor devolvió un error inesperado. Revisa la consola donde se ejecuta servidor.py.";
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
    xhr.addEventListener("error", () => rechazar(new Error(
      "No se pudo conectar con el servidor. Comprueba que servidor.py sigue en marcha.")));
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

function recibirAudio({ onda, duracion }) {
  estado.onda = onda;
  estado.duracion = duracion;
  animarEntrada(dibujarProgreso);
}

function seguir(id) {
  const fuente = new EventSource(`/api/trabajos/${id}/eventos`);
  fuente.addEventListener("message", (e) => {
    const evento = JSON.parse(e.data);
    if (evento.tipo === "progreso") {
      manejarProgreso(evento);
    } else if (evento.tipo === "audio") {
      recibirAudio(evento);
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
      mostrarError("Se ha perdido la conexión con el servidor. Si lo has reiniciado, vuelve a lanzar la transcripción.");
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

function crearEtiquetaHablante(hablante) {
  const el = crear("span", "linea-hablante");
  el.dataset.hablante = hablante;
  el.append(crearPunto(hablante), crear("span", "nombre", etiqueta(hablante)));
  return el;
}

function pintarTranscripcion() {
  reproduccion.palabras = [];
  reproduccion.lineas = [];
  reproduccion.palabraActiva = -1;
  reproduccion.lineaActiva = -1;

  const filas = estado.intervenciones.map((i) => {
    const fila = crear("div", "linea");
    fila.style.setProperty("--color-hablante", colorDe(i.hablante));
    const tiempo = crear("button", "linea-tiempo", i.tiempo);
    tiempo.type = "button";
    tiempo.dataset.inicio = i.inicio;
    tiempo.setAttribute("aria-label", `Escuchar desde ${i.tiempo}`);
    const texto = crear("p", "linea-texto");
    pintarTexto(texto, i.palabras);
    fila.append(tiempo, crearEtiquetaHablante(i.hablante), texto);
    reproduccion.lineas.push({ inicio: i.inicio, fin: i.fin, hablante: i.hablante, el: fila });
    return fila;
  });
  if (!filas.length) {
    filas.push(crear("p", "ayuda", "No se ha detectado voz en el audio. Prueba con otro archivo o revisa que tenga sonido."));
  }
  $("#transcripcion").replaceChildren(...filas);
}

function pintarLeyenda(numHablantes) {
  const elementos = [];
  for (let n = 0; n < numHablantes; n++) {
    const li = crear("li");
    li.dataset.hablante = n;
    li.append(crearPunto(n), crear("span", "nombre", etiqueta(n)));
    elementos.push(li);
  }
  $("#leyenda").replaceChildren(...elementos);
}

function renombrar(hablante) {
  document.querySelectorAll(`[data-hablante="${hablante}"] .nombre`)
    .forEach((el) => { el.textContent = etiqueta(hablante); });
}

function pintarHablantes(numHablantes) {
  const lista = [];
  for (let n = 0; n < numHablantes; n++) {
    const fila = crear("div", "hablante");
    const campo = crear("div", "hablante-campo");
    const entrada = crear("input");
    entrada.type = "text";
    entrada.placeholder = `Hablante ${n + 1}`;
    entrada.value = estado.nombres[n] || "";
    entrada.setAttribute("aria-label", `Nombre del hablante ${n + 1}`);
    entrada.addEventListener("input", () => {
      estado.nombres[n] = entrada.value;
      renombrar(n);
    });
    campo.append(crearPunto(n), entrada);

    const primera = estado.intervenciones.find((i) => i.hablante === n);
    const veces = estado.intervenciones.filter((i) => i.hablante === n).length;
    const muestra = crear("span", "hablante-muestra",
      `${plural(veces, "intervención", "intervenciones")}. Empieza en ${primera.tiempo}: «${primera.texto}»`);
    muestra.title = primera.texto;

    fila.append(campo, muestra);
    lista.push(fila);
  }
  $("#lista-hablantes").replaceChildren(...lista);
  $("#lista-hablantes").closest(".bloque").hidden = numHablantes === 0;
}

function mostrarResultado({ intervenciones, segundos }) {
  estado.intervenciones = intervenciones;
  estado.nombres = [];
  const numHablantes = intervenciones.reduce((max, i) => Math.max(max, i.hablante + 1), 0);

  $("#resumen-titulo").textContent = estado.archivo.name;
  $("#resumen-detalle").textContent =
    `${plural(numHablantes, "hablante", "hablantes")} y ` +
    `${plural(intervenciones.length, "intervención", "intervenciones")}. ` +
    `Lista en ${formatearDuracion(segundos)}.`;
  pintarHablantes(numHablantes);
  pintarLeyenda(numHablantes);
  pintarTranscripcion();
  mostrarVista("resultado");
  prepararAudio();
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
    boton.textContent = "Texto copiado";
  } catch {
    boton.textContent = "No se pudo copiar";
  }
  setTimeout(() => { boton.textContent = "Copiar texto"; }, 1500);
}

// ----------------------------------------------------------- reproducción

const audio = () => $("#audio");

function duracionAudio() {
  return estado.duracion || audio().duration || 0;
}

function prepararAudio() {
  // El navegador reproduce el archivo que ya tiene; no se vuelve a pedir
  if (estado.urlAudio) URL.revokeObjectURL(estado.urlAudio);
  estado.urlAudio = URL.createObjectURL(estado.archivo);
  $("#aviso-audio").hidden = true;
  $("#reproductor-principal").hidden = false;
  $("#reproductor-pie").hidden = false;
  reproduccion.segundoMostrado = -1;
  audio().src = estado.urlAudio;
  actualizarReproductor();
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

// La onda del resultado: cada barra con el color de quien habla en ese
// momento; lo ya escuchado, a plena intensidad
function dibujarResultado() {
  const total = duracionAudio();
  const cabezal = total ? audio().currentTime / total : 0;
  dibujarOnda($("#onda-resultado"), {
    cabezal,
    estilo: (x) => {
      const t = x * total;
      const i = activo(reproduccion.lineas, t, 0.25);
      const escuchado = x <= cabezal;
      if (i < 0) return [colores.suave, escuchado ? 0.6 : 0.25];
      const color = colores.hablantes[reproduccion.lineas[i].hablante % NUM_COLORES];
      return [color, escuchado ? 1 : 0.4];
    },
  });
}

function actualizarReproductor() {
  const t = audio().currentTime;
  const total = duracionAudio();
  const segundo = Math.floor(t);
  if (segundo !== reproduccion.segundoMostrado) {
    reproduccion.segundoMostrado = segundo;
    $("#tiempo-actual").textContent = formatearTiempo(t);
    $("#tiempo-total").textContent = `de ${formatearTiempo(total)}`;
    const onda = $("#onda-resultado");
    onda.setAttribute("aria-valuemax", Math.round(total));
    onda.setAttribute("aria-valuenow", segundo);
    onda.setAttribute("aria-valuetext", `${formatearTiempo(t)} de ${formatearTiempo(total)}`);
  }
  dibujarResultado();
}

function resaltar() {
  const t = audio().currentTime;
  actualizarReproductor();

  const palabra = activo(reproduccion.palabras, t, MARGEN_PALABRA);
  if (palabra !== reproduccion.palabraActiva) {
    cambiarActivo(reproduccion.palabras, reproduccion.palabraActiva, palabra);
    reproduccion.palabraActiva = palabra;
  }

  const linea = activo(reproduccion.lineas, t, MARGEN_LINEA);
  if (linea !== reproduccion.lineaActiva) {
    cambiarActivo(reproduccion.lineas, reproduccion.lineaActiva, linea);
    reproduccion.lineaActiva = linea;
    if (linea >= 0 && !audio().paused && $("#seguir").checked) {
      reproduccion.lineas[linea].el.scrollIntoView({
        block: "center", behavior: menosMovimiento.matches ? "auto" : "smooth",
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

function irA(segundos) {
  const total = duracionAudio();
  audio().currentTime = Math.min(Math.max(0, segundos), total || segundos);
  resaltar();
}

function escucharDesde(segundos) {
  irA(segundos);
  audio().play().catch(() => {});
}

function alternarReproduccion() {
  if (audio().paused) audio().play().catch(() => {});
  else audio().pause();
}

function actualizarBotonPlay() {
  const sonando = !audio().paused;
  const boton = $("#boton-play");
  boton.classList.toggle("sonando", sonando);
  boton.setAttribute("aria-label", sonando ? "Pausar" : "Reproducir");
}

function configurarOndaComoBarra() {
  const onda = $("#onda-resultado");
  const posicion = (e) => {
    const caja = onda.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - caja.left) / caja.width));
  };
  onda.addEventListener("pointerdown", (e) => {
    onda.setPointerCapture(e.pointerId);
    irA(posicion(e) * duracionAudio());
  });
  onda.addEventListener("pointermove", (e) => {
    if (onda.hasPointerCapture(e.pointerId)) irA(posicion(e) * duracionAudio());
  });
}

function configurarReproductor() {
  const el = audio();
  el.addEventListener("play", () => {
    actualizarBotonPlay();
    if (!reproduccion.animacion) bucleResaltado();
  });
  el.addEventListener("pause", () => { actualizarBotonPlay(); pararBucle(); });
  el.addEventListener("ended", () => { actualizarBotonPlay(); pararBucle(); });
  el.addEventListener("seeked", resaltar);
  el.addEventListener("loadedmetadata", actualizarReproductor);
  el.addEventListener("error", () => {
    if (!el.getAttribute("src")) return;
    $("#reproductor-principal").hidden = true;
    $("#reproductor-pie").hidden = true;
    $("#aviso-audio").hidden = false;
  });

  $("#boton-play").addEventListener("click", alternarReproduccion);
  configurarOndaComoBarra();

  $("#velocidad").addEventListener("change", (e) => {
    el.playbackRate = el.defaultPlaybackRate = Number(e.target.value);
  });

  // Clic en una palabra o en el tiempo de una línea: escuchar desde ahí
  $("#transcripcion").addEventListener("click", (e) => {
    const destino = e.target.closest(".palabra, .linea-tiempo");
    // Sin aviso de formato no compatible = el audio se puede reproducir
    if (destino && $("#aviso-audio").hidden) {
      escucharDesde(Number(destino.dataset.inicio));
    }
  });

  document.addEventListener("keydown", (e) => {
    if ($("#vista-resultado").hidden || !$("#aviso-audio").hidden) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Sin interferir con la escritura de nombres ni con los controles.
    // Los tiempos de línea sí cuentan: tras pulsar uno, Espacio debe pausar
    // y no volver a saltar a ese punto.
    const control = "input, select, textarea, button:not(.linea-tiempo)";
    if (e.target.closest(control)) return;
    if (e.key === " ") {
      e.preventDefault();
      alternarReproduccion();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const salto = e.key === "ArrowLeft" ? -SALTO_TECLADO : SALTO_TECLADO;
      irA(el.currentTime + salto);
    }
  });
}

// Redibuja las ondas al cambiar su tamaño o el tema claro/oscuro
function configurarRedibujado() {
  const redibujar = () => {
    if (!$("#vista-progreso").hidden) dibujarProgreso();
    if (!$("#vista-resultado").hidden) dibujarResultado();
  };
  new ResizeObserver(redibujar).observe(document.body);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    leerColores();
    redibujar();
  });
}

// ----------------------------------------------------------------- inicio

document.addEventListener("DOMContentLoaded", () => {
  leerColores();
  configurarZona();
  configurarReproductor();
  configurarRedibujado();
  cargarInfo();
  $("#modelo").addEventListener("change", actualizarAyudaModelo);
  $("#formulario").addEventListener("submit", transcribir);
  $("#boton-volver").addEventListener("click", () => mostrarVista("formulario"));
  $("#boton-nueva").addEventListener("click", () => {
    audio().pause();
    mostrarVista("formulario");
  });
  $("#boton-descargar").addEventListener("click", descargar);
  $("#boton-copiar").addEventListener("click", copiar);
  window.addEventListener("beforeunload", (e) => {
    if (estado.enCurso) e.preventDefault();
  });
});
