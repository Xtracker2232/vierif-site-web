const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { Pool } = require('pg');
const mindee = require('mindee');

sharp.cache(false);

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL manquante.'); process.exit(1); }
if (!process.env.MINDEE_API_KEY) { console.error('❌ MINDEE_API_KEY manquante.'); process.exit(1); }
if (!process.env.MINDEE_MODEL_ID) { console.error('❌ MINDEE_MODEL_ID manquante.'); process.exit(1); }

// ========== MINDEE V2 ==========
const mindeeClient = new mindee.Client({ apiKey: process.env.MINDEE_API_KEY });
const MINDEE_MODEL_ID = process.env.MINDEE_MODEL_ID;

console.log(`🔧 Mindee V2 initialisé. Model ID: ${MINDEE_MODEL_ID}`);

// ========== POSTGRES ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        code TEXT PRIMARY KEY, discord_id TEXT NOT NULL, valide INTEGER DEFAULT 0,
        photo_path TEXT, a_moderer INTEGER DEFAULT 0, lycee TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('ALTER TABLE verifications ADD COLUMN IF NOT EXISTS lycee TEXT');
    console.log('✅ Table verifications prête.');
  } catch (err) { console.error('❌ Erreur création table :', err.message); }
})();

// ========== UPLOAD ==========
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images uniquement'));
  }
});

// ========== LYCEES ==========
const LYCEES = [
  { nom: 'Léon Chiris', variantes: ['leon chiris', 'leonchiris', 'chiris'] },
  { nom: 'Amiral de Grasse', variantes: ['amiral de grasse', 'amiral grasse', 'grasse'] },
  { nom: 'Decroisset', variantes: ['decroisset', 'de croisset', 'croisset'] },
];

function normaliser(texte) {
  if (!texte) return '';
  return texte.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function trouverLycee(texte) {
  const t = normaliser(texte);
  for (const l of LYCEES) for (const v of l.variantes) if (t.includes(normaliser(v))) return l.nom;
  return null;
}

// ========== APP ==========
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Route 1 : vérifier le code ---
app.post('/api/verifier-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM verifications WHERE code = $1 AND valide = 0',
      [code.toUpperCase().trim()]
    );
    if (!rows[0]) return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
    res.json({ succes: true });
  } catch (err) {
    console.error('Erreur SQL:', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// --- Route 2 : upload photo + Mindee V2 Extraction ---
app.post('/api/verifier-photo', upload.single('photo'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });
  if (!req.file) return res.status(400).json({ erreur: 'Aucune photo reçue' });

  let imageOptimisee = null;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM verifications WHERE code = $1 AND valide = 0',
      [code.toUpperCase().trim()]
    );
    if (!rows[0]) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ erreur: 'Code invalide.' });
    }

    const baseName = path.parse(req.file.filename).name;
    imageOptimisee = path.join(UPLOAD_DIR, `opt-${baseName}.jpg`);
    await sharp(req.file.path)
      .rotate()
      .resize({ width: 2000, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(imageOptimisee);

    console.log(`📤 Envoi à Mindee V2 Extraction (code ${code})...`);

    let lyceeTrouve = null;
    let erreurMindee = false;

    try {
      const inputSource = new mindee.PathInput({ inputPath: imageOptimisee });
      const modelParams = { modelId: MINDEE_MODEL_ID };

      // Appel V2 avec Extraction (ton modèle est un modèle d'extraction
      // qui contient un champ de type classification en interne)
      const response = await mindeeClient.enqueueAndGetResult(
        mindee.product.Extraction,
        inputSource,
        modelParams
      );

      console.log(`📄 Réponse Mindee brute :`, JSON.stringify(response.inference).slice(0, 1200));

      // Extraction du champ etablissement_scolaire (plusieurs chemins possibles selon structure)
      let valeurExtraite = null;
      const r = response.inference?.result || {};
      const fields = r.fields || {};

      // Cas 1 : valeur directe dans fields.etablissement_scolaire
      let etab = fields.etablissement_scolaire;

      // Cas 2 : valeur dans fields.fields.etablissement_scolaire
      if (!etab && fields.fields) etab = fields.fields.etablissement_scolaire;

      // Cas 3 : dans prediction.fields
      if (!etab && r.prediction?.fields) etab = r.prediction.fields.etablissement_scolaire;

      if (etab) {
        if (typeof etab === 'string') valeurExtraite = etab;
        else if (etab.value) valeurExtraite = etab.value;
        else if (etab.stringValue) valeurExtraite = etab.stringValue;
        else if (etab.content) valeurExtraite = etab.content;
        else if (Array.isArray(etab.values) && etab.values[0]) {
          const v = etab.values[0];
          valeurExtraite = v.content || v.value || v.stringValue || (typeof v === 'string' ? v : null);
        }
      }

      console.log(`🏫 Lycée extrait :`, valeurExtraite);

      if (valeurExtraite) {
        lyceeTrouve = trouverLycee(valeurExtraite);
      }
      if (!lyceeTrouve) {
        // Fallback : cherche dans toute la réponse
        lyceeTrouve = trouverLycee(JSON.stringify(response.inference));
      }
    } catch (mindeeErr) {
      console.error('❌ Erreur Mindee :', mindeeErr.message);
      if (mindeeErr.response) {
        console.error('Détails:', JSON.stringify(mindeeErr.response).slice(0, 400));
      }
      erreurMindee = true;
    }

    if (lyceeTrouve) {
      await pool.query(
        'UPDATE verifications SET valide = 1, lycee = $1 WHERE code = $2',
        [lyceeTrouve, code.toUpperCase().trim()]
      );
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      try { fs.unlinkSync(imageOptimisee); } catch (e) {}
      console.log(`✅ Lycée reconnu : ${lyceeTrouve}`);
      return res.json({
        succes: true,
        message: `✅ Carnet reconnu (${lyceeTrouve}). Tu seras vérifié dans quelques secondes.`,
      });
    }

    await pool.query(
      'UPDATE verifications SET photo_path = $1, a_moderer = 1, lycee = $2 WHERE code = $3',
      [req.file.path, erreurMindee ? 'Erreur analyse' : 'En attente', code.toUpperCase().trim()]
    );
    try { fs.unlinkSync(imageOptimisee); } catch (e) {}
    console.log(`⚠️ Envoi en modération pour ${code}`);
    return res.json({
      succes: true,
      moderation: true,
      message: '📸 Photo reçue. Un modérateur va vérifier ton carnet manuellement.',
    });
  } catch (err) {
    console.error('❌ Erreur générale :', err);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    if (imageOptimisee) try { fs.unlinkSync(imageOptimisee); } catch (e) {}
    return res.status(500).json({ erreur: 'Erreur lors du traitement de la photo.' });
  }
});

// --- Route 3 : exposer une photo au bot ---
app.get('/photo/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT photo_path FROM verifications WHERE code = $1',
      [req.params.code.toUpperCase().trim()]
    );
    if (!rows[0] || !rows[0].photo_path) return res.status(404).send('Photo introuvable');
    const filePath = rows[0].photo_path;
    if (!fs.existsSync(filePath)) return res.status(404).send('Fichier introuvable');
    res.sendFile(filePath);
  } catch (err) {
    console.error('Erreur /photo :', err);
    res.status(500).send('Erreur serveur');
  }
});

// --- Route santé ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DEMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Site en ligne sur le port ${PORT}`);
});