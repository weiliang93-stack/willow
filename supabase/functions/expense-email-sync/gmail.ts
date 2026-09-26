// Minimal Gmail API client for the owner's personal Gmail, authorised once
// via an OAuth refresh token (a Google service account can't read a personal
// @gmail.com inbox - that only works for Workspace domains with delegation).
// Scopes needed: gmail.modify (read + label/archive) and gmail.send.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class Gmail {
  private token: string | null = null;
  constructor(private clientId: string, private clientSecret: string, private refreshToken: string) {}

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
    this.token = (await res.json()).access_token;
    return this.token!;
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Gmail ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  // Lists individual messages (not threads), so a busy same-subject thread
  // can never hide newer messages behind older ones. Includes Trash: the
  // old routine trashed processed alerts, and shadow mode still needs to see them.
  async listIds(q: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q, includeSpamTrash: "true", maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.call(`/messages?${params}`);
      for (const m of data.messages ?? []) ids.push(m.id);
      pageToken = data.nextPageToken ?? "";
    } while (pageToken && ids.length < 500);
    return ids;
  }

  async get(id: string): Promise<{ id: string; from: string; subject: string; internalDate: number; text: string; labelIds: string[] }> {
    const m = await this.call(`/messages/${id}?format=full`);
    const headers: Record<string, string> = {};
    for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
    const plain: string[] = [];
    const html: string[] = [];
    const walk = (part: any) => {
      if (!part) return;
      if (part.body?.data) {
        if (part.mimeType === "text/plain") plain.push(b64decode(part.body.data));
        else if (part.mimeType === "text/html") html.push(b64decode(part.body.data));
      }
      for (const p of part.parts ?? []) walk(p);
    };
    walk(m.payload);
    return {
      id: m.id,
      from: headers["from"] ?? "",
      subject: headers["subject"] ?? "",
      internalDate: Number(m.internalDate),
      text: plain.join("\n") || html.join("\n") || m.snippet || "",
      labelIds: m.labelIds ?? [],
    };
  }

  async labelId(name: string): Promise<string> {
    const data = await this.call("/labels");
    const found = (data.labels ?? []).find((l: any) => l.name === name);
    if (found) return found.id;
    const created = await this.call("/labels", { method: "POST", body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
    return created.id;
  }

  // Adds the label and archives (removes INBOX) - archived, not trashed,
  // so the alerts stay searchable instead of auto-deleting after 30 days.
  async labelAndArchive(ids: string[], labelId: string) {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.call("/messages/batchModify", { method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds: [labelId], removeLabelIds: ["INBOX"] }) });
    }
  }

  async profileEmail(): Promise<string> {
    return (await this.call("/profile")).emailAddress;
  }

  async send(to: string, subject: string, text: string, html: string) {
    const boundary = `b${crypto.randomUUID().replace(/-/g, "")}`;
    const mime = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64encode(subject)}?=`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64encode(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64encode(html),
      `--${boundary}--`,
    ].join("\r\n");
    await this.call("/messages/send", { method: "POST", body: JSON.stringify({ raw: b64encode(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }) });
  }
}

function b64decode(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
