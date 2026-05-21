import blessed from 'blessed';
import { S } from './shell.js';

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

  let screen, logPanel, statusBox, setLabel = null, mirror = null, ownScreen = false;

  if (widgets) {
    ({ screen, logPanel, statusBox, setLabel = null, mirror = null } = widgets);
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
      style: { fg: S.border }
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
    if (status === 'done')    return `{${S.success}-fg}●{/}`;
    if (status === 'running') return `{${S.text}-fg}${FRAMES[frame % FRAMES.length]}{/}`;
    if (status === 'paused')  return `{${S.warning}-fg}●{/}`;
    if (status === 'error')   return `{${S.error}-fg}●{/}`;
    return `{${S.subtle}-fg}○{/}`;
  }

  function shimmerName(text, frame = 0) {
    const peak = frame % (text.length + 6);
    return text.split('').map((ch, i) => {
      const dist = Math.abs(i - peak);
      let color = S.accent;
      if (dist === 0) color = S.text;
      else if (dist === 1) color = '#EDD9FF';
      else if (dist === 2) color = '#D4B0FE';
      return ch === ' ' ? ch : `{${color}-fg}{bold}${ch}{/}`;
    }).join('');
  }

  function compactDots(frame = 0) {
    return stepNames.map((_name, i) => dot(statuses[i], frame)).join(`  {${S.subtle}-fg}─{/}  `);
  }

  function renderTimeline(frame = 0) {
    const currentMeta = runningIdx >= 0 && meta[runningIdx]
      ? `  {${S.muted}-fg}${meta[runningIdx]}{/}`
      : '';
    const isPaused = runningIdx >= 0 && statuses[runningIdx] === 'paused';
    const activityLabel = isPaused
      ? `{${S.warning}-fg}{bold}Paused{/}`
      : `{bold}Running{/}`;
    const activityIcon = isPaused
      ? `{${S.warning}-fg}●{/}`
      : `{${S.text}-fg}${FRAMES[frame % FRAMES.length]}{/}`;
    const runningLabel = runningIdx >= 0
      ? `${activityLabel}  ${activityIcon}  ${shimmerName(stepNames[runningIdx], frame)}${currentMeta}`
      : `{bold}Running:{/} {${S.muted}-fg}idle{/}`;
    const statusLines = [
      '',
      runningLabel,
      '',
      compactDots(frame)
    ];
    statusBox.setContent(statusLines.join('\n'));
    if (setLabel) {
      if (runningIdx < 0) {
        setLabel('');
      } else if (runningIdx === 0) {
        // Index 0 is always the preflight pseudo-step — it's not a "real" pipeline step,
        // so show "preflight" rather than fold it into the X/N count.
        const labelText = isPaused ? 'preflight — paused' : 'preflight';
        setLabel(`{${S.text}-fg}{bold}${labelText}{/}`);
      } else {
        // Real steps: 1..(N-1). Subtract 1 from N to exclude preflight from the total.
        const labelText = isPaused
          ? `step ${runningIdx}/${N - 1} — paused`
          : `step ${runningIdx}/${N - 1}`;
        setLabel(`{${S.text}-fg}{bold}${labelText}{/}`);
      }
    }
    screen.render();
  }

  renderTimeline();

  return {
    log(text)        { const s = `{${S.keyword}-fg}${text}{/}`; logPanel.log(s); mirror?.(s); screen.render(); },
    logMuted(text)   { const s = `{${S.muted}-fg}${text}{/}`;   logPanel.log(s); mirror?.(s); screen.render(); },
    logSuccess(text) { const s = `{${S.success}-fg}${text}{/}`; logPanel.log(s); mirror?.(s); screen.render(); },
    logError(text)   { const s = `{${S.error}-fg}${text}{/}`;   logPanel.log(s); mirror?.(s); screen.render(); },
    logDiffLine(raw) {
      const text = String(raw ?? '');
      const body = text.replace(/^\s+/, '');
      // Default to S.subtle for all non-signal lines (meta git, context, untracked previews) —
      // one consistent gray instead of two slightly different ones. Check git meta starts before
      // +/- because +++ and --- would otherwise match the body coloring.
      let color = S.muted;
      if (/^(diff --git|index |--- |\+\+\+ )/.test(body))      color = S.muted;
      else if (body.startsWith('@@'))                           color = S.keyword;
      else if (body.startsWith('+'))                            color = S.success;
      else if (body.startsWith('-'))                            color = S.error;
      const s = `{${color}-fg}${text}{/}`;
      logPanel.log(s);
      mirror?.(s);
      screen.render();
    },

    setRunning(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      runningIdx = i;
      statuses[i] = 'running';
      meta[i] = info;
      renderTimeline();
      spinnerInterval = setInterval(() => { spinnerFrame++; renderTimeline(spinnerFrame); }, 80);
    },

    setPaused(i, info = '') {
      if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
      runningIdx = i;
      statuses[i] = 'paused';
      meta[i] = info;
      renderTimeline();
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
