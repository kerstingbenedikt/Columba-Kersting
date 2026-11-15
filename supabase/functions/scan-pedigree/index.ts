import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// =====================================================================================
// scan-pedigree v2 — "Slot-Liste" statt Pixel-Koordinaten
//
// Idee: Die KI muss NICHT mehr Pixelpositionen schätzen (dafür sind Sprachmodelle
// unzuverlässig). Sie liest nur noch Spalte für Spalte von links nach rechts, in jeder
// Spalte von oben nach unten, und gibt LEERE/unbekannte Kästchen ausdrücklich als
// Platzhalter aus. Die Position (= Verwandtschaft) ergibt sich dann rein aus der Zahl:
//
//   Nr. 0 = Proband, Vater von Nr. i = 2i+1, Mutter von Nr. i = 2i+2
//   Generation g (1 = Eltern) hat 2^g Plätze, von oben nach unten:
//   Eltern 1,2 · Großeltern 3,4,5,6 · Urgroßeltern 7–14 · Ururgroßeltern 15–30 …
//   (ungerade Nr. = Vogel, gerade Nr. = Weibchen → Plausibilitätsprüfung)
//
// Die Schlüssel der Antwort bleiben unverändert (proband, father, mother, ff, fm, mf, mm …).
// =====================================================================================

type JsonObject = Record<string, unknown>;

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// flash-lite ist für diese Aufgabe zu schwach → flash, bei Auffälligkeiten pro.
const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

