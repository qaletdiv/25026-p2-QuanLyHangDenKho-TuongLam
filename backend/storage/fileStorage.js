// ---------------------------------------------------------------------------
// File blobs — the CI workbooks, packing lists and ASNs the portal generates.
//
// This is the half of the old driveStorage.js that was never about records. It
// was tangled up with readData/writeData in one class, which is how a Google
// Drive client ended up sitting in the middle of the data layer; records are in
// Postgres via models/, and this deals only with files on disk.
//
// THE GOOGLE DRIVE PATH WAS DELETED, NOT PORTED. It required GOOGLE_CLIENT_EMAIL
// + GOOGLE_PRIVATE_KEY + GOOGLE_DRIVE_FOLDER_ID, and this deployment sets NONE
// of them (they appear only in .env.example). So `this.drive` was always null
// and every upload has always taken the local-disk fallback below — the Drive
// branch was unreachable code carrying a 171-package dependency. If Drive is
// ever wanted back, it belongs behind this same interface.
//
// Files are served by routes/documents.js, which mounts /uploads BELOW the auth
// gate — see the download notes in CLAUDE.md.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// Beside this file: backend/storage/uploads/. These are generated documents,
// not records — which is why they are here and not under database/.
const UPLOAD_DIR = path.join(__dirname, 'uploads');

/**
 * Write a generated document to disk.
 *
 * @param {string} filename    name to store it under
 * @param {stream.Readable} bufferStream  the file's bytes
 * @param {string} [mimeType]  retained for interface compatibility; the local
 *                             path infers the type from the extension
 * @returns {Promise<{id: string, url: string}>} `url` is what gets stored on the
 *          document row and handed to the frontend's docHref().
 */
function uploadFile(filename, bufferStream, mimeType) {  // eslint-disable-line no-unused-vars
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filepath = path.join(UPLOAD_DIR, filename);

    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(filepath);
        bufferStream.pipe(writeStream);
        writeStream.on('finish', () => resolve({ id: filename, url: `/uploads/${filename}` }));
        writeStream.on('error', reject);
    });
}

module.exports = { uploadFile, UPLOAD_DIR };
