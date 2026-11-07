export declare class TupleMap<K extends ReadonlyArray<unknown>, V> {
	get(key: K): V | undefined
	set(key: K, value: V): this
}

export declare class TupleSet<K extends ReadonlyArray<unknown>> {
	has(key: K): boolean
	add(key: K): this
}
