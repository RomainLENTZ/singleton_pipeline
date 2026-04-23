import blessed from 'blessed';
import { C } from './shell.js';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

// widgets: { screen, leftPanel, rightPanel } — provided by shell when running inside the TUI.
// If omitted, a standalone blessed screen is created.
export function createTimeline(stepNames, widgets = null) {
  const N = stepNames.length;
  const statuses = stepNames.map(() => 'pending');
  const meta     = stepNames.map(() => '');
  let spinnerInterval = null;
  let spinnerFrame    = 0;

  let screen, leftPanel, rightPanel, ownScreen = false;

  if (widgets) {
    ({ screen, leftPanel, rightPanel } = widgets);
  } else {
    ownScreen = true;
    screen = blessed.screen({ smartCSR: true, title: 'Singleton' });

    leftPanel = blessed.box({
      top: 0, left: 0,
      width: '35%', height: '100%',
      tags: true,
      padding: { left: 2, top: 1 }
    });

    const separator = blessed.line({
      orientation: 'vertical',
      top: 0, left: '35%',
      height: '100%',
      style: { fg: C.line }
    });

    rightPanel = blessed.log({
      top: 0, left: '35%+2',
      width: '65%-2', height: '100%',
      tags: true,
      scrollable: true, alwaysScroll: true,
      padding: { left: 2, top: 1 }
    });

    screen.append(leftPanel);
    screen.append(separator);
    screen.append(rightPanel);

    screen.key(['C-c'], () => { screen.destroy(); process.exit(0); });
  }

  function dot(status, frame = 0) {
    if (status === 'done')    return `{${C.mint}-fg}●{/}`;
    if (status === 'running') return `{${C.violet}-fg}${FRAMES[frame % FRAMES.length]}{/}`;
    if (status === 'error')   return `{${C.salmon}-fg}●{/}`;
    return `{${C.line}-fg}○{/}`;
  }

  function stepLine(i, frame = 0) {
    const s = statuses[i];
    const nameColor = s === 'running' ? C.violet : s === 'done' ? C.dimV : C.line;
    const name = `{${nameColor}-fg}${stepNames[i]}{/}`;
    const info = meta[i] ? `  {${C.line}-fg}${meta[i]}{/}` : '';
    return `${dot(s, frame)}  ${name}${info}`;
  }

  function renderTimeline(frame = 0) {
    const lines = [`{${C.line}-fg}│{/}`];
    for (let i = 0; i < N; i++) {
      lines.push(stepLine(i, frame));
      lines.push(`{${C.line}-fg}│{/}`);
    }
    leftPanel.setContent(lines.join('\n'));
    screen.render();
  }

  renderTimeline();

  return {
    log(text)      { rightPanel.log(`{${C.blue}-fg}${text}{/}`);  screen.render(); },
    logMuted(text) { rightPanel.log(`{${C.dimV}-fg}${text}{/}`);  screen.render(); },

    setRunning(i) {
      statuses[i] = 'running';
      renderTimeline();
      spinnerInterval = setInterval(() => { spinnerFrame++; renderTimeline(spinnerFrame); }, 80);
    },

    setDone(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      statuses[i] = 'done';
      meta[i] = info;
      renderTimeline();
    },

    setError(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      statuses[i] = 'error';
      meta[i] = info;
      renderTimeline();
    },

    end() {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      if (ownScreen) screen.destroy();
    }
  };
}
