# 🎾 Padel – gemeinsam buchen

Im Tab **Padel** können Freunde Sessions für den Padel-Platz (Horstmarer Landweg) anlegen und beitreten.
Sobald **mindestens 2 Spieler** dabei sind, bucht der Bot den Platz automatisch und lädt die anderen per E-Mail in der HSP-Buchung ein.

## Ablauf

1. **Anmelden** – jeder Spieler fügt einmal seine eigenen `delcom_auth`-Daten ein (wie im Auth-Tab). Das ist gleichzeitig der Login.
2. **Session anlegen** – Datum wählen, freien Slot antippen. Belegte Slots (von anderen in HSP gebucht) sind durchgestrichen.
3. **Beitreten** – die anderen tippen auf „Beitreten“ (max. 4 Spieler).
4. **Automatische Buchung** – ab 2 Spielern plant der Bot die Buchung:
   - Slots werden **7 Tage vorher um 14:00 Uhr** freigeschaltet. Der Bot startet 2 s vorher, versucht es bis 3 s danach alle 500 ms, dann jede Sekunde bis max. 15 s danach.
   - Ist das Fenster schon offen, bucht er sofort.
   - Vorher prüft er, ob der Slot schon belegt ist – dann gibt es keinen einzigen Buchungsversuch.
   - Eindeutige Absagen von HSP beenden die Versuche: „blocked by a booking“ (Slot belegt/gesperrt) stoppt sofort, „max bookings per day/period“ oder ein ungültiger Token nimmt nur diesen Booker raus. Andere Absagen werden pro Booker max. 3× wiederholt.
   - Wer nach der Buchung beitritt, wird mit seinem eigenen Account zur bestehenden HSP-Buchung hinzugefügt.

Die Regeln werden beim Serverstart aus HSP gelesen:
- Freischaltung (7 Tage vorher, 14:00) aus der Platzmiete `129`
- Öffnungszeiten (`weekCalendar`, z. B. Mo–Fr 8–19 Uhr, Sa/So 10–17 Uhr) aus dem Platz `108`
- Belegt ist ein Slot, wenn auf dem Platz `108` irgendetwas liegt – auch Kurse und Sonderbelegungen (Produkt `524`), nicht nur Mietbuchungen. Achtung: Sonderbelegungen haben `status: 2` – das heißt **nicht** „storniert“, HSP blockiert den Slot damit.

## Wer bucht? („bester Booker“)

HSP erlaubt pro Person **1 Buchung pro Tag** und **3 in 7 Tagen** (so zeigt es der HSP-Buchungsdialog; Werte der Platzmiete `129`). Der Bot sortiert die Teilnehmer so:

1. Gültiger HSP-Token (abgelaufene Tokens ohne Refresh werden übersprungen)
2. Mitgliedschaft, die Padel-Buchungen erlaubt (HSP verlangt eine verknüpfte Mitgliedschaft, z. B. „Rückschlagspiele Club“ oder „Sportpass Unlimited“; die Liste wird beim Start aus HSP gelesen). Geprüft über `/subscribers/my-memberships`, 15 min gecacht.
   Außerdem gilt pro Mitgliedschaft **nur eine offene Buchung gleichzeitig** (`maxSimultaneousPerPerson: 1`): wer schon einen kommenden Padel-Termin selbst gebucht hat, kann erst nach diesem Termin wieder buchen. HSP antwortet sonst mit „you need to have one of the required subscriptions“. Solche Spieler gelten als `schon eine offene Buchung` und werden erst zuletzt versucht.
3. Freies Kontingent laut eigenen Padel-Buchungen in HSP – geprüft als rollierendes 7-Tage-Fenster, d. h. auch Buchungen *nach* dem Termin zählen
4. Wer in den letzten 30 Tagen am wenigsten über den Bot gebucht hat
5. Wer am längsten nicht gebucht hat, dann wer zuerst beigetreten ist

Spieler ohne Mitgliedschaft oder über dem Limit werden nicht übersprungen, sondern erst versucht, wenn alle anderen abgelehnt wurden (die Prüfung ist nur eine Schätzung). Ist etwas nicht prüfbar, zählt der Spieler als „unklar“ und wird nach den sicheren Kandidaten versucht.