// 0 = Proband, 1 = Eltern, … 5 = 32 Vorfahren
const MAX_GENERATION = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EXTRACTION_PROMPT = `Du bist ein Experte für Brieftauben-Abstammungsscheine (Pedigrees) und OCR.

AUFGABE: Lies den Stammbaum SPALTE FÜR SPALTE von LINKS nach RECHTS. Gib in jeder Spalte die Kästchen von OBEN nach UNTEN aus. Du musst keine Positionen/Koordinaten angeben und nicht entscheiden, wer Vater oder Mutter ist - das ergibt sich danach automatisch aus der Reihenfolge. Wichtig ist daher NUR: richtige Spalte, richtige Reihenfolge, nichts auslassen.

AUFBAU EINES STAMMBAUMS (gilt für alle Layouts):
- Von links nach rechts wird jede Spalte eine Generation älter. Pro Generation verdoppelt sich die Zahl der Kästchen: 1 Proband, 2 Eltern, 4 Großeltern, 8 Urgroßeltern, 16 Ururgroßeltern, 32 ...
- Innerhalb einer Spalte stehen die Vorfahren in fester Reihenfolge, immer paarweise Vater (♂) dann Mutter (♀): z.B. in der Großeltern-Spalte von oben nach unten: Vater des Vaters, Mutter des Vaters, Vater der Mutter, Mutter der Mutter.
- Variante A: ganz links steht nur der Proband, daneben die beiden Eltern-Kästchen in der nächsten Spalte.
- Variante B ("zusammengefasste erste Spalte"): in der ersten Spalte stehen untereinander Vater (oben), Proband (Mitte, oft ein kleineres Kästchen unter/über der Zeile "Stammbaum von Taube:"), Mutter (unten). Gib sie dann alle drei in der Reihenfolge oben → unten in EINER Spalte aus.
- Unbekannte, leere oder nicht lesbare Kästchen (nur Rahmen, "unbekannt", "?", leeres Feld) MÜSSEN als Platzhalter mit "empty": true ausgegeben werden, damit die Zählung stimmt. Eine Spalte der Generation g hat (außer Variante B, erste Spalte) immer GENAU 2^g Einträge. Lass nie einen Eintrag weg und erfinde keinen.
- Erfinde NIE Ringnummern und gib keine Spalte aus, die im Bild nicht existiert (hat der Stammbaum nur 4 Spalten, gib genau 4 aus). Dieselbe Ringnummer darf nur dann mehrfach vorkommen, wenn sie wirklich so im Bild steht.
- Dieselbe Taube kann an mehreren Stellen vorkommen (Ahnenverlust, gleiche Ringnummer) - gib sie jedes Mal wieder mit aus, nicht zusammenfassen.
- Ganz rechts steht manchmal eine Spalte mit sehr kleinen Kästchen, die nur zwei Ringnummern (Vater oben, Mutter unten) ohne weitere Daten enthalten. Gib so ein Kästchen als EIN Element mit "pair_rings": ["RING_OBEN", "RING_UNTEN"] aus (ringnumber dann null).
- NICHT in die Spalten aufnehmen: Kopfzeilen, Logos, Adresse/Kontakt, Züchtererfolge-Listen, Fußzeilen, DNA-/QR-Zertifikat-Kästchen und Notizen, die nur eine Beziehung zu einer anderen Taube beschreiben ("is half sister to ...").
- Rote/handschriftliche Nummern oder Brüche (z.B. "1/2", "3/8") neben den Kästchen sind nachträgliche Markierungen - ignoriere sie.

PROBAND: Die Box, auf die die Zeile "Stammbaum von Taube: ...", "Pedigree of pigeon: ..." oder sinngemäß verweist (oft auch eine große Überschrift mit Ringnummer und Name links oben), ist der Proband: setze für sie "is_proband": true. Sonst ist es die Box, von der aus eine Vater-Linie nach oben und eine Mutter-Linie nach unten geht. Der Proband ist oft die informationsärmste Box. Trage zusätzlich die genannte Ringnummer wortwörtlich in "proband_label_ring" ein, sonst null.

FELDER je Kästchen (empty-Platzhalter: nur "empty": true, alles andere null):
- ringnumber: vollständige Ringnummer (z.B. DE-04987-25-001, NL-25-1234567, BE-15-1029362), Zeichen für Zeichen, ziffernweise nachzählen, nichts ergänzen oder doppeln; Leerzeichen/Bindestriche wie gedruckt.
- name: echter Name/Spitzname. Reihenfolge in einer Box meist: Ringnummer → Name/Titel → Züchter → Erfolge. Das Farbwort (blau, Grizzle, gehämmert-scheck ...) gehört in "color", nie in "name".
- date_year: Jahrgang als vierstellige Zahl (z.B. 2015), sonst null. Er steht in der Ringnummer als zweistelliger Block direkt VOR der laufenden Nummer (DE-01971-26-57 → 2026, NL-25-1234567 → 2025). Die Vereinsnummer (hier 01971) ist NIE der Jahrgang.
- gender: "M" (♂, Täuber, V, Vogel) oder "F" (♀, Täubin, W, Weibchen) für JEDES Kästchen einzeln aus dem Symbol/Buchstaben hinter der Ringnummer oder der farbigen Markierung (blau = M, rosa/violett = F). Nur wenn nichts erkennbar ist: null. Nicht raten.
- color: Gefiederfarbe. Sie steht meist OHNE Beschriftung als einzelnes Wort oder Abkürzung im Kästchen (blau, bl., gehämmert, geh., fahl, rot, dunkel, schimmel, scheck, weißschlag, blau-scheck; niederländisch blauw, kras, geschelpt, vaal, rood, bont, witpen; englisch blue, check, red, grizzle, pied). Immer in "color" eintragen, so wie gedruckt; nicht in "name" oder "info" wiederholen. Nur wenn keine Farbe im Kästchen steht: null.
- breeder (Züchter): Der Züchtername steht meist unbeschriftet unter dem Namen/Titel (z.B. "Homberg", "Dörner Heinz", "Karl Hans van Loon") und gehört IMMER in "breeder", nicht in "strain".
- strain (Linie/Stamm) nur, wenn ausdrücklich so beschriftet (Stamm, Linie, Strain), sonst null.
- race, owner, countrycode, associationno: wie beschriftet, sonst null.
- info: alle weiteren Texte des Kästchens (Erfolge, Preise, Beschreibungen) als ein Freitext, Zeilenumbrüche als ' / ', sonst null.

Antworte NUR mit dem JSON-Objekt (kein Markdown):
{"proband_label_ring": null, "columns": [ {"boxes": [ {"empty": false, "is_proband": false, "ringnumber": "...", "name": "...", "date_year": 2020, "gender": "M", "color": null, "race": null, "strain": null, "breeder": null, "owner": null, "countrycode": null, "associationno": null, "info": null, "pair_rings": null} ] } ] }`;

