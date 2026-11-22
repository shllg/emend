import { Link } from "@tanstack/react-router";
import { CopyPrompt } from "../components/CopyPrompt.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { agentsLabel, integrations } from "../lib/integrations.ts";

export function IntegrationsPage() {
  return (
    <AppFrame>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pt-8 pb-20">
          <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">Integrations</h1>
          <p className="mt-1">
            <Link to="/settings">Settings</Link>
          </p>
          <p className="mt-4 text-14 text-fg-3">
            Optional add-ons for your coding agent. Paste an add-on's prompt into the agent to set it up.
          </p>
          {integrations.map((integration) => (
            <section
              key={integration.id}
              aria-labelledby={`integration-${integration.id}`}
              className="mt-8 flex min-w-0 flex-col gap-2"
            >
              <h2 id={`integration-${integration.id}`} className="text-16 font-semibold">
                {integration.name}
              </h2>
              <p className="text-14">{integration.summary}</p>
              <p className="text-14 text-fg-3">{agentsLabel(integration.agents)}</p>
              <CopyPrompt prompt={integration.prompt} />
            </section>
          ))}
        </div>
      </main>
    </AppFrame>
  );
}
