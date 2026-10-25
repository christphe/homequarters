// The start of a plugin iframe's document (its hidden frame, or the view of its modal): English, a title for
// assistive technology, and the Content-Security-Policy. host.ts appends the scripts.

const escapeHTML = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function frameHead(title: string, policy: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHTML(title)}</title><meta http-equiv="Content-Security-Policy" content="${policy}">`;
}
