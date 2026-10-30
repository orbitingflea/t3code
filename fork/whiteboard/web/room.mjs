// Converts project paths and other room identifiers into safe snapshot names.
/** @param {string} value @returns {string} */
export function boardRoom(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'main'
}
