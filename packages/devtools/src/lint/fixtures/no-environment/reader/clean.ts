export const startupVariableSet = (name: string): boolean => {
	const value = process.env[name]
	return value !== undefined && value !== ""
}
