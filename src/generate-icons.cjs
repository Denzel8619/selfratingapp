const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, 'public', 'icon.svg'));

const sizes = [
  { name: 'icon-192.png',       size: 192 },
  { name: 'icon-512.png',       size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

for (const { name, size } of sizes) {
  const resvg = new Resvg(svg, { width: size, height: size });
  const png   = resvg.render().asPng();
  fs.writeFileSync(path.join(__dirname, 'public', name), png);
  console.log(`✓ ${name} (${size}x${size})`);
}
