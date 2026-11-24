import { Outcome, ReviewState, ThreadState } from "@recense/contract";
import { AgentStatus, type AgentStatusKey } from "../status/AgentStatus.tsx";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { OutcomeBadge } from "../status/OutcomeBadge.tsx";
import { SnoozeBadge, StateBadge } from "../status/StateBadge.tsx";
import { ThreadStateBadge } from "../status/ThreadStateBadge.tsx";
import { TopicRank } from "../status/TopicRank.tsx";

const agentStates: AgentStatusKey[] = ["approved", "waiting", "pending", "pickedUp"];
const origins = Array.from({ length: 8 }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name: `sample-${index + 1}`,
}));
export function SampleBadges() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap gap-3">
        {ReviewState.options.map((state) => (
          <StateBadge key={state} state={state} revision={2} />
        ))}
        <SnoozeBadge until={null} now={0} />
      </div>
      <div className="flex flex-wrap gap-3">
        {agentStates.map((status) => (
          <AgentStatus key={status} status={status} pill />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {["unsent" as const, ...ThreadState.options].map((state) => (
          <ThreadStateBadge key={state} state={state} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {Outcome.options.map((outcome) => (
          <OutcomeBadge key={outcome} outcome={outcome} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <ChangedMarker revision={2} />
        <TopicRank rank={1} />
        <TopicRank rank={2} current />
        {origins.map((origin) => (
          <OriginBadge key={origin.id} origin={origin} />
        ))}
      </div>
    </div>
  );
}
