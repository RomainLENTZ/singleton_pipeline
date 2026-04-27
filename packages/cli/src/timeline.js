import blessed from 'blessed';
import { C } from './shell.js';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

// widgets: { screen, logPanel, statusBox } — provided by shell when running inside the TUI.
// If omitted, a standalone blessed screen is created.
export function createTimeline(stepNames, widgets = null) {
  const N = stepNames.length;
  const statuses = stepNames.map(() => 'pending');
  const meta     = stepNames.map(() => '');
  let runningIdx = -1;
  let spinnerInterval = null;
  let spinnerFrame    = 0;

  let screen, logPanel, statusBox, ownScreen = false;

  if (widgets) {
    ({ screen, logPanel, statusBox } = widgets);
  } else {
    ownScreen = true;
    screen = blessed.screen({ smartCSR: true, title: 'Singleton' });

    logPanel = blessed.log({
      top: 0, left: 0,
      width: '100%', height: '100%-6',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      padding: { left: 2, top: 1, right: 2 }
    });

    const separator = blessed.line({
      orientation: 'horizontal',
      bottom: 5, left: 0,
      width: '100%',
      style: { fg: C.line }
    });

    statusBox = blessed.box({
      bottom: 1, left: 0,
      width: '100%', height: 4,
      tags: true,
      padding: { left: 2, right: 2 }
    });

    screen.append(logPanel);
    screen.append(separator);
    screen.append(statusBox);

    screen.key(['C-c'], () => { screen.destroy(); process.exit(0); });
  }

  function dot(status, frame = 0) {
    if (status === 'done')    return `{${C.mint}-fg}●{/}`;
    if (status === 'running') return `{#FFFFFF-fg}${FRAMES[frame % FRAMES.length]}{/}`;
    if (status === 'error')   return `{${C.salmon}-fg}●{/}`;
    return `{${C.line}-fg}○{/}`;
  }

  function shimmerName(text, frame = 0) {
    const peak = frame % (text.length + 6);
    return text.split('').map((ch, i) => {
      const dist = Math.abs(i - peak);
      let color = C.violet;
      if (dist === 0) color = '#FFFFFF';
      else if (dist === 1) color = '#EDD9FF';
      else if (dist === 2) color = '#D4B0FE';
      return ch === ' ' ? ch : `{${color}-fg}${ch}{/}`;
    }).join('');
  }

  function stepLine(i, frame = 0) {
    const s = statuses[i];
    const nameColor = s === 'running' ? C.violet : s === 'done' ? C.dimV : C.line;
    const name = `{${nameColor}-fg}${stepNames[i]}{/}`;
    const info = meta[i] ? `  {${C.line}-fg}${meta[i]}{/}` : '';
    return `${dot(s, frame)}  ${name}${info}`;
  }

  function compactDots(frame = 0) {
    return stepNames.map((_name, i) => dot(statuses[i], frame)).join(`  {${C.line}-fg}─{/}  `);
  }

  function renderTimeline(frame = 0) {
    const runningLabel = runningIdx >= 0
      ? `{bold}Running{/}  {#FFFFFF-fg}${FRAMES[frame % FRAMES.length]}{/}  {${C.line}-fg}step ${runningIdx + 1}/${N}{/}`
      : `{bold}Running:{/} {${C.dimV}-fg}idle{/}`;
    const currentNode = runningIdx >= 0
      ? shimmerName(stepNames[runningIdx], frame)
      : `{${C.dimV}-fg}—{/}`;
    const statusLines = [
      '',
      runningLabel,
      '',
      currentNode,
      '',
      compactDots(frame)
    ];
    statusBox.setContent(statusLines.join('\n'));
    screen.render();
  }

  renderTimeline();

  return {
    log(text)      { logPanel.log(`{${C.blue}-fg}${text}{/}`);  screen.render(); },
    logMuted(text) { logPanel.log(`{${C.dimV}-fg}${text}{/}`);  screen.render(); },

    setRunning(i) {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      runningIdx = i;
      statuses[i] = 'running';
      renderTimeline();
      spinnerInterval = setInterval(() => { spinnerFrame++; renderTimeline(spinnerFrame); }, 80);
    },

    setDone(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      statuses[i] = 'done';
      meta[i] = info;
      if (runningIdx === i) runningIdx = -1;
      renderTimeline();
    },

    setError(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      statuses[i] = 'error';
      meta[i] = info;
      if (runningIdx === i) runningIdx = -1;
      renderTimeline();
    },

    end() {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      if (ownScreen) screen.destroy();
    }
  };
}
