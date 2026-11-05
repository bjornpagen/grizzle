export { relay } from "#fixture/relay.ts"

export type Options = Readonly<{
	limit?: number // violation
	label: string
}>

export const open = (options: Options): string => options.label

export interface Config {
	readonly retries?: number // violation
	readonly nested: Readonly<{ depth?: number }> // violation
}

export class Client {
	readonly config: Config

	constructor(config: Config) {
		this.config = config
	}
}

export type Relayed = Readonly<{ channel: string; echo?: boolean }> // violation

export const builder = () => ({
	run: (input: Readonly<{ dryRun?: boolean }>) => input // violation
})

export const each = (visit: (item: string) => Readonly<{ stop?: boolean }>) => visit // violation

export const many = (inputs: ReadonlyArray<Readonly<{ tag?: string }>>) => inputs // violation

export const keyed = (inputs: Readonly<Record<string, Readonly<{ weight?: number }>>>) => inputs // violation

export const gated = <B extends boolean>(
	input: B extends true ? Readonly<{ token: string }> : Readonly<{ token?: string }> // violation
) => input

export const bounded = <T extends Readonly<{ scale?: number }>>(input: T): number => input.scale ?? 1 // violation

export type Size = Readonly<{
	width: number // violation
}>

export const resize = (size: Partial<Size>) => size
