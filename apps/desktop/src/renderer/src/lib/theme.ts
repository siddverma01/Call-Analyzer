export type Accent = "indigo" | "violet" | "emerald" | "amber" | "rose";

const ACCENTS: Record<Accent, { from: string; to: string; dot: string }> = {
  indigo: { from: "#6366f1", to: "#7c3aed", dot: "#818cf8" },
  violet: { from: "#8b5cf6", to: "#a855f7", dot: "#a78bfa" },
  emerald: { from: "#10b981", to: "#14b8a6", dot: "#34d399" },
  amber: { from: "#f59e0b", to: "#f97316", dot: "#fbbf24" },
  rose: { from: "#f43f5e", to: "#e11d48", dot: "#fb7185" },
};

const ACCENT_KEY = "callnotes.accent";

export function getAccent(): Accent {
  const stored = localStorage.getItem(ACCENT_KEY);
  if (stored === "violet" || stored === "emerald" || stored === "amber" || stored === "rose") return stored;
  return "indigo";
}

export function applyAccent(accent: Accent): void {
  const palette = ACCENTS[accent];
  const root = document.documentElement;
  root.style.setProperty("--accent-from", palette.from);
  root.style.setProperty("--accent-to", palette.to);
  root.style.setProperty("--accent-dot", palette.dot);
}

export function setAccent(accent: Accent): void {
  localStorage.setItem(ACCENT_KEY, accent);
  applyAccent(accent);
}

export function accentColors(accent: Accent): { from: string; to: string } {
  return { from: ACCENTS[accent].from, to: ACCENTS[accent].to };
}