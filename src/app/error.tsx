"use client";

import { RefreshCw } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="workspace-loading"><h1>Something interrupted your workspace</h1><p>Your saved case records are still on the server. Try loading this view again.</p><button type="button" className="button button-primary" onClick={reset}><RefreshCw size={17} />Try again</button></main>;
}
