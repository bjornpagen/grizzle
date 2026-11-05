export const home = process.env.HOME // violation

export const where = (): string => process.cwd() // violation

const shared = (): ReadonlyArray<string> => process.argv // violation

export const exposed = (): number => shared().length

const flagged = process.argv.length // violation

if (import.meta.main) {
	console.log(process.argv.slice(2), process.cwd(), home, shared(), flagged)
}

export const nested = (): boolean => {
	if (import.meta.main) {
		return process.argv.length > 0 // violation
	}
	return false
}
