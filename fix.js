const fs = require('fs');
const file = 'c:/Users/bobby/Desktop/bidsoft/UI.html';
let content = fs.readFileSync(file, 'utf8');

// Replace \${ with ${
content = content.replace(/\\\$\{/g, '${');

// Replace \` with `
content = content.replace(/\\`/g, '`');

fs.writeFileSync(file, content);
console.log('Fixed escaping issues in UI.html');
