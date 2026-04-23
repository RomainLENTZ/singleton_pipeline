import path from 'node:path';
import { spawn } from 'node:child_process';
import { select } from '@inquirer/prompts';
import { style } from '../theme.js';
import { scanAgents } from '../scanner.js';

export async function editAgentCommand(idOrUndef, opts) {
  const root = path.resolve(opts.root || process.cwd());
  const agents = await scanAgents(root);

  if (agents.length === 0) {
    console.log(style.warn('Aucun agent trouvé dans ce repo.'));
    return;
  }

  let target = idOrUndef ? agents.find((a) => a.id === idOrUndef) : null;

  if (idOrUndef && !target) {
    console.log(style.error(`Agent "${idOrUndef}" introuvable.`));
    console.log(style.muted(`Disponibles : ${agents.map((a) => a.id).join(', ')}`));
    return;
  }

  if (!target) {
    const picked = await select({
      message: 'Quel agent éditer ?',
      choices: agents.map((a) => ({
        name: `${a.id}  ${style.muted('— ' + (a.description || '').slice(0, 60))}`,
        value: a.id
      }))
    });
    target = agents.find((a) => a.id === picked);
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  console.log(style.muted(`Ouverture dans ${editor} : ${path.relative(root, target.file)}`));

  const child = spawn(editor, [target.file], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}`))));
    child.on('error', reject);
  });
}
