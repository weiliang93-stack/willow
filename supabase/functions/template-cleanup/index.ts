// Supabase Edge Function: one-time maintenance operation that strips
// stray blank paragraphs out of every teleconsult template's body in the
// live WILLOW TM Google Doc — the doc was originally typed with a blank
// paragraph after nearly every line, which sheet-teletemplates-sync
// faithfully carries into each template's `body` (30-50+ blank lines per
// template, vs. single digits in the WILLOW doc, which wasn't typed that
// way). Fixing app_state alone wouldn't stick: the next periodic sync
// would just re-pull the doc's still-unedited spacing and overwrite it,
// so this edits the doc itself.
//
// Admin/cron-style function (not called by the app) — same
// x-webhook-secret pattern as budget-alert/sheet-*-sync, triggered
// manually for this one-off cleanup rather than on a schedule.
//
// Pass `dryRun: true` to just report how many blank paragraphs would be
// removed, across how many templates, without writing anything — meant
// to be reviewed before the real (non-dry-run) call.
//
// Safety: only ever deletes a paragraph that is already empty once
// trimmed (so there is never any real content to lose), and only when
// it falls strictly inside a recognized template's body range (between
// one boundary/title paragraph and the next) — titles, headings, and
// the doc's "Table of Contents" block (skipped by title, same as
// sheet-teletemplates-sync) are never touched. All deletions are sent
// as one batchUpdate, highest paragraph index first (so earlier
// deletions never invalidate indices used by later ones in the same
// call), locked to the doc's revisionId read at the start of the call —
// if the doc changes mid-operation, the whole call fails cleanly rather
// than applying half the edit.
//
// On a successful real run, also immediately re-triggers
// sheet-teletemplates-sync (using the same secret, read from this
// function's own env — never exposed outside it) so the app reflects
// the cleaned-up doc right away instead of waiting for the next
// scheduled sync.
//
// Required secrets: none new — reuses GOOGLE_SERVICE_ACCOUNT_EMAIL/
// PRIVATE_KEY, GOOGLE_WILLOW_TM_DOC_ID, DB_WEBHOOK_SECRET, SUPABASE_URL.

import { JWT } from "npm:google-auth-library@9";

const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const DOC_ID = Deno.env.get("GOOGLE_WILLOW_TM_DOC_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

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

function isBoundary(p: Para): boolean {
  return p.headingLevel !== null || p.boldOnly;
}

function titleText(p: Para): string {
  if (p.headingLevel === null && p.boldOnly) return p.trimmed.replace(/:$/, "").trim();
  return p.trimmed;
}

async function fetchDoc(accessToken: string): Promise<DocsDocument> {
  const fields = "revisionId,body(content(startIndex,endIndex,paragraph(paragraphStyle.namedStyleType,elements(textRun(content,textStyle.bold)))))";
  const url = `https://docs.googleapis.com/v1/documents/${DOC_ID}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Docs get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

interface BlankTarget {
  startIndex: number;
  endIndex: number;
}

interface TemplateBlanks {
  title: string;
  blankCount: number;
}

function findBlankTargets(paras: Para[]): { targets: BlankTarget[]; perTemplate: TemplateBlanks[] } {
  const boundaryIdxs: number[] = [];
  paras.forEach((p, i) => {
    if (isBoundary(p)) boundaryIdxs.push(i);
  });

  const targets: BlankTarget[] = [];
  const perTemplate: TemplateBlanks[] = [];

  for (let b = 0; b < boundaryIdxs.length; b++) {
    const titleIdx = boundaryIdxs[b];
    const title = titleText(paras[titleIdx]);
    if (title.toLowerCase() === "table of contents") continue; // mirrors sheet-teletemplates-sync's own skip

    const bodyEnd = b + 1 < boundaryIdxs.length ? boundaryIdxs[b + 1] : paras.length;
    let blankCount = 0;
    for (let i = titleIdx + 1; i < bodyEnd; i++) {
      if (paras[i].trimmed === "") {
        targets.push({ startIndex: paras[i].startIndex, endIndex: paras[i].endIndex });
        blankCount++;
      }
    }
    if (blankCount > 0) perTemplate.push({ title, blankCount });
  }

  return { targets, perTemplate };
}

async function applyDeletions(accessToken: string, revisionId: string, targets: BlankTarget[]): Promise<void> {
  // Highest index first, so each deletion is applied against indices
  // that haven't yet been shifted by any deletion later in this list.
  const sorted = [...targets].sort((a, b) => b.startIndex - a.startIndex);
  const requests = sorted.map((t) => ({
    deleteContentRange: { range: { startIndex: t.startIndex, endIndex: t.endIndex } },
  }));

  const url = `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
  });
  if (!res.ok) throw new Error(`Docs batchUpdate failed: ${res.status} ${await res.text()}`);
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
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let payload: { dryRun?: boolean } = {};
  try {
    payload = await req.json();
  } catch {
    // no body is fine — defaults to a real run
  }

  let accessToken: string;
  let doc: DocsDocument;
  try {
    accessToken = await getAccessToken();
    doc = await fetchDoc(accessToken);
  } catch (err) {
    return new Response(`error reading doc: ${err}`, { status: 500 });
  }

  const paras = extractParagraphs(doc);
  const { targets, perTemplate } = findBlankTargets(paras);

  if (payload.dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        dryRun: true,
        blankLinesFound: targets.length,
        templatesAffected: perTemplate.length,
        sample: perTemplate.slice(0, 10),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({ ok: true, blankLinesRemoved: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  try {
    await applyDeletions(accessToken, doc.revisionId, targets);
  } catch (err) {
    return new Response(`error applying cleanup: ${err}`, { status: 500 });
  }

  await triggerResync();

  return new Response(
    JSON.stringify({ ok: true, blankLinesRemoved: targets.length, templatesAffected: perTemplate.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
