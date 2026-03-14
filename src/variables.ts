import type { CompanionVariableDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export type VariablesSchema = {
	tallyNumber: number
}

export function UpdateVariableDefinitions(self: Kahuna): void {
	const variables: Partial<CompanionVariableDefinitions<VariablesSchema>> = {}
	variables['tallyNumber'] = { name: 'Kahuna Tally Number' }
	self.setVariableDefinitions(variables as CompanionVariableDefinitions<VariablesSchema>)
}
