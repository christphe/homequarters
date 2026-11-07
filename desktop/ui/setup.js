// @ts-check
// The offices page: the offices this computer knows (open one, forget one) and a field to add one.
// The shell checks every address, remembers it and opens it in this window.
/** @typedef {{ url: string, name: string | null }} Office one entry of the list (offices.rs) */
/** @typedef {{ current: string | null, list: Office[] }} Offices what list_offices and remove_office return (offices.rs) */
const { invoke } = window.__TAURI__.core;
// the elements of index.html, always there
const form = /** @type {HTMLFormElement} */ (document.getElementById("office"));
const input = /** @type {HTMLInputElement} */ (document.getElementById("address"));
const error = /** @type {HTMLElement} */ (document.getElementById("error"));
const submit = /** @type {HTMLButtonElement} */ (form.querySelector("button[type=submit]"));
const cancel = /** @type {HTMLButtonElement} */ (document.getElementById("cancel"));
const saved = /** @type {HTMLElement} */ (document.getElementById("saved"));
const list = /** @type {HTMLElement} */ (document.getElementById("list"));

/** @param {Office} o */
const label = (o) => o.name || o.url.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");

/** @param {Offices} offices */
function render(offices) {
  list.replaceChildren();
  for (const o of offices.list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label(o);
    name.title = o.url;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = o.url === offices.current ? "Open (current)" : "Open";
    open.setAttribute("aria-label", `Open ${label(o)}`);
    open.addEventListener("click", () => void go(o.url));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${label(o)}`);
    // a second click confirms (no confirm(): an embedded WKWebView shows no dialog unless the app draws it)
    // oxlint-disable-next-line typescript/no-misused-promises -- the DOM ignores the promise; kept as it was (a failed remove_office goes unhandled)
    remove.addEventListener("click", async () => {
      if (remove.dataset.armed !== "1") {
        remove.dataset.armed = "1";
        remove.textContent = "Click again to remove";
        return;
      }
      const after = /** @type {Offices} */ (await invoke("remove_office", { url: o.url }));
      if (o.url === current) {
        current = null; // nothing left to go back to
        cancel.hidden = true;
      }
      render(after);
    });
    remove.addEventListener("blur", () => {
      delete remove.dataset.armed;
      remove.textContent = "Remove";
    });
    li.append(name, open, remove);
    list.append(li);
  }
  saved.hidden = offices.list.length === 0;
}

/** @param {string} address */
async function go(address) {
  error.textContent = "";
  submit.disabled = true;
  try {
    await invoke("open_office", { address });
  } catch (err) {
    error.textContent = String(err);
    submit.disabled = false;
    input.focus();
  }
}

// Cancel (and Escape) go back to the office that was open, changing nothing; a first start has none
/** @type {string | null} */
let current = null;
cancel.addEventListener("click", () => current && void go(current));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && current) void go(current);
});

void /** @type {Promise<Offices>} */ (invoke("list_offices")).then((offices) => {
  current = offices.list.some((o) => o.url === offices.current) ? offices.current : null;
  cancel.hidden = !current;
  render(offices);
  // "Add office..." comes with #add; a first start has nothing else to do
  if (location.hash === "#add" || offices.list.length === 0) input.focus();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void go(input.value);
});
