/** Minimal ANSI color/format helpers (no dependencies). */
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: number, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const color = {
  bold: (s: string) => wrap(1, s),
  dim: (s: string) => wrap(2, s),
  green: (s: string) => wrap(32, s),
  red: (s: string) => wrap(31, s),
  yellow: (s: string) => wrap(33, s),
  cyan: (s: string) => wrap(36, s),
  blue: (s: string) => wrap(34, s),
  gray: (s: string) => wrap(90, s),
};

export const symbols = {
  check: enabled ? '\u2713' : '✓',
  arrow: enabled ? '\u2192' : '→',
  bullet: enabled ? '\u2022' : '•',
};

/** Render the banner box. */
export function banner(title: string, lines: string[]): string {
  const width = 42;
  const border = '─'.repeat(width);
  const row = (label: string, value: string) => `│ ${label.padEnd(16)} ${value}`.padEnd(width + 1) + '│';
  return [
    `╭${border}╮`,
    `│ ${title.padEnd(width - 1)}│`,
    `├${border}┤`,
    ...lines.map((l) => `│ ${l.padEnd(width - 1)}│`),
    `╰${border}╯`,
  ].join('\n');
}
