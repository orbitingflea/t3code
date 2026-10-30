# Login shells may replace the inherited PATH; restore the whiteboard CLI directory afterward.
WHITEBOARD_TOOLS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case ":$PATH:" in
  *":$WHITEBOARD_TOOLS_DIR/bin:"*) ;;
  *) export PATH="$WHITEBOARD_TOOLS_DIR/bin:$PATH" ;;
esac
unset WHITEBOARD_TOOLS_DIR
