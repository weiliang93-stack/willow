// Supabase Edge Function: lets templates-app edit a template's body and
// have that edit written back into the live source Google Doc (WILLOW or
// WILLOW TM, depending on which app the template belongs to) — the one
// place in this repo's sync architecture where an app writes into a doc
// rather than just reading from it. Called by the app itself as the
// signed-in user (via SupaSync.invokeFunction, which attaches the
// session's access token), not by cron — verify_jwt is left on, and the
// resolved user id is checked against WILLOW_USER_ID as a second layer
// (this is a single-user app; app_state's own RLS already scopes by
// auth.uid(), but the service-role client this function uses bypasses
// RLS, so the check here is what actually stops another Supabase user
// from hitting this function and editing the doctor's real doc).
//
// The core problem this solves safely: given a template id, find the
// exact paragraph range in the live doc that holds that template's body,
// and replace only that range — without needing to re-derive the
// title/category decisions sheet-templates-sync's and
// sheet-teletemplates-sync's parsers make (restated-header skipping, TOC
// matching, heading levels). Instead:
//   1. Look up the template's stored `title` (from the last successful
//      sync) in app_state — that string already exists verbatim in the
//      live doc as of that sync.
//   2. Fetch the doc via the Docs API (not the plain-text/markdown
//      export the read syncs use — this needs real paragraph start/end
//      indices to build a batchUpdate request) and search for paragraphs
//      whose text exactly matches that title (restricted to paragraph
//      shapes each doc's read sync actually treats as titles — see
//      TITLE_CANDIDATE below).
//   3. Require EXACTLY one match. Zero means the doc changed (title
//      renamed/removed) since the last sync; more than one means an
//      ambiguous doc we refuse to guess at. Either way this aborts with
//      a clear error rather than editing the wrong section — the one
//      invariant this function must never violate, since a wrong edit
//      here corrupts the doctor's real clinical reference document, not
//      just a cached copy of it.
//   4. Find the body's end boundary by scanning forward for the next
//      "new template" marker (a "====" separator or an embedded
//      age-variant heading for WILLOW; a heading or bold-only paragraph
//      for WILLOW TM — the same markers each read parser treats as
//      block/template boundaries), then trim to the innermost non-blank
//      paragraphs so the surrounding blank-line spacing is preserved.
//   5. batchUpdate a delete-then-insert over that inner range, with
//      writeControl.requiredRevisionId set to the revision just read —
//      if the doc changed between steps 2 and 5, the whole call fails
//      cleanly instead of silently overwriting a concurrent edit.
//
// Pass `dryRun: true` in the request body to run steps 1-4 and return
// what would be changed (matched title, computed range, current text in
// that range) without calling batchUpdate or touching app_state — used
// to verify the matching/boundary logic against the real live docs
// before ever issuing a real write.
//
// On a successful real write, the corresponding template's `body` in
// app_state is also updated immediately (rather than waiting for the
// next periodic sync), preserving every other field including `starred`.
//
// Required secrets, beyond what the sheet-sync functions already use:
//   (none new — reuses GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY,
//   GOOGLE_WILLOW_DOC_ID, GOOGLE_WILLOW_TM_DOC_ID, WILLOW_USER_ID)
// The service account needs Editor (not just Viewer) access to both
// docs for this to work.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type DocKind = "separator" | "heading";

interface AppConfig {
  docIdEnv: string;
  kind: DocKind;
}

const APP_CONFIGS: Record<string, AppConfig> = {
  templates: { docIdEnv: "GOOGLE_WILLOW_DOC_ID", kind: "separator" },
  teletemplates: { docIdEnv: "GOOGLE_WILLOW_TM_DOC_ID", kind: "heading" },
};

const SEPARATOR_RE = /^=+$/;
const MIN_SEPARATOR_LEN = 10;
const AGE_KEYWORDS = new Set(["paeds", "paed", "paediatric", "pediatric", "child", "children", "kids", "kid", "adults", "adult"]);

