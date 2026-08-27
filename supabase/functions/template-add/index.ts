// Supabase Edge Function: lets templates-app add a brand-new template to
// the live source Google Doc — WILLOW TM for Teleconsult, or WILLOW for
// In-Clinic — rather than only editing an existing one (see
// template-edit). Excludes "Standard Blocks" (Teleconsult only), which
// uses a different bold-only-paragraph convention (see sheet-
// teletemplates-sync's STANDARD_BLOCKS_HEADING handling) rather than
// "### " headings.
//
// Called by the app itself as the signed-in user (SupaSync.invokeFunction),
// same auth pattern as template-edit: verify_jwt on, resolved user id
// checked against WILLOW_USER_ID, CORS handled explicitly since this is
// a cross-origin browser call unlike the cron-only sheet-sync functions.
//
// The two docs need genuinely different insertion strategies, mirroring
// how sheet-templates-sync and sheet-teletemplates-sync parse them
// differently:
//
//   Teleconsult (WILLOW TM, "heading" kind) — categories are their own
//   "## " headings in the live doc, so the target category is looked up
//   directly: exactly one "## " heading matching the category name is
//   required (0 or >1 aborts), and the new template is appended right
//   before the next "## "-or-higher heading (or end of doc).
//
//   In-Clinic (WILLOW, "separator" kind) — categories are NOT headings
//   in the doc at all; sheet-templates-sync assigns each block's category
//   by walking the doc's own table of contents in step with the body (see
//   that function's own comments), so there's no single heading to anchor
//   on. Instead: take the LAST existing template already stored under the
//   chosen category (app_state's own array order mirrors doc order, since
//   sheet-templates-sync appends templates as it encounters them
//   top-to-bottom) as an anchor, locate that exact template's title
//   paragraph in the live doc (same title-matching logic as
//   template-edit's own locateTemplate, since an anchor's "title" may
//   itself be an embedded age-variant marker line rather than a
//   "===="-preceded one), then scan forward for the next REAL "===="
//   separator — deliberately skipping over any embedded age-variant
//   marker lines along the way, so a new entry never gets spliced into
//   the middle of an existing multi-variant block (which would otherwise
//   carve a variant like "Balanitis (Paeds)" out into its own separate
//   raw block and change how the doc's *existing* content parses). The
//   new template is appended right after that real separator's line —
//   i.e. right after the anchor's own combined block ends — with its own
//   new "====" separator so the following block's boundary is preserved
//   unchanged. Since sheet-templates-sync assigns category purely by
//   sequential TOC-matching (a title with no TOC entry just inherits
//   whatever category is "current" when that block is reached — the same
//   fallback age-variants rely on), appending right after the last real
//   block of the chosen category makes the parser assign it that same
//   category correctly, with no TOC entry required.
//
// Safety design, mirroring template-edit's caution for both doc kinds:
//   1. The insertion anchor (a "## " heading for Teleconsult, an existing
//      template's title paragraph for In-Clinic) must match EXACTLY once
//      in the doc's live paragraph structure — 0 or >1 aborts with a
//      clear error — so a stale/renamed doc can't silently insert in the
//      wrong place.
//   2. The new template's title must not already exist among the
//      currently-synced templates for that app (case-insensitive) —
//      refuses to create an accidental duplicate.
//   3. Insertion only ever appends at a section boundary already computed
//      from the live doc — never touches or reorders any existing
//      content.
//   4. The inserted text is PLAIN text only. For Teleconsult, heading
//      level (Heading 3) and bold are applied afterward via separate,
//      narrowly-scoped updateParagraphStyle/updateTextStyle requests
//      targeting only the new title paragraph's own exact range — never a
//      broad range, unlike the earlier template-cleanup incident that
//      corrupted heading levels doc-wide via an imprecise style update.
//      IMPORTANT caveat learned the hard way: the insertion point sits at
//      the START of the next boundary paragraph. Docs' insertText SPLITS
//      that paragraph at the insertion point, and every new paragraph
//      created by the inserted text's own newlines inherits that split
//      paragraph's style — i.e. the whole inserted block silently came
//      back as HEADING_2 + bold, not NORMAL_TEXT, because that's what the
//      following category heading was. Fix, for both doc kinds: explicitly
//      reset the ENTIRE inserted range to NORMAL_TEXT + not bold FIRST,
//      then (Teleconsult only) re-apply HEADING_3 + bold to only the title
//      paragraph as a later, overriding request. In-Clinic's own parser
//      (sheet-templates-sync) never looks at paragraph style at all — it's
//      a plain-text export parsed purely by "====" separator text and
//      table-of-contents matching — so this reset there is a cosmetic
//      safeguard against an ugly inherited style, not a correctness fix,
//      but it's cheap enough to apply uniformly rather than special-case.
//   5. writeControl.requiredRevisionId locks the whole batchUpdate to the
//      revision just read, so a concurrent doc edit fails the call
//      cleanly instead of clobbering it.
//
// Pass `dryRun: true` to compute and return the insertion point and
// preview text without writing anything — used to verify correctness
// against the real live docs before ever issuing a real write. In-Clinic
// verification, in particular, went through a read-only preview mode
// added temporarily to template-cleanup (an already admin-secret-
// authenticated function) since this function itself needs real user
// auth that can't be faked to test it directly — same pattern used to
// verify the Teleconsult version originally.
//
// On a successful real write, the new template is also appended to
// app_state[app].templates immediately (preserving `starred` and every
// other existing template unchanged), and the matching sheet sync
// (sheet-templates-sync or sheet-teletemplates-sync) is re-triggered so
// the doc's own re-parse is cross-checked against what this function just
// wrote.
//
// Required secrets: none new — reuses GOOGLE_SERVICE_ACCOUNT_EMAIL/
// PRIVATE_KEY, GOOGLE_WILLOW_DOC_ID, GOOGLE_WILLOW_TM_DOC_ID,
// WILLOW_USER_ID, DB_WEBHOOK_SECRET, SUPABASE_URL. Same Editor access on
// both docs already granted for template-edit.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const STANDARD_BLOCKS_CATEGORY = "Standard Blocks";

