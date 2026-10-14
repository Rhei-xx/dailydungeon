/** Tiny helpers for hand-built, Gmail-safe HTML: tables and inline styles only. */

export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text (possibly multi-paragraph) → escaped HTML paragraphs' inner content. */
export function paragraphs(text: string, style: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="${style}">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The palette — the cream/ink/red of the original Daily Scribe theme, in hex for email. */
export const COLORS = {
  page: "#f4efe6",
  card: "#fffdf8",
  border: "#e3d9c6",
  ink: "#23201a",
  muted: "#6b6457",
  faint: "#9a8f7d",
  accent: "#b0402e",
  panel: "#f7f1e6",
  good: "#3f6b3a",
} as const;

export const SERIF = "Georgia, 'Times New Roman', serif";
export const SANS = "Helvetica, Arial, sans-serif";
