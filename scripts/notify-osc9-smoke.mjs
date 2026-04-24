import fs from 'node:fs'

function sanitizeOscText(value) {
	return String(value || '')
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function truncateText(value, maxLength) {
	if (value.length <= maxLength) return value
	return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function formatOsc9Message(title, body) {
	const safeTitle = sanitizeOscText(title)
	const safeBody = sanitizeOscText(body)
	const combined = [safeTitle, safeBody].filter(Boolean).join(' — ')
	const prefixed = /^\d+;/.test(combined) ? `OpenCode ${combined}` : combined
	return truncateText(prefixed, 512)
}

function getTerminalNotificationSupport() {
	if (process.env.ZELLIJ) return { supported: false, reason: 'zellij-not-supported' }
	if (process.env.TMUX) return { supported: false, reason: 'tmux-requires-passthrough' }
	if (process.env.STY) return { supported: false, reason: 'screen-not-supported' }

	const termProgram = (process.env.TERM_PROGRAM || '').trim().toLowerCase()
	const term = (process.env.TERM || '').trim().toLowerCase()

	if (termProgram === 'ghostty' || term.includes('ghostty')) {
		return { supported: true, terminal: 'ghostty' }
	}

	if (termProgram === 'iterm.app') {
		return { supported: true, terminal: 'iterm2' }
	}

	if (process.env.KITTY_WINDOW_ID || term.includes('kitty')) {
		return { supported: true, terminal: 'kitty' }
	}

	if (termProgram === 'wezterm' || process.env.WEZTERM_PANE) {
		return { supported: true, terminal: 'wezterm' }
	}

	return { supported: false, reason: 'terminal-unsupported' }
}

function writeTerminalSequence(sequence) {
	try {
		fs.appendFileSync('/dev/tty', sequence, { encoding: 'utf8' })
		return '/dev/tty'
	} catch {
		// fall through
	}

	for (const [name, stream] of [
		['stderr', process.stderr],
		['stdout', process.stdout],
	]) {
		if (!stream?.isTTY || typeof stream.write !== 'function') continue
		try {
			stream.write(sequence)
			return name
		} catch {
			// try next stream
		}
	}

	return null
}

const argv = process.argv.slice(2)
const noSend = argv.includes('--check')
const titleArgIndex = argv.indexOf('--title')
const messageArgIndex = argv.indexOf('--message')
const title = titleArgIndex >= 0 ? argv[titleArgIndex + 1] || 'OpenCode smoke test' : 'OpenCode smoke test'
const body =
	messageArgIndex >= 0 ? argv[messageArgIndex + 1] || 'OSC 9 terminal notification' : 'OSC 9 terminal notification'

const support = getTerminalNotificationSupport()
const payload = formatOsc9Message(title, body)

console.log(`terminal=${support.terminal || 'unknown'}`)
console.log(`supported=${support.supported}`)
if (support.reason) console.log(`reason=${support.reason}`)
console.log(`tty=/dev/tty:${fs.existsSync('/dev/tty')}`)
console.log(`stderr.isTTY=${Boolean(process.stderr?.isTTY)}`)
console.log(`stdout.isTTY=${Boolean(process.stdout?.isTTY)}`)
console.log(`payload=${payload}`)

if (noSend) process.exit(support.supported ? 0 : 1)

if (!support.supported) {
	console.error(
		'Refusing to send OSC 9 because this terminal is not currently detected as supported. Use --check for diagnostics only.',
	)
	process.exit(1)
}

const target = writeTerminalSequence(`\u001b]9;${payload}\u001b\\`)

if (!target) {
	console.error('Failed to reach a writable TTY for OSC 9 output.')
	process.exit(1)
}

console.log(`sent_via=${target}`)
