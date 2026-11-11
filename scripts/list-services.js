const fs = require('fs');
const path = require('path');

const servicesDir = path.join(__dirname, '..', 'services');
fs.readdirSync(servicesDir).forEach(file => {
  if (file.endsWith('.js')) {
    try {
      const mod = require(path.join(servicesDir, file));
      console.log(`\n=== ${file} ===`);
      if (typeof mod === 'object' && mod !== null) {
        Object.keys(mod).forEach(k => {
          if (typeof mod[k] === 'function') console.log(`  - ${k}()`);
          else console.log(`  * ${k}`);
        });
      }
    } catch (e) {
      console.log(`Failed loading ${file}:`, e.message);
    }
  }
});
