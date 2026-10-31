const { Telegraf } = require('telegraf');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');

if (!process.env.FIREBASE_CONFIG_JSON) {
  console.error("❌ Falta la variable FIREBASE_CONFIG_JSON en Render.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

const bot = new Telegraf(TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const OFFICIAL_ROWS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44];

function crearEstructuraVacia() {
  const data = {};
  OFFICIAL_ROWS.forEach(r => {
    data[r] = Array.from({ length: 9 }, () => ({ M: 0, F: 0, PD_M: 0, PD_F: 0 }));
  });
  return data;
}

function edadToIndex(edadNum) {
  const e = parseFloat(edadNum) || 0;
  if (e <= 3) return 0;
  if (e <= 6) return 1;
  if (e <= 9) return 2;
  if (e <= 12) return 3;
  if (e <= 17) return 4;
  if (e <= 25) return 5;
  if (e <= 35) return 6;
  if (e <= 59) return 7;
  return 8;
}

// Función para llamar a Gemini con reintentos automáticos si hay alta demanda
async function generarContenidoConReintentos(model, contents, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await model.generateContent(contents);
      return result;
    } catch (err) {
      const msg = err.message || '';
      if ((msg.includes('high demand') || msg.includes('429') || msg.includes('overloaded')) && i < retries - 1) {
        console.warn(`⚠️ Servidor saturado (Alta demanda). Reintentando en ${delay / 1000}s (Intento ${i + 1}/${retries})...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2; // Duplicar espera exponencialmente
      } else {
        throw err;
      }
    }
  }
}

bot.start((ctx) => {
  ctx.reply('🏥 ¡Hola! Envíame la foto de una Hoja de Guardia de Enfermería y contaré automáticamente los datos en la página web.');
});

bot.on('photo', async (ctx) => {
  try {
    await ctx.reply('🔍 Analizando hoja de guardia con IA (si hay alta demanda, reintentaré automáticamente)...');

    const photoArray = ctx.message.photo;
    const bestPhoto = photoArray[photoArray.length - 1];
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);

    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const base64Image = Buffer.from(response.data, 'binary').toString('base64');

    // Usamos gemini-1.5-flash que es sumamente estable frente a picos de demanda
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
      Eres un experto digitalizador de hojas de guardia diaria de enfermería en Venezuela.
      Analiza cada fila numerada escrita a mano en la imagen. Ignora los nombres salvo para deducir el sexo ("M" o "F") si la casilla SEXO está vacía.
      Devuelve ÚNICAMENTE un objeto JSON válido sin bloques markdown con este formato exacto:
      {
        "pacientes": [
          {"edad": 27, "sexo": "F", "medicamentos": 2, "tr": false, "cura": false, "sutura": false, "ta": false, "prenatal": false, "parto": false, "retiro_diu": false, "colocacion_diu": false, "implante": false}
        ]
      }
      Reglas:
      - "edad": años en número entero (si dice meses como "6m", pon 0).
      - "sexo": "M" o "F".
      - "medicamentos": cuántos medicamentos (EV, IM, Oral o gotas) se aplicaron en esa fila. Si hay varios separados por "+", cuéntalos por separado.
      - "tr": true si recibió Terapia Respiratoria / Nebulización (TR, T/R, Budesonida, Budecort).
      - "cura": true si dice Cura, Lavado ocular o Lavado ótico.
      - "sutura": true si dice Sutura.
      - "ta": true si tiene tensión arterial en la columna T.A o dice Control de TA.
      - "prenatal": true si dice Prenatal o Embarazada.
      - "parto": true si dice Parto.
    `;

    const result = await generarContenidoConReintentos(model, [
      prompt,
      { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
    ]);

    const rawText = result.response.text().trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No se pudo leer el formato de la hoja.');

    const parsed = JSON.parse(jsonMatch[0]);
    const lista = parsed.pacientes || [];

    if (lista.length === 0) {
      return ctx.reply('⚠️ No detecté filas de pacientes en la imagen. Intenta con una foto más clara.');
    }

    const docRef = db.collection('estadistica_salud').doc('consolidado_jel');
    let totalMeds = 0, totalTR = 0, totalCuras = 0, totalTA = 0;

    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      let appData = crearEstructuraVacia();

      if (snap.exists && snap.data().appData) {
        try { appData = JSON.parse(snap.data().appData); } catch (e) {}
      }

      lista.forEach(p => {
        const aIdx = edadToIndex(p.edad);
        const s = (p.sexo && p.sexo.toUpperCase() === 'F') ? 'F' : 'M';

        appData[12][aIdx][s] = (appData[12][aIdx][s] || 0) + 1;

        const cantMeds = parseInt(p.medicamentos, 10) || 0;
        if (cantMeds > 0) {
          appData[14][aIdx][s] = (appData[14][aIdx][s] || 0) + cantMeds;
          totalMeds += cantMeds;
        }

        if (p.tr) {
          appData[13][aIdx][s] = (appData[13][aIdx][s] || 0) + 1;
          appData[17][aIdx][s] = (appData[17][aIdx][s] || 0) + 1;
          totalTR++;
        }

        if (p.sutura) {
          appData[20][aIdx][s] = (appData[20][aIdx][s] || 0) + 1;
          appData[19][aIdx][s] = (appData[19][aIdx][s] || 0) + 1;
          totalCuras++;
        } else if (p.cura) {
          appData[19][aIdx][s] = (appData[19][aIdx][s] || 0) + 1;
          totalCuras++;
        }

        if (p.ta) {
          appData[18][aIdx][s] = (appData[18][aIdx][s] || 0) + 1;
          totalTA++;
        }

        if (p.prenatal) appData[27][aIdx][s] = (appData[27][aIdx][s] || 0) + 1;
        if (p.parto) appData[30][aIdx][s] = (appData[30][aIdx][s] || 0) + 1;
        if (p.retiro_diu) appData[22][aIdx][s] = (appData[22][aIdx][s] || 0) + 1;
        if (p.colocacion_diu) appData[23][aIdx][s] = (appData[23][aIdx][s] || 0) + 1;
        if (p.implante) appData[34][aIdx][s] = (appData[34][aIdx][s] || 0) + 1;
      });

      t.set(docRef, {
        appData: JSON.stringify(appData),
        updatedAt: new Date().toISOString()
      }, { merge: true });
    });

    ctx.reply(
      `✅ ¡Hoja de guardia sumada con éxito a la web!\n\n` +
      `👥 Pacientes (Triaje): +${lista.length}\n` +
      `💉 Medicamentos (EV/IM/Oral): +${totalMeds}\n` +
      `💨 Nebulizaciones (TR): +${totalTR}\n` +
      `🩹 Curas / Suturas: +${totalCuras}\n` +
      `❤️ Controles de T.A: +${totalTA}`
    );

  } catch (error) {
    console.error('Error procesando hoja:', error);
    ctx.reply('❌ Error al procesar la hoja debido a tráfico alto en la IA. Vuelve a enviar la foto en un momento.');
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot de Estadistica Enfermeria Activo 24/7');
}).listen(PORT, () => {
  console.log(`🌐 Servidor HTTP listo en puerto ${PORT}`);
});

bot.launch().then(() => {
  console.log('🤖 Bot de Estadística EN LÍNEA.');
});