type DocKind = "separator" | "heading";

interface AppConfig {
  docIdEnv: string;
  kind: DocKind;
  syncFunction: string;
}

const APP_CONFIGS: Record<string, AppConfig> = {
  templates: { docIdEnv: "GOOGLE_WILLOW_DOC_ID", kind: "separator", syncFunction: "sheet-templates-sync" },
  teletemplates: { docIdEnv: "GOOGLE_WILLOW_TM_DOC_ID", kind: "heading", syncFunction: "sheet-teletemplates-sync" },
};

const SEPARATOR_RE = /^=+$/;
const MIN_SEPARATOR_LEN = 10;
const NEW_SEPARATOR_LINE = "=".repeat(20);
const AGE_KEYWORDS = new Set(["paeds", "paed", "paediatric", "pediatric", "child", "children", "kids", "kid", "adults", "adult"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

async function getAccessToken(): Promise<string> {
  const jwt = new JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/documents"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

interface TextRun {
  content: string;
  textStyle?: { bold?: boolean };
}
interface ParagraphElement {
  textRun?: TextRun;
}
interface DocParagraph {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
}
interface DocStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocParagraph;
}
interface DocsDocument {
  revisionId: string;
  body?: { content?: DocStructuralElement[] };
}

interface Para {
  startIndex: number;
  endIndex: number;
  trimmed: string;
  headingLevel: number | null;
  boldOnly: boolean;
}

function extractParagraphs(doc: DocsDocument): Para[] {
  const out: Para[] = [];
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph || el.startIndex === undefined || el.endIndex === undefined) continue;
    const runs = el.paragraph.elements ?? [];
    const text = runs.map((r) => r.textRun?.content ?? "").join("");
    const style = el.paragraph.paragraphStyle?.namedStyleType ?? "";
    const headingMatch = /^HEADING_([1-3])$/.exec(style);
    const nonEmptyRuns = runs.filter((r) => r.textRun && r.textRun.content.trim() !== "");
    const boldOnly = nonEmptyRuns.length > 0 && nonEmptyRuns.every((r) => r.textRun!.textStyle?.bold === true);
    out.push({
      startIndex: el.startIndex,
      endIndex: el.endIndex,
      trimmed: text.trim(),
      headingLevel: headingMatch ? Number(headingMatch[1]) : null,
      boldOnly,
    });
  }
  return out;
}

