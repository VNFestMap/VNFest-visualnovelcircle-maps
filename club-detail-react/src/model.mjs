// Only API-visible contact fields are accepted; never inspect raw_text or hidden aliases.
export function normalizeClub(row) {
  const hidden =
    row.info_hidden === true ||
    row.infoHidden === true ||
    row.info === "申请绑定后可见";
  return {
    id: Number(row.id),
    country: row.country || "china",
    name: String(row.name || row.display_name || ""),
    type: row.rawType || row.type,
    hidden,
    contact: hidden ? "" : String(row.originalInfo ?? row.info ?? ""),
    canApply: row.can_apply === true || row.canApply === true,
    status: row.membership_status || row.membershipStatus || null,
    registered:
      row.verified === undefined || row.verified === null
        ? null
        : row.verified === true || Number(row.verified) === 1,
    established: String(row.created_at || ""),
    intro: String(row.remark || ""),
    school: String(row.school || ""),
    external_links: String(row.external_links || ""),
    logo_url: String(row.logo_url || ""),
  };
}

export function safeHttp(value) {
  try {
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function externalPlatforms(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([^:：]+)[:：]\s*(.+)$/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        value: match[2].trim(),
        href: safeHttp(match[2].trim()),
      };
    })
    .filter(Boolean);
}

export function appendComments(previous, next) {
  const seen = new Set(previous.map((item) => String(item.id)));
  return [
    ...previous,
    ...next.filter((item) => {
      const id = String(item.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ];
}

export function visibleContactUrl(contact) {
  const match = String(contact || "").match(
    /https?:\/\/[^\s]+|discord\.gg\/[^\s]+|discord\.com\/invite\/[^\s]+/i,
  );
  if (!match) return null;
  return safeHttp(
    /^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`,
  );
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.success === false)
    throw new Error(result.message || "Request failed");
  return result;
}
