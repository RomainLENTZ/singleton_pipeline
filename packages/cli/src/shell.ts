import blessed from 'blessed';
import { ESC_SENTINEL } from './sentinels.js';

type Suggestion = {
  value: string;
  label: string;
  description?: string;
};

type Completer = (state: { buffer: string; cursor: number }) => Promise<Suggestion[]> | Suggestion[];

type PromptMode = {
  message: string;
  silent: boolean;
  completer: Completer | null;
  default: string;
  resolve(value: string): void;
};

type ShellMode = 'running' | 'awaiting' | 'error' | null;

export const ASCII_MODE = process.env.SINGLETON_ASCII === '1'
  || (process.platform === 'win32' && process.env.SINGLETON_UNICODE !== '1');

// ── Pastel theme ────────────────────────────────────────────────
export const C = ASCII_MODE ? {
  violet:  'magenta',
  pink:    'magenta',
  blue:    'blue',
  mint:    'green',
  peach:   'yellow',
  salmon:  'red',
  dimV:    'gray',
  line:    'gray',
  ghost:   'gray',
} : {
  violet:  '#C084FC',   // accent principal
  pink:    '#F9A8D4',   // secondaire
  blue:    '#93C5FD',   // tertiaire
  mint:    '#6EE7B7',   // success
  peach:   '#FDBA74',   // warning
  salmon:  '#FCA5A5',   // erreur
  dimV:    '#b58eb8',   // violet clair (texte muted)
  line:    '#4A4060',   // separators
  ghost:   '#797C81',   // gris discret lisible sur fond sombre
};

// ── Semantic tokens — one color, one role ────────────────────────
// Use these everywhere. Each token carries meaning, not decoration.
//   text     — primary readable body text
//   muted    — secondary text, metadata (dates, versions, descriptions)
//   subtle   — decorative separators (·, ─)
//   accent   — brand, interactive elements (slash commands, agent IDs)
//   keyword  — technical labels and feature/provider names
//   string   — user data (pipeline names, paths, URLs)
//   success  — positive markers (✓), confirmations
//   warning  — attention markers (!), announcements (New)
//   error    — failure markers (✕), blocking errors
export const S = ASCII_MODE ? {
  text:    'white',
  muted:   'gray',
  subtle:  'gray',
  border:  'gray',
  accent:  'magenta',
  keyword: 'blue',
  string:  'magenta',
  success: 'green',
  warning: 'yellow',
  error:   'red',
} : {
  text:    '#FFFFFF',
  muted:   '#8E8B9E',   // soft cool gray, very subtly violet-tinted — reads as "quiet"
  subtle:  '#797C81',
  border:  '#4A4060',   // structural separators (blessed.line widgets, frames)
  accent:  '#C084FC',
  keyword: '#93C5FD',
  string:  '#F9A8D4',
  success: '#6EE7B7',
  warning: '#FDBA74',
  error:   '#FCA5A5',
};

export const G = ASCII_MODE ? {
  scrollbar: '|',
  pointer: '>',
  cursor: '|',
  cancel: '<-',
  bullet: '.',
  dash: '-',
  hline: '-',
  vline: '|',
  cross: '+',
  success: 'OK',
  error: 'X',
  running: '*',
  pending: 'o',
  skipped: '->',
} : {
  scrollbar: '│',
  pointer: '›',
  cursor: '▌',
  cancel: '↩',
  bullet: '·',
  dash: '─',
  hline: '─',
  vline: '│',
  cross: '┼',
  success: '✓',
  error: '✕',
  running: '●',
  pending: '○',
  skipped: '↷',
};

