// Supabase Edge Function: lets templates-app add a brand-new template to
// the live WILLOW TM (Teleconsult) Google Doc, rather than only editing
// an existing one (see template-edit). Scoped to Teleconsult only for
// now — WILLOW's (In-Clinic) category assignment is driven by matching
// each block's title against the doc's own table of contents in order
// (see sheet-templates-sync), so a brand-new title with no TOC entry
// would silently inherit whatever category happens to precede it in the
// doc rather than the category the user actually chose. WILLOW TM's
// categories are plain "## " headings instead, so inserting within the
// chosen category's own heading-bounded section is straightforward and
// safe. Also excludes the "Standard Blocks" category, which uses a
// different bold-only-paragraph convention (see sheet-teletemplates-
// sync's STANDARD_BLOCKS_HEADING handling) rather than "### " headings.
//
// Called by the app itself as the signed-in user (SupaSync.invokeFunction),
// same auth pattern as template-edit: verify_jwt on, resolved user id
// checked against WILLOW_USER_ID, CORS handled explicitly since this is
// a cross-origin browser call unlike the cron-only sheet-sync functions.
//
// Safety design, mirroring template-edit's caution:
//   1. The target category must match an EXISTING "## " heading in the
//      doc's live paragraph structure — exactly one match required (0 or
//      >1 aborts with a clear error) — so a stale/renamed category can't
//      silently create a new, wrong section.
//   2. The new template's title must not already exist among the
//      currently-synced templates (case-insensitive) — refuses to create
//      an accidental duplicate.
//   3. Insertion point is the very end of the chosen category's section
//      (right before the next "## "-or-higher heading, or end of doc if
//      it's the last category) — appends only, never touches or
//      reorders any existing content.
//   4. The inserted text is PLAIN text only — heading level (Heading 3)
//      and bold are applied afterward via separate, narrowly-scoped
//      updateParagraphStyle/updateTextStyle requests targeting only the
//      new title paragraph's own exact range (fields limited to
//      namedStyleType / bold respectively) — never a broad range, unlike
//      the earlier template-cleanup incident that corrupted heading
//      levels doc-wide via an imprecise style update.
//      IMPORTANT caveat learned the hard way (see incident below): the
//      insertion point sits at the START of the next boundary paragraph
//      (the next "## " category heading, or "### " for a mid-section
//      insert). Docs' insertText SPLITS that paragraph at the insertion
//      point, and every new paragraph created by the inserted text's own
//      newlines inherits that split paragraph's style — i.e. the whole
//      inserted block (blank lead-in, title, every body line) silently
//      came back as HEADING_2 + bold, not NORMAL_TEXT, because that's
//      what the following category heading was. The title-only override
//      masked this for the title line but left the body corrupted. Fix:
//      explicitly reset the ENTIRE inserted range to NORMAL_TEXT + not
//      bold FIRST, then re-apply HEADING_3 + bold to only the title
//      paragraph as a later, overriding request — never rely on "plain
//      insertText defaults to plain style," since it inherits neighbor
//      style instead.
//   5. writeControl.requiredRevisionId locks the whole batchUpdate to the
//      revision just read, so a concurrent doc edit fails the call
//      cleanly instead of clobbering it.
//
// Pass `dryRun: true` to compute and return the insertion point and
// preview text without writing anything — used to verify correctness
// against the real live doc before ever issuing a real write.
//
// On a successful real write, the new template is also appended to
// app_state.teletemplates.templates immediately (preserving `starred`
// and every other existing template unchanged), and
// sheet-teletemplates-sync is re-triggered so the doc's own re-parse is
// cross-checked against what this function just wrote.
//
// Required secrets: none new — reuses GOOGLE_SERVICE_ACCOUNT_EMAIL/
// PRIVATE_KEY, GOOGLE_WILLOW_TM_DOC_ID, WILLOW_USER_ID, DB_WEBHOOK_SECRET,
// SUPABASE_URL. Same Editor access on WILLOW TM already granted for
// template-edit.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const DOC_ID = Deno.env.get("GOOGLE_WILLOW_TM_DOC_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const STANDARD_BLOCKS_CATEGORY = "Standard Blocks";

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

async function fetchDoc(accessToken: string): Promise<DocsDocument> {
  const fields =
    "revisionId,body(content(startIndex,endIndex,paragraph(paragraphStyle.namedStyleType,elements(textRun(content,textStyle.bold)))))";
  const url = `https://docs.googleapis.com/v1/documents/${DOC_ID}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Docs get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function triggerResync(): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/sheet-teletemplates-sync`, {
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

  let payload: { category?: string; title?: string; body?: string; dryRun?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const category = (payload.category ?? "").trim();
  const title = (payload.title ?? "").trim();
  const bodyText = (payload.body ?? "").trim();
  if (!category || !title || !bodyText) {
    return jsonResponse(400, { error: "category, title, and body are required" });
  }
  if (category === STANDARD_BLOCKS_CATEGORY) {
    return jsonResponse(400, { error: "adding to Standard Blocks isn't supported yet" });
  }

  const { data: row, error: rowError } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "teletemplates")
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
    doc = await fetchDoc(accessToken);
  } catch (err) {
    return jsonResponse(500, { error: `error reading doc: ${err}` });
  }

  const paras = extractParagraphs(doc);
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
  const atDocEnd = nextHeadingIdx === paras.length;
  const insertAt = atDocEnd ? paras[paras.length - 1].endIndex - 1 : paras[nextHeadingIdx].startIndex;

  // Plain text only — no markdown syntax, no style embedded in the
  // string itself. Heading level and bold are applied afterward via
  // their own narrowly-scoped requests below.
  const insertTextStr = `\n${title}\n${bodyText}\n\n`;
  const titleParaStart = insertAt + 1; // past the leading blank-paragraph newline
  const titleParaEnd = titleParaStart + title.length + 1; // past the title's own newline

  if (payload.dryRun) {
    return jsonResponse(200, {
      ok: true,
      dryRun: true,
      category,
      title,
      insertAt,
      atEndOfDoc: atDocEnd,
      preview: insertTextStr,
    });
  }

  // The full inserted block, in the post-insertText document — spans the
  // leading blank paragraph through the trailing blank paragraph.
  const insertedRangeStart = insertAt;
  const insertedRangeEnd = insertAt + insertTextStr.length;

  const requests = [
    { insertText: { location: { index: insertAt }, text: insertTextStr } },
    // Force the WHOLE inserted block back to plain style first — it
    // otherwise inherits the style of whichever paragraph it split (see
    // the caveat in the header comment above), not NORMAL_TEXT.
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
    // Then re-apply Heading 3 + bold to only the title paragraph, as a
    // later (overriding) request.
    {
      updateParagraphStyle: {
        range: { startIndex: titleParaStart, endIndex: titleParaEnd },
        paragraphStyle: { namedStyleType: "HEADING_3" },
        fields: "namedStyleType",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: titleParaStart, endIndex: titleParaStart + title.length },
        textStyle: { bold: true },
        fields: "bold",
      },
    },
  ];

  const batchUrl = `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`;
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
    .upsert({ user_id: USER_ID, app: "teletemplates", state: { ...row!.state, templates: updatedTemplates }, updated_at: new Date().toISOString() });

  await triggerResync();

  if (updateError) {
    return jsonResponse(200, { ok: true, id, warning: `doc updated, but app_state refresh failed: ${updateError.message}` });
  }

  return jsonResponse(200, { ok: true, id });
});