// ---------------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------------

function stringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
}

function genderOrNull(v: unknown): "M" | "F" | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (["M", "MALE", "MÄNNLICH", "COCK", "HAHN", "TÄUBER", "V", "VOGEL"].includes(s)) return "M";
  if (["F", "W", "FEMALE", "WEIBLICH", "HEN", "HENNE", "TÄUBIN", "WEIBCHEN"].includes(s)) return "F";
  return null;
}

// Abschließendes V/W hinter der Ringnummer = Vogel/Weibchen, gehört nicht zur Ringnummer
function ringSexLetter(v: unknown): "M" | "F" | null {
  const m = String(v ?? "").trim().match(/\d\s*[-\/]?\s*([VWvw])\.?$/);
  return m ? (m[1].toUpperCase() === "V" ? "M" : "F") : null;
}

function normalizeRing(v: unknown): string | null {
  const raw = stringOrNull(v);
  if (!raw) return null;
  const ring = raw.toUpperCase().replace(/[–—−]/g, "-").replace(/\s+/g, "").replace(/(\d)[-\/]?[VW]\.?$/, "$1");
  return ring || null;
}

type Box = {
  empty: boolean;
  is_proband: boolean;
  ringnumber: string | null;
  name: string | null;
  date_year: number | null;
  gender: "M" | "F" | null;
  color: string | null;
  race: string | null;
  strain: string | null;
  breeder: string | null;
  owner: string | null;
  countrycode: string | null;
  associationno: string | null;
  info: string | null;
  pair_rings: [string | null, string | null] | null;
};

function normalizeBox(raw: unknown): Box | null {
  const b = raw && typeof raw === "object" ? raw as JsonObject : null;
  if (!b) return null;
  const pr = Array.isArray(b.pair_rings) && b.pair_rings.length >= 2
    ? [normalizeRing(b.pair_rings[0]), normalizeRing(b.pair_rings[1])] as [string | null, string | null]
    : null;
  const box: Box = {
    empty: b.empty === true,
    is_proband: b.is_proband === true,
    ringnumber: normalizeRing(b.ringnumber),
    name: stringOrNull(b.name),
    date_year: intOrNull(b.date_year),
    gender: ringSexLetter(b.ringnumber) ?? genderOrNull(b.gender),
    color: stringOrNull(b.color),
    race: stringOrNull(b.race),
    strain: stringOrNull(b.strain),
    breeder: stringOrNull(b.breeder),
    owner: stringOrNull(b.owner),
    countrycode: stringOrNull(b.countrycode),
    associationno: stringOrNull(b.associationno),
    info: stringOrNull(b.info),
    pair_rings: pr && (pr[0] || pr[1]) ? pr : null,
  };
  // Ein "leerer" Platzhalter, der doch Inhalt hat, ist keiner
  if (box.empty && (box.ringnumber || box.name || box.pair_rings)) box.empty = false;
  return box;
}

