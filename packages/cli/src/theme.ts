import chalk from 'chalk';

// ============================================================
// CLI theme — semantic tokens. Change palette here.
// ============================================================

const accent = chalk.hex('#AF87FF');

type TextStyle = (text: string) => string;

type Style = {
  title: TextStyle;
  heading: TextStyle;
  muted: TextStyle;
  dim: TextStyle;
  success: TextStyle;
  warn: TextStyle;
  error: TextStyle;
  info: TextStyle;
  accent: TextStyle;
  id: TextStyle;
  path: TextStyle;
  value: TextStyle;
  code: TextStyle;
};

// -- Semantic styles ----------------------------------------
export const style: Style = {
  // Informational
  title:     (text) => accent.bold(text),
  heading:   (text) => chalk.bold(text),
  muted:     (text) => chalk.hex('#676498')(text),
  dim:       (text) => chalk.gray.italic(text),

  // Status
  success:   (text) => chalk.green(text),
  warn:      (text) => chalk.yellow(text),
  error:     (text) => chalk.red(text),
  info:      (text) => accent(text),

  // Data accents
  accent:    (text) => accent(text),
  id:        (text) => accent.bold(text),
  path:      (text) => chalk.gray(text),
  value:     (text) => chalk.white(text),
  code:      (text) => chalk.magenta(text)
};

// -- Semantic markers (prefix glyphs) -----------------------
export const mark = {
  success: '✓',
  error:   '✕',
  warn:    '!',
  info:    '›',
  bullet:  '·'
};

// -- Pre-composed line helpers ------------------------------
export const line: Record<'success' | 'error' | 'warn' | 'info', TextStyle> = {
  success: (message) => `${style.success(mark.success)} ${message}`,
  error:   (message) => `${style.error(mark.error)} ${message}`,
  warn:    (message) => `${style.warn(mark.warn)} ${message}`,
  info:    (message) => `${style.info(mark.info)} ${message}`
};
