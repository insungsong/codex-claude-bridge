const TEMPLATE_PLACEHOLDER_RE = /^{{[^{}]+}}$/
const SEND_TO_CLAUDE_PREFIX_RE = /^\$send-to-claude\s*$/i
const TASK_ONLY_RE = /^Task:\s*$/i
const TASK_PLACEHOLDER_RE = /^Task:\s*{{[^{}]+}}\s*$/i

export type BridgePayloadValidationResult =
  | {
      ok: true
      text: string
      normalized: string
    }
  | {
      ok: false
      reason: 'empty' | 'placeholder-only'
      error: string
    }

function stripWrappingQuotes(text: string) {
  let candidate = text.trim()

  while (candidate.length >= 2) {
    const first = candidate[0]
    const last = candidate[candidate.length - 1]
    const isWrapped =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`')

    if (!isWrapped) break

    const unwrapped = candidate.slice(1, -1).trim()
    if (unwrapped === candidate) break
    candidate = unwrapped
  }

  return candidate
}

export function normalizeBridgeMessage(text: string) {
  return text.trim().replace(/\s+/g, ' ')
}

function isPlaceholderOnlyPayload(text: string) {
  return (
    TEMPLATE_PLACEHOLDER_RE.test(text) ||
    SEND_TO_CLAUDE_PREFIX_RE.test(text) ||
    TASK_ONLY_RE.test(text) ||
    TASK_PLACEHOLDER_RE.test(text)
  )
}

export function validateBridgeTextPayload(value: unknown): BridgePayloadValidationResult {
  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: 'empty',
      error: 'message must be a non-empty string',
    }
  }

  const text = value.trim()
  if (!text) {
    return {
      ok: false,
      reason: 'empty',
      error: 'message must be a non-empty string',
    }
  }

  const validationTarget = normalizeBridgeMessage(stripWrappingQuotes(text))
  if (!validationTarget) {
    return {
      ok: false,
      reason: 'empty',
      error: 'message must be a non-empty string',
    }
  }

  if (isPlaceholderOnlyPayload(validationTarget)) {
    return {
      ok: false,
      reason: 'placeholder-only',
      error: 'message must include real text, not an empty or placeholder-only payload',
    }
  }

  return {
    ok: true,
    text,
    normalized: normalizeBridgeMessage(text),
  }
}
