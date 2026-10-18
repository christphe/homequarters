// Deploy versions. The page carries the version of the server that served it (a meta tag) and hello
// carries the version of the server the socket reached: after a deploy they differ, and a dialog that
// cannot be dismissed asks to reload onto the new code.

/** The version this page was served with, or "" outside a server-served page (the Vite dev server). */
export const pageVersion = (): string => document.querySelector<HTMLMetaElement>('meta[name="hq-version"]')?.content ?? "";

/** Outdated when both sides name a version and they differ. */
export const isOutdated = (page: string, server: string | undefined): boolean => !!page && !!server && page !== server;
