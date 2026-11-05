declare const limitBrand: unique symbol

interface Stated<N extends number> {
	readonly value: N
	readonly owner: string
}

export type Limit<N extends number = number> = Stated<N> & { readonly [limitBrand]: N }

export type AnyLimit = Limit<number>

export declare const published: <N extends number>(
	limit: Readonly<{ value: N; owner: string; source: `https://${string}` }>
) => Limit<N>

export declare const measured: <N extends number>(
	limit: Readonly<{ value: N; owner: string; evidence: string }>
) => Limit<N>

export declare const derived: <const From extends ReadonlyArray<AnyLimit>, N extends number>(
	limit: Readonly<{ owner: string; from: From; derivation: string; compute: (from: From) => N }>
) => Limit<N>
