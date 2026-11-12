"use strict";
/* Frontend del pronóstico SARIMA.
   Habla con la API del mismo servidor:
     GET /api/prediccion?horas=..&historia=..&confianza=..   (pronóstico + histórico)
     GET /api/modelo                                           (datos del modelo)
   La API entrega las horas en UTC (terminan en "Z"); aquí se muestran en hora de Colombia. */

const ZONA = "America/Bogota";        // Colombia: UTC−5 todo el año
const REFRESCO_MS = 5 * 60 * 1000;    // los datos son horarios: basta refrescar cada 5 minutos

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatos
// Requisito 2: convertir UTC → hora de Colombia. Intl lo hace con la zona "America/Bogota".
const formato = (opciones) => new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, hourCycle: "h23", ...opciones });
const fEje   = formato({ weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fCorto = formato({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fLargo = formato({ weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const fHora  = formato({ hour: "2-digit", minute: "2-digit" });
const fEjeCorto = formato({ weekday: "short", hour: "2-digit", minute: "2-digit" });   // para pantallas angostas
const esCelular = () => window.innerWidth < 600;

const aFecha = (iso) => new Date(iso);   // "2026-11-12T02:00:00Z" se interpreta como UTC
const numero = (v, decimales = 1) =>
  Number(v).toLocaleString("es-CO", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
const colorCSS = (nombre) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();

// ---------------------------------------------------------------- estado
let grafica = null;       // instancia de Chart.js
let ultimaRespuesta = null;   // último pronóstico válido (para repintar al cambiar el tema)
let numSolicitud = 0;     // para descartar respuestas viejas si el usuario cambia los controles rápido

// ---------------------------------------------------------------- llamadas a la API
function textoDeError(datos, estado) {
  const detalle = datos && datos.detail;
  if (typeof detalle === "string") return detalle;
  if (Array.isArray(detalle)) return detalle.map((e) => e.msg).join("; ");   // errores de validación (422)
  return `La API respondió con el error ${estado}.`;
}

async function pedirJSON(ruta) {
  let respuesta;
  try {
    respuesta = await fetch(ruta, { cache: "no-store" });
  } catch {
    throw new Error("No se pudo conectar con la API. Revisa que el servicio esté encendido.");
  }
  let datos = null;
  try { datos = await respuesta.json(); } catch { /* la respuesta no era JSON */ }
  if (!respuesta.ok) throw new Error(textoDeError(datos, respuesta.status));
  return datos;
}

// ---------------------------------------------------------------- mensajes de error
function mostrarError(mensaje) {
  const conservados = ultimaRespuesta ? " Se muestran los últimos datos recibidos." : "";
  const sinPunto = mensaje.replace(/[.\s]+$/, "");     // evita "..": el mensaje de la API puede traer su propio punto
  $("error-texto").textContent = `No se pudo obtener el pronóstico: ${sinPunto}.${conservados}`;
  $("error").hidden = false;
}
function ocultarError() { $("error").hidden = true; }

// ---------------------------------------------------------------- modelo (se pide una sola vez)
async function cargarModelo() {
  try {
    const m = await pedirJSON("/api/modelo");
    $("v-modelo").textContent = `(${m.order.join(",")}) × (${m.seasonal_order.join(",")})`;
    const prueba = m.metricas_test || {};
    const partes = [];
    if (prueba.MAE != null) partes.push(`Error medio en la prueba (MAE): ${numero(prueba.MAE)}`);
    if (prueba["MAPE_%"] != null) partes.push(`MAPE ${numero(prueba["MAPE_%"])} %`);
    $("d-modelo").textContent = partes.join(" · ") || "Sin métricas guardadas";
    if (m.measurement && m.field) {
      $("serie").textContent = `${m.measurement} · ${m.field} — promedio por hora, en hora de Colombia (UTC−5)`;
    }
  } catch (error) {
    $("v-modelo").textContent = "No disponible";
    $("d-modelo").textContent = error.message;
  }
}

// ---------------------------------------------------------------- pronóstico
async function cargarPrediccion() {
  const miSolicitud = ++numSolicitud;
  const horas = $("horas").value;
  const historia = $("historia").value;
  const confianza = $("confianza").value;

  document.body.classList.add("cargando");
  $("actualizar").disabled = true;
  try {
    const datos = await pedirJSON(`/api/prediccion?horas=${horas}&historia=${historia}&confianza=${confianza}`);
    if (miSolicitud !== numSolicitud) return;          // ya llegó una petición más nueva
    if (!datos.prediccion || datos.prediccion.length === 0) throw new Error("La API no devolvió pronóstico.");
    ultimaRespuesta = datos;
    ocultarError();
    pintarIndicadores(datos);
    pintarGrafica(datos);
    pintarTabla(datos);
  } catch (error) {
    if (miSolicitud === numSolicitud) mostrarError(error.message);
  } finally {
    if (miSolicitud === numSolicitud) {
      document.body.classList.remove("cargando");
      $("actualizar").disabled = false;
    }
  }
}

// ---------------------------------------------------------------- indicadores (requisito 3)
function pintarIndicadores(datos) {
  const pred = datos.prediccion;
  const pct = Math.round(datos.confianza * 100);

  // Próxima hora
  const primera = pred[0];
  $("v-proxima").textContent = numero(primera.prediccion);
  $("d-proxima").textContent =
    `a las ${fHora.format(aFecha(primera.tiempo))} · entre ${numero(primera.limite_inferior)} y ${numero(primera.limite_superior)} (${pct} %)`;

  // Máximo esperado dentro del horizonte elegido
  const maxima = pred.reduce((a, b) => (b.prediccion > a.prediccion ? b : a));
  $("v-maximo").textContent = numero(maxima.prediccion);
  $("d-maximo").textContent = `${fCorto.format(aFecha(maxima.tiempo))} · puede llegar a ${numero(maxima.limite_superior)}`;

  // Calidad de los datos: horas sin dato que la API tuvo que rellenar
  const rellenadas = datos.horas_rellenadas;
  const consultadas = datos.horas_contexto_usadas;
  const nivel = rellenadas === 0 ? "ok" : rellenadas <= 6 ? "aviso" : "alerta";
  $("v-datos").textContent = rellenadas === 0 ? "Completos" : `${rellenadas} h rellenadas`;
  $("d-datos").textContent =
    rellenadas === 0 ? `${consultadas} h consultadas, sin huecos`
    : nivel === "aviso" ? `de ${consultadas} h consultadas: pronóstico algo menos confiable`
    : `de ${consultadas} h consultadas: el sensor estuvo caído, pronóstico poco confiable`;
  $("t-datos").dataset.nivel = nivel;

  // Hora del último dato real (encabezado)
  const ultima = aFecha(datos.ultima_observacion);
  const atrasoHoras = (Date.now() - ultima.getTime()) / 3600000;
  let texto = `Último dato real: ${fCorto.format(ultima)}`;
  if (atrasoHoras > 3) texto += ` · ⚠ sin datos nuevos desde hace ${Math.floor(atrasoHoras)} h`;
  $("ultimo-dato").textContent = texto;
}

// ---------------------------------------------------------------- gráfica (requisito 1)
// Línea vertical que separa el pasado del pronóstico
const lineaAhora = {
  id: "lineaAhora",
  afterDatasetsDraw(chart, _args, opciones) {
    if (opciones.indice == null || opciones.indice < 0) return;
    const x = chart.scales.x.getPixelForValue(opciones.indice);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = colorCSS("--suave");
    ctx.fillStyle = colorCSS("--suave");
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("Pronóstico →", x + 6, top + 14);
    ctx.restore();
  },
};

function pintarGrafica(datos) {
  const aviso = $("aviso-grafica");
  if (typeof Chart === "undefined") {
    aviso.textContent = "No se pudo cargar la librería de gráficas (¿sin conexión a internet?). " +
                        "Los indicadores y la tabla siguen funcionando.";
    aviso.hidden = false;
    return;
  }
  aviso.hidden = true;

  const hist = datos.historico;
  const pred = datos.prediccion;
  const pct = Math.round(datos.confianza * 100);
  const nh = hist.length;
  const tiempos = [...hist.map((h) => h.tiempo), ...pred.map((p) => p.tiempo)];

  const vacios = (n) => new Array(n).fill(null);
  // Las líneas del pronóstico arrancan en el último dato real para que la gráfica no quede cortada
  const unir = nh ? hist[nh - 1].valor : null;
  const conUnion = (valores) => [...vacios(Math.max(nh - 1, 0)), ...(nh ? [unir] : []), ...valores];

  const serieHistorico = [...hist.map((h) => h.valor), ...vacios(pred.length)];
  const seriePronostico = conUnion(pred.map((p) => p.prediccion));
  const serieInferior = conUnion(pred.map((p) => p.limite_inferior));
  const serieSuperior = conUnion(pred.map((p) => p.limite_superior));

  if (grafica) grafica.destroy();
  grafica = new Chart($("grafica"), {
    type: "line",
    data: {
      labels: tiempos,
      datasets: [
        { label: "Límite inferior", data: serieInferior, borderWidth: 0, pointRadius: 0, fill: false },
        { label: `Intervalo de confianza ${pct} %`, data: serieSuperior, borderWidth: 0, pointRadius: 0,
          backgroundColor: colorCSS("--banda"), fill: "-1" },
        { label: "Histórico", data: serieHistorico, borderColor: colorCSS("--historico"),
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
        { label: "Pronóstico", data: seriePronostico, borderColor: colorCSS("--pronostico"),
          borderWidth: 2.5, borderDash: [7, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: colorCSS("--suave"),
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: esCelular() ? 4 : 8,
            // Las etiquetas del eje son las marcas UTC; se muestran en hora de Colombia
            callback(valor) {
              return (esCelular() ? fEjeCorto : fEje).format(aFecha(this.getLabelForValue(valor)));
            },
          },
        },
        y: {
          grace: "8%",
          grid: { color: colorCSS("--borde") },
          ticks: { color: colorCSS("--suave") },
          title: { display: true, text: "Consumo", color: colorCSS("--suave") },
        },
      },
      plugins: {
        lineaAhora: { indice: nh - 1 },
        legend: {
          labels: {
            color: colorCSS("--texto"),
            usePointStyle: true,
            filter: (item) => item.datasetIndex !== 0,      // se oculta "Límite inferior" de la leyenda
          },
        },
        tooltip: {
          filter: (item) => item.datasetIndex >= 2,
          callbacks: {
            title: (items) => `${fLargo.format(aFecha(tiempos[items[0].dataIndex]))} (hora de Colombia)`,
            label: (item) => `${item.dataset.label}: ${numero(item.parsed.y)}`,
            afterBody: (items) => {
              const i = items[0].dataIndex;
              return i >= nh
                ? `Intervalo ${pct} %: ${numero(serieInferior[i])} a ${numero(serieSuperior[i])}`
                : "";
            },
          },
        },
      },
    },
    plugins: [lineaAhora],
  });

  const maxima = pred.reduce((a, b) => (b.prediccion > a.prediccion ? b : a));
  $("grafica").setAttribute("aria-label",
    `Gráfica del consumo: ${nh} horas de histórico y ${pred.length} horas de pronóstico. ` +
    `El máximo esperado es ${numero(maxima.prediccion)} el ${fCorto.format(aFecha(maxima.tiempo))}.`);
}

// ---------------------------------------------------------------- tabla de detalle
function pintarTabla(datos) {
  const pred = datos.prediccion;
  const pct = Math.round(datos.confianza * 100);
  const maxima = pred.reduce((a, b) => (b.prediccion > a.prediccion ? b : a));

  $("titulo-tabla").textContent = `Detalle del pronóstico · hora de Colombia · intervalo del ${pct} %`;
  const fFila = esCelular() ? fEjeCorto : fCorto;   // fecha más corta en el celular
  $("filas").innerHTML = pred.map((p) => `
    <tr class="${p === maxima ? "maximo" : ""}">
      <td>${fFila.format(aFecha(p.tiempo))}${p === maxima ? '<span class="etiqueta-max">máx.</span>' : ""}</td>
      <td class="num">${numero(p.prediccion)}</td>
      <td class="num">${numero(p.limite_inferior)}</td>
      <td class="num">${numero(p.limite_superior)}</td>
    </tr>`).join("");
}

// ---------------------------------------------------------------- arranque
["horas", "historia", "confianza"].forEach((id) => $(id).addEventListener("change", cargarPrediccion));
$("actualizar").addEventListener("click", cargarPrediccion);
$("reintentar").addEventListener("click", cargarPrediccion);

// Si cambia el tema claro/oscuro del sistema, se repinta la gráfica con los colores nuevos
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (ultimaRespuesta) pintarGrafica(ultimaRespuesta);
});

// Refresco automático mientras la pestaña esté visible
setInterval(() => { if (document.visibilityState === "visible") cargarPrediccion(); }, REFRESCO_MS);

cargarModelo();
cargarPrediccion();
