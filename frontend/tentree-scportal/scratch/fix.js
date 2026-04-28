const fs = require('fs');
const files = [
  'src/app/page.tsx',
  'src/app/shipments/page.tsx',
  'src/app/asn/page.tsx',
  'src/app/contacts/page.tsx',
  'src/app/eom/page.tsx'
];
for(const f of files) {
  let content = fs.readFileSync(f, 'utf8');
  content = content.replace(/\\`/g, '`').replace(/\\\$/g, '$');
  fs.writeFileSync(f, content);
  console.log('Fixed', f);
}