function extractJsonText(raw: string): string {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

function parseModelJson(raw: string): JsonObject {
  const candidates = [extractJsonText(raw), extractJsonText(raw).replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // nächster Versuch
    }
  }
  return { _parse_error: true, _raw: raw.slice(0, 500), columns: [] };
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------------
// PDF-Textebene: Ringnummern aus dem Text haben Vorrang vor der KI-Lesung (kein OCR-Fehler)
// ---------------------------------------------------------------------------------

const RING_TOKEN = /[A-Z]{1,3} ?-? ?\d{1,5} ?- ?\d{2} ?- ?\d{1,7}|[A-Z]{1,3} ?-? ?\d{2} ?- ?\d{5,8}|\b\d{5,8}-\d{2}\b/g;

function ringsFromText(text: string): string[] {
  const t = text.toUpperCase().replace(/[–—−]/g, "-");
  const out = new Set<string>();
  for (const m of t.matchAll(RING_TOKEN)) out.add(m[0].replace(/\s+/g, ""));
  return [...out];
}

function snapRing(ring: string | null, known: string[]): { ring: string | null; changed: boolean } {
  if (!ring || !known.length) return { ring, changed: false };
  if (known.includes(ring)) return { ring, changed: false };
  let best: string | null = null, bestD = 99, tie = false;
  for (const k of known) {
    const d = levenshtein(ring, k);
    if (d < bestD) { bestD = d; best = k; tie = false; } else if (d === bestD) tie = true;
  }
  if (best && bestD <= 2 && !tie) return { ring: best, changed: true };
  return { ring, changed: false };
}

function snapRings(columns: Box[][], pdfText: string): string[] {
  const known = ringsFromText(pdfText);
  const notes: string[] = [];
  if (!known.length) return notes;
  for (const c of columns) for (const b of c) {
    const r = snapRing(b.ringnumber, known);
    if (r.changed) { notes.push(`Ringnummer ${b.ringnumber} → ${r.ring} (laut PDF-Text korrigiert).`); b.ringnumber = r.ring; }
    if (b.pair_rings) {
      b.pair_rings = b.pair_rings.map((p) => {
        const q = snapRing(p, known);
        if (q.changed) notes.push(`Ringnummer ${p} → ${q.ring} (laut PDF-Text korrigiert).`);
        return q.ring;
      }) as [string | null, string | null];
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------------
// Nummerierung (Slot 0 = Proband, Vater = 2i+1, Mutter = 2i+2)
// ---------------------------------------------------------------------------------

// Schlüssel für Slot-Nummer i (heap-Index) ↔ bisherige Schlüssel (father, mother, ff, fm, ...)
function slotKey(slot: number): string {
  if (slot === 0) return "proband";
  const parts: string[] = [];
  let i = slot;
  while (i > 0) {
    parts.push(i % 2 === 1 ? "f" : "m"); // ungerade = Vater, gerade = Mutter
    i = Math.floor((i - 1) / 2);
  }
  const k = parts.reverse().join("");
  return k === "f" ? "father" : k === "m" ? "mother" : k;
}

function keyToSlot(key: string): number {
  if (key === "proband") return 0;
  const k = key === "father" ? "f" : key === "mother" ? "m" : key;
  let i = 0;
  for (const ch of k) i = 2 * i + (ch === "f" ? 1 : 2);
  return i;
}

// k-tes Kästchen (0-basiert, von oben) der Generation g → Slot-Nummer
function slotOfGenerationPosition(g: number, k: number): number {
  return (2 ** g - 1) + k;
}

function expectedGenderOfSlot(slot: number): "M" | "F" {
  return slot % 2 === 1 ? "M" : "F";
}

function allSlots(maxGeneration = MAX_GENERATION): number[] {
  const n = 2 ** (maxGeneration + 1) - 1;
  return Array.from({ length: n }, (_, i) => i);
}

function emptyTree(): JsonObject {
  const tree: JsonObject = {};
  for (const s of allSlots()) tree[slotKey(s)] = null;
  return tree;
}

function boxToPigeon(b: Box, slot: number): JsonObject {
  return {
    ringnumber: b.ringnumber,
    name: b.name,
    date_year: b.date_year,
    // Fehlt das Geschlecht, ergibt es sich eindeutig aus der Position (außer Proband)
    gender: b.gender ?? (slot === 0 ? null : expectedGenderOfSlot(slot)),
    color: b.color,
    race: b.race,
    strain: b.strain,
    breeder: b.breeder,
    owner: b.owner,
    countrycode: b.countrycode,
    associationno: b.associationno,
    ringnumberfather: null,
    ringnumbermother: null,
    info: b.info,
  };
}

function ringOnlyPigeon(ring: string | null, slot: number): JsonObject {
  return {
    ringnumber: ring, name: null, date_year: null, gender: expectedGenderOfSlot(slot), color: null, race: null,
    strain: null, breeder: null, owner: null, countrycode: null, associationno: null,
    ringnumberfather: null, ringnumbermother: null, info: null,
  };
}

// ---------------------------------------------------------------------------------
// Baum aufbauen: reine Zähl-Logik, keine Geometrie
// ---------------------------------------------------------------------------------

type BuildResult = {
  tree: JsonObject;
  warnings: string[];
  slots: Record<string, number>;
  structureOk: boolean; // alle Spalten hatten exakt die erwartete Anzahl
};

function findProband(columns: Box[][], labelRing: string | null): { col: number; idx: number } | null {
  // 1. explizit markiert
  const marked: { col: number; idx: number }[] = [];
  columns.forEach((c, ci) => c.forEach((b, bi) => { if (b.is_proband) marked.push({ col: ci, idx: bi }); }));
  // 2. Label-Ringnummer (exakt, dann max. 1 Zeichen Abweichung) hat Vorrang
  if (labelRing) {
    let best: { col: number; idx: number } | null = null;
    let bestDist = Infinity;
    columns.forEach((c, ci) => c.forEach((b, bi) => {
      if (!b.ringnumber) return;
      const d = levenshtein(b.ringnumber, labelRing);
      if (d < bestDist) { bestDist = d; best = { col: ci, idx: bi }; }
    }));
    if (best && bestDist <= 1) return best;
  }
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return marked[0];
  // 3. Fallback: erste Spalte mit nur einem Kästchen = Proband; bei 3 Kästchen das mittlere
  const c0 = columns[0] ?? [];
  if (c0.length === 1) return { col: 0, idx: 0 };
  if (c0.length === 3) return { col: 0, idx: 1 };
  return null;
}

function buildTree(columnsRaw: Box[][], labelRing: string | null = null): BuildResult {
  const tree = emptyTree();
  const warnings: string[] = [];
  const slots: Record<string, number> = {};
  let structureOk = true;

  // leere Spalten entfernen; Spalten mit lauter gleichen Ringnummern sind von der KI erfunden
  const columns = columnsRaw.filter((c, ci) => {
    if (c.length === 0) return false;
    const rings = c.flatMap((b) => b.pair_rings ? b.pair_rings : [b.ringnumber]).filter((r): r is string => !!r);
    if (rings.length >= 4 && new Set(rings).size / rings.length <= 0.25) {
      warnings.push(`Spalte ${ci + 1} enthielt fast nur dieselbe Ringnummer (${rings[0]}) - vermutlich von der KI erfunden und ignoriert.`);
      return false;
    }
    return true;
  });
  if (!columns.length) return { tree, warnings: ["Es wurden keine Kästchen erkannt."], slots, structureOk: false };

  const pos = findProband(columns, labelRing);
  if (!pos) {
    warnings.push("Proband nicht eindeutig erkannt.");
    return { tree, warnings, slots, structureOk: false };
  }
  const probandBox = columns[pos.col][pos.idx];
  if (probandBox.empty) {
    warnings.push("Der Proband-Platz war leer.");
    return { tree, warnings, slots, structureOk: false };
  }

  const put = (slot: number, b: Box | null) => {
    if (slot > 2 ** (MAX_GENERATION + 1) - 2) return;
    if (!b || b.empty) return;
    const key = slotKey(slot);
    tree[key] = boxToPigeon(b, slot);
    slots[key] = slot;
  };

  put(0, probandBox);

  // Spalten VOR der Proband-Spalte gibt es nicht (Proband steht links). Falls doch: Warnung.
  if (pos.col > 0) warnings.push("Vor der Proband-Spalte standen weitere Spalten - sie wurden ignoriert.");

  const col = columns[pos.col];
  let genColStart: number; // Index der Spalte, die Generation 2 (Großeltern) enthält
  let nextGen: number;

  if (col.length > 1) {
    // Variante B: Vater oben, Proband, Mutter unten in derselben Spalte
    const idx = pos.idx;
    if (col.length !== 3 || idx !== 1) {
      warnings.push(`Erste Spalte hat ${col.length} Kästchen (Proband an Position ${idx + 1}) - erwartet: Vater, Proband, Mutter.`);
      structureOk = false;
    }
    put(1, col[idx - 1] ?? null);
    put(2, col[idx + 1] ?? null);
    genColStart = pos.col + 1;
    nextGen = 2;
  } else {
    // Variante A: Proband allein, Eltern in der nächsten Spalte
    genColStart = pos.col + 1;
    nextGen = 1;
  }

  for (let ci = genColStart, g = nextGen; ci < columns.length && g <= MAX_GENERATION + 1; ci++, g++) {
    const c = columns[ci];
    const pairColumn = c.filter((b) => b.pair_rings).length >= Math.max(1, Math.ceil(c.length / 2));

    if (pairColumn) {
      // Jedes Kästchen = 2 Ringnummern (Vater oben, Mutter unten) der Vorfahren-Generation g
      const expectedBoxes = 2 ** (g - 1);
      if (c.length !== expectedBoxes) {
        warnings.push(`Ring-Spalte (Generation ${g}) hat ${c.length} statt ${expectedBoxes} Kästchen.`);
        structureOk = false;
      }
      c.forEach((b, k) => {
        if (!b.pair_rings) return;
        const baseSlot = slotOfGenerationPosition(g, 2 * k);
        if (baseSlot + 1 > 2 ** (MAX_GENERATION + 1) - 2) return;
        [0, 1].forEach((j) => {
          const r = b.pair_rings![j];
          if (!r) return;
          const slot = baseSlot + j;
          tree[slotKey(slot)] = ringOnlyPigeon(r, slot);
          slots[slotKey(slot)] = slot;
        });
      });
      continue;
    }

    if (g > MAX_GENERATION) {
      warnings.push(`Spalte ${ci + 1} (Generation ${g}) liegt über der unterstützten Tiefe und wurde ignoriert.`);
      break;
    }
    const expected = 2 ** g;
    if (c.length !== expected) {
      warnings.push(`Spalte ${ci + 1} (Generation ${g}) hat ${c.length} statt ${expected} Kästchen - Zuordnung unsicher.`);
      structureOk = false;
    }
    c.forEach((b, k) => { if (k < expected) put(slotOfGenerationPosition(g, k), b); });
  }

  fixGenderMismatches(tree, slots, warnings);
  return { tree, warnings, slots, structureOk };
}

// Geschwisterpaar (Slot 2i+1 / 2i+2): sind beide Geschlechter genau vertauscht, wurde nur
// die Reihenfolge verwechselt → automatisch tauschen.
function fixGenderMismatches(tree: JsonObject, slots: Record<string, number>, warnings: string[]): void {
  for (let father = 1; father <= 2 ** (MAX_GENERATION + 1) - 3; father += 2) {
    const mother = father + 1;
    const kf = slotKey(father), km = slotKey(mother);
    const a = tree[kf] as JsonObject | null;
    const b = tree[km] as JsonObject | null;
    if (!a || !b) continue;
    const ga = a.gender as "M" | "F" | null;
    const gb = b.gender as "M" | "F" | null;
    if (ga === "F" && gb === "M") {
      tree[kf] = b; tree[km] = a;
      warnings.push(`Nr. ${father}/${mother}: Geschlechter passten nicht zur Position (Vogel muss oben stehen), Kästchen wurden getauscht.`);
    }
  }
}

// Zusätzliche Plausibilitätsprüfungen
function collectDataWarnings(tree: JsonObject, warnings: string[]): string[] {
  const all = [...warnings];
  const proband = tree.proband as JsonObject | null;
  if (!proband?.ringnumber) all.push("Proband hat keine lesbare Ringnummer.");
  const probandRing = normalizeRing(proband?.ringnumber);

  for (const s of allSlots()) {
    if (s === 0) continue;
    const key = slotKey(s);
    const box = tree[key] as JsonObject | null;
    if (!box) continue;
    if (probandRing && box.ringnumber && normalizeRing(box.ringnumber) === probandRing) {
      all.push(`Nr. ${s} (${key}) hat dieselbe Ringnummer wie der Proband - vermutlich falsch zugeordnet.`);
    }
    // Eltern müssen älter als ihre Kinder sein
    const child = tree[slotKey(Math.floor((s - 1) / 2))] as JsonObject | null;
    const py = intOrNull(box.date_year), cy = child ? intOrNull(child.date_year) : null;
    if (py !== null && cy !== null && py > cy) {
      all.push(`Nr. ${s} (${key}): Jahrgang ${py} ist jünger als das Kind (${cy}) - Zuordnung prüfen.`);
    }
  }
  return all;
}

// Qualitätsmaß für die Eskalation auf das stärkere Modell
function structureScore(columns: Box[][], build: BuildResult): number {
  let score = 0;
  for (const c of columns) for (const b of c) if (!b.empty && b.ringnumber) score += 5;
  score += Object.keys(build.slots).length * 2;
  if (build.structureOk) score += 100;
  score -= build.warnings.length * 5;
  return score;
}

// ---------------------------------------------------------------------------------
// Gemini-Aufruf
// ---------------------------------------------------------------------------------

const BOX_SCHEMA = {
  type: "OBJECT",
  properties: {
    empty: { type: "BOOLEAN" },
    is_proband: { type: "BOOLEAN" },
    ringnumber: { type: "STRING", nullable: true },
    name: { type: "STRING", nullable: true },
    date_year: { type: "INTEGER", nullable: true },
    gender: { type: "STRING", nullable: true },
    color: { type: "STRING", nullable: true },
    race: { type: "STRING", nullable: true },
    strain: { type: "STRING", nullable: true },
    breeder: { type: "STRING", nullable: true },
    owner: { type: "STRING", nullable: true },
    countrycode: { type: "STRING", nullable: true },
    associationno: { type: "STRING", nullable: true },
    info: { type: "STRING", nullable: true },
    pair_rings: { type: "ARRAY", nullable: true, items: { type: "STRING", nullable: true } },
  },
  required: ["empty", "is_proband", "ringnumber", "name", "date_year", "gender", "color", "race", "strain", "breeder", "owner", "countrycode", "associationno", "info"],
};

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    proband_label_ring: { type: "STRING", nullable: true },
    columns: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { boxes: { type: "ARRAY", items: BOX_SCHEMA } }, required: ["boxes"] },
    },
  },
  required: ["proband_label_ring", "columns"],
};

