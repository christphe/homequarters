import { useEffect, useRef, useState } from "react";
import { session } from "../session";
import type { UINode } from "../plugins/commands";

// A plugin's view in its modal: an iframe with sandbox="allow-scripts" only (an opaque origin: it cannot
// read this page, its cookies, storage or media), filled and connected by the plugin's host (host.ts). Its
// key is the plugin and the view, so redrawing the modal keeps the iframe and the view's state.

export function PluginViewFrame({ plugin, node }: { plugin: string; node: Extract<UINode, { type: "view" }> }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const f = ref.current;
    if (!f) return undefined;
    // not declared, or it did not start: the view goes, the modal stays (the host said why in the console)
    return session.plugins?.attachView(plugin, node.view, f, () => setFailed(true));
  }, [plugin, node.view]);
  if (failed) return null;
  return <iframe ref={ref} sandbox="allow-scripts" title={node.label} className={"plugin-view h-" + node.height} data-plugin={plugin} data-view={node.view} />;
}
