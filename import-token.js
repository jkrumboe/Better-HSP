// import-token.js
// Hilfs-Skript um Token aus dem Browser-LocalStorage zu importieren

import { importFromLocalStorage } from './token-manager.js';

console.log('📥 Token-Import Anleitung:');
console.log('==========================\n');
console.log('1. Öffne die Website im Browser');
console.log('2. Öffne Developer Tools (F12)');
console.log('3. Gehe zu Console Tab');
console.log('4. Führe aus: localStorage.getItem("delcom_auth")');
console.log('5. Kopiere den kompletten Output (großer JSON)');
console.log('6. Speichere ihn in eine Datei "auth-data.json"');
console.log('7. Führe dann aus: node import-token.js\n');

// Versuche, token-store.json zu laden, um zu sehen ob schon Token da sind
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenStoreFile = path.join(__dirname, 'data', 'token-store.json');
const authDataFile = path.join(__dirname, 'auth-data.json');
const authDataFileData = path.join(__dirname, 'data', 'auth-data.json');

if (fs.existsSync(tokenStoreFile)) {
  console.log('✅ Token-Store existiert bereits!\n');
  const tokens = JSON.parse(fs.readFileSync(tokenStoreFile, 'utf-8'));
  console.log('Gespeicherte Tokens:');
  console.log(JSON.stringify(tokens, null, 2));
} else if (fs.existsSync(authDataFile) || fs.existsSync(authDataFileData)) {
  const fileToRead = fs.existsSync(authDataFile) ? authDataFile : authDataFileData;
  console.log(`📁 Importiere aus ${path.basename(fileToRead)}...\n`);
  const authData = JSON.parse(fs.readFileSync(fileToRead, 'utf-8'));
  importFromLocalStorage(authData);
} else {
  console.log('⚠️  Weder token-store.json noch auth-data.json vorhanden.');
  console.log('   Speichere zuerst dein Auth-Daten aus dem Browser-LocalStorage!');
}
