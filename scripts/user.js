'use strict';
/* Gestion des comptes : node scripts/user.js add|list|passwd|role|disable|enable ... */
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const env = process.env;
const [, , cmd, ...a] = process.argv;
const ROLES = ['admin', 'editor', 'viewer'];
const usage = () => {
  console.log(`Usage :
  user.js list
  user.js add <email> "<Nom complet>" <admin|editor|viewer> [mot_de_passe]
  user.js passwd <email> [nouveau_mot_de_passe]
  user.js role <email> <admin|editor|viewer>
  user.js disable <email>      user.js enable <email>
Sans mot de passe fourni, un mot de passe aléatoire est généré et affiché une seule fois.`);
  process.exit(1);
};
const gen = () => crypto.randomBytes(12).toString('base64url');
(async () => {
  if (!cmd) usage();
  const db = await mysql.createConnection({ host: env.DB_HOST || '127.0.0.1', port: +env.DB_PORT || 3306, user: env.DB_USER || 'pmo', password: env.DB_PASSWORD || '', database: env.DB_NAME || 'pmo', charset: 'utf8mb4' });
  try {
    const email = (a[0] || '').trim().toLowerCase();
    if (cmd === 'list') {
      const [rows] = await db.query('SELECT email,name,role,active,last_login FROM users ORDER BY email'); console.table(rows);
    } else if (cmd === 'add') {
      const [name, role, pw] = [a[1], a[2], a[3]];
      if (!email || !name || !ROLES.includes(role)) usage();
      const p = pw || gen(); if (p.length < 10) { console.error('Mot de passe trop court (10 caractères minimum).'); process.exit(1); }
      await db.query('INSERT INTO users (id,email,name,role,pass_hash) VALUES (?,?,?,?,?)', [crypto.randomBytes(8).toString('hex'), email, name, role, await bcrypt.hash(p, 11)]);
      console.log(`Compte créé : ${email} (${role})` + (pw ? '' : `\nMot de passe : ${p}`));
    } else if (cmd === 'passwd') {
      if (!email) usage(); const p = a[1] || gen(); if (p.length < 10) { console.error('Mot de passe trop court (10 caractères minimum).'); process.exit(1); }
      const [r] = await db.query('UPDATE users SET pass_hash=? WHERE email=?', [await bcrypt.hash(p, 11), email]);
      console.log(r.affectedRows ? 'Mot de passe modifié (les sessions ouvertes sont fermées).' + (a[1] ? '' : `\nNouveau mot de passe : ${p}`) : 'Utilisateur introuvable.');
    } else if (cmd === 'role') {
      if (!email || !ROLES.includes(a[1])) usage(); const [r] = await db.query('UPDATE users SET role=? WHERE email=?', [a[1], email]); console.log(r.affectedRows ? 'Rôle modifié.' : 'Utilisateur introuvable.');
    } else if (cmd === 'disable' || cmd === 'enable') {
      if (!email) usage(); const [r] = await db.query('UPDATE users SET active=? WHERE email=?', [cmd === 'enable' ? 1 : 0, email]); console.log(r.affectedRows ? 'Compte mis à jour.' : 'Utilisateur introuvable.');
    } else usage();
  } catch (e) { console.error('Erreur :', e.code === 'ER_DUP_ENTRY' ? 'cette adresse existe déjà.' : e.message); process.exit(1); }
  finally { await db.end(); }
})();