function promptWith(pdfText: string): string {
  if (!pdfText) return EXTRACTION_PROMPT;
  return EXTRACTION_PROMPT + `

ZUSATZ - TEXT AUS DER PDF-TEXTEBENE (fehlerfrei, aber nur grob nach Spalten gruppiert - die Gruppierung kann ungenau sein, verlasse dich für Struktur und Reihenfolge auf das Bild):
"""
${pdfText}
"""
Übernimm Ringnummern, Namen und Zahlen Zeichen für Zeichen aus diesem Text, wenn sie dort vorkommen. Die Struktur (Spalte/Reihenfolge, leere Kästchen) bestimmst du weiterhin anhand des Bildes.`;
}

async function callGemini(model: string, mediaType: string, imageData: string, pdfText: string, maxOutputTokens = 32768): Promise<Response> {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: imageData } }, { text: promptWith(pdfText) }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    }),
  });
}

async function runModel(model: string, mediaType: string, imageData: string, pdfText: string): Promise<{ parsed: JsonObject; ok: boolean; err?: string }> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));
    let resp: Response;
    try {
      resp = await callGemini(model, mediaType, imageData, pdfText);
    } catch (e) {
      lastErr = `${model}: ${String(e)}`;
      continue;
    }
    if (!resp.ok) {
      lastErr = `${model} HTTP ${resp.status}: ${await resp.text()}`;
      if (resp.status !== 503 && resp.status !== 429) break;
      continue;
    }
    let data = await resp.json();
    if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      const retry = await callGemini(model, mediaType, imageData, pdfText, 60000);
      if (retry.ok) {
        const retryData = await retry.json();
        if (retryData?.candidates?.[0]?.finishReason !== "MAX_TOKENS") data = retryData;
      }
    }
    const rawText = data?.candidates?.[0]?.content?.parts?.map((p: JsonObject) => String(p.text ?? "")).join("") ?? "";
    return { parsed: parseModelJson(rawText), ok: true };
  }
  return { parsed: {}, ok: false, err: lastErr };
}

