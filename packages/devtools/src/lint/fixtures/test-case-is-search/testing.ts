import type { Effect } from "effect"

export type Gen<A> = (pick: number) => A

export declare const integer: (min: number, max: number) => Gen<number>

export declare const element: <const A>(values: ReadonlyArray<A>) => Gen<A>

export declare const explore: <A>(
	spec: Readonly<{ suite: string; draw: Gen<A> }>,
	property: (value: A) => Effect.Effect<void>
) => Effect.Effect<void>

export declare const exhaust: <A>(
	spec: Readonly<{ suite: string; generator: Gen<A> }>,
	property: (value: A) => Effect.Effect<void>
) => Effect.Effect<void>

export declare const interleave: (strategy: "pct" | "every order") => Effect.Effect<void>