function isSeparator(p: Para): boolean {
  return p.trimmed.length >= MIN_SEPARATOR_LEN && SEPARATOR_RE.test(p.trimmed);
}

function isAgeVariantMarker(p: Para): boolean {
  const s = p.trimmed;
  if (!s || s.length > 30 || s.endsWith(":")) return false;
  const firstWord = (s.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (AGE_KEYWORDS.has(firstWord)) return true;
  const m = s.match(/\(([a-zA-Z]+)\)\s*$/);
  return m !== null && AGE_KEYWORDS.has(m[1].toLowerCase());
}

// A "boundary" paragraph marks the start of the next template (or
// sub-template) for TITLE-MATCHING purposes — mirrors template-edit's own
// isBoundary exactly, since an anchor's title may itself be an embedded
// age-variant marker line.
function isBoundary(p: Para, kind: DocKind): boolean {
  if (kind === "separator") return isSeparator(p) || isAgeVariantMarker(p);
  return p.headingLevel !== null || p.boldOnly;
}

const SEPARATOR_TITLE_SCAN_LINES = 4;

// Finds the title paragraph index for a known title, requiring EXACTLY
// one match — mirrors template-edit's own locateTemplate title-finding
// (not the body-range part, which this function doesn't need).
function findTitleParagraphIndex(paras: Para[], kind: DocKind, title: string): number | { matches: number } {
  const candidateIdxs = new Set<number>();
  paras.forEach((p, i) => {
    if (!isBoundary(p, kind)) return;
    if (kind === "heading") {
      if (p.trimmed === title) candidateIdxs.add(i);
      return;
    }
    if (!isSeparator(p)) {
      if (p.trimmed === title) candidateIdxs.add(i); // age-variant marker
      return;
    }
    let j = i + 1;
    let scanned = 0;
    while (j < paras.length && scanned < SEPARATOR_TITLE_SCAN_LINES && !isBoundary(paras[j], kind)) {
      if (paras[j].trimmed === "") {
        j++;
        continue;
      }
      if (paras[j].trimmed === title) {
        candidateIdxs.add(j);
        break;
      }
      scanned++;
      j++;
    }
  });
  if (candidateIdxs.size !== 1) return { matches: candidateIdxs.size };
  return [...candidateIdxs][0];
}

async function fetchDoc(accessToken: string, docId: string): Promise<DocsDocument> {
  const fields =
    "revisionId,body(content(startIndex,endIndex,paragraph(paragraphStyle.namedStyleType,elements(textRun(content,textStyle.bold)))))";
  const url = `https://docs.googleapis.com/v1/documents/${docId}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Docs get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function triggerResync(syncFunction: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/${syncFunction}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": WEBHOOK_SECRET },
      body: "{}",
    });
  } catch {
    // best-effort — the next scheduled 10-minute sync will pick it up regardless
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse(401, { error: "missing Authorization header" });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user || authData.user.id !== USER_ID) {
    return jsonResponse(403, { error: "not authorized" });
  }

  let payload: { app?: string; category?: string; title?: string; body?: string; dryRun?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const app = payload.app ?? "";
  const config = APP_CONFIGS[app];
  if (!config) return jsonResponse(400, { error: `unknown app "${app}"` });

  const category = (payload.category ?? "").trim();
  const title = (payload.title ?? "").trim();
  const bodyText = (payload.body ?? "").trim();
  if (!category || !title || !bodyText) {
    return jsonResponse(400, { error: "category, title, and body are required" });
  }
  if (app === "teletemplates" && category === STANDARD_BLOCKS_CATEGORY) {
    return jsonResponse(400, { error: "adding to Standard Blocks isn't supported yet" });
  }

  const docId = Deno.env.get(config.docIdEnv);
  if (!docId) return jsonResponse(500, { error: `${config.docIdEnv} is not set` });

  const { data: row, error: rowError } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", app)
    .maybeSingle();
  if (rowError) return jsonResponse(500, { error: `error reading app_state: ${rowError.message}` });

  const templates: Array<{ id: string; category: string; title: string; body: string }> = row?.state?.templates ?? [];
  const categories = new Set(templates.map((t) => t.category));
  if (!categories.has(category)) {
    return jsonResponse(400, { error: `"${category}" isn't a known category` });
  }
  if (templates.some((t) => t.title.trim().toLowerCase() === title.toLowerCase())) {
    return jsonResponse(409, { error: `a template titled "${title}" already exists` });
  }

  let accessToken: string;
  let doc: DocsDocument;
  try {
    accessToken = await getAccessToken();
    doc = await fetchDoc(accessToken, docId);
  } catch (err) {
    return jsonResponse(500, { error: `error reading doc: ${err}` });
  }

  const paras = extractParagraphs(doc);

  let insertAt: number;
  let atDocEnd: boolean;
  let titleParaStart: number | null = null; // only meaningful for "heading" kind
  let titleParaEnd = 0;
  let insertTextStr: string;

  if (config.kind === "heading") {
    const categoryIdxs: number[] = [];
    paras.forEach((p, i) => {
      if (p.headingLevel === 2 && p.trimmed === category) categoryIdxs.push(i);
    });
    if (categoryIdxs.length === 0) {
      return jsonResponse(409, { error: `couldn't find "${category}" in the doc — it may have been renamed; refresh and try again` });
    }
    if (categoryIdxs.length > 1) {
      return jsonResponse(409, { error: `found "${category}" more than once in the doc — refusing to guess which one` });
    }
    const categoryIdx = categoryIdxs[0];

    let nextHeadingIdx = paras.length;
    for (let i = categoryIdx + 1; i < paras.length; i++) {
      if (paras[i].headingLevel !== null && paras[i].headingLevel! <= 2) {
        nextHeadingIdx = i;
        break;
      }
    }

    // The Docs API refuses a range/insertion touching the very last
    // newline of the document body segment — insert one character before
    // the true end in that case, same rule template-edit/template-cleanup
    // already established.
    atDocEnd = nextHeadingIdx === paras.length;
    insertAt = atDocEnd ? paras[paras.length - 1].endIndex - 1 : paras[nextHeadingIdx].startIndex;

    // Plain text only — no markdown syntax, no style embedded in the
    // string itself. Heading level and bold are applied afterward via
    // their own narrowly-scoped requests below.
    insertTextStr = `\n${title}\n${bodyText}\n\n`;
    titleParaStart = insertAt + 1; // past the leading blank-paragraph newline
    titleParaEnd = titleParaStart + title.length + 1; // past the title's own newline
  } else {
    // "separator" kind (In-Clinic) — anchor on the LAST existing template
    // already stored under this category (app_state's array order mirrors
    // doc order), locate its title paragraph, then scan forward for the
    // next REAL separator only — skipping over any embedded age-variant
    // marker lines so a new entry can't get spliced into the middle of an
    // existing multi-variant block.
    const categoryTemplates = templates.filter((t) => t.category === category);
    const anchor = categoryTemplates[categoryTemplates.length - 1];
    if (!anchor) return jsonResponse(500, { error: `no existing template found under "${category}" to anchor on` });

    const anchorIdx = findTitleParagraphIndex(paras, config.kind, anchor.title);
    if (typeof anchorIdx !== "number") {
      return jsonResponse(409, {
        error:
          anchorIdx.matches === 0
            ? `couldn't find the anchor template "${anchor.title}" in the doc — it may have been renamed; refresh and try again`
            : `found the anchor template "${anchor.title}" more than once in the doc — refusing to guess which one`,
      });
    }

    let separatorIdx = paras.length;
    for (let i = anchorIdx + 1; i < paras.length; i++) {
      if (isSeparator(paras[i])) {
        separatorIdx = i;
        break;
      }
    }

    atDocEnd = separatorIdx === paras.length;
    insertAt = atDocEnd ? paras[paras.length - 1].endIndex - 1 : paras[separatorIdx].endIndex;

    // No leading blank paragraph needed — insertAt already sits right at
    // the start of the paragraph following the real separator (or right
    // before the doc's own final newline), so the separator itself
    // already provides visual spacing. A trailing separator closes off
    // the new block the same way every other block is closed.
    insertTextStr = `${title}\n${bodyText}\n\n${NEW_SEPARATOR_LINE}\n\n`;
    titleParaStart = insertAt;
    titleParaEnd = titleParaStart + title.length + 1;
  }

  if (payload.dryRun) {
    return jsonResponse(200, {
      ok: true,
      dryRun: true,
      app,
      category,
      title,
      insertAt,
      atEndOfDoc: atDocEnd,
      preview: insertTextStr,
    });
  }

  // The full inserted block, in the post-insertText document.
  const insertedRangeStart = insertAt;
  const insertedRangeEnd = insertAt + insertTextStr.length;

  const requests: unknown[] = [
    { insertText: { location: { index: insertAt }, text: insertTextStr } },
    // Force the WHOLE inserted block back to plain style first — it
    // otherwise inherits the style of whichever paragraph it split (see
    // the caveat in the header comment above), not NORMAL_TEXT. For
    // "separator" kind this is a cosmetic safeguard only (sheet-
    // templates-sync's parser never looks at paragraph style), but it's
    // cheap to apply uniformly.
    {
      updateParagraphStyle: {
        range: { startIndex: insertedRangeStart, endIndex: insertedRangeEnd },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: insertedRangeStart, endIndex: insertedRangeEnd },
        textStyle: { bold: false },
        fields: "bold",
      },
    },
  ];

  if (config.kind === "heading") {
    // Then re-apply Heading 3 + bold to only the title paragraph, as a
    // later (overriding) request.
    requests.push(
      {
        updateParagraphStyle: {
          range: { startIndex: titleParaStart, endIndex: titleParaEnd },
          paragraphStyle: { namedStyleType: "HEADING_3" },
          fields: "namedStyleType",
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: titleParaStart!, endIndex: titleParaStart! + title.length },
          textStyle: { bold: true },
          fields: "bold",
        },
      },
    );
  }

  const batchUrl = `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: doc.revisionId } }),
  });
  if (!batchRes.ok) {
    const errText = await batchRes.text();
    const conflict = batchRes.status === 400 && /revision/i.test(errText);
    return jsonResponse(conflict ? 409 : 500, {
      error: conflict ? "the doc changed since this was loaded — refresh and try again" : `Docs batchUpdate failed: ${batchRes.status} ${errText}`,
    });
  }

  let base = `${slugify(category)}-${slugify(title)}` || "template";
  let id = base;
  const existingIds = new Set(templates.map((t) => t.id));
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n++;
  }

  const updatedTemplates = [...templates, { id, category, title, body: bodyText }];
  const { error: updateError } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app, state: { ...row!.state, templates: updatedTemplates }, updated_at: new Date().toISOString() });

  await triggerResync(config.syncFunction);

  if (updateError) {
    return jsonResponse(200, { ok: true, id, warning: `doc updated, but app_state refresh failed: ${updateError.message}` });
  }

  return jsonResponse(200, { ok: true, id });
});
