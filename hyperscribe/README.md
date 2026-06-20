# HyperScribe

Eine schlichte Desktop-App für macOS und Windows, die Audiodateien transkribiert — inklusive Sprechererkennung (Diarization). Die eigentliche Spracherkennung läuft komplett über die [Deepgram API](https://developers.deepgram.com/); die App selbst ist nur die Bedienoberfläche drumherum.

## Was die App macht

1. Audiodatei auswählen (Klick oder Drag & Drop)
2. Sprache wählen: automatische Erkennung, Deutsch oder Englisch
3. Transkription starten
4. Ergebnis als `.txt`-Datei herunterladen, mit Sprecherlabels (`[Sprecher 1]`, `[Sprecher 2]`, ...)

Daneben zeigt die App fortlaufend das verbleibende Deepgram-Guthaben und den Verbrauch seit App-Start an.

## Tech-Stack

- **[Tauri 2](https://tauri.app/)** — natives Desktop-Shell (Rust-Backend + Systemwebview), erzeugt kleine, native Binaries für Mac und Windows
- **Deno** als Paketmanager/Runtime für das Frontend-Tooling (statt npm/Node)
- **Vite + vanilla TypeScript** — kein UI-Framework, bewusst schlank gehalten
- **[Lucide](https://lucide.dev/)** für Icons
- **Rust** (`src-tauri/`) für alles, was Netzwerk- oder Dateisystemzugriff braucht: Deepgram-Aufrufe, Datei lesen/schreiben, Einstellungen speichern

Die Aufteilung folgt Tauris Standardmuster: das TypeScript-Frontend (`src/`) ist nur für Darstellung und Nutzerinteraktion zuständig und kommuniziert über `invoke()` mit Rust-„Commands" im Backend (`src-tauri/src/lib.rs`). Alles, was einen API-Key braucht (Deepgram-Aufrufe), läuft im Rust-Backend — der Key verlässt nie das Backend in Richtung Webview-JavaScript.

## Funktionsweise im Detail

### Datei-Auswahl

- Klick auf die Upload-Fläche öffnet den nativen Datei-Dialog (`@tauri-apps/plugin-dialog`), gefiltert auf gängige Audioformate (`mp3`, `wav`, `m4a`, `aac`, `ogg`, `opus`, `flac`, `webm`, `mp4`).
- Drag & Drop wird über Tauris Webview-Event `onDragDropEvent` abgefangen (liefert echte Dateisystempfade, nicht nur Browser-`File`-Objekte).
- Die App merkt sich getrennt den zuletzt genutzten Upload- und Download-Ordner (für die Laufzeit der App, nicht dauerhaft).

### Transkription

Beim Klick auf Start ruft das Frontend den Rust-Command `transcribe_audio(path, language)` auf. Der macht:

1. Liest die Audiodatei als Bytes ein
2. Schickt sie per `POST` direkt an Deepgram (siehe unten)
3. Meldet den Fortschritt über Tauri-Events (`transcription-progress`: `preparing` → `transcribing` → `done`) ans Frontend zurück, das die drei Fortschritts-Punkte entsprechend einfärbt
4. Fasst von Deepgram zurückgelieferte Sprecher-Segmente zusammen (Deepgram zerstückelt denselben Sprecher bei kurzen Pausen in mehrere "Utterances" — die App fügt aufeinanderfolgende Segmente desselben Sprechers wieder zu einem Block zusammen)
5. Gibt eine Liste von `{ speaker, transcript }`-Objekten ans Frontend zurück

Das Frontend formatiert daraus den finalen Text:

```
[Sprecher 1]
<zusammenhängender Text>

[Sprecher 2]
<zusammenhängender Text>
```

### Download

Der Download-Button öffnet den nativen Speichern-Dialog, vorbelegt mit dem Namen der Audiodatei (gleicher Name, Endung `.txt`) und dem zuletzt genutzten Download-Ordner (Default beim allerersten Mal: der System-Downloads-Ordner, wie im Browser). Geschrieben wird die Datei über den Rust-Command `save_transcript`.

## Deepgram-API-Nutzung

Es wird ausschließlich der **Pre-recorded-Endpunkt** verwendet, kein Streaming:

```
POST https://api.deepgram.com/v1/listen
  ?model=nova-3
  &diarize_model=latest
  &utterances=true
  &smart_format=true
  &language=de            (oder &language=en, oder &detect_language=true bei "Automatisch")

Header: Authorization: Token <API_KEY>
Header: Content-Type: <audio-mime-type, z.B. audio/mpeg>
Body:   <Audiodatei als Rohbytes>
```

Wichtige Parameter-Entscheidungen:

- **`model=nova-3`** — aktuell genaueste Deepgram-Modellfamilie, unterstützt Deutsch als eigenes monolinguales Modell.
- **`diarize_model=latest`** statt des älteren `diarize=true` — das neue v2-Diarization-Modell reduziert laut Deepgram die Fehlerrate bei Sprechertrennung um bis zu ~80 % gegenüber v1. Wichtigste Einschränkung: bei **Mono-Aufnahmen** (Raummikro, zusammengemischte Online-Meetings) bleibt akustische Diarization grundsätzlich fehleranfälliger als bei Aufnahmen mit einem Audiokanal pro Sprecher — das lässt sich über API-Parameter nicht weiter beheben.
- **`utterances=true`** — liefert von Deepgram bereits in Sprecher-Segmente gruppierten Text (statt einer rohen Wortliste, die man selbst gruppieren müsste).
- **`smart_format=true`** — automatische Zahlen-, Datums- und Interpunktionsformatierung.
- **Sprache:** "Automatische Erkennung" nutzt `detect_language=true`; explizite Auswahl setzt `language=de`/`language=en` direkt.

Die Antwort wird unter `results.utterances[]` ausgelesen (`speaker`-Index pro Segment, `transcript`-Text).

### Guthaben-Anzeige

Zusätzlich nutzt die App zwei Deepgram-Management-Endpunkte (separat vom Transkriptions-Endpunkt, gleiche Authentifizierung):

- `GET /v1/projects` — um die Projekt-ID zu ermitteln (falls keine explizit hinterlegt ist)
- `GET /v1/projects/{project_id}/balances` — liefert das aktuelle Guthaben

Angezeigt wird `Verbrauch: <seit App-Start verbraucht> (<verbleibendes Guthaben>) USD`. Der Verbrauch ist eine reine Differenzrechnung (Guthaben bei App-Start minus aktuelles Guthaben), kein separater Tracking-Mechanismus.

**Hinweis:** Der verwendete API-Key braucht Berechtigungen für diese Management-Endpunkte (nicht alle Deepgram-Keys haben das automatisch — reine "Usage"-Keys können hier mit einem Berechtigungsfehler scheitern, die Transkription selbst funktioniert davon unabhängig).

## API-Key einrichten

Beim allerersten Start (bzw. wenn noch kein Key hinterlegt ist) öffnet sich automatisch ein Dialog zur Eingabe des Deepgram-API-Keys. Der Key wird lokal im Tauri-Standard-Konfigurationsordner des Betriebssystems gespeichert (`app_config_dir`, z. B. unter macOS `~/Library/Application Support/com.zeitgewinn.hyperscribe/settings.json`) — **nicht** im Projektordner, nicht im Repository. Über das Zahnrad-Symbol oben rechts lässt sich der Key jederzeit ändern.

Für die lokale Entwicklung gibt es alternativ `.env`-Unterstützung (siehe `src-tauri/.env.example`): `DEEPGRAM_API_KEY` und optional `DEEPGRAM_PROJECT_ID`. Die App-Einstellungen haben aber immer Vorrang vor der `.env`.

## Installation (für Endnutzer)

### macOS

1. `hyperscribe_<version>_aarch64.dmg` öffnen (für Apple Silicon, M1 und neuer).
2. Im sich öffnenden Fenster die App in den "Programme"-Ordner ziehen.
3. App aus "Programme" starten.
4. Da die App nicht mit einem Apple-Developer-Zertifikat signiert ist, warnt macOS beim allerersten Start ("nicht verifizierter Entwickler" / "kann nicht geöffnet werden"). Abhilfe: **Rechtsklick auf die App → "Öffnen" → im Dialog bestätigen.** Danach lässt sie sich auch ganz normal per Doppelklick starten.

Für Intel-Macs braucht es einen separaten Build (`--target x86_64-apple-darwin`) oder einen Universal-Build — der aktuelle Build ist reines Apple-Silicon (`aarch64`).

### Windows

Für Windows existiert noch kein fertiger Installer. Tauri erzeugt Windows-Pakete (`.msi` via WiX oder `.exe` via NSIS) nur, wenn der Build auf einem echten Windows-Rechner läuft — Cross-Compiling von macOS aus ist mit Tauri nicht ohne erheblichen Zusatzaufwand möglich.

So entsteht ein Windows-Build:

1. Auf einem Windows-Rechner [Rust](https://rustup.rs/) und [Deno](https://deno.com/) installieren.
2. Projektordner dorthin übertragen.
3. `deno install && deno task tauri build` ausführen.
4. Ergebnis liegt unter `src-tauri/target/release/bundle/msi/` bzw. `src-tauri/target/release/bundle/nsis/`.

Beim ersten Start warnt vermutlich auch Windows SmartScreen (ebenfalls wegen fehlender Signatur) — Abhilfe: "Weitere Informationen" → "Trotzdem ausführen".

Alternative für wiederholte Windows-Builds ohne eigenen Windows-Rechner: ein CI-Workflow (z. B. GitHub Actions mit `windows-latest`-Runner), der bei jedem Release automatisch baut.

## Entwicklung

Voraussetzungen: [Deno](https://deno.com/) und ein Rust-Toolchain (`cargo`, via [rustup](https://rustup.rs/)).

```bash
cd hyperscribe
deno install        # Frontend-Abhängigkeiten installieren
deno task tauri dev # App im Dev-Modus starten (Hot-Reload fürs Frontend)
```

Nur das Frontend bauen/typprüfen (ohne Rust):

```bash
deno task build
```

## Release-Build (.app / .dmg)

```bash
deno task tauri build
```

Ergebnis liegt unter:

- `src-tauri/target/release/bundle/macos/hyperscribe.app`
- `src-tauri/target/release/bundle/dmg/hyperscribe_<version>_<arch>.dmg`

**Wichtig:** Der Build ist architekturspezifisch (z. B. `aarch64` für Apple Silicon). Für Intel-Macs braucht es einen separaten Build mit `--target x86_64-apple-darwin`, oder einen Universal-Build, der beide Architekturen kombiniert.

Da die App nicht mit einem Apple-Developer-Zertifikat signiert ist, blockiert macOS Gatekeeper den ersten Start bei anderen Nutzern ("nicht verifizierter Entwickler"). Abhilfe: Rechtsklick auf die App → "Öffnen" → bestätigen (einmalig pro Empfänger).

## App-Icon ändern

```bash
deno task tauri icon /pfad/zu/einem-bild.png
```

Erzeugt automatisch alle benötigten Formate (`.icns`, `.ico`, diverse PNG-Größen) in `src-tauri/icons/`. Empfehlung: quadratisches PNG, mindestens 1024×1024px, transparenter Hintergrund.

## Projektstruktur

```
hyperscribe/
├── index.html              UI-Markup
├── src/
│   ├── main.ts              Frontend-Logik (Dateiauswahl, UI-Status, Tauri-Aufrufe)
│   └── styles.css           Styling (12×12-CSS-Grid für die Positionierung)
├── src-tauri/
│   ├── src/lib.rs            Rust-Backend: Deepgram-Aufrufe, Dateizugriff, Einstellungen
│   ├── tauri.conf.json       App-Konfiguration (Fenster, Bundle-Targets, Icons)
│   ├── capabilities/         Tauri-Berechtigungen (Dialog-Plugin etc.)
│   └── .env.example          Vorlage für lokale Dev-Umgebungsvariablen
└── samples/                  Test-Audiodateien (außerhalb von hyperscribe/, im Repo-Root)
```

## Bekannte Grenzen

- **Diarization bei Mono-Aufnahmen** ist nie perfekt — vor allem an Sprecherwechseln kann es vorkommen, dass einzelne Wörter dem falschen Sprecher zugeordnet werden. Das ist eine Grenze des Deepgram-Modells bei einkanaligen Aufnahmen, kein App-Bug.
- Kein Undo/Verlauf: Es gibt jeweils nur eine aktive Transkription, keine Liste vergangener Projekte.
- Die Guthaben-Anzeige benötigt einen API-Key mit Berechtigung für Deepgrams Management-Endpunkte.
