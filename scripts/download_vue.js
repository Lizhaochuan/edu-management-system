const https = require('https');
const fs = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, 'web-admin', 'vendor');
if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

const dest = path.join(vendorDir, 'vue.global.prod.js');
const file = fs.createWriteStream(dest);

console.log('Testing download of Vue 3...');
const req = https.get('https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js', (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, (redirectRes) => {
      redirectRes.pipe(file);
      redirectRes.on('end', () => console.log('Vue 3 downloaded successfully!'));
    });
  } else {
    res.pipe(file);
    res.on('end', () => console.log('Vue 3 downloaded successfully!'));
  }
});

req.on('error', (err) => {
  console.log('Download failed (standard sandbox network isolation):', err.message);
});
