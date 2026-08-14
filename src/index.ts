// dsh-mermaid — Mermaid 流程圖渲染 plugin for DeepSeek Harness.
//
// Port of Gurpartap/pi-mermaid@0.3.0 (MIT). The ported logic (block
// extraction, type support, hashing, caching, parser validation, issue
// reporting) is kept as close to upstream as dsh permits:
//
//   - upstream entry `export default (pi: ExtensionAPI)` → dsh namespace
//     entry `{ name, apply }` (dsh loader requires the namespace shape);
//   - upstream `pi.on('input')` / `pi.on('agent_end')` → dsh
//     `ctx.on('session/event')` watching `user/message` and
//     `assistant/message` (no Pi-style input/agent_end events in dsh);
//   - upstream `renderMermaidAscii` → `renderMermaidSVG` (same
//     beautiful-mermaid package; dsh has a web client, not a TUI);
//   - upstream TUI renderer (`registerMessageRenderer` + Box/Text) → dsh
//     client slot (see lib/client.js) that renders the SVG produced here;
//   - upstream `pi.sendMessage({customType, display, details})` → results
//     stored per (session, turn) and served to the client over a same-origin
//     webServer route;
//   - upstream `pi.registerCommand('pi-mermaid')` → dsh command `mermaid`.
//
// Every other constant, regex, limit, and algorithm below is verbatim from
// upstream index.ts.

import { createHash } from 'node:crypto'
import { renderMermaidSVG } from 'beautiful-mermaid'

export const name = 'dsh-mermaid'

const MESSAGE_TYPE = 'dsh-mermaid'
const MERMAID_BLOCK_RE = /```mermaid\s*([\s\S]*?)```/gi
const ISSUE_LINE_RE = /^\[mermaid:(warning|error)\](?:\[hash:[^\]]+\])?\s*(.*)$/
const COLLAPSED_LINES = 10
const MAX_BLOCKS = 5
const MAX_SOURCE_LINES = 400
const MAX_SOURCE_CHARS = 20000
const MAX_SEEN_ISSUES = 200
const MAX_SVG_CACHE = 200

const SUPPORTED_TYPES = new Map([
  ['graph', 'flowchart'],
  ['flowchart', 'flowchart'],
  ['sequenceDiagram', 'sequence'],
  ['classDiagram', 'class'],
  ['erDiagram', 'er'],
  ['stateDiagram', 'state'],
  ['stateDiagram-v2', 'state'],
])
export const SUPPORTED_TYPE_LABEL = 'graph/flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram(-v2)'

let mermaidParser: ((text: string) => Promise<void>) | null = null
let mermaidParserError: string | null = null
let mermaidParserWarned = false
const seenIssueKeys = new Map()
const svgCache = new Map()

function isDomPurifyError(message) {
  return message.includes('DOMPurify.addHook') || message.includes('DOMPurify')
}

async function getMermaidParser(): Promise<((text: string) => Promise<void>) | null> {
  if (mermaidParser || mermaidParserError) return mermaidParser

  try {
    const mod = await import('mermaid')
    const api = (mod as any).default ?? (mod as any).mermaidAPI ?? mod
    if (!api || typeof api.parse !== 'function') {
      mermaidParserError = 'Mermaid parse API not available'
      return null
    }
    if (typeof api.initialize === 'function') {
      try {
        api.initialize({ startOnLoad: false })
      } catch {
        // ignore initialization errors
      }
    }
    mermaidParser = async (text) => {
      const result = api.parse(text)
      if (result && typeof result.then === 'function') {
        await result
      }
    }
    return mermaidParser
  } catch (error) {
    mermaidParserError = error instanceof Error ? error.message : String(error)
    return null
  }
}

export function normalizeMermaidSource(source) {
  return source.replace(/\s+$/g, '')
}

export function formatIssueLines(issues, hash) {
  if (issues.length === 0) return ''
  return issues.map((issue) => `[mermaid:${issue.severity}][hash:${hash}] ${issue.message}`).join('\n')
}

export function buildContextContent(block, hash, issues, includeSource) {
  const issueLines = formatIssueLines(issues, hash)
  if (!includeSource) return issueLines

  const normalizedBlock = normalizeMermaidSource(block)
  const sourceBlock = `%% mermaid-hash: ${hash}\n${normalizedBlock}`
  const contextBlock = `\`\`\`mermaid\n${sourceBlock}\n\`\`\``
  return issueLines ? `${issueLines}\n\n${contextBlock}` : contextBlock
}

export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && part.type === 'text' ? part.text : ''))
      .filter((part) => part.trim().length > 0)
      .join('\n')
  }
  return ''
}

export function extractMermaidBlocks(text, maxBlocks = Infinity) {
  const blocks = []
  MERMAID_BLOCK_RE.lastIndex = 0
  let match = null
  while ((match = MERMAID_BLOCK_RE.exec(text)) !== null) {
    const code = match[1]?.trim()
    if (code) blocks.push(code)
    if (blocks.length >= maxBlocks) break
  }
  return blocks
}

