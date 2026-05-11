const stream = require('stream');
const driveStorage = require('../driveStorage');

async function upload(req, res) {
    if (!req.file) {
        const err = new Error('No file uploaded');
        err.statusCode = 400;
        throw err;
    }

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const result = await driveStorage.uploadFile(req.file.originalname, bufferStream, req.file.mimetype);
    res.json(result);
}

module.exports = { upload };
