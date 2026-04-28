const http = require('http');

const data = JSON.stringify({
  email: 'admin@tentree.com',
  password: 'password123'
});

const options = {
  hostname: '127.0.0.1',
  port: 5000,
  path: '/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

console.log('Testing terminal login to http://127.0.0.1:5000/login...');

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
  
  let body = '';
  res.on('data', (d) => {
    body += d;
  });
  
  res.on('end', () => {
    console.log('Response Body:', body);
    if (res.statusCode === 200) {
      console.log('✅ LOGIN SUCCESSFUL');
    } else {
      console.log('❌ LOGIN FAILED');
    }
  });
});

req.on('error', (error) => {
  console.error('❌ CONNECTION ERROR:', error.message);
});

req.write(data);
req.end();
