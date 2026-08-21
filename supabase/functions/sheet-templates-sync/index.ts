// Supabase Edge Function: pulls the WILLOW consult-templates Google Doc
// (clinical consult-note templates used at the point of care, organised
// into categories like General/Neuro/ENT/Dermatology/etc.) and writes a
// parsed, structured copy into app_state under app "templates", for
// templates-app to search and copy from.
//
// One-way, doc -> app, same as sheet-investment-sync: edits to the doc
// show up here on the next sync; templates-app never writes back, so
// there's no whole-state-clobber risk from this sync the way the other
// sheet-sync functions have (nothing else ever writes to app "templates").
//
// Parsing relies on two things the doc already has:
//   1. Every template is separated from the next by a paragraph that is
//      just a long run of "=" characters.
//   2. The doc's own table of contents (the first "block", before the
//      first separator) lists every condition under a category heading,
//      in the same top-to-bottom order the body itself follows.
// Category is assigned by walking the TOC in step with the body: each
// body block's title is checked against the next few not-yet-consumed
// TOC entries (word-overlap match, case/punctuation-insensitive, tolerant
// of a body title being a reworded or expanded form of its TOC entry) —
// a hit advances to that TOC entry's category, a miss means this block is
// a variant of the current condition (e.g. "URTI (COVID)" / "URTI" /
// "Paeds URTI" all under one TOC entry) and inherits the current
// category unchanged.
//
// A block's first line isn't always its title, though: the doc
// inconsistently restates a section label above the real title — an
// exact category name in some spot ("DERMATOLOGY" above "Urticaria"), an
// ad hoc abbreviation in others ("GASTRO" above "Gastroenteritis"), never
// in most. There's no fixed marker for these, so the rule is: if the
// first line reads like a label (short, entirely uppercase) AND the line
// right after it is the one that actually matches the TOC, use that
// second line as the title instead. Checking the *second* line's match
// rather than the first line's non-match is what makes this safe — a
// short all-caps line that's a genuine title on its own (e.g. "RENAL
// COLIC", matching the TOC directly) never even reaches the fallback,
// and a label whose real title doesn't happen to match anything nearby
// (e.g. plain "URTI" as a variant of the COVID one) just keeps the first
// line rather than being swapped for unrelated body text.
//
// Some blocks also bundle two age-group variants under one heading
// instead of using their own separator (e.g. one block's body running
// "Balanitis (Adult)" ... full note ... "Balanitis (Paeds)" ... full
// note, with no "====" between them) — inconsistent with the /many/
// conditions that already get their own separated blocks per variant.
// Those embedded sub-headings are detected within the body (short line,
// no trailing colon, starting or parenthetically ending with an
// adult/paeds/child-type word) and split out into their own separate
// templates, sharing the parent block's category.
//
// Because all of this is pattern-matching against a doc that isn't
// perfectly consistent, rather than a hard structural anchor, treat
// category as best-effort — occasionally a block may land one category
// off — while template titles and bodies (read directly off the block
// itself) are always exact.
//
// Fetches the doc via Drive's plain-text export rather than the Docs API,
// since that already gives clean paragraph-per-line text without having
// to walk structuralElements/textRuns — Viewer access to the doc is
// enough for this.
//
// Required secrets:
//   GOOGLE_WILLOW_DOC_ID                 - the id from the doc's URL
//                                          (docs.google.com/document/d/<id>/edit)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY   - reused from sheet-budget-sync's
//                                          setup; this doc must also be
//                                          shared with that service
//                                          account's email (Viewer is enough)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET    - reuse the same values already
//                                          set for the other functions
//
// Meant to be triggered daily by a Database > Cron Job calling this via
// pg_net, same as the other sheet-sync functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const DOC_ID = Deno.env.get("GOOGLE_WILLOW_DOC_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const CATEGORIES = [
  "General", "Neuro", "PSY", "Eye", "ENT", "Chest", "Abdomen",
  "Uro/Gynae", "Dermatology", "MSK/Ortho", "Procedures", "Chronic Conditions Follow-up",
];
const CATEGORY_SET = new Set(CATEGORIES);

