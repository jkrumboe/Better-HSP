# 🚀 HSP-Bot - Kursanmeldungs-Automation & Rate-Limit Testing

Ein automatisiertes System zur Anmeldung in Hochschulsport-Kursen mit Token-Management und Rate-Limit-Testing.

## ✨ Features

- ✅ **Automatische Authentifizierung** - Tokens werden verwaltet und automatisch erneuert
- ✅ **Polling-System** - Regelmäßige Anmeldungsversuche mit konfigurierbarem Intervall
- ✅ **Batch-Verarbeitung** - Mehrere Kurse gleichzeitig anmelden
- ✅ **Web-GUI** - Interaktive Oberfläche mit Live-Feedback

## 📦 Installation

```bash
# Repository klonen (falls noch nicht geschehen)
git clone https://github.com/RobinGummels/HSP-Bot.git
cd HSP-Bot

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

## 🖥️ Web-GUI (Empfohlen)

Die einfachste Art, den HSP-Bot zu nutzen:

```bash
# Server starten
npm run server
# oder
node server.js
```

Dann öffne **http://localhost:3003** im Browser.

### GUI-Features

| Feature | Beschreibung |
|---------|--------------|
| 🔍 **Kurssuche** | Filtere nach Level, Zeitraum und freien Plätzen |
| 🎯 **Schnellanmeldung** | Ein Klick auf "Anmelden" für sofortige Buchung |
| ⏰ **Geplante Buchung** | Bucht automatisch zur Öffnung des Buchungsfensters (siehe unten) |
| 👀 **Platz-Überwachung** | Meldet an, sobald in einem vollen Kurs ein Platz frei wird |
| 🔑 **Auth-Import** | Token direkt im Browser einfügen |
| 📊 **Live-Feedback** | WebSocket-basierte Echtzeit-Updates |

### ⏰ Geplante Buchung („Planen“)

Für Kurse, deren Buchung noch nicht geöffnet ist. Der Zeitpunkt der Öffnung kommt pro Sportart
aus der HSP-API (`bookableAvailableMinutesAhead`, z.B. 6, 7, 14 oder 28 Tage vor Kursbeginn).

Ablauf eines Plans:

1. **Vorab-Prüfung (10 Min. vor Öffnung):** Der HSP-Token wird erneuert, damit er im Buchungsfenster
   sicher gilt. Klappt das nicht, erscheint am Plan die Warnung „HSP-Login abgelaufen – bitte neu
   anmelden“. Dann muss sich der Nutzer vor der Öffnung einmal neu anmelden.
2. **Start (15 s vor Öffnung):** Token wird bei Bedarf noch einmal erneuert, der echte Anmeldestatus
   geprüft (schon angemeldet → fertig) und die eigene Uhr mit der HSP-Serveruhr abgeglichen.
3. **Buchungsfenster (bis 10 s nach Öffnung):** Anmeldeversuche dicht um die Öffnung
   (−0,1 s bis +2 s, 8 Versuche), danach 1 Versuch pro Sekunde.
   - Angemeldet → Plan erledigt.
   - Auf Warteliste gelandet → Übergabe an die Platz-Überwachung.
   - Abgelehnt → einmalige Prüfung, ob die Person schon angemeldet ist.
   - Rate-Limit (429) → 2 s Pause.
4. **Kein Platz nach 10 s:** Der Plan gibt nicht auf, sondern übergibt an die
   **Platz-Überwachung** (Status `watching`), die bis Kursbeginn weiterläuft.

**Last auf dem HSP-Server:** höchstens ~26 Anfragen pro Plan (8 GETs für Öffnungszeit und
Uhrenabgleich, bis zu 3 Status-GETs, ~15 POSTs). In der Regel endet ein Plan schon nach 1–3 POSTs.
Ein Plan kann bis 10 s nach Öffnung angelegt werden, danach direkt über die Kurskarte buchen.

### 👀 Platz-Überwachung

Ein einziger Watcher prüft die freien Plätze **aller** überwachten Kurse mit einer gemeinsamen,
öffentlichen Abfrage (alle 1–2 s). Ein Anmeldeversuch (POST) wird nur gesendet, wenn wirklich ein
Platz frei ist; nach einem abgelehnten Versuch gilt eine Pause von 5 s, bei Rate-Limit 15 s.
Ist die Person inzwischen angemeldet (z.B. von der Warteliste nachgerückt), endet die Überwachung
automatisch. Sie endet spätestens mit Kursbeginn.

> **Keine Garantie:** Ist ein Kurs bei Öffnung sofort voll und wird bis Kursbeginn kein Platz frei,
> kann auch der Bot keinen Platz bekommen.

### Auth-Daten über GUI importieren

1. Öffne http://localhost:3003
2. Klicke auf den Tab **"🔑 Auth-Daten"**
3. Folge der Anleitung zum Kopieren der Daten aus dem Browser
4. Füge die Daten ein und klicke "Importieren"

## 🎯 Schnelle Start-Befehle (Terminal)

### 1️⃣ Kurse suchen

```bash
# Alle Volleyball-Kurse der nächsten 8 Tage
node searchCourses.js

