// Home Quarters' own Oxlint rules (a JS plugin, ESLint's rule format), loaded by .oxlintrc.json.
// Each one turns a line of AGENTS.md or of a gauntlet critic's checklist into a gate; tests in
// scripts/oxlint-hq.test.mjs. Oxlint's JS plugins are alpha: the oxlint version is pinned in web/package.json.

const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const calleeName = (c) => (c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : "");
// the string literals an expression can evaluate to: "a", `a ${x}`, c ? "a" : "b", x || "a", "a " + x
const strings = (e) => {
  if (!e) return [];
  if (e.type === "Literal") return typeof e.value === "string" ? [e.value] : [];
  if (e.type === "TemplateLiteral") return [e.quasis.map((q) => q.value.cooked ?? "").join("…")];
  if (e.type === "ConditionalExpression") return [...strings(e.consequent), ...strings(e.alternate)];
  if (e.type === "LogicalExpression") return [...strings(e.left), ...strings(e.right)];
  if (e.type === "BinaryExpression" && e.operator === "+") return [...strings(e.left), ...strings(e.right)];
  return [];
};
// words, not symbols: "×", "·", "3/4" or "+" are not text to translate
const WORDS = /[A-Za-z]{2,}/;
const TEXT_ATTRS = new Set(["aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "title", "placeholder", "alt"]);

const effectCleanup = {
  meta: { type: "problem", docs: { description: "An effect returns a cleanup function or nothing" } },
  create(context) {
    // the hooks under the names this file imports them as (import { useEffect as useFx } from "react")
    const effects = new Set(EFFECTS);
    return {
      ImportSpecifier(node) {
        if (node.parent?.source?.value === "react" && EFFECTS.has(node.imported.name ?? node.imported.value)) effects.add(node.local.name);
      },
      CallExpression(node) {
        if (!effects.has(calleeName(node.callee))) return;
        const fn = node.arguments[0];
        if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) return;
        // React calls whatever the effect returns as its cleanup: a Promise (an async effect, or an
        // expression body such as scrollIntoView() on Chrome 154) crashed the whole UI once
        if (fn.async) context.report({ node: fn, message: "Async effect: it returns a Promise to React as its cleanup. Call an async function from inside a synchronous effect." });
        else if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement")
          context.report({ node: fn.body, message: "Expression-bodied effect: its value goes to React as the cleanup. Give it a block body: useEffect(() => { ... }, deps)." });
      },
    };
  },
};

const uiText = {
  meta: { type: "problem", docs: { description: "User-visible text goes through t() (web/src/i18n.ts)" } },
  create(context) {
    const report = (node, text) => context.report({ node, message: `User-visible text "${text.slice(0, 40)}" outside the i18n dictionary: add it to web/src/i18n.ts and use t().` });
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (WORDS.test(text)) report(node, text);
      },
      // a child written as an expression: {"Hello"}, {open ? "Open" : "Closed"}
      JSXExpressionContainer(node) {
        if (node.parent?.type !== "JSXElement" && node.parent?.type !== "JSXFragment") return;
        const text = strings(node.expression).find((s) => WORDS.test(s));
        if (text !== undefined) report(node, text);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !TEXT_ATTRS.has(node.name.name) || !node.value) return;
        const text = strings(node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value).find((s) => WORDS.test(s));
        if (text !== undefined) report(node, text);
      },
    };
  },
};

const dialogThroughModal = {
  meta: { type: "problem", docs: { description: "Dialogs use Modal (focus trap, Escape)" } },
  create(context) {
    const message = "A dialog outside Modal: use <Modal> from web/src/ui/Modal.tsx, which traps focus and closes on Escape.";
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "dialog") context.report({ node, message });
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "role" || !node.value) return;
        const v = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (v.type === "Literal" && (v.value === "dialog" || v.value === "alertdialog")) context.report({ node, message });
      },
    };
  },
};

export default {
  meta: { name: "hq" },
  rules: { "effect-cleanup": effectCleanup, "ui-text": uiText, "dialog-through-modal": dialogThroughModal },
};
