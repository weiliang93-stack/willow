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
//      just a long run of "=" characters, and the first non-blank line
//      after that separator is the template's title.
//   2. The doc's own table of contents (the first "block", before the
//      first separator) lists every condition under a category heading,
//      in the same top-to-bottom order the body itself follows.
// Category is assigned by walking the TOC in step with the body: each
// body block's title is checked against the next few not-yet-consumed
// TOC entries (loose containment match, case/punctuation-insensitive) —
// a hit advances to that TOC entry's category, a miss means this block is
// a variant of the current condition (e.g. "URTI (COVID)" / "URTI" /
// "Paeds URTI" all under one TOC entry) and inherits the current
// category unchanged. This turned out to be necessary rather than a
// nice-to-have: an earlier version tried reading the category off a
// restated header line at the top of each category's first body block,
// but the doc only does that consistently for a handful of categories —
// for the rest, relying on it silently dumped everything after the last
// correctly-detected category into that one category. Because this is
// order-based rather than a hard structural anchor, treat category as
// best-effort — occasionally a block may land one category off — while
// template titles and bodies (read directly off the block itself) are
// always exact.
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

// Loose, symmetric containment match: strips parenthetical asides and
// punctuation, lowercases, and checks whether either normalized string
// contains the other — tolerant of a body title being a shortened or
// reworded form of its TOC entry (or vice versa).
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titlesMatch(bodyTitle: string, tocTitle: string): boolean {
  const a = normalizeTitle(bodyTitle);
  const b = normalizeTitle(tocTitle);
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

const TOC_LOOKAHEAD = 4;

// Finds the block's title line and everything after it as the body.
// Returns null for a block with no real content (stray blank block from
// consecutive separators).
function parseBlockContent(raw: string): { title: string; body: string } | null {
  const lines = raw.split("\n").map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  if (i >= lines.length) return null;

  let titleIdx = i;
  // Skip a restated category-name line where the doc happens to include
  // one — it isn't relied on for categorization, but shouldn't be
  // mistaken for the title either.
  if (CATEGORY_SET.has(lines[i])) {
    let j = i + 1;
    while (j < lines.length && lines[j] === "") j++;
    titleIdx = j;
  }
  if (titleIdx >= lines.length || !lines[titleIdx]) return null;

  const title = lines[titleIdx];
  const bodyLines = lines.slice(titleIdx + 1);
  while (bodyLines.length && bodyLines[0] === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();

  return { title, body: bodyLines.join("\n") };
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
    const content = parseBlockContent(block);
    if (!content) continue;

    for (let k = 0; k < TOC_LOOKAHEAD && tocIdx + k < tocEntries.length; k++) {
      if (titlesMatch(content.title, tocEntries[tocIdx + k].title)) {
        currentCategory = tocEntries[tocIdx + k].category;
        tocIdx = tocIdx + k + 1;
        break;
      }
    }

    templates.push({ category: currentCategory, title: content.title, body: content.body });
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
