declare const phantom: unique symbol

export const open = (options: Readonly<{ limit: number | undefined; label: string }>): string =>
	options.label

export type PageRequest =
	| Readonly<{ first: number; last?: never }>
	| Readonly<{ last: number; first?: never; before?: undefined }>

export const page = (request: PageRequest): PageRequest => request

export type Tagged = Readonly<{ value: string; [phantom]?: true }>

export const tag = (value: Tagged): Tagged => value

export const read = (): Readonly<{ note?: string }> => ({})

export const visit = (callback: (event: Readonly<{ detail?: string }>) => void): void => {
	callback({})
}

const local = (options: Readonly<{ verbose?: boolean }>): boolean => options.verbose === true

export const useLocal = (): boolean => local({})

export type Shape = Readonly<{ optional?: string }>

export type HiddenOptions = Readonly<{ limit?: number }>

export const same = <T extends Readonly<{ id: string }>>(input: T): T => input

export const url = (input: Partial<URL>) => input
