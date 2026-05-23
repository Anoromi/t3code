/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

export interface KeyedDrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

export const makeKeyedDrainableWorker = <A, K, E, R>(input: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
  readonly maxConcurrentKeys?: number;
}): Effect.Effect<KeyedDrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queues = new Map<K, Queue.Queue<A>>();
    const activeKeys = new Set<K>();
    const outstanding = yield* TxRef.make(0);
    const context = yield* Effect.context<R>();
    const workerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const maxConcurrentKeys = input.maxConcurrentKeys ?? Number.POSITIVE_INFINITY;
    const semaphore =
      Number.isFinite(maxConcurrentKeys) && maxConcurrentKeys > 0
        ? yield* Semaphore.make(maxConcurrentKeys)
        : null;

    const processQueue = (key: K, queue: Queue.Queue<A>) =>
      Effect.gen(function* () {
        while (true) {
          const itemOption = yield* Queue.poll(queue);
          if (itemOption._tag === "None") {
            queues.delete(key);
            activeKeys.delete(key);
            return;
          }

          yield* input
            .process(itemOption.value)
            .pipe(Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)));
        }
      });

    const startQueue = (key: K, queue: Queue.Queue<A>) => {
      activeKeys.add(key);
      const run = processQueue(key, queue);
      return (semaphore ? semaphore.withPermits(1)(run) : run).pipe(
        Effect.provide(context),
        Effect.forkIn(workerScope),
      );
    };

    const enqueue: KeyedDrainableWorker<A>["enqueue"] = (item) =>
      Effect.gen(function* () {
        const key = input.key(item);
        let queue = queues.get(key);
        if (!queue) {
          queue = yield* Queue.unbounded<A>();
          queues.set(key, queue);
        }

        yield* Queue.offer(queue, item);
        yield* TxRef.update(outstanding, (n) => n + 1).pipe(Effect.tx);

        if (!activeKeys.has(key)) {
          yield* startQueue(key, queue);
        }
      });

    const drain: KeyedDrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies KeyedDrainableWorker<A>;
  });
