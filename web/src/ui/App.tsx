import { useEffect } from "react";
import { JoinScreen } from "./JoinScreen";
import { OfficeScreen } from "./OfficeScreen";
import { toast, useStore } from "../store";
import { t } from "../i18n";
import { loadMe } from "../me";

export function App() {
  const phase = useStore((s) => s.phase);
  useEffect(() => {
    // back from linking an account: say so once, and keep the address clean
    if (new URLSearchParams(location.search).get("auth") === "linked") {
      history.replaceState(null, "", location.pathname);
      toast(t("signin.linked"), 6000);
    }
    void loadMe();
  }, []);
  if (phase === "boot") return <div className="boot" />;
  if (phase === "join") return <JoinScreen />;
  return <OfficeScreen />;
}
