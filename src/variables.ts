import type { JsonValue, CompanionVariableDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export function UpdateVariableDefinitions(self: Kahuna): void {
	const variables: CompanionVariableDefinitions<Record<string, JsonValue>> = {}
	self.setVariableDefinitions(variables)
}
