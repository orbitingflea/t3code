// Exposes editable inline-math TipTap support and stable tldraw text options.
import { InputRule, Node, PasteRule, type Editor as TiptapEditor } from '@tiptap/core'
import { MathView, mathPlugin, mathSelectPlugin } from '@benrbray/prosemirror-math'
import { Fragment, type Node as PMNode, type NodeType } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import katex from 'katex'
import { tipTapDefaultExtensions, type TldrawOptions } from 'tldraw'
import { findMathInputRule, findMathPasteRule } from './mathsplit'

const KATEX_OPTIONS = { throwOnError: false, displayMode: false } as const
const mathRuleHandler = (type: NodeType) => ({ state, range, match }: Parameters<InputRule['handler']>[0]) => {
  if (match[1]) state.tr.replaceRangeWith(range.from, range.to, type.create(null, state.schema.text(match[1])))
}
type Edge = 'left' | 'right'
let pendingEdge: Edge = 'left'
interface MathViewInternals { _innerView?: EditorView; _node: PMNode }

class WhiteboardMathView extends MathView {
  tiptap?: TiptapEditor
  private keyedInner?: EditorView

  override selectNode() {
    super.selectNode()
    const { _innerView: inner, _node: node } = this as unknown as MathViewInternals
    if (!inner) return
    if (pendingEdge === 'right') {
      inner.dispatch(inner.state.tr.setSelection(TextSelection.create(inner.state.doc, node.nodeSize - 2)))
    }
    pendingEdge = 'left'
    if (this.keyedInner !== inner) {
      inner.dom.addEventListener('keydown', (event) => this.onInnerKeyDown(event, inner))
      this.keyedInner = inner
    }
  }

  private onInnerKeyDown(event: KeyboardEvent, inner: EditorView) {
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === 'a') {
      event.preventDefault()
      inner.dispatch(inner.state.tr.setSelection(TextSelection.create(inner.state.doc, 0, inner.state.doc.content.size)))
    } else if (key === 'z' || key === 'y') {
      event.preventDefault()
      const commands = this.tiptap?.commands as unknown as { undo?: () => boolean; redo?: () => boolean }
      if (key === 'y' || event.shiftKey) commands.redo?.()
      else commands.undo?.()
    }
  }
}

export const InlineMath = Node.create({
  name: 'math_inline',
  group: 'inline math',
  content: 'text*',
  inline: true,
  atom: true,
  parseHTML() {
    return [
      { tag: 'math-inline' },
      {
        tag: 'span[data-type="inline-math"]',
        getContent: (dom, schema) => {
          const element = dom as HTMLElement
          const latex = element.querySelector('[data-math-source]')?.textContent ?? element.dataset.latex ?? ''
          return latex ? Fragment.from(schema.text(latex)) : Fragment.empty
        },
      },
    ]
  },
  renderHTML({ node }) {
    const latex = node.textContent
    const dom = document.createElement('span')
    dom.dataset.type = 'inline-math'
    dom.dataset.latex = latex
    const rendered = document.createElement('span')
    katex.render(latex, rendered, KATEX_OPTIONS)
    const source = document.createElement('span')
    source.dataset.mathSource = ''
    source.hidden = true
    source.textContent = latex
    dom.append(rendered, source)
    return { dom }
  },
  renderText: ({ node }) => `$${node.textContent}$`,
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({ props: { nodeViews: {
        math_inline: (node, view, getPos) => {
          const mathView = new WhiteboardMathView(node, view, getPos as () => number, { katexOptions: KATEX_OPTIONS }, mathPlugin as never)
          mathView.tiptap = editor
          return mathView
        },
      } } }),
      mathPlugin,
      mathSelectPlugin,
    ]
  },
  addKeyboardShortcuts() {
    const enter = (edge: Edge, side: 'before' | 'after') => () => {
      const { state, view } = this.editor
      if (!state.selection.empty) return false
      const node = side === 'before' ? state.selection.$from.nodeBefore : state.selection.$from.nodeAfter
      if (node?.type !== this.type) return false
      pendingEdge = edge
      const pos = side === 'before' ? state.selection.from - node.nodeSize : state.selection.from
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)))
      return true
    }
    const fromRight = enter('right', 'before')
    return { ArrowLeft: fromRight, Backspace: fromRight, ArrowRight: enter('left', 'after') }
  },
  addInputRules() {
    return [new InputRule({ find: findMathInputRule, handler: mathRuleHandler(this.type) })]
  },
  addPasteRules() {
    return [new PasteRule({ find: findMathPasteRule, handler: mathRuleHandler(this.type) })]
  },
})

export const mathTextOptions = {
  text: { tipTapConfig: { extensions: [...tipTapDefaultExtensions, InlineMath] } },
} satisfies Partial<TldrawOptions>