export function createShell() {
  const screen = blessed.screen({ smartCSR: true, title: 'Singleton' });
  const inputHints = [
    '/help to start',
    '/scan to scan agents',
    '/new to create an agent',
    '/run to execute a pipeline',
    '/commit-last to commit the last run',
  ];

  // ── Normal mode ────────────────────────────────────────────────
  const content = blessed.log({
    top: 0, left: 0,
    width: '100%', height: '100%-4',
    scrollable: true, alwaysScroll: true,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: S.border } },
    padding: { left: 1, top: 0, right: 1 },
    scrollbar: {
      ch: G.scrollbar,
      style: { fg: S.border }
    }
  });

  // ── Pipeline mode (single column) ──────────────────────────────
  const pipelineLog = blessed.log({
    top: 0, left: 0,
    width: '100%', height: '100%-10',
    tags: true,
    hidden: true,
    scrollable: true,
    alwaysScroll: true,
    border: { type: 'line' },
    style: { border: { fg: S.border } },
    padding: { left: 1, top: 0, right: 1 },
    scrollbar: {
      ch: G.scrollbar,
      style: { fg: S.border }
    }
  });

  const pipelineStatus = blessed.box({
    bottom: 5, left: 0,
    width: '100%', height: 4,
    tags: true,
    hidden: true,
    padding: { left: 2, right: 2 }
  });

  // Label overlay sitting on the top border of pipelineLog (e.g. "Step 2/4" or "input waiting")
  const pipelineLabel = blessed.box({
    top: 0, left: 4,
    width: 'shrink', height: 1,
    tags: true,
    hidden: true
  });

  // ── Shell bar (toujours visible) ───────────────────────────────
  const sep1 = blessed.line({
    orientation: 'horizontal',
    bottom: 3, left: 0, width: '100%',
    style: { fg: S.border }
  });

  const suggestBox = blessed.box({
    bottom: 4, left: 0,
    width: '100%', height: 5,
    tags: true,
    hidden: true,
    padding: { left: 2, right: 2 },
    style: { bg: 'default' }
  });

  const promptBox = blessed.box({
    bottom: 2, left: 0,
    width: '100%', height: 1,
    padding: { left: 2 }, tags: true
  });

  const sep2 = blessed.line({
    orientation: 'horizontal',
    bottom: 1, left: 0, width: '100%',
    style: { fg: S.border }
  });

  const footerLeftBox = blessed.box({
    bottom: 0, left: 0,
    width: '70%', height: 1,
    padding: { left: 2 },
    tags: true
  });

  const footerRightBox = blessed.box({
    bottom: 0, right: 2,
    width: '30%', height: 1,
    align: 'right',
    tags: true
  });

  const footerCenterBox = blessed.box({
    bottom: 0, left: '30%',
    width: '40%', height: 1,
    align: 'center',
    tags: true
  });

  screen.append(content);
  screen.append(pipelineLog);
  screen.append(pipelineStatus);
  screen.append(pipelineLabel);
  screen.append(suggestBox);
  screen.append(sep1);
  screen.append(promptBox);
  screen.append(sep2);
  screen.append(footerLeftBox);
  screen.append(footerRightBox);
  screen.append(footerCenterBox);

  pipelineStatus.hide();

  // ── Input state ─────────────────────────────────────────────────
  let buffer       = '';
  let inputEnabled = true;
  let onSubmit: ((value: string) => void) | null = null;
  let promptMode: PromptMode | null = null;
  let completer: Completer | null = null;
  let suggestions: Suggestion[] = [];
  let suggestIndex = 0;
  let completeSeq  = 0;
  let pipelineMode = false;
  let history: string[] = [];
  let historyIndex = -1;
  let draftBuffer = '';
  let hintIndex = 0;
  let footerLeft = '';
  let footerRight = '';
  let footerCenter = '';
  // Tracks the /run two-step submit: first Enter on `/run <pipeline>` opens flag suggestions
  // passively, second Enter submits. Cleared by any keystroke that breaks the dance.
  let runAwaitingSecondEnter = false;
  function stripTags(s: unknown): string {
    return String(s || '').replace(/\{[^}]+\}/g, '');
  }

  function hideSuggestions() {
    suggestions = [];
    suggestIndex = 0;
    suggestBox.hide();
  }

  function renderSuggestions() {
    if (!suggestions.length) {
      suggestBox.hide();
      return;
    }

    const maxItems = Math.min(5, suggestions.length);
    const start = Math.min(
      Math.max(0, suggestIndex - maxItems + 1),
      Math.max(0, suggestions.length - maxItems)
    );
    const width = Math.max(40, (screen.width ?? 100) - 6);
    // Semantic styling:
    //   active row   → accent ›, white bold label, muted description (clearly the one in focus)
    //   inactive row → blank marker, muted label, subtle description (recedes)
    // suggestIndex === -1 means "no active selection" (passive listing after a soft Enter on /run).
    const lines = suggestions.slice(start, start + maxItems).map((item, idx) => {
      const active = suggestIndex >= 0 && start + idx === suggestIndex;
      const marker = active ? `{${S.accent}-fg}{bold}${G.pointer}{/}` : ' ';
      const label = active
        ? `{${S.text}-fg}{bold}${item.label}{/}`
        : `{${S.muted}-fg}${item.label}{/}`;
      const descColor = active ? S.muted : S.subtle;
      const desc = item.description ? ` {${descColor}-fg}${item.description}{/}` : '';
      const visible = stripTags(`${marker} ${item.label}${item.description ? ` ${item.description}` : ''}`);
      const clippedDesc = visible.length > width ? '' : desc;
      return `${marker} ${label}${clippedDesc}`;
    });

    suggestBox.setContent(lines.join('\n'));
    suggestBox.show();
  }

  async function refreshSuggestions({ applySingle = false, passive = false } = {}): Promise<boolean> {
    // Prompt-scoped completer (set via shell.prompt({ completer })) takes precedence,
    // so per-field autocompletes don't leak into the global slash-command completer.
    const activeCompleter = promptMode?.completer || completer;
    if (!activeCompleter) return false;

    const seq = ++completeSeq;
    const result = await activeCompleter({ buffer, cursor: buffer.length });
    if (seq !== completeSeq) return false;

    suggestions = Array.isArray(result)
      ? result.filter((s) => s && typeof s.value === 'string' && typeof s.label === 'string')
      : [];
    // passive=true: shown as a list with no active row; Enter will submit, not apply.
    suggestIndex = passive ? -1 : 0;

    if (applySingle && suggestions.length === 1) {
      applySuggestion(suggestions[0]);
      return true;
    }

    renderSuggestions();
    screen.render();
    return suggestions.length > 0;
  }

  function applySuggestion(item = suggestions[suggestIndex]): boolean {
    if (!item) return false;
    buffer = item.value;
    hideSuggestions();
    runAwaitingSecondEnter = false;
    updatePrompt();
    return true;
  }

  function updatePrompt() {
    if (promptMode) {
      const message = String(promptMode.message || '');
      // If the caller passed pre-tagged content, respect it. Otherwise the message
      // belongs to the "awaiting input" state → bold + warning to match the ambient frame.
      const renderedMessage = message.includes('{')
        ? message
        : `{${S.warning}-fg}{bold}${message}{/}`;
      const marker = message.includes('Debug action')
        ? ''
        : `{${S.warning}-fg}{bold}?{/}  `;
      // Ghost-text default: when the buffer is empty and the caller supplied a
      // `default` value, render it in subtle after the cursor so it reads as a
      // suggestion. Pressing Enter on an empty buffer accepts the default.
      const ghost = (!buffer && promptMode.default)
        ? `{${S.subtle}-fg}${promptMode.default}{/}`
        : '';
      promptBox.setContent(
        `${marker}${renderedMessage}  {${S.muted}-fg}${G.pointer}{/}  ${buffer}{${S.accent}-fg}${G.cursor}{/}${ghost}`
      );
    } else {
      if (buffer) {
        promptBox.setContent(`{${S.muted}-fg}${G.pointer}{/}  ${buffer}{${S.accent}-fg}${G.cursor}{/}`);
      } else {
        const hint = history.length === 0 ? inputHints[0] : inputHints[hintIndex];
        promptBox.setContent(`{${S.muted}-fg}${G.pointer}{/}  {${S.accent}-fg}${G.cursor}{/}{${S.subtle}-fg}${hint}{/}`);
      }
    }
    screen.render();
  }

  function renderFooter() {
    footerLeftBox.setContent(footerLeft ? `{${C.dimV}-fg}${String(footerLeft)}{/}` : '');
    footerRightBox.setContent(footerRight ? `{${C.dimV}-fg}${String(footerRight)}{/}` : '');
    footerCenterBox.setContent(footerCenter || '');
  }

  function setFooter(left = '', right = '') {
    footerLeft = left;
    footerRight = right;
    renderFooter();
    screen.render();
  }

  function setFooterCenter(text = '') {
    footerCenter = text;
    renderFooter();
    screen.render();
  }

  screen.on('resize', () => {
    renderSuggestions();
    screen.render();
  });

  function resetHistoryNav() {
    historyIndex = -1;
    draftBuffer = '';
  }

  const hintTicker = setInterval(() => {
    if (promptMode || pipelineMode || buffer || history.length === 0) return;
    hintIndex = (hintIndex + 1) % inputHints.length;
    updatePrompt();
  }, 3000);

  screen.on('keypress', async (ch, key) => {
    if (key.full === 'C-c') {
      log(`{${C.dimV}-fg}See you soon.{/}`);
      screen.render();
      setTimeout(() => { screen.destroy(); process.exit(0); }, 200);
    }

    if (pipelineMode) {
      if (key.name === 'up') {
        pipelineLog.scroll(-1);
        screen.render();
        return;
      }
      if (key.name === 'down') {
        pipelineLog.scroll(1);
        screen.render();
        return;
      }
      if (key.name === 'pageup') {
        pipelineLog.scroll(-(pipelineLog.height - 2));
        screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        pipelineLog.scroll(pipelineLog.height - 2);
        screen.render();
        return;
      }
      if (key.name === 'home') {
        pipelineLog.setScroll(0);
        screen.render();
        return;
      }
      if (key.name === 'end') {
        pipelineLog.setScrollPerc(100);
        screen.render();
        return;
      }
    }

    if (!pipelineMode && !promptMode && !suggestions.length) {
      if (buffer === '' && key.name === 'up') {
        content.scroll(-1);
        screen.render();
        return;
      }
      if (buffer === '' && key.name === 'down') {
        content.scroll(1);
        screen.render();
        return;
      }
      if (key.name === 'pageup') {
        content.scroll(-(content.height - 2));
        screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        content.scroll(content.height - 2);
        screen.render();
        return;
      }
      if (key.name === 'home') {
        content.setScroll(0);
        screen.render();
        return;
      }
      if (key.name === 'end') {
        content.setScrollPerc(100);
        screen.render();
        return;
      }
    }

    if (!inputEnabled && !promptMode) return;

    if (promptMode && key.name === 'escape') {
      // In a prompt with autocomplete open, Esc first closes the suggestions instead
      // of cancelling the prompt itself (matches the global-mode behavior).
      if (suggestions.length) {
        hideSuggestions();
        updatePrompt();
        return;
      }
      const { resolve, message, silent } = promptMode;
      promptMode = null;
      buffer = '';
      if (!silent) log(`{${S.subtle}-fg}${G.cancel} cancelled{/} {${S.muted}-fg}${message}{/}`);
      updatePrompt();
      resolve(ESC_SENTINEL);
      return;
    }

    if (key.name === 'tab' && (promptMode?.completer || (!promptMode && completer))) {
      if (suggestions.length > 1) {
        // From the passive -1 state, Tab focuses the first item rather than skipping it.
        suggestIndex = suggestIndex < 0 ? 0 : (suggestIndex + 1) % suggestions.length;
        renderSuggestions();
        screen.render();
        return;
      }
      await refreshSuggestions({ applySingle: true });
      return;
    }

    if (suggestions.length && (key.name === 'down' || key.name === 'up')) {
      const dir = key.name === 'down' ? 1 : -1;
      // From the passive -1 state, the first arrow lands on item 0 (down) or last (up).
      if (suggestIndex < 0) suggestIndex = dir === 1 ? 0 : suggestions.length - 1;
      else suggestIndex = (suggestIndex + dir + suggestions.length) % suggestions.length;
      renderSuggestions();
      screen.render();
      return;
    }

    if (!promptMode && suggestions.length && key.name === 'escape') {
      hideSuggestions();
      updatePrompt();
      return;
    }

    if (suggestions.length && (key.name === 'right' || key.name === 'enter' || key.name === 'return')) {
      // Passive listing (no active row) → Enter falls through to the submit handler below.
      if (suggestIndex < 0 && (key.name === 'enter' || key.name === 'return')) {
        // fall through
      } else {
        applySuggestion();
        return;
      }
    }

    if (!promptMode && !suggestions.length && (key.full === 'C-p' || key.full === 'C-n')) {
      if (history.length === 0) return;

      if (key.full === 'C-p') {
        if (historyIndex === -1) {
          draftBuffer = buffer;
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex -= 1;
        }
        buffer = history[historyIndex] || '';
      } else {
        if (historyIndex === -1) return;
        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          buffer = history[historyIndex] || '';
        } else {
          historyIndex = -1;
          buffer = draftBuffer;
        }
      }

      updatePrompt();
      return;
    }

    if (key.name === 'enter' || key.name === 'return') {
      const value = buffer.trim();

      // Two-step submit for /run <pipeline>: first Enter opens flag suggestions passively,
      // second Enter submits. Guarded by runAwaitingSecondEnter so dismissing the suggestions
      // (Esc) and pressing Enter again doesn't re-loop.
      if (
        !promptMode &&
        !runAwaitingSecondEnter &&
        /^\/run\s+\S+\s*$/.test(value) &&
        !value.includes(' --')
      ) {
        if (!buffer.endsWith(' ')) buffer += ' ';
        runAwaitingSecondEnter = true;
        updatePrompt();
        await refreshSuggestions({ passive: true });
        return;
      }
      runAwaitingSecondEnter = false;

      buffer = '';
      hideSuggestions();
      if (promptMode) {
        const { resolve, message, silent, default: promptDefault } = promptMode;
        // Empty submission with a ghost-text default → resolve with the default.
        const finalValue = (value === '' && promptDefault) ? promptDefault : value;
        promptMode = null;
        if (!silent) log(`{${S.warning}-fg}{bold}?{/}  {${S.muted}-fg}${message}{/}  ${finalValue}`);
        updatePrompt();
        resolve(finalValue);
      } else {
        updatePrompt();
        if (value) {
          if (history[history.length - 1] !== value) history.push(value);
          if (history.length > 200) history = history.slice(-200);
          resetHistoryNav();
          if (onSubmit) onSubmit(value);
        } else {
          resetHistoryNav();
        }
      }
    } else if (key.name === 'backspace') {
      buffer = buffer.slice(0, -1);
      resetHistoryNav();
      runAwaitingSecondEnter = false;
      // In a prompt with a completer, keystrokes re-filter the suggestions instead
      // of dismissing them. In all other modes, typing hides the suggest panel.
      if (promptMode?.completer) {
        updatePrompt();
        await refreshSuggestions({ passive: true });
      } else {
        hideSuggestions();
        updatePrompt();
      }
    } else if (ch && !key.ctrl && !key.meta) {
      buffer += ch;
      resetHistoryNav();
      runAwaitingSecondEnter = false;
      if (promptMode?.completer) {
        updatePrompt();
        await refreshSuggestions({ passive: true });
      } else {
        hideSuggestions();
        updatePrompt();
      }
    }
  });

  function log(text) {
    content.log(text);
    screen.render();
  }

  updatePrompt();

  // Mode → border color mapping. Drives the "ambient state" frame around the log panel.
  //   null/'idle'    → S.border (faint, structural)
  //   'running'      → S.keyword (blue, run in progress)
  //   'awaiting'     → S.warning (orange, waiting for human input)
  //   'error'        → S.error (red, last run failed)
  //   'debug'        → S.warning (orange, debug mode active)
  // Label overlay shown on the top border of the pipeline log frame.
  // Timeline writes the step indicator (step X/N). The executor can override
  // with "input waiting" while a prompt is pending — overrides are sticky
  // until cleared, so the timeline's spinner-tick re-renders don't clobber them.
  let pipelineLabelOverride: string | null = null;
  function writePipelineLabel(text: string): void {
    if (!text) {
      pipelineLabel.setContent('');
      pipelineLabel.hide();
    } else {
      pipelineLabel.setContent(` ${text} `);
      pipelineLabel.show();
    }
    screen.render();
  }
  function applyPipelineLabel(text: string): void {
    if (pipelineLabelOverride !== null) return;
    writePipelineLabel(text);
  }
  function setPipelineLabel(text: string): void {
    pipelineLabelOverride = text;
    writePipelineLabel(`{${S.warning}-fg}{bold}${text}{/}`);
  }
  function clearPipelineLabel() {
    pipelineLabelOverride = null;
    writePipelineLabel('');
  }

  // Mode → border color. Two-layer state:
  //   baseMode  — ambient mode set by the executor ('running' during a step, etc.)
  //   currentMode — what is actually painted; prompts override to 'awaiting' and restore baseMode on resolve.
  // Removed 'debug' as its own mode: a debug pause IS an awaiting state, a running debug step IS running.
  let baseMode: ShellMode = null;
  function applyMode(mode: ShellMode): void {
    const map: Record<Exclude<ShellMode, null>, string> = {
      running:  S.keyword,
      awaiting: S.warning,
      error:    S.error,
    };
    const color = mode ? map[mode] : S.border;
    content.style.border.fg = color;
    pipelineLog.style.border.fg = color;
    sep1.style.fg = color;
    sep2.style.fg = color;
    screen.render();
  }
  function setMode(mode: ShellMode): void {
    baseMode = mode;
    applyMode(mode);
  }

  return {
    log,
    logMuted(text)  { log(`{${S.muted}-fg}${text}{/}`); },
    logAccent(text) { log(`{${S.accent}-fg}${text}{/}`); },
    setFooter,
    setFooterCenter,
    setMode,
    setPipelineLabel,
    clearPipelineLabel,

    clear() { content.setContent(''); screen.render(); },
    setContent(text) { content.setContent(text); screen.render(); },
    onCommand(fn)  { onSubmit = fn; },
    setCompleter(fn) { completer = fn; },

    // Shimmer animation overlay (e.g. for "Welcome back")
    createShimmer(text, top, left) {
      const box = blessed.box({
        top, left,
        width: text.length,
        height: 1,
        tags: true
      });
      screen.append(box);

      let peak = -4;
      function render() {
        const content = text.split('').map((ch, i) => {
          const dist = Math.abs(i - peak);
          let color;
          if      (dist === 0) color = '#FFFFFF';
          else if (dist === 1) color = '#EDD9FF';
          else if (dist === 2) color = '#D4B0FE';
          else                 color = C.violet;
          return `{${color}-fg}{bold}${ch}{/}`;
        }).join('');
        box.setContent(content);
        screen.render();
        peak++;
        if (peak > text.length + 4) peak = -4;
      }

      render();
      const iv = setInterval(render, 80);
      return () => { clearInterval(iv); screen.remove(box); screen.render(); };
    },
    disableInput() { inputEnabled = false; hideSuggestions(); resetHistoryNav(); screen.render(); },
    enableInput()  { inputEnabled = true; buffer = ''; hideSuggestions(); resetHistoryNav(); updatePrompt(); },

    prompt(message, { silent = false, completer: promptCompleter = null, default: promptDefault = '' } = {}) {
      return new Promise((resolve) => {
        // Override ambient mode to 'awaiting' (orange) for the duration of the prompt,
        // and restore the baseMode (e.g. 'running') once the user has answered.
        const shouldOverride = baseMode === 'running';
        if (shouldOverride) applyMode('awaiting');
        promptMode = {
          message,
          silent,
          completer: promptCompleter,
          default: promptDefault,
          resolve: (value) => {
            if (shouldOverride) applyMode(baseMode);
            resolve(value);
          },
        };
        buffer = '';
        hideSuggestions();
        resetHistoryNav();
        updatePrompt();
        // With a prompt-scoped completer, show the full suggestion list immediately
        // so the user sees what's available without having to press Tab first.
        // Use passive mode so Enter submits the typed value rather than applying
        // the first row — Tab/arrows are the explicit "pick" path.
        if (promptCompleter) {
          refreshSuggestions({ passive: true }).catch(() => {});
        }
      });
    },

    // Mirror sends every timeline.log call into the main `content` widget too, so the full
    // run history survives exitPipelineMode (pipelineLog gets hidden, but content keeps it).
    pipelineWidgets: {
      screen,
      logPanel: pipelineLog,
      statusBox: pipelineStatus,
      setLabel: applyPipelineLabel,
      mirror: (text) => content.log(text),
    },

    enterPipelineMode() {
      pipelineMode = true;
      content.hide();
      pipelineLog.setContent('');
      pipelineStatus.setContent('');
      pipelineLog.show();
      pipelineStatus.show();
      pipelineLabel.show();
      promptBox.setContent('');
      screen.render();
    },

    exitPipelineMode() {
      pipelineMode = false;
      pipelineLabelOverride = null;
      pipelineLog.hide();
      pipelineStatus.hide();
      pipelineLabel.hide();
      pipelineLabel.setContent('');
      content.show();
      updatePrompt();
      screen.render();
    },

    screen,
    destroy() {
      clearInterval(hintTicker);
      screen.destroy();
    }
  };
}
