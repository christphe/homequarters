// @ts-check
(() => {
  const root = document.body.dataset.root || "./";

  // Copy buttons on code blocks
  document.querySelectorAll(".code .copy").forEach((btn) => {
    // oxlint-disable-next-line typescript/no-misused-promises -- the handler catches its own failure; the DOM ignores the promise
    btn.addEventListener("click", async () => {
      const text = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (btn.parentElement).querySelector("code")).innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Press Ctrl+C";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
  });

  // Fit the fixed-size hero stage into its wrapper
  const wrap = document.querySelector(".stage-wrap");
  if (wrap) {
    const stage = /** @type {HTMLElement} */ (wrap.querySelector(".stage"));
    const fit = () => stage.style.setProperty("--k", /** @type {string} */ (/** @type {unknown} */ (Math.min(1, wrap.clientWidth / 640)))); // the number becomes its string
    new ResizeObserver(fit).observe(wrap);
    fit();
  }

  // Docs: mobile sidebar toggle + tiny client-side search
  const toggle = document.querySelector(".side-toggle");
  const sidebar = /** @type {HTMLElement} */ (document.querySelector(".sidebar"));
  toggle?.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  const q = /** @type {HTMLInputElement | null} */ (document.getElementById("q"));
  const list = document.getElementById("results");
  if (q && list) {
    /** @typedef {{ t: string, u: string, x: string, h: string[] }} Entry one page of search-index.json (build.ts) */
    /** @type {Entry[] | null} */
    let index = null;
    /** @returns {Promise<Entry[]>} */
    const load = async () => (index ??= /** @type {Entry[]} */ (await (await fetch(root + "search-index.json")).json()));
    // oxlint-disable-next-line typescript/no-misused-promises -- the DOM ignores the promise (a failed fetch of the index stays an unhandled rejection, as before)
    q.addEventListener("input", /** @returns {Promise<boolean | void>} */ async () => {
      const term = q.value.trim().toLowerCase();
      if (term.length < 2) return (list.hidden = true);
      const data = await load();
      const words = term.split(/\s+/);
      const hits = data
        .map((p) => {
          const hay = (p.t + " " + p.h.join(" ")).toLowerCase();
          const body = p.x.toLowerCase();
          let s = 0;
          for (const w of words) {
            if (p.t.toLowerCase().includes(w)) s += 8;
            if (hay.includes(w)) s += 4;
            if (body.includes(w)) s += 1;
            else return null;
          }
          return { p, s };
        })
        .filter(/** @type {(h: { p: Entry, s: number } | null) => h is { p: Entry, s: number }} */ (/** @type {unknown} */ (Boolean)))
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      list.replaceChildren(
        ...(hits.length
          ? hits.map(({ p }) => {
              const li = document.createElement("li");
              const a = document.createElement("a");
              a.href = root + p.u;
              a.textContent = p.t;
              li.append(a);
              return li;
            })
          : [Object.assign(document.createElement("li"), { textContent: "No results", className: "none" })]),
      );
      list.hidden = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        q.focus();
      }
      if (e.key === "Escape") list.hidden = true;
    });
  }
})();