### Kann überhaupt jemand buchen?

Der Bot prüft das nicht erst beim Buchen, sondern schon beim Anlegen, Beitreten und Austreten, beim Serverstart, nach jedem Token-Import und alle 30 min:

- Spieler, die nicht buchen können, bekommen ein gelbes **!** am Namen (Grund im Tooltip).
- Kann **niemand** in der Session buchen, erscheint auf der Karte „Niemand kann buchen“ mit Kurzgrund pro Spieler (`Token abgelaufen`, `keine Mitgliedschaft`, `Limit erreicht`, `schon eine offene Buchung`). Typischer Fall: jemand ohne Mitgliedschaft ist allein in der Session und braucht einen Mitspieler, der für beide bucht.

### Automatisch neu versuchen

Fehlgeschlagene Sessions prüft der Bot **stündlich** und zusätzlich, wenn jemand den Padel-Tab öffnet (höchstens alle 5 min). Ist der Slot frei und kann laut Prüfung jemand buchen, startet er die Buchung selbst neu:

- War der Slot beim Fehlschlag belegt und ist jetzt frei (z. B. storniert), geht es sofort los.
- War er schon frei (z. B. Limit erreicht), frühestens 1 h nach dem letzten Versuch.
- Max. 5 automatische Versuche pro Session (ein manuelles „Erneut versuchen“ setzt den Zähler zurück), nicht in den letzten 15 min vor dem Termin.

Pro Prüfung kostet das nur eine öffentliche Abfrage je Session; Token/Kontingent werden erst geprüft, wenn der Slot frei ist.

HSP vergleicht Datumsfilter in deutscher Ortszeit (ein `…Z`-Wert wird um den Berlin-Offset verschoben). Der Bot fragt deshalb einen großzügigen Bereich ab und prüft die Überschneidung selbst.

Schlägt eine Buchung fehl, zeigt die Karte nur den Kurzgrund (z. B. „Niemand konnte buchen (Limit erreicht)“, „Platz war schon vergeben“, „HSP hat die Buchung abgelehnt“). Versuche und die genaue HSP-Antwort stehen im Verlauf. Fehlgeschlagene Sessions können per „Erneut versuchen“ neu gestartet werden.

## Kalender

- **Kalender abonnieren** (webcal) – einmal auf dem Handy hinzufügen. Alle eigenen Sessions erscheinen automatisch: geplant = vorläufig, gebucht = bestätigt (mit Erinnerung 1 h vorher), abgesagt = storniert.
- **Android / Google Kalender**: „Link kopieren“ → calendar.google.com → *Weitere Kalender* → *Per URL*.
- **📅 Zum Kalender** an jeder Session lädt eine einzelne `.ics`-Datei.

Der Kalender-Link enthält einen geheimen Token – nicht weitergeben. Damit Handys den Feed abrufen können, muss der Server von außen erreichbar sein.

## Daten

| Datei | Inhalt |
|---|---|
| `data/users.json` | Spieler inkl. HSP-Tokens, Login-Key und Kalender-Token |
| `data/padel-sessions.json` | Sessions, Teilnehmer, Verlauf |

Beide liegen im (git-ignorierten) `data/`-Ordner, der im Docker-Setup als Volume gemountet ist.

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/api/padel/login` | `delcom_auth`-JSON → `userKey` |
| `GET` | `/api/padel/me` | Eigenes Profil, Kalender-Token, Regeln |
| `GET` | `/api/padel/slots?date=YYYY-MM-DD` | Slots eines Tages (frei/belegt/Session) |
| `GET` | `/api/padel/sessions` | Alle aktuellen Sessions |
| `POST` | `/api/padel/sessions` | Session anlegen `{ startDate }` |
| `POST` | `/api/padel/sessions/:id/join` · `/leave` · `/retry` | Beitreten / Absagen / Neu versuchen |
| `DELETE` | `/api/padel/sessions/:id` | Session absagen (nur Ersteller, vor der Buchung) |
| `GET` | `/api/padel/calendar/:calendarToken.ics` | Kalender-Abo |
| `GET` | `/api/padel/calendar/:calendarToken/:sessionId.ics` | Einzelner Termin |

Alle Endpunkte außer Login und Kalender erwarten den Header `x-user-key`.