// A block boundary is a paragraph that, once trimmed, is nothing but "="
// characters — long enough that a stray "==" typo in body text can't
// accidentally match.
const SEPARATOR_RE = /^=+$/;
const MIN_SEPARATOR_LEN = 10;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function getAccessToken(): Promise<string> {
  const jwt = new JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

async function fetchDocText(accessToken: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${DOC_ID}/export?mimeType=text%2Fplain`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive export failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

function splitBlocks(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_SEPARATOR_LEN && SEPARATOR_RE.test(trimmed)) {
      blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join("\n"));
  return blocks;
}

interface ParsedTemplate {
  category: string;
  title: string;
  body: string;
}

interface TocEntry {
  category: string;
  title: string;
}

// TOC lines are either a bare category heading (exact match against
// CATEGORIES) or a numbered entry ("1. Condition name", "2) Condition
// name", occasionally without a space after the number/punctuation).
function parseToc(raw: string): TocEntry[] {
  const lines = raw.split("\n").map((l) => l.trim());
  const entries: TocEntry[] = [];
  let current: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    if (CATEGORY_SET.has(line)) {
      current = line;
      continue;
    }
    const m = line.match(/^\d+[.)]\s*(.+)$/);
    if (m && current) entries.push({ category: current, title: m[1].trim() });
  }
  return entries;
}

// Strips parenthetical asides and punctuation, lowercases, and splits
// into words for comparison — tolerant of a body title being a reworded
// or expanded form of its TOC entry ("Stye/Hordeolum/Chalazion" vs the
// TOC's "Stye/Chalazion") without falling for an unrelated TOC entry
// that merely shares one common word with a short candidate (plain
// substring containment let "EYE" match the word "eye" inside "Red eye
// - Conjunctivitis" several entries away — word-set overlap doesn't).
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordSet(s: string): Set<string> {
  return new Set(s.split(" ").filter(Boolean));
}

function titlesMatch(bodyTitle: string, tocTitle: string): boolean {
  const a = normalizeTitle(bodyTitle);
  const b = normalizeTitle(tocTitle);
  if (a.length < 3 || b.length < 3) return false;
  const aw = wordSet(a);
  const bw = wordSet(b);
  const [shorter, longer] = aw.size <= bw.size ? [aw, bw] : [bw, aw];
  if (shorter.size === 0) return false;
  let overlap = 0;
  for (const w of shorter) if (longer.has(w)) overlap++;
  return overlap / shorter.size >= 0.8;
}

const TOC_LOOKAHEAD = 4;

function tocMatchIndex(candidate: string, tocEntries: TocEntry[], tocIdx: number): number {
  for (let k = 0; k < TOC_LOOKAHEAD && tocIdx + k < tocEntries.length; k++) {
    if (titlesMatch(candidate, tocEntries[tocIdx + k].title)) return k;
  }
  return -1;
}

// A restated section label reads like "DERMATOLOGY" or "GASTRO": short
// and entirely uppercase. A genuine all-caps condition title ("RENAL
// COLIC") looks the same on its own — the caller only acts on this when
// the *following* line is the one that resolves against the TOC.
function looksLikeLabel(line: string): boolean {
  if (!line || line.length > 40) return false;
  return line === line.toUpperCase() && /[A-Z]/.test(line);
}

function firstNonEmpty(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i] === "") i++;
  return i;
}

const AGE_KEYWORDS = new Set(["paeds", "paed", "paediatric", "pediatric", "child", "children", "kids", "kid", "adults", "adult"]);

// An embedded age-variant sub-heading: short, not a "Meds:"-style list
// intro (those end in a colon and belong to the section above them, not
// a new one), and either led by or parenthetically qualified with an
// age-group word — "Balanitis (Paeds)", "PAEDS GE", but not a body line
// that merely happens to end with "(Adult)" as part of a much longer
// sentence (a real case found in the doc: a medication dosing line).
function isAgeVariantMarker(line: string): boolean {
  const s = line.trim();
  if (!s || s.length > 30 || s.endsWith(":")) return false;
  const firstWord = (s.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (AGE_KEYWORDS.has(firstWord)) return true;
  const m = s.match(/\(([a-zA-Z]+)\)\s*$/);
  return m !== null && AGE_KEYWORDS.has(m[1].toLowerCase());
}

// Splits a block's body on any embedded age-variant sub-headings, e.g.
// "Balanitis (Adult)"'s body containing a later "Balanitis (Paeds)" line
// that should become its own template rather than trailing content
// glued onto the first. A block with no such marker returns its single
// original title/body unchanged.
function splitAgeVariants(title: string, bodyLines: string[]): { title: string; body: string }[] {
  const segments: { title: string; body: string[] }[] = [{ title, body: [] }];
  for (const line of bodyLines) {
    if (line !== "" && isAgeVariantMarker(line)) {
      segments.push({ title: line, body: [] });
    } else {
      segments[segments.length - 1].body.push(line);
    }
  }
  return segments.map((seg) => {
    const b = seg.body.slice();
    while (b.length && b[0] === "") b.shift();
    while (b.length && b[b.length - 1] === "") b.pop();
    return { title: seg.title, body: b.join("\n") };
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseDoc(text: string): ParsedTemplate[] {
  const blocks = splitBlocks(text);
  const tocEntries = parseToc(blocks[0] ?? "");
  if (tocEntries.length === 0) return [];

  let tocIdx = 0;
  let currentCategory = tocEntries[0].category;
  const templates: ParsedTemplate[] = [];

  for (const block of blocks.slice(1)) {
    const lines = block.split("\n").map((l) => l.trim());
    const i = firstNonEmpty(lines, 0);
    if (i >= lines.length) continue;

    let titleIdx = i;
    if (looksLikeLabel(lines[i])) {
      const j = firstNonEmpty(lines, i + 1);
      if (j < lines.length && lines[j] && tocMatchIndex(lines[j], tocEntries, tocIdx) !== -1) {
        titleIdx = j;
      }
    }
    if (!lines[titleIdx]) continue;

    const title = lines[titleIdx];
    const match = tocMatchIndex(title, tocEntries, tocIdx);
    if (match !== -1) {
      currentCategory = tocEntries[tocIdx + match].category;
      tocIdx = tocIdx + match + 1;
    }

    const bodyLines = lines.slice(titleIdx + 1);
    while (bodyLines.length && bodyLines[0] === "") bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();

    for (const seg of splitAgeVariants(title, bodyLines)) {
      templates.push({ category: currentCategory, title: seg.title, body: seg.body });
    }
  }
  return templates;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let docText: string;
  try {
    const accessToken = await getAccessToken();
    docText = await fetchDocText(accessToken);
  } catch (err) {
    console.error(err);
    return new Response(`error reading doc: ${err}`, { status: 500 });
  }

  const parsed = parseDoc(docText);
  if (parsed.length < 20) {
    return new Response(
      `only parsed ${parsed.length} templates — doc structure may have changed, aborting without writing`,
      { status: 500 },
    );
  }

  const seenIds = new Set<string>();
  const templates = parsed.map((t) => {
    let base = `${slugify(t.category)}-${slugify(t.title)}` || "template";
    let id = base;
    let n = 2;
    while (seenIds.has(id)) {
      id = `${base}-${n}`;
      n++;
    }
    seenIds.add(id);
    return { id, category: t.category, title: t.title, body: t.body };
  });

  const { error } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app: "templates", state: { templates }, updated_at: new Date().toISOString() });
  if (error) {
    console.error(error);
    return new Response(`error writing app_state: ${error.message}`, { status: 500 });
  }

  return new Response(`synced ${templates.length} templates across ${new Set(templates.map((t) => t.category)).size} categories`);
});
