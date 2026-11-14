/** A rule above an agent message that follows another one, as markdown's `---` would draw it. */
export function AgentMessageDivider(props: { readonly show: boolean }) {
  return props.show ? <hr className="mb-3 border-border" /> : null;
}
