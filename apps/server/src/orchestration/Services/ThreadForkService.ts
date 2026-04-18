import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ThreadForkCommand,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationCommandInvariantError } from "../Errors.ts";

export interface ThreadForkServiceShape {
  readonly createForkEvent: (input: {
    readonly command: ThreadForkCommand;
    readonly readModel: OrchestrationReadModel;
  }) => Effect.Effect<
    Omit<OrchestrationEvent, "sequence">,
    ProjectionRepositoryError | OrchestrationCommandInvariantError
  >;
}

export class ThreadForkService extends Context.Service<ThreadForkService, ThreadForkServiceShape>()(
  "t3/orchestration/Services/ThreadForkService",
) {}
