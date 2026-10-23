'use strict';
// Deterministic, original project artwork. No font or network dependency.
const fs = require('node:fs');
const { PNG } = require('pngjs');
const png = new PNG({ width: 256, height: 256 });
const segments = [[88,80,56,128],[56,128,88,176],[168,80,200,128],[200,128,168,176],[143,68,113,188]];
function distance(x,y,[a,b,c,d]) { const t=Math.max(0,Math.min(1,((x-a)*(c-a)+(y-b)*(d-b))/((c-a)**2+(d-b)**2))); return Math.hypot(x-a-t*(c-a),y-b-t*(d-b)); }
for(let y=0;y<256;y++)for(let x=0;x<256;x++) {
  const offset=(y*256+x)*4;
  const corner=Math.hypot(Math.max(28-x,x-227,0),Math.max(28-y,y-227,0));
  const alpha=Math.max(0,Math.min(1,28-corner));
  const ink=Math.min(...segments.map(s=>distance(x,y,s)))<8;
  const color=ink?[107,239,195]:[23,33+Math.round(y/25),49+Math.round(y/18)];
  png.data.set([...color,Math.round(alpha*255)],offset);
}
fs.mkdirSync('media',{recursive:true});
fs.writeFileSync('media/icon.png',PNG.sync.write(png));
