interface Shape {
	readonly kind: string
}
export type Alias = Shape // violation
export type Text = string // violation
export type Pair = readonly [string, number]
