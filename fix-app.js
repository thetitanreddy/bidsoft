const fs = require('fs');
const file = 'c:/Users/bobby/Desktop/bidsoft/app.js';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/\\\$\{/g, '${');
content = content.replace(/\\`/g, '`');

fs.writeFileSync(file, content);
console.log('Fixed escaping issues in app.js');
