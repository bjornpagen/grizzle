import { Effect, Function, Layer } from "effect"

/**
 * `effect` with the services `layer` builds, the layer built in a scope of its own that closes when `effect` ends: a
 * per-case layer, where a suite's layer cannot hold it. A Scope `effect` needs stays its caller's.
 */
export const withLayer = Function.dual<
	<ROut, E2, RIn>(
		layer: Layer.Layer<ROut, E2, RIn>
	) => <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | E2, Exclude<R, ROut> | RIn>,
	<A, E, R, ROut, E2, RIn>(
		effect: Effect.Effect<A, E, R>,
		layer: Layer.Layer<ROut, E2, RIn>
	) => Effect.Effect<A, E | E2, Exclude<R, ROut> | RIn>
>(
	2,
	<A, E, R, ROut, E2, RIn>(
		effect: Effect.Effect<A, E, R>,
		layer: Layer.Layer<ROut, E2, RIn>
	): Effect.Effect<A, E | E2, Exclude<R, ROut> | RIn> =>
		Effect.scopedWith((scope) =>
			Effect.flatMap(Layer.buildWithScope(layer, scope), (context) =>
				Effect.provideContext(effect, context)
			)
		)
)
