import { useEffect } from "react";
import { AnalyticsMfe } from "./AnalyticsMfe";
import { AuthMfe, type AuthMfeProps } from "./AuthMfe";
import { CallerMfe } from "./CallerMfe";
import type { DeeplinkLogEntry } from "./host";
import { DeeplinkStatusPanel, installDeeplinkLogger } from "./host";
import { OrdersMfe } from "./OrdersMfe";

export interface AppProps {
  user: AuthMfeProps["user"];
  /** Which MFEs are mounted — lets the sample show partial chains. */
  mounted?: { auth?: boolean; analytics?: boolean; orders?: boolean };
  timeout?: number;
  onLog?: (entry: DeeplinkLogEntry) => void;
  onTrack?: (key: string) => void;
}

/**
 * A host page with four "MFEs". In production each MFE is a separate Module Federation remote
 * sharing one toolbox; here they are plain components on one page, which behaves the same
 * because the registry is page-wide.
 */
export function App({
  user,
  mounted = { auth: true, analytics: true, orders: true },
  timeout,
  onLog = () => {},
  onTrack = () => {},
}: AppProps) {
  // Host boot: install the global logger once.
  useEffect(() => installDeeplinkLogger(onLog), [onLog]);

  return (
    <main>
      <DeeplinkStatusPanel />
      {mounted.auth && <AuthMfe user={user} />}
      {mounted.analytics && <AnalyticsMfe onTrack={onTrack} />}
      {mounted.orders && <OrdersMfe />}
      <CallerMfe timeout={timeout} />
    </main>
  );
}
