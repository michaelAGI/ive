# iPhone mit einem IVE-Agenten benutzen

Stand: 18. November 2026. Diese Anleitung gilt für den Device Hub ab IVE 1.0.32.
IVE 1.0.31 enthält ihn noch nicht. Ein vollständiger Test mit einem echten
iPhone steht aus.

## Brauche ich Xcode?

**Ja.** Dieser Verbindungsweg benötigt einen Apple-Silicon-Mac mit **macOS 27+**,
**Xcode 27+** und ein iPhone mit **iOS 27+**. Das sind Anforderungen der optionalen
iPhone-Steuerung, keine neuen Mindestanforderungen für IVE insgesamt.

Der Setup-Agent prüft Xcode und baut den mitgelieferten Steuerungs-Helper lokal.
Fehlt Xcode, kann er dessen offizielle App-Store-Seite öffnen und anschließend
weiterarbeiten. Apples Download, Anmeldung, Lizenz- und Administratorabfragen
lassen sich nicht durch „Full access“ ersetzen. Xcode muss einmal geöffnet und
seine Komponenteneinrichtung abgeschlossen werden.

Für die reine Steuerung wird kein eigenes iOS-Projekt, keine WebDriverAgent-App
und keine App-Signierung eingerichtet. Der gebündelte ipb-Helper verwendet
Apples CoreDevice- und private HID-Schnittstellen. Dieser Weg kann sich nach
Systemupdates ändern; eine funktionierende Eingabe muss am Gerät überprüft
werden. [Upstream-Projekt ipb](https://github.com/ipbtools/ipb)

## Einmal einrichten

1. IVE öffnen und einen verfügbaren Claude-Code- oder Codex-Zugang verbinden.
2. In der Seitenleiste **Devices** öffnen. Das ist die Steuerung des iPhones
   vom Mac aus. **Phone access** bezeichnet die andere Richtung: IVE vom Handy bedienen.
3. iPhone mit einem Datenkabel verbinden und entsperren. Bei Bedarf auf dem
   iPhone **Diesem Computer vertrauen** bestätigen und den Gerätecode selbst eingeben.
4. Das gewünschte iPhone wählen. Sind mehrere Geräte angeschlossen, entscheidet
   der Agent nicht stillschweigend, welches er verwenden soll.
5. Claude Code oder Codex wählen. **Full access on this Mac** erlaubt diesem Agenten Befehle
   und Änderungen auf dem Mac ohne Einzelabfragen. Ohne das Häkchen gelten die
   normalen Freigaben der Agent-Sitzung.
6. Optional über **Choose a task idea** eine Vorlage auswählen oder einen eigenen
   Auftrag eingeben. Dann **Connect iPhone** anklicken. Ist das iPhone bereits
   eingerichtet, startet **Start control** direkt eine neue Agent-Sitzung.
7. Der Agent prüft den Mac, baut den gebündelten Helper und startet Pairing und
   gegebenenfalls die Anforderung des Entwicklermodus.
8. Wenn nötig am iPhone **Einstellungen → Datenschutz & Sicherheit →
   Entwicklermodus** einschalten, neu starten, entsperren und bestätigen.
   Danach dem Agenten sagen, dass er fortfahren kann. Die notwendigen
   Bestätigungen bleiben bei dir. [Apple: Vertrauen](https://support.apple.com/109054),
   [Apple: Entwicklermodus](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
9. Der Agent prüft ein frisches Bildschirmbild. Erst nach erfolgreicher Prüfung
   weist IVE ihm das gewählte iPhone zu. Eine vorher ausgewählte Aufgabe startet
   anschließend; ohne Aufgabe wartet er.

Nach dieser Einrichtung ist das Ziel: anschließen, entsperren, Agent zuweisen,
Aufgabe nennen. Apple kann erneut eine Bestätigung verlangen. Nach der ersten
USB-Kopplung kann auch die Verbindung im selben lokalen WLAN funktionieren.
Der Mac muss laufen und erreichbar sein; ein anderer Standort über das Internet
ist mit dieser Verbindung nicht eingerichtet.

## Benutzen und stoppen

- **Choose a task idea**: Eine Vorlage auswählen, den Auftrag bearbeiten
  und an den zugewiesenen Agenten senden. Die Auswahl allein startet nichts.
- **Open agent**: Die normale IVE-Sitzung öffnen und den Fortschritt verfolgen.
- **Show screen**: Eine echte Vorschau anfordern. Sie wird alle paar Sekunden
  aktualisiert; **Pause** hält nur die Vorschau an.
- **Stop control**: Die IVE-Gerätezuweisung widerrufen, laufende Adapterprozesse
  stoppen und gespeicherte Beobachtungen verwerfen. Bereits übermittelte
  Eingaben können dadurch nicht rückgängig gemacht werden.
- **Stop setup**: Die Einrichtung beenden. Der Helper bleibt als lokale Datei
  erhalten; laufende Setup-Prozesse werden beendet.

Die Zuweisung gilt für eine Sitzung und höchstens eine Stunde. Ein zweiter Agent
benötigt eine neue Zuweisung. Alte Sitzungen müssen gegebenenfalls neu gestartet
werden, damit ihre MCP-Verbindung die neuen Gerätewerkzeuge lädt.

Screenshots werden dem ausgewählten Agenten und seinem Anbieter zugänglich.
IVE speichert die Bilder nicht als dauerhafte Gerätehistorie. Der normale
Sitzungsverlauf des Anbieters kann sie enthalten. Tippen und Wischen unterstützen
zunächst das Hochformat; Texteingabe ersetzt die Zwischenablage des iPhones.

„Full access“ ist eine breite Berechtigung für die Mac-Sitzung. **Stop control**
widerruft die IVE-Gerätewerkzeuge, beendet aber nicht die ganze Agent-Sitzung und
kann einen Agenten mit beliebigem Shell-Zugriff nicht am direkten Aufruf anderer
lokaler Werkzeuge hindern. Zum Beenden sämtlicher Agent-Aktivität auch die Sitzung
stoppen. Eine Gerätezuweisung ist keine isolierte Sandbox.

## Zehn vorbereitete Anwendungsfälle

Die Vorlagen stehen direkt im Device Hub. Sie beschreiben Aufträge für den Agenten;
sie sind keine zehn bereits am echten iPhone geprüften Automatisierungen.

| Auswahl in IVE | Was du bekommst | Was zunächst passiert |
| --- | --- | --- |
| Find duplicate photos | Überblick über doppelte Fotos und mögliche Bereinigung | Apple Fotos prüfen; konkrete Gruppen vor Zusammenführen oder Löschen bestätigen |
| Sort saved screenshots | Aufgaben, Referenzen und Aufräumkandidaten aus vergessenen Screenshots | Bis zu 30 aktuelle Screenshots sichten; nichts löschen |
| Find wasted storage | Priorisierte Vorschläge, die tatsächlich Speicher freigeben könnten | Angezeigte Größen und Empfehlungen in iPhone-Speicher auslesen |
| Organize receipts | Ausgabenübersicht mit Datum, Händler, Betrag und Quelle | Nur ein gewähltes Album bzw. einen Ordner prüfen; unsichere Beträge markieren |
| Turn notes into reminders | Konkrete Erinnerungen statt verstreuter To-dos | Gewählte Notiz auswerten, Vorschau zeigen, genehmigte Erinnerungen anlegen |
| Review the coming week | Wochenüberblick, Überschneidungen und Vorbereitung | Ausgewählte Kalender lesen; keine Einladungen oder Verschiebungen |
| Reduce distractions | Passender Fokus für Arbeit oder Lernen | Gewünschte Zeiten und Ausnahmen klären, bestätigte Einstellungen anwenden |
| Prepare for a trip | Reisecheckliste aus deinen gespeicherten Informationen | Gewählte Tickets, Termine und Notizen zusammenfassen; nichts buchen |
| Review subscriptions | Übersicht der in Apple angezeigten Preise und Verlängerungen | Abos lesen; keine Käufe, Kündigungen oder Tarifwechsel |
| Test an app on iPhone | Nachvollziehbarer Fehlerbericht und Prüfung nach einem Fix | Bestimmten Ablauf mit erlaubten Testdaten reproduzieren |

## Foto-Duplikate: drei verschiedene Möglichkeiten

**Direkt auf dem iPhone:** Der Agent kann die vorhandene Duplikate-Sammlung in
Apple Fotos bedienen. Sie enthält die von Fotos erkannten Gruppen; eine leere
Ansicht ist kein vollständiger Beweis, dass es keine ähnlichen Bilder gibt.
Zusammenführen wird erst nach Auswahl und Bestätigung konkreter Gruppen
ausgeführt. [Apple: Doppelte Fotos zusammenführen](https://support.apple.com/en-mide/guide/iphone/iph1978d9c23/27/ios/27)

**Exakte Dateien in einem Export:** IVE bringt das eigene, lesende Skript
[`photo_duplicate_report.py`](../scripts/photo_duplicate_report.py) mit.
Es benötigt nur Python 3.9+ bzw. den Python-Laufzeitmodus des IVE-Backends:

```sh
python3 scripts/photo_duplicate_report.py "/Pfad/zum/Fotos-Export" --output "/Pfad/zu/neuem-duplikate-bericht.json"
```

Im ausgelieferten App-Build gibt `device_list` unter `photo_duplicate_report`
den passenden Befehlsanfang für den Agenten zurück. Du wählst ausdrücklich den
Exportordner; der Agent ergänzt diesen Pfad und gegebenenfalls eine neue
JSON-Berichtsdatei. Es ist kein zusätzlicher Paket- oder Modelldownload nötig.

Das Skript vergleicht SHA-256-Hashes gleich großer Medien. Es meldet Dateigruppen
und die Größe zusätzlicher Kopien. Es löscht, verschiebt oder verändert keine
Medien; ein bestehender Bericht wird nicht überschrieben. Symlinks werden nicht
verfolgt, Hardlinks nicht als zusätzliche Dateien gezählt und Photos-Mediatheken
ausgeschlossen. Während des Lesens veränderte Dateien werden als unklar gemeldet.
Live-Photo-Zusammenhänge, APFS-Klone und Cloud-Synchronisierung können die tatsächliche
Speicherersparnis verändern. Neu komprimierte oder nur ähnlich aussehende Bilder
werden nicht erkannt. Es gibt keine automatische Bereinigung der iPhone-Mediathek.

**Ähnliche Bilder und größere Mediatheken:** Folgende Originalprojekte wurden
recherchiert, aber nicht automatisch heruntergeladen oder ausgeführt:

| Werkzeug / Skript | Wofür es passt | Grenze |
| --- | --- | --- |
| [ImageHash: find_similar_images.py](https://github.com/JohannesBuchner/imagehash/blob/master/find_similar_images.py) | Python-Beispiel für Bild-Hashes wie aHash, pHash und dHash | Braucht Pillow/ImageHash; gleiche Bild-Hashes sind Kandidaten, kein Löschbeweis. Das Beispiel gibt teils `rm`-Vorschläge aus; diese nicht automatisch ausführen. Kein iPhone-Dateizugriff. |
| [Czkawka](https://github.com/qarmin/czkawka) | Umfangreicher Finder für exakte Duplikate und ähnliche Bilder in lokalen Ordnern | Auf Exportkopien arbeiten; Auswahl und mögliche Löschaktionen getrennt prüfen. Keine automatische Installation durch diese Integration. |
| [OSXPhotos](https://github.com/RhetTbull/osxphotos) | Abfragen und Export von Fotos samt Metadaten aus Apple Fotos auf dem Mac | Zugriff auf eine Mac-Mediathek, kein USB-Zugang zur gesamten iPhone-Mediathek. Exportziele und Optionen vor Ausführung prüfen. |

Für den ersten eingebauten Ablauf: Apple Fotos auf dem Gerät, oder das lesende
IVE-Skript auf einem ausdrücklich gewählten Export. Bildähnlichkeit kann später
ergänzt werden, ohne ML-Modelle oder fremden Download-Code vorauszusetzen.

## Wenn es nicht klappt

| Anzeige / Situation | Nächster Schritt |
| --- | --- |
| Kein iPhone gefunden | Datenkabel prüfen, entsperren, Vertrauen bestätigen, Refresh. Bei mehreren Geräten das richtige wählen. |
| Xcode needs setup | Xcode 27+ installieren, öffnen und Komponenten fertig einrichten; Setup-Agent erneut prüfen lassen. |
| Developer Mode required | Am Gerät aktivieren, Neustart und Bestätigung abschließen, dann fortfahren. |
| Fehler oder unklarer Eingabestatus | Bildschirm erneut beobachten; eine unsicher ausgeführte Eingabe nicht blind wiederholen. |
| Gerät gedreht | Hochformat einstellen und neues Bildschirmbild anfordern. |
| Sitzung hat keine Gerätewerkzeuge | Sitzung nach dem IVE-Update neu starten. |
| Verbindung nach Systemupdate defekt | Voraussetzungen erneut prüfen und Helper neu vorbereiten; private Schnittstellen können sich geändert haben. |

Ein erfolgreicher Screenshot beweist Bildschirmzugriff. Ob eine Eingabe gewirkt
hat, zeigt erst eine erneute Beobachtung. Der abschließende reale Test sollte
ein harmloses Öffnen/Navigieren in einer Test-App, Texteingabe mit Testdaten,
Abziehen des Kabels und Stop control abdecken.
