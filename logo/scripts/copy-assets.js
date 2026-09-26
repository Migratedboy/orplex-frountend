// Copies static assets (renderer HTML/CSS, logo) into dist/ after tsc emits.
// HTML/CSS live next to the compiled renderer JS: dist/renderer/renderer/.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rendererOut = path.join(root, 'dist', 'renderer', 'renderer');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] ${src} -> ${dest}`);
}

for (const page of ['widget.html', 'panel.html', 'lock.html']) {
  copy(path.join(root, 'src', 'renderer', page), path.join(rendererOut, page));
}

for (const css of ['widget.css', 'panel.css', 'lock.css']) {
  copy(path.join(root, 'src', 'renderer', css), path.join(rendererOut, css));
}

copy(
  path.join(root, 'assets', 'logo.svg'),
  path.join(root, 'dist', 'main', 'logo.svg')
);

// Class-pin helper script: resolved by classPin.ts as <root>/native/.
fs.mkdirSync(path.join(root, 'dist', 'native'), { recursive: true });
copy(
  path.join(root, 'native', 'classPin.ps1'),
  path.join(root, 'dist', 'native', 'classPin.ps1')
);

// Optional PNG override: preferred by main when present.
const pngSrc = path.join(root, 'assets', 'logo.png');
if (fs.existsSync(pngSrc)) {
  copy(pngSrc, path.join(root, 'dist', 'main', 'logo.png'));
}
