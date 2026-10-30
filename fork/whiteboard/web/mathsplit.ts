// Exposes TipTap finders for non-empty $...$ spans paired within one line.
type Span = { index: number; text: string; latex: string }
type RuleMatch = { index: number; text: string; replaceWith: string }

function scanMath(text: string): Span[] {
  const spans: Span[] = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '$') continue
    let end = start + 1
    while (end < text.length && text[end] !== '$' && text[end] !== '\n') end++
    if (text[end] !== '$') continue
    const latex = text.slice(start + 1, end).trim()
    if (latex) spans.push({ index: start, text: text.slice(start, end + 1), latex })
    start = end
  }
  return spans
}

const toMatch = (span: Span): RuleMatch => ({ index: span.index, text: span.text, replaceWith: span.latex })
export function findMathInputRule(text: string): RuleMatch | null {
  const last = scanMath(text).at(-1)
  return last && last.index + last.text.length === text.length ? toMatch(last) : null
}
export function findMathPasteRule(text: string): RuleMatch[] {
  return scanMath(text).map(toMatch)
}


type RichNode = { type?: string; text?: string; content?: RichNode[]; [key: string]: unknown }
export function normalizeMath(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const visit = (node: RichNode): RichNode[] => {
    if (node.type === 'math_inline') return [node]
    if (node.type === 'text' && typeof node.text === 'string') {
      const spans = scanMath(node.text)
      if (!spans.length) return [node]
      const out: RichNode[] = []
      let at = 0
      for (const span of spans) {
        if (span.index > at) out.push({ ...node, text: node.text.slice(at, span.index) })
        out.push({ type: 'math_inline', content: [{ type: 'text', text: span.latex }] })
        at = span.index + span.text.length
      }
      if (at < node.text.length) out.push({ ...node, text: node.text.slice(at) })
      return out
    }
    return [{ ...node, ...(node.content ? { content: node.content.flatMap(visit) } : {}) }]
  }
  return visit(value as RichNode)[0]
}
