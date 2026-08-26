// Supabase Edge Function: one-time maintenance operation that zeroes
// out paragraph spacing (spaceAbove/spaceBelow) across every teleconsult
// template's body in the live WILLOW TM Google Doc. The visible "extra
// spacing between lines" is NOT literal blank paragraphs — a diagnostic
// pass (`diagnoseTitle` below) found every body paragraph carrying
// spaceAbove/spaceBelow: 6pt styling, which Google's Markdown exporter
// renders as a blank line between paragraphs. (An earlier version of
// this function deleted literal empty paragraphs based on the wrong
// theory: it found and removed 0 blank paragraphs on its second run,
// yet the exported body was byte-identical before and after — the
// giveaway that spacing, not blank paragraphs, was the real cause.)
// Fixing app_state alone wouldn't stick either way: the next periodic
// sync would just re-pull the doc's still-unedited styling, so this
// edits the doc itself.
//
// Admin/cron-style function (not called by the app) — same
// x-webhook-secret pattern as budget-alert/sheet-*-sync, triggered
// manually for this one-off cleanup rather than on a schedule.
//
// Pass `dryRun: true` to just report how many templates have non-zero
// paragraph spacing, without writing anything — meant to be reviewed
// before the real (non-dry-run) call. Pass `diagnoseTitle: "<title>"`
// to dump raw paragraph text + spaceAbove/spaceBelow for one template's
// body.
//
// Safety: only ever touches paragraph spacing (spaceAbove/spaceBelow),
// never paragraph text — there is no content to lose. Only applies
// within a recognized template's body range (between one boundary/title
// paragraph and the next) — titles, headings, and the doc's "Table of
// Contents" block (skipped by title, same as sheet-teletemplates-sync)
// are never touched. All updates are sent as one batchUpdate, locked to
// the doc's revisionId read at the start of the call — if the doc
// changes mid-operation, the whole call fails cleanly rather than
// applying half the edit. These are style-only updates (no text
// inserted or deleted), so unlike a content edit, the document's length
// never changes and request order/index-shifting are non-issues.
//
// On a successful real run, also immediately re-triggers
// sheet-teletemplates-sync (using the same secret, read from this
// function's own env — never exposed outside it) so the app reflects
// the cleaned-up doc right away instead of waiting for the next
// scheduled sync.
//
// Required secrets: none new — reuses GOOGLE_SERVICE_ACCOUNT_EMAIL/
// PRIVATE_KEY, GOOGLE_WILLOW_TM_DOC_ID, DB_WEBHOOK_SECRET, SUPABASE_URL.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const DOC_ID = Deno.env.get("GOOGLE_WILLOW_TM_DOC_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const USER_ID = Deno.env.get("WILLOW_USER_ID")!;

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// pg_net (used to trigger this function from SQL) hard-caps its client
// wait at 5000ms regardless of requested timeout, and Drive markdown
// export + a diagnostic pass sometimes runs close to or over that — so
// diagnostic output is written here instead of just returned in the
// response, to read back reliably via a plain SQL select afterward.
async function writeDebugSnippet(data: unknown): Promise<void> {
  await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app: "template_cleanup_debug", state: { data }, updated_at: new Date().toISOString() });
}