// Called directly from the browser (templates-app, on a different origin
// than *.supabase.co), unlike every other function here which is only
// ever called server-to-server by cron — so, unlike those, this one
// needs to answer the browser's CORS preflight OPTIONS request (which
// never carries the Authorization header) and echo CORS headers on every
// response, or the browser rejects the real request before it's ever sent.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
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
  text: string;
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
    const trimmed = text.trim();
    const style = el.paragraph.paragraphStyle?.namedStyleType ?? "";
    const headingMatch = /^HEADING_([1-3])$/.exec(style);
    const nonEmptyRuns = runs.filter((r) => r.textRun && r.textRun.content.trim() !== "");
    const boldOnly = nonEmptyRuns.length > 0 && nonEmptyRuns.every((r) => r.textRun!.textStyle?.bold === true);
    out.push({
      startIndex: el.startIndex,
      endIndex: el.endIndex,
      text,
      trimmed,
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
// sub-template) — used both to know where THIS template's body ends and
// to know which paragraphs even qualify as a title in the first place.
function isBoundary(p: Para, kind: DocKind): boolean {
  if (kind === "separator") return isSeparator(p) || isAgeVariantMarker(p);
  return p.headingLevel !== null || p.boldOnly;
}

// For heading-kind docs (WILLOW TM) the boundary paragraph IS the title
// paragraph. For separator-kind docs (WILLOW), a "====" boundary
// paragraph is NOT itself the title — the title is the next non-blank
// paragraph after it — while an embedded age-variant marker boundary
// (e.g. "Balanitis (Paeds)", no preceding "====") IS its own title
// paragraph. Returns null if a trailing "====" has no following content.
function titleParagraphIndex(paras: Para[], boundaryIdx: number, kind: DocKind): number | null {
  if (kind === "heading") return boundaryIdx;
  if (!isSeparator(paras[boundaryIdx])) return boundaryIdx; // age-variant marker
  let i = boundaryIdx + 1;
  while (i < paras.length && paras[i].trimmed === "") i++;
  return i < paras.length ? i : null;
}

// The text a title paragraph would have been stored as a template title
// under (mirrors each read parser's own title cleanup): a heading-kind
// bold-only paragraph (WILLOW TM's "Standard Blocks" sub-items) has its
// trailing colon stripped, matching sheet-teletemplates-sync's
// `stripBold(...).replace(/:$/, "")`; everything else compares as-is.
function titleText(p: Para, kind: DocKind): string {
  if (kind === "heading" && p.headingLevel === null && p.boldOnly) return p.trimmed.replace(/:$/, "").trim();
  return p.trimmed;
}

interface MatchResult {
  matches: number;
  titleIdx: number;
  bodyContentStart: number;
  bodyContentEnd: number;
  currentText: string;
}

function locateTemplate(paras: Para[], kind: DocKind, title: string): MatchResult | { matches: number } {
  const candidateIdxs = new Set<number>();
  paras.forEach((p, i) => {
    if (!isBoundary(p, kind)) return;
    const tIdx = titleParagraphIndex(paras, i, kind);
    if (tIdx === null) return;
    if (titleText(paras[tIdx], kind) === title) candidateIdxs.add(tIdx);
  });
  if (candidateIdxs.size !== 1) return { matches: candidateIdxs.size };

  const titleIdx = [...candidateIdxs][0];
  let boundaryIdx = paras.length;
  for (let i = titleIdx + 1; i < paras.length; i++) {
    if (isBoundary(paras[i], kind)) {
      boundaryIdx = i;
      break;
    }
  }

  // Body spans (titleIdx, boundaryIdx) exclusive of both ends; trim to
  // the innermost non-blank paragraphs so surrounding blank-line spacing
  // in the doc is left untouched.
  let start = titleIdx + 1;
  while (start < boundaryIdx && paras[start].trimmed === "") start++;
  let end = boundaryIdx - 1;
  while (end >= start && paras[end].trimmed === "") end--;

  if (start > end) {
    // No non-blank body content at all (shouldn't happen for a real
    // template) — insert right after the title paragraph.
    const at = paras[titleIdx].endIndex;
    return { matches: 1, titleIdx, bodyContentStart: at, bodyContentEnd: at, currentText: "" };
  }

  const bodyContentStart = paras[start].startIndex;
  const bodyContentEnd = paras[end].endIndex;
  const currentText = paras
    .slice(start, end + 1)
    .map((p) => p.text)
    .join("")
    .replace(/\n+$/, "");

  return { matches: 1, titleIdx, bodyContentStart, bodyContentEnd, currentText };
}

async function fetchDoc(accessToken: string, docId: string): Promise<DocsDocument> {
  const fields = "revisionId,body(content(startIndex,endIndex,paragraph(paragraphStyle.namedStyleType,elements(textRun(content,textStyle.bold)))))";
  const url = `https://docs.googleapis.com/v1/documents/${docId}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Docs get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function applyEdit(
  accessToken: string,
  docId: string,
  revisionId: string,
  range: { bodyContentStart: number; bodyContentEnd: number },
  newBody: string,
): Promise<{ ok: true } | { ok: false; conflict: boolean; message: string }> {
  const textToInsert = newBody.replace(/\n+$/, "") + "\n";
  const requests: unknown[] = [];
  if (range.bodyContentEnd > range.bodyContentStart) {
    requests.push({ deleteContentRange: { range: { startIndex: range.bodyContentStart, endIndex: range.bodyContentEnd } } });
  }
  requests.push({ insertText: { location: { index: range.bodyContentStart }, text: textToInsert } });

  const url = `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
  });
  if (res.ok) return { ok: true };

  const bodyText = await res.text();
  const conflict = res.status === 400 && /revision/i.test(bodyText);
  return { ok: false, conflict, message: `Docs batchUpdate failed: ${res.status} ${bodyText}` };
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
    console.error(
      "template-edit auth rejected:",
      JSON.stringify({ authError: authError?.message, gotUserId: authData?.user?.id, expectedUserId: USER_ID }),
    );
    return jsonResponse(403, { error: "not authorized" });
  }

  let payload: { app?: string; templateId?: string; newBody?: string; dryRun?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const { app, templateId, newBody, dryRun } = payload;
  if (!app || !templateId || typeof newBody !== "string") {
    return jsonResponse(400, { error: "app, templateId, and newBody are required" });
  }
  const config = APP_CONFIGS[app];
  if (!config) return jsonResponse(400, { error: `unknown app "${app}"` });

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
  const template = templates.find((t) => t.id === templateId);
  if (!template) return jsonResponse(404, { error: "template not found" });

  let accessToken: string;
  let doc: DocsDocument;
  try {
    accessToken = await getAccessToken();
    doc = await fetchDoc(accessToken, docId);
  } catch (err) {
    return jsonResponse(500, { error: `error reading doc: ${err}` });
  }

  const paras = extractParagraphs(doc);
  const located = locateTemplate(paras, config.kind, template.title);
  if (located.matches === 0) {
    return jsonResponse(409, { error: `couldn't find "${template.title}" in the doc — it may have been renamed or removed; refresh and try again` });
  }
  if (located.matches > 1) {
    return jsonResponse(409, { error: `found "${template.title}" more than once in the doc — refusing to guess which one; please edit the doc directly this time` });
  }

  const match = located as MatchResult;

  if (dryRun) {
    return jsonResponse(200, {
      ok: true,
      dryRun: true,
      matchedTitle: template.title,
      revisionId: doc.revisionId,
      bodyContentStart: match.bodyContentStart,
      bodyContentEnd: match.bodyContentEnd,
      currentText: match.currentText,
      matchesReadBody: match.currentText === template.body,
    });
  }

  const result = await applyEdit(accessToken, docId, doc.revisionId, match, newBody);
  if (!result.ok) {
    return jsonResponse(result.conflict ? 409 : 500, {
      error: result.conflict
        ? "the doc changed since this was loaded — refresh and try again"
        : result.message,
    });
  }

  const updatedTemplates = templates.map((t) => (t.id === templateId ? { ...t, body: newBody.trim() } : t));
  const { error: updateError } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app, state: { ...row!.state, templates: updatedTemplates }, updated_at: new Date().toISOString() });
  if (updateError) {
    // The doc write already succeeded; only the local cache failed to
    // refresh immediately. The next periodic sync will pick it up, so
    // this isn't a hard failure — just say so.
    return jsonResponse(200, { ok: true, warning: `doc updated, but app_state refresh failed: ${updateError.message}` });
  }

  return jsonResponse(200, { ok: true });
});
