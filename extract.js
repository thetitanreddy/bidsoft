const fs = require('fs');
const content = fs.readFileSync('c:/Users/bobby/Desktop/bidsoft/UI.html', 'utf8');
const match = content.match(/<script>([\s\S]*?)<\/script>/);
if (match) {
    fs.writeFileSync('c:/Users/bobby/Desktop/bidsoft/script.js', match[1]);
}
