const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { Pool } = require('pg');

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante. Ajoute PostgreSQL au projet Railway.');
  process.exit(1);
}

// ========== POSTGRES ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Création de la table au démarrage
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        code         TEXT PRIMARY KEY,
        discord_id   TEXT NOT NULL,
        valide       INTEGER DEFAULT 0,
        photo_path   TEXT,
        a_moderer    INTEGER DEFAULT 0,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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

// ========== LYCEES ==========
const LYCEES = [
  { nom: 'Léon Chiris',      variantes: ['leon chiris', 'leonchiris', 'chiris'] },
  { nom: 'Amiral de Grasse', variantes: ['amiral de grasse', 'amiral grasse', 'grasse'] },
  { nom: 'Decroisset',       variantes: ['decroisset', 'de croisset', 'croisset'] },
];

function normaliser(texte) {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trouverLycee(texteOCR) {
  const texte = normaliser(texteOCR);
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

// --- Route 2 : upload photo + OCR ---
app.post('/api/verifier-photo', upload.single('photo'), async (req, res) => {
  const { code } = req.body;

  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });
  if (!req.file) return res.status(400).json({ erreur: 'Aucune photo reçue' });

  let imageTraitee = null;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM verifications WHERE code = $1 AND valide = 0',
      [code.toUpperCase().trim()]
    );

    if (!rows[0]) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
    }

    // Prétraitement pour améliorer l'OCR
    imageTraitee = path.join(UPLOAD_DIR, `traite-${req.file.filename}.png`);
    await sharp(req.file.path)
      .resize({ width: 1600, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen()
      .toFile(imageTraitee);

    // OCR français
    const { data: { text } } = await Tesseract.recognize(imageTraitee, 'fra');
    console.log(`📄 OCR (${code}) :`, text.slice(0, 200).replace(/\n/g, ' '));

    const lyceeTrouve = trouverLycee(text);

    if (lyceeTrouve) {
      await pool.query(
        'UPDATE verifications SET valide = 1 WHERE code = $1',
        [code.toUpperCase().trim()]
      );

      try { fs.unlinkSync(req.file.path); } catch (e) {}
      if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}

      console.log(`✅ Lycée reconnu : ${lyceeTrouve}`);
      return res.json({
        succes: true,
        message: `✅ Carnet reconnu (${lyceeTrouve}). Tu seras vérifié dans quelques secondes.`,
      });
    }

    // OCR n'a rien trouvé → modération manuelle
    await pool.query(
      'UPDATE verifications SET photo_path = $1, a_moderer = 1 WHERE code = $2',
      [req.file.path, code.toUpperCase().trim()]
    );

    if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}

    console.log(`⚠️ Aucun lycée reconnu — modération pour ${code}`);
    return res.json({
      succes: true,
      moderation: true,
      message:
        '📸 Photo reçue. Un modérateur va vérifier ton carnet manuellement ' +
        '(généralement sous quelques heures).',
    });
  } catch (err) {
    console.error('❌ Erreur OCR :', err);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    if (imageTraitee) try { fs.unlinkSync(imageTraitee); } catch (e) {}
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

// --- Route santé (utile pour Railway) ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DEMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Site en ligne sur le port ${PORT}`);
});