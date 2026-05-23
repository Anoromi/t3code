export const MAX_COALESCED_OUTPUT_CHARS = 65_536;

type OutputLikeEvent = {
  type: "output";
  data: string;
};

type NonOutputLikeEvent = {
  type: string;
};

function isOutputLikeEvent(event: OutputLikeEvent | NonOutputLikeEvent): event is OutputLikeEvent {
  return event.type === "output";
}

export function appendPendingTerminalProcessEvent<
  TEvent extends OutputLikeEvent | NonOutputLikeEvent,
>(
  queue: TEvent[],
  event: TEvent,
  maxCoalescedOutputChars: number = MAX_COALESCED_OUTPUT_CHARS,
): void {
  if (event.type !== "output") {
    queue.push(event);
    return;
  }

  const outputEvent = event as OutputLikeEvent;
  const lastEvent = queue.at(-1);
  if (
    lastEvent !== undefined &&
    isOutputLikeEvent(lastEvent) &&
    lastEvent.data.length + outputEvent.data.length <= maxCoalescedOutputChars
  ) {
    lastEvent.data += outputEvent.data;
    return;
  }

  queue.push(event);
}
