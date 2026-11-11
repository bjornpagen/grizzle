import type { Effect } from "effect"

export type Gen<A> = (pick: number) => A

export type Draw<A> = Readonly<{ generator: Gen<A> }>

export declare const integer: (min: number, max: number) => Gen<number>

export declare const element: <const A>(values: ReadonlyArray<A>) => Gen<A>

export declare const constant: <A>(value: A) => Gen<A>

export declare const map: <A, B>(generator: Gen<A>, transform: (value: A) => B) => Gen<B>

export declare const span: <A>(label: string, generator: Gen<A>) => Gen<A>

export declare const oneOf: <A>(generators: ReadonlyArray<Gen<A>>) => Gen<A>

export declare const weighted: <A>(
	options: ReadonlyArray<readonly [weight: number, generator: Gen<A>]>
) => Gen<A>

export declare const array: <A>(
	item: Gen<A>,
	size: Readonly<{ min: number; max: number }>
) => Gen<ReadonlyArray<A>>

export declare const record: <A>(fields: { readonly [K in keyof A]: Gen<A[K]> }) => Gen<A>

export declare const drawn: <A>(generator: Gen<A>) => Draw<A>

export declare const sketched: <S, A>(generator: Gen<S>, resolve: (sketch: S) => A) => Draw<A>

export declare const exhaust: <A>(
	spec: Readonly<{ suite: string; generator: Gen<A> }>,
	property: (value: A) => Effect.Effect<void>
) => Effect.Effect<void>

export declare const explore: <A>(
	spec: Readonly<{ suite: string; draw: Draw<A>; kept: ReadonlyArray<A> }>,
	property: (value: A) => Effect.Effect<void>
) => Effect.Effect<void>

export declare const notASearch: <A>(spec: Readonly<{ generator: Gen<A> }>) => Effect.Effect<void>
