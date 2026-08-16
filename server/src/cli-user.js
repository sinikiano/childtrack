// Tiny CLI to add a parent user:  node src/cli-user.js <username> <password>
import 'dotenv/config';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';

const [,, username, password, role = 'parent'] = process.argv;
if (!username || !password) {
  console.error('Usage: node src/cli-user.js <username> <password> [role]');
  process.exit(2);
}
const db = openDb(process.env.DB_PATH || './data/childtrack.db');
const { hash, salt } = hashPassword(password);
try {
  db.prepare(
    'INSERT INTO users (username, pass_hash, pass_salt, role, created) VALUES (?, ?, ?, ?, ?)'
  ).run(username, hash, salt, role, Date.now());
  console.log(`Created user ${username} (${role}).`);
} catch (e) {
  if (String(e.message).includes('UNIQUE')) {
    db.prepare('UPDATE users SET pass_hash=?, pass_salt=?, role=? WHERE username=?')
      .run(hash, salt, role, username);
    console.log(`Updated user ${username} (${role}).`);
  } else throw e;
}