function parseColumns(parsed: JsonObject): Box[][] {
  const cols = Array.isArray(parsed.columns) ? parsed.columns : [];
  return cols.map((c) => {
    const boxes = c && typeof c === "object" && Array.isArray((c as JsonObject).boxes) ? (c as JsonObject).boxes as unknown[] : [];
    return boxes.map(normalizeBox).filter((b): b is Box => b !== null);
  });
}

// ---------------------------------------------------------------------------------
// HTTP-Handler (alles oberhalb davon ist reine Logik)
// ---------------------------------------------------------------------------------
// ==SERVER==
serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const imageData = stringOrNull(body?.imageData);
    const mediaType = stringOrNull(body?.mediaType) ?? "image/jpeg";
    const pdfText = (stringOrNull(body?.pdfText) ?? "").slice(0, 12000);
    if (!imageData) throw new Error("Kein Bild übermittelt");
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY nicht konfiguriert");

    let best: { build: BuildResult; columns: Box[][]; score: number; model: string; labelRing: string | null } | null = null;
    let escalated = false;
    let lastErr = "";

    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      const result = await runModel(model, mediaType, imageData, pdfText);
      if (!result.ok) { lastErr = result.err ?? lastErr; continue; }
      const columns = parseColumns(result.parsed);
      const snapNotes = pdfText ? snapRings(columns, pdfText) : [];
      const labelRing = normalizeRing(result.parsed.proband_label_ring);
      const build = buildTree(columns, labelRing);
      build.warnings.push(...snapNotes);
      const score = structureScore(columns, build);
      if (!best || score > best.score) best = { build, columns, score, model, labelRing };
      // Gut genug: Struktur stimmt und Proband gefunden → kein teureres Modell nötig
      if (build.structureOk && build.tree.proband) break;
      if (i < MODELS.length - 1) escalated = true;
    }

    if (!best) throw new Error(lastErr || "Alle Modelle fehlgeschlagen");

    const allWarnings = collectDataWarnings(best.build.tree, best.build.warnings);
    const responseData: JsonObject = { ...best.build.tree };
    if (escalated) responseData._escalatedModel = best.model;
    if (allWarnings.length) responseData._warnings = allWarnings;
    responseData._slots = best.build.slots; // Schlüssel → Nr. (0 = Proband, 1 = Vater, 2 = Mutter, 3–6 = Großeltern …)
    responseData._model = best.model;
    responseData._pdfText = !!pdfText;
    // Rohdaten zur Fehlersuche: tatsächlich gelieferte Spalten (Anzahl je Spalte + Ringnummern)
    responseData._debugColumns = best.columns.map((c) => c.map((b) => (b.empty ? "(leer)" : b.pair_rings ? b.pair_rings.join(" | ") : b.ringnumber ?? b.name ?? "?")));

    return new Response(JSON.stringify({ ok: true, data: responseData }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
