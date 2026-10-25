// The start of a plugin iframe's document (its hidden frame, or the view of its modal): English, a title for
// assistive technology, and the Content-Security-Policy. host.ts appends the scripts.

const escapeHTML = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function frameHead(title: string, policy: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHTML(title)}</title><meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a plugin's iframe may load: its own folder (the browser code, its assets) and the hosts its manifest
 * declares (externalHosts, over https), nothing else. Administrators see those hosts before turning the
 * plugin on; without this policy a plugin could reach any server with every viewer's address. A view
 * (shared: the plugins running when it starts) may also draw the images other plugins put in shared/, the
 * one part of a plugin's folder meant for others, as hq.loadSprite(..., { from }) does on the page.
 */
export function framePolicy(origin: string, plugin: string, hosts: string[], shared: string[]): string {
  const own = new URL(`/plugins/${plugin}/`, origin).href;
  const out = hosts.filter((h) => /^[a-z0-9.-]+$/.test(h)).map((h) => "https://" + h);
  const others = shared.filter((p) => p !== plugin && PLUGIN_NAME.test(p)).map((p) => new URL(`/plugins/${p}/assets/shared/`, origin).href);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${own}`,
    `connect-src ${[own, ...out].join(" ")}`,
    `img-src blob: data: ${[own, ...out, ...others].join(" ")}`,
    "style-src 'unsafe-inline'",
  ].join("; ");
}