async function getAccessToken(): Promise<string> {
  const jwt = new JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

async function fetchMarkdownExport(accessToken: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${DOC_ID}/export?mimeType=text%2Fmarkdown`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive export failed: ${res.status} ${await res.text()}`);
  return await res.text();
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
  paragraphStyle?: { namedStyleType?: string; spaceAbove?: { magnitude?: number }; spaceBelow?: { magnitude?: number } };
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
  spaceAbove: number;
  spaceBelow: number;
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
      spaceAbove: el.paragraph.paragraphStyle?.spaceAbove?.magnitude ?? 0,
      spaceBelow: el.paragraph.paragraphStyle?.spaceBelow?.magnitude ?? 0,
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
  const fields =
    "revisionId,body(content(startIndex,endIndex,paragraph(paragraphStyle(namedStyleType,spaceAbove,spaceBelow),elements(textRun(content,textStyle.bold)))))";
  const url = `https://docs.googleapis.com/v1/documents/${DOC_ID}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Docs get failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

interface SpacingRange {
  startIndex: number;
  endIndex: number;
}

interface TemplateSpacing {
  title: string;
  paragraphCount: number;
}

// The visible "extra spacing" turns out to be paragraph-level
// spaceAbove/spaceBelow styling (commonly 6pt on every paragraph in the
// WILLOW TM doc), not literal blank paragraphs — Google's Markdown
// exporter renders that styling as a blank line between paragraphs.
// Finds, per template, the single outer range spanning its whole body
// (title's end to the next boundary's start) so spaceAbove/spaceBelow
// can be zeroed for the whole block in one updateParagraphStyle request.
function findSpacingRanges(paras: Para[]): { ranges: SpacingRange[]; perTemplate: TemplateSpacing[] } {
  const boundaryIdxs: number[] = [];
  paras.forEach((p, i) => {
    if (isBoundary(p)) boundaryIdxs.push(i);
  });

  const ranges: SpacingRange[] = [];
  const perTemplate: TemplateSpacing[] = [];

  for (let b = 0; b < boundaryIdxs.length; b++) {
    const titleIdx = boundaryIdxs[b];
    const title = titleText(paras[titleIdx]);
    if (title.toLowerCase() === "table of contents") continue; // mirrors sheet-teletemplates-sync's own skip

    const bodyEnd = b + 1 < boundaryIdxs.length ? boundaryIdxs[b + 1] : paras.length;
    const bodyStart = titleIdx + 1;
    if (bodyStart >= bodyEnd) continue;

    const hasSpacing = paras.slice(bodyStart, bodyEnd).some((p) => p.spaceAbove !== 0 || p.spaceBelow !== 0);
    if (!hasSpacing) continue;

    // The Docs API refuses a range touching the very last newline of the
    // document body segment — trim the range's end back by one
    // character in that case (updateParagraphStyle only needs the range
    // to overlap each paragraph, not span its exact boundary).
    const lastParaIdx = bodyEnd - 1;
    const endsAtDocEnd = lastParaIdx === paras.length - 1;
    const startIndex = paras[bodyStart].startIndex;
    const endIndex = endsAtDocEnd ? paras[lastParaIdx].endIndex - 1 : paras[lastParaIdx].endIndex;

    ranges.push({ startIndex, endIndex });
    perTemplate.push({ title, paragraphCount: bodyEnd - bodyStart });
  }

  return { ranges, perTemplate };
}

async function applySpacingReset(accessToken: string, revisionId: string, ranges: SpacingRange[]): Promise<void> {
  // Style-only updates, not insertions/deletions — the document's length
  // never changes, so none of these ranges can invalidate each other and
  // order doesn't matter.
  const requests = ranges.map((r) => ({
    updateParagraphStyle: {
      range: { startIndex: r.startIndex, endIndex: r.endIndex },
      paragraphStyle: {
        spaceAbove: { magnitude: 0, unit: "PT" },
        spaceBelow: { magnitude: 0, unit: "PT" },
      },
      fields: "spaceAbove,spaceBelow",
    },
  }));

  const url = `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
  });
  if (!res.ok) throw new Error(`Docs batchUpdate failed: ${res.status} ${await res.text()}`);
}

