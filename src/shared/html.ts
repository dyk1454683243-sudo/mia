/**
 * HTML escaping, shared by the browser pages and the pure modules they render
 * their prose from. Player names are user input and reach both, so there is one
 * implementation rather than one per caller.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