export function getMermaidTypeToken(block) {
  const lines = block.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('%%')) continue
    return trimmed.split(/\s+/)[0] ?? null
  }
  return null
}

export function getSupportedMermaidType(block) {
  const token = getMermaidTypeToken(block)
  if (!token) return { token, normalized: null }
  return { token, normalized: SUPPORTED_TYPES.get(token) ?? null }
}

export function hashMermaid(block) {
  return createHash('sha256').update(block).digest('hex').slice(0, 8)
}

function getCachedVariant(key) {
  const cached = svgCache.get(key)
  if (!cached) return null
  svgCache.delete(key)
  svgCache.set(key, cached)
  return cached
}

function setCachedVariant(key, variant) {
  svgCache.set(key, variant)
  if (svgCache.size > MAX_SVG_CACHE) {
    const oldest = svgCache.keys().next().value
    if (oldest) svgCache.delete(oldest)
  }
}

export function splitIssuesFromContent(text) {
  if (!text) return { ascii: '', issues: [] }

  const lines = text.split(/\r?\n/)
  const issues = []
  let current = null
  let i = 0
  let inIssues = false

  while (i < lines.length) {
    const line = lines[i]
    const match = line.match(ISSUE_LINE_RE)

    if (match) {
      inIssues = true
      if (current) issues.push(current)
      current = { severity: match[1], message: match[2] }
      i++
      continue
    }

    if (inIssues) {
      if (line.trim() === '') {
        if (current) issues.push(current)
        i++
        break
      }
      if (current) {
        current = { ...current, message: `${current.message}\n${line}` }
      }
      i++
      continue
    }

    break
  }

  if (current && !issues.includes(current)) issues.push(current)

  const ascii = lines.slice(i).join('\n')
  if (issues.length > 0) return { ascii, issues }
  return { ascii: ascii || text, issues }
}

export function getLastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type !== 'message') continue
    if (entry.message.role !== 'assistant') continue
    const text = extractText(entry.message.content)
    if (text.trim()) return text
  }
  return null
}