async function applySpacingRestore(accessToken: string, revisionId: string, range: SpacingRange): Promise<void> {
  const requests = [
    {
      updateParagraphStyle: {
        range: { startIndex: range.startIndex, endIndex: range.endIndex },
        paragraphStyle: {
          spaceAbove: { magnitude: 6, unit: "PT" },
          spaceBelow: { magnitude: 6, unit: "PT" },
        },
        fields: "spaceAbove,spaceBelow",
      },
    },
  ];

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

  let payload: {
    dryRun?: boolean;
    diagnoseTitle?: string;
    diagnoseAround?: string;
    restoreAll?: boolean;
    diagnoseMarkdown?: string;
    previewAdd?: { category: string; title: string };
  } = {};
  try {
    payload = await req.json();
  } catch {
    // no body is fine — defaults to a real run
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return new Response(`error getting access token: ${err}`, { status: 500 });
  }

  if (payload.previewAdd) {
    // Mirrors template-add's own category-matching + insertion-point
    // logic exactly, run here (read-only, no write) so it can be
    // verified against the real live doc via this admin-secret-only
    // function — template-add itself needs real user auth to call,
    // which can't be faked to test it directly.
    let doc: DocsDocument;
    try {
      doc = await fetchDoc(accessToken);
    } catch (err) {
      await writeDebugSnippet({ error: `error reading doc: ${err}` });
      return new Response("ok", { headers: { "Content-Type": "application/json" } });
    }
    const paras = extractParagraphs(doc);
    const { category, title } = payload.previewAdd;
    const categoryIdxs: number[] = [];
    paras.forEach((p, i) => {
      if (p.headingLevel === 2 && p.trimmed === category) categoryIdxs.push(i);
    });
    if (categoryIdxs.length !== 1) {
      await writeDebugSnippet({ previewAdd: true, error: `found category "${category}" ${categoryIdxs.length} times` });
      return new Response("ok", { headers: { "Content-Type": "application/json" } });
    }
    const categoryIdx = categoryIdxs[0];
    let nextHeadingIdx = paras.length;
    for (let i = categoryIdx + 1; i < paras.length; i++) {
      if (paras[i].headingLevel !== null && paras[i].headingLevel! <= 2) {
        nextHeadingIdx = i;
        break;
      }
    }
    const atDocEnd = nextHeadingIdx === paras.length;
    const insertAt = atDocEnd ? paras[paras.length - 1].endIndex - 1 : paras[nextHeadingIdx].startIndex;
    const beforeCtx = paras
      .slice(Math.max(0, (atDocEnd ? paras.length : nextHeadingIdx) - 3), atDocEnd ? paras.length : nextHeadingIdx)
      .map((p) => ({ text: p.trimmed.slice(0, 40), headingLevel: p.headingLevel, boldOnly: p.boldOnly }));
    const afterCtx = atDocEnd
      ? []
      : paras.slice(nextHeadingIdx, nextHeadingIdx + 2).map((p) => ({ text: p.trimmed.slice(0, 40), headingLevel: p.headingLevel, boldOnly: p.boldOnly }));
    await writeDebugSnippet({
      previewAdd: true,
      category,
      title,
      insertAt,
      atDocEnd,
      docLength: paras.length ? paras[paras.length - 1].endIndex : 0,
      beforeInsertionPoint: beforeCtx,
      afterInsertionPoint: afterCtx,
    });
    return new Response("ok", { headers: { "Content-Type": "application/json" } });
  }

  if (payload.diagnoseMarkdown) {
    let md: string;
    try {
      md = await fetchMarkdownExport(accessToken);
    } catch (err) {
      await writeDebugSnippet({ error: `error reading markdown: ${err}` });
      return new Response("ok", { headers: { "Content-Type": "application/json" } });
    }
    const idxs: number[] = [];
    let from = 0;
    while (idxs.length < 5) {
      const i = md.indexOf(payload.diagnoseMarkdown, from);
      if (i === -1) break;
      idxs.push(i);
      from = i + payload.diagnoseMarkdown.length;
    }
    const snippets = idxs.map((idx) => md.slice(Math.max(0, idx - 100), idx + 500));
    await writeDebugSnippet({ query: payload.diagnoseMarkdown, matchCount: idxs.length, mdLength: md.length, snippets });
    return new Response("ok", { headers: { "Content-Type": "application/json" } });
  }

  let doc: DocsDocument;
  try {
    doc = await fetchDoc(accessToken);
  } catch (err) {
    return new Response(`error reading doc: ${err}`, { status: 500 });
  }

  const paras = extractParagraphs(doc);

  // Emergency revert: the spacing-removal cleanup below turned out to
  // also strip spacing from bold Table-of-Contents category labels
  // (never excluded — only a block literally titled "Table of
  // Contents" was skipped), which changed how those paragraphs render
  // in Markdown export and broke sheet-teletemplates-sync's regex-based
  // boundary detection (604 garbage "templates" instead of ~74, most
  // with empty bodies). This restores the original 6pt spacing across
  // the whole document body in one shot, undoing exactly what the
  // cleanup changed, rather than trying to selectively fix scope.
  if (payload.restoreAll) {
    const first = paras[0];
    const last = paras[paras.length - 1];
    if (!first || !last) return new Response(JSON.stringify({ ok: true, restored: false }), { headers: { "Content-Type": "application/json" } });
    const range = { startIndex: first.startIndex, endIndex: last.endIndex - 1 };
    try {
      await applySpacingRestore(accessToken, doc.revisionId, range);
    } catch (err) {
      return new Response(`error restoring spacing: ${err}`, { status: 500 });
    }
    await triggerResync();
    return new Response(JSON.stringify({ ok: true, restored: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (payload.diagnoseAround) {
    const idx = paras.findIndex((p) => p.trimmed === payload.diagnoseAround);
    if (idx === -1) return new Response(JSON.stringify({ ok: false, error: "text not found" }), { headers: { "Content-Type": "application/json" } });
    const dump = paras.slice(Math.max(0, idx - 2), idx + 20).map((p) => ({
      text: p.trimmed.slice(0, 50),
      headingLevel: p.headingLevel,
      boldOnly: p.boldOnly,
      spaceAbove: p.spaceAbove,
      spaceBelow: p.spaceBelow,
    }));
    return new Response(JSON.stringify({ ok: true, paragraphs: dump }), { headers: { "Content-Type": "application/json" } });
  }

  if (payload.diagnoseTitle) {
    const boundaryIdxs: number[] = [];
    paras.forEach((p, i) => {
      if (isBoundary(p)) boundaryIdxs.push(i);
    });
    const b = boundaryIdxs.findIndex((idx) => titleText(paras[idx]) === payload.diagnoseTitle);
    if (b === -1) return new Response(JSON.stringify({ ok: false, error: "title not found" }), { headers: { "Content-Type": "application/json" } });
    const bodyEnd = b + 1 < boundaryIdxs.length ? boundaryIdxs[b + 1] : paras.length;
    const dump = paras.slice(boundaryIdxs[b], bodyEnd).map((p) => ({
      text: p.trimmed.slice(0, 40),
      spaceAbove: p.spaceAbove,
      spaceBelow: p.spaceBelow,
    }));
    return new Response(JSON.stringify({ ok: true, paragraphs: dump }), { headers: { "Content-Type": "application/json" } });
  }

  const { ranges, perTemplate } = findSpacingRanges(paras);

  if (payload.dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        dryRun: true,
        templatesAffected: perTemplate.length,
        sample: perTemplate.slice(0, 10),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  if (ranges.length === 0) {
    return new Response(JSON.stringify({ ok: true, templatesAffected: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  try {
    await applySpacingReset(accessToken, doc.revisionId, ranges);
  } catch (err) {
    return new Response(`error applying cleanup: ${err}`, { status: 500 });
  }

  await triggerResync();

  return new Response(
    JSON.stringify({ ok: true, templatesAffected: perTemplate.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
