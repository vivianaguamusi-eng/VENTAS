// api/dashboard.js
// Función serverless de Vercel (Node.js) que descarga el CSV publicado de
// Google Sheets, lo parsea a JSON tipado y lo devuelve al cliente.
//
// La URL es un link "publicado en la web" de Google Sheets: es pública por
// diseño (así funciona la función "Publicar en la web" de Sheets), por lo
// que NO se trata de un secreto y no necesita variable de entorno.

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRZhG16c6gNzf_76m8fnRuDOnFbYdnDDvr-9PnoEiQOVQLL30TvE44RYisrBVXTUeuZFXvD6Mtqt7ht/pub?output=csv";

// Orden de columnas esperado en la hoja:
// Fecha (Fecha) | Vendedor (Texto) | Producto (Texto) | Monto (Número) | Región (Texto)
const COLUMNAS = ["fecha", "vendedor", "producto", "monto", "region"];

/**
 * Parser de CSV estándar (RFC 4180) implementado a mano, sin dependencias.
 * Soporta:
 *  - Campos entre comillas dobles que contienen comas.
 *  - Comillas dobles escapadas dentro de un campo entre comillas ("").
 *  - Saltos de línea \n, \r\n y \r dentro y fuera de campos entre comillas.
 */
function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = "";
  let dentroDeComillas = false;

  // Normalizamos \r\n y \r sueltos para simplificar el recorrido,
  // pero solo fuera de campos entre comillas (por eso recorremos char a char).
  for (let i = 0; i < texto.length; i++) {
    const char = texto[i];
    const siguiente = texto[i + 1];

    if (dentroDeComillas) {
      if (char === '"' && siguiente === '"') {
        campo += '"';
        i++; // saltar la segunda comilla del escape
      } else if (char === '"') {
        dentroDeComillas = false;
      } else {
        campo += char;
      }
      continue;
    }

    if (char === '"') {
      dentroDeComillas = true;
      continue;
    }

    if (char === ",") {
      fila.push(campo);
      campo = "";
      continue;
    }

    if (char === "\r") {
      // Si viene seguido de \n, lo dejamos que lo maneje el \n
      if (siguiente === "\n") continue;
      fila.push(campo);
      campo = "";
      filas.push(fila);
      fila = [];
      continue;
    }

    if (char === "\n") {
      fila.push(campo);
      campo = "";
      filas.push(fila);
      fila = [];
      continue;
    }

    campo += char;
  }

  // Último campo / fila pendiente
  if (campo.length > 0 || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  // Descartamos filas completamente vacías (líneas en blanco al final del CSV)
  return filas.filter((f) => f.some((valor) => valor.trim() !== ""));
}

/**
 * Convierte un valor de monto en texto (posible "$", separadores de miles,
 * comas decimales, espacios) a un número JavaScript.
 */
function parseMonto(valorCrudo) {
  if (valorCrudo == null) return 0;
  let limpio = String(valorCrudo).trim();
  if (limpio === "") return 0;

  // Quitar símbolos de moneda y espacios
  limpio = limpio.replace(/[^0-9.,-]/g, "");

  const tieneComa = limpio.includes(",");
  const tienePunto = limpio.includes(".");

  if (tieneComa && tienePunto) {
    // Formato "1.234,56" -> el punto es separador de miles, la coma es decimal
    if (limpio.lastIndexOf(",") > limpio.lastIndexOf(".")) {
      limpio = limpio.replace(/\./g, "").replace(",", ".");
    } else {
      // Formato "1,234.56" -> la coma es separador de miles
      limpio = limpio.replace(/,/g, "");
    }
  } else if (tieneComa && !tienePunto) {
    // Solo coma: puede ser decimal ("1234,56") o miles ("1,234").
    const partes = limpio.split(",");
    if (partes[partes.length - 1].length === 2) {
      limpio = limpio.replace(/,/g, (m, idx) =>
        idx === limpio.lastIndexOf(",") ? "." : ""
      );
      limpio = partes.slice(0, -1).join("") + "." + partes[partes.length - 1];
    } else {
      limpio = limpio.replace(/,/g, "");
    }
  }

  const numero = parseFloat(limpio);
  return Number.isFinite(numero) ? numero : 0;
}

/**
 * Convierte el texto de fecha del CSV a un ISO string (YYYY-MM-DD) estable,
 * aceptando formatos comunes de Google Sheets: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD.
 */
function parseFecha(valorCrudo) {
  if (!valorCrudo) return null;
  const texto = String(valorCrudo).trim();
  if (texto === "") return null;

  // YYYY-MM-DD o YYYY/MM/DD
  let m = texto.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD/MM/YYYY (formato regional más común en hojas en español)
  m = texto.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // Como último recurso, dejar que Date lo intente parsear
  const fechaNativa = new Date(texto);
  if (!isNaN(fechaNativa.getTime())) {
    return fechaNativa.toISOString().slice(0, 10);
  }

  return texto; // se devuelve tal cual si no se pudo interpretar
}

function filasAObjetos(filas) {
  if (filas.length === 0) return [];

  // La primera fila del CSV se asume como encabezado y se descarta,
  // ya que el orden de columnas viene fijado por el contrato de la hoja.
  const datos = filas.slice(1);

  return datos
    .map((fila) => {
      const [fecha, vendedor, producto, monto, region] = COLUMNAS.map(
        (_, idx) => fila[idx] ?? ""
      );

      return {
        fecha: parseFecha(fecha),
        vendedor: String(vendedor).trim(),
        producto: String(producto).trim(),
        monto: parseMonto(monto),
        region: String(region).trim(),
      };
    })
    .filter((venta) => venta.vendedor !== "" || venta.producto !== "");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const respuesta = await fetch(SHEET_CSV_URL, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!respuesta.ok) {
      throw new Error(
        `Google Sheets respondió con estado ${respuesta.status}`
      );
    }

    const textoCSV = await respuesta.text();
    const filas = parseCSV(textoCSV);
    const ventas = filasAObjetos(filas);

    res.status(200).json({
      success: true,
      syncedAt: new Date().toISOString(),
      total: ventas.length,
      ventas,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      syncedAt: new Date().toISOString(),
      error: error.message || "Error desconocido al sincronizar la hoja.",
      ventas: [],
    });
  }
};
