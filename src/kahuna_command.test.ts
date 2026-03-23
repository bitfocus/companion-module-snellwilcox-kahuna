/**
 * KahunaCommand.test.ts
 *
 * Unit tests for KahunaCommand — covers wire-format output, stage
 * progression, zero-padding, and error handling for invalid inputs.
 */

import { describe, it, expect } from 'vitest'
import { KahunaCommand } from './kahuna_command.js'
import { MacroStage, type MacroMessage } from './kahuna.types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a MacroMessage from a plain array of stages. */
function makeMessage(project: number, macro: number, stages: MacroStage[]): MacroMessage {
	return {
		project,
		macro,
		getNumberStages: () => stages.length,
		getStage: (index: number): MacroStage => {
			const stage = stages[index]
			if (stage === undefined) throw new RangeError(`Stage index ${index} out of range`)
			return stage
		},
	}
}

/** Standard two-stage (LOAD → TRIGGER) message, matching buildMacroMessage(). */
function loadTriggerMessage(project: number, macro: number): MacroMessage {
	return makeMessage(project, macro, [MacroStage.LOAD, MacroStage.TRIGGER])
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('constructor', () => {
	it('stores the message reference', () => {
		const msg = loadTriggerMessage(1, 1)
		const cmd = new KahunaCommand(msg)
		expect(cmd.message).toBe(msg)
	})

	it('starts at stage 0', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(1, 1))
		expect(cmd.isFinished()).toBe(false)
	})
})

// ─── Stage control ────────────────────────────────────────────────────────────

describe('isFinished', () => {
	it('is false before any stages have been advanced', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(1, 1))
		expect(cmd.isFinished()).toBe(false)
	})

	it('is false after advancing through the first stage', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(1, 1))
		cmd.nextStage()
		expect(cmd.isFinished()).toBe(false)
	})

	it('is true once all stages have been advanced through', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(1, 1))
		cmd.nextStage()
		cmd.nextStage()
		expect(cmd.isFinished()).toBe(true)
	})

	it('remains true if nextStage is called beyond the final stage', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(1, 1))
		cmd.nextStage()
		cmd.nextStage()
		cmd.nextStage() // past the end
		expect(cmd.isFinished()).toBe(true)
	})

	it('is true immediately for a zero-stage message', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, []))
		expect(cmd.isFinished()).toBe(true)
	})
})

describe('nextStage', () => {
	it('advances through all three stage types in sequence', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.LOAD, MacroStage.TRIGGER, MacroStage.UNLOAD]))
		expect(cmd.toString()).toMatch(/^MLD/)
		cmd.nextStage()
		expect(cmd.toString()).toMatch(/^MTR/)
		cmd.nextStage()
		expect(cmd.toString()).toMatch(/^MUL/)
	})
})

// ─── Wire format — stage prefixes ─────────────────────────────────────────────

describe('toString — stage prefixes', () => {
	it('produces MLD for LOAD', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.LOAD]))
		expect(cmd.toString()).toMatch(/^MLD/)
	})

	it('produces MTR for TRIGGER', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.TRIGGER]))
		expect(cmd.toString()).toMatch(/^MTR/)
	})

	it('produces MUL for UNLOAD', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.UNLOAD]))
		expect(cmd.toString()).toMatch(/^MUL/)
	})
})

// ─── Wire format — zero padding ───────────────────────────────────────────────

describe('toString — zero padding', () => {
	it('pads a single-digit project to two digits', () => {
		const cmd = new KahunaCommand(makeMessage(1, 100, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,100\r')
	})

	it('does not pad a two-digit project', () => {
		const cmd = new KahunaCommand(makeMessage(12, 100, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD12,100\r')
	})

	it('pads a single-digit macro to three digits', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,001\r')
	})

	it('pads a two-digit macro to three digits', () => {
		const cmd = new KahunaCommand(makeMessage(1, 42, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,042\r')
	})

	it('does not pad a three-digit macro', () => {
		const cmd = new KahunaCommand(makeMessage(1, 100, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,100\r')
	})
})

// ─── Wire format — full string ────────────────────────────────────────────────

describe('toString — full wire string', () => {
	it('produces the correct full string for a LOAD stage', () => {
		const cmd = new KahunaCommand(makeMessage(3, 7, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD03,007\r')
	})

	it('produces the correct full string for a TRIGGER stage', () => {
		const cmd = new KahunaCommand(makeMessage(3, 7, [MacroStage.TRIGGER]))
		expect(cmd.toString()).toBe('MTR03,007\r')
	})

	it('produces the correct full string for an UNLOAD stage', () => {
		const cmd = new KahunaCommand(makeMessage(3, 7, [MacroStage.UNLOAD]))
		expect(cmd.toString()).toBe('MUL03,007\r')
	})

	it('always terminates with a carriage return', () => {
		const cmd = new KahunaCommand(makeMessage(1, 1, [MacroStage.TRIGGER]))
		expect(cmd.toString()).toMatch(/\r$/)
	})

	it('uses a comma to separate project and macro', () => {
		const cmd = new KahunaCommand(makeMessage(5, 10, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD05,010\r')
	})
})

// ─── Wire format — boundary values ───────────────────────────────────────────

describe('toString — boundary values', () => {
	it('handles project=0 (zero-padded to 00)', () => {
		const cmd = new KahunaCommand(makeMessage(0, 1, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD00,001\r')
	})

	it('handles macro=0 (zero-padded to 000)', () => {
		const cmd = new KahunaCommand(makeMessage(1, 0, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,000\r')
	})

	it('handles maximum two-digit project (99)', () => {
		const cmd = new KahunaCommand(makeMessage(99, 1, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD99,001\r')
	})

	it('handles maximum three-digit macro (999)', () => {
		const cmd = new KahunaCommand(makeMessage(1, 999, [MacroStage.LOAD]))
		expect(cmd.toString()).toBe('MLD01,999\r')
	})
})

// ─── Wire format — full LOAD → TRIGGER sequence ───────────────────────────────

describe('toString — LOAD → TRIGGER sequence', () => {
	it('produces the correct wire string at each stage', () => {
		const cmd = new KahunaCommand(loadTriggerMessage(5, 42))

		expect(cmd.toString()).toBe('MLD05,042\r')
		expect(cmd.isFinished()).toBe(false)

		cmd.nextStage()
		expect(cmd.toString()).toBe('MTR05,042\r')
		expect(cmd.isFinished()).toBe(false)

		cmd.nextStage()
		expect(cmd.isFinished()).toBe(true)
	})
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('toString — invalid stage', () => {
	it('throws when getStage returns an unrecognised value', () => {
		const msg: MacroMessage = {
			project: 1,
			macro: 1,
			getNumberStages: () => 1,
			getStage: () => 'INVALID' as MacroStage,
		}
		const cmd = new KahunaCommand(msg)
		expect(() => cmd.toString()).toThrow('Unknown macro stage: INVALID')
	})
})
