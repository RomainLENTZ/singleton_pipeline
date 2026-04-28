import blessed from 'blessed';

// ── Pastel theme ────────────────────────────────────────────────
export const C = {
  violet:  '#C084FC',   // accent principal
  pink:    '#F9A8D4',   // secondaire
  blue:    '#93C5FD',   // tertiaire
  mint:    '#6EE7B7',   // succès
  peach:   '#FDBA74',   // warning
  salmon:  '#FCA5A5',   // erreur
  dimV:    '#b58eb8',   // violet clair (texte muted)
  line:    '#4A4060',   // séparateurs
  ghost:   '#797C81',   // gris discret lisible sur fond sombre
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
    padding: { left: 2, top: 1, right: 2 },
    scrollbar: {
      ch: '│',
      style: { fg: C.line }
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
    padding: { left: 2, top: 1, right: 2 },
    scrollbar: {
      ch: '│',
      style: { fg: C.line }
    }
  });

  const pipelineSep = blessed.line({
    orientation: 'horizontal',
    bottom: 8, left: 0, width: '100%',
    style: { fg: C.line }
  });

  const pipelineStatus = blessed.box({
    bottom: 4, left: 0,
    width: '100%', height: 4,
    tags: true,
    hidden: true,
    padding: { left: 2, right: 2 }
  });

  // ── Shell bar (toujours visible) ───────────────────────────────
  const sep1 = blessed.line({
    orientation: 'horizontal',
    bottom: 3, left: 0, width: '100%',
    style: { fg: C.line }
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
    style: { fg: C.line }
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
  screen.append(pipelineSep);
  screen.append(pipelineStatus);
  screen.append(suggestBox);
  screen.append(sep1);
  screen.append(promptBox);
  screen.append(sep2);
  screen.append(footerLeftBox);
  screen.append(footerRightBox);
  screen.append(footerCenterBox);

  pipelineSep.hide();
  pipelineStatus.hide();

  // ── Input state ─────────────────────────────────────────────────
  let buffer       = '';
  let inputEnabled = true;
  let onSubmit     = null;
  let promptMode   = null; // { resolve, message }
  let completer    = null;
  let suggestions  = [];
  let suggestIndex = 0;
  let completeSeq  = 0;
  let pipelineMode = false;
  let history = [];
  let historyIndex = -1;
  let draftBuffer = '';
  let hintIndex = 0;
  let footerLeft = '';
  let footerRight = '';
  let footerCenter = '';
  function stripTags(s) {
    return String(s || '').replace(/\{[^}]+\}/g, '');
  }

  function hideSuggestions() {
    suggestions = [];
    suggestIndex = 0;
    suggestBox.hide();
  }

  function renderSuggestions() {
    if (!suggestions.length || promptMode) {
      suggestBox.hide();
      return;
    }

    const maxItems = Math.min(5, suggestions.length);
    const start = Math.min(
      Math.max(0, suggestIndex - maxItems + 1),
      Math.max(0, suggestions.length - maxItems)
    );
    const width = Math.max(40, (screen.width ?? 100) - 6);
    const lines = suggestions.slice(start, start + maxItems).map((item, idx) => {
      const active = start + idx === suggestIndex;
      const marker = active ? `{${C.violet}-fg}›{/}` : `{${C.ghost}-fg} {/}`;
      const label = active
        ? `{${C.pink}-fg}${item.label}{/}`
        : `{${C.dimV}-fg}${item.label}{/}`;
      const desc = item.description ? ` {${C.ghost}-fg}${item.description}{/}` : '';
      const visible = stripTags(`${marker} ${item.label}${item.description ? ` ${item.description}` : ''}`);
      const clippedDesc = visible.length > width ? '' : desc;
      return `${marker} ${label}${clippedDesc}`;
    });

    suggestBox.setContent(lines.join('\n'));
    suggestBox.show();
  }

  async function refreshSuggestions({ applySingle = false } = {}) {
    if (!completer || promptMode) return false;

    const seq = ++completeSeq;
    const result = await completer({ buffer, cursor: buffer.length });
    if (seq !== completeSeq) return false;

    suggestions = Array.isArray(result)
      ? result.filter((s) => s && typeof s.value === 'string' && typeof s.label === 'string')
      : [];
    suggestIndex = 0;

    if (applySingle && suggestions.length === 1) {
      applySuggestion(suggestions[0]);
      return true;
    }

    renderSuggestions();
    screen.render();
    return suggestions.length > 0;
  }

  function applySuggestion(item = suggestions[suggestIndex]) {
    if (!item) return false;
    buffer = item.value;
    hideSuggestions();
    updatePrompt();
    return true;
  }

  function updatePrompt() {
    if (promptMode) {
      promptBox.setContent(
        `{${C.pink}-fg}?{/}  {${C.dimV}-fg}${promptMode.message}{/}  {${C.dimV}-fg}›{/}  ${buffer}{${C.violet}-fg}▌{/}`
      );
    } else {
      if (buffer) {
        promptBox.setContent(`{${C.dimV}-fg}›{/}  ${buffer}{${C.violet}-fg}▌{/}`);
      } else {
        const hint = history.length === 0 ? inputHints[0] : inputHints[hintIndex];
        promptBox.setContent(`{${C.dimV}-fg}›{/}  {${C.violet}-fg}▌{/}{#797C81-fg}${hint}{/}`);
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
      log(`{${C.dimV}-fg}À bientôt.{/}`);
      screen.render();
      setTimeout(() => { screen.destroy(); process.exit(0); }, 200);
    }

    if (pipelineMode && !promptMode) {
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

    if (!promptMode && key.name === 'tab') {
      if (suggestions.length > 1) {
        suggestIndex = (suggestIndex + 1) % suggestions.length;
        renderSuggestions();
        screen.render();
        return;
      }
      await refreshSuggestions({ applySingle: true });
      return;
    }

    if (!promptMode && suggestions.length && (key.name === 'down' || key.name === 'up')) {
      const dir = key.name === 'down' ? 1 : -1;
      suggestIndex = (suggestIndex + dir + suggestions.length) % suggestions.length;
      renderSuggestions();
      screen.render();
      return;
    }

    if (!promptMode && suggestions.length && key.name === 'escape') {
      hideSuggestions();
      updatePrompt();
      return;
    }

    if (!promptMode && suggestions.length && (key.name === 'right' || key.name === 'enter' || key.name === 'return')) {
      applySuggestion();
      return;
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
      buffer = '';
      hideSuggestions();
      if (promptMode) {
        const { resolve, message } = promptMode;
        promptMode = null;
        log(`{${C.pink}-fg}?{/}  {${C.dimV}-fg}${message}{/}  ${value}`);
        updatePrompt();
        resolve(value);
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
      hideSuggestions();
      resetHistoryNav();
      updatePrompt();
    } else if (ch && !key.ctrl && !key.meta) {
      buffer += ch;
      hideSuggestions();
      resetHistoryNav();
      updatePrompt();
    }
  });

  function log(text) {
    content.log(text);
    screen.render();
  }

  updatePrompt();

  return {
    log,
    logMuted(text)  { log(`{${C.dimV}-fg}${text}{/}`); },
    logAccent(text) { log(`{${C.violet}-fg}${text}{/}`); },
    setFooter,
    setFooterCenter,

    clear() { content.setContent(''); screen.render(); },
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

    prompt(message) {
      return new Promise((resolve) => {
        promptMode = { resolve, message };
        buffer = '';
        hideSuggestions();
        resetHistoryNav();
        updatePrompt();
      });
    },

    pipelineWidgets: { screen, logPanel: pipelineLog, statusBox: pipelineStatus },

    enterPipelineMode() {
      pipelineMode = true;
      content.hide();
      pipelineLog.setContent('');
      pipelineStatus.setContent('');
      pipelineLog.show();
      pipelineSep.show();
      pipelineStatus.show();
      promptBox.setContent(`{${C.dimV}-fg}scroll: ↑ ↓ pgup pgdn home end{/}`);
      screen.render();
    },

    exitPipelineMode() {
      pipelineMode = false;
      pipelineLog.hide();
      pipelineSep.hide();
      pipelineStatus.hide();
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
