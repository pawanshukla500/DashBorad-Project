import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(projectRoot, 'released', 'build');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'desktop', 'package.json'), 'utf8'));
const version = packageJson.version;
const assets = [
  {
    source: path.join(buildDir, 'ReconCentral-RateCard-Worker-Setup-' + version + '.exe'),
    name: 'ReconCentral-RateCard-Worker-Setup-' + version + '.exe'
  },
  {
    source: path.join(buildDir, 'ReconCentral RateCard Worker-' + version + '.AppImage'),
    name: 'ReconCentral RateCard Worker-' + version + '.AppImage'
  }
];

for (const asset of assets) {
  if (!fs.existsSync(asset.source)) {
    console.error('[Release] Required installer not found:', asset.source);
    process.exit(1);
  }
}

const targetDirs = [
  path.join(projectRoot, 'released'),
  path.join(os.homedir(), 'Desktop', 'released')
];
const guide = [
  '# ReconCentral RateCard Worker ' + version,
  '',
  '## Download one installer',
  '',
  '| Platform | Installer |',
  '| --- | --- |',
  '| Windows | ReconCentral-RateCard-Worker-Setup-' + version + '.exe |',
  '| Linux | ReconCentral RateCard Worker-' + version + '.AppImage |',
  '',
  'The setup executable installs the Windows desktop app. The AppImage is the Linux desktop app; make it executable in file properties if your desktop does not prompt to run it.',
  '',
  'Sign in to the desktop app with your ReconCentral account. Seller Hub login is completed manually in the embedded browser and the encrypted session is reused until the portal expires it.',
  '',
  'Rate-card extraction is staged locally. Review each marketplace separately against PostgreSQL; publication is enabled only for complete, changed rates after an authorized admin review.',
  '',
  'Windows installs receive automatic updates through GitHub Releases. The latest.yml and blockmap files are update metadata and are not installers.',
  '',
  '© ReconCentral Enterprise Reconciliation • VB Exports'
].join('\n');

for (const directory of targetDirs) {
  fs.mkdirSync(directory, { recursive: true });
  for (const asset of assets) fs.copyFileSync(asset.source, path.join(directory, asset.name));
  fs.writeFileSync(path.join(directory, 'INSTALLATION_AND_AUTHORIZATION_GUIDE.md'), guide, 'utf8');
}
console.log('[Release] Prepared the Windows setup installer and Linux AppImage.');
