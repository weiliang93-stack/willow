// Supabase Edge Function: delivers the GP MediList locum-group outreach digest
// to your own chat with the bot.
//
// The daily Claude scheduled task does the judgment work (clinic admin vs
// doctor, independent vs chain, dedup, drafting) and just writes rows:
//   outreach_digest_runs  status 'pending'       -> the summary header message
//   outreach_contacts     status 'pending_send'  -> one candidate each
// This function (pg_cron, every 5 min — exits immediately when nothing is
// pending) sends them and flips them to 'sent' / 'digested'. For each
// candidate it:
//   1. forwards their original group post into this chat (forwardMessage), and
//   2. replies to that forward with: Independent/Chain label, their name as a
//      tg://user?id= link (tap -> their profile -> Message), the clinic, the
//      draft in a <pre> block (tap to copy), and ✅ Sent / Skip buttons.
// The name link is sent separately from the forward on purpose: the forward's
// "Forwarded from" header is only tappable if the poster's privacy settings
// allow it, the id link isn't subject to that.
//
// The ✅ Sent / Skip buttons are handled by telegram-poll (the only consumer of
// getUpdates) via callback_data "out:sent:<tg_user_id>" / "out:skip:<tg_user_id>".
//
// Rows are claimed with a conditional UPDATE (pending -> sending) before
// anything is sent, so overlapping cron invocations can't double-send.
//
// Required secrets (already set for telegram-poll, shared project-wide):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DB_WEBHOOK_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const CALL_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Rows stuck in 'sending' longer than this (e.g. the function was killed
// mid-run) get retried.
const STALE_SENDING_MS = 10 * 60 * 1000;
const POST_RETENTION_DAYS = 45;

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // Respect flood control rather than dropping the message.
  if (!data.ok && data.error_code === 429 && data.parameters?.retry_after) {
    await new Promise((r) => setTimeout(r, (data.parameters.retry_after + 1) * 1000));
    return tg(method, body);
  }
  return data;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function releaseStale() {
  const cutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  await supabase.from("outreach_contacts").update({ status: "pending_send" }).eq("status", "sending").lt("updated_at", cutoff);
  await supabase.from("outreach_digest_runs").update({ status: "pending" }).eq("status", "sending").lt("created_at", cutoff);
}

async function sendRuns(): Promise<number> {
  const { data: runs } = await supabase
    .from("outreach_digest_runs")
    .update({ status: "sending" })
    .eq("status", "pending")
    .select("id, summary")
    .order("id");
  for (const run of runs ?? []) {
    const r = await tg("sendMessage", { chat_id: CHAT_ID, text: run.summary, disable_web_page_preview: true });
    await supabase
      .from("outreach_digest_runs")
      .update(r.ok ? { status: "sent", sent_at: new Date().toISOString() } : { status: "pending" })
      .eq("id", run.id);
  }
  return runs?.length ?? 0;
}

function buildCard(c: any, includeLink: boolean): string {
  const label = c.clinic_type === "chain" ? "🏢 Chain" : "🏠 Independent";
  const displayName = esc(c.sender_name || "this poster");
  const who = includeLink ? `<a href="tg://user?id=${c.tg_user_id}">${displayName}</a>` : displayName;
  const handle = c.username ? ` · @${esc(c.username)}` : "";
  const lines = [
    `<b>${label}</b>${c.org && c.org !== c.clinic ? ` · ${esc(c.org)}` : ""}`,
    `👤 ${who}${handle} — tap to open chat`,
    c.clinic ? `🏥 ${esc(c.clinic)}` : null,
    c.source_chat_title ? `📍 ${esc(c.source_chat_title)}` : null,
    c.note ? `ℹ️ ${esc(c.note)}` : null,
    "",
    "<i>Tap the message below to copy it:</i>",
    `<pre>${esc(c.draft || "")}</pre>`,
  ].filter((l) => l !== null);
  return lines.join("\n");
}

async function sendCandidate(c: any): Promise<boolean> {
  // 1. Forward the original post.
  let anchorId: number | null = null;
  if (c.source_chat_id && c.source_message_id) {
    const fwd = await tg("forwardMessage", {
      chat_id: CHAT_ID,
      from_chat_id: c.source_chat_id,
      message_id: c.source_message_id,
    });
    if (fwd.ok) anchorId = fwd.result.message_id;
  }
  if (anchorId === null) {
    // Forward failed (post deleted, or the group restricts forwarding) — fall
    // back to the captured text so there's still context.
    const { data: post } = await supabase
      .from("locum_posts")
      .select("text, link")
      .eq("chat_id", c.source_chat_id)
      .eq("message_id", c.source_message_id)
      .maybeSingle();
    const snippet = post?.text ? (post.text.length > 1500 ? post.text.slice(0, 1500) + "…" : post.text) : "(original post unavailable)";
    const r = await tg("sendMessage", {
      chat_id: CHAT_ID,
      text: `📨 Original post (couldn't forward):\n\n${snippet}${post?.link ? `\n\n${post.link}` : ""}`,
      disable_web_page_preview: true,
    });
    if (r.ok) anchorId = r.result.message_id;
  }

  // 2. Reply with the card.
  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Sent", callback_data: `out:sent:${c.tg_user_id}` },
      { text: "⏭ Skip", callback_data: `out:skip:${c.tg_user_id}` },
    ]],
  };
  const base: Record<string, unknown> = {
    chat_id: CHAT_ID,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  };
  if (anchorId !== null) base.reply_parameters = { message_id: anchorId, allow_sending_without_reply: true };

  let r = await tg("sendMessage", { ...base, text: buildCard(c, true) });
  if (!r.ok) {
    // e.g. the id link can't be resolved — resend without it rather than lose the card.
    console.error("card with link failed", r);
    r = await tg("sendMessage", { ...base, text: buildCard(c, false) });
  }
  return !!r.ok;
}

async function sendCandidates(): Promise<number> {
  const { data: claimed } = await supabase
    .from("outreach_contacts")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("status", "pending_send")
    .select("*");
  const rows = (claimed ?? []).sort((a: any, b: any) => (a.digest_order ?? 999) - (b.digest_order ?? 999));
  let sent = 0;
  for (const c of rows) {
    let ok = false;
    try {
      ok = await sendCandidate(c);
    } catch (err) {
      console.error("sendCandidate", c.tg_user_id, err);
    }
    // Give up after 3 failed attempts so a permanently broken card (e.g. the
    // fallback post goes out but the card never does) can't re-send every 5 min.
    const attempts = (c.attempts ?? 0) + 1;
    await supabase
      .from("outreach_contacts")
      .update(
        ok
          ? { status: "digested", attempts, digested_at: new Date().toISOString(), updated_at: new Date().toISOString() }
          : { status: attempts >= 3 ? "failed" : "pending_send", attempts, updated_at: new Date().toISOString() }
      )
      .eq("tg_user_id", c.tg_user_id);
    if (ok) sent++;
    await sleep(400); // stay well under Telegram's per-chat rate limit
  }
  return sent;
}

async function pruneOldPosts() {
  const cutoff = new Date(Date.now() - POST_RETENTION_DAYS * 86400 * 1000).toISOString();
  await supabase.from("locum_posts").delete().lt("posted_at", cutoff);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== CALL_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  await releaseStale();
  const runs = await sendRuns();
  const cards = await sendCandidates();
  if (new Date().getUTCMinutes() < 5) await pruneOldPosts(); // roughly hourly
  return new Response(JSON.stringify({ runs, cards }), { headers: { "Content-Type": "application/json" } });
});
