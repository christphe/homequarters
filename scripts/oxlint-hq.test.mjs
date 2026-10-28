// Tests of the project's own Oxlint rules (scripts/oxlint-hq.mjs) with Oxlint's RuleTester.
// Run: node --test scripts/oxlint-hq.test.mjs  (part of the web-unit gate)
import { describe, it } from "node:test";
import { RuleTester } from "../web/node_modules/oxlint/dist/plugins-dev.js";
import plugin from "./oxlint-hq.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } });
const tsx = (code) => ({ code, filename: "x.tsx" });
const bad = (code, errors = 1) => ({ ...tsx(code), errors });

tester.run("effect-cleanup", plugin.rules["effect-cleanup"], {
  valid: [
    tsx("useEffect(() => { el.focus(); }, []);"),
    tsx("useEffect(() => { const t = setInterval(f, 100); return () => clearInterval(t); }, []);"),
    tsx("React.useLayoutEffect(function () { return undefined; });"),
    tsx("useMemo(() => a + b, [a, b]);"),
  ],
  invalid: [
    // the chat crash: scrollIntoView() returned a Promise on Chrome 154
    bad("useEffect(() => el.scrollIntoView(), [msgs]);"),
    bad("useLayoutEffect(() => (x = 1));"),
    bad("useEffect(async () => { await load(); }, []);"),
    bad("React.useInsertionEffect(async function () {});"),
    bad("import { useEffect as useFx } from 'react'; useFx(() => el.focus());"),
  ],
});

tester.run("ui-text", plugin.rules["ui-text"], {
  valid: [
    tsx("const a = <p>{t('chat.title')}</p>;"),
    tsx("const a = <button aria-label={t('close')} title={t('close')}>×</button>;"),
    tsx("const a = <span>{n} · {m}</span>;"),
    tsx("const a = <div className='Large panel' data-name='Some Name' />;"),
    tsx("const a = <p>{open ? t('a') : t('b')}</p>;"),
    tsx("const a = <p>{n + 1}{' '}{'×'}</p>;"),
  ],
  invalid: [
    bad("const a = <p>Hello there</p>;"),
    bad("const a = <button aria-label='Close'>x</button>;"),
    bad("const a = <input placeholder={'Your name'} />;"),
    bad("const a = <img alt={`Avatar of ${n}`} />;"),
    bad("const a = <span title='Ok'>Ok</span>;", 2),
    bad("const a = <p>{'Literal child'}</p>;"),
    bad("const a = <p>{open ? 'Open now' : t('closed')}</p>;"),
    bad("const a = <>{err || 'Something failed'}</>;"),
    bad("const a = <button aria-label={open ? 'Close it' : 'Open it'} />;"),
    bad("const a = <button aria-label={'Some ' + name} />;"),
  ],
});

tester.run("dialog-through-modal", plugin.rules["dialog-through-modal"], {
  valid: [tsx("const a = <Modal title={t('x')} onClose={f} />;"), tsx("const a = <div role='status' />;")],
  invalid: [bad("const a = <div role='dialog' />;"), bad("const a = <div role={'alertdialog'} />;"), bad("const a = <dialog open />;")],
});
