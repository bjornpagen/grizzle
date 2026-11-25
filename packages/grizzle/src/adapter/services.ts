import { Context, Effect, Tracer } from "effect"

/**
 * A layer's own services: the context it runs in where it is built, the span it is built in left behind, captured once.
 * What a layer does for no one caller runs under exactly these, put in place of the context of whichever caller set it
 * going (`Effect.updateContext`, which replaces, never `Effect.provideContext`, which merges, so a caller's span would
 * stay): the installation's live fan-out and its leader candidacy, which the first watch of a process starts and every
 * later watch shares (live/subscriptions.ts), a pool's connection attempt that no lease made (wire/pool.ts makePool),
 * and each request an HTTP handler answers (http/handler.ts httpAnswers), which comes from outside any fiber. Each
 * outlives the build and serves every caller, so it is traced under none of their spans, the build's among them, and
 * holds no caller's services: a tracer reads such work as a root of its own, or, through a tracer bridged to the
 * platform's, under the platform's span active when it runs. What a caller asks for itself, its Db's calls, its
 * verify, its lease's connection attempt, runs in the caller's own fiber, under the caller's span.
 */
export const ownServices = <R = never>(): Effect.Effect<
	Context.Context<Exclude<R, Tracer.ParentSpan>>,
	never,
	R
> => Effect.map(Effect.context<R>(), Context.omit(Tracer.ParentSpan))
