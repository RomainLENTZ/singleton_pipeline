import fs from 'node:fs/promises';
import path from 'node:path';

/** @typedef {import('../types.js').PipelineStep} PipelineStep */
/** @typedef {import('../types.js').TimelineLike} TimelineLike */
/** @typedef {import('../types.js').FileWrite} FileWrite */

/**
 * @param {string} absPath
 * @param {string} absRoot
 * @returns {boolean}
 */
export function isInsidePath(absPath, absRoot) {
  const rel = path.relative(absRoot, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {string} absPath
 * @param {string} cwd
 * @returns {boolean}
 */
export function isSingletonInternalPath(absPath, cwd) {
  return isInsidePath(absPath, path.join(cwd, '.singleton'));
}

/**
 * @param {string} absPath
 * @param {string} artifactRoot
 * @param {string} agentName
 * @param {string} outputName
 */
export function assertRunArtifactWriteAllowed(absPath, artifactRoot, agentName, outputName) {
  if (!isInsidePath(absPath, artifactRoot)) {
    throw new Error(
      `Step "${agentName}" output "${outputName}" resolves outside the run artifact workspace: ${absPath}`
    );
  }
}

// If an internal Singleton sink lands inside <root>/.singleton/ (but not inside
// .singleton/runs/), redirect it into the current step's workspace. Project
// deliverables are left untouched and remain subject to the security policy.
/**
 * @param {unknown} sink
 * @param {{ cwd: string, stepDir: string }} options
 * @returns {unknown}
 */
export function rewriteInternalSink(sink, { cwd, stepDir }) {
  if (typeof sink !== 'string') return sink;
  const prefix = sink.startsWith('$FILE:') ? '$FILE:' : sink.startsWith('$FILES:') ? '$FILES:' : null;
  if (!prefix) return sink;
  const raw = sink.slice(prefix.length).trim();
  const absOut = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
  const rel = path.relative(cwd, absOut);
  if (!rel.startsWith('.singleton' + path.sep)) return sink;
  if (rel.startsWith(path.join('.singleton', 'runs') + path.sep)) return sink;
  const basename = path.basename(absOut);
  return `${prefix}${path.join(stepDir, basename)}`;
}

/**
 * @param {string} text
 * @param {string[]} outputNames
 * @returns {Record<string, string>}
 */
export function parseOutputs(text, outputNames) {
  if (outputNames.length === 1) {
    return { [outputNames[0]]: text.trim() };
  }
  /** @type {Record<string, string>} */
  const result = {};
  for (const name of outputNames) {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
    const m = text.match(re);
    result[name] = m ? m[1].trim() : '';
  }
  return result;
}

/**
 * @param {Record<string, string>} parsed
 * @param {string[]} outputNames
 */
export function summarizeParsedOutputs(parsed, outputNames) {
  return outputNames.map((name) => {
    const value = String(parsed[name] || '');
    const trimmed = value.trim();
    return {
      name,
      found: Boolean(trimmed),
      chars: value.length,
      lines: trimmed ? trimmed.split('\n').length : 0,
    };
  });
}

/**
 * @param {{ stepDir: string | null, step: PipelineStep, text: string, reason: string, timeline: TimelineLike }} options
 * @returns {Promise<string | null>}
 */
export async function writeRawOutputArtifact({ stepDir, step, text, reason, timeline }) {
  if (!stepDir) return null;
  const rawPath = path.join(stepDir, 'raw-output.md');
  const content = [
    `# Raw output for ${step.agent}`,
    '',
    `Reason: ${reason}`,
    '',
    '```text',
    text || '',
    '```',
    '',
  ].join('\n');
  await fs.writeFile(rawPath, content);
  timeline.logMuted(`raw output saved: ${path.relative(path.dirname(stepDir), rawPath)}`);
  return rawPath;
}

/**
 * @param {string} fromAbs
 * @param {string} toAbs
 * @returns {Promise<boolean>}
 */
async function moveFileIfExists(fromAbs, toAbs) {
  try {
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    if (code === 'ENOENT') return false;
    await fs.copyFile(fromAbs, toAbs);
    await fs.rm(fromAbs, { force: true });
    return true;
  }
}

/**
 * @param {{ cwd: string, stepDir: string | null, attempt: number, writes: FileWrite[], rawOutputPath: string | null }} options
 * @returns {Promise<{ writes: FileWrite[], rawOutputPath: string | null }>}
 */
export async function moveAttemptArtifactsToAttemptDir({ cwd, stepDir, attempt, writes, rawOutputPath }) {
  if (!stepDir || attempt !== 1) {
    return {
      writes,
      rawOutputPath,
    };
  }

  const attemptDir = path.join(stepDir, `attempt-${attempt}`);
  /** @type {FileWrite[]} */
  const movedWrites = [];
  for (const entry of writes) {
    if (!isInsidePath(entry.absPath, stepDir) || isInsidePath(entry.absPath, attemptDir)) {
      movedWrites.push(entry);
      continue;
    }
    const relInsideStep = path.relative(stepDir, entry.absPath);
    if (!relInsideStep || relInsideStep.startsWith('..') || relInsideStep.split(path.sep)[0] === '.snapshot') {
      movedWrites.push(entry);
      continue;
    }
    const nextAbs = path.join(attemptDir, relInsideStep);
    await moveFileIfExists(entry.absPath, nextAbs);
    movedWrites.push({
      ...entry,
      absPath: nextAbs,
      relPath: path.relative(cwd, nextAbs),
      kind: path.relative(cwd, nextAbs).startsWith('.singleton' + path.sep) ? 'intermediate' : entry.kind,
    });
  }

  let movedRawOutputPath = rawOutputPath;
  if (rawOutputPath) {
    const rawAbs = path.isAbsolute(rawOutputPath) ? rawOutputPath : path.join(cwd, rawOutputPath);
    if (isInsidePath(rawAbs, stepDir) && !isInsidePath(rawAbs, attemptDir)) {
      const relInsideStep = path.relative(stepDir, rawAbs);
      const nextAbs = path.join(attemptDir, relInsideStep);
      if (await moveFileIfExists(rawAbs, nextAbs)) {
        movedRawOutputPath = path.relative(cwd, nextAbs);
      }
    }
  }

  return {
    writes: movedWrites,
    rawOutputPath: movedRawOutputPath,
  };
}
