import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export default function prepareBuild() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(directory);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const tracked = git(['ls-files', 'desktop']).split(/\r?\n/).filter(Boolean);
  const files = {};
  for (const file of tracked) {
    if (file.startsWith('desktop/tests/')) continue;
    files[file.slice('desktop/'.length)] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  const manifest = { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no', '--', 'desktop', 'scripts/prepare-release.js'])), files };
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify(manifest, null, 2));
}
