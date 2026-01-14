# 🚀 Better-HSP - Kursanmeldungs-Automation & Rate-Limit Testing

Ein automatisiertes System zur Anmeldung in Hochschulsport-Kursen mit Token-Management und Rate-Limit-Testing.

## ✨ Features

- ✅ **Automatische Authentifizierung** - Tokens werden verwaltet und automatisch erneuert
- ✅ **Polling-System** - Regelmäßige Anmeldungsversuche mit konfigurierbarem Intervall
- ✅ **Batch-Verarbeitung** - Mehrere Kurse gleichzeitig anmelden

## 📦 Installation

```bash
# Repository klonen (falls noch nicht geschehen)
git clone https://github.com/jkrumboe/Better-HSP.git
cd Better-HSP

# Abhängigkeiten installieren
npm install
```

## 🔑 Token einmalig importieren

```bash
# 1. Öffne die HSP-Website im Browser
# 2. Öffne Developer Tools (F12) → Console
# 3. Führe aus: localStorage.getItem("delcom_auth")
# 4. Kopiere die komplette Ausgabe
# 5. Speichere als "auth-data.json" im HSP-Bot Ordner

# Dann importieren:
node import-token.js
```

Danach wird der Token automatisch in `token-store.json` gespeichert.

## 🎯 Schnelle Start-Befehle

### Einzelne Anmeldung
```bash
node register-course-auto.js 946 36432
```

### Polling mit 60 Sekunden Intervall
```bash
node register-course-auto.js 946 36432 60
```

### Polling mit Limit (30s, max. 20 Versuche)
```bash
node register-course-auto.js 946 36432 30 20
```

## 📊 Verwendete Skripte

| Skript | Beschreibung | Verwendung |
|--------|---|---|
| `register-course-auto.js` | Produktive Anmeldung + Polling | `node register-course-auto.js [options]` |
| `token-manager.js` | Token-Verwaltung & Renewal | Import nur, nicht direkt aufrufen |
| `import-token.js` | Browser-Token Importer | `node import-token.js` |

## 🔐 Sicherheit

- **Token-Dateien werden NICHT committed** (in `.gitignore`)
- Token-Refresh erfolgt automatisch basierend auf Gültigkeit
- Refresh-Token wird sicher lokal gespeichert
- Keine Passwörter im Code

## 📝 Konfiguration

### Benutzer-Daten ändern

In `register-course-auto.js` oder direkt per Kommandozeilen-Argument:

```bash
# Beliebige Member ID und Booking ID
node register-course-auto.js 999 12345 60
```

### API Endpoints

Hauptendpoint ist:
```
https://backbone-web-api.production.munster.delcom.nl/participations
```

Token-Refresh:
```
https://backbone-web-api.production.munster.delcom.nl/auth/refresh
```

## 🐛 Troubleshooting

### "Konnte keinen gültigen Token besorgen"
- Token ist abgelaufen
- Refresh-Token ist ungültig
- **Lösung**: `node import-token.js` erneut durchführen

### "File not found: token-store.json"
- Du hast noch keinen Token importiert
- **Lösung**: `node import-token.js` ausführen

### Polling stoppt nicht
- Drücke Ctrl+C um zu beenden
- Oder setze maxAttempts-Limit
- Mit `> output.log` kannst du Logs speichern

## 👤 Autor

Justin Krumböhmer, Robin Gummels und Humam Hikmat

---

**Hinweis**: Verwende dieses Tool verantwortungsvoll. Respektiere die Server und deren Rate-Limits! 🙏
