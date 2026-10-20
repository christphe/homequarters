// The offices page: the offices this computer knows (open one, forget one) and a field to add one.
// The shell checks every address, remembers it and opens it in this window.
const { invoke } = window.__TAURI__.core;
const form = document.getElementById("office");
const input = document.getElementById("address");
const error = document.getElementById("error");
const submit = form.querySelector("button[type=submit]");
const cancel = document.getElementById("cancel");
const saved = document.getElementById("saved");
const list = document.getElementById("list");

const label = (o) => o.name || o.url.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");

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
    open.addEventListener("click", () => go(o.url));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${label(o)}`);
    // a second click confirms (no confirm(): an embedded WKWebView shows no dialog unless the app draws it)
    remove.addEventListener("click", async () => {
      if (remove.dataset.armed !== "1") {
        remove.dataset.armed = "1";
        remove.textContent = "Click again to remove";
        return;
      }
      const after = await invoke("remove_office", { url: o.url });
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
let current = null;
cancel.addEventListener("click", () => current && go(current));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && current) go(current);
});

invoke("list_offices").then((offices) => {
  current = offices.list.some((o) => o.url === offices.current) ? offices.current : null;
  cancel.hidden = !current;
  render(offices);
  // "Add office..." comes with #add; a first start has nothing else to do
  if (location.hash === "#add" || offices.list.length === 0) input.focus();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  go(input.value);
});
