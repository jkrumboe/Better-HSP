# HSP-Bot – Online-Deployment (Docker + Nginx Proxy Manager)

Die App läuft jetzt **Single-Origin**: der Express-Server liefert Frontend, API und WebSocket
über **einen** Port aus. Kein separater Vite-Server mehr in Produktion.

## 1. Login & Sicherheit – Überblick

- **App-Login**: Jede:r legt sich mit **E-Mail + Passwort** einen Account an (offene Registrierung).
  Passwörter werden als **scrypt-Hash** gespeichert – niemals im Klartext, nicht umkehrbar.
- **HSP-Verbindung**: Nach dem Login verbindet man seinen HSP-Account per **Uni-SSO**
  (Shibboleth) oder – als Fallback – per eingefügten `delcom_auth`-Daten.
- **HSP-Tokens** (access/refresh/id) liegen **verschlüsselt** (AES-256-GCM) in `data/`.
  Der **Refresh-Token** erneuert den Access-Token automatisch, damit die App dauerhaft läuft.
- **Sessions**: HMAC-signiertes, httpOnly-Cookie (`Secure` + `SameSite=Lax` hinter HTTPS).
- Der **erste** registrierte Account wird automatisch `admin`.

Secrets (`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`) werden beim ersten Start einmalig erzeugt
und in `data/.secrets.json` abgelegt (im Volume persistent). Optional per `.env` fest vorgeben.

## 2. Schnellstart

### Portainer (Git-Stack, empfohlen)

1. **Stacks → Add stack → Repository**
   - Repository URL: `https://github.com/jkrumboe/HSP-Bot`
   - Reference: `refs/heads/main` (bzw. der gewünschte Branch)
   - Compose path: `docker-compose.yml`
2. **Environment variables**: mindestens `PUBLIC_URL` setzen (siehe Tabelle unten).
3. **Deploy the stack**. Updates: Stack öffnen → **Pull and redeploy** – das Image wird dank
   `pull_policy: build` jedes Mal aus dem aktuellen Repo-Stand neu gebaut.
   Optional „GitOps updates“ aktivieren, dann deployt Portainer nach jedem Push automatisch.

### Docker Compose (CLI)

```bash
cp .env.example .env     # PUBLIC_URL eintragen (siehe unten)
docker compose up -d --build
docker compose logs -f
```

Die App läuft auf Port **3003** – im Container und auf dem Host (`ports: "3003:3003"`).
Der Port kollidiert mit keinem anderen Container auf dem Server. Darauf zeigt der Nginx Proxy Manager.

## 3. Nginx Proxy Manager einrichten

1. **Proxy Host** anlegen → Domain z.B. `betterhsp.deine-domain.de`.
2. **Forward Hostname/IP**: IP/Hostname des Docker-Hosts, **Port** `3003`.
3. **Websockets Support**: **einschalten** (wichtig für Live-Updates `/ws`).
4. **SSL**: Let's-Encrypt-Zertifikat anfordern, „Force SSL“ aktivieren.
5. In `.env` die **PUBLIC_URL** exakt auf diese HTTPS-Adresse setzen:
   ```
   PUBLIC_URL=https://betterhsp.deine-domain.de
   COOKIE_SECURE=true
   ```
   `PUBLIC_URL` wird für den **SSO-Rücksprung** gebraucht (Callback-URL).

## 4. Umgebungsvariablen (`.env` / `docker-compose.yml`)

| Variable | Zweck |
|---|---|
| `PUBLIC_URL` | Öffentliche HTTPS-URL, für den SSO-Callback. Ohne Slash am Ende. |
| `COOKIE_SECURE` | `true` hinter HTTPS-Proxy (Standard in Produktion). |
| `PORT` | Server-Port (Standard 3003). |
| `TZ` | Zeitzone für geplante Buchungen (Standard `Europe/Berlin`). |
| `SESSION_SECRET` | Optional. Sonst Auto-Generierung. `openssl rand -hex 48` |
| `TOKEN_ENCRYPTION_KEY` | Optional. 64 Hex-Zeichen. `openssl rand -hex 32` |

