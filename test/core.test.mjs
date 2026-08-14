// dsh-mermaid core logic tests — mirrors upstream pi-mermaid@0.3.0 behavior.
// Tests the ported pure functions (extractMermaidBlocks, type support, hashing,
// context building, issue splitting) before any dsh wiring is involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMermaidBlocks,
  getMermaidTypeToken,
  getSupportedMermaidType,
  hashMermaid,
  normalizeMermaidSource,
  formatIssueLines,
  buildContextContent,
  extractText,
  splitIssuesFromContent,
  getLastAssistantText,
  SUPPORTED_TYPE_LABEL,
} from '../lib/index.js'

test('extractMermaidBlocks finds fenced blocks and trims them', () => {
  const text = 'before\n```mermaid\ngraph TD\n  A --> B\n```\nafter'
  const blocks = extractMermaidBlocks(text)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0], 'graph TD\n  A --> B')
})

test('extractMermaidBlocks returns empty for no fences', () => {
  assert.deepEqual(extractMermaidBlocks('no mermaid here'), [])
  assert.deepEqual(extractMermaidBlocks('```python\nx = 1\n```'), [])
})

test('extractMermaidBlocks respects maxBlocks', () => {
  const text = '```mermaid\ngraph TD\n  A\n```\n```mermaid\ngraph TD\n  B\n```\n```mermaid\ngraph TD\n  C\n```'
  assert.equal(extractMermaidBlocks(text, 2).length, 2)
})

test('extractMermaidBlocks skips empty fences', () => {
  assert.deepEqual(extractMermaidBlocks('```mermaid\n```'), [])
})

test('getMermaidTypeToken reads first non-comment line', () => {
  assert.equal(getMermaidTypeToken('%% comment\ngraph TD\n  A'), 'graph')
  assert.equal(getMermaidTypeToken('sequenceDiagram\n  A->>B'), 'sequenceDiagram')
  assert.equal(getMermaidTypeToken('   flowchart LR\n  A'), 'flowchart')
  assert.equal(getMermaidTypeToken(''), null)
})

test('getSupportedMermaidType maps aliases to normalized types', () => {
  assert.deepEqual(getSupportedMermaidType('graph TD\n  A'), { token: 'graph', normalized: 'flowchart' })
  assert.deepEqual(getSupportedMermaidType('flowchart LR\n  A'), { token: 'flowchart', normalized: 'flowchart' })
  assert.deepEqual(getSupportedMermaidType('stateDiagram-v2\n  A'), { token: 'stateDiagram-v2', normalized: 'state' })
  assert.deepEqual(getSupportedMermaidType('pie\n  "A" : 1'), { token: 'pie', normalized: null })
  assert.deepEqual(getSupportedMermaidType(''), { token: null, normalized: null })
})

test('SUPPORTED_TYPE_LABEL lists the five supported diagram families', () => {
  assert.equal(SUPPORTED_TYPE_LABEL, 'graph/flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram(-v2)')
})

test('hashMermaid returns stable 8-char sha256 prefix', () => {
  const first = hashMermaid('graph TD\n  A --> B')
  assert.match(first, /^[0-9a-f]{8}$/)
  assert.equal(hashMermaid('graph TD\n  A --> B'), first)
  assert.notEqual(hashMermaid('graph TD\n  A --> C'), first)
})

test('normalizeMermaidSource strips trailing whitespace', () => {
  assert.equal(normalizeMermaidSource('graph TD\n  A  \n'), 'graph TD\n  A')
})

test('formatIssueLines renders severity + hash + message lines', () => {
  const issues = [
    { severity: 'error', message: 'parse failed: boom' },
    { severity: 'warning', message: 'looks off' },
  ]
  assert.equal(
    formatIssueLines(issues, 'abc12345'),
    '[mermaid:error][hash:abc12345] parse failed: boom\n[mermaid:warning][hash:abc12345] looks off',
  )
  assert.equal(formatIssueLines([], 'abc12345'), '')
})

test('buildContextContent includes source block and issue lines', () => {
  const issues = [{ severity: 'error', message: 'bad syntax' }]
  const content = buildContextContent('graph TD\n  A', 'deadbeef', issues, true)
  assert.match(content, /\[mermaid:error\]\[hash:deadbeef\] bad syntax/)
  assert.match(content, /%% mermaid-hash: deadbeef/)
  assert.match(content, /```mermaid/)
})

test('buildContextContent omits source when includeSource is false', () => {
  const issues = [{ severity: 'error', message: 'bad syntax' }]
  const content = buildContextContent('graph TD\n  A', 'deadbeef', issues, false)
  assert.equal(content, '[mermaid:error][hash:deadbeef] bad syntax')
})

test('extractText handles string and block-array content', () => {
  assert.equal(extractText('plain'), 'plain')
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(extractText([{ type: 'tool-result', content: [] }]), '')
  assert.equal(extractText(undefined), '')
})

test('splitIssuesFromContent separates issue header from ascii body', () => {
  const text = '[mermaid:error][hash:abc12345] boom\n\nMermaid (ASCII)\n ┌────┐'
  const { ascii, issues } = splitIssuesFromContent(text)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'error')
  assert.match(ascii, /Mermaid \(ASCII\)/)
})

test('getLastAssistantText walks back to the most recent non-empty assistant text', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: 'hi' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
    { type: 'message', message: { role: 'assistant', content: 'second' } },
    { type: 'other', data: {} },
  ]
  assert.equal(getLastAssistantText(entries), 'second')
  assert.equal(getLastAssistantText([{ type: 'message', message: { role: 'user', content: 'x' } }]), null)
})
