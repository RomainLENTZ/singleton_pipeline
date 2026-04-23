import chalk from 'chalk';

// ============================================================
// CLI theme — semantic tokens. Change palette here.
// ============================================================

const accent = chalk.hex('#AF87FF');

// -- Semantic styles ----------------------------------------
export const style = {
  // Informational
  title:     (s) => accent.bold(s),
  heading:   (s) => chalk.bold(s),
  muted:     (s) => chalk.hex('#676498')(s),
  dim:       (s) => chalk.gray.italic(s),

  // Status
  success:   (s) => chalk.green(s),
  warn:      (s) => chalk.yellow(s),
  error:     (s) => chalk.red(s),
  info:      (s) => accent(s),

  // Data accents
  accent:    (s) => accent(s),
  id:        (s) => accent.bold(s),
  path:      (s) => chalk.gray(s),
  value:     (s) => chalk.white(s),
  code:      (s) => chalk.magenta(s)
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
export const line = {
  success: (msg) => `${style.success(mark.success)} ${msg}`,
  error:   (msg) => `${style.error(mark.error)} ${msg}`,
  warn:    (msg) => `${style.warn(mark.warn)} ${msg}`,
  info:    (msg) => `${style.info(mark.info)} ${msg}`
};
