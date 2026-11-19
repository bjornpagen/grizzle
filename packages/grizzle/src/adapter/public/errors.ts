export { OpenError, type OpenReason, type OpenStage } from "#adapter/errors/execution.ts"

export {
	type ClaimFault,
	ClaimRefused,
	ConnectionEnvironmentRefused,
	CredentialError,
	DbConfigRefused,
	ExpiryRefused,
	LiveSourceMissing,
	RoleOutsideLayers,
	ServedLoginRefused,
	type SettingFault,
	type SettingRule,
	TokenError,
	TokenMalformed
} from "#adapter/errors/failures.ts"