> ⚠️ Wird `TOKEN_ENCRYPTION_KEY` **nachträglich geändert**, sind bereits verschlüsselte
> HSP-Tokens nicht mehr lesbar – die Nutzer müssen sich dann einfach neu via SSO verbinden.

## 5. Volume

Das benannte Volume **`hsp-bot-data`** (→ `/app/data`) übersteht Redeploys und enthält:

| Datei | Inhalt |
|---|---|
| `.secrets.json` | Session-/Verschlüsselungs-Secrets (nur lokal, `chmod 600`) |
| `accounts.json` | App-Accounts (E-Mail + **scrypt-Hash**) |
| `users.json` | HSP-Mitglieder inkl. **verschlüsselter** Tokens, Kalender-Token |
| `scheduled-jobs.json`, `polling-jobs.json` | geplante/laufende Buchungen |

## 6. Erster Login

1. App über die Domain öffnen → **Registrieren** (E-Mail + Passwort ≥ 8 Zeichen).
2. Oben rechts aufs 👤-Symbol → **HSP-Account verbinden** → Uni-/FH-SSO wählen.
3. Beim Uni-IdP anmelden → zurück in der App ist der HSP-Account verknüpft.
   - Klappt der SSO-Redirect nicht (delcom akzeptiert fremde Callback-URLs evtl. nicht),
     den **manuellen Token-Import** im selben Fenster nutzen
     (`localStorage.getItem("delcom_auth")` auf der HSP-Seite kopieren).

## 7. Container-Verwaltung

```bash
docker compose up -d --build   # nach Code-Änderungen neu bauen
docker compose logs -f
docker compose restart
docker compose down
```

## 8. Troubleshooting

- **Live-Updates fehlen / WebSocket bricht ab** → im Nginx Proxy Manager „Websockets Support“ aktivieren.
- **Nach Login sofort wieder ausgeloggt** → `COOKIE_SECURE=true`, aber Zugriff über `http://`?
  Immer über HTTPS (die Proxy-Domain) zugreifen, nicht direkt über die IP:Port.
- **SSO endet auf einer delcom-Fehlerseite** → `PUBLIC_URL` prüfen; sonst manuellen Import nutzen.
- **Logs**: `docker compose logs hsp-bot`

## Admin-Bereich (nur Heimnetz + Tailscale)

Der Admin-Bereich (Nutzer, HSP-Token-Status, Jobs, Padel, Live-Logs) läuft auf einem
**eigenen Port 3004** und ist bewusst **nicht** über den Nginx Proxy Manager / die Domain erreichbar.

**Nichts einzurichten:** Der Container läuft mit `network_mode: host`, erkennt dadurch die
Adressen des Servers (Heimnetz + Tailscale) selbst und lässt alle Geräte aus dem Heimnetz und
dem Tailnet durch. Alle anderen IPs bekommen 403.

So kommst du hin und zurück:
- **App → Admin:** in der App auf „Account“ – Admins sehen dort die Buttons „Tailscale“
  (funktioniert zuhause und unterwegs) und „Heimnetz“.
- **Admin → App:** Button „← App“ oben im Admin-Bereich.

Schutz: (1) eigener Port, nicht über die Domain und nicht am Router freigegeben,
(2) automatische IP-Allowlist auf die echte TCP-Quelladresse (`X-Forwarded-For` wird ignoriert;
Docker-Bridge-Netze sind ausgeschlossen), (3) Login mit einem App-Account mit Rolle `admin`.

Hinweise:
- Port 3004 **nicht** im Router freigeben und **nicht** im Nginx Proxy Manager eintragen.
- `network_mode: host` gibt es nur unter Linux. Ohne Host-Netzwerk funktioniert der Zugriff
  aus dem Heimnetz (10.x / 192.168.x) und Tailscale trotzdem, nur die Links in der App erscheinen
  erst, nachdem du dich einmal direkt unter `http://<Server-IP>:3004/admin` angemeldet hast.
- Optional `ADMIN_ALLOWED_IPS` (kommagetrennt, CIDR erlaubt) ersetzt die automatische Erkennung.
- `ADMIN_ENABLED=false` schaltet den Admin-Bereich komplett ab.