# Nur Level 3 Kurse
node searchCourses.js --level 3

# Kurse mit mindestens 5 freien Plätzen
node searchCourses.js --min-available 5

# Level 2 in den nächsten 14 Tagen mit mindestens 3 freien Plätzen
node searchCourses.js --level 2 --days 14 --min-available 3

# Hilfe anzeigen
node searchCourses.js --help
```

### 2️⃣ Einzelne Anmeldung (memberId wird automatisch aus Token/`auth-data.json` geladen)
```bash
node register-course-auto.js 36432
```

### 3️⃣ Polling mit 60 Sekunden Intervall
```bash
node register-course-auto.js 36432 60
```

### 4️⃣ Polling mit Limit (30s, max. 20 Versuche)
```bash
node register-course-auto.js 36432 30 20
```

## 📊 Verwendete Skripte

| Skript | Beschreibung | Verwendung |
|--------|---|---|
| `server.js` | Web-GUI Server | `npm run server` oder `node server.js` |
| `searchCourses.js` | Kurssuche mit Filtern | `node searchCourses.js [--level LEVEL] [--min-available COUNT] [--days DAYS]` |
| `register-course-auto.js` | Produktive Anmeldung + Polling | `node register-course-auto.js [memberId] <bookingId> [intervalSeconds] [maxAttempts]` |
| `token-manager.js` | Token-Verwaltung & Renewal | Import nur, nicht direkt aufrufen |
| `import-token.js` | Browser-Token Importer | `node import-token.js` |

## 🔐 Sicherheit

- **Token-Dateien werden NICHT committed** (in `.gitignore`)
- Token-Refresh erfolgt automatisch basierend auf Gültigkeit
- Refresh-Token wird sicher lokal gespeichert
- Keine Passwörter im Code

## 📝 Konfiguration

### Kurssuche mit `searchCourses.js`

Die Kurssuche ist das erste Werkzeug, um passende Kurse zu finden:

**Filter-Optionen:**
- `--level LEVEL` - Nach Niveau filtern (z.B. 1, 2, 3)
- `--min-available COUNT` - Nur Kurse mit mindestens COUNT freien Plätzen
- `--days DAYS` - Zeitraum in Tagen (Standard: 8)

**Beispiel-Workflow:**
```bash
# 1. Alle verfügbaren Kurse anschauen
node searchCourses.js

# 2. Nur Level 3 Kurse mit freien Plätzen
node searchCourses.js --level 3 --min-available 1

# 3. BookingId aus der Ausgabe kopieren und Anmeldung starten
node register-course-auto.js 36432 60
```

### Member ID/Booking ID setzen

- Standard: `memberId` wird automatisch aus `token-store.json` bzw. `auth-data.json` verwendet.
- Optional kannst du eine andere `memberId` als erstes Argument angeben.

```bash
# Booking ID 12345 mit gespeicherter memberId
node register-course-auto.js 12345

# Booking ID 12345 mit expliziter memberId 999
node register-course-auto.js 999 12345 60
```

### API Endpoints

Hauptendpoint ist:
```
https://backbone-web-api.production.munster.delcom.nl/participations
```

Token-Refresh (Body `{"refresh_token": "..."}`, Antwort mit `access_token`/`refresh_token`;
das alte `/auth/refresh` liefert inzwischen 404):
```
https://backbone-web-api.production.munster.delcom.nl/auth/token-refresh
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

Justin Krumböhmer und Robin Gummels

---

**Hinweis**: Verwende dieses Tool verantwortungsvoll. Respektiere die Server und deren Rate-Limits! 🙏
