const GLYPHS: Record<string, string[]> = {
  O: ['████ ', '█  █ ', '█  █ ', '█  █ ', '████ '],
  V: ['█  █ ', '█  █ ', '█  █ ', ' ██  ', ' ██  '],
  L: ['█    ', '█    ', '█    ', '█    ', '████ '],
  9: ['████ ', '█  █ ', '████ ', '   █ ', '████ '],
}

export const BRAND_LOGO_ROWS = Array.from({ length: 5 }, (_, row) =>
  [...'OVOLV999'].map((character) => GLYPHS[character][row]).join(' '),
)
