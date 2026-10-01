const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const FormData = require('form-data');

sharp.cache(false);

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante.');
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
  console.warn('⚠️ DISCORD_WEBHOOK_URL manquante — les photos ne seront pas envoyées à Discord.');
}

console.log('🔧 Serveur de vérification initialisé');
console.log(`📁 Dossier uploads : ${UPLOAD_DIR}`);
console.log(`🔗 Webhook Discord : ${DISCORD_WEBHOOK_URL ? 'configuré' : 'non configuré'}`);

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

// ========== ENVOI WEBHOOK DISCORD ==========
async function envoyerDansModeration(code, imagePath, discordId, pseudo) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ Pas de webhook configuré, photo non envoyée à Discord.');
    return false;
  }

  try {
    const form = new FormData();

    const embed = {
      title: '🔍 Vérification à examiner',
      color: 0xFEE75C,
      fields: [
        { name: 'Utilisateur', value: pseudo ? `${pseudo} (\`${discordId}\`)` : `\`${discordId}\``, inline: false },
        { name: 'ID Discord', value: `\`${discordId}\``, inline: true },
        { name: 'Code', value: `\`${code}\``, inline: true },
      ],
      image: { url: `attachment://carnet-${code}.jpg` },
      footer: { text: 'Réponds avec ✅ pour approuver ou ❌ pour refuser' },
      timestamp: new Date().toISOString(),
    };

    const payload = {
      content: `📬 **Nouvelle vérification** — réponds avec ✅ ou ❌`,
      embeds: [embed],
    };

    form.append('payload_json', JSON.stringify(payload));
    form.append('file', fs.createReadStream(imagePath), {
      filename: `carnet-${code}.jpg`,
    });

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status} — ${errText.slice(0, 200)}`);
    }

    console.log(`✅ Photo envoyée dans #moderation pour ${code}`);
    return true;
  } catch (err) {
    console.error('❌ Erreur webhook Discord :', err.message);
    return false;
  }
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
      return res.status(400).json({ erreur: 'Code invalide ou déjà utilisé.' });
    }

    res.json({ succes: true });
  } catch (err) {
    console.error('Erreur SQL verifier-code :', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// --- Route 2 : upload photo + envoi immédiat dans #moderation ---
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

    // Optimisation de l'image
    const baseName = path.parse(req.file.filename).name;
    const imageOptimisee = path.join(UPLOAD_DIR, `opt-${baseName}.jpg`);

    await sharp(req.file.path)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(imageOptimisee);

    // Supprime l'original
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    // Récupère le pseudo Discord de l'utilisateur
    const pseudo = rows[0].discord_id ? `<@${rows[0].discord_id}>` : 'Inconnu';

    // Marque comme "en modération"
    await pool.query(
      'UPDATE verifications SET photo_path = $1, a_moderer = 1, lycee = $2 WHERE code = $3',
      [imageOptimisee, 'En attente', code.toUpperCase().trim()]
    );

    console.log(`📸 Photo reçue pour ${code} — envoi à Discord...`);

    // Envoie immédiatement dans #moderation via webhook
    const envoye = await envoyerDansModeration(
      code.toUpperCase().trim(),
      imageOptimisee,
      rows[0].discord_id,
      pseudo
    );

    if (envoye) {
      return res.json({
        succes: true,
        moderation: true,
        message: '✅ Photo envoyée ! Un modérateur va vérifier ton carnet très bientôt.',
      });
    } else {
      return res.json({
        succes: true,
        moderation: true,
        message: '⚠️ Photo reçue mais erreur d\'envoi. Contacte un modérateur.',
      });
    }
  } catch (err) {
    console.error('❌ Erreur upload :', err);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ erreur: 'Erreur lors du traitement de la photo.' });
  }
});

// --- Route 3 : supprimer une photo (appelée par le bot après refus) ---
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

// --- Route santé ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== DEMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Site en ligne sur le port ${PORT}`);
});