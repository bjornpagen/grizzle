export type Pair = readonly [string, number]
export type Lookup = ReadonlyMap<string, number>
export type Point = Readonly<{ x: number; y: number }>
declare const TodoId: { Type: string }
export type TodoId = typeof TodoId.Type
export type Expect<T extends true> = T
export type Check = Expect<true>