async function processBlock(block, blockIndex, blockLabel, parser, warnParserUnavailable) {
  const issues = []
  const notifications = []
  const diagramHash = hashMermaid(block)

  const addIssue = (severity, message) => {
    notifications.push({ message, type: severity === 'error' ? 'error' : 'warning' })
    const key = `${diagramHash}:${severity}:${message}`
    if (seenIssueKeys.has(key)) return
    seenIssueKeys.set(key, true)
    if (seenIssueKeys.size > MAX_SEEN_ISSUES) {
      const oldest = seenIssueKeys.keys().next().value
      if (oldest) seenIssueKeys.delete(oldest)
    }
    issues.push({ severity, message })
  }

  let parserFailed = false
  if (parser) {
    try {
      await parser(block)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (isDomPurifyError(errorMessage)) {
        warnParserUnavailable(errorMessage)
      } else {
        parserFailed = true
        const message = `Mermaid parse error${blockLabel}: ${errorMessage}`
        addIssue('error', message)
      }
    }
  }

  let svg = ''
  if (parserFailed) {
    svg = ''
  } else {
    try {
      const cacheKey = diagramHash
      const cached = getCachedVariant(cacheKey)
      if (cached) {
        svg = cached.svg
      } else {
        svg = renderMermaidSVG(block).trimEnd()
        setCachedVariant(cacheKey, { svg })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const message = `Mermaid render failed${blockLabel}: ${errorMessage}`
      addIssue('error', message)
      svg = ''
    }
  }

  return {
    diagramHash,
    details: {
      source: block,
      index: blockIndex,
      svg,
      issues: issues.length > 0 ? issues : undefined,
    },
    issues,
    notifications,
  }
}

// --- dsh wiring ----------------------------------------------------------

/**
 * Render every mermaid block found in `text` and store the resulting SVG
 * per (session, turn). Shared by the session-event watcher and the command.
 */
async function renderBlocksFor(
  sessionId: string,
  turn: number,
  text: string,
  options: { notify?: (message: string, type: string) => void } = {},
) {
  const blocks = extractMermaidBlocks(text, MAX_BLOCKS + 1)
  if (blocks.length === 0) return []

  const notify = (message: string, type: string) => {
    if (options.notify) options.notify(message, type)
  }
  const warnParserUnavailable = (errorMessage?: string) => {
    if (mermaidParserWarned) return
    const suffixSource = errorMessage ?? mermaidParserError
    const suffix = suffixSource ? ` (${suffixSource})` : ''
    notify(
      `Mermaid parser validation isn't usable right now${suffix}. Will try again next time; rendering anyway.`,
      'warning',
    )
    mermaidParserWarned = true
  }

  let parser = await getMermaidParser()
  if (!parser) warnParserUnavailable()

  if (blocks.length > MAX_BLOCKS) {
    notify(`Found ${blocks.length} mermaid blocks, rendering first ${MAX_BLOCKS}.`, 'warning')
  }

  const results = []
  for (const [index, block] of blocks.slice(0, MAX_BLOCKS).entries()) {
    const blockIndex = index + 1
    const blockLabel = blocks.length > 1 ? ` (block ${blockIndex})` : ''
    const sourceLines = block.split(/\r?\n/)
    if (sourceLines.length > MAX_SOURCE_LINES || block.length > MAX_SOURCE_CHARS) {
      notify(
        `Mermaid block ${blockIndex} too large (${sourceLines.length} lines, ${block.length} chars).`,
        'warning',
      )
      continue
    }

    const { token, normalized } = getSupportedMermaidType(block)
    if (!normalized) {
      const typeLabel = token ?? 'unknown'
      notify(
        `dsh-mermaid can't render type "${typeLabel}"${blockLabel}. Supported: ${SUPPORTED_TYPE_LABEL}.`,
        'info',
      )
      continue
    }

    const { diagramHash, details, issues, notifications } = await processBlock(
      block,
      blockIndex,
      blockLabel,
      parser,
      warnParserUnavailable,
    )
    results.push({ hash: diagramHash, source: details.source, svg: details.svg, issues: details.issues ?? [] })
    for (const notification of notifications) {
      notify(notification.message, notification.type)
    }
  }
  return results
}

/** In-memory per-(session, turn) store; served to the web client. */
export function createRenderStore() {
  const bySession = new Map()
  return {
    /** Record the rendered results for a (session, turn). */
    set(sessionId, turn, results) {
      if (results.length === 0) return
      let turns = bySession.get(sessionId)
      if (turns === undefined) {
        turns = new Map()
        bySession.set(sessionId, turns)
      }
      turns.set(turn, results)
    },
    /** Read results for a (session, turn); undefined when nothing rendered. */
    get(sessionId, turn) {
      return bySession.get(sessionId)?.get(turn)
    },
    /** All turns recorded for a session, newest first. */
    list(sessionId) {
      const turns = bySession.get(sessionId)
      if (turns === undefined) return []
      return [...turns.entries()].sort((a, b) => b[0] - a[0]).map(([turn, results]) => ({ turn, results }))
    },
  }
}

export function apply(ctx) {
  const store = createRenderStore()
  // track the current turn for `user/message` events, which carry no turn.
  let currentTurn = 0

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn
      return
    }
    if (event.type === 'user/message') {
      const text = extractText(event.data.content)
      if (!text) return
      void renderBlocksFor(session.id, currentTurn, text, {
        notify: (message, type) => ctx.logger?.warn?.(`[${name}] ${type}: ${message}`),
      }).then((results) => store.set(session.id, currentTurn, results))
      return
    }
    if (event.type === 'assistant/message') {
      const text = extractText(event.data.message?.content)
      if (!text) return
      void renderBlocksFor(session.id, event.data.turn, text, {
        notify: (message, type) => ctx.logger?.warn?.(`[${name}] ${type}: ${message}`),
      }).then((results) => store.set(session.id, event.data.turn, results))
    }
  })

  // Same-origin route the web client reads rendered SVGs from.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-mermaid/api',
        handler: async (req, res) => {
          const remote = String(req.socket?.remoteAddress ?? '')
          if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
            responseJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'dsh-mermaid route is localhost-only' } })
            return
          }
          if (req.method !== 'POST') {
            responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
            return
          }
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'invalid JSON body' } })
            return
          }
          const sessionId = typeof body?.session === 'string' ? body.session : ''
          const turn = typeof body?.turn === 'number' ? body.turn : undefined
          if (!sessionId || turn === undefined) {
            responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'session and turn are required' } })
            return
          }
          const results = store.get(sessionId, turn)
          responseJson(res, 200, { ok: true, value: results ?? [] })
        },
      })
      return () => dispose()
    }, 'dsh-mermaid: web route')
  })

  // Manual re-render of the last assistant message (upstream /pi-mermaid).
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'mermaid',
      description: 'Render mermaid blocks in the last assistant message as SVG',
      handler: async (invocation) => {
        const session = invocation.agent?.session
        if (!session) return { kind: 'error', text: 'No active session' }
        const text = getLastAssistantText(session.events)
        if (!text) return { kind: 'error', text: 'No assistant message found' }
        const results = await renderBlocksFor(session.id, currentTurn, text, {
          notify: () => {},
        })
        store.set(session.id, currentTurn, results)
        if (results.length === 0) return { kind: 'error', text: 'No mermaid blocks found' }
        return { kind: 'success', text: `Rendered ${results.length} mermaid block(s).` }
      },
    })
  })
}

async function readBody(req) {
  // webServer hands a plain http.IncomingMessage (or a compatible object).
  if (typeof req.body === 'string') return req.body
  if (req.readableEnded && req.body === undefined) return ''
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    chunks.push(chunk)
    size += chunk.length
    if (size > 1_000_000) throw new RangeError('request body too large')
  }
  return Buffer.concat(chunks).toString('utf8')
}

function responseJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status)
  res.end(bytes)
}
