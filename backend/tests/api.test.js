const request = require('supertest');
// app.js, NOT server.js — server.js is the entry point and binds the port and
// starts the cron scheduler on require. app.js is the express app alone.
const app = require('../src/app');

describe('API Endpoints', () => {
    it('should return 200 OK on /health', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('message', 'initial running');
    });
});

describe('Global Error Handler', () => {
    it('should return 401 for invalid login credentials via the asyncWrap and errorHandler', async () => {
        const res = await request(app).post('/login').send({ email: 'wrong@user', password: 'bad' });
        expect(res.statusCode).toEqual(401);
        expect(res.body).toHaveProperty('success', false);
        expect(res.body).toHaveProperty('error', 'Invalid credentials');
    });
});
