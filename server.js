const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { Pool } = require('pg');

sharp.cache(false);

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante.');
  process.exit(1);
}

console.log('🔧 Serveur de vérification initialisé');
console.log(`📁 Dossier uploads : ${UPLOAD_DIR}`);

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
  } catch (err) {
    console.error('❌ Erreur création table :', err.message);
  }
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
      return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
    }

    res.json({ succes: true });
  } catch (err) {
    console.error('Erreur SQL verifier-code :', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// --- Route 2 : upload photo (100% manuel, pas d'IA) ---
app.post('/api/verifier-photo', upload.single('photo'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ erreur: 'Aucun code fourni' });
  if (!req.file) return res.status(400).json({ erreur: 'Aucune photo reçue' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM verifications WHERE code = $1 AND valide = 0',
      [code.toUpperCase().trim()]
    );

    if (!rows[0]) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ erreur: 'Code invalide.' });
    }

    // Optimisation de l'image (compression, correction orientation)
    const baseName = path.parse(req.file.filename).name;
    const imageOptimisee = path.join(UPLOAD_DIR, `opt-${baseName}.jpg`);

    await sharp(req.file.path)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(imageOptimisee);

    // On supprime l'original (garde seulement l'optimisée)
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    await pool.query(
      'UPDATE verifications SET photo_path = $1, a_moderer = 1, lycee = $2 WHERE code = $3',
      [imageOptimisee, 'En attente', code.toUpperCase().trim()]
    );

    console.log(`📸 Photo reçue pour ${code} — en attente de modération`);
    console.log(`   Fichier : ${imageOptimisee}`);

    return res.json({
      succes: true,
      moderation: true,
      message: '✅ Photo reçue. Un modérateur va vérifier ton carnet manuellement (généralement sous quelques minutes à quelques heures).',
    });
  } catch (err) {
    console.error('❌ Erreur upload :', err);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ erreur: 'Erreur lors du traitement de la photo.' });
  }
});

// --- Route 3 : exposer une photo au bot (appelée par le bot) ---
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

// --- Route 4 : supprimer une photo (appelée par le bot après refus) ---
app.delete('/api/supprimer-photo/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT photo_path FROM verifications WHERE code = $1',
      [req.params.code.toUpperCase().trim()]
    );

    if (rows[0] && rows[0].photo_path && fs.existsSync(rows[0].photo_path)) {
      try { fs.unlinkSync(rows[0].photo_path); } catch (e) {}
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur suppression :', err);
    res.status(500).json({ erreur: 'Erreur serveur' });
  }
});

// --- Route santé (utile pour Railway) ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DEMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Site en ligne sur le port ${PORT}`);
});