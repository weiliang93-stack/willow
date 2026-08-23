// Supabase Edge Function: pulls the WILLOW TM teleconsultation templates
// Google Doc (companion to WILLOW's in-clinic templates — same doctor,
// same point-of-care use case, but for video/phone consults) and writes
// a parsed, structured copy into app_state under app "teletemplates",
// for templates-app's Teleconsult mode to search and copy from.
//
// Unlike sheet-templates-sync's source doc, WILLOW TM is authored with
// real Google Docs heading styles (Heading 1/2/3), not a run of "="
// characters between blocks — so this fetches the doc as Markdown
// (`export?mimeType=text/markdown`) instead of plain text, and parses
// off the resulting "#"/"##"/"###" markers directly. That's a hard
// structural anchor rather than the pattern-matching sheet-templates-
// sync needs, so this parser is considerably simpler: no table-of-
// contents cross-referencing, no label/title disambiguation.
//
// Structure: "## " headings are categories, "### " headings under them
// are templates (title = heading text, body = everything until the next
// heading). The "## Table of Contents" section is skipped entirely —
// it's just a bullet list of links, not real content. The doc's own
// "## Standard Teleconsult Blocks" section doesn't use "### " for its
// sub-items (opening/closing scripts, MC disclaimer, referral letter
// template, paediatric medication precautions) — each is instead a
// paragraph that's *only* bold text, e.g. "**Opening (use for every
// teleconsult):**". Those are parsed the same way as "### " headings
// (a trimmed line matching ^\*\*(.+)\*\*$ starts a new template) and
// filed under category "Standard Blocks", since they're exactly the
// kind of frequently-reused snippet this app exists to make quick to
// find and copy.
//
// Markdown escapes the doc's own literal backslashes/underscores/etc.
// introduce (e.g "\_\_\_" for a literal blank-fill "___") are unescaped
// before parsing; the long underscore divider lines Standard Blocks
// uses between its sub-items are dropped as non-content.
//
// One-way for the templates themselves, doc -> app, same as
// sheet-templates-sync. templates-app writes back one thing this
// function doesn't touch — which templates are starred, scoped
// separately per mode — so like sheet-templates-sync this preserves the
// existing `starred` list (pruned to ids that still exist) across each
// sync rather than overwriting `state` wholesale.
//
// Required secrets:
//   GOOGLE_WILLOW_TM_DOC_ID               - the id from the doc's URL
//                                           (docs.google.com/document/d/<id>/edit)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY    - reused from sheet-budget-sync's
//                                           setup; this doc must also be
//                                           shared with that service
//                                           account's email (Viewer is enough)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET     - reuse the same values already
//                                           set for the other functions
//
// Meant to be triggered every 10 minutes by a Database > Cron Job
// calling this via pg_net, same as the other sheet-sync functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const DOC_ID = Deno.env.get("GOOGLE_WILLOW_TM_DOC_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const STANDARD_BLOCKS_HEADING = "Standard Teleconsult Blocks";
const STANDARD_BLOCKS_CATEGORY = "Standard Blocks";

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

async function fetchDocMarkdown(accessToken: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${DOC_ID}/export?mimeType=text%2Fmarkdown`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive export failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

interface ParsedTemplate {
  category: string;
  title: string;
  body: string;
}

// Markdown escapes a real export puts in front of literal characters
// that would otherwise read as syntax (e.g. "\_\_\_" for a literal
// blank-fill "___", "\*" for a literal asterisk).
function unescapeMarkdown(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
}

function stripBold(s: string): string {
  return s.replace(/\*\*(.*?)\*\*/g, "$1").trim();
}

function isDivider(line: string): boolean {
  return /^_{5,}$/.test(line.trim());
}

function parseDoc(rawText: string): ParsedTemplate[] {
  const text = unescapeMarkdown(rawText);
  const lines = text.split(/\r\n|\r|\n/);

  const templates: ParsedTemplate[] = [];
  let currentCategory: string | null = null;
  let skipping = false; // inside the "Table of Contents" section
  let current: { title: string; category: string; body: string[] } | null = null;

  function flush() {
    if (current && current.title) {
      const body = current.body.slice();
      while (body.length && body[0].trim() === "") body.shift();
      while (body.length && body[body.length - 1].trim() === "") body.pop();
      templates.push({ category: current.category, title: current.title, body: body.join("\n") });
    }
    current = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
      const level = heading[1].length;
      const headingText = stripBold(heading[2]);

      if (/^table of contents$/i.test(headingText)) {
        flush();
        skipping = true;
        currentCategory = null;
        continue;
      }
      if (level <= 2) {
        flush();
        skipping = false;
        if (level === 2) currentCategory = headingText;
        continue;
      }
      if (level === 3) {
        if (skipping || !currentCategory) continue;
        flush();
        current = { title: headingText, category: currentCategory, body: [] };
        continue;
      }
      continue;
    }

    if (skipping) continue;

    // Standard Teleconsult Blocks' sub-items are bold-only paragraphs,
    // not "### " headings — treat one exactly like a heading.
    const boldOnly = trimmed.match(/^\*\*(.+)\*\*$/);
    if (currentCategory === STANDARD_BLOCKS_HEADING && boldOnly) {
      flush();
      const title = stripBold(trimmed).replace(/:$/, "").trim();
      current = { title, category: STANDARD_BLOCKS_CATEGORY, body: [] };
      continue;
    }

    if (isDivider(trimmed)) continue;
    if (current) current.body.push(line);
  }
  flush();

  return templates;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let docText: string;
  try {
    const accessToken = await getAccessToken();
    docText = await fetchDocMarkdown(accessToken);
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

  const { data: existingRow } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "teletemplates")
    .maybeSingle();

  const templateIds = new Set(templates.map((t) => t.id));
  const existingStarred: unknown = existingRow?.state?.starred;
  const starred = Array.isArray(existingStarred) ? existingStarred.filter((id) => templateIds.has(id)) : [];

  const { error } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app: "teletemplates", state: { templates, starred }, updated_at: new Date().toISOString() });
  if (error) {
    console.error(error);
    return new Response(`error writing app_state: ${error.message}`, { status: 500 });
  }

  return new Response(`synced ${templates.length} templates across ${new Set(templates.map((t) => t.category)).size} categories`);
});
