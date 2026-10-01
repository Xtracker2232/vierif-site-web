const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { Pool } = require('pg');
const { Client: MindeeClient } = require('mindee');

// Désactive le cache de sharp (évite des erreurs de fichiers)
sharp.cache(false);

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante.');
  process.exit(1);
}
if (!process.env.MINDEE_API_KEY) {
  console.error('❌ MINDEE_API_KEY manquante.');
  process.exit(1);
}
if (!process.env.MINDEE_MODEL_ID) {
  console.error('❌ MINDEE_MODEL_ID manquante.');
  process.exit(1);
}

// ========== MINDEE ==========
const mindeeClient = new MindeeClient({
  apiKey: process.env.MINDEE_API_KEY,
});

const MINDEE_MODEL_ID = process.env.MINDEE_MODEL_ID;
const MINDEE_ACCOUNT_NAME = process.env.MINDEE_ACCOUNT_NAME || '';

// ========== POSTGRES ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        code         TEXT PRIMARY KEY,
        discord_id   TEXT NOT NULL,
        valide       INTEGER DEFAULT 0,
        photo_path   TEXT,
        a_moderer    INTEGER DEFAULT 0,
        lycee        TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('ALTER TABLE verifications ADD COLUMN IF NOT EXISTS lycee TEXT');
    console.log('✅ Table verifications prête.');
  } catch (err) {
    console.error('❌ Erreur création table :', err.message);
  }
})();

// ========== UPLOAD ==========
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées'));
  },
});

// ========== LYCEES ACCEPTES ==========
const LYCEES = [
  { nom: 'Léon Chiris',      variantes: ['leon chiris', 'leonchiris', 'chiris'] },
  { nom: 'Amiral de Grasse', variantes: ['amiral de grasse', 'amiral grasse', 'grasse'] },
  { nom: 'Decroisset',       variantes: ['decroisset', 'de croisset', 'croisset'] },
];

function normaliser(texte) {
  if (!texte) return '';
  return texte
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trouverLycee(texteExtrait) {
  const texte = normaliser(texteExtrait);
  for (const lycee of LYCEES) {
    for (const variante of lycee.variantes) {
      if (texte.includes(normaliser(variante))) return lycee.nom;
    }
  }
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

    if (!rows[0]) {
      return res.status(400).json({
        erreur: 'Code invalide ou déjà utilisé. Vérifie ton MP Discord.',
      });
    }

    res.json({ succes: true });
  } catch (err) {
    console.error('Erreur SQL verifier-code :', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// --- Route 2 : upload photo + analyse Mindee ---
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
      return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
    }

    // Optimisation de l'image
    const baseName = path.parse(req.file.filename).name;
    imageOptimisee = path.join(UPLOAD_DIR, `opt-${baseName}.jpg`);

    await sharp(req.file.path)
      .rotate()
      .resize({ width: 2000, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(imageOptimisee);

    console.log(`📤 Envoi à Mindee (code ${code})...`);

    // Variable pour stocker le lycée trouvé
    let lyceeTrouve = null;
    let erreurMindee = false;

    try {
      // Prépare le stream en gérant l'erreur
      const stream = fs.createReadStream(imageOptimisee);
      stream.on('error', (err) => {
        console.error('Erreur stream:', err);
      });

      // Paramètres de l'appel Mindee
      const mindeeOptions = { endpointName: MINDEE_MODEL_ID };
      if (MINDEE_ACCOUNT_NAME) {
        mindeeOptions.accountName = MINDEE_ACCOUNT_NAME;
      }

      const response = await mindeeClient.parse(
        require('mindee').product.CustomV1,
        { inputSource: stream },
        mindeeOptions
      );

      const toutesLesValeurs = JSON.stringify(response.document);
      console.log(`📄 Réponse Mindee (${code}) :`, toutesLesValeurs.slice(0, 500));

      lyceeTrouve = trouverLycee(toutesLesValeurs);
    } catch (mindeeErr) {
      console.error('❌ Erreur Mindee :', mindeeErr.message);
      erreurMindee = true;
    }

    if (lyceeTrouve) {
      // ✅ Validation automatique
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

    // ❌ Envoi en modération manuelle
    await pool.query(
      'UPDATE verifications SET photo_path = $1, a_moderer = 1, lycee = $2 WHERE code = $3',
      [
        req.file.path,
        erreurMindee ? 'Erreur analyse' : 'En attente',
        code.toUpperCase().trim(),
      ]
    );

    try { fs.unlinkSync(imageOptimisee); } catch (e) {}

    console.log(`⚠️ Envoi en modération pour ${code} (raison: ${erreurMindee ? 'erreur Mindee' : 'aucun lycée reconnu'})`);
    return res.json({
      succes: true,
      moderation: true,
      message:
        '📸 Photo reçue. Un modérateur va vérifier ton carnet manuellement ' +
        '(généralement sous quelques heures).',
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

    if (!rows[0] || !rows[0].photo_path) {
      return res.status(404).send('Photo introuvable');
    }

    const filePath = rows[0].photo_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Fichier introuvable');
    }

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