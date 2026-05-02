/**
 * Termómetro Social Chile
 * Script de actualización diaria — llama a Claude API con web search
 * y escribe data/coeficiente.json y data/historial.json
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌ Falta la variable de entorno ANTHROPIC_API_KEY');
  process.exit(1);
}

// ─── MODELO ───
const VARIABLES = [
  { id:'gini',         peso:0.18, ref2019:0.46, min:0.25, max:0.65, inverso:false },
  { id:'costo',        peso:0.15, ref2019:72,   min:20,   max:100,  inverso:false },
  { id:'desempleo',    peso:0.10, ref2019:7.2,  min:2,    max:25,   inverso:false },
  { id:'conf_gob',     peso:0.14, ref2019:14,   min:5,    max:80,   inverso:true  },
  { id:'conf_cong',    peso:0.10, ref2019:11,   min:3,    max:70,   inverso:true  },
  { id:'movilizacion', peso:0.13, ref2019:9.5,  min:1,    max:10,   inverso:false },
  { id:'abuso',        peso:0.10, ref2019:68,   min:5,    max:95,   inverso:false },
  { id:'frag',         peso:0.10, ref2019:8.5,  min:2,    max:20,   inverso:false },
];

function calcularCoeficiente(variables) {
  let score = 0;
  for (const v of VARIABLES) {
    const dato = variables[v.id];
    const val = (dato && dato.valor != null) ? dato.valor : v.ref2019;
    const clamped = Math.min(v.max, Math.max(v.min, val));
    let norm = (clamped - v.min) / (v.max - v.min);
    if (v.inverso) norm = 1 - norm;
    score += norm * v.peso;
  }
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

// ─── PROMPT ───
function buildPrompt(today) {
  return `Hoy es ${today}. Eres un analista experto en datos socioeconómicos y políticos de Chile. Tu objetivo es construir un índice de tensión social objetivo y sin sesgo ideológico.

INSTRUCCIÓN DE BALANCE EDITORIAL:
Debes consultar fuentes de DISTINTOS espectros editoriales. Para cada variable busca en al menos 2 fuentes distintas:
- Derecha/centroderecha: El Mercurio, La Tercera, DF (Diario Financiero), Emol
- Centro: CNN Chile, BioBioChile, La Segunda
- Izquierda/centroizquierda: El Mostrador, The Clinic, Radio Universidad de Chile
- Oficiales/neutras: INE, Cadem, CEP, IPSOS, Ministerios, Banco Central, Banco Mundial

Si encuentras discrepancias entre fuentes de distinto espectro, anótalas en el campo "nota". El valor final debe ser el promedio o el dato más reciente de fuente oficial cuando exista.

VARIABLES A BUSCAR (datos más recientes de Chile):
1. gini — Coeficiente Gini de Chile (decimal 0.25-0.65). Busca "Gini Chile 2024 2025 OCDE Banco Mundial"
2. costo — % chilenos que sienten que el sueldo no alcanza o ven el costo de vida como problema (entero 20-100). Busca "encuesta costo vida Chile 2025 2026"
3. desempleo — Tasa de desocupación INE Chile más reciente (decimal 2-25). Busca "desempleo Chile INE 2026"
4. conf_gob — % aprobación gobierno Boric (entero 5-80). Busca "aprobacion Boric Cadem Plaza Publica 2026"
5. conf_cong — % confianza Congreso Nacional Chile (entero 3-70). Busca "confianza Congreso Chile CEP Cadem 2025 2026"
6. movilizacion — Nivel movilización social Chile 1-10 según protestas/marchas/huelgas recientes (decimal 1-10). Busca "protestas huelgas Chile 2026"
7. abuso — % percepción abuso policial o institucional en Chile (entero 5-95). Busca "abuso policial Chile encuesta 2025 2026"
8. frag — Número efectivo de partidos con representación parlamentaria en Chile (decimal 2-20). Busca "partidos politicos Congreso Chile 2026"

FORMATO DE RESPUESTA:
Retorna ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin bloques markdown, sin explicaciones. Solo el JSON puro:

{
  "fecha": "${today}",
  "variables": {
    "gini":         {"valor": 0.0,  "fuente": "", "tipo_fuente": "oficial",   "fecha": "", "nota": ""},
    "costo":        {"valor": 0,    "fuente": "", "tipo_fuente": "encuesta",  "fecha": "", "nota": ""},
    "desempleo":    {"valor": 0.0,  "fuente": "", "tipo_fuente": "oficial",   "fecha": "", "nota": ""},
    "conf_gob":     {"valor": 0,    "fuente": "", "tipo_fuente": "encuesta",  "fecha": "", "nota": ""},
    "conf_cong":    {"valor": 0,    "fuente": "", "tipo_fuente": "encuesta",  "fecha": "", "nota": ""},
    "movilizacion": {"valor": 0.0,  "fuente": "", "tipo_fuente": "media",     "fecha": "", "nota": ""},
    "abuso":        {"valor": 0,    "fuente": "", "tipo_fuente": "encuesta",  "fecha": "", "nota": ""},
    "frag":         {"valor": 0.0,  "fuente": "", "tipo_fuente": "oficial",   "fecha": "", "nota": ""}
  },
  "fuentes_usadas": [
    {"variable": "", "nombre": "", "tipo": "oficial", "espectro": "neutro", "fecha": ""}
  ],
  "fuentes_editoriales": {
    "derecha": 0,
    "centro": 0,
    "izquierda": 0
  }
}

Campos tipo_fuente válidos: "oficial", "encuesta", "media", "rrss"
Campos espectro válidos: "derecha", "centroderecha", "centro", "centroizquierda", "izquierda", "neutro"`;
}

// ─── LLAMADA A CLAUDE API ───
async function llamarClaude(today) {
  console.log('📡 Llamando a Claude API con web search...');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: buildPrompt(today) }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const fullText = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  console.log('✅ Respuesta recibida de Claude.');

  // Extraer JSON de la respuesta
  let jsonStr = fullText.replace(/```json|```/g, '').trim();
  const match = jsonStr.match(/\{[\s\S]*"variables"[\s\S]*\}/);
  if (match) jsonStr = match[0];

  return JSON.parse(jsonStr);
}

// ─── MAIN ───
async function main() {
  const today = new Date().toLocaleDateString('es-CL', {
    timeZone: 'America/Santiago',
    day: 'numeric', month: 'long', year: 'numeric'
  });
  const todayISO = new Date().toLocaleDateString('es-CL', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).split('/').reverse().join('-');

  console.log(`\n🌡  Termómetro Social Chile — ${today}`);
  console.log('─'.repeat(50));

  // Asegurar que existe la carpeta data/
  if (!existsSync('data')) mkdirSync('data');

  let parsed;
  try {
    parsed = await llamarClaude(today);
  } catch (err) {
    console.error('❌ Error al llamar a Claude:', err.message);
    process.exit(1);
  }

  // Calcular coeficiente
  const coeficiente = calcularCoeficiente(parsed.variables);
  const resultado = { ...parsed, coeficiente, fecha: today, fecha_iso: todayISO };

  // Mostrar resultado en consola
  console.log(`\n📊 Coeficiente calculado: ${coeficiente}`);
  for (const v of VARIABLES) {
    const d = parsed.variables[v.id];
    if (d) console.log(`  ${v.id.padEnd(14)} ${String(d.valor).padEnd(8)} ← ${d.fuente}`);
  }

  // Escribir coeficiente.json
  writeFileSync('data/coeficiente.json', JSON.stringify(resultado, null, 2));
  console.log('\n✅ data/coeficiente.json actualizado.');

  // Actualizar historial.json
  const histPath = 'data/historial.json';
  let historial = [];
  if (existsSync(histPath)) {
    try { historial = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
  }

  // Evitar duplicados del mismo día
  historial = historial.filter(d => d.fecha_iso !== todayISO);
  historial.push({ fecha: today, fecha_iso: todayISO, coeficiente });

  // Mantener máximo 365 días
  if (historial.length > 365) historial = historial.slice(-365);
  historial.sort((a, b) => (a.fecha_iso||'').localeCompare(b.fecha_iso||''));

  writeFileSync(histPath, JSON.stringify(historial, null, 2));
  console.log('✅ data/historial.json actualizado.');
  console.log(`\n🎉 Proceso completado. Coeficiente hoy: ${coeficiente}`);
}

main().catch(err => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